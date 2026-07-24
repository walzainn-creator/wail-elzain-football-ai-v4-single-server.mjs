import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_FOOTBALL_KEY || '').trim();
const ENABLE_PUBLIC_FALLBACK = String(process.env.ENABLE_PUBLIC_FALLBACK || 'true') !== 'false';
const CACHE_TTL_MS = Math.max(30, Number(process.env.CACHE_TTL_SECONDS || 600)) * 1000;
const API_BASE = 'https://v3.football.api-sports.io';
const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/123';
const APP_VERSION = '5.0.0';

const cache = new Map();
const fixtureIndex = new Map();

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
    home: safeName(teams.home?.name, 'المضيف'),
    away: safeName(teams.away?.name, 'الضيف'),
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
    home: safeName(event.strHomeTeam, 'المضيف'),
    away: safeName(event.strAwayTeam, 'الضيف'),
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
<meta name="theme-color" content="#071421">
<meta name="description" content="توقعات وائل الزين - تحليل مباريات كرة القدم">
<link rel="manifest" href="/manifest.webmanifest">
<title>توقعات وائل الزين • LIVE V5</title>
<style>
:root{--bg:#04101b;--panel:#0a2134;--panel2:#0c2a42;--line:#ffffff18;--text:#f7fbff;--muted:#9ab1c2;--green:#30e3a4;--green2:#70f4c2;--blue:#52b8ff;--warn:#ffd36a;--bad:#ff7b88;--shadow:0 22px 70px #0008}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(circle at 85% 5%,#153d5b 0,#071725 34%,#030911 86%);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif}.wrap{width:min(1280px,calc(100% - 24px));margin:auto}.top{position:sticky;top:0;z-index:40;background:#06131fee;border-bottom:1px solid var(--line);backdrop-filter:blur(16px)}.topin{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:12px}.brand{display:flex;align-items:center;gap:12px}.logo{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;font-weight:1000;font-size:18px;background:linear-gradient(135deg,var(--green),#c4ffe8);color:#03140d;box-shadow:0 10px 30px #29e29c35}.brand b{display:block;font-size:19px}.brand small{display:block;color:var(--muted);margin-top:2px}.server{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;padding:10px 13px;background:#ffffff08;font-size:13px}.dot{width:9px;height:9px;border-radius:50%;background:var(--warn);box-shadow:0 0 16px currentColor}.dot.ok{background:var(--green)}.dot.bad{background:var(--bad)}
main{padding:18px 0 44px}.card{background:linear-gradient(180deg,#0d2940e8,#071827ee);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow)}.hero{padding:24px;display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center}.eyebrow{font-size:12px;color:var(--green);font-weight:900}.hero h1{font-size:clamp(30px,5vw,52px);margin:8px 0 10px;line-height:1.12}.hero p{margin:0;color:#c4d5df;line-height:1.9;max-width:850px}.mode{min-width:190px;padding:18px;border-radius:18px;background:#29e29c0d;border:1px solid #29e29c2c;text-align:center}.mode b{display:block;color:var(--green);font-size:19px}.mode span{font-size:12px;color:var(--muted)}
.toolbar{display:grid;grid-template-columns:auto 1fr;gap:12px;padding:14px;margin-top:14px;align-items:center}.ranges{display:flex;gap:6px;flex-wrap:wrap}.range,.btn{border:0;font:inherit;cursor:pointer}.range{background:#06131f;color:var(--muted);padding:11px 14px;border-radius:12px;border:1px solid var(--line);font-weight:750}.range.active{background:#29e29c17;color:var(--green);border-color:#29e29c40}.search{display:flex;gap:9px;justify-content:flex-end}.search input{width:min(440px,100%);background:#05121d;border:1px solid var(--line);color:white;border-radius:13px;padding:13px 15px;outline:none;font-size:15px}.btn{padding:13px 18px;border-radius:13px;font-weight:900;background:linear-gradient(135deg,#23d999,#66efbd);color:#03140d}.btn.secondary{background:#ffffff08;color:white;border:1px solid var(--line)}
.fixtures{margin-top:14px;padding:17px}.heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.heading h2{margin:0;font-size:23px}.heading p{color:var(--muted);margin:5px 0 0;font-size:12px}.count{min-width:42px;height:36px;border-radius:999px;display:grid;place-items:center;background:#52b8ff18;border:1px solid #52b8ff36;color:#9ad8ff;font-weight:900}.fixtureList{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:15px}.fixture{border:1px solid var(--line);background:#ffffff06;color:white;border-radius:18px;padding:16px;text-align:right;cursor:pointer;width:100%;transition:.2s}.fixture:hover{transform:translateY(-2px);border-color:#30e3a455;background:#30e3a40b}.ftop,.fbottom{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px}.league{font-weight:700}.teams{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;margin:15px 0;font-size:17px;font-weight:950}.teams .away{text-align:left}.vs{color:var(--muted)}.ready{color:#79ecc1;font-weight:800}.emptyList{padding:50px;text-align:center;color:var(--muted)}
.modal{position:fixed;inset:0;z-index:100;background:#000a;backdrop-filter:blur(8px);display:none;padding:8px}.modal.open{display:grid;place-items:center}.dialog{width:min(1120px,100%);max-height:95dvh;overflow:auto;background:linear-gradient(180deg,#0d2940,#061623);border:1px solid #ffffff22;border-radius:26px;box-shadow:0 30px 100px #000c}.modalTop{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;background:#081c2bea;border-bottom:1px solid var(--line);backdrop-filter:blur(15px)}.modalTop b{font-size:18px}.close{border:1px solid var(--line);background:#ffffff0a;color:white;width:44px;height:44px;border-radius:13px;font-size:24px;cursor:pointer}.analysisBody{padding:18px}.loader{padding:70px 20px;text-align:center;color:var(--muted)}.spin{width:42px;height:42px;border:4px solid #ffffff16;border-top-color:var(--green);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 13px}@keyframes spin{to{transform:rotate(360deg)}}
.matchHead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding-bottom:16px;border-bottom:1px solid var(--line)}.matchHead h2{font-size:clamp(24px,5vw,38px);margin:0}.matchHead p{color:var(--muted);margin:7px 0 0;line-height:1.7}.confidence{width:122px;height:122px;flex:0 0 auto;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--green) var(--pct),#ffffff12 0);position:relative}.confidence:after{content:"";position:absolute;inset:9px;background:#0a2235;border-radius:50%}.confidence div{position:relative;z-index:1;text-align:center}.confidence b{font-size:30px;color:var(--green)}.confidence small{display:block;color:var(--muted)}.pick{margin-top:16px;border:1px solid #30e3a43a;background:linear-gradient(135deg,#30e3a414,#52b8ff0c);border-radius:20px;padding:20px}.pick .lab{color:var(--green);font-weight:950;font-size:12px}.pick h3{font-size:clamp(24px,5vw,34px);margin:8px 0}.pick p{color:#cbd9e2;line-height:1.8;margin:0}.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.chip{padding:8px 10px;border:1px solid var(--line);border-radius:11px;color:var(--muted);font-size:12px}.chip b{color:white}.codeBox{margin-top:15px;padding:15px;border-radius:16px;background:#030c14;border:1px dashed #ffffff32}.codeLabel{font-size:12px;color:var(--muted);margin-bottom:8px}.codeRow{display:grid;grid-template-columns:1fr auto;gap:10px}.codeRow code{direction:ltr;text-align:left;display:block;overflow:auto;white-space:nowrap;font-size:17px;padding:12px;border-radius:11px;background:#071725}.copy{border:0;border-radius:11px;padding:0 18px;background:var(--green);color:#03140d;font-weight:950;cursor:pointer}.codeNote{font-size:11px;color:#e7c978;margin-top:8px;line-height:1.7}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:14px}.box{padding:16px;border:1px solid var(--line);background:#ffffff05;border-radius:17px}.box h4{font-size:16px;margin:0 0 10px}.metric{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #ffffff0d;font-size:13px}.metric:last-child{border:0}.metric span{color:var(--muted)}.section{margin-top:14px;padding:16px;border:1px solid var(--line);border-radius:17px;background:#ffffff04}.section h4{margin:0 0 10px;font-size:17px}.listItem{padding:9px 0;border-bottom:1px solid #ffffff0d;line-height:1.7;font-size:13px}.listItem:last-child{border:0}.muted{color:var(--muted)}.qualityBar{height:9px;background:#ffffff13;border-radius:999px;overflow:hidden;margin-top:10px}.qualityBar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--green))}.alt{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #ffffff0d}.alt:last-child{border:0}.footer{margin-top:14px;padding:16px;color:var(--muted);font-size:12px;line-height:1.8;text-align:center}
@media(max-width:820px){.hero{grid-template-columns:1fr}.mode{text-align:right}.toolbar{grid-template-columns:1fr}.search{justify-content:stretch}.search input{width:100%}.fixtureList{grid-template-columns:1fr}.dialog{max-height:96dvh;border-radius:20px}.analysisBody{padding:13px}.grid2{grid-template-columns:1fr}.matchHead{flex-direction:column}.confidence{width:100%;height:auto;border-radius:16px;background:#30e3a411;padding:12px}.confidence:after{display:none}.confidence div{display:flex;align-items:center;gap:8px}.confidence b{font-size:26px}.confidence small{display:inline}.codeRow{grid-template-columns:1fr}.copy{padding:12px}.brand small{display:none}}
@media(max-width:540px){.wrap{width:min(100% - 14px,1280px)}.topin{min-height:65px}.logo{width:46px;height:46px}.brand b{font-size:16px}.server{padding:8px 10px;font-size:12px}.hero{padding:18px}.hero h1{font-size:32px}.ranges{display:grid;grid-template-columns:1fr 1fr}.range{width:100%}.search{flex-direction:column}.fixtures{padding:12px}.teams{font-size:16px}.modal{padding:0}.dialog{width:100%;height:100dvh;max-height:100dvh;border-radius:0}.modalTop{padding-top:max(12px,env(safe-area-inset-top))}.analysisBody{padding-bottom:max(18px,env(safe-area-inset-bottom))}}
</style>
</head>
<body>
<header class="top"><div class="wrap topin"><div class="brand"><div class="logo">WZ</div><div><b>توقعات وائل الزين</b><small>ذكاء كرة القدم • LIVE V5</small></div></div><div class="server"><i id="serverDot" class="dot"></i><span id="serverText">فحص الخادم…</span></div></div></header>
<main class="wrap">
<section class="card hero"><div><div class="eyebrow">تحليل مباريات بالبيانات والذكاء الاصطناعي</div><h1>المواجهة أولًا، ثم حدث واحد أوضح</h1><p>واجهة عربية مرتبة، فترة الشهر القادم كاملة، وتحليل أكبر على الهاتف يشمل الفورمة ونقاط القوة والضعف والغيابات المتاحة وجودة البيانات والتوقع الأقوى.</p></div><div class="mode"><b id="modeText">جارٍ الاتصال</b><span>مصدر البيانات الحالي</span></div></section>
<section class="card toolbar"><div class="ranges"><button class="range active" data-days="7">7 أيام</button><button class="range" data-days="14">14 يوم</button><button class="range" data-days="30">30 يوم</button><button class="range" data-range="next-month">الشهر القادم</button></div><div class="search"><input id="search" placeholder="ابحث عن فريق أو بطولة"><button id="refresh" class="btn">تحديث المباريات</button></div></section>
<section class="card fixtures"><div class="heading"><div><h2>المواجهات القادمة</h2><p id="fixtureMeta">تحميل المباريات…</p></div><div id="count" class="count">0</div></div><div id="fixtureList" class="fixtureList"></div></section>
<div class="card footer">التوقعات احتمالية وليست ضمانًا. كود WZ هو معرّف داخلي للتوقع والمشاركة داخل المشروع، وليس وعدًا بنتيجة المباراة.</div>
</main>
<div id="modal" class="modal" aria-hidden="true"><div class="dialog"><div class="modalTop"><b>تفاصيل التحليل</b><button id="closeModal" class="close" aria-label="إغلاق">×</button></div><div id="analysisBody" class="analysisBody"></div></div></div>
<script>
(function(){
'use strict';
var state={days:7,range:'',fixtures:[],selected:null,provider:'',mode:''};
var $=function(s){return document.querySelector(s)};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function fmtDate(v){try{return new Intl.DateTimeFormat('ar-OM',{weekday:'short',day:'numeric',month:'long'}).format(new Date(v))}catch{return v}}
function fmtTime(v){try{return new Intl.DateTimeFormat('ar-OM',{hour:'2-digit',minute:'2-digit'}).format(new Date(v))}catch{return ''}}
function openModal(){var m=$('#modal');m.classList.add('open');m.setAttribute('aria-hidden','false');document.body.style.overflow='hidden'}
function closeModal(){var m=$('#modal');m.classList.remove('open');m.setAttribute('aria-hidden','true');document.body.style.overflow=''}
$('#closeModal').onclick=closeModal;$('#modal').addEventListener('click',function(e){if(e.target===this)closeModal()});document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal()});
async function api(path){var r=await fetch(path,{cache:'no-store'});var d=await r.json().catch(function(){return {}});if(!r.ok)throw new Error(d.message||d.detail||('HTTP '+r.status));return d}
async function health(){try{var h=await api('/api/health');$('#serverDot').className='dot ok';$('#serverText').textContent='الخادم متصل';$('#modeText').textContent=h.mode==='deep-live'?'تحليل عميق':'تحليل عام';}catch(e){$('#serverDot').className='dot bad';$('#serverText').textContent='الخادم غير متصل';$('#modeText').textContent='تعذر الاتصال'}}
function queryString(){return state.range==='next-month'?'?range=next-month':('?days='+state.days)}
async function loadFixtures(){var root=$('#fixtureList');root.innerHTML='<div class="loader"><div class="spin"></div>تحميل المواجهات…</div>';try{var data=await api('/api/fixtures'+queryString());state.fixtures=data.fixtures||[];state.provider=data.provider||'';state.mode=data.mode||'';$('#fixtureMeta').textContent=(data.rangeLabel||'الفترة المحددة')+' • '+state.provider+(data.partial?' • تغطية جزئية حسب المصدر':'');renderFixtures()}catch(e){root.innerHTML='<div class="emptyList">تعذر تحميل المباريات: '+esc(e.message)+'</div>';$('#count').textContent='0'}}
function renderFixtures(){var root=$('#fixtureList');var q=$('#search').value.trim().toLowerCase();var rows=state.fixtures.filter(function(f){return !q||((f.home+' '+f.away+' '+f.league+' '+(f.leagueOriginal||'')).toLowerCase().indexOf(q)>=0)});$('#count').textContent=rows.length;root.innerHTML='';if(!rows.length){root.innerHTML='<div class="emptyList">لا توجد مباريات مطابقة في الفترة المحددة.</div>';return}rows.forEach(function(f){var b=document.createElement('button');b.className='fixture';b.innerHTML='<div class="ftop"><span class="league">'+esc(f.league||f.leagueOriginal)+'</span><span>'+esc(fmtTime(f.date))+'</span></div><div class="teams"><span>'+esc(f.home)+'</span><span class="vs">×</span><span class="away">'+esc(f.away)+'</span></div><div class="fbottom"><span>'+esc(fmtDate(f.date))+'</span><span class="ready">جاهز للتحليل</span></div>';b.onclick=function(){analyze(f)};root.appendChild(b)})}
function metricRows(m){m=m||{};return '<div class="metric"><span>آخر النتائج</span><b>'+esc(m.form||'غير متاح')+'</b></div><div class="metric"><span>معدل التسجيل</span><b>'+esc(m.gf==null?'—':m.gf)+'</b></div><div class="metric"><span>معدل الاستقبال</span><b>'+esc(m.ga==null?'—':m.ga)+'</b></div><div class="metric"><span>الترتيب</span><b>'+esc(m.rank==null?'—':m.rank)+'</b></div><div class="metric"><span>النقاط</span><b>'+esc(m.points==null?'—':m.points)+'</b></div>'}
function listHtml(items,empty){if(!items||!items.length)return '<div class="listItem muted">'+esc(empty)+'</div>';return items.map(function(x){return '<div class="listItem">'+esc(typeof x==='string'?x:(x.player?((x.team?x.team+' • ':'')+x.player+' — '+(x.reason||x.type||'غياب')):JSON.stringify(x)))+'</div>'}).join('')}
function renderAnalysis(a){var f=a.fixture||{};var p=a.prediction||{};var q=a.quality||{};var body=$('#analysisBody');var alts=(a.alternatives||[]).map(function(x){return '<div class="alt"><b>'+esc(x.event)+'</b><span>'+esc(x.probability)+'%</span></div>'}).join('')||'<div class="listItem muted">لا توجد بدائل متاحة.</div>';var sources=(a.sources||[]).map(function(x){return '<div class="listItem"><b>'+esc(x.name)+'</b><div class="muted">'+esc(x.role||'')+'</div></div>'}).join('');body.innerHTML='<div class="matchHead"><div><h2>'+esc(f.home)+' × '+esc(f.away)+'</h2><p>'+esc(f.league||f.leagueOriginal||'')+'<br>'+esc(fmtDate(f.date))+' • '+esc(fmtTime(f.date))+'</p></div><div class="confidence" style="--pct:'+esc(p.confidence||0)+'%"><div><b>'+esc(p.confidence||0)+'%</b><small>نسبة الترجيح</small></div></div></div><div class="pick"><div class="lab">🎯 التوقع الأقوى</div><h3>'+esc(p.event||'غير متاح')+'</h3><p>'+esc(p.explanation||'')+'</p><div class="chips"><span class="chip">احتمال خام: <b>'+esc(p.rawProbability||0)+'%</b></span><span class="chip">جودة البيانات: <b>'+esc(q.label||'غير محددة')+'</b></span><span class="chip">وضع التحليل: <b>'+esc(a.mode||'')+'</b></span></div><div class="codeBox"><div class="codeLabel">كود التوقع</div><div class="codeRow"><code id="wzCode">'+esc(p.internalCode||'')+'</code><button id="copyCode" class="copy">نسخ الكود</button></div><div class="codeNote">هذا الكود معرّف داخلي للتوقع ويمكن نسخه ومشاركته كما هو.</div></div></div><div class="grid2"><div class="box"><h4>'+esc(f.home)+'</h4>'+metricRows(a.metrics&&a.metrics.home)+'</div><div class="box"><h4>'+esc(f.away)+'</h4>'+metricRows(a.metrics&&a.metrics.away)+'</div></div><div class="grid2"><div class="box"><h4>نقاط القوة</h4>'+listHtml((a.strengths&&a.strengths.home||[]).concat(a.strengths&&a.strengths.away||[]),'لا توجد إشارات كافية')+'</div><div class="box"><h4>نقاط الضعف</h4>'+listHtml((a.weaknesses&&a.weaknesses.home||[]).concat(a.weaknesses&&a.weaknesses.away||[]),'لا توجد إشارات كافية')+'</div></div><div class="section"><h4>الغيابات والإصابات والإيقافات المتاحة</h4>'+listHtml(a.absences||[],'لا توجد غيابات مؤكدة في المصدر الحالي أو التغطية غير متاحة.')+'</div><div class="grid2"><div class="box"><h4>أهمية المباراة</h4><div class="metric"><span>درجة الأهمية</span><b>'+esc(a.importance&&a.importance.score||'—')+'/100</b></div>'+listHtml(a.importance&&a.importance.notes||[],'لا توجد تفاصيل إضافية')+'</div><div class="box"><h4>جودة البيانات</h4><div class="metric"><span>الدرجة</span><b>'+esc(q.score||'—')+'/100</b></div><div class="qualityBar"><i style="width:'+esc(q.score||0)+'%"></i></div>'+listHtml(q.reasons||[],'لا توجد تفاصيل إضافية')+'</div></div><div class="section"><h4>لماذا اختير هذا التوقع؟</h4>'+listHtml(a.reasons||[],'لا توجد أسباب إضافية')+'</div><div class="grid2"><div class="box"><h4>توقعات بديلة</h4>'+alts+'</div><div class="box"><h4>مصادر البيانات</h4>'+sources+'</div></div>';
var copy=$('#copyCode');if(copy)copy.onclick=async function(){var code=$('#wzCode').textContent;try{await navigator.clipboard.writeText(code);copy.textContent='تم النسخ ✓';setTimeout(function(){copy.textContent='نسخ الكود'},1500)}catch(e){copy.textContent='انسخ يدويًا'}}}
async function analyze(f){state.selected=f.id;openModal();$('#analysisBody').innerHTML='<div class="loader"><div class="spin"></div>جارٍ تحليل '+esc(f.home)+' و '+esc(f.away)+'…</div>';try{var a=await api('/api/analyze/'+encodeURIComponent(f.id));renderAnalysis(a)}catch(e){$('#analysisBody').innerHTML='<div class="loader">⚠<br><br>تعذر إكمال التحليل<br><span class="muted">'+esc(e.message)+'</span></div>'}}
Array.from(document.querySelectorAll('.range')).forEach(function(btn){btn.onclick=function(){document.querySelectorAll('.range').forEach(function(x){x.classList.remove('active')});btn.classList.add('active');state.range=btn.getAttribute('data-range')||'';state.days=Number(btn.getAttribute('data-days')||7);loadFixtures()}});$('#refresh').onclick=loadFixtures;$('#search').addEventListener('input',renderFixtures);health();loadFixtures();
if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}
})();
</script>
</body>
</html>`;

const MANIFEST = JSON.stringify({
  name: 'توقعات وائل الزين',
  short_name: 'WZ توقعات',
  start_url: '/',
  display: 'standalone',
  background_color: '#04101b',
  theme_color: '#071421',
  lang: 'ar',
  dir: 'rtl'
});

const SERVICE_WORKER = "const CACHE='wz-v5-shell-1';const SHELL=['/','/manifest.webmanifest'];self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname.startsWith('/api/'))return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))))});";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function sendText(res, status, body, contentType, cacheControl = 'no-cache') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'Wail Elzain Football AI',
        version: APP_VERSION,
        mode: API_KEY ? 'deep-live' : ENABLE_PUBLIC_FALLBACK ? 'public-live' : 'no-provider',
        providerConfigured: Boolean(API_KEY),
        publicFallback: ENABLE_PUBLIC_FALLBACK,
        serverTime: new Date().toISOString()
      });
    }

    if (req.method === 'GET' && pathname === '/api/fixtures') {
      const range = rangeFromRequest(url);
      try {
        if (API_KEY) {
          const fixtures = await getApiFixtures(range);
          return sendJson(res, 200, { fixtures, mode: 'deep-live', provider: 'API-Football', rangeLabel: range.label, from: range.from, to: range.to, partial: false });
        }
        if (ENABLE_PUBLIC_FALLBACK) {
          const fixtures = await getPublicFixtures(range);
          return sendJson(res, 200, { fixtures, mode: 'public-live', provider: 'TheSportsDB Free', rangeLabel: range.label, from: range.from, to: range.to, partial: fixtures.length >= 500 });
        }
        return sendJson(res, 503, { error: 'NO_DATA_PROVIDER', message: 'لا يوجد مزود بيانات مفعّل على الخادم.' });
      } catch (error) {
        if (ENABLE_PUBLIC_FALLBACK && API_KEY) {
          try {
            const fixtures = await getPublicFixtures(range);
            return sendJson(res, 200, { fixtures, mode: 'public-live-fallback', provider: 'TheSportsDB Free', rangeLabel: range.label, from: range.from, to: range.to, warning: error.message, partial: fixtures.length >= 500 });
          } catch {}
        }
        return sendJson(res, 502, { error: 'UPSTREAM_FAILURE', message: 'تعذر تحميل المباريات من مزود البيانات.', detail: error.message });
      }
    }

    if (req.method === 'GET' && pathname.startsWith('/api/analyze/')) {
      const id = decodeURIComponent(pathname.slice('/api/analyze/'.length));
      try {
        if (id.startsWith('af-')) {
          if (!API_KEY) return sendJson(res, 503, { error: 'PROVIDER_KEY_REQUIRED', message: 'هذه المباراة تتطلب مفتاح API-Football على الخادم.' });
          return sendJson(res, 200, await analyzeApiFixture(id));
        }
        if (id.startsWith('tsdb-')) {
          if (!ENABLE_PUBLIC_FALLBACK) return sendJson(res, 503, { error: 'PUBLIC_FALLBACK_DISABLED', message: 'المصدر العام غير مفعّل.' });
          return sendJson(res, 200, await analyzePublicFixture(id));
        }
        const indexed = fixtureIndex.get(id);
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
  console.log('Wail Elzain Football AI V5 running on port ' + PORT);
});
