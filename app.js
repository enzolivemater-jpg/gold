/* ==========================================================================
   GOLD COMPASS — moteur institutionnel XAUUSD
   Architecture : DATA (data.json + prix live) -> ENGINES -> DIFF RENDER -> UI

   Mode LIVE permanent :
   - boucle d'actualisation auto-adaptative selon le régime de marché
   - mesure réelle de latence, âge de la donnée affiché en continu
   - rendu différentiel (seuls les blocs modifiés touchent le DOM)
   - journal d'audit des changements de biais
   Aucune donnée n'est inventée en dehors de data.json / du flux prix.
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   0. CONFIGURATION
   -------------------------------------------------------------------------- */
const CONFIG = {
  // Cadence du flux prix selon le régime de marché (ms).
  // Plus le marché est stressé, plus on rafraîchit vite.
  PRICE_INTERVAL: { normal: 20000, volatile: 10000, stress: 6000, crisis: 4000 },
  // Cadence de rechargement du fichier de données complet (news/géo/calendrier).
  DATA_INTERVAL: 60000,
  // Cadence du bloc macro live (15 tickers Yahoo en parallèle). Plus lent que
  // le prix : ces séries bougent moins vite et coûtent 15 appels par cycle.
  MACRO_INTERVAL: 45000,
  // En deçà, une variation est considérée comme du bruit et non un signal.
  MACRO_NOISE_PCT: 0.05,
  // Seuils d'obsolescence de la donnée affichée.
  STALE_WARN_MS: 45000,
  STALE_CRIT_MS: 120000,
  // Au-delà, une cotation Yahoo est considérée périmée MÊME SI l'appel réseau
  // a réussi rapidement — c'est l'horodatage de la cotation qui compte, pas
  // la vitesse à laquelle Yahoo nous a répondu.
  QUOTE_STALE_MS: 90000,
  // Résilience réseau : backoff exponentiel plafonné.
  BACKOFF_FACTOR: 1.8,
  BACKOFF_MAX_MS: 120000,
  FETCH_TIMEOUT_MS: 4000,
  // Journal d'audit.
  HISTORY_MAX: 40,
  HISTORY_KEY: 'goldcompass.biashistory.v1'
};

/* --------------------------------------------------------------------------
   1. FALLBACK LOCAL (si data.json est inaccessible)
   -------------------------------------------------------------------------- */
const FALLBACK_DATA = {
  meta: { generated_at: new Date().toISOString(), source: 'MOCK_FALLBACK_LOCAL', market_status: 'normal', session: 'Session inconnue', latency_ms: null },
  price: { symbol: 'XAUUSD', last: 4180.00, prev_close: 4180.00, change_pct: 0, change_abs: 0, spread: 0.30, day_high: 4180.00, day_low: 4180.00 },
  macro: {}, calendar: [], geopolitics: [], news: []
};

/* --------------------------------------------------------------------------
   2. ÉTAT GLOBAL
   -------------------------------------------------------------------------- */
const STATE = {
  data: null,
  liveStatus: 'LIVE',        // LIVE | DEGRADE  (data.json atteignable)
  priceSource: 'STATIC',     // LIVE | STATIC   (prix réel ou statique)
  activeTab: 'snapshot',
  bias: null, risk: null, haven: null, scenarios: null, newsGraded: [],

  // --- suivi live ---
  lastPriceAt: null,         // timestamp du dernier prix réel obtenu
  priceQuoteTimeMs: null,    // horodatage RÉEL de la cotation (Yahoo regularMarketTime)
  priceSourceLabel: null,    // quelle source a répondu (diagnostic)
  lastDataAt: null,          // timestamp du dernier data.json chargé
  lastMacroAt: null,         // timestamp du dernier bloc macro live
  macroLive: 0,              // nb de tickers macro récupérés au dernier cycle
  macroTotal: 0,             // nb de tickers macro suivis (rempli à l'init)
  latencyMs: null,           // latence réelle mesurée du dernier appel prix
  prevPrice: null,           // pour détecter le sens du tick
  consecutiveFailures: 0,
  paused: false,             // onglet en arrière-plan
  timerPrice: null, timerData: null, timerClock: null, timerMacro: null,
  biasHistory: [],
  renderCache: {}            // signatures de rendu, pour le diff
};

/* --------------------------------------------------------------------------
   3. CHARGEMENT DES DONNÉES
   -------------------------------------------------------------------------- */
async function fetchWithTimeout(url, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadData() {
  try {
    const res = await fetchWithTimeout('data.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    STATE.liveStatus = 'LIVE';
    STATE.lastDataAt = Date.now();
    return json;
  } catch (err) {
    console.warn('[GoldCompass] data.json indisponible, bascule fallback:', err.message);
    STATE.liveStatus = 'DEGRADE';
    return FALLBACK_DATA;
  }
}

/* --- Prix live : API v8 Yahoo Finance, avec chaîne de repli ---------------- */
const YAHOO_XAU = 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=5m&range=1d';
const YAHOO_GC  = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d';
const PRICE_SOURCES = [
  { url: YAHOO_XAU, label: 'yahoo:XAUUSD=X' },
  { url: 'https://corsproxy.io/?url=' + encodeURIComponent(YAHOO_XAU), label: 'yahoo:XAUUSD=X (proxy)' },
  { url: YAHOO_GC,  label: 'yahoo:GC=F' },
  { url: 'https://corsproxy.io/?url=' + encodeURIComponent(YAHOO_GC), label: 'yahoo:GC=F (proxy)' }
];

async function fetchLiveGoldPrice() {
  for (const src of PRICE_SOURCES) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      const res = await fetchWithTimeout(src.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('Réponse Yahoo invalide');
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      // regularMarketTime = horodatage de LA COTATION elle-même (secondes Unix),
      // distinct du moment où NOUS avons reçu la réponse. Un appel rapide peut
      // très bien renvoyer une cotation vieille de plusieurs minutes si le
      // fournisseur sert une valeur en cache — c'est ça qu'il faut détecter.
      const quoteTimeMs = typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null;
      return {
        last: meta.regularMarketPrice,
        prev_close: meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice,
        day_high: meta.regularMarketDayHigh ?? meta.regularMarketPrice,
        day_low: meta.regularMarketDayLow ?? meta.regularMarketPrice,
        latency_ms: Math.round(t1 - t0),
        fetched_at: new Date().toISOString(),
        quote_time_ms: quoteTimeMs,
        quote_age_ms: quoteTimeMs != null ? Date.now() - quoteTimeMs : null,
        source: src.label
      };
    } catch (err) {
      console.warn('[GoldCompass] Source prix indisponible (' + src.label + '):', err.message);
    }
  }
  return null;
}

function applyLivePrice(data, live) {
  const prevClose = live.prev_close || live.last;
  const changeAbs = +(live.last - prevClose).toFixed(2);
  const changePct = prevClose ? +((changeAbs / prevClose) * 100).toFixed(2) : 0;
  data.price = {
    ...data.price,
    symbol: 'XAUUSD',
    last: +live.last.toFixed(2),
    prev_close: +prevClose.toFixed(2),
    change_abs: changeAbs,
    change_pct: changePct,
    day_high: +Math.max(live.day_high, live.last).toFixed(2),
    day_low: +Math.min(live.day_low, live.last).toFixed(2)
  };
  data.meta.generated_at = live.fetched_at;
  STATE.latencyMs = live.latency_ms;
  STATE.lastPriceAt = Date.now();
  STATE.priceQuoteTimeMs = live.quote_time_ms;   // horodatage réel de la cotation
  STATE.priceSourceLabel = live.source;          // pour diagnostic (XAUUSD=X vs GC=F)
}


/* --------------------------------------------------------------------------
   3bis. MACRO LIVE — mêmes endpoints Yahoo v8, un ticker par appel.
   C'est ce bloc qui rend le BIAIS réellement vivant : dollar, taux, VIX,
   actions, métaux et énergie alimentent directement le moteur de conviction.

   Reste statique (issu de data.json) : flux ETF, COT, stocks COMEX, fixings
   LBMA, prime Shanghai — séries publiées quotidiennement ou hebdomadairement,
   sans diffusion continue gratuite.
   -------------------------------------------------------------------------- */

/* Règles de conversion variation -> impact sur l'or :
   inverse = la baisse du ticker est haussière pour l'or (dollar, taux)
   direct  = la hausse du ticker est haussière pour l'or (argent, EURUSD)
   riskoff = la baisse du ticker traduit une aversion au risque (actions, BTC)
   vol     = la hausse du ticker traduit du stress (VIX)
   geo     = la hausse du ticker traduit une prime géopolitique (pétrole) */
const MACRO_TICKERS = [
  { key: 'dxy',     symbol: 'DX-Y.NYB', label: 'DXY',                 unit: '',  rule: 'inverse' },
  { key: 'us10y',   symbol: '^TNX',     label: 'US 10Y Yield',        unit: '%', rule: 'inverse', asYield: true },
  { key: 'us02y',   symbol: '^IRX',     label: 'US 13W Bill (proxy court terme)', unit: '%', rule: 'inverse', asYield: true },
  { key: 'vix',     symbol: '^VIX',     label: 'VIX',                 unit: '',  rule: 'vol' },
  { key: 'gvz',     symbol: '^GVZ',     label: 'GVZ (Gold Vol)',      unit: '',  rule: 'neutral' },
  { key: 'spx',     symbol: '^GSPC',    label: 'S&P 500',             unit: '',  rule: 'riskoff' },
  { key: 'nasdaq',  symbol: '^IXIC',    label: 'Nasdaq',              unit: '',  rule: 'riskoff' },
  { key: 'silver',  symbol: 'SI=F',     label: 'Silver',              unit: '',  rule: 'direct' },
  { key: 'copper',  symbol: 'HG=F',     label: 'Copper',              unit: '',  rule: 'neutral' },
  { key: 'oil_wti', symbol: 'CL=F',     label: 'WTI Crude',           unit: '',  rule: 'geo' },
  { key: 'natgas',  symbol: 'NG=F',     label: 'Nat Gas',             unit: '',  rule: 'neutral' },
  { key: 'btc',     symbol: 'BTC-USD',  label: 'Bitcoin',             unit: '',  rule: 'riskoff' },
  { key: 'usdjpy',  symbol: 'JPY=X',    label: 'USD/JPY',             unit: '',  rule: 'neutral' },
  { key: 'eurusd',  symbol: 'EURUSD=X', label: 'EUR/USD',             unit: '',  rule: 'direct' },
  { key: 'gbpusd',  symbol: 'GBPUSD=X', label: 'GBP/USD',             unit: '',  rule: 'neutral' }
];

function yahooChartUrl(symbol) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
         encodeURIComponent(symbol) + '?interval=1d&range=5d';
}

function yahooChartUrlViaProxy(symbol) {
  return 'https://corsproxy.io/?url=' + encodeURIComponent(yahooChartUrl(symbol));
}

/* Même résilience que le prix : direct d'abord, proxy CORS en repli.
   Aujourd'hui le direct suffit (Yahoo autorise le CORS sur cet endpoint),
   mais rien ne garantit que ça reste vrai indéfiniment — un ticker macro
   ne doit pas être moins résilient que le prix pour la même API. */
async function fetchYahooQuote(symbol, asYield) {
  let lastErr;
  for (const url of [yahooChartUrl(symbol), yahooChartUrlViaProxy(symbol)]) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('Réponse invalide');
      let last = meta.regularMarketPrice;
      let prev = meta.chartPreviousClose ?? meta.previousClose ?? last;
      // Yahoo cote historiquement certains indices de taux en dixièmes
      // (^TNX à 42.8 pour 4.28 %). On normalise si l'ordre de grandeur le trahit.
      if (asYield && last > 20) { last /= 10; prev /= 10; }
      const changePct = prev ? ((last - prev) / prev) * 100 : 0;
      return { last, prev, change_pct: changePct };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function deriveSignal(rule, changePct) {
  const t = CONFIG.MACRO_NOISE_PCT;
  const up = changePct > t, down = changePct < -t;
  switch (rule) {
    case 'inverse': return down ? 'bullish_gold' : up ? 'bearish_gold' : 'neutral';
    case 'direct':  return up ? 'bullish_gold' : down ? 'bearish_gold' : 'neutral';
    case 'riskoff': return down ? 'risk_off' : 'neutral';
    case 'vol':     return up ? 'risk_off' : 'neutral';
    case 'geo':     return up ? 'geopolitical_premium' : 'neutral';
    default:        return 'neutral';
  }
}
function deriveTrend(changePct) {
  if (Math.abs(changePct) < CONFIG.MACRO_NOISE_PCT) return 'flat';
  return changePct > 0 ? 'up' : 'down';
}

/* Récupère tous les tickers en parallèle. Un échec isolé n'invalide pas
   le reste : on retourne ce qui a répondu. */
async function fetchMacroSnapshot() {
  const settled = await Promise.allSettled(MACRO_TICKERS.map(async t => ({
    cfg: t, quote: await fetchYahooQuote(t.symbol, t.asYield)
  })));
  const out = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out[r.value.cfg.key] = r.value;
    else console.warn('[GoldCompass] Ticker macro indisponible (' +
                      MACRO_TICKERS[i].symbol + '):', r.reason?.message);
  });
  return out;
}

/* Rendement réel 10 ans = nominal live − point mort d'inflation.
   Le point mort évolue lentement : il vient de data.json (assumptions). */
function applyRealYield(data) {
  const nominal = data.macro?.us10y;
  const breakeven = data.assumptions?.inflation_breakeven_10y;
  if (!nominal || breakeven == null) return;
  data.macro.real_yields_10y = {
    label: 'US 10Y Real Yield',
    value: +(nominal.value - breakeven).toFixed(2),
    unit: '%',
    change_pct: nominal.change_pct,
    change_bps: nominal.change_bps ?? 0,
    trend: nominal.trend,
    signal: nominal.signal,
    live: true, derived: true
  };
}

/* Fusionne le snapshot live dans data.macro, en préservant les séries
   statiques que Yahoo ne fournit pas. */
function applyMacroSnapshot(data, snapshot) {
  let liveCount = 0;
  Object.values(snapshot).forEach(({ cfg, quote }) => {
    const prev = data.macro[cfg.key] || {};
    const entry = {
      ...prev,
      label: cfg.label,
      value: cfg.asYield ? +quote.last.toFixed(2)
                         : +quote.last.toFixed(quote.last > 1000 ? 2 : 4),
      unit: cfg.unit ?? prev.unit ?? '',
      change_pct: +quote.change_pct.toFixed(2),
      trend: deriveTrend(quote.change_pct),
      signal: deriveSignal(cfg.rule, quote.change_pct),
      live: true
    };
    if (cfg.asYield) entry.change_bps = Math.round((quote.last - quote.prev) * 100);
    data.macro[cfg.key] = entry;
    liveCount++;
  });
  applyRealYield(data);
  // Marquage explicite des séries non couvertes par Yahoo : le modèle de
  // données ne doit jamais laisser `live` indéfini (ambiguïté à la lecture).
  Object.values(data.macro).forEach(e => { if (e && e.live !== true) e.live = false; });
  STATE.macroLive = liveCount;
  STATE.macroTotal = MACRO_TICKERS.length;
  STATE.lastMacroAt = Date.now();
}

/* --------------------------------------------------------------------------
   4. NEWS GRADING ENGINE
   NEWS SCORE = macro*0.30 + vol*0.20 + fiabilité*0.15 + surprise*0.20 + durée*0.15
   -------------------------------------------------------------------------- */
const DURATION_SCORE = { court: 30, moyen: 60, long: 90 };

function computeNewsScore(item) {
  const dureeScore = DURATION_SCORE[item.duration] ?? 50;
  const score =
    item.impact_macro * 0.30 + item.impact_vol * 0.20 + item.reliability * 0.15 +
    item.surprise_prob * 0.20 + dureeScore * 0.15;
  return Math.round(score * 10) / 10;
}

function classifyNewsTier(score) {
  if (score >= 80) return { tier: 'CATALYSEUR CRITIQUE', level: 5, cls: 'tier-critical' };
  if (score >= 60) return { tier: 'IMPACT MAJEUR',        level: 4, cls: 'tier-major' };
  if (score >= 40) return { tier: 'IMPACT SIGNIFICATIF',  level: 3, cls: 'tier-significant' };
  if (score >= 20) return { tier: 'IMPACT MODÉRÉ',        level: 2, cls: 'tier-moderate' };
  return              { tier: 'BRUIT FAIBLE',          level: 1, cls: 'tier-noise' };
}

function gradeAllNews(newsList) {
  return newsList
    .map(n => { const score = computeNewsScore(n); return { ...n, score, ...classifyNewsTier(score) }; })
    .sort((a, b) => b.score - a.score); // tri par impact réel, pas chronologique
}

/* --------------------------------------------------------------------------
   5. GEOPOLITICAL ENGINE — Global Risk Score (0-100)
   -------------------------------------------------------------------------- */
const TREND_WEIGHT = { escalade: 1.15, stable: 1.0, desescalade: 0.75 };

function computeGlobalRiskScore(geoList) {
  if (!geoList || !geoList.length) return { score: 0, level: 'FAIBLE', escalating: 0, deescalating: 0, stable: 0, zones: 0 };
  let weighted = 0, escalating = 0, deescalating = 0, stable = 0;
  geoList.forEach(g => {
    weighted += g.severity * (TREND_WEIGHT[g.trend] ?? 1.0);
    if (g.trend === 'escalade') escalating++;
    else if (g.trend === 'desescalade') deescalating++;
    else stable++;
  });
  const score = Math.round(Math.min(100, (weighted / (geoList.length * 100)) * 100));
  let level = 'FAIBLE';
  if (score >= 75) level = 'CRITIQUE';
  else if (score >= 55) level = 'ÉLEVÉ';
  else if (score >= 30) level = 'MODÉRÉ';
  return { score, level, escalating, deescalating, stable, zones: geoList.length };
}

/* --------------------------------------------------------------------------
   6. SAFE HAVEN ENGINE
   -------------------------------------------------------------------------- */
function safeVal(macro, key, fallback = 0) { return macro && macro[key] ? macro[key].value : fallback; }

function computeSafeHaven(macro, riskScore) {
  const vix = safeVal(macro, 'vix', 15);
  const realYield = safeVal(macro, 'real_yields_10y', 2);
  const dxyTrend = macro?.dxy?.trend ?? 'flat';
  const etfInflow = macro?.etf_flows_gold?.trend === 'inflow';
  const clamp = v => Math.max(0, Math.min(100, Math.round(v)));

  const riskOff = clamp(riskScore * 0.55 + (vix - 12) * 3.2);
  const riskOn = clamp(100 - riskOff);
  const gold = clamp(riskScore * 0.45 + (2.2 - realYield) * 18 + (etfInflow ? 12 : 0) + (dxyTrend === 'down' ? 8 : 0));
  const silver = clamp(gold * 0.85 + (safeVal(macro, 'silver', 0) > 0 ? 4 : 0));
  const chf = clamp(riskOff * 0.6 + 15);
  const jpy = clamp(riskOff * 0.45 + (safeVal(macro, 'usdjpy', 150) < 155 ? 10 : 0));
  const treasury = clamp(riskOff * 0.5 + (realYield < 2 ? 15 : -5));
  const cash = clamp(riskOff * 0.35 + (vix > 22 ? 20 : 0));
  return { gold, silver, chf, jpy, treasury, cash, riskOff, riskOn };
}

/* --------------------------------------------------------------------------
   7. GOLD BIAS ENGINE
   -------------------------------------------------------------------------- */
const SIGNAL_SCORE = { bullish_gold: 1, bearish_gold: -1, risk_off: 0.4, geopolitical_premium: 0.5, neutral: 0, undefined: 0 };
function factorSignedScore(macroItem) { return macroItem ? (SIGNAL_SCORE[macroItem.signal] ?? 0) : 0; }

function computeGoldBias(data, riskScore) {
  const m = data.macro || {};
  const factors = [
    { name: 'Dollar (DXY)',         weight: 0.22, score: factorSignedScore(m.dxy) },
    { name: 'Rendements réels',     weight: 0.24, score: factorSignedScore(m.real_yields_10y) },
    { name: 'Flux ETF',             weight: 0.14, score: factorSignedScore(m.etf_flows_gold) },
    { name: 'Positionnement (COT)', weight: 0.10, score: factorSignedScore(m.cot_spec_net_long) },
    { name: 'Demande physique',     weight: 0.08, score: factorSignedScore(m.comex_registered) },
    { name: 'Volatilité (VIX)',     weight: 0.08, score: factorSignedScore(m.vix) },
    { name: 'Risque géopolitique',  weight: 0.14, score: (riskScore.score / 100) * (riskScore.escalating >= riskScore.deescalating ? 1 : 0.3) }
  ];

  let net = 0, weightSum = 0;
  factors.forEach(f => { net += f.score * f.weight; weightSum += f.weight; });
  net = weightSum ? Math.max(-1, Math.min(1, net / weightSum)) : 0;

  const sameSign = factors.filter(f => Math.sign(f.score) === Math.sign(net) && f.score !== 0).length;
  const agreement = factors.length ? sameSign / factors.length : 0;
  const magnitude = Math.abs(net);
  const conviction = Math.max(0, Math.min(100, Math.round(magnitude * 70 + agreement * 30)));

  const neutralBase = Math.max(10, Math.min(65, 60 - magnitude * 50));
  const directional = 100 - neutralBase;
  let pHausse, pBaisse;
  if (net >= 0) { pHausse = directional * (0.5 + magnitude * 0.5); pBaisse = directional - pHausse; }
  else { pBaisse = directional * (0.5 + magnitude * 0.5); pHausse = directional - pBaisse; }
  pHausse = Math.round(pHausse); pBaisse = Math.round(pBaisse);
  const pNeutre = Math.max(0, 100 - pHausse - pBaisse);

  let biasLabel = 'NEUTRE / RANGE', direction = 'ATTENTE';
  if (net > 0.15) { biasLabel = net > 0.45 ? 'HAUSSIER MARQUÉ' : 'HAUSSIER'; direction = 'ACHAT PROBABLE'; }
  else if (net < -0.15) { biasLabel = net < -0.45 ? 'BAISSIER MARQUÉ' : 'BAISSIER'; direction = 'VENTE PROBABLE'; }

  const price = data.price?.last ?? 0;
  const invalidationPct = Math.max(0.35, 1.1 - magnitude * 0.7);
  const invalidation = net >= 0
    ? +(price * (1 - invalidationPct / 100)).toFixed(2)
    : +(price * (1 + invalidationPct / 100)).toFixed(2);

  const altHypothesis = net >= 0
    ? 'Invalidation si le dollar et les rendements réels reprennent leur hausse simultanément, ou en cas de désescalade géopolitique rapide.'
    : 'Invalidation si les rendements réels chutent brutalement ou si un choc géopolitique majeur ravive la demande refuge.';

  return { net, conviction, pHausse, pBaisse, pNeutre, biasLabel, direction,
           invalidation, invalidationPct: +invalidationPct.toFixed(2), altHypothesis,
           factors, agreement: Math.round(agreement * 100) };
}

/* --------------------------------------------------------------------------
   8. SCENARIO ENGINE
   -------------------------------------------------------------------------- */
const HORIZONS = [
  { key: '1h',      label: 'PROCHAINE HEURE',   decay: 0,    invalidPct: 0.30, hours: 1 },
  { key: 'session', label: 'PROCHAINE SESSION', decay: 0.06, invalidPct: 0.55, hours: 8 },
  { key: '24h',     label: '24 HEURES',         decay: 0.14, invalidPct: 1.10, hours: 24 },
  { key: '48h',     label: '48 HEURES',         decay: 0.22, invalidPct: 1.70, hours: 48 },
  { key: 'week',    label: 'SEMAINE',           decay: 0.35, invalidPct: 2.80, hours: 168 }
];

function nextTriggersWithin(calendar, hoursAhead) {
  if (!calendar) return [];
  const now = new Date(STATE.data?.meta?.generated_at ?? Date.now());
  const limit = new Date(now.getTime() + hoursAhead * 3600 * 1000);
  return calendar.filter(c => { const t = new Date(c.time); return t >= now && t <= limit; });
}

function computeScenarios(data, bias, risk) {
  const price = data.price?.last ?? 0;
  return HORIZONS.map(h => {
    const confidence = Math.max(15, Math.round(bias.conviction * (1 - h.decay)));
    const triggers = nextTriggersWithin(data.calendar, h.hours);
    const triggerLabel = triggers.length
      ? triggers.map(t => t.event).slice(0, 2).join(' · ')
      : (risk.escalating > 0 ? 'Évolution du risque géopolitique' : 'Flux macro / positionnement');
    const upTarget = +(price * (1 + h.invalidPct / 100)).toFixed(2);
    const downTarget = +(price * (1 - h.invalidPct / 100)).toFixed(2);

    const dominant = bias.net >= 0
      ? `Poursuite du biais haussier vers ${upTarget}, soutenue par ${bias.factors.filter(f => f.score > 0).map(f => f.name).slice(0, 2).join(' et ') || 'les facteurs macro dominants'}.`
      : `Poursuite du biais baissier vers ${downTarget}, sous la pression de ${bias.factors.filter(f => f.score < 0).map(f => f.name).slice(0, 2).join(' et ') || 'facteurs macro dominants'}.`;
    const alternative = `Range de consolidation entre ${downTarget} et ${upTarget} si les catalyseurs attendus déçoivent.`;
    const rupture = risk.score >= 55
      ? `Choc haussier violent au-delà de ${upTarget} en cas d'escalade géopolitique soudaine (frappe, blocage, sanction majeure).`
      : `Choc baissier sous ${downTarget} en cas de surprise macro hawkish combinée à une désescalade rapide.`;

    return { key: h.key, label: h.label, confidence, dominant, alternative, rupture,
             trigger: triggerLabel, invalidation: bias.net >= 0 ? downTarget : upTarget };
  });
}

/* --------------------------------------------------------------------------
   9. HELPERS
   -------------------------------------------------------------------------- */
function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function signCls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat'; }
function signPrefix(n) { return n > 0 ? '+' : ''; }
function trendArrow(t) { return t === 'up' ? '▲' : t === 'down' ? '▼' : '▬'; }
function timeAgo(iso) {
  if (!iso) return '—';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  return `il y a ${Math.round(min / 60)} h`;
}
function hhmm(iso, tz) {
  try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz }); }
  catch { return '—'; }
}
function hhmmss(iso, tz) {
  try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz }); }
  catch { return '—'; }
}
function directionLabel(d) {
  return { bullish: 'BULLISH OR', bearish: 'BEARISH OR', mixed: 'MIXTE', undefined: 'INDÉFINI' }[d] ?? String(d).toUpperCase();
}

/* --- Rendu différentiel : n'écrit dans le DOM que si la valeur a changé --- */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el && el.textContent !== String(value)) el.textContent = value;
}
function setClass(id, value) {
  const el = document.getElementById(id);
  if (el && el.className !== value) el.className = value;
}
function setHTMLIfChanged(id, signature, htmlFactory) {
  if (STATE.renderCache[id] === signature) return false;
  const el = document.getElementById(id);
  if (!el) return false;
  el.innerHTML = htmlFactory();
  STATE.renderCache[id] = signature;
  return true;
}

/* --------------------------------------------------------------------------
   10. JOURNAL D'AUDIT DES BIAIS
   Trace chaque transition de biais avec horodatage — indispensable pour
   relire a posteriori ce que le moteur affichait au moment d'une décision.
   -------------------------------------------------------------------------- */
function loadBiasHistory() {
  try {
    const raw = window.localStorage?.getItem(CONFIG.HISTORY_KEY);
    STATE.biasHistory = raw ? JSON.parse(raw) : [];
  } catch { STATE.biasHistory = []; }
}
function persistBiasHistory() {
  try { window.localStorage?.setItem(CONFIG.HISTORY_KEY, JSON.stringify(STATE.biasHistory.slice(0, CONFIG.HISTORY_MAX))); }
  catch { /* stockage indisponible : le journal reste en mémoire */ }
}
function recordBiasChange(prev, next) {
  const entry = {
    at: new Date().toISOString(),
    from: prev ? prev.biasLabel : null,
    to: next.biasLabel,
    convictionFrom: prev ? prev.conviction : null,
    convictionTo: next.conviction,
    price: STATE.data?.price?.last ?? null
  };
  STATE.biasHistory.unshift(entry);
  STATE.biasHistory = STATE.biasHistory.slice(0, CONFIG.HISTORY_MAX);
  persistBiasHistory();
  flashBiasChange(entry);
}
function flashBiasChange(entry) {
  const el = document.getElementById('bias-change-flash');
  if (!el) return;
  el.textContent = entry.from
    ? `BIAIS MODIFIÉ · ${entry.from} → ${entry.to}`
    : `BIAIS INITIAL · ${entry.to}`;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 8000);
}

/* --------------------------------------------------------------------------
   11. RENDU
   -------------------------------------------------------------------------- */
function quoteAgeMs() {
  return STATE.priceQuoteTimeMs != null ? Date.now() - STATE.priceQuoteTimeMs : null;
}
function isQuoteStale() {
  const age = quoteAgeMs();
  return STATE.priceSource === 'LIVE' && age != null && age > CONFIG.QUOTE_STALE_MS;
}

function renderHeader() {
  const { price, meta } = STATE.data;

  // Tick directionnel : flash bref sur variation de prix
  const priceEl = document.getElementById('hdr-price');
  if (priceEl) {
    const newTxt = fmt(price.last);
    if (priceEl.textContent !== newTxt) {
      const up = STATE.prevPrice != null && price.last > STATE.prevPrice;
      const down = STATE.prevPrice != null && price.last < STATE.prevPrice;
      priceEl.textContent = newTxt;
      priceEl.classList.remove('tick-up', 'tick-down');
      if (up || down) {
        void priceEl.offsetWidth; // relance l'animation
        priceEl.classList.add(up ? 'tick-up' : 'tick-down');
      }
    }
    STATE.prevPrice = price.last;
  }

  setText('hdr-change', `${signPrefix(price.change_pct)}${fmt(price.change_pct)}% (${signPrefix(price.change_abs)}${fmt(price.change_abs)})`);
  setClass('hdr-change', 'hdr-change ' + signCls(price.change_pct));
  setText('hdr-spread', fmt(price.spread));

  // Statut : DÉGRADÉ > RETARD (cotation périmée malgré un fetch réussi) > LIVE > DÉMO
  let statusLabel, statusCls;
  if (STATE.liveStatus === 'DEGRADE') { statusLabel = 'DÉGRADÉ'; statusCls = 'degraded'; }
  else if (isQuoteStale()) { statusLabel = 'RETARD'; statusCls = 'stale'; }
  else if (STATE.priceSource === 'LIVE') { statusLabel = 'LIVE'; statusCls = 'ok'; }
  else { statusLabel = 'DÉMO'; statusCls = 'demo'; }
  if (STATE.paused) { statusLabel = 'PAUSE'; statusCls = 'paused'; }
  setText('hdr-status', statusLabel);
  setClass('hdr-status', 'hdr-status ' + statusCls);

  setText('hdr-latency', STATE.latencyMs != null ? `${STATE.latencyMs}ms` : '—');

  const regimeMap = { normal: 'NORMAL', volatile: 'VOLATIL', stress: 'STRESS', crisis: 'CRISE' };
  setText('hdr-regime', regimeMap[meta.market_status] ?? String(meta.market_status).toUpperCase());
  setClass('hdr-regime', 'hdr-regime regime-' + meta.market_status);

  document.body.classList.toggle('crisis-mode', meta.market_status === 'crisis' || (STATE.risk && STATE.risk.score >= 80));
}

/* Horloge + âge de la donnée : mis à jour chaque seconde, indépendamment
   du cycle réseau, pour que l'obsolescence soit toujours visible.
   ÂGE reflète l'horodatage RÉEL de la cotation (Yahoo regularMarketTime)
   quand il est disponible — jamais seulement la vitesse de notre fetch. */
function renderClockAndFreshness() {
  const now = new Date().toISOString();
  setText('hdr-utc', hhmmss(now, 'UTC'));
  setText('hdr-local', hhmmss(now));

  const qAge = quoteAgeMs();
  const fetchAge = STATE.lastPriceAt != null ? Date.now() - STATE.lastPriceAt
                 : STATE.lastDataAt != null ? Date.now() - STATE.lastDataAt : null;
  const ageMs = qAge != null ? qAge : fetchAge;

  let ageTxt = '—', ageCls = 'hdr-age';
  if (ageMs != null) {
    const s = Math.round(ageMs / 1000);
    ageTxt = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
    if (ageMs > CONFIG.STALE_CRIT_MS) ageCls += ' stale-crit';
    else if (ageMs > CONFIG.STALE_WARN_MS) ageCls += ' stale-warn';
  }
  setText('hdr-age', ageTxt);
  setClass('hdr-age', ageCls);

  const dot = document.getElementById('live-dot');
  if (dot) {
    const cls = 'live-dot' +
      (STATE.paused ? ' paused' : '') +
      (STATE.liveStatus === 'DEGRADE' || STATE.consecutiveFailures > 0 || isQuoteStale() ? ' failing' : '');
    if (dot.className !== cls) dot.className = cls;
  }

  setText('bias-updated', timeAgo(STATE.data?.meta?.generated_at));
}

function renderBiasBanner() {
  const b = STATE.bias;
  setText('bias-label', b.biasLabel);
  setClass('bias-label', 'bias-label ' + (b.net >= 0 ? 'bull' : 'bear'));
  setText('bias-conviction-value', b.conviction);
  setText('bias-direction', b.direction);
  setText('bias-invalidation', fmt(b.invalidation));
  setText('bias-invalidation-pct', `dist. ${fmt(b.invalidationPct)}%`);
  setText('bias-alt', b.altHypothesis);
  setText('bias-agreement', `${b.agreement}% des facteurs alignés`);

  setHTMLIfChanged('prob-bar', `${b.pHausse}|${b.pNeutre}|${b.pBaisse}`, () => `
    <div class="prob-seg prob-up" style="flex:${Math.max(b.pHausse, 2)}"><span>${b.pHausse}%</span></div>
    <div class="prob-seg prob-neutral" style="flex:${Math.max(b.pNeutre, 2)}"><span>${b.pNeutre}%</span></div>
    <div class="prob-seg prob-down" style="flex:${Math.max(b.pBaisse, 2)}"><span>${b.pBaisse}%</span></div>`);
  setHTMLIfChanged('prob-labels', `L${b.pHausse}|${b.pNeutre}|${b.pBaisse}`, () =>
    `<span class="lbl-up">P(HAUSSE) ${b.pHausse}%</span><span class="lbl-neutral">P(NEUTRE) ${b.pNeutre}%</span><span class="lbl-down">P(BAISSE) ${b.pBaisse}%</span>`);
}

const CATALYST_MAP = [
  { key: 'dxy', label: 'DOLLAR', factor: 'Dollar (DXY)', desc: m => `${m.dxy?.value ?? '—'} (${signPrefix(m.dxy?.change_pct)}${fmt(m.dxy?.change_pct)}%)` },
  { key: 'real_yields_10y', label: 'RENDEMENTS RÉELS', factor: 'Rendements réels', desc: m => `${m.real_yields_10y?.value ?? '—'}% (${m.real_yields_10y?.change_bps ?? 0}bps)` },
  { key: 'etf_flows_gold', label: 'FLUX ETF', factor: 'Flux ETF', desc: m => `${m.etf_flows_gold?.value ?? '—'}M$ · ${m.etf_flows_gold?.trend ?? '—'}` },
  { key: 'comex_registered', label: 'DEMANDE PHYSIQUE', factor: 'Demande physique', desc: m => `COMEX ${m.comex_registered?.value ?? '—'}M oz` },
  { key: 'cot_spec_net_long', label: 'BANQUES CENTRALES / POSITIONNEMENT', factor: 'Positionnement (COT)', desc: m => `COT ${m.cot_spec_net_long?.value?.toLocaleString('fr-FR') ?? '—'}` },
  { key: 'geo', label: 'RISQUE GÉOPOLITIQUE', factor: null, desc: () => `Score ${STATE.risk.score}/100 · ${STATE.risk.level}` },
  { key: 'vix', label: 'VOLATILITÉ', factor: 'Volatilité (VIX)', desc: m => `VIX ${m.vix?.value ?? '—'} (${signPrefix(m.vix?.change_pct)}${fmt(m.vix?.change_pct)}%)` },
  { key: 'cot2', label: 'POSITIONNEMENT SPÉCULATIF', factor: 'Positionnement (COT)', desc: m => m.cot_spec_net_long?.change_wow_pct != null ? `${signPrefix(m.cot_spec_net_long.change_wow_pct)}${fmt(m.cot_spec_net_long.change_wow_pct)}% WoW` : '—' }
];

function renderCatalystMatrix() {
  const m = STATE.data.macro;
  const sig = STATE.bias.factors.map(f => f.score.toFixed(3)).join(',') + '|' + STATE.risk.score;
  setHTMLIfChanged('catalyst-grid', sig, () => CATALYST_MAP.map(c => {
    const factor = c.factor
      ? (STATE.bias.factors.find(f => f.name === c.factor) || { score: 0 })
      : { score: (STATE.risk.score / 100) * (STATE.risk.escalating >= STATE.risk.deescalating ? 1 : 0.3) };
    const dirCls = factor.score > 0.05 ? 'bull' : factor.score < -0.05 ? 'bear' : 'flat';
    const dirTxt = factor.score > 0.05 ? 'HAUSSIER' : factor.score < -0.05 ? 'BAISSIER' : 'NEUTRE';
    const intensity = Math.min(100, Math.round(Math.abs(factor.score) * 100));
    return `
      <div class="catalyst-card">
        <div class="catalyst-top">
          <span class="catalyst-label">${c.label}</span>
          <span class="catalyst-dir ${dirCls}">${dirTxt}</span>
        </div>
        <div class="catalyst-value">${c.desc(m)}</div>
        <div class="catalyst-bar"><div class="catalyst-bar-fill ${dirCls}" style="width:${intensity}%"></div></div>
        <div class="catalyst-conf">Intensité ${intensity}/100</div>
      </div>`;
  }).join(''));
}

function renderNewsFeed(containerId, limit) {
  const items = limit ? STATE.newsGraded.slice(0, limit) : STATE.newsGraded;
  const sig = items.map(n => n.id + ':' + n.score).join(',');
  setHTMLIfChanged(containerId, sig, () => items.map(n => `
    <div class="news-item ${n.cls}">
      <div class="news-top">
        <span class="news-tier ${n.cls}">${n.tier}</span>
        <span class="news-score">${n.score}</span>
      </div>
      <div class="news-title">${n.title}</div>
      <div class="news-meta">
        <span>${n.source}</span><span>·</span><span>${timeAgo(n.timestamp)}</span><span>·</span>
        <span class="news-dir ${n.direction}">${directionLabel(n.direction)}</span>
      </div>
      <div class="news-sens">Vol ${n.impact_vol} · Fiab ${n.reliability} · Surprise ${n.surprise_prob} · Durée ${n.duration}</div>
    </div>`).join(''));
}

function renderScenarios(containerId, keys) {
  const list = keys ? STATE.scenarios.filter(s => keys.includes(s.key)) : STATE.scenarios;
  const sig = list.map(s => s.key + ':' + s.confidence + ':' + s.invalidation).join(',');
  setHTMLIfChanged(containerId, sig, () => list.map(s => `
    <div class="scenario-card">
      <div class="scenario-top">
        <span class="scenario-horizon">${s.label}</span>
        <span class="scenario-conf">CONF. ${s.confidence}%</span>
      </div>
      <div class="scenario-row"><span class="scenario-tag dominant">DOMINANT</span><p>${s.dominant}</p></div>
      <div class="scenario-row"><span class="scenario-tag alternative">ALTERNATIF</span><p>${s.alternative}</p></div>
      <div class="scenario-row"><span class="scenario-tag rupture">RUPTURE</span><p>${s.rupture}</p></div>
      <div class="scenario-foot">
        <span>Déclencheur : ${s.trigger}</span><span>Invalidation : ${fmt(s.invalidation)}</span>
      </div>
    </div>`).join(''));
}

function renderGeopolitics() {
  setText('risk-score-value', STATE.risk.score);
  setText('risk-score-level', STATE.risk.level);
  setClass('risk-score-level', 'risk-level risk-' + STATE.risk.level.toLowerCase().replace('é', 'e'));
  setText('risk-escalating', STATE.risk.escalating);
  setText('risk-stable', STATE.risk.stable);
  setText('risk-deescalating', STATE.risk.deescalating);

  const geoSig = STATE.data.geopolitics.map(g => g.id + ':' + g.severity + ':' + g.trend).join(',');
  setHTMLIfChanged('geo-zones', geoSig, () => STATE.data.geopolitics.map(g => `
    <div class="geo-card trend-${g.trend}">
      <div class="geo-top"><span class="geo-zone">${g.zone}</span><span class="geo-severity">${g.severity}/100</span></div>
      <div class="geo-type">${g.type.replace(/_/g, ' ')} · <span class="geo-trend">${g.trend}</span></div>
      <div class="geo-desc">${g.desc_short}</div>
      <div class="geo-updated">${timeAgo(g.last_update)}</div>
    </div>`).join(''));

  const h = STATE.haven;
  const havenItems = [['OR', h.gold], ['ARGENT', h.silver], ['CHF', h.chf], ['JPY', h.jpy],
                       ['TREASURIES', h.treasury], ['CASH', h.cash], ['RISK-OFF', h.riskOff], ['RISK-ON', h.riskOn]];
  setHTMLIfChanged('haven-grid', havenItems.map(i => i[1]).join(','), () => havenItems.map(([label, val]) => `
    <div class="haven-cell">
      <div class="haven-label">${label}</div>
      <div class="haven-bar"><div class="haven-bar-fill" style="width:${val}%"></div></div>
      <div class="haven-value">${val}</div>
    </div>`).join(''));
}

function renderCalendar() {
  const now = new Date(STATE.data.meta.generated_at);
  const sig = STATE.data.calendar.map(c => c.time + ':' + (c.actual ?? '')).join(',');
  setHTMLIfChanged('calendar-list', sig, () => STATE.data.calendar.map(c => {
    const t = new Date(c.time);
    return `
      <div class="cal-item imp-${c.importance} ${t < now ? 'past' : ''}">
        <div class="cal-time">${hhmm(c.time, 'UTC')} UTC · ${t.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}</div>
        <div class="cal-event">${c.event}</div>
        <div class="cal-imp">${c.importance.toUpperCase()}</div>
        <div class="cal-figures">
          ${c.forecast ? `<span>Prév. ${c.forecast}</span>` : ''}
          ${c.previous ? `<span>Préc. ${c.previous}</span>` : ''}
          ${c.actual ? `<span class="cal-actual">Actu. ${c.actual}</span>` : ''}
        </div>
      </div>`;
  }).join(''));
}

function renderMacroTab() {
  const values = Object.values(STATE.data.macro);
  const sig = values.map(i => `${i.label}:${i.value}:${i.live ? 1 : 0}`).join(',');
  setText('macro-live-count', `${STATE.macroLive}/${STATE.macroTotal} live`);
  setHTMLIfChanged('macro-list', sig, () => values.map(item => `
    <div class="macro-row">
      <span class="macro-name">${item.live ? '<i class="macro-live-dot"></i>' : '<i class="macro-static-dot"></i>'}${item.label}</span>
      <span class="macro-val">${typeof item.value === 'number' ? fmt(item.value, item.value > 1000 ? 0 : 2) : item.value}${item.unit ?? ''}</span>
      ${item.change_pct != null
        ? `<span class="macro-chg ${signCls(item.change_pct)}">${signPrefix(item.change_pct)}${fmt(item.change_pct)}%</span>`
        : item.change_bps != null
          ? `<span class="macro-chg ${signCls(item.change_bps)}">${signPrefix(item.change_bps)}${item.change_bps}bp</span>`
          : '<span class="macro-chg flat">—</span>'}
      ${item.trend ? `<span class="macro-trend">${trendArrow(item.trend)}</span>` : ''}
    </div>`).join(''));
}

function renderBiasHistory() {
  const sig = STATE.biasHistory.map(e => e.at).join(',');
  setHTMLIfChanged('bias-history', sig, () => {
    if (!STATE.biasHistory.length) return '<div class="history-empty">Aucun changement enregistré depuis l\'ouverture.</div>';
    return STATE.biasHistory.slice(0, 12).map(e => `
      <div class="history-row">
        <span class="history-time">${hhmm(e.at)}</span>
        <span class="history-transition">${e.from ? `${e.from} → ` : ''}<b>${e.to}</b></span>
        <span class="history-meta">conv. ${e.convictionTo}${e.price != null ? ' · ' + fmt(e.price) : ''}</span>
      </div>`).join('');
  });
}

/* --------------------------------------------------------------------------
   12. CYCLE DE CALCUL + RENDU
   -------------------------------------------------------------------------- */
function recomputeAndRender() {
  const prevBias = STATE.bias;

  STATE.risk = computeGlobalRiskScore(STATE.data.geopolitics);
  STATE.haven = computeSafeHaven(STATE.data.macro, STATE.risk.score);
  STATE.bias = computeGoldBias(STATE.data, STATE.risk);
  STATE.newsGraded = gradeAllNews(STATE.data.news || []);
  STATE.scenarios = computeScenarios(STATE.data, STATE.bias, STATE.risk);

  // Journalisation : transition de libellé, ou saut de conviction >= 10 pts
  const changedLabel = !prevBias || prevBias.biasLabel !== STATE.bias.biasLabel;
  const jumpedConviction = prevBias && Math.abs(prevBias.conviction - STATE.bias.conviction) >= 10;
  if (changedLabel || jumpedConviction) recordBiasChange(prevBias, STATE.bias);

  renderHeader();
  renderClockAndFreshness();
  renderBiasBanner();
  renderCatalystMatrix();
  renderNewsFeed('news-feed-snapshot', 4);
  renderNewsFeed('news-feed-full', null);
  renderScenarios('scenario-cards-snapshot', ['session', '24h']);
  renderScenarios('scenario-cards-full', null);
  renderGeopolitics();
  renderCalendar();
  renderMacroTab();
  renderBiasHistory();
}

/* --------------------------------------------------------------------------
   13. BOUCLE LIVE
   Cadence adaptative (régime de marché) + backoff exponentiel sur échec.
   setTimeout chaîné plutôt que setInterval : évite tout chevauchement
   d'appels si le réseau est lent.
   -------------------------------------------------------------------------- */
function currentPriceInterval() {
  const regime = STATE.data?.meta?.market_status ?? 'normal';
  const base = CONFIG.PRICE_INTERVAL[regime] ?? CONFIG.PRICE_INTERVAL.normal;
  if (STATE.consecutiveFailures === 0) return base;
  const backoff = base * Math.pow(CONFIG.BACKOFF_FACTOR, STATE.consecutiveFailures);
  return Math.min(backoff, CONFIG.BACKOFF_MAX_MS);
}

async function priceCycle() {
  if (!STATE.paused) {
    const live = await fetchLiveGoldPrice();
    if (live) {
      applyLivePrice(STATE.data, live);
      STATE.priceSource = 'LIVE';
      STATE.consecutiveFailures = 0;
    } else {
      STATE.consecutiveFailures++;
      if (STATE.priceSource !== 'LIVE') STATE.priceSource = 'STATIC';
    }
    recomputeAndRender();
  }
  STATE.timerPrice = setTimeout(priceCycle, currentPriceInterval());
}

async function macroCycle() {
  if (!STATE.paused) {
    const snapshot = await fetchMacroSnapshot();
    if (Object.keys(snapshot).length) {
      applyMacroSnapshot(STATE.data, snapshot);
      recomputeAndRender();
    }
  }
  STATE.timerMacro = setTimeout(macroCycle, CONFIG.MACRO_INTERVAL);
}

async function dataCycle() {
  if (!STATE.paused) {
    const fresh = await loadData();
    if (fresh) {
      // Prix et macro live déjà obtenus priment sur le contenu statique.
      const livePrice = STATE.priceSource === 'LIVE' ? STATE.data.price : null;
      const liveMacro = {};
      Object.entries(STATE.data.macro || {}).forEach(([k, v]) => { if (v && v.live) liveMacro[k] = v; });
      STATE.data = fresh;
      if (livePrice) STATE.data.price = livePrice;
      Object.assign(STATE.data.macro, liveMacro);
      recomputeAndRender();
    }
  }
  STATE.timerData = setTimeout(dataCycle, CONFIG.DATA_INTERVAL);
}

function startLiveLoop() {
  stopLiveLoop();
  STATE.timerPrice = setTimeout(priceCycle, currentPriceInterval());
  STATE.timerMacro = setTimeout(macroCycle, CONFIG.MACRO_INTERVAL);
  STATE.timerData = setTimeout(dataCycle, CONFIG.DATA_INTERVAL);
  STATE.timerClock = setInterval(renderClockAndFreshness, 1000);
}
function stopLiveLoop() {
  clearTimeout(STATE.timerPrice); clearTimeout(STATE.timerMacro);
  clearTimeout(STATE.timerData); clearInterval(STATE.timerClock);
  STATE.timerPrice = STATE.timerMacro = STATE.timerData = STATE.timerClock = null;
}

/* Rafraîchissement immédiat, hors cadence (retour d'arrière-plan, tap manuel) */
async function forceRefresh() {
  const [live, snapshot] = await Promise.all([fetchLiveGoldPrice(), fetchMacroSnapshot()]);
  if (live) { applyLivePrice(STATE.data, live); STATE.priceSource = 'LIVE'; STATE.consecutiveFailures = 0; }
  else STATE.consecutiveFailures++;
  if (Object.keys(snapshot).length) applyMacroSnapshot(STATE.data, snapshot);
  recomputeAndRender();
}

/* --------------------------------------------------------------------------
   14. NAVIGATION + ÉVÉNEMENTS SYSTÈME
   -------------------------------------------------------------------------- */
function switchTab(tab) {
  STATE.activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch { /* environnement sans scroll */ }
}

function bindEvents() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Tap sur le bloc statut = rafraîchissement manuel immédiat
  const statusBlock = document.getElementById('hdr-status-block');
  if (statusBlock) statusBlock.addEventListener('click', forceRefresh);

  // Onglet en arrière-plan : on suspend le réseau, on reprend au retour.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      STATE.paused = true;
      renderHeader();
    } else {
      STATE.paused = false;
      renderHeader();
      forceRefresh();
    }
  });

  window.addEventListener('online', () => { STATE.consecutiveFailures = 0; forceRefresh(); });
  window.addEventListener('offline', () => { STATE.consecutiveFailures++; renderHeader(); });
}

/* --------------------------------------------------------------------------
   15. INIT
   -------------------------------------------------------------------------- */
async function init() {
  loadBiasHistory();
  STATE.data = await loadData();

  STATE.macroTotal = MACRO_TICKERS.length;

  // Prix et macro récupérés en parallèle : un seul aller-retour perçu.
  const [live, snapshot] = await Promise.all([fetchLiveGoldPrice(), fetchMacroSnapshot()]);
  if (live) { applyLivePrice(STATE.data, live); STATE.priceSource = 'LIVE'; }
  else { STATE.priceSource = 'STATIC'; STATE.lastDataAt = STATE.lastDataAt ?? Date.now(); }
  if (Object.keys(snapshot).length) applyMacroSnapshot(STATE.data, snapshot);

  recomputeAndRender();
  bindEvents();
  startLiveLoop();

  document.getElementById('app-loading')?.remove();
  document.getElementById('app')?.classList.add('ready');
}

document.addEventListener('DOMContentLoaded', init);
