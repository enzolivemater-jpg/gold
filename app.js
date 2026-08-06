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
  // Plancher à 30 s : c'est le TTL de cache de XAUS et la limite d'usage
  // loyal qu'il documente. Interroger plus vite ne donnerait pas de donnée
  // plus fraîche, seulement des requêtes inutiles.
  PRICE_INTERVAL: { normal: 60000, volatile: 45000, stress: 30000, crisis: 30000 },
  // Référence journalière (clôture veille / plus haut / plus bas) : XAUS met
  // cet endpoint en cache 6 h, inutile d'y revenir plus souvent.
  DAILY_REF_INTERVAL: 6 * 3600 * 1000,
  // Cadence de rechargement du fichier de données complet (news/géo/calendrier).
  DATA_INTERVAL: 60000,
  // Cadence du bloc macro live (15 tickers Yahoo en parallèle). Plus lent que
  // le prix : ces séries bougent moins vite et coûtent 15 appels par cycle.
  MACRO_INTERVAL: 45000,
  // News live : GDELT réindexe toutes les 15 min ; 3 min suffit largement
  // pour ne rien manquer sans marteler une API publique gratuite.
  NEWS_INTERVAL: 180000,
  // En deçà, une variation est considérée comme du bruit et non un signal.
  MACRO_NOISE_PCT: 0.05,
  // Seuils d'obsolescence de la donnée affichée.
  STALE_WARN_MS: 45000,
  STALE_CRIT_MS: 120000,
  // Au-delà, une cotation Yahoo est considérée périmée MÊME SI l'appel réseau
  // a réussi rapidement — c'est l'horodatage de la cotation qui compte, pas
  // la vitesse à laquelle Yahoo nous a répondu.
  QUOTE_STALE_MS: 90000,
  // Cadence plancher quand XAUS est la source active : leur cache est de 30 s
  // et leur charte demande >= 30 s côté client. Interroger plus vite ne
  // rapporterait aucune donnée nouvelle.
  XAUS_MIN_INTERVAL: 30000,
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
  priceKind: null,           // spot | futures — un repli futures doit être visible
  providerStatus: null,      // fresh | stale | unavailable, déclaré par XAUS
  dailyRef: null,            // { prev_close, day_high, day_low, fetched_at }
  spotSilver: null,          // spot XAG issu de XAUS, prioritaire sur SI=F
  lastDataAt: null,          // timestamp du dernier data.json chargé
  lastMacroAt: null,         // timestamp du dernier bloc macro live
  macroLive: 0,              // nb de tickers macro récupérés au dernier cycle
  macroTotal: 0,             // nb de tickers macro suivis (rempli à l'init)
  lastNewsAt: null,          // dernier cycle news réussi
  newsSeen: [],              // clés déjà vues (dédoublonnage + détection nouveautés)
  newsNewSinceOpen: 0,       // compteur de nouveautés depuis l'ouverture
  newsInitialised: false,    // le 1er lot ne compte pas comme "nouveau"
  newsLiveCount: 0,
  newsSourcesOk: 0,
  calendarGenerated: 0,
  calendarManual: 0,
  latencyMs: null,           // latence réelle mesurée du dernier appel prix
  prevPrice: null,           // pour détecter le sens du tick
  consecutiveFailures: 0,
  paused: false,             // onglet en arrière-plan
  timerPrice: null, timerData: null, timerClock: null, timerMacro: null, timerNews: null,
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

/* --- Prix live : XAUS en source primaire, Yahoo en repli -------------------

   Pourquoi ce changement : Yahoo ne publie aucune garantie de fraîcheur sur
   XAUUSD=X et sert régulièrement une cotation figée avec un HTTP 200 rapide,
   ce qui est indétectable sans inspecter regularMarketTime — et même là, le
   symbole peut rester bloqué des dizaines de minutes.

   XAUS (xaus.com/api/v1/spot) est un endpoint dédié au spot or :
   - aucune clé API, CORS totalement ouvert
   - un objet data_state { status: fresh|stale|unavailable, as_of, age_seconds }
     où LE FOURNISSEUR déclare lui-même la fraîcheur
   - il ne fabrique jamais de prix : en cas de panne amont il renvoie soit
     stale:true avec l'horodatage réel, soit un 503 honnête
   - il fournit aussi le spot argent, plus fidèle que le future SI=F

   Usage loyal (documenté par XAUS) : cache >= 30 s côté client, < 10 000
   requêtes/jour. Nos cadences respectent ces deux contraintes.
   -------------------------------------------------------------------------- */
const XAUS_SPOT_URL = 'https://xaus.com/api/v1/spot?compact=1';
const XAUS_HISTORY_URL = 'https://xaus.com/api/v1/history';

function yahooPriceUrl(sym) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
         encodeURIComponent(sym) + '?interval=1m&range=1d';
}

/* Repères journaliers (clôture veille, plus haut/bas du jour).
   /spot ne les fournit pas ; /history est mis en cache 6 h côté XAUS,
   on le rafraîchit donc à la même cadence. */
async function fetchDailyReference() {
  try {
    const res = await fetchWithTimeout(XAUS_HISTORY_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const pts = Array.isArray(json?.points) ? json.points : [];
    if (!pts.length) throw new Error('Historique vide');
    const today = new Date().toISOString().slice(0, 10);
    // Clôture de référence = dernier point antérieur à aujourd'hui
    let prevClose = null;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].d < today && typeof pts[i].c === 'number') { prevClose = pts[i].c; break; }
    }
    if (prevClose == null && typeof pts[pts.length - 1].c === 'number') {
      prevClose = pts[pts.length - 1].c;
    }
    const dayRange = json?.ranges?.day;
    return {
      prev_close: prevClose,
      day_high: typeof dayRange?.high === 'number' ? dayRange.high : null,
      day_low: typeof dayRange?.low === 'number' ? dayRange.low : null,
      fetched_at: Date.now()
    };
  } catch (err) {
    console.warn('[GoldCompass] Référence journalière indisponible:', err.message);
    return null;
  }
}

/* Lecture XAUS. `bust` ajoute un paramètre unique pour traverser tout cache
   intermédiaire — la parade documentée par XAUS quand la fraîcheur prime. */
async function fetchXausSpot(bust) {
  const url = XAUS_SPOT_URL + (bust ? '&fresh=' + Date.now() : '');
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const last = json?.spot_usd_oz;
  if (typeof last !== 'number') throw new Error('Réponse XAUS invalide');
  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const ds = json.data_state || {};
  // Horodatage réel de la cotation, dans l'ordre de fiabilité décroissante.
  const asOf = json.price_as_of || ds.as_of || json.updated_at || null;
  const asOfMs = asOf ? Date.parse(asOf) : null;
  // age_seconds du fournisseur fait autorité ; sinon on calcule.
  const providerAgeMs = typeof ds.age_seconds === 'number' ? ds.age_seconds * 1000 : null;
  const ageMs = providerAgeMs != null ? providerAgeMs
              : (asOfMs != null && !Number.isNaN(asOfMs) ? Date.now() - asOfMs : null);

  return {
    last,
    silver: typeof json.silver_usd_oz === 'number' ? json.silver_usd_oz : null,
    quote_time_ms: asOfMs != null && !Number.isNaN(asOfMs) ? asOfMs : null,
    quote_age_ms: ageMs,
    provider_status: ds.status || (json.stale === true ? 'stale' : 'fresh'),
    latency_ms: Math.round(t1 - t0),
    fetched_at: new Date().toISOString(),
    source: 'XAUS',
    kind: 'spot'
  };
}

/* Repli Yahoo : conservé tel quel, mais désormais en seconde ligne.
   meta.regularMarketPrice peut être figé alors que la série intraday avance :
   on retient le plus récent des deux. */
function parseYahooPrice(json) {
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;

  let last = meta.regularMarketPrice;
  let timeMs = typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null;

  const stamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (Array.isArray(stamps) && Array.isArray(closes)) {
    for (let i = closes.length - 1; i >= 0; i--) {
      if (typeof closes[i] === 'number' && typeof stamps[i] === 'number') {
        const seriesMs = stamps[i] * 1000;
        if (timeMs == null || seriesMs > timeMs) { last = closes[i]; timeMs = seriesMs; }
        break;
      }
    }
  }
  return {
    last,
    prev_close: meta.chartPreviousClose ?? meta.previousClose ?? last,
    day_high: meta.regularMarketDayHigh ?? last,
    day_low: meta.regularMarketDayLow ?? last,
    quote_time_ms: timeMs
  };
}

const YAHOO_FALLBACKS = [
  { url: yahooPriceUrl('XAUUSD=X'), label: 'XAUUSD', kind: 'spot' },
  { url: 'https://corsproxy.io/?url=' + encodeURIComponent(yahooPriceUrl('XAUUSD=X')), label: 'XAUUSD~', kind: 'spot' },
  { url: yahooPriceUrl('GC=F'),     label: 'GC=F',   kind: 'futures' },
  { url: 'https://corsproxy.io/?url=' + encodeURIComponent(yahooPriceUrl('GC=F')), label: 'GC=F~', kind: 'futures' }
];

async function fetchLiveGoldPrice() {
  let bestStale = null;
  const keepIfStale = c => {
    if (!bestStale || (c.quote_age_ms ?? Infinity) < (bestStale.quote_age_ms ?? Infinity)) bestStale = c;
  };

  // --- 1. XAUS, source primaire. Une première lecture peut venir du CDN
  //        (TTL 30 s) ; si elle est périmée on retente en cache-busting avant
  //        de renoncer, comme recommandé par le fournisseur.
  for (const bust of [false, true]) {
    try {
      const q = await fetchXausSpot(bust);
      if (q.provider_status === 'unavailable') throw new Error('XAUS: donnée indisponible');
      const stale = q.provider_status === 'stale' ||
                    (q.quote_age_ms != null && q.quote_age_ms > CONFIG.QUOTE_STALE_MS);
      if (!stale) return q;
      console.warn('[GoldCompass] XAUS périmé (' +
                   (q.quote_age_ms != null ? Math.round(q.quote_age_ms / 1000) + 's' : 'état ' + q.provider_status) +
                   ')' + (bust ? ' même en cache-bust — repli Yahoo' : ' — nouvelle tentative sans cache'));
      keepIfStale(q);
    } catch (err) {
      console.warn('[GoldCompass] XAUS indisponible:', err.message);
      break; // inutile de retenter en cache-bust si l'appel a échoué
    }
  }

  // --- 2. Repli Yahoo, avec la même règle : périmé = échec, on continue.
  for (const src of YAHOO_FALLBACKS) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      const res = await fetchWithTimeout(src.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const parsed = parseYahooPrice(await res.json());
      if (!parsed) throw new Error('Réponse Yahoo invalide');
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const ageMs = parsed.quote_time_ms != null ? Date.now() - parsed.quote_time_ms : null;
      const candidate = {
        ...parsed,
        latency_ms: Math.round(t1 - t0),
        fetched_at: new Date().toISOString(),
        quote_age_ms: ageMs,
        provider_status: null,
        source: src.label,
        kind: src.kind
      };
      if (ageMs == null || ageMs <= CONFIG.QUOTE_STALE_MS) return candidate;
      console.warn('[GoldCompass] Cotation périmée sur ' + src.label +
                   ' (' + Math.round(ageMs / 1000) + 's) — bascule source suivante');
      keepIfStale(candidate);
    } catch (err) {
      console.warn('[GoldCompass] Source prix indisponible (' + src.label + '):', err.message);
    }
  }

  // Tout est périmé : on rend la moins vieille, RETARD s'affichera.
  return bestStale;
}

function applyLivePrice(data, live) {
  // XAUS /spot ne fournit pas la clôture veille : on la prend de la référence
  // journalière (/history), avec repli sur celle du fournisseur si présente.
  const ref = STATE.dailyRef || {};
  const prevClose = live.prev_close ?? ref.prev_close ?? data.price?.prev_close ?? live.last;
  const changeAbs = +(live.last - prevClose).toFixed(2);
  const changePct = prevClose ? +((changeAbs / prevClose) * 100).toFixed(2) : 0;
  const high = live.day_high ?? ref.day_high ?? live.last;
  const low  = live.day_low  ?? ref.day_low  ?? live.last;
  data.price = {
    ...data.price,
    symbol: 'XAUUSD',
    last: +live.last.toFixed(2),
    prev_close: +prevClose.toFixed(2),
    change_abs: changeAbs,
    change_pct: changePct,
    day_high: +Math.max(high, live.last).toFixed(2),
    day_low: +Math.min(low, live.last).toFixed(2)
  };
  // Le spot argent de XAUS est plus fidèle que le future SI=F : on l'injecte
  // dans le bloc macro quand il est disponible.
  if (typeof live.silver === 'number' && data.macro) {
    STATE.spotSilver = live.silver;   // mémorisé : le cycle macro doit le respecter
    const prev = data.macro.silver || {};
    const prevVal = typeof prev.value === 'number' ? prev.value : live.silver;
    const chg = prevVal ? ((live.silver - prevVal) / prevVal) * 100 : 0;
    data.macro.silver = {
      ...prev,
      label: 'Silver (spot)',
      value: +live.silver.toFixed(3),
      unit: '',
      change_pct: typeof prev.change_pct === 'number' ? prev.change_pct : +chg.toFixed(2),
      trend: prev.trend ?? 'flat',
      signal: prev.signal ?? 'neutral',
      live: true
    };
  }
  data.meta.generated_at = live.fetched_at;
  STATE.latencyMs = live.latency_ms;
  STATE.lastPriceAt = Date.now();
  STATE.priceQuoteTimeMs = live.quote_time_ms;   // horodatage réel de la cotation
  STATE.priceSourceLabel = live.source;          // quelle source a répondu
  STATE.priceKind = live.kind;                   // spot | futures
  STATE.providerStatus = live.provider_status ?? null;
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
    // Le spot argent de XAUS prime sur le future SI=F pour la VALEUR affichée ;
    // on conserve en revanche la direction (change/trend/signal) du future,
    // qui donne le sens du mouvement. Sans cette garde, l'ordre d'exécution
    // des cycles décidait arbitrairement laquelle des deux sources gagnait.
    if (cfg.key === 'silver' && typeof STATE.spotSilver === 'number') {
      entry.value = +STATE.spotSilver.toFixed(3);
      entry.label = 'Silver (spot)';
    }
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
   NEWS LIVE — GDELT DOC 2.0 (CORS ACAO *, sans clé)
   Boucle permanente : quatre requêtes thématiques en parallèle, dédoublonnage,
   notation automatique, fusion avec les news statiques de data.json.
   GDELT réindexe toutes les 15 min ; on interroge toutes les 3 min avec une
   fenêtre d'1 h pour ne rien manquer sans marteler l'API.
   -------------------------------------------------------------------------- */
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const NEWS_QUERIES = [
  { id: 'macro', q: '(gold OR bullion OR XAUUSD) (Fed OR inflation OR CPI OR "interest rate" OR dollar OR yields)' },
  { id: 'price', q: '("gold price" OR "gold prices" OR bullion) (surge OR plunge OR rises OR falls OR record OR outlook)' },
  { id: 'geo',   q: '(gold OR "safe haven") (war OR sanctions OR strike OR conflict OR escalation OR missile)' },
  { id: 'cb',    q: 'gold ("central bank" OR reserves OR PBOC OR "World Gold Council" OR bullion buying)' }
];

function gdeltUrl(query) {
  return GDELT_BASE + '?query=' + encodeURIComponent(query) +
         '&mode=artlist&format=json&maxrecords=75&timespan=1h&sort=datedesc';
}

/* GDELT date : "20260806T053000Z" -> Date */
function parseGdeltDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) { const d = Date.parse(s); return Number.isNaN(d) ? null : new Date(d); }
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/* --- Notation automatique -------------------------------------------------
   Une dépêche brute ne fournit ni impact ni fiabilité : on les dérive du
   domaine émetteur et du vocabulaire du titre, puis on réutilise le moteur
   de grading existant (NEWS SCORE) pour le classement final. */
const SOURCE_TIERS = [
  { r: 95, hosts: ['federalreserve.gov','bls.gov','ecb.europa.eu','imf.org','worldgoldcouncil.org','treasury.gov'] },
  { r: 88, hosts: ['reuters.com','bloomberg.com','wsj.com','ft.com','apnews.com','cnbc.com'] },
  { r: 76, hosts: ['marketwatch.com','investing.com','kitco.com','fxstreet.com','barrons.com','forbes.com','businessinsider.com'] },
  { r: 62, hosts: ['dailyfx.com','mining.com','economictimes.indiatimes.com','moneycontrol.com','scmp.com'] }
];
function sourceReliability(domain) {
  const d = String(domain || '').toLowerCase();
  for (const t of SOURCE_TIERS) if (t.hosts.some(h => d.endsWith(h))) return t.r;
  return 48;
}

const IMPACT_RULES = [
  { w: 90, re: /\b(fomc|rate decision|rate cut|rate hike|powell|federal reserve|dot plot)\b/i, dur: 'long' },
  { w: 86, re: /\b(cpi|inflation|core pce|pce|consumer price)\b/i, dur: 'long' },
  { w: 80, re: /\b(nonfarm|non-farm|payrolls|jobs report|unemployment rate|jobless)\b/i, dur: 'moyen' },
  { w: 76, re: /\b(war|missile|strike[sd]?|invasion|sanction|nuclear|escalation|airstrike)\b/i, dur: 'moyen' },
  { w: 68, re: /\b(central bank|gold reserves|pboc|bullion buying|reserve diversification)\b/i, dur: 'long' },
  { w: 62, re: /\b(treasury yield|real yield|bond yield|dollar index|dxy)\b/i, dur: 'moyen' },
  { w: 56, re: /\b(etf|holdings|inflow|outflow|comex|lbma|shanghai)\b/i, dur: 'moyen' },
  { w: 44, re: /\b(gold price|bullion|xau|precious metal)\b/i, dur: 'court' }
];
const VOL_RE = /\b(surge[sd]?|plunge[sd]?|soar[sd]?|crash|record high|record low|tumble[sd]?|spike[sd]?|slump[sd]?|rally|selloff)\b/i;
const SURPRISE_RE = /\b(unexpected|surprise|shock|higher than expected|lower than expected|misses|beats|breaking)\b/i;
const BULL_RE = /\b(safe haven|surge|soar|record high|rate cut|dovish|weaker dollar|escalation|war|haven demand|rally)\b/i;
const BEAR_RE = /\b(hawkish|rate hike|stronger dollar|profit.taking|plunge|tumble|risk-on|selloff|outflow)\b/i;

function autoGradeArticle(a) {
  const title = a.title || '';
  let impact = 40, duration = 'court';
  for (const r of IMPACT_RULES) {
    if (r.re.test(title)) { impact = r.w; duration = r.dur; break; }
  }
  const reliability = sourceReliability(a.domain);
  const vol = VOL_RE.test(title) ? 72 : Math.max(20, impact - 25);
  const surprise = SURPRISE_RE.test(title) ? 70 : 30;
  const bull = BULL_RE.test(title), bear = BEAR_RE.test(title);
  const direction = bull && bear ? 'mixed' : bull ? 'bullish' : bear ? 'bearish' : 'undefined';
  return {
    impact_macro: impact, impact_vol: vol, reliability, surprise_prob: surprise,
    duration, direction
  };
}

/* Clé de dédoublonnage : titre normalisé (les agrégateurs republient le même
   titre sous des URL différentes). */
function newsKey(title, url) {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 70) : String(url || '');
}

async function fetchGdeltBatch() {
  const settled = await Promise.allSettled(NEWS_QUERIES.map(async q => {
    const res = await fetchWithTimeout(gdeltUrl(q.q), 8000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = (await res.text()).replace(/^\uFEFF/, '');   // GDELT peut préfixer un BOM
    if (!txt.trim().startsWith('{')) throw new Error('Réponse non JSON');
    const json = JSON.parse(txt);
    return { id: q.id, articles: Array.isArray(json.articles) ? json.articles : [] };
  }));

  const out = [];
  let okCount = 0;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') { okCount++; out.push(...r.value.articles); }
    else console.warn('[GoldCompass] Requête news échouée (' + NEWS_QUERIES[i].id + '):', r.reason?.message);
  });
  return { articles: out, okCount, total: NEWS_QUERIES.length };
}

/* Fusion : les news live rejoignent les news statiques, dédoublonnées,
   notées, triées par impact réel. On conserve la trace de ce qui est arrivé
   depuis l'ouverture de l'application. */
function mergeLiveNews(articles) {
  const seen = new Set(STATE.newsSeen);
  let fresh = 0;
  const mapped = [];

  for (const a of articles) {
    const key = newsKey(a.title, a.url);
    if (!key || mapped.some(m => m._key === key)) continue;
    const d = parseGdeltDate(a.seendate);
    const graded = autoGradeArticle(a);
    mapped.push({
      _key: key,
      id: 'gdelt:' + key,
      title: a.title,
      source: a.domain || 'source inconnue',
      url: a.url,
      timestamp: d ? d.toISOString() : new Date().toISOString(),
      live: true,
      ...graded,
      sensitivities: {}
    });
    if (!seen.has(key)) { seen.add(key); fresh++; }
  }

  STATE.newsSeen = Array.from(seen).slice(-400);
  STATE.newsLiveCount = mapped.length;
  STATE.newsNewSinceOpen += STATE.newsInitialised ? fresh : 0;
  STATE.newsInitialised = true;
  STATE.lastNewsAt = Date.now();

  const staticNews = (STATE.data.news || []).filter(n => !n.live);
  const combined = [...mapped, ...staticNews];

  // Dédoublonnage final statique/live
  const uniq = [];
  const keys = new Set();
  for (const n of combined) {
    const k = n._key || newsKey(n.title, n.url);
    if (keys.has(k)) continue;
    keys.add(k);
    uniq.push(n);
  }
  STATE.data.news = uniq.slice(0, 80);
}

/* --------------------------------------------------------------------------
   CALENDRIER PLANIFIÉ — génération déterministe
   Plutôt que de saisir les dates à la main (source de l'erreur qui plaçait le
   NFP un samedi), on les dérive des règles de publication officielles. Le
   calendrier se met donc à jour tout seul, mois après mois.

   Règles certaines (calculables) : NFP = 1er vendredi, Claims = chaque jeudi,
   ISM = 1er et 3e jour ouvré, U. Michigan = 2e et dernier vendredi.
   Règles approchées : CPI/PPI/Retail Sales tombent dans une fenêtre connue
   mais à date variable — elles sont marquées "estimée" et jamais présentées
   comme certaines. Les dates FOMC 2026 sont publiées un an à l'avance.
   -------------------------------------------------------------------------- */
const FOMC_2026 = [   // dates officielles publiées par la Fed (décision J2, 18:00 UTC)
  '2026-01-28','2026-03-18','2026-04-29','2026-06-17',
  '2026-07-29','2026-09-16','2026-11-04','2026-12-16'
];

function utcAt(y, m, d, h, min) { return new Date(Date.UTC(y, m, d, h, min, 0)); }
function isWeekend(dt) { const g = dt.getUTCDay(); return g === 0 || g === 6; }

/* n-ième jour de semaine du mois (weekday 0=dim..6=sam, n commence à 1) */
function nthWeekday(y, m, weekday, n) {
  const first = new Date(Date.UTC(y, m, 1));
  let offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, m, 1 + offset + (n - 1) * 7));
}
/* n-ième jour ouvré du mois */
function nthBusinessDay(y, m, n) {
  let d = new Date(Date.UTC(y, m, 1)), count = 0;
  while (true) {
    if (!isWeekend(d)) { count++; if (count === n) return d; }
    d = new Date(d.getTime() + 86400000);
  }
}

function scheduledEventsForMonth(y, m) {
  const ev = [];
  const push = (dt, hour, min, event, impact, note, estimated) => {
    ev.push({
      time: utcAt(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), hour, min).toISOString(),
      event, gold_impact: impact, note, estimated: !!estimated,
      forecast: null, previous: null, actual: null, scheduled: true
    });
  };

  // NFP — 1er vendredi, 12:30 UTC
  push(nthWeekday(y, m, 5, 1), 12, 30, 'NFP (Non-Farm Payrolls)', 88,
       "Pilote direct de la trajectoire Fed. Le salaire horaire compte autant que le chiffre principal.");

  // Jobless Claims — chaque jeudi, 12:30 UTC
  for (let n = 1; n <= 5; n++) {
    const d = nthWeekday(y, m, 4, n);
    if (d.getUTCMonth() !== m) break;
    push(d, 12, 30, 'Initial Jobless Claims', 38,
         "Bruit hebdomadaire : n'oriente l'or qu'au-delà d'une surprise de ~20K.");
  }

  // ISM Manufacturier (1er jour ouvré) et Services (3e jour ouvré), 14:00 UTC
  push(nthBusinessDay(y, m, 1), 14, 0, 'ISM Manufacturier', 50,
       "Composante prix payés surveillée : alimente les anticipations d'inflation.");
  push(nthBusinessDay(y, m, 3), 14, 0, 'ISM Services', 52,
       "Poids dominant dans le PIB américain ; la composante emploi précède le NFP.");

  // CPI — fenêtre habituelle 10-15 du mois, jour ouvré. Date estimée.
  let cpi = new Date(Date.UTC(y, m, 12));
  while (isWeekend(cpi)) cpi = new Date(cpi.getTime() + 86400000);
  push(cpi, 12, 30, 'US CPI (IPC)', 92,
       "Événement le plus sensible pour l'or : agit simultanément sur taux réels, dollar et Fed.", true);

  // PPI — généralement le lendemain ouvré du CPI. Date estimée.
  let ppi = new Date(cpi.getTime() + 86400000);
  while (isWeekend(ppi)) ppi = new Date(ppi.getTime() + 86400000);
  push(ppi, 12, 30, 'US PPI (prix à la production)', 58,
       "Confirme ou infirme la tendance du CPI ; effet amplifié en cas de divergence.", true);

  // Sentiment U. Michigan — préliminaire 2e vendredi, définitif dernier vendredi
  push(nthWeekday(y, m, 5, 2), 14, 0, 'Sentiment U. Michigan (prél.)', 35,
       "Anticipations d'inflation à 5 ans : seule composante réellement suivie pour l'or.");

  // FOMC — dates officielles
  FOMC_2026.forEach(iso => {
    const d = new Date(iso + 'T00:00:00Z');
    if (d.getUTCFullYear() === y && d.getUTCMonth() === m) {
      push(d, 18, 0, 'Décision FOMC', 95,
           "Décision de taux + projections. Événement à plus fort impact sur l'or, toutes catégories confondues.");
    }
  });

  return ev;
}

/* Génère les événements planifiés sur une fenêtre glissante autour d'aujourd'hui. */
function generateScheduledCalendar(daysBack = 7, daysAhead = 45) {
  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 86400000);
  const to = new Date(now.getTime() + daysAhead * 86400000);
  const months = new Set();
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 15 * 86400000)) {
    months.add(d.getUTCFullYear() + ':' + d.getUTCMonth());
  }
  months.add(to.getUTCFullYear() + ':' + to.getUTCMonth());

  let all = [];
  months.forEach(k => {
    const [y, m] = k.split(':').map(Number);
    all = all.concat(scheduledEventsForMonth(y, m));
  });
  return all.filter(e => {
    const t = new Date(e.time);
    return t >= from && t <= to;
  }).sort((a, b) => new Date(a.time) - new Date(b.time));
}

/* Fusion : une entrée saisie dans data.json (avec consensus/valeur publiée)
   prime sur l'entrée générée du même événement au même jour. */
function mergeCalendar(data) {
  const manual = Array.isArray(data.calendar) ? data.calendar : [];
  const generated = generateScheduledCalendar();
  const keyOf = e => new Date(e.time).toISOString().slice(0, 10) + '|' +
                     String(e.event).toLowerCase().slice(0, 14);
  const map = new Map();
  generated.forEach(e => map.set(keyOf(e), e));
  manual.forEach(e => map.set(keyOf(e), { ...map.get(keyOf(e)), ...e }));
  data.calendar = Array.from(map.values()).sort((a, b) => new Date(a.time) - new Date(b.time));
  STATE.calendarGenerated = generated.length;
  STATE.calendarManual = manual.length;
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

  // Source du prix : un repli sur les futures (GC=F) cote structurellement
  // au-dessus du spot. Ne jamais le laisser passer en silence.
  setText('hdr-src', STATE.priceSourceLabel ?? '—');
  setClass('hdr-src', 'hdr-src' + (STATE.priceKind === 'futures' ? ' futures' : ''));

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

  // Le compte à rebours du prochain catalyseur doit s'écouler en continu,
  // indépendamment des cycles réseau.
  if (STATE.data?.calendar?.length) renderCalendar();
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
  setHTMLIfChanged(containerId, sig, () => items.map(n => {
    const title = n.url
      ? `<a href="${n.url}" target="_blank" rel="noopener noreferrer">${n.title}</a>`
      : n.title;
    return `
    <div class="news-item ${n.cls}">
      <div class="news-top">
        <span class="news-tier ${n.cls}">${n.tier}</span>
        <span class="news-right">
          ${n.live ? '<i class="news-live-dot" title="flux live"></i>' : ''}
          <span class="news-score">${n.score}</span>
        </span>
      </div>
      <div class="news-title">${title}</div>
      <div class="news-meta">
        <span>${n.source}</span><span>·</span><span>${timeAgo(n.timestamp)}</span><span>·</span>
        <span class="news-dir ${n.direction}">${directionLabel(n.direction)}</span>
      </div>
      <div class="news-sens">Vol ${n.impact_vol} · Fiab ${n.reliability} · Surprise ${n.surprise_prob} · Durée ${n.duration}</div>
    </div>`;
  }).join(''));
}

/* Compteur + alerte du fil de news */
function renderNewsStatus() {
  const live = STATE.newsGraded.filter(n => n.live).length;
  const today = STATE.newsGraded.filter(n => {
    const t = new Date(n.timestamp), now = new Date();
    return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  }).length;
  setText('news-counter',
    `${today} aujourd'hui · ${live} live` +
    (STATE.newsNewSinceOpen ? ` · +${STATE.newsNewSinceOpen} depuis l'ouverture` : ''));
  setText('news-sources', `${STATE.newsSourcesOk}/${NEWS_QUERIES.length} flux`);
  setClass('news-sources', 'section-sub ' + (STATE.newsSourcesOk === 0 ? 'feed-down' : ''));

  const top = STATE.newsGraded[0];
  const critical = top && top.level >= 4 ? top : null;
  setHTMLIfChanged('news-alert', critical ? critical.id : 'none', () => {
    if (!critical) return '';
    return `
      <div class="news-alert-box ${critical.cls}">
        <div class="news-alert-head">
          <span class="news-alert-tag">⚠ ${critical.tier}</span>
          <span class="news-alert-score">${critical.score}/100</span>
        </div>
        <div class="news-alert-title">${critical.url
          ? `<a href="${critical.url}" target="_blank" rel="noopener noreferrer">${critical.title}</a>`
          : critical.title}</div>
        <div class="news-alert-meta">${critical.source} · ${timeAgo(critical.timestamp)} · ${directionLabel(critical.direction)}</div>
      </div>`;
  });
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

/* --------------------------------------------------------------------------
   CALENDRIER — classement d'impact propre à l'or
   L'importance générique d'une publication (actions, obligations) n'est pas
   sa sensibilité pour l'or. Ce qui pilote l'or : taux réels, trajectoire Fed,
   dollar, demande refuge. On note donc gold_impact 0-100, avec repli sur
   l'ancienne échelle `importance` si le champ est absent.
   -------------------------------------------------------------------------- */
const LEGACY_IMPORTANCE = { critical: 90, high: 70, medium: 50, low: 30 };

function calendarImpact(c) {
  if (typeof c.gold_impact === 'number') return c.gold_impact;
  return LEGACY_IMPORTANCE[c.importance] ?? 50;
}
function classifyCalendarImpact(score) {
  if (score >= 80) return { tier: 'CATALYSEUR', cls: 'cal-catalyst', alert: true };
  if (score >= 60) return { tier: 'MAJEUR',     cls: 'cal-major',    alert: true };
  if (score >= 40) return { tier: 'MODÉRÉ',     cls: 'cal-moderate', alert: false };
  return              { tier: 'MINEUR',      cls: 'cal-minor',    alert: false };
}

/* Écart temporel lisible : 45 min · 6h20 · 3j 4h */
function formatDelta(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return h + 'h' + String(m).padStart(2, '0');
  const j = Math.floor(h / 24);
  return j + 'j ' + (h % 24) + 'h';
}
function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function renderCalendar() {
  // L'heure de référence est l'heure réelle, pas un horodatage de données :
  // un fichier daté d'hier ne doit pas faire passer un événement pour à venir.
  const now = new Date();
  const items = (STATE.data.calendar || []).map(c => {
    const t = new Date(c.time);
    const score = calendarImpact(c);
    return { ...c, t, score, ...classifyCalendarImpact(score), deltaMs: t - now, past: t < now };
  });

  const upcoming = items.filter(i => !i.past).sort((a, b) => a.t - b.t);
  const past = items.filter(i => i.past).sort((a, b) => b.t - a.t);
  const todayCount = items.filter(i => sameLocalDay(i.t, now)).length;
  const nextAlert = upcoming.find(i => i.alert) || null;

  // Compteur
  setText('cal-counter', `${todayCount} aujourd'hui · ${upcoming.length} à venir`);

  // Bandeau d'alerte : prochain événement à fort impact
  const alertSig = nextAlert ? nextAlert.time + ':' + Math.floor(nextAlert.deltaMs / 60000) : 'none';
  setHTMLIfChanged('cal-alert', alertSig, () => {
    if (!nextAlert) return '';
    const imminent = nextAlert.deltaMs <= 3600000;   // < 1 h
    const proche  = nextAlert.deltaMs <= 86400000;   // < 24 h
    return `
      <div class="cal-alert-box ${nextAlert.cls} ${imminent ? 'imminent' : ''}">
        <div class="cal-alert-head">
          <span class="cal-alert-tag">${imminent ? '⚠ IMMINENT' : 'PROCHAIN ' + nextAlert.tier}</span>
          <span class="cal-alert-countdown">dans ${formatDelta(nextAlert.deltaMs)}</span>
        </div>
        <div class="cal-alert-event">${nextAlert.event}</div>
        <div class="cal-alert-meta">
          Impact or ${nextAlert.score}/100 · ${hhmm(nextAlert.time)} locale · ${hhmm(nextAlert.time, 'UTC')} UTC
        </div>
        ${proche && nextAlert.note ? `<div class="cal-alert-note">${nextAlert.note}</div>` : ''}
      </div>`;
  });

  const card = (c) => `
    <div class="cal-item ${c.cls} ${c.past ? 'past' : ''}">
      <div class="cal-time">
        <span class="cal-time-local">${hhmm(c.time)}</span>
        <span class="cal-time-utc">${hhmm(c.time, 'UTC')} UTC</span>
        <span class="cal-date">${c.t.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' })}</span>
      </div>
      <div class="cal-badges">
        <span class="cal-imp ${c.cls}">${c.tier}</span>
        <span class="cal-score">${c.score}</span>
      </div>
      <div class="cal-event">${c.event}${c.estimated ? '<span class="cal-est">date estimée</span>' : ''}</div>
      <div class="cal-delta">${c.past ? 'il y a ' + formatDelta(c.deltaMs) : 'dans ' + formatDelta(c.deltaMs)}</div>
      <div class="cal-figures">
        ${c.forecast ? `<span>Prév. ${c.forecast}</span>` : ''}
        ${c.previous ? `<span>Préc. ${c.previous}</span>` : ''}
        ${c.actual ? `<span class="cal-actual">Actu. ${c.actual}</span>` : ''}
      </div>
      ${c.note ? `<div class="cal-note">${c.note}</div>` : ''}
    </div>`;

  const upSig = upcoming.map(c => c.time + ':' + c.score + ':' + Math.floor(c.deltaMs / 60000)).join(',');
  setHTMLIfChanged('cal-upcoming', upSig, () =>
    upcoming.length ? upcoming.map(card).join('')
                    : '<div class="cal-empty">Aucun événement à venir dans les données chargées.</div>');

  const pastSig = past.map(c => c.time + ':' + (c.actual ?? '')).join(',');
  setHTMLIfChanged('cal-past', pastSig, () => past.slice(0, 6).map(card).join(''));
  setText('cal-past-count', past.length ? `${past.length} publié${past.length > 1 ? 's' : ''}` : '—');
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
  renderNewsStatus();
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
  let base = CONFIG.PRICE_INTERVAL[regime] ?? CONFIG.PRICE_INTERVAL.normal;

  // Usage loyal XAUS : le fournisseur met en cache 30 s et demande un cache
  // client d'au moins 30 s (< 10 000 req/jour). Interroger plus vite ne
  // renverrait que la même valeur tout en consommant un service gratuit —
  // en régime crise (4 s) cela ferait ~21 600 requêtes/jour.
  if (STATE.priceSourceLabel === 'XAUS') base = Math.max(base, CONFIG.XAUS_MIN_INTERVAL);

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

async function newsCycle() {
  if (!STATE.paused) {
    const { articles, okCount, total } = await fetchGdeltBatch();
    STATE.newsSourcesOk = okCount;
    if (articles.length) {
      mergeLiveNews(articles);
      recomputeAndRender();
    } else if (okCount === 0) {
      console.warn('[GoldCompass] Aucun flux news joignable (' + total + ' requêtes)');
    }
  }
  STATE.timerNews = setTimeout(newsCycle, CONFIG.NEWS_INTERVAL);
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
      mergeCalendar(STATE.data);
      recomputeAndRender();
    }
    // Référence journalière rafraîchie à sa propre cadence (cache 6 h côté XAUS)
    const refAge = STATE.dailyRef ? Date.now() - STATE.dailyRef.fetched_at : Infinity;
    if (refAge > CONFIG.DAILY_REF_INTERVAL) {
      const ref = await fetchDailyReference();
      if (ref) { STATE.dailyRef = ref; recomputeAndRender(); }
    }
  }
  STATE.timerData = setTimeout(dataCycle, CONFIG.DATA_INTERVAL);
}

function startLiveLoop() {
  stopLiveLoop();
  STATE.timerPrice = setTimeout(priceCycle, currentPriceInterval());
  STATE.timerMacro = setTimeout(macroCycle, CONFIG.MACRO_INTERVAL);
  STATE.timerNews = setTimeout(newsCycle, CONFIG.NEWS_INTERVAL);
  STATE.timerData = setTimeout(dataCycle, CONFIG.DATA_INTERVAL);
  STATE.timerClock = setInterval(renderClockAndFreshness, 1000);
}
function stopLiveLoop() {
  clearTimeout(STATE.timerPrice); clearTimeout(STATE.timerMacro);
  clearTimeout(STATE.timerNews); clearTimeout(STATE.timerData);
  clearInterval(STATE.timerClock);
  STATE.timerPrice = STATE.timerMacro = STATE.timerNews = STATE.timerData = STATE.timerClock = null;
}

/* Rafraîchissement immédiat, hors cadence (retour d'arrière-plan, tap manuel) */
async function forceRefresh() {
  const [live, snapshot, newsBatch] = await Promise.all([
    fetchLiveGoldPrice(), fetchMacroSnapshot(), fetchGdeltBatch()
  ]);
  if (live) { applyLivePrice(STATE.data, live); STATE.priceSource = 'LIVE'; STATE.consecutiveFailures = 0; }
  else STATE.consecutiveFailures++;
  if (Object.keys(snapshot).length) applyMacroSnapshot(STATE.data, snapshot);
  STATE.newsSourcesOk = newsBatch.okCount;
  if (newsBatch.articles.length) mergeLiveNews(newsBatch.articles);
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
  // Le calendrier planifié est dérivé des règles de publication, pas saisi :
  // il reste juste même sans intervention, mois après mois.
  mergeCalendar(STATE.data);

  // Référence journalière d'abord : elle fournit la clôture veille dont
  // dépendent la variation % et le niveau d'invalidation.
  STATE.dailyRef = await fetchDailyReference();

  // Prix et macro récupérés en parallèle : un seul aller-retour perçu.
  const [live, snapshot] = await Promise.all([fetchLiveGoldPrice(), fetchMacroSnapshot()]);
  if (live) { applyLivePrice(STATE.data, live); STATE.priceSource = 'LIVE'; }
  else { STATE.priceSource = 'STATIC'; STATE.lastDataAt = STATE.lastDataAt ?? Date.now(); }
  if (Object.keys(snapshot).length) applyMacroSnapshot(STATE.data, snapshot);

  const firstNews = await fetchGdeltBatch();
  STATE.newsSourcesOk = firstNews.okCount;
  if (firstNews.articles.length) mergeLiveNews(firstNews.articles);

  recomputeAndRender();
  bindEvents();
  startLiveLoop();

  document.getElementById('app-loading')?.remove();
  document.getElementById('app')?.classList.add('ready');
}

document.addEventListener('DOMContentLoaded', init);
