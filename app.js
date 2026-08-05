/* ==========================================================================
   GOLD COMPASS — moteur institutionnel XAUUSD
   Architecture : DATA (data.json ou fallback) -> ENGINES -> RENDER -> UI
   Aucune donnée n'est inventée en dehors du data.json fourni / fallback local.
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   0. FALLBACK LOCAL (utilisé uniquement si data.json est inaccessible)
   -------------------------------------------------------------------------- */
const FALLBACK_DATA = {
  meta: { generated_at: new Date().toISOString(), source: 'MOCK_FALLBACK_LOCAL', market_status: 'normal', session: 'Session inconnue', latency_ms: null },
  price: { symbol: 'XAUUSD', last: 4180.00, prev_close: 4180.00, change_pct: 0, change_abs: 0, spread: 0.30, day_high: 4180.00, day_low: 4180.00 },
  macro: {}, calendar: [], geopolitics: [], news: []
};

/* --------------------------------------------------------------------------
   1. ÉTAT GLOBAL
   -------------------------------------------------------------------------- */
const STATE = {
  data: null,
  liveStatus: 'LIVE',      // LIVE | DEGRADE  (data.json atteignable ou non)
  priceSource: 'STATIC',   // LIVE | STATIC   (prix réel Yahoo ou valeur de data.json)
  activeTab: 'snapshot',
  bias: null,
  risk: null,
  haven: null,
  scenarios: null,
  newsGraded: []
};

/* --------------------------------------------------------------------------
   2. CHARGEMENT DES DONNÉES
   -------------------------------------------------------------------------- */
async function loadData() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    STATE.liveStatus = 'LIVE';
    return json;
  } catch (err) {
    console.warn('[GoldCompass] data.json indisponible, bascule fallback:', err.message);
    STATE.liveStatus = 'DEGRADE';
    return FALLBACK_DATA;
  }
}

/* --------------------------------------------------------------------------
   2bis. PRIX LIVE — API v8 Yahoo Finance (même source que GBP Compass /
   Metals Compass). Le prix réel écrase le prix statique de data.json ;
   le reste (macro/news/géopolitique) continue de venir de data.json.
   Chaîne de repli : XAUUSD spot en direct -> XAUUSD via proxy CORS ->
   GC=F (futures COMEX, proxy de secours) en direct -> via proxy.
   -------------------------------------------------------------------------- */
const PRICE_SOURCES = [
  { url: 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=5m&range=1d', label: 'yahoo:XAUUSD=X' },
  { url: 'https://corsproxy.io/?url=' + encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=5m&range=1d'), label: 'yahoo:XAUUSD=X (proxy)' },
  { url: 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d', label: 'yahoo:GC=F' },
  { url: 'https://corsproxy.io/?url=' + encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d'), label: 'yahoo:GC=F (proxy)' }
];

const PRICE_FETCH_TIMEOUT_MS = 4000;

async function fetchLiveGoldPrice() {
  for (const src of PRICE_SOURCES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(src.url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('Réponse Yahoo invalide');
      return {
        last: meta.regularMarketPrice,
        prev_close: meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice,
        day_high: meta.regularMarketDayHigh ?? meta.regularMarketPrice,
        day_low: meta.regularMarketDayLow ?? meta.regularMarketPrice,
        fetched_at: new Date().toISOString(),
        source: src.label
      };
    } catch (err) {
      console.warn('[GoldCompass] Source prix indisponible (' + src.label + '):', err.message);
    } finally {
      clearTimeout(timer);
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
}

/* --------------------------------------------------------------------------
   3. NEWS GRADING ENGINE
   NEWS SCORE = impact_macro*0.30 + impact_vol*0.20 + fiabilite*0.15
              + surprise*0.20 + duree*0.15
   -------------------------------------------------------------------------- */
const DURATION_SCORE = { court: 30, moyen: 60, long: 90 };

function computeNewsScore(item) {
  const dureeScore = DURATION_SCORE[item.duration] ?? 50;
  const score =
    item.impact_macro * 0.30 +
    item.impact_vol * 0.20 +
    item.reliability * 0.15 +
    item.surprise_prob * 0.20 +
    dureeScore * 0.15;
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
    .map(n => {
      const score = computeNewsScore(n);
      const tier = classifyNewsTier(score);
      return { ...n, score, ...tier };
    })
    .sort((a, b) => b.score - a.score); // tri par impact réel, pas chronologique
}

/* --------------------------------------------------------------------------
   4. GEOPOLITICAL ENGINE — Global Risk Score (0-100)
   -------------------------------------------------------------------------- */
const TREND_WEIGHT = { escalade: 1.15, stable: 1.0, desescalade: 0.75 };

function computeGlobalRiskScore(geoList) {
  if (!geoList || !geoList.length) {
    return { score: 0, level: 'FAIBLE', escalating: 0, deescalating: 0, stable: 0 };
  }
  let weighted = 0, weightTotal = 0;
  let escalating = 0, deescalating = 0, stable = 0;
  geoList.forEach(g => {
    const w = TREND_WEIGHT[g.trend] ?? 1.0;
    weighted += g.severity * w;
    weightTotal += 100 * 1.15; // normalisation sur le pire cas
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
   5. SAFE HAVEN ENGINE
   Heuristique 0-100 par actif refuge, dérivée du risque géopolitique,
   du régime de taux et du VIX. Documentée pour audit rapide.
   -------------------------------------------------------------------------- */
function safeVal(macro, key, fallback = 0) {
  return macro && macro[key] ? macro[key].value : fallback;
}

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
   6. GOLD BIAS ENGINE
   Combine facteurs macro + risque géopolitique en un score signé [-1, 1]
   (positif = bullish or). Conviction = magnitude ajustée par la cohérence
   des facteurs (agreement bonus / malus).
   -------------------------------------------------------------------------- */
const SIGNAL_SCORE = {
  bullish_gold: 1, bearish_gold: -1, risk_off: 0.4, geopolitical_premium: 0.5,
  neutral: 0, undefined: 0
};

function factorSignedScore(macroItem) {
  if (!macroItem) return 0;
  return SIGNAL_SCORE[macroItem.signal] ?? 0;
}

function computeGoldBias(data, riskScore) {
  const m = data.macro || {};
  const factors = [
    { name: 'Dollar (DXY)',        weight: 0.22, score: -factorSignedScore(m.dxy) * -1 * 0 + factorSignedScore(m.dxy) },
    { name: 'Rendements réels',    weight: 0.24, score: factorSignedScore(m.real_yields_10y) },
    { name: 'Flux ETF',            weight: 0.14, score: factorSignedScore(m.etf_flows_gold) },
    { name: 'Positionnement (COT)',weight: 0.10, score: factorSignedScore(m.cot_spec_net_long) },
    { name: 'Demande physique',    weight: 0.08, score: factorSignedScore(m.comex_registered) + factorSignedScore(m.shanghai_premium ? { signal: m.shanghai_premium.signal } : null) * 0 },
    { name: 'Volatilité (VIX)',    weight: 0.08, score: factorSignedScore(m.vix) },
    { name: 'Risque géopolitique', weight: 0.14, score: (riskScore.score / 100) * (riskScore.escalating >= riskScore.deescalating ? 1 : 0.3) }
  ];

  let net = 0, weightSum = 0;
  factors.forEach(f => { net += f.score * f.weight; weightSum += f.weight; });
  net = weightSum ? net / weightSum : 0;
  net = Math.max(-1, Math.min(1, net));

  // Cohérence : proportion de facteurs allant dans le même sens que net
  const sameSign = factors.filter(f => Math.sign(f.score) === Math.sign(net) && f.score !== 0).length;
  const agreement = factors.length ? sameSign / factors.length : 0;

  const magnitude = Math.abs(net);
  let conviction = Math.round(magnitude * 70 + agreement * 30);
  conviction = Math.max(0, Math.min(100, conviction));

  const neutralBase = Math.max(10, Math.min(65, 60 - magnitude * 50));
  const directional = 100 - neutralBase;
  let pHausse, pBaisse;
  if (net >= 0) {
    pHausse = directional * (0.5 + magnitude * 0.5);
    pBaisse = directional - pHausse;
  } else {
    pBaisse = directional * (0.5 + magnitude * 0.5);
    pHausse = directional - pBaisse;
  }
  pHausse = Math.round(pHausse);
  pBaisse = Math.round(pBaisse);
  const pNeutre = Math.max(0, 100 - pHausse - pBaisse);

  let biasLabel = 'NEUTRE / RANGE';
  let direction = 'ATTENTE';
  if (net > 0.15) { biasLabel = net > 0.45 ? 'HAUSSIER MARQUÉ' : 'HAUSSIER'; direction = 'ACHAT PROBABLE'; }
  else if (net < -0.15) { biasLabel = net < -0.45 ? 'BAISSIER MARQUÉ' : 'BAISSIER'; direction = 'VENTE PROBABLE'; }

  const price = data.price?.last ?? 0;
  const invalidationPct = Math.max(0.35, 1.1 - magnitude * 0.7); // plus la conviction est haute, plus l'invalidation est resserrée
  const invalidation = net >= 0
    ? +(price * (1 - invalidationPct / 100)).toFixed(2)
    : +(price * (1 + invalidationPct / 100)).toFixed(2);

  const altHypothesis = net >= 0
    ? 'Invalidation si le dollar et les rendements réels reprennent leur hausse simultanément, ou en cas de désescalade géopolitique rapide.'
    : 'Invalidation si les rendements réels chutent brutalement ou si un choc géopolitique majeur ravive la demande refuge.';

  return {
    net, conviction, pHausse, pBaisse, pNeutre, biasLabel, direction,
    invalidation, invalidationPct: +invalidationPct.toFixed(2), altHypothesis,
    factors, agreement: Math.round(agreement * 100)
  };
}

/* --------------------------------------------------------------------------
   7. SCENARIO ENGINE
   Génère un scénario dominant / alternatif / rupture par horizon.
   La confiance décroît avec l'horizon (incertitude croissante).
   -------------------------------------------------------------------------- */
const HORIZONS = [
  { key: '1h',      label: 'PROCHAINE HEURE',   decay: 0,    invalidPct: 0.30 },
  { key: 'session', label: 'PROCHAINE SESSION', decay: 0.06, invalidPct: 0.55 },
  { key: '24h',     label: '24 HEURES',         decay: 0.14, invalidPct: 1.10 },
  { key: '48h',     label: '48 HEURES',         decay: 0.22, invalidPct: 1.70 },
  { key: 'week',    label: 'SEMAINE',           decay: 0.35, invalidPct: 2.80 }
];

function nextTriggersWithin(calendar, hoursAhead) {
  if (!calendar) return [];
  const now = new Date(STATE.data?.meta?.generated_at ?? Date.now());
  const limit = new Date(now.getTime() + hoursAhead * 3600 * 1000);
  return calendar.filter(c => {
    const t = new Date(c.time);
    return t >= now && t <= limit;
  });
}

function computeScenarios(data, bias, risk) {
  const price = data.price?.last ?? 0;
  const horizonHours = { '1h': 1, session: 8, '24h': 24, '48h': 48, week: 168 };

  return HORIZONS.map(h => {
    const confidence = Math.max(15, Math.round(bias.conviction * (1 - h.decay)));
    const triggers = nextTriggersWithin(data.calendar, horizonHours[h.key]);
    const triggerLabel = triggers.length
      ? triggers.map(t => t.event).slice(0, 2).join(' · ')
      : (risk.escalating > 0 ? 'Évolution du risque géopolitique' : 'Flux macro / positionnement');

    const upTarget = +(price * (1 + h.invalidPct / 100)).toFixed(2);
    const downTarget = +(price * (1 - h.invalidPct / 100)).toFixed(2);

    const dominant = bias.net >= 0
      ? `Poursuite du biais haussier vers ${upTarget}, soutenue par ${bias.factors.filter(f => f.score > 0).map(f => f.name).slice(0, 2).join(' et ') || 'les facteurs macro dominants'}.`
      : `Poursuite du biais baissier vers ${downTarget}, sous la pression de ${bias.factors.filter(f => f.score < 0).map(f => f.name).slice(0, 2).join(' et ') || 'facteurs macro dominants'}.`;

    const alternative = bias.net >= 0
      ? `Range de consolidation entre ${downTarget} et ${upTarget} si les catalyseurs attendus déçoivent.`
      : `Range de consolidation entre ${downTarget} et ${upTarget} si la pression baissière s'essouffle.`;

    const rupture = risk.score >= 55
      ? `Choc haussier violent au-delà de ${upTarget} en cas d'escalade géopolitique soudaine (frappe, blocage, sanction majeure).`
      : `Choc baissier sous ${downTarget} en cas de surprise macro hawkish combinée à une désescalade rapide.`;

    return {
      key: h.key, label: h.label, confidence,
      dominant, alternative, rupture,
      trigger: triggerLabel,
      invalidation: bias.net >= 0 ? downTarget : upTarget,
      duration: h.label
    };
  });
}

/* --------------------------------------------------------------------------
   8. HELPERS UI
   -------------------------------------------------------------------------- */
function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function signCls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat'; }
function signPrefix(n) { return n > 0 ? '+' : ''; }
function trendArrow(trend) { return trend === 'up' ? '▲' : trend === 'down' ? '▼' : '▬'; }
function timeAgo(iso) {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return `il y a ${h} h`;
}
function hhmm(iso, tz) {
  try {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch { return '—'; }
}

/* --------------------------------------------------------------------------
   9. RENDER — HEADER
   -------------------------------------------------------------------------- */
function renderHeader() {
  const { price, meta } = STATE.data;
  document.getElementById('hdr-price').textContent = fmt(price.last);
  const chEl = document.getElementById('hdr-change');
  chEl.textContent = `${signPrefix(price.change_pct)}${fmt(price.change_pct)}% (${signPrefix(price.change_abs)}${fmt(price.change_abs)})`;
  chEl.className = 'hdr-change ' + signCls(price.change_pct);
  document.getElementById('hdr-spread').textContent = `SPRD ${fmt(price.spread)}`;
  document.getElementById('hdr-utc').textContent = hhmm(new Date().toISOString(), 'UTC') + ' UTC';
  document.getElementById('hdr-local').textContent = hhmm(new Date().toISOString()) + ' LOC';

  // Statut affiché : DÉGRADÉ prime (data.json injoignable) > LIVE (prix réel Yahoo)
  // > DÉMO (data.json ok mais prix statique de secours, source Yahoo indisponible).
  const statusEl = document.getElementById('hdr-status');
  let statusLabel, statusCls;
  if (STATE.liveStatus === 'DEGRADE') { statusLabel = 'DÉGRADÉ'; statusCls = 'degraded'; }
  else if (STATE.priceSource === 'LIVE') { statusLabel = 'LIVE'; statusCls = 'ok'; }
  else { statusLabel = 'DÉMO'; statusCls = 'demo'; }
  statusEl.textContent = statusLabel;
  statusEl.className = 'hdr-status ' + statusCls;

  document.getElementById('hdr-latency').textContent = meta.latency_ms != null ? `${meta.latency_ms}ms` : '—';

  const regimeEl = document.getElementById('hdr-regime');
  const regimeMap = { normal: 'NORMAL', volatile: 'VOLATIL', stress: 'STRESS', crisis: 'CRISE' };
  regimeEl.textContent = regimeMap[meta.market_status] ?? meta.market_status.toUpperCase();
  regimeEl.className = 'hdr-regime regime-' + meta.market_status;

  document.body.classList.toggle('crisis-mode', meta.market_status === 'crisis' || (STATE.risk && STATE.risk.score >= 80));
}

/* --------------------------------------------------------------------------
   10. RENDER — BANDEAU BIAS
   -------------------------------------------------------------------------- */
function renderBiasBanner() {
  const b = STATE.bias;
  document.getElementById('bias-label').textContent = b.biasLabel;
  document.getElementById('bias-label').className = 'bias-label ' + (b.net >= 0 ? 'bull' : 'bear');
  document.getElementById('bias-conviction-value').textContent = b.conviction;
  document.getElementById('bias-direction').textContent = b.direction;
  document.getElementById('bias-invalidation').textContent = fmt(b.invalidation);
  document.getElementById('bias-invalidation-pct').textContent = `dist. ${fmt(b.invalidationPct)}%`;
  document.getElementById('bias-alt').textContent = b.altHypothesis;
  document.getElementById('bias-updated').textContent = timeAgo(STATE.data.meta.generated_at);
  document.getElementById('bias-agreement').textContent = `${b.agreement}% des facteurs alignés`;

  // Barre de probabilités segmentée (signature visuelle)
  const bar = document.getElementById('prob-bar');
  bar.innerHTML = `
    <div class="prob-seg prob-up" style="flex:${Math.max(b.pHausse, 2)}"><span>${b.pHausse}%</span></div>
    <div class="prob-seg prob-neutral" style="flex:${Math.max(b.pNeutre, 2)}"><span>${b.pNeutre}%</span></div>
    <div class="prob-seg prob-down" style="flex:${Math.max(b.pBaisse, 2)}"><span>${b.pBaisse}%</span></div>
  `;
  document.getElementById('prob-labels').innerHTML =
    `<span class="lbl-up">P(HAUSSE) ${b.pHausse}%</span><span class="lbl-neutral">P(NEUTRE) ${b.pNeutre}%</span><span class="lbl-down">P(BAISSE) ${b.pBaisse}%</span>`;
}

/* --------------------------------------------------------------------------
   11. RENDER — MATRICE DES CATALYSEURS
   -------------------------------------------------------------------------- */
const CATALYST_MAP = [
  { key: 'dxy', label: 'DOLLAR', desc: m => `${m.dxy?.value ?? '—'} (${signPrefix(m.dxy?.change_pct)}${fmt(m.dxy?.change_pct)}%)` },
  { key: 'real_yields_10y', label: 'RENDEMENTS RÉELS', desc: m => `${m.real_yields_10y?.value ?? '—'}% (${m.real_yields_10y?.change_bps ?? 0}bps)` },
  { key: 'etf_flows_gold', label: 'FLUX ETF', desc: m => `${m.etf_flows_gold?.value ?? '—'}M$ · ${m.etf_flows_gold?.trend ?? '—'}` },
  { key: 'comex_registered', label: 'DEMANDE PHYSIQUE', desc: m => `COMEX ${m.comex_registered?.value ?? '—'}M oz` },
  { key: 'cot_spec_net_long', label: 'BANQUES CENTRALES / POSITIONNEMENT', desc: m => `COT ${m.cot_spec_net_long?.value?.toLocaleString('fr-FR') ?? '—'}` },
  { key: 'geo', label: 'RISQUE GÉOPOLITIQUE', desc: () => `Score ${STATE.risk.score}/100 · ${STATE.risk.level}` },
  { key: 'vix', label: 'VOLATILITÉ', desc: m => `VIX ${m.vix?.value ?? '—'} (${signPrefix(m.vix?.change_pct)}${fmt(m.vix?.change_pct)}%)` },
  { key: 'cot2', label: 'POSITIONNEMENT SPÉCULATIF', desc: m => `${m.cot_spec_net_long?.change_wow_pct != null ? signPrefix(m.cot_spec_net_long.change_wow_pct) + fmt(m.cot_spec_net_long.change_wow_pct) + '% WoW' : '—'}` }
];

function factorForCatalyst(key) {
  if (key === 'geo') return { score: (STATE.risk.score / 100) * (STATE.risk.escalating >= STATE.risk.deescalating ? 1 : 0.3) };
  return STATE.bias.factors.find(f =>
    (key === 'dxy' && f.name === 'Dollar (DXY)') ||
    (key === 'real_yields_10y' && f.name === 'Rendements réels') ||
    (key === 'etf_flows_gold' && f.name === 'Flux ETF') ||
    (key === 'comex_registered' && f.name === 'Demande physique') ||
    ((key === 'cot_spec_net_long' || key === 'cot2') && f.name === 'Positionnement (COT)') ||
    (key === 'vix' && f.name === 'Volatilité (VIX)')
  ) || { score: 0 };
}

function renderCatalystMatrix() {
  const m = STATE.data.macro;
  const grid = document.getElementById('catalyst-grid');
  grid.innerHTML = CATALYST_MAP.map(c => {
    const factor = factorForCatalyst(c.key);
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
  }).join('');
}

/* --------------------------------------------------------------------------
   12. RENDER — FIL D'ALERTES
   -------------------------------------------------------------------------- */
function renderNewsFeed(containerId, limit) {
  const container = document.getElementById(containerId);
  const items = limit ? STATE.newsGraded.slice(0, limit) : STATE.newsGraded;
  container.innerHTML = items.map(n => `
    <div class="news-item ${n.cls}">
      <div class="news-top">
        <span class="news-tier ${n.cls}">${n.tier}</span>
        <span class="news-score">${n.score}</span>
      </div>
      <div class="news-title">${n.title}</div>
      <div class="news-meta">
        <span>${n.source}</span>
        <span>·</span>
        <span>${timeAgo(n.timestamp)}</span>
        <span>·</span>
        <span class="news-dir ${n.direction}">${directionLabel(n.direction)}</span>
      </div>
      <div class="news-sens">
        Vol ${n.impact_vol} · Fiab ${n.reliability} · Surprise ${n.surprise_prob} · Durée ${n.duration}
      </div>
    </div>
  `).join('');
}
function directionLabel(d) {
  return { bullish: 'BULLISH OR', bearish: 'BEARISH OR', mixed: 'MIXTE', undefined: 'INDÉFINI' }[d] ?? d.toUpperCase();
}

/* --------------------------------------------------------------------------
   13. RENDER — SCÉNARIOS
   -------------------------------------------------------------------------- */
function renderScenarios(containerId, keys) {
  const container = document.getElementById(containerId);
  const list = keys ? STATE.scenarios.filter(s => keys.includes(s.key)) : STATE.scenarios;
  container.innerHTML = list.map(s => `
    <div class="scenario-card">
      <div class="scenario-top">
        <span class="scenario-horizon">${s.label}</span>
        <span class="scenario-conf">CONF. ${s.confidence}%</span>
      </div>
      <div class="scenario-row"><span class="scenario-tag dominant">DOMINANT</span><p>${s.dominant}</p></div>
      <div class="scenario-row"><span class="scenario-tag alternative">ALTERNATIF</span><p>${s.alternative}</p></div>
      <div class="scenario-row"><span class="scenario-tag rupture">RUPTURE</span><p>${s.rupture}</p></div>
      <div class="scenario-foot">
        <span>Déclencheur : ${s.trigger}</span>
        <span>Invalidation : ${fmt(s.invalidation)}</span>
      </div>
    </div>
  `).join('');
}

/* --------------------------------------------------------------------------
   14. RENDER — GUERRE / GÉOPOLITIQUE + SAFE HAVEN
   -------------------------------------------------------------------------- */
function renderGeopolitics() {
  document.getElementById('risk-score-value').textContent = STATE.risk.score;
  document.getElementById('risk-score-level').textContent = STATE.risk.level;
  document.getElementById('risk-score-level').className = 'risk-level risk-' + STATE.risk.level.toLowerCase().replace('é', 'e');
  document.getElementById('risk-escalating').textContent = STATE.risk.escalating;
  document.getElementById('risk-stable').textContent = STATE.risk.stable;
  document.getElementById('risk-deescalating').textContent = STATE.risk.deescalating;

  const zonesEl = document.getElementById('geo-zones');
  zonesEl.innerHTML = STATE.data.geopolitics.map(g => `
    <div class="geo-card trend-${g.trend}">
      <div class="geo-top">
        <span class="geo-zone">${g.zone}</span>
        <span class="geo-severity">${g.severity}/100</span>
      </div>
      <div class="geo-type">${g.type.replace(/_/g, ' ')} · <span class="geo-trend">${g.trend}</span></div>
      <div class="geo-desc">${g.desc_short}</div>
      <div class="geo-updated">${timeAgo(g.last_update)}</div>
    </div>
  `).join('');

  const haven = STATE.haven;
  const havenEl = document.getElementById('haven-grid');
  const havenItems = [
    ['OR', haven.gold], ['ARGENT', haven.silver], ['CHF', haven.chf], ['JPY', haven.jpy],
    ['TREASURIES', haven.treasury], ['CASH', haven.cash], ['RISK-OFF', haven.riskOff], ['RISK-ON', haven.riskOn]
  ];
  havenEl.innerHTML = havenItems.map(([label, val]) => `
    <div class="haven-cell">
      <div class="haven-label">${label}</div>
      <div class="haven-bar"><div class="haven-bar-fill" style="width:${val}%"></div></div>
      <div class="haven-value">${val}</div>
    </div>
  `).join('');
}

/* --------------------------------------------------------------------------
   15. RENDER — CALENDRIER
   -------------------------------------------------------------------------- */
function renderCalendar() {
  const el = document.getElementById('calendar-list');
  const now = new Date(STATE.data.meta.generated_at);
  el.innerHTML = STATE.data.calendar.map(c => {
    const t = new Date(c.time);
    const past = t < now;
    return `
      <div class="cal-item imp-${c.importance} ${past ? 'past' : ''}">
        <div class="cal-time">${hhmm(c.time, 'UTC')} UTC · ${t.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}</div>
        <div class="cal-event">${c.event}</div>
        <div class="cal-imp">${c.importance.toUpperCase()}</div>
        <div class="cal-figures">
          ${c.forecast ? `<span>Prév. ${c.forecast}</span>` : ''}
          ${c.previous ? `<span>Préc. ${c.previous}</span>` : ''}
          ${c.actual ? `<span class="cal-actual">Actu. ${c.actual}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

/* --------------------------------------------------------------------------
   16. RENDER — MACRO (matrice complète)
   -------------------------------------------------------------------------- */
function renderMacroTab() {
  const m = STATE.data.macro;
  const el = document.getElementById('macro-list');
  el.innerHTML = Object.values(m).map(item => `
    <div class="macro-row">
      <span class="macro-name">${item.label}</span>
      <span class="macro-val">${typeof item.value === 'number' ? fmt(item.value, item.value > 1000 ? 0 : 2) : item.value}${item.unit ?? ''}</span>
      ${item.change_pct != null ? `<span class="macro-chg ${signCls(item.change_pct)}">${signPrefix(item.change_pct)}${fmt(item.change_pct)}%</span>` : item.change_bps != null ? `<span class="macro-chg ${signCls(item.change_bps)}">${signPrefix(item.change_bps)}${item.change_bps}bp</span>` : '<span class="macro-chg flat">—</span>'}
      ${item.trend ? `<span class="macro-trend">${trendArrow(item.trend)}</span>` : ''}
    </div>
  `).join('');
}

/* --------------------------------------------------------------------------
   17. NAVIGATION PAR ONGLETS
   -------------------------------------------------------------------------- */
function switchTab(tab) {
  STATE.activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function bindNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

/* --------------------------------------------------------------------------
   18. INIT
   -------------------------------------------------------------------------- */
async function init() {
  STATE.data = await loadData();

  const livePrice = await fetchLiveGoldPrice();
  if (livePrice) {
    applyLivePrice(STATE.data, livePrice);
    STATE.priceSource = 'LIVE';
  } else {
    STATE.priceSource = 'STATIC';
  }

  STATE.risk = computeGlobalRiskScore(STATE.data.geopolitics);
  STATE.haven = computeSafeHaven(STATE.data.macro, STATE.risk.score);
  STATE.bias = computeGoldBias(STATE.data, STATE.risk);
  STATE.newsGraded = gradeAllNews(STATE.data.news || []);
  STATE.scenarios = computeScenarios(STATE.data, STATE.bias, STATE.risk);

  renderHeader();
  renderBiasBanner();
  renderCatalystMatrix();
  renderNewsFeed('news-feed-snapshot', 4);
  renderNewsFeed('news-feed-full', null);
  renderScenarios('scenario-cards-snapshot', ['session', '24h']);
  renderScenarios('scenario-cards-full', null);
  renderGeopolitics();
  renderCalendar();
  renderMacroTab();

  bindNav();

  document.getElementById('app-loading')?.remove();
  document.getElementById('app')?.classList.add('ready');

  // Rafraîchissement de l'horloge et re-render léger toutes les 30s
  setInterval(() => {
    document.getElementById('hdr-utc').textContent = hhmm(new Date().toISOString(), 'UTC') + ' UTC';
    document.getElementById('hdr-local').textContent = hhmm(new Date().toISOString()) + ' LOC';
    document.querySelectorAll('.news-meta span:nth-child(3), .geo-updated, #bias-updated').forEach(() => {});
  }, 30000);
}

document.addEventListener('DOMContentLoaded', init);
