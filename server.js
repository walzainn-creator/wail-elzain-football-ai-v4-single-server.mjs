import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_FOOTBALL_KEY || '').trim();
const ENABLE_PUBLIC_FALLBACK = String(process.env.ENABLE_PUBLIC_FALLBACK || 'true') !== 'false';
const CACHE_TTL_MS = Math.max(30, Number(process.env.CACHE_TTL_SECONDS || 600)) * 1000;
const API_BASE = 'https://v3.football.api-sports.io';
const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/123';

const cache = new Map();
const memoryFixtureIndex = new Map();

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
async function withCache(key, loader, ttl) {
  const hit = cachedGet(key);
  if (hit !== null) return hit;
  const value = await loader();
  return cachedSet(key, value, ttl);
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function avg(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}
function pct(v) {
  return Math.round(clamp(v * 100, 0, 100));
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
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away || 1;
  return { home: home / total, draw: draw / total, away: away / total };
}
function safeName(v, fallback = 'غير متاح') {
  return String(v || fallback).trim() || fallback;
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.message || data?.errors || `HTTP ${res.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function apiFootball(endpoint, params = {}) {
  if (!API_KEY) throw new Error('API_FOOTBALL_KEY_NOT_CONFIGURED');
  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return fetchJson(url, { headers: { 'x-apisports-key': API_KEY } });
}

async function tsdb(endpoint, params = {}) {
  const url = new URL(`${TSDB_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return fetchJson(url);
}

function normalizeApiFixture(item) {
  const f = item?.fixture || {};
  const league = item?.league || {};
  const teams = item?.teams || {};
  const out = {
    id: `af-${f.id}`,
    providerId: f.id,
    date: f.date,
    timestamp: f.timestamp,
    timezone: f.timezone,
    venue: f.venue?.name || '',
    referee: f.referee || '',
    league: [league.country, league.name].filter(Boolean).join(' • '),
    leagueId: league.id,
    season: league.season,
    round: league.round,
    home: safeName(teams.home?.name, 'المضيف'),
    away: safeName(teams.away?.name, 'الضيف'),
    homeId: teams.home?.id,
    awayId: teams.away?.id,
    source: 'API-Football'
  };
  memoryFixtureIndex.set(out.id, out);
  return out;
}

function tsdbDateTime(e) {
  const date = e?.dateEvent || e?.strTimestamp?.slice(0, 10) || isoDate(new Date());
  const time = (e?.strTime || '00:00:00').slice(0, 8);
  const raw = e?.strTimestamp || `${date}T${time}Z`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? `${date}T${time}Z` : d.toISOString();
}
function normalizeTsdbFixture(e) {
  const out = {
    id: `tsdb-${e.idEvent}`,
    providerId: e.idEvent,
    date: tsdbDateTime(e),
    league: [e.strCountry, e.strLeague].filter(Boolean).join(' • '),
    leagueId: e.idLeague,
    season: e.strSeason,
    round: e.intRound || '',
    home: safeName(e.strHomeTeam, 'المضيف'),
    away: safeName(e.strAwayTeam, 'الضيف'),
    homeId: e.idHomeTeam,
    awayId: e.idAwayTeam,
    source: 'TheSportsDB Free'
  };
  memoryFixtureIndex.set(out.id, out);
  return out;
}

async function getApiFixtures(days) {
  const from = isoDate(new Date());
  const to = isoDate(addDays(new Date(), days - 1));
  const key = `af:fixtures:${from}:${to}`;
  return withCache(key, async () => {
    const data = await apiFootball('/fixtures', { from, to, timezone: 'Asia/Muscat' });
    return (data.response || [])
      .filter(x => ['NS', 'TBD'].includes(x?.fixture?.status?.short))
      .map(normalizeApiFixture)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 250);
  }, 5 * 60 * 1000);
}

async function getPublicFixtures(days) {
  const capped = Math.min(days, 30);
  const key = `tsdb:fixtures:${isoDate(new Date())}:${capped}`;
  return withCache(key, async () => {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < capped; i++) {
      const date = isoDate(addDays(new Date(), i));
      try {
        const data = await tsdb('eventsday.php', { d: date, s: 'Soccer' });
        for (const e of data.events || []) {
          if (!e?.idEvent || seen.has(String(e.idEvent))) continue;
          seen.add(String(e.idEvent));
          out.push(normalizeTsdbFixture(e));
        }
      } catch {
        // Skip one bad day instead of failing the whole request.
      }
      if (out.length >= 120) break;
    }
    return out.sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 120);
  }, 10 * 60 * 1000);
}

function recentFormFromApi(rows, teamId) {
  const gf = [], ga = [];
  let w = 0, d = 0, l = 0;
  const formChars = [];
  let lastDate = null;
  for (const row of rows || []) {
    const homeId = row?.teams?.home?.id;
    const awayId = row?.teams?.away?.id;
    const hg = Number(row?.goals?.home);
    const ag = Number(row?.goals?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const isHome = Number(homeId) === Number(teamId);
    const scored = isHome ? hg : ag;
    const conceded = isHome ? ag : hg;
    gf.push(scored); ga.push(conceded);
    if (scored > conceded) { w++; formChars.push('W'); }
    else if (scored === conceded) { d++; formChars.push('D'); }
    else { l++; formChars.push('L'); }
    const dt = row?.fixture?.date ? new Date(row.fixture.date) : null;
    if (dt && (!lastDate || dt > lastDate)) lastDate = dt;
  }
  const restDays = lastDate ? Math.max(0, Math.floor((Date.now() - lastDate.getTime()) / 86400000)) : null;
  return { w, d, l, gf: avg(gf), ga: avg(ga), count: gf.length, form: formChars.slice(0, 8).join(''), restDays };
}

function recentFormFromTsdb(rows, teamId) {
  const gf = [], ga = [];
  let w = 0, d = 0, l = 0;
  const formChars = [];
  for (const e of rows || []) {
    const hg = Number(e.intHomeScore), ag = Number(e.intAwayScore);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const isHome = String(e.idHomeTeam) === String(teamId);
    const scored = isHome ? hg : ag;
    const conceded = isHome ? ag : hg;
    gf.push(scored); ga.push(conceded);
    if (scored > conceded) { w++; formChars.push('W'); }
    else if (scored === conceded) { d++; formChars.push('D'); }
    else { l++; formChars.push('L'); }
  }
  return { w, d, l, gf: avg(gf), ga: avg(ga), count: gf.length, form: formChars.join(''), restDays: null };
}

function deriveStrengthsWeaknesses(stats, label) {
  const strengths = [], weaknesses = [];
  if (stats.gf >= 1.7) strengths.push(`${label}: إنتاج هجومي قوي في المباريات الأخيرة`);
  else if (stats.gf >= 1.25) strengths.push(`${label}: معدل تسجيل مستقر`);
  if (stats.ga <= 0.9 && stats.count >= 3) strengths.push(`${label}: صلابة دفاعية جيدة`);
  if (stats.w >= Math.max(3, Math.ceil(stats.count * 0.55))) strengths.push(`${label}: زخم نتائج إيجابي`);
  if (stats.gf < 0.9 && stats.count >= 3) weaknesses.push(`${label}: صعوبة نسبية في التسجيل`);
  if (stats.ga >= 1.7) weaknesses.push(`${label}: استقبال أهداف بمعدل مرتفع`);
  if (stats.l >= Math.max(3, Math.ceil(stats.count * 0.5))) weaknesses.push(`${label}: تذبذب واضح في النتائج`);
  return { strengths, weaknesses };
}

function buildMarkets(lambdaHome, lambdaAway) {
  const total = lambdaHome + lambdaAway;
  const outcomes = outcomeProbabilities(lambdaHome, lambdaAway);
  const bttsYes = (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway));
  const markets = [
    { key: 'O05', event: 'أكثر من 0.5 هدف في المباراة', p: 1 - Math.exp(-total) },
    { key: 'U45', event: 'أقل من 4.5 أهداف في المباراة', p: poissonCdf(4, total) },
    { key: 'O15', event: 'أكثر من 1.5 هدف في المباراة', p: 1 - poissonCdf(1, total) },
    { key: 'U35', event: 'أقل من 3.5 أهداف في المباراة', p: poissonCdf(3, total) },
    { key: '1X', event: 'المضيف أو التعادل (فرصة مزدوجة)', p: outcomes.home + outcomes.draw },
    { key: 'X2', event: 'الضيف أو التعادل (فرصة مزدوجة)', p: outcomes.away + outcomes.draw },
    { key: 'BTTS_NO', event: 'الفريقان لا يسجلان معًا', p: 1 - bttsYes }
  ];
  return markets.sort((a, b) => b.p - a.p);
}

function choosePrediction({ homeStats, awayStats, injuryCount = 0, qualityScore, providerPrediction }) {
  const fallbackGF = 1.25, fallbackGA = 1.25;
  const hGF = homeStats.gf || fallbackGF;
  const hGA = homeStats.ga || fallbackGA;
  const aGF = awayStats.gf || fallbackGF;
  const aGA = awayStats.ga || fallbackGA;

  let lambdaHome = clamp((hGF * 0.52) + (aGA * 0.38) + 0.18, 0.25, 2.9);
  let lambdaAway = clamp((aGF * 0.50) + (hGA * 0.38) + 0.08, 0.20, 2.7);
  if (injuryCount >= 5) {
    lambdaHome *= 0.97;
    lambdaAway *= 0.97;
  }

  const markets = buildMarkets(lambdaHome, lambdaAway);
  let best = markets[0];

  // Avoid presenting extremely trivial probabilities as certainty.
  if (best.key === 'O05' && best.p > 0.94 && markets[1]?.p > 0.82) best = markets[1];

  let providerBoost = 0;
  const advice = String(providerPrediction?.predictions?.advice || '').trim();
  if (advice) providerBoost = 2;

  const confidence = Math.round(clamp(
    (best.p * 100) * 0.72 + qualityScore * 0.20 + providerBoost,
    42,
    Math.min(88, best.p * 100)
  ));

  return {
    lambdaHome,
    lambdaAway,
    markets,
    best,
    confidence,
    providerAdvice: advice || null
  };
}

function extractStanding(standingsPayload, teamId) {
  const groups = standingsPayload?.response?.[0]?.league?.standings || [];
  for (const group of groups) {
    const row = (group || []).find(x => Number(x?.team?.id) === Number(teamId));
    if (row) return { rank: row.rank, points: row.points, form: row.form || '', description: row.description || '' };
  }
  return null;
}

function mapInjuries(payload) {
  return (payload?.response || []).slice(0, 30).map(x => ({
    team: x?.team?.name || '',
    teamId: x?.team?.id,
    player: x?.player?.name || 'لاعب غير محدد',
    playerId: x?.player?.id,
    reason: x?.player?.reason || x?.player?.type || 'غياب/إصابة',
    type: x?.player?.type || 'Injury'
  }));
}

async function analyzeApiFixture(id) {
  const fixtureId = Number(String(id).replace(/^af-/, ''));
  if (!Number.isFinite(fixtureId)) throw new Error('INVALID_FIXTURE_ID');
  return withCache(`af:analysis:${fixtureId}`, async () => {
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
    const homeRecent = homeRecentR.status === 'fulfilled' ? homeRecentR.value.response || [] : [];
    const awayRecent = awayRecentR.status === 'fulfilled' ? awayRecentR.value.response || [] : [];
    const injuries = injuriesR.status === 'fulfilled' ? mapInjuries(injuriesR.value) : [];
    const lineupsRaw = lineupsR.status === 'fulfilled' ? lineupsR.value.response || [] : [];
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
    if (lineupsR.status === 'fulfilled' && lineupsRaw.length) { qualityScore += 8; qualityReasons.push('التشكيلات متاحة'); }
    if (predictionsR.status === 'fulfilled' && providerPrediction) { qualityScore += 6; qualityReasons.push('مصدر تحليلي إضافي متاح'); }
    qualityScore = clamp(qualityScore, 35, 95);

    const pred = choosePrediction({
      homeStats: hs,
      awayStats: as,
      injuryCount: injuries.length,
      qualityScore,
      providerPrediction
    });

    const hSW = deriveStrengthsWeaknesses(hs, fixture.home);
    const aSW = deriveStrengthsWeaknesses(as, fixture.away);
    const importanceNotes = [];
    let importanceScore = 50;
    if (homeStanding && awayStanding) {
      const gap = Math.abs((homeStanding.rank || 0) - (awayStanding.rank || 0));
      importanceNotes.push(`الترتيب: ${fixture.home} (${homeStanding.rank})، ${fixture.away} (${awayStanding.rank})`);
      if (gap <= 3) importanceScore += 8;
      if ((homeStanding.rank || 99) <= 5 || (awayStanding.rank || 99) <= 5) importanceScore += 7;
    }
    if (/final|semi|quarter|playoff|knockout/i.test(String(fixture.round || ''))) {
      importanceScore += 20;
      importanceNotes.push('مرحلة إقصائية/حاسمة بحسب وصف الجولة');
    }
    importanceScore = clamp(importanceScore, 35, 90);

    const reasons = [
      `نموذج الأهداف قدّر المتوسط النظري بنحو ${pred.lambdaHome.toFixed(2)} للمضيف و${pred.lambdaAway.toFixed(2)} للضيف.`,
      `تمت مقارنة ${hs.count} مباراة حديثة للمضيف و${as.count} مباراة للضيف.`,
      injuries.length ? `تم رصد ${injuries.length} حالة غياب/إصابة في بيانات المزود لهذه المواجهة.` : 'لم تظهر غيابات مؤكدة في المصدر وقت التحليل أو أن تغطيتها غير متاحة.',
      pred.providerAdvice ? `إشارة المصدر التحليلي الإضافي: ${pred.providerAdvice}` : 'لم تتوفر نصيحة تحليلية إضافية من المزود لهذه المواجهة.'
    ];

    const lineups = lineupsRaw.map(x => ({
      team: x?.team?.name || '',
      formation: x?.formation || '',
      coach: x?.coach?.name || '',
      startXI: (x?.startXI || []).map(p => p?.player?.name).filter(Boolean).slice(0, 11)
    }));

    return {
      fixture,
      prediction: {
        event: pred.best.event,
        marketKey: pred.best.key,
        confidence: pred.confidence,
        rawProbability: pct(pred.best.p),
        explanation: 'اختيار حدث واحد أعلى احتمالًا وفق نموذج أهداف محافظ، الفورمة الحديثة، جودة التغطية، الغيابات والسياق المتاح. الثقة ليست ضمانًا للنتيجة.',
        internalCode: `WZ-${fixtureId}-${pred.best.key}-V4`,
        status: 'live-deep'
      },
      metrics: {
        home: { form: `${hs.w} فوز • ${hs.d} تعادل • ${hs.l} خسارة`, gf: hs.gf.toFixed(2), ga: hs.ga.toFixed(2), restDays: hs.restDays, rank: homeStanding?.rank ?? null, points: homeStanding?.points ?? null },
        away: { form: `${as.w} فوز • ${as.d} تعادل • ${as.l} خسارة`, gf: as.gf.toFixed(2), ga: as.ga.toFixed(2), restDays: as.restDays, rank: awayStanding?.rank ?? null, points: awayStanding?.points ?? null }
      },
      advanced: {
        home: { xg: null, xga: null, corners: null, shotsOn: null, coverage: hs.count },
        away: { xg: null, xga: null, corners: null, shotsOn: null, coverage: as.count }
      },
      strengths: { home: hSW.strengths, away: aSW.strengths },
      weaknesses: { home: hSW.weaknesses, away: aSW.weaknesses },
      absences: injuries,
      lineups: { available: lineups.length > 0, teams: lineups },
      importance: { score: importanceScore, notes: importanceNotes.length ? importanceNotes : ['تقييم الأهمية متوسط لعدم اكتمال بيانات السياق التنافسي.'] },
      calibration: {
        marketSamples: 0,
        marketHits: 0,
        empirical: null,
        blended: pred.confidence,
        note: 'المعايرة طويلة المدى تحتاج قاعدة نتائج تاريخية متراكمة؛ الإصدار الحالي يستخدم معايرة محافظة حسب جودة البيانات.'
      },
      quality: {
        score: qualityScore,
        label: qualityScore >= 80 ? 'مرتفعة' : qualityScore >= 60 ? 'جيدة' : 'متوسطة',
        reasons: qualityReasons
      },
      sources: [
        { name: 'API-Football / API-Sports', status: 'active', role: 'المواجهات والنتائج والغيابات والتشكيلات والترتيب والتنبؤات حسب التغطية' }
      ],
      reasons,
      alternatives: pred.markets.filter(x => x.key !== pred.best.key).slice(0, 4).map(x => ({ event: x.event, probability: pct(x.p), calibratedScore: Math.round(clamp(x.p * 100 * 0.78 + qualityScore * 0.16, 0, 92)) })),
      mode: 'live-deep'
    };
  }, 10 * 60 * 1000);
}

async function analyzePublicFixture(id) {
  const eventId = String(id).replace(/^tsdb-/, '');
  return withCache(`tsdb:analysis:${eventId}`, async () => {
    const detail = await tsdb('lookupevent.php', { id: eventId });
    const e = detail.events?.[0];
    if (!e) throw new Error('FIXTURE_NOT_FOUND');
    const fixture = normalizeTsdbFixture(e);
    const [hR, aR] = await Promise.allSettled([
      tsdb('eventslast.php', { id: fixture.homeId }),
      tsdb('eventslast.php', { id: fixture.awayId })
    ]);
    const hRows = hR.status === 'fulfilled' ? (hR.value.results || hR.value.events || []) : [];
    const aRows = aR.status === 'fulfilled' ? (aR.value.results || aR.value.events || []) : [];
    const hs = recentFormFromTsdb(hRows, fixture.homeId);
    const as = recentFormFromTsdb(aRows, fixture.awayId);
    const qualityScore = (hs.count + as.count) >= 8 ? 52 : (hs.count + as.count) >= 4 ? 45 : 36;
    const pred = choosePrediction({ homeStats: hs, awayStats: as, injuryCount: 0, qualityScore, providerPrediction: null });
    const hSW = deriveStrengthsWeaknesses(hs, fixture.home);
    const aSW = deriveStrengthsWeaknesses(as, fixture.away);
    return {
      fixture,
      prediction: {
        event: pred.best.event,
        marketKey: pred.best.key,
        confidence: Math.min(pred.confidence, 62),
        rawProbability: pct(pred.best.p),
        explanation: 'تحليل مباشر محدود من المصدر العام. تم خفض الثقة لأن الغيابات والتشكيلات والترتيب المتقدم غير مكتملة.',
        internalCode: `WZ-${eventId}-${pred.best.key}-PUBLIC-V4`,
        status: 'public-live-limited'
      },
      metrics: {
        home: { form: `${hs.w} فوز • ${hs.d} تعادل • ${hs.l} خسارة`, gf: hs.gf.toFixed(2), ga: hs.ga.toFixed(2) },
        away: { form: `${as.w} فوز • ${as.d} تعادل • ${as.l} خسارة`, gf: as.gf.toFixed(2), ga: as.ga.toFixed(2) }
      },
      advanced: { home: { coverage: hs.count }, away: { coverage: as.count } },
      strengths: { home: hSW.strengths, away: aSW.strengths },
      weaknesses: { home: hSW.weaknesses, away: aSW.weaknesses },
      absences: [],
      lineups: { available: false, teams: [] },
      importance: { score: 45, notes: ['تقييم أهمية المباراة محدود في المصدر العام.'] },
      calibration: { marketSamples: 0, marketHits: 0, empirical: null, blended: Math.min(pred.confidence, 62), note: 'المصدر العام لا يوفر عمقًا كافيًا لمعايرة تاريخية كاملة.' },
      quality: { score: qualityScore, label: 'محدودة', reasons: ['مواجهات ونتائج عامة مباشرة', 'لا توجد تغطية موثوقة للغيابات والتشكيلات في هذا الوضع'] },
      sources: [{ name: 'TheSportsDB Free API', status: 'active', role: 'مواجهات ونتائج عامة مجانية' }],
      reasons: [
        `تمت مقارنة ${hs.count} مباراة للمضيف و${as.count} مباراة للضيف من العينة العامة المتاحة.`,
        'تم استخدام نموذج أهداف محافظ مع خفض الثقة بسبب نقص البيانات المتقدمة.'
      ],
      alternatives: pred.markets.filter(x => x.key !== pred.best.key).slice(0, 4).map(x => ({ event: x.event, probability: pct(x.p), calibratedScore: Math.round(x.p * 55) })),
      mode: 'public-live'
    };
  }, 10 * 60 * 1000);
}


const embeddedFiles = new Map([
  ['/index.html', { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\" />\n  <meta name=\"theme-color\" content=\"#071421\" />\n  <meta name=\"description\" content=\"\u062a\u0648\u0642\u0639\u0627\u062a \u0648\u0627\u0626\u0644 \u0627\u0644\u0632\u064a\u0646 - \u062a\u062d\u0644\u064a\u0644 \u0645\u0628\u0627\u0631\u064a\u0627\u062a \u0643\u0631\u0629 \u0627\u0644\u0642\u062f\u0645 \u0628\u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0648\u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064a\" />\n  <link rel=\"manifest\" href=\"/manifest.webmanifest\" />\n  <title>\u062a\u0648\u0642\u0639\u0627\u062a \u0648\u0627\u0626\u0644 \u0627\u0644\u0632\u064a\u0646 \u2022 LIVE v4</title>\n  <style>\n    :root{--bg:#050d16;--panel:#0a1c2cdd;--panel2:#0d263b;--line:#ffffff16;--text:#f4f8fb;--muted:#91a8ba;--green:#29e29c;--blue:#49adff;--warn:#ffd166;--bad:#ff7280;--shadow:0 20px 60px #0008}\n    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(circle at 85% 10%,#133854 0,#071421 32%,#030910 82%);color:var(--text);font-family:system-ui,-apple-system,\"Segoe UI\",Tahoma,Arial,sans-serif}.wrap{width:min(1200px,calc(100% - 24px));margin:auto}.top{position:sticky;top:0;z-index:20;background:#06111de8;border-bottom:1px solid var(--line);backdrop-filter:blur(15px)}.topin{height:68px;display:flex;align-items:center;justify-content:space-between;gap:12px}.brand{display:flex;align-items:center;gap:10px}.logo{width:45px;height:45px;border-radius:14px;display:grid;place-items:center;font-weight:1000;background:linear-gradient(135deg,var(--green),#b2ffdd);color:#04130d;box-shadow:0 8px 28px #29e29c32}.brand b{display:block}.brand small{display:block;color:var(--muted);margin-top:2px}.server{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:8px 11px;background:#ffffff08;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--warn);box-shadow:0 0 14px currentColor}.dot.ok{background:var(--green)}.dot.bad{background:var(--bad)}\n    main{padding:18px 0 38px}.card{background:linear-gradient(180deg,#0d263bdc,#081725e8);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow)}.hero{padding:25px;display:grid;grid-template-columns:1fr auto;gap:24px;align-items:center;position:relative;overflow:hidden}.hero:after{content:\"\";position:absolute;width:290px;height:290px;border:50px solid #2be19b0a;border-radius:50%;left:-120px;top:-120px}.eyebrow{font-size:11px;letter-spacing:2px;color:var(--green);font-weight:800}.hero h1{font-size:clamp(28px,5vw,49px);line-height:1.1;margin:9px 0 11px}.hero p{color:#bed0dc;line-height:1.8;max-width:760px}.mode{min-width:165px;padding:18px;border-radius:18px;background:#29e29c0b;border:1px solid #29e29c26;text-align:center}.mode b{display:block;color:var(--green);font-size:18px}.mode span{font-size:11px;color:var(--muted)}\n    .toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px;margin-top:14px}.ranges{display:flex;border:1px solid var(--line);background:#0003;border-radius:13px;padding:4px}.ranges button,.btn{border:0;font:inherit;cursor:pointer}.ranges button{background:transparent;color:var(--muted);padding:9px 12px;border-radius:9px}.ranges button.active{background:#29e29c15;color:var(--green)}.search{display:flex;gap:8px;flex:1;justify-content:flex-end}.search input{width:min(330px,100%);background:#06111d;border:1px solid var(--line);color:white;border-radius:12px;padding:11px 13px;outline:none}.btn{padding:11px 15px;border-radius:12px;font-weight:850;background:linear-gradient(135deg,#20d894,#4bf0b6);color:#03120c}.btn.secondary{background:#ffffff08;color:white;border:1px solid var(--line)}\n    .layout{display:grid;grid-template-columns:minmax(310px,.82fr) minmax(0,1.6fr);gap:14px;margin-top:14px}.fixtures,.analysis{padding:16px;min-height:650px}.heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.heading h2{font-size:18px;margin:0}.heading p{color:var(--muted);font-size:11px;margin:4px 0 0}.count{min-width:32px;height:28px;border-radius:999px;display:grid;place-items:center;background:#49adff14;border:1px solid #49adff26;color:#8bd0ff;font-weight:800}.fixtureList{display:flex;flex-direction:column;gap:9px;margin-top:14px;max-height:580px;overflow:auto}.fixture{border:1px solid var(--line);background:#ffffff06;color:white;border-radius:15px;padding:12px;text-align:right;cursor:pointer;width:100%}.fixture:hover,.fixture.active{border-color:#29e29c55;background:#29e29c0b}.ftop,.fbottom{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:var(--muted)}.teams{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;margin:10px 0;font-size:14px;font-weight:800;align-items:center}.teams .away{text-align:left}.statusMini{color:#76eabb}.empty{height:590px;display:grid;place-content:center;text-align:center;color:var(--muted);padding:30px}.empty .ico{font-size:48px}.empty h3{color:white;margin:10px 0 5px}.loader{padding:35px;text-align:center;color:var(--muted)}.spin{width:29px;height:29px;border:3px solid #ffffff16;border-top-color:var(--green);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 10px}@keyframes spin{to{transform:rotate(360deg)}}\n    .ahead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid var(--line)}.ahead h2{font-size:26px;margin:0}.ahead p{color:var(--muted);font-size:12px;margin-top:5px}.ring{width:105px;height:105px;border-radius:50%;background:conic-gradient(var(--green) var(--pct),#ffffff12 0);display:grid;place-items:center;position:relative;flex:0 0 auto}.ring:after{content:\"\";position:absolute;inset:8px;background:#0b1f31;border-radius:50%}.ring div{z-index:1;text-align:center}.ring b{display:block;color:var(--green);font-size:25px}.ring small{color:var(--muted)}.pick{margin-top:14px;padding:17px;border:1px solid #29e29c2f;background:linear-gradient(135deg,#29e29c11,#49adff08);border-radius:17px}.pick .lab{font-size:10px;color:var(--green);font-weight:900}.pick h3{font-size:24px;margin:7px 0}.pick p{color:#c4d3dd;line-height:1.7;font-size:13px}.prob{display:flex;gap:8px;flex-wrap:wrap;margin-top:11px}.chip{font-size:11px;padding:7px 9px;border-radius:10px;border:1px solid var(--line);color:var(--muted)}.chip b{color:white}.code{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:12px}.code code{direction:ltr;text-align:left;white-space:nowrap;overflow:auto;background:#030b13;border:1px dashed #ffffff33;border-radius:11px;padding:12px}.copy{border:1px solid var(--line);background:#ffffff08;color:white;border-radius:11px;padding:0 13px;cursor:pointer}.note{font-size:10px;color:#efcb78;margin-top:8px;line-height:1.6}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.mini{padding:13px;border:1px solid var(--line);background:#ffffff05;border-radius:14px}.mini h4{font-size:13px;margin:0 0 8px}.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #ffffff0e;font-size:12px}.row:last-child{border:0}.row span{color:var(--muted)}.quality{margin-top:12px;padding:13px;border:1px solid var(--line);border-radius:14px}.qualityHead{display:flex;justify-content:space-between}.bar{height:7px;background:#ffffff12;border-radius:999px;overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--green));border-radius:999px}.reason{padding:8px 0;border-bottom:1px solid #ffffff0e;font-size:12px;line-height:1.65}.reason:last-child{border:0}.alt{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #ffffff0e;font-size:12px}.alt:last-child{border:0}.alt span{color:var(--muted)}.sectionTitle{margin-top:14px;font-size:14px}.footer{margin-top:14px;padding:15px;color:var(--muted);font-size:11px;line-height:1.8;text-align:center}.hidden{display:none!important}\n    @media(max-width:900px){.layout{grid-template-columns:1fr}.fixtures,.analysis{min-height:0}.fixtureList{max-height:430px}.empty{height:380px}.hero{grid-template-columns:1fr}.mode{text-align:right}.mode b,.mode span{display:inline;margin-left:8px}}\n    @media(max-width:620px){.wrap{width:min(100% - 16px,1200px)}.brand small{display:none}.server{padding:7px 9px}.hero{padding:18px}.toolbar{flex-direction:column;align-items:stretch}.search{flex-direction:column}.search input{width:100%}.ranges{justify-content:space-between}.ranges button{flex:1}.layout{gap:10px;margin-top:10px}.fixtures,.analysis{padding:12px;border-radius:17px}.ahead h2{font-size:20px}.ring{width:84px;height:84px}.pick h3{font-size:20px}.grid2{grid-template-columns:1fr}.code{grid-template-columns:1fr}.copy{padding:10px}.hero h1{font-size:30px}}\n  </style>\n</head>\n<body>\n<header class=\"top\"><div class=\"wrap topin\"><div class=\"brand\"><div class=\"logo\">WZ</div><div><b>\u062a\u0648\u0642\u0639\u0627\u062a \u0648\u0627\u0626\u0644 \u0627\u0644\u0632\u064a\u0646</b><small>Football Intelligence \u2022 LIVE v4</small></div></div><div class=\"server\"><i id=\"serverDot\" class=\"dot\"></i><span id=\"serverText\">\u0641\u062d\u0635 \u0627\u0644\u062e\u0627\u062f\u0645\u2026</span></div></div></header>\n<main class=\"wrap\">\n  <section class=\"card hero\">\n    <div><div class=\"eyebrow\">WAIL ELZAIN \u2022 AI MATCH ANALYSIS</div><h1>\u062a\u062d\u0644\u064a\u0644 \u0623\u0639\u0645\u0642 \u0642\u0628\u0644 \u0627\u062e\u062a\u064a\u0627\u0631 \u0627\u0644\u062d\u062f\u062b</h1><p>\u0627\u0644\u0645\u0648\u0627\u062c\u0647\u0627\u062a \u0627\u0644\u0642\u0627\u062f\u0645\u0629\u060c \u0627\u0644\u0641\u0648\u0631\u0645\u0629 \u0627\u0644\u062d\u062f\u064a\u062b\u0629\u060c \u0642\u0648\u0629 \u0627\u0644\u0647\u062c\u0648\u0645 \u0648\u0627\u0644\u062f\u0641\u0627\u0639\u060c \u0627\u0644\u063a\u064a\u0627\u0628\u0627\u062a \u0648\u0627\u0644\u062a\u0634\u0643\u064a\u0644\u0627\u062a \u0648\u0627\u0644\u062a\u0631\u062a\u064a\u0628 \u0639\u0646\u062f \u062a\u0648\u0641\u0631\u0647\u0627\u060c \u062b\u0645 \u0646\u0645\u0630\u062c\u0629 \u0627\u062d\u062a\u0645\u0627\u0644\u064a\u0629 \u0644\u0627\u062e\u062a\u064a\u0627\u0631 \u062d\u062f\u062b \u0648\u0627\u062d\u062f \u0623\u0639\u0644\u0649 \u0627\u062d\u062a\u0645\u0627\u0644\u064b\u0627 \u0645\u0639 \u062f\u0631\u062c\u0629 \u062c\u0648\u062f\u0629 \u0645\u0633\u062a\u0642\u0644\u0629 \u0639\u0646 \u0646\u0633\u0628\u0629 \u0627\u0644\u062b\u0642\u0629.</p></div>\n    <div class=\"mode\"><b id=\"modeText\">\u062c\u0627\u0631\u064d \u0627\u0644\u0627\u062a\u0635\u0627\u0644</b><span>\u0645\u0635\u062f\u0631 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a</span></div>\n  </section>\n  <section class=\"card toolbar\">\n    <div class=\"ranges\"><button class=\"range active\" data-days=\"7\">7 \u0623\u064a\u0627\u0645</button><button class=\"range\" data-days=\"14\">14 \u064a\u0648\u0645</button><button class=\"range\" data-days=\"30\">30 \u064a\u0648\u0645</button></div>\n    <div class=\"search\"><input id=\"search\" placeholder=\"\u0627\u0628\u062d\u062b \u0639\u0646 \u0641\u0631\u064a\u0642 \u0623\u0648 \u0628\u0637\u0648\u0644\u0629\"/><button id=\"refresh\" class=\"btn\">\u062a\u062d\u062f\u064a\u062b \u0627\u0644\u0645\u0628\u0627\u0631\u064a\u0627\u062a</button></div>\n  </section>\n  <section class=\"layout\">\n    <aside class=\"card fixtures\"><div class=\"heading\"><div><h2>\u0627\u0644\u0645\u0648\u0627\u062c\u0647\u0627\u062a \u0627\u0644\u0642\u0627\u062f\u0645\u0629</h2><p id=\"fixtureMeta\">\u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0645\u0628\u0627\u0631\u064a\u0627\u062a\u2026</p></div><div id=\"count\" class=\"count\">0</div></div><div id=\"fixtureList\" class=\"fixtureList\"></div></aside>\n    <section class=\"card analysis\"><div id=\"empty\" class=\"empty\"><div><div class=\"ico\">\u26bd</div><h3>\u0627\u062e\u062a\u0631 \u0645\u0648\u0627\u062c\u0647\u0629</h3><p>\u0633\u064a\u0638\u0647\u0631 \u0647\u0646\u0627 \u0627\u0644\u062d\u062f\u062b \u0627\u0644\u0623\u0639\u0644\u0649 \u0627\u062d\u062a\u0645\u0627\u0644\u064b\u0627 \u0645\u0639 \u0623\u0633\u0628\u0627\u0628 \u0627\u0644\u0627\u062e\u062a\u064a\u0627\u0631 \u0648\u062c\u0648\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0648\u0627\u0644\u063a\u064a\u0627\u0628\u0627\u062a \u0627\u0644\u0645\u062a\u0627\u062d\u0629.</p></div></div><div id=\"content\" class=\"hidden\"></div></section>\n  </section>\n  <div class=\"card footer\">\u0644\u0627 \u062a\u0648\u062c\u062f \u062a\u0648\u0642\u0639\u0627\u062a \u0645\u0636\u0645\u0648\u0646\u0629 100% \u0641\u064a \u0643\u0631\u0629 \u0627\u0644\u0642\u062f\u0645. \u0627\u0644\u0631\u0645\u0632 WZ \u0627\u0644\u0630\u064a \u064a\u0638\u0647\u0631 \u062f\u0627\u062e\u0644 \u0627\u0644\u062a\u062d\u0644\u064a\u0644 \u0647\u0648 \u0631\u0645\u0632 \u062f\u0627\u062e\u0644\u064a \u0644\u0644\u062a\u062a\u0628\u0639 \u0648\u0644\u064a\u0633 \u0643\u0648\u062f \u0642\u0633\u064a\u0645\u0629 1xBet \u0642\u0627\u0628\u0644\u064b\u0627 \u0644\u0644\u0627\u0633\u062a\u064a\u0631\u0627\u062f. \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0644\u0627 \u064a\u0631\u0633\u0644 \u0631\u0647\u0627\u0646\u0627\u062a \u0648\u0644\u0627 \u064a\u062a\u0635\u0644 \u0628\u062d\u0633\u0627\u0628 \u0645\u0631\u0627\u0647\u0646\u0629.</div>\n</main>\n<script>\nconst $=s=>document.querySelector(s); const state={days:7,fixtures:[],selected:null};\nconst esc=(s='')=>String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nconst fmtDate=iso=>new Intl.DateTimeFormat('ar-OM',{weekday:'short',day:'numeric',month:'short'}).format(new Date(iso));\nconst fmtTime=iso=>new Intl.DateTimeFormat('ar-OM',{hour:'2-digit',minute:'2-digit'}).format(new Date(iso));\nasync function api(path){const r=await fetch(path,{headers:{Accept:'application/json'}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.detail||`HTTP ${r.status}`);return j}\nasync function health(){try{const h=await api('/api/health');$('#serverDot').className='dot ok';$('#serverText').textContent='\u0627\u0644\u062e\u0627\u062f\u0645 \u0645\u062a\u0635\u0644';$('#modeText').textContent=h.mode==='deep-live'?'LIVE \u0639\u0645\u064a\u0642':'LIVE \u0639\u0627\u0645';}catch(e){$('#serverDot').className='dot bad';$('#serverText').textContent='\u0627\u0644\u062e\u0627\u062f\u0645 \u063a\u064a\u0631 \u0645\u062a\u0635\u0644';$('#modeText').textContent='\u063a\u064a\u0631 \u0645\u062a\u0635\u0644';}}\nasync function load(){const root=$('#fixtureList');root.innerHTML='<div class=\"loader\"><div class=\"spin\"></div>\u062c\u0627\u0631\u064a \u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0645\u0628\u0627\u0631\u064a\u0627\u062a\u2026</div>';try{const j=await api(`/api/fixtures?days=${state.days}`);state.fixtures=j.fixtures||[];$('#modeText').textContent=j.mode?.includes('deep')?'LIVE \u0639\u0645\u064a\u0642':'LIVE \u0639\u0627\u0645';$('#fixtureMeta').textContent=`${j.provider||'\u0645\u0635\u062f\u0631 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a'} \u2022 \u062d\u062f\u0651\u062b \u0639\u0646\u062f \u0627\u0644\u062d\u0627\u062c\u0629`;render();}catch(e){state.fixtures=[];$('#count').textContent='0';$('#fixtureMeta').textContent='\u062a\u0639\u0630\u0631 \u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a';root.innerHTML=`<div class=\"loader\">${esc(e.message)}</div>`}}\nfunction render(){const q=$('#search').value.trim().toLowerCase();const rows=state.fixtures.filter(f=>!q||`${f.home} ${f.away} ${f.league}`.toLowerCase().includes(q));$('#count').textContent=rows.length;const root=$('#fixtureList');root.innerHTML=rows.length?'':'<div class=\"loader\">\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0648\u0627\u062c\u0647\u0627\u062a \u0645\u0637\u0627\u0628\u0642\u0629.</div>';for(const f of rows){const b=document.createElement('button');b.className='fixture'+(state.selected===f.id?' active':'');b.innerHTML=`<div class=\"ftop\"><span>${esc(f.league||'\u0628\u0637\u0648\u0644\u0629')}</span><span>${fmtTime(f.date)}</span></div><div class=\"teams\"><span>${esc(f.home)}</span><b>\u00d7</b><span class=\"away\">${esc(f.away)}</span></div><div class=\"fbottom\"><span>${fmtDate(f.date)}</span><span class=\"statusMini\">\u062c\u0627\u0647\u0632 \u0644\u0644\u062a\u062d\u0644\u064a\u0644</span></div>`;b.onclick=()=>analyze(f);root.appendChild(b)}}\nfunction metricCard(title,team,m){return `<div class=\"mini\"><h4>${esc(title)} \u2022 ${esc(team)}</h4><div class=\"row\"><span>\u0627\u0644\u0641\u0648\u0631\u0645\u0629</span><b>${esc(m?.form||'\u063a\u064a\u0631 \u0645\u062a\u0627\u062d')}</b></div><div class=\"row\"><span>\u0627\u0644\u062a\u0633\u062c\u064a\u0644</span><b>${esc(m?.gf??'\u2014')}</b></div><div class=\"row\"><span>\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644</span><b>${esc(m?.ga??'\u2014')}</b></div>${m?.rank?`<div class=\"row\"><span>\u0627\u0644\u062a\u0631\u062a\u064a\u0628</span><b>${esc(m.rank)}</b></div>`:''}${m?.points!=null?`<div class=\"row\"><span>\u0627\u0644\u0646\u0642\u0627\u0637</span><b>${esc(m.points)}</b></div>`:''}</div>`}\nfunction listCard(title,items=[]){return `<div class=\"mini\"><h4>${esc(title)}</h4>${items.length?items.map(x=>`<div class=\"reason\">\u2022 ${esc(x)}</div>`).join(''):'<div class=\"reason\">\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a \u0643\u0627\u0641\u064a\u0629.</div>'}</div>`}\nasync function analyze(f){state.selected=f.id;render();$('#empty').classList.add('hidden');$('#content').classList.remove('hidden');$('#content').innerHTML='<div class=\"loader\"><div class=\"spin\"></div>\u0641\u062d\u0635 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0648\u0628\u0646\u0627\u0621 \u0627\u0644\u0627\u062d\u062a\u0645\u0627\u0644\u0627\u062a\u2026</div>';try{const a=await api(`/api/analyze/${encodeURIComponent(f.id)}`);drawAnalysis(a)}catch(e){$('#content').innerHTML=`<div class=\"empty\"><div><div class=\"ico\">\u26a0\ufe0f</div><h3>\u062a\u0639\u0630\u0631 \u0625\u0643\u0645\u0627\u0644 \u0627\u0644\u062a\u062d\u0644\u064a\u0644</h3><p>${esc(e.message)}</p></div></div>`}}\nfunction drawAnalysis(a){const f=a.fixture||{},p=a.prediction||{},q=a.quality||{},conf=Math.round(p.confidence||0),abs=a.absences||[],alts=a.alternatives||[],reasons=a.reasons||[];$('#content').innerHTML=`<div class=\"ahead\"><div><h2>${esc(f.home)} \u00d7 ${esc(f.away)}</h2><p>${esc(f.league||'')} \u2022 ${f.date?fmtDate(f.date)+' '+fmtTime(f.date):''}</p></div><div class=\"ring\" style=\"--pct:${conf}%\"><div><b>${conf}%</b><small>\u062b\u0642\u0629 \u0627\u0644\u0646\u0645\u0648\u0630\u062c</small></div></div></div><div class=\"pick\"><div class=\"lab\">\u0627\u0644\u062d\u062f\u062b \u0627\u0644\u0623\u0639\u0644\u0649 \u0627\u062d\u062a\u0645\u0627\u0644\u064b\u0627 \u0648\u0641\u0642 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062a\u0627\u062d\u0629</div><h3>${esc(p.event||'\u063a\u064a\u0631 \u0645\u062a\u0627\u062d')}</h3><p>${esc(p.explanation||'')}</p><div class=\"prob\"><span class=\"chip\">\u0627\u062d\u062a\u0645\u0627\u0644 \u062e\u0627\u0645: <b>${esc(p.rawProbability??'\u2014')}%</b></span><span class=\"chip\">\u062c\u0648\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a: <b>${esc(q.score??'\u2014')}%</b></span><span class=\"chip\">\u0627\u0644\u0648\u0636\u0639: <b>${esc(a.mode||'\u2014')}</b></span></div><div class=\"code\"><code>${esc(p.internalCode||'WZ-N/A')}</code><button class=\"copy\" id=\"copy\">\u0646\u0633\u062e \u0627\u0644\u0631\u0645\u0632</button></div><div class=\"note\">\u0631\u0645\u0632 \u062f\u0627\u062e\u0644\u064a \u0644\u0644\u062a\u062a\u0628\u0639 \u0641\u0642\u0637\u061b \u0644\u064a\u0633 \u0643\u0648\u062f 1xBet \u0648\u0644\u0627 \u064a\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0623\u064a \u0631\u0647\u0627\u0646 \u062a\u0644\u0642\u0627\u0626\u064a\u064b\u0627.</div></div><div class=\"grid2\">${metricCard('\u0627\u0644\u0645\u0636\u064a\u0641',f.home,a.metrics?.home)}${metricCard('\u0627\u0644\u0636\u064a\u0641',f.away,a.metrics?.away)}${listCard('\u0646\u0642\u0627\u0637 \u0642\u0648\u0629 \u0627\u0644\u0645\u0636\u064a\u0641',a.strengths?.home)}${listCard('\u0646\u0642\u0627\u0637 \u0636\u0639\u0641 \u0627\u0644\u0645\u0636\u064a\u0641',a.weaknesses?.home)}${listCard('\u0646\u0642\u0627\u0637 \u0642\u0648\u0629 \u0627\u0644\u0636\u064a\u0641',a.strengths?.away)}${listCard('\u0646\u0642\u0627\u0637 \u0636\u0639\u0641 \u0627\u0644\u0636\u064a\u0641',a.weaknesses?.away)}</div><div class=\"quality\"><div class=\"qualityHead\"><b>\u062c\u0648\u062f\u0629 \u0627\u0644\u062a\u063a\u0637\u064a\u0629</b><span>${esc(q.label||'\u2014')} \u2022 ${esc(q.score??0)}%</span></div><div class=\"bar\"><i style=\"width:${Math.max(0,Math.min(100,q.score||0))}%\"></i></div>${(q.reasons||[]).map(x=>`<div class=\"reason\">${esc(x)}</div>`).join('')}</div><h3 class=\"sectionTitle\">\u0627\u0644\u063a\u064a\u0627\u0628\u0627\u062a \u0648\u0627\u0644\u0625\u0635\u0627\u0628\u0627\u062a</h3><div class=\"mini\">${abs.length?abs.slice(0,16).map(x=>`<div class=\"row\"><span>${esc(x.team||'')} \u2022 ${esc(x.player||'')}</span><b>${esc(x.reason||x.type||'\u063a\u064a\u0627\u0628')}</b></div>`).join(''):'<div class=\"reason\">\u0644\u0645 \u062a\u0638\u0647\u0631 \u063a\u064a\u0627\u0628\u0627\u062a \u0645\u0624\u0643\u062f\u0629 \u0641\u064a \u0627\u0644\u0645\u0635\u062f\u0631 \u0648\u0642\u062a \u0627\u0644\u062a\u062d\u0644\u064a\u0644 \u0623\u0648 \u0623\u0646 \u0627\u0644\u062a\u063a\u0637\u064a\u0629 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d\u0629.</div>'}</div><h3 class=\"sectionTitle\">\u0623\u0633\u0628\u0627\u0628 \u0627\u0644\u0627\u062e\u062a\u064a\u0627\u0631</h3><div class=\"mini\">${reasons.map(x=>`<div class=\"reason\">${esc(x)}</div>`).join('')}</div><h3 class=\"sectionTitle\">\u0628\u062f\u0627\u0626\u0644 \u0623\u0642\u0644 \u062a\u0631\u062a\u064a\u0628\u064b\u0627</h3><div class=\"mini\">${alts.length?alts.map(x=>`<div class=\"alt\"><span>${esc(x.event)}</span><b>${esc(x.probability)}%</b></div>`).join(''):'<div class=\"reason\">\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u062f\u0627\u0626\u0644 \u0643\u0627\u0641\u064a\u0629.</div>'}</div>`;$('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(p.internalCode||'');$('#copy').textContent='\u062a\u0645 \u0627\u0644\u0646\u0633\u062e'}catch{$('#copy').textContent='\u062a\u0639\u0630\u0631 \u0627\u0644\u0646\u0633\u062e'}}}\ndocument.querySelectorAll('.range').forEach(b=>b.onclick=()=>{document.querySelectorAll('.range').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.days=Number(b.dataset.days);load()});$('#search').addEventListener('input',render);$('#refresh').onclick=load;health();load();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});\n</script>\n</body></html>\n", type: 'text/html; charset=utf-8' }],
  ['/manifest.webmanifest', { body: "{\n  \"name\": \"\u062a\u0648\u0642\u0639\u0627\u062a \u0648\u0627\u0626\u0644 \u0627\u0644\u0632\u064a\u0646\",\n  \"short_name\": \"WZ \u062a\u0648\u0642\u0639\u0627\u062a\",\n  \"start_url\": \"/\",\n  \"display\": \"standalone\",\n  \"background_color\": \"#050d16\",\n  \"theme_color\": \"#071421\",\n  \"lang\": \"ar\",\n  \"dir\": \"rtl\"\n}\n", type: 'application/manifest+json; charset=utf-8' }],
  ['/sw.js', { body: "const CACHE='wz-v4-shell-1';\nconst SHELL=['/','/index.html','/manifest.webmanifest'];\nself.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));\nself.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));\nself.addEventListener('fetch',e=>{\n  const u=new URL(e.request.url);\n  if(u.pathname.startsWith('/api/')) return;\n  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))));\n});\n", type: 'application/javascript; charset=utf-8' }]
]);

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

async function serveStatic(req, res, pathname) {
  const key = pathname === '/' ? '/index.html' : pathname;
  const file = embeddedFiles.get(key);
  if (!file) return false;
  const body = file.body;
  res.writeHead(200, {
    'Content-Type': file.type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': key === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'Wail Elzain Football AI',
        version: '4.0.0',
        mode: API_KEY ? 'deep-live' : ENABLE_PUBLIC_FALLBACK ? 'public-live' : 'no-provider',
        providerConfigured: Boolean(API_KEY),
        publicFallback: ENABLE_PUBLIC_FALLBACK,
        serverTime: new Date().toISOString()
      });
    }

    if (req.method === 'GET' && pathname === '/api/fixtures') {
      const days = clamp(Number(url.searchParams.get('days') || 7), 1, 30);
      try {
        if (API_KEY) {
          const fixtures = await getApiFixtures(days);
          return sendJson(res, 200, { fixtures, mode: 'deep-live', provider: 'API-Football' });
        }
        if (ENABLE_PUBLIC_FALLBACK) {
          const fixtures = await getPublicFixtures(days);
          return sendJson(res, 200, { fixtures, mode: 'public-live', provider: 'TheSportsDB Free' });
        }
        return sendJson(res, 503, { error: 'NO_DATA_PROVIDER', message: 'لا يوجد مزود بيانات مفعّل على الخادم.' });
      } catch (error) {
        if (ENABLE_PUBLIC_FALLBACK && API_KEY) {
          try {
            const fixtures = await getPublicFixtures(days);
            return sendJson(res, 200, { fixtures, mode: 'public-live-fallback', provider: 'TheSportsDB Free', warning: error.message });
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
        const indexed = memoryFixtureIndex.get(id);
        if (indexed?.source === 'API-Football' && API_KEY) return sendJson(res, 200, await analyzeApiFixture(indexed.id));
        if (indexed?.source === 'TheSportsDB Free' && ENABLE_PUBLIC_FALLBACK) return sendJson(res, 200, await analyzePublicFixture(indexed.id));
        return sendJson(res, 400, { error: 'UNKNOWN_FIXTURE_ID', message: 'معرّف المباراة غير معروف. حدّث قائمة المباريات ثم حاول مجددًا.' });
      } catch (error) {
        return sendJson(res, 502, { error: 'ANALYSIS_FAILED', message: 'تعذر إكمال التحليل لهذه المواجهة.', detail: error.message });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (await serveStatic(req, res, pathname)) return;
    if (await serveStatic(req, res, '/index.html')) return;
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'SERVER_ERROR', message: 'خطأ داخلي في الخادم.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Wail Elzain Football AI running on port ${PORT}`);
});
