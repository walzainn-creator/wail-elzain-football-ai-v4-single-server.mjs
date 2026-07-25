import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const SPORTMONKS_TOKEN = String(process.env.SPORTMONKS_API_TOKEN || '').trim();
const API_KEY = String(process.env.API_FOOTBALL_KEY || '').trim();
const ENABLE_PUBLIC_FALLBACK = String(process.env.ENABLE_PUBLIC_FALLBACK || 'true') !== 'false';
const CACHE_TTL_MS = Math.max(30, Number(process.env.CACHE_TTL_SECONDS || 600)) * 1000;
const SPORTMONKS_BASE = 'https://api.sportmonks.com/v3/football';
const API_BASE = 'https://v3.football.api-sports.io';
const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/123';
const APP_VERSION = '6.0.0';

const cache = new Map();
const fixtureIndex = new Map();
const requestBuckets = new Map();
const RATE_LIMIT_PER_MINUTE = Math.max(30, Number(process.env.RATE_LIMIT_PER_MINUTE || 180));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function avg(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : 0;
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function addDays(value, days) {
  const d = new Date(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function daysBetweenInclusive(from, to) {
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to + 'T00:00:00Z');
  return Math.max(1, Math.floor((b - a) / 86400000) + 1);
}

function rangeFromRequest(url) {
  const range = String(url.searchParams.get('range') || '').trim();
  if (range === 'next-month') {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const first = new Date(Date.UTC(y, m + 1, 1));
    const last = new Date(Date.UTC(y, m + 2, 0));
    return {
      key: 'next-month',
      label: 'الشهر القادم كاملًا',
      from: isoDate(first),
      to: isoDate(last),
      days: daysBetweenInclusive(isoDate(first), isoDate(last))
    };
  }

  const days = clamp(Number(url.searchParams.get('days') || 7), 1, 62);
  const from = isoDate(new Date());
  const to = isoDate(addDays(new Date(), days - 1));
  return { key: String(days), label: days + ' يوم', from, to, days };
}

function cachedGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cachedSet(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function withCache(key, loader, ttl = CACHE_TTL_MS) {
  const hit = cachedGet(key);
  if (hit !== null) return hit;
  const value = await loader();
  return cachedSet(key, value, ttl);
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.message || data?.errors || ('HTTP ' + res.status);
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function apiFootball(endpoint, params = {}) {
  if (!API_KEY) throw new Error('API_FOOTBALL_KEY_NOT_CONFIGURED');
  const url = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return fetchJson(url, { headers: { 'x-apisports-key': API_KEY } });
}

async function tsdb(endpoint, params = {}) {
  const url = new URL(TSDB_BASE + '/' + endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return fetchJson(url);
}

async function sportmonks(endpoint, params = {}) {
  if (!SPORTMONKS_TOKEN) throw new Error('SPORTMONKS_API_TOKEN_NOT_CONFIGURED');
  const url = new URL(SPORTMONKS_BASE + endpoint);
  url.searchParams.set('api_token', SPORTMONKS_TOKEN);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return fetchJson(url);
}

async function sportmonksPaged(endpoint, params = {}, maxPages = 6) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const payload = await sportmonks(endpoint, { ...params, page, per_page: 100 });
    rows.push(...(payload.data || []));
    const pagination = payload.pagination || {};
    if (!pagination.has_more && !(pagination.current_page < pagination.last_page)) break;
  }
  return rows;
}

async function sportmonksFixtureRows(endpoint) {
  try {
    return await sportmonksPaged(endpoint, { include: 'participants;league;venue;state;scores' });
  } catch {
    return sportmonksPaged(endpoint, { include: 'participants;league' });
  }
}


const TEAM_AR = {
  'Manchester City': 'مانشستر سيتي', 'Manchester United': 'مانشستر يونايتد', 'Liverpool': 'ليفربول',
  'Arsenal': 'أرسنال', 'Chelsea': 'تشيلسي', 'Tottenham Hotspur': 'توتنهام', 'Newcastle United': 'نيوكاسل يونايتد',
  'Real Madrid': 'ريال مدريد', 'FC Barcelona': 'برشلونة', 'Barcelona': 'برشلونة', 'Atletico Madrid': 'أتلتيكو مدريد',
  'Sevilla': 'إشبيلية', 'Valencia': 'فالنسيا', 'Villarreal': 'فياريال', 'Athletic Club': 'أتلتيك بلباو',
  'Bayern Munich': 'بايرن ميونخ', 'Borussia Dortmund': 'بوروسيا دورتموند', 'Bayer Leverkusen': 'باير ليفركوزن',
  'Paris Saint Germain': 'باريس سان جيرمان', 'Paris Saint-Germain': 'باريس سان جيرمان',
  'Juventus': 'يوفنتوس', 'Inter': 'إنتر ميلان', 'Inter Milan': 'إنتر ميلان', 'AC Milan': 'ميلان', 'Napoli': 'نابولي', 'Roma': 'روما',
  'Al Nassr': 'النصر', 'Al-Hilal': 'الهلال', 'Al Hilal': 'الهلال', 'Al Ittihad': 'الاتحاد', 'Al-Ahli': 'الأهلي', 'Al Ahli': 'الأهلي',
  'Sporting CP': 'سبورتينغ لشبونة', 'Benfica': 'بنفيكا', 'FC Porto': 'بورتو', 'Ajax': 'أياكس', 'PSV': 'آيندهوفن',
  'Galatasaray': 'غلطة سراي', 'Fenerbahce': 'فنربخشة', 'Besiktas': 'بشكتاش', 'Celtic': 'سيلتيك', 'Rangers': 'رينجرز'
};

const TEAM_WORD_AR = {
  united:'يونايتد', city:'سيتي', real:'ريال', club:'كلوب', football:'فوتبول', fc:'',
  sporting:'سبورتينغ', athletic:'أتلتيك', deportivo:'ديبورتيفو', racing:'راسينغ',
  olympic:'أولمبيك', al:'ال', saint:'سان', st:'سانت', new:'نيو', north:'نورث',
  south:'ساوث', east:'إيست', west:'ويست'
};

function transliterateLatinWord(word) {
  let s = String(word || '').toLowerCase();
  const pairs = [['sch','ش'],['sh','ش'],['ch','تش'],['th','ث'],['ph','ف'],['kh','خ'],['gh','غ'],['oo','و'],['ee','ي'],['ou','و'],['ai','اي']];
  for (const [a,b] of pairs) s = s.split(a).join(b);
  const map = {a:'ا',b:'ب',c:'ك',d:'د',e:'ي',f:'ف',g:'غ',h:'ه',i:'ي',j:'ج',k:'ك',l:'ل',m:'م',n:'ن',o:'و',p:'ب',q:'ق',r:'ر',s:'س',t:'ت',u:'و',v:'ف',w:'و',x:'كس',y:'ي',z:'ز'};
  return s.replace(/[a-z]/g, ch => map[ch] || ch);
}

function arTeam(name) {
  const key = String(name || '').trim();
  if (!key) return 'فريق غير محدد';
  if (/[\u0600-\u06FF]/.test(key)) return key;
  if (TEAM_AR[key]) return TEAM_AR[key];
  return key.split(/([\s-]+)/).map(part => {
    const lower = part.toLowerCase();
    if (TEAM_WORD_AR[lower] !== undefined) return TEAM_WORD_AR[lower];
    if (/^[A-Za-z]+$/.test(part)) return transliterateLatinWord(part);
    return part;
  }).join('').replace(/\s+/g,' ').trim() || key;
}

const COUNTRY_AR = {
  'United States': 'الولايات المتحدة', 'USA': 'الولايات المتحدة', 'England': 'إنجلترا', 'Spain': 'إسبانيا',
  'Italy': 'إيطاليا', 'Germany': 'ألمانيا', 'France': 'فرنسا', 'Portugal': 'البرتغال', 'Netherlands': 'هولندا',
  'Belgium': 'بلجيكا', 'Scotland': 'اسكتلندا', 'Turkey': 'تركيا', 'Saudi Arabia': 'السعودية', 'Oman': 'عُمان',
  'United Arab Emirates': 'الإمارات', 'Qatar': 'قطر', 'Egypt': 'مصر', 'Morocco': 'المغرب', 'Tunisia': 'تونس',
  'Brazil': 'البرازيل', 'Argentina': 'الأرجنتين', 'Mexico': 'المكسيك', 'Japan': 'اليابان', 'South Korea': 'كوريا الجنوبية',
  'Australia': 'أستراليا', 'Switzerland': 'سويسرا', 'Austria': 'النمسا', 'Greece': 'اليونان', 'Denmark': 'الدنمارك',
  'Sweden': 'السويد', 'Norway': 'النرويج', 'Poland': 'بولندا', 'Czech Republic': 'التشيك', 'Croatia': 'كرواتيا'
};

const LEAGUE_AR = {
  'English Premier League': 'الدوري الإنجليزي الممتاز', 'Premier League': 'الدوري الإنجليزي الممتاز',
  'Spanish La Liga': 'الدوري الإسباني', 'La Liga': 'الدوري الإسباني', 'Italian Serie A': 'الدوري الإيطالي', 'Serie A': 'الدوري الإيطالي',
  'German Bundesliga': 'الدوري الألماني', 'Bundesliga': 'الدوري الألماني', 'French Ligue 1': 'الدوري الفرنسي', 'Ligue 1': 'الدوري الفرنسي',
  'UEFA Champions League': 'دوري أبطال أوروبا', 'UEFA Europa League': 'الدوري الأوروبي', 'UEFA Conference League': 'دوري المؤتمر الأوروبي',
  'Saudi Professional League': 'دوري روشن السعودي', 'Saudi Pro League': 'دوري روشن السعودي',
  'American USL Championship': 'دوري USL Championship الأمريكي', 'American USL League One': 'دوري USL League One الأمريكي',
  'Major League Soccer': 'الدوري الأمريكي MLS', 'MLS': 'الدوري الأمريكي MLS', 'FIFA Club World Cup': 'كأس العالم للأندية'
};

function arCountry(name) {
  const key = String(name || '').trim();
  return COUNTRY_AR[key] || key;
}

function arLeague(name) {
  const key = String(name || '').trim();
  return LEAGUE_AR[key] || key;
}

function safeName(value, fallback = 'غير متاح') {
  return String(value || fallback).trim() || fallback;
}


function smParticipant(fixture, location) {
  const participants = fixture?.participants || [];
  return participants.find(p => String(p?.meta?.location || '').toLowerCase() === location) || null;
}

function normalizeSportmonksFixture(item) {
  const homeP = smParticipant(item, 'home') || item?.participants?.[0] || {};
  const awayP = smParticipant(item, 'away') || item?.participants?.[1] || {};
  const leagueOriginal = safeName(item?.league?.name, 'بطولة غير محددة');
  const homeOriginal = safeName(homeP?.name, 'المضيف');
  const awayOriginal = safeName(awayP?.name, 'الضيف');
  const date = item?.starting_at
    || (item?.starting_at_timestamp ? new Date(Number(item.starting_at_timestamp) * 1000).toISOString() : new Date().toISOString());

  const out = {
    id: 'sm-' + item.id,
    providerId: item.id,
    date,
    venue: item?.venue?.name || '',
    country: item?.league?.country?.name || '',
    leagueName: leagueOriginal,
    league: arLeague(leagueOriginal),
    leagueOriginal,
    leagueId: item.league_id || item?.league?.id,
    season: item.season_id,
    round: item.round_id || item.stage_id || '',
    home: arTeam(homeOriginal),
    away: arTeam(awayOriginal),
    homeOriginal,
    awayOriginal,
    homeId: homeP?.id,
    awayId: awayP?.id,
    homeLogo: homeP?.image_path || '',
    awayLogo: awayP?.image_path || '',
    state: item?.state?.short_name || item?.state?.name || '',
    source: 'Sportmonks'
  };
  fixtureIndex.set(out.id, out);
  return out;
}

async function getSportmonksFixtures(range) {
  const key = 'sm:fixtures:' + range.from + ':' + range.to;
  return withCache(key, async () => {
    const rows = await sportmonksFixtureRows('/fixtures/between/' + range.from + '/' + range.to);
    return rows
      .map(normalizeSportmonksFixture)
      .filter(x => x.homeId && x.awayId)
      .sort((a,b) => new Date(a.date) - new Date(b.date))
      .slice(0, 600);
  }, 5 * 60 * 1000);
}

function sportmonksScore(fixture, teamId) {
  const scores = (fixture?.scores || []).filter(s => String(s?.participant_id) === String(teamId));
  if (!scores.length) return null;
  const preferred = scores.find(s => /current|fulltime|full time|ft/i.test(String(s?.description || s?.type?.name || ''))) || scores[scores.length - 1];
  const raw = preferred?.score?.goals ?? preferred?.score?.score ?? preferred?.goals ?? preferred?.value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function recentFormFromSportmonks(rows, teamId) {
  const gf = [], ga = [];
  let w = 0, d = 0, l = 0;
  let lastDate = null;
  const ordered = [...(rows || [])].sort((a,b) => new Date(b.starting_at || 0) - new Date(a.starting_at || 0));
  for (const row of ordered) {
    const homeP = smParticipant(row, 'home') || row?.participants?.[0];
    const awayP = smParticipant(row, 'away') || row?.participants?.[1];
    if (!homeP || !awayP) continue;
    const hg = sportmonksScore(row, homeP.id);
    const ag = sportmonksScore(row, awayP.id);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const isHome = String(homeP.id) === String(teamId);
    const scored = isHome ? hg : ag;
    const conceded = isHome ? ag : hg;
    gf.push(scored); ga.push(conceded);
    if (scored > conceded) w++; else if (scored === conceded) d++; else l++;
    const dt = row?.starting_at ? new Date(row.starting_at) : null;
    if (dt && (!lastDate || dt > lastDate)) lastDate = dt;
    if (gf.length >= 10) break;
  }
  const restDays = lastDate ? Math.max(0, Math.floor((Date.now() - lastDate.getTime()) / 86400000)) : null;
  return { w, d, l, gf: avg(gf), ga: avg(ga), count: gf.length, restDays };
}

function normalizeApiFixture(item) {
  const f = item?.fixture || {};
  const league = item?.league || {};
  const teams = item?.teams || {};
  const country = safeName(league.country, '');
  const leagueName = safeName(league.name, 'بطولة غير محددة');
  const out = {
    id: 'af-' + f.id,
    providerId: f.id,
    date: f.date,
    timestamp: f.timestamp,
    timezone: f.timezone,
    venue: f.venue?.name || '',
    referee: f.referee || '',
    country,
    leagueName,
    league: [arCountry(country), arLeague(leagueName)].filter(Boolean).join(' • '),
    leagueOriginal: [country, leagueName].filter(Boolean).join(' • '),
    leagueId: league.id,
    season: league.season,
    round: league.round,
    home: arTeam(safeName(teams.home?.name, 'المضيف')),
    away: arTeam(safeName(teams.away?.name, 'الضيف')),
    homeOriginal: safeName(teams.home?.name, 'المضيف'),
    awayOriginal: safeName(teams.away?.name, 'الضيف'),
    homeLogo: teams.home?.logo || '',
    awayLogo: teams.away?.logo || '',
    homeId: teams.home?.id,
    awayId: teams.away?.id,
    source: 'API-Football'
  };
  fixtureIndex.set(out.id, out);
  return out;
}

function tsdbDateTime(event) {
  const date = event?.dateEvent || event?.strTimestamp?.slice(0, 10) || isoDate(new Date());
  const time = (event?.strTime || '00:00:00').slice(0, 8);
  const raw = event?.strTimestamp || (date + 'T' + time + 'Z');
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? (date + 'T' + time + 'Z') : d.toISOString();
}

function normalizeTsdbFixture(event) {
  const country = safeName(event.strCountry, '');
  const leagueName = safeName(event.strLeague, 'بطولة غير محددة');
  const out = {
    id: 'tsdb-' + event.idEvent,
    providerId: event.idEvent,
    date: tsdbDateTime(event),
    country,
    leagueName,
    league: [arCountry(country), arLeague(leagueName)].filter(Boolean).join(' • '),
    leagueOriginal: [country, leagueName].filter(Boolean).join(' • '),
    leagueId: event.idLeague,
    season: event.strSeason,
    round: event.intRound || '',
    home: arTeam(safeName(event.strHomeTeam, 'المضيف')),
    away: arTeam(safeName(event.strAwayTeam, 'الضيف')),
    homeOriginal: safeName(event.strHomeTeam, 'المضيف'),
    awayOriginal: safeName(event.strAwayTeam, 'الضيف'),
    homeLogo: event.strHomeTeamBadge || '',
    awayLogo: event.strAwayTeamBadge || '',
    homeId: event.idHomeTeam,
    awayId: event.idAwayTeam,
    source: 'TheSportsDB Free'
  };
  fixtureIndex.set(out.id, out);
  return out;
}

async function getApiFixtures(range) {
  const key = 'af:fixtures:' + range.from + ':' + range.to;
  return withCache(key, async () => {
    const data = await apiFootball('/fixtures', { from: range.from, to: range.to, timezone: 'Asia/Muscat' });
    return (data.response || [])
      .filter(row => ['NS', 'TBD'].includes(row?.fixture?.status?.short))
      .map(normalizeApiFixture)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 500);
  }, 5 * 60 * 1000);
}

async function getPublicFixtures(range) {
  const key = 'tsdb:fixtures:' + range.from + ':' + range.to;
  return withCache(key, async () => {
    const out = [];
    const seen = new Set();
    const start = new Date(range.from + 'T00:00:00Z');
    const totalDays = clamp(range.days, 1, 62);

    for (let i = 0; i < totalDays; i++) {
      const date = isoDate(addDays(start, i));
      try {
        const data = await tsdb('eventsday.php', { d: date, s: 'Soccer' });
        for (const event of data.events || []) {
          if (!event?.idEvent || seen.has(String(event.idEvent))) continue;
          seen.add(String(event.idEvent));
          out.push(normalizeTsdbFixture(event));
        }
      } catch {
        // تجاهل اليوم الذي يفشل بدلاً من إيقاف الفترة كاملة.
      }
      if (out.length >= 500) break;
    }

    return out.sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 500);
  }, 10 * 60 * 1000);
}

function recentFormFromApi(rows, teamId) {
  const gf = [], ga = [];
  let w = 0, d = 0, l = 0;
  let lastDate = null;
  for (const row of rows || []) {
    const hg = Number(row?.goals?.home);
    const ag = Number(row?.goals?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const isHome = Number(row?.teams?.home?.id) === Number(teamId);
    const scored = isHome ? hg : ag;
    const conceded = isHome ? ag : hg;
    gf.push(scored); ga.push(conceded);
    if (scored > conceded) w++; else if (scored === conceded) d++; else l++;
    const dt = row?.fixture?.date ? new Date(row.fixture.date) : null;
    if (dt && (!lastDate || dt > lastDate)) lastDate = dt;
  }
  const restDays = lastDate ? Math.max(0, Math.floor((Date.now() - lastDate.getTime()) / 86400000)) : null;
  return { w, d, l, gf: avg(gf), ga: avg(ga), count: gf.length, restDays };
}

function recentFormFromTsdb(rows, teamId) {
  const gf = [], ga = [];
  let w = 0, d = 0, l = 0;
  for (const event of rows || []) {
    const hg = Number(event.intHomeScore);
    const ag = Number(event.intAwayScore);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const isHome = String(event.idHomeTeam) === String(teamId);
    const scored = isHome ? hg : ag;
    const conceded = isHome ? ag : hg;
    gf.push(scored); ga.push(conceded);
    if (scored > conceded) w++; else if (scored === conceded) d++; else l++;
  }
  return { w, d, l, gf: avg(gf), ga: avg(ga), count: gf.length, restDays: null };
}

function deriveStrengthsWeaknesses(stats, label) {
  const strengths = [];
  const weaknesses = [];
  if (stats.gf >= 1.7) strengths.push(label + ': إنتاج هجومي قوي مؤخرًا');
  else if (stats.gf >= 1.25) strengths.push(label + ': معدل تسجيل مستقر');
  if (stats.ga <= 0.9 && stats.count >= 3) strengths.push(label + ': صلابة دفاعية جيدة');
  if (stats.w >= Math.max(3, Math.ceil(stats.count * 0.55))) strengths.push(label + ': زخم نتائج إيجابي');
  if (stats.gf < 0.9 && stats.count >= 3) weaknesses.push(label + ': صعوبة نسبية في التسجيل');
  if (stats.ga >= 1.7) weaknesses.push(label + ': استقبال أهداف بمعدل مرتفع');
  if (stats.l >= Math.max(3, Math.ceil(stats.count * 0.5))) weaknesses.push(label + ': تذبذب واضح في النتائج');
  if (!strengths.length) strengths.push(label + ': لا توجد إشارة قوة حاسمة من العينة المتاحة');
  if (!weaknesses.length) weaknesses.push(label + ': لا توجد نقطة ضعف حاسمة من العينة المتاحة');
  return { strengths, weaknesses };
}

function poissonPmf(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

function poissonCdf(k, lambda) {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(i, lambda);
  return sum;
}

function outcomeProbabilities(lambdaHome, lambdaAway) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
    }
  }
  const total = home + draw + away || 1;
  return { home: home / total, draw: draw / total, away: away / total };
}

function buildMarkets(lambdaHome, lambdaAway) {
  const total = lambdaHome + lambdaAway;
  const outcomes = outcomeProbabilities(lambdaHome, lambdaAway);
  const bttsYes = (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway));
  return [
    { key: 'O05', event: 'أكثر من 0.5 هدف في المباراة', p: 1 - Math.exp(-total) },
    { key: 'U45', event: 'أقل من 4.5 أهداف في المباراة', p: poissonCdf(4, total) },
    { key: 'O15', event: 'أكثر من 1.5 هدف في المباراة', p: 1 - poissonCdf(1, total) },
    { key: 'U35', event: 'أقل من 3.5 أهداف في المباراة', p: poissonCdf(3, total) },
    { key: '1X', event: 'المضيف أو التعادل (فرصة مزدوجة)', p: outcomes.home + outcomes.draw },
    { key: 'X2', event: 'الضيف أو التعادل (فرصة مزدوجة)', p: outcomes.away + outcomes.draw },
    { key: 'BTTSNO', event: 'الفريقان لا يسجلان معًا', p: 1 - bttsYes }
  ].sort((a, b) => b.p - a.p);
}

function choosePrediction({ homeStats, awayStats, injuryCount = 0, qualityScore = 45, providerPrediction = null }) {
  const hGF = homeStats.gf || 1.25;
  const hGA = homeStats.ga || 1.25;
  const aGF = awayStats.gf || 1.25;
  const aGA = awayStats.ga || 1.25;
  let lambdaHome = clamp(hGF * 0.52 + aGA * 0.38 + 0.18, 0.25, 2.9);
  let lambdaAway = clamp(aGF * 0.50 + hGA * 0.38 + 0.08, 0.20, 2.7);
  if (injuryCount >= 5) { lambdaHome *= 0.97; lambdaAway *= 0.97; }
  const markets = buildMarkets(lambdaHome, lambdaAway);
  let best = markets[0];
  if (best.key === 'O05' && best.p > 0.94 && markets[1]?.p > 0.82) best = markets[1];
  const providerBoost = providerPrediction?.predictions?.advice ? 2 : 0;
  const confidence = Math.round(clamp(best.p * 100 * 0.72 + qualityScore * 0.20 + providerBoost, 42, Math.min(88, best.p * 100)));
  return { lambdaHome, lambdaAway, markets, best, confidence, advice: providerPrediction?.predictions?.advice || null };
}

function extractStanding(payload, teamId) {
  const groups = payload?.response?.[0]?.league?.standings || [];
  for (const group of groups) {
    const row = (group || []).find(x => Number(x?.team?.id) === Number(teamId));
    if (row) return { rank: row.rank, points: row.points, form: row.form || '' };
  }
  return null;
}

function mapInjuries(payload) {
  return (payload?.response || []).slice(0, 40).map(x => ({
    team: x?.team?.name || '',
    player: x?.player?.name || 'لاعب غير محدد',
    reason: x?.player?.reason || x?.player?.type || 'غياب/إصابة',
    type: x?.player?.type || 'غياب'
  }));
}

function pct(v) {
  return Math.round(clamp(v * 100, 0, 100));
}

function buildWzCode(fixtureId, marketKey, confidence, publicMode = false) {
  const id = String(fixtureId).replace(/[^A-Za-z0-9]/g, '').slice(-12).toUpperCase();
  const market = String(marketKey || 'PICK').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const mode = publicMode ? 'P' : 'D';
  return 'WZ-' + id + '-' + market + '-' + mode + confidence + '-V5';
}


async function analyzeSportmonksFixture(id) {
  const fixtureId = Number(String(id).replace(/^sm-/, ''));
  if (!Number.isFinite(fixtureId)) throw new Error('INVALID_FIXTURE_ID');

  return withCache('sm:analysis:' + fixtureId, async () => {
    let payload;
    try {
      payload = await sportmonks('/fixtures/' + fixtureId, { include: 'participants;league;venue;state;scores;statistics' });
    } catch {
      payload = await sportmonks('/fixtures/' + fixtureId, { include: 'participants;league' });
    }

    const row = payload?.data;
    if (!row) throw new Error('FIXTURE_NOT_FOUND');
    const fixture = normalizeSportmonksFixture(row);
    const matchDate = new Date(fixture.date);
    const recentTo = isoDate(addDays(matchDate, -1));
    const recentFrom = isoDate(addDays(matchDate, -180));

    const [homeR, awayR] = await Promise.allSettled([
      sportmonksFixtureRows('/fixtures/between/' + recentFrom + '/' + recentTo + '/' + fixture.homeId),
      sportmonksFixtureRows('/fixtures/between/' + recentFrom + '/' + recentTo + '/' + fixture.awayId)
    ]);

    const homeRows = homeR.status === 'fulfilled' ? homeR.value : [];
    const awayRows = awayR.status === 'fulfilled' ? awayR.value : [];
    const hs = recentFormFromSportmonks(homeRows, fixture.homeId);
    const as = recentFormFromSportmonks(awayRows, fixture.awayId);

    let qualityScore = 46;
    const qualityReasons = ['مواعيد وهوية الفرق من Sportmonks'];
    if (hs.count >= 6 && as.count >= 6) {
      qualityScore += 28;
      qualityReasons.push('عينة حديثة قوية للفريقين');
    } else if (hs.count + as.count >= 8) {
      qualityScore += 17;
      qualityReasons.push('عينة نتائج متوسطة');
    }
    if ((row.statistics || []).length) {
      qualityScore += 7;
      qualityReasons.push('إحصائيات إضافية متاحة للمواجهة');
    }
    qualityScore = clamp(qualityScore, 42, 88);

    const pred = choosePrediction({ homeStats: hs, awayStats: as, injuryCount: 0, qualityScore });
    const hSW = deriveStrengthsWeaknesses(hs, fixture.home);
    const aSW = deriveStrengthsWeaknesses(as, fixture.away);
    const importanceScore = /final|semi|quarter|playoff|knockout/i.test(String(fixture.round || row?.stage?.name || '')) ? 75 : 52;

    return {
      fixture,
      prediction: {
        event: pred.best.event,
        marketKey: pred.best.key,
        confidence: Math.min(pred.confidence, 82),
        rawProbability: pct(pred.best.p),
        explanation: 'اختيار احتمالي محافظ مبني على نتائج الفريقين ونموذج بواسون وجودة البيانات المتاحة. لا توجد نتيجة مضمونة.',
        status: 'sportmonks-live'
      },
      metrics: {
        home: {
          form: hs.w + ' فوز • ' + hs.d + ' تعادل • ' + hs.l + ' خسارة',
          gf: hs.gf.toFixed(2), ga: hs.ga.toFixed(2), restDays: hs.restDays, rank: null, points: null
        },
        away: {
          form: as.w + ' فوز • ' + as.d + ' تعادل • ' + as.l + ' خسارة',
          gf: as.gf.toFixed(2), ga: as.ga.toFixed(2), restDays: as.restDays, rank: null, points: null
        }
      },
      strengths: { home: hSW.strengths, away: aSW.strengths },
      weaknesses: { home: hSW.weaknesses, away: aSW.weaknesses },
      absences: [],
      lineups: { available: false, teams: [] },
      importance: {
        score: importanceScore,
        notes: [importanceScore > 70 ? 'المباراة تبدو ضمن مرحلة حاسمة.' : 'تقييم الأهمية متوسط لعدم توفر سياق ترتيب كامل في الخطة الحالية.']
      },
      quality: {
        score: qualityScore,
        label: qualityScore >= 75 ? 'جيدة جدًا' : qualityScore >= 60 ? 'جيدة' : 'متوسطة',
        reasons: qualityReasons
      },
      sources: [{
        name: 'Sportmonks Football API',
        status: 'active',
        role: 'المباريات والفرق والنتائج والإحصائيات بحسب تغطية الاشتراك'
      }],
      reasons: [
        'متوسط الأهداف النظري: ' + pred.lambdaHome.toFixed(2) + ' للمضيف و' + pred.lambdaAway.toFixed(2) + ' للضيف.',
        'تمت مقارنة ' + hs.count + ' مباراة حديثة للمضيف و' + as.count + ' مباراة للضيف.',
        'الغيابات والتشكيلات لا تدخل في النتيجة إلا عند توفرها من المزود، لذلك خُفض سقف الثقة.'
      ],
      alternatives: pred.markets
        .filter(x => x.key !== pred.best.key)
        .slice(0, 4)
        .map(x => ({
          event: x.event,
          marketKey: x.key,
          probability: pct(x.p),
          calibratedScore: Math.round(clamp(x.p * 100 * 0.76 + qualityScore * 0.16, 0, 90))
        })),
      mode: 'sportmonks-live'
    };
  }, 10 * 60 * 1000);
}

async function analyzeApiFixture(id) {
  const fixtureId = Number(String(id).replace(/^af-/, ''));
  if (!Number.isFinite(fixtureId)) throw new Error('INVALID_FIXTURE_ID');
  return withCache('af:analysis:' + fixtureId, async () => {
    const detail = await apiFootball('/fixtures', { id: fixtureId });
    const row = detail.response?.[0];
    if (!row) throw new Error('FIXTURE_NOT_FOUND');
    const fixture = normalizeApiFixture(row);

    const tasks = await Promise.allSettled([
      apiFootball('/fixtures', { team: fixture.homeId, last: 8, status: 'FT' }),
      apiFootball('/fixtures', { team: fixture.awayId, last: 8, status: 'FT' }),
      apiFootball('/injuries', { fixture: fixtureId }),
      apiFootball('/fixtures/lineups', { fixture: fixtureId }),
      apiFootball('/standings', { league: fixture.leagueId, season: fixture.season }),
      apiFootball('/predictions', { fixture: fixtureId })
    ]);

    const [homeRecentR, awayRecentR, injuriesR, lineupsR, standingsR, predictionsR] = tasks;
    const homeRecent = homeRecentR.status === 'fulfilled' ? (homeRecentR.value.response || []) : [];
    const awayRecent = awayRecentR.status === 'fulfilled' ? (awayRecentR.value.response || []) : [];
    const injuries = injuriesR.status === 'fulfilled' ? mapInjuries(injuriesR.value) : [];
    const lineupsRaw = lineupsR.status === 'fulfilled' ? (lineupsR.value.response || []) : [];
    const standingsPayload = standingsR.status === 'fulfilled' ? standingsR.value : null;
    const providerPrediction = predictionsR.status === 'fulfilled' ? predictionsR.value.response?.[0] : null;

    const hs = recentFormFromApi(homeRecent, fixture.homeId);
    const as = recentFormFromApi(awayRecent, fixture.awayId);
    const homeStanding = standingsPayload ? extractStanding(standingsPayload, fixture.homeId) : null;
    const awayStanding = standingsPayload ? extractStanding(standingsPayload, fixture.awayId) : null;

    let qualityScore = 36;
    const qualityReasons = [];
    if (hs.count >= 5 && as.count >= 5) { qualityScore += 24; qualityReasons.push('عينة حديثة جيدة للفريقين'); }
    else if (hs.count + as.count >= 6) { qualityScore += 14; qualityReasons.push('عينة نتائج متوسطة'); }
    if (injuriesR.status === 'fulfilled') { qualityScore += 12; qualityReasons.push('تم فحص الغيابات والإصابات'); }
    if (standingsR.status === 'fulfilled') { qualityScore += 10; qualityReasons.push('تم إدخال الترتيب والسياق'); }
    if (lineupsRaw.length) { qualityScore += 8; qualityReasons.push('التشكيلات متاحة'); }
    if (providerPrediction) { qualityScore += 6; qualityReasons.push('مصدر تحليلي إضافي متاح'); }
    qualityScore = clamp(qualityScore, 35, 95);

    const pred = choosePrediction({ homeStats: hs, awayStats: as, injuryCount: injuries.length, qualityScore, providerPrediction });
    const hSW = deriveStrengthsWeaknesses(hs, fixture.home);
    const aSW = deriveStrengthsWeaknesses(as, fixture.away);

    const importanceNotes = [];
    let importanceScore = 50;
    if (homeStanding && awayStanding) {
      importanceNotes.push('الترتيب: ' + fixture.home + ' (' + homeStanding.rank + ')، ' + fixture.away + ' (' + awayStanding.rank + ')');
      if (Math.abs((homeStanding.rank || 0) - (awayStanding.rank || 0)) <= 3) importanceScore += 8;
      if ((homeStanding.rank || 99) <= 5 || (awayStanding.rank || 99) <= 5) importanceScore += 7;
    }
    if (/final|semi|quarter|playoff|knockout/i.test(String(fixture.round || ''))) {
      importanceScore += 20;
      importanceNotes.push('مرحلة إقصائية أو حاسمة بحسب الجولة');
    }
    importanceScore = clamp(importanceScore, 35, 90);

    const reasons = [
      'متوسط الأهداف النظري: ' + pred.lambdaHome.toFixed(2) + ' للمضيف و' + pred.lambdaAway.toFixed(2) + ' للضيف.',
      'تمت مقارنة ' + hs.count + ' مباراة حديثة للمضيف و' + as.count + ' مباراة للضيف.',
      injuries.length ? ('تم رصد ' + injuries.length + ' حالة غياب/إصابة في بيانات المزود.') : 'لم تظهر غيابات مؤكدة في المصدر وقت التحليل أو أن تغطيتها غير متاحة.',
      pred.advice ? ('إشارة تحليلية إضافية: ' + pred.advice) : 'لا توجد نصيحة تحليلية إضافية من المزود لهذه المواجهة.'
    ];

    return {
      fixture,
      prediction: {
        event: pred.best.event,
        marketKey: pred.best.key,
        confidence: pred.confidence,
        rawProbability: pct(pred.best.p),
        explanation: 'تم اختيار حدث واحد أعلى احتمالًا وفق نموذج أهداف محافظ والفورمة والغيابات وجودة البيانات المتاحة. النسبة تقدير وليست ضمانًا.',
        internalCode: buildWzCode(fixtureId, pred.best.key, pred.confidence, false),
        status: 'live-deep'
      },
      metrics: {
        home: { form: hs.w + ' فوز • ' + hs.d + ' تعادل • ' + hs.l + ' خسارة', gf: hs.gf.toFixed(2), ga: hs.ga.toFixed(2), restDays: hs.restDays, rank: homeStanding?.rank ?? null, points: homeStanding?.points ?? null },
        away: { form: as.w + ' فوز • ' + as.d + ' تعادل • ' + as.l + ' خسارة', gf: as.gf.toFixed(2), ga: as.ga.toFixed(2), restDays: as.restDays, rank: awayStanding?.rank ?? null, points: awayStanding?.points ?? null }
      },
      strengths: { home: hSW.strengths, away: aSW.strengths },
      weaknesses: { home: hSW.weaknesses, away: aSW.weaknesses },
      absences: injuries,
      lineups: { available: lineupsRaw.length > 0, teams: lineupsRaw.map(x => ({ team: x?.team?.name || '', formation: x?.formation || '', coach: x?.coach?.name || '' })) },
      importance: { score: importanceScore, notes: importanceNotes.length ? importanceNotes : ['تقييم الأهمية متوسط لعدم اكتمال بيانات السياق التنافسي.'] },
      quality: { score: qualityScore, label: qualityScore >= 80 ? 'مرتفعة' : qualityScore >= 60 ? 'جيدة' : 'متوسطة', reasons: qualityReasons },
      sources: [{ name: 'API-Football / API-Sports', status: 'active', role: 'المواجهات والنتائج والغيابات والتشكيلات والترتيب والتوقعات حسب التغطية' }],
      reasons,
      alternatives: pred.markets.filter(x => x.key !== pred.best.key).slice(0, 4).map(x => ({ event: x.event, probability: pct(x.p), calibratedScore: Math.round(clamp(x.p * 100 * 0.78 + qualityScore * 0.16, 0, 92)) })),
      mode: 'live-deep'
    };
  }, 10 * 60 * 1000);
}

async function analyzePublicFixture(id) {
  const eventId = String(id).replace(/^tsdb-/, '');
  return withCache('tsdb:analysis:' + eventId, async () => {
    const detail = await tsdb('lookupevent.php', { id: eventId });
    const event = detail.events?.[0];
    if (!event) throw new Error('FIXTURE_NOT_FOUND');
    const fixture = normalizeTsdbFixture(event);
    const [hR, aR] = await Promise.allSettled([
      tsdb('eventslast.php', { id: fixture.homeId }),
      tsdb('eventslast.php', { id: fixture.awayId })
    ]);
    const hRows = hR.status === 'fulfilled' ? (hR.value.results || hR.value.events || []) : [];
    const aRows = aR.status === 'fulfilled' ? (aR.value.results || aR.value.events || []) : [];
    const hs = recentFormFromTsdb(hRows, fixture.homeId);
    const as = recentFormFromTsdb(aRows, fixture.awayId);
    const qualityScore = (hs.count + as.count) >= 8 ? 52 : (hs.count + as.count) >= 4 ? 45 : 36;
    const pred = choosePrediction({ homeStats: hs, awayStats: as, injuryCount: 0, qualityScore });
    const hSW = deriveStrengthsWeaknesses(hs, fixture.home);
    const aSW = deriveStrengthsWeaknesses(as, fixture.away);
    const confidence = Math.min(pred.confidence, 62);

    return {
      fixture,
      prediction: {
        event: pred.best.event,
        marketKey: pred.best.key,
        confidence,
        rawProbability: pct(pred.best.p),
        explanation: 'تحليل مباشر محدود من المصدر العام. تم خفض الثقة لأن الغيابات والتشكيلات والترتيب المتقدم غير مكتملة.',
        internalCode: buildWzCode(eventId, pred.best.key, confidence, true),
        status: 'public-live-limited'
      },
      metrics: {
        home: { form: hs.w + ' فوز • ' + hs.d + ' تعادل • ' + hs.l + ' خسارة', gf: hs.gf.toFixed(2), ga: hs.ga.toFixed(2), restDays: null, rank: null, points: null },
        away: { form: as.w + ' فوز • ' + as.d + ' تعادل • ' + as.l + ' خسارة', gf: as.gf.toFixed(2), ga: as.ga.toFixed(2), restDays: null, rank: null, points: null }
      },
      strengths: { home: hSW.strengths, away: aSW.strengths },
      weaknesses: { home: hSW.weaknesses, away: aSW.weaknesses },
      absences: [],
      lineups: { available: false, teams: [] },
      importance: { score: 45, notes: ['تقييم أهمية المباراة محدود في المصدر العام.'] },
      quality: { score: qualityScore, label: 'محدودة', reasons: ['مواجهات ونتائج عامة مباشرة', 'الغيابات والتشكيلات المتقدمة غير متاحة بشكل موثوق في هذا الوضع'] },
      sources: [{ name: 'TheSportsDB Free', status: 'active', role: 'مواجهات ونتائج عامة مجانية' }],
      reasons: [
        'تمت مقارنة ' + hs.count + ' مباراة للمضيف و' + as.count + ' مباراة للضيف من العينة العامة المتاحة.',
        'استخدم نموذج أهداف محافظ مع خفض الثقة بسبب نقص البيانات المتقدمة.'
      ],
      alternatives: pred.markets.filter(x => x.key !== pred.best.key).slice(0, 4).map(x => ({ event: x.event, probability: pct(x.p), calibratedScore: Math.round(x.p * 55) })),
      mode: 'public-live'
    };
  }, 10 * 60 * 1000);
}

const INDEX_HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#061522">
<link rel="manifest" href="/manifest.webmanifest">
<title>توقعات وائل الزين V6</title>
<style>
:root{--bg:#030b13;--panel:#0a2134;--line:#ffffff18;--text:#f7fbff;--muted:#9eb4c3;--green:#2fe5a4;--blue:#4ab9ff;--warn:#ffd36a;--bad:#ff7787;--shadow:0 20px 65px #0008}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 80% 0,#174664 0,#061522 34%,#02070d 86%);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif}.wrap{width:min(1280px,calc(100% - 20px));margin:auto}.top{position:sticky;top:0;z-index:40;background:#06131fee;border-bottom:1px solid var(--line);backdrop-filter:blur(16px)}.topin{min-height:68px;display:flex;align-items:center;justify-content:space-between;gap:10px}.brand{display:flex;align-items:center;gap:10px}.logo{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;font-weight:1000;background:linear-gradient(135deg,var(--green),#caffeb);color:#03140d}.brand small{display:block;color:var(--muted)}.head{display:flex;gap:8px;align-items:center}.status,.basketTop{border:1px solid var(--line);border-radius:999px;padding:9px 12px;background:#ffffff08;color:white;font:inherit}.basketTop{cursor:pointer;font-weight:900}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--warn);margin-left:6px}.dot.ok{background:var(--green)}.dot.bad{background:var(--bad)}main{padding:15px 0 95px}.card{background:linear-gradient(180deg,#0d2940e8,#071827ee);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow)}.hero{padding:22px;display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center}.eyebrow{font-size:12px;color:var(--green);font-weight:900}.hero h1{font-size:clamp(29px,5vw,48px);margin:7px 0 9px}.hero p{margin:0;color:#c5d6df;line-height:1.85;max-width:820px}.mode{min-width:190px;padding:16px;border-radius:17px;background:#29e29c0d;border:1px solid #29e29c2c;text-align:center}.mode b{display:block;color:var(--green);font-size:18px}.mode span{font-size:12px;color:var(--muted)}.toolbar{margin-top:13px;padding:13px;display:grid;grid-template-columns:auto 1fr;gap:10px}.ranges{display:flex;gap:6px;flex-wrap:wrap}.range,.btn{border:0;font:inherit;cursor:pointer}.range{padding:10px 13px;border-radius:11px;background:#06131f;color:var(--muted);border:1px solid var(--line);font-weight:800}.range.active{background:#2fe5a418;color:var(--green);border-color:#2fe5a444}.search{display:flex;gap:8px;justify-content:flex-end}.search input,.voteForm input,.voteForm select{background:#05121d;border:1px solid var(--line);color:white;border-radius:12px;padding:12px 14px;outline:none}.search input{width:min(420px,100%)}.btn{padding:12px 16px;border-radius:12px;background:linear-gradient(135deg,#23d999,#66efbd);color:#03140d;font-weight:950}.btn.alt{background:#ffffff08;color:white;border:1px solid var(--line)}.fixtures{margin-top:13px;padding:15px}.heading{display:flex;justify-content:space-between;align-items:center}.heading h2{margin:0}.heading p{margin:4px 0 0;color:var(--muted);font-size:12px}.count{min-width:42px;height:35px;border-radius:999px;display:grid;place-items:center;background:#4ab9ff18;border:1px solid #4ab9ff38;color:#a5ddff;font-weight:900}.list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px;margin-top:14px}.fixture{width:100%;padding:15px;border-radius:18px;border:1px solid var(--line);background:#ffffff06;color:white;text-align:right;cursor:pointer}.fixture:hover{border-color:#2fe5a455;background:#2fe5a40b}.ftop,.fbottom{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:12px}.league{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:800}.teams{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin:14px 0;font-size:16px;font-weight:950}.team{display:flex;align-items:center;gap:8px}.team.away{justify-content:flex-end;text-align:left}.badge{width:32px;height:32px;border-radius:50%;object-fit:contain;background:#fff;padding:2px}.vs{color:var(--muted)}.ready{color:#78e9bd;font-weight:850}.known{color:var(--warn);font-weight:850}.empty,.loader{padding:55px 20px;text-align:center;color:var(--muted)}.spin{width:42px;height:42px;border:4px solid #ffffff18;border-top-color:var(--green);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px}@keyframes spin{to{transform:rotate(360deg)}}.modal{position:fixed;inset:0;z-index:100;background:#000b;backdrop-filter:blur(8px);display:none;padding:8px}.modal.open{display:grid;place-items:center}.dialog{width:min(1100px,100%);max-height:95dvh;overflow:auto;background:linear-gradient(180deg,#0d2940,#061623);border:1px solid #ffffff22;border-radius:24px}.modalTop{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;padding:13px 15px;background:#081c2bea;border-bottom:1px solid var(--line);backdrop-filter:blur(15px)}.close{width:43px;height:43px;border-radius:12px;border:1px solid var(--line);background:#ffffff0a;color:white;font-size:24px;cursor:pointer}.body{padding:17px}.matchHead{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;padding-bottom:15px;border-bottom:1px solid var(--line)}.matchHead h2{font-size:clamp(23px,5vw,36px);margin:0}.matchHead p{color:var(--muted);line-height:1.7}.confidence{width:118px;height:118px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--green) var(--pct),#ffffff12 0);position:relative}.confidence:after{content:"";position:absolute;inset:9px;border-radius:50%;background:#0a2235}.confidence div{position:relative;z-index:1;text-align:center}.confidence b{font-size:29px;color:var(--green)}.confidence small{display:block;color:var(--muted)}.pick{margin-top:15px;padding:19px;border-radius:19px;border:1px solid #2fe5a43a;background:linear-gradient(135deg,#2fe5a414,#4ab9ff0c)}.pick h3{font-size:clamp(23px,5vw,32px);margin:7px 0}.pick p{line-height:1.8;color:#cbd9e2}.chips,.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.chip{padding:7px 9px;border:1px solid var(--line);border-radius:10px;color:var(--muted);font-size:12px}.chip b{color:white}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:13px}.box,.section{padding:15px;border:1px solid var(--line);background:#ffffff05;border-radius:16px}.section{margin-top:13px}.box h4,.section h4{margin:0 0 9px}.metric{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #ffffff0d;font-size:13px}.metric:last-child{border:0}.metric span,.muted{color:var(--muted)}.item{padding:8px 0;border-bottom:1px solid #ffffff0d;line-height:1.7;font-size:13px}.item:last-child{border:0}.quality{height:8px;border-radius:999px;background:#ffffff13;overflow:hidden}.quality i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--green))}.voteForm{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-top:10px}.voteRow{display:flex;justify-content:space-between;gap:8px}.voteRow button,.remove{border:0;border-radius:8px;padding:6px 9px;background:#ff77871a;color:#ffb0b9;cursor:pointer}.basketBar{position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:70;width:min(720px,calc(100% - 18px));display:none;align-items:center;justify-content:space-between;gap:10px;background:#081d2ddd;border:1px solid #2fe5a455;border-radius:18px;padding:11px 13px;box-shadow:0 20px 60px #000b;backdrop-filter:blur(15px)}.basketBar.show{display:flex}.basketBar b{color:var(--green)}.basketItem{padding:12px;border:1px solid var(--line);border-radius:14px;background:#ffffff05;margin-bottom:9px}.basketItemTop{display:flex;justify-content:space-between;gap:10px}.footer{margin-top:13px;padding:15px;color:var(--muted);font-size:12px;text-align:center;line-height:1.8}@media(max-width:820px){.hero{grid-template-columns:1fr}.mode{text-align:right}.toolbar{grid-template-columns:1fr}.search{justify-content:stretch}.search input{width:100%}.list,.grid2{grid-template-columns:1fr}.matchHead{flex-direction:column}.confidence{width:100%;height:auto;border-radius:15px;background:#2fe5a411;padding:11px}.confidence:after{display:none}.confidence div{display:flex;gap:8px;align-items:center}.voteForm{grid-template-columns:1fr}.brand small{display:none}}@media(max-width:540px){.wrap{width:min(100% - 14px,1280px)}.status{display:none}.ranges{display:grid;grid-template-columns:1fr 1fr}.range{width:100%}.search{flex-direction:column}.modal{padding:0}.dialog{width:100%;height:100dvh;max-height:100dvh;border-radius:0}.modalTop{padding-top:max(12px,env(safe-area-inset-top))}.body{padding-bottom:max(20px,env(safe-area-inset-bottom))}}
</style>
</head>
<body>
<header class="top"><div class="wrap topin"><div class="brand"><div class="logo">WZ</div><div><b>توقعات وائل الزين</b><small>تحليل كرة القدم • V6</small></div></div><div class="head"><div class="status"><i id="serverDot" class="dot"></i><span id="serverText">فحص الخادم…</span></div><button id="basketTop" class="basketTop">🧺 السلة <span id="basketTopCount">0</span></button></div></div></header>
<main class="wrap">
<section class="card hero"><div><div class="eyebrow">Sportmonks + مصادر احتياطية</div><h1>المباريات العالمية في واجهة عربية حديثة</h1><p>يعتمد التطبيق على Sportmonks عند توفر المفتاح، ثم ينتقل تلقائيًا إلى المصادر الاحتياطية عند الفشل. اختر المباراة، راجع التحليل، وأضف أقوى التوقعات إلى سلة تُشارك كصورة أو نص عبر واتساب.</p></div><div class="mode"><b id="modeText">جارٍ الاتصال</b><span>مصدر البيانات الحالي</span></div></section>
<section class="card toolbar"><div class="ranges"><button class="range active" data-days="1">اليوم</button><button class="range" data-days="7">7 أيام</button><button class="range" data-days="14">14 يوم</button><button class="range" data-days="30">30 يوم</button><button class="range" data-range="next-month">الشهر القادم</button></div><div class="search"><input id="search" placeholder="ابحث عن فريق أو بطولة"><button id="refresh" class="btn">تحديث</button></div></section>
<section class="card fixtures"><div class="heading"><div><h2>المواجهات القادمة</h2><p id="fixtureMeta">تحميل المباريات…</p></div><div id="count" class="count">0</div></div><div id="fixtureList" class="list"></div></section>
<div class="card footer">التوقعات احتمالية وليست ضمانًا. لا تعتمد على أي محلل أو خوارزمية وحدها، ولا تستخدم مبلغًا لا تتحمل خسارته.</div>
</main>
<div id="analysisModal" class="modal"><div class="dialog"><div class="modalTop"><b>تفاصيل التحليل</b><button class="close" data-close="analysisModal">×</button></div><div id="analysisBody" class="body"></div></div></div>
<div id="basketModal" class="modal"><div class="dialog"><div class="modalTop"><b>سلة التوقعات</b><button class="close" data-close="basketModal">×</button></div><div class="body"><div id="basketItems"></div><div class="actions"><button id="shareImage" class="btn">مشاركة كصورة</button><button id="shareText" class="btn alt">واتساب كنص</button><button id="clearBasket" class="btn alt">تفريغ السلة</button></div></div></div></div>
<div id="basketBar" class="basketBar"><div><b><span id="basketCount">0</span> توقعات</b><div class="muted">مرتبة من الأعلى ثقة</div></div><button id="openBasket" class="btn">فتح السلة</button></div>
<script>
(function(){
'use strict';
var state={days:1,range:'',fixtures:[],basket:load('wzBasket',[]),summaries:load('wzSummaries',{}),votes:load('wzVotes',{}),analysis:null};
var $=function(s){return document.querySelector(s)};
function load(k,d){try{return JSON.parse(localStorage.getItem(k)||JSON.stringify(d))}catch{return d}}
function save(k,v){localStorage.setItem(k,JSON.stringify(v))}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function fmtDate(v){try{return new Intl.DateTimeFormat('ar-OM',{weekday:'short',day:'numeric',month:'long'}).format(new Date(v))}catch{return v}}
function fmtTime(v){try{return new Intl.DateTimeFormat('ar-OM',{hour:'2-digit',minute:'2-digit'}).format(new Date(v))}catch{return ''}}
function openModal(id){var m=$('#'+id);m.classList.add('open');document.body.style.overflow='hidden'}
function closeModal(id){$('#'+id).classList.remove('open');document.body.style.overflow=''}
document.querySelectorAll('[data-close]').forEach(function(b){b.onclick=function(){closeModal(b.getAttribute('data-close'))}});
document.querySelectorAll('.modal').forEach(function(m){m.onclick=function(e){if(e.target===m)closeModal(m.id)}});
async function api(path){var r=await fetch(path,{cache:'no-store'});var d=await r.json().catch(function(){return {}});if(!r.ok)throw new Error(d.message||d.detail||('HTTP '+r.status));return d}
async function health(){try{var h=await api('/api/health');$('#serverDot').className='dot ok';$('#serverText').textContent='الخادم متصل';var names={'sportmonks-live':'Sportmonks مباشر','deep-live':'API-Football مباشر','public-live':'مصدر عام محدود','public-live-fallback':'مصدر احتياطي'};$('#modeText').textContent=names[h.mode]||h.mode}catch(e){$('#serverDot').className='dot bad';$('#serverText').textContent='الخادم غير متصل';$('#modeText').textContent='تعذر الاتصال'}}
function query(){return state.range==='next-month'?'?range=next-month':'?days='+state.days}
async function loadFixtures(){var root=$('#fixtureList');root.innerHTML='<div class="loader"><div class="spin"></div>تحميل المواجهات…</div>';try{var d=await api('/api/fixtures'+query());state.fixtures=d.fixtures||[];$('#fixtureMeta').textContent=(d.rangeLabel||'الفترة المحددة')+' • '+(d.provider||'')+(d.warning?' • تم تشغيل مصدر بديل':'');renderFixtures()}catch(e){root.innerHTML='<div class="empty">تعذر التحميل: '+esc(e.message)+'</div>';$('#count').textContent='0'}}
function logo(url,name){return url?'<img class="badge" src="'+esc(url)+'" alt="'+esc(name)+'" loading="lazy" onerror="this.style.display=\'none\'">':''}
function renderFixtures(){var q=$('#search').value.trim().toLowerCase();var rows=state.fixtures.filter(function(f){return !q||((f.home+' '+f.away+' '+(f.homeOriginal||'')+' '+(f.awayOriginal||'')+' '+(f.league||'')+' '+(f.leagueOriginal||'')).toLowerCase().indexOf(q)>=0)});rows.sort(function(a,b){var sa=state.summaries[a.id]||{},sb=state.summaries[b.id]||{};return Number(sb.confidence||0)-Number(sa.confidence||0)||new Date(a.date)-new Date(b.date)});$('#count').textContent=rows.length;var root=$('#fixtureList');root.innerHTML='';if(!rows.length){root.innerHTML='<div class="empty">لا توجد مباريات مطابقة.</div>';return}rows.forEach(function(f){var s=state.summaries[f.id];var b=document.createElement('button');b.className='fixture';b.innerHTML='<div class="ftop"><span class="league">'+esc(f.league||f.leagueOriginal)+'</span><span>'+esc(fmtTime(f.date))+'</span></div><div class="teams"><span class="team">'+logo(f.homeLogo,f.home)+esc(f.home)+'</span><span class="vs">×</span><span class="team away">'+esc(f.away)+logo(f.awayLogo,f.away)+'</span></div><div class="fbottom"><span>'+esc(fmtDate(f.date))+'</span><span class="'+(s?'known':'ready')+'">'+(s?esc(s.event)+' • '+esc(s.confidence)+'%':'اضغط للتحليل')+'</span></div>';b.onclick=function(){analyze(f)};root.appendChild(b)})}
function metrics(m){m=m||{};return '<div class="metric"><span>آخر النتائج</span><b>'+esc(m.form||'غير متاح')+'</b></div><div class="metric"><span>معدل التسجيل</span><b>'+esc(m.gf==null?'—':m.gf)+'</b></div><div class="metric"><span>معدل الاستقبال</span><b>'+esc(m.ga==null?'—':m.ga)+'</b></div><div class="metric"><span>الراحة</span><b>'+esc(m.restDays==null?'—':m.restDays+' يوم')+'</b></div>'}
function items(arr,empty){if(!arr||!arr.length)return '<div class="item muted">'+esc(empty)+'</div>';return arr.map(function(x){return '<div class="item">'+esc(typeof x==='string'?x:(x.player?((x.team?x.team+' • ':'')+x.player+' — '+(x.reason||x.type||'غياب')):JSON.stringify(x)))+'</div>'}).join('')}
function optionList(a){var all=[a.prediction].concat((a.alternatives||[]).map(function(x){return {event:x.event,marketKey:x.marketKey||x.event}}));var seen={};return all.filter(function(x){var k=x.marketKey||x.event;if(seen[k])return false;seen[k]=1;return true}).map(function(x){return '<option value="'+esc(x.marketKey||x.event)+'">'+esc(x.event)+'</option>'}).join('')}
function consensus(a){var id=a.fixture.id,v=state.votes[id]||[],support=v.filter(function(x){return x.marketKey===a.prediction.marketKey}).length,oppose=v.length-support,label=!v.length?'لا توجد آراء بعد':support>oppose?'مدعوم بالأغلبية':oppose>support?'متعارض مع الأغلبية':'غير حاسم';return '<div class="section"><h4>مقارنة توقعات تيك توك والمحللين</h4><div class="metric"><span>النتيجة</span><b>'+esc(label)+'</b></div><div id="votes">'+(v.length?v.map(function(x,i){return '<div class="item voteRow"><span><b>'+esc(x.source)+'</b> — '+esc(x.event)+'</span><button data-vote-remove="'+i+'">حذف</button></div>'}).join(''):'<div class="item muted">أضف التوقعات يدويًا؛ التطبيق يقارن رأي الأغلبية مع رأيه.</div>')+'</div><div class="voteForm"><input id="voteSource" placeholder="اسم المصدر مثل لينا"><select id="votePick">'+optionList(a)+'</select><button id="addVote" class="btn">إضافة</button></div></div>'}
function renderAnalysis(a){state.analysis=a;var f=a.fixture||{},p=a.prediction||{},q=a.quality||{};state.summaries[f.id]={event:p.event,confidence:p.confidence};save('wzSummaries',state.summaries);renderFixtures();var alts=(a.alternatives||[]).map(function(x){return '<div class="metric"><span>'+esc(x.event)+'</span><b>'+esc(x.probability)+'%</b></div>'}).join('')||'<div class="item muted">لا توجد بدائل.</div>';var sources=(a.sources||[]).map(function(x){return '<div class="item"><b>'+esc(x.name)+'</b><div class="muted">'+esc(x.role||'')+'</div></div>'}).join('');$('#analysisBody').innerHTML='<div class="matchHead"><div><h2>'+esc(f.home)+' × '+esc(f.away)+'</h2><p>'+esc(f.league||f.leagueOriginal||'')+'<br>'+esc(fmtDate(f.date))+' • '+esc(fmtTime(f.date))+'</p></div><div class="confidence" style="--pct:'+esc(p.confidence||0)+'%"><div><b>'+esc(p.confidence||0)+'%</b><small>درجة الثقة</small></div></div></div><div class="pick"><div class="eyebrow">🎯 رأي التطبيق الأقوى</div><h3>'+esc(p.event||'غير متاح')+'</h3><p>'+esc(p.explanation||'')+'</p><div class="chips"><span class="chip">الاحتمال الخام: <b>'+esc(p.rawProbability||0)+'%</b></span><span class="chip">جودة البيانات: <b>'+esc(q.label||'—')+'</b></span><span class="chip">المصدر: <b>'+esc(a.mode||'—')+'</b></span></div><div class="actions"><button id="addBasket" class="btn">إضافة إلى السلة</button></div></div><div class="grid2"><div class="box"><h4>'+esc(f.home)+'</h4>'+metrics(a.metrics&&a.metrics.home)+'</div><div class="box"><h4>'+esc(f.away)+'</h4>'+metrics(a.metrics&&a.metrics.away)+'</div></div><div class="grid2"><div class="box"><h4>نقاط القوة</h4>'+items((a.strengths&&a.strengths.home||[]).concat(a.strengths&&a.strengths.away||[]),'لا توجد إشارات كافية')+'</div><div class="box"><h4>نقاط الضعف</h4>'+items((a.weaknesses&&a.weaknesses.home||[]).concat(a.weaknesses&&a.weaknesses.away||[]),'لا توجد إشارات كافية')+'</div></div><div class="section"><h4>الغيابات المتاحة</h4>'+items(a.absences||[],'لا توجد غيابات مؤكدة أو أن التغطية غير متاحة.')+'</div><div class="grid2"><div class="box"><h4>أهمية المباراة</h4><div class="metric"><span>الدرجة</span><b>'+esc(a.importance&&a.importance.score||'—')+'/100</b></div>'+items(a.importance&&a.importance.notes||[],'لا توجد تفاصيل')+'</div><div class="box"><h4>جودة البيانات</h4><div class="metric"><span>الدرجة</span><b>'+esc(q.score||'—')+'/100</b></div><div class="quality"><i style="width:'+esc(q.score||0)+'%"></i></div>'+items(q.reasons||[],'لا توجد تفاصيل')+'</div></div><div class="section"><h4>أسباب الاختيار</h4>'+items(a.reasons||[],'لا توجد أسباب إضافية')+'</div><div class="grid2"><div class="box"><h4>بدائل</h4>'+alts+'</div><div class="box"><h4>المصادر</h4>'+sources+'</div></div>'+consensus(a);$('#addBasket').onclick=function(){addBasket(a)};bindVotes(a)}
function bindVotes(a){var add=$('#addVote');if(add)add.onclick=function(){var source=$('#voteSource').value.trim(),sel=$('#votePick');if(!source)return alert('اكتب اسم المصدر');var id=a.fixture.id;state.votes[id]=state.votes[id]||[];state.votes[id].push({source:source,marketKey:sel.value,event:sel.options[sel.selectedIndex].textContent});save('wzVotes',state.votes);renderAnalysis(a)};document.querySelectorAll('[data-vote-remove]').forEach(function(b){b.onclick=function(){state.votes[a.fixture.id].splice(Number(b.getAttribute('data-vote-remove')),1);save('wzVotes',state.votes);renderAnalysis(a)}})}
async function analyze(f){openModal('analysisModal');$('#analysisBody').innerHTML='<div class="loader"><div class="spin"></div>جارٍ تحليل '+esc(f.home)+' و '+esc(f.away)+'…</div>';try{renderAnalysis(await api('/api/analyze/'+encodeURIComponent(f.id)))}catch(e){$('#analysisBody').innerHTML='<div class="empty">تعذر التحليل: '+esc(e.message)+'</div>'}}
function addBasket(a){var x={id:a.fixture.id,home:a.fixture.home,away:a.fixture.away,league:a.fixture.league||a.fixture.leagueOriginal,date:a.fixture.date,event:a.prediction.event,marketKey:a.prediction.marketKey,confidence:a.prediction.confidence};state.basket=state.basket.filter(function(i){return i.id!==x.id});state.basket.push(x);state.basket.sort(function(i,j){return j.confidence-i.confidence});save('wzBasket',state.basket);updateBasket();$('#addBasket').textContent='تمت الإضافة ✓'}
function updateBasket(){var n=state.basket.length;$('#basketCount').textContent=n;$('#basketTopCount').textContent=n;$('#basketBar').classList.toggle('show',n>0);renderBasket()}
function renderBasket(){var root=$('#basketItems');if(!state.basket.length){root.innerHTML='<div class="empty">السلة فارغة.</div>';return}root.innerHTML=state.basket.map(function(x,i){return '<div class="basketItem"><div class="basketItemTop"><div><b>'+esc(x.home)+' × '+esc(x.away)+'</b><div class="muted">'+esc(x.league)+' • '+esc(fmtDate(x.date))+' '+esc(fmtTime(x.date))+'</div></div><button class="remove" data-basket-remove="'+i+'">حذف</button></div><div class="item"><b>'+esc(x.event)+'</b> — '+esc(x.confidence)+'%</div></div>'}).join('');document.querySelectorAll('[data-basket-remove]').forEach(function(b){b.onclick=function(){state.basket.splice(Number(b.getAttribute('data-basket-remove')),1);save('wzBasket',state.basket);updateBasket()}})}
function basketText(){return '⚽ توقعات وائل الزين\n\n'+state.basket.map(function(x,i){return (i+1)+') '+x.home+' × '+x.away+'\n🎯 '+x.event+'\n📊 الثقة: '+x.confidence+'%\n🗓 '+fmtDate(x.date)+' '+fmtTime(x.date)}).join('\n\n')+'\n\n⚠️ توقعات احتمالية وليست ضمانًا.'}
function wrap(ctx,text,x,y,w,lh){var words=String(text).split(' '),line='';for(var i=0;i<words.length;i++){var test=line+words[i]+' ';if(ctx.measureText(test).width>w&&i>0){ctx.fillText(line,x,y);line=words[i]+' ';y+=lh}else line=test}ctx.fillText(line,x,y);return y+lh}
async function imageBlob(){if(!state.basket.length)throw new Error('السلة فارغة');var W=1080,H=300+state.basket.length*190,c=document.createElement('canvas');c.width=W;c.height=H;var ctx=c.getContext('2d'),g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'#0d2940');g.addColorStop(1,'#03101a');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);ctx.direction='rtl';ctx.textAlign='right';ctx.fillStyle='#2fe5a4';ctx.font='bold 52px Arial';ctx.fillText('توقعات وائل الزين',1010,85);ctx.fillStyle='#c5d6df';ctx.font='29px Arial';ctx.fillText('أقوى التوقعات المختارة',1010,135);var y=215;state.basket.forEach(function(x,i){ctx.fillStyle='rgba(255,255,255,.06)';ctx.beginPath();ctx.roundRect(65,y-42,950,165,22);ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 33px Arial';ctx.fillText((i+1)+'. '+x.home+' × '+x.away,980,y);ctx.fillStyle='#2fe5a4';ctx.font='bold 30px Arial';var ny=wrap(ctx,'التوقع: '+x.event,980,y+46,880,38);ctx.fillStyle='#ffd36a';ctx.font='bold 26px Arial';ctx.fillText('الثقة '+x.confidence+'% • '+fmtDate(x.date)+' '+fmtTime(x.date),980,ny+5);y+=190});ctx.fillStyle='#9eb4c3';ctx.font='24px Arial';ctx.fillText('التوقعات احتمالية وليست ضمانًا.',1010,H-35);return new Promise(function(resolve){c.toBlob(resolve,'image/png',.95)})}
async function shareImage(){var blob=await imageBlob(),file=new File([blob],'wail-elzain-predictions.png',{type:'image/png'});if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({title:'توقعات وائل الزين',text:'أقوى التوقعات المختارة',files:[file]})}else{var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=file.name;a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},1000)}}
document.querySelectorAll('.range').forEach(function(b){b.onclick=function(){document.querySelectorAll('.range').forEach(function(x){x.classList.remove('active')});b.classList.add('active');state.range=b.getAttribute('data-range')||'';state.days=Number(b.getAttribute('data-days')||1);loadFixtures()}});
$('#refresh').onclick=loadFixtures;$('#search').oninput=renderFixtures;$('#openBasket').onclick=$('#basketTop').onclick=function(){renderBasket();openModal('basketModal')};$('#clearBasket').onclick=function(){if(confirm('تفريغ السلة؟')){state.basket=[];save('wzBasket',state.basket);updateBasket()}};$('#shareText').onclick=function(){if(!state.basket.length)return alert('السلة فارغة');location.href='https://wa.me/?text='+encodeURIComponent(basketText())};$('#shareImage').onclick=function(){shareImage().catch(function(e){alert(e.message)})};
health();loadFixtures();updateBasket();if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}
})();
</script>
</body>
</html>`;

const MANIFEST = JSON.stringify({
  name: 'توقعات وائل الزين V6',
  short_name: 'WZ توقعات',
  start_url: '/',
  display: 'standalone',
  background_color: '#04101b',
  theme_color: '#071421',
  lang: 'ar',
  dir: 'rtl'
});

const SERVICE_WORKER = "const CACHE='wz-v6-shell-1';const SHELL=['/','/manifest.webmanifest'];self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname.startsWith('/api/'))return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))))});";


function requestAllowed(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let bucket = requestBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= 60000) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  requestBuckets.set(ip, bucket);
  return bucket.count <= RATE_LIMIT_PER_MINUTE;
}

function securityHeaders(contentType = '') {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };
  if (String(contentType).includes('text/html')) {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  }
  return headers;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...securityHeaders('application/json')
  });
  res.end(body);
}

function sendText(res, status, body, contentType, cacheControl = 'no-cache') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...securityHeaders(contentType)
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  try {
    if (!requestAllowed(req)) {
      return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'طلبات كثيرة جدًا. حاول بعد دقيقة.' });
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'Wail Elzain Football AI',
        version: APP_VERSION,
        mode: SPORTMONKS_TOKEN ? 'sportmonks-live' : API_KEY ? 'deep-live' : ENABLE_PUBLIC_FALLBACK ? 'public-live' : 'no-provider',
        providerConfigured: Boolean(SPORTMONKS_TOKEN || API_KEY),
        providers: {
          sportmonks: Boolean(SPORTMONKS_TOKEN),
          apiFootball: Boolean(API_KEY),
          publicFallback: ENABLE_PUBLIC_FALLBACK
        },
        publicFallback: ENABLE_PUBLIC_FALLBACK,
        serverTime: new Date().toISOString()
      });
    }

    if (req.method === 'GET' && pathname === '/api/fixtures') {
      const range = rangeFromRequest(url);
      const failures = [];

      if (SPORTMONKS_TOKEN) {
        try {
          const fixtures = await getSportmonksFixtures(range);
          return sendJson(res, 200, {
            fixtures, mode: 'sportmonks-live', provider: 'Sportmonks',
            rangeLabel: range.label, from: range.from, to: range.to,
            partial: fixtures.length >= 600
          });
        } catch (error) {
          failures.push('Sportmonks: ' + error.message);
        }
      }

      if (API_KEY) {
        try {
          const fixtures = await getApiFixtures(range);
          return sendJson(res, 200, {
            fixtures, mode: 'deep-live', provider: 'API-Football',
            rangeLabel: range.label, from: range.from, to: range.to,
            partial: false, warning: failures.join(' | ') || undefined
          });
        } catch (error) {
          failures.push('API-Football: ' + error.message);
        }
      }

      if (ENABLE_PUBLIC_FALLBACK) {
        try {
          const fixtures = await getPublicFixtures(range);
          return sendJson(res, 200, {
            fixtures,
            mode: failures.length ? 'public-live-fallback' : 'public-live',
            provider: 'TheSportsDB Free',
            rangeLabel: range.label, from: range.from, to: range.to,
            warning: failures.join(' | ') || undefined,
            partial: fixtures.length >= 500
          });
        } catch (error) {
          failures.push('TheSportsDB: ' + error.message);
        }
      }

      return sendJson(res, 502, {
        error: 'UPSTREAM_FAILURE',
        message: 'تعذر تحميل المباريات من جميع المصادر.',
        detail: failures.join(' | ')
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/analyze/')) {
      const id = decodeURIComponent(pathname.slice('/api/analyze/'.length));
      try {
        if (id.startsWith('sm-')) {
          if (!SPORTMONKS_TOKEN) {
            return sendJson(res, 503, {
              error: 'PROVIDER_KEY_REQUIRED',
              message: 'هذه المباراة تتطلب مفتاح Sportmonks على الخادم.'
            });
          }
          return sendJson(res, 200, await analyzeSportmonksFixture(id));
        }
        if (id.startsWith('af-')) {
          if (!API_KEY) return sendJson(res, 503, { error: 'PROVIDER_KEY_REQUIRED', message: 'هذه المباراة تتطلب مفتاح API-Football على الخادم.' });
          return sendJson(res, 200, await analyzeApiFixture(id));
        }
        if (id.startsWith('tsdb-')) {
          if (!ENABLE_PUBLIC_FALLBACK) return sendJson(res, 503, { error: 'PUBLIC_FALLBACK_DISABLED', message: 'المصدر العام غير مفعّل.' });
          return sendJson(res, 200, await analyzePublicFixture(id));
        }
        const indexed = fixtureIndex.get(id);
        if (indexed?.source === 'Sportmonks' && SPORTMONKS_TOKEN) {
          return sendJson(res, 200, await analyzeSportmonksFixture(indexed.id));
        }
        if (indexed?.source === 'API-Football' && API_KEY) return sendJson(res, 200, await analyzeApiFixture(indexed.id));
        if (indexed?.source === 'TheSportsDB Free' && ENABLE_PUBLIC_FALLBACK) return sendJson(res, 200, await analyzePublicFixture(indexed.id));
        return sendJson(res, 400, { error: 'UNKNOWN_FIXTURE_ID', message: 'معرّف المباراة غير معروف. حدّث قائمة المباريات ثم حاول مجددًا.' });
      } catch (error) {
        return sendJson(res, 502, { error: 'ANALYSIS_FAILED', message: 'تعذر إكمال التحليل لهذه المواجهة.', detail: error.message });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (pathname === '/' || pathname === '/index.html') return sendText(res, 200, INDEX_HTML, 'text/html; charset=utf-8', 'no-cache');
    if (pathname === '/manifest.webmanifest') return sendText(res, 200, MANIFEST, 'application/manifest+json; charset=utf-8', 'public, max-age=3600');
    if (pathname === '/sw.js') return sendText(res, 200, SERVICE_WORKER, 'application/javascript; charset=utf-8', 'no-cache');
    return sendText(res, 200, INDEX_HTML, 'text/html; charset=utf-8', 'no-cache');
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'SERVER_ERROR', message: 'خطأ داخلي في الخادم.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Wail Elzain Football AI V6 running on port ' + PORT);
});
