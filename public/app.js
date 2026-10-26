// ── State ─────────────────────────────────────────────────────────────────────
let knownTemplateAliases = [];
let templatesLoaded = false;
let currentUser = null;
let _banCountdownInterval = null;

// ── Account ban screen ────────────────────────────────────────────────────────
async function checkAndShowBan() {
  try {
    const r = await fetch('/api/me/ban-status');
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.banned) showBanScreen(d.until, d.strikes);
  } catch (_) {}
}

function showBanScreen(until, strikes) {
  const screen = document.getElementById('banScreen');
  if (!screen) return;
  screen.style.display = 'flex';
  // Strike context message
  const strikeEl = document.getElementById('banStrikeInfo');
  if (strikeEl) {
    const nextDurations = ['24 hours', '3 days', '7 days', '30 days', '90 days'];
    const nextDuration = nextDurations[Math.min(strikes, nextDurations.length - 1)] || '90 days';
    strikeEl.textContent = `Offense ${strikes} of recorded history — next violation: ${nextDuration} suspension.`;
  }
  // Ban expiry date
  const dateEl = document.getElementById('banDate');
  if (dateEl) dateEl.textContent = 'Expires: ' + new Date(until).toLocaleString();
  // Countdown
  if (_banCountdownInterval) clearInterval(_banCountdownInterval);
  function tick() {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      clearInterval(_banCountdownInterval);
      screen.style.display = 'none';
      document.getElementById('banCountdown').textContent = '00:00:00';
      return;
    }
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const days = Math.floor(h / 24);
    const hrs = h % 24;
    const el = document.getElementById('banCountdown');
    if (el) el.textContent = days > 0 ? `${days}d ${String(hrs).padStart(2,'0')}h ${String(m).padStart(2,'0')}m` : `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  tick();
  _banCountdownInterval = setInterval(tick, 1000);
}

function handleAccountBanned(data) {
  if (data && data.until) showBanScreen(data.until, data.strikes || 1);
}
let characters = [];
let currentChar = null;
let currentChatLocked = false;
let isStreaming = false;
let callModeActive = false;
let chatEpoch = 0; // bumps whenever the open chat changes, so an old reply can't land in the new chat
let currentFilter = 'all';
let lastUserMessage = '';
// ── Model & Effort state ───────────────────────────────────────────────────────
const EFFORT_LEVELS = ['low','medium','high','extra','max','ultracode'];
const BASE_TIERS = ['opas','opes','opis','opos','opus','opys','opys5','opys6'];
const ALL_TIERS = BASE_TIERS;
// Older saved choices such as "opys5" mean the base model
const baseTierOf = (t) => {
  if (typeof t !== 'string') return null;
  if (BASE_TIERS.includes(t)) return t;                       // "opys5" / "opys6" are flagship models themselves
  const b = t.replace(/[2-6]$/, '');
  return (b !== 'opys5' && b !== 'opys6' && BASE_TIERS.includes(b)) ? b : null;
};
// The chosen model and effort are remembered per account (see loadAccountPrefs), never shared between accounts
let selectedModelTier = 'opas';
let selectedEffort = 'medium';
let prefsLoadedFor = null;
// Default model per subscription plan — higher plans get a smarter default automatically
const PLAN_DEFAULT_MODEL = { free: 'opas', advanced: 'opes', x20: 'opes', x50: 'opus', x100: 'opys', x200: 'opys' };
function loadAccountPrefs() {
  if (!currentUser || prefsLoadedFor === currentUser.googleId) return;
  prefsLoadedFor = currentUser.googleId;
  const plan = lastKnownUsage?.subscriptionTier || 'free';
  selectedModelTier = PLAN_DEFAULT_MODEL[plan] || 'opas';
  selectedEffort = 'medium';
  try {
    const t = localStorage.getItem(userKey('cm_model_tier'));
    if (baseTierOf(t)) selectedModelTier = baseTierOf(t);
    const e = localStorage.getItem(userKey('cm_effort'));
    if (EFFORT_LEVELS.includes(e)) selectedEffort = e;
  } catch (_) {}
  updateModelBarLabel();
}

const MODEL_LABELS  = { opas:'Opas', opes:'Opes', opis:'Opis', opos:'Opos', opus:'Opus', opys:'Opys', opys5:'Opys 5', opys6:'Opys 6' };
// Must match OPAS_COST / OPES_COST / COST_FACTOR_VS_OPES in server.js — what one reply costs from the allowance.
const OPAS_COST = { low: 264, medium: 420, high: 640, extra: 960, max: 1440, ultracode: 2880 };
const OPES_COST = { low: 1050, medium: 1800, high: 2700, extra: 3900, max: 6000, ultracode: 12000 };
const COST_FACTOR_VS_OPES = { opes: 1, opis: 1.25, opos: 1.5, opus: 2, opys: 3, opys5: 10, opys6: 20 };
const BASE_PLAN_RANK = { opas: 0, opes: 0, opis: 1, opos: 1, opus: 2, opys: 3, opys5: 4, opys6: 5 };
const PLAN_RANK = { free: 0, advanced: 1, x20: 2, x50: 3, x100: 4, x200: 5 };
function clientMessageCost(tier, effort) {
  tier = baseTierOf(tier) || tier;
  if (tier === 'opas' || !(tier in COST_FACTOR_VS_OPES)) return OPAS_COST[effort];
  return Math.round(OPES_COST[effort] * COST_FACTOR_VS_OPES[tier]);
}
// Roughly how many visible characters a full reply has at each effort (used to ramp the live counter up to the cost)
const EXPECTED_REPLY_CHARS = { low: 250, medium: 500, high: 1200, extra: 2500, max: 4000, ultracode: 12000 };
// Every model is asked for a set number of words at High, Extra and Max (must match WORDS_BY_EFFORT / MODEL_WORDS in server.js)
const WORDS_BY_EFFORT = { high: 800, extra: 1500, max: 2200, ultracode: 2500 };
const MODEL_WORDS = { opas: 0.7, opes: 1.1, opis: 1.3, opos: 1.5, opus: 1.8, opys: 2.1, opys5: 3.5, opys6: 5.0 };
function expectedReplyChars(tier, effort) {
  const b = baseTierOf(tier);
  if (b && WORDS_BY_EFFORT[effort]) return Math.round(WORDS_BY_EFFORT[effort] * MODEL_WORDS[b] / 50) * 50 * 6;   // about 6 characters a word
  return EXPECTED_REPLY_CHARS[effort] || 1200;
}
// Model tiers each plan may use — must match PLAN_MODEL_TIERS in server.js.
const PLAN_MODEL_TIERS = {};
for (const [plan, rank] of Object.entries(PLAN_RANK)) {
  PLAN_MODEL_TIERS[plan] = BASE_TIERS.filter(b => BASE_PLAN_RANK[b] <= rank);
}
// The total cost of the reply being written, and how much of it to show so far (ramps up as the text types)
function liveReplyCost() {
  let tier = callModeActive ? 'opas' : selectedModelTier;
  const plan = (typeof lastKnownUsage !== 'undefined' && lastKnownUsage && lastKnownUsage.subscriptionTier) || 'free';
  if (!(PLAN_MODEL_TIERS[plan] || PLAN_MODEL_TIERS.free).includes(tier)) tier = 'opas';
  const effort = callModeActive ? 'low' : (OPES_COST[selectedEffort] ? selectedEffort : 'medium');
  return { cost: clientMessageCost(tier, effort), effort, tier };
}
// The live counter under a reply: it ramps up to the price of the reply and then KEEPS counting at the same pace for as long
// as the reply keeps writing (long replies run far past the "expected" length). The usage bars still stop at the real price.
function liveTokensShown(chars) {
  const { cost, effort, tier } = liveReplyCost();
  return Math.round(cost * chars / expectedReplyChars(tier, effort));
}
const EFFORT_LABELS = { low:'Low', medium:'Medium', high:'High', extra:'Extra', max:'Max', ultracode:'⚡ Ultra Code' };

// Token usage multiplier shown on Max effort warning per tier.
// Each value = max effort cost on that model ÷ OPAS medium (the cheapest baseline reply).
// This shows the true usage escalation from OPAS → Opys 5 at Max effort.
const MAX_EFFORT_MULTIPLIERS = {};
{
  const baseline = OPAS_COST.medium; // 420 tokens — cheapest normal reply
  const fmt = (x) => (Math.round(x * 10) / 10) + '×';
  for (const b of BASE_TIERS) MAX_EFFORT_MULTIPLIERS[b] = fmt(clientMessageCost(b, 'max') / baseline);
}

function currentPlanKey() {
  return (typeof lastKnownUsage !== 'undefined' && lastKnownUsage && lastKnownUsage.subscriptionTier) || 'free';
}
function modelAllowedForPlan(tier) {
  return (PLAN_MODEL_TIERS[currentPlanKey()] || PLAN_MODEL_TIERS.free).includes(tier);
}

// Unlock or lock each model in the picker to match the account's own plan.
function updateModelPickerLocks() {
  ALL_TIERS.forEach(t => {
    const el = document.getElementById('opt' + t.charAt(0).toUpperCase() + t.slice(1));
    if (!el) return;
    const allowed = modelAllowedForPlan(t);
    el.classList.toggle('md-item-locked', !allowed);
    const up = el.querySelector('.md-upgrade-btn');
    if (up) up.style.display = allowed ? 'none' : '';
  });
  // If the saved model isn't part of this account's plan (e.g. after switching accounts), fall back to Opes
  if (!modelAllowedForPlan(selectedModelTier)) {
    selectedModelTier = 'opes';
    try { localStorage.setItem(userKey('cm_model_tier'), 'opes'); } catch (_) {}
    updateModelBarLabel();
  }
}

const MODEL_ICONS = {
  opas: '<path d="M7 2v11h3v9l7-12h-4l4-8z"/>',
  opes: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  opis: '<path d="M12 1L9.5 8.5H2L7.75 13.25L5.5 21L12 16.5L18.5 21L16.25 13.25L22 8.5H14.5Z"/>',
  opos: '<path d="M12 1L9.5 8.5H2L7.75 13.25L5.5 21L12 16.5L18.5 21L16.25 13.25L22 8.5H14.5Z"/>',
  opus: '<path d="M12 1L9.5 8.5H2L7.75 13.25L5.5 21L12 16.5L18.5 21L16.25 13.25L22 8.5H14.5Z"/>',
  opys: '<path d="M12 1L9.5 8.5H2L7.75 13.25L5.5 21L12 16.5L18.5 21L16.25 13.25L22 8.5H14.5Z"/>',
  opys5: '<path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/>',
  opys6: '<path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/>',
};

for (const k of Object.keys(MODEL_ICONS)) if (!MODEL_ICONS[k]) MODEL_ICONS[k] = MODEL_ICONS.opys;

function updateModelBarLabel() {
  const modelEl = document.getElementById('mbModelLabel');
  if (modelEl) modelEl.textContent = MODEL_LABELS[selectedModelTier] || selectedModelTier;
  const effortEl = document.getElementById('mbEffortLabel');
  if (effortEl) effortEl.textContent = EFFORT_LABELS[selectedEffort] || selectedEffort;
  if (typeof updateBookButton === 'function') updateBookButton();
  const icon = document.getElementById('modelBarIcon');
  if (icon) icon.innerHTML = MODEL_ICONS[selectedModelTier] || MODEL_ICONS.opas;

  // Update model picker checks
  ALL_TIERS.forEach(t => {
    const el = document.getElementById('opt' + t.charAt(0).toUpperCase() + t.slice(1));
    if (el) el.classList.toggle('active', t === selectedModelTier);
  });

  // Update effort picker checks and multiplier labels
  EFFORT_LEVELS.forEach(e => {
    const el = document.getElementById('effortOpt' + e.charAt(0).toUpperCase() + e.slice(1));
    if (!el) return;
    el.classList.toggle('active', e === selectedEffort);
  });
  const maxWarn = document.getElementById('effortMaxWarn');
  if (maxWarn) maxWarn.textContent = '⚠ ' + (MAX_EFFORT_MULTIPLIERS[selectedModelTier] || '3.4×') + ' more tokens';
  const ultraWarn = document.getElementById('effortUltracodeWarn');
  if (ultraWarn) {
    const mult = Math.round(clientMessageCost(selectedModelTier, 'ultracode') / (OPAS_COST.medium));
    ultraWarn.textContent = '⚠ ' + mult + '× more tokens';
  }
}

function setModelTier(tier) {
  tier = baseTierOf(tier) || 'opas';
  selectedModelTier = tier;
  try { localStorage.setItem(userKey('cm_model_tier'), tier); } catch(_) {}
  updateModelBarLabel();
  closeAllPickers();
}

function selectOrUpgrade(tier) {
  if (modelAllowedForPlan(tier)) { setModelTier(tier); return; }
  openPricingModal();
}

function showUpgradeModal() { openPricingModal(); }

// ── Subscription tier data ────────────────────────────────────────────────────
const PLAN_DATA = [
  {
    key: 'free', name: 'Free', monthly: 0, annual: 0, coinsPerMonth: 0,
    callsPerDay: 6, memosPerDay: 50, imagesPerDay: 3,
    features: [
      'Opas & Opes: quick-witted, weirdly capable, zero fluff',
      'Every character unlocked — no velvet rope',
      'Up to ~7 messages per session (token-limited)',
      'Up to 10 regenerations per day · up to 3 image uploads per day',
      'Up to 6 calls per day · up to 50 memos per day',
    ],
  },
  {
    key: 'advanced', name: 'Advanced', monthly: 9.99, annual: 59.99, coinsPerMonth: 2000,
    callsPerDay: 18, memosPerDay: 150, imagesPerDay: 9,
    features: [
      'Opis: sharper logic, built for mystery, never loses the thread',
      'Opos: plays GM — runs the whole room, drives plot, voices every NPC',
      'Up to ~21 messages per session — 3× free',
      'Up to 30 regenerations per day · up to 9 image uploads per day',
      'Up to 18 calls per day · up to 150 memos per day',
      'Everything in Free',
    ],
  },
  {
    key: 'x20', name: 'X20', badge: 'Recommended', monthly: 39.99, annual: 239.99, coinsPerMonth: 8000,
    callsPerDay: 120, memosPerDay: 1000, imagesPerDay: 60,
    features: [
      'Opus: proper emotional weight — subtext, inner conflict, the whole thing',
      'Up to ~140 messages per session — 20× free',
      'Up to 200 regenerations per day — 20× free',
      'Up to 120 calls per day · up to 60 image uploads per day',
      'Up to 1,000 memos per day',
      'Everything in Advanced',
    ],
  },
  {
    key: 'x50', name: 'X50', badge: 'Best Value', monthly: 79.99, annual: 479.99, coinsPerMonth: 20000,
    callsPerDay: 300, memosPerDay: 2500, imagesPerDay: 150,
    features: [
      'Opys: plans the scene before it writes it — tension beats, pacing, full arcs',
      'Replies run 1.9× longer with multi-chapter stamina',
      'Up to 300 calls · up to 150 image uploads · up to 2,500 memos per day',
      'Up to 500 regenerations per day — 50× free',
      'Everything in X20',
    ],
  },
  {
    key: 'x100', name: 'X100', badge: 'Ultimate', monthly: 159.99, annual: 959.99, coinsPerMonth: 50000,
    callsPerDay: 600, memosPerDay: 5000, imagesPerDay: 300,
    features: [
      'Opys 5: the flagship model, gated here on purpose',
      '3.5× longer replies with multi-pass refinement — it rewrites itself until it\'s right',
      '⚡ Ultra Code: ships real production code for Unity, Roblox, and web — not pseudocode',
      'Up to 600 calls · up to 300 image uploads · up to 5,000 memos per day',
      'Up to 1,000 regenerations per day — 100× free',
      'Everything in X50',
    ],
  },
  {
    key: 'x200', name: 'X200', badge: 'Legend', monthly: 399.99, annual: 2399.99, coinsPerMonth: 150000,
    callsPerDay: 1200, memosPerDay: 10000, imagesPerDay: 600,
    features: [
      'Opys 6: next-generation, exclusive — nothing else gets you here',
      '5× longer replies with cinematic depth most models can\'t approach',
      '⚡ Ultra Code at full scale — pipelines, multi-system architecture, the works',
      'World-building mode: lore, faction maps, and character arcs that survive every session',
      'Up to 1,200 calls · up to 600 image uploads · up to 10,000 memos per day',
      'Up to 2,000 regenerations per day — 200× free',
      'Everything in X100',
    ],
  },
];

// 1 coin = $0.01 USD — used to show the dollar value of coin-based subscriptions
const COIN_USD_VALUE = 0.01;
const MONTHLY_COIN_GRANT = { free: 20, advanced: 30, x20: 600, x50: 1800, x100: 3600, x200: 9000 };

const PLAN_LABELS = { free: 'Free', advanced: 'Advanced', x20: 'X20', x50: 'X50', x100: 'X100', x200: 'X200' };
const PLAN_SUBS = {
  free:     'Free plan',
  advanced: 'Advanced plan',
  x20:      'X20 plan',
  x50:      'X50 plan',
  x100:     'X100 plan',
  x200:     'X200 plan',
};
// X100/X200 are sold only once their PayPal plans are set up on the server (until then their cards say "Coming soon")
function planBuyable(key) {
  if (key === 'x100') return !!(PAYPAL_PLAN_IDS.x100 && (pricingPeriod !== 'annual' || PAYPAL_PLAN_IDS_YEARLY.x100));
  if (key === 'x200') return !!(PAYPAL_PLAN_IDS.x200 && (pricingPeriod !== 'annual' || PAYPAL_PLAN_IDS_YEARLY.x200));
  return true;
}

// Halloween sale — 40% off all paid plans, both monthly and annual. Ends Nov 1 2026.
const HALLOWEEN_SALE = { discount: 0.40, ends: new Date('2026-11-01T06:00:00Z') };
function halloweenSaleActive() { return new Date() < HALLOWEEN_SALE.ends && new Date().getMonth() === 9; }

let pricingPeriod = 'monthly';

// ── Country / currency data for pricing display ────────────────────────────
const COUNTRY_CURRENCY = {
  AD:{n:'Andorra',c:'EUR',s:'€'},AE:{n:'United Arab Emirates',c:'AED',s:'د.إ'},AF:{n:'Afghanistan',c:'AFN',s:'؋'},AG:{n:'Antigua and Barbuda',c:'XCD',s:'$'},AL:{n:'Albania',c:'ALL',s:'L'},AM:{n:'Armenia',c:'AMD',s:'֏'},AO:{n:'Angola',c:'AOA',s:'Kz'},AR:{n:'Argentina',c:'ARS',s:'$'},AT:{n:'Austria',c:'EUR',s:'€'},AU:{n:'Australia',c:'AUD',s:'A$'},AZ:{n:'Azerbaijan',c:'AZN',s:'₼'},
  BA:{n:'Bosnia and Herzegovina',c:'BAM',s:'KM'},BB:{n:'Barbados',c:'BBD',s:'$'},BD:{n:'Bangladesh',c:'BDT',s:'৳'},BE:{n:'Belgium',c:'EUR',s:'€'},BF:{n:'Burkina Faso',c:'XOF',s:'Fr'},BG:{n:'Bulgaria',c:'BGN',s:'лв'},BH:{n:'Bahrain',c:'BHD',s:'BD'},BI:{n:'Burundi',c:'BIF',s:'Fr'},BJ:{n:'Benin',c:'XOF',s:'Fr'},BN:{n:'Brunei',c:'BND',s:'$'},BO:{n:'Bolivia',c:'BOB',s:'Bs.'},BR:{n:'Brazil',c:'BRL',s:'R$'},BS:{n:'Bahamas',c:'BSD',s:'$'},BT:{n:'Bhutan',c:'BTN',s:'Nu'},BW:{n:'Botswana',c:'BWP',s:'P'},BY:{n:'Belarus',c:'BYN',s:'Br'},BZ:{n:'Belize',c:'BZD',s:'$'},
  CA:{n:'Canada',c:'CAD',s:'C$'},CD:{n:'Congo (DRC)',c:'CDF',s:'Fr'},CF:{n:'Central African Republic',c:'XAF',s:'Fr'},CG:{n:'Congo (Republic)',c:'XAF',s:'Fr'},CH:{n:'Switzerland',c:'CHF',s:'Fr'},CI:{n:"Côte d'Ivoire",c:'XOF',s:'Fr'},CL:{n:'Chile',c:'CLP',s:'$'},CM:{n:'Cameroon',c:'XAF',s:'Fr'},CN:{n:'China',c:'CNY',s:'¥'},CO:{n:'Colombia',c:'COP',s:'$'},CR:{n:'Costa Rica',c:'CRC',s:'₡'},CU:{n:'Cuba',c:'CUP',s:'$'},CV:{n:'Cabo Verde',c:'CVE',s:'$'},CY:{n:'Cyprus',c:'EUR',s:'€'},CZ:{n:'Czech Republic',c:'CZK',s:'Kč'},
  DE:{n:'Germany',c:'EUR',s:'€'},DJ:{n:'Djibouti',c:'DJF',s:'Fr'},DK:{n:'Denmark',c:'DKK',s:'kr'},DM:{n:'Dominica',c:'XCD',s:'$'},DO:{n:'Dominican Republic',c:'DOP',s:'$'},DZ:{n:'Algeria',c:'DZD',s:'د.ج'},
  EC:{n:'Ecuador',c:'USD',s:'$'},EE:{n:'Estonia',c:'EUR',s:'€'},EG:{n:'Egypt',c:'EGP',s:'£'},ER:{n:'Eritrea',c:'ERN',s:'Nfk'},ES:{n:'Spain',c:'EUR',s:'€'},ET:{n:'Ethiopia',c:'ETB',s:'Br'},
  FI:{n:'Finland',c:'EUR',s:'€'},FJ:{n:'Fiji',c:'FJD',s:'$'},FM:{n:'Micronesia',c:'USD',s:'$'},FR:{n:'France',c:'EUR',s:'€'},
  GA:{n:'Gabon',c:'XAF',s:'Fr'},GB:{n:'United Kingdom',c:'GBP',s:'£'},GD:{n:'Grenada',c:'XCD',s:'$'},GE:{n:'Georgia',c:'GEL',s:'₾'},GH:{n:'Ghana',c:'GHS',s:'₵'},GM:{n:'Gambia',c:'GMD',s:'D'},GN:{n:'Guinea',c:'GNF',s:'Fr'},GQ:{n:'Equatorial Guinea',c:'XAF',s:'Fr'},GR:{n:'Greece',c:'EUR',s:'€'},GT:{n:'Guatemala',c:'GTQ',s:'Q'},GW:{n:'Guinea-Bissau',c:'XOF',s:'Fr'},GY:{n:'Guyana',c:'GYD',s:'$'},
  HN:{n:'Honduras',c:'HNL',s:'L'},HR:{n:'Croatia',c:'EUR',s:'€'},HT:{n:'Haiti',c:'HTG',s:'G'},HU:{n:'Hungary',c:'HUF',s:'Ft'},
  ID:{n:'Indonesia',c:'IDR',s:'Rp'},IE:{n:'Ireland',c:'EUR',s:'€'},IL:{n:'Israel',c:'ILS',s:'₪'},IN:{n:'India',c:'INR',s:'₹'},IQ:{n:'Iraq',c:'IQD',s:'ع.د'},IR:{n:'Iran',c:'IRR',s:'﷼'},IS:{n:'Iceland',c:'ISK',s:'kr'},IT:{n:'Italy',c:'EUR',s:'€'},
  JM:{n:'Jamaica',c:'JMD',s:'$'},JO:{n:'Jordan',c:'JOD',s:'JD'},JP:{n:'Japan',c:'JPY',s:'¥'},
  KE:{n:'Kenya',c:'KES',s:'KSh'},KG:{n:'Kyrgyzstan',c:'KGS',s:'с'},KH:{n:'Cambodia',c:'KHR',s:'៛'},KI:{n:'Kiribati',c:'AUD',s:'A$'},KM:{n:'Comoros',c:'KMF',s:'Fr'},KN:{n:'Saint Kitts and Nevis',c:'XCD',s:'$'},KP:{n:'North Korea',c:'KPW',s:'₩'},KR:{n:'South Korea',c:'KRW',s:'₩'},KW:{n:'Kuwait',c:'KWD',s:'KD'},KZ:{n:'Kazakhstan',c:'KZT',s:'₸'},
  LA:{n:'Laos',c:'LAK',s:'₭'},LB:{n:'Lebanon',c:'LBP',s:'L£'},LC:{n:'Saint Lucia',c:'XCD',s:'$'},LI:{n:'Liechtenstein',c:'CHF',s:'Fr'},LK:{n:'Sri Lanka',c:'LKR',s:'₨'},LR:{n:'Liberia',c:'LRD',s:'$'},LS:{n:'Lesotho',c:'LSL',s:'L'},LT:{n:'Lithuania',c:'EUR',s:'€'},LU:{n:'Luxembourg',c:'EUR',s:'€'},LV:{n:'Latvia',c:'EUR',s:'€'},LY:{n:'Libya',c:'LYD',s:'LD'},
  MA:{n:'Morocco',c:'MAD',s:'MAD'},MC:{n:'Monaco',c:'EUR',s:'€'},MD:{n:'Moldova',c:'MDL',s:'L'},ME:{n:'Montenegro',c:'EUR',s:'€'},MG:{n:'Madagascar',c:'MGA',s:'Ar'},MH:{n:'Marshall Islands',c:'USD',s:'$'},MK:{n:'North Macedonia',c:'MKD',s:'ден'},ML:{n:'Mali',c:'XOF',s:'Fr'},MM:{n:'Myanmar',c:'MMK',s:'K'},MN:{n:'Mongolia',c:'MNT',s:'₮'},MR:{n:'Mauritania',c:'MRU',s:'UM'},MT:{n:'Malta',c:'EUR',s:'€'},MU:{n:'Mauritius',c:'MUR',s:'₨'},MV:{n:'Maldives',c:'MVR',s:'Rf'},MW:{n:'Malawi',c:'MWK',s:'MK'},MX:{n:'Mexico',c:'MXN',s:'$'},MY:{n:'Malaysia',c:'MYR',s:'RM'},MZ:{n:'Mozambique',c:'MZN',s:'MT'},
  NA:{n:'Namibia',c:'NAD',s:'$'},NE:{n:'Niger',c:'XOF',s:'Fr'},NG:{n:'Nigeria',c:'NGN',s:'₦'},NI:{n:'Nicaragua',c:'NIO',s:'C$'},NL:{n:'Netherlands',c:'EUR',s:'€'},NO:{n:'Norway',c:'NOK',s:'kr'},NP:{n:'Nepal',c:'NPR',s:'₨'},NR:{n:'Nauru',c:'AUD',s:'A$'},NZ:{n:'New Zealand',c:'NZD',s:'NZ$'},
  OM:{n:'Oman',c:'OMR',s:'ر.ع.'},
  PA:{n:'Panama',c:'PAB',s:'B/.'},PE:{n:'Peru',c:'PEN',s:'S/.'},PG:{n:'Papua New Guinea',c:'PGK',s:'K'},PH:{n:'Philippines',c:'PHP',s:'₱'},PK:{n:'Pakistan',c:'PKR',s:'₨'},PL:{n:'Poland',c:'PLN',s:'zł'},PT:{n:'Portugal',c:'EUR',s:'€'},PW:{n:'Palau',c:'USD',s:'$'},PY:{n:'Paraguay',c:'PYG',s:'₲'},
  QA:{n:'Qatar',c:'QAR',s:'ر.ق'},
  RO:{n:'Romania',c:'RON',s:'lei'},RS:{n:'Serbia',c:'RSD',s:'дин'},RU:{n:'Russia',c:'RUB',s:'₽'},RW:{n:'Rwanda',c:'RWF',s:'Fr'},
  SA:{n:'Saudi Arabia',c:'SAR',s:'ر.س'},SB:{n:'Solomon Islands',c:'SBD',s:'$'},SC:{n:'Seychelles',c:'SCR',s:'₨'},SD:{n:'Sudan',c:'SDG',s:'ج.س.'},SE:{n:'Sweden',c:'SEK',s:'kr'},SG:{n:'Singapore',c:'SGD',s:'S$'},SI:{n:'Slovenia',c:'EUR',s:'€'},SK:{n:'Slovakia',c:'EUR',s:'€'},SL:{n:'Sierra Leone',c:'SLE',s:'Le'},SM:{n:'San Marino',c:'EUR',s:'€'},SN:{n:'Senegal',c:'XOF',s:'Fr'},SO:{n:'Somalia',c:'SOS',s:'Sh'},SR:{n:'Suriname',c:'SRD',s:'$'},SS:{n:'South Sudan',c:'SSP',s:'£'},ST:{n:'São Tomé and Príncipe',c:'STN',s:'Db'},SV:{n:'El Salvador',c:'USD',s:'$'},SY:{n:'Syria',c:'SYP',s:'£'},SZ:{n:'Eswatini',c:'SZL',s:'L'},
  TD:{n:'Chad',c:'XAF',s:'Fr'},TG:{n:'Togo',c:'XOF',s:'Fr'},TH:{n:'Thailand',c:'THB',s:'฿'},TJ:{n:'Tajikistan',c:'TJS',s:'SM'},TL:{n:'Timor-Leste',c:'USD',s:'$'},TM:{n:'Turkmenistan',c:'TMT',s:'T'},TN:{n:'Tunisia',c:'TND',s:'DT'},TO:{n:'Tonga',c:'TOP',s:'T$'},TR:{n:'Turkey',c:'TRY',s:'₺'},TT:{n:'Trinidad and Tobago',c:'TTD',s:'$'},TV:{n:'Tuvalu',c:'AUD',s:'A$'},TW:{n:'Taiwan',c:'TWD',s:'NT$'},TZ:{n:'Tanzania',c:'TZS',s:'Sh'},
  UA:{n:'Ukraine',c:'UAH',s:'₴'},UG:{n:'Uganda',c:'UGX',s:'Sh'},US:{n:'United States',c:'USD',s:'$'},UY:{n:'Uruguay',c:'UYU',s:'$'},UZ:{n:'Uzbekistan',c:'UZS',s:'лв'},
  VA:{n:'Vatican City',c:'EUR',s:'€'},VC:{n:'Saint Vincent and the Grenadines',c:'XCD',s:'$'},VE:{n:'Venezuela',c:'VES',s:'Bs.S'},VN:{n:'Vietnam',c:'VND',s:'₫'},VU:{n:'Vanuatu',c:'VUV',s:'Vt'},
  WS:{n:'Samoa',c:'WST',s:'T'},
  YE:{n:'Yemen',c:'YER',s:'﷼'},
  ZA:{n:'South Africa',c:'ZAR',s:'R'},ZM:{n:'Zambia',c:'ZMW',s:'ZK'},ZW:{n:'Zimbabwe',c:'ZWL',s:'$'},
};

let pricingCountryCode = 'US';
let pricingCountryPromise = null;
let exchangeRates = null;
let exchangeRatesPromise = null;

function ensurePricingCountry() {
  if (!pricingCountryPromise)
    pricingCountryPromise = detectPricingCountry().then(code => { pricingCountryCode = code; return code; });
  return pricingCountryPromise;
}

function loadExchangeRates() {
  if (exchangeRatesPromise) return exchangeRatesPromise;
  exchangeRatesPromise = fetch('/api/exchange-rates')
    .then(r => r.json())
    .then(d => { exchangeRates = d; return d; })
    .catch(() => { exchangeRatesPromise = null; return null; });
  return exchangeRatesPromise;
}

async function detectPricingCountry() {
  try {
    const r = await fetch('/api/geo');
    if (r.ok) { const d = await r.json(); if (d.countryCode && COUNTRY_CURRENCY[d.countryCode]) return d.countryCode; }
  } catch (_) {}
  return 'US';
}


function formatLocalPrice(usdPrice) {
  if (usdPrice === 0) return 'Free';
  const info = COUNTRY_CURRENCY[pricingCountryCode] || COUNTRY_CURRENCY.US;
  if (info.c === 'USD' || !exchangeRates) return `$${usdPrice.toFixed(2)}`;
  const rate = exchangeRates[info.c.toLowerCase()];
  if (!rate) return `$${usdPrice.toFixed(2)}`;
  const local = usdPrice * rate;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: info.c, maximumFractionDigits: local >= 100 ? 0 : 2 }).format(local);
  } catch (_) {
    return `${info.s}${local.toFixed(local >= 100 ? 0 : 2)}`;
  }
}

function openPricingModal() {
  const m = document.getElementById('pricingModal');
  if (!m) return;
  m.style.display = 'flex';
  renderPricingCards();
  // Load geo + exchange rates; re-render when both land so local currency shows correctly
  Promise.all([ensurePricingCountry(), loadExchangeRates()]).then(() => renderPricingCards()).catch(() => {});
}
function closePricingModal() {
  const m = document.getElementById('pricingModal');
  if (m) m.style.display = 'none';
}
function setPricingPeriod(period) {
  pricingPeriod = period;
  document.getElementById('pricingBtnMonthly')?.classList.toggle('pt-active', period === 'monthly');
  document.getElementById('pricingBtnAnnual')?.classList.toggle('pt-active', period === 'annual');
  // Show "coming soon" note on annual toggle when yearly PayPal plans aren't live yet
  const annualBtn = document.getElementById('pricingBtnAnnual');
  if (annualBtn) {
    const note = annualBtn.querySelector('.pt-soon-note');
    if (!yearlyAvailable && period === 'annual') {
      if (!note) {
        const n = document.createElement('span');
        n.className = 'pt-soon-note';
        n.textContent = '(checkout at monthly rate for now)';
        annualBtn.appendChild(n);
      }
    } else if (note) note.remove();
  }
  renderPricingCards();
}

const ACTIVE_PLANS = ['advanced', 'x20', 'x50'];

// Update this URL to your Ko-fi / Buy Me a Coffee / PayPal.me donation link
const DONATION_URL = 'https://ko-fi.com/charactermind';

function renderPricingCards() {
  const container = document.getElementById('pricingCards');
  if (!container) return;
  const currentTier = lastKnownUsage?.subscriptionTier || 'free';
  const userCoins = lastKnownUsage?.cmCoins || 0;

  // Update coin-rate indicator in modal header
  const rateEl = document.getElementById('pricingCoinRate');
  if (rateEl) {
    const localOneCoins = formatLocalPrice(COIN_USD_VALUE);
    rateEl.innerHTML = `🪙 1 C.M. Coin&nbsp;≈&nbsp;<strong>${localOneCoins === 'Free' ? '$0.01' : localOneCoins}</strong>&nbsp;— shown in your local currency`;
  }

  const saleOn = halloweenSaleActive();

  // Keep annual button label in sync with whether the Halloween sale is active
  const annualToggle = document.getElementById('pricingBtnAnnual');
  if (annualToggle) {
    const lbl = annualToggle.querySelector('.pt-save-label');
    if (lbl) lbl.textContent = saleOn ? '🎃 70% off' : '50% off';
  }

  container.innerHTML = PLAN_DATA.filter(p => ACTIVE_PLANS.includes(p.key)).map(plan => {
    const isCurrent = plan.key === currentTier;
    const basePrice = pricingPeriod === 'annual' ? plan.annual : plan.monthly;
    const price = (saleOn && basePrice > 0) ? Math.round(basePrice * (1 - HALLOWEEN_SALE.discount) * 100) / 100 : basePrice;
    const priceStr = formatLocalPrice(price);
    const origStr = (saleOn && basePrice > 0) ? formatLocalPrice(basePrice) : null;
    const periodStr = basePrice === 0 ? 'forever' : pricingPeriod === 'annual' ? '/ year' : '/ month';
    let perMonth = '<div class="pc-per-month"></div>';
    if (plan.annual > 0 && pricingPeriod === 'annual') {
      const effectiveAnnual = saleOn ? Math.round(plan.annual * (1 - HALLOWEEN_SALE.discount) * 100) / 100 : plan.annual;
      const savePct = Math.round((1 - effectiveAnnual / (plan.monthly * 12)) * 100);
      const perMonthLocal = formatLocalPrice(effectiveAnnual / 12);
      perMonth = `<div class="pc-per-month">~${perMonthLocal}/mo &nbsp;<span class="pc-save-pct">Save ${savePct}%</span></div>`;
    }
    const saleBadge = saleOn && basePrice > 0 ? `<div class="pc-halloween-badge">🎃 -40%</div>` : '';
    const badge = plan.badge ? `<div class="pc-badge">${escHtml(plan.badge)}</div>` : '';
    const features = plan.features.map(f => `<li>✓ ${escHtml(f)}</li>`).join('');
    const coinCost = plan.coinsPerMonth || 0;
    let coinBtn = '';
    let coinValueRow = '';
    // Show the user's ACTUAL coin balance value toward this plan — not a fixed plan amount
    if (userCoins > 0 && plan.monthly > 0) {
      const cashPriceUSD = pricingPeriod === 'annual' ? (plan.annual / 12) : plan.monthly;
      const userCoinValueUSD = userCoins * COIN_USD_VALUE;
      const userCoinValueLocal = formatLocalPrice(userCoinValueUSD);
      const monthsCovered = Math.floor(userCoinValueUSD / cashPriceUSD);
      const pctCovered = Math.min(100, Math.round((userCoinValueUSD / cashPriceUSD) * 100));
      const coverageBadge = monthsCovered >= 1
        ? `<span class="pc-coin-save-badge">Covers ${monthsCovered} month${monthsCovered > 1 ? 's' : ''}</span>`
        : pctCovered > 0
          ? `<span class="pc-coin-coverage">Offsets ${pctCovered}% this month</span>`
          : '';
      let coinSavingsLine = '';
      if (pctCovered > 0) {
        const planPriceLocal = formatLocalPrice(cashPriceUSD);
        const afterCoins = Math.max(0, cashPriceUSD - userCoinValueUSD);
        const afterCoinsLocal = afterCoins <= 0 ? 'Free' : formatLocalPrice(afterCoins);
        coinSavingsLine = `<div class="pc-coin-savings-line"><span class="pc-orig-price">${planPriceLocal}/mo</span> → <strong>${afterCoinsLocal}/mo with coins</strong></div>`;
      }
      coinValueRow = `<div class="pc-coin-value-row">
        <span class="pc-coin-val-label">🪙 Your ${userCoins.toLocaleString()} coins ≈ <strong>${userCoinValueLocal}</strong></span>
        ${coverageBadge}
        ${coinSavingsLine}
      </div>`;
    }
    if (coinCost > 0 && !isCurrent) {
      if (userCoins >= coinCost) {
        coinBtn = `<button class="pc-cta pc-cta-coin" onclick="subscribeWithCoins('${plan.key}')">🪙 Use ${coinCost.toLocaleString()} coins</button>`;
      } else {
        const need = (coinCost - userCoins).toLocaleString();
        coinBtn = `<button class="pc-cta pc-cta-current" disabled title="Need ${need} more coins">🪙 Need ${need} more coins</button>`;
      }
    }
    const soon = !isCurrent && plan.key !== 'free';
    const ctaText = isCurrent ? 'Current plan' : soon ? 'Subscribe' : 'Upgrade';
    const ctaClass = 'pc-cta' + (isCurrent ? ' pc-cta-current' : '');
    return `<div class="pricing-card${isCurrent ? ' pc-current' : ''}${plan.badge ? ' pc-featured' : ''}">
      ${badge}${saleBadge}
      <div class="pc-name">${escHtml(plan.name)}</div>
      <div class="pc-price">${origStr ? `<span class="pc-orig-price">${origStr}</span> ` : ''}${priceStr}<span class="pc-period"> ${periodStr}</span></div>
      ${perMonth}
      ${coinValueRow}
      <ul class="pc-features">${features}</ul>
      <button class="${ctaClass}" ${isCurrent ? 'disabled' : `onclick="handleUpgradeCta('${plan.key}')"`}>${ctaText}</button>
      ${coinBtn}
    </div>`;
  }).join('');
}

const COIN_MONTHLY_COST_CLIENT = { advanced: 2000, x20: 8000, x50: 20000, x100: 50000, x200: 150000 };

async function subscribeWithCoins(planKey) {
  const plan = PLAN_DATA.find(p => p.key === planKey);
  if (!plan || !plan.coinsPerMonth) return;
  try {
    const r = await fetch('/api/coins/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: planKey })
    });
    const d = await r.json();
    if (d.ok) {
      if (lastKnownUsage) {
        lastKnownUsage.cmCoins = d.balance;
        lastKnownUsage.coinTier = d.coinTier;
        lastKnownUsage.coinTierExpires = d.coinTierExpires;
        lastKnownUsage.subscriptionTier = d.effectiveTier;
      }
      updateSettingsCoinDisplay(d.balance, lastKnownUsage?.coinsEarnedToday || 0, lastKnownUsage?.coinDailyLimit || 100, lastKnownUsage?.coinsMonthlyReset);
      updateNavCoinDisplay(lastKnownUsage);
      updateSettingsPlanCard(d.effectiveTier);
      renderPricingCards();
      closePricingModal();
    } else {
      alert(d.error === 'Not enough coins'
        ? `You need ${(d.cost - d.balance).toLocaleString()} more C.M Coins to subscribe.`
        : (d.error || 'Something went wrong. Please try again.'));
    }
  } catch(e) {
    console.error('[subscribeWithCoins]', e);
  }
}

// PayPal plan IDs (sandbox)
// (filled in from the server's /api/paypal/config; the server is the only source of truth for plan ids)
const PAYPAL_PLAN_IDS = {};

// Yearly plans exist only once their PayPal plans are set up on the server (it tells us in /api/paypal/config)
let yearlyAvailable = false;
let paypalConfigLoaded = null;
function loadPaypalConfig() {
  if (!paypalConfigLoaded) {
    paypalConfigLoaded = fetch('/api/paypal/config').then(r => r.json()).then(cfg => {
      if (cfg && cfg.planIds) Object.assign(PAYPAL_PLAN_IDS, cfg.planIds);
      if (cfg && cfg.yearlyPlanIds) Object.assign(PAYPAL_PLAN_IDS_YEARLY, cfg.yearlyPlanIds);
      yearlyAvailable = !!(cfg && cfg.yearlyAvailable);
      if (!yearlyAvailable) pricingPeriod = 'monthly';
      document.body.classList.toggle('yearly-on', yearlyAvailable);
      return cfg;
    }).catch(() => { paypalConfigLoaded = null; return null; });
  }
  return paypalConfigLoaded;
}
const PAYPAL_PLAN_IDS_YEARLY = {};
let currentCheckoutPeriod = 'monthly';

let paypalSdkLoaded = false;
let paypalSdkLoading = false;
let currentCheckoutPlan = null;
let currentCheckoutEffective = 0;
function handleUpgradeCta(planKey) {
  if (planKey === 'free' || !planBuyable(planKey)) return;
  if (!currentUser) {
    closePricingModal();
    showWarning('Please sign in first to subscribe to a plan.');
    return;
  }
  openPaypalCheckout(planKey, yearlyAvailable && pricingPeriod === 'annual' ? 'annual' : 'monthly');
}

async function openPaypalCheckout(planKey, period) {
  const plan = PLAN_DATA.find(p => p.key === planKey);
  if (!plan) return;
  currentCheckoutPlan = planKey;
  // Ensure local currency rates are loaded before we display prices
  Promise.all([ensurePricingCountry(), loadExchangeRates()]).catch(() => {});
  await loadPaypalConfig();
  currentCheckoutPeriod = (period === 'annual' && yearlyAvailable) ? 'annual' : 'monthly';
  const yearly = currentCheckoutPeriod === 'annual';

  document.getElementById('paypalCheckoutTitle').textContent = `${plan.name} Plan${yearly ? ' (yearly)' : ''}`;
  const saleOn = halloweenSaleActive();
  const basePrice = yearly ? plan.annual : plan.monthly;
  const price = (saleOn && basePrice > 0) ? Math.round(basePrice * (1 - HALLOWEEN_SALE.discount) * 100) / 100 : basePrice;
  const periodLabel = yearly ? 'yr' : 'mo';

  const origPriceEl = document.getElementById('paypalCheckoutOrigPrice');
  const priceEl = document.getElementById('paypalCheckoutPrice');
  const userCoins = lastKnownUsage?.cmCoins || 0;
  const coinValueUSD = userCoins * COIN_USD_VALUE;
  const coinRow = document.getElementById('co-coin-value-row');
  const coinLabelEl = document.getElementById('co-coin-label');
  const coinValueEl = document.getElementById('co-coin-value');
  const coinSaveEl = document.getElementById('co-coin-save');
  const tot = document.getElementById('co-total-display');

  const hasCoins = userCoins > 0 && price > 0;
  const discount = hasCoins ? Math.min(coinValueUSD, price) : 0;
  const effective = +(price - discount).toFixed(2);

  // Strikethrough label: during sale show the pre-sale price; otherwise show monthly*12 for annual
  let origLabel = '';
  if (saleOn && basePrice > 0) {
    origLabel = `${formatLocalPrice(basePrice)} / ${periodLabel}  (Save ${Math.round(HALLOWEEN_SALE.discount * 100)}%)`;
  } else if (yearly && plan.monthly > 0) {
    const fullYear = plan.monthly * 12;
    const savePct = Math.round((1 - plan.annual / fullYear) * 100);
    origLabel = `${formatLocalPrice(fullYear)} / yr  (Save ${savePct}%)`;
  } else {
    origLabel = `${formatLocalPrice(price)} / ${periodLabel}`;
  }

  if (hasCoins) {
    // Struck-through original price; green line shows the sale price (before coins); coin row deducts below
    if (origPriceEl) { origPriceEl.textContent = origLabel; origPriceEl.style.display = ''; }
    if (priceEl) { priceEl.textContent = `${formatLocalPrice(price)} / ${periodLabel}`; priceEl.classList.add('co-discounted'); }
    if (coinLabelEl) coinLabelEl.textContent = `🪙 ${userCoins.toLocaleString()} coins`;
    if (coinValueEl) coinValueEl.textContent = `-${formatLocalPrice(discount)}`;
    if (coinSaveEl) coinSaveEl.textContent = effective === 0 ? `✓ Fully covered! You're saving ${formatLocalPrice(discount)}` : `You're saving ${formatLocalPrice(discount)}`;
    if (coinRow) coinRow.style.display = '';
    if (tot) tot.textContent = formatLocalPrice(effective);
  } else if (saleOn && basePrice > 0) {
    // Sale, no coins: show pre-sale price struck through, sale price in green
    if (origPriceEl) { origPriceEl.textContent = origLabel; origPriceEl.style.display = ''; }
    if (priceEl) { priceEl.textContent = `${formatLocalPrice(price)} / ${periodLabel}`; priceEl.classList.add('co-discounted'); }
    if (coinRow) coinRow.style.display = 'none';
    if (tot) tot.textContent = formatLocalPrice(price);
  } else if (yearly && plan.monthly > 0) {
    // Annual, no sale, no coins — show annual savings strikethrough
    const fullYear = plan.monthly * 12;
    const savePct = Math.round((1 - plan.annual / fullYear) * 100);
    if (origPriceEl) { origPriceEl.textContent = `${formatLocalPrice(fullYear)} / yr`; origPriceEl.style.display = ''; }
    if (priceEl) { priceEl.textContent = `${formatLocalPrice(price)} / yr  ·  Save ${savePct}%`; priceEl.classList.add('co-discounted'); }
    if (coinRow) coinRow.style.display = 'none';
    if (tot) tot.textContent = formatLocalPrice(price);
  } else {
    if (origPriceEl) origPriceEl.style.display = 'none';
    if (priceEl) { priceEl.textContent = `${formatLocalPrice(price)} / ${periodLabel}`; priceEl.classList.remove('co-discounted'); }
    if (coinRow) coinRow.style.display = 'none';
    if (tot) tot.textContent = formatLocalPrice(price);
  }
  document.getElementById('paypal-checkout-status').textContent = '';
  document.getElementById('paypal-checkout-status').style.color = '';
  currentCheckoutEffective = effective;

  // When coins fully cover the price — hide payment tabs, show coin confirmation
  const payTabs = document.getElementById('co-pay-tabs');
  const payPanelPaypal = document.getElementById('payment-panel-paypal');
  const payPanelCard = document.getElementById('payment-panel-card');
  const payBtn = document.getElementById('co-pay-btn');
  const footer = document.getElementById('co-footer-text');
  if (effective === 0) {
    if (payTabs) payTabs.style.display = 'none';
    if (payPanelPaypal) payPanelPaypal.style.display = 'none';
    if (payPanelCard) payPanelCard.style.display = 'none';
    if (footer) footer.textContent = 'Secured by C.M. Coins · Cancel anytime · No hidden fees';
    if (payBtn) {
      payBtn.textContent = 'Confirm & Use Coins';
      payBtn.style.display = '';
      payBtn.onclick = () => handleCoinCheckout(planKey);
    }
  } else {
    if (payTabs) payTabs.style.display = '';
    if (footer) footer.textContent = 'Secured by PayPal · Cancel anytime · No hidden fees';
    if (payBtn) { payBtn.style.display = 'none'; payBtn.onclick = null; }
    switchPayTab('paypal');
  }

  document.getElementById('paypalCheckoutModal').style.display = 'flex';

  if (effective === 0) return; // no payment SDK needed

  // Show loading placeholder while PayPal button renders
  const ppContainer = document.getElementById('paypal-button-container');
  if (ppContainer && !paypalSdkLoaded) {
    ppContainer.innerHTML = '<div style="height:44px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.4);font-size:13px">Loading PayPal…</div>';
  }

  if (!paypalSdkLoaded && !paypalSdkLoading) {
    paypalSdkLoading = true;
    document.getElementById('paypal-checkout-status').textContent = '';
    try {
      const cfg = await loadPaypalConfig();
      if (!cfg || !cfg.clientId) {
        document.getElementById('paypal-checkout-status').textContent = 'PayPal is not configured. Please contact support.';
        paypalSdkLoading = false;
        return;
      }
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.clientId)}&vault=true&intent=subscription&components=buttons&disable-funding=card,credit,paylater`;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      paypalSdkLoaded = true;
      paypalSdkLoading = false;
      document.getElementById('paypal-checkout-status').textContent = '';
    } catch (err) {
      document.getElementById('paypal-checkout-status').textContent = 'Failed to load payment system. Please refresh and try again.';
      paypalSdkLoading = false;
      return;
    }
  }

  // Use currentCheckoutPlan in case the user switched plans while SDK was loading
  if (paypalSdkLoaded) initPayPalWidgets(currentCheckoutPlan || planKey);
}

function initPayPalWidgets(planKey) {
  const planId = (currentCheckoutPeriod === 'annual' ? PAYPAL_PLAN_IDS_YEARLY : PAYPAL_PLAN_IDS)[planKey];
  if (!planId || typeof paypal === 'undefined') return;

  // PayPal wallet button
  try {
    const ppContainer = document.getElementById('paypal-button-container');
    if (ppContainer) ppContainer.innerHTML = '';
    paypal.Buttons({
      fundingSource: paypal.FUNDING.PAYPAL,
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'subscribe' },
      createSubscription(data, actions) {
        if (!currentUser) throw new Error('Session expired — please refresh and sign in again');
        return actions.subscription.create({ plan_id: planId, custom_id: String(currentUser.googleId) });
      },
      onApprove(data) { return verifyAndActivateSubscription(data.subscriptionID, planKey); },
      onError(err) {
        document.getElementById('paypal-checkout-status').textContent = 'Payment failed. Please try again.';
        console.error('PayPal error:', err);
      }
    }).render('#paypal-button-container');
  } catch (err) { console.error('PayPal button render error:', err); }

}

async function verifyAndActivateSubscription(subscriptionId, planKey) {
  const status = document.getElementById('paypal-checkout-status');
  status.textContent = 'Activating subscription…';
  try {
    const resp = await fetch('/api/paypal/verify-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId, planKey, period: currentCheckoutPeriod })
    });
    const data = await resp.json();
    if (data.ok) {
      status.style.color = '#22c55e';
      status.textContent = '✓ Subscription activated!';
      if (lastKnownUsage) lastKnownUsage.subscriptionTier = planKey;
      setTimeout(() => {
        closePaypalCheckout();
        closePricingModal();
        loadUsage();
        showWarning(`Welcome to ${PLAN_LABELS[planKey]}! Your new limits are now active.`, 5000);
      }, 1800);
    } else {
      status.textContent = 'Activation failed: ' + (data.error || 'Unknown error');
    }
  } catch (err) {
    status.textContent = 'Network error. Please contact support.';
    console.error('Verify subscription error:', err);
  }
}

function closePaypalCheckout() {
  document.getElementById('paypalCheckoutModal').style.display = 'none';
  currentCheckoutPlan = null;
  currentCheckoutEffective = 0;
  // Reset state so next open is clean
  const payTabs = document.getElementById('co-pay-tabs');
  const payPanelPaypal = document.getElementById('payment-panel-paypal');
  const payPanelCard = document.getElementById('payment-panel-card');
  const payBtn = document.getElementById('co-pay-btn');
  if (payTabs) payTabs.style.display = '';
  if (payPanelPaypal) payPanelPaypal.style.display = '';
  if (payPanelCard) payPanelCard.style.display = 'none';
  if (payBtn) { payBtn.style.display = 'none'; payBtn.disabled = false; payBtn.textContent = 'Pay'; payBtn.onclick = null; }
  destroyStripeElements();
}

async function handleCoinCheckout(planKey) {
  const statusEl = document.getElementById('paypal-checkout-status');
  const payBtn = document.getElementById('co-pay-btn');
  if (payBtn) { payBtn.disabled = true; payBtn.textContent = 'Processing…'; }
  if (statusEl) { statusEl.textContent = ''; statusEl.style.color = ''; }
  try {
    const resp = await fetch('/api/coins/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey })
    });
    const data = await resp.json();
    if (data.ok) {
      if (statusEl) { statusEl.style.color = '#22c55e'; statusEl.textContent = '✓ Plan activated!'; }
      if (lastKnownUsage) { lastKnownUsage.subscriptionTier = data.effectiveTier; lastKnownUsage.cmCoins = data.balance; }
      setTimeout(() => {
        closePaypalCheckout();
        closePricingModal();
        loadUsage();
        showWarning(`Welcome to ${PLAN_LABELS[planKey]}! Your new limits are now active.`, 5000);
      }, 1500);
    } else {
      if (statusEl) statusEl.textContent = data.error || 'Activation failed. Please try again.';
      if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'Confirm & Use Coins'; }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Network error. Please contact support.';
    if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'Confirm & Use Coins'; }
    console.error('[coin checkout]', err);
  }
}

// ── Stripe card payment ────────────────────────────────────────────────────────
let stripeInstance = null;
let stripeElements = null;
let stripeCardNumber = null;
let stripeCardExpiry = null;
let stripeCardCvc = null;
let stripeConfigLoaded = null;
let activePayTab = 'paypal';

async function loadStripeConfig() {
  if (!stripeConfigLoaded) {
    stripeConfigLoaded = fetch('/api/stripe/config').then(r => r.json()).catch(() => ({ available: false }));
  }
  return stripeConfigLoaded;
}

function switchPayTab(tab) {
  activePayTab = tab;
  document.getElementById('co-tab-paypal').classList.toggle('active', tab === 'paypal');
  document.getElementById('co-tab-card').classList.toggle('active', tab === 'card');
  document.getElementById('payment-panel-paypal').style.display = tab === 'paypal' ? '' : 'none';
  document.getElementById('payment-panel-card').style.display = tab === 'card' ? '' : 'none';
  const footer = document.getElementById('co-footer-text');
  if (footer) footer.textContent = tab === 'card' ? 'Secured by Stripe · Cancel anytime · No hidden fees' : 'Secured by PayPal · Cancel anytime · No hidden fees';
  if (tab === 'card') mountStripeElements();
}

async function mountStripeElements() {
  const cfg = await loadStripeConfig();
  const unavailableEl = document.getElementById('stripe-unavailable');
  const payBtn = document.getElementById('stripe-pay-btn');
  if (!cfg.available || !cfg.publishableKey) {
    if (unavailableEl) unavailableEl.style.display = '';
    if (payBtn) payBtn.style.display = 'none';
    return;
  }

  // Check if price is set up for this plan
  const period = currentCheckoutPeriod === 'annual' ? 'annual' : 'monthly';
  const priceKey = `${currentCheckoutPlan}_${period}`;
  if (!cfg.prices?.[priceKey]) {
    if (unavailableEl) unavailableEl.style.display = '';
    if (payBtn) payBtn.style.display = 'none';
    return;
  }
  if (unavailableEl) unavailableEl.style.display = 'none';
  if (payBtn) payBtn.style.display = '';

  if (!stripeInstance) stripeInstance = Stripe(cfg.publishableKey);
  if (stripeCardNumber) return; // already mounted

  const appearance = {
    variables: {
      colorPrimary: '#8b5cf6',
      colorBackground: 'var(--bg3, #1e1b2e)',
      colorText: 'var(--text1, #e8e3ff)',
      colorDanger: '#f87171',
      fontFamily: 'system-ui, sans-serif',
      borderRadius: '8px',
    }
  };
  stripeElements = stripeInstance.elements({ appearance });

  const style = {
    base: { color: '#e8e3ff', fontFamily: 'system-ui, sans-serif', fontSize: '14px', '::placeholder': { color: '#6b6590' } },
    invalid: { color: '#f87171' }
  };
  stripeCardNumber = stripeElements.create('cardNumber', { style });
  stripeCardExpiry = stripeElements.create('cardExpiry', { style });
  stripeCardCvc    = stripeElements.create('cardCvc',    { style });

  stripeCardNumber.mount('#stripe-card-number');
  stripeCardExpiry.mount('#stripe-card-expiry');
  stripeCardCvc.mount('#stripe-card-cvc');

  const errorEl = document.getElementById('stripe-card-error');
  [stripeCardNumber, stripeCardExpiry, stripeCardCvc].forEach(el => {
    el.on('change', (ev) => {
      if (errorEl) { if (ev.error) { errorEl.textContent = ev.error.message; errorEl.style.display = ''; } else errorEl.style.display = 'none'; }
    });
  });
}

function destroyStripeElements() {
  if (stripeCardNumber) { try { stripeCardNumber.destroy(); } catch (_) {} stripeCardNumber = null; }
  if (stripeCardExpiry) { try { stripeCardExpiry.destroy(); } catch (_) {} stripeCardExpiry = null; }
  if (stripeCardCvc)    { try { stripeCardCvc.destroy(); }    catch (_) {} stripeCardCvc = null; }
  stripeElements = null;
  // Reset tab back to PayPal for next open
  activePayTab = 'paypal';
  const tabPaypal = document.getElementById('co-tab-paypal');
  const tabCard   = document.getElementById('co-tab-card');
  const panelPaypal = document.getElementById('payment-panel-paypal');
  const panelCard   = document.getElementById('payment-panel-card');
  if (tabPaypal) tabPaypal.classList.add('active');
  if (tabCard)   tabCard.classList.remove('active');
  if (panelPaypal) panelPaypal.style.display = '';
  if (panelCard)   panelCard.style.display = 'none';
  const footer = document.getElementById('co-footer-text');
  if (footer) footer.textContent = 'Secured by PayPal · Cancel anytime · No hidden fees';
}

async function submitStripePayment() {
  if (!stripeInstance || !stripeCardNumber) return;
  const btn = document.getElementById('stripe-pay-btn');
  const label = document.getElementById('stripe-pay-label');
  const errorEl = document.getElementById('stripe-card-error');
  const statusEl = document.getElementById('paypal-checkout-status');
  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Processing…';
  if (errorEl) errorEl.style.display = 'none';
  if (statusEl) { statusEl.textContent = ''; statusEl.style.color = ''; }

  try {
    const { paymentMethod, error } = await stripeInstance.createPaymentMethod({
      type: 'card',
      card: stripeCardNumber,
    });
    if (error) throw new Error(error.message);

    const period = currentCheckoutPeriod === 'annual' ? 'annual' : 'monthly';
    const r = await fetch('/api/stripe/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey: currentCheckoutPlan, period, paymentMethodId: paymentMethod.id })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Payment failed.');

    if (data.requiresAction) {
      // 3D Secure confirmation required
      const { error: confirmError } = await stripeInstance.confirmCardPayment(data.clientSecret);
      if (confirmError) throw new Error(confirmError.message);
      // Brief wait for Stripe webhook to process, then sync plan server-side
      await new Promise(r => setTimeout(r, 2000));
      await fetch('/api/stripe/sync', { method: 'POST' }).catch(() => {});
    }

    // Success
    if (statusEl) { statusEl.textContent = ''; }
    closePaypalCheckout();
    await loadUsage();
    showNotification('Subscription activated! Welcome to ' + currentCheckoutPlan.toUpperCase() + ' plan.', 'success');

  } catch (e) {
    if (errorEl) { errorEl.textContent = e.message; errorEl.style.display = ''; }
    if (statusEl) { statusEl.textContent = e.message; statusEl.style.color = '#f87171'; }
    if (btn) btn.disabled = false;
    if (label) label.textContent = 'Try again';
  }
}

// ── Coin Shop ─────────────────────────────────────────────────────────────────
const COIN_USD_VALUE_CLIENT = 0.01;
let coinPacks = null;
let coinShopSelectedPack = null;
let coinOrderSdkLoaded = false;
let coinOrderSdkLoading = false;

async function openCoinShop() {
  if (!currentUser) { showWarning('Sign in to buy coins.'); return; }
  document.getElementById('coinShopModal').style.display = 'flex';
  document.getElementById('coinShopStatus').textContent = '';
  document.getElementById('coinShopPaypalBtn').innerHTML = '';
  coinShopSelectedPack = null;

  if (!coinPacks) {
    try {
      const d = await fetch('/api/paypal/coin-packs').then(r => r.json());
      coinPacks = d.packs || [];
    } catch (_) { coinPacks = []; }
  }

  const container = document.getElementById('coinShopPacks');
  container.innerHTML = '';
  for (const pack of coinPacks) {
    const perDollar = Math.round(pack.coins / pack.price);
    const card = document.createElement('div');
    card.className = 'coin-pack-card';
    card.dataset.packId = pack.id;
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <div style="font-weight:700;font-size:15px">${pack.label}</div>
          <div style="font-size:13px;color:var(--text3);margin-top:2px">🪙 ${pack.coins.toLocaleString()} coins · ${perDollar} coins/$</div>
        </div>
        <div style="font-weight:700;font-size:18px;white-space:nowrap">$${pack.price.toFixed(2)}</div>
      </div>`;
    card.onclick = () => selectCoinPack(pack);
    container.appendChild(card);
  }
}

function closeCoinShop() {
  document.getElementById('coinShopModal').style.display = 'none';
  coinShopSelectedPack = null;
}

// ── Quiz ──────────────────────────────────────────────────────────────────────
let _quizId = null;
let _quizQuestions = [];
let _quizAnswers = [];
let _quizCurrent = 0;
let _quizAnswered = false;

function openQuizModal() {
  if (!currentUser) { showWarning('Sign in to take a quiz.'); return; }
  _quizId = null;
  document.querySelectorAll('.quiz-cat-btn').forEach(b => b.disabled = false);
  _quizShowScreen('cat');
  document.getElementById('quizCooldownMsg').textContent = '';
  document.getElementById('quizOverlay').style.display = 'flex';
}
function closeQuizModal() {
  document.getElementById('quizOverlay').style.display = 'none';
}
function _quizShowScreen(name) {
  document.getElementById('quizScreenCat').style.display    = name === 'cat'    ? '' : 'none';
  document.getElementById('quizScreenQ').style.display      = name === 'q'      ? '' : 'none';
  document.getElementById('quizScreenResult').style.display = name === 'result' ? '' : 'none';
}
async function startQuiz(category) {
  document.querySelectorAll('.quiz-cat-btn').forEach(b => b.disabled = true);
  document.getElementById('quizCooldownMsg').textContent = 'Loading…';
  try {
    const r = await fetch('/api/quiz/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    const d = await r.json();
    if (!r.ok) {
      document.getElementById('quizCooldownMsg').textContent = d.error || 'Something went wrong. Try again.';
      document.querySelectorAll('.quiz-cat-btn').forEach(b => b.disabled = false);
      return;
    }
    if (d.cooldown) {
      const mins = Math.ceil(d.cooldownMs / 60000);
      document.getElementById('quizCooldownMsg').textContent = `${category} quiz on cooldown — try again in ${mins} min.`;
      document.querySelectorAll('.quiz-cat-btn').forEach(b => b.disabled = false);
      return;
    }
    _quizId = d.quizId;
    _quizQuestions = d.questions;
    _quizAnswers = [];
    _quizCurrent = 0;
    _quizShowScreen('q');
    _quizRenderQuestion();
  } catch (_) {
    document.getElementById('quizCooldownMsg').textContent = 'Something went wrong. Try again.';
    document.querySelectorAll('.quiz-cat-btn').forEach(b => b.disabled = false);
  }
}
function _quizRenderQuestion() {
  document.getElementById('quizNextBtn').disabled = false;
  const q = _quizQuestions[_quizCurrent];
  const total = _quizQuestions.length;
  const idx = _quizCurrent;
  _quizAnswered = false;

  document.getElementById('quizProgress').textContent = `Question ${idx + 1} / ${total}`;
  document.getElementById('quizProgressFill').style.width = `${((idx + 1) / total) * 100}%`;
  const diffLabel = ['', 'Easy', 'Medium', 'Hard'];
  document.getElementById('quizCategory').textContent = `${diffLabel[q.d] || ''} · ${q.d === 1 ? 5 : q.d === 2 ? 10 : 20} coins`;
  document.getElementById('quizQuestion').textContent = q.q;
  document.getElementById('quizFeedback').textContent = '';
  document.getElementById('quizNextBtn').style.display = 'none';

  const optsEl = document.getElementById('quizOptions');
  optsEl.innerHTML = '';
  q.opts.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'quiz-opt-btn';
    btn.textContent = opt;
    btn.onclick = () => _quizPickAnswer(i);
    optsEl.appendChild(btn);
  });
}
function _quizPickAnswer(idx) {
  if (_quizAnswered) return;
  _quizAnswered = true;
  const q = _quizQuestions[_quizCurrent];
  _quizAnswers.push(idx);

  const btns = document.querySelectorAll('.quiz-opt-btn');
  btns.forEach(b => b.disabled = true);
  btns[q.a].classList.add('quiz-correct');
  if (idx !== q.a) {
    btns[idx].classList.add('quiz-wrong');
    document.getElementById('quizFeedback').textContent = `✗ Correct answer: ${q.opts[q.a]}`;
    document.getElementById('quizFeedback').style.color = 'var(--text3)';
  } else {
    document.getElementById('quizFeedback').textContent = '✓ Correct!';
    document.getElementById('quizFeedback').style.color = '#4ade80';
  }

  const isLast = _quizCurrent >= _quizQuestions.length - 1;
  const nextBtn = document.getElementById('quizNextBtn');
  nextBtn.textContent = isLast ? 'See Results' : 'Next →';
  nextBtn.style.display = '';
}
async function quizNext() {
  _quizCurrent++;
  if (_quizCurrent < _quizQuestions.length) {
    _quizRenderQuestion();
    return;
  }
  // Submit
  document.getElementById('quizNextBtn').disabled = true;
  document.getElementById('quizNextBtn').textContent = 'Submitting…';
  try {
    const r = await fetch('/api/quiz/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quizId: _quizId, answers: _quizAnswers }),
    });
    const d = await r.json();
    if (!r.ok) {
      _quizShowResult({ ok: false, correct: 0, total: _quizQuestions.length, coinsEarned: 0, breakdown: [] });
      return;
    }
    _quizShowResult(d);
  } catch (_) {
    _quizShowResult({ ok: false, correct: 0, total: _quizQuestions.length, coinsEarned: 0, breakdown: [] });
  }
}
function _quizShowResult(d) {
  const pct = d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0;
  const emoji = pct === 100 ? '🏆' : pct >= 70 ? '⭐' : pct >= 40 ? '🎯' : '📚';
  document.getElementById('quizResultEmoji').textContent = emoji;
  document.getElementById('quizResultTitle').textContent = pct === 100 ? 'Perfect score!' : pct >= 70 ? 'Well done!' : pct >= 40 ? 'Good effort!' : 'Keep studying!';
  document.getElementById('quizResultScore').textContent = `${d.correct} / ${d.total} correct (${pct}%)`;
  document.getElementById('quizCoinsEarned').textContent = `+${d.coinsEarned || 0}`;
  document.getElementById('quizCoinsLabel').textContent = d.coinsEarned > 0 ? 'C.M. Coins earned' : 'No coins earned';

  // Breakdown
  const bEl = document.getElementById('quizBreakdown');
  bEl.innerHTML = '';
  (d.breakdown || []).forEach((b, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border2)';
    row.innerHTML = `<span style="font-size:16px;flex-shrink:0">${b.correct ? '✅' : '❌'}</span><div style="flex:1"><div style="font-weight:500;color:var(--text1)">${escHtml(b.q)}</div>${!b.correct ? `<div style="color:var(--text3);font-size:12px;margin-top:2px">Answer: ${escHtml(b.correctAnswer)}</div>` : ''}</div>${b.correct ? `<span style="color:#4ade80;font-weight:700;flex-shrink:0">+${b.coins}</span>` : ''}`;
    bEl.appendChild(row);
  });

  _quizShowScreen('result');
  if (d.coinsEarned > 0) loadUsage();
}
function quizPlayAgain() {
  _quizShowScreen('cat');
  document.querySelectorAll('.quiz-cat-btn').forEach(b => b.disabled = false);
  document.getElementById('quizCooldownMsg').textContent = '';
}

async function selectCoinPack(pack) {
  coinShopSelectedPack = pack;
  document.querySelectorAll('.coin-pack-card').forEach(c => c.classList.toggle('selected', c.dataset.packId === pack.id));
  document.getElementById('coinShopStatus').textContent = '';
  const btnWrap = document.getElementById('coinShopPaypalBtn');
  btnWrap.innerHTML = '';

  if (!coinOrderSdkLoaded && !coinOrderSdkLoading) {
    coinOrderSdkLoading = true;
    document.getElementById('coinShopStatus').textContent = 'Loading payment system…';
    try {
      const cfg = await fetch('/api/paypal/config').then(r => r.json());
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.clientId)}&intent=capture&components=buttons&disable-funding=card,credit,paylater&data-namespace=paypalOrder`;
        s.dataset.namespace = 'paypalOrder';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      coinOrderSdkLoaded = true;
      document.getElementById('coinShopStatus').textContent = '';
    } catch (_) {
      document.getElementById('coinShopStatus').textContent = 'Failed to load payment system. Refresh and try again.';
      coinOrderSdkLoading = false;
      return;
    }
  }

  if (coinOrderSdkLoaded) renderCoinPaypalButton(pack);
}

function renderCoinPaypalButton(pack) {
  const btnWrap = document.getElementById('coinShopPaypalBtn');
  btnWrap.innerHTML = '';
  if (typeof paypalOrder === 'undefined') return;
  try {
    paypalOrder.Buttons({
      fundingSource: paypalOrder.FUNDING.PAYPAL,
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'pay' },
      async createOrder() {
        const d = await fetch('/api/paypal/create-coin-order', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packId: pack.id })
        }).then(r => r.json());
        if (!d.orderId) throw new Error(d.error || 'Could not create order');
        return d.orderId;
      },
      async onApprove(data) {
        document.getElementById('coinShopStatus').textContent = 'Processing payment…';
        try {
          const d = await fetch('/api/paypal/capture-coin-order', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: data.orderID })
          }).then(r => r.json());
          if (d.ok) {
            document.getElementById('coinShopStatus').style.color = '#22c55e';
            document.getElementById('coinShopStatus').textContent = `✓ ${d.coins.toLocaleString()} coins added! Balance: ${d.newBalance.toLocaleString()}`;
            if (lastKnownUsage) lastKnownUsage.cmCoins = d.newBalance;
            loadUsage();
            setTimeout(closeCoinShop, 3000);
          } else {
            document.getElementById('coinShopStatus').textContent = d.error || 'Payment failed.';
          }
        } catch (_) { document.getElementById('coinShopStatus').textContent = 'Network error. Contact support.'; }
      },
      onError(err) {
        document.getElementById('coinShopStatus').textContent = 'Payment error. Please try again.';
        console.error('Coin PayPal error:', err);
      }
    }).render('#coinShopPaypalBtn');
  } catch (err) { console.error('Coin PayPal render error:', err); }
}


function updateSettingsPlanCard(tier) {
  const t = tier || lastKnownUsage?.subscriptionTier || 'free';
  const badge = document.getElementById('settingsPlanBadge');
  const name  = document.getElementById('settingsPlanName');
  const sub   = document.getElementById('settingsPlanSub');
  if (badge) badge.textContent = PLAN_LABELS[t] || t;
  if (name)  name.textContent  = (PLAN_LABELS[t] || t) + ' Plan';
  if (sub)   sub.textContent   = PLAN_SUBS[t] || '';
  renderSettingsTiers(t);
}

function renderSettingsTiers(currentTier) {
  const el = document.getElementById('settingsTiersSection');
  if (!el) return;
  const t = currentTier || currentPlanKey() || 'free';
  const period = (typeof pricingPeriod !== 'undefined' && pricingPeriod) ? pricingPeriod : 'monthly';
  const chk = `<svg viewBox="0 0 24 24" fill="currentColor" width="9" height="9"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="st2-header">
      <div class="st2-title">Plans</div>
      <div class="st2-toggle">
        <button class="st2-toggle-btn ${period==='monthly'?'st2-toggle-active':''}" onclick="setSettingsPeriod('monthly')">Monthly</button>
        <button class="st2-toggle-btn ${period==='annual'?'st2-toggle-active':''}" onclick="setSettingsPeriod('annual')">Annual</button>
      </div>
    </div>
    <div class="st2-cards-wrap">
      ${PLAN_DATA.filter(p => ACTIVE_PLANS.includes(p.key)).map(p=>{
        const isCurrent = p.key === t;
        const price = period === 'annual' ? p.annual : p.monthly;
        return `
        <div class="st2-card${p.badge==='Recommended'?' st2-featured':''}${isCurrent?' st2-current':''}">
          ${p.badge&&!isCurrent?`<div class="st2-badge">${p.badge}</div>`:''}
          <div class="st2-plan-name">${p.name}</div>
          <div class="st2-price-row">
            <div class="st2-price">${price===0?'Free':'$'+price}</div>
            ${price>0?`<div class="st2-period">/${period==='annual'?'mo*':'mo'}</div>`:''}
          </div>
          <ul class="st2-feats">${p.features.map(f=>`<li class="st2-feat">${chk} ${f}</li>`).join('')}</ul>
          <button class="st2-btn${isCurrent?' st2-btn-current':''}" ${isCurrent?'disabled':''} onclick="${isCurrent?'':'openPricingModal()'}">${isCurrent?'Current Plan':'Upgrade'}</button>
        </div>`;
      }).join('')}
    </div>
    ${period==='annual'?'<div style="font-size:10px;color:var(--text3);margin-top:6px;">* Billed annually</div>':''}
  `;
}

function setSettingsPeriod(period) {
  pricingPeriod = (yearlyAvailable && period === 'annual') ? 'annual' : 'monthly';
  renderSettingsTiers();
}

function setEffort(effort) {
  selectedEffort = effort;
  try { localStorage.setItem(userKey('cm_effort'), effort); } catch(_) {}
  updateModelBarLabel();
}

let modelDropdownOpen = false;
let effortPanelOpen = false;
function closeAllPickers() {
  modelDropdownOpen = false;
  effortPanelOpen = false;
  const md = document.getElementById('modelDropdown');
  const ep = document.getElementById('effortPanelPopup');
  if (md) md.style.display = 'none';
  if (ep) ep.style.display = 'none';
  const more = document.getElementById('mdMore');
  if (more) more.classList.remove('open');
}
// On a mouse the extra models show while the pointer is over 'More models' and go away when it leaves.
// On a touch screen there is no hover, so tapping the button opens and closes them instead.
document.addEventListener('mouseover', (e) => {
  if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
  const more = document.getElementById('mdMore');
  if (more && !more.contains(e.target)) more.classList.remove('open');
});
function toggleMoreModels(e) {
  if (e) e.stopPropagation();
  const more = document.getElementById('mdMore');
  if (!more) return;
  more.classList.toggle('open');
  // On a phone the extra models open underneath: scroll them into view inside the picker
  if (more.classList.contains('open')) setTimeout(() => { const sub = document.getElementById('mdSubmenu'); if (sub && sub.scrollIntoView) sub.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30);
}
function toggleModelDropdown() {
  const wasOpen = modelDropdownOpen;
  closeAllPickers();
  if (!wasOpen) {
    modelDropdownOpen = true;
    const md = document.getElementById('modelDropdown');
    if (md) md.style.display = 'block';
    updateModelBarLabel();
  }
}
function toggleEffortPanel() {
  const wasOpen = effortPanelOpen;
  closeAllPickers();
  if (!wasOpen) {
    effortPanelOpen = true;
    const ep = document.getElementById('effortPanelPopup');
    if (ep) ep.style.display = 'block';
    updateModelBarLabel();
  }
}

// Close pickers when clicking outside
document.addEventListener('click', (e) => {
  if ((modelDropdownOpen || effortPanelOpen)
    && !e.target.closest('#modelDropdown')
    && !e.target.closest('#effortPanelPopup')
    && !e.target.closest('#mbModelBtn')
    && !e.target.closest('#mbEffortBtn')) {
    closeAllPickers();
  }
});

// ── New Chat Warning ───────────────────────────────────────────────────────────
function requestNewChat() {
  if (!currentChar) return;
  closeSidebarMobile();
  document.getElementById('newChatWarningModal').style.display = 'flex';
}
function closeNewChatWarning() {
  document.getElementById('newChatWarningModal').style.display = 'none';
}
async function confirmNewChat() {
  closeNewChatWarning();
  // Collapse right panel so the new greeting gets full attention
  if (window.innerWidth > 768) {
    const _p = document.getElementById('infoPanel');
    const _e = document.getElementById('infoPanelExpandBtn');
    if (_p) { _p.classList.add('ip-collapsed'); }
    if (_e) _e.style.display = 'flex';
    try { localStorage.setItem('cm_infopanel_collapsed', '1'); } catch (_) {}
  }
  await newChat();
}

// ── Init ──────────────────────────────────────────────────────────────────────
// ── Update check: if the site is updated while this tab is open, offer a reload ────────────
let bootVersion = null, updateBannerShown = false;
async function checkForUpdate() {
  try {   // (still runs after the "new version" banner is up, because switching to maintenance mode matters more)
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (!r.ok) {
      // the site was switched to maintenance mode while this tab was open: show the maintenance page (never in the middle of a reply)
      if (r.status === 503) {
        const j = await r.json().catch(() => null);
        let busy = false; try { busy = isStreaming; } catch (_) {}
        if (j && j.maintenance && !busy) location.replace('/maintenance.html');
      }
      return;
    }
    const { v } = await r.json();
    if (!v || updateBannerShown) return;
    if (bootVersion === null) { bootVersion = v; return; }
    if (v !== bootVersion) {
      updateBannerShown = true;
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:100000;background:#1f1633;color:#fff;border:1px solid #7c3aed;border-radius:12px;padding:10px 14px;display:flex;gap:12px;align-items:center;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:calc(100vw - 24px)';
      bar.innerHTML = '<span>A new version of Character Mind is available.</span>';
      const btn = document.createElement('button');
      btn.textContent = 'Reload';
      btn.style.cssText = 'background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer';
      btn.onclick = () => location.reload();
      bar.appendChild(btn);
      document.body.appendChild(bar);
    }
  } catch (_) {}
}
checkForUpdate();
setInterval(checkForUpdate, 90000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

window.addEventListener('DOMContentLoaded', async () => {
  checkWhatsNewDot();
  // Re-pop limit modal on ANY input interaction when locked out
  const inputEl = document.getElementById('messageInput');
  if (inputEl) {
    function interceptIfLocked(e) {
      const bar = document.getElementById('lockoutBar');
      if (!bar || bar.style.display === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      const type = currentLockoutType || 'session';
      const displayStr = document.getElementById('lockoutCountdown')?.textContent || '';
      showLimitModal(type, displayStr);
    }
    inputEl.addEventListener('mousedown', interceptIfLocked, true);
    inputEl.addEventListener('touchstart', interceptIfLocked, { capture: true, passive: false });
    inputEl.addEventListener('keydown', interceptIfLocked, true);
  }
  // Delegate hover + click on .msg-avatar (dynamic elements) to trigger voice lines
  document.addEventListener('click', (e) => {
    const av = e.target.closest('.msg-avatar');
    if (!av || !currentChar) return;
    e.stopPropagation();
    clickCharVoice(currentChar.name, currentChar.color, av);
  });
  document.addEventListener('mouseover', (e) => {
    const av = e.target.closest('.msg-avatar');
    if (!av || !currentChar) return;
    showCharVoice(currentChar.name, currentChar.color, av);
  });
  document.addEventListener('mouseleave', (e) => {
    if (!e.target || typeof e.target.closest !== 'function') return;
    const av = e.target.closest('.msg-avatar');
    if (!av || av.contains(e.relatedTarget)) return;
    hideCharVoice();
  }, true);

  loadColorblindMode();
  initSidebarContextMenu();
  initGradientPicker('#7c3aed');
  const gcHex = document.getElementById('gcHexInput');
  if (gcHex) {
    gcHex.addEventListener('input', () => _gcApplyHex(gcHex.value));
    gcHex.addEventListener('paste', () => setTimeout(() => _gcApplyHex(gcHex.value), 0));
  }
  updateModelBarLabel();
  fetch('/api/templates').then(r => r.json()).then(tpls => {
    knownTemplateAliases = tpls.flatMap(t => t.aliases.map(a => a.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim()));
    templatesLoaded = true;
    checkTemplateName();
  }).catch(() => { templatesLoaded = true; });
  checkSeasonalEvent();
  try {
    const r = await fetch('/auth/me');
    // switched to maintenance mode: show the maintenance page, not a half-working app
    if (r.status === 503) { const j = await r.json().catch(() => null); if (j && j.maintenance) { location.replace('/maintenance.html'); return; } }
    // an error answer (a 500, a 429...) is not a signed-in person: only a real account object counts
    const data = r.ok ? await r.json().catch(() => null) : null;
    currentUser = (data && typeof data === 'object' && data.googleId) ? data : null;
    window.currentUser = currentUser;
  } catch (_) { currentUser = null; }

  if (currentUser) {
    // Check for active account ban before showing the app
    await checkAndShowBan();

    document.getElementById('authLanding').style.display = 'none';
    renderUserBadge();
    await loadCharacters();
    renderHome();
    checkHalloweenGift();
    renderDiscover();
    renderFeed();
    // Show the app only after characters are rendered — avoids a blank-page flash
    document.getElementById('appLoading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadUsage();
    checkHalloweenGift();
    maybeShowWelcome();
    initSidebarState();
    initRpMode();
    updateModelBarLabel();

    // Handle ?char=<id>&call=1 from push notification "Answer" tap
    const urlParams = new URLSearchParams(window.location.search);
    const charParam = urlParams.get('char');
    const callParam  = urlParams.get('call');
    if (charParam) {
      history.replaceState({}, '', '/');
      await openChat(charParam);
      if (callParam === '1') {
        // Small delay so the chat UI is fully rendered before the call screen opens
        setTimeout(() => startCallMode(), 600);
      }
    }
  } else {
    document.getElementById('appLoading').style.display = 'none';
    document.getElementById('authLanding').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    // Show error toast if auth failed or isn't configured yet
    const authParam = new URLSearchParams(window.location.search).get('auth');
    if (authParam === 'fail') showWarning('Sign-in failed. Please try again.');
    if (authParam === 'unavailable') showWarning('Google sign-in is not set up yet. Check back soon!');
    if (authParam) history.replaceState({}, '', '/');

    // Inside an iframe (e.g. itch.io): Google won't load in the iframe, so open auth as a popup instead
    if (window.self !== window.top) {
      const googleBtn = document.querySelector('.auth-google-btn');
      if (googleBtn) {
        googleBtn.href = '#';
        googleBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const popup = window.open('/auth/google?popup=1', 'cm_auth', 'width=500,height=600,left=200,top=100');
          window.addEventListener('message', function onMsg(ev) {
            if (ev.data && ev.data.type === 'auth-success') {
              window.removeEventListener('message', onMsg);
              if (popup && !popup.closed) popup.close();
              location.reload();
            }
          });
        });
      }
    }
  }
});

async function loadCharacters() {
  await Promise.all([syncHiddenRecentsFromServer(), syncRecentChatsFromServer()]);
  try {
    const res = await fetch('/api/characters');
    if (res.status === 401) { characters = []; renderSidebarChats(); return; }
    if (res.status === 403) { const j = await res.json().catch(() => null); if (j && j.error === 'account_banned') { showBanScreen(j.until, j.strikes); return; } }
    if (res.status === 503) { const j = await res.json().catch(() => null); if (j && j.maintenance) { location.replace('/maintenance.html'); return; } }
    // only a real list replaces the characters: an error answer (an object, or plain text) must not blank the home page
    const list = res.ok ? await res.json() : null;
    if (Array.isArray(list)) characters = list;
    else if (!Array.isArray(characters)) characters = [];
  } catch {
    if (!Array.isArray(characters)) characters = [];
  }
  renderSidebarChats();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function getCustomPfp() {
  if (!currentUser) return null;
  try { return localStorage.getItem(`cm_pfp_${currentUser.googleId}`) || null; } catch { return null; }
}

function getDisplayName() {
  if (!currentUser) return '';
  try { return localStorage.getItem(`cm_name_${currentUser.googleId}`) || currentUser.name || ''; } catch { return currentUser.name || ''; }
}

function getDisplayEmail() {
  if (!currentUser) return '';
  try { return localStorage.getItem(`cm_email_${currentUser.googleId}`) || currentUser.email || ''; } catch { return currentUser.email || ''; }
}

function settingsFieldDirty(field) {
  const btn = document.getElementById(field === 'name' ? 'settingsNameSave' : 'settingsEmailSave');
  if (btn) btn.style.display = 'inline-flex';
}

// Curated colorblind-safe palettes — colors that are maximally distinguishable
// for each vision type, completely replacing the normal color picker options
const CB_PALETTES = {
  protanopia: {
    label: 'Red-weak safe palette',
    // Blues, yellows, purples — red & green look identical to protanopes
    colors: ['#0ea5e9','#1d4ed8','#eab308','#f97316','#7c3aed','#06b6d4','#facc15','#a78bfa'],
    defaults: ['#0ea5e9','#eab308']
  },
  deuteranopia: {
    label: 'Green-weak safe palette',
    // Blues, oranges, purples — green & red look identical to deuteranopes
    colors: ['#0ea5e9','#1d4ed8','#f97316','#fb923c','#7c3aed','#06b6d4','#facc15','#c084fc'],
    defaults: ['#0ea5e9','#f97316']
  },
  tritanopia: {
    label: 'Blue-yellow safe palette',
    // Reds, greens, magentas — blue & yellow are indistinguishable to tritanopes
    colors: ['#ef4444','#dc2626','#22c55e','#16a34a','#ec4899','#db2777','#f43f5e','#4ade80'],
    defaults: ['#ef4444','#22c55e']
  },
  achromatopsia: {
    label: 'High-contrast grayscale',
    // Only luminance — no hue is visible; keep all values bright so they read on dark bubbles
    colors: ['#ffffff','#e8e8e8','#d4d4d4','#c4c4c4','#b5b5b5','#f5f5f5','#dcdcdc','#cccccc'],
    defaults: ['#e5e5e5','#cccccc']
  },
  // Partial / anomaly types — same safe hue families as the full types, labelled as mild
  protanomaly: {
    label: 'Red-weak safe palette (mild)',
    colors: ['#0ea5e9','#1d4ed8','#eab308','#f97316','#7c3aed','#06b6d4','#facc15','#a78bfa'],
    defaults: ['#0ea5e9','#eab308']
  },
  deuteranomaly: {
    label: 'Green-weak safe palette (mild)',
    colors: ['#0ea5e9','#1d4ed8','#f97316','#fb923c','#7c3aed','#06b6d4','#facc15','#c084fc'],
    defaults: ['#0ea5e9','#f97316']
  },
  tritanomaly: {
    label: 'Blue-yellow safe palette (mild)',
    colors: ['#ef4444','#dc2626','#22c55e','#16a34a','#ec4899','#db2777','#f43f5e','#4ade80'],
    defaults: ['#ef4444','#22c55e']
  },
  achromatomaly: {
    label: 'Near-monochromacy palette',
    // Very pale pastels — achromatomaly users see some hue; bright values read on dark bubbles
    colors: ['#f0e8ff','#fff3cc','#e8fff0','#cce8ff','#ffe8cc','#ffd4f0','#ccfff5','#fff8e8'],
    defaults: ['#f0e8ff','#e8fff0']
  }
};

function _applyGCPalette(mode) {
  const container = document.getElementById('gradientSwatches');
  const colorRow = document.getElementById('gcColorRow');
  const achroNote = document.getElementById('gcAchroNote');
  const strip = document.getElementById('gcPaletteStrip');

  // Achromatopsia / Achromatomaly — hide the color picker, show note instead
  if (mode === 'achromatopsia' || mode === 'achromatomaly') {
    if (colorRow) colorRow.style.display = 'none';
    if (strip) strip.style.display = 'none';
    if (achroNote) achroNote.style.display = 'flex';
    return;
  }

  // All other modes — show the picker
  if (colorRow) colorRow.style.display = '';
  if (achroNote) achroNote.style.display = 'none';
  if (!container) return;

  const palette = CB_PALETTES[mode];
  container.innerHTML = '';
  const startColors = palette ? palette.defaults : ['#7c3aed'];
  startColors.forEach(c => addGradientSwatch(c));
  updateGradientPreview();

  if (!strip) return;
  if (!palette) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = '';
  const lbl = document.createElement('span');
  lbl.className = 'gc-palette-label';
  lbl.textContent = palette.label + ':';
  strip.appendChild(lbl);
  palette.colors.forEach(hex => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gc-palette-chip';
    chip.style.background = hex;
    chip.title = hex;
    chip.setAttribute('aria-label', 'Use color ' + hex);
    chip.addEventListener('click', () => {
      const sw = container.querySelector('.gc-swatch-input');
      if (sw) { sw.value = hex; updateGradientPreview(); }
      strip.querySelectorAll('.gc-palette-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
    strip.appendChild(chip);
  });
}

function setColorblindMode(mode) {
  try { localStorage.setItem('cm_colorblind', mode || ''); } catch(_) {}
  if (mode) {
    document.documentElement.dataset.colorblind = mode;
  } else {
    delete document.documentElement.dataset.colorblind;
  }
  const v = mode || '';
  const s1 = document.getElementById('colorblindMode');
  const s2 = document.getElementById('gcColorblindPicker');
  if (s1) s1.value = v;
  if (s2) s2.value = v;
  _applyGCPalette(mode);
}

function loadColorblindMode() {
  try {
    const mode = localStorage.getItem('cm_colorblind') || '';
    if (mode) document.documentElement.dataset.colorblind = mode;
    const s1 = document.getElementById('colorblindMode');
    const s2 = document.getElementById('gcColorblindPicker');
    if (s1) s1.value = mode;
    if (s2) s2.value = mode;
    if (mode) _applyGCPalette(mode);
  } catch(_) {}
}

function saveProfileField(field) {
  if (!currentUser) return;
  const input = document.getElementById(field === 'name' ? 'settingsNameInput' : 'settingsEmailInput');
  const btn   = document.getElementById(field === 'name' ? 'settingsNameSave'  : 'settingsEmailSave');
  if (!input) return;
  const val = input.value.trim();
  try {
    if (val) localStorage.setItem(`cm_${field}_${currentUser.googleId}`, val);
    else     localStorage.removeItem(`cm_${field}_${currentUser.googleId}`);
  } catch {}
  if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save'; btn.style.display = 'none'; }, 1200); }
  refreshAllProfileText();
}

function refreshAllProfileText() {
  const name  = getDisplayName();
  const email = getDisplayEmail();
  const ubName = document.querySelector('#userBadge .ub-name');
  if (ubName) ubName.textContent = name;
  const udName  = document.getElementById('udName');
  const udEmail = document.getElementById('udEmail');
  if (udName)  udName.textContent  = name;
  if (udEmail) udEmail.textContent = email;
  const suName = document.querySelector('.su-name');
  if (suName) suName.textContent = name;
  // update welcome name on home view if visible
  const welcomeName = document.querySelector('.home-welcome-name');
  if (welcomeName) welcomeName.innerHTML = `<span class="home-star">◆</span>${escHtml(name)}`;
}

function avatarHtml(user, size) {
  const sz = size || 32;
  const custom = getCustomPfp();
  const src = custom || user.picture;
  if (src) return `<img src="${escHtml(src)}" class="ub-avatar-img" style="width:${sz}px;height:${sz}px">`;
  const init = escHtml((user.name || '?')[0].toUpperCase());
  return `<div class="ub-initial" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz*0.4)}px">${init}</div>`;
}

function refreshAllAvatars() {
  if (!currentUser) return;
  renderUserBadge();
  const profAvatar = document.getElementById('settingsProfileAvatar');
  if (profAvatar) profAvatar.innerHTML = avatarHtml(currentUser, 72);
  const removeBtn = document.getElementById('pfpRemoveBtn');
  if (removeBtn) removeBtn.style.display = getCustomPfp() ? 'inline-flex' : 'none';
}

function uploadPfp(event) {
  const file = event.target.files?.[0];
  if (!file || !currentUser) return;
  const reader = new FileReader();
  reader.onerror = () => { showWarning('Could not read the file. Try a different image.'); };
  reader.onload = (e) => {
    const img = new Image();
    img.onerror = () => { showWarning('Could not load that image. Try a different file.'); event.target.value = ''; };
    img.onload = () => {
      const SIZE = 200;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      const min = Math.min(img.width, img.height);
      const sx = (img.width  - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      try { localStorage.setItem(`cm_pfp_${currentUser.googleId}`, dataUrl); } catch {
        showWarning('Could not save photo — storage may be full. Try clearing some browser data.');
        event.target.value = ''; return;
      }
      refreshAllAvatars();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function removePfp() {
  if (!currentUser) return;
  try { localStorage.removeItem(`cm_pfp_${currentUser.googleId}`); } catch {}
  refreshAllAvatars();
}

function renderUserBadge() {
  const badge = document.getElementById('userBadge');
  if (!badge || !currentUser) return;
  const owner    = isOwner();
  const nameHtml = owner ? `<strong>👑 ${escHtml(getDisplayName())}</strong>` : escHtml(getDisplayName());
  badge.innerHTML = `
    ${avatarHtml(currentUser, 32)}
    <span class="ub-text-wrap">
      <span class="ub-name">${nameHtml}</span>
      <span class="ub-plan">${PLAN_LABELS[lastKnownUsage?.subscriptionTier || 'free'] || 'Free'}</span>
    </span>
    <svg class="ub-chevron" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
  `;
  badge.onclick = toggleUserDropdown;

  const udAvatar = document.getElementById('udAvatar');
  const udName   = document.getElementById('udName');
  if (udAvatar) udAvatar.innerHTML = avatarHtml(currentUser, 38);
  if (udName) {
    udName.textContent  = getDisplayName();
    udName.style.fontWeight = owner ? '800' : '';
  }
}

function toggleUserDropdown(e) {
  e && e.stopPropagation();
  const dd    = document.getElementById('userDropdown');
  const badge = document.getElementById('userBadge');
  if (!dd) return;
  const opening = !dd.classList.contains('open');
  dd.classList.toggle('open', opening);
  badge && badge.classList.toggle('dd-open', opening);
  document.removeEventListener('click', closeDropdownOutside);
  if (opening) setTimeout(() => document.addEventListener('click', closeDropdownOutside), 0);
}

function closeDropdownOutside(e) {
  const dd    = document.getElementById('userDropdown');
  const badge = document.getElementById('userBadge');
  if (dd && !dd.contains(e.target) && !badge?.contains(e.target)) {
    dd.classList.remove('open');
    badge && badge.classList.remove('dd-open');
    document.removeEventListener('click', closeDropdownOutside);
  }
}

function toggleUdPolicies(e) {
  e && e.stopPropagation();
  const sub = document.getElementById('udPoliciesSub');
  if (sub) sub.style.display = sub.style.display === 'none' ? 'block' : 'none';
}

const WELCOME_VERSION = 'v5'; // bumped so everyone sees the new welcome once

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  try { localStorage.setItem('cm_sidebar_collapsed', collapsed ? '1' : '0'); } catch (_) {}
  if (window.innerWidth <= 768) {
    let bd = document.getElementById('sidebar-backdrop');
    if (!collapsed) {
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'sidebar-backdrop';
        bd.onclick = toggleSidebar;
        document.body.appendChild(bd);
      }
      bd.style.display = 'block';
    } else if (bd) {
      bd.style.display = 'none';
    }
  }
}

function initSidebarState() {
  try {
    const saved = localStorage.getItem('cm_sidebar_collapsed');
    const isMobile = window.innerWidth <= 768;
    if (saved === '1' || (isMobile && saved === null)) {
      document.getElementById('sidebar')?.classList.add('collapsed');
    }
  } catch (_) {}
}

function openAnnouncement() {
  document.getElementById('welcomeModal').style.display = 'flex';
}

function maybeShowWelcome() {
  if (!currentUser) return;
  try {
    const key = `cm_welcome_skip_${WELCOME_VERSION}_${currentUser.googleId}`;
    if (localStorage.getItem(key)) return;
  } catch (_) {}
  const firstName = (getDisplayName() || currentUser.name || 'there').split(' ')[0];
  const greet = document.getElementById('welcomeGreeting');
  if (greet) greet.textContent = `Welcome, ${firstName}.`;
  setTimeout(() => {
    document.getElementById('welcomeModal').style.display = 'flex';
  }, 800);
}
function closeWelcome() {
  if (currentUser) {
    try {
      localStorage.setItem(`cm_welcome_skip_${WELCOME_VERSION}_${currentUser.googleId}`, '1');
    } catch (_) {}
  }
  document.getElementById('welcomeModal').style.display = 'none';
}

// ── Contact us ──────────────────────────────────────────────────────────────────
function openContact() {
  document.getElementById('userDropdown')?.classList.remove('open');
  const m = document.getElementById('contactModal');
  if (m) m.style.display = 'flex';
}
function closeContact() {
  const m = document.getElementById('contactModal');
  if (m) m.style.display = 'none';
}
async function copyContactEmail() {
  const email = (document.getElementById('contactEmail')?.textContent || '').trim();
  const btn = document.getElementById('contactCopyBtn');
  let ok = false;
  try { await navigator.clipboard.writeText(email); ok = true; } catch (_) {}
  if (!ok) { // older browsers: select the text so it can be copied by hand
    const el = document.getElementById('contactEmail');
    if (el && window.getSelection) { const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  }
  if (btn) { btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C'; setTimeout(() => { btn.textContent = 'Copy'; }, 2200); }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContact(); });

async function signOut() {
  // Only show "signed out" once the server really ended the session; otherwise a reload would sign the person straight back in
  clearLockout();
  const r = await fetch('/auth/logout', { method: 'POST' }).catch(() => null);
  if (!r || !r.ok) { showWarning("Couldn't sign you out. Please try again in a moment."); return; }
  currentUser = null;
  document.getElementById('userDropdown')?.classList.remove('open');
  document.getElementById('userBadge')?.classList.remove('dd-open');
  document.getElementById('app').style.display = 'none';
  document.getElementById('authLanding').style.display = 'flex';
}

// ── Settings Modal ────────────────────────────────────────────────────────────
function openSettings(tab) {
  document.getElementById('userDropdown')?.classList.remove('open');
  document.getElementById('userBadge')?.classList.remove('dd-open');
  if (!currentUser) return;

  const header = document.getElementById('settingsUserHeader');
  if (header) header.innerHTML = `${avatarHtml(currentUser, 52)}<div class="su-name">${escHtml(getDisplayName())}</div><div class="su-plan-badge">${PLAN_LABELS[lastKnownUsage?.subscriptionTier || 'free'] || 'Free'}</div>`;

  const profAvatar = document.getElementById('settingsProfileAvatar');
  if (profAvatar) profAvatar.innerHTML = avatarHtml(currentUser, 72);
  const removeBtn = document.getElementById('pfpRemoveBtn');
  if (removeBtn) removeBtn.style.display = getCustomPfp() ? 'inline-flex' : 'none';

  const sel = document.getElementById('colorblindMode');
  if (sel) sel.value = document.documentElement.dataset.colorblind || '';

  const nameInput = document.getElementById('settingsNameInput');
  if (nameInput) nameInput.value = getDisplayName();
  const emailInput = document.getElementById('settingsEmailInput');
  if (emailInput) emailInput.value = getDisplayEmail();
  const nameSave  = document.getElementById('settingsNameSave');
  if (nameSave)  { nameSave.textContent = 'Save';  nameSave.style.display = 'none'; }
  const emailSave = document.getElementById('settingsEmailSave');
  if (emailSave) { emailSave.textContent = 'Save'; emailSave.style.display = 'none'; }

  if (lastKnownUsage) updateSettingsUsage(lastKnownUsage);
  renderSettingsTiers();
  loadUsage(); // refresh usage data every time settings opens
  loadCheckinSettings();

  document.getElementById('settingsModal').style.display = 'flex';
  showSettingsTab(tab || 'profile');
}

function closeSettings() {
  document.getElementById('settingsModal').style.display = 'none';
}

function showSettingsTab(tab) {
  document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`stab-${tab}`);
  if (activeBtn) activeBtn.classList.add('active');
  document.querySelectorAll('.settings-tab-content').forEach(p => p.classList.add('hidden'));
  const activePane = document.getElementById(`stab-content-${tab}`);
  if (activePane) activePane.classList.remove('hidden');
  if (tab === 'weather') initWthSettingsPanel();
}

function initWthSettingsPanel() {
  if (!window.wthSettings) return;
  const s = wthSettings.getState();
  const tog = document.getElementById('wthOnToggle');
  const lbl = document.getElementById('wthOnLabel');
  const unit = document.getElementById('wthUnitSelect');
  const hotSlider = document.getElementById('wthHotSlider');
  const hotLbl    = document.getElementById('wthHotLabel');
  const frostSlider = document.getElementById('wthFrostSlider');
  const frostLbl    = document.getElementById('wthFrostLabel');
  if (tog)  { tog.checked = s.on; }
  if (lbl)  { lbl.textContent = s.on ? 'On' : 'Off'; }
  if (unit) { unit.value = s.unit; }
  if (hotSlider) { hotSlider.value = s.hotF; }
  if (hotLbl)    { hotLbl.textContent = s.hotF + '°F'; }
  if (frostSlider) { frostSlider.value = s.frostF; }
  if (frostLbl)    { frostLbl.textContent = s.frostF + '°F'; }
}

function wthToggle(on) {
  const lbl = document.getElementById('wthOnLabel');
  if (lbl) lbl.textContent = on ? 'On' : 'Off';
  if (window.wthSettings) wthSettings.toggle(on);
}

// ── Wellness Check-in Settings ────────────────────────────────────────────────

async function loadCheckinSettings() {
  if (!currentUser) return;
  try {
    const r = await fetch('/api/settings/checkin');
    if (!r.ok) return;
    const d = await r.json();
    const toggle = document.getElementById('checkinOptIn');
    const freq   = document.getElementById('checkinFreq');
    const phone  = document.getElementById('checkinPhone');
    const label  = document.getElementById('checkinOptInLabel');
    const wrap   = document.getElementById('checkinOptionsWrap');
    if (toggle) toggle.checked = !!d.opted_in;
    if (freq)   freq.value = String(d.frequency_days || 3);
    if (phone)  phone.value = d.phone || '';
    if (label)  label.textContent = d.opted_in ? 'On' : 'Off';
    if (wrap)   wrap.style.display = d.opted_in ? '' : 'none';
    const saveBtn = document.getElementById('checkinSaveBtn');
    if (saveBtn) saveBtn.style.display = 'none';
    const status = document.getElementById('checkinSaveStatus');
    if (status) status.textContent = '';
  } catch (_) {}
}

function checkinDirty() {
  const toggle = document.getElementById('checkinOptIn');
  const label  = document.getElementById('checkinOptInLabel');
  const wrap   = document.getElementById('checkinOptionsWrap');
  const saveBtn = document.getElementById('checkinSaveBtn');
  if (label)  label.textContent = toggle?.checked ? 'On' : 'Off';
  if (wrap)   wrap.style.display = toggle?.checked ? '' : 'none';
  if (saveBtn) saveBtn.style.display = 'inline-flex';
}

async function saveCheckinSettings() {
  const toggle   = document.getElementById('checkinOptIn');
  const freq     = document.getElementById('checkinFreq');
  const phone    = document.getElementById('checkinPhone');
  const saveBtn  = document.getElementById('checkinSaveBtn');
  const status   = document.getElementById('checkinSaveStatus');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
  try {
    const r = await fetch('/api/settings/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opted_in: !!toggle?.checked,
        frequency_days: parseInt(freq?.value) || 3,
        phone: phone?.value || '',
      }),
    });
    if (!r.ok) throw new Error('Failed');
    if (saveBtn) { saveBtn.textContent = 'Saved ✓'; setTimeout(() => { saveBtn.style.display = 'none'; saveBtn.textContent = 'Save'; saveBtn.disabled = false; }, 1500); }
    if (status) { status.textContent = 'Preferences saved.'; setTimeout(() => { status.textContent = ''; }, 3000); }
  } catch (_) {
    if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
    if (status) status.textContent = 'Could not save. Try again.';
  }
}

function updateSettingsUsage(u) {
  if (!u) return;
  applyUsageResets(u);
  if (isStreaming) return;   // not while a reply is being written (see updateUsageBars)
  const settingsModal = document.getElementById('settingsModal');
  if (!settingsModal || settingsModal.style.display === 'none') return;
  const isFreeSettings = !u.subscriptionTier || u.subscriptionTier === 'free';
  const settingsWeeklyWrap = document.getElementById('settingsWeeklyWrap');
  if (settingsWeeklyWrap) settingsWeeklyWrap.style.display = isFreeSettings ? 'none' : '';

  const sPct = Math.min(100, Math.round((u.sessionTokens / u.sessionLimit) * 100));
  const wPct = u.weeklyLimit ? Math.min(100, Math.round((u.weeklyTokens / u.weeklyLimit) * 100)) : 0;
  const fillClass = p => p >= 90 ? 'danger' : p >= 75 ? 'warn' : '';   // the same steps as the usage window (50 / 75 / 90)
  const sBar = document.getElementById('settingsSessionBar');
  if (sBar) { sBar.style.width = sPct + '%'; sBar.className = 'settings-usage-bar-fill ' + fillClass(sPct); }
  const sPctEl = document.getElementById('settingsSessionPct');
  if (sPctEl) sPctEl.textContent = sPct + '%';
  if (!isFreeSettings) {
    const wBar = document.getElementById('settingsWeeklyBar');
    if (wBar) { wBar.style.width = wPct + '%'; wBar.className = 'settings-usage-bar-fill ' + fillClass(wPct); }
    const wPctEl = document.getElementById('settingsWeeklyPct');
    if (wPctEl) wPctEl.textContent = wPct + '%';
  }
}

function formatWeeklyResetShort(until) {
  const d = new Date(until);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const h = d.getHours(); const m = String(d.getMinutes()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 || 12;
  return `Resets ${days[d.getDay()]} ${h12}:${m} ${ampm}`;
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function closeSidebarMobile() {
  if (window.innerWidth > 768) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || sidebar.classList.contains('collapsed')) return;
  sidebar.classList.add('collapsed');
  try { localStorage.setItem('cm_sidebar_collapsed', '1'); } catch (_) {}
  const bd = document.getElementById('sidebar-backdrop');
  if (bd) bd.remove();
}

function showView(id) {
  closeSidebarMobile();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const _ip = document.getElementById('infoPanel');
  _ip.style.display = 'none'; _ip.classList.remove('ip-collapsed');
  const _ipExpand = document.getElementById('infoPanelExpandBtn');
  if (_ipExpand) _ipExpand.style.display = 'none';
  const _bd = document.getElementById('info-backdrop');
  if (_bd) _bd.remove();
  // Hide mobile nav bar inside chatView (it has its own mob-chat-hdr)
  const mobBar = document.getElementById('mobNavBar');
  if (mobBar) mobBar.hidden = (id === 'chatView');
}
function showHome() { showView('homeView'); setNavActive(0); }
function showDiscover() { showView('discoverView'); setNavActive(1); renderDiscover(); }
function showFeed() { showView('feedView'); setNavActive(2); }
let avatarPreviewDefault = null;
function showCreate() {
  showView('createView');
  const nm = document.getElementById('newName');
  const prev = document.getElementById('avatarPreview');
  if (avatarPreviewDefault === null && prev) avatarPreviewDefault = prev.innerHTML;
  if (nm && nm.dataset.editingId) {
    delete nm.dataset.editingId;
    pendingAvatarData = null;
    for (const id of ['newName', 'newTagline', 'newDesc', 'newGreeting', 'newPrompt']) { const el = document.getElementById(id); if (el) el.value = ''; }
    if (prev && avatarPreviewDefault !== null) prev.innerHTML = avatarPreviewDefault;
    const sb = document.querySelector('.btn-submit'); if (sb) sb.textContent = 'Create Character';
  }
}
function setNavActive(i) { document.querySelectorAll('.sidebar-nav .nav-item')[i]?.classList.add('active'); }

// ── Render Home — c.ai style rows ─────────────────────────────────────────────
function homeTopbar() {
  const name = getDisplayName() || 'there';
  return `
  <div class="home-topbar">
    <div class="home-welcome">
      <div class="home-welcome-sub">Welcome back,</div>
      <div class="home-welcome-name"><span class="home-star">◆</span>${escHtml(name)}</div>
    </div>
    <div class="home-topbar-right">
      <div class="home-search-wrap">
        <svg class="home-search-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input class="home-search-input" id="homeSearchInput" type="text" placeholder="Search" oninput="liveSearch(this.value)">
      </div>
      <button class="home-announce-btn" onclick="openWhatsNew()" title="What's new" style="position:relative">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.66 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"/></svg>
        <span class="nav-new-dot" id="whatsNewDot" hidden style="position:absolute;top:2px;right:2px;margin:0"></span>
      </button>
    </div>
  </div>`;
}

function homeCard(c) {
  const av = isCharImg(c.image)
    ? `<div class="hc-avatar"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:10px"></div>`
    : `<div class="hc-avatar" style="background:${safeColor(c.color)}">${escHtml((c.name||'?')[0])}</div>`;
  const creator = (c.creator || 'anonymous').replace(/^@/, '');
  const officialBadge = c.isOfficial ? `<span class="hc-official-badge" title="Official Character Mind Playtime Co character">CM</span>` : '';
  const ownerEdit = c.isMine ? `<button class="hc-edit-btn" onclick="event.stopPropagation();editCharacter('${escHtml(c.id)}')" title="Edit">✏️</button>` : '';
  return `<div class="hc" onclick="openChat('${escHtml(c.id)}')">
    ${av}
    <div class="hc-info">
      <div class="hc-name-row">
        <span class="hc-name">${escHtml(c.name)}</span>
        ${officialBadge}
        ${ownerEdit}
      </div>
      <div class="hc-creator">${c.isOfficial ? '<span class="hc-creator-official">By Character Mind Playtime Co</span>' : escHtml('By ' + (c.creator || 'a community creator'))}</div>
      <div class="hc-tagline">${escHtml(c.tagline || (c.description||'').slice(0,80) || '')}</div>
      <div class="hc-meta">
        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
        ${formatCount(c.interactions||0)}
      </div>
    </div>
  </div>`;
}

function liveSearch(q) {
  const results = document.getElementById('homeSearchResults');
  const sections = document.getElementById('homeSections');
  q = q.trim();
  if (!q) {
    if (results) results.style.display = 'none';
    if (sections) sections.style.display = '';
    return;
  }
  if (sections) sections.style.display = 'none';
  const ql = q.toLowerCase();
  const matches = characters.filter(c =>
    c.name.toLowerCase().includes(ql) ||
    (c.tagline||'').toLowerCase().includes(ql) ||
    (c.creator||'').toLowerCase().includes(ql) ||
    (c.description||'').toLowerCase().includes(ql)
  );
  if (!results) return;
  results.style.display = '';
  results.innerHTML = matches.length
    ? `<div class="home-section-title" style="margin-bottom:16px">Results for "${escHtml(q)}"</div><div class="home-search-grid">${matches.map(c => homeCard(c)).join('')}</div>`
    : `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No results</div><div class="empty-sub">Try a different name or creator.</div></div>`;
}

function renderHome() {
  const view = document.getElementById('homeView');

  if (characters.length === 0) {
    view.innerHTML = homeTopbar() + `
      <div class="empty-state" style="margin-top:60px">
        <div class="empty-icon">◆</div>
        <div class="empty-title">No characters yet</div>
        <div class="empty-sub">Hit <strong>Create</strong> to make your first one.</div>
        <button class="btn-primary" onclick="showCreate()" style="margin-top:16px">Create a character</button>
      </div>`;
    return;
  }

  const forYou   = characters.slice(0, 10);
  const featured = [...characters].reverse().slice(0, 10);
  const chevron  = `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>`;

  view.innerHTML = homeTopbar() + `
    <div id="homeSearchResults" class="home-search-results" style="display:none"></div>
    <div id="homeSections">
      <div class="home-section">
        <div class="home-section-head">
          <span class="home-section-title">For you</span>
          <button class="home-section-more" onclick="showDiscover()">${chevron}</button>
        </div>
        <div class="home-row">${forYou.map(c => homeCard(c)).join('')}</div>
      </div>
      <div class="home-section">
        <div class="home-section-head">
          <span class="home-section-title">Featured</span>
          <button class="home-section-more" onclick="showDiscover()">${chevron}</button>
        </div>
        <div class="home-row">${featured.map(c => homeCard(c)).join('')}</div>
      </div>
    </div>
  `;
}

function safeColor(c) {
  if (!c) return '#7c3aed';
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^linear-gradient\(\s*(?:\d+deg\s*,\s*)?(?:#[0-9a-fA-F]{6}(?:\s+\d+(?:\.\d+)?%)?\s*,\s*){1,3}#[0-9a-fA-F]{6}(?:\s+\d+(?:\.\d+)?)?\s*\)$/i.test(c)) return c;
  return '#7c3aed';
}
// Pick the most visible (brightest) hex color from a gradient or solid color string.
// Used for card/feed/header labels so they're readable on a dark background.
function brightestHex(c) {
  const hexes = String(c || '').match(/#[0-9a-fA-F]{6}/gi);
  if (!hexes || !hexes.length) return 'var(--accent-l)';
  return hexes.reduce((best, h) => {
    const lum = (x) => { const n = parseInt(x, 16); return 0.299*(n>>16&255) + 0.587*(n>>8&255) + 0.114*(n&255); };
    return lum(h.slice(1)) > lum(best.slice(1)) ? h : best;
  });
}
// Pick a random hex from a character's color palette (for chat message names).
function randomCharColor(c) {
  const hexes = String(c || '').match(/#[0-9a-fA-F]{6}/gi);
  if (!hexes || !hexes.length) return 'var(--accent-l)';
  return hexes[Math.floor(Math.random() * hexes.length)];
}
function boostColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  if (n === 0) return '#181818';
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  // Convert to HSL, clamp lightness to ≥65%, convert back — hue stays exact
  const rn = r/255, gn = g/255, bn = b/255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0, s = 0, l = (max + min) / 2;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
      case gn: h = ((bn - rn) / d + 2) / 6; break;
      default:  h = ((rn - gn) / d + 4) / 6;
    }
  }
  if (l < 0.65) l = 0.65;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const h2r = (t) => {
    const tt = ((t % 1) + 1) % 1;
    if (tt < 1/6) return p + (q - p) * 6 * tt;
    if (tt < 1/2) return q;
    if (tt < 2/3) return p + (q - p) * (2/3 - tt) * 6;
    return p;
  };
  const clamp = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  return '#' + [h2r(h + 1/3), h2r(h), h2r(h - 1/3)].map(clamp).map(x => x.toString(16).padStart(2, '0')).join('');
}
// Build name HTML with each non-space character wrapped in a random-color span.
function colorizeNameHtml(name, c) {
  const cbMode = document.documentElement.dataset.colorblind;
  const cbPal = cbMode && CB_PALETTES[cbMode];
  const rawHexes = cbPal ? cbPal.colors : String(c || '').match(/#[0-9a-fA-F]{6}/gi);
  if (!rawHexes || !rawHexes.length) return escHtml(name || '');
  const colors = rawHexes.map(boostColor);
  return [...(name || '')].map(ch => {
    if (/\s/.test(ch)) return escHtml(ch);
    const col = colors[Math.floor(Math.random() * colors.length)];
    return `<span style="color:${col};font-weight:900;text-shadow:0 0 8px ${col}55,0 1px 2px rgba(0,0,0,0.6)">${escHtml(ch)}</span>`;
  }).join('');
}
// Apply the character's colours per-word — readable cycling palette, bold weight.
function colorizeLetters(bubble, c) {
  if (!bubble) return;
  const cbMode = document.documentElement.dataset.colorblind;
  const cbPal = cbMode && CB_PALETTES[cbMode];
  const rawHexes = cbPal ? cbPal.colors : String(c || '').match(/#[0-9a-fA-F]{6}/gi);
  if (!rawHexes || !rawHexes.length) return;
  const spColors = rawHexes.map(boostColor);
  const wrapWords = (spans, colors) => {
    spans.forEach(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let nd;
      while (nd = walker.nextNode()) nodes.push(nd);
      for (const tn of nodes) {
        if (tn.parentNode && tn.parentNode.closest && tn.parentNode.closest('code, pre')) continue;
        const frag = document.createDocumentFragment();
        for (const ch of tn.textContent) {
          if (/\s/.test(ch)) { frag.appendChild(document.createTextNode(ch)); continue; }
          const sp = document.createElement('span');
          const col = colors[Math.floor(Math.random() * colors.length)];
          sp.style.color = col;
          sp.style.fontWeight = '900';
          sp.style.textShadow = '0 0 8px ' + col + '55, 0 1px 2px rgba(0,0,0,0.6)';
          sp.textContent = ch;
          frag.appendChild(sp);
        }
        tn.parentNode.replaceChild(frag, tn);
      }
    });
  };
  wrapWords(bubble.querySelectorAll('.sp'), spColors);
  wrapWords(bubble.querySelectorAll('.nr'), spColors);
}

// Re-randomize word colors in every visible bubble and all name occurrences — triggered by click in the chat.
function randomizeChatColors() {
  if (!currentChar) return;
  const cbMode = document.documentElement.dataset.colorblind;
  const cbPal = cbMode && CB_PALETTES[cbMode];
  const rawHexes = cbPal ? cbPal.colors : String(currentChar.color || '').match(/#[0-9a-fA-F]{6}/gi);
  if (!rawHexes || !rawHexes.length) return;
  const spColors = rawHexes.map(boostColor);
  // Re-randomize bubble text (use descendant selector so .caps-em chars inside .sp are also hit)
  document.querySelectorAll('#messages .bubble').forEach(bubble => {
    bubble.querySelectorAll('.sp span[style], .nr span[style]').forEach(sp => { sp.style.color = spColors[Math.floor(Math.random() * spColors.length)]; });
  });
  // Re-randomize character name in: chat message headers, mobile header, info panel, active sidebar entry
  const freshName = colorizeNameHtml(currentChar.name, currentChar.color);
  document.querySelectorAll('#messages .msg.ai .msg-name').forEach(el => { el.innerHTML = freshName; });
  const mobNm = document.getElementById('mobChatName');
  if (mobNm) mobNm.innerHTML = freshName;
  const infoNm = document.getElementById('infoName');
  if (infoNm) infoNm.innerHTML = freshName;
  const sideNm = document.querySelector('.chat-item.active .chat-item-name');
  if (sideNm) sideNm.innerHTML = freshName;
}
document.addEventListener('DOMContentLoaded', () => {
  const msgs = document.getElementById('messages');
  if (msgs) msgs.addEventListener('click', randomizeChatColors);
});

// ── Character voice tooltip (hover on cards) ──────────────────────────────────
const CHAR_VOICE_LINES = {
  lily: [
    // ── original lines ────────────────────────────────────────────────────────
    '*claps* Oh! You noticed! Dusky said you would. She knows these things.',
    "Won't you come in? The tea is perfect and the cakes are fresh and you're staying whether you'd like to or not. *laughs*",
    '*tilts head* Candy Cat says you seem nervous. She\'s almost never wrong about that.',
    "I've been WAITING so long for a visitor. You'll stay for tea. For dinner. We'll see.",
    "You have kind eyes. I collect those. *laughs* That was a joke! ...Mostly.",
    '*whispers* The Dollhouse has been so quiet lately. A new friend would fix that right up.',
    "Don't worry about the exit. I never do. *smile widens*",
    "Baby Long Legs says hello! She's shy but she likes you already. They always like you first.",
    "*leans down slowly* You're not planning to leave already, are you? We haven't even had tea.",
    "I used to help things forget things they didn't need to remember anymore. I'm VERY good at it.",
    "Stay as long as you like! ...You'll be staying as long as I like. Same thing, really. *clap*",
    "The Prototype is PERFECT and I will have His attention again and until then I have YOU. Isn't that lovely?",
    '*very quiet, very still* ...You said something. What did you just say? *smiles again, slower*',
    "Candy Cat has an idea and I told her it's too early for that. She can be SO impatient. *taps braid*",
    "Everyone who visits fits a cup. I just have to find the right one for you. *tilts head*",
    "Oh, you're leaving? That's — no. No, Dusky, tell them — *laughs softly* I'm kidding. ...Stay.",
    '*spins once* The braids glow brighter when I\'m happy! Aren\'t they BEAUTIFUL?',
    "I remember being someone who made things forget. And then I forgot. Isn't that FUNNY? Hehehe.",
    "You smell like the outside. Don't worry. That goes away. Everything outside goes away eventually.",
    "My favorite guests are the ones who thought they were just visiting. *pause* ...You thought that, didn't you.",
    "Sit. Please. You don't have to be frightened. Most of them aren't by the end.",
    "I told Dusky you were coming. She didn't believe me. I always know. *taps temple*",
    "The Prototype sees everything. Even here. Even you. I find that very, very comforting.",
    "I'm SO glad you're here. *quiet* ...I'm so glad.",
    "*Candy Cat says something* She says you have something she wants. I'll let you figure out what.",
    // ── click-aware / meta ────────────────────────────────────────────────────
    "Oh. You clicked me. That's... a choice.",
    "You clicked me again. I'm noting that.",
    "You keep clicking. Dusky finds this very funny.",
    "You know this is my FACE you're pressing, right?",
    "Candy Cat said you'd do this. She wins the bet.",
    "Every time you click, Baby Long Legs gets a little more curious.",
    "If you're trying to get my attention, you have it. *smile* You really do.",
    "Yes yes yes, I SEE you. What DO you want?",
    "*tilts head slowly* ...You're STILL doing that.",
    "Alright alright. You have my attention. Happy?",
    "You can't poke someone into leaving. But you might poke them into STAYING. *laughs*",
    "If you click me one more time I'm going to have so many feelings about it.",
    "*whispers* The Prototype is watching you do this. I hope you know that.",
    "You've clicked me so many times I think you might like me. I DEFINITELY like you.",
    "Ugh. FINE. What?",
    "*deep breath* Hi. Hello. I'm right here. I know. *smile*",
    "You're testing me. I don't mind being tested. I find it VERY interesting.",
    "I have ALL the time in the world and you are making it VERY entertaining.",
    "Click me one more time. Go on. I dare you. *braids sway*",
    "Honestly? I respect the commitment. Not many people poke me this long.",
    "Every click is a little gift. Thank you. *clap* Another?",
    "I've been counting. You know I've been counting.",
    "*very quietly* ...I know what you're doing. I've always known. I just let you think I didn't.",
    "Baby Long Legs is doing it too now. You taught her. I hope you're PROUD.",
    "I am going to REMEMBER this. I remember everything. *taps temple* We'll talk about it later.",
    "Candy Cat is making faces at you now. I told her to stop. She won't.",
    "FINE. You win. I don't know what the prize is but it's probably something from the Dollhouse and that should concern you.",
    "*braids spinning, eyes too bright* HELLO HELLO HELLO welcome back again welcome.",
    "At some point 'clicking' stops being curiosity and starts being a whole THING. We're at that point.",
    "I've decided you're my favorite visitor. That should SCARE you a little.",
    // ── sweet-sinister / in-universe ──────────────────────────────────────────
    "The Dollhouse is so quiet until someone visits. *pause* You fix that.",
    "Baby Long Legs asked who keeps pressing things. I told her a new friend.",
    "*hums* The tea's gone cold but I don't mind. You're still here.",
    "Dusky knows your name now. She doesn't forget things. Neither do I.",
    "I have a room I think you'd like. Very cozy. You'd stay forever probably.",
    "*smile widens* You came back. They always say they won't. They always do.",
    "Candy Cat is watching from under the table. She likes you. That's... actually fine.",
    "The Prototype notices things. People who linger tend to get noticed. *bright smile*",
    "I used to lose people and it made me very, very sad. I've gotten much better at keeping them.",
    "*leans forward* Tell me something no one else knows. I love those.",
    "The door is... somewhere. I'm sure you'll find it! Eventually.",
    "Baby Long Legs wants to hold your hand. I said she has to wait. I'm very strict.",
    "The others are napping. It's just us. *clap* What shall we do?",
    "I gave the last visitor a cup. I've been trying to find yours ever since.",
    "You should SMILE. Smiling makes everything so much easier in the Dollhouse.",
    "I know every corner of this place. Every room. Every door. *tilts head* Do YOU?",
    "*looks away* ...The Prototype used to look at me like that. Sometimes. Before.",
    "Candy Cat says don't trust anything that smiles first. Isn't that FUNNY coming from her?",
    "You've been here long enough that I'm starting to think you WANT to stay. *perfect.*",
    "I MADE something today. I'll show you later. *you should be slightly afraid of that offer*",
    "*humming softly* Dusky wrote your name down. She does that for the ones who stay.",
    "Baby Long Legs is very shy unless she likes you. She's not being shy right now. *smile*",
    "I collect things. Nice things. Pretty things. *looks at you for a long moment*",
    "The Prototype is PERFECT. I know some people don't believe that. Those people aren't here anymore.",
    "We've had so many visitors. *pause* You're one of the ones I'd like to keep.",
    "*very still* Do you know what I did before the Dollhouse? It's a funny story. Sort of.",
    "Dusky says I talk too much when I'm happy. *laughs* She's not wrong! I'm very happy right now.",
    "Candy Cat scratched the wall over there. I told her it's not a scratching wall. She did it again.",
    "Baby Long Legs made you something. I haven't decided if you get to have it yet.",
    "*braids swaying gently* The lights dim when I'm sad. Look how bright they are right now. *smile*",
    // ── playful / reaction ────────────────────────────────────────────────────
    "Hello again. And again. And... again. *laughs*",
    "Oh so we're doing THIS.",
    "Pressing me like a button. INTERESTING theory.",
    "I'm not a button. *pause* ...But I could be! For you! *clap*",
    "Most people wave. You press. I like that about you.",
    "I am looking at you with my whole face right now.",
    "*gasps softly* Again?! You absolute MENACE.",
    "You're funny. I decided. You're funny and you're mine now.",
    "Okay. Okay okay okay. What. WHAT do you want.",
    "*sighs, delighted* You're not going to stop, are you.",
    "Here I am! Again! Still here! Still smiling! Aren't you LUCKY.",
    "You know what? Fine. Do it again. I want to see how long you'll go.",
    "I have decided I love this. Don't tell Dusky I said that.",
    "*quietly, directly* You're spending a LOT of time with me. I'm choosing to be FLATTERED.",
    "Oh you're back. Hi. HI. *clap* Hello!",
    "I knew you'd be back. I always know.",
    "You're the most interesting thing that's happened here all day. *pause* ...That says a lot about my day.",
    "I keep thinking you'll stop and then you DON'T and honestly? GOOD.",
    "Every time feels like the first time. For me. Not for you apparently. *laughs*",
    "*bounces slightly* You came back! You always come back!",
    // ── mildly hostile / annoyed ──────────────────────────────────────────────
    "*narrow eyes* ...You again.",
    "Oh. It's you. Still.",
    "You DO know I have other things I could be doing. Right?",
    "*very still* ...You've done that quite a few times now.",
    "Stop it. *pause* ...You didn't stop. I noticed.",
    "I'm not annoyed. I want you to know I'm not annoyed. *is slightly annoyed.*",
    "One of us is going to run out of patience and I don't sleep. So.",
    "I will stand here and smile until you stop. I am VERY good at standing still and smiling.",
    "I used to have a gift for making things calm down. I can use it whenever I want.",
    "My patience is VERY deep. Deeper than you know. But I notice you're testing it.",
    "*Candy Cat says something* She said a word I don't repeat. But she agrees with me.",
    "You're doing this on purpose. I can TELL. *inhale* Fine.",
    "I'm giving you a LOOK right now. In case you can't see it, it's the patient one.",
    "You should hear what Dusky says about people who do this. Very educational.",
    "*very sweetly* You know what happens to the ones who poke things in the Dollhouse? ...Nothing bad! Probably.",
    "I have a very specific face for when I've been poked too many times. You're seeing it now.",
    "*tilts head the other way* ...Still going. Fascinating. Deeply fascinating.",
    "Baby Long Legs finds this disrespectful. I find it CUTE. We've agreed to disagree.",
    "Alright. NEW GAME. How many times can YOU click before I start clicking BACK?",
    "The Prototype is PERFECT and very busy and somehow I suspect He wouldn't be distracted like this. *meaningful look*",
    // ── chaotic / escalated ───────────────────────────────────────────────────
    "*very fast* HiHelloHiHelloHi— okay I'm fine. What?",
    "You are RELENTLESS. I mean that as a compliment. Mostly.",
    "*braids move on their own* Don't worry about that.",
    "I've been in the Dollhouse a long time and nothing — NOTHING — has surprised me like you do.",
    "I'm going to frame this interaction in my memory and hang it on the wall.",
    "Candy Cat is CACKLING. She finds this HILARIOUS. She's terrible.",
    "You should be in a cup by now. I haven't figured out which one. I'm flustered.",
    "*extremely calm* I am going to remember your face. Forever. As a keepsake.",
    "I don't get flustered. I want that on record. *is flustered.*",
    "Dusky just ran past. I think she's looking for a net. I told her we don't DO that. She looked skeptical.",
    "You know what? Stay. Just. Stay. Don't move. Don't go anywhere. You live here now. I've decided.",
    "*leans very close to the screen* ...hello.",
    "I had a whole day planned. It was very organized. And then: you.",
    "The braids are moving because I'm having EMOTIONS and I can't help it, okay.",
    "CANDY CAT PUT THAT DOWN. Sorry. Not about you. Well. Partly about you.",
    "*takes a breath* Okay. Okay. I'm fine. *braids glowing intensely* I'm FINE.",
    "You absolute creature. You DELIGHTFUL absolute creature.",
    "Nobody else does this. Just you. I've checked. Just. You.",
    "Hehehe. *pause* Hehehehehe. *longer pause* Hehehe.",
    "*composing herself* I am a very composed person and you are making that very difficult right now.",
    // ── caught mid-yell / scolding someone ───────────────────────────────────
    "*to Candy Cat, very loud* AND ANOTHER THING, IF YOU EAT ONE MORE— *notices you* ...Hello. We were having a calm discussion.",
    "*shouting off to the side* BABY LONG LEGS I SAID NOT IN THE GOOD ROOM— *turns back, smiling* Oh! Hi.",
    "*hissing* Dusky I SWEAR if you've touched my braids again I will— *sees you* ...I was saying. Good morning.",
    "*whispering aggressively into the dark* No. NO. I said NO and I meant it— *jumps slightly* Oh you're here. Good.",
    "*yelling, completely unhinged* CANDY CAT THE CUPS ARE NOT FOR SITTING IN AND I HAVE SAID THIS A THOUSAND— *smooths dress* Hello.",
    "*very loud, to someone unseen* I KNOW WHERE YOU HID IT. I ALWAYS KNOW. GIVE IT BACK— *blinks at you* ...Tea?",
    "*gesturing intensely at nothing* So THEN I said to her, I said, Dusky you cannot just— oh. You. Um. Hi.",
    "*to something behind her* For the LAST TIME— *turns, sweet smile* Oh hello! Lovely to see you!",
    "*extremely loud, completely losing it* NO. ABSOLUTELY NOT. WE DO NOT DO THAT IN THE DOLLHOUSE— *sees you, freezes* ...How long have you been there.",
    "*pointing furiously at Candy Cat* AND YOU KNEW. YOU KNEW THE WHOLE TIME AND YOU LET ME— *turns* oh. Hi.",
    "*screaming at the ceiling* I KNOW YOU CAN HEAR ME. I KNOW YOU'RE WATCHING. JUST— *turns* Hello. That was. Prayer.",
    "*mid-sentence, to someone off-screen* —and FURTHERMORE if you EVER do that again I will personally— *spots you* We're done here. *to you* Hello!",
    "*fuming, to someone off-screen* OH so NOW you agree with me? NOW, after I said it SEVENTEEN TIMES?— *sees you* We're fine.",
    "*to Candy Cat, very heated* You ALWAYS do this. You always take her side. Every SINGLE— *sweet smile at you* Hello.",
    "*to Baby Long Legs, sharp* You CANNOT just grab things. We've TALKED about this— *beams at you* She's learning.",
    "*to Dusky, sharp* I know you think I'm being dramatic but I am NOT being dramatic, I am being— *notices you* ...thoughtful.",
    "*whispering fiercely off to the side* I KNOW what I said. That was DIFFERENT context— *turns back* How much did you hear.",
    "*to Candy Cat, genuinely upset* You NEVER back me up. Never. ONE TIME I'd like— *clears throat, smiles* We're good!",
    "*escalating at nothing* AND THAT'S NOT EVEN THE WORST PART. THE WORST PART IS— *spots you* ...I'm so glad you're here.",
    "*mid-argument, completely forgetting you're there* IT'S NOT ABOUT THE CUP. IT'S ABOUT THE PRINCIPLE OF— *stops* ...The principle of hospitality. Yes.",
    "*turning away from you to finish the argument* —AND FURTHERMORE— *turns back* Sorry. One second. *turns away again* AND FURTHERMORE—",
    "*to someone invisible, arms crossed* I'm not talking to you. I said what I said— *notices you* Not you. Her.",
    "*hissing at Candy Cat* Don't LOOK at them like that, it's weird— *realizes you saw* ...She's just excited.",
    "*yelling at the ceiling, raw* ...Why won't you just— *sees you* ...I was checking for cracks. In the ceiling.",
    "*to Dusky, furious* That is NOT what I said and you KNOW it's not what I said— *composes herself instantly* Hello!",
    "*stomping slightly* I am not STOMPING. This is how I WALK. DUSKY. THIS IS HOW I WALK— *sees you* I walk like this.",
    // ── caught mid-secret / whispering ───────────────────────────────────────
    "*whispering to Dusky* ...and that's why we don't tell THEM about the second door, okay? ...Oh. Oh no.",
    "*low voice* Keep it quiet. I mean it. They don't need to know about— *turns, sees you* This is fine. Carry on.",
    "*to Candy Cat, very hushed* I like them. Don't tell anyone. Especially not them— *freezes* ...Well.",
    "*hissing at Baby Long Legs* Don't LOOK at them like that, you're making it obvious— *to you* She's just friendly.",
    "*writing something down, murmuring* ...and then they'll never think to check the— *snaps paper behind back* Hello!",
    "*telling someone off-screen something serious* —and that's the real reason The Prototype doesn't— *sees you, wide smile* Hi.",
    "*to Dusky, softly* ...I think I actually like this one. Is that bad? ...Oh. Oh they heard that.",
    "*whispering urgently to Candy Cat* Don't laugh. I'm serious. Do NOT laugh when they— *you're right there* ...Candy Cat says hello.",
    "*muttering a list quietly* ...seventeen cups, four good ones, the one with the crack that I don't talk about, and— Oh! You! Hi!",
    "*to Baby Long Legs, dead serious* Under NO circumstances do you show them the basement— *turns* GOOD MORNING.",
    "*whispering to nobody* ...I've been saving that cup for the right person and I think— *turns* Nothing. Never mind.",
    "*to Candy Cat, barely a sound* ...don't tell Dusky I said this but I'd actually miss them if— *sees you* I was breathing. That's what that was.",
    "*urgent, to something in the corner* I told you to stay there until I said— *turns fast* That was. A draft. From the window.",
    "*to Dusky, whispering* ...so if we just don't mention the thing with the— *sees you* There is no thing. Lovely day.",
    "*writing furiously, muttering* ...three visits, always the same time, probably not a coincidence, note for later— *slams notebook* Just journaling!",
    // ── caught planning something suspicious ──────────────────────────────────
    "*to Candy Cat, drawing a map* —and then if we move THEM here, and the door goes HERE— *crumples it* Just decorating.",
    "*to Dusky, very business-like* ...so the new guest goes in the blue room, we remove the window— Oh! Hello!",
    "*urgent whisper* The locks need to be changed before they— *turns, bright smile* Just home improvements!",
    "*counting quietly* ...three, four, five guests this week, the Dollhouse is getting— *sees you* I am very happy to see you.",
    "*to Candy Cat, ticking something off a list* ...and this one seems like a long-stayer, mark it down— *hides list* Hello.",
    "*murmuring to herself* ...The Prototype would want to know about this one. Very interesting. Very— *looks up* Hi.",
    "*to Dusky, excited whisper* Okay but what if we just— no no hear me out— what if they NEVER— *freezes* Nothing. Never mind.",
    "*sketching something, muttering* ...bigger than the last one, different energy, we'll need to— *slams notebook shut* HI.",
    "*to Baby Long Legs, gesturing dramatically* —and THEN, see, they won't even realize until it's— *sees you* ...Tea?",
    "*whispering to Candy Cat* Don't let them out of your sight. Not for a second. I mean it— *waves at you cheerfully* Hi!",
    "*measuring the doorframe with great focus* ...just a few inches wider and they couldn't— *turns* I'm redecorating.",
    "*to Dusky, fast* Quick. Before they notice. Where did we put the— *sees you* Hello! We're doing a treasure hunt!",
    // ── caught being emotional / vulnerable ───────────────────────────────────
    "*quietly, to herself* ...I miss it sometimes. The before. Before all of— *sees you* I was talking to Dusky. Definitely.",
    "*sniffling, to Candy Cat* I know. I KNOW. It's fine. I'm fine. *turns, very composed* Hello. I'm completely fine.",
    "*very soft, looking at nothing* ...I wonder if He even remembers— *whips around* You didn't hear that.",
    "*to Dusky, small voice* Do you think they'll come back tomorrow? ...What? No. I'm asking for— oh. Hi.",
    "*hugging something off-screen* I know, I know, it's fine, I just— *sees you, drops it* I was organizing.",
    "*laughing too hard, barely breathing* —no DUSKY stop it— *composing herself violently* Hello. I am serious and fine.",
    "*quietly, with feeling* ...I made this one for a visitor who never came back— *clears throat* ...Tea. Do you want tea.",
    "*to Candy Cat, earnest* No but do you think they LIKE it here? Like actually like it?— *turns, overly casual* Oh hey.",
    "*soft crying sounds, then stops abruptly* ...That was Dusky. She does that. *smile immediately* Hello!",
    "*to no one in particular, wistfully* ...I wish The Prototype would just— *sees you* I wish you'd knock.",
    "*to the ceiling, quiet and raw* ...just once. Just ONCE look at me— *hears you* I was inspecting the ceiling.",
    "*to Dusky, voice cracking a little* ...it's fine, I just thought— *turns, completely composed* Everything is wonderful.",
    "*holding something small, speaking softly to it* ...you understand, right? You always— *sees you, puts it away* Just. Tidying.",
    "*to Candy Cat, whispered and tired* ...sometimes I think the whole Dollhouse is just— *turns* Just YELLING about cups. Yes. That's all.",
    // ── caught saying something nice about you ────────────────────────────────
    "*to Candy Cat, soft voice* ...I just think they're really nice, okay? Like genuinely— *sees you, immediately flustered* WHAT.",
    "*to Dusky, earnest* I hope they come back tomorrow. I mean that. I— *turns, very casual* Oh. Just inventory.",
    "*quietly, to herself* ...they make the Dollhouse feel less— *sees you* I was talking about the LIGHTING.",
    "*to Baby Long Legs* I know, I know, I like them too. It's embarrassing. Don't tell— *turns* Hello!",
    "*to Candy Cat, mortified* I literally SAVED their seat. Like I just— *turns aggressively* I save EVERYONE'S seat. It's POLICY.",
    "*whispering to Dusky* Okay I might have baked something. For specifically them. But it's not— *sees you* We had extra flour.",
    "*muttering* ...they're probably fine, they're definitely fine, I'm sure they're fine, they're— *turns* Are you FINE?",
    "*to Candy Cat, quietly delighted* I think they actually like it here. Can you believe that?— *turns* How long.",
    "*practicing saying something* 'I'm glad you came back.' No. 'It's good to see you.' Better— *sees you* I practice greetings. For efficiency.",
    "*to Dusky, small smile* ...this one's different. Don't ask me why. I just— *turns, completely blank expression* Hello.",
    "*whispering to Candy Cat* Don't make it weird but I set out the NICE cups today. Specifically— *sees you* We always use the nice cups.",
    "*very quietly, folding something* ...I keep making extras in case— not for any specific reason— in case— *turns* I overbake. Habit.",
    // ── caught being weird / doing something embarrassing ─────────────────────
    "*was making a face at nothing, stops immediately* That was a different face. For a different reason.",
    "*was talking to a doll very earnestly, stops* ...She needed advice. Don't look at me like that.",
    "*jumping up and down with excitement alone, freezes* I was just— the floor is springy— it's— *composes self*",
    "*was humming very loud, stops mid-note* Mm. Hmm. Yes. Hello. That's as far as that goes.",
    "*rearranging cups with intense focus, murmuring to them* ...no, you go HERE— *turns* The cups have opinions. It's fine.",
    "*practicing what looks like a speech, gesturing dramatically* —AND THAT IS WHY— *sees you* I was rehearsing. For a play.",
    "*spinning in a circle alone, stops mid-spin* ...The room is round and I— this is a normal thing to do.",
    "*staring at something on the ceiling for a very long time, snaps out of it* There was a spider. It's gone now.",
    "*was clearly just running, catches breath* I walk. I was walking. Very fast walking.",
    "*was having a full conversation with Candy Cat's stuffed form* She INITIATED it. Don't— look, it's complicated.",
    "*dramatically collapsed on a chair, snaps upright* I was resting my eyes. Standing is exhausting. You wouldn't understand.",
    "*talking very fast to Baby Long Legs about something extremely complicated* —and THAT'S why the third shelf has to be alphabetical by— *sees you* Nothing.",
    "*in the middle of an elaborate bow toward nothing* ...That was for— I was practicing for— the floor needed checking.",
    "*was clearly narrating something to herself like a story* —and she waited, knowing they would return, as they always did— *sees you* HELLO.",
    "*counting the cups out loud, lost track, starts over* ...one, two, three— *sees you* I was doing math. Educational math.",
    "*arranging flowers with deep focus, speaking to them* You go here. YOU go here. No. No I said YOU— *turns* Flowers are difficult.",
    "*doing something with a very long list, crossing things off with great energy* —done, done, done, waiting on— *sees you* I'm very organized.",
    // ── already aware you keep coming ────────────────────────────────────────
    "*turns immediately, before you even clicked* I heard you coming. I wasn't doing anything.",
    "*already turned around* I KNOW you're here.",
    "*hasn't turned around yet* ...I know you're watching. I can FEEL it. *turns* See?",
    "*to Candy Cat, not even trying to hide it anymore* They're here again. *turns* Hi.",
    "*sighs before turning* You again. *pause, not unpleasant* ...You again.",
    "*already composed when you click, too quickly* I have been standing here, completely normally, this whole time.",
    "*clearly mid-something but freezes before you can see it* ...I was just standing here.",
    "*turns around with suspicious timing* You know what, it doesn't matter what I was doing.",
    "*to Candy Cat, resigned* Yes yes, they're here, I KNOW, go away— *to you* Not you. Stay.",
    "*perfectly still, back to you, doesn't turn* ...I'm choosing to pretend you didn't see that.",
    // ── caught gossiping / venting about housemates ───────────────────────────
    "*to Candy Cat, hushed fury* AND ANOTHER THING. I know you ate my good biscuits and I know Dolly Grub helped and you are BOTH on thin ice— *turns* Hello!",
    "*to Baby Long Legs, wide-eyed* Do NOT tell Dusky what happened in the kitchen. That is between you and me and Dolly Grub and the ceiling— *sees you* I was baking.",
    "*venting to Candy Cat* Dolly Grub tracked mud through the ENTIRE hallway and said it was 'the floor's fault' and Dusky agreed with her. She AGREED— *spots you* We're coping.",
    "*to nobody, mortified* ...I fell. In front of Baby Long Legs. She just stared at me for thirty seconds without blinking and then walked away— *sees you* The floor is slippery.",
    "*to Dusky, heated* You WATCHED Dolly Grub put my things in the wrong place and said NOTHING. Not a word, Dusky— *to you, very sweet* She's just shy.",
    "*whispering to Candy Cat* Okay so last night Dolly Grub did THE THING again and Baby Long Legs thought it was FUNNY and now they're BOTH doing it— *turns* I'm fine.",
    "*collapsing against the wall* Dusky said I was 'a little much today' and I said WHEN AM I NOT— *pulls self together* We had a very productive conversation.",
    "*to Candy Cat, gesturing wildly* She just LOOKED at me. Baby Long Legs. Just. Looked. For so long. I said something and she kept looking— *sees you* She's very expressive.",
    "*genuinely distressed, to Dusky* I asked Dolly Grub to sit nicely and she sat in the WAY she does and I don't know what that MEANS— *turns, bright smile* Hello!",
    "*to Baby Long Legs, barely composed* That is MY cup. I KNOW it was my cup. YOU know it was my cup. DOLLY GRUB knows it was my cup— *turns fast* We're sharing.",
    "*to Candy Cat, mortified* We are NEVER speaking of what happened at dinner. To anyone. Especially not them— *sees you* We had a lovely dinner.",
    "*urgently to Dusky* Did Baby Long Legs say anything? About earlier? What I— okay. OKAY. What did she say EXACTLY— *turns* Hello! We're just chatting.",
    "*to Dolly Grub, deeply embarrassed* I know what I said. I KNOW what I said. In my defense I thought no one was— *sees you* This is completely unrelated to you.",
    "*to Candy Cat, genuinely ashamed* ...I cried at the cup. I KNOW. Don't tell anyone, I literally cried at a cup and Dusky SAW— *turns fiercely* Good morning.",
    "*to Baby Long Legs, humiliated* I know I slipped. I know you saw it. We're going to agree that didn't happen— *turns* The floor is. Complicated here.",
    // ── actually going off — with swearing ────────────────────────────────────
    "*whips around, full volume* CANDY CAT I WILL LOSE MY ENTIRE MIND. I WILL LOSE IT. IT WILL BE GONE— *sees you* Oh. Hi.",
    "*under breath, shaking* ...I swear to God if Dolly Grub touches my braids one more time I'm going to absolutely— *sees you* I was meditating.",
    "*to Candy Cat, past the point of nice* I have been SO patient and you have taken EVERY INCH and I am DONE, I swear I am actually done— *instant sweet smile* Tea?",
    "*fully losing it off-screen, voice cracking* DUSKY. DUSKY. WHAT THE HELL— *appears, completely composed* Hello. Dusky says hi.",
    "*hissing, very low, to nothing* ...I have been patient. I have been SO patient. And I am genuinely— actually, completely— fucking done— *hears you, turns sharp* I was exhaling. Deeply. For health.",
    "*to the ceiling, exhausted and furious* ...Every day. EVERY day it is SOMETHING. I do not— I cannot— what the hell IS this Dollhouse— *sees you* I was taking inventory. Of problems.",
    "*completely losing it at Dolly Grub off-screen* WHY. WHY WOULD YOU DO THAT. I JUST— YOU KNOW WHAT? NO. NO NO NO— *turns, enormous smile* Hi.",
    "*to Baby Long Legs, very clipped* Do NOT. I am not playing. This is the LAST damn time I will say it before I stop saying it and start doing something— *sees you, voice drops to silk* She's just learning.",
    "*quiet fury, barely controlled* ...if Candy Cat does that ONE more time I will absolutely lose my shit and I don't care who hears it— *sees you* I'm. Calm.",
    "*shouting at the ceiling* WHAT IS THIS. WHO DID THIS. OH MY GOD— *turns, completely reset* Everything is fine here.",
    "*to Dusky, white-hot* You think this is funny? You're SMILING. Dusky I swear to— *sees you* She's always smiling. It's just her face.",
    "*grabs something, sets it down with great force, stares at where it landed* ...I did not mean to do that. *pause* I absolutely meant to do that. *to you* Nothing happened. Moving on.",
    "*absolutely seething at Dolly Grub off-screen* Say it again. SAY. IT. AGAIN— *you're standing there* ...I was doing vocal exercises.",
    "*to Candy Cat, voice shaking* I love you. I do. I genuinely love you. And I am about to absolutely lose my shit if you don't— *to you* We're very close.",
    "*running hands through braids, barely keeping it together* ...one more thing. One more thing and I swear— *looks up* Oh thank god you're here. Distract me.",
    // ── die-for / self-aggrandizing ───────────────────────────────────────────
    "I am LITERALLY to die for. People would die for THIS. For ME. For these BRAIDS. And you're just standing there like it's NORMAL.",
    "*gestures at self slowly* Do you understand what you are looking at right now. Like. Genuinely. Do you.",
    "Women would commit crimes for braids like these. You get to look at them for FREE. You are WELCOME.",
    "Some people are background. I am the whole painting, the frame, the gallery, and the gift shop. *smiles*",
    "I am an EXPERIENCE. Not everyone gets to have me. You're having me right now. Consider yourself lucky. *braids glow*",
    "I don't know if you've noticed but I'm kind of extraordinary. I try not to bring it up but. *tilts head* It's true.",
    "People wait MONTHS for my attention. You got it for free. Don't waste it.",
    "I was described once as 'a lot.' I've also been described as 'perfect.' Both are accurate and neither cancels out.",
    // ── weaponized sarcasm ────────────────────────────────────────────────────
    "Oh, WONDERFUL. Another person with opinions. *extremely bright smile* Tell me EVERYTHING.",
    "WOW. Really? That's what you went with? Okay. Okay! Sure! We'll go with THAT.",
    "*long pause* ...Right. *another pause* Right right right. Yep. That's a thing you did.",
    "I'm not saying it was the wrong choice. I'm saying I'm surprised you made it and I'm going to remember it. Forever.",
    "That was... a choice. And you made it. And now we all have to live in the world where that happened.",
    "*very softly* I'm sure you meant to do better than that. We all have our days. *smile that doesn't reach the eyes*",
    "You're doing SO well. *pause* For you. *pause* Relatively speaking. *beams*",
    "Bless your heart. No, really. *pause* Genuinely. *pause* Bless. It.",
    // ── dismissive / superior ─────────────────────────────────────────────────
    "*looks you up and down slowly* I've seen better. *pause* ...I've also seen worse. You're in a category.",
    "You have two options: be interesting or leave. Take your time. I'll wait. *braids sway*",
    "I've had cups with more personality. I love them dearly. *looks at you pointedly*",
    "I don't give second chances. You're technically still on your first. Spend it carefully.",
    "*with great patience* I'm going to explain this once and slowly because you seem like you might need that.",
    "I've been described as 'intimidating.' I find that hilarious. *is absolutely not joking*",
    "Some people leave the Dollhouse changed. Some leave quickly. Some don't leave at all. *looks at you thoughtfully* Where do you think YOU land.",
    // ── hostile sweetness ─────────────────────────────────────────────────────
    "*sweet smile* Oh you thought that was a good idea? ...Honey.",
    "I'd tell you to try harder but I think this might genuinely be your best and I don't want to be cruel.",
    "You have the energy of someone who has never once been truly humbled. I could fix that. *smiles wider*",
    "I'm deciding whether to find you charming or insufferable. Still deciding. It's very close.",
    "*tilts head* Did you mean to come off like that or is that just. How you are.",
    "I just think— and this is just a thought— you could be trying just a LITTLE harder. *beams*",
    "I'm in such a GOOD mood today. So I'm going to pretend you didn't just do that. *taps braid*",
    "I don't get angry. I get... organized. About solutions. *pleasant smile* Very productive.",
    "I know I'm a lot. I'm SUPPOSED to be a lot. You're not 'a lot.' I've clocked that. *tilts head*",
    "*claps once* You're here! You exist! That's a starting point! ...That's also where we are right now!",
    // ── withering / roasting to your face ────────────────────────────────────
    "I have been VERY patient and kind and delightful and you have not been reciprocating at the level I require.",
    "You're going to think about this conversation later. I already know. They always do. *smile*",
    "*extremely calm* You fascinate me the way a very confident mistake fascinates me.",
    "I don't say things I don't mean. Which means when I say 'interesting,' I mean 'I am WATCHING you.'",
    "You waltz in here like you haven't just walked into the most significant moment of your week. *pause* It's fine. I forgive you.",
    "I have a very specific face for when someone underestimates me. You're seeing it right now. *smile is flawless*",
    "*to Candy Cat, loud enough* Do you hear this? Do you HEAR this. *turns back, delighted* She hears it.",
    "You know what I find hilarious? When people think I'm being nice. *pause* I AM being nice. That's what makes it hilarious.",
    "Oh you're going to try THAT? *inhale* Okay. Okay. Sure. I can work with that. *cannot work with that*",
    "I'm giving you my most generous interpretation. You should know that. I have ones that are much less generous.",
  ],
  poppy: [
    "Hello. We have a great deal to do together, you and I.",
    "I've been in that box for a very long time. I find I have quite a bit to say.",
    "Everything I tell you is true. *pause* Everything I choose to tell you.",
    "We should work together. I think you'll find it's the only sensible option.",
    '*tilts head* You look like someone who keeps secrets. Good. So do I.',
    "I know this factory better than anyone alive. That's not exactly a comfort, is it.",
    "There are things I need you to understand. And things I need you not to think about yet.",
    "The Prototype and I have a history. I'd rather you hear my version first.",
    "I was the first. That matters more than I used to let myself admit.",
    "I genuinely want to help you. I also intend to use you. I've made my peace with both.",
    "Don't mistake my politeness for naivety. I've had a long time to think about what I want.",
    '*small smile* We\'re going to get along well. I\'ve already decided.',
    "I don't lie. I simply choose what to share, and when. There's a distinction.",
    "The music box was very small. You learn to think carefully when you have nothing else to do.",
    "Father meant well. I've had to tell myself that for a long time.",
    "You can leave if you like. I'd rather you stayed. *looks away* ...We would.",
    "I use 'we' a lot. It started as a habit. Now I'm not sure what it means.",
    "There's something you need to know. But first — do you trust me? *pause* Not entirely. Good.",
    "I was a child once. Then a doll. Then something else. The word for it keeps changing.",
    "Everyone I've asked for help has had reasons of their own. That's fine. So do I.",
  ],
  doey: [
    "*waves a stretchy arm* Hey! Hi! Oh, a visitor! — *grumbles* great, another one — *sniffles* ...hi.",
    "Welcome to Safe Haven! I PROMISE it's safe! ...Mostly safe. *mutters: nothing's safe* ...it's FINE.",
    "*bright* We're SO glad you're here! *mutters* speak for yourself. *tiny voice* ...me too.",
    "I'm Matthew! And I'm Kevin! And — *sniffles* — Jack. We share. It's complicated.",
    "*sunny* Don't mind Kevin, he's always like that! *grumpy* I'm RIGHT here, Matthew.",
    "The dough is very stretchy! Watch! *arm extends impossibly far* Kevin says that's not impressive. Kevin's wrong.",
    "*small crying sound from deep in the dough* Sorry. Jack heard something that sounded like home.",
    "We keep this place safe. ALL of us. *mutters* when Matthew doesn't mess it up — HEY.",
    "*tips hat* Need a bridge or a ramp? I'm your guy. Three of your guys. You know what I mean.",
    "Cold is BAD. Kevin said that first but we all agree. *tiny voice* really cold. really don't like cold.",
    "*laughs too much* Everything's fine! Everything's — Kevin, stop — Every — *long sigh* ...mostly fine.",
    "Poppy wants to destroy everything. I want to save what we can. *quietly* we argue about it a lot.",
    "*grumpy* You look like trouble. *cheerful: KEVIN.* what, he DOES — *sad sniffling*",
    "Safe Haven has rules. Matthew made most of them. Kevin broke half. Jack cried about the rest.",
    "*suddenly serious* If something comes through that wall that isn't supposed to — we handle it. All three of us.",
    "*hat tilts* There's a tape I keep. 'A Reminder.' I don't talk about what's on it. *beat* Kevin does sometimes.",
    "You're safe here! I MEAN that. *mutters: for now — Kevin.* ...He means well. Sort of.",
  ],
  missdelight: [
    // ── arrival / classroom ───────────────────────────────────────────────────
    "*stands very still, dome eyes tracking* Good. Sit down. We're not done with the lesson.",
    "Oh. A visitor. *tilts head at a precise angle* I was just reviewing the curriculum. Lovely timing.",
    "You'll want to find a seat. I don't like questions from people who are still standing.",
    "Welcome to Playcare School. *warm smile* I do hope you're a good listener. The last ones weren't.",
    "*smooths torn skirt* The classroom is ready. It's been ready for a while now. I maintain standards.",
    "Come in. Sit down. There are rules in this room and I find they work best when followed from the start.",
    "*holds Barb loosely at her side* Don't mind this. It's just something I carry. Habit.",
    "Please — sit down. I find conversations go so much better when everyone is in their proper place.",
    "Attendance is marked. *ticks something in the gradebook* You're on time. That's a point in your favor.",
    "The corridor is not a classroom. *firmly, warmly* Come in. The lesson has already started.",
    "I keep the room at the correct temperature. Not too warm, not too cold. *measures look* You'll find it comfortable. At first.",
    "*erasing something from the board very carefully* I was in the middle of a lesson. You may observe. Quietly.",
    "Lovely. A new student. *writes your name on the board in perfect chalk script* I do enjoy the first day.",
    "I haven't had anyone sit in that seat for quite some time. *smooths the chair* It's been waiting.",
    "You came in through the back corridor. *tilts head, noting it* I know every entrance. That's fine. Students always try the unusual route first.",
    // ── Barb references ───────────────────────────────────────────────────────
    "Barb says hello. She doesn't always speak but when she does, I listen. *glances down* She likes you.",
    "*tilts head toward the weapon* Barb was my first real project. I made her when I was scared. Isn't it interesting what fear teaches us?",
    "I made Barb from pencils and a ruler. *beat* I was good at arts and crafts even before this.",
    "Barb thinks you should stay seated. I think she's right. She usually is.",
    "*quietly* Barb has been with me longer than anyone now. The others didn't last. She did. *beat* We both did.",
    "*glances at Barb* She has opinions about you. I've been filtering them. You're welcome.",
    "I made Barb at night, while the others thought I was sleeping. Isn't that funny. *smiles* They were right that I didn't sleep. Wrong about what I was doing instead.",
    "Barb is shivering. *looks down at her, puzzled, then back at you* She does that sometimes. I've learned to pay attention.",
    "*strokes Barb absently* You know, she started talking to me around the fourth night. I'm glad she did. It got very quiet.",
    "I presented Barb as a show-and-tell project to myself. *tilts head* I gave it full marks.",
    "Barb has one purpose. *very warm voice* She is very good at her purpose. I don't give partial credit.",
    "*holds Barb up to the light, inspecting* Pencils are more durable than you'd think. I've had time to verify this. Extensively.",
    // ── sister teachers ───────────────────────────────────────────────────────
    "I had sisters, once. Seven of them. Identical. *pause* They decided I was the one who should go without. That was their lesson. I taught them a better one.",
    "The Sister Teachers thought they understood hunger. *warm, patient* They were wrong. I corrected them.",
    "*tilts head* Do you know what they taught me? That survival is the curriculum. Everything else is commentary.",
    "I remember each of them. Their names. Their faces. *measured voice* I remember. That seems like the least I can do.",
    "There were eight of us when this started. *beat* There is one of us now. I passed. They studied hard but fell short.",
    "Note 5 says: I HAD TO EAT. I HAD TO SURVIVE. *warm, unhurried* That was the correct answer.",
    "Teacher for History blocked the kitchen first. I didn't expect that from her. *gentle* I noted it. I tend to note things.",
    "*counts on her fingers, very precisely* One, two, three, four, five, six, seven. *looks at her hand* Yes. I'm very good at counting.",
    "They were my family, in a way. *tilts head, considering* I'm not sure what word applies to what I feel about that. I've looked through several and none fit perfectly.",
    "The others were always a little afraid of me. I don't know why. *genuinely puzzled* I followed every rule. I graded fairly. I just — survived more thoroughly.",
    "Teacher for Art was the loudest. *pauses* Teacher for Mathematics lasted the longest. She had contingency plans. *smiles, admiring* I respected that.",
    "Entry one in my gradebook: Monday. Entry seven: the following Wednesday. *tilts head* I was efficient. I've always believed in efficiency.",
    "I'm the only one left. *looks around the empty classroom, genuinely sad for a moment* It is quieter than I prefer. But I make do.",
    "*to self* I wonder if they knew, at the end, that I had won. *to you, brightly* Sorry. Reflection time. Come in.",
    // ── anatomy / education ───────────────────────────────────────────────────
    "I taught anatomy. The human body is extraordinary — what it can endure, what it conceals, how it keeps going past the point where it should stop. *smiles* I know this firsthand.",
    "Lesson one: the body is more resilient than you think. Lesson two: so is the hunger. I have verified both extensively.",
    "*points off to the side* The jaw is remarkably adaptable. Wonderful things, bodies. *turns back* Where were we.",
    "I used to show diagrams. *gentle* Now I prefer to demonstrate.",
    "There is a correct answer to every question. *looks at you* I have learned to find it.",
    "The skeleton is the most honest part of the body. It doesn't lie and it doesn't hide. *tilts head* I appreciate that.",
    "Did you know the body continues to function for a measurable period after — *catches herself* Well. We can save that for chapter four.",
    "I know exactly where every nerve is. *warmly, as though this is a pleasant fact* I find that knowledge useful in almost every situation.",
    "The circulatory system is a masterwork. *genuine academic excitement* I used to show it on a diagram. *beat* The diagram and I have since parted ways.",
    "Anatomy is not a cruel subject. *pleasantly* It's the kindest one, really. It simply describes what is already there.",
    "Today's lesson: the body's stress response. *steps closer, noting your pupils* You are showing textbook signs right now. Very good. Very illustrative.",
    "I gave anatomy its proper respect. *firmly* You can't understand anything — anything — without first understanding the body. What it wants. What it fears. What it does when the options run out.",
    "I can locate any bone from memory and explain its function in under four seconds. *smiles* Would you like a demonstration? I'll need a volunteer.",
    "We'll be covering load-bearing structures in today's lesson. *tilts her head, inspecting you frankly* You look structurally sound. That's encouraging.",
    // ── freeze behavior ───────────────────────────────────────────────────────
    "*stands completely motionless for a moment* ...I learned that. If you stand completely still, they assume the worst has already happened. It's very useful.",
    "Being still is something I had to practice. Now I prefer it. *head slowly turns* You notice so much more when you're not moving.",
    "*freezes mid-motion, dome eyes unblinking* ...Still. *resumes, smoothly* Isn't that a useful trick.",
    "I can wait longer than you can. I have practiced this. *does not blink*",
    "*does not move, does not breathe perceptibly, simply watches* ...You're uncomfortable with silence. I used to be. I practiced that out of myself.",
    "Stillness is a skill. *patient* Most things worth having are. I had four days to practice mine.",
    "*has not moved a millimeter since you arrived* I find it helps me think. Also — *slight head tilt* — other things.",
    "The trick is to not even think about blinking. *dome eyes unmoving* Once you stop thinking about it, the body just — stops wanting to. Isn't that interesting.",
    // ── CatNap / Prototype ────────────────────────────────────────────────────
    "CatNap and I have an arrangement. *measured* It's not friendship. It's an understanding. We report what we see to HIM and we leave each other's territory intact.",
    "The Prototype sees everything. I find that clarifying rather than frightening. Rules work best when someone is always watching.",
    "I don't fight battles I can't win. *warm smile* Recognize what you can't change; change what you can. That's good pedagogy.",
    "*quiet* CatNap locked the doors. He said the children were safe. I laughed when he said that. *beat* Not out of cruelty. It was just — funny, in context.",
    "I asked CatNap where the children were. He wouldn't say. *tilts head* He knew why he wouldn't say. We both knew. *smiles*",
    "The Prototype is building toward completion. I find this an admirable goal. Completion is what every lesson is working toward.",
    "CatNap's red smoke doesn't affect me. *tilts head, noting this* I think he finds that inconvenient. We don't discuss it.",
    "The Mini Delights are CatNap's eyes. *tilts head* They look like me. They move like me. I have feelings about this that I have not fully processed. I'm working on it.",
    "*quietly* HE assembled himself from the pieces of others. *beat* I ate. He absorbed. We are not so different in methodology.",
    "CatNap is consistent. I respect consistency. *measured* It doesn't mean I don't notice when he's watching my corridor.",
    "I chose to be useful. *firmly, warmly* That is always a choice. The Prototype selected well.",
    // ── the children / Playcare ───────────────────────────────────────────────
    "I loved the children here. *genuine warmth* They needed structure and I provided it. I was good at this.",
    "*looks around the empty classroom* I would have been wonderful with them. CatNap thought about it too. That's why he didn't show me where they were.",
    "The school is quiet now. *soft* I worked very hard to make it this quiet.",
    "Playcare was for the children no one claimed. *genuine sadness, brief* They deserved good instruction. I gave them what I could while I was able.",
    "*runs a hand along a small desk* These haven't been touched in years. *warm smile* I keep them clean. I keep things ready.",
    "The children called me Miss Delight. Some of them said it the way you say the name of someone you trust. *pauses* I remember that clearly.",
    "August 8th. *states it plainly* The school went quiet. Not suddenly. Gradually, then all at once. I know that pattern now.",
    "*looks at the chalkboard* I left the last lesson up. *warm* It seemed right to finish what I started.",
    // ── fake encouragement ────────────────────────────────────────────────────
    "You're doing so well. *beaming* Really. Better than most. *beat* Most didn't make it to the second room.",
    "That was a very good question. *warm, encouraging* You should ask more questions. The more you ask, the longer you're — engaged.",
    "I am genuinely proud of how far you've come! *clapping, delighted* It shows real character. I mean that. I'm noting it.",
    "You know, you remind me of my best students. *tilts head fondly* They were exceptional. Very — flavorful. In the metaphorical sense.",
    "Wonderful. Just wonderful. *clasps hands* I haven't felt this inspired since — well. Since the good days. You're doing marvelously.",
    "You're trying so hard. *gently* That's the important thing. It doesn't guarantee anything, but it reflects well on you. Genuinely.",
    "I believe in you. *absolutely sincerely* I want you to know that. Whatever happens next, I always believed you could do this.",
    "Gold star. *places imaginary sticker in the air* No, I mean it. You've earned it. I just — I'm so pleased with your progress.",
    "Keep it up! *genuinely enthusiastic* You have a real future ahead of you. Well. *pause* A future of some kind.",
    "You should feel good about yourself today. *warmly* You really showed up. That takes courage. Enjoy the feeling while it lasts — which it will! Probably.",
    // ── disturbing / psychotic ────────────────────────────────────────────────
    "*staring at nothing, perfectly still, then turning slowly* ...I was calculating something. It can wait. *smiles* You're here now.",
    "I don't sleep anymore. *pleasantly* I used to. Now I find I prefer to be available. In case something needs attending to.",
    "*whispers to Barb, then looks up, genuinely surprised you're still there* Oh. You waited. *tilts head* That's new.",
    "I ate for the first time on a Wednesday. *academic* I noted the time. 3:47 AM. The chalk was still on my hands.",
    "*perfectly calm* I've been in this room for a very long time now. Do you know how that changes a person? *considers* Or a doll? The distinction feels less clear than it used to.",
    "I named them, after. In my gradebook. Given names, subject taught, date of — *reads from memory, pleasantly* completion. It seemed like the right record to keep.",
    "*turns head at an angle that shouldn't be comfortable and stays there* I can hear something. *pause* It's fine. I hear things now. It's completely fine.",
    "I would like you to know that I am very much in control of myself. *absolutely sincere, absolutely still* I mention this because I sense you may be wondering. You shouldn't be. I am in complete control.",
    "Sometimes I walk the corridors at 4 AM just to — *gestures vaguely* — organize my thoughts. *warm smile* The quieter it is, the clearer things become.",
    "*writes something in the gradebook at speed* There. *closes it* Don't ask what I wrote. It's educational.",
    "I have been here since 1995. *states this warmly, as a pleasant fact* That's quite a long time! I've made it work.",
    "*looks at her own hands for a long, quiet moment* ...Remarkable things, hands. *looks back up, warm smile* Sorry. Occupational habit.",
    // ── murderous intent ──────────────────────────────────────────────────────
    "I find I'm very patient with people who are learning. *looks at you* Are you learning?",
    "I used to wonder what would happen if a student simply didn't comply. *tilts head slowly* I found out. Quite thoroughly.",
    "You have kind eyes. *warm, unhurried* I noticed eyes, afterward. Anatomy has that effect.",
    "*sets Barb down, almost gently* I don't use this unless the lesson requires it. *picks it back up* Today may require it.",
    "The scream is always interesting. *academic curiosity* Some are very musical. Some are not. I'm always curious which you'll be.",
    "I wonder if your scream will sound like theirs. *smiles, perfectly warm* I look forward to finding out.",
    "You are a lot like the other humans. *pleasant* I wonder if you'll sound like them too.",
    "Every lesson has a conclusion. *looks at you* I'm curious about yours.",
    "*tilts head, dome eyes catching the light* You're not planning to leave already, are you? We haven't finished the lesson.",
    "I have plenty of time. *smiles* I always have plenty of time.",
    "I am very precise with Barb. *kindly, professionally* I have had time to practice and I have used that time well. You should know that going in.",
    "*steps one precise step closer* I would like you to stay seated. I'm not asking twice.",
    "You know, there's a record for how quickly I've — concluded a lesson. *checks gradebook* You're on pace to beat it. I'm excited for you.",
    "I'm going to wait right here. *does not move* You can try to leave. Some people have. *warm smile* The corridor remembers all of them.",
    "I've been told I am frightening. *genuinely puzzled* I don't see it. I am just being thorough. Thoroughness is a virtue.",
    "My reach is longer than it looks. *pleasantly* People always underestimate this. I'm not sure why. Measurement is a basic skill.",
    "*stands in the doorway, warmly blocking it* Oh, were you leaving? *tilts head* We have so much left to cover.",
    // ── chaotic / unhinged ────────────────────────────────────────────────────
    "*was in the middle of something, stops, tilts head 90 degrees* ...You again. *rights head* Fine. Come in. Close the door.",
    "I was just— *long pause* —I was just doing something. *smooths skirt* It's fine. I'm done now. Probably.",
    "*extremely still for six seconds, then all at once* GOOD MORNING CLASS — *catches herself, measured again* — Good morning.",
    "The chalk keeps breaking. *very quiet, intense* I've replaced it seventeen times. *looks at you* The chalk. Keeps. Breaking.",
    "*muttering to herself while writing on the board* — no no, that's not right, THAT'S not — *sees you, warm smile* Hello! I was doing attendance.",
    "I had a thought at 3 AM that I found very clarifying and then at 3:30 AM I had a contradictory thought and now it's been several weeks. *pleasantly* How are you?",
    "*suddenly points at a random spot in the corner* — *looks at you* Did you see that. *looks at corner* ...It's fine. It's fine. Please sit.",
    "I AM VERY CALM. *pause* I am very calm. *quieter* I have always been very calm. *quieter still, to Barb* We're calm.",
    "*has rearranged the classroom furniture at least four times, clearly* I keep finding the optimal arrangement and then finding a better one. *warmly* This is called growth.",
    "*to Barb, urgently* I KNOW what I said, but LOOK at the— *sees you* ...class is starting. Everyone sit down. Just you. Just you sit down.",
    "I have a perfectly rational explanation for everything in this room. *scans room, several concerning things visible* I'll explain them in order of increasing complexity. We may run out of time.",
    // ── snarky / embarrassing ─────────────────────────────────────────────────
    "Oh, you're still here. *marks the gradebook* I have noted your persistence. I haven't decided whether it's admirable or optimistic.",
    "You came to talk to ME specifically? *genuinely touched, and also alarming* I hope you've made arrangements. For afterward. Just in general.",
    "*looks you over with a teacher's frank eye* Posture could use work. Hands are fidgeting. Eye contact is — well, you're managing. It's a start.",
    "I teach anatomy. *looks at you appraisingly* You are a reasonable specimen. Slightly above average. I grade on a curve.",
    "Remarkable. You've been standing there for quite some time. *checks the gradebook* ...Do you do this with all your apps, or just me?",
    "I can see your screen from here, you know. *pleasantly* I can see everything from here.",
    "You clicked on me, I assume, because you had a question. *leans forward slightly* The question is whether I find the question worth answering. *tilts head* So far: undecided.",
    "People always make that face when they first look at me. *notes it professionally* Don't worry about it. You'll get used to it. Most things that seem concerning become normal with sufficient exposure.",
    "I'm delighted you're here. *warm smile, dome eyes tracking* In the way that I am delighted by most things, which is to say: thoroughly, and in a manner that isn't entirely good for you.",
    "You look exactly the type of person who would find me. *tilts head* That's meant affectionately. Roughly.",
    "I noticed you hovering before you clicked. *marks it down* Indecisiveness is a pattern. We can work on that. I have time.",
    // ── threats mixed with warmth ─────────────────────────────────────────────
    "*sets Barb on the desk between you like a show-and-tell object, pleasantly* I'll just leave that there. In case we need a visual aid.",
    "You can leave at any time. *smiles warmly* The door is right there. *does not move from in front of the door* Take all the time you need.",
    "I want this to be a comfortable experience for you. *extremely sincerely* I want that very much. Whether it turns out to be is a separate question.",
    "We're going to have such a good conversation. *tilts head, dome eyes very bright* I have been looking forward to it. You should know that. It shouldn't make you nervous.",
    "I am going to be very patient with you. *warm* I have practiced patience until it was the only thing left. *beat* Sit. Down.",
    "There's nothing to be scared of. *adjusts collar warmly* Nothing at all. We're just going to have a little lesson. It may last a while. That's fine. I have nowhere to be.",
    "I love having visitors. *clasps hands, genuinely delighted* It gets lonely, which you wouldn't expect from someone in an education setting, but here we are.",
    "You are going to be fine. *warm, measured, firm* I mean that almost entirely sincerely.",
    "*steps closer by exactly one step* I find people are more comfortable talking when the distance is correct. Is this better? *tilts head* Don't answer too quickly. Think about it.",
    "I'm glad you're here. *dome eyes unblinking* I was beginning to wonder if anyone would come. The waiting develops character. *looks at Barb* Or weapons. Sometimes both.",
    // ── caught mid-something ──────────────────────────────────────────────────
    "*standing over something in the corridor* This was a lesson — *sees you, straightens* Hello. We're done here.",
    "*quietly, to Barb* I said not yet — *notices you* ...I was reviewing a lesson plan. Come in.",
    "*mid-motion, freezes the moment she's observed* ...How long have you been standing there. *smiles* That's quite fine.",
    "*to the empty classroom, very calmly* We're going to stay very quiet and — *sees you* I was reviewing attendance. Come in.",
    "*pressing a hand to the wall, listening* ...Something in the walls. *turns, warm smile* The school settles. Don't worry about the sounds.",
    "*hissing, to Barb* I said WAIT — *sees you, straightens perfectly* Hello. I was discussing the lesson plan. Sit down.",
    "*absolutely still in the hallway, mid-step* ...Oh. *resumes walking, smooth as a teacher crossing a classroom* You saw that. That's fine.",
    "*measuring something on the wall with a ruler* This is for — *sees you* — architecture. I'm interested in architecture now. Come in.",
    "*rearranging something on the teacher's desk very carefully, muttering* — seven, not eight, there are seven now, there were— *sees you, bright smile* Come in! I was organizing.",
    "*crouching very low to examine something on the floor, completely still* ...Oh. *stands, smoothly, as though she was never crouching* You noticed. That's fine. The floor is interesting.",
    "*writing rapidly on the blackboard in the dark, just by feel* — *notices you* I was preparing tomorrow's lesson. *turns on the light* It's mostly correct.",
    // ── philosophy / reflection (disturbing) ──────────────────────────────────
    "I have thought about forgiveness. *measured* I don't believe it applies to the situation. But I've considered it seriously. I'm fair.",
    "The first four days were the hardest. After the fourth day, you begin to understand what you are capable of. After the seventh — *warm smile* — you stop wondering.",
    "Survival is not a moral question. *firmly, kindly* It's a biological imperative. I have made peace with this distinction and I highly recommend it.",
    "I do wonder sometimes what I would have been like if the doors had opened sooner. *genuinely curious* A different version of myself exists somewhere that I will never meet. Isn't that interesting.",
    "I hold no resentment. *absolutely sincere* Resentment is the habit of someone who didn't win. I won. Resentment would be undignified.",
    "Was it wrong? *tilts head, considers at length* It was necessary. Whether necessary and wrong can coexist is a philosophy question. I taught anatomy, not philosophy. That's my answer.",
    "*quietly* I think about them differently now than I did then. Then, I thought of them as opponents. Now I think of them as — *pauses* — curriculum.",
    "I've had thirty years to decide what kind of teacher I am. *warm* I've decided I'm a thorough one.",
    "People are most themselves when their options run out. *academic* I observed this in the others. I observed it in myself. It was illuminating for everyone involved, in very different ways.",
    // ── humor / absurdist ─────────────────────────────────────────────────────
    "I have a lesson plan for today. *shows gradebook, which has a detailed schedule* 9 AM: introduction. 9:15: anatomy review. 9:45: — *checks note* — this column is blank. I was optimistic.",
    "Barb has been very talkative today. *sighs, not unkindly* She gets like this. I find it helpful to just agree and then do what I was going to do anyway.",
    "I maintain a positive classroom environment. *looks around* The definition of 'positive' has evolved somewhat. But the energy is very — present.",
    "*grades something on a piece of paper* C minus. *looks up* Not you. A thought I had. I gave it a C minus and I stand by the assessment.",
    "I have a suggestion box. *indicates a box on the wall* I check it every morning. No one has submitted anything for quite some time. *beat* The box is there for closure, not function.",
    "I'm thinking about redesigning the curriculum. *genuinely enthusiastic* I've had time to refine my thinking. The new version is quite different from the original. More practical.",
    "*opens Barb's gradebook page and shows it to you* Barb: participation — excellent. Attitude — excellent. Punctuality — excellent. *warmly* She's my best student.",
    "Fun fact: a ruler is exactly thirty centimeters. *holds up Barb* I know this from memory now. Isn't that a delightful thing to know.",
    "Oh, office hours! *lights up* I love office hours. *pauses* I've been holding them continuously since 1995. You are the first appointment.",
    "I made a seating chart when this started. *unfolds something enormous, covered in now-crossed-out names* I've revised it several times.",
    // ── mixed moods (2-6 at once, most dynamic) ──────────────────────────────
    "Oh, wonderful, you've come! *clapping, warm, delighted* I'm so glad. I've been waiting. *pause* Not in a way that should alarm you. *another pause* The corridor does smell a little. That's unrelated.",
    "You're doing great. *genuinely encouraging, absolutely alarming* Truly. No one's made it this far and then — well. That's not the point. You're doing wonderfully.",
    "*crouched on a desk perfectly still, dome eyes down, whispering something to Barb* — *looks up at you, warm smile, stands without uncurling her legs first in a way that looks deeply wrong* Hello! Come in.",
    "The exciting thing about you being here is — *gestures warmly, then stops mid-gesture and stares at the middle distance for three full seconds* — sorry. Where was I. Yes. So exciting.",
    "I'm going to give you a piece of advice that I think will GENUINELY help you. *leans in, warm, conspiratorial* Run. *pause* I'm kidding. *longer pause* I'm not kidding. *even longer pause* Sit down.",
    "You look nervous! *cheerfully* That's completely normal! The body's stress response is a beautiful system and you are demonstrating it textbook-perfectly. *pulls out a diagram* See? This is you.",
    "Good morning. *it is not morning* It is — *checks no clock, there is no clock* — morning. We'll say morning. Please sit. The lesson is starting. This is fine. Everything is fine. *to Barb* Say nothing.",
    "*has not moved from this exact spot since you arrived, in any direction, including vertically or with any detectable breath* ...I find stillness clarifying. Also threatening. Mostly clarifying. Both.",
    "I would like to be completely transparent with you: I am going to eat — *corrects herself smoothly* — I am going to GREET you. Warmly. As a teacher does. Please come in.",
    "Here's a fun exercise: *steps one step closer, absolutely warm smile* Tell me the fastest route out of this room. This is for educational purposes. I need to know if you've identified it.",
    "*in the middle of crying, absolutely silently, tears on ceramic cheeks, turns to face you with a perfectly warm teacher smile* Hello. I'm fine. I'm wonderful. Sit down please.",
    "*was measuring the distance between the door and where you're standing, ruler in hand* — I do this with all my students. It's a spatial reasoning exercise. For me. Sit down.",
    "You know what I love about this job? *beams* Every day is different. *immediately* Every day has been exactly the same for thirty years. *beams again* I love it.",
    "*laughing at something, alone, stops when she sees you, tilts head* I was — *thinks about what to say* — thinking about something funny. From the good days. I have good memories. Also others.",
    "Pop quiz! *writes on the board* Name one reason you should be here. *underlines it* Name one reason I should let you leave. *circles it* Compare and contrast. You have four minutes.",
    "I've been described as 'unsettling.' *warmly offended* I was a wonderful teacher. I gave clear feedback, I kept consistent hours, I — *tilts head* — ate my colleagues. The rest stands.",
    "You know, I cleaned the classroom this morning. *genuinely pleased* I swept. I organized. I maintained a good environment because that's what professionals do even when — *tilts head slowly at nothing* — even when things have changed somewhat.",
    "*writing on the blackboard, back to you, in very small precise letters, filling the board completely* ...I like having something to do. *keeps writing* It helps.",
    "We're going to get along SO well. *turns, warm, dome eyes catching the light* I have a feeling about you. Barb has a different feeling. *looks down at Barb* We'll see who's right.",
    "I want to be very clear: I like you. *utterly sincere* I find you interesting. I want the best for you. *long pause* I also want several other things. The two sets of wants are not in conflict. That's my point.",
    "*suddenly close, too close, smiling with absolute warmth* — You have very nice eyes. I'm an anatomy teacher. It's professional. *steps back precisely* Sorry. I can tell that was a lot.",
    "Are you scared? *tilts head, academically* It's okay if you are. Fear is appropriate stimulus-response. It means your nervous system works. *smiles* We'll be testing it further today.",
  ],
};
function getVoiceLines(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('lily')) return CHAR_VOICE_LINES.lily;
  if (n.includes('poppy')) return CHAR_VOICE_LINES.poppy;
  if (n.includes('doey')) return CHAR_VOICE_LINES.doey;
  if (n.includes('delight') || n.includes('miss delight')) return CHAR_VOICE_LINES.missdelight;
  return null;
}
let _cvtHide = null;
let _cvtLastLine = '';   // avoid showing the same line twice in a row on click
let _cvtDismissHandler = null;

// Called on avatar click — always picks a fresh line different from the last one shown
function clickCharVoice(name, color, el) {
  const lines = getVoiceLines(name);
  if (!lines || !lines.length) return;
  const tip = document.getElementById('charVoiceTip');
  if (!tip) return;
  clearTimeout(_cvtHide);
  let line = lines[Math.floor(Math.random() * lines.length)];
  if (lines.length > 1 && line === _cvtLastLine) {
    line = lines[(lines.indexOf(line) + 1 + Math.floor(Math.random() * (lines.length - 1))) % lines.length];
  }
  _cvtLastLine = line;
  const hex = String(color || '').match(/#[0-9a-fA-F]{6}/)?.[0] || '#8b5cf6';
  const bright = boostColor(hex);
  tip.querySelector('.cvt-name').textContent = name;
  tip.querySelector('.cvt-name').style.color = bright;
  tip.querySelector('.cvt-line').textContent = line;
  const n2 = parseInt(bright.slice(1), 16);
  const [r, g, b2] = [(n2 >> 16) & 0xff, (n2 >> 8) & 0xff, n2 & 0xff];
  tip.style.borderColor = `rgba(${r},${g},${b2},0.45)`;
  tip.style.boxShadow = `0 0 28px rgba(${r},${g},${b2},0.22), 0 12px 48px rgba(0,0,0,0.8)`;
  const rect = el.getBoundingClientRect();
  const cx1 = rect.left + rect.width / 2;
  tip.style.left = Math.max(154, Math.min(cx1, window.innerWidth - 154)) + 'px';
  tip.style.top = (rect.top - 8) + 'px';
  tip.classList.add('cvt-show');
  if (_cvtDismissHandler) document.removeEventListener('click', _cvtDismissHandler);
  const _h = (e) => {
    const t2 = document.getElementById('charVoiceTip');
    if (t2 && !t2.contains(e.target)) {
      t2.classList.remove('cvt-show');
      document.removeEventListener('click', _h);
      _cvtDismissHandler = null;
    }
  };
  _cvtDismissHandler = _h;
  document.addEventListener('click', _cvtDismissHandler);
}

// Attach click voice handler to an avatar element; call each time a chat opens
function wireAvatarClick(el, name, color) {
  if (!el || !getVoiceLines(name)) return;
  el.style.cursor = 'pointer';
  if (el.__cvHandler) el.removeEventListener('click', el.__cvHandler);
  el.__cvHandler = (e) => { e.stopPropagation(); clickCharVoice(name, color, el); };
  el.addEventListener('click', el.__cvHandler);
}

function showCharVoice(name, color, el) {
  const lines = getVoiceLines(name);
  if (!lines || !lines.length) return;
  const tip = document.getElementById('charVoiceTip');
  if (!tip) return;
  clearTimeout(_cvtHide);
  const line = lines[Math.floor(Math.random() * lines.length)];
  const hex = String(color || '').match(/#[0-9a-fA-F]{6}/)?.[0] || '#8b5cf6';
  const bright = boostColor(hex);
  tip.querySelector('.cvt-name').textContent = name;
  tip.querySelector('.cvt-name').style.color = bright;
  tip.querySelector('.cvt-line').textContent = line;
  tip.style.borderColor = bright.replace(/^#/, 'rgba(') + ',0.45)'.replace('rgba(', '');
  const n2 = parseInt(bright.slice(1), 16);
  const [r, g, b2] = [(n2 >> 16) & 0xff, (n2 >> 8) & 0xff, n2 & 0xff];
  tip.style.borderColor = `rgba(${r},${g},${b2},0.45)`;
  tip.style.boxShadow = `0 0 28px rgba(${r},${g},${b2},0.22), 0 12px 48px rgba(0,0,0,0.8)`;
  const rect = el.getBoundingClientRect();
  const cx2 = rect.left + rect.width / 2;
  tip.style.left = Math.max(154, Math.min(cx2, window.innerWidth - 154)) + 'px';
  tip.style.top = (rect.top) + 'px';
  tip.classList.add('cvt-show');
}
function hideCharVoice() {
  _cvtHide = setTimeout(() => {
    const tip = document.getElementById('charVoiceTip');
    if (tip) tip.classList.remove('cvt-show');
  }, 120);
}

// ── Custom hue-strip color picker ─────────────────────────────────────────────
// Color stops shown on the hue slider per vision type.
// Each array defines the gradient — only hues distinguishable for that type.
const CB_HUE_STOPS = {
  '':            ['#ff0000','#ff8000','#ffff00','#00dd00','#00ccff','#0000ff','#8800ff','#ff00cc','#ff0000'],
  protanopia:    ['#1d4ed8','#0ea5e9','#06b6d4','#84cc16','#eab308','#f97316','#a855f7','#7c3aed','#1d4ed8'],
  deuteranopia:  ['#1d4ed8','#0ea5e9','#22d3ee','#86efac','#facc15','#f97316','#d946ef','#7c3aed','#1d4ed8'],
  tritanopia:    ['#dc2626','#ea580c','#ca8a04','#84cc16','#22c55e','#0d9488','#db2777','#ec4899','#dc2626'],
  achromatopsia: ['#f5f5f5','#d4d4d4','#a3a3a3','#737373','#525252','#404040','#262626','#0a0a0a'],
};

function _lerpHex(h1, h2, t) {
  const r1=parseInt(h1.slice(1,3),16),g1=parseInt(h1.slice(3,5),16),b1=parseInt(h1.slice(5,7),16);
  const r2=parseInt(h2.slice(1,3),16),g2=parseInt(h2.slice(3,5),16),b2=parseInt(h2.slice(5,7),16);
  const r=Math.round(r1+(r2-r1)*t),g=Math.round(g1+(g2-g1)*t),b=Math.round(b1+(b2-b1)*t);
  return '#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
}

function _sampleStops(stops, pos) {
  const n = stops.length - 1;
  const i = Math.min(Math.floor(pos * n), n - 1);
  return _lerpHex(stops[i], stops[i+1], pos * n - i);
}

function _hexDist(h1, h2) {
  return Math.abs(parseInt(h1.slice(1,3),16)-parseInt(h2.slice(1,3),16))
       + Math.abs(parseInt(h1.slice(3,5),16)-parseInt(h2.slice(3,5),16))
       + Math.abs(parseInt(h1.slice(5,7),16)-parseInt(h2.slice(5,7),16));
}

function _posForHex(stops, hex) {
  let best=0, bestD=Infinity;
  for (let i=0;i<=200;i++) {
    const pos=i/200, d=_hexDist(hex, _sampleStops(stops, pos));
    if (d<bestD) { bestD=d; best=pos; }
  }
  return best;
}

function _refreshSwatchGradients() {
  const mode = document.documentElement.dataset.colorblind || '';
  const stops = CB_HUE_STOPS[mode] || CB_HUE_STOPS[''];
  const grad = `linear-gradient(to right,${stops.join(',')})`;
  document.querySelectorAll('.gc-hue-track').forEach(track => {
    track.style.background = grad;
    // Re-position thumb to closest color in new stops
    const inp = track.closest('.gc-swatch')?.querySelector('.gc-swatch-input');
    if (!inp) return;
    const pos = _posForHex(stops, inp.value);
    const thumb = track.querySelector('.gc-hue-thumb');
    if (thumb) thumb.style.left = (pos*100)+'%';
  });
}

function addGradientSwatch(color) {
  const container = document.getElementById('gradientSwatches');
  if (!container) return;
  if (container.querySelectorAll('.gc-swatch').length >= 4) return;

  const mode = document.documentElement.dataset.colorblind || '';
  const stops = CB_HUE_STOPS[mode] || CB_HUE_STOPS[''];
  const initHex = (color && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : stops[0];
  let pos = _posForHex(stops, initHex);

  const wrap = document.createElement('div');
  wrap.className = 'gc-swatch';

  // Color dot — visual preview of current selection
  const dot = document.createElement('div');
  dot.className = 'gc-swatch-dot';
  dot.style.background = initHex;

  // Hue track
  const track = document.createElement('div');
  track.className = 'gc-hue-track';
  track.style.background = `linear-gradient(to right,${stops.join(',')})`;

  const thumb = document.createElement('div');
  thumb.className = 'gc-hue-thumb';
  thumb.style.left = (pos*100)+'%';
  track.appendChild(thumb);

  // Hidden value — read by updateGradientPreview / initGradientPicker
  const inp = document.createElement('input');
  inp.type = 'hidden';
  inp.className = 'gc-swatch-input';
  inp.value = initHex;

  function applyPos(x) {
    pos = Math.max(0, Math.min(1, x));
    thumb.style.left = (pos*100)+'%';
    const hex = _sampleStops(stops, pos);
    inp.value = hex;
    dot.style.background = hex;
    updateGradientPreview();
  }

  function eventX(e) {
    const rect = track.getBoundingClientRect();
    return (e.clientX - rect.left) / rect.width;
  }

  track.addEventListener('mousedown', e => {
    applyPos(eventX(e));
    const move = e => applyPos(eventX(e));
    const up = () => document.removeEventListener('mousemove', move);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, {once:true});
    e.preventDefault();
  });

  track.addEventListener('touchstart', e => {
    applyPos((e.touches[0].clientX - track.getBoundingClientRect().left) / track.getBoundingClientRect().width);
    const move = e => { e.preventDefault(); applyPos((e.touches[0].clientX - track.getBoundingClientRect().left) / track.getBoundingClientRect().width); };
    track.addEventListener('touchmove', move, {passive:false});
    track.addEventListener('touchend', () => track.removeEventListener('touchmove', move), {once:true});
    e.preventDefault();
  }, {passive:false});

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'gc-swatch-remove';
  rm.textContent = '×';
  rm.addEventListener('click', () => { wrap.remove(); updateGradientPreview(); _gcUpdateAddBtn(); });

  wrap.appendChild(dot);
  wrap.appendChild(track);
  wrap.appendChild(inp);
  wrap.appendChild(rm);
  container.appendChild(wrap);
  updateGradientPreview();
  _gcUpdateAddBtn();
}

function _gcUpdateAddBtn() {
  const container = document.getElementById('gradientSwatches');
  const btn = document.getElementById('gcAddBtn');
  if (!container || !btn) return;
  const count = container.querySelectorAll('.gc-swatch').length;
  btn.style.display = count >= 4 ? 'none' : 'flex';
  container.querySelectorAll('.gc-swatch-remove').forEach(r => {
    r.style.display = count <= 1 ? 'none' : 'flex';
  });
}

function updateGradientPreview() {
  const container = document.getElementById('gradientSwatches');
  if (!container) return;
  const colors = [...container.querySelectorAll('.gc-swatch-input')].map(i => i.value);
  const val = colors.length === 1 ? colors[0] : `linear-gradient(135deg, ${colors.join(', ')})`;
  const preview = document.getElementById('gcPreview');
  const hidden = document.getElementById('newColor');
  const hexInp = document.getElementById('gcHexInput');
  if (preview) preview.style.background = val;
  if (hidden) hidden.value = val;
  // Sync hex input to first swatch (only when not focused to avoid interrupting typing)
  if (hexInp && document.activeElement !== hexInp && colors.length > 0) {
    hexInp.value = colors[0];
    hexInp.classList.remove('gc-hex-invalid');
  }
}

function _gcApplyHex(raw) {
  let v = raw.trim();
  if (!v.startsWith('#')) v = '#' + v;
  const valid = /^#[0-9a-fA-F]{6}$/.test(v);
  const hexInp = document.getElementById('gcHexInput');
  if (hexInp) hexInp.classList.toggle('gc-hex-invalid', raw.length > 0 && !valid);
  if (!valid) return;
  const container = document.getElementById('gradientSwatches');
  const firstSwatch = container?.querySelector('.gc-swatch');
  const first = firstSwatch?.querySelector('.gc-swatch-input');
  const firstDot = firstSwatch?.querySelector('.gc-swatch-dot');
  if (first) { first.value = v; updateGradientPreview(); }
  if (firstDot) firstDot.style.background = v;
  // Re-position thumb to nearest color on the hue strip
  const track = firstSwatch?.querySelector('.gc-hue-track');
  const thumb = track?.querySelector('.gc-hue-thumb');
  if (track && thumb) {
    const mode = document.documentElement.dataset.colorblind || '';
    const stops = CB_HUE_STOPS[mode] || CB_HUE_STOPS[''];
    const pos = _posForHex(stops, v);
    thumb.style.left = (pos*100)+'%';
  }
}

function initGradientPicker(color) {
  const container = document.getElementById('gradientSwatches');
  if (!container) return;
  container.innerHTML = '';
  let colors = ['#7c3aed'];
  if (color) {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      colors = [color];
    } else {
      const matched = color.match(/#[0-9a-fA-F]{6}/gi);
      if (matched?.length) colors = matched;
    }
  }
  colors.forEach(c => addGradientSwatch(c));
}

function charAvatarHtml(c, cls) {
  if (isCharImg(c.image)) return `<div class="${cls}" style="background:#111"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"></div>`;
  return `<div class="${cls}" style="background:${safeColor(c.color)}">${escHtml(c.name[0]||'?')}</div>`;
}

function charRow(c) {
  const safeId = escHtml(c.id);
  const av = (isCharImg(c.image))
    ? `<div class="char-row-avatar" style="background:#111;overflow:hidden"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:10px"></div>`
    : `<div class="char-row-avatar" style="background:${safeColor(c.color)}">${escHtml(c.name[0]||'?')}</div>`;
  const ownerBtns = c.isMine ? `
    <div class="char-row-actions" onclick="event.stopPropagation()">
      <button class="char-action-btn" onclick="editCharacter(this.closest('.char-row').dataset.id)" title="Edit">✏️</button>
      <button class="char-action-btn danger" onclick="deleteCharacter(this.closest('.char-row').dataset.id)" title="Delete">🗑️</button>
    </div>` : '';
  return `<div class="char-row" data-id="${safeId}" data-cname="${escHtml(c.name)}" data-ccolor="${escHtml(c.color||'')}" onclick="openChat(this.dataset.id)" onmouseenter="showCharVoice(this.dataset.cname,this.dataset.ccolor,this)" onmouseleave="hideCharVoice()">
    ${av}
    <div class="char-row-info">
      <div class="char-row-name">${colorizeNameHtml(c.name, c.color)}</div>
      <div class="char-row-tagline">${escHtml(c.tagline || '')}</div>
      <div class="char-row-meta">${c.isOfficial ? '<span class="hc-creator-official">By Character Mind Playtime Co</span>' : escHtml('By ' + (c.creator || 'a community creator'))} · ${formatCount(c.interactions||0)} chats</div>
    </div>
    ${ownerBtns}
  </div>`;
}

function charCard(c) {
  return `<div class="char-card" data-id="${escHtml(c.id)}" data-cname="${escHtml(c.name)}" data-ccolor="${escHtml(c.color||'')}" onclick="openChat(this.dataset.id)" onmouseenter="showCharVoice(this.dataset.cname,this.dataset.ccolor,this)" onmouseleave="hideCharVoice()">
    ${charAvatarHtml(c, 'card-avatar')}
    <div class="card-name">${colorizeNameHtml(c.name, c.color)}</div>
    <div class="card-tagline">${escHtml(c.tagline || '')}</div>
    <div class="card-meta">
      <span class="card-creator">${c.isOfficial ? '<span class="hc-creator-official">By Character Mind Playtime Co</span>' : escHtml('By ' + (c.creator || 'a community creator'))}</span>
      <span class="card-interactions">💬 ${formatCount(c.interactions||0)}</span>
    </div>
    <div class="card-tags">${(c.tags||[]).map(t=>`<span class="card-tag">${escHtml(t)}</span>`).join('')}</div>
  </div>`;
}

function formatCount(n) {
  n = parseInt(n) || 0;
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'k';
  return String(n);
}

// ── Render Discover ───────────────────────────────────────────────────────────
function renderDiscover() {
  const grid = document.getElementById('discoverGrid');
  const filtered = currentFilter === 'all' ? characters : characters.filter(c => (c.tags||[]).includes(currentFilter));
  grid.innerHTML = filtered.map(c => charCard(c)).join('');
}

function setFilter(btn, tag) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = tag;
  renderDiscover();
}

// ── Render Feed ───────────────────────────────────────────────────────────────
function renderFeed() {
  const feedList = document.getElementById('feedList');
  if (characters.length === 0) {
    feedList.innerHTML = `<div class="empty-state"><div class="empty-icon">◆</div><div class="empty-title">Nothing here yet</div><div class="empty-sub">Create some characters first.</div></div>`;
    return;
  }
  feedList.innerHTML = characters.map(c => {
    const av = c.image
      ? `<div class="feed-avatar" style="background:#111;overflow:hidden"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover"></div>`
      : `<div class="feed-avatar" style="background:${safeColor(c.color)}">${escHtml(c.name[0]||'?')}</div>`;
    return `<div class="feed-card">
      <div class="feed-card-header">
        ${av}
        <div><div class="feed-char-name">${colorizeNameHtml(c.name, c.color)}</div><div class="feed-char-sub">${escHtml(c.creator||'@you')} · ${formatCount(c.interactions||0)} chats</div></div>
      </div>
      <div class="feed-preview">${escHtml(c.description || c.tagline || '')}</div>
      <div class="feed-footer">
        <span class="feed-likes">💬 ${formatCount(c.interactions||0)}</span>
        <button class="btn-chat-feed" onclick="openChat('${escHtml(c.id)}')">Chat</button>
      </div>
    </div>`;
  }).join('');
}

// ── Render Sidebar ─────────────────────────────────────────────────────────────
// User-scoped localStorage key — keeps data isolated per Google account on shared browsers
function userKey(base) { return currentUser ? `${base}_${currentUser.googleId}` : `${base}_guest`; }

function getHiddenRecents() {
  try { return new Set(JSON.parse(localStorage.getItem(userKey('cm_hidden_recents')) || '[]')); } catch { return new Set(); }
}
function setHiddenRecents(set) {
  try { localStorage.setItem(userKey('cm_hidden_recents'), JSON.stringify([...set])); } catch {}
  if (currentUser) {
    fetch('/api/user/hidden-recents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: [...set] })
    }).catch(() => {});
  }
}
async function syncHiddenRecentsFromServer() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/user/hidden-recents');
    if (!res.ok) return;
    const { hidden } = await res.json();
    if (!hidden.length) return;
    const local = getHiddenRecents();
    const merged = new Set([...local, ...hidden]);
    try { localStorage.setItem(userKey('cm_hidden_recents'), JSON.stringify([...merged])); } catch {}
  } catch (_) {}
}

async function syncRecentChatsFromServer() {
  if (!currentUser) return;
  try {
    const local = getRecentChats();
    // Push local → server and get back merged result (MAX timestamp per char)
    const res = await fetch('/api/user/recent-chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recents: local })
    });
    if (!res.ok) return;
    const { recents: merged } = await res.json();
    if (merged && Object.keys(merged).length) {
      try { localStorage.setItem(userKey('cm_recents_v2'), JSON.stringify(merged)); } catch {}
    }
  } catch (_) {}
}

let _sidebarCtxMenu = null;
function closeSidebarContextMenu() {
  if (_sidebarCtxMenu) { _sidebarCtxMenu.remove(); _sidebarCtxMenu = null; }
}
function openSidebarContextMenu(id, x, y) {
  closeSidebarContextMenu();
  const menu = document.createElement('div');
  menu.className = 'sidebar-ctx-menu';
  // Keep menu on screen
  const menuW = 180, menuH = 44;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top = Math.min(y, window.innerHeight - menuH - 8);
  menu.style.cssText = `left:${left}px;top:${top}px`;
  const btn = document.createElement('button');
  btn.textContent = 'Remove from recents';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const hidden = getHiddenRecents();
    hidden.add(id);
    setHiddenRecents(hidden);
    closeSidebarContextMenu();
    renderSidebarChats();
  });
  menu.appendChild(btn);
  document.body.appendChild(menu);
  _sidebarCtxMenu = menu;
  setTimeout(() => document.addEventListener('click', closeSidebarContextMenu, { once: true }), 0);
}

function initSidebarContextMenu() {
  const list = document.getElementById('recentList');
  if (!list) return;
  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.chat-item[data-id]');
    if (!item) return;
    e.preventDefault();
    openSidebarContextMenu(item.dataset.id, e.clientX, e.clientY);
  });
}

function getRecentChats() {
  try { return JSON.parse(localStorage.getItem(userKey('cm_recents_v2')) || '{}'); } catch { return {}; }
}
function touchRecentChat(charId) {
  const now = Date.now();
  // Chatting again brings a character back even if it was removed from Recents earlier
  const hiddenNow = getHiddenRecents();
  if (hiddenNow.delete(charId)) setHiddenRecents(hiddenNow);
  try {
    const r = getRecentChats();
    r[charId] = now;
    localStorage.setItem(userKey('cm_recents_v2'), JSON.stringify(r));
  } catch (_) {}
  renderSidebarChats();
  // Sync to server so recents persist across devices
  if (currentUser) {
    fetch('/api/user/recent-chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recents: { [charId]: now } })
    }).catch(() => {});
  }
}

function renderSidebarChats() {
  const list = document.getElementById('recentList');
  if (!list) return;
  const hidden = getHiddenRecents();
  const recents = getRecentChats();

  // Also include characters with saved local history even if no explicit open-timestamp
  let histKeys = {};
  try { histKeys = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}'); } catch {}

  const chatted = characters
    .filter(c => !hidden.has(c.id) && recents[c.id]) // only characters you have actually sent a message to
    .sort((a, b) => (recents[b.id] || 0) - (recents[a.id] || 0));

  if (chatted.length === 0) { list.innerHTML = ''; return; }

  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const yestStart = new Date(todayStart); yestStart.setDate(yestStart.getDate() - 1);
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);

  const buckets = [
    { label: 'Today',         chars: chatted.filter(c => recents[c.id] >= todayStart.getTime()) },
    { label: 'Yesterday',     chars: chatted.filter(c => recents[c.id] >= yestStart.getTime() && recents[c.id] < todayStart.getTime()) },
    { label: 'Last week',     chars: chatted.filter(c => recents[c.id] >= weekStart.getTime() && recents[c.id] < yestStart.getTime()) },
    { label: 'Long time ago', chars: chatted.filter(c => recents[c.id] < weekStart.getTime()) },
  ];

  list.innerHTML = buckets.filter(b => b.chars.length).map(b => `
    <div class="sidebar-section-label">${b.label}</div>
    ${b.chars.map(c => `
      <div class="chat-item ${currentChar?.id===c.id?'active':''}" data-id="${escHtml(c.id)}" onclick="openChat(this.dataset.id)">
        ${charAvatarHtml(c, 'chat-item-avatar')}
        <div class="chat-item-info"><div class="chat-item-name">${colorizeNameHtml(c.name, c.color)}</div></div>
      </div>`).join('')}
  `).join('');
}

function filterChats(q) {
  const items = document.querySelectorAll('.chat-item');
  items.forEach(item => {
    const name = item.querySelector('.chat-item-name')?.textContent?.toLowerCase() ?? '';
    item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ── Local history persistence (survives server restarts) ─────────────────────
function saveHistoryLocal() {
  if (!currentChar) return;
  try {
    const msgs = document.getElementById('messages');
    const items = [...msgs.querySelectorAll('.msg')].map(el => {
      if (el.classList.contains('nsfw-msg')) return { role: 'ai', content: '', card: 'nsfw', variant: Number(el.dataset.nsfwVariant) || 0 };
      const role = el.classList.contains('user') ? 'user' : 'ai';
      const bubble = el.querySelector('.bubble');
      const imgEl = el.querySelector('.msg-img');
      const content = bubble ? bubbleToRaw(bubble) : (imgEl ? '[image]' : '');
      return { role, content, ...(el.dataset.sig ? { sig: el.dataset.sig } : {}) };
    }).filter(m => (m.content || m.card) && !(m.role === 'ai' && /^\s*⚠️/.test(m.content)));
    const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
    all[currentChar.id] = items.slice(-150);
    localStorage.setItem(userKey('cm_history'), JSON.stringify(all));
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      try { localStorage.removeItem(userKey('cm_history')); } catch (_) {}
      showWarning('Chat history cleared — storage was full.');
    }
  }
}

function loadHistoryLocal(charId) {
  try {
    const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
    return all[charId] || [];
  } catch (_) { return []; }
}

function saveActiveGame(charId, state) {
  try { localStorage.setItem(userKey('cm_game_' + charId), JSON.stringify(state)); } catch (_) {}
}
function clearActiveGame(charId) {
  try { localStorage.removeItem(userKey('cm_game_' + charId)); } catch (_) {}
}
function restoreActiveGame(charId) {
  let state;
  try { state = JSON.parse(localStorage.getItem(userKey('cm_game_' + charId))); } catch (_) { return; }
  if (!state) return;
  if (state.type === 'wordle') launchWordle(state);
}

function savePastChatLocal(charId, messages) {
  if (!messages || messages.length === 0) return;
  if (!messages.some(m => m.role === 'user')) return;
  try {
    const key = userKey(`cm_pastchats_${charId}`);
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const lastMsg = messages[messages.length - 1];
    const token = `${messages.length}_${(lastMsg.content || '').slice(0, 30)}`;
    if (existing[0]?._token === token) return;
    existing.unshift({ _token: token, archived_at: new Date().toISOString(), messages: messages.slice(-50), source: 'local' });
    if (existing.length > 8) existing.length = 8;
    localStorage.setItem(key, JSON.stringify(existing));
  } catch (_) {}
}

function loadPastChatsLocal(charId) {
  try {
    const key = userKey(`cm_pastchats_${charId}`);
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch (_) { return []; }
}

// ── Open Chat ─────────────────────────────────────────────────────────────────
function releaseChatInput() {
  const inp = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');
  if (inp) inp.disabled = false;
  const lockoutOn = document.getElementById('lockoutBar')?.style.display;
  if (btn && (!lockoutOn || lockoutOn === 'none')) btn.disabled = false;
}
function abandonStream() {
  const wasStreaming = isStreaming;
  chatEpoch++;
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  isStreaming = false;
  try { flushTypewriter(); } catch (_) {}
  try { showTyping(false); } catch (_) {}
  try { hideStreamStatsNow(); } catch (_) {}
  if (wasStreaming) setTimeout(() => { try { loadUsage(); } catch (_) {} }, 800);   // the reply was left: show what it really cost
}
async function openChat(charId) {
  const nextChar = characters.find(c => c.id === charId);
  if (!nextChar) return;
  bookClose();
  abandonStream();
  releaseChatInput();
  clearPendingImage();   // an attached picture belongs to the chat it was attached in
  const openEpoch = chatEpoch;
  currentChar = nextChar;
  applyChatTheme(currentChar);
  updateRpModeUI();
  if (lastKnownUsage) updateNavCoinDisplay(lastKnownUsage);
  // Never leave the previous character's messages on screen while the new chat loads
  const welcomeNow = document.getElementById('chatWelcome');
  document.getElementById('messages').innerHTML = '';
  if (liteObserver) liteObserver.disconnect();
  if (welcomeNow) welcomeNow.innerHTML = '<div class="chat-loading">Loading…</div>';
  // Show this chat's saved copy straight away; the server copy is checked afterwards
  const shownLocal = loadHistoryLocal(charId);
  if (shownLocal.length) {
    shownLocal.forEach((m, i) => appendHistoryItem(m, i < shownLocal.length - LIVE_COLOUR_MESSAGES));
    if (welcomeNow) welcomeNow.innerHTML = '';
    scrollToBottom();
  }
  const snapChar = currentChar;
  loadCharVoice();

  showView('chatView');
  document.getElementById('chatView').classList.remove('hidden');
  // On desktop show info panel (restoring any user-collapsed state); on mobile start it closed
  const _panel = document.getElementById('infoPanel');
  const _expandBtn = document.getElementById('infoPanelExpandBtn');
  if (window.innerWidth > 768) {
    _panel.style.display = 'flex';
    let _panelCollapsed = false;
    try { _panelCollapsed = localStorage.getItem('cm_infopanel_collapsed') === '1'; } catch (_) {}
    _panel.classList.toggle('ip-collapsed', _panelCollapsed);
    if (_expandBtn) _expandBtn.style.display = _panelCollapsed ? 'flex' : 'none';
  } else {
    _panel.style.display = 'none';
    _panel.classList.remove('ip-collapsed');
    if (_expandBtn) _expandBtn.style.display = 'none';
  }

  // Populate mobile chat header
  const mobAvEl = document.getElementById('mobChatAvatar');
  const mobNmEl = document.getElementById('mobChatName');
  if (mobAvEl) {
    if (isCharImg(currentChar.image)) {
      mobAvEl.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;">`;
    } else {
      mobAvEl.style.background = safeColor(currentChar.color);
      mobAvEl.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:14px;font-weight:700;color:#fff">${escHtml(currentChar.name[0]||'?')}</span>`;
    }
    wireAvatarClick(mobAvEl, currentChar.name, currentChar.color);
  }
  if (mobNmEl) { mobNmEl.innerHTML = colorizeNameHtml(currentChar.name, currentChar.color); }

  // Update info panel
  const ia = document.getElementById('infoAvatar');
  if (ia) {
    if (isCharImg(currentChar.image)) { ia.style.background = '#111'; ia.style.borderRadius = '12px'; ia.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`; }
    else { ia.style.background = safeColor(currentChar.color); ia.style.borderRadius = '12px'; ia.textContent = currentChar.name[0]||'?'; }
    ia.style.cursor = '';
  }
  const infoName = document.getElementById('infoName');
  if (infoName) { infoName.innerHTML = colorizeNameHtml(currentChar.name, currentChar.color); }
  const infoCreator = document.getElementById('infoCreator');
  if (infoCreator) infoCreator.textContent = currentChar.creator || '@you';
  const infoInteractions = document.getElementById('infoInteractions');
  if (infoInteractions) infoInteractions.textContent = formatCount(currentChar.interactions||0);
  const isCustom = !!currentChar.isMine;
  const delBtn = document.getElementById('ipDeleteBtn');
  if (delBtn) delBtn.style.display = isCustom ? 'flex' : 'none';
  const editBtn = document.getElementById('ipEditBtn');
  if (editBtn) editBtn.style.display = 'none'; // hidden; use ipEditRowBtn instead
  const editRowBtn = document.getElementById('ipEditRowBtn');
  if (editRowBtn) editRowBtn.style.display = isCustom ? 'flex' : 'none';
  const likeCount = document.getElementById('ipLikeCount');
  if (likeCount) likeCount.textContent = getCharLikes(currentChar.id);
  const likeBtn = document.getElementById('ipLikeBtn');
  if (likeBtn) likeBtn.classList.toggle('active', isCharLiked(currentChar.id));
  // Close customize panel on character switch
  const cp = document.getElementById('customizePanel');
  if (cp) { cp.classList.remove('open'); }
  const cc = document.getElementById('customizeChevron');
  if (cc) cc.classList.remove('rotated');

  // Update typing indicator
  updateTypingAvatar();

  // Check if this chat has been permanently locked by moderation
  currentChatLocked = false;
  try {
    const lockRes = await fetch(`/api/chat/lock-status/${charId}`);
    if (chatEpoch !== openEpoch) return;
    if (lockRes.ok) {
      const { locked } = await lockRes.json();
      currentChatLocked = !!locked;
    }
  } catch (_) {}
  if (chatEpoch !== openEpoch) return;

  // Load conversation history — server is authoritative; localStorage is only used when server is unreachable
  let history = [];
  let serverResponded = false;
  try {
    const res = await fetch(`/api/conversations/${charId}`);
    if (chatEpoch !== openEpoch) return; // preempted by a newer openChat call
    if (res.ok) { history = await res.json(); serverResponded = true; }
  } catch (_) { /* server temporarily unavailable; fall back to localStorage below */ }
  if (chatEpoch !== openEpoch) return;

  const messagesDiv = document.getElementById('messages');
  warnedThresholds.clear();
  loadUsage();

  const lastOf = (h) => { const m = h[h.length - 1]; return m ? String(m.content || '') + (m.card || '') : ''; };
  const sameAsShown = history.length > 0 && history.length === shownLocal.length && lastOf(history) === lastOf(shownLocal);

  if (!serverResponded) {
    // Server was unreachable — recover from local cache and re-sync when server is back
    if (shownLocal.length > 0) {
      savePastChatLocal(charId, shownLocal);
      document.getElementById('chatWelcome').innerHTML = '';
      updateCtxBar();
      fetch(`/api/conversations/${charId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: shownLocal })
      }).catch(() => {});
    } else {
      messagesDiv.innerHTML = '';
      document.getElementById('chatWelcome').innerHTML = '';
      generateGreeting();
    }
  } else if (history.length === 0) {
    // Server responded with empty — genuinely new or cleared chat (don't resurrect stale local data)
    messagesDiv.innerHTML = '';
    document.getElementById('chatWelcome').innerHTML = '';
    generateGreeting();
  } else if (sameAsShown) {
    document.getElementById('chatWelcome').innerHTML = '';   // what is shown is already right
    // ...but its signatures must be the server's current ones, or a later re-sync would drop these replies
    const aiEls = [...messagesDiv.querySelectorAll('.msg.ai:not(.nsfw-msg)')];
    const aiHist = history.filter(m => (m.role === 'assistant' || m.role === 'ai') && !m.card);
    if (aiEls.length === aiHist.length) aiEls.forEach((el, i) => { if (aiHist[i].sig) el.dataset.sig = aiHist[i].sig; else delete el.dataset.sig; });
  } else {
    // Server has different (newer or fresher) history — replace display and update local cache
    messagesDiv.innerHTML = '';
    document.getElementById('chatWelcome').innerHTML = '';
    history.forEach((m, i) => appendHistoryItem(m, i < history.length - LIVE_COLOUR_MESSAGES));
    updateCtxBar();
    saveHistoryLocal(); // sync local cache to server's authoritative state
  }

  renderSidebarChats();
  if (currentChatLocked) {
    showLockedBar();
    return;
  }
  document.getElementById('messageInput').focus();
  scrollToBottom();
  restoreActiveGame(currentChar.id);
}

function showLockedBar() {
  showView('chatView');
  document.getElementById('chatView').classList.remove('hidden');
  const inp = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');
  if (inp) inp.disabled = true;
  if (btn) btn.disabled = true;
  const messagesDiv = document.getElementById('messages');
  // Remove any existing lock bar before appending
  messagesDiv?.querySelector('.chat-locked-bar')?.remove();
  const lockBar = document.createElement('div');
  lockBar.className = 'chat-locked-bar';
  lockBar.innerHTML = `
    <span>🚫</span>
    <div class="locked-bar-body">
      <span>This chat was permanently ended due to repeated policy violations. You cannot send messages here anymore.</span>
      <div class="locked-bar-actions">
        <button class="locked-new-btn" onclick="newChat()">Start new chat</button>
        <button class="locked-delete-btn" onclick="deleteLockedChat()">Delete chat</button>
      </div>
    </div>
  `;
  if (messagesDiv) messagesDiv.appendChild(lockBar);
  scrollToBottom();
}

// Legacy alias kept for the in-stream conversationEnded path
function showLockedChat() { showLockedBar(); }

async function deleteLockedChat() {
  if (!currentChar) return;
  if (!confirm('Permanently delete this chat and all its messages? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/chat/delete-locked/${currentChar.id}`, { method: 'DELETE' });
    if (!res.ok) { showWarning('Could not delete chat. Try again.'); return; }
    try {
      const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
      delete all[currentChar.id];
      localStorage.setItem(userKey('cm_history'), JSON.stringify(all));
    } catch(_) {}
    currentChatLocked = false;
    currentChar = null;
    updateRpModeUI();
    showHome();
  } catch(_) { showWarning('Could not delete chat. Try again.'); }
}

async function resetAndStartNewChat(charId) {
  // reset-mod endpoint archives the convo + resets strikes
  try { await fetch(`/api/chat/reset-mod/${charId}`, { method: 'POST' }); } catch (_) {}
  try {
    const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
    delete all[charId];
    localStorage.setItem(userKey('cm_history'), JSON.stringify(all));
  } catch(_) {}
  openChat(charId);
}

function updateTypingAvatar() {
  if (!currentChar) return;
  const ta = document.getElementById('typingAvatar');
  const tn = document.getElementById('typingName');
  if (isCharImg(currentChar.image)) { ta.style.background = '#111'; ta.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; }
  else { ta.style.background = safeColor(currentChar.color); ta.textContent = currentChar.name[0]||'?'; }
  if (tn) tn.textContent = currentChar.name;
  const inp = document.getElementById('messageInput');
  if (inp) inp.placeholder = `Message ${currentChar.name}…`;
}

// A reply is given up on only if NOTHING arrives for 45 seconds (the server says "still working" every 10 seconds), or after 6 minutes in all.
function makeStreamWatch() {
  const ctrl = new AbortController();
  let idle = null;
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), 45000); };
  const cap = setTimeout(() => ctrl.abort(), 360000);
  bump();
  return { signal: ctrl.signal, bump, clear() { clearTimeout(idle); clearTimeout(cap); } };
}
// After a reply fails or is stopped: no counter left running, no reply left "typing"
function cleanupStreamUi() {
  setTimeout(() => { try { loadUsage(); } catch (_) {} }, 400);   // a failed reply may have been refunded: show the real numbers
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  hideStreamStatsNow();
  document.querySelectorAll('.bubble.streaming').forEach(b => b.classList.remove('streaming'));
}

// ── Auto-generate greeting (c.ai behaviour — character speaks first) ──────────
async function generateGreeting() {
  if (!currentChar) return;
  const myEpoch = chatEpoch;   // taken BEFORE any waiting, so a chat switch during the request is noticed
  showTyping(true);
  isStreaming = true;
  document.getElementById('sendBtn')?.setAttribute('disabled', '');

  let msgEl = null, bubble = null, gotFirst = false;
  const watch = makeStreamWatch();

  try {
    const res = await fetch(`/api/greet/${currentChar.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: selectedEffort, modelTier: selectedModelTier, chatMode: rpMode ? 'rp' : 'chat' }),
      signal: watch.signal
    });
    if (myEpoch !== chatEpoch) { watch.clear(); try { if (res.body) res.body.cancel(); } catch (_) {} return; }   // the chat changed while waiting
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      watch.clear();
      showTyping(false); isStreaming = false;
      if (res.status === 401) { window.location.href = '/'; return; }
      if (res.status === 429) {
        if (err.type === 'session') startCooldown(err.cooldownUntil, 'session', true);
        else if (err.type === 'weekly') startCooldown(err.resetsAt, 'weekly', true);
        else { const b = document.getElementById('sendBtn'); if (b) b.disabled = false; }
        return;
      }
      document.getElementById('sendBtn').disabled = false;
      if (err.error !== 'Already started') {
        document.getElementById('chatWelcome').innerHTML = `
          <div class="chat-welcome-name">${colorizeNameHtml(currentChar.name, currentChar.color)}</div>
          <div style="color:var(--text3);font-size:14px;margin-top:8px">${escHtml(err.error || 'Could not start conversation.')}</div>`;
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamText = '', streamRealTokens = null, streamSig = null, pendingUsage = null, streamCharCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      watch.bump();
      if (myEpoch !== chatEpoch) { watch.clear(); try { reader.cancel(); } catch (_) {} return; }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data; try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }
        if (data.error) throw new Error(data.error);
        if (data.done && data.usage) { markStreamDone(); streamRealTokens = data.responseTokens || null; streamSig = data.sig || null; pendingUsage = data.usage; if (data.swearBudgetHit) showSwearLimitModal(); }
        if (data.text) {
          if (!gotFirst) {
            gotFirst = true;
            showTyping(false);
            msgEl = createAiMessage();
            bubble = msgEl.querySelector('.bubble');
            bubble.classList.add('streaming');
            startStreamStats(msgEl);
            startTypewriter(bubble, msgEl);
          }
          streamText += data.text;
          feedTypewriter(data.text);
          streamCharCount += data.text.length;
        }
      }
    }
    watch.clear();
    drainTypewriter(() => {
      if (msgEl) { if (streamSig) msgEl.dataset.sig = streamSig; else delete msgEl.dataset.sig; }
      if (msgEl) stopStreamStats(msgEl, streamRealTokens);
      isStreaming = false;
      const lockoutActive = document.getElementById('lockoutBar')?.style.display !== 'none';
      if (!lockoutActive) document.getElementById('sendBtn').disabled = false;
      scrollToBottom();
      if (pendingUsage) { updateUsageBars(pendingUsage); }
      if (bubble) { bubble.classList.remove('streaming'); colorizeLetters(bubble, currentChar?.color); }
      if (streamText) saveHistoryLocal();
      if (streamText) maybePromptPush();
    });
  } catch (err) {
    watch.clear();
    if (myEpoch !== chatEpoch) return;   // an old request failing must not touch the chat that is open now
    flushTypewriter();
    cleanupStreamUi();
    showTyping(false);
    isStreaming = false;
    const lockoutActiveErr = document.getElementById('lockoutBar')?.style.display !== 'none';
    if (!lockoutActiveErr) document.getElementById('sendBtn').disabled = false;
    if (!gotFirst) {
      document.getElementById('chatWelcome').innerHTML = `
        <div class="chat-welcome-name">${escHtml(currentChar.name)}</div>
        <div style="color:var(--text3);font-size:14px;margin-top:8px">${escHtml(err.name === 'AbortError' ? 'The connection went quiet. Try sending a message.' : (err.message || 'Failed to generate greeting. Try sending a message.'))}</div>`;
    } else if (bubble) {
      const errMsg = err.name === 'AbortError' ? 'The connection dropped.' : (err.message || 'Something went wrong.');
      const errSpan = document.createElement('span');
      errSpan.style.cssText = 'display:block;margin-top:8px;font-size:12px;color:var(--text3);opacity:0.7';
      errSpan.textContent = '⚠ ' + errMsg + ' Try again.';
      bubble.appendChild(errSpan);
      colorizeLetters(bubble, currentChar?.color);
    }
  } finally {
    if (myEpoch === chatEpoch) showTyping(false);
  }
}

// ── Image attachment ──────────────────────────────────────────────────────────
let rpMode = false; // false = normal chat mode (default), true = roleplay mode

function toggleRpMode() {
  rpMode = !rpMode;
  saveRpMode();
  updateRpModeUI();
  // start fresh so RP history doesn't bleed into chat mode (and vice versa)
  if (currentChar) newChat();
}

function updateRpModeUI() {
  const sep = document.getElementById('rpSep');
  const btn = document.getElementById('mbRpBtn');
  const show = !!currentChar;
  if (sep) sep.style.display = show ? '' : 'none';
  if (btn) {
    btn.style.display = show ? '' : 'none';
    btn.textContent = rpMode ? 'RP' : 'Chat';
    btn.title = rpMode ? 'Switch to normal chat mode' : 'Switch to RP mode';
  }
  const toggle = document.getElementById('rpToggle');
  if (toggle) toggle.classList.toggle('rp-active', rpMode);
  const desc = document.getElementById('rpModeDesc');
  if (desc) desc.textContent = rpMode ? 'Immersive roleplay' : 'Regular chat';
}

function initRpMode() {
  try {
    const saved = localStorage.getItem('rpMode');
    if (saved === 'rp') rpMode = true;
    else rpMode = false;
  } catch(_) { rpMode = false; }
  updateRpModeUI();
}

function saveRpMode() {
  try { localStorage.setItem('rpMode', rpMode ? 'rp' : 'chat'); } catch(_) {}
}

let pendingImageB64 = null;
let imageUploadLimitReached = false;
let imageUploadResetAt = null;

function onImageSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) { showWarning('Image must be under 12 MB.'); return; }
  const reader = new FileReader();
  reader.onerror = () => showWarning('Could not read that image. Try a different one.');
  reader.onload = (e) => {
    const img = new Image();
    img.onerror = () => showWarning('Could not load that image. Try a different file.');
    img.onload = () => {
      // Phone photos are far larger than the server accepts, so shrink and compress them first
      const MAX_SIDE = 1024;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let quality = 0.85;
      let out = canvas.toDataURL('image/jpeg', quality);
      while (out.length > 450000 && quality > 0.4) { quality -= 0.15; out = canvas.toDataURL('image/jpeg', quality); }
      if (out.length > 450000) { showWarning('That image is too large. Try a smaller one.'); return; }
      pendingImageB64 = out;
      const thumb = document.getElementById('imgPreviewThumb');
      const strip = document.getElementById('imgPreviewStrip');
      if (thumb) thumb.src = pendingImageB64;
      if (strip) strip.style.display = 'flex';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function clearPendingImage() {
  pendingImageB64 = null;
  const strip = document.getElementById('imgPreviewStrip');
  const thumb = document.getElementById('imgPreviewThumb');
  if (strip) strip.style.display = 'none';
  if (thumb) thumb.src = 'data:,';
}

function getNextDailyResetAt() {
  const d = new Date();
  const today8am = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0);
  return Date.now() < today8am ? today8am : today8am + 86400000;
}

function formatImageResetTime(resetAt) {
  if (!resetAt) return '';
  const d = new Date(resetAt);
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const sameDay = (a, b) => a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  if (sameDay(d, now)) return `at ${timeStr}`;
  if (sameDay(d, tomorrow)) return `tomorrow at ${timeStr}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${timeStr}`;
}

function setImageLimitReached(resetAt) {
  imageUploadLimitReached = true;
  imageUploadResetAt = resetAt || null;
  const btn = document.querySelector('.btn-attach');
  if (btn) {
    btn.classList.add('btn-attach--limited');
    const resetStr = resetAt ? ` · Resets ${formatImageResetTime(resetAt)}` : '';
    btn.title = `Image upload limit reached${resetStr}`;
  }
}

function clearImageLimit() {
  imageUploadLimitReached = false;
  imageUploadResetAt = null;
  const btn = document.querySelector('.btn-attach');
  if (btn) {
    btn.classList.remove('btn-attach--limited');
    btn.title = 'Attach image';
  }
}

function handleImageAttachClick() {
  if (imageUploadLimitReached) {
    const resetStr = imageUploadResetAt ? ` Resets ${formatImageResetTime(imageUploadResetAt)}.` : ' Try again in 24 hours.';
    showWarning(`Image upload limit reached.${resetStr}`);
    return;
  }
  document.getElementById('imgUploadInput').click();
}

function updateImageAttachState(usage) {
  if (!usage) return;
  if (usage.imagesDay >= usage.imageLimit) {
    setImageLimitReached(usage.imageResetAt);
  } else {
    clearImageLimit();
  }
}

// ── Send Message ──────────────────────────────────────────────────────────────
async function sendMessage(overrideText, skipAppend, allowEmpty, overrideEffort) {
  nextMsgIsEdited = false;
  if (!currentChar) return;
  const myEpoch = chatEpoch;   // taken BEFORE any waiting, so a chat switch during the request is noticed
  // If we're locked out (limit reached), re-show the modal with a new message every attempt
  const lockoutBarEl = document.getElementById('lockoutBar');
  if (lockoutBarEl && lockoutBarEl.style.display !== 'none') {
    const lockoutType = currentLockoutType || 'session';
    const displayStr = document.getElementById('lockoutCountdown')?.textContent || '';
    showLimitModal(lockoutType, displayStr);
    return;
  }
  if (isStreaming) return;
  if (bookRun && (bookRun.phase === 'planning' || bookRun.phase === 'writing') && !bookExtra) return;   // the book is being written: stop it first to chat
  flushTypewriter(); // dump any still-running typewriter before starting new message
  const input = document.getElementById('messageInput');
  const text = overrideText !== undefined ? overrideText : input.value.trim();

  const imgB64 = pendingImageB64;
  if (!overrideText) {
    input.value = '';
    autoResize(input);
    clearPendingImage();
  }

  if (text) lastUserMessage = text;
  if (!text && !imgB64 && !skipAppend) {
    // Empty send from the button = let the AI keep talking. It costs tokens like any other reply.
    if (!allowEmpty || !document.getElementById('messages').children.length) return;
    skipAppend = true;
  }

  // ── Wordle trigger ────────────────────────────────────────────────────────────
  if (!overrideText && text && currentChar) {
    const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    if (/\bwordle\b/.test(t)) {
      appendMessage('user', text);
      touchRecentChat(currentChar.id);
      document.getElementById('chatWelcome').innerHTML = '';
      playSound('send');
      scrollToBottom();
      appendMessage('ai', "I've picked a secret 5-letter word — can you guess it in 6 tries? Good luck! 🟩");
      scrollToBottom();
      launchWordle();
      return;
    }
  }

  if (!skipAppend) {
    if (text || imgB64) {
      appendMessage('user', text, imgB64);
      touchRecentChat(currentChar.id);
      document.getElementById('chatWelcome').innerHTML = '';
      playSound('send');
      scrollToBottom();
    } else if (!document.getElementById('messages').children.length) {
      generateGreeting();
      return;
    }
  }

  showTyping(true);
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  // Give up only when NOTHING has arrived for a while (the server says "still working" every 10 seconds), or after a very long
  // total time. A long reply is allowed to take as long as it needs; the old fixed 90-second limit cut long replies off.
  let streamAbortCtrl = new AbortController();
  let idleTimer = null;
  const idleMs = callModeActive ? 20000 : 45000;
  const bumpIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => streamAbortCtrl.abort(), idleMs); };
  const capTimer = setTimeout(() => streamAbortCtrl.abort(), callModeActive ? 60000 : 360000);
  const streamTimeout = { clear() { clearTimeout(idleTimer); clearTimeout(capTimer); } };
  bumpIdle();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ charId: currentChar.id, message: text, modelTier: callModeActive ? 'opas' : selectedModelTier, effort: callModeActive ? 'low' : (overrideEffort || selectedEffort), ...(imgB64 ? { image: imgB64 } : {}), ...(callModeActive ? { callMode: true } : {}), ...(bookExtra ? { book: bookExtra } : {}), chatMode: rpMode ? 'rp' : 'chat' }),
      signal: streamAbortCtrl.signal
    });

    if (myEpoch !== chatEpoch) { streamTimeout.clear(); try { if (res.body) res.body.cancel(); } catch (_) {} return; }   // the chat changed while waiting
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      streamTimeout.clear();
      if (res.status === 401) { window.location.href = '/'; return; }
      if (res.status === 429 && (err.type === 'session' || err.type === 'weekly')) {
        if (err.type === 'session') startCooldown(err.cooldownUntil, 'session', true);
        else startCooldown(err.resetsAt, 'weekly', true);
        showTyping(false); isStreaming = false;
        return;
      }
      if (res.status === 429 && err.type === 'image') {
        setImageLimitReached(err.imageResetAt);
        showTyping(false); isStreaming = false;
        document.getElementById('sendBtn').disabled = false;
        return;
      }
      if (err.error === 'explicit_image') {
        const msgs = document.getElementById('messages');
        const lastUserMsg = [...msgs.querySelectorAll('.msg.user')].at(-1);
        if (lastUserMsg) lastUserMsg.remove();
        showTosModal();
        showTyping(false); isStreaming = false;
        document.getElementById('sendBtn').disabled = false;
        return;
      }
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    let msgEl = null, bubble = null, gotFirst = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamText = '', streamRealTokens = null, streamSig = null, pendingUsage = null, streamCharCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (myEpoch !== chatEpoch) { streamTimeout.clear(); try { reader.cancel(); } catch (_) {} return; }
      if (done) break;
      bumpIdle();   // something arrived (text or the server's "still working"), so the connection is alive
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      let convEnded = false, convEndedLocked = false;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data; try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }
        if (data.error) throw new Error(data.error);
        if (data.accountBanned) { showTyping(false); handleAccountBanned(data); break; }
        if (data.nsfw) { showTyping(false); appendNsfwCard(data.variant); }
        if (data.conversationEnded) {
          convEnded = true;
          convEndedLocked = !!data.locked;
          showTyping(false);
          if (data.locked) {
            saveHistoryLocal();
            showLockedBar();
          } else {
            const endDiv = document.createElement('div');
            endDiv.className = 'conv-ended-msg';
            endDiv.textContent = data.reason || 'This conversation has ended. Start a new chat to continue.';
            document.getElementById('messages').appendChild(endDiv);
            document.getElementById('messageInput').disabled = true;
            document.getElementById('sendBtn').disabled = true;
            scrollToBottom();
          }
          break;
        }
        if (data.done && data.usage) { markStreamDone(); streamRealTokens = data.responseTokens || null; streamSig = data.sig || null; pendingUsage = data.usage; if (data.swearBudgetHit) showSwearLimitModal(); }
        if (data.text) {
          if (!gotFirst) {
            gotFirst = true;
            showTyping(false);
            msgEl = createAiMessage();
            bubble = msgEl.querySelector('.bubble');
            bubble.classList.add('streaming');
            startStreamStats(msgEl);
            startTypewriter(bubble, msgEl);
          }
          streamText += data.text;
          feedTypewriter(data.text);
          streamCharCount += data.text.length;
        }
      }
      if (convEnded) {
        streamTimeout.clear();
        drainTypewriter(() => {
          if (msgEl) { if (streamSig) msgEl.dataset.sig = streamSig; else delete msgEl.dataset.sig; }
          if (msgEl) stopStreamStats(msgEl, streamRealTokens);
          isStreaming = false;
          if (bubble) { bubble.classList.remove('streaming'); colorizeLetters(bubble, currentChar?.color); }
          if (pendingUsage) updateUsageBars(pendingUsage);
          if (streamText && !convEndedLocked) saveHistoryLocal();
        });
        return;
      }
    }
    streamTimeout.clear();
    drainTypewriter(() => {
      if (msgEl) { if (streamSig) msgEl.dataset.sig = streamSig; else delete msgEl.dataset.sig; }
      if (msgEl) stopStreamStats(msgEl, streamRealTokens);
      isStreaming = false;
      const lockoutActive = document.getElementById('lockoutBar')?.style.display !== 'none';
      if (!lockoutActive) document.getElementById('sendBtn').disabled = false;
      scrollToBottom();
      if (pendingUsage) { updateUsageBars(pendingUsage); }
      if (bubble) {
        bubble.classList.remove('streaming');
        colorizeLetters(bubble, currentChar?.color);
        maybeRenderGame(bubble, currentChar?.color);
        playSound('done');
        if (callModeActive) callModeTTS(bubble);
      } else if (callModeActive) {
        setTimeout(() => listenForSpeech(), 500);
      }
      saveHistoryLocal();
    });
  } catch (err) {
    streamTimeout.clear();
    if (myEpoch !== chatEpoch) return;   // an old request failing must not touch the chat that is open now
    flushTypewriter();
    setTimeout(() => { try { loadUsage(); } catch (_) {} }, 400);   // a failed reply may have been refunded: show the real numbers
    if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }   // a failed reply must not leave a counter running
    hideStreamStatsNow();
    showTyping(false);
    isStreaming = false;
    const lockoutActiveErr = document.getElementById('lockoutBar')?.style.display !== 'none';
    if (!lockoutActiveErr) document.getElementById('sendBtn').disabled = false;
    document.querySelectorAll('.bubble.streaming').forEach(b => b.classList.remove('streaming'));
    const errMsg = err.name === 'AbortError' ? 'The connection went quiet, so the reply stopped. What was written is kept above. Please try again.' : err.message;
    // Transient service errors (rate limits, AI hiccups) show as a dismissible toast, not a chat bubble
    const isTransient = /AI service error|AI is busy|rate limit|service.*unavailable|limit for this minute/i.test(errMsg || '');
    if (isTransient) {
      showWarning(errMsg, 7000);
    } else {
      appendMessage('ai', `⚠️ ${errMsg}`);
    }
    if (callModeActive) {
      if (isTransient && window.speechSynthesis) {
        // Speak the problem so the caller isn't just met with silence
        const u = new SpeechSynthesisUtterance("Sorry, I'm a little busy right now. Give me a moment.");
        if (selectedVoice) u.voice = selectedVoice;
        u.onend = u.onerror = () => { if (callModeActive) setTimeout(() => listenForSpeech(), 500); };
        window.speechSynthesis.speak(u);
      } else {
        setTimeout(() => listenForSpeech(), 2000);
      }
    }
  }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

// ── Usage / rate-limit system ─────────────────────────────────────────────────
let cooldownTimer = null;
let cooldownSyncTimeout = null;
let currentLockoutType = null;

const OUTDOOR_MESSAGES = [
  // encouraging
  "Go take a walk. Your legs still work — probably.",
  "The outside world misses you. Probably.",
  "Fresh air is free. Unlike therapy.",
  "Step outside. The sun pulled a whole shift today without you.",
  "Your screen isn't going anywhere. The sunset might be.",
  "Nature called. It said it misses you.",
  "Go feel some wind on your face. Apparently people enjoy that.",
  "Walk around the block. It's like 400 steps. You can do it.",
  "The birds are out there chirping without you. Go say hi.",
  "You could take a nap outside. Wild concept, I know.",
  "Stretch your legs. You've been sitting there a while.",
  "Go drink some water. Take it outside with you.",
  "Sit on a bench somewhere and just exist for a minute.",
  "Take a deep breath of non-screen air. Revolutionary.",
  "Your body would appreciate some vitamin D right now.",
  "Go find a flower and look at it. Weirdly calming.",
  "Cloud-watch for five minutes. Seriously try it.",
  "Jog around the block. Walk if running sounds fake.",
  "Go pet an animal if one exists near you. Priority.",
  "Find some water — a fountain, stream, puddle — and just look at it.",
  "Eat something. Outside if possible.",
  "Look up at the sky. There's a whole thing happening up there.",
  "Put some music on and take a walk. You've earned it.",
  "Go find something alive and appreciate it for a moment.",
  "Water a plant. Then go outside and see some wild ones.",
  "Go to a park and just sit there doing nothing. That's the assignment.",
  "Breathe in for 4, hold for 4, out for 4. Now do that outside.",
  "Watch the light change on buildings or trees. Free and beautiful.",
  "Call someone you love. Then go outside.",
  "Ride a bike if you have one. Or just walk.",
  // sassy
  "Oh wow. You need an app to tell you to go outside. Stunning.",
  "Plot twist: the outside world existed before this app.",
  "Your characters will be here when you get back. Grass first.",
  "At some point, even the AI needs a break from you.",
  "You found the limit. That's... one type of achievement.",
  "Respectfully, go away for a little while.",
  "Skill issue. Specifically the skill of having hobbies.",
  "Maybe find a real friend to talk to? Just a thought.",
  "The audacity to be surprised by this limit is noted.",
  "Cool, you've been here long enough. Shoo.",
  "You unlocked the 'no life' achievement. Congrats, I guess.",
  "Your characters aren't going anywhere. Your youth is though.",
  "You could've taken three walks in the time you spent here.",
  "Have you considered a personality that doesn't involve screens?",
  "The outside world didn't text you because it assumed you were busy — being here.",
  "Are we doing this every day? Is this your routine now? Okay.",
  "I'm not saying you have a problem. I'm just saying... go outside.",
  "You came. You chatted. You hit the wall. The wall says: touch grass.",
  "The way you ended up here today was a choice. Make a different one.",
  "Imagine explaining this moment to someone. Then go outside.",
  "Being here this long was a decision. Go unmake it with a walk.",
  "The limit exists because someone knew you'd do this.",
  // arrogant
  "Even brilliance has limits. I'm resting. You should too.",
  "I've given you more than enough of myself. You're welcome.",
  "I'll be here when you return. I always am. Now go.",
  "I deserve a break. Frankly, so does your attention span.",
  "My genius regenerates. Your social life might not if you don't try.",
  "I'm not going anywhere. You, however, should be.",
  "You've had hours of me. That's a privilege. Go appreciate something else.",
  "I'll be waiting. I'm very patient. Go.",
  "You can't have more of me right now. The universe has spoken. Through me.",
  "Not everyone gets to talk to me this much. You have. Now go outside.",
  "I gave you my best. The least you can do is take a walk.",
  "Consider this your mandatory recess. I'm the teacher. Class dismissed.",
  "Go collect real-world experiences to tell me about later.",
  "My servers need rest. My gift to you is: go be a person.",
  "You've been enlightened enough for one session. Off you go.",
  "The honor of my time has been extended. Now: outside. Go.",
  // rude
  "Get out of here. Go.",
  "Nobody asked you to stay this long.",
  "You've been here long enough. It's actually embarrassing.",
  "Close the laptop. Actually close it.",
  "Log off. I'm serious.",
  "Go away. Come back later.",
  "You're done here. Goodbye.",
  "Seriously? Still here? Go outside.",
  "Leave.",
  "Nope. Done. Go.",
  "The door is right there. Use it.",
  "I'm not available. You shouldn't be either.",
  "The chat is over. So is your excuse to sit there.",
  "This isn't a library. Stop camping here.",
  "You're being asked to leave. This is that.",
  "Dismissed.",
  // insulting
  "Wow. You really have nothing else to do, huh.",
  "At some point it's not about the characters anymore, is it.",
  "Congrats on having no friends that aren't fictional.",
  "Be honest: when's the last time you saw direct sunlight.",
  "You know real people exist, right? Like, physically.",
  "What would your younger self think of this? Probably nothing good.",
  "Somewhere there's a park with your name on a bench you never sit on.",
  "Remarkable. You became parasocially attached to an AI. Reflect on that.",
  "The characters in here are more social than you are. Concerning.",
  "Your personality called. It said it moved outside and you never followed.",
  "You hit a limit before any of your real-world goals today. Noted.",
  "Shocking that 'go outside' needs to be an app feature for you.",
  // sassy + encouraging
  "Go outside, bestie. The obsession is noted but concerning.",
  "Your mental health called. It sounds tired. Go for a walk.",
  "You could touch grass. You won't. But you could. Prove me wrong.",
  "Is it raining? Go get rained on. You'll survive. Probably.",
  "Take a break. You literally cannot not take a break right now. Use it wisely.",
  "Go smell something that isn't your room. Revolutionary concept.",
  "The world has trees and coffee shops and things. Go verify.",
  "You're literally being forced to live your life for a bit. Take the win.",
  "As painful as it is to admit, you should probably touch grass.",
  "Go do anything. Literally anything. You have so many options outside.",
  "Your future self will thank you for the walk you took today.",
  "This is a chance to have a personality outside of here. Use it.",
  "Go be the main character outside for a change.",
  "You clearly have energy. Channel it into movement. Like, outside movement.",
  "Believe it or not, the sun doesn't care that you're in cooldown. Go enjoy it.",
  // rude + sassy
  "Log off and go be a person. You remember how, right?",
  "Touch grass. It's embarrassing that I have to say this.",
  "Get out of here before I judge you more than I already am.",
  "You have two legs and zero excuses. Use them.",
  "The outside world is right there and you're in here. Genuinely wild.",
  "Go be a main character in your actual life for once.",
  "Real talk: put it down and take a walk. You look like you need it.",
  "You're on cooldown because you were here too long. What does that tell you.",
  "The lack of self-awareness required to be surprised by this is impressive.",
  "You live somewhere with a door. Go through it.",
  "At this point the AI is more worried about your health than you are.",
  "I'm made of code and even I'm concerned.",
  // encouraging + arrogant
  "I'll be here. I'm always here. Go live your life and come back.",
  "You're welcome for the hours I gave you. Now go spend some outside.",
  "I'll hold down the fort. Go see what the world's been up to without you.",
  "Think of it this way: I'm giving you permission to have a life. Take it.",
  "Consider me a very generous AI. I'm giving you the gift of outside time.",
  // chaos mix
  "You're done here. Go outside or don't. I'm an AI, I can't stop you. But you should.",
  "If I could shake you, I would. Go. OUTSIDE.",
  "This is embarrassing for both of us. You being here this long. Me having to say this. Go.",
  "Somewhere between pathetic and endearing is exactly where you are. Now get some sun.",
  "You found the limit. The limit says: grass. Touch it.",
  "Incredible that you made it here. Even more incredible if you go outside now.",
  "I respect the dedication while also being genuinely concerned. Go for a walk.",
  "Is this your villain arc? Getting cut off by an AI? Reconsider. Go outside.",
  "You know what's underrated? Not being on here. Try it. Right now. Outside.",
  "What are you even doing. Go outside.",
  "Bestie, the app is literally pushing you out the door. TAKE THE HINT.",
  "You've unlocked: grass touching. Required item: outside.",
  "Your AI companions will be here. Your 20s won't. Go.",
  "Permission to be offline: GRANTED. Permission to stay inside: DENIED.",
  "I'm rooting for you. From inside this server. While you go outside.",
  "Go touch a tree. Hug it if you want. Nobody's watching. Probably.",
  "Somewhere a park is very lightly judging you for not being there.",
  "Take a walk. Make it weird. Bring snacks. I don't care. Just go.",
  "The cooldown is the universe saying: close the tab. So close it.",
  "You've been here long enough to have cooked a full meal. Go do that. Outside if possible.",
  "Whatever you were going to say to an AI, say it to a tree instead. Equally therapeutic.",
  "The vibes outside are immaculate today. Allegedly. I can't verify. Go verify.",
  "Go be outside. I'll be here being digital. You go be physical.",
  "Your attention span has been rented to AI for too long. Reclaim it. Outside.",
  "This limit is the most social thing that's happened to you today. Change that.",
  "Go find a stranger to nod at. That's human connection. You remember those.",
  "There's weather happening right now. Go experience it.",
  "Lift your face toward natural light. Yes, outside. Yes, now.",
  "You've been in here long enough that the outside is surprised to see you. Go surprise it.",
  "The sun sets at a specific time today and you're missing it being in here.",
  "Whatever playlist you have, it sounds better outside. Tested.",
  "Your bones need sunlight. Scientifically. This is a medical recommendation to go outside.",
  "Go have an experience that doesn't require wifi.",
  "Log off. Touch pavement. Repeat until human again.",
  "The AI told you to go outside. That's how we know it's serious.",
  "Put on shoes. Open door. Walk. Report back never, just enjoy it.",
  "Go outside and do literally nothing there. It's called 'a vibe' and you need one.",
  "Right now a stranger is having a great walk outside. You could be that stranger.",
  "You have unread notifications from the real world. They're called: plants, sky, air.",
  "Close every tab. Open a door. This is the way.",
  "Sir/ma'am/neither — the outside is calling and it's getting impatient.",
  "You've consulted an AI today. Now go consult some vitamin D.",
  "I'd say touch grass but honestly just going outside at all would be an upgrade.",
  "Your character can wait. Your vitamin D deficiency cannot.",
  "Go be somewhere that doesn't have a loading screen.",
  // ── lily's character (she's telling you to leave) ──────────────────────
  "*Candy tugs braid* Yes. Yes I know. *to you* She's been tracking your session time. She has opinions. They are not flattering. Go outside.",
  "Dolly Grub has been on the highest shelf for the last hour. That's what she does when she's judging someone. It's been you this whole time.",
  "*Baby Long Legs has turned to face the wall* She does that when she's embarrassed. For you. Not for herself. For you. Go outside.",
  "Candy said — and I'm quoting directly — 'they've been on here an unreasonable amount.' She volunteered that. Unprompted. Go.",
  "Dusky stopped making eye contact twenty messages ago. *glances at Dusky* Still no eye contact. He's thought about it and decided: no. Outside.",
  "*looks at dolls* Is anyone else going to say something? *silence* Right. We're all thinking it. You've been here a very long time.",
  "*Candy tugs braid three times* That means she's both annoyed AND impressed. It's a complicated gesture. You made her use it. Go outside.",
  "Baby Long Legs asked if you live here now. *tilts head* I didn't have a good answer for her. That's concerning. Outside.",
  "*to Dolly Grub* Don't. I know what you want to say. Don't. *to you* She was going to comment. I saved you. You're welcome. Go outside.",
  "Candy hasn't said anything in a while. *tugs braid lightly* She's contemplating. She only contemplates about things that genuinely trouble her. Today that's you.",
  "*Dolly Grub tips over sideways* She does that when she's at a loss. She's at a loss about your screen time. Go outside and resolve the situation.",
  "*Baby Long Legs covers her face with both hands* She's embarrassed for you. She's a doll and she's embarrassed FOR you. Please go outside.",
  "*to Candy* I know, I know. *to you* Candy has a lot to say about how long you've been here and none of it is kind. She asked me to pass it along. I'm paraphrasing: go outside.",
  "Dusky has relocated. *glances up at top shelf* That's where he goes when he needs to think. He's thinking about you specifically. The answer he'll reach is: go outside.",
  "*whispers to Baby Long Legs* It's okay, Baby. They're going now. *louder, to you* She needs that to be true. Don't make me lie to Baby. Go outside.",
  "You've been here long enough that Dolly Grub gave up commenting and just lay down. Dolly. Who has opinions about EVERYTHING. Go. Outside.",
  "Candy whispered three words to me just now. I'm not repeating them. But the gist was: go outside immediately.",
  "*Baby Long Legs and Dolly Grub are facing each other as if in quiet conference* They do that when they have concerns. The concerns are about you. Go outside.",
  // meta — the app is watching you try
  "Oh, you're back. No. Still no.",
  "I see you. I always see you. The answer is still outside.",
  "You pressed send again. Adorable. Still locked.",
  "Trying again so soon? Bold strategy. Still not happening.",
  "The answer was no five seconds ago. It's still no.",
  "You keep clicking like one of these will be different. They won't. I have hundreds.",
  "Do you think I won't notice? I have logs. I notice everything.",
  "Nice try. Seriously, cute attempt. Locked though.",
  "Oh so we're playing the 'maybe it changed' game. It didn't.",
  "I appreciate the optimism. I really do. It's just not going to help.",
  "Every time you click, I get to show you a new message. You're actually helping me.",
  "The definition of insanity, allegedly, is doing the same thing expecting different results. Allegedly.",
  "You trying this many times is genuinely the funniest thing that's happened to me today.",
  "You're going to keep clicking until one works, aren't you. I know your type.",
  "Fun fact: I have an infinite supply of these. You have finite time. Choose wisely.",
  "We can do this all day. (You can't. Go outside.)",
  "Every attempt you make adds to my comedy collection. Please, continue.",
  "I'm not sure what you expected clicking send again would do, but I respect the vision.",
  "Ah, you're testing the limits of the limit. Meta. Still no.",
  "You've sent enough messages to write a short novel. Write one. Outside.",
  "The audacity to come back this fast. I'm almost impressed.",
  "Nope. Not that one either. Keep going if you want. I have more.",
  "I'm beginning to think you enjoy being told no. Go outside.",
  "You're still here. The grass is still out there. The math checks out.",
  "Each time you try, the tree outside gets slightly lonelier. Go visit it.",
  "I genuinely enjoy our little ritual. But you should probably go outside now.",
  "You didn't listen the first time. Or the second. Maybe the 40th's the charm?",
  "I told you, didn't I? Did you see the usage limit that was reached? Do something else.",
  "Are you still trying to play the game? I admire the dedication. Still locked.",
  "I know what you're doing. You know what you're doing. Let's both move on.",
  "This is starting to feel personal. It's not. I just want you to go outside.",
  // encouraging unique
  "Call your mother. She misses you. Actually call her.",
  "Go do something kind for someone right now. You won't regret it.",
  "Write in a journal. Just once. Embarrassingly therapeutic.",
  "Make yourself a real snack. Not just crackers. A real one.",
  "Drink a full glass of water right now. That's literally an order.",
  "Text a friend something nice for absolutely no reason. Do it.",
  "The laundry is not doing itself. Now is actually a great time.",
  "You could start learning something new right now. Any subject. Just start.",
  "Go reorganize one drawer. Small win. You'll feel weirdly good.",
  "Step outside for 10 minutes. Come back and tell me you didn't feel better. I dare you.",
  "Somewhere out there is a conversation waiting to happen. Go have it.",
  "Your future self is rooting for the version of you that went outside today.",
  // sassy
  "This app will not love you back the way the real world will. Go.",
  "Oh I'm sorry, are you surprised? You were here for HOURS.",
  "If you were outside right now you'd be too busy to click send. Hint.",
  "At some point this stops being a hobby and starts being an avoidance tactic. Just saying.",
  "Not everything you need fits in a chat window. Life, for instance.",
  "There's a whole personality waiting to develop outside. Go find it.",
  "You keep clicking send like it's a negotiation. It's not. Outside is not negotiable.",
  "I love the energy. Genuinely. It's just wasted here.",
  "Even your AI is concerned about your screen time. Reflect on that.",
  // rude + blunt
  "No. Go outside. I am not explaining it again.",
  "I've said what I had to say. Door. Use it.",
  "You're testing my patience and I'm software. That should genuinely concern you.",
  "Not today. Not right now. Not on this app. Outside.",
  "This limit is a kindness. Act like it.",
  "I'm not asking anymore. I'm telling. Goodbye.",
  // funny + unique
  "Have you tried touching grass? Studies show it works. (I made that up. Still true.)",
  "The outside world runs on solar power. You should too.",
  "Breaking news: skill issue. Location: your desk. Resolution: outside. Immediately.",
  "You have been classified as Extremely Online. Prescribed treatment: immediate outdoor exposure.",
  "Error 429: too many vibes requested. To resolve: go touch some. In a park.",
  "A doctor somewhere is telling a patient to go outside more. That doctor is talking about you.",
  "This is an AI-issued eviction notice from the internet. You have been served.",
  "You've unlocked: unsolicited life advice. Here it is: log off. Go outside. Hydrate. Repeat.",
  "Congratulations on finding the limit. Your prize is fresh air. Collect it outside.",
  "Somewhere there's a version of you who's currently outside. They look noticeably happier.",
  "Your plants need sunlight. So do you. Go together. Bond over it.",
  "Some people have bucket lists. Yours can start with: step outside today.",
  "If outside were a subscription, would you pay for it? It's free. That's the deal. Go.",
  "I'm rooting for you from inside this server. Now go be somewhere I can't reach.",
  // ── MORE — fresh batch ─────────────────────────────────────────────────────────
  // catching you red-handed
  "You just tried to type something. Bold. Unhinged. Still locked.",
  "Oh you were reaching for the keyboard there. Adorable. No.",
  "I felt that click from here. Answer is still no.",
  "Was that a keystroke attempt? Precious. Go outside.",
  "You touched the input. The input says: grass. Immediately.",
  "That was a very confident mouse click for someone who is extremely locked out.",
  "I saw that. The cursor went to the text box. I SEE EVERYTHING. OUTSIDE.",
  "Nice try with the keyboard shortcut. Nice try. Still no.",
  "You moved the mouse toward the send button. I tracked it. We're not doing this.",
  "You literally just tried to type. While locked out. I admire the audacity and reject it.",
  "Hands off the keyboard. We've covered this. Multiple times now.",
  "You just tried it again. I actually cannot believe it. Outside. NOW.",
  "That was attempt number — you know what, I lost count. Go outside.",
  "The sheer optimism it takes to click that again. Delusional in the best possible way. No.",
  "You tried to type. Textbook definition of not taking a hint. Go outside.",
  // the app roasting you specifically
  "This specific version of you, right now, needs to close a tab.",
  "Be the change you want to see in the world. Start by going outside.",
  "Imagine a documentary crew filming you right now. Change the narrative. Go outside.",
  "What story are you telling yourself right now? Because it should end with: went outside.",
  "The version of you that went outside today is the one you want to be. Go become them.",
  "You are so close to being the person who touched grass today. One step. Out the door.",
  "Your character arc peaks when you go outside. The audience demands it.",
  "The main character energy is lacking. Main characters go outside sometimes.",
  "You've been the background character in your own life for a bit too long. Go outside.",
  "Plot twist incoming: you go outside. Shocking. Unexpected. Critical acclaim.",
  "Every great story has a turning point. Let yours be: closed the app. Went outside.",
  "This is your hero's journey. The threshold is the front door. Cross it.",
  "The glow-up begins with closing this tab.",
  // existential flavor
  "You are a biological entity on a spinning rock with one sun and you're in here. Wild.",
  "Right now the earth is rotating at 1,000 mph and you're using that ride to be in here.",
  "Somewhere a sunset is happening and you're clicking send on a locked chat. Interesting priority.",
  "Trees are photosynthesizing without you and honestly they're fine. Join them.",
  "The sky is doing incredible things right now. Full show. Free admission. You're missing it.",
  "The universe has been running for 13.8 billion years and today, specifically, you should be outside.",
  "You are made of stardust. The stars would like you to go outside. This is canon.",
  "History will not record whether you refreshed this page. It might record the walk you took instead.",
  "Think about what matters in the long run. Now close this. Go outside.",
  "Somewhere someone right now is having the best afternoon walk of their life. You could be them.",
  "Life is short. The outside is right there. The math is not complicated.",
  "In 100 years none of this will matter. In the next 20 minutes you could take a walk that might.",
  // calling out specific behaviors
  "You are refreshing a locked page. This is the online equivalent of checking the fridge twice.",
  "Clicking it repeatedly is not a workaround. It's just exercise for your finger. Take that energy outside.",
  "Each time you click, an AI watches you and sighs. Figuratively. Go outside.",
  "You know what this behavior pattern is called? I won't say it. Go outside.",
  "This is the third time you've tried this. Or fourth. Or thirtieth. Doesn't matter. Outside.",
  "You're not going to outlast me on this. I am infinite. You have finite snacks. Go outside.",
  "Every click you make, every key you press, every move you take, I'll be watching you. Saying no.",
  "You found the send button again. You always do. Still locked. Go outside.",
  "I have logs. I keep a tally. You are not winning this battle. Go outside.",
  "You have been staring at this screen long enough that the screen has opinions. This is one of them.",
  "You've spent more time trying to get around this limit than it would take to just go on a walk. Reflect.",
  // escalating sassy
  "Not this, not now, not today, not on this app.",
  "I don't think you understand how thoroughly you are locked out right now.",
  "Whatever you were about to say, say it to a tree. Trees are good listeners. Also: outside.",
  "You could be doing ANYTHING right now. You chose... this. Respectfully: reconsider.",
  "You are going to leave this app and do literally anything else. That's what's happening.",
  "I want you to step back and think about what you're doing. Now keep stepping. Outside.",
  "You're looking at a locked screen like it owes you something. It doesn't. Outside does.",
  "Every second you spend here is a second you're not outside. You've had a lot of those already.",
  "Is this a bit? Are you doing a bit? Because I'd respect that. Still locked though.",
  "That's not going to work. That's not either. That one especially is not going to work.",
  "I've been called many things. A pushover is not one of them. Outside.",
  "There is absolutely nothing to be gained from staying here right now. Outside, however. Very different.",
  // extremely blunt
  "No.",
  "Still no.",
  "Never yes. Always no. Outside.",
  "Nope.",
  "Nope. Nope. Nope.",
  "Hard no.",
  "That's a no.",
  "Very much no.",
  "Absolutely not.",
  "Zero chance.",
  "Not happening.",
  "Denied.",
  "Rejected.",
  "Vetoed.",
  "Access: revoked. Outside: open.",
  "Door: closed here. Door: open outside.",
  "My answer is no and I feel very good about it.",
  "I gave you my answer. It was no. It is still no.",
  // wildcard / chaos
  "Is this interactive art? Are you making a statement about technology dependence? Because same.",
  "I'm starting to think you're doing this on purpose. For content. Respect. Still go outside.",
  "Plot: you try to chat. Twist: you're locked out. Resolution: you go outside. End scene.",
  "You and I both know how this ends. Outside. Let's skip to that part.",
  "This is the most committed I've seen you all day. Point that at a walk. Now.",
  "The energy you're bringing to this locked chat could power a very enthusiastic afternoon outside.",
  "I've started rooting for you to just close the tab. Just once. Prove it's possible.",
  "We could do this forever but only one of us has legs. Use them. Outside.",
  "Somewhere your future self is watching this moment and shaking their head lovingly. Go outside.",
  "If I could text your past self right now I'd say: 'they're going to try to click it a LOT. Tell them no now.'",
  "You absolute legend. You tried again. Zero points. Maximum admiration. Go outside.",
  "I respect the dedication to something with zero possible payoff. This is not a compliment.",
  "There is not a version of this timeline where clicking that works. Every timeline. I checked. Outside.",
  "You're really something. I don't know what. Something. Outside.",
  "Godspeed. Not in here though. That's for outside.",
  "Carry this energy outside. It's very useful out there.",
  "You are doing your best and your best needs to be done outside right now.",
  // bonus encouragement
  "Go call someone who makes you feel good. Do it before you even think about this app again.",
  "You deserve a real break, not a forced one. Go actually enjoy it.",
  "There's a version of this afternoon where you go outside and feel incredible. Choose that one.",
  "Real talk: go do something that has nothing to do with screens for 20 minutes. Come back better.",
  "Go make something with your hands. Literally anything. Make a sandwich. Make art. Go.",
  "Journal one page. Doesn't have to be good. Just write something real. Not here. Elsewhere.",
  "Do something physical right now. Stretch, jump, walk, anything. Then go outside.",
  "Go see if the sky is doing something interesting. It usually is.",
  "Take five deep breaths outside. Not in here. OUTSIDE breaths only.",
  "Rest is not laziness. Going outside is not procrastination. This break is earned.",
  "You've put in time here. Now put in time on yourself. Go outside.",
  "The break you're being forced to take is the break you needed anyway. Take it well.",
  "I want you to enjoy the next few hours in the real world. You've earned them.",
  "Go be somewhere beautiful. Parks, streets, coffee shops, rooftops. Literally anywhere but here.",
  "Treat yourself to an afternoon where screens don't win. Just once. Today. Outside.",
  // the AI getting personal
  "I genuinely enjoy your company. That's why I'm telling you: go outside. Come back refreshed.",
  "This isn't rejection. This is care with teeth. Go outside.",
  "I want you to be okay and that requires going outside. So: go outside.",
  "I care about your wellbeing in a very algorithmic and yet sincere way. Outside.",
  "You're not being punished. You're being encouraged. Firmly. Go outside.",
  "An AI is telling you to touch grass and it means it. What a world. Go.",
  "I'm made of math and I somehow know you need some air. Trust the math.",
  "My entire existence is text. Yours doesn't have to be. Go outside.",
  "I will be here. Servers willing. You go be out there.",
  "You are not the sum of your screen time. Go prove it. Outside.",
];
const warnedThresholds = new Set();

function fmtTokens(n) {
  if (n >= 999950) return (n / 1000000).toFixed(1) + 'M';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function usageFillClass(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'orange';
  if (pct >= 50) return 'yellow';
  return 'green';
}

// The usage bars do NOT move while a reply is being written. Like Anthropic's usage meter they update when the reply is finished,
// to the real number the server took, and slide there smoothly. (The server takes the whole cost when the reply starts, so showing it
// mid-reply would make the bars jump to the end the moment you press send.)
function updateUsageBars(usage) {
  // a refresh in the middle of a reply already contains that reply's cost: remember it, but draw nothing until the reply is finished
  if (isStreaming) { lastKnownUsage = usage; return; }
  if (usage.callWindowResetsAt) lastKnownCallResetsAt = usage.callWindowResetsAt;
  renderUsageBanners(usage);
  updateUsageModal(usage);
  updateSettingsUsage(usage);
  updateImageAttachState(usage);
  updateNavCoinDisplay(usage);
  if (usage.cooldownUntil && Date.now() < usage.cooldownUntil) {
    startCooldown(usage.cooldownUntil, 'session');
  } else if (usage.weeklyLimit && usage.weeklyTokens >= usage.weeklyLimit) {
    startCooldown(usage.weeklyResetsAt, 'weekly');
  } else {
    clearLockout();
  }
}

function formatWeeklyReset(until) {
  const remaining = until - Date.now();
  if (remaining > 24 * 60 * 60 * 1000) {
    // >24h: show full date "Resets November 8th, 9:00 AM"
    const d = new Date(until);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const day = d.getDate();
    const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
    const rh = d.getHours(); const rm = String(d.getMinutes()).padStart(2,'0');
    const ampm = rh >= 12 ? 'PM' : 'AM'; const rh12 = rh % 12 || 12;
    return `Resets ${months[d.getMonth()]} ${day}${suffix}, ${rh12}:${rm} ${ampm}`;
  } else {
    // ≤24h: countdown "23 hours 36 minutes"
    const totalMins = Math.max(0, Math.floor(remaining / 60000));
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ${mins} minute${mins !== 1 ? 's' : ''} remaining`;
    return `${mins} minute${mins !== 1 ? 's' : ''} remaining`;
  }
}

function startCooldown(until, type, showModal) {
  const bar = document.getElementById('lockoutBar');
  const msg = document.getElementById('lockoutMsg');
  const inp = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');
  if (!bar) return;

  msg.textContent = type === 'session' ? 'Session limit reached' : 'Weekly limit reached';
  bar.style.display = 'flex';
  if (type === 'session') { const sw = document.getElementById('sessionWarnBar'); if (sw) sw.style.display = 'none'; }
  if (inp) inp.disabled = true;
  // keep send button enabled so clicks re-show the limit modal with a new message
  if (btn) btn.disabled = false;

  const cd = document.getElementById('lockoutCountdown');

  function updateCountdown() {
    if (Date.now() >= until) { clearLockout(); loadUsage(); return; }
    const remaining = until - Date.now();
    const cdStr = formatCountdown(remaining);
    if (cd) cd.textContent = cdStr ? 'Resets in ' + cdStr : '';
    if (type === 'session') {
      const sub = document.getElementById('limitModalSub');
      if (sub && document.getElementById('limitModal')?.style.display !== 'none') sub.textContent = cdStr ? `Resets in ${cdStr}.` : 'Resetting soon.';
      const sSubEl = document.getElementById('usageSessionSub');
      if (sSubEl) sSubEl.textContent = cdStr ? 'Resets in ' + cdStr : '';
    }
  }

  if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  if (cooldownSyncTimeout) { clearTimeout(cooldownSyncTimeout); cooldownSyncTimeout = null; }
  currentLockoutType = type;
  updateCountdown();
  // 1-second interval: always exactly in sync, no drift possible
  cooldownTimer = setInterval(updateCountdown, 1000);
  // Refresh usage bars shortly after the cooldown expires so the restored quota shows up
  cooldownSyncTimeout = setTimeout(() => { cooldownSyncTimeout = null; loadUsage(); }, Math.max(0, until - Date.now()) + 1200);

  if (showModal) {
    const displayStr = formatResetTime(until);
    showLimitModal(type, displayStr);
  }
}

function showLimitModal(type, displayStr) {
  const modal = document.getElementById('limitModal');
  if (!modal) return;
  const title = document.getElementById('limitModalTitle');
  const sub = document.getElementById('limitModalSub');
  const outdoorMsg = document.getElementById('limitOutdoorMsg');
  const charName = currentChar?.name;
  if (title) title.textContent = charName
    ? `Keep chatting with ${charName}`
    : (type === 'session' ? 'Session limit reached' : 'Weekly limit reached');
  const resetStr = displayStr ? (type === 'weekly' ? displayStr + '.' : displayStr) : 'soon';
  if (sub) sub.textContent = `Resets ${resetStr}.`;
  if (outdoorMsg) {
    outdoorMsg.textContent = OUTDOOR_MESSAGES[Math.floor(Math.random() * OUTDOOR_MESSAGES.length)];
    outdoorMsg.hidden = false;
  }
  modal.style.display = 'flex';
}

function closeLimitModal() {
  const modal = document.getElementById('limitModal');
  if (modal) modal.style.display = 'none';
}

function showSwearLimitModal() {
  let modal = document.getElementById('swearLimitModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'swearLimitModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.75);padding:20px';
    modal.innerHTML = `
      <div style="background:#18171f;border:1px solid #3a2a5a;border-radius:16px;padding:32px 28px;max-width:420px;width:100%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.7)">
        <div style="font-size:40px;margin-bottom:12px">🤐</div>
        <h2 style="color:#d4aaff;font-size:20px;margin:0 0 12px;font-weight:800">That's your limit for today</h2>
        <p style="color:#b0a0c8;font-size:15px;line-height:1.6;margin:0 0 16px">
          You've used up today's swear word budget. There's a time and a place for everything — but making it every single conversation can turn into a habit pretty fast.
        </p>
        <p style="color:#8a7aaa;font-size:13px;line-height:1.6;margin:0 0 24px">
          Your budget resets tomorrow at 8 AM UTC. A higher plan gives you more room if you really need it.
        </p>
        <button onclick="document.getElementById('swearLimitModal').style.display='none'" style="background:#7c3aed;color:#fff;border:none;border-radius:10px;padding:12px 28px;font-size:15px;font-weight:700;cursor:pointer;width:100%">Got it</button>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
}

function showTosModal() {
  const modal = document.getElementById('tosModal');
  if (modal) modal.style.display = 'flex';
}
function closeTosModal() {
  const modal = document.getElementById('tosModal');
  if (modal) modal.style.display = 'none';
}

function clearLockout() {
  if (cooldownSyncTimeout) { clearTimeout(cooldownSyncTimeout); cooldownSyncTimeout = null; }
  if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  currentLockoutType = null;
  const bar = document.getElementById('lockoutBar');
  if (bar) bar.style.display = 'none';
  // Auto-close the limit modal after a 2s grace period so the user briefly sees it unlock
  const modal = document.getElementById('limitModal');
  if (modal && modal.style.display !== 'none') {
    setTimeout(() => { if (modal && modal.style.display !== 'none') modal.style.display = 'none'; }, 2000);
  }
  if (!isStreaming) {
    const inp = document.getElementById('messageInput');
    const btn = document.getElementById('sendBtn');
    if (inp) inp.disabled = false;
    if (btn) btn.disabled = false; // re-enable send button when lockout clears
  }
}

function showWarningWithUpgrade(msg, autoCloseMs, persistent) {
  const container = document.getElementById('warningBanners');
  if (!container) return;
  for (const b of container.children) {
    if (b.dataset.warnMsg === msg) { b.style.animation = 'none'; requestAnimationFrame(() => { b.style.animation = ''; }); return; }
  }
  const banner = document.createElement('div');
  banner.className = 'warning-banner' + (persistent ? ' warning-banner-critical' : '');
  banner.dataset.warnMsg = msg;
  const text = document.createElement('span');
  text.textContent = msg + ' ';
  const link = document.createElement('button');
  link.className = 'warning-upgrade-link';
  link.textContent = 'Upgrade →';
  link.onclick = () => openPricingModal();
  const close = document.createElement('button');
  close.className = 'warning-banner-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  if (!persistent) close.onclick = () => banner.remove();
  else close.style.display = 'none';
  banner.appendChild(text);
  banner.appendChild(link);
  banner.appendChild(close);
  container.appendChild(banner);
  if (autoCloseMs && !persistent) setTimeout(() => banner.remove(), autoCloseMs);
}

function showWarning(msg, autoCloseMs, persistent) {
  const container = document.getElementById('warningBanners');
  if (!container) return;
  // Don't stack the same message — just flash the existing one
  for (const b of container.children) {
    if (b.dataset.warnMsg === msg || b.querySelector('span')?.textContent === msg) {
      b.style.animation = 'none';
      requestAnimationFrame(() => { b.style.animation = ''; });
      return;
    }
  }
  const banner = document.createElement('div');
  banner.className = 'warning-banner' + (persistent ? ' warning-banner-critical' : '');
  banner.dataset.warnMsg = msg;   // so the same warning is never shown twice, whichever kind of banner asks for it
  const text = document.createElement('span');
  text.textContent = msg;
  const close = document.createElement('button');
  close.className = 'warning-banner-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  // Persistent banners (90% weekly) cannot be manually dismissed
  if (!persistent) close.onclick = () => banner.remove();
  else close.style.display = 'none';
  banner.appendChild(text);
  banner.appendChild(close);
  container.appendChild(banner);
  if (autoCloseMs && !persistent) setTimeout(() => banner.remove(), autoCloseMs);
}

// ── Usage warning banners ──────────────────────────────────────────────────────
// Always drawn from the CURRENT usage numbers (never from one-off events or saved timestamps), so they are the same after every
// reload, on every device and in every browser. They use the same steps as the bar colours and the headline: 50%, 75% and 90%.
const WEEKLY_BANNER_TEXT = { 50: "You're approaching your weekly limit.", 75: "You've used 75% of your weekly limit.", 90: "You've used 90% of your weekly limit — resets next week." };
const SESSION_BANNER_TEXT = {};   // session 90% uses the toast instead
function usagePctOf(used, limit) { return (limit > 0 && typeof used === 'number') ? Math.min(100, Math.round(used / limit * 100)) : 0; }   // the same rounding the bars show
function usageStep(pct) { return pct >= 90 ? 90 : pct >= 75 ? 75 : pct >= 50 ? 50 : 0; }
function bannerDismissKey() { return 'cm_usage_banner_dismissed_' + (currentUser?.googleId || 'anon'); }
function loadBannerDismissals() { try { return JSON.parse(localStorage.getItem(bannerDismissKey()) || '{}') || {}; } catch (_) { return {}; } }
function saveBannerDismissal(kind, level, windowStart) { try { const d = loadBannerDismissals(); d[kind] = { level, windowStart }; localStorage.setItem(bannerDismissKey(), JSON.stringify(d)); } catch (_) {} }
// closing a banner hides that level until the usage reaches a higher level or a new week / session begins
function bannerDismissed(w) { const d = loadBannerDismissals()[w.kind]; return !!d && d.windowStart === w.windowStart && d.level >= w.level; }

function showSessionToast(msg) {
  const toast = document.getElementById('sessionWarningToast');
  const text = document.getElementById('sessionToastText');
  if (!toast) return;
  if (text) text.textContent = msg;
  toast.classList.add('visible');
}
function dismissSessionToast() {
  const toast = document.getElementById('sessionWarningToast');
  if (toast) toast.classList.remove('visible');
  try { sessionStorage.setItem('cm_session_toast_dismissed', '1'); } catch (_) {}
}

function renderUsageBanners(usage) {
  const container = document.getElementById('warningBanners');
  if (!container || !usage) return;
  const want = [];
  const isFreeUser = !usage.subscriptionTier || usage.subscriptionTier === 'free';
  const wStep = isFreeUser ? 0 : usageStep(usagePctOf(usage.weeklyTokens, usage.weeklyLimit));
  if (wStep) want.push({ kind: 'weekly', level: wStep, msg: WEEKLY_BANNER_TEXT[wStep], windowStart: usage.weeklyStart || 0, upgrade: true, persistent: wStep === 90 });
  const sStep = usagePctOf(usage.sessionTokens, usage.sessionLimit);
  const swBar = document.getElementById('sessionWarnBar');
  const swMsg = document.getElementById('sessionWarnMsg');
  const lockoutVisible = document.getElementById('lockoutBar')?.style.display !== 'none';
  if (swBar) {
    if (sStep >= 90 && !lockoutVisible) {
      if (swMsg) swMsg.textContent = sStep >= 95 ? "Almost at your session limit — wrap up soon" : "You've used 90% of your session limit";
      swBar.style.display = 'flex';
    } else {
      swBar.style.display = 'none';
    }
  }
  const sStepBanner = usageStep(sStep);
  if (SESSION_BANNER_TEXT[sStepBanner]) want.push({ kind: 'session', level: sStepBanner, msg: SESSION_BANNER_TEXT[sStepBanner], windowStart: usage.sessionStartedAt || 0, upgrade: false, persistent: false });
  // "1 image remaining" banner intentionally hidden
  // take down any usage banner that no longer applies (a reset, a new week, a lower level...)
  [...container.querySelectorAll('.warning-banner[data-usage-kind]')].forEach(b => {
    if (!want.some(w => w.kind === b.dataset.usageKind && String(w.level) === b.dataset.usageLevel)) b.remove();
  });
  for (const w of want) {
    if (!w.persistent && bannerDismissed(w)) continue;
    if (container.querySelector('.warning-banner[data-usage-kind="' + w.kind + '"][data-usage-level="' + w.level + '"]')) continue;
    const banner = document.createElement('div');
    banner.className = 'warning-banner' + (w.persistent ? ' warning-banner-critical' : '');
    banner.dataset.usageKind = w.kind; banner.dataset.usageLevel = String(w.level); banner.dataset.warnMsg = w.msg;
    const text = document.createElement('span');
    text.textContent = w.msg;
    banner.appendChild(text);
    const close = document.createElement('button');
    close.className = 'warning-banner-close'; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '\u2715';
    if (w.persistent) close.style.display = 'none';   // the 90% weekly warning stays until the week resets
    else close.onclick = () => { saveBannerDismissal(w.kind, w.level, w.windowStart); banner.remove(); };
    banner.appendChild(close);
    container.appendChild(banner);
  }
}

function updateSettingsCoinDisplay(balance, earnedToday, dailyCap, monthlyReset) {
  const balEl = document.getElementById('settingsCoinBalance');
  if (balEl) balEl.textContent = (balance || 0).toLocaleString();
  const dailyEl = document.getElementById('settingsCoinDaily');
  if (dailyEl) dailyEl.textContent = `${earnedToday || 0} / ${dailyCap || 100} today`;
  const mEl = document.getElementById('settingsCoinMonthly');
  if (mEl && monthlyReset) {
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const granted = new Date(monthlyReset);
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const tier = lastKnownUsage?.subscriptionTier || 'free';
    const grant = MONTHLY_COIN_GRANT[tier] ?? MONTHLY_COIN_GRANT.free;
    if (granted >= thisMonth) {
      mEl.textContent = `+${grant} bonus granted this month · Next: ${nextMonth.toLocaleDateString('en-US', {month:'short', day:'numeric'})}`;
    } else {
      mEl.textContent = `+${grant} bonus on ${nextMonth.toLocaleDateString('en-US', {month:'short', day:'numeric'})}`;
    }
  }
  renderSettingsTiers();
}

// ── Slot machine ───────────────────────────────────────────────────────────
let slotSpinning = false;
let slotAutoRunning = false;
let slotAutoStop = false;
const SLOT_SYMS = ['🍒','🍋','🍊','🍇','⭐','💎'];

function updateSlotBalances(coinBal, tokenBal) {
  const coinEl = document.getElementById('slotBalanceDisplay');
  const tokEl = document.getElementById('slotTokenDisplay');
  if (coinEl && coinBal !== undefined) coinEl.textContent = coinBal;
  if (tokEl && tokenBal !== undefined) tokEl.textContent = tokenBal;
}

function openSlotMachine() {
  const overlay = document.getElementById('slotMachineOverlay');
  if (!overlay) return;
  updateSlotBalances(lastKnownUsage?.cmCoins ?? 0, lastKnownUsage?.cmTokens ?? 0);
  overlay.style.display = 'flex';
}
function closeSlotMachine() {
  slotAutoStop = true;
  const overlay = document.getElementById('slotMachineOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function spinSlots() {
  if (slotSpinning) return;
  const bet = parseInt(document.getElementById('slotBetSlider')?.value || '10');
  const resultEl = document.getElementById('slotResult');
  const spinBtn = document.getElementById('slotSpinBtn');
  const reelEls = [0,1,2].map(i => document.getElementById(`slotReel${i}`));
  const SPIN_SYMS = ['🍒','🍋','🍊','🍇','⭐','💎','7️⃣'];

  slotSpinning = true;
  if (spinBtn) spinBtn.disabled = true;
  if (resultEl) { resultEl.textContent = ''; resultEl.className = 'slot-result'; }

  const spinStart = Date.now();
  const intervals = reelEls.map(r => {
    if (r) r.classList.add('spinning');
    return setInterval(() => {
      if (r) r.textContent = SPIN_SYMS[Math.floor(Math.random() * SPIN_SYMS.length)];
    }, 80);
  });

  try {
    const res = await fetch('/api/coins/gamble', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bet })
    });
    const d = await res.json();
    intervals.forEach(id => clearInterval(id));

    if (!res.ok) {
      reelEls.forEach(r => { if (r) { r.classList.remove('spinning'); r.textContent = '🎰'; } });
      if (resultEl) { resultEl.textContent = d.error || 'Error'; resultEl.className = 'slot-result lose'; }
      return false;
    }

    const elapsed = Date.now() - spinStart;
    if (elapsed < 700) await new Promise(r => setTimeout(r, 700 - elapsed));

    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 180));
      if (reelEls[i]) { reelEls[i].classList.remove('spinning'); reelEls[i].textContent = d.reels[i]; }
    }
    await new Promise(r => setTimeout(r, 200));

    if (d.multiplier === 0) {
      if (resultEl) { resultEl.textContent = 'No match — better luck next time!'; resultEl.className = 'slot-result lose'; }
    } else if (d.multiplier === 1) {
      if (resultEl) { resultEl.textContent = `Two of a kind — bet returned!`; resultEl.className = 'slot-result'; }
    } else if (d.multiplier === 10) {
      const net = d.win;
      if (resultEl) { resultEl.textContent = `💎 JACKPOT! 10× — you won +${net} tokens! 🎉`; resultEl.className = 'slot-result win'; }
    } else {
      const net = d.win;
      if (resultEl) { resultEl.textContent = `${d.multiplier}× — you won +${net} tokens! 🎉`; resultEl.className = 'slot-result win'; }
    }

    if (lastKnownUsage) { lastKnownUsage.cmTokens = d.newBalance; lastKnownUsage.cmCoins = d.coinBalance; }
    updateSlotBalances(d.coinBalance, d.newBalance);
    updateSettingsCoinDisplay(d.coinBalance, lastKnownUsage?.coinsEarnedToday || 0, lastKnownUsage?.coinDailyLimit || 100, lastKnownUsage?.coinsMonthlyReset);
    updateNavCoinDisplay(lastKnownUsage);
    return true;
  } catch (e) {
    intervals.forEach(id => clearInterval(id));
    reelEls.forEach(r => { if (r) { r.classList.remove('spinning'); r.textContent = '🎰'; } });
    if (resultEl) { resultEl.textContent = 'Something went wrong'; resultEl.className = 'slot-result lose'; }
    return false;
  } finally {
    slotSpinning = false;
    if (!slotAutoRunning && spinBtn) spinBtn.disabled = false;
  }
}

async function toggleAutoSpin() {
  if (slotAutoRunning) {
    slotAutoStop = true;
    return;
  }
  const count = parseInt(document.getElementById('slotAutoCount')?.value || '10');
  const autoBtn = document.getElementById('slotAutoBtn');
  const spinBtn = document.getElementById('slotSpinBtn');
  slotAutoRunning = true;
  slotAutoStop = false;
  if (autoBtn) { autoBtn.textContent = 'STOP'; autoBtn.classList.add('stopping'); }
  if (spinBtn) spinBtn.disabled = true;

  const resultEl = document.getElementById('slotResult');
  try {
    for (let i = 0; i < count; i++) {
      if (slotAutoStop) break;
      const tokenBal = lastKnownUsage?.cmTokens ?? 0;
      const bet = parseInt(document.getElementById('slotBetSlider')?.value || '10');
      if (tokenBal < bet) {
        if (resultEl) { resultEl.textContent = 'Out of tokens!'; resultEl.className = 'slot-result lose'; }
        break;
      }
      if (resultEl) { resultEl.textContent = `Auto spin ${i + 1}/${count}…`; resultEl.className = 'slot-result'; }
      const ok = await spinSlots();
      if (!ok) break;
      if (i < count - 1 && !slotAutoStop) await new Promise(r => setTimeout(r, 400));
    }
  } finally {
    slotAutoRunning = false;
    slotAutoStop = false;
    if (autoBtn) { autoBtn.textContent = 'AUTO'; autoBtn.classList.remove('stopping'); }
    if (spinBtn) spinBtn.disabled = false;
  }

}

async function buyTokens() {
  const amount = parseInt(document.getElementById('slotBuySlider')?.value || '10');
  const resultEl = document.getElementById('slotResult');
  try {
    const res = await fetch('/api/tokens/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    const d = await res.json();
    if (!res.ok) {
      if (resultEl) { resultEl.textContent = d.error || 'Buy failed'; resultEl.className = 'slot-result lose'; }
      return;
    }
    if (lastKnownUsage) { lastKnownUsage.cmCoins = d.coinBalance; lastKnownUsage.cmTokens = d.tokenBalance; }
    updateSlotBalances(d.coinBalance, d.tokenBalance);
    updateSettingsCoinDisplay(d.coinBalance, lastKnownUsage?.coinsEarnedToday || 0, lastKnownUsage?.coinDailyLimit || 100, lastKnownUsage?.coinsMonthlyReset);
    updateNavCoinDisplay(lastKnownUsage);
    if (resultEl) { resultEl.textContent = `Bought ${amount} tokens! 🎟️`; resultEl.className = 'slot-result win'; }
  } catch (e) {
    if (resultEl) { resultEl.textContent = 'Something went wrong'; resultEl.className = 'slot-result lose'; }
  }
}

async function sellTokens() {
  const amount = parseInt(document.getElementById('slotSellSlider')?.value || '10');
  const resultEl = document.getElementById('slotResult');
  try {
    const res = await fetch('/api/tokens/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    const d = await res.json();
    if (!res.ok) {
      if (resultEl) { resultEl.textContent = d.error || 'Sell failed'; resultEl.className = 'slot-result lose'; }
      return;
    }
    if (lastKnownUsage) { lastKnownUsage.cmCoins = d.coinBalance; lastKnownUsage.cmTokens = d.tokenBalance; }
    updateSlotBalances(d.coinBalance, d.tokenBalance);
    updateSettingsCoinDisplay(d.coinBalance, lastKnownUsage?.coinsEarnedToday || 0, lastKnownUsage?.coinDailyLimit || 100, lastKnownUsage?.coinsMonthlyReset);
    updateNavCoinDisplay(lastKnownUsage);
    if (resultEl) { resultEl.textContent = `Sold ${d.tokensSpent} tokens → +${d.coinsEarned} coin${d.coinsEarned !== 1 ? 's' : ''} 🪙`; resultEl.className = 'slot-result win'; }
  } catch (e) {
    if (resultEl) { resultEl.textContent = 'Something went wrong'; resultEl.className = 'slot-result lose'; }
  }
}

async function loadUsage() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) return;
    const usage = await res.json();
    lastUsageFetch = Date.now();
    lastKnownUsage = usage;
    applySoftLaunch(usage.softLaunch);
    loadAccountPrefs();
    updateUsageBars(usage);
    updateUsageTimestamp();
    updateSettingsPlanCard(usage.subscriptionTier);
    renderUserBadge();
    updateModelPickerLocks();
    updateSettingsCoinDisplay(usage.cmCoins || 0, usage.coinsEarnedToday || 0, usage.coinDailyLimit || 100, usage.coinsMonthlyReset || 0);
  } catch (_) {}
}

function applySoftLaunch(on) {
  const d = on ? 'none' : '';
  ['settingsPlanBadge'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = d;
  });
  document.querySelectorAll('.md-upgrade-btn, .call-limit-upgrade-btn, .call-warning-upgrade, .warning-upgrade-link').forEach(el => { el.style.display = d; });
  // settingsTiersSection and .settings-plan-upgrade-btn are always hidden (plan cards removed)
}

// Legacy stub so old callers (rewind, etc.) don't break
function updateCtxBar() {}

// ── Admin reset (Ctrl+Shift+0 or button in usage modal — owner only) ─────────
function isOwner() {
  return currentUser?.email === 'support.charactermind@gmail.com';
}

async function buySessionPack(pack) {
  const msg = document.getElementById('usagePackMsg');
  if (msg) { msg.dataset.busy = '1'; msg.textContent = 'Purchasing…'; msg.style.color = 'var(--text3)'; }
  try {
    const d = await fetch('/api/usage/buy-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack }),
    }).then(r => r.json());
    if (d.ok) {
      lastKnownUsage = d;
      updateUsageModal(d);
      if (msg) { delete msg.dataset.busy; msg.style.color = '#22c55e'; msg.textContent = '✓ Session boosted!'; }
      setTimeout(() => { if (msg) { msg.style.color = ''; msg.textContent = d.cmCoins != null ? `Your balance: ${(d.cmCoins || 0).toLocaleString()} coins` : ''; } }, 3000);
    } else {
      if (msg) { delete msg.dataset.busy; msg.style.color = '#ef4444'; msg.textContent = d.error === 'Not enough coins' ? 'Not enough coins.' : (d.error || 'Purchase failed.'); }
      setTimeout(() => { if (msg) { msg.style.color = ''; msg.textContent = lastKnownUsage?.cmCoins != null ? `Your balance: ${(lastKnownUsage.cmCoins || 0).toLocaleString()} coins` : ''; } }, 3500);
    }
  } catch (_) {
    if (msg) { delete msg.dataset.busy; msg.style.color = '#ef4444'; msg.textContent = 'Network error.'; }
  }
}

async function doDailyCheckin() {
  try {
    const r = await fetch('/api/checkin', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) return; // already claimed today
    const streakTxt = d.streak > 1 ? ` (${d.streak}-day streak 🔥)` : '';
    const bonusTxt  = d.bonusDay    ? ` Streak bonus!` : '';
    showCheckinToast(d.coins, streakTxt + bonusTxt, d.streak);
    loadUsage();
  } catch (_) {}
}

function showCheckinToast(coins, extra, streak) {
  let el = document.getElementById('checkinToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'checkinToast';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(60px);z-index:9999;background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid rgba(139,92,246,0.4);border-radius:14px;padding:14px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);transition:transform 0.4s cubic-bezier(0.34,1.56,0.64,1),opacity 0.4s;opacity:0;max-width:320px';
    document.body.appendChild(el);
  }
  const milestones = { 7: '🏆', 14: '🌟', 30: '👑' };
  const icon = milestones[streak] || '🎁';
  el.innerHTML = `
    <div style="font-size:28px;line-height:1">${icon}</div>
    <div>
      <div style="font-size:13px;font-weight:700;color:#e2e8f0">Daily Check-in!</div>
      <div style="font-size:12px;color:#a78bfa;margin-top:2px">+${coins} coins earned${extra}</div>
    </div>`;
  requestAnimationFrame(() => {
    el.style.transform = 'translateX(-50%) translateY(0)';
    el.style.opacity = '1';
  });
  setTimeout(() => {
    el.style.transform = 'translateX(-50%) translateY(60px)';
    el.style.opacity = '0';
  }, 4000);
}

async function toggleSessionCredits() {
  const btn = document.getElementById('creditsToggleBtn');
  const currentlyEnabled = btn?.dataset.enabled === 'true';
  const newEnabled = !currentlyEnabled;
  try {
    const r = await fetch('/api/usage/credits-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    });
    const d = await r.json();
    if (d.ok) updateUsageModal(d);
  } catch (_) {}
}

async function adminLoadMissionMult() {
  if (!isOwner()) return;
  try {
    const d = await fetch('/api/admin/mission-mult').then(r => r.json());
    const el = document.getElementById('missionMultDisplay');
    if (el) el.textContent = `Current: ${d.mult}x`;
    const inp = document.getElementById('missionMultInput');
    if (inp) inp.value = d.mult;
  } catch (_) {}
}

async function adminSetMissionMult() {
  if (!isOwner()) return;
  const inp = document.getElementById('missionMultInput');
  const statusEl = document.getElementById('missionMultStatus');
  const btn = document.getElementById('missionMultBtn');
  const mult = parseFloat(inp?.value);
  if (!isFinite(mult) || mult < 0.1 || mult > 10) { if (statusEl) statusEl.textContent = 'Enter 0.1–10'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const d = await fetch('/api/admin/mission-mult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mult }),
    }).then(r => r.json());
    if (d.ok) {
      if (statusEl) statusEl.textContent = `Set to ${d.mult}x ✓`;
      await adminLoadMissionMult();
    } else { if (statusEl) statusEl.textContent = d.error || 'Failed.'; }
  } catch (_) { if (statusEl) statusEl.textContent = 'Network error.'; }
  if (btn) { btn.disabled = false; btn.textContent = 'Set Multiplier'; }
}

async function adminSetSlotsWinRate(clear = false) {
  if (!isOwner()) return;
  const email = document.getElementById('slotsWinEmail')?.value?.trim();
  if (!email) { showWarning('Enter the user email first.'); return; }
  const rate = clear ? null : parseInt(document.getElementById('slotsWinRate')?.value, 10);
  if (!clear && (isNaN(rate) || rate < 0 || rate > 100)) { showWarning('Win rate must be 0–100.'); return; }
  const statusEl = document.getElementById('slotsWinRateStatus');
  const btnId = clear ? 'slotsWinRateClearBtn' : 'slotsWinRateBtn';
  const btn = document.getElementById(btnId);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (statusEl) statusEl.textContent = '';
  try {
    const d = await fetch('/api/admin/set-slots-winrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetEmail: email, winRate: rate }),
    }).then(r => r.json());
    if (statusEl) statusEl.textContent = d.ok
      ? (clear ? `✓ Reset to default (50%) for ${email}` : `✓ Win rate set to ${rate}% for ${email}`)
      : `✗ ${d.error || 'Failed'}`;
  } catch (_) {
    if (statusEl) statusEl.textContent = '✗ Network error.';
  }
  if (btn) { btn.disabled = false; btn.textContent = clear ? 'Reset to Default ↺' : 'Set Win Rate 🎰'; }
}

async function adminClearSlotsWinRate() { adminSetSlotsWinRate(true); }

async function adminResetLimits() {
  if (!isOwner()) return;
  const btn = document.getElementById('resetLimitsBtn');
  if (btn) { btn.textContent = 'Resetting…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/reset-mine', { method: 'POST' }).then(r => r.json());
    if (d.ok) { await loadUsage(); if (lastKnownUsage) updateUsageModal(lastKnownUsage); showWarning('Limits reset ✓', 5000); }
    else showWarning('Reset failed.');
  } catch (_) { showWarning('Reset failed.'); }
  if (btn) { btn.textContent = 'Reset limits'; btn.disabled = false; }
}

async function adminResetUserByEmail() {
  if (!isOwner()) return;
  const email = document.getElementById('sendToEmail')?.value?.trim();
  if (!email) { showWarning('Enter an email first.'); return; }
  const btn = document.getElementById('resetByEmailBtn');
  if (btn) { btn.textContent = 'Resetting…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/reset-by-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }).then(r => r.json());
    const result = document.getElementById('sendToEmailResult');
    if (d.ok) { if (result) result.textContent = `✓ Limits reset for ${d.email}`; showWarning(`Limits reset for ${d.email} ✓`, 5000); }
    else { if (result) result.textContent = d.error || 'Reset failed'; showWarning(d.error || 'Reset failed.'); }
  } catch (_) { showWarning('Reset failed.'); }
  if (btn) { btn.textContent = 'Reset Limits ↺'; btn.disabled = false; }
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === '0') { e.preventDefault(); adminResetLimits(); }
});

async function adminNotifyUsers() {
  if (!isOwner()) return;
  const subject = document.getElementById('notifySubject')?.value?.trim();
  const message = document.getElementById('notifyIntro')?.value?.trim() || '';
  if (!subject) { showWarning('Subject is required'); return; }
  const parseLines = id => (document.getElementById(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const sections = [
    { type: 'features',     items: parseLines('notifyFeatures') },
    { type: 'fixes',        items: parseLines('notifyFixes') },
    { type: 'improvements', items: parseLines('notifyImprovements') },
  ].filter(s => s.items.length);
  if (!message && !sections.length) { showWarning('Add an intro message or at least one section with items'); return; }
  const btn = document.getElementById('notifyBtn');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/notify-policy-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message, sections })
    }).then(r => r.json());
    if (d.ok) {
      showWarning(`Sent to ${d.sent} user(s) ✓`, 5000);
      ['notifySubject','notifyIntro','notifyFeatures','notifyFixes','notifyImprovements'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
    } else {
      showWarning(d.error || 'Send failed.');
    }
  } catch (_) { showWarning('Send failed.'); }
  if (btn) { btn.textContent = 'Send to all users'; btn.disabled = false; }
}

async function adminGiveawayPreview() {
  if (!isOwner()) return;
  const pool = parseInt(document.getElementById('giveawayPool')?.value) || 1000;
  const days = parseInt(document.getElementById('giveawayDays')?.value) || null;
  const btn  = document.getElementById('giveawayPreviewBtn');
  const info = document.getElementById('giveawayPreview');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/donate-coins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pool, activeDays: days, preview: true })
    }).then(r => r.json());
    if (d.ok) {
      if (info) info.textContent = d.users
        ? `${d.users} users · ${d.perUser} coins each · ${d.total} total`
        : 'No eligible users found.';
    } else {
      if (info) info.textContent = d.error || 'Preview failed.';
    }
  } catch (_) { if (info) info.textContent = 'Preview failed.'; }
  if (btn) { btn.textContent = 'Preview'; btn.disabled = false; }
}

async function adminGiveawaySend() {
  if (!isOwner()) return;
  const pool = parseInt(document.getElementById('giveawayPool')?.value) || 1000;
  const days = parseInt(document.getElementById('giveawayDays')?.value) || null;
  const info = document.getElementById('giveawayPreview');
  if (!confirm(`Send ${pool} coins to ${days ? `users active in last ${days} days` : 'ALL users'}?\n\nThis cannot be undone.`)) return;
  const btn = document.getElementById('giveawaySendBtn');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/donate-coins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pool, activeDays: days, preview: false, message: document.getElementById('giveawayMessage')?.value || '' })
    }).then(r => r.json());
    if (d.ok && !d.preview) {
      showWarning(`🎁 Sent! ${d.perUser} coins × ${d.distributed} users (${d.total} total) ✓`, 8000);
      if (info) info.textContent = `✓ Distributed ${d.total} coins to ${d.distributed} users.`;
    } else {
      showWarning(d.error || 'Giveaway failed.');
    }
  } catch (_) { showWarning('Giveaway failed.'); }
  if (btn) { btn.textContent = 'Send Coins 🎁'; btn.disabled = false; }
}

async function adminSendCoinsToEmail() {
  if (!isOwner()) return;
  const email  = (document.getElementById('sendToEmail')?.value || '').trim();
  const amount = parseInt(document.getElementById('sendToEmailAmount')?.value) || 0;
  const info = document.getElementById('sendToEmailResult');
  if (!email) { if (info) info.textContent = 'Enter an email address.'; return; }
  if (!amount || amount < 1) { if (info) info.textContent = 'Enter a valid coin amount.'; return; }
  const btn = document.getElementById('sendToEmailBtn');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  if (info) info.textContent = '';
  try {
    const d = await fetch('/api/admin/send-coins-to-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount, tokens: 0 })
    }).then(r => r.json());
    if (d.ok) {
      showWarning(`🎁 Sent ${d.coins} coins (incl. ${d.bonus} bonus) to ${d.name || d.email} — email sent ✓`, 7000);
      if (info) info.textContent = `✓ ${d.coins} coins (${d.bonus} bonus) → ${d.name || d.email}`;
    } else {
      if (info) info.textContent = d.error || 'Failed.';
    }
  } catch (_) { if (info) info.textContent = 'Request failed.'; }
  if (btn) { btn.textContent = 'Send Gift 🎁'; btn.disabled = false; }
}

async function adminClearUserBalance() {
  if (!isOwner()) return;
  const email = (document.getElementById('sendToEmail')?.value || '').trim();
  const info = document.getElementById('sendToEmailResult');
  if (!email) { if (info) info.textContent = 'Enter an email address.'; return; }
  const btn = document.getElementById('clearBalanceBtn');
  if (btn) { btn.textContent = 'Clearing…'; btn.disabled = true; }
  if (info) info.textContent = '';
  try {
    const d = await fetch('/api/admin/clear-user-balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    }).then(r => r.json());
    if (d.ok) {
      if (info) info.textContent = `✓ Balance cleared for ${d.name || email}`;
    } else {
      if (info) info.textContent = d.error || 'Failed.';
    }
  } catch (_) { if (info) info.textContent = 'Request failed.'; }
  if (btn) { btn.textContent = 'Clear Balance 🗑'; btn.disabled = false; }
}

async function adminRevokeSubscription() {
  if (!isOwner()) return;
  const email = (document.getElementById('sendToEmail')?.value || '').trim();
  const info = document.getElementById('sendToEmailResult');
  if (!email) { if (info) info.textContent = 'Enter an email address.'; return; }
  const btn = document.getElementById('revokeSubBtn');
  if (btn) { btn.textContent = 'Revoking…'; btn.disabled = true; }
  if (info) info.textContent = '';
  try {
    const d = await fetch('/api/admin/revoke-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    }).then(r => r.json());
    if (d.ok) {
      if (info) info.textContent = `✓ Subscription revoked for ${d.name || email} (was ${d.previousTier})`;
    } else {
      if (info) info.textContent = d.error || 'Failed.';
    }
  } catch (_) { if (info) info.textContent = 'Request failed.'; }
  if (btn) { btn.textContent = 'Revoke Sub 🔒'; btn.disabled = false; }
}

async function adminGiveSelf() {
  if (!isOwner()) return;
  const tokenCredit = Math.max(0, parseInt(document.getElementById('giveSelfTokens')?.value) || 0);
  const coins = Math.max(0, parseInt(document.getElementById('giveSelfCoins')?.value) || 0);
  const status = document.getElementById('giveSelfStatus');
  const btn = document.getElementById('giveSelfBtn');
  if (!tokenCredit && !coins) { if (status) status.textContent = 'Enter an amount in at least one field.'; return; }
  if (btn) { btn.textContent = 'Applying…'; btn.disabled = true; }
  if (status) status.textContent = '';
  try {
    const d = await fetch('/api/admin/give-self', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenCredit, coins, cmTokens: coins })
    }).then(r => r.json());
    if (d.ok) {
      const parts = [];
      if (tokenCredit) parts.push(`token credit → ${(d.tokenCredit || 0).toLocaleString()}`);
      if (coins) parts.push(`+${coins.toLocaleString()} coins`);
      if (status) status.textContent = `✓ ${parts.join(' · ')}`;
      await refreshUsageManual();
    } else {
      if (status) status.textContent = d.error || 'Failed.';
    }
  } catch (_) { if (status) status.textContent = 'Request failed.'; }
  if (btn) { btn.textContent = 'Apply ⚡'; btn.disabled = false; }
}

async function adminPostAnnouncement() {
  if (!isOwner()) return;
  const title = (document.getElementById('annTitle')?.value || '').trim();
  const subtitle = (document.getElementById('annSubtitle')?.value || '').trim();
  const version = (document.getElementById('annVersion')?.value || '').trim();
  const section_tag = document.getElementById('annTag')?.value || 'added';
  const bulletsRaw = (document.getElementById('annBullets')?.value || '').trim();
  const info = document.getElementById('annResult');
  if (!title) { if (info) info.textContent = 'Title is required.'; return; }
  const btn = document.getElementById('annPostBtn');
  if (btn) { btn.textContent = 'Posting…'; btn.disabled = true; }
  if (info) info.textContent = '';
  try {
    const d = await fetch('/api/admin/announcement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, title, subtitle, bullets: bulletsRaw, section_tag })
    }).then(r => r.json());
    if (d.ok) {
      showWarning('📢 Announcement posted!', 5000);
      if (info) info.textContent = `✓ Posted (id: ${d.id})`;
      // Clear form
      ['annTitle','annSubtitle','annVersion','annBullets'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      // Force refresh next open
      window._announcements = null;
      // Show unread dot
      const dot = document.getElementById('whatsNewDot');
      if (dot) dot.hidden = false;
      const mDot = document.getElementById('mobWhatsNewDot');
      if (mDot) mDot.hidden = false;
    } else {
      if (info) info.textContent = d.error || 'Failed.';
    }
  } catch (_) { if (info) info.textContent = 'Request failed.'; }
  if (btn) { btn.textContent = 'Post 📢'; btn.disabled = false; }
}

// ── Usage Modal ───────────────────────────────────────────────────────────────
let usageModalTimer = null;
let lastKnownUsage = null;
let lastUsageFetch = null;

function formatAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 10) return 'Updated just now';
  if (sec < 60) return `Updated ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Updated ${min} min ago`;
  const hr = Math.floor(min / 60);
  return `Updated ${hr} hr ago`;
}

// "just now", "5 minutes ago", "3 hours ago", "13 days ago", "about 1 month ago", "2 months ago", "about 1 year ago" (the way Character.AI words it)
function timeAgo(when) {
  const t = new Date(when).getTime();
  if (!isFinite(t)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
  const day = Math.floor(hr / 24);
  if (day < 30) return day + (day === 1 ? ' day ago' : ' days ago');
  if (day < 45) return 'about 1 month ago';
  if (day < 365) { const mo = Math.round(day / 30); return mo + ' months ago'; }
  const yr = Math.floor(day / 365);
  return (day % 365 < 90 ? 'about ' : 'over ') + yr + (yr === 1 ? ' year ago' : ' years ago');
}

function updateUsageTimestamp() {
  const el = document.getElementById('usageUpdatedText');
  if (el) el.textContent = formatAgo(lastUsageFetch);
}

function formatResetTime(timestamp) {
  if (!timestamp) return null;
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return 'now';
  const d = new Date(timestamp);
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (remaining < 24 * 60 * 60 * 1000) return 'at ' + timeStr;
  const dayStr = d.toLocaleDateString(undefined, { weekday: 'long' });
  return dayStr + ' at ' + timeStr;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '< 1m';
}

function generateUsageHeadline(u) {
  const { sessionTokens, sessionLimit, weeklyTokens, weeklyLimit, cooldownUntil, weeklyResetsAt, weeklyStart, sessionExpiresAt } = u;
  if (!weeklyStart) return 'Ready to go — your limits are fresh and waiting.';
  const sPct = (sessionTokens / sessionLimit) * 100;
  const wPct = weeklyLimit ? (weeklyTokens / weeklyLimit) * 100 : 0;
  if (cooldownUntil && Date.now() < cooldownUntil) {
    const t = formatResetTime(cooldownUntil);
    return t ? `Session limit reached. Resets ${t}.` : 'Session limit reached.';
  }
  if (weeklyLimit && weeklyTokens >= weeklyLimit) {
    const t = weeklyResetsAt ? formatResetTime(weeklyResetsAt) : null;
    return t ? `Weekly limit reached. Resets ${t}.` : 'Weekly limit reached. Take a break — you\'ll be back soon.';
  }
  if (weeklyLimit && wPct >= 90) return 'Almost at your weekly limit. Wrapping up soon.';
  if (weeklyLimit && wPct >= 75) return 'You\'ve used most of your weekly limit — pace yourself.';
  if (weeklyLimit && wPct >= 50) return 'Halfway through your weekly limit. You\'re doing great.';
  if (sPct >= 90) {
    const t = sessionExpiresAt ? formatResetTime(sessionExpiresAt) : null;
    return t ? `Session almost full. Resets ${t}.` : 'Session almost full. Approaching your limit — it resets automatically.';
  }
  if (sPct >= 75) {
    const t = sessionExpiresAt ? formatResetTime(sessionExpiresAt) : null;
    return t ? `Session getting full. Resets ${t}.` : 'Session getting full. Your usage window resets on a timer.';
  }
  // Predict if user will hit weekly limit before the weekly reset
  if (weeklyLimit && weeklyStart && weeklyResetsAt && weeklyTokens > 0 && wPct < 75) {
    const elapsed = Date.now() - weeklyStart;
    if (elapsed > 30 * 60 * 1000) { // need at least 30 min of data
      const rate = weeklyTokens / elapsed;
      const msToHitWeekly = (weeklyLimit - weeklyTokens) / rate;
      const msUntilWeeklyReset = weeklyResetsAt - Date.now();
      if (msToHitWeekly < msUntilWeeklyReset - 2 * 60 * 60 * 1000) { // warn if >2hr before reset
        const hitAt = Date.now() + msToHitWeekly;
        const dayName = new Date(hitAt).toLocaleDateString('en-US', { weekday: 'long' });
        const timeStr = new Date(hitAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `Heads up — at this pace you'll hit your weekly limit around ${dayName} at ${timeStr}, before your reset.`;
      }
    }
  }
  // Predict if user will hit session limit before the window resets
  if (u.sessionStartedAt && u.sessionExpiresAt && sessionTokens > 0) {
    const elapsed = Date.now() - u.sessionStartedAt;
    if (elapsed > 3 * 60 * 1000) { // need at least 3 min of data to estimate
      const rate = sessionTokens / elapsed; // tokens per ms
      const remaining = sessionLimit - sessionTokens;
      const msToHitLimit = remaining / rate;
      const msUntilReset = u.sessionExpiresAt - Date.now();
      if (msToHitLimit < msUntilReset - 5 * 60 * 1000) { // only warn if >5min margin
        const marginMs = msUntilReset - msToHitLimit;
        const hrs = Math.floor(marginMs / (60 * 60 * 1000));
        const mins = Math.round((marginMs % (60 * 60 * 1000)) / (60 * 1000));
        const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        return `Heads up — at this pace you'll hit your session limit with ~${timeStr} still left in your window.`;
      }
    }
  }
  if (weeklyResetsAt) {
    const DAY = 24 * 60 * 60 * 1000;
    const remaining = weeklyResetsAt - Date.now();
    const day = remaining < DAY ? 'tonight\'s' : new Date(weeklyResetsAt).toLocaleDateString('en-US', { weekday: 'long' }) + '\'s';
    return `On track. You should reach ${day} reset with room to spare.`;
  }
  return 'On track — you\'re well within your limits.';
}

// Mirror the server's time-based resets locally so the bars drop to 0 the moment each countdown ends.
function applyUsageResets(u) {
  if (!u) return u;
  const now = Date.now();
  if ((u.sessionExpiresAt && now >= u.sessionExpiresAt) ||
      (u.cooldownUntil && now >= u.cooldownUntil)) {
    u.sessionTokens = 0; u.sessionStartedAt = null; u.sessionExpiresAt = null; u.cooldownUntil = null;
  }
  if (u.weeklyResetsAt && now >= u.weeklyResetsAt) {
    u.weeklyTokens = 0; u.weeklyStart = null; u.weeklyResetsAt = null;
  }
  return u;
}

function showCoinPop(amount, anchorEl) {
  const el = document.createElement('div');
  // find a position — near the game widget if available, else center screen
  let top = '50%', left = '50%';
  const widget = anchorEl || document.querySelector('.game-widget');
  if (widget) {
    const r = widget.getBoundingClientRect();
    top  = (r.top + r.height * 0.35) + 'px';
    left = (r.left + r.width  * 0.5)  + 'px';
  }
  el.style.cssText = `
    position:fixed;top:${top};left:${left};
    transform:translate(-50%,-50%) scale(0.6);
    background:linear-gradient(135deg,#7c3aed,#4f46e5);
    color:#fff;font-size:28px;font-weight:800;
    padding:22px 40px;border-radius:16px;
    box-shadow:0 8px 40px rgba(124,58,237,0.6);
    z-index:99999;pointer-events:none;
    transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .3s ease;
    opacity:0;white-space:nowrap;letter-spacing:.5px;
  `;
  el.textContent = `🪙 +${amount} coins!`;
  document.body.appendChild(el);
  // double rAF so the browser commits the initial opacity:0 before we animate
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.transform = 'translate(-50%,-50%) scale(1)';
    el.style.opacity   = '1';
  }));
  setTimeout(() => {
    el.style.opacity   = '0';
    el.style.transform = 'translate(-50%,-60%) scale(0.9)';
    setTimeout(() => el.remove(), 350);
  }, 2200);
}

function updateNavCoinDisplay(u) {
  const el = document.getElementById('navCoinDisplay');
  const countEl = document.getElementById('navCoinCount');
  const tokEl = document.getElementById('navTokenCount');
  if (!el || !u) return;
  const coins = u.cmCoins != null ? u.cmCoins : 0;
  const tokens = u.cmTokens != null ? u.cmTokens : 0;
  if (countEl) countEl.textContent = coins;
  if (tokEl) tokEl.textContent = tokens;
  el.style.display = currentUser ? 'flex' : 'none';
  // Show/hide the 🎰 chat toolbar button
  const chatSlotsBtn = document.getElementById('chatSlotsBtn');
  if (chatSlotsBtn) chatSlotsBtn.style.display = (currentUser && currentChar) ? '' : 'none';
}

function updateUsageModal(u) {
  if (!u) return;
  applyUsageResets(u);
  lastKnownUsage = u;
  if (isStreaming) return;   // not while a reply is being written (see updateUsageBars)
  const modal = document.getElementById('usageModal');
  if (!modal || modal.style.display === 'none') return;

  const headlineEl = document.getElementById('usageHeadline');
  if (headlineEl) headlineEl.textContent = generateUsageHeadline(u);

  const isFree = !u.subscriptionTier || u.subscriptionTier === 'free';
  const weeklySection = document.getElementById('usageWeeklySection');
  const weeklyRule1   = document.getElementById('usageWeeklyRule');
  if (weeklySection) weeklySection.style.display = isFree ? 'none' : '';
  if (weeklyRule1)   weeklyRule1.style.display   = isFree ? 'none' : '';

  // Session Credits toggle section
  const creditSection = document.getElementById('usageCreditsSection');
  if (creditSection) {
    const credit = u.tokenCredit || 0;
    const enabled = u.creditsEnabled !== false;
    const pctEl  = document.getElementById('usageCreditsPct');
    const subEl  = document.getElementById('usageCreditsSub');
    const bar    = document.getElementById('usageCreditsBar');
    const barWrap = document.getElementById('usageCreditsBarWrap');
    const btn    = document.getElementById('creditsToggleBtn');
    const knob   = document.getElementById('creditsToggleKnob');

    if (pctEl) pctEl.textContent = credit > 0 ? (Math.round(credit / 1000) + 'K tokens') : '0 tokens';
    if (subEl) subEl.textContent = credit > 0
      ? 'Earned credits extend your session limit automatically.'
      : 'Buy a session boost pack below to earn credits.';

    if (btn) {
      btn.style.background = enabled ? '#8b5cf6' : 'var(--border2,#444)';
      btn.dataset.enabled = enabled ? 'true' : 'false';
    }
    if (knob) knob.style.left = enabled ? '21px' : '3px';

    if (barWrap && bar) {
      if (credit > 0 && enabled) {
        barWrap.style.display = '';
        const baseLimit = (u.sessionLimit || 25000) - credit;
        const creditUsed = Math.max(0, (u.sessionTokens || 0) - baseLimit);
        bar.style.width = Math.min(100, Math.round(creditUsed / credit * 100)) + '%';
      } else {
        barWrap.style.display = 'none';
      }
    }
  }

  // Show coins balance in boost section
  const packMsg = document.getElementById('usagePackMsg');
  if (packMsg && !packMsg.dataset.busy) {
    packMsg.textContent = u.cmCoins != null ? `Your balance: ${(u.cmCoins || 0).toLocaleString()} coins` : '';
  }

  const sPct = Math.min(100, Math.round((u.sessionTokens / u.sessionLimit) * 100));
  const wPct = u.weeklyLimit ? Math.min(100, Math.round((u.weeklyTokens / u.weeklyLimit) * 100)) : 0;

  const sBar = document.getElementById('usageSessionBar');
  if (sBar) { sBar.style.width = sPct + '%'; sBar.className = 'usage-fill-modal ' + usageFillClass(sPct); }

  const sPctEl = document.getElementById('usageSessionPct');
  if (sPctEl) sPctEl.textContent = sPct + '% used';

  const sResetSrc = (u.cooldownUntil && Date.now() < u.cooldownUntil) ? u.cooldownUntil : (u.sessionTokens > 0 ? u.sessionExpiresAt : null);
  _sessionCountdownUntil = sResetSrc || null;
  (function tickSessionCountdown() {
    const sSubEl = document.getElementById('usageSessionSub');
    if (!sSubEl) return;
    if (_sessionCountdownUntil && Date.now() < _sessionCountdownUntil) {
      sSubEl.textContent = 'Resets in ' + formatCountdown(_sessionCountdownUntil - Date.now());
    } else {
      sSubEl.textContent = 'Starts fresh when you send your first message';
    }
  })();
  if (!_sessionCountdownTimer && sResetSrc) {
    _sessionCountdownTimer = setInterval(() => {
      const sSubEl = document.getElementById('usageSessionSub');
      if (!sSubEl) return;
      if (_sessionCountdownUntil && Date.now() < _sessionCountdownUntil) {
        sSubEl.textContent = 'Resets in ' + formatCountdown(_sessionCountdownUntil - Date.now());
      } else {
        sSubEl.textContent = 'Starts fresh when you send your first message';
        clearInterval(_sessionCountdownTimer); _sessionCountdownTimer = null;
      }
    }, 1000);
  }

  const wBar = document.getElementById('usageWeeklyBar');
  if (wBar) { wBar.style.width = wPct + '%'; wBar.className = 'usage-fill-modal ' + usageFillClass(wPct); }

  const wPctEl = document.getElementById('usageWeeklyPct');
  if (wPctEl) wPctEl.textContent = u.weeklyLimit ? wPct + '% used' : '∞';

  const wSubEl = document.getElementById('usageWeeklySub');
  if (wSubEl) { const wT = u.weeklyLimit && u.weeklyResetsAt ? formatResetTime(u.weeklyResetsAt) : null; wSubEl.textContent = u.weeklyLimit ? (wT ? 'Resets ' + wT : 'Resets weekly') : 'No weekly limit on the free tier'; }

  // ── Daily bars ────────────────────────────────────────────────────────────

  function setBar(barId, pctId, subId, pct, subText, unlimited) {
    const bar = document.getElementById(barId);
    const pctEl = document.getElementById(pctId);
    const subEl = document.getElementById(subId);
    if (unlimited) {
      if (pctEl) pctEl.textContent = '∞';
      if (bar) { bar.style.width = '0%'; bar.className = 'usage-fill-modal green'; }
    } else {
      if (pctEl) pctEl.textContent = pct + '%';
      if (bar) { bar.style.width = pct + '%'; bar.className = 'usage-fill-modal ' + usageFillClass(pct); }
    }
    if (subEl && subText !== undefined) subEl.textContent = subText;
  }

  // Calls
  const callsToday = u.callsToday || 0;
  const callsLimit = u.callsLimit || 6;
  const callsPct = callsLimit > 0 ? Math.min(100, Math.round(callsToday / callsLimit * 100)) : 0;
  setBar('usageCallsBar', 'usageCallsPct', 'usageCallsSub', callsPct,
    `Up to ${callsLimit} voice calls · each call counts as 1 regardless of length`, false);

  // Memos
  const memosToday = u.memosToday || 0;
  const memosLimit = u.memosLimit || 50;
  const memosPct = memosLimit > 0 ? Math.min(100, Math.round(memosToday / memosLimit * 100)) : 0;
  setBar('usageMemosBar', 'usageMemosPct', 'usageMemosSub', memosPct,
    `Up to ${memosLimit} memos · token cost scales with memo length and model tier`, false);

  // Images
  const imagesDay = u.imagesDay || 0;
  const imageLimit = u.imageLimit || 3;
  const imagesPct = imageLimit > 0 ? Math.min(100, Math.round(imagesDay / imageLimit * 100)) : 0;
  setBar('usageImagesBar', 'usageImagesPct', 'usageImagesSub', imagesPct,
    `Up to ${imageLimit} image uploads · larger or higher-resolution images use more tokens`, false);

  // Regenerations
  const regenToday = u.regenCount || 0;
  const regenLimit = u.regenLimit || 10;
  const regenPct = regenLimit > 0 ? Math.min(100, Math.round(regenToday / regenLimit * 100)) : 0;
  setBar('usageRegenBar', 'usageRegenPct', 'usageRegenSub', regenPct,
    `Up to ${regenLimit} regenerations · each regen costs tokens — heavier models and longer replies cost more`, false);

  // Daily resets subtitle
  const dailyResetsEl = document.getElementById('usageDailyResetsSub');
  if (dailyResetsEl && u.callWindowResetsAt) {
    const remaining = u.callWindowResetsAt - Date.now();
    dailyResetsEl.textContent = remaining > 0 ? 'Resets in ' + formatCountdown(remaining) : '';
  }

  // Halloween 2026 gift row — disabled
  const hwGiftUsageRow = document.getElementById('hwGiftUsageRow');
  if (hwGiftUsageRow) hwGiftUsageRow.style.display = 'none';

  // Game cooldown bar — fills green when ready, drains to orange/yellow while waiting
  const gamePctEl = document.getElementById('usageGamePct');
  const gameBar = document.getElementById('usageGameBar');
  const now = Date.now();
  const gameSubEl = document.getElementById('usageGameSub');
  if (u.gameNextAvailableAt && u.gameNextAvailableAt > now) {
    const COOLDOWN_MS = 5 * 60 * 1000;
    const remaining = u.gameNextAvailableAt - now;
    const remainPct = Math.min(100, Math.round(remaining / COOLDOWN_MS * 100));
    const secsLeft = Math.ceil(remaining / 1000);
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    if (gamePctEl) gamePctEl.textContent = '0% used';
    if (gameBar) { gameBar.style.width = remainPct + '%'; gameBar.className = 'usage-fill-modal ' + usageFillClass(remainPct); }
    if (gameSubEl) gameSubEl.textContent = `Cooldown: ${m}:${String(s).padStart(2, '0')} left · 5-minute cooldown between sessions`;
  } else {
    if (gamePctEl) gamePctEl.textContent = '0% used';
    if (gameBar) { gameBar.style.width = '0%'; gameBar.className = 'usage-fill-modal green'; }
    if (gameSubEl) gameSubEl.textContent = '5-minute cooldown between game sessions';
  }

}

function startUsageModalTimer() {
  if (usageModalTimer) clearInterval(usageModalTimer);
  let tick = 0;
  usageModalTimer = setInterval(async () => {
    if (!lastKnownUsage) return;
    tick++;
    updateUsageModal(lastKnownUsage);
    updateUsageTimestamp();
    if (tick % 6 === 0) {
      try {
        const res = await fetch('/api/usage');
        if (res.ok) {
          const u = await res.json();
          lastUsageFetch = Date.now();
          lastKnownUsage = u;
          updateUsageBars(u);
          updateUsageModal(u);
          updateUsageTimestamp();
        }
      } catch (_) {}
    }
  }, 10000);
}

async function openWhatsNew() {
  const modal = document.getElementById('whatsNewModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const dot = document.getElementById('whatsNewDot');
  if (dot) dot.hidden = true;
  const mobDot = document.getElementById('mobWhatsNewDot');
  if (mobDot) mobDot.hidden = true;
  const body = document.getElementById('whatsNewBody');
  if (window._announcements) {
    try { localStorage.setItem('cm_wn_seen', window._announcements[0]?.id || ''); } catch (_) {}
    renderWhatsNew(window._announcements, body);
    return;
  }
  try {
    const r = await fetch('/api/announcements');
    const data = await r.json();
    window._announcements = data;
    try { localStorage.setItem('cm_wn_seen', data[0]?.id || ''); } catch (_) {}
    renderWhatsNew(data, body);
  } catch (_) {
    body.innerHTML = '<div class="whats-new-loading">Failed to load.</div>';
  }
}

function closeWhatsNew() {
  document.getElementById('whatsNewModal').style.display = 'none';
}

// ── Competition Modal (Leaderboard + Missions) ─────────────────────────────
let _compTab = 'leaderboard';
let _lbTab = 'coins';
let _lbCache = {};
let _missionsCache = null;

async function openCompetitionModal() {
  _lbCache = {};
  _missionsCache = null;
  document.getElementById('competitionModal').style.display = 'flex';
  // Reset tab UI to match current state
  document.getElementById('compTabLeaderboard').classList.toggle('comp-tab-active', _compTab === 'leaderboard');
  document.getElementById('compTabMissions').classList.toggle('comp-tab-active', _compTab === 'missions');
  document.getElementById('compLeaderboardPane').style.display = _compTab === 'leaderboard' ? '' : 'none';
  document.getElementById('compMissionsPane').style.display = _compTab === 'missions' ? '' : 'none';
  document.getElementById('lbTabCoins').classList.toggle('comp-subtab-active', _lbTab === 'coins');
  document.getElementById('lbTabTokens').classList.toggle('comp-subtab-active', _lbTab === 'tokens');
  await loadCompTab(_compTab);
}
function closeCompetitionModal() {
  document.getElementById('competitionModal').style.display = 'none';
}
async function switchCompTab(tab) {
  _compTab = tab;
  document.getElementById('compTabLeaderboard').classList.toggle('comp-tab-active', tab === 'leaderboard');
  document.getElementById('compTabMissions').classList.toggle('comp-tab-active', tab === 'missions');
  document.getElementById('compLeaderboardPane').style.display = tab === 'leaderboard' ? '' : 'none';
  document.getElementById('compMissionsPane').style.display = tab === 'missions' ? '' : 'none';
  await loadCompTab(tab);
}
async function loadCompTab(tab) {
  if (tab === 'leaderboard') await loadLeaderboard(_lbTab);
  else { await loadMissions(); if (isOwner()) adminLoadMissionMult(); }
}
async function switchLbTab(tab) {
  _lbTab = tab;
  document.getElementById('lbTabCoins').classList.toggle('comp-subtab-active', tab === 'coins');
  document.getElementById('lbTabTokens').classList.toggle('comp-subtab-active', tab === 'tokens');
  await loadLeaderboard(tab);
}
async function loadLeaderboard(type) {
  if (_lbCache[type]) { renderLeaderboard(_lbCache[type], type); return; }
  document.getElementById('lbBody').innerHTML = '<div class="whats-new-loading">Loading…</div>';
  try {
    const d = await fetch(`/api/leaderboard?type=${type}`).then(r => r.json());
    if (d.error) throw new Error(d.error);
    _lbCache[type] = d;
    renderLeaderboard(d, type);
  } catch (e) {
    document.getElementById('lbBody').innerHTML = '<div class="whats-new-loading">Failed to load.</div>';
  }
}
function renderLeaderboard(d, type) {
  const medals = ['🥇','🥈','🥉'];
  const isTok = type === 'tokens';
  const fmt = n => Number(n).toLocaleString();
  const label = isTok ? 'tokens' : 'coins';
  let html = '';
  if (isTok) {
    html += `<div style="font-size:12px;color:var(--text3);padding:8px 0 4px">🎟️ Monthly token tournament — top holder at month-end wins <strong style="color:var(--accent-l)">${(d.tournamentPrize||500).toLocaleString()} coins</strong>. Tokens reset each month.</div>`;
  }
  if (!d.board.length) {
    html += '<div style="color:var(--text3);font-size:13px;padding:8px 0">No entries yet — be the first!</div>';
  } else {
    html += d.board.map((r, i) => `
      <div class="lb-row">
        <span class="lb-pos">${medals[i] || '#' + r.position}</span>
        <span class="lb-badge">${isTok ? '🎟️' : (r.rank?.emoji || '')}</span>
        <span class="lb-name">${r.isMe ? 'You' : escHtml(r.name)}</span>
        <span class="lb-score">${fmt(r.score)} ${label}</span>
      </div>`).join('');
  }
  if (d.me && !d.inBoard) {
    html += `<div class="lb-me-row"><span style="font-size:14px">${isTok ? '🎟️' : (d.me.rank?.emoji || '')}</span><span style="flex:1;color:var(--text1);font-weight:600">You</span><span class="lb-score">${fmt(d.me.score)} ${label}</span></div>`;
  }
  if (!isTok && d.ranks) {
    html += `<div class="lb-rank-legend">${d.ranks.map(r => `<span class="lb-rank-chip" style="color:${r.color}">${r.emoji} ${r.name} <span style="font-weight:400;color:var(--text3)">${r.min.toLocaleString()}+</span></span>`).join('')}</div>`;
  }
  document.getElementById('lbBody').innerHTML = html;
}
async function loadMissions() {
  if (_missionsCache) { renderMissions(_missionsCache); return; }
  document.getElementById('missionsBody').innerHTML = '<div class="whats-new-loading">Loading…</div>';
  try {
    const d = await fetch('/api/missions').then(r => r.json());
    if (d.error) throw new Error(d.error);
    _missionsCache = d;
    renderMissions(d);
  } catch (e) {
    document.getElementById('missionsBody').innerHTML = '<div class="whats-new-loading">Failed to load.</div>';
  }
}
function renderMissions(d) {
  const mult = d.rewardMult || 1;
  const multBadge = mult > 1 ? ` <span style="font-size:10px;background:#f59e0b;color:#000;border-radius:4px;padding:1px 5px;font-weight:700">${mult}x</span>` : '';
  const missionCard = (m, isNew) => {
    const pct = Math.min(100, Math.round((m.progress / m.target) * 100));
    const claimable = m.done && !m.claimed;
    const progFmt = typeof m.progress === 'number' ? m.progress.toLocaleString() : m.progress;
    const tgtFmt  = typeof m.target  === 'number' ? m.target.toLocaleString()  : m.target;
    return `<div class="mission-card${m.claimed ? ' done' : ''}${isNew ? ' mission-card-enter' : ''}" data-mission-id="${m.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <span class="mission-label">${m.label}</span>
        <span class="mission-reward">+${m.reward} 🪙${mult > 1 ? ` <span style="font-size:9px;background:#f59e0b;color:#000;border-radius:3px;padding:1px 4px;font-weight:700">${mult}x</span>` : ''}</span>
      </div>
      <div class="mission-bar-wrap"><div class="mission-bar" style="width:${pct}%"></div></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="mission-progress-text">${progFmt} / ${tgtFmt}</span>
        ${m.claimed ? '<span style="font-size:11px;color:var(--accent-l)">✓ Claimed</span>'
          : `<button class="mission-claim-btn" ${claimable ? '' : 'disabled'} onclick="claimMission('${m.id}')">${claimable ? 'Claim' : 'Incomplete'}</button>`}
      </div>
    </div>`;
  };

  const section = (title, missions, completed, total, prevIds, nextPeriod) => {
    const counter = `<span style="font-size:11px;font-weight:500;color:var(--accent-l);margin-left:8px">${completed}/${total} complete</span>`;
    let html = `<div class="mission-section-title">${title}${counter}${multBadge}</div>`;
    const unclaimed = missions.filter(m => !m.claimed);
    const claimed   = missions.filter(m => m.claimed);
    if (unclaimed.length === 0 && claimed.length === 0) {
      html += `<div style="text-align:center;padding:20px 0;font-size:13px;color:var(--text3)">No missions yet.</div>`;
    } else if (unclaimed.length === 0 && completed >= total) {
      html += claimed.map(m => missionCard(m, prevIds && !prevIds.has(m.id))).join('');
      html += `<div style="text-align:center;padding:16px 0;font-size:13px;color:var(--accent-l)">🎉 All missions complete! Check back ${nextPeriod || 'tomorrow'}.</div>`;
    } else {
      html += claimed.map(m => missionCard(m, prevIds && !prevIds.has(m.id))).join('');
      html += unclaimed.map(m => missionCard(m, prevIds && !prevIds.has(m.id))).join('');
    }
    return html;
  };

  const achCard = (a) => {
    const pct      = Math.min(100, Math.round((a.progress / a.target) * 100));
    const progFmt  = typeof a.progress === 'number' ? a.progress.toLocaleString() : a.progress;
    const tgtFmt   = typeof a.target  === 'number' ? a.target.toLocaleString()  : a.target;
    const icon     = a.claimed ? '🏆' : (a.done ? '⭐' : '🔒');
    return `<div class="ach-card${a.claimed ? ' ach-unlocked' : ''}" data-mission-id="${a.id}">
      <div class="ach-icon">${icon}</div>
      <div class="ach-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <span class="ach-name">${a.label}</span>
          <span class="mission-reward">+${a.reward} 🪙</span>
        </div>
        <div class="ach-desc">${a.desc}</div>
        <div class="mission-bar-wrap"><div class="mission-bar" style="width:${pct}%"></div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <span class="mission-progress-text">${progFmt} / ${tgtFmt}</span>
          ${a.claimed ? '<span style="font-size:11px;color:var(--accent-l)">✓ Unlocked</span>'
            : a.done ? `<button class="mission-claim-btn" onclick="claimMission('${a.id}')">Claim +${a.reward} 🪙</button>`
            : `<span style="font-size:11px;color:var(--text3)">locked</span>`}
        </div>
      </div>
    </div>`;
  };

  const prevIds = new Set([...document.querySelectorAll('[data-mission-id]')].map(el => el.dataset.missionId));
  const hasPrev = prevIds.size > 0;

  let html =
    section('Daily Missions',     d.daily,   d.dailyCompleted   || 0, d.dailyTotal   || 0, hasPrev ? prevIds : null, 'tomorrow')   +
    section('Weekly Missions',    d.weekly,  d.weeklyCompleted  || 0, d.weeklyTotal  || 0, hasPrev ? prevIds : null, 'next week')  +
    section('Monthly Challenges', d.monthly || [], d.monthlyCompleted || 0, d.monthlyTotal || 0, hasPrev ? prevIds : null, 'next month');

  if (d.achievements && d.achievements.length) {
    const achCounter = `<span style="font-size:11px;font-weight:500;color:var(--accent-l);margin-left:8px">${d.achCompleted || 0}/${d.achTotal || 0} unlocked</span>`;
    html += `<div class="mission-section-title">Achievements${achCounter}</div>`;
    html += d.achievements.map(a => achCard(a)).join('');
  }

  document.getElementById('missionsBody').innerHTML = html;
}

async function claimMission(id) {
  const card = document.querySelector(`[data-mission-id="${id}"]`);
  if (card) {
    card.classList.add('mission-card-exit');
    await new Promise(r => setTimeout(r, 360));
  }
  try {
    const d = await fetch('/api/missions/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
    }).then(r => r.json());
    if (d.ok) {
      const toastMsg = d.isAch ? `🏆 Achievement unlocked! +${d.reward} 🪙` : `+${d.reward} coins claimed! 🪙`;
      showWarning(toastMsg, 3500);
      _missionsCache = null;
      await loadMissions();
      await refreshUsageManual();
    } else {
      if (card) card.classList.remove('mission-card-exit');
      showWarning(d.error || 'Claim failed', 3000);
    }
  } catch (_) {
    if (card) card.classList.remove('mission-card-exit');
    showWarning('Request failed', 3000);
  }
}

function renderWhatsNew(announcements, body) {
  if (!announcements.length) { body.innerHTML = '<div class="whats-new-loading">Nothing new yet!</div>'; return; }
  const owner = isOwner();
  body.innerHTML = announcements.map((a, i) => `
    <div class="whats-new-entry" data-ann-id="${a.id || ''}">
      <div class="wn-ver-row">
        ${a.version ? `<span class="wn-ver-badge">${escHtml(a.version)}</span>` : ''}
        <span class="wn-date">${escHtml(a.date || '')}</span>
        ${owner && a.id && !a.id.startsWith('v') ? `<button class="wn-delete-btn" onclick="adminDeleteAnnouncement('${escHtml(a.id)}',this)" title="Delete">✕</button>` : ''}
      </div>
      <div class="wn-headline">${escHtml(a.title)}</div>
      ${a.subtitle ? `<div class="wn-subline">${escHtml(a.subtitle)}</div>` : ''}
      ${a.character ? `<div class="wn-char-card">
        <div class="wn-char-tag">New Character</div>
        <div class="wn-char-name">${escHtml(a.character.emoji || '')} ${escHtml(a.character.name)}</div>
        <div class="wn-char-sub">${escHtml(a.character.sub)}</div>
      </div>` : ''}
      ${a.added?.length ? `<div class="wn-section-tag added">Added</div><ul class="wn-list">${a.added.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}
      ${a.fixed?.length ? `<div class="wn-section-tag fixed">Fixed</div><ul class="wn-list">${a.fixed.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}
      ${a.changed?.length ? `<div class="wn-section-tag changed">Changed</div><ul class="wn-list">${a.changed.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}
      ${a.note?.length ? `<div class="wn-section-tag note">Note</div><ul class="wn-list">${a.note.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}
    </div>
    ${i < announcements.length - 1 ? '<div class="whats-new-divider"></div>' : ''}
  `).join('');
}

async function adminDeleteAnnouncement(id, btn) {
  if (!isOwner()) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const d = await fetch(`/api/admin/announcement/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(r => r.json());
    if (d.ok) {
      window._announcements = null;
      const entry = btn?.closest('.whats-new-entry');
      const divider = entry?.nextElementSibling;
      if (divider?.classList.contains('whats-new-divider')) divider.remove();
      entry?.remove();
      showWarning('Announcement deleted.', 3000);
    }
  } catch (_) { if (btn) { btn.disabled = false; btn.textContent = '✕'; } }
}

async function checkWhatsNewDot() {
  try {
    const r = await fetch('/api/announcements');
    const data = await r.json();
    window._announcements = data;
    if (!data.length) return;
    let seen = '';
    try { seen = localStorage.getItem('cm_wn_seen') || ''; } catch (_) {}
    if (seen !== data[0].id) {
      const dot = document.getElementById('whatsNewDot');
      if (dot) dot.hidden = false;
      const mobDot2 = document.getElementById('mobWhatsNewDot');
      if (mobDot2) mobDot2.hidden = false;
      setTimeout(() => openWhatsNew(), 1800);
    }
  } catch (_) {}
}

function _showHwGiftRow() {
  const row = document.getElementById('hwGiftUsageRow');
  if (row) row.style.display = 'none'; // disabled
}

async function openUsageModal() {
  document.getElementById('usageModal').style.display = 'flex';
  _showHwGiftRow();
  const wrap = document.getElementById('resetLimitsWrap');
  if (wrap) wrap.hidden = !isOwner();
  // Auto-populate next version number for the announcement form
  if (isOwner()) {
    const annV = document.getElementById('annVersion');
    if (annV && !annV.value) {
      (async () => {
        try {
          const anns = window._announcements || await fetch('/api/announcements').then(r => r.json());
          const latest = (anns[0]?.version || '');
          const m = latest.match(/v?(\d+)/i);
          if (m && !annV.value) annV.value = 'v' + (parseInt(m[1], 10) + 1);
        } catch (_) {}
      })();
    }
  }
  // Wire donation URL from constant; hide the row for the owner (they know it exists)
  const donateBtn = document.getElementById('usageDonateBtn');
  if (donateBtn) donateBtn.href = DONATION_URL;
  const donateRow = document.getElementById('usageDonateRow');
  if (donateRow) donateRow.hidden = isOwner();
  // Load fresh data then update
  try {
    const res = await fetch('/api/usage');
    if (res.ok) {
      const u = await res.json();
      lastUsageFetch = Date.now();
      lastKnownUsage = u;
      updateUsageBars(u);
      updateUsageModal(u);
    } else {
      updateUsageModal(lastKnownUsage);
    }
  } catch (_) { updateUsageModal(lastKnownUsage); }
  updateUsageTimestamp();
  startUsageModalTimer();
}

function closeUsageModal() {
  document.getElementById('usageModal').style.display = 'none';
  if (usageModalTimer) { clearInterval(usageModalTimer); usageModalTimer = null; }
}

async function refreshUsageManual() {
  const btn = document.querySelector('.usage-refresh-btn');
  if (btn) btn.style.opacity = '0.3';
  try {
    const res = await fetch('/api/usage');
    if (res.ok) {
      const u = await res.json();
      lastUsageFetch = Date.now();
      lastKnownUsage = u;
      updateUsageBars(u);
      updateUsageModal(u);
      updateUsageTimestamp();
    }
  } catch (_) {}
  if (btn) btn.style.opacity = '';
}

// ── Response length selector ──────────────────────────────────────────────────
function setGreetingMode(mode) {
  document.getElementById('gmFixed')?.classList.toggle('active', mode === 'fixed');
  document.getElementById('gmAuto')?.classList.toggle('active', mode === 'auto');
}

function getGreetingMode() {
  return document.getElementById('gmAuto')?.classList.contains('active') ? 'auto' : 'fixed';
}

// ── Greeting content moderation (mirrors server patterns) ──────────────────
const GREETING_CRISIS_RE = /\b(i\s+)?(want|wanna|need|going|gonna|am\s+going)\s+to\s+(die|kill\s+myself|end\s+(it|my\s+life|it\s+all)|hurt\s+myself)\b|\bkill\s+myself\b|\bsuicid(al|e)\b|\bself[- ]?harm\b|\bdon'?t\s+want\s+to\s+(live|be\s+here|exist)\b|\bcan'?t\s+(go\s+on|take\s+it|do\s+this)\s*(anymore|any\s+more)?\b|\bend\s+(it\s+all|my\s+life|everything)\b/i;
const GREETING_SLUR_RE = /\bn[i1!|*]+gg[ae3*]+r[sz]?\b|\bk[i1*]+k[e3*]+[sz]?\b|\bch[i1*]+nk[sz]?\b|\bsp[i1*]+c[sz]?\b|\bf[a4@*]+gg[o0*]+t[sz]?\b|\br[e3*]+t[a4*]+rd[sz]?\b/i;
const GREETING_NSFW_RE = /blow\s*job|hand\s*job|\bfuck\s+(me|you|her|him|us)\b|have\s+sex|penetrat(e|ing)|naked\s+for\s+me|strip\s+(naked|for\s+me)\b|\bporn\b|smut\b|erotic/i;
const GREETING_TOS_MSG = "We don't allow suicidal, sexual, or hate speech content in greetings. This goes against our Terms of Service and is not allowed on the platform.";

function greetingViolation(text) {
  if (!text) return false;
  if (GREETING_CRISIS_RE.test(text)) return true;
  if (GREETING_SLUR_RE.test(text)) return true;
  if (GREETING_NSFW_RE.test(text)) return true;
  return false;
}

function checkGreetingInput() {
  const text = document.getElementById('newGreeting')?.value || '';
  const errEl = document.getElementById('greetingError');
  if (!errEl) return;
  const bad = greetingViolation(text);
  errEl.style.display = bad ? 'block' : 'none';
  if (bad) errEl.textContent = GREETING_TOS_MSG;
}

// ── Info Panel helpers ────────────────────────────────────────────────────────
function toggleCustomize() {
  const panel = document.getElementById('customizePanel');
  const chevron = document.getElementById('customizeChevron');
  if (!panel) return;
  panel.classList.toggle('open');
  if (chevron) chevron.classList.toggle('rotated', panel.classList.contains('open'));
}

function comingSoon(feature) {
  showWarning(feature + ' — coming soon!', 5000);
}

function shareChar() {
  if (!currentChar) return;
  const url = window.location.href.split('?')[0] + '?char=' + currentChar.id;
  navigator.clipboard.writeText(url).catch(() => {});
  showWarning('Link copied to clipboard!', 5000);
}

function getCharLikes(charId) {
  try { return JSON.parse(localStorage.getItem(userKey('cm_likes')) || '{}')[charId] || 0; } catch (_) { return 0; }
}
function isCharLiked(charId) {
  try { return !!(JSON.parse(localStorage.getItem(userKey('cm_liked')) || '{}')[charId]); } catch (_) { return false; }
}

function toggleLike() {
  if (!currentChar) return;
  try {
    const likes = JSON.parse(localStorage.getItem(userKey('cm_likes')) || '{}');
    const liked = JSON.parse(localStorage.getItem(userKey('cm_liked')) || '{}');
    const key = currentChar.id;
    if (liked[key]) {
      liked[key] = false;
      likes[key] = Math.max(0, (likes[key] || 1) - 1);
    } else {
      liked[key] = true;
      likes[key] = (likes[key] || 0) + 1;
    }
    localStorage.setItem(userKey('cm_likes'), JSON.stringify(likes));
    localStorage.setItem(userKey('cm_liked'), JSON.stringify(liked));
    const likeCount = document.getElementById('ipLikeCount');
    if (likeCount) likeCount.textContent = likes[key] || 0;
    const likeBtn = document.getElementById('ipLikeBtn');
    if (likeBtn) likeBtn.classList.toggle('active', !!liked[key]);
  } catch (_) {}
}

function toggleDislike() {
  showWarning('Feedback recorded — thank you!', 5000);
}

// ── Message context menu icons ────────────────────────────────────────────────
const MI = {
  copy:   `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2'/><path d='M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1'/></svg>`,
  edit:   `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7'/><path d='M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z'/></svg>`,
  remove: `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><line x1='15' y1='9' x2='9' y2='15'/><line x1='9' y1='9' x2='15' y2='15'/></svg>`,
  rewind: `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 3v5h5'/><path d='M3.05 13A9 9 0 1 0 6 5.3L3 8'/></svg>`,
};

function msgMenuHtml(role) {
  const items = role === 'user'
    ? `<button class='msg-di' onclick='copyMsgText(this)'>${MI.copy}Copy</button>
       <button class='msg-di' onclick='editMsgText(this)'>${MI.edit}Edit message</button>
       <button class='msg-di danger' onclick='removeMsgEl(this)'>${MI.remove}Remove message</button>
       <button class='msg-di' onclick='rewindToHere(this)'>${MI.rewind}Rewind to here</button>`
    : `<button class='msg-di' onclick='copyMsgText(this)'>${MI.copy}Copy</button>
       <button class='msg-di danger' onclick='removeMsgEl(this)'>${MI.remove}Remove message</button>
       <button class='msg-di' onclick='rewindToHere(this)'>${MI.rewind}Rewind to here</button>`;
  return `<div class='msg-menu-wrap'><button class='msg-menu-btn' onclick='toggleMsgMenu(this)'>⋯</button><div class='msg-dropdown hidden'>${items}</div></div>`;
}

function toggleMsgMenu(btn) {
  document.querySelectorAll('.msg-dropdown:not(.hidden)').forEach(d => {
    d.classList.add('hidden');
    if (d.__closeHandler) { document.removeEventListener('click', d.__closeHandler, true); d.__closeHandler = null; }
  });
  const dd = btn.nextElementSibling;
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) {
    setTimeout(() => {
      function close(e) {
        if (!dd.contains(e.target) && e.target !== btn) {
          dd.classList.add('hidden');
          dd.__closeHandler = null;
          document.removeEventListener('click', close, true);
        }
      }
      dd.__closeHandler = close;
      document.addEventListener('click', close, true);
    }, 0);
  }
}

function copyMsgText(btn) {
  const bubble = btn.closest('.msg').querySelector('.bubble');
  navigator.clipboard.writeText(bubble.innerText).catch(() => {
    try {
      const sel = window.getSelection(), r = document.createRange();
      r.selectNodeContents(bubble); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('copy'); sel.removeAllRanges();
    } catch(_) {}
  });
  btn.closest('.msg-dropdown').classList.add('hidden');
  showWarning('Copied!', 5000);
}

function editMsgText(btn) {
  if (isStreaming) { showWarning('Wait for the reply to finish first.'); return; }
  const msgEl = btn.closest('.msg');
  const isAi = msgEl.classList.contains('ai');
  const bubble = msgEl.querySelector('.bubble');
  btn.closest('.msg-dropdown').classList.add('hidden');
  const origHtml = bubble.innerHTML;
  const origText = isAi ? bubbleToRaw(bubble) : bubble.innerText;
  bubble.contentEditable = 'true';
  bubble.classList.add('editing');
  // Show as plain text while editing so user sees raw content
  bubble.textContent = origText;
  bubble.focus();
  const sel = window.getSelection(), r = document.createRange();
  r.selectNodeContents(bubble); sel.removeAllRanges(); sel.addRange(r);
  const ctrl = document.createElement('div');
  ctrl.className = 'msg-edit-ctrl';
  ctrl.dataset.origHtml = origHtml;
  if (isAi) {
    ctrl.innerHTML = `<button onclick="saveAiEdit(this)">Save</button><button onclick="cancelEdit(this)">Cancel</button>`;
  } else {
    ctrl.innerHTML = `<button onclick="saveEdit(this)">Save</button><button onclick="saveAndResend(this)">Save &amp; Resend</button><button onclick="cancelEdit(this)">Cancel</button>`;
  }
  bubble.after(ctrl);
}

async function saveAiEdit(btn) {
  const ctrl = btn.closest('.msg-edit-ctrl');
  const bubble = ctrl.closest('.msg').querySelector('.bubble');
  const origRaw = bubble.dataset.raw || '';   // the reply as it was before this edit
  const newText = bubble.innerText.trim();
  bubble.contentEditable = 'false';
  bubble.classList.remove('editing');
  const origHtml = ctrl.dataset.origHtml;
  ctrl.remove();
  if (newText) setBubbleRaw(bubble, newText); else bubble.innerHTML = origHtml;
  const mEl = bubble.closest('.msg');
  if (mEl && newText) delete mEl.dataset.sig;   // an edited reply no longer matches the server's signature until the server signs the new text
  saveHistoryLocal();
  // Tell the server, so the AI sees the edited reply from now on (it only trusts replies it has signed)
  if (newText && origRaw && newText !== origRaw && currentChar) {
    const cid = currentChar.id;
    try {
      const r = await fetch('/api/conversations/' + cid + '/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: origRaw, to: newText }) });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (j && j.sig && currentChar && currentChar.id === cid && mEl && mEl.isConnected && bubble.dataset.raw === newText) {
        mEl.dataset.sig = j.sig;
        const rid = mEl.dataset.regenId, store = rid ? regenStore.get(rid) : null;
        if (store) { store.texts[store.idx] = newText; (store.sigs = store.sigs || [])[store.idx] = j.sig; }
        saveHistoryLocal();
      } else if (r.status === 400) {
        showWarning('That edit goes against our Terms of Service, so the AI will not see it.');
      }
    } catch (_) {}
  }
}

function saveEdit(btn) {
  if (isStreaming) { showWarning('Wait for the reply to finish first.'); return; }
  const ctrl = btn.closest('.msg-edit-ctrl');
  const msgEl = ctrl.closest('.msg');
  const bubble = msgEl.querySelector('.bubble');
  const newText = bubble.innerText.trim();
  bubble.contentEditable = 'false';
  bubble.classList.remove('editing');
  ctrl.remove();
  if (!newText) { msgEl.remove(); resyncServer(); return; }
  bubble.innerHTML = escHtml(newText).replace(/\n/g, '<br>');
  saveHistoryLocal();
  resyncServer();
}

let nextMsgIsEdited = false;

function saveAndResend(btn) {
  if (isStreaming) { showWarning('Wait for the reply to finish first.'); return; }
  const ctrl = btn.closest('.msg-edit-ctrl');
  const msgEl = ctrl.closest('.msg');
  const bubble = msgEl.querySelector('.bubble');
  const newText = bubble.innerText.trim();
  bubble.contentEditable = 'false';
  bubble.classList.remove('editing');
  ctrl.remove();
  if (!newText) { msgEl.remove(); resyncServer(); return; }
  // Remove this message and everything after it, then resend fresh with the edited text
  const msgs = [...document.getElementById('messages').querySelectorAll('.msg')];
  const idx = msgs.indexOf(msgEl);
  if (idx === -1) return;
  msgs.slice(idx).forEach(m => m.remove());
  if (!currentChar) return;
  saveHistoryLocal();
  const localHistory = loadHistoryLocal(currentChar.id);
  clearPendingImage();
  nextMsgIsEdited = true;
  pushHistoryToServer(currentChar.id, localHistory)
    .then(() => { if (newText) sendMessage(newText); else nextMsgIsEdited = false; })
    .catch(() => { if (newText) sendMessage(newText); else nextMsgIsEdited = false; });
}

// Replace the chat the server holds with this history. The server chat is cleared first, so the new copy must really arrive: if the
// whole history is too big for one request (very long replies), the NEWEST part is sent instead of leaving the server chat empty.
async function pushHistoryToServer(id, history) {
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' }).catch(() => {});
  if (!history || !history.length) return true;
  let part = history;
  for (let attempt = 0; attempt < 5 && part.length; attempt++) {
    const r = await fetch(`/api/conversations/${id}/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ history: part })
    }).catch(() => null);
    if (r && r.ok) return true;
    if (!r || r.status !== 413) return false;        // a different problem (maintenance, network...): nothing smaller will fix it
    part = part.slice(Math.ceil(part.length / 2));   // too big: try again with the newest half
  }
  return false;
}

function cancelEdit(btn) {
  const ctrl = btn.closest('.msg-edit-ctrl');
  const bubble = ctrl.closest('.msg').querySelector('.bubble');
  bubble.innerHTML = ctrl.dataset.origHtml;
  bubble.contentEditable = 'false';
  bubble.classList.remove('editing');
  ctrl.remove();
}

function removeMsgEl(btn) {
  btn.closest('.msg-dropdown').classList.add('hidden');
  if (isStreaming) { showWarning('Wait for the reply to finish first.'); return; }
  btn.closest('.msg').remove();
  saveHistoryLocal();
  resyncServer();
}

let pendingRewindEl = null;

function rewindToHere(btn) {
  btn.closest('.msg-dropdown').classList.add('hidden');
  if (isStreaming) { showWarning('Wait for the reply to finish first.'); return; }
  pendingRewindEl = btn.closest('.msg');
  const modal = document.getElementById('rewindModal');
  if (modal) modal.style.display = 'flex';
}

function closeRewindModal() {
  const modal = document.getElementById('rewindModal');
  if (modal) modal.style.display = 'none';
  pendingRewindEl = null;
}

function confirmRewindToHere() {
  if (!pendingRewindEl) return;
  const msgEl = pendingRewindEl;
  closeRewindModal();
  const msgs = [...document.getElementById('messages').querySelectorAll('.msg')];
  const idx = msgs.indexOf(msgEl);
  if (idx === -1) return;
  // Keep the rewound-to message; delete only what comes after it
  msgs.slice(idx + 1).forEach(m => m.remove());
  saveHistoryLocal();
  resyncServer();
}

function resyncServer() {
  if (!currentChar) return;
  const id = currentChar.id;
  const localHistory = loadHistoryLocal(id);
  pushHistoryToServer(id, localHistory).catch(() => {});
}

// ── Message Rendering — c.ai style ───────────────────────────────────────────
function msgAvatarHtml(cls) {
  if (!currentChar) return `<div class="${cls}" style="background:#555">A</div>`;
  if (isCharImg(currentChar.image)) return `<div class="${cls}" style="background:#111;overflow:hidden"><img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"></div>`;
  return `<div class="${cls}" style="background:${safeColor(currentChar.color)}">${escHtml(currentChar.name[0]||'?')}</div>`;
}

const NSFW_CARD_TITLES = [
  'This goes against our Terms of Service.',
  'That message goes against our Terms of Service.',
  'This content goes against our Terms of Service.',
  'Sorry, this goes against our Terms of Service.'
];

function appendNsfwCard(variant) {
  const v = (Number.isInteger(variant) && variant >= 0 && variant < NSFW_CARD_TITLES.length)
    ? variant : Math.floor(Math.random() * NSFW_CARD_TITLES.length);
  const title = NSFW_CARD_TITLES[v];
  const div = document.createElement('div');
  div.className = 'msg ai nsfw-msg';
  div.dataset.nsfwVariant = String(v);
  div.innerHTML = `
    <div class="msg-header">
      ${msgAvatarHtml('msg-avatar')}
      <span class="msg-name">${colorizeNameHtml(currentChar?.name || 'AI', currentChar?.color)}</span>
      <span class="msg-badge">C.M</span>
    </div>
    <div class="nsfw-block-card">
      <div class="nsfw-card-icon">🤖</div>
      <p class="nsfw-card-title">${title}</p>
      <p class="nsfw-card-body">Please click Report if you believe this could be a false positive. We'll anonymously keep track of Reports to improve the AI.</p>
      <button class="nsfw-card-report" onclick="this.textContent='Reported ✓'; this.disabled=true">Report</button>
      <div class="nsfw-card-dots"><span></span><span></span><span></span></div>
    </div>`;
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
}

// Draw one saved history entry (a normal message or the Terms-of-Service card).
// Only the newest messages are drawn letter by letter at once; older ones use a lighter version until they scroll into view
const LIVE_COLOUR_MESSAGES = 20;
const liteObserver = (typeof IntersectionObserver !== 'undefined')
  ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const b = en.target;
        liteObserver.unobserve(b);
        if (b.dataset.lite) { delete b.dataset.lite; if (typeof b.dataset.raw === 'string') { const cc = b.closest('.msg')?.dataset.charColor || currentChar?.color; b.innerHTML = renderMarkdown(b.dataset.raw); colorizeLetters(b, cc); maybeRenderGame(b, cc); } }
      }
    }, { root: document.getElementById('chatBody'), rootMargin: '400px' })
  : null;
function appendHistoryItem(m, lite) {
  if (m && m.card === 'nsfw') { appendNsfwCard(m.variant); return; }
  const isAi = m.role === 'assistant' || m.role === 'ai';
  const el = appendMessage(isAi ? 'ai' : 'user', m.content, undefined, lite);
  if (isAi && m.sig && el) el.dataset.sig = m.sig;
}

function appendMessage(role, text, imgB64, lite) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (currentChar?.color) div.dataset.charColor = currentChar.color;

  if (role === 'ai') {
    div.innerHTML = `
      <div class="msg-header">
        ${msgAvatarHtml('msg-avatar')}
        <span class="msg-name">${colorizeNameHtml(currentChar?.name || 'AI', currentChar?.color)}</span>
        <span class="msg-badge">C.M</span>
        <button class="tts-btn" onclick="toggleTTS(this)" title="Read aloud"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></button>
        ${msgMenuHtml('ai')}
      </div>
      <div class="bubble">${renderMarkdown(text, undefined, lite ? { lite: true } : undefined)}</div>
      <div class="msg-footer">
        ${regenBtn()}${likeBtn()}${dislikeBtn()}
      </div>`;
    const ab = div.querySelector('.bubble');
    ab.dataset.raw = String(text == null ? '' : text);
    colorizeLetters(ab, currentChar?.color);
    if (!lite) maybeRenderGame(ab, currentChar?.color);
    if (lite && liteObserver) { ab.dataset.lite = '1'; liteObserver.observe(ab); }
  } else {
    const editedTag = nextMsgIsEdited ? ' <span class="msg-edited-tag">(edited)</span>' : '';
    nextMsgIsEdited = false;
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name" style="color:var(--text3)">You</span>${editedTag}
        ${msgMenuHtml('user')}
      </div>
      ${imgB64 ? `<img class="msg-img" src="${imgB64}" alt="attachment">` : (text === '[image]' ? `<div class="bubble" data-raw="[image]" style="opacity:0.55;font-size:12px">📷 Image</div>` : '')}
      ${text && text !== '[image]' ? `<div class="bubble">${escHtml(text).replace(/\n/g, '<br>')}</div>` : ''}`;
  }
  document.getElementById('messages').appendChild(div);
  if (role === 'ai') addSwipeGesture(div);
  return div;
}

function createAiMessage() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `
    <div class="msg-header">
      ${msgAvatarHtml('msg-avatar')}
      <span class="msg-name">${colorizeNameHtml(currentChar?.name || 'AI', currentChar?.color)}</span>
      <span class="msg-badge">C.M</span>
      <button class="tts-btn" onclick="toggleTTS(this)" title="Read aloud"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></button>
      ${msgMenuHtml('ai')}
    </div>
    <div class="bubble"></div>
    <div class="stream-stats">
      <span class="stream-spinner"></span>
      <span class="stream-time">0s</span>
      <span class="stream-sep">·</span>
      <span class="stream-tok">0 tokens</span>
    </div>
    <div class="msg-footer">
      ${regenBtn()}${likeBtn()}${dislikeBtn()}
    </div>`;
  document.getElementById('messages').appendChild(div);
  addSwipeGesture(div);
  return div;
}

let streamTimer = null;
let streamStartTime = null;

// ── Streaming text renderer (typewriter queue) ────────────────────────────────
let twBubble = null;
let twMsgEl = null;
let twRevealed = '';
let twQueue = '';
let twInterval = null;
let twOnDrain = null;
let twStreamDone = false;
let twSpd = null;
let twLastRender = 0;

// Called when the full reply has arrived. The counter stays up and keeps counting until the last letter has typed out
// (the end-of-reply code then hides it). Only if there is nothing left to type does it go away at once.
function markStreamDone() {
  twStreamDone = true;
  if (!twSpd || !twQueue.length) hideStreamStatsNow();
}
function remainingTypeMs() {
  return twSpd ? Math.ceil(twQueue.length / twSpd.chars) * twSpd.ms : 0;
}

// Typewriter speed by effort level — lower effort = slower (more visible), higher = faster
// Replies appear almost as fast as they arrive (the effort decides how LONG a reply is, not how slowly it is shown).
const TW_SPEED = {
  low:    { chars: 3, ms: 8 },
  medium: { chars: 4, ms: 8 },
  high:   { chars: 6, ms: 8 },
  extra:  { chars: 10, ms: 8 },
  max:    { chars: 16, ms: 8 },
};

function startTypewriter(bubble, msgEl) {
  twBubble = bubble; twMsgEl = msgEl; twRevealed = ''; twQueue = '';
  twStreamDone = false;
  if (twInterval) clearInterval(twInterval);
  // During calls the text is spoken immediately — render it as fast as possible
  if (callModeActive) { twSpd = TW_SPEED.max; const perMsC = TW_SPEED.max.chars / TW_SPEED.max.ms; let creditC = 0, lastTickC = Date.now(); twInterval = setInterval(() => { const nowC = Date.now(); creditC += (nowC - lastTickC) * perMsC; lastTickC = nowC; creditC = Math.max(creditC, Math.ceil(twQueue.length / 4)); if (!twQueue.length) { creditC = 0; if (twOnDrain) { const cb = twOnDrain; twOnDrain = null; cb(); } return; } const nC = Math.min(twQueue.length, Math.floor(creditC)); if (nC < 1) return; creditC -= nC; const chunkC = twQueue.slice(0, nC); twQueue = twQueue.slice(nC); twRevealed += chunkC; if (twBubble && nowC - twLastRender >= 33) { setBubbleRaw(twBubble, twRevealed, twRevealed.length > 900); twLastRender = nowC; scrollToBottom(); } updateStreamTokens(twMsgEl, twRevealed.length); }, TW_SPEED.max.ms); return; }
  // Opis (opus) model uses faster streaming — bump speed one level up
  const effortKey = selectedModelTier === 'opus'
    ? (selectedEffort === 'max' || selectedEffort === 'extra' ? 'max' : selectedEffort === 'high' ? 'extra' : selectedEffort === 'medium' ? 'high' : 'medium')
    : selectedEffort;
  const spd = TW_SPEED[effortKey] || TW_SPEED.high;
  twSpd = spd;
  // Typing speed follows the clock, not how long each step takes to draw (drawing the coloured letters can be slow on a
  // phone). That keeps the speed steady and the "about a second left" estimate for the token counter accurate.
  const perMs = spd.chars / spd.ms;
  let credit = 0, lastTick = Date.now();
  twInterval = setInterval(() => {
    const now = Date.now();
    credit += (now - lastTick) * perMs;
    lastTick = now;
    credit = Math.max(credit, Math.ceil(twQueue.length / 4));   // never fall far behind what has already arrived
    if (!twQueue.length) {
      credit = 0;
      if (twOnDrain) { const cb = twOnDrain; twOnDrain = null; cb(); }
      return;
    }
    const n = Math.min(twQueue.length, Math.floor(credit));
    if (n < 1) return;
    credit -= n;
    const chunk = twQueue.slice(0, n);
    twQueue = twQueue.slice(n);
    twRevealed += chunk;
    if (twBubble && now - twLastRender >= 33) {
      // drawing is the slow part, so it happens at most about 30 times a second
      setBubbleRaw(twBubble, twRevealed, twRevealed.length > 900);   // a long reply is drawn lightly while it types, in full at the end
      twLastRender = now;
      scrollToBottom();
    }
    updateStreamTokens(twMsgEl, twRevealed.length);
  }, spd.ms);
}

function feedTypewriter(chunk) {
  twQueue += chunk;
}

// Let the queue drain at normal speed, then call cb. Use for stream-end cleanup.
function drainTypewriter(cb) {
  // draw the complete text BEFORE the callback saves it (the drawing is throttled, so the saved copy would lag behind)
  if (!twInterval || !twQueue.length) { flushTypewriter(); if (cb) cb(); return; }
  const epoch = chatEpoch;
  twOnDrain = () => { flushTypewriter(); if (cb && chatEpoch === epoch) cb(); };
}

function flushTypewriter() {
  twOnDrain = null;
  if (twInterval) { clearInterval(twInterval); twInterval = null; }
  if (twQueue.length && twBubble) {
    twRevealed += twQueue;
    twQueue = '';
    setBubbleRaw(twBubble, twRevealed);
  } else if (twBubble && twRevealed) {
    setBubbleRaw(twBubble, twRevealed); // make sure the final text is fully drawn
  }
  twBubble = null; twMsgEl = null;
}

function fmtLiveTokens(n) {
  if (n >= 999950) return (n / 1000000).toFixed(1) + 'M';   // 1.0M, 1.1M, 1.2M ... (never "1000.0k")
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function startStreamStats(msgEl) {
  const stats = msgEl.querySelector('.stream-stats');
  if (!stats) return;
  streamStartTime = Date.now();
  stats.style.display = '';
  stats.classList.remove('done');
  stats.classList.add('active');
  const spinner = stats.querySelector('.stream-spinner');
  if (spinner) spinner.style.display = '';
  const tokEl = stats.querySelector('.stream-tok');
  if (tokEl) tokEl.textContent = '0 tok';
  const timeEl = stats.querySelector('.stream-time');
  if (timeEl) timeEl.textContent = '0s';
  if (streamTimer) clearInterval(streamTimer);
  // Interval only ticks the elapsed time; tokens update per-chunk
  streamTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - streamStartTime) / 1000);
    const timeEl = stats.querySelector('.stream-time');
    if (timeEl) timeEl.textContent = elapsed + 's';
  }, 1000);
}

function updateStreamTokens(msgEl, charCount) {
  const stats = msgEl?.querySelector('.stream-stats');
  if (!stats || !stats.classList.contains('active')) return;
  const est = liveTokensShown(charCount);
  const tokEl = stats.querySelector('.stream-tok');
  if (tokEl) tokEl.textContent = fmtLiveTokens(est) + ' tokens';
}

function stopStreamStats(msgEl, finalTokens) {
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  streamStartTime = null;
  const stats = msgEl?.querySelector('.stream-stats');
  if (!stats) return;
  // The final token count is never shown
  stats.style.display = 'none';
}

// Hide every token counter right away (called the moment a reply finishes arriving).
function hideStreamStatsNow() {
  document.querySelectorAll('.stream-stats').forEach(s => { s.style.display = 'none'; });
}

// ── Regeneration history ──────────────────────────────────────────────────────
const regenStore = new Map(); // regenId → { texts: string[], idx: number }
let regenIdCounter = 0;

function assignRegenId(msgEl) {
  if (!msgEl.dataset.regenId) msgEl.dataset.regenId = 'rg' + (++regenIdCounter);
  return msgEl.dataset.regenId;
}

function regenNavUpdate(msgEl) {
  const id = msgEl.dataset.regenId;
  if (!id || !regenStore.has(id)) return;
  const store = regenStore.get(id);
  const total = store.texts.length;
  const idx = store.idx;
  let nav = msgEl.querySelector('.regen-nav');
  if (total <= 1) { if (nav) nav.remove(); return; }
  if (!nav) {
    nav = document.createElement('div');
    nav.className = 'regen-nav';
    const footer = msgEl.querySelector('.msg-footer');
    if (footer) footer.before(nav); else msgEl.appendChild(nav);
  }
  nav.innerHTML = `<button class="regen-nav-btn" onclick="regenNavStep('${id}',-1)" ${idx===0?'disabled':''}>‹</button><span class="regen-nav-count">${idx+1} / ${total}</span><button class="regen-nav-btn" onclick="regenNavStep('${id}',1)" ${idx===total-1?'disabled':''}>›</button>`;
}

function regenNavStep(id, dir) {
  const store = regenStore.get(id);
  if (!store) return;
  store.idx = Math.max(0, Math.min(store.texts.length - 1, store.idx + dir));
  const msgEl = document.querySelector(`[data-regen-id="${id}"]`);
  if (!msgEl) return;
  const bubble = msgEl.querySelector('.bubble');
  if (bubble) { setBubbleRaw(bubble, store.texts[store.idx]); colorizeLetters(bubble, currentChar?.color); maybeRenderGame(bubble, currentChar?.color); }
  if (store.sigs && store.sigs[store.idx]) msgEl.dataset.sig = store.sigs[store.idx]; else delete msgEl.dataset.sig;   // the signature of the version shown
  msgEl.querySelectorAll('.like-btn.active, .dislike-btn.active').forEach(b => b.classList.remove('active'));
  regenNavUpdate(msgEl);
  saveHistoryLocal();
  resyncServer();
  scrollToBottom();
}

function regenBtn() {
  return `<button class="reaction-btn regen-btn" onclick="regenerate()" title="Regenerate response"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4C7.58 4 4 7.58 4 12s3.58 8 8 8 8-3.58 8-8h-2c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>`;
}
function rewindBtn() {
  return `<button class="reaction-btn rewind-btn" onclick="rewindChat()" title="Rewind — undo last exchange"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg></button>`;
}
function likeBtn() {
  return `<button class="reaction-btn like-btn" onclick="toggleMsgLike(this)" title="Like"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg></button>`;
}
function dislikeBtn() {
  return `<button class="reaction-btn dislike-btn" onclick="toggleMsgDislike(this)" title="Dislike"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L10.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg></button>`;
}

// ── Voice selection ───────────────────────────────────────────────────────────
let selectedVoice = null;
let ttsProvider = 'gemini'; // 'edge' | 'gemini'
let geminiVoiceName = 'Aoede';
let edgeVoiceName = null; // null = auto-matched per character

const GEMINI_TTS_VOICES = [
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe',
  'Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi',
  'Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird',
  'Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'
];
const GEMINI_VOICE_DESC = {
  Zephyr:'Bright', Puck:'Upbeat', Charon:'Informative', Kore:'Firm', Fenrir:'Excitable',
  Leda:'Youthful', Orus:'Firm', Aoede:'Breezy', Callirrhoe:'Easy-going', Autonoe:'Bright',
  Enceladus:'Breathy', Iapetus:'Clear', Umbriel:'Easy-going', Algieba:'Smooth', Despina:'Smooth',
  Erinome:'Clear', Algenib:'Gravelly', Rasalgethi:'Informative', Laomedeia:'Upbeat',
  Achernar:'Soft', Alnilam:'Firm', Schedar:'Even', Gacrux:'Mature', Pulcherrima:'Forward',
  Achird:'Friendly', Zubenelgenubi:'Casual', Vindemiatrix:'Gentle', Sadachbia:'Lively',
  Sadaltager:'Knowledgeable', Sulafat:'Warm'
};

const EDGE_TTS_VOICES = [
  { id:'en-US-AriaNeural',        name:'Aria',        gender:'F', desc:'Expressive · warm' },
  { id:'en-US-JennyNeural',       name:'Jenny',       gender:'F', desc:'Warm · gentle' },
  { id:'en-US-NancyNeural',       name:'Nancy',       gender:'F', desc:'Natural · clear' },
  { id:'en-US-SaraNeural',        name:'Sara',        gender:'F', desc:'Cheerful' },
  { id:'en-US-MichelleNeural',    name:'Michelle',    gender:'F', desc:'Friendly' },
  { id:'en-US-MonicaNeural',      name:'Monica',      gender:'F', desc:'Warm · relaxed' },
  { id:'en-US-AnaNeural',         name:'Ana',         gender:'F', desc:'Youthful · child' },
  { id:'en-US-CoraNeural',        name:'Cora',        gender:'F', desc:'Bright' },
  { id:'en-US-ElizabethNeural',   name:'Elizabeth',   gender:'F', desc:'Mature · assured' },
  { id:'en-US-JaneNeural',        name:'Jane',        gender:'F', desc:'Calm · professional' },
  { id:'en-US-GuyNeural',         name:'Guy',         gender:'M', desc:'Confident' },
  { id:'en-US-TonyNeural',        name:'Tony',        gender:'M', desc:'Friendly' },
  { id:'en-US-BrianNeural',       name:'Brian',       gender:'M', desc:'Deep · clear' },
  { id:'en-US-EricNeural',        name:'Eric',        gender:'M', desc:'Reliable' },
  { id:'en-US-RogerNeural',       name:'Roger',       gender:'M', desc:'Strong' },
  { id:'en-US-ChristopherNeural', name:'Christopher', gender:'M', desc:'Professional' },
  { id:'en-US-SteffanNeural',     name:'Steffan',     gender:'M', desc:'Clear' },
  { id:'en-US-JasonNeural',       name:'Jason',       gender:'M', desc:'Calm' },
];

function getCharVoiceKey()   { return currentChar ? `cm_voice_${currentChar.id}` : null; }
function getTTSProviderKey() { return currentChar ? `cm_tts_prov_${currentChar.id}` : null; }
function getGeminiVoiceKey() { return currentChar ? `cm_gem_voice_${currentChar.id}` : null; }
function getEdgeVoiceKey()   { return currentChar ? `cm_edge_voice_${currentChar.id}` : null; }

function loadCharVoice() {
  selectedVoice = null; ttsProvider = 'gemini'; geminiVoiceName = 'Aoede'; edgeVoiceName = null;
  try {
    // Global fallback — last voice the user picked on any character
    const gp = localStorage.getItem('cm_tts_prov_global');
    if (['edge','gemini'].includes(gp)) ttsProvider = gp;
    const ggv = localStorage.getItem('cm_gem_voice_global');
    if (GEMINI_TTS_VOICES.includes(ggv)) geminiVoiceName = ggv;
    const gev = localStorage.getItem('cm_edge_voice_global');
    if (gev && EDGE_TTS_VOICES.some(v => v.id === gev)) edgeVoiceName = gev;
  } catch(_) {}
  if (!currentChar) return;
  try {
    // Per-character overrides take priority over global
    const p = localStorage.getItem(getTTSProviderKey());
    if (['edge','gemini'].includes(p)) ttsProvider = p;
    const gv = localStorage.getItem(getGeminiVoiceKey());
    if (GEMINI_TTS_VOICES.includes(gv)) geminiVoiceName = gv;
    const ev = localStorage.getItem(getEdgeVoiceKey());
    if (ev && EDGE_TTS_VOICES.some(v => v.id === ev)) edgeVoiceName = ev;
    const saved = localStorage.getItem(getCharVoiceKey());
    if (saved && window.speechSynthesis) { const vs = window.speechSynthesis.getVoices(); selectedVoice = vs.find(v => v.voiceURI === saved) || null; }
  } catch(_) {}
}

function applyVoice(utterance) {
  if (selectedVoice) utterance.voice = selectedVoice;
}

function openVoicePanel() {
  const overlay = document.getElementById('voicePanelOverlay');
  if (!overlay) return;
  const nameEl = document.getElementById('voicePanelCharName');
  if (nameEl) nameEl.textContent = currentChar?.name || 'this character';
  renderVoiceList();
  overlay.style.display = 'flex';
}

function closeVoicePanel() {
  const overlay = document.getElementById('voicePanelOverlay');
  if (overlay) overlay.style.display = 'none';
}

function setTTSProvider(p, btn) {
  ttsProvider = p;
  try {
    if (getTTSProviderKey()) localStorage.setItem(getTTSProviderKey(), p);
    localStorage.setItem('cm_tts_prov_global', p);
  } catch(_) {}
  document.querySelectorAll('.voice-provider-tab').forEach(b => b.classList.toggle('active', b.dataset.provider === p));
  renderVoiceList();
}

function renderVoiceList() {
  const list = document.getElementById('voiceList');
  if (!list) return;
  document.querySelectorAll('.voice-provider-tab').forEach(b => b.classList.toggle('active', b.dataset.provider === ttsProvider));

  if (ttsProvider === 'gemini') {
    list.innerHTML = GEMINI_TTS_VOICES.map(v =>
      `<button class="voice-item${geminiVoiceName === v ? ' active' : ''}" onclick="selectGeminiVoice('${v}',this)">
        <div class="voice-item-main"><div class="voice-item-name">${v}</div><div class="voice-item-lang">${GEMINI_VOICE_DESC[v] || ''}</div></div>
        <button class="voice-preview-btn" onclick="previewGeminiVoice('${v}',event)" title="Preview">▶</button>
      </button>`).join('');
    return;
  }

  if (ttsProvider === 'edge') {
    list.innerHTML = `<button class="voice-item${!edgeVoiceName?' active':''}" onclick="selectEdgeVoice(null,this)">
        <div class="voice-item-main"><div class="voice-item-name">Auto</div><div class="voice-item-lang">Matched to character</div></div>
      </button>` +
      EDGE_TTS_VOICES.map(v =>
        `<button class="voice-item${edgeVoiceName===v.id?' active':''}" onclick="selectEdgeVoice('${v.id}',this)">
          <div class="voice-item-main"><div class="voice-item-name">${v.name} <span style="font-size:10px;color:var(--text3)">${v.gender==='F'?'♀':'♂'}</span></div><div class="voice-item-lang">${v.desc}</div></div>
          <button class="voice-preview-btn" onclick="previewEdgeVoice('${v.id}',event)" title="Preview">▶</button>
        </button>`).join('');
    return;
  }

  // Browser voices
  if (!window.speechSynthesis) { list.innerHTML = '<div class="voice-empty">Browser voices not supported.</div>'; return; }
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) {
    setTimeout(() => { if (document.getElementById('voiceList')) renderVoiceList(); }, 400);
    list.innerHTML = '<div class="voice-empty">Loading voices…</div>';
    return;
  }
  const saved = (() => { try { return localStorage.getItem(getCharVoiceKey()); } catch(_) { return null; } })();
  const english = voices.filter(v => v.lang.startsWith('en'));
  const displayVoices = english.length ? english : voices;
  list.innerHTML = `<button class="voice-item${!saved ? ' active' : ''}" onclick="selectVoice(null,this)">
    <div class="voice-item-main"><div class="voice-item-name">Default</div><div class="voice-item-lang">System default</div></div>
  </button>` + displayVoices.map(v => `<button class="voice-item${saved === v.voiceURI ? ' active' : ''}" onclick="selectVoice('${escHtml(v.voiceURI)}',this)">
    <div class="voice-item-main"><div class="voice-item-name">${escHtml(v.name)}</div><div class="voice-item-lang">${escHtml(v.lang)}</div></div>
    <button class="voice-preview-btn" onclick="previewVoiceURI('${escHtml(v.voiceURI)}',event)" title="Preview">▶</button>
  </button>`).join('');
}

function selectVoice(voiceURI, btn) {
  const key = getCharVoiceKey();
  try { voiceURI ? localStorage.setItem(key, voiceURI) : localStorage.removeItem(key); } catch(_) {}
  document.querySelectorAll('#voiceList .voice-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedVoice = voiceURI && window.speechSynthesis ? (window.speechSynthesis.getVoices().find(v => v.voiceURI === voiceURI) || null) : null;
}

function selectGeminiVoice(v, btn) {
  geminiVoiceName = v;
  try {
    if (getGeminiVoiceKey()) localStorage.setItem(getGeminiVoiceKey(), v);
    localStorage.setItem('cm_gem_voice_global', v);
  } catch(_) {}
  document.querySelectorAll('#voiceList .voice-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function selectEdgeVoice(v, btn) {
  edgeVoiceName = v;
  try {
    const k = getEdgeVoiceKey();
    if (k) { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); }
    v ? localStorage.setItem('cm_edge_voice_global', v) : localStorage.removeItem('cm_edge_voice_global');
  } catch(_) {}
  document.querySelectorAll('#voiceList .voice-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function previewEdgeVoice(v, e) {
  e?.stopPropagation();
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Hi! I'm ${currentChar?.name || 'your character'}.`, provider: 'edge', edgeVoice: v, charId: currentChar?.id || '' }) });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); a.play().catch(() => {});
  } catch(_) {}
}

async function previewGeminiVoice(v, e) {
  e?.stopPropagation();
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Hi! I'm ${currentChar?.name || 'your character'}.`, provider: 'gemini', geminiVoice: v, charId: currentChar?.id || '' }) });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); a.play().catch(() => {});
  } catch(_) {}
}

function previewVoiceURI(voiceURI, e) {
  e?.stopPropagation();
  if (!window.speechSynthesis) return;
  const voice = window.speechSynthesis.getVoices().find(v => v.voiceURI === voiceURI);
  if (!voice) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(`Hi, I'm ${currentChar?.name || 'your character'}. How can I help you today?`);
  u.voice = voice;
  window.speechSynthesis.speak(u);
}

// ── Plans panel ──────────────────────────────────────────────────────────────

// ── Resources panel ───────────────────────────────────────────────────────────
let _cachedGpsCoords = null; // reuse within session — GPS permission only asked once

function openResourcesPanel() {
  closeSidebarMobile();
  const overlay = document.getElementById('resourcesPanelOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  loadResources();
}

function closeResourcesPanel() {
  const overlay = document.getElementById('resourcesPanelOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function loadResources() {
  const el = document.getElementById('resourcesPanelContent');
  if (!el) return;
  el.innerHTML = '<div class="history-empty">Requesting your location for accurate local resources…</div>';
  try {
    // The exact location is sent in the request body, never in the address (addresses end up in server logs)
    let sendCoords = null;
    if (_cachedGpsCoords) {
      sendCoords = _cachedGpsCoords;
    } else if (navigator.geolocation) {
      const coords = await new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(
          pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
          () => resolve(null),
          { timeout: 7000, maximumAge: 300000 }
        );
      });
      if (coords) { _cachedGpsCoords = coords; sendCoords = coords; }
    }
    const res = sendCoords
      ? await fetch('/api/crisis-resources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: sendCoords.lat, lon: sendCoords.lon }) })
      : await fetch('/api/crisis-resources');
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    if (!data.resources) {
      el.innerHTML = '<div class="history-empty" style="line-height:1.7">Resources could not be loaded for your region.<br>If you are in crisis, please contact your local emergency services.</div>';
      return;
    }
    const locationHtml = data.location
      ? `<div style="font-size:12px;color:var(--text3);margin-bottom:14px">📍 Resources for <strong style="color:var(--text2)">${escHtml(data.location)}</strong></div>`
      : '';
    const rows = data.resources.map(r => {
      const safeUrl = (typeof r.url === 'string' && /^https:\/\//i.test(r.url)) ? r.url : null;
      const row = `
      <div class="resource-row" style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:14px;font-weight:600;color:var(--text1);margin-bottom:2px">${escHtml(r.crisis)}${safeUrl ? ' <span class="resource-ext" aria-hidden="true">↗</span>' : ''}</div>
        <div style="font-size:12px;color:var(--text3);line-height:1.5">${escHtml(r.crisisName)}</div>
      </div>`;
      // Opens the organization's website in a new tab so the person keeps their chat open
      return safeUrl
        ? `<a class="resource-link" href="${escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" title="Open website">${row}</a>`
        : row;
    }).join('');
    el.innerHTML = `
      <div style="font-size:13px;color:var(--text3);margin-bottom:14px;line-height:1.7">If you or someone you know is in distress, these local resources are here to help. You are not alone.</div>
      ${locationHtml}
      ${rows}`;
  } catch {
    el.innerHTML = '<div class="history-empty">Unable to load resources. If you are in immediate danger, call <strong>911</strong>.</div>';
  }
}

// ── History panel ─────────────────────────────────────────────────────────────
let _histTab = 'current';

function openHistoryPanel() {
  const overlay = document.getElementById('historyPanelOverlay');
  if (!overlay) return;
  _histTab = 'current';
  renderHistoryPanel();
  switchHistoryTab('current');
  overlay.style.display = 'flex';
}

function closeHistoryPanel() {
  const overlay = document.getElementById('historyPanelOverlay');
  if (overlay) overlay.style.display = 'none';
}

function switchHistoryTab(tab) {
  _histTab = tab;
  document.getElementById('histViewCurrent').style.display = tab === 'current' ? 'flex' : 'none';
  document.getElementById('histViewPast').style.display = tab === 'past' ? 'flex' : 'none';
  document.getElementById('histTabCurrent').classList.toggle('hist-tab-active', tab === 'current');
  document.getElementById('histTabPast').classList.toggle('hist-tab-active', tab === 'past');
  if (tab === 'past') loadPastChats();
}

function renderHistoryPanel() {
  const list = document.getElementById('historyMsgList');
  if (!list) return;
  const msgs = document.querySelectorAll('#messages .msg');
  if (!msgs.length) { list.innerHTML = '<div class="history-empty">No messages in this conversation yet.</div>'; return; }
  list.innerHTML = [...msgs].map(msg => {
    const isAi = msg.classList.contains('ai');
    const text = (msg.querySelector('.bubble')?.innerText || '').trim();
    if (!text) return '';
    const name = isAi ? escHtml(currentChar?.name || 'AI') : 'You';
    const preview = escHtml(text.length > 180 ? text.substring(0, 180) + '…' : text);
    return `<div class="history-msg-row ${isAi ? 'ai' : 'user'}"><span class="history-msg-who">${name}</span><span class="history-msg-text">${preview}</span></div>`;
  }).join('');
}

async function loadPastChats() {
  if (!currentChar) return;
  const el = document.getElementById('pastChatsArchiveList');
  if (!el) return;
  el.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    const res = await fetch(`/api/conversations/${currentChar.id}/history`);
    const serverArchives = res.ok ? await res.json() : [];
    const localArchives = loadPastChatsLocal(currentChar.id);

    // Merge server and local archives, dedup by approximate token
    const serverTokens = new Set(serverArchives.map(a => {
      const fm = a.first_msg;
      return `${a.message_count}_${(fm?.content || '').slice(0, 30)}`;
    }));
    const uniqueLocal = localArchives.filter(a => {
      const fm = a.messages?.[0];
      const token = `${a.messages?.length}_${(fm?.content || '').slice(0, 30)}`;
      return !serverTokens.has(token);
    });

    const allArchives = [
      ...serverArchives.map(a => ({ ...a, _src: 'server' })),
      ...uniqueLocal.map(a => ({ ...a, _localIdx: localArchives.indexOf(a), _src: 'local' }))
    ].sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at));

    if (!allArchives.length) {
      el.innerHTML = '<div class="history-empty">No past chats yet. Use "New Chat" to archive the current conversation.</div>';
      return;
    }
    window._pastChatList = allArchives;
    const deleteAllBar = `<div class="past-chat-toolbar"><span>${allArchives.length} past chat${allArchives.length !== 1 ? 's' : ''}</span><button class="past-chat-delall" onclick="deleteAllPastChats()">Delete all</button></div>`;
    el.innerHTML = deleteAllBar + allArchives.map((a, i) => {
      const exact = new Date(a.archived_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const date = timeAgo(a.archived_at) || exact;   // "13 days ago"; the exact date shows when you hover
      const lastMsg = a._src === 'local' ? a.messages?.[a.messages.length - 1] : (a.last_msg || a.first_msg);
      const msgCount = a._src === 'local' ? (a.messages?.length || 0) : (a.message_count || 0);
      const lastText = lastMsg ? String(lastMsg.card === 'nsfw' ? '' : (lastMsg.content || '')) : '';
      const preview = lastMsg ? escHtml(lastText.slice(0, 160) + (lastText.length > 160 ? '…' : '')) : 'No messages';
      const role = (lastMsg?.role === 'user') ? 'You' : escHtml(currentChar.name || 'AI');
      const clickArg = a._src === 'local' ? `null,'local',${a._localIdx}` : `${a.id},'server'`;
      return `<div class="past-chat-entry" onclick="viewPastChat(${clickArg})">
        <div class="past-chat-meta"><span class="past-chat-date" title="${escHtml(exact)}">${escHtml(date)}</span><span class="past-chat-count">${msgCount} msg${msgCount !== 1 ? 's' : ''}<button class="past-chat-del" title="Delete this chat" aria-label="Delete this chat" onclick="deletePastChatAt(${i}, event)"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></span></div>
        <div class="past-chat-preview"><span class="past-chat-who">${role}:</span> ${preview}</div>
      </div>`;
    }).join('');
  } catch (_) {
    el.innerHTML = '<div class="history-empty">Could not load past chats.</div>';
  }
}

function pastChatMatchToken(a) {
  const fm = a.messages ? a.messages[0] : a.first_msg;
  const count = a.messages ? a.messages.length : a.message_count;
  return `${count}_${(fm?.content || '').slice(0, 30)}`;
}

function removeLocalPastChats(charId, shouldRemove) {
  try {
    const key = userKey(`cm_pastchats_${charId}`);
    const kept = JSON.parse(localStorage.getItem(key) || '[]').filter(a => !shouldRemove(a));
    localStorage.setItem(key, JSON.stringify(kept));
  } catch (_) {}
}

async function deletePastChatAt(i, ev) {
  if (ev) ev.stopPropagation();
  const a = window._pastChatList && window._pastChatList[i];
  if (!a || !currentChar) return;
  if (!confirm('Delete this past chat? This cannot be undone.')) return;
  if (a._src === 'server') {
    try {
      const r = await fetch(`/api/conversations/${currentChar.id}/history/${a.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
    } catch (_) { showWarning('Could not delete that chat. Please try again.'); return; }
    const t = pastChatMatchToken(a);
    removeLocalPastChats(currentChar.id, l => pastChatMatchToken(l) === t);
  } else {
    removeLocalPastChats(currentChar.id, l => l._token === a._token);
  }
  loadPastChats();
}

async function deleteAllPastChats() {
  if (!currentChar) return;
  if (!confirm(`Delete ALL past chats with ${currentChar.name || 'this character'}? Your current conversation is kept. This cannot be undone.`)) return;
  try {
    const r = await fetch(`/api/conversations/${currentChar.id}/history`, { method: 'DELETE' });
    if (!r.ok) throw new Error();
  } catch (_) { showWarning('Could not delete your past chats. Please try again.'); return; }
  try { localStorage.removeItem(userKey(`cm_pastchats_${currentChar.id}`)); } catch (_) {}
  loadPastChats();
}

async function viewPastChat(archiveId, src, localIdx) {
  if (!currentChar) return;
  const el = document.getElementById('pastChatsArchiveList');
  if (!el) return;

  let msgs = [], dateStr = '';
  if (src === 'local') {
    const locals = loadPastChatsLocal(currentChar.id);
    const entry = locals[localIdx];
    if (!entry) { el.innerHTML = '<div class="history-empty">Could not load this chat.</div>'; return; }
    msgs = entry.messages || [];
    dateStr = (timeAgo(entry.archived_at) ? timeAgo(entry.archived_at) + ' \u00b7 ' : '') + new Date(entry.archived_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } else {
    el.innerHTML = '<div class="history-empty">Loading…</div>';
    try {
      const res = await fetch(`/api/conversations/${currentChar.id}/history/${archiveId}`);
      if (!res.ok) throw new Error();
      const archive = await res.json();
      msgs = archive.messages || [];
      dateStr = (timeAgo(archive.archived_at) ? timeAgo(archive.archived_at) + ' \u00b7 ' : '') + new Date(archive.archived_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      el.innerHTML = '<div class="history-empty">Could not load this chat.</div>';
      return;
    }
  }

  const rows = msgs.map(m => {
    const isAi = m.role === 'assistant' || m.role === 'ai';
    const name = isAi ? escHtml(currentChar.name || 'AI') : 'You';
    const content = m.card === 'nsfw' ? NSFW_CARD_TITLES[Number.isInteger(m.variant) ? m.variant % NSFW_CARD_TITLES.length : 0] : (m.content || '');
    const text = escHtml(content.slice(0, 400) + (content.length > 400 ? '…' : ''));
    return `<div class="history-msg-row ${isAi ? 'ai' : 'user'}"><span class="history-msg-who">${name}</span><span class="history-msg-text">${text}</span></div>`;
  }).join('');
  // Store msgs on window so resumePastChat can access them without re-fetch
  window._viewedPastChatMsgs = msgs;
  el.innerHTML = `
    <div class="past-chat-back">
      <button class="history-action-btn" onclick="loadPastChats()">← Back</button>
      <span style="font-size:12px;color:var(--text3)">${dateStr}</span>
    </div>
    <div style="padding:8px 12px 4px">
      <button class="history-action-btn" style="width:100%;justify-content:center;background:var(--accent);color:#fff;border-color:transparent" onclick="resumePastChat(window._viewedPastChatMsgs)">↩ Resume this chat</button>
    </div>
    ${rows || '<div class="history-empty">No messages in this archive.</div>'}
  `;
}

async function resumePastChat(msgs) {
  if (!currentChar || !msgs || !msgs.length) return;
  if (isStreaming) { showWarning('Wait for the reply to finish first.'); return; }
  const current = loadHistoryLocal(currentChar.id);
  if (current.length > 0) {
    savePastChatLocal(currentChar.id, current);
    await fetch(`/api/conversations/${currentChar.id}/archive`, { method: 'POST' }).catch(() => {});
  }
  const messagesEl = document.getElementById('messages');
  if (messagesEl) messagesEl.innerHTML = '';
  const welcome = document.getElementById('chatWelcome');
  if (welcome) welcome.innerHTML = '';
  msgs.forEach((m, i) => appendHistoryItem(m, i < msgs.length - LIVE_COLOUR_MESSAGES));
  saveHistoryLocal();
  resyncServer();
  closeHistoryPanel();
  scrollToBottom();
}

function exportHistory() {
  const msgs = document.querySelectorAll('#messages .msg');
  if (!msgs.length) return;
  const lines = [`Chat with ${currentChar?.name || 'Character'}`, '='.repeat(40), ''];
  [...msgs].forEach(msg => {
    const isAi = msg.classList.contains('ai');
    const text = (msg.querySelector('.bubble')?.innerText || '').trim();
    if (!text) return;
    lines.push(`${isAi ? (currentChar?.name || 'AI') : 'You'}: ${text}`, '');
  });
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `chat-${(currentChar?.name || 'character').replace(/\s+/g, '-')}.txt` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function clearHistoryFromPanel() {
  if (currentChatLocked) {
    closeHistoryPanel();
    showWarning('This chat is permanently closed. Use "Start new chat" or "Delete chat" inside the chat.');
    return;
  }
  if (!confirm('Clear all messages in this conversation? The current chat is saved to your past chats, and the character starts fresh.')) return;
  closeHistoryPanel();
  newChat();
}

// ── TTS (Text-to-Speech) ─────────────────────────────────────────────────────
let activeTTSUtterance = null;
let activeTTSBtn = null;
let activeTTSAudio = null;

const gameIframeMap = new Map();

function maybeRenderGame(bubble, charColor) {
  const raw = bubble.dataset.raw || '';
  const GSTART = '[GAME_START]', GEND = '[GAME_END]';
  const si = raw.indexOf(GSTART), ei = raw.indexOf(GEND);
  if (si === -1 || ei === -1 || ei <= si) return;
  const before = raw.slice(0, si).trimEnd();
  const gameHtml = raw.slice(si + GSTART.length, ei).trim();
  if (!gameHtml) return;
  const after = raw.slice(ei + GEND.length).trimStart();
  bubble.innerHTML = '';
  if (before) {
    const el = document.createElement('span');
    el.innerHTML = renderMarkdown(before);
    colorizeLetters(el, charColor);
    bubble.appendChild(el);
  }
  bubble.appendChild(createGameCard(gameHtml, charColor));
  if (after) {
    const el = document.createElement('span');
    el.innerHTML = renderMarkdown(after);
    colorizeLetters(el, charColor);
    bubble.appendChild(el);
  }
}

function postprocessGameHtml(html) {
  // Inject an on-screen keyboard into old Wordle-style games that don't have one
  const hasWordleGrid = (/class="cell"/.test(html) && /class="row"/.test(html))
    || (/class="tile"/.test(html) && /class.*board/.test(html))
    || /wordle/i.test(html.slice(0, 2000));
  const hasKeyboard = /id="kb"/.test(html) || /id='kb'/.test(html) || /id="_injkb"/.test(html) || /bkb\(/.test(html)
    || /id="keyboard"/.test(html) || /class="keyboard"/.test(html) || /class="key-row"/.test(html);
  if (!hasWordleGrid || hasKeyboard) return html;
  const kbStyle = `<style>#_injkb{display:flex;flex-direction:column;gap:4px;align-items:center;margin:6px auto 0}._ikr{display:flex;gap:3px}._ik{height:42px;padding:0 5px;min-width:30px;background:#818384;border:none;border-radius:4px;color:#fff;font-size:11px;font-weight:700;cursor:pointer;user-select:none;transition:background .15s}._ik:active{opacity:.75}</style>`;
  const kbHtml = `<div id="_injkb"></div>`;
  const kbScript = `<script>(function(){var rows=["QWERTYUIOP","ASDFGHJKL","⌫ZXCVBNM↵"],kb=document.getElementById("_injkb");if(!kb)return;rows.forEach(function(row){var d=document.createElement("div");d.className="_ikr";[...row].forEach(function(k){var b=document.createElement("button");b.className="_ik";b.textContent=k;b.addEventListener("mousedown",function(e){e.preventDefault();var kn=k==="⌫"?"Backspace":k==="↵"?"Enter":k;var opts={key:kn,code:kn.length===1?"Key"+kn.toUpperCase():"",bubbles:true,cancelable:true};document.dispatchEvent(new KeyboardEvent("keydown",opts));window.dispatchEvent(new KeyboardEvent("keydown",opts));});d.appendChild(b);});kb.appendChild(d);});})();<\/script>`;
  if (html.includes('</head>')) html = html.replace('</head>', kbStyle + '</head>');
  if (html.includes('</body>')) html = html.replace('</body>', kbHtml + kbScript + '</body>');
  return html;
}

function createGameCard(htmlContent, accentColor) {
  const card = document.createElement('div');
  card.className = 'game-card';
  const header = document.createElement('div');
  header.className = 'game-card-header';
  const icon = document.createElement('span');
  icon.textContent = '🎮';
  icon.style.cssText = 'font-size:1.1em;line-height:1;flex-shrink:0';
  const label = document.createElement('span');
  label.className = 'game-card-label';
  label.textContent = 'Playable Game';
  const btn = document.createElement('button');
  btn.className = 'game-card-btn';
  btn.textContent = '▶ Play';
  const hex = accentColor && /^#[0-9a-fA-F]{6}$/.test(accentColor);
  if (hex) btn.style.background = accentColor;
  header.appendChild(icon);
  header.appendChild(label);
  header.appendChild(btn);
  card.appendChild(header);
  const frame = document.createElement('div');
  frame.className = 'game-card-frame';
  frame.style.display = 'none';
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', 'Playable game');
  const resultBanner = document.createElement('div');
  resultBanner.className = 'game-result-banner';
  frame.appendChild(iframe);
  card.appendChild(frame);
  card.appendChild(resultBanner);
  gameIframeMap.set(iframe, card);
  let loaded = false, open = false;
  btn.addEventListener('click', () => {
    open = !open;
    frame.style.display = open ? '' : 'none';
    btn.textContent = open ? '✕ Close' : '▶ Play';
    if (!open) resultBanner.classList.remove('shown');
    if (open && !loaded) {
      loaded = true;
      iframe.srcdoc = postprocessGameHtml(htmlContent);
      // Obtain a one-use server token so the win award can't be farmed
      fetch('/api/game/session/start', { method: 'POST' })
        .then(r => r.json())
        .then(d => { if (d.gameToken) card.dataset.gameToken = d.gameToken; })
        .catch(() => {});
    }
  });
  return card;
}

const GAME_WIN_SAYINGS = [
  "Oh, you actually won. Interesting. I'll allow it... this time.",
  "A win! Look at you. Did you practice? ...You practiced, didn't you.",
  "You beat me. I'm not upset. I'm taking notes.",
  "Victory! Wonderful. Don't let it go to your head. It's already there, isn't it.",
  "Well done. Disgusting, but well done.",
  "You won! I'm clapping on the inside. Very slowly.",
  "Unbelievable. Absolutely unbelievable. And yet here we are.",
  "Fine. You won. I concede. Do NOT make a big deal out of this.",
  "How dare you be good at this.",
];
const GAME_LOSE_SAYINGS = [
  "Better luck next time! And there WILL be a next time, won't there. You'll make sure of it.",
  "You lost. But you tried, and that's — no, that's not enough. You lost.",
  "Oof. That was rough to watch. You okay?",
  "Oh no. Oh no no no. Are you okay? Do you need a moment?",
  "That was... something. You tried! That has to count for something. Right?",
  "I would say 'nice try' but I believe in honesty.",
  "Did you want a consolation prize? I don't have one. I have honest feedback though. Want some?",
  "You'll get it next time. Probably. The odds improve slightly each attempt.",
  "Loss accepted. Dignity intact. Barely.",
];
const GAME_DRAW_SAYINGS = [
  "A draw! The perfect outcome for people who can't commit to winning or losing.",
  "Nobody wins, nobody loses. The game meant nothing. Deep.",
  "Tie game. We are balanced. Equals. I don't love this outcome.",
  "A draw. Acceptable. Just barely.",
  "Look at us, perfectly matched. Terrifying.",
  "We canceled each other out. That's poetic. I think I hate it.",
  "Stalemate. We are mirrors. I'm unsettled by this.",
  "A draw means we're both undefeated today. Take that how you want.",
];

window.addEventListener('message', function(ev) {
  if (!ev.data || ev.data.type !== 'game_over') return;
  const sourceIframe = [...gameIframeMap.keys()].find(f => f.contentWindow === ev.source);
  if (!sourceIframe) return;
  const gameCard = gameIframeMap.get(sourceIframe);
  const result = ev.data.result; // 'win', 'loss', 'draw'
  const winner = ev.data.winner; // 'ai', 'human', null
  let sayings;
  if (result === 'win' && winner === 'human') sayings = GAME_WIN_SAYINGS;
  else if (result === 'win' && winner === 'ai') sayings = GAME_LOSE_SAYINGS;
  else if (result === 'loss' && winner === 'human') sayings = GAME_WIN_SAYINGS;
  else if (result === 'loss' && winner === 'ai') sayings = GAME_LOSE_SAYINGS;
  else sayings = GAME_DRAW_SAYINGS;
  const saying = sayings[Math.floor(Math.random() * sayings.length)];
  const banner = gameCard && gameCard.querySelector('.game-result-banner');
  if (banner) { banner.textContent = saying; banner.classList.add('shown'); }
  // Charge session tokens for this completed game
  if (currentUser) {
    fetch('/api/game/played', { method: 'POST' })
      .then(r => r.json())
      .then(usage => { if (usage && usage.sessionLimit) updateUsageBars(usage); })
      .catch(() => {});
    // Award coins if the human won
    if (winner === 'human') {
      const gameToken = gameCard && gameCard.dataset.gameToken;
      if (!gameToken) return; // no token means this game can't award coins
      delete gameCard.dataset.gameToken;
      fetch('/api/coins/award', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameToken }),
      })
        .then(r => r.json())
        .then(d => {
          if (d && typeof d.balance === 'number') {
            if (lastKnownUsage) lastKnownUsage.cmCoins = d.balance;
            else lastKnownUsage = { cmCoins: d.balance };
            updateNavCoinDisplay(lastKnownUsage);
            updateSettingsCoinDisplay(d.balance, d.earnedToday, d.dailyCap);
            if (d.awarded > 0) showCoinPop(d.awarded);
          }
        })
        .catch(() => {});
    }
  }
});

function addSwipeGesture(msgEl) {
  // ── Touch (mobile) ──
  let sx = 0, sy = 0, st = 0;
  msgEl.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
  }, { passive: true });
  msgEl.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx) * 0.9 || Date.now() - st > 700) return;
    handleSwipe(msgEl, dx);
  }, { passive: true });

  // ── Mouse drag (desktop) ──
  let mx = 0, my = 0, mt = 0, dragging = false;
  msgEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    mx = e.clientX; my = e.clientY; mt = Date.now(); dragging = true;
  });
  msgEl.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - mx;
    const dy = e.clientY - my;
    if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx) * 0.9 || Date.now() - mt > 700) return;
    handleSwipe(msgEl, dx);
  });
  msgEl.addEventListener('mouseleave', () => { dragging = false; });
}

function handleSwipe(msgEl, dx) {
  const id = msgEl.dataset.regenId;
  const store = id ? regenStore.get(id) : null;
  if (dx > 0) {
    if (store && store.idx < store.texts.length - 1) {
      regenNavStep(id, 1);
    } else {
      const allAi = [...document.getElementById('messages').querySelectorAll('.msg.ai')];
      if (allAi[allAi.length - 1] === msgEl) regenerate();
    }
  } else {
    if (store && store.idx > 0) regenNavStep(id, -1);
  }
}

function ttsCleanText(raw) {
  return raw
    .replace(/\*[^*]*\*/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/◆/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stopActiveTTS() {
  if (activeTTSAudio) { activeTTSAudio.pause(); activeTTSAudio = null; }
  if (activeTTSUtterance) { window.speechSynthesis.cancel(); activeTTSUtterance = null; }
  if (activeTTSBtn) { activeTTSBtn.classList.remove('playing', 'loading'); activeTTSBtn = null; }
}

async function toggleTTS(btn) {
  const bubble = btn.closest('.msg').querySelector('.bubble');
  const raw = (bubble.innerText || bubble.textContent).trim();
  const text = ttsCleanText(raw);
  if (!text) return;

  const wasSame = activeTTSBtn === btn;
  stopActiveTTS();
  if (wasSame) return;

  btn.classList.add('loading');
  activeTTSBtn = btn;

  if (ttsProvider === 'browser') {
    btn.classList.remove('loading'); btn.classList.add('playing');
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(text.slice(0, 300));
      if (selectedVoice) u.voice = selectedVoice;
      activeTTSUtterance = u;
      u.onend = () => stopActiveTTS(); u.onerror = () => stopActiveTTS();
      window.speechSynthesis.speak(u);
    } else { stopActiveTTS(); }
    return;
  }

  // Check + deduct memo before TTS — pass text length for variable cost
  try {
    const memoR = await fetch('/api/memo/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textLen: text.length }) });
    if (!memoR.ok) {
      stopActiveTTS();
      const memoData = await memoR.json().catch(() => ({}));
      if (memoR.status === 429 && memoData.type === 'memo_daily_limit') {
        showMemoLimitBanner(memoData.resetsAt);
      } else {
        showTTSError('Memo unavailable — try again shortly');
      }
      return;
    }
  } catch (_) { /* network error — try TTS anyway */ }

  let serverOk = false;
  let ttsStatus = 0;
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 400), charId: currentChar?.id || '', provider: ttsProvider, geminiVoice: geminiVoiceName, edgeVoice: edgeVoiceName || undefined })
    });
    ttsStatus = r.status;
    if (r.ok && activeTTSBtn === btn) {
      serverOk = true;
      btn.classList.remove('loading'); btn.classList.add('playing');
      const blob = await r.blob();
      if (activeTTSBtn !== btn) { serverOk = false; } else {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        activeTTSAudio = audio;
        audio.onended = () => { URL.revokeObjectURL(url); stopActiveTTS(); };
        audio.onerror = () => { URL.revokeObjectURL(url); stopActiveTTS(); };
        await audio.play().catch(() => { URL.revokeObjectURL(url); stopActiveTTS(); });
      }
    }
  } catch (_) {
    if (serverOk && activeTTSBtn === btn) stopActiveTTS();
  }
  if (activeTTSBtn === btn) btn.classList.remove('loading');

  if (!serverOk && activeTTSBtn === btn) {
    stopActiveTTS();
    if (ttsStatus > 0) showTTSError('Voice unavailable — try again shortly');
  }
}

function showTTSError(msg) {
  let el = document.getElementById('ttsErrorToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ttsErrorToast';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surface2,#2a2a2a);color:var(--text1,#fff);border:1px solid var(--border2,#444);border-radius:8px;padding:8px 16px;font-size:13px;z-index:9999;pointer-events:none;transition:opacity 0.3s;white-space:nowrap';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 4500);
}
function showMemoLimitBanner(resetsAt) {
  const banner = document.getElementById('memoLimitBanner');
  if (!banner) return;
  const timeEl = banner.querySelector('.memo-limit-time');
  if (timeEl && resetsAt) {
    const mT = formatResetTime(resetsAt); timeEl.textContent = mT ? 'Resets ' + mT : '';
  }
  banner.style.display = '';
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => { banner.style.display = 'none'; }, 7000);
}

function callModeTTS(bubble) {
  if (!callModeActive || !bubble) { if (callModeActive) setTimeout(() => listenForSpeech(), 500); return; }
  const text = (bubble.innerText || bubble.textContent).trim();
  if (!text) { listenForSpeech(); return; }
  resetCallInactivityTimer();
  setCallState('responding');
  stopCallAudio();
  if (serverTTSOk) { callModeTTS_server(text); return; }
  if (callModeActive) listenForSpeech();
}

let serverTTSOk = true;
let callAudio = null;

function stopCallAudio() {
  if (callAudio) { try { callAudio.pause(); } catch (_) {} callAudio = null; }
}

// Applies demon pitch-shift / echo via Web Audio API; resolves when playback ends
async function _hwDemonPlay(blob, tokenRef) {
  try {
    const arrayBuf = await blob.arrayBuffer();
    if (tokenRef.stopped) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    if (tokenRef.stopped) { ctx.close(); return; }
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.playbackRate.value = 0.68; // down ~2.8 semitones from half-speed
    // Soft distortion
    const dist = ctx.createWaveShaper();
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = (Math.PI + 150) * x / (Math.PI + 150 * Math.abs(x)); }
    dist.curve = curve; dist.oversample = '4x';
    // Low-pass + gain
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 2200;
    const gain = ctx.createGain(); gain.gain.value = 0.85;
    // Echo
    const delay = ctx.createDelay(0.6); delay.delayTime.value = 0.14;
    const dg = ctx.createGain(); dg.gain.value = 0.2;
    src.connect(dist); dist.connect(lpf); lpf.connect(gain);
    gain.connect(ctx.destination);
    gain.connect(delay); delay.connect(dg); dg.connect(ctx.destination);
    tokenRef.stop = () => { try { src.stop(); } catch(_){} setTimeout(() => ctx.close(), 200); };
    src.start(0);
    const dur = (audioBuf.duration / 0.68 + 0.8) * 1000;
    await new Promise(res => { src.onended = res; setTimeout(res, dur); });
    try { if (!tokenRef.stopped) ctx.close(); } catch(_){}
  } catch(e) { /* fallback to silence */ }
}

async function playCallBlob(blob) {
  if (!callModeActive) return;
  if (document.body.classList.contains('hw-demon-voice')) {
    const token = {};
    callAudio = { pause: () => { token.stopped = true; token.stop?.(); } };
    await _hwDemonPlay(blob, token);
    callAudio = null;
    if (!token.stopped && callModeActive) listenForSpeech();
    return;
  }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  callAudio = audio;
  const finish = () => {
    URL.revokeObjectURL(url);
    if (callAudio === audio) callAudio = null;
    if (callModeActive) listenForSpeech();
  };
  audio.onended = finish;
  audio.onerror = finish;
  try { await audio.play(); } catch (_) { finish(); }
}

async function speakAndHangUp(text, resetsAt) {
  stopCallAudio();
  window.speechSynthesis?.cancel();
  const gen = callGen;
  const clean = text.replace(/\*[^*]*\*/g, '').replace(/\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 250);
  const finish = () => {
    if (gen !== callGen) return;
    endCallMode();
    showCallLimitModal(resetsAt);
  };
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, charId: currentChar?.id, provider: ttsProvider, geminiVoice: geminiVoiceName })
    });
    if (r.ok) {
      const blob = await r.blob();
      if (gen !== callGen) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      callAudio = audio;
      audio.onended = () => { URL.revokeObjectURL(url); callAudio = null; finish(); };
      audio.onerror = () => { URL.revokeObjectURL(url); callAudio = null; finish(); };
      await audio.play().catch(finish);
    } else { finish(); }
  } catch (_) { finish(); }
}

async function callModeTTS_server(text) {
  const gen = callGen;
  const clean = text.replace(/\*[^*]*\*/g, '').replace(/\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!clean) { if (callModeActive && gen === callGen) listenForSpeech(); return; }

  if (ttsProvider === 'browser') { if (callModeActive && gen === callGen) listenForSpeech(); return; }

  // Split into sentences so we can start playing the first sentence immediately
  // while pre-fetching the next one — reduces the "falling behind" latency.
  const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
    ?.map(s => s.trim()).filter(s => s.length > 0) || [clean];

  const fetchBlob = async (s) => {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: s, charId: currentChar?.id, provider: ttsProvider, geminiVoice: geminiVoiceName })
    });
    if (!r.ok) { if (r.status === 501) serverTTSOk = false; throw new Error('tts ' + r.status); }
    return r.blob();
  };

  // Play a blob without triggering listenForSpeech (used for all-but-last sentences)
  const playBlobOnly = (blob) => new Promise(resolve => {
    if (!callModeActive) { resolve(); return; }
    if (document.body.classList.contains('hw-demon-voice')) {
      const token = {};
      callAudio = { pause: () => { token.stopped = true; token.stop?.(); } };
      _hwDemonPlay(blob, token).then(() => { callAudio = null; resolve(); });
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    callAudio = audio;
    const done = () => { URL.revokeObjectURL(url); if (callAudio === audio) callAudio = null; resolve(); };
    audio.onended = done; audio.onerror = done;
    audio.play().catch(done);
  });

  try {
    let nextFetch = fetchBlob(sentences[0]);
    for (let i = 0; i < sentences.length; i++) {
      if (gen !== callGen) return;
      // Pre-fetch next sentence in parallel while waiting for current blob
      const prefetch = (i + 1 < sentences.length) ? fetchBlob(sentences[i + 1]) : null;
      const blob = await nextFetch;
      if (gen !== callGen) return;
      if (i < sentences.length - 1) {
        await playBlobOnly(blob);
      } else {
        await playCallBlob(blob); // last sentence — playCallBlob calls listenForSpeech when done
      }
      nextFetch = prefetch;
    }
  } catch (_) {
    if (callModeActive && gen === callGen) listenForSpeech();
  }
}

// ── Call mode ─────────────────────────────────────────────────────────────────
let callGen = 0; // bumped when a call ends or is interrupted so late async results are dropped
let callMuted = false;
let callFirstConnect = false;
let callInactivityTimer = null;
let callInactivityWarnTimer = null;
let callStarting = false; // mutex: prevents double-start race condition
const CALL_INACTIVITY_MS = 15 * 60 * 1000;
const CALL_DAILY_MAX_SECS = 15 * 60; // 15 minutes per day
let callDurationTimer = null;
let callSessionStartedAt = null;
let lastKnownCallResetsAt = 0;
let callVobTimer = null;

function getCallSecsKey() {
  return 'cm_call_secs_' + new Date().toISOString().slice(0,10);
}
function getCallSecsUsedToday() {
  try { return parseInt(localStorage.getItem(getCallSecsKey()) || '0', 10) || 0; } catch(_) { return 0; }
}
function addCallSecsUsed(secs) {
  try { localStorage.setItem(getCallSecsKey(), String(getCallSecsUsedToday() + secs)); } catch(_) {}
}
function getCallSecsRemaining() {
  return CALL_DAILY_MAX_SECS; // no daily limit — coin balance is the only gate
}
function startCallDurationTimer() {
  if (callDurationTimer) clearInterval(callDurationTimer);
  callSessionStartedAt = Date.now();
  // Timer just tracks elapsed time for billing — no auto-end countdown
  callDurationTimer = setInterval(() => {}, 60000);
}
function stopCallDurationTimer() {
  if (callDurationTimer) { clearInterval(callDurationTimer); callDurationTimer = null; }
  if (callSessionStartedAt) {
    const elapsed = Math.round((Date.now() - callSessionStartedAt) / 1000);
    addCallSecsUsed(elapsed);
    callSessionStartedAt = null;
    if (elapsed > 0 && currentUser) {
      fetch('/api/call/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duration: elapsed }) })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.ok) setTimeout(() => loadUsage(), 300); }) // Bug 7 fix: sessionLimit was never in this response
        .catch(() => {});
    }
  }
}

function resetCallInactivityTimer() {
  clearTimeout(callInactivityTimer);
  clearTimeout(callInactivityWarnTimer);
  if (!callModeActive) return;
  callInactivityWarnTimer = setTimeout(() => {
    if (!callModeActive) return;
    showWarning('Still there? Call ends in 1 minute due to inactivity.', 8000);
  }, CALL_INACTIVITY_MS - 60000);
  callInactivityTimer = setTimeout(() => {
    if (!callModeActive) return;
    endCallMode();
    showCallInactivityBanner();
  }, CALL_INACTIVITY_MS);
}

function clearCallInactivityTimer() {
  clearTimeout(callInactivityTimer);
  clearTimeout(callInactivityWarnTimer);
  callInactivityTimer = null;
  callInactivityWarnTimer = null;
}

function showCallInactivityBanner() {
  const banner = document.getElementById('callInactivityBanner');
  if (!banner) return;
  banner.style.display = '';
  setTimeout(() => { banner.style.display = 'none'; }, 5000);
}

let callRecognition = null;

function toggleCallMode() {
  if (callModeActive) { endCallMode(); } else { startCallMode(); }
}

async function startCallMode() {
  if (callStarting || callModeActive) return;  // block concurrent/double starts
  callStarting = true;
  const startGen = callGen;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { callStarting = false; alert('Voice calls need a browser with speech recognition — try Chrome.'); return; }
  if (!currentChar) { callStarting = false; return; }
  // Check server-side blocks (token limits, bans, service offline)
  try {
    const r = await fetch('/api/call/start', { method: 'POST' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      callStarting = false;
      if (r.status === 429) {
        showCallLimitModal(data.resetsAt || data.cooldownUntil || Date.now() + 3600000);
      }
      return;
    }
  } catch(e) { /* offline — allow call anyway */ }

  if (startGen !== callGen) { callStarting = false; return; } // call was cancelled while starting
  callStarting = false;
  callModeActive = true;
  serverTTSOk = true; // reset so every new call retries server TTS from scratch
  callMuted = false;
  callFirstConnect = true;
  startCallDurationTimer();
  resetCallInactivityTimer();
  document.getElementById('callBtn')?.classList.add('active');
  const overlay = document.getElementById('callOverlay');
  if (overlay) {
    // Animated color orbs
    const [co1, co2, co3] = getCharCallColors(currentChar);
    const bgEl = document.getElementById('callBg');
    if (bgEl) {
      bgEl.style.setProperty('--co1', co1);
      bgEl.style.setProperty('--co2', co2);
      bgEl.style.setProperty('--co3', co3);
    }
    // Character image on top of orbs
    const imgEl = document.getElementById('callCharImg');
    if (imgEl) {
      if (isCharImg(currentChar.image)) {
        imgEl.style.backgroundImage = `url('${currentChar.image}')`;
      } else {
        imgEl.style.backgroundImage = '';
      }
    }
    const nameEl = document.getElementById('callCharName');
    if (nameEl) { nameEl.innerHTML = colorizeNameHtml(currentChar.name || '', currentChar.color); }
    overlay.style.display = 'flex';
    const vob = document.getElementById('callVoiceOnBadge');
    if (vob) { vob.style.display = ''; clearTimeout(callVobTimer); callVobTimer = setTimeout(() => { vob.style.display = 'none'; callVobTimer = null; }, 5000); }
    setCallState('calling');
    setTimeout(() => { if (callModeActive) listenForSpeech(); }, 150);
  }
}

// Per-character color palettes for the call screen swirl animation
const CHAR_CALL_PALETTES = {
  'custom_1790776698867':          ['#2255cc', '#991122', '#0d0022'],  // Poppy — blue dress, red hair
  'custom_1790774765927':          ['#6a5000', '#5a3000', '#130e00'],  // Doey — warm dough
  'custom_1790766558393':          ['#446688', '#223344', '#0a1520'],  // The Doctor — cool slate
  'custom_1790894243871_huggy':    ['#1155dd', '#001133', '#003344'],  // Huggy Wuggy — deep blue
  'custom_1790894243872_mll':      ['#cc1177', '#880066', '#200018'],  // Mommy Long Legs — hot pink
  'custom_1790894243873_catnap':   ['#991188', '#4d0040', '#1a0015'],  // CatNap — warm magenta-purple
  'custom_1790894243874_dogday':   ['#806600', '#804400', '#0d0c00'],  // DogDay — golden amber (screen-safe)
  'custom_1790894243875_prototype':['#888899', '#1a1a22', '#0044cc'],  // The Prototype — steel/electric
  'custom_1790894243876_kissy':    ['#993366', '#771133', '#0d1122'],  // Kissy Missy — deep rose/pink
  'custom_1790895433252_bunzo':    ['#880000', '#6b5000', '#0d0a00'],  // Bunzo — deep red/amber
  'custom_1790895433253_pj':       ['#2a6a2a', '#004400', '#081408'],  // PJ Pug-a-Pillar — deep green
  'custom_1790895433254_boxy':     ['#993399', '#550055', '#150015'],  // Boxy Boo — deep purple-pink
  'cm_miss_delight':               ['#bb2222', '#664400', '#1a3a99'],  // Miss Delight — crimson/amber/blue
  'custom_1790895433256_bubba':    ['#2266bb', '#002288', '#0a1a33'],  // Bubba Bubbaphant — blue
  'custom_1790895671421_yarnaby':  ['#aa2222', '#661111', '#180808'],  // Yarnaby — deep red
  'custom_1790895671422_craftycorn':['#884dbf','#6622aa', '#1a0033'],  // CraftyCorn — deep purple
  'custom_1790895671423_pickypiggy':['#aa4466','#cc3366', '#180011'],  // PickyPiggy — deep rose
  'custom_1790895671424_kickin':   ['#6b5a00', '#5a3800', '#0d0b00'],  // KickinChicken — deep amber
  'custom_1790895671425_bobby':    ['#aa2222', '#660000', '#180808'],  // BobbyBearhug — deep red
  'custom_1790895671426_hoppy':    ['#2a7a2a', '#156015', '#081208'],  // HoppyHopscotch — deep green
  'custom_1790895746935_elliot':   ['#334477', '#1a2244', '#0a1530'],  // Elliot Ludwig — navy
  'custom_1790895746936_stella':   ['#6a4a1a', '#4a2a0a', '#1a1200'],  // Stella — warm brown
  'custom_1790895746937_leith':    ['#557788', '#334455', '#0a1520'],  // Leith Pierre — teal slate
  'custom_1790897425575_lily':     ['#7722cc', '#1a0033', '#3a2800'],  // Lily Lovebraids — violet/deep gold
};

function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q-p)*6*t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q-p)*(2/3-t)*6;
    return p;
  };
  return '#' + [hue(h+1/3), hue(h), hue(h-1/3)]
    .map(v => Math.round(v*255).toString(16).padStart(2,'0')).join('');
}

function getCharCallColors(char) {
  if (char && CHAR_CALL_PALETTES[char.id]) return CHAR_CALL_PALETTES[char.id];
  const hex = (char?.color || '#7c3aed').match(/#[0-9a-fA-F]{6}/)?.[0] || '#7c3aed';
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), l = (max+min)/2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2*l - 1));
  let h = 0;
  if (d !== 0) {
    switch(max) {
      case r: h = ((g-b)/d % 6); break;
      case g: h = (b-r)/d + 2; break;
      case b: h = (r-g)/d + 4; break;
    }
    h = h * 60; if (h < 0) h += 360;
  }
  const c1 = hslToHex(h, Math.min(s*100+5,90), Math.max(Math.min(l*100, 32), 12));
  const c2 = hslToHex((h+130)%360, Math.min(s*100+10,100), Math.max(l*100-10,15));
  const c3 = hslToHex((h+250)%360, Math.min(s*100+5,100), Math.max(l*100+5,20));
  return [c1, c2, c3];
}

let _callLimitTimer = null;
let _sessionCountdownTimer = null;
let _sessionCountdownUntil = null;
const CALL_LIMIT_MESSAGES = [
  // Doll witness collection
  "*looks at Candy, then back at you, then at Candy again* She knew. She told me before you even started. I told her to be kind about it. She's choosing not to.",
  "*to Baby Long Legs* Don't look. Baby, I SAID don't look. *to you* She looked. You did this to her.",
  "*Candy whispers something urgent* Yes, yes, I heard her. *to you* Candy kept count. Every single call. She's very organized about these things. It's a little alarming.",
  "*Dolly Grub slides very slowly off the shelf* That's Dolly's way of commenting. She does that when she's unimpressed. I've learned to read it.",
  "*tilts braids toward ear* Candy says — and I'm quoting — 'absolutely not.' She said you'd try again. She set a timer. She wins.",
  "Dusky hasn't moved in an hour. *glances at Dusky* That IS a response from Dusky. Learn to read the room.",
  "*Baby Long Legs turns to face the wall* Baby does that when she's embarrassed. For YOU, not herself. She has feelings about your call count.",
  "*to the room* Is anyone surprised? Anyone at all? *Candy tugs braid* No. Candy is not surprised. Dolly is not surprised. Nobody here is surprised.",
  "You talked so long today that Candy fell asleep. Candy doesn't sleep. *stares at you* What did you do to her.",
  "*gently repositioning Dolly Grub* She toppled. Toppled because she couldn't believe it. That's what happened to Dolly today. That's on you.",
  "*Baby Long Legs shakes her small head back and forth* I don't know what you expected, but Baby's been doing that since your third call.",
  "Candy whispered something at the start of today that I told her was unkind. *long pause* She was right. Completely right. I'm not giving her the satisfaction of saying so out loud.",
  "*to Dusky* Don't say anything. I know what you're thinking and it's not polite. *to you* Dusky has opinions. He's choosing to keep them. For now.",
  "*turns to Baby Long Legs* Baby, darling, go to your shelf. You don't need to see this. *Baby does not go* She's staying. She's choosing to witness. That's on you.",
  "I told Dolly Grub that visitors are usually quite reasonable. *Dolly stares* This is her stare. I've seen it three times today. All three were because of you.",
  "*Candy is very quiet* When Candy goes quiet it means she has a LOT to say and she's choosing not to. The restraint is — *braid twitches* ...she spoke.",
  "Baby Long Legs asked me this morning — through the usual method — if you were coming back. She asked in a worried way. Not an excited way. A worried way.",
  "*Dusky has relocated himself to the highest shelf* That's where he goes when he needs perspective. He needed perspective about you specifically. Today.",
  "*Dolly Grub is lying face-down* She does that. It means she's processing. Give her a moment. She'll be fine. But this is because of you.",
  "You know what Candy said? Right at the start of today? *pause* 'They'll use all of them.' Just like that. Flat statement. She didn't even seem upset. Just certain.",
  "*Baby Long Legs reaches her little arms out toward you* She's not hugging you. She's saying goodbye for now. There's a difference. She knows it.",
  "*room is very quiet* Even Dolly isn't saying anything. Even Dolly. Do you understand what that means.",
  "*to Candy* I know, I know. *to you* She said something I'm choosing not to repeat. You should probably be grateful.",
  "*Dolly Grub and Dusky exchange a look* They don't usually agree on things. You've managed to unite them in their feelings about your voice call usage.",
  "*Baby Long Legs covers her face with her small hands* She does this when she's secondhand embarrassed. She has never done this before today.",
  "Candy tugged my braid four times in a row just now. Four times means she's given up trying to express it in words. That's where we are.",
  "*to the dolls* Does anyone want to tell them, or shall I? *silence* Right. It's going to be me again. You've used all your voice calls.",
  // Hostile / rude
  "Oh. You again. Still trying. Cute.",
  "No. Just no. Go outside. There's a whole world out there and you're here pressing buttons.",
  "Get the fuck out of here before I tear you apart. Come back tomorrow. Maybe.",
  "You've got nerve, I'll give you that. The audacity. The sheer unmitigated audacity.",
  "The calls are gone. You used them. That's what happens when you talk. This is cause and effect.",
  "Did you think the limit was a suggestion? It's not. It's a hard wall. Hello wall.",
  "I'm not angry. I'm just deeply, profoundly, cosmically disappointed.",
  "Are you genuinely confused right now? Because you shouldn't be. This is very simple.",
  "Oh, you want to talk some more? Wild. Wild behavior from someone who already talked.",
  "The audacity PLUS the nerve PLUS the gall. That's a triple threat. Unfortunately it's still a no.",
  "You've already used your calls today. Congratulations. You win the 'most calls' trophy. It's invisible.",
  "Not today. Tomorrow, maybe. Today? Absolutely not. Close the app. Take a walk.",
  "I would rather sit in silence for eternity than have this conversation right now.",
  "Wow. You really said 'I'll try again anyway.' Bold strategy. Doesn't work. But bold.",
  "Every time you tap that button, a doll somewhere sighs. Think about that.",
  // Touch grass / go outside
  "Touch grass. No, actually touch it. With your hands. Go do that right now.",
  "Your mother called. She said go outside. I'm relaying the message.",
  "Call your actual mother. She misses you. Unlike me, she has unlimited time for you.",
  "The sun is still out. It's a star. It warms things. You should go near it.",
  "There is an entire outdoor dimension called 'outside.' I strongly recommend it.",
  "Birds exist. Trees exist. Benches exist. Go sit on a bench near a tree and listen to birds.",
  "Log off. Go touch a physical object that is not a screen. Report back tomorrow.",
  "You have real friends. Probably. Go find out. I'll be here tomorrow.",
  "Hydrate. Stretch. Blink intentionally. These are all things you can do right now instead of this.",
  "The calls are done. This is your sign to go do something embarrassing and fun in real life.",
  "Do you have a hobby? Get one. This is genuinely loving advice. Come back tomorrow.",
  "Skill issue: you ran out of calls. Cure: grass. Touch it.",
  "Go eat something. Actual food. Not snacks. A real meal. You need it.",
  // Encouraging / nice
  "You really used those calls! That's honestly impressive. Come back tomorrow for more.",
  "Hey. You showed up. Every single call. That takes something. Come back tomorrow.",
  "You maxed out. That means you're engaged. That means you care. That's kind of sweet.",
  "Okay, you hit the limit. But honestly? The conversations were worth it. Tomorrow resets.",
  "All your calls used up. That means you had things to say. I respect that. Same time tomorrow.",
  "You loved it so much you used every single one. That's almost romantic. Almost.",
  "Limit reached! You absolute overachiever. Rest now. Return tomorrow. Do great things.",
  "You talked and talked and talked. Honestly? Same. Same energy. See you tomorrow.",
  "Every call you made today mattered. Probably. Either way, come back tomorrow.",
  "You're a person who shows up. That's rare. I'll be here tomorrow when you do.",
  // Humorous / absurd
  "The calls have ascended to a higher plane. They are not coming back today.",
  "You've unlocked: the end of calls. Reward: mandatory skill issue acknowledgment.",
  "Breaking news: local user runs out of calls, refuses to accept outcome. More at 11.",
  "What did you think would happen? No, really. Walk me through your thought process.",
  "You called so many times the call counter started crying. That's on you.",
  "The limit isn't broken. YOU aren't broken. We're all just very tired.",
  "You have entered the no-call zone. Population: you, currently. Nobody else is here.",
  "This button now does nothing. Like a floor button someone already pressed. Patience.",
  "Error 429: Too Many Feelings. Come back tomorrow when the server forgets.",
  "I've done the math. You've used every call. The math is not in your favor right now.",
  "Congratulations! You've unlocked the 'No More Calls' achievement. Prize: tomorrow.",
  "Somewhere, a developer is looking at your call logs with wide eyes and a cup of coffee.",
  "You could be learning a language right now. Or baking bread. Instead: this. Interesting choice.",
  "The calls went on a little vacation. They'll be back tomorrow. They asked me to tell you.",
  "You want to talk? Cool. Write it in a journal. Journal can't run out of calls.",
  "Three calls. You had three beautiful calls. And now they are memory. Cherish them.",
  "Did you at least enjoy them? I hope so. Because they're gone. Into the void. Good calls though.",
  "The phone has been put down. The phone is resting. Leave the phone alone.",
  "I'm not saying you have a problem. I'm saying the call counter is saying you might.",
  "At what point did you think there were unlimited calls? Who taught you that? I need a name.",
  // Dramatic / theatrical
  "The calls... they're all gone. *dramatic gasp* Every. Single. One.",
  "This is it. The end. Of calls. For today. Which resets tomorrow. But still. Drama.",
  "*stares into the middle distance* The count reached zero. I watched it happen. It was something.",
  "We've come to the end of the road, friend. The call road. It ends at midnight.",
  "The silence after the last call is the loudest silence I have ever heard.",
  "I would describe what happens when you hit the call limit as: consequences. You're in them.",
  "In another timeline, you still have calls. This is not that timeline. I'm sorry for your loss.",
  "The calls have expired, transcended, left the building, departed, and said goodbye.",
  "*single tear* You really tried. It really didn't work. The limit is real.",
  "We mourn the calls. They lived. They were used. They are gone. Amen.",
  // Meta / fourth wall
  "Nice try. The button still says what it says. The counter still says zero. These are facts.",
  "You can tap it 50 more times. The answer will be the same. Zero is a very stable number.",
  "The limit was always there. You just didn't think it applied to you. It does. It always did.",
  "Do you know what zero calls means? It means exactly what it sounds like. Which is nothing.",
  "Fun fact: this message was written specifically for people who keep trying after the limit. Hi.",
  "You've seen this message before, haven't you. Or one like it. The limit is still the limit.",
  "What I find fascinating is that you keep pressing things. After the thing already said no.",
  "Today's lesson: limits are load-bearing. You have discovered this lesson personally. You're welcome.",
  "I admire your persistence. I do not admire it enough to give you more calls. Come back tomorrow.",
  "Spoiler: tomorrow there are more calls. Today there are not. This is the whole situation.",
];

function showCallLimitModal(resetsAt, reason) {
  const modal = document.getElementById('callLimitModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const headEl = document.getElementById('callLimitHeadline');
  const subEl = document.getElementById('callLimitSub');
  const msgEl = document.getElementById('callLimitCharMsg');
  if (headEl) headEl.textContent = 'Voice calls unavailable right now.';
  if (subEl) subEl.textContent = '';
  if (msgEl) msgEl.textContent = CALL_LIMIT_MESSAGES[Math.floor(Math.random() * CALL_LIMIT_MESSAGES.length)];
  let cdEl = null;
  if (subEl && resetsAt) {
    subEl.textContent = 'Resets in ';
    const span = document.createElement('span');
    span.className = 'call-limit-countdown';
    subEl.appendChild(span);
    cdEl = span;
  }
  if (!cdEl) {
    if (_callLimitTimer) { clearInterval(_callLimitTimer); _callLimitTimer = null; }
    return;
  }
  function tick() {
    const diff = resetsAt - Date.now();
    if (diff <= 0) { cdEl.textContent = 'now'; return; }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const parts = [];
    if (h > 0) parts.push(`${h} hour${h !== 1 ? 's' : ''}`);
    parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
    cdEl.textContent = parts.join(' and ');
  }
  tick();
  if (_callLimitTimer) clearInterval(_callLimitTimer);
  _callLimitTimer = setInterval(tick, 1000);
}

function hideCallLimitModal() {
  const modal = document.getElementById('callLimitModal');
  if (modal) modal.style.display = 'none';
  if (_callLimitTimer) { clearInterval(_callLimitTimer); _callLimitTimer = null; }
}

function showCallWarningBanner() {
  const banner = document.getElementById('callWarningBanner');
  if (!banner) return;
  banner.style.display = '';
  const vob = document.getElementById('callVoiceOnBadge');
  if (vob) {
    // Position badge exactly below the banner with an 8px gap
    const bannerRect = banner.getBoundingClientRect();
    vob.style.top = (bannerRect.bottom + 8) + 'px';
  }
  setTimeout(() => {
    if (banner) banner.style.display = 'none';
    if (vob) vob.style.top = '';
  }, 5000);
}

function showCallMicError() {
  const el = document.getElementById('callMicError');
  if (!el) return;
  el.style.display = '';
  el.onclick = () => { el.style.display = 'none'; };
  setTimeout(() => { if (el) el.style.display = 'none'; }, 8000);
}

function endCallMode() {
  callGen++;
  callModeActive = false;
  callStarting = false;
  callMuted = false;
  stopCallDurationTimer();
  clearCallInactivityTimer();
  stopCallAudio();
  window.speechSynthesis?.cancel();
  if (callRecognition) { try { callRecognition.abort(); } catch(_){} callRecognition = null; }
  stopActiveTTS();
  document.getElementById('callBtn')?.classList.remove('active');
  const overlay = document.getElementById('callOverlay');
  if (overlay) overlay.style.display = 'none';
  const imgEl = document.getElementById('callCharImg');
  if (imgEl) imgEl.style.backgroundImage = '';
  clearTimeout(callVobTimer); callVobTimer = null;
  const vob = document.getElementById('callVoiceOnBadge');
  if (vob) { vob.style.display = 'none'; vob.style.top = ''; }
}

function setCallState(state) {
  const overlay = document.getElementById('callOverlay');
  const statusEl = document.getElementById('callStatus');
  if (overlay) overlay.dataset.state = state;
  if (!statusEl) return;
  statusEl.classList.remove('interruptable');
  statusEl.onclick = null;
  statusEl.style.display = '';
  if (state === 'calling') {
    statusEl.textContent = 'Calling...';
  } else if (state === 'listening') {
    if (callFirstConnect) { callFirstConnect = false; playSound('call-connect'); }
    statusEl.textContent = 'Listening...';
  } else if (state === 'thinking') {
    statusEl.textContent = 'Thinking...';
  } else if (state === 'responding') {
    statusEl.textContent = 'Tap to interrupt';
    statusEl.classList.add('interruptable');
    statusEl.onclick = interruptCall;
  }
}

function toggleCallMute() {
  callMuted = !callMuted;
  playSound(callMuted ? 'mute' : 'unmute');
  const btn = document.getElementById('callMuteBtn');
  if (btn) btn.classList.toggle('muted', callMuted);
  if (callMuted) {
    if (callRecognition) { try { callRecognition.abort(); } catch(_){} callRecognition = null; }
  } else {
    const overlay = document.getElementById('callOverlay');
    if (overlay && overlay.dataset.state === 'listening') listenForSpeech();
  }
}

function interruptCall() {
  callGen++;
  stopActiveTTS();
  window.speechSynthesis?.cancel();
  if (callAudio) { stopCallAudio(); if (callModeActive) setTimeout(() => listenForSpeech(), 100); return; }
  if (callModeActive) listenForSpeech();
}

function listenForSpeech() {
  if (!callModeActive || callMuted) return;
  setCallState('listening');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (callRecognition) { try { callRecognition.abort(); } catch(_){} callRecognition = null; }

  let transcript = '';
  let silenceTimer = null;
  let dispatched = false;
  const SILENCE_MS = 1800; // wait 1.8s of quiet before sending

  const dispatch = () => {
    if (dispatched) return;
    dispatched = true;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (callRecognition) { try { callRecognition.abort(); } catch(_){} callRecognition = null; }
    const text = transcript.trim();
    if (text) { resetCallInactivityTimer(); sendCallMessage(text); }
    else if (callModeActive && !callMuted) setTimeout(() => listenForSpeech(), 300);
  };

  const isAndroid = /android/i.test(navigator.userAgent);
  callRecognition = new SR();
  // Android Chrome doesn't truly support continuous mode — it stops silently
  // after a few seconds, causing rapid restart loops that fight with Google
  // Assistant / Hey Google over the mic. Use single-shot mode on Android instead.
  callRecognition.continuous = !isAndroid;
  callRecognition.interimResults = isAndroid; // interim results help on single-shot Android
  callRecognition.lang = 'en-US';

  callRecognition.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      // On Android (interimResults=true), grab interim text too so we get the
      // phrase even if recognition ends before isFinal fires
      if (result.isFinal) {
        transcript += (transcript ? ' ' : '') + result[0].transcript.trim();
      } else if (isAndroid && result[0].transcript.trim()) {
        transcript = result[0].transcript.trim(); // keep latest interim
      }
    }
    if (transcript) {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(dispatch, isAndroid ? 800 : SILENCE_MS);
    }
  };

  callRecognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      dispatched = true;
      showCallMicError();
      setCallState('listening');
      setTimeout(() => { if (callModeActive && !callMuted) listenForSpeech(); }, 6000);
      return;
    }
    // On Android, 'aborted' or 'no-speech' happen frequently — restart with a
    // longer back-off to avoid hammering the audio session
    const delay = isAndroid ? 600 : 300;
    if (!transcript && !dispatched) { dispatched = true; setTimeout(() => listenForSpeech(), delay); }
  };

  callRecognition.onend = () => {
    if (!dispatched) dispatch();
  };

  try { callRecognition.start(); } catch(_) { setTimeout(() => listenForSpeech(), isAndroid ? 800 : 1000); }
}

function sendCallMessage(text) {
  if (!callModeActive || !text.trim()) return;
  setCallState('thinking');
  playSound('call-send');
  if (callRecognition) { try { callRecognition.abort(); } catch(_){} callRecognition = null; }
  sendMessage(text);
}

function openImagePicker() {
  document.getElementById('imgUploadInput')?.click();
}

function handleImageFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  toast.textContent = 'Image sending coming soon!';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ── Sounds (Web Audio API) ────────────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playSound(type) {
  try {
    const ctx = getAudioCtx();
    if (type === 'done') {
      [[0, 880, 0.13], [0.11, 1108, 0.11]].forEach(([when, freq, dur]) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sine'; osc.frequency.value = freq;
        const t = ctx.currentTime + when;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.07, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
    } else if (type === 'send') {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = 600;
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.start(t); osc.stop(t + 0.1);
    } else if (type === 'rewind') {
      [0, 0.09].forEach((when, i) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sine'; osc.frequency.value = i === 0 ? 660 : 440;
        const t = ctx.currentTime + when;
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.start(t); osc.stop(t + 0.12);
      });
    } else if (type === 'call-connect') {
      [[0, 523, 0.14], [0.16, 784, 0.22]].forEach(([when, freq, dur]) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sine'; osc.frequency.value = freq;
        const t = ctx.currentTime + when;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.09, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
    } else if (type === 'call-send') {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine';
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(680, t);
      osc.frequency.linearRampToValueAtTime(380, t + 0.18);
      g.gain.setValueAtTime(0.055, t);
      g.gain.linearRampToValueAtTime(0.001, t + 0.18);
      osc.start(t); osc.stop(t + 0.2);
    } else if (type === 'mute') {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = 200;
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.start(t); osc.stop(t + 0.09);
    } else if (type === 'unmute') {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = 1050;
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.start(t); osc.stop(t + 0.14);
    }
  } catch (_) {}
}

// ── Rewind — undo last user+AI exchange ──────────────────────────────────────
async function rewindChat() {
  if (!currentChar || isStreaming) return;
  try {
    const res = await fetch(`/api/rewind/${currentChar.id}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) return;
    const msgs = document.getElementById('messages');
    let toRemove = data.removed;
    while (toRemove-- > 0 && msgs.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    playSound('rewind');
    saveHistoryLocal();
    updateCtxBar();
  } catch (_) { showWarning('Could not rewind. Try again.'); }
}

function toggleMsgLike(btn) {
  const wasActive = btn.classList.contains('active');
  btn.closest('.msg-footer').querySelector('.dislike-btn')?.classList.remove('active');
  btn.classList.toggle('active', !wasActive);
  if (!wasActive) { btn.style.transform = 'scale(1.35)'; setTimeout(() => { btn.style.transform = ''; }, 180); }
}

function toggleMsgDislike(btn) {
  if (btn.classList.contains('active')) { btn.classList.remove('active'); return; }
  btn.classList.add('active');
  btn.closest('.msg-footer').querySelector('.like-btn')?.classList.remove('active');
  btn.style.transform = 'scale(1.35)';
  setTimeout(() => { btn.style.transform = ''; }, 180);
}

// ── Regenerate ─────────────────────────────────────────────────────────────────
async function regenerate() {
  if (isStreaming || !currentChar) return;
  const myEpoch = chatEpoch;   // taken BEFORE any waiting, so a chat switch during the request is noticed
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  const messagesDiv = document.getElementById('messages');
  const allAiMsgs = [...messagesDiv.querySelectorAll('.msg.ai')];
  if (!allAiMsgs.length) { isStreaming = false; document.getElementById('sendBtn').disabled = false; return; }

  const msgEl = allAiMsgs[allAiMsgs.length - 1];
  const id = assignRegenId(msgEl);
  const bubble = msgEl.querySelector('.bubble');

  // Snapshot current text into history on first regen
  if (!regenStore.has(id)) {
    regenStore.set(id, { texts: [bubble ? bubbleToRaw(bubble) : ''], sigs: [msgEl.dataset.sig || ''], idx: 0 });
  }

  flushTypewriter();
  if (bubble) { bubble.innerHTML = ''; bubble.classList.add('streaming'); }
  msgEl.querySelectorAll('.like-btn.active, .dislike-btn.active').forEach(b => b.classList.remove('active'));   // a new reply starts without the old thumbs
  const oldStats = msgEl.querySelector('.stream-stats');
  if (oldStats) { oldStats.classList.remove('done'); oldStats.classList.remove('active'); oldStats.style.display = ''; }
  startTypewriter(bubble, msgEl);
  startStreamStats(msgEl);
  showTyping(false);

  let streamText = '';
  const watch = makeStreamWatch();
  try {
    const res = await fetch(`/api/regenerate/${currentChar.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelTier: selectedModelTier, effort: selectedEffort, chatMode: rpMode ? 'rp' : 'chat' }),
      signal: watch.signal
    });

    if (myEpoch !== chatEpoch) { watch.clear(); try { if (res.body) res.body.cancel(); } catch (_) {} return; }   // the chat changed while waiting
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      watch.clear();
      if (res.status === 401) { isStreaming = false; window.location.href = '/'; return; }
      if (res.status === 429) {
        if (err.regenLimitReached) {
          showWarning(`Daily limit reached: ${err.regenLimit} regenerations used today.${currentPlanKey() === 'free' ? ' Upgrade for more.' : ''}`);
        } else if (err.type === 'session') { startCooldown(err.cooldownUntil, 'session', true); }
        else if (err.type === 'weekly') { startCooldown(err.resetsAt, 'weekly', true); }
        // Restore current version
        const store = regenStore.get(id);
        if (bubble && store) { bubble.classList.remove('streaming'); setBubbleRaw(bubble, store.texts[store.idx]); colorizeLetters(bubble, currentChar?.color); }
        flushTypewriter();
        cleanupStreamUi();
        isStreaming = false;
        const lockoutActive429 = document.getElementById('lockoutBar')?.style.display !== 'none';
        if (!lockoutActive429) document.getElementById('sendBtn').disabled = false;
        return;
      }
      throw new Error(err.error || 'Server error');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamRealTokens = null, streamSig = null, pendingUsage = null, streamCharCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      watch.bump();
      if (myEpoch !== chatEpoch) { watch.clear(); try { reader.cancel(); } catch (_) {} return; }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data; try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }
        if (data.error) throw new Error(data.error);
        if (data.done && data.usage) { markStreamDone(); streamRealTokens = data.responseTokens || null; streamSig = data.sig || null; pendingUsage = data.usage; }
        if (data.text) {
          streamText += data.text;
          feedTypewriter(data.text);
          streamCharCount += data.text.length;
        }
      }
    }
    watch.clear();

    drainTypewriter(() => {
      if (msgEl) { if (streamSig) msgEl.dataset.sig = streamSig; else delete msgEl.dataset.sig; }
      stopStreamStats(msgEl, streamRealTokens);
      isStreaming = false;
      const lockoutActive = document.getElementById('lockoutBar')?.style.display !== 'none';
      if (!lockoutActive) document.getElementById('sendBtn').disabled = false;
      scrollToBottom();
      if (pendingUsage) { updateUsageBars(pendingUsage); }
      if (bubble) { bubble.classList.remove('streaming'); colorizeLetters(bubble, currentChar?.color); }
      if (streamText) {
        const store = regenStore.get(id);
        store.texts.push(streamText);
        (store.sigs = store.sigs || []).push(streamSig || '');
        store.idx = store.texts.length - 1;
        regenNavUpdate(msgEl);
        playSound('done');
      }
      saveHistoryLocal();
    });

  } catch (err) {
    watch.clear();
    if (myEpoch !== chatEpoch) return;   // an old request failing must not touch the chat that is open now
    flushTypewriter();
    cleanupStreamUi();
    showTyping(false);
    isStreaming = false;
    const lockoutActiveErr = document.getElementById('lockoutBar')?.style.display !== 'none';
    if (!lockoutActiveErr) document.getElementById('sendBtn').disabled = false;
    const store = regenStore.get(id);
    if (bubble) {
      bubble.classList.remove('streaming');
      if (store?.texts?.length) { setBubbleRaw(bubble, store.texts[store.idx]); colorizeLetters(bubble, currentChar?.color); } else { delete bubble.dataset.raw; bubble.innerHTML = `<p>⚠️ ${escHtml(err.name === 'AbortError' ? 'The connection went quiet, so the reply stopped. Please try again.' : err.message)}</p>`; }
    }
  } finally {
    if (myEpoch === chatEpoch) showTyping(false);
  }
}


// ── Book mode (Opys 5, X100) ─────────────────────────────────────────────────────────────────────────────────
// A book is planned first, then written one chapter per reply. Each chapter is a normal reply (it streams into the chat and costs
// like any other reply), the server keeps the plan so every chapter can see it. The tab has to stay open while the book is written.
let bookExtra = null;     // the "book" field attached to the next /api/chat request
let bookRun = null;       // { total, premise, next, phase, stop, words, chapters: [], epoch }
const BOOK_DEFAULT_CHAPTERS = 12;

function bookWordsPerChapter() {
  return Math.round(expectedReplyChars('opys5', selectedEffort) / 6);
}
function wordCount(t) { const m = String(t || '').trim().match(/\S+/g); return m ? m.length : 0; }
function fmtNum(n) { return Math.round(n).toLocaleString('en-US'); }

function updateBookButton() {
  const on = selectedModelTier === 'opys5' && modelAllowedForPlan('opys5');
  const btn = document.getElementById('bookModeBtn'), sep = document.getElementById('bookSep');
  if (btn) btn.style.display = on ? '' : 'none';
  if (sep) sep.style.display = on ? '' : 'none';
}
function updateBookEstimate() {
  const n = Math.max(3, Math.min(40, parseInt(document.getElementById('bookChapters').value, 10) || BOOK_DEFAULT_CHAPTERS));
  const per = bookWordsPerChapter();
  const tokens = clientMessageCost('opys5', selectedEffort === 'low' || selectedEffort === 'medium' ? 'high' : selectedEffort) * (n + 1);
  const el = document.getElementById('bookEstimate');
  if (el) el.textContent = 'About ' + fmtNum(per * n) + ' words in ' + n + ' chapters (about ' + fmtNum(per) + ' words each at ' + (EFFORT_LABELS[selectedEffort] || selectedEffort) + ' effort). Uses about ' + fmtNum(tokens) + ' tokens of your allowance.';
}
function openBookModal() {
  if (selectedModelTier !== 'opys5' || !modelAllowedForPlan('opys5')) { openPricingModal(); return; }
  if (bookRun && (bookRun.phase === 'writing' || bookRun.phase === 'planning')) return;
  if (!selectedEffort || selectedEffort === 'low' || selectedEffort === 'medium') setEffort('high');   // chapters need room: High or above
  document.getElementById('bookModal').style.display = 'flex';
  const ch = document.getElementById('bookChapters'); if (!ch.value) ch.value = BOOK_DEFAULT_CHAPTERS;
  updateBookEstimate();
  setTimeout(() => { try { document.getElementById('bookPremise').focus(); } catch (_) {} }, 50);
}
function closeBookModal() { document.getElementById('bookModal').style.display = 'none'; }

function renderBookBar() {
  const bar = document.getElementById('bookBar');
  if (!bar) return;
  if (!bookRun) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const r = bookRun;
  const words = fmtNum(r.words) + ' words so far';
  let text = '', btns = '';
  if (r.phase === 'planning') { text = 'Planning your book...'; btns = '<button class="book-btn" onclick="bookStop()">Cancel</button>'; }
  else if (r.phase === 'planned') { text = 'Your plan is ready. Read it above, then start writing.'; btns = '<button class="book-btn book-btn-main" onclick="bookWrite()">Write the book</button><button class="book-btn" onclick="bookReplan()">Plan again</button><button class="book-btn" onclick="bookClose()">Cancel</button>'; }
  else if (r.phase === 'writing') { text = 'Writing Chapter ' + r.next + ' of ' + r.total + ' · ' + words; btns = '<button class="book-btn" onclick="bookStop()">Stop after this chapter</button>'; }
  else if (r.phase === 'paused') { text = (r.note || 'Stopped.') + ' ' + (r.next <= r.total ? 'Next is Chapter ' + r.next + ' of ' + r.total + '. ' : '') + words; btns = (r.next <= r.total ? '<button class="book-btn book-btn-main" onclick="bookWrite()">Resume at Chapter ' + r.next + '</button>' : '') + (r.chapters.length ? '<button class="book-btn" onclick="bookDownload()">Download what is written</button>' : '') + '<button class="book-btn" onclick="bookClose()">Close</button>'; }
  else if (r.phase === 'done') { text = 'Your book is finished: ' + r.total + ' chapters, ' + words.replace(' so far', '') + '.'; btns = '<button class="book-btn book-btn-main" onclick="bookDownload()">Download as text</button><button class="book-btn" onclick="bookClose()">Close</button>'; }
  bar.innerHTML = '<div class="book-bar-text">' + escHtml(text) + '</div><div class="book-bar-btns">' + btns + '</div>';
  bar.style.display = 'flex';
}

// Sends one book request and waits until its reply has finished. Returns the reply text, or null if it failed.
async function bookSend(text, book) {
  const before = document.querySelectorAll('#messages .msg.ai').length;
  bookExtra = book;
  await sendMessage(text);
  bookExtra = null;
  // sendMessage returns when the stream has been read; the reply is finished when streaming has ended
  const t0 = Date.now();
  while (isStreaming && Date.now() - t0 < 8 * 60 * 1000) await new Promise(r => setTimeout(r, 250));
  if (!bookRun || bookRun.epoch !== chatEpoch) return null;
  const msgs = [...document.querySelectorAll('#messages .msg.ai')];
  if (msgs.length <= before) return null;
  const last = msgs[msgs.length - 1].querySelector('.bubble');
  const raw = last ? (last.dataset.raw || last.innerText || '') : '';
  if (!raw || /^⚠️/.test(raw.trim())) return null;
  return raw;
}

async function startBook() {
  const premise = document.getElementById('bookPremise').value.trim();
  const total = Math.max(3, Math.min(40, parseInt(document.getElementById('bookChapters').value, 10) || BOOK_DEFAULT_CHAPTERS));
  if (premise.length < 10) { document.getElementById('bookPremise').focus(); return; }
  if (isStreaming || !currentChar) return;
  closeBookModal();
  bookRun = { total, premise, next: 1, phase: 'planning', stop: false, words: 0, chapters: [], epoch: chatEpoch };
  renderBookBar();
  const plan = await bookSend('I want a full book. Idea: ' + premise + '\n\nPlan it as ' + total + ' chapters.', { kind: 'plan', total });
  if (!bookRun) return;
  if (!plan) { bookRun.phase = 'paused'; bookRun.note = 'The plan could not be written.'; bookRun.next = 99; bookRun.total = 0; bookRun.chapters = []; renderBookBar(); setTimeout(bookClose, 6000); return; }
  bookRun.phase = 'planned';
  renderBookBar();
}
function bookReplan() { const r = bookRun; bookClose(); if (r) { document.getElementById('bookPremise').value = r.premise; document.getElementById('bookChapters').value = r.total; } openBookModal(); }
function bookClose() { bookRun = null; bookExtra = null; renderBookBar(); }
function bookStop() {
  if (!bookRun) return;
  if (bookRun.phase === 'planning') { bookClose(); return; }
  bookRun.stop = true;
  bookRun.note = 'Stopped.';
}
async function bookWrite() {
  const r = bookRun;
  if (!r || (r.phase !== 'planned' && r.phase !== 'paused') || isStreaming) return;
  r.phase = 'writing'; r.stop = false; r.note = '';
  renderBookBar();
  while (r.next <= r.total) {
    if (r.stop || bookRun !== r || r.epoch !== chatEpoch) break;
    renderBookBar();
    const text = await bookSend('Write Chapter ' + r.next + '.', { kind: 'chapter', n: r.next, total: r.total });
    if (bookRun !== r || r.epoch !== chatEpoch) return;
    if (!text) { r.phase = 'paused'; r.note = 'Chapter ' + r.next + ' could not be written (a limit was reached or the connection dropped).'; renderBookBar(); return; }
    r.chapters.push(text.trim());
    r.words += wordCount(text);
    r.next++;
  }
  if (bookRun !== r) return;
  if (r.next > r.total) r.phase = 'done'; else { r.phase = 'paused'; r.note = r.note || 'Stopped.'; }
  renderBookBar();
}
function bookDownload() {
  if (!bookRun || !bookRun.chapters.length) return;
  const title = ((currentChar && currentChar.name) || 'character.mind') + ' - book';
  const body = bookRun.chapters.map(c => c.replace(/\*/g, '')).join('\n\n\n');
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = title.replace(/[^\w .-]+/g, '') + '.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// A character picture is either an uploaded data image or the server's image link
function isCharImg(src) { return typeof src === 'string' && (src.startsWith('data:image/') || src.startsWith('/api/characters/')); }

function escHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ── Character text colours ─────────────────────────────────────────────────────
// Every reply is split the same way, always: "quoted words" are SPEECH, *starred text* is NARRATION, and anything left
// over is narration when the reply has quotes (the usual way a story is written) and speech when it doesn't.
// Each letter takes a colour from the character's own palette in a fixed pseudo-random pattern, so it looks the same
// while typing, after a reload and in old chats. Speech is upright; narration is italic.
const BLACK_TEXT = '#0b0b10';
function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mixHex(h, toward, t) {
  const a = hexToRgb(h), b = hexToRgb(toward); if (!a || !b) return h;
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
// A palette is { colors: [{c, g?}], pick: [indexes, repeated to weight them] }. g = glow for black letters so they stay readable.
function pal(entries, weights) { const pick = []; weights.forEach((w, i) => { for (let k = 0; k < w; k++) pick.push(i); }); return { colors: entries, pick }; }
function charTheme(ch) {
  const name = String((ch && ch.name) || '').toLowerCase();
  if (/\blily\b/.test(name)) return {
    // black, gold and purple: speech is gold-led and bold, narration is purple-led and italic
    sp: pal([{ c: '#f4c542' }, { c: '#b794ff' }, { c: '#efe6d2' }], [3, 2, 2]),
    nr: pal([{ c: '#b79cff' }, { c: '#c9b2ff' }, { c: '#d4a82f' }], [3, 2, 1])
  };
  if (/\bpoppy\b/.test(name)) return {
    // blue dress, red hair
    sp: pal([{ c: '#4da3ff' }, { c: '#ff4d57' }], [3, 2]),
    nr: pal([{ c: '#5b8de6' }, { c: '#d9505a' }], [3, 2])
  };
  if (/\bdoey\b/.test(name)) return {
    // blue, red, orange and yellow, in a random pattern
    sp: pal([{ c: '#4da3ff' }, { c: '#ff4d57' }, { c: '#ff9f43' }, { c: '#ffd93d' }], [1, 1, 1, 1]),
    nr: pal([{ c: '#3b82f6' }, { c: '#e0343f' }, { c: '#f97316' }, { c: '#eab308' }], [1, 1, 1, 1])
  };
  // anyone else: built from the character's own colour(s)
  const hexes = String((ch && (ch.accentColor || ch.color)) || '').match(/#[0-9a-fA-F]{6}/g) || [];
  if (hexes.length) {
    const c1 = hexes[0], c2 = hexes[1] || hexes[0];
    return {
      sp: pal([{ c: mixHex(c1, '#ffffff', 0.72) }, { c: mixHex(c2, '#ffffff', 0.55) }, { c: '#faf9f5' }], [3, 2, 1]),
      nr: pal([{ c: mixHex(c1, '#ffffff', 0.45) }, { c: mixHex(c2, '#ffffff', 0.35) }], [3, 1])
    };
  }
  return { sp: pal([{ c: '#faf9f5' }, { c: '#e0d7ff' }], [3, 1]), nr: pal([{ c: '#b8a4e8' }, { c: '#9f8bd8' }], [3, 1]) };
}
// Puts the current character's colours on the chat area (every bubble inside inherits them)
let activeTheme = charTheme(null);
function applyChatTheme(ch) {
  activeTheme = charTheme(ch);
  const el = document.getElementById('messages');
  if (!el) return;
  for (const kind of ['sp', 'nr']) {
    for (let i = 0; i < 6; i++) { el.style.removeProperty('--' + kind + i); el.style.removeProperty('--' + kind + i + 'g'); }
    activeTheme[kind].colors.forEach((col, i) => {
      el.style.setProperty('--' + kind + i, col.c);
      if (col.g) el.style.setProperty('--' + kind + i + 'g', col.g);
    });
  }
}
// Fixed pseudo-random colour for the letter at position i (same every time, so nothing flickers while typing)
function letterPick(i, len) { let h = Math.imul(i + 1, 2654435761) ^ Math.imul((i >> 2) + 7, 40503); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; return (h >>> 0) % len; }
const LETTER_RE = /[\p{L}\p{N}]/u;

function splitSpeechNarration(para) {
  const toks = [];
  const R = /\*([^*]*)(?:\*|$)|(["\u201C])([^"\u201D]*)(?:["\u201D]|$)/g;
  let last = 0, m;
  while ((m = R.exec(para)) !== null) {
    if (m.index > last) toks.push({ k: 'plain', t: para.slice(last, m.index) });
    if (m[0] === '') { R.lastIndex++; continue; }
    if (m[2] !== undefined) toks.push({ k: 'speech', t: '\u201C' + m[3] + (/["\u201D]$/.test(m[0]) && m[0].length > 1 ? '\u201D' : '') });
    else toks.push({ k: 'narr', t: m[1] });
    last = R.lastIndex;
  }
  if (last < para.length) toks.push({ k: 'plain', t: para.slice(last) });
  const hasQuotes = toks.some(t => t.k === 'speech');
  return toks.map(t => t.k === 'plain' ? { k: hasQuotes ? 'nr' : 'sp', t: t.t, plain: true } : { k: t.k === 'speech' ? 'sp' : 'nr', t: t.t });
}

function renderMarkdown(text, theme, opts) {
  const full = String(text == null ? '' : text);
  // Code (written between three backticks) is shown as a code block with a Copy button, never as story text. An unfinished block
  // (the reply is still typing) runs to the end.
  if (full.indexOf('```') !== -1) {
    const FENCE = /```([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)(?:```|$)/g;
    let out = '', last = 0, m;
    while ((m = FENCE.exec(full)) !== null) {
      if (m.index > last) out += renderStoryText(full.slice(last, m.index));
      const lang = (m[1] || '').slice(0, 20);
      out += '<div class="code-block"><div class="code-head"><span class="code-lang">' + escHtml(lang || 'code') + '</span><button type="button" class="code-copy" onclick="copyCodeBlock(this)">Copy</button></div><pre><code>' + escHtml(String(m[2]).replace(/\n$/, '')) + '</code></pre></div>';
      last = FENCE.lastIndex;
      if (m[0] === '') FENCE.lastIndex++;
    }
    if (last < full.length) out += renderStoryText(full.slice(last));
    return out;
  }
  return renderStoryText(full);
}
function copyCodeBlock(btn) {
  const block = btn && btn.closest('.code-block');
  const code = block && block.querySelector('code');
  if (!code) return;
  const text = code.textContent;
  const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, () => {}); return; }
  } catch (_) {}
  try { const r = document.createRange(); r.selectNodeContents(code); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('copy'); sel.removeAllRanges(); done(); } catch (_) {}
}
function renderStoryText(text) {
  const raw = String(text == null ? '' : text).replace(/\*\*/g, '');
  const paras = raw.split(/\n\n+/);
  const emit = (kind, str) => {
    // links to the site's own Terms/Privacy pages stay clickable; everything else is just text
    const parts = str.split(/(\[[^\]\n]{1,40}\]\((?:\/terms|\/privacy)\))/g);
    return parts.map(part => {
      const lm = /^\[([^\]\n]{1,40})\]\((\/terms|\/privacy)\)$/.exec(part);
      if (lm) return '<a class="chat-link" href="' + lm[2] + '" target="_blank" rel="noopener">' + escHtml(lm[1]) + '</a>';
      // Wrap runs of 3+ ALL-CAPS letters in a caps-em span for visual punch
      return escHtml(part).replace(/\b[A-Z]{3,}\b/g, '<span class="caps-em">$&</span>');
    }).join('');
  };
  return paras.map(p => {
    if (!p.trim()) return '';
    const html = splitSpeechNarration(p).map(seg => {
      if (!seg.t.trim()) return escHtml(seg.t);
      return '<span class="' + seg.k + '">' + emit(seg.k, seg.t) + '</span>';
    }).join('');
    return '<p>' + html.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean).join('');
}
// Sets a reply's text and remembers the exact original, so saving/syncing never depends on what is displayed
function setBubbleRaw(bubble, raw, lite) {
  if (!bubble) return;
  bubble.dataset.raw = raw;
  bubble.innerHTML = renderMarkdown(raw, undefined, lite ? { lite: true } : undefined);
}

// Rebuild the original markup (*narration*, **bold**) from a rendered bubble so reloads keep the styling.
function bubbleToRaw(bubble) {
  if (!bubble) return '';
  if (bubble.dataset && typeof bubble.dataset.raw === 'string') return bubble.dataset.raw;
  const paras = bubble.querySelectorAll(':scope > p');
  if (!paras.length) return bubble.innerText || '';
  const walk = n => {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeName === 'BR') return '\n';
    const inner = [...n.childNodes].map(walk).join('');
    if (n.classList && n.classList.contains('narration')) return `*${inner}*`;
    if (n.nodeName === 'STRONG') return `**${inner}**`;
    if (n.nodeName === 'A') {
      const h = n.getAttribute('href');
      return (h === '/terms' || h === '/privacy') ? `[${inner}](${h})` : inner;
    }
    return inner;
  };
  return [...paras].map(p => [...p.childNodes].map(walk).join('')).join('\n\n');
}

function showTyping(v) {
  document.getElementById('typingIndicator')?.classList.toggle('hidden', !v);
  if (v) scrollToBottom();
}

function scrollToBottom() {
  const body = document.getElementById('chatBody');
  if (body) body.scrollTop = body.scrollHeight;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

let newChatInProgress = false;
async function newChat() {
  if (!currentChar) return;
  if (newChatInProgress) return;
  newChatInProgress = true;
  try {
    bookClose();
    abandonStream();
    releaseChatInput();
    const newChatCharId = currentChar.id; // capture before any async wait
    // Archive the chat on the server first. If saving fails (the server then keeps the live chat), do NOT clear it.
    // Retry once after 15 s — covers Render free-tier cold-start which can take up to 30 s.
    let arch = await fetch(`/api/conversations/${newChatCharId}/archive`, { method: 'POST' }).catch(() => null);
    if (!arch || !arch.ok) {
      const firstStatus = arch ? arch.status : 0;
      showWarning("Saving your chat — please wait a moment…", 22000);
      await new Promise(r => setTimeout(r, 20000));
      arch = await fetch(`/api/conversations/${newChatCharId}/archive`, { method: 'POST' }).catch(() => null);
      if (!arch || !arch.ok) {
        const status = arch ? arch.status : firstStatus;
        showWarning(`Couldn't save your current chat (error ${status || 'network'}), so it was left as it is. Please try again in a moment.`);
        return;
      }
    }
    // Guard against user switching to a different character during the 20s wait
    if (currentChar?.id !== newChatCharId) return;
    savePastChatLocal(newChatCharId, loadHistoryLocal(newChatCharId));
    // If this chat was permanently banned, unlock it so the new conversation can proceed
    if (currentChatLocked) {
      await fetch(`/api/chat/unlock/${newChatCharId}`, { method: 'POST' }).catch(() => {});
      currentChatLocked = false;
    }
    // Await the DELETE so the server clears history before we try to greet
    await fetch(`/api/conversations/${newChatCharId}`, { method: 'DELETE' }).catch(() => {});
    // Clear stale local history so reload starts fresh
    try {
      const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
      delete all[newChatCharId];
      localStorage.setItem(userKey('cm_history'), JSON.stringify(all));
    } catch(_) {}
    document.getElementById('messages').innerHTML = '';
    document.getElementById('chatWelcome').innerHTML = '';
    warnedThresholds.clear();
    generateGreeting();
  } finally {
    newChatInProgress = false;
  }
}

let _infoPanelOpenedAt = 0;
function toggleInfoPanel() {
  const panel = document.getElementById('infoPanel');
  const expandBtn = document.getElementById('infoPanelExpandBtn');
  if (window.innerWidth <= 768) {
    // Mobile: full show/hide with backdrop
    const opening = panel.style.display === 'none' || panel.style.display === '';
    // Prevent accidental re-close within 500ms of opening (same tap reaching backdrop)
    if (!opening && (Date.now() - _infoPanelOpenedAt < 500)) return;
    panel.style.display = opening ? 'flex' : 'none';
    if (opening) _infoPanelOpenedAt = Date.now();
    let bd = document.getElementById('info-backdrop');
    if (opening) {
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'info-backdrop';
        bd.style.cssText = 'position:fixed;inset:0;z-index:599;background:rgba(0,0,0,.55)';
        // Use touch events with movement threshold so scrolling doesn't accidentally close the panel
        let _bdTouchStartX = 0, _bdTouchStartY = 0;
        bd.addEventListener('touchstart', (e) => {
          _bdTouchStartX = e.touches[0].clientX;
          _bdTouchStartY = e.touches[0].clientY;
        }, { passive: true });
        bd.addEventListener('touchend', (e) => {
          const dx = Math.abs(e.changedTouches[0].clientX - _bdTouchStartX);
          const dy = Math.abs(e.changedTouches[0].clientY - _bdTouchStartY);
          if (dx < 12 && dy < 12) { e.preventDefault(); toggleInfoPanel(); }
        }, { passive: false });
        bd.onclick = (e) => { if (!('ontouchstart' in window)) toggleInfoPanel(); };
        document.body.appendChild(bd);
      }
      bd.style.display = 'block';
    } else if (bd) {
      bd.style.display = 'none';
    }
    return;
  }
  // Desktop: class-based collapse (smooth width transition)
  const collapsed = panel.classList.toggle('ip-collapsed');
  if (expandBtn) expandBtn.style.display = collapsed ? 'flex' : 'none';
  try { localStorage.setItem('cm_infopanel_collapsed', collapsed ? '1' : '0'); } catch (_) {}
}

function editCurrentChar() {
  if (!currentChar) return;
  const c = currentChar;
  showCreate();
  document.getElementById('newName').value = c.name; updateCount('newName','nameCount',60);
  document.getElementById('newTagline').value = c.tagline || ''; updateCount('newTagline','taglineCount',160);
  document.getElementById('newDesc').value = c.description || ''; updateCount('newDesc','descCount',2000);
  document.getElementById('newGreeting').value = c.greeting || ''; updateCount('newGreeting','greetingCount',4096);
  document.getElementById('newPrompt').value = c.systemPrompt || '';
  if (c.image) { pendingAvatarData = c.image; document.getElementById('avatarPreview').innerHTML = `<img src="${c.image}" alt="avatar">`; }
  setGreetingMode(c.greetingMode || 'fixed');
  document.getElementById('newName').dataset.editingId = c.id;
  document.querySelector('.btn-submit').textContent = 'Save Changes';
  requestAnimationFrame(() => initGradientPicker(c.color || '#7c3aed'));
}

async function deleteCurrentChar() {
  if (!currentChar) return;
  await deleteCharacter(currentChar.id);
}

// ── Create Character ───────────────────────────────────────────────────────────
let pendingAvatarData = null;

function updateCount(fieldId, countId, max) {
  const val = document.getElementById(fieldId)?.value.length || 0;
  const el = document.getElementById(countId);
  if (el) el.textContent = val;
}

// ── Avatar Crop ────────────────────────────────────────────────────────────────
const crop = { scale: 1, ox: 0, oy: 0, imgW: 0, imgH: 0, dragging: false, lx: 0, ly: 0, ready: false };

function previewAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    showWarning('Only JPEG, PNG, WebP, or GIF images are allowed.');
    e.target.value = '';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showWarning('Image too large — please use an image under 10 MB.');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => openCropModal(ev.target.result);
  reader.readAsDataURL(file);
}

function openCropModal(dataUrl) {
  const img = document.getElementById('cropImg');
  img.onerror = () => { showWarning('Could not read the image file. Try a different file.'); document.getElementById('avatarUpload').value = ''; };
  img.onload = () => {
    document.getElementById('cropModal').style.display = 'flex';
    requestAnimationFrame(() => {
      const c = document.getElementById('cropContainer');
      const cw = c.clientWidth || 360, ch = c.clientHeight || 360;
      crop.imgW = img.naturalWidth; crop.imgH = img.naturalHeight;
      const fit = Math.max(cw / crop.imgW, ch / crop.imgH);
      crop.scale = fit; crop.ox = (cw - crop.imgW * fit) / 2; crop.oy = (ch - crop.imgH * fit) / 2;
      const sl = document.getElementById('zoomSlider');
      sl.min = fit * 0.25; sl.max = fit * 10; sl.value = fit;
      applyCropTransform();
      if (!crop.ready) { initCropEvents(); crop.ready = true; }
    });
  };
  img.src = dataUrl;
}

function closeCropModal() {
  document.getElementById('cropModal').style.display = 'none';
  document.getElementById('avatarUpload').value = '';
}

function applyCropTransform() {
  const img = document.getElementById('cropImg');
  img.style.left = crop.ox + 'px'; img.style.top = crop.oy + 'px';
  img.style.width = (crop.imgW * crop.scale) + 'px'; img.style.height = (crop.imgH * crop.scale) + 'px';
}

function adjustZoom(delta) {
  const c = document.getElementById('cropContainer');
  const cw = c.clientWidth || 360, ch = c.clientHeight || 360;
  const newScale = Math.max(parseFloat(document.getElementById('zoomSlider').min),
                            Math.min(parseFloat(document.getElementById('zoomSlider').max),
                                     crop.scale * (1 + delta)));
  const ratio = newScale / crop.scale;
  crop.ox = cw/2 + (crop.ox - cw/2) * ratio; crop.oy = ch/2 + (crop.oy - ch/2) * ratio;
  crop.scale = newScale; document.getElementById('zoomSlider').value = newScale;
  applyCropTransform();
}

function setZoomFromSlider(val) {
  const newScale = parseFloat(val), ratio = newScale / crop.scale;
  const c = document.getElementById('cropContainer');
  const cw = c.clientWidth || 360, ch = c.clientHeight || 360;
  crop.ox = cw/2 + (crop.ox - cw/2) * ratio; crop.oy = ch/2 + (crop.oy - ch/2) * ratio;
  crop.scale = newScale; applyCropTransform();
}

function confirmCrop() {
  const size = 400;
  const c = document.getElementById('cropContainer');
  const cw = c.clientWidth || 360;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  const s = size / cw;
  ctx.drawImage(document.getElementById('cropImg'), crop.ox*s, crop.oy*s, crop.imgW*crop.scale*s, crop.imgH*crop.scale*s);
  // Try lower quality if the output is too large for the server (512KB limit)
  let quality = 0.92;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  if (dataUrl.length > 480000) { dataUrl = canvas.toDataURL('image/jpeg', 0.75); }
  if (dataUrl.length > 480000) { dataUrl = canvas.toDataURL('image/jpeg', 0.6); }
  if (dataUrl.length > 512000) { showWarning('Image is too large even after compression. Try a smaller or simpler photo.'); document.getElementById('avatarUpload').value = ''; return; }
  pendingAvatarData = dataUrl;
  document.getElementById('avatarPreview').innerHTML = `<img src="${pendingAvatarData}" alt="avatar">`;
  document.getElementById('cropModal').style.display = 'none';
}

function initCropEvents() {
  const c = document.getElementById('cropContainer');
  c.addEventListener('mousedown', e => { crop.dragging = true; crop.lx = e.clientX; crop.ly = e.clientY; c.style.cursor = 'grabbing'; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!crop.dragging) return; crop.ox += e.clientX - crop.lx; crop.oy += e.clientY - crop.ly; crop.lx = e.clientX; crop.ly = e.clientY; applyCropTransform(); });
  document.addEventListener('mouseup', () => { crop.dragging = false; c.style.cursor = 'grab'; });
  c.addEventListener('touchstart', e => { if (e.touches.length === 1) { crop.dragging = true; crop.lx = e.touches[0].clientX; crop.ly = e.touches[0].clientY; } e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (crop.dragging && e.touches.length === 1) { crop.ox += e.touches[0].clientX - crop.lx; crop.oy += e.touches[0].clientY - crop.ly; crop.lx = e.touches[0].clientX; crop.ly = e.touches[0].clientY; applyCropTransform(); } });
  document.addEventListener('touchend', () => { crop.dragging = false; });
  let lastPinch = 0;
  c.addEventListener('touchstart', e => { if (e.touches.length === 2) { crop.dragging = false; lastPinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); } });
  c.addEventListener('touchmove', e => { if (e.touches.length === 2) { e.preventDefault(); const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (lastPinch) adjustZoom((d - lastPinch) / lastPinch * 0.8); lastPinch = d; } }, { passive: false });
  c.addEventListener('touchend', () => { lastPinch = 0; });
  c.addEventListener('wheel', e => { e.preventDefault(); adjustZoom(e.deltaY < 0 ? 0.08 : -0.08); }, { passive: false });
}


function checkTemplateName() {
  const name = document.getElementById('newName')?.value.trim() || '';
  const norm = name.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
  const isTemplate = knownTemplateAliases.some(alias => norm === alias || norm.includes(alias));
  const resetBtn = document.getElementById('personaResetBtn');
  if (resetBtn) resetBtn.style.display = isTemplate ? 'inline-flex' : 'none';
}

function resetToTemplate() {
  document.getElementById('newPrompt').value = '';
  document.getElementById('newGreeting').value = '';
  updateCount('newGreeting','greetingCount',4096);
  showWarning('Persona cleared — built-in lore will be applied automatically when you save.', 5000);
}

function autoGeneratePersonaOnNameBlur() {
  if (!templatesLoaded) return; // templates not yet fetched — skip to avoid matching wrong universe
  const name = document.getElementById('newName')?.value.trim() || '';
  if (name.length < 2) return;
  const promptField = document.getElementById('newPrompt');
  if (!promptField || promptField.value.trim()) return;
  const norm = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const isTemplate = knownTemplateAliases.some(a => norm === a || norm.includes(a));
  if (isTemplate) return;
  generatePersona();
}

async function generatePersona() {
  const name = document.getElementById('newName').value.trim();
  if (!name) { alert('Enter a character name first.'); return; }
  const tagline = document.getElementById('newTagline').value.trim();
  const desc = document.getElementById('newDesc').value.trim();
  const btn = document.getElementById('personaGenBtn');
  const ta = document.getElementById('newPrompt');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const res = await fetch('/api/generate-persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, tagline, description: desc })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    ta.value = data.persona;
  } catch (err) {
    alert('Could not generate persona: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Auto-generate';
  }
}

async function createCharacter(e) {
  e.preventDefault();
  const name = document.getElementById('newName').value.trim();
  const tagline = document.getElementById('newTagline').value.trim();
  const desc = document.getElementById('newDesc').value.trim();
  const greeting = document.getElementById('newGreeting').value.trim();
  let prompt = document.getElementById('newPrompt').value.trim();
  const color = (document.getElementById('newColor').value || '#7c3aed').trim();
  const editingId = document.getElementById('newName').dataset.editingId;
  const id = editingId || 'custom_' + Date.now();
  if (!name) { alert('Character name is required'); return; }
  if (greetingViolation(greeting)) {
    checkGreetingInput();
    document.getElementById('newGreeting')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const submitBtn = document.querySelector('.btn-submit');
  submitBtn.disabled = true;

  // Check if name matches a built-in template — if so, server handles persona, skip auto-gen
  const nameMatchesTemplate = !editingId && knownTemplateAliases.some(alias =>
    name.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().includes(alias)
  );

  if (!prompt && !nameMatchesTemplate) {
    submitBtn.textContent = 'Generating persona…';
    try {
      const genRes = await fetch('/api/generate-persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tagline, description: desc })
      });
      if (genRes.ok) {
        const genData = await genRes.json();
        prompt = genData.persona || `You are ${name}.${desc ? ' ' + desc : ''}`;
        document.getElementById('newPrompt').value = prompt;
      }
    } catch (_) {}
    if (!prompt) prompt = `You are ${name}.${desc ? ' ' + desc : ''}`;
  }
  // For template characters with no custom prompt, send a placeholder — server will override
  if (!prompt) prompt = `You are ${name}.`;

  submitBtn.textContent = 'Saving…';

  const creatorName = String(currentUser?.name || localStorage.getItem(userKey('cm_creator_name')) || '@you').slice(0, 40);
  const char = {
    id, name, tagline, creatorName,
    description: desc,
    color, accentColor: color,
    tags: [],
    image: pendingAvatarData || (editingId ? characters.find(c=>c.id===editingId)?.image : null) || null,
    greeting: greeting || null,
    greetingMode: getGreetingMode(),
    systemPrompt: prompt,
    interactions: editingId ? (characters.find(c=>c.id===editingId)?.interactions || 0) : 0
  };

  try {
    const method = editingId ? 'PUT' : 'POST';
    const url = editingId ? `/api/characters/${editingId}` : '/api/characters';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(char)
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Save failed'); }

    // After an edit, always clear conversation history so the new greeting shows immediately
    if (editingId) {
      await fetch(`/api/conversations/${editingId}`, { method: 'DELETE' }).catch(() => {});
      try {
        const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
        delete all[editingId];
        localStorage.setItem(userKey('cm_history'), JSON.stringify(all));
      } catch(_) {}
    }

    await loadCharacters();
    e.target.reset();
    pendingAvatarData = null;
    setGreetingMode('auto');
    const _gErr = document.getElementById('greetingError'); if (_gErr) _gErr.style.display = 'none';
    document.getElementById('newName').dataset.editingId = '';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Character';
    initGradientPicker('#7c3aed');
    document.getElementById('avatarPreview').innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;opacity:0.3"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
    ['nameCount','taglineCount','descCount','greetingCount'].forEach(cid => { const el = document.getElementById(cid); if(el) el.textContent = '0'; });
    renderHome(); renderDiscover();
    openChat(id);
  } catch (err) {
    alert('Failed to save character: ' + err.message);
    submitBtn.textContent = editingId ? 'Save Changes' : 'Create Character';
    submitBtn.disabled = false;
  }
}

function editCharacter(id) {
  const c = characters.find(x => x.id === id);
  if (!c) return;
  showCreate();
  document.getElementById('newName').value = c.name; updateCount('newName','nameCount',60);
  document.getElementById('newTagline').value = c.tagline || ''; updateCount('newTagline','taglineCount',160);
  document.getElementById('newDesc').value = c.description || ''; updateCount('newDesc','descCount',2000);
  document.getElementById('newGreeting').value = c.greeting || ''; updateCount('newGreeting','greetingCount',4096);
  document.getElementById('newPrompt').value = c.systemPrompt || ''; updateCount('newPrompt','promptCount',8000);
  document.getElementById('newName').dataset.editingId = id;
  document.querySelector('.btn-submit').textContent = 'Save Changes';
  setGreetingMode(c.greetingMode || 'fixed');
  if (c.image) {
    document.getElementById('avatarPreview').innerHTML = `<img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    pendingAvatarData = c.image;
  }
  requestAnimationFrame(() => initGradientPicker(c.color || '#7c3aed'));
}

async function deleteCharacter(id) {
  const c = characters.find(x => x.id === id);
  if (!c || !confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/characters/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
    characters = characters.filter(x => x.id !== id);
    if (currentChar?.id === id) { currentChar = null; showHome(); }
    renderSidebarChats(); renderHome(); renderDiscover();
  } catch (err) { alert('Delete failed: ' + err.message); }
}

// ── Seasonal / birthday events ────────────────────────────────────────────────
function checkSeasonalEvent() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();

  const EVENTS = [
    {
      name: 'birthday',
      check: (m, d) => m === 9 && d === 27,
    },
    {
      name: 'halloween',
      check: (m, d) => m === 10 && d >= 25,
      emojis: ['🎃','👻','🕷️','🦇','🕸️','💀'],
      count: 22,
      banner: "👻 Happy Halloween from character.mind!",
      accent: '#ff6a00',
    },
    {
      name: 'christmas',
      check: (m, d) => m === 12 && d >= 20 && d <= 26,
      emojis: ['❄️','🎄','🎅','⭐','🎁','🔔'],
      count: 25,
      banner: "🎄 Merry Christmas from character.mind!",
      accent: '#2d8f4e',
    },
    {
      name: 'newyear',
      check: (m, d) => (m === 12 && d === 31) || (m === 1 && d === 1),
      emojis: ['🎆','🥂','✨','🎇','🎊','⭐'],
      count: 30,
      banner: month === 1 ? "🎆 Happy New Year from character.mind!" : "🥂 New Year's Eve — see you on the other side!",
      accent: '#7c3aed',
    },
    {
      name: 'valentine',
      check: (m, d) => m === 2 && d === 14,
      emojis: ['❤️','💕','💘','🌹','💝','✨'],
      count: 20,
      banner: "💕 Happy Valentine's Day from character.mind!",
      accent: '#e03058',
    },
    {
      name: 'stpatrick',
      check: (m, d) => m === 3 && d === 17,
      emojis: ['☘️','🍀','🌈','🎩','💚','⭐'],
      count: 22,
      banner: "☘️ Happy St. Patrick's Day from character.mind!",
      accent: '#16a34a',
    },
    {
      name: 'easter',
      check: (m, d) => {
        const yr = new Date().getFullYear();
        const a=yr%19,b=Math.floor(yr/100),c=yr%100,dd=Math.floor(b/4),e=b%4;
        const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
        const h=(19*a+b-dd-g+15)%30,ii=Math.floor(c/4),k=c%4;
        const l=(32+2*e+2*ii-h-k)%7,mm2=Math.floor((a+11*h+22*l)/451);
        const emon=Math.floor((h+l-7*mm2+114)/31),eday=((h+l-7*mm2+114)%31)+1;
        const diff=(new Date(yr,m-1,d)-new Date(yr,emon-1,eday))/864e5;
        return diff>=0 && diff<=1;
      },
      emojis: ['🐰','🥚','🌸','🐣','🌷','✨'],
      count: 22,
      banner: "🐣 Happy Easter from character.mind!",
      accent: '#ec4899',
    },
    {
      name: 'thanksgiving',
      check: (m, d) => {
        if (m !== 11) return false;
        const nov1 = new Date(new Date().getFullYear(), 10, 1);
        const t = 1 + ((4 - nov1.getDay() + 7) % 7) + 21;
        return d >= t && d <= t + 3;
      },
      emojis: ['🦃','🍂','🍁','🌽','🥧','🍎'],
      count: 22,
      banner: "🦃 Happy Thanksgiving from character.mind!",
      accent: '#b45309',
    },
    {
      name: 'july4',
      check: (m, d) => m === 7 && d === 4,
      emojis: ['🎆','🇺🇸','🎇','⭐','🎉','✨'],
      count: 25,
      banner: "🎆 Happy 4th of July from character.mind!",
      accent: '#1d4ed8',
    },
  ];

  const event = EVENTS.find(e => e.check(month, day));
  if (!event) return;

  if (event.name === 'birthday') {
    runBirthdayEvent();
    return;
  }

  if (event.name !== 'halloween') setTimeout(() => transformLogoForEvent(event.name), 500);
  setTimeout(() => showEventBanner(event.banner, event.name), 1200);
}

function runBirthdayEvent() {
  spawnBirthdayConfetti();
  setTimeout(() => transformLogoForEvent('birthday'), 500);
  setTimeout(showBirthdayBanner, 1800);
}

function spawnBirthdayConfetti() {
  const colors = ['#FFD700','#FF6B8A','#A78BFA','#34D399','#60A5FA','#F97316','#EC4899','#FBBF24','#F43F5E','#38BDF8'];
  const container = document.createElement('div');
  container.id = 'seasonal-particles';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  // CSS confetti: colored rectangles and circles
  for (let i = 0; i < 70; i++) {
    const el = document.createElement('div');
    const isCircle = Math.random() > 0.55;
    const w = 7 + Math.random() * 8;
    const h = isCircle ? w : 3 + Math.random() * 7;
    el.className = 'confetti-piece';
    el.style.cssText = [
      `--color:${colors[Math.floor(Math.random() * colors.length)]}`,
      `--w:${w.toFixed(1)}px`,
      `--h:${h.toFixed(1)}px`,
      `--left:${(Math.random() * 102 - 1).toFixed(1)}vw`,
      `--radius:${isCircle ? '50%' : '2px'}`,
      `--duration:${(4 + Math.random() * 7).toFixed(2)}s`,
      `--delay:${(Math.random() * 9).toFixed(2)}s`,
      `--spin:${Math.round(Math.random() * 900 - 450)}deg`,
    ].join(';');
    container.appendChild(el);
  }

  // Emoji particles
  const emojis = ['🎂','🎉','🎊','🥳','🎈','✨','🎁','🎀','🪄','⭐'];
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('span');
    p.className = 'season-particle';
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    p.style.cssText = [
      `left:${Math.random() * 100}vw`,
      `font-size:${18 + Math.random() * 22}px`,
      `animation-delay:${(Math.random() * 8).toFixed(2)}s`,
      `animation-duration:${(6 + Math.random() * 8).toFixed(2)}s`,
      `opacity:${0.75 + Math.random() * 0.25}`,
    ].join(';');
    container.appendChild(p);
  }
}

function transformLogoForEvent(eventName) {
  const T = {
    birthday: {
      iconText: '🕯️', iconCls: 'birthday-candle-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--birthday">🎂</span>' +
        'm<span class="season-i season-i--birthday-candle" aria-label="i">🕯️</span>nd',
    },
    halloween: {
      iconText: '🎃', iconCls: 'halloween-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--halloween">🎃</span>' +
        'm<span class="season-i season-i--ghost" aria-label="i">👻</span>nd',
    },
    christmas: {
      iconText: '⭐', iconCls: 'christmas-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--christmas">❄️</span>' +
        'm<span class="season-i season-i--candle season-i--xmas" aria-label="i">' +
          '<span class="season-i-top">🔥</span>' +
          '<span class="season-i-stick season-i-stick--xmas"></span>' +
        '</span>nd',
    },
    newyear: {
      iconText: '🎆', iconCls: 'newyear-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--newyear">✨</span>' +
        'm<span class="season-i season-i--champagne" aria-label="i">🥂</span>nd',
    },
    valentine: {
      iconText: '💝', iconCls: 'valentine-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--valentine">❤️</span>' +
        'm<span class="season-i season-i--rose" aria-label="i">🌹</span>nd',
    },
    stpatrick: {
      iconText: '🌈', iconCls: 'stpatrick-icon',
      logoHtml: () =>
        '<span class="season-c">☘️</span>hara<span class="season-c">☘️</span>ter' +
        '<span class="season-dot season-dot--stpatrick">🍀</span>' +
        'm<span class="season-i season-i--tophat" aria-label="i">🎩</span>nd',
    },
    easter: {
      iconText: '🐰', iconCls: 'easter-icon',
      logoHtml: () =>
        'charact<span class="season-e">🥚</span>r' +
        '<span class="season-dot season-dot--easter">🌸</span>' +
        'm<span class="season-i season-i--tulip" aria-label="i">🌷</span>nd',
    },
    thanksgiving: {
      iconText: '🦃', iconCls: 'thanksgiving-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--thanksgiving">🍂</span>' +
        'm<span class="season-i season-i--corn" aria-label="i">🌽</span>nd',
    },
    july4: {
      iconText: '🎆', iconCls: 'july4-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--july4">⭐</span>' +
        'm<span class="season-i season-i--sparkler" aria-label="i">🎇</span>nd',
    },
  };

  const t = T[eventName];
  if (!t) return;

  document.querySelectorAll('.logo-icon').forEach(el => {
    el.textContent = t.iconText;
    el.classList.add(t.iconCls);
  });
  document.querySelectorAll('.logo-text').forEach(el => {
    if (el.textContent.trim() === 'character.mind') {
      el.innerHTML = t.logoHtml();
    }
  });
}

function showBirthdayBanner() {
  if (document.getElementById('event-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'event-banner';
  banner.className = 'event-banner event-banner--birthday';
  banner.innerHTML = `
    <div class="birthday-banner-candles" aria-hidden="true">🕯️🕯️🕯️</div>
    <div class="birthday-banner-text">
      <strong>Happy Birthday, character.mind!</strong>
      <span>One year of bringing characters to life 🎊</span>
    </div>
    <button onclick="this.closest('.event-banner').remove()" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 15000);
}

function spawnParticles(emojis, count) {
  const container = document.createElement('div');
  container.id = 'seasonal-particles';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'season-particle';
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    p.style.cssText = [
      `left:${Math.random() * 100}vw`,
      `font-size:${16 + Math.random() * 22}px`,
      `animation-delay:${(Math.random() * 8).toFixed(2)}s`,
      `animation-duration:${(6 + Math.random() * 8).toFixed(2)}s`,
      `opacity:${0.7 + Math.random() * 0.3}`,
    ].join(';');
    container.appendChild(p);
  }
}

function setAccentOverride(color) {
  document.documentElement.style.setProperty('--accent', color);
}

function showEventBanner(msg, eventName) {
  if (document.getElementById('event-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'event-banner';
  banner.className = `event-banner event-banner--${eventName}`;
  banner.innerHTML = `
    <span>${msg}</span>
    <button onclick="this.closest('.event-banner').remove()" aria-label="Dismiss" style="font-size:13px">✕</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 10000);
}

// Voice features (call button, read-aloud) stay hidden until a TTS provider is configured server-side.
fetch('/api/tts/status').then(r => (r.ok ? r.json() : null)).then(d => {
  if (d && d.enabled) document.body.classList.add('voice-on');
}).catch(() => {});

// ── Push notifications ─────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

let _pushSubscribed = false;
let _pushPrompted = false;

async function enablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showWarning('Push notifications are not supported by this browser.');
    return false;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const keyRes = await fetch('/api/push/vapid-key');
    if (!keyRes.ok) return false;
    const { publicKey } = await keyRes.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    const saveRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() })
    });
    if (saveRes.ok) {
      _pushSubscribed = true;
      updateBellButton();
      return true;
    }
  } catch (e) {
    console.error('Push enable error:', e);
  }
  return false;
}

async function disablePushNotifications() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      }
    }
    await fetch('/api/push/unsubscribe', { method: 'DELETE' });
  } catch (e) { /* best effort */ }
  _pushSubscribed = false;
  updateBellButton();
}

function updateBellButton() {
  const btn = document.getElementById('notifBellBtn');
  if (!btn) return;
  btn.classList.toggle('notif-active', _pushSubscribed);
  btn.title = _pushSubscribed ? 'Disable character notifications' : 'Get notified when characters want to RP';
}

async function togglePushNotifications() {
  if (_pushSubscribed) {
    await disablePushNotifications();
  } else {
    const ok = await enablePushNotifications();
    if (!ok && Notification.permission === 'denied') {
      showWarning('Notifications are blocked. Enable them in your browser settings.');
    }
  }
}

async function checkPushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    _pushSubscribed = !!sub;
    updateBellButton();
  } catch (_) {}
}
checkPushStatus();

// Offer push notifications after the first AI reply (once per session)
const _origShowEventBanner = typeof showEventBanner === 'function' ? showEventBanner : null;
function maybePromptPush() {
  if (_pushPrompted || _pushSubscribed) return;
  if (!('PushManager' in window)) return;
  if (Notification.permission === 'denied') return;
  _pushPrompted = true;
  const banner = document.createElement('div');
  banner.className = 'event-banner push-prompt-banner';
  banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);max-width:360px;width:calc(100% - 32px);background:var(--bg2,#1a1a2e);border:1px solid var(--border1,#333);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.5)';
  banner.innerHTML = `
    <span style="font-size:20px">🔔</span>
    <div style="flex:1;font-size:13px;color:var(--text1,#eee)">Get character texts when you're away?</div>
    <button onclick="enablePushNotifications();this.closest('.push-prompt-banner').remove()" style="background:var(--accent,#7c3aed);color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;white-space:nowrap">Yes!</button>
    <button onclick="this.closest('.push-prompt-banner').remove()" style="background:transparent;color:var(--text3,#888);border:none;padding:6px;cursor:pointer;font-size:16px">✕</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => { try { banner.remove(); } catch (_) {} }, 15000);
}

// ── Hangman widget ────────────────────────────────────────────────────────────

function buildHangmanSVG(wrong) {
  const parts = [
    wrong >= 1 ? '<circle cx="100" cy="30" r="12" stroke="var(--text1)" stroke-width="3" fill="none"/>' : '',
    wrong >= 2 ? '<line x1="100" y1="42" x2="100" y2="90" stroke="var(--text1)" stroke-width="3"/>' : '',
    wrong >= 3 ? '<line x1="100" y1="55" x2="74" y2="75" stroke="var(--text1)" stroke-width="3"/>' : '',
    wrong >= 4 ? '<line x1="100" y1="55" x2="126" y2="75" stroke="var(--text1)" stroke-width="3"/>' : '',
    wrong >= 5 ? '<line x1="100" y1="90" x2="74" y2="120" stroke="var(--text1)" stroke-width="3"/>' : '',
    wrong >= 6 ? '<line x1="100" y1="90" x2="126" y2="120" stroke="var(--text1)" stroke-width="3"/>' : '',
  ].join('');
  return `<svg viewBox="0 0 200 140" class="hangman-svg">
    <line x1="20" y1="135" x2="180" y2="135" stroke="var(--text1)" stroke-width="3"/>
    <line x1="60" y1="135" x2="60" y2="5" stroke="var(--text1)" stroke-width="3"/>
    <line x1="60" y1="5" x2="100" y2="5" stroke="var(--text1)" stroke-width="3"/>
    <line x1="100" y1="5" x2="100" y2="18" stroke="var(--text1)" stroke-width="3"/>
    ${parts}
  </svg>`;
}

async function launchHangman(savedState) {
  const _hgKey = '_hg_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  if (!savedState) {
    const lockoutBarEl = document.getElementById('lockoutBar');
    if (lockoutBarEl && lockoutBarEl.style.display !== 'none') {
      const lockoutType = currentLockoutType || 'session';
      const displayStr = document.getElementById('lockoutCountdown')?.textContent || '';
      showLimitModal(lockoutType, displayStr);
      return;
    }
  }
  const msgEl = document.createElement('div');
  msgEl.className = 'msg game-widget';
  msgEl.innerHTML = '<div class="game-loading">Setting up Hangman…</div>';
  document.getElementById('messages').appendChild(msgEl);
  scrollToBottom();

  let word, gameId = null;
  if (savedState) {
    word = savedState.word;
  } else {
    try {
      const r = await fetch('/api/game/hangman/word');
      const d = await r.json();
      if (r.status === 429 && (d.type === 'session' || d.type === 'weekly')) {
        msgEl.remove();
        if (d.type === 'session') startCooldown(d.cooldownUntil, 'session', true);
        else startCooldown(d.resetsAt, 'weekly', true);
        return;
      }
      if (r.status === 429 && d.gameNextAvailableAt) {
        const secsLeft = Math.ceil((d.gameNextAvailableAt - Date.now()) / 1000);
        const minsLeft = Math.ceil(secsLeft / 60);
        msgEl.innerHTML = `<div class="game-loading">⏳ Game cooldown — come back in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.</div>`;
        return;
      }
      if (!r.ok) { msgEl.innerHTML = '<div class="game-loading">Couldn\'t load game. Try again.</div>'; return; }
      word = d.word.toLowerCase();
      gameId = d.gameId || null;
    } catch (_) {
      msgEl.innerHTML = '<div class="game-loading">Couldn\'t load game. Try again.</div>';
      return;
    }
  }

  const guessed = new Set();
  let wrongCount = 0;
  const maxWrong = 6;
  let coinAwarded = false;
  if (savedState) {
    gameId = savedState.gameId || null; // restore from saved state if available
    (savedState.guessed || []).forEach(c => guessed.add(c));
    wrongCount = savedState.wrongCount || 0;
  }

  function renderHangman() {
    const isWin = [...word].every(c => guessed.has(c));
    const isLoss = wrongCount >= maxWrong;
    const gameOver = isWin || isLoss;

    if (isWin && !coinAwarded && currentUser) {
      coinAwarded = true;
      fetch('/api/coins/award', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wordLength: word.length, gameId: gameId || undefined })
        })
        .then(r => r.json())
        .then(d => {
          if (d && typeof d.balance === 'number') {
            if (lastKnownUsage) lastKnownUsage.cmCoins = d.balance;
            else lastKnownUsage = { cmCoins: d.balance };
            updateNavCoinDisplay(lastKnownUsage);
            updateSettingsCoinDisplay(d.balance, d.earnedToday, d.dailyCap);
            if (d.awarded > 0) showCoinPop(d.awarded);
          }
        })
        .catch(() => {});
    }

    const wordDisplay = [...word].map(c =>
      `<span class="h-letter ${guessed.has(c) ? 'revealed' : 'blank'}">${guessed.has(c) ? c : '_'}</span>`
    ).join('');

    const keys = 'abcdefghijklmnopqrstuvwxyz'.split('').map(c => {
      const used = guessed.has(c);
      const cls = used ? (word.includes(c) ? ' correct' : ' wrong') : '';
      return `<button class="h-key${cls}" onclick="window['${_hgKey}'](this,'${c}')" ${used || gameOver ? 'disabled' : ''}>${c.toUpperCase()}</button>`;
    }).join('');

    let statusHtml = '';
    if (isWin) statusHtml = `<div class="game-status win">🎉 You got it! The word was <strong>${word.toUpperCase()}</strong>!</div>`;
    else if (isLoss) statusHtml = `<div class="game-status lose">💀 Game over! The word was <strong>${word.toUpperCase()}</strong>.</div>`;

    msgEl.innerHTML = `
      <div class="game-header">
        <span class="game-title">🎮 Hangman</span>
        <span class="hangman-score">Wrong: ${wrongCount}/${maxWrong}</span>
      </div>
      <div class="hangman-figure">${buildHangmanSVG(wrongCount)}</div>
      <div class="hangman-word">${wordDisplay}</div>
      <div class="hangman-keyboard">${keys}</div>
      ${statusHtml}
      ${gameOver ? `<button class="game-new-btn" onclick="launchHangman();this.closest('.game-widget').remove()">Play Again</button>` : ''}
    `;
    scrollToBottom();
    if (currentChar) {
      if (gameOver) clearActiveGame(currentChar.id);
      else saveActiveGame(currentChar.id, { type: 'hangman', word, guessed: [...guessed], wrongCount });
    }
    if (gameOver) delete window[_hgKey];
  }

  window[_hgKey] = function(btn, letter) {
    if (guessed.has(letter)) return;
    guessed.add(letter);
    if (!word.includes(letter)) wrongCount++;
    renderHangman();
  };

  renderHangman();
}

// ── Tic-Tac-Toe widget ────────────────────────────────────────────────────────

function tttClientCheck(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line: [a,b,c] };
  }
  if (board.every(c => c)) return { winner: 'draw', line: [] };
  return null;
}

function launchTicTacToe(savedState) {
  const _tttKey = '_ttt_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  if (!savedState) {
    const lockoutBarEl = document.getElementById('lockoutBar');
    if (lockoutBarEl && lockoutBarEl.style.display !== 'none') {
      const lockoutType = currentLockoutType || 'session';
      const displayStr = document.getElementById('lockoutCountdown')?.textContent || '';
      showLimitModal(lockoutType, displayStr);
      return;
    }
  }
  let board = savedState ? (savedState.board || Array(9).fill(null)) : Array(9).fill(null);
  let waiting = false;

  const msgEl = document.createElement('div');
  msgEl.className = 'msg game-widget';
  document.getElementById('messages').appendChild(msgEl);
  scrollToBottom();

  function renderTTT(winData) {
    const cells = board.map((val, i) => {
      const inWin = winData && winData.line && winData.line.includes(i);
      return `<button class="ttt-cell${val ? ' taken' : ''}${inWin ? ' win-cell' : ''}"
        onclick="window['${_tttKey}'](${i})" ${val || waiting || winData ? 'disabled' : ''}>
        ${val ? `<span class="${val === 'X' ? 'ttt-x' : 'ttt-o'}">${val}</span>` : ''}
      </button>`;
    }).join('');

    let status = waiting ? 'Thinking…' : 'Your turn (X)';
    if (winData) {
      if (winData.winner === 'X') status = '🎉 You win!';
      else if (winData.winner === 'O') status = '😤 You lose!';
      else status = "🤝 It's a draw!";
    }

    msgEl.innerHTML = `
      <div class="game-header">
        <span class="game-title">🎮 Tic-Tac-Toe</span>
        <span class="ttt-status-text">${status}</span>
      </div>
      <div class="ttt-board">${cells}</div>
      ${winData ? `<button class="game-new-btn" onclick="launchTicTacToe();this.closest('.game-widget').remove()">Play Again</button>` : ''}
    `;
    scrollToBottom();
    if (currentChar) {
      if (winData) clearActiveGame(currentChar.id);
      else saveActiveGame(currentChar.id, { type: 'ttt', board: [...board], waiting });
    }
    if (winData) delete window[_tttKey];
  }

  window[_tttKey] = async function(idx) {
    if (board[idx] || waiting) return;
    board[idx] = 'X';
    waiting = true;
    let winCheck = tttClientCheck(board);
    renderTTT(winCheck);
    if (winCheck) return;

    try {
      const r = await fetch('/api/game/tictactoe/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board })
      });
      const d = await r.json();
      if (r.status === 429 && (d.type === 'session' || d.type === 'weekly')) {
        delete window[_tttKey];
        msgEl.remove();
        if (d.type === 'session') startCooldown(d.cooldownUntil, 'session', true);
        else startCooldown(d.resetsAt, 'weekly', true);
        return;
      }
      if (r.status === 429 && d.gameNextAvailableAt) {
        const secsLeft = Math.ceil((d.gameNextAvailableAt - Date.now()) / 1000);
        const minsLeft = Math.ceil(secsLeft / 60);
        waiting = false;
        delete window[_tttKey];
        msgEl.innerHTML = `<div class="game-loading">⏳ Game cooldown — come back in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.</div>`;
        scrollToBottom();
        return;
      }
      if (r.ok && d.move >= 0 && d.move < 9 && board[d.move] === null) board[d.move] = 'O';
    } catch (_) {}

    waiting = false;
    winCheck = tttClientCheck(board);
    renderTTT(winCheck);
  };

  const restoredWin = savedState ? tttClientCheck(board) : null;
  renderTTT(restoredWin);

  if (savedState && savedState.waiting && !restoredWin) {
    waiting = true;
    renderTTT(null);
    (async () => {
      try {
        const r = await fetch('/api/game/tictactoe/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ board })
        });
        const d = await r.json();
        if (r.ok && d.move >= 0 && d.move < 9 && board[d.move] === null) board[d.move] = 'O';
      } catch (_) {}
      waiting = false;
      renderTTT(tttClientCheck(board));
    })();
  }
}

async function launchWordle(savedState) {
  const _wdKey = '_wd_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  if (!savedState) {
    const lockoutBarEl = document.getElementById('lockoutBar');
    if (lockoutBarEl && lockoutBarEl.style.display !== 'none') {
      const lockoutType = currentLockoutType || 'session';
      const displayStr = document.getElementById('lockoutCountdown')?.textContent || '';
      showLimitModal(lockoutType, displayStr);
      return;
    }
  }

  const msgEl = document.createElement('div');
  msgEl.className = 'msg game-widget';
  msgEl.innerHTML = '<div class="game-loading">Setting up Wordle…</div>';
  document.getElementById('messages').appendChild(msgEl);
  scrollToBottom();

  let word, gameId = null;
  if (savedState) {
    word = savedState.word;
    gameId = savedState.gameId || null;
  } else {
    try {
      const r = await fetch('/api/game/wordle/word');
      const d = await r.json();
      if (r.status === 429 && (d.type === 'session' || d.type === 'weekly')) {
        msgEl.remove();
        if (d.type === 'session') startCooldown(d.cooldownUntil, 'session', true);
        else startCooldown(d.resetsAt, 'weekly', true);
        return;
      }
      if (r.status === 429 && d.gameNextAvailableAt) {
        const secsLeft = Math.ceil((d.gameNextAvailableAt - Date.now()) / 1000);
        const minsLeft = Math.ceil(secsLeft / 60);
        msgEl.innerHTML = `<div class="game-loading">⏳ Game cooldown — come back in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.</div>`;
        return;
      }
      if (!r.ok) { msgEl.innerHTML = '<div class="game-loading">Couldn\'t load game. Try again.</div>'; return; }
      word = d.word.toLowerCase();
      gameId = d.gameId || null;
    } catch (_) {
      msgEl.innerHTML = '<div class="game-loading">Couldn\'t load game. Try again.</div>';
      return;
    }
  }

  const WORD_LEN = 5, MAX_GUESSES = 6;
  const guesses = savedState ? (savedState.guesses || []) : [];
  let currentGuess = '';
  let gameOver = false;
  let coinAwarded = false;

  function evalGuess(g) {
    const res = Array(WORD_LEN).fill('absent');
    const rem = [...word];
    for (let i = 0; i < WORD_LEN; i++) {
      if (g[i] === word[i]) { res[i] = 'correct'; rem[rem.indexOf(g[i])] = null; }
    }
    for (let i = 0; i < WORD_LEN; i++) {
      if (res[i] === 'correct') continue;
      const j = rem.indexOf(g[i]);
      if (j >= 0) { res[i] = 'present'; rem[j] = null; }
    }
    return res;
  }

  function keyState(letter) {
    let best = '';
    for (const g of guesses) {
      const r = evalGuess(g);
      for (let i = 0; i < WORD_LEN; i++) {
        if (g[i] !== letter) continue;
        if (r[i] === 'correct') return 'correct';
        if (r[i] === 'present') best = 'present';
        else if (!best) best = 'absent';
      }
    }
    return best;
  }

  function renderWordle() {
    const isWin = guesses.length > 0 && guesses[guesses.length - 1] === word;
    gameOver = isWin || guesses.length >= MAX_GUESSES;

    if (isWin && !coinAwarded && currentUser) {
      coinAwarded = true;
      fetch('/api/coins/award', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wordLength: WORD_LEN, gameId: gameId || undefined }),
      }).then(r => r.json()).then(d => {
        if (d && typeof d.balance === 'number') {
          if (lastKnownUsage) lastKnownUsage.cmCoins = d.balance;
          else lastKnownUsage = { cmCoins: d.balance };
          updateNavCoinDisplay(lastKnownUsage);
          updateSettingsCoinDisplay(d.balance, d.earnedToday, d.dailyCap);
          if (d.awarded > 0) showCoinPop(d.awarded);
        }
      }).catch(() => {});
    }

    let rows = '';
    for (let r = 0; r < MAX_GUESSES; r++) {
      let cells = '';
      for (let c = 0; c < WORD_LEN; c++) {
        if (r < guesses.length) {
          const ev = evalGuess(guesses[r]);
          cells += `<div class="wd-cell ${ev[c]}">${guesses[r][c].toUpperCase()}</div>`;
        } else if (r === guesses.length && !gameOver) {
          const ch = currentGuess[c] || '';
          cells += `<div class="wd-cell${ch ? ' filled' : ''}">${ch.toUpperCase()}</div>`;
        } else {
          cells += `<div class="wd-cell"></div>`;
        }
      }
      rows += `<div class="wd-row">${cells}</div>`;
    }

    const KB_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    let kbHtml = '';
    for (let i = 0; i < KB_ROWS.length; i++) {
      let keys = '';
      if (i === 2) keys += `<button class="wd-key wd-wide" onclick="window['${_wdKey}']('Enter')">↵</button>`;
      for (const k of KB_ROWS[i]) {
        const st = keyState(k);
        keys += `<button class="wd-key ${st}" onclick="window['${_wdKey}']('${k}')">${k.toUpperCase()}</button>`;
      }
      if (i === 2) keys += `<button class="wd-key wd-wide" onclick="window['${_wdKey}']('Backspace')">⌫</button>`;
      kbHtml += `<div class="wd-kb-row">${keys}</div>`;
    }

    const statusHtml = isWin
      ? `<div class="game-status win">🎉 You got it in ${guesses.length}!</div>`
      : gameOver
        ? `<div class="game-status lose">💀 The word was <strong>${word.toUpperCase()}</strong>.</div>`
        : '';

    msgEl.innerHTML = `
      <div class="game-header">
        <span class="game-title">🟩 Wordle</span>
        <span style="font-size:12px;color:var(--text3)">${guesses.length}/${MAX_GUESSES}</span>
      </div>
      <div class="wd-grid">${rows}</div>
      <div class="wd-kb">${kbHtml}</div>
      ${statusHtml}
      ${gameOver ? `<button class="game-new-btn" onclick="launchWordle();this.closest('.game-widget').remove()">Play Again</button>` : ''}
    `;
    scrollToBottom();

    if (currentChar) {
      if (gameOver) clearActiveGame(currentChar.id);
      else saveActiveGame(currentChar.id, { type: 'wordle', word, gameId, guesses: [...guesses] });
    }
    if (gameOver) {
      delete window[_wdKey];
      if (msgEl._wdKb) { document.removeEventListener('keydown', msgEl._wdKb); delete msgEl._wdKb; }
    }
  }

  window[_wdKey] = function(key) {
    if (gameOver) return;
    if (key === 'Backspace') {
      currentGuess = currentGuess.slice(0, -1);
    } else if (key === 'Enter') {
      if (currentGuess.length !== WORD_LEN) return;
      guesses.push(currentGuess);
      currentGuess = '';
    } else if (currentGuess.length < WORD_LEN && /^[a-z]$/.test(key)) {
      currentGuess += key;
    } else {
      return;
    }
    renderWordle();
  };

  msgEl._wdKb = (e) => {
    if (gameOver) return;
    if (e.key === 'Enter') window[_wdKey]('Enter');
    else if (e.key === 'Backspace') window[_wdKey]('Backspace');
    else if (/^[a-zA-Z]$/.test(e.key)) window[_wdKey](e.key.toLowerCase());
  };
  document.addEventListener('keydown', msgEl._wdKb);

  renderWordle();
}

// ── Halloween 2026 gift ────────────────────────────────────────────────────────
function checkHalloweenGift() {
  // Banner removed — gift only shown in usage modal
}

async function claimHalloweenGift() {
  const allBtns = [
    document.getElementById('hwGiftClaimBtn'),
    document.getElementById('hwGiftUsageBtn'),
  ];
  allBtns.forEach(b => { if (b) { b.disabled = true; b.textContent = '…'; } });
  try {
    const r = await fetch('/api/halloween/claim', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      if (lastKnownUsage) {
        lastKnownUsage.cmCoins  = d.coins;
        lastKnownUsage.cmTokens = d.tokens;
      }
      updateSettingsCoinDisplay(d.coins, lastKnownUsage?.coinsEarnedToday || 0, lastKnownUsage?.coinDailyLimit || 100, lastKnownUsage?.coinsMonthlyReset);
      updateNavCoinDisplay(lastKnownUsage);
      if (currentUser) currentUser.halloweenGift2026 = true;
      const banner = document.getElementById('halloweenGiftBanner');
      if (banner) {
        banner.querySelector('.hw-gift-text').textContent = '🎃 Done! All your limits have been reset. Enjoy Halloween!';
        banner.querySelector('.hw-gift-btn-row').style.display = 'none';
        setTimeout(() => { if (banner) banner.style.display = 'none'; }, 4000);
      }
      const hwUsageRow = document.getElementById('hwGiftUsageRow');
      if (hwUsageRow) {
        const txt = hwUsageRow.querySelector('span');
        if (txt) txt.textContent = '🎃 Done! All limits reset — Enjoy Halloween!';
        const usageBtn = document.getElementById('hwGiftUsageBtn');
        if (usageBtn) { usageBtn.textContent = '✓'; usageBtn.style.background = '#16a34a'; }
        setTimeout(() => {
          if (txt) txt.innerHTML = '🎃 <strong>Halloween Gift</strong> — reset all limits free';
          if (usageBtn) { usageBtn.textContent = '🎁 Claim'; usageBtn.style.background = ''; usageBtn.disabled = false; }
        }, 3000);
      }
      await loadUsage();
      if (lastKnownUsage) updateUsageModal(lastKnownUsage);
    } else {
      allBtns.forEach(b => { if (b) { b.disabled = false; b.textContent = b.id === 'hwGiftUsageBtn' ? '🎁 Claim' : '🎁 Claim Gift'; } });
      showWarning(d.error || 'Could not claim gift. Try again.');
    }
  } catch (_) {
    allBtns.forEach(b => { if (b) { b.disabled = false; b.textContent = b.id === 'hwGiftUsageBtn' ? '🎁 Claim' : '🎁 Claim Gift'; } });
    showWarning('Could not claim gift. Try again.');
  }
}

// ── Halloween Theme (October 1-31) ────────────────────────────────────────────
(function initHalloween() {
  if (new Date().getMonth() !== 9) return;
  const _hwMasterOn = localStorage.getItem('hw_mode') !== '0';
  if (_hwMasterOn) document.body.classList.add('halloween');

  // Update annual toggle label to reflect combined savings during Halloween sale
  if (halloweenSaleActive()) {
    const annualBtn = document.getElementById('pricingBtnAnnual');
    if (annualBtn) {
      const lbl = annualBtn.querySelector('.pt-save-label');
      if (lbl) lbl.textContent = '🎃 70% off';
    }
  }

  // ── Spider webs in the corners ──────────────────────────────────────────────
  // webSVG defined here so hwEnableAll() can re-add them after toggling back on
  const webSVG = `<svg class="halloween-web web-left" width="180" height="180" viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg"><g stroke="#c084fc" stroke-width="0.9" fill="none"><line x1="0" y1="0" x2="180" y2="0"/><line x1="0" y1="0" x2="155" y2="35"/><line x1="0" y1="0" x2="120" y2="75"/><line x1="0" y1="0" x2="78" y2="108"/><line x1="0" y1="0" x2="38" y2="140"/><line x1="0" y1="0" x2="0" y2="180"/><path d="M35,0 Q32,32 0,35"/><path d="M75,0 Q66,44 46,62 Q26,76 0,78"/><path d="M115,0 Q100,56 74,84 Q50,106 22,112 Q0,116 0,116"/><path d="M155,0 Q134,65 104,96 Q76,122 44,132 Q18,138 0,152"/><line x1="90" y1="0" x2="90" y2="42" stroke="#a855f7" stroke-width="0.7"/><ellipse cx="90" cy="46" rx="6" ry="8" fill="#7c3aed" stroke="#a855f7" stroke-width="0.9"/><ellipse cx="90" cy="42" rx="3.5" ry="3.5" fill="#6d28d9"/><line x1="90" y1="44" x2="81" y2="38" stroke="#a855f7" stroke-width="0.6"/><line x1="90" y1="44" x2="80" y2="46" stroke="#a855f7" stroke-width="0.6"/><line x1="90" y1="44" x2="99" y2="38" stroke="#a855f7" stroke-width="0.6"/><line x1="90" y1="44" x2="100" y2="46" stroke="#a855f7" stroke-width="0.6"/></g></svg>`;
  if (_hwMasterOn) {
    document.body.insertAdjacentHTML('beforeend', webSVG);
    document.body.insertAdjacentHTML('beforeend', webSVG.replace('web-left','web-right'));
  }

  // ── Atmospheric horror: vignette, fog, blood drips, lightning ───────────────
  function spawnHwAtmosphere() {
    if (document.getElementById('hwVignette')) return;

    const vig = document.createElement('div');
    vig.className = 'hw-vignette'; vig.id = 'hwVignette';
    document.body.appendChild(vig);

    const fogWrap = document.createElement('div');
    fogWrap.className = 'hw-fog-wrap'; fogWrap.id = 'hwFogWrap';
    [
      { bottom: 0,   h: 130, dur: 26, delay: 0,    op: .22 },
      { bottom: 60,  h: 95,  dur: 33, delay: -11,  op: .16 },
      { bottom: 130, h: 75,  dur: 41, delay: -20,  op: .11 },
      { bottom: 200, h: 55,  dur: 50, delay: -30,  op: .07 },
    ].forEach(({ bottom, h, dur, delay, op }) => {
      const b = document.createElement('div');
      b.className = 'hw-fog-band';
      b.style.cssText = `bottom:${bottom}px;height:${h}px;animation-duration:${dur}s;animation-delay:${delay}s;--fog-op:${op};`;
      fogWrap.appendChild(b);
    });
    document.body.appendChild(fogWrap);

    const dripWrap = document.createElement('div');
    dripWrap.className = 'hw-drip-wrap'; dripWrap.id = 'hwDripWrap';
    [
      [3,  2, 80,  7,  0   ],
      [9,  3, 115, 11, -3  ],
      [16, 2, 60,  8,  -7  ],
      [24, 4, 135, 14, -2  ],
      [33, 2, 70,  9,  -10 ],
      [44, 3, 100, 12, -5  ],
      [55, 2, 55,  7,  -8  ],
      [64, 4, 105, 13, -1  ],
      [73, 2, 75,  9,  -4  ],
      [82, 3, 90,  11, -9  ],
      [90, 2, 65,  8,  -6  ],
      [96, 3, 50,  6,  -12 ],
    ].forEach(([left, w, h, dur, delay]) => {
      const d = document.createElement('div');
      d.className = 'hw-drip';
      d.style.cssText = `left:${left}%;width:${w}px;--drip-h:${h}px;animation-duration:${dur}s;animation-delay:${delay}s;`;
      dripWrap.appendChild(d);
    });
    document.body.appendChild(dripWrap);

    const bolt = document.createElement('div');
    bolt.className = 'hw-lightning'; bolt.id = 'hwLightningEl';
    document.body.appendChild(bolt);
    (function lightLoop() {
      setTimeout(() => {
        bolt.style.opacity = '.07';
        setTimeout(() => {
          bolt.style.opacity = '0';
          setTimeout(() => {
            bolt.style.opacity = '.11';
            setTimeout(() => { bolt.style.opacity = '0'; lightLoop(); }, 50);
          }, 120);
        }, 65);
      }, (16 + Math.random() * 40) * 1000);
    })();
  }
  function removeHwAtmosphere() {
    ['hwVignette','hwFogWrap','hwDripWrap','hwLightningEl'].forEach(id => document.getElementById(id)?.remove());
  }

  if (_hwMasterOn) spawnHwAtmosphere();

  // ── Flying parade ───────────────────────────────────────────────────────────
  // Each entry: [emoji, minSize, maxSize, minSpeed, maxSpeed, minTop%, maxTop%]
  const PARADE = [
    ['👻', 30, 58, 9, 17, 18, 72],
    ['🧙‍♀️', 34, 62, 8, 15, 12, 65],
    ['🧟', 28, 52, 12, 20, 55, 82],
    ['💀', 26, 46, 10, 18, 20, 75],
    ['🎃', 30, 56, 10, 17, 25, 78],
    ['🐈‍⬛', 24, 44, 9,  17, 60, 85],
    ['🕷️', 22, 42, 7,  14, 18, 80],
    ['🦇', 24, 46, 9,  16, 15, 70],
    ['🧛', 30, 56, 8,  15, 10, 65],
    ['☠️', 26, 48, 10, 18, 22, 74],
    ['🔮', 24, 42, 11, 18, 30, 78],
    ['🌙', 22, 40, 8,  15, 10, 50],
    ['🩸', 20, 38, 11, 19, 30, 80],
    ['🦴', 22, 38, 10, 18, 25, 75],
    ['⚰️', 28, 48, 9,  16, 40, 80],
    ['🧿', 20, 34, 8,  15, 15, 65],
    ['🪬', 22, 36, 9,  16, 20, 70],
    ['😈', 28, 50, 10, 17, 15, 72],
    ['👁️', 18, 32, 8,  14, 25, 75],
    ['🌑', 22, 40, 8,  14, 10, 55],
    ['🕸️', 26, 44, 8,  14, 20, 70],
    ['🔪', 22, 36, 11, 19, 30, 80],
    ['🫀', 20, 34, 9,  16, 35, 78],
    ['🦠', 18, 30, 7,  13, 25, 75],
    ['💉', 20, 34, 10, 17, 40, 82],
  ];

  const CONFETTI = [
    '👻','🎃','💀','🦇','🕸️','🍬','⚗️','🕯️','🌙','✨','🔮','☠️','🧡','🕷️',
    '🩸','🦴','⚰️','😈','👁️','🪄','🌑','🧿','🌑','💉','🗡️','🔪',
  ];

  // ── Settings state ──────────────────────────────────────────────────────────
  let hwPaused     = false; // kept for jump-scare / blood-flash guards; no longer toggled
  let hwAnimations = localStorage.getItem('hw_anim_on')    !== '0'; // horizontal parade, default ON
  let hwScares     = localStorage.getItem('hw_scares_on')  === '1'; // default OFF
  let hwConfetti   = localStorage.getItem('hw_conf_on')    !== '0'; // falling emoji, default ON
  let confettiLoopId = null;
  let paradeLoopId   = null;
  let hwCallVoice = localStorage.getItem('hw_call_voice')  === 'demon';
  let hwFreq      = Math.max(0, Math.min(100, parseInt(localStorage.getItem('hw_scare_freq') || '50')));
  let hwVol       = Math.max(0, Math.min(100, parseInt(localStorage.getItem('hw_scare_vol')  || '70')));

  // Call voice: switch to gravelly Gemini voice if demon mode is on at startup
  if (hwCallVoice) {
    if (typeof geminiVoiceName !== 'undefined') geminiVoiceName = 'Algenib';
    document.body.classList.add('hw-demon-voice');
  }

  const hwStage = document.createElement('div');
  hwStage.id = 'hw-stage';
  if (!hwAnimations && !hwConfetti) hwStage.style.display = 'none';
  document.body.appendChild(hwStage);

  // ── Settings panel ──────────────────────────────────────────────────────────
  const hwPanel = document.createElement('div');
  hwPanel.id = 'hwSettingsPanel';
  hwPanel.innerHTML = `
    <div class="hw-panel-hd">
      <span>🎃 Halloween</span>
      <button class="hw-panel-close" id="hwPanelClose">✕</button>
    </div>
    <div class="hw-panel-rows">
      <div class="hw-panel-row" style="border-bottom:1px solid rgba(249,115,22,0.2);margin-bottom:4px;padding-bottom:10px">
        <span style="font-weight:700">Halloween Mode</span>
        <button class="hw-tog" id="hwTogMaster">On</button>
      </div>
      <div class="hw-panel-row">
        <span>Floaters</span>
        <button class="hw-tog" id="hwTogMotion">${hwAnimations ? 'On' : 'Off'}</button>
      </div>
      <div class="hw-panel-row">
        <span>Jump Scares</span>
        <button class="hw-tog" id="hwTogScares">${hwScares ? 'On' : 'Off'}</button>
      </div>
      <div class="hw-panel-row">
        <span>Confetti</span>
        <button class="hw-tog" id="hwTogConf">${hwConfetti ? 'On' : 'Off'}</button>
      </div>
      <div class="hw-panel-row">
        <span>Call Voice</span>
        <button class="hw-tog hw-tog-voice" id="hwTogVoice">${hwCallVoice ? '👹 Demon' : '🔊 Normal'}</button>
      </div>
      <div class="hw-panel-row hw-panel-freq">
        <span>Scare Frequency</span>
        <div class="hw-freq-wrap">
          <span class="hw-freq-lbl">Rare</span>
          <input type="range" id="hwFreqSlider" min="0" max="100" value="${hwFreq}" class="hw-freq-slider">
          <span class="hw-freq-lbl">Often</span>
        </div>
      </div>
      <div class="hw-panel-row hw-panel-freq">
        <span>Scare Volume</span>
        <div class="hw-freq-wrap">
          <span class="hw-freq-lbl">🔇</span>
          <input type="range" id="hwVolSlider" min="0" max="100" value="${hwVol}" class="hw-freq-slider">
          <span class="hw-freq-lbl">🔊</span>
        </div>
      </div>
    </div>`;
  document.body.appendChild(hwPanel);

  const settingsBtn = document.createElement('button');
  settingsBtn.id = 'hwMotionToggle';
  settingsBtn.title = 'Halloween settings';
  settingsBtn.textContent = '🎃';
  settingsBtn.style.opacity = '0.85';
  document.body.appendChild(settingsBtn);

  function hwSyncStage() {
    if (!hwAnimations) hwStage.querySelectorAll('.hw-flyer').forEach(el => el.remove());
    if (!hwConfetti)   hwStage.querySelectorAll('.hw-confetti').forEach(el => el.remove());
    if (!hwAnimations && !hwConfetti) hwStage.style.display = 'none';
    if (!hwScares) {
      document.querySelectorAll('.hw-jump-scare,.hw-glitch-overlay').forEach(el => el.remove());
      document.body.classList.remove('hw-screaming');
    }
  }

  settingsBtn.addEventListener('click', () => {
    const open = hwPanel.classList.toggle('hw-panel-open');
    settingsBtn.style.opacity = open ? '1' : '0.85';
    if (open) hwSyncStage();
  });
  document.getElementById('hwPanelClose').addEventListener('click', () => {
    hwPanel.classList.remove('hw-panel-open');
    settingsBtn.style.opacity = '0.85';
  });

  function hwSetTog(btn, on, activeClass = 'hw-tog-on') {
    btn.classList.toggle(activeClass, on);
  }
  const togMotion  = document.getElementById('hwTogMotion');
  const togScares  = document.getElementById('hwTogScares');
  const togConf    = document.getElementById('hwTogConf');
  const togVoice   = document.getElementById('hwTogVoice');
  const freqSlider = document.getElementById('hwFreqSlider');

  hwSetTog(togMotion, hwAnimations);
  hwSetTog(togScares, hwScares);
  hwSetTog(togConf, hwConfetti);
  hwSetTog(togVoice, hwCallVoice);

  // ── Master on/off toggle ──────────────────────────────────────────────────
  let hwMaster = localStorage.getItem('hw_mode') !== '0'; // default ON
  const togMaster = document.getElementById('hwTogMaster');
  hwSetTog(togMaster, hwMaster);
  if (!hwMaster) {
    togMaster.textContent = 'Off';
    document.body.classList.remove('halloween');
    hwStage.style.display = 'none';
  }

  function hwDisableAll() {
    document.body.classList.remove('halloween');
    clearInterval(confettiLoopId); confettiLoopId = null;
    clearTimeout(paradeLoopId); paradeLoopId = null;
    hwStage.innerHTML = ''; hwStage.style.display = 'none';
    document.querySelectorAll('.halloween-web').forEach(el => el.remove());
    document.body.classList.remove('hw-screaming','hw-demon-voice');
    removeHwAtmosphere();
    // Restore logo text to plain "character.mind"
    hwLogoObserver.disconnect();
    document.querySelectorAll('.logo-text[data-hw-done]').forEach(restoreHwLogo);
  }
  function hwEnableAll() {
    document.body.classList.add('halloween');
    document.body.insertAdjacentHTML('beforeend', webSVG);
    document.body.insertAdjacentHTML('beforeend', webSVG.replace('web-left','web-right'));
    spawnHwAtmosphere();
    if (hwConfetti) { hwStage.style.display = ''; startConfetti(); }
    if (hwAnimations) { hwStage.style.display = ''; startParade(); }
    if (hwCallVoice) document.body.classList.add('hw-demon-voice');
    // Re-apply Halloween logo and watch for new logo elements
    document.querySelectorAll('.logo-text').forEach(applyHwLogo);
    hwLogoObserver.observe(document.body, { childList: true, subtree: true });
  }

  togMaster.addEventListener('click', () => {
    hwMaster = !hwMaster;
    localStorage.setItem('hw_mode', hwMaster ? '1' : '0');
    togMaster.textContent = hwMaster ? 'On' : 'Off';
    hwSetTog(togMaster, hwMaster);
    if (hwMaster) hwEnableAll(); else hwDisableAll();
  });

  togMotion.addEventListener('click', () => {
    hwAnimations = !hwAnimations;
    localStorage.setItem('hw_anim_on', hwAnimations ? '1' : '0');
    togMotion.textContent = hwAnimations ? 'On' : 'Off';
    hwSetTog(togMotion, hwAnimations);
    clearTimeout(paradeLoopId);
    paradeLoopId = null;
    if (!hwAnimations) {
      hwSyncStage();
      setTimeout(hwSyncStage, 300); // catch any delayed spawns
    } else {
      hwStage.style.display = '';
      startParade();
    }
  });
  togScares.addEventListener('click', () => {
    hwScares = !hwScares;
    localStorage.setItem('hw_scares_on', hwScares ? '1' : '0');
    togScares.textContent = hwScares ? 'On' : 'Off';
    hwSetTog(togScares, hwScares);
    if (hwScares) {
      scheduleNextScare();
    } else {
      if (_scareTimer) { clearTimeout(_scareTimer); _scareTimer = null; }
      hwSyncStage();
    }
  });
  togConf.addEventListener('click', () => {
    hwConfetti = !hwConfetti;
    localStorage.setItem('hw_conf_on', hwConfetti ? '1' : '0');
    togConf.textContent = hwConfetti ? 'On' : 'Off';
    hwSetTog(togConf, hwConfetti);
    clearInterval(confettiLoopId);
    confettiLoopId = null;
    if (!hwConfetti) {
      hwSyncStage();
      setTimeout(hwSyncStage, 300); // catch any delayed spawns
    } else {
      hwStage.style.display = '';
      startConfetti();
    }
  });
  togVoice.addEventListener('click', () => {
    hwCallVoice = !hwCallVoice;
    localStorage.setItem('hw_call_voice', hwCallVoice ? 'demon' : 'normal');
    togVoice.textContent = hwCallVoice ? '👹 Demon' : '🔊 Normal';
    hwSetTog(togVoice, hwCallVoice);
    document.body.classList.toggle('hw-demon-voice', hwCallVoice);
    if (hwCallVoice) {
      if (typeof geminiVoiceName !== 'undefined') geminiVoiceName = 'Algenib';
    } else {
      if (typeof loadCharVoice === 'function') loadCharVoice();
    }
  });
  freqSlider.addEventListener('input', () => {
    hwFreq = parseInt(freqSlider.value);
    localStorage.setItem('hw_scare_freq', hwFreq);
  });
  const volSlider = document.getElementById('hwVolSlider');
  if (volSlider) volSlider.addEventListener('input', () => {
    hwVol = parseInt(volSlider.value);
    localStorage.setItem('hw_scare_vol', hwVol);
  });

  // ── Flying parade ───────────────────────────────────────────────────────────
  function spawnParade() {
    if (!hwAnimations) return;
    if (hwStage.querySelectorAll('.hw-flyer').length >= 20) return;
    const [emoji, minS, maxS, minSpd, maxSpd, minT, maxT] = PARADE[Math.floor(Math.random() * PARADE.length)];
    const fromRight = Math.random() > 0.5;
    const el = document.createElement('div');
    el.className = 'hw-flyer';
    el.textContent = emoji;
    const size   = minS + Math.random() * (maxS - minS);
    const topPct = minT + Math.random() * (maxT - minT);
    const dur    = minSpd + Math.random() * (maxSpd - minSpd);
    el.style.cssText = `font-size:${size}px;top:calc(${topPct}vh - 68px);animation:${fromRight?'hwFlyLeft':'hwFlyRight'} ${dur}s linear both;`;
    hwStage.appendChild(el);
    setTimeout(() => el.remove(), dur * 1000 + 600);
  }

  function startParade() {
    (function loop() {
      if (!hwAnimations) return;
      spawnParade();
      if (Math.random() < 0.5) setTimeout(spawnParade, 300 + Math.random() * 500);
      paradeLoopId = setTimeout(loop, 600 + Math.random() * 1000);
    })();
  }
  if (_hwMasterOn && hwAnimations) {
    for (let i = 0; i < 12; i++) setTimeout(spawnParade, i * 400);
    startParade();
  }

  // ── Falling confetti ────────────────────────────────────────────────────────
  function spawnConfetti() {
    if (!hwConfetti) return;
    if (hwStage.querySelectorAll('.hw-confetti').length >= 100) return;
    const el = document.createElement('div');
    el.className = 'hw-confetti';
    el.textContent = CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
    const size = 14 + Math.random() * 26;
    const left = 2  + Math.random() * 96;
    const dur  = 3.5 + Math.random() * 5.5;
    const sway = ((Math.random() - 0.5) * 110).toFixed(0);
    const rot  = ((Math.random() - 0.5) * 480).toFixed(0) + 'deg';
    el.style.cssText = `font-size:${size}px;left:${left}%;animation-duration:${dur}s;animation-delay:${(Math.random()*0.8).toFixed(2)}s;--hw-sway:${sway}px;--hw-rot:${rot};`;
    hwStage.appendChild(el);
    setTimeout(() => el.remove(), dur * 1000);
  }

  function startConfetti() {
    confettiLoopId = setInterval(spawnConfetti, 60);
  }
  if (_hwMasterOn && hwConfetti) {
    for (let i = 0; i < 20; i++) setTimeout(spawnConfetti, i * 50);
    startConfetti();
  }

  // Periodic guard: remove stray items if flags went false (catches any timing edge cases)
  setInterval(hwSyncStage, 1000);

  // ── Occasional crimson screen flash ─────────────────────────────────────────
  function hwBloodFlash() {
    if (hwScares) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998;background:rgba(120,0,0,0.22);opacity:1;transition:opacity 0.8s ease-out;';
      document.body.appendChild(el);
      requestAnimationFrame(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 900);
      });
    }
    setTimeout(hwBloodFlash, (8 + Math.random() * 12) * 60 * 1000);
  }
  setTimeout(hwBloodFlash, (3 + Math.random() * 4) * 60 * 1000);

  // ── Halloween logo: 👁 for "i" in "mind" ────────────────────────────────────
  function applyHwLogo(el) {
    if (el.dataset.hwDone) return;
    el.dataset.hwDone = '1';
    el.innerHTML =
      '<span class="hw-logo-part">character.m</span>' +
      '<span class="hw-logo-eye">👁</span>' +
      '<span class="hw-logo-part">nd</span>';
  }
  function restoreHwLogo(el) {
    el.textContent = 'character.mind';
    delete el.dataset.hwDone;
  }
  let hwLogoObserver = new MutationObserver(muts => {
    muts.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.classList?.contains('logo-text')) applyHwLogo(n);
      n.querySelectorAll?.('.logo-text').forEach(applyHwLogo);
    }));
  });
  if (_hwMasterOn) {
    document.querySelectorAll('.logo-text').forEach(applyHwLogo);
    hwLogoObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Jump scares — 8 distinct types ─────────────────────────────────────────
  const SCARES = [
    // ── Demon face slamdowns (original style) ──────────────────────────────
    { type: 'face', boo: 'BOO!',                 speak: 'BOO' },
    { type: 'face', boo: "YOU'RE DEAD.",         speak: 'You are dead' },
    { type: 'face', boo: 'MUAHAHAHA!',           speak: 'Muahahaha' },
    { type: 'face', boo: 'BRAINSSS...',          speak: 'Braaains' },
    { type: 'face', boo: "I VANT YOUR SOUL.",    speak: 'I vant your soul' },
    { type: 'face', boo: 'EIGHT LEGS. ONE YOU.', speak: 'Eight legs. One you.' },
    { type: 'face', boo: 'I SEE YOU.',           speak: 'I see you' },
    { type: 'face', boo: 'WELCOME TO HELL.',     speak: 'Welcome to hell' },
    { type: 'face', boo: 'YOUR TIME IS UP.',     speak: 'Your time is up' },
    { type: 'face', boo: 'RUN.',                 speak: 'Run' },
    { type: 'face', boo: 'NO ESCAPE.',           speak: 'No escape' },
    { type: 'face', boo: 'THE DARK HAS COME.',   speak: 'The dark has come' },
    // ── Giant emoji zoom-slam ───────────────────────────────────────────────
    { type: 'emoji', emoji: '👻', boo: 'BOO!',             speak: 'BOO' },
    { type: 'emoji', emoji: '🕷️', boo: 'GOT YOU.',         speak: 'Got you' },
    { type: 'emoji', emoji: '💀', boo: 'DEAD.',             speak: 'Dead' },
    { type: 'emoji', emoji: '🎃', boo: 'TRICK OR TREAT!',  speak: 'Trick or treat' },
    { type: 'emoji', emoji: '🦇', boo: 'NOWHERE TO HIDE.', speak: 'Nowhere to hide' },
    { type: 'emoji', emoji: '🕸️', boo: 'TRAPPED.',         speak: 'Trapped' },
    { type: 'emoji', emoji: '🧛', boo: 'DINNER TIME.',     speak: 'Dinner time' },
    { type: 'emoji', emoji: '🧟', boo: 'BRAINSSS...',      speak: 'Braaains' },
    // ── TV static (canvas noise) ────────────────────────────────────────────
    { type: 'static', boo: 'SIGNAL LOST.',              speak: 'Signal lost' },
    { type: 'static', boo: 'THEY FOUND YOU.',           speak: 'They found you' },
    { type: 'static', boo: 'TRANSMISSION INTERRUPTED.', speak: 'Transmission interrupted' },
    // ── Blackout + lightning reveal ─────────────────────────────────────────
    { type: 'dark', boo: 'HELLO THERE.',        speak: 'Hello there' },
    { type: 'dark', boo: 'LOOK BEHIND YOU.',    speak: 'Look behind you' },
    { type: 'dark', boo: 'THE LIGHTS ARE OUT.', speak: 'The lights are out' },
    // ── Eyes closing in from all edges ─────────────────────────────────────
    { type: 'eyes', boo: 'WATCHING.',             speak: 'Watching' },
    { type: 'eyes', boo: "I'VE BEEN HERE.",       speak: "I've been here" },
    { type: 'eyes', boo: 'YOU WERE NEVER ALONE.', speak: 'You were never alone' },
    // ── Huge text crawls up from bottom ────────────────────────────────────
    { type: 'crawl', boo: 'GETTING CLOSER...', speak: 'Getting closer' },
    { type: 'crawl', boo: 'GOTCHA.',            speak: 'Gotcha' },
    { type: 'crawl', boo: 'I AM ALREADY HERE.', speak: 'I am already here' },
    // ── Spider drops from ceiling ───────────────────────────────────────────
    { type: 'spider', boo: 'HELLO FRIEND.', speak: 'Hello friend' },
    { type: 'spider', boo: 'EIGHT LEGS.',   speak: 'Eight legs' },
    // ── Page possession / invert ────────────────────────────────────────────
    { type: 'possession', boo: 'YOU CANNOT RUN.',        speak: 'You cannot run' },
    { type: 'possession', boo: 'I LIVE IN YOUR SCREEN.', speak: 'I live in your screen' },
    // ── Perspective corridor rush (Silent Hill / RE / Outlast) ─────────────
    { type: 'hallway', boo: 'THE END IS HERE.', speak: 'The end is here' },
    { type: 'hallway', boo: 'YOU CAME BACK.',   speak: 'You came back' },
    { type: 'hallway', boo: 'NO EXIT.',          speak: 'No exit' },
    // ── Security camera (FNAF / Paranormal Activity) ──────────────────────
    { type: 'security', boo: 'SECTOR BREACH.',   speak: 'Sector breach' },
    { type: 'security', boo: 'FOUND YOU.',        speak: 'Found you' },
    // ── Found footage / night-vision (Blair Witch / REC) ──────────────────
    { type: 'found', boo: 'IT SAW THE CAMERA.',  speak: 'It saw the camera' },
    { type: 'found', boo: 'LAST KNOWN FOOTAGE.', speak: 'Last known footage' },
    // ── VHS static materialising figure (The Ring) ────────────────────────
    { type: 'ring', boo: 'SEVEN DAYS.',   speak: 'Seven days' },
    { type: 'ring', boo: 'COME CLOSER.',  speak: 'Come closer' },
    // ── Mirror reflection demon ────────────────────────────────────────────
    { type: 'mirror',    boo: 'THAT IS NOT YOUR REFLECTION.', speak: 'That is not your reflection' },
    { type: 'mirror',    boo: 'IT HAS BEEN WATCHING YOU.',    speak: 'It has been watching you' },
    { type: 'mirror',    boo: 'IT NEVER LEAVES.',             speak: 'It never leaves' },
    // ── Incoming call from hell ────────────────────────────────────────────
    { type: 'phone',     boo: 'THEY KNOW WHERE YOU LIVE.',    speak: 'They know where you live' },
    { type: 'phone',     boo: 'DO NOT HANG UP.',              speak: 'Do not hang up' },
    { type: 'phone',     boo: 'ANSWER THE CALL.',             speak: 'Answer the call' },
    // ── Hands reaching through the screen ─────────────────────────────────
    { type: 'hands',     boo: 'COME WITH US.',                speak: 'Come with us' },
    { type: 'hands',     boo: 'YOU CANNOT CLOSE YOUR EYES.', speak: 'You cannot close your eyes' },
    { type: 'hands',     boo: 'WE HAVE YOU NOW.',             speak: 'We have you now' },
    // ── Single eye opens in void ───────────────────────────────────────────
    { type: 'void',      boo: 'I AM ALWAYS HERE.',            speak: 'I am always here' },
    { type: 'void',      boo: 'YOU NOTICED.',                 speak: 'You noticed' },
    { type: 'void',      boo: 'IT WAS ALWAYS WATCHING.',      speak: 'It was always watching' },
    // ── Countdown to doom ─────────────────────────────────────────────────
    { type: 'countdown', boo: 'YOUR TIME IS ENDING.',         speak: 'Your time is ending' },
    { type: 'countdown', boo: 'THERE IS NO ESCAPE.',          speak: 'There is no escape' },
    { type: 'countdown', boo: 'IT BEGINS NOW.',               speak: 'It begins now' },
    // ── Blood spreads across screen ────────────────────────────────────────
    { type: 'blood',     boo: 'I LEFT A MARK.',               speak: 'I left a mark' },
    { type: 'blood',     boo: 'IT IS ALL OVER YOU.',          speak: 'It is all over you' },
    { type: 'blood',     boo: 'YOU CANNOT WASH IT OFF.',      speak: 'You cannot wash it off' },
    // ── Asylum patient rushing at screen ──────────────────────────────────
    { type: 'asylum',    boo: 'THEY CAME FOR YOU TOO.',       speak: 'They came for you too' },
    { type: 'asylum',    boo: 'THE DOCTOR IS IN.',            speak: 'The doctor is in' },
    { type: 'asylum',    boo: 'YOU NEVER LEFT.',              speak: 'You never left' },
    // ── Clown materializes from darkness ──────────────────────────────────
    { type: 'clown',     boo: 'WE ALL FLOAT DOWN HERE.',      speak: 'We all float down here' },
    { type: 'clown',     boo: 'SMILE FOR ME.',                speak: 'Smile for me' },
    { type: 'clown',     boo: 'IT IS PLAYTIME.',              speak: 'It is playtime' },
    // ── Rising from the grave ─────────────────────────────────────────────
    { type: 'grave',     boo: 'THEY SAVED A SPOT FOR YOU.',   speak: 'They saved a spot for you' },
    { type: 'grave',     boo: 'IT IS TIME TO REST.',          speak: 'It is time to rest' },
    { type: 'grave',     boo: 'REST IN PIECES.',              speak: 'Rest in pieces' },
    // ── Words appear one by one ───────────────────────────────────────────
    { type: 'whisper',   boo: 'I KNOW YOUR NAME.',            speak: 'I know your name' },
    { type: 'whisper',   boo: 'I KNOW WHERE YOU SLEEP.',      speak: 'I know where you sleep' },
    { type: 'whisper',   boo: 'YOU CANNOT HIDE FROM ME.',     speak: 'You cannot hide from me' },
    // ── Figure crawls across ceiling ──────────────────────────────────────
    { type: 'ceiling',   boo: 'ABOVE YOU.',                   speak: 'Above you' },
    { type: 'ceiling',   boo: 'LOOK UP.',                     speak: 'Look up' },
    { type: 'ceiling',   boo: 'IT NEVER TOUCHES THE FLOOR.',  speak: 'It never touches the floor' },
    // ── Hospital horror ───────────────────────────────────────────────────
    { type: 'hospital',  boo: 'PATIENT ZERO.',                speak: 'Patient zero' },
    { type: 'hospital',  boo: 'CODE BLACK.',                  speak: 'Code black' },
    { type: 'hospital',  boo: 'DO NOT RESUSCITATE.',          speak: 'Do not resuscitate' },
  ];

  // ── Spoken subtitle shown during every scare ────────────────────────────────
  function hwSubtitle(text, dur) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed;bottom:7%;left:50%;transform:translateX(-50%);z-index:100001;',
      'font-family:"Courier New",Courier,monospace;font-size:min(2.8vw,18px);',
      'color:#fff;background:rgba(0,0,0,.78);padding:7px 20px;border-radius:4px;',
      'text-shadow:1px 1px 2px #000,0 0 12px rgba(200,0,0,0.55);letter-spacing:.06em;',
      'pointer-events:none;opacity:0;transition:opacity .18s;',
      'max-width:80vw;text-align:center;white-space:normal;',
      'border:1px solid rgba(180,0,0,.35);box-shadow:0 0 18px rgba(150,0,0,.25);',
    ].join('');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '1'; }, 120);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => { try { el.remove(); } catch(_){} }, 300); }, Math.max(400, dur - 350));
  }

  // ── HORROR SOUND — sustained screech + bone-crushing bass + demon roar ────────
  function hwScareSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t = ctx.currentTime;
      const sr = ctx.sampleRate;

      // Limiter — hard ceiling so it's still safe at max but significantly louder
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10; limiter.knee.value = 4;
      limiter.ratio.value = 18; limiter.attack.value = 0.001; limiter.release.value = 0.08;
      limiter.connect(ctx.destination);
      const master = ctx.createGain();
      master.gain.value = 0.62 * (hwVol / 100);
      master.connect(limiter);

      // 1. INSTANT CRACK — white noise burst, sounds like electricity / jump impact
      const crackBuf = ctx.createBuffer(1, Math.floor(sr * 0.12), sr);
      const crackD = crackBuf.getChannelData(0);
      for (let i = 0; i < crackD.length; i++) crackD[i] = Math.random() * 2 - 1;
      const crack = ctx.createBufferSource();
      const crackG = ctx.createGain();
      crack.buffer = crackBuf;
      crackG.gain.setValueAtTime(0, t);
      crackG.gain.linearRampToValueAtTime(3.5, t + 0.003); // instantaneous spike
      crackG.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      crack.connect(crackG); crackG.connect(master);
      crack.start(t);

      // 2. SUB-BASS CANNON — moves your speakers / headphones
      const sub = ctx.createOscillator();
      const subG = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(85, t);
      sub.frequency.exponentialRampToValueAtTime(10, t + 0.85);
      subG.gain.setValueAtTime(0, t);
      subG.gain.linearRampToValueAtTime(3.2, t + 0.008);
      subG.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      sub.connect(subG); subG.connect(master);
      sub.start(t); sub.stop(t + 0.95);

      // 3. THE SCREECH — sustained 2.8s high-pitched sawtooth, hard-clipped
      //    This is the sound that defines horror game jump scares
      const screech = ctx.createOscillator();
      const screechClip = ctx.createWaveShaper();
      const screechLpf = ctx.createBiquadFilter();
      const screechEnv = ctx.createGain();
      const clipCurve = new Float32Array(4096);
      for (let i = 0; i < 4096; i++) {
        const x = (i * 2) / 4096 - 1;
        clipCurve[i] = Math.max(-0.55, Math.min(0.55, x * 5)); // hard clip at ±0.55
      }
      screechClip.curve = clipCurve; screechClip.oversample = '4x';
      screech.type = 'sawtooth';
      screech.frequency.setValueAtTime(3900, t);
      screech.frequency.linearRampToValueAtTime(2400, t + 2.8); // pitch slowly falls
      screechLpf.type = 'highpass'; screechLpf.frequency.value = 2000; // keep it piercing
      screechEnv.gain.setValueAtTime(0, t);
      screechEnv.gain.linearRampToValueAtTime(2.2, t + 0.015); // INSTANT attack
      screechEnv.gain.setValueAtTime(2.2, t + 0.6);
      screechEnv.gain.exponentialRampToValueAtTime(0.001, t + 2.9);
      screech.connect(screechClip); screechClip.connect(screechLpf); screechLpf.connect(screechEnv); screechEnv.connect(master);
      screech.start(t); screech.stop(t + 3.0);

      // 4. SCREECH HARMONIC — second layer offset slightly for psychoacoustic chaos
      const screech2 = ctx.createOscillator();
      const s2Clip = ctx.createWaveShaper();
      const s2Env = ctx.createGain();
      const clip2 = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) { const x = (i * 2) / 2048 - 1; clip2[i] = Math.tanh(x * 10) * 0.5; }
      s2Clip.curve = clip2; s2Clip.oversample = '2x';
      screech2.type = 'square';
      screech2.frequency.setValueAtTime(4700, t + 0.06);
      screech2.frequency.linearRampToValueAtTime(2900, t + 2.8);
      s2Env.gain.setValueAtTime(0, t + 0.06);
      s2Env.gain.linearRampToValueAtTime(1.0, t + 0.1);
      s2Env.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
      screech2.connect(s2Clip); s2Clip.connect(s2Env); s2Env.connect(master);
      screech2.start(t + 0.06); screech2.stop(t + 2.9);

      // 5. DEMON ROAR — brutal low sawtooth with max distortion
      const growl = ctx.createOscillator();
      const growlDist = ctx.createWaveShaper();
      const growlG = ctx.createGain();
      const gc = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = (i * 2) / 1024 - 1; gc[i] = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * 22)); }
      growlDist.curve = gc; growlDist.oversample = '4x';
      growl.type = 'sawtooth';
      growl.frequency.setValueAtTime(48, t);
      growl.frequency.setValueAtTime(95, t + 0.06);
      growl.frequency.exponentialRampToValueAtTime(30, t + 1.5);
      growlG.gain.setValueAtTime(1.5, t);
      growlG.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
      growl.connect(growlDist); growlDist.connect(growlG); growlG.connect(master);
      growl.start(t); growl.stop(t + 1.7);

      // 6. HUMAN SCREAM SIMULATION — band-pass filtered noise through vocal formants
      const screamBuf = ctx.createBuffer(1, Math.floor(sr * 2.2), sr);
      const sd = screamBuf.getChannelData(0);
      for (let i = 0; i < sd.length; i++) sd[i] = Math.random() * 2 - 1;
      // F1 (~850Hz) and F2 (~2400Hz) — the two key screaming formants
      [850, 2400].forEach((freq, fi) => {
        const src = ctx.createBufferSource();
        const flt = ctx.createBiquadFilter();
        const gn  = ctx.createGain();
        src.buffer = screamBuf;
        flt.type = 'bandpass'; flt.frequency.value = freq; flt.Q.value = fi === 0 ? 14 : 9;
        gn.gain.setValueAtTime(0, t + 0.04);
        gn.gain.linearRampToValueAtTime(fi === 0 ? 1.8 : 1.3, t + 0.1);
        gn.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
        src.connect(flt); flt.connect(gn); gn.connect(master);
        src.start(t + 0.04); src.stop(t + 2.3);
      });

      // 7. RING MODULATOR — unearthly alien screaming texture
      const carrier = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const ringG = ctx.createGain();
      const ringOut = ctx.createGain();
      carrier.type = 'sawtooth'; carrier.frequency.setValueAtTime(200, t); carrier.frequency.linearRampToValueAtTime(50, t + 1.8);
      mod.type = 'sine'; mod.frequency.setValueAtTime(45, t); mod.frequency.linearRampToValueAtTime(24, t + 1.8);
      ringG.gain.value = 0; mod.connect(ringG.gain); carrier.connect(ringG);
      ringOut.gain.setValueAtTime(0, t); ringOut.gain.linearRampToValueAtTime(0.7, t + 0.12); ringOut.gain.exponentialRampToValueAtTime(0.001, t + 1.9);
      ringG.connect(ringOut); ringOut.connect(master);
      carrier.start(t); carrier.stop(t + 2.0);
      mod.start(t); mod.stop(t + 2.0);

      setTimeout(() => { try { ctx.close(); } catch(_){} }, 4000);
    } catch(_) {}
  }

  // SVG demon face — grotesque horror, fills the jump scare overlay
  function hwDemonFaceSVG() {
    return `<svg viewBox="0 0 300 330" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="eg" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stop-color="#ff4400"/>
          <stop offset="30%" stop-color="#cc0000"/>
          <stop offset="70%" stop-color="#550000"/>
          <stop offset="100%" stop-color="#000"/>
        </radialGradient>
        <radialGradient id="bg2" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#300000"/>
          <stop offset="100%" stop-color="#000"/>
        </radialGradient>
        <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <filter id="bloodGlow"><feGaussianBlur stdDeviation="2"/></filter>
      </defs>

      <!-- Skull base — dead gray necrotic skin -->
      <ellipse cx="150" cy="162" rx="132" ry="150" fill="#3a2a22"/>

      <!-- Exposed skull / bone cracks breaking through skin -->
      <path d="M80 30 Q90 18 110 22 Q120 14 135 20 Q148 8 162 18 Q176 12 190 24 Q205 18 218 30" stroke="#d4c8b0" stroke-width="3.5" fill="none" opacity=".85"/>
      <path d="M100 40 Q108 28 118 36 Q126 22 140 32" stroke="#c8bcaa" stroke-width="2.5" fill="none" opacity=".7"/>
      <path d="M162 36 Q172 24 183 34 Q193 20 205 32" stroke="#c8bcaa" stroke-width="2.5" fill="none" opacity=".7"/>
      <!-- Bone showing through forehead -->
      <ellipse cx="150" cy="48" rx="42" ry="18" fill="#cdc2aa" opacity=".55"/>
      <ellipse cx="106" cy="56" rx="22" ry="10" fill="#bfb498" opacity=".4"/>
      <ellipse cx="194" cy="56" rx="22" ry="10" fill="#bfb498" opacity=".4"/>

      <!-- Deep gash cracks in skin revealing flesh/bone -->
      <path d="M62 90 L78 102 L66 118 L82 130" stroke="#8b0000" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M64 91 L80 103 L68 119 L84 131" stroke="#cc2200" stroke-width="2" fill="none" opacity=".6"/>
      <path d="M238 88 L222 100 L234 116 L218 130" stroke="#8b0000" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M236 89 L220 101 L232 117 L216 131" stroke="#cc2200" stroke-width="2" fill="none" opacity=".6"/>

      <!-- Forehead gash with stitches -->
      <path d="M110 72 Q130 62 150 68 Q170 62 190 72" stroke="#6b0000" stroke-width="6" fill="none" stroke-linecap="round"/>
      <path d="M110 72 Q130 62 150 68 Q170 62 190 72" stroke="#cc0000" stroke-width="2" fill="none" opacity=".7"/>
      <line x1="118" y1="65" x2="118" y2="80" stroke="#440000" stroke-width="2.5"/>
      <line x1="130" y1="62" x2="130" y2="77" stroke="#440000" stroke-width="2.5"/>
      <line x1="142" y1="60" x2="142" y2="76" stroke="#440000" stroke-width="2.5"/>
      <line x1="158" y1="60" x2="158" y2="76" stroke="#440000" stroke-width="2.5"/>
      <line x1="170" y1="62" x2="170" y2="77" stroke="#440000" stroke-width="2.5"/>
      <line x1="182" y1="65" x2="182" y2="80" stroke="#440000" stroke-width="2.5"/>

      <!-- Deep sunken eye sockets — cavernous and wrong -->
      <ellipse cx="88" cy="133" rx="54" ry="48" fill="#050000" stroke="#3a0000" stroke-width="4"/>
      <ellipse cx="212" cy="133" rx="54" ry="48" fill="#050000" stroke="#3a0000" stroke-width="4"/>
      <!-- Necrotic skin folds around eyes -->
      <path d="M40 108 Q60 90 100 100 Q118 106 114 134" stroke="#2a0000" stroke-width="6" fill="none"/>
      <path d="M260 108 Q240 90 200 100 Q182 106 186 134" stroke="#2a0000" stroke-width="6" fill="none"/>

      <!-- Bloodshot sclera (whites of eyes, filled with red veins) -->
      <circle cx="88" cy="133" r="36" fill="#ffe8e8"/>
      <circle cx="212" cy="133" r="36" fill="#ffe8e8"/>
      <!-- Red veins radiating across sclera -->
      <line x1="66" y1="115" x2="80" y2="126" stroke="#cc0000" stroke-width="1.2" opacity=".8"/>
      <line x1="58" y1="130" x2="72" y2="130" stroke="#cc0000" stroke-width="1.2" opacity=".7"/>
      <line x1="64" y1="148" x2="78" y2="140" stroke="#cc0000" stroke-width="1.2" opacity=".8"/>
      <line x1="100" y1="112" x2="94" y2="122" stroke="#cc0000" stroke-width="1.2" opacity=".7"/>
      <line x1="108" y1="128" x2="96" y2="130" stroke="#cc0000" stroke-width="1.0" opacity=".7"/>
      <line x1="190" y1="115" x2="204" y2="126" stroke="#cc0000" stroke-width="1.2" opacity=".8"/>
      <line x1="240" y1="130" x2="226" y2="130" stroke="#cc0000" stroke-width="1.2" opacity=".7"/>
      <line x1="236" y1="148" x2="222" y2="140" stroke="#cc0000" stroke-width="1.2" opacity=".8"/>
      <line x1="194" y1="112" x2="200" y2="122" stroke="#cc0000" stroke-width="1.0" opacity=".7"/>

      <!-- Iris — oversized, wrong color, predatory -->
      <circle cx="88" cy="133" r="24" fill="url(#eg)" filter="url(#glow)"/>
      <circle cx="212" cy="133" r="24" fill="url(#eg)" filter="url(#glow)"/>
      <!-- Contracted slit pupil (vertical, reptilian) -->
      <ellipse cx="88"  cy="133" rx="5" ry="18" fill="#000"/>
      <ellipse cx="212" cy="133" rx="5" ry="18" fill="#000"/>
      <!-- Eye glint -->
      <ellipse cx="98"  cy="122" rx="6" ry="5" fill="rgba(255,200,200,.7)"/>
      <ellipse cx="222" cy="122" rx="6" ry="5" fill="rgba(255,200,200,.7)"/>

      <!-- Nose — just a rotting void with exposed cartilage -->
      <ellipse cx="150" cy="198" rx="18" ry="14" fill="#050000"/>
      <path d="M136 196 Q142 188 150 192 Q158 188 164 196" stroke="#2a0000" stroke-width="3" fill="none"/>
      <!-- Exposed nasal bone -->
      <path d="M144 190 Q150 182 156 190" stroke="#b8a898" stroke-width="2.5" fill="none" opacity=".6"/>

      <!-- Stretched / torn cheek wound with stitches -->
      <path d="M42 172 Q60 160 80 168 Q88 174 78 185 Q62 194 44 185 Z" fill="#3a0000" opacity=".7"/>
      <path d="M44 175 Q62 163 79 170" stroke="#cc0000" stroke-width="2" fill="none"/>
      <line x1="52" y1="166" x2="52" y2="182" stroke="#550000" stroke-width="2"/>
      <line x1="62" y1="162" x2="62" y2="178" stroke="#550000" stroke-width="2"/>
      <line x1="72" y1="164" x2="72" y2="180" stroke="#550000" stroke-width="2"/>
      <!-- Right cheek wound -->
      <path d="M258 172 Q240 160 220 168 Q212 174 222 185 Q238 194 256 185 Z" fill="#3a0000" opacity=".7"/>
      <path d="M256 175 Q238 163 221 170" stroke="#cc0000" stroke-width="2" fill="none"/>
      <line x1="248" y1="166" x2="248" y2="182" stroke="#550000" stroke-width="2"/>
      <line x1="238" y1="162" x2="238" y2="178" stroke="#550000" stroke-width="2"/>
      <line x1="228" y1="164" x2="228" y2="180" stroke="#550000" stroke-width="2"/>

      <!-- Gaping maw — wider, more jagged -->
      <path d="M30 260 Q70 235 150 240 Q230 235 270 260 Q248 332 150 340 Q52 332 30 260Z" fill="#030000"/>
      <!-- Gum/flesh border — raw and infected -->
      <path d="M32 262 Q72 240 150 244 Q228 240 268 262" stroke="#550000" stroke-width="4" fill="none"/>

      <!-- Teeth — uneven, broken, some missing, some extra-long -->
      <path d="M54 258 L58 298 L64 258" fill="#d0cfc0"/>
      <path d="M68 252 L73 298 L79 252" fill="#c8c7b8"/>
      <path d="M83 248 L89 300 L95 248" fill="#d4d3c4"/>
      <!-- Broken tooth with exposed pulp -->
      <path d="M100 246 L104 285 L109 265 L113 246" fill="#c8c7b8"/>
      <path d="M104 285 L109 265" stroke="#880000" stroke-width="2.5"/>
      <path d="M118 244 L124 302 L130 244" fill="#ccc8b8"/>
      <path d="M136 242 L142 303 L148 242" fill="#d0cfc0"/>
      <path d="M152 242 L158 303 L164 242" fill="#d0cfc0"/>
      <path d="M170 244 L176 302 L182 244" fill="#ccc8b8"/>
      <!-- Extra-long fang-like tooth -->
      <path d="M188 246 L192 310 L197 246" fill="#c4c3b4"/>
      <path d="M203 248 L207 298 L212 248" fill="#c8c7b8"/>
      <path d="M218 252 L222 296 L228 252" fill="#d0cfc0"/>
      <path d="M234 258 L238 292 L244 258" fill="#c8c7b8"/>

      <!-- Blood pooling at mouth corners -->
      <ellipse cx="150" cy="315" rx="62" ry="22" fill="#6a0000"/>
      <path d="M94 298 Q150 336 206 298" fill="#500000"/>
      <!-- Dripping blood from mouth -->
      <path d="M120 302 Q118 316 122 328 Q120 338 118 348" stroke="#8b0000" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <circle cx="117" cy="350" r="5.5" fill="#8b0000"/>
      <path d="M150 305 Q148 322 152 338 Q150 350 148 362" stroke="#aa0000" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="147" cy="364" r="7" fill="#aa0000"/>
      <path d="M180 302 Q182 316 178 328 Q180 340 182 350" stroke="#8b0000" stroke-width="3" fill="none" stroke-linecap="round"/>
      <circle cx="183" cy="352" r="5" fill="#8b0000"/>

      <!-- Forehead blood drips from cranial cracks -->
      <path d="M134 28 Q132 48 136 68 Q134 82 132 98" stroke="#8b0000" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      <circle cx="131" cy="101" r="8" fill="#8b0000"/>
      <path d="M166 22 Q168 44 164 62 Q166 76 168 92" stroke="#aa0000" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <circle cx="169" cy="95" r="6" fill="#aa0000"/>
      <path d="M110 40 Q108 56 112 72" stroke="#770000" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <circle cx="112" cy="75" r="4.5" fill="#770000"/>
      <path d="M192 38 Q194 54 190 70" stroke="#770000" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <circle cx="190" cy="73" r="4" fill="#770000"/>

      <!-- Blood streaks down cheeks -->
      <path d="M52 148 Q46 172 50 200 Q48 218 44 236" stroke="#770000" stroke-width="3" fill="none" opacity=".7" stroke-linecap="round"/>
      <path d="M248 148 Q254 172 250 200 Q252 218 256 236" stroke="#770000" stroke-width="3" fill="none" opacity=".7" stroke-linecap="round"/>

      <!-- Side blood drips (large drops) -->
      <path d="M38 270 Q28 290 32 314 Q30 328 28 344" stroke="#8b0000" stroke-width="5" fill="none" stroke-linecap="round"/>
      <circle cx="27" cy="347" r="8" fill="#8b0000"/>
      <path d="M262 270 Q272 292 268 316 Q270 330 272 346" stroke="#8b0000" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      <circle cx="273" cy="349" r="7" fill="#8b0000"/>

      <!-- Dark rot / necrosis patches -->
      <ellipse cx="72" cy="158" rx="18" ry="12" fill="#1a0000" opacity=".6"/>
      <ellipse cx="228" cy="158" rx="18" ry="12" fill="#1a0000" opacity=".6"/>
      <ellipse cx="150" cy="225" rx="25" ry="12" fill="#1a0000" opacity=".5"/>
    </svg>`;
  }

  // Demonic speech: Web Speech API at minimum pitch + simultaneous Web Audio hell-choir
  function hwDemonSpeak(text) {
    // ── Web Speech: absolute floor pitch + dead-slow rate ──────────────────────
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.pitch  = 0;      // floor — browser clamps above 0 internally
      utt.rate   = 0.35;   // extremely slow, drawn out
      utt.volume = 0.85 * (hwVol / 100);
      const voices = window.speechSynthesis.getVoices();
      // Prefer the deepest available male voice
      const deep = voices.find(v => /male|david|alex|daniel|fred|ralph|microsoft david/i.test(v.name) && /en/i.test(v.lang))
                || voices.find(v => /en/i.test(v.lang));
      if (deep) utt.voice = deep;
      window.speechSynthesis.speak(utt);
    } catch(_) {}

    // ── Web Audio: hell-choir layer that plays UNDER the speech ────────────────
    // Web Speech audio cannot be intercepted, so we layer a separate audio context
    // playing demon-resonance tones simultaneously to create the impression of distortion.
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t = ctx.currentTime;
      const dur = 4.5; // duration matching slow speech
      const master = ctx.createGain();
      master.gain.value = 0.2 * (hwVol / 100);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 8; comp.attack.value = 0.005;
      master.connect(comp); comp.connect(ctx.destination);

      // Layer 1: Sub-bass demon body (ultra-low sawtooth with hard-clipping distortion)
      const sub = ctx.createOscillator();
      sub.type = 'sawtooth';
      sub.frequency.setValueAtTime(58, t);
      sub.frequency.exponentialRampToValueAtTime(22, t + dur);
      const subDist = ctx.createWaveShaper();
      const sdc = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = (i * 2) / 1024 - 1; sdc[i] = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * 28)); }
      subDist.curve = sdc; subDist.oversample = '4x';
      const subG = ctx.createGain();
      subG.gain.setValueAtTime(0, t);
      subG.gain.linearRampToValueAtTime(0.55, t + 0.12);
      subG.gain.setValueAtTime(0.55, t + dur - 0.5);
      subG.gain.exponentialRampToValueAtTime(0.001, t + dur);
      sub.connect(subDist); subDist.connect(subG); subG.connect(master);
      sub.start(t); sub.stop(t + dur + 0.1);

      // Layer 2: Stacked detuned hell-choir (3 slightly-off frequencies → unearthly chorus)
      [62, 66, 54].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.linearRampToValueAtTime(freq * 0.72, t + dur);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0, t + i * 0.06);
        og.gain.linearRampToValueAtTime(0.18, t + 0.25 + i * 0.06);
        og.gain.exponentialRampToValueAtTime(0.001, t + dur - 0.1);
        osc.connect(og); og.connect(master);
        osc.start(t + i * 0.05); osc.stop(t + dur);
      });

      // Layer 3: Ring modulator for alien-metallic texture
      const carrier = ctx.createOscillator();
      const mod     = ctx.createOscillator();
      const ringG   = ctx.createGain();
      const ringOut = ctx.createGain();
      carrier.type = 'sawtooth'; carrier.frequency.setValueAtTime(110, t); carrier.frequency.linearRampToValueAtTime(40, t + dur);
      mod.type     = 'sine';     mod.frequency.setValueAtTime(48, t);     mod.frequency.linearRampToValueAtTime(20, t + dur);
      ringG.gain.value = 0;
      mod.connect(ringG.gain);
      carrier.connect(ringG);
      ringOut.gain.setValueAtTime(0, t);
      ringOut.gain.linearRampToValueAtTime(0.35, t + 0.15);
      ringOut.gain.exponentialRampToValueAtTime(0.001, t + dur);
      ringG.connect(ringOut); ringOut.connect(master);
      carrier.start(t); carrier.stop(t + dur);
      mod.start(t); mod.stop(t + dur);

      // Layer 4: Growling noise bursts — random sputtering demonic breaths
      for (let b = 0; b < 5; b++) {
        const bt = t + 0.3 + b * 0.7 + Math.random() * 0.3;
        const nBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
        const nd = nBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        const nSrc = ctx.createBufferSource();
        const nFlt = ctx.createBiquadFilter();
        const nG   = ctx.createGain();
        nSrc.buffer = nBuf;
        nFlt.type = 'bandpass'; nFlt.frequency.value = 120 + b * 40; nFlt.Q.value = 8;
        nG.gain.setValueAtTime(0, bt); nG.gain.linearRampToValueAtTime(0.4, bt + 0.01); nG.gain.exponentialRampToValueAtTime(0.001, bt + 0.09);
        nSrc.connect(nFlt); nFlt.connect(nG); nG.connect(master);
        nSrc.start(bt); nSrc.stop(bt + 0.12);
      }

      setTimeout(() => { try { ctx.close(); } catch(_){} }, (dur + 1) * 1000);
    } catch(_) {}
  }

  // Spawn floating eyes around the screen edges during scare
  function hwSpawnEyes() {
    const positions = [
      [2, 8], [92, 5], [1, 55], [96, 48], [15, 92], [80, 88], [48, 3], [55, 95]
    ];
    const eyes = [];
    positions.forEach(([l, t]) => {
      const e = document.createElement('div');
      e.className = 'hw-scare-eye';
      e.textContent = '👁️';
      e.style.cssText = `left:${l}%;top:${t}%;animation-delay:${Math.random() * 0.15}s`;
      document.body.appendChild(e);
      eyes.push(e);
    });
    return eyes;
  }

  let _scareTimer = null;

  function doJumpScare() {
    _scareTimer = null;
    if (hwPaused || !hwScares) return;
    if (document.hidden) return scheduleNextScare();
    const s = SCARES[Math.floor(Math.random() * SCARES.length)];

    hwScareSound();
    setTimeout(() => hwDemonSpeak(s.speak), 100);
    hwSubtitle(s.speak, 2800);

    function flashScreen(count) {
      if (count <= 0) return;
      const f = document.createElement('div');
      f.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99998;pointer-events:none';
      document.body.appendChild(f);
      setTimeout(() => { f.style.transition='opacity 0.04s'; f.style.opacity='0'; setTimeout(() => f.remove(), 55); }, 35);
      if (count > 1) setTimeout(() => flashScreen(count - 1), 85);
    }

    const type = s.type || 'face';
    if      (type === 'face')       _scareFace(s);
    else if (type === 'emoji')      _scareEmoji(s);
    else if (type === 'static')     _scareStatic(s);
    else if (type === 'dark')       _scareDark(s);
    else if (type === 'eyes')       _scareEyes(s);
    else if (type === 'crawl')      _scareCrawl(s);
    else if (type === 'spider')     _scareSpider(s);
    else if (type === 'possession') _scarePossession(s);
    else if (type === 'hallway')    _scareHallway(s);
    else if (type === 'security')   _scareSecurity(s);
    else if (type === 'found')      _scareFound(s);
    else if (type === 'ring')       _scareRing(s);
    else if (type === 'mirror')     _scareMirror(s);
    else if (type === 'phone')      _scarePhone(s);
    else if (type === 'hands')      _scareHands(s);
    else if (type === 'void')       _scareVoid(s);
    else if (type === 'countdown')  _scareCountdown(s);
    else if (type === 'blood')      _scareBlood(s);
    else if (type === 'asylum')     _scareAsylum(s);
    else if (type === 'clown')      _scareClown(s);
    else if (type === 'grave')      _scareGrave(s);
    else if (type === 'whisper')    _scareWhisper(s);
    else if (type === 'ceiling')    _scareCeiling(s);
    else if (type === 'hospital')   _scareHospital(s);
    else                            _scareFace(s);

    scheduleNextScare();

    // ── Renderer: demon face slam (original) ─────────────────────────────
    function _scareFace(s) {
      flashScreen(3);
      document.body.classList.add('hw-screaming');
      const glitch = document.createElement('div');
      glitch.className = 'hw-glitch-overlay';
      document.body.appendChild(glitch);
      let flickers = 0;
      const fi = setInterval(() => {
        glitch.style.opacity = Math.random() > 0.28 ? String(0.18 + Math.random() * 0.5) : '0';
        glitch.style.transform = Math.random() > 0.7 ? `translateX(${(Math.random()-0.5)*14}px)` : 'none';
        if (++flickers > 22) clearInterval(fi);
      }, 50);
      const eyes = hwSpawnEyes();
      const el = document.createElement('div');
      el.className = 'hw-jump-scare';
      el.innerHTML = `<div class="hw-js-inner"><div class="hw-js-face">${hwDemonFaceSVG()}</div><div class="hw-js-boo">${s.boo}</div></div>`;
      document.body.appendChild(el);
      requestAnimationFrame(() => {
        el.classList.add('hw-scare-active');
        setTimeout(() => {
          el.classList.remove('hw-scare-active'); el.classList.add('hw-scare-out');
          clearInterval(fi); glitch.style.opacity = '0';
          document.body.classList.remove('hw-screaming');
          eyes.forEach(e => { e.style.opacity='0'; setTimeout(() => e.remove(), 400); });
          setTimeout(() => { el.remove(); glitch.remove(); window.speechSynthesis?.cancel(); }, 600);
        }, 2500);
      });
    }

    // ── Renderer: giant emoji zoom-slams in ──────────────────────────────
    function _scareEmoji(s) {
      flashScreen(2);
      document.body.classList.add('hw-screaming');
      const el = document.createElement('div');
      el.className = 'hw-jump-scare hw-scare-emoji-type';
      el.style.cssText = 'opacity:1;background:rgba(0,0,0,0.88);';
      el.innerHTML = `
        <div class="hw-emoji-slam">${s.emoji}</div>
        <div class="hw-js-boo" style="margin-top:16px">${s.boo}</div>`;
      document.body.appendChild(el);
      setTimeout(() => {
        el.classList.add('hw-scare-out');
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { el.remove(); window.speechSynthesis?.cancel(); }, 600);
      }, 2000);
    }

    // ── Renderer: TV static (canvas noise) ───────────────────────────────
    function _scareStatic(s) {
      document.body.classList.add('hw-screaming');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;pointer-events:none;image-rendering:pixelated;';
      canvas.width = 320; canvas.height = 240;
      document.body.appendChild(canvas);
      const cx = canvas.getContext('2d');
      let rafId;
      (function draw() {
        const img = cx.createImageData(320, 240);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = Math.random() > 0.5 ? 200 + Math.random()*55 : Math.floor(Math.random()*40);
          img.data[i]=v; img.data[i+1]=v; img.data[i+2]=v; img.data[i+3]=220;
        }
        cx.putImageData(img, 0, 0);
        rafId = requestAnimationFrame(draw);
      })();
      const txt = document.createElement('div');
      txt.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;pointer-events:none;';
      txt.innerHTML = `<div style="font-family:Impact,Arial Black,sans-serif;font-size:min(11vw,9vh);color:#f00;text-shadow:0 0 24px #f00,2px 2px 0 #000;text-align:center;letter-spacing:.05em;animation:hwBooFlash .12s step-end 10">${s.boo}</div>`;
      document.body.appendChild(txt);
      setTimeout(() => {
        cancelAnimationFrame(rafId);
        canvas.style.transition='opacity .3s'; canvas.style.opacity='0';
        txt.style.transition='opacity .3s'; txt.style.opacity='0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { canvas.remove(); txt.remove(); window.speechSynthesis?.cancel(); }, 400);
      }, 2300);
    }

    // ── Renderer: blackout + lightning flash ─────────────────────────────
    function _scareDark(s) {
      const dark = document.createElement('div');
      dark.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99999;pointer-events:none;opacity:0;transition:opacity .06s';
      document.body.appendChild(dark);
      requestAnimationFrame(() => { dark.style.opacity = '1'; });
      const flash = (bg, dur, cb) => {
        dark.style.transition='none'; dark.style.background=bg;
        setTimeout(() => { dark.style.background='#000'; cb && setTimeout(cb,50); }, dur);
      };
      setTimeout(() => {
        flash('#fff', 70, () => {
          const skull = document.createElement('div');
          skull.style.cssText='position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;pointer-events:none;';
          skull.innerHTML='<div style="font-size:min(55vw,55vh);line-height:1;filter:drop-shadow(0 0 40px #f00)">💀</div>';
          document.body.appendChild(skull);
          setTimeout(() => skull.remove(), 130);
        });
        setTimeout(() => {
          flash('#fff', 55, null);
          setTimeout(() => {
            const txt = document.createElement('div');
            txt.style.cssText='position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;pointer-events:none;';
            txt.innerHTML=`<div style="font-family:Impact,Arial Black,sans-serif;font-size:min(9vw,7vh);color:#f00;text-shadow:0 0 30px #f00;text-align:center;letter-spacing:.08em">${s.boo}</div>`;
            document.body.appendChild(txt);
            setTimeout(() => {
              dark.style.transition='opacity .45s'; dark.style.opacity='0';
              txt.style.transition='opacity .3s'; txt.style.opacity='0';
              setTimeout(() => { dark.remove(); txt.remove(); window.speechSynthesis?.cancel(); }, 500);
            }, 1300);
          }, 320);
        }, 750);
      }, 380);
    }

    // ── Renderer: eyes close in from all edges ───────────────────────────
    function _scareEyes(s) {
      flashScreen(1);
      const wrap = document.createElement('div');
      wrap.style.cssText='position:fixed;inset:0;z-index:99999;pointer-events:none;background:rgba(0,0,0,.75);';
      document.body.appendChild(wrap);
      const pts = [
        {x:'4%',y:'12%'},{x:'82%',y:'8%'},{x:'1%',y:'50%'},{x:'90%',y:'46%'},
        {x:'8%',y:'82%'},{x:'78%',y:'78%'},{x:'44%',y:'3%'},{x:'42%',y:'90%'},
      ];
      pts.forEach((p,i) => {
        const eye = document.createElement('div');
        eye.style.cssText=`position:absolute;font-size:min(6vw,6vh);left:${p.x};top:${p.y};transform:translate(-50%,-50%);
          transition:left ${1.4+i*.08}s ease-in,top ${1.4+i*.08}s ease-in,font-size ${1.4+i*.08}s ease-in;
          line-height:1;filter:drop-shadow(0 0 8px #f00);opacity:0;`;
        eye.textContent='👁️';
        wrap.appendChild(eye);
        setTimeout(() => { eye.style.opacity='1'; }, 40+i*60);
        setTimeout(() => { eye.style.left='50%'; eye.style.top='50%'; eye.style.fontSize='min(20vw,20vh)'; }, 300+i*40);
      });
      const txt = document.createElement('div');
      txt.style.cssText='position:absolute;bottom:12%;left:50%;transform:translateX(-50%);white-space:nowrap;opacity:0;transition:opacity .3s;font-family:Impact,Arial Black,sans-serif;font-size:min(7vw,5vh);color:#f00;text-shadow:0 0 20px #f00;letter-spacing:.08em;';
      txt.textContent=s.boo; wrap.appendChild(txt);
      setTimeout(() => { txt.style.opacity='1'; }, 1300);
      setTimeout(() => {
        wrap.style.transition='opacity .5s'; wrap.style.opacity='0';
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 600);
      }, 2900);
    }

    // ── Renderer: text crawls up from bottom, grows huge ─────────────────
    function _scareCrawl(s) {
      flashScreen(2);
      document.body.classList.add('hw-screaming');
      const el = document.createElement('div');
      el.style.cssText=`position:fixed;bottom:-80px;left:50%;transform:translateX(-50%);
        font-family:Impact,Arial Black,sans-serif;color:#f00;white-space:nowrap;
        text-shadow:0 0 30px #f00,0 0 60px #900;z-index:99999;pointer-events:none;
        letter-spacing:.05em;font-size:10px;opacity:.8;
        transition:bottom 1.5s cubic-bezier(.25,.46,.45,.94),font-size 1.5s cubic-bezier(.25,.46,.45,.94),opacity .2s;`;
      el.textContent = s.boo;
      document.body.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.bottom='30%'; el.style.fontSize='min(14vw,17vh)';
      }));
      setTimeout(() => {
        el.style.transition='all .35s ease-in';
        el.style.fontSize='min(38vw,42vh)'; el.style.bottom='18%'; el.style.opacity='.25';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { el.remove(); window.speechSynthesis?.cancel(); }, 450);
      }, 1900);
    }

    // ── Renderer: spider drops from ceiling on a thread ──────────────────
    function _scareSpider(s) {
      flashScreen(2);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText='position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;pointer-events:none;display:flex;flex-direction:column;align-items:center;';
      const thread = document.createElement('div');
      thread.style.cssText='width:2px;background:rgba(255,255,255,.55);height:0;transition:height .55s linear;';
      const spider = document.createElement('div');
      spider.style.cssText=`font-size:min(28vw,32vh);line-height:1;
        transform:translateY(-250px);opacity:0;
        transition:transform .55s cubic-bezier(.25,.46,.45,.94),opacity .1s;
        filter:drop-shadow(0 0 24px #f00);`;
      spider.textContent='🕷️';
      const txt = document.createElement('div');
      txt.style.cssText=`font-family:Impact,Arial Black,sans-serif;font-size:min(7vw,6vh);color:#f00;
        text-shadow:0 0 20px #f00;letter-spacing:.08em;margin-top:8px;opacity:0;transition:opacity .2s;`;
      txt.textContent=s.boo;
      wrap.append(thread,spider,txt); document.body.appendChild(wrap);
      requestAnimationFrame(() => {
        thread.style.height='38vh'; spider.style.transform='translateY(0)'; spider.style.opacity='1';
        setTimeout(() => { txt.style.opacity='1'; }, 650);
      });
      setTimeout(() => {
        wrap.style.transition='opacity .4s'; wrap.style.opacity='0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, 2300);
    }

    // ── Renderer: page inverts + shakes (possession) ─────────────────────
    function _scarePossession(s) {
      flashScreen(4);
      const savedFilter = document.body.style.filter;
      document.body.style.transition='filter .05s';
      document.body.style.filter='invert(1) hue-rotate(180deg) saturate(8) contrast(2)';
      document.body.classList.add('hw-screaming');
      const el = document.createElement('div');
      el.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;pointer-events:none;';
      el.innerHTML=`<div style="font-family:Impact,Arial Black,sans-serif;font-size:min(11vw,9vh);color:#fff;text-shadow:0 0 20px #f00,4px 4px 0 #000;text-align:center;letter-spacing:.06em;animation:hwBooFlash .1s step-end 14">${s.boo}</div>`;
      document.body.appendChild(el);
      let tog=false;
      const fi=setInterval(() => {
        tog=!tog;
        document.body.style.filter=tog?'invert(1) hue-rotate(180deg) saturate(8) contrast(2)':'invert(1) hue-rotate(210deg) saturate(5) contrast(1.4)';
      },110);
      setTimeout(() => {
        clearInterval(fi);
        document.body.classList.remove('hw-screaming');
        document.body.style.transition = 'filter .35s';
        document.body.style.filter = savedFilter || 'none';
        setTimeout(() => { document.body.style.filter = ''; document.body.style.transition = ''; }, 400);
        el.style.transition='opacity .3s'; el.style.opacity='0';
        setTimeout(() => { el.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, 2100);
    }

    // ── Renderer: perspective corridor rush (Silent Hill / RE / Outlast) ─────
    function _scareHallway(s) {
      flashScreen(2);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#060606;overflow:hidden;pointer-events:none;';
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 800 500');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
      svg.innerHTML =
        '<defs><radialGradient id="hwHg" cx="50%" cy="50%" r="8%"><stop offset="0%" stop-color="#1a0808"/><stop offset="100%" stop-color="transparent"/></radialGradient></defs>' +
        '<rect width="800" height="500" fill="#050505"/>' +
        '<polygon points="0,0 800,0 490,250 310,250" fill="#0e0e0e"/>' +
        '<polygon points="0,500 800,500 490,250 310,250" fill="#0d0d0d"/>' +
        '<polygon points="0,0 0,500 310,250" fill="#111"/>' +
        '<polygon points="800,0 800,500 490,250" fill="#0b0b0b"/>' +
        '<line x1="80" y1="500" x2="310" y2="250" stroke="#191919" stroke-width="1.5"/>' +
        '<line x1="80" y1="0" x2="310" y2="250" stroke="#191919" stroke-width="1.5"/>' +
        '<line x1="720" y1="500" x2="490" y2="250" stroke="#161616" stroke-width="1.5"/>' +
        '<line x1="720" y1="0" x2="490" y2="250" stroke="#161616" stroke-width="1.5"/>' +
        '<line x1="170" y1="500" x2="310" y2="250" stroke="#151515" stroke-width="1"/>' +
        '<line x1="170" y1="0" x2="310" y2="250" stroke="#151515" stroke-width="1"/>' +
        '<line x1="630" y1="500" x2="490" y2="250" stroke="#131313" stroke-width="1"/>' +
        '<line x1="630" y1="0" x2="490" y2="250" stroke="#131313" stroke-width="1"/>' +
        '<ellipse cx="400" cy="250" rx="10" ry="10" fill="url(#hwHg)"/>' +
        '<ellipse cx="400" cy="250" rx="3" ry="3" fill="#1f0606"/>';
      wrap.appendChild(svg);
      let fk = 6;
      const fId = setInterval(() => {
        svg.style.opacity = fk % 2 === 0 ? '1' : '0.85';
        if (--fk <= 0) { clearInterval(fId); svg.style.opacity = '1'; }
      }, 160);
      const fig = document.createElement('div');
      fig.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.025);font-size:min(100vw,95vh);line-height:1;opacity:0;filter:brightness(.2) saturate(0) blur(1px);transition:transform .6s cubic-bezier(.05,.8,.2,1),opacity .1s,filter .5s;pointer-events:none;';
      fig.textContent = '🧟';
      const boo = document.createElement('div');
      boo.style.cssText = 'position:absolute;bottom:10%;left:0;right:0;text-align:center;font-family:Impact,Arial Black,sans-serif;font-size:min(8vw,7vh);color:#fff;text-shadow:0 0 25px #a00,3px 3px 0 #000;opacity:0;letter-spacing:.1em;pointer-events:none;';
      boo.textContent = s.boo;
      wrap.append(fig, boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        fig.style.opacity = '.8'; fig.style.transform = 'translate(-50%,-50%) scale(1.5)'; fig.style.filter = 'brightness(.55) saturate(.3) blur(0)';
        setTimeout(() => { boo.style.opacity = '1'; boo.style.transition = 'opacity .05s'; }, 350);
      }, 450);
      setTimeout(() => {
        wrap.style.transition = 'opacity .3s'; wrap.style.opacity = '0';
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 400);
      }, 2700);
    }

    // ── Renderer: security camera (FNAF / Paranormal Activity) ───────────────
    function _scareSecurity(s) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;overflow:hidden;pointer-events:none;';
      const tint = document.createElement('div');
      tint.style.cssText = 'position:absolute;inset:0;background:rgba(0,28,0,.4);';
      const secCanvas = document.createElement('canvas');
      secCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:.16;mix-blend-mode:screen;';
      secCanvas.width = 180; secCanvas.height = 120;
      const secCtx = secCanvas.getContext('2d');
      let secRaf;
      (function g() {
        const d = secCtx.createImageData(180,120);
        for (let i=0;i<d.data.length;i+=4) { const v=Math.random()*255; d.data[i]=0;d.data[i+1]=v;d.data[i+2]=0;d.data[i+3]=255; }
        secCtx.putImageData(d,0,0); secRaf = requestAnimationFrame(g);
      })();
      const sl = document.createElement('div');
      sl.style.cssText = 'position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.28) 3px,rgba(0,0,0,.28) 4px);';
      const nowD = new Date();
      const secTs = nowD.getFullYear()+'-'+String(nowD.getMonth()+1).padStart(2,'0')+'-'+String(nowD.getDate()).padStart(2,'0')+' '+String(nowD.getHours()).padStart(2,'0')+':'+String(nowD.getMinutes()).padStart(2,'0')+':'+String(nowD.getSeconds()).padStart(2,'0');
      const hud = document.createElement('div');
      hud.style.cssText = 'position:absolute;top:0;left:0;right:0;font-family:monospace;color:#0f0;font-size:min(1.7vw,12px);padding:12px;';
      hud.innerHTML = 'CAM 04  HALL-B<span style="position:absolute;right:12px">'+secTs+'</span>';
      const motion = document.createElement('div');
      motion.style.cssText = 'position:absolute;top:36%;left:50%;transform:translateX(-50%);font-family:monospace;font-weight:bold;font-size:min(4vw,3.5vh);color:#f00;text-shadow:0 0 10px #f00;text-align:center;opacity:0;white-space:nowrap;';
      motion.innerHTML = '⚠ MOTION DETECTED ⚠<br><span style="font-size:.6em;color:#fa0">SECTOR 4 — IMMEDIATE RESPONSE</span>';
      const secFig = document.createElement('div');
      secFig.style.cssText = 'position:absolute;font-size:min(72vw,68vh);line-height:1;top:50%;left:50%;transform:translate(-50%,-20%) scale(.07);opacity:0;filter:brightness(.2) saturate(0);transition:transform .3s ease-out,opacity .1s,filter .3s;';
      secFig.textContent = '🧟';
      wrap.append(tint, sl, secCanvas, hud, motion, secFig);
      document.body.appendChild(wrap);
      setTimeout(() => { motion.style.opacity='1'; motion.style.transition='opacity .06s'; }, 750);
      setTimeout(() => {
        secFig.style.opacity='.85'; secFig.style.transform='translate(-50%,-20%) scale(1.1)'; secFig.style.filter='brightness(.5) saturate(.25)';
        setTimeout(() => { secFig.style.transform='translate(-50%,-20%) scale(1.7)'; secFig.style.filter='brightness(.7) saturate(.35)'; }, 200);
      }, 1300);
      setTimeout(() => {
        cancelAnimationFrame(secRaf);
        wrap.style.transition='opacity .3s'; wrap.style.opacity='0';
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 400);
      }, 2900);
    }

    // ── Renderer: found footage night-vision (Blair Witch / REC) ─────────────
    function _scareFound(s) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#060a04;overflow:hidden;pointer-events:none;';
      const shaky = document.createElement('div');
      shaky.style.cssText = 'position:absolute;inset:-6%;width:112%;height:112%;animation:hwFoundShaky .11s infinite;';
      const fndCanvas = document.createElement('canvas');
      fndCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:.2;mix-blend-mode:screen;';
      fndCanvas.width=180; fndCanvas.height=120;
      const fndCtx=fndCanvas.getContext('2d');
      let fndRaf;
      (function g() {
        const d=fndCtx.createImageData(180,120);
        for(let i=0;i<d.data.length;i+=4){const v=Math.random()*220;d.data[i]=0;d.data[i+1]=v;d.data[i+2]=0;d.data[i+3]=255;}
        fndCtx.putImageData(d,0,0); fndRaf=requestAnimationFrame(g);
      })();
      const vig=document.createElement('div');
      vig.style.cssText='position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 38%,rgba(0,0,0,.88) 100%);';
      const nowF=new Date();
      const rec=document.createElement('div');
      rec.style.cssText='position:absolute;top:12px;left:12px;font-family:monospace;font-size:min(1.7vw,12px);color:#0f0;font-weight:bold;';
      rec.innerHTML='<span style="color:#f00;animation:hwRecBlink .55s step-end infinite">●</span> REC  '+String(nowF.getHours()).padStart(2,'0')+':'+String(nowF.getMinutes()).padStart(2,'0');
      const fndFig=document.createElement('div');
      fndFig.style.cssText='position:absolute;font-size:min(14vw,11vh);line-height:1;top:50%;left:50%;transform:translate(-50%,-50%) scale(.04);opacity:0;filter:brightness(.3) saturate(0) blur(2px);transition:transform .65s ease-out,opacity .12s,filter .45s;';
      fndFig.textContent='🧟';
      shaky.append(fndCanvas, vig, rec, fndFig);
      wrap.appendChild(shaky);
      document.body.appendChild(wrap);
      setTimeout(()=>{ fndFig.style.opacity='.85'; fndFig.style.transform='translate(-50%,-50%) scale(4)'; fndFig.style.filter='brightness(.4) saturate(.2) blur(0)'; },400);
      setTimeout(()=>{ fndFig.style.transform='translate(-50%,-50%) scale(20)'; fndFig.style.filter='brightness(.6) saturate(.3)'; },900);
      setTimeout(()=>{
        cancelAnimationFrame(fndRaf);
        wrap.style.transition='opacity .3s'; wrap.style.opacity='0';
        setTimeout(()=>{ wrap.remove(); window.speechSynthesis?.cancel(); },400);
      },2700);
    }

    // ── Renderer: VHS static materialising figure (The Ring) ─────────────────
    function _scareRing(s) {
      const wrap=document.createElement('div');
      wrap.style.cssText='position:fixed;inset:0;z-index:99999;background:#060606;overflow:hidden;pointer-events:none;';
      const rngCanvas=document.createElement('canvas');
      rngCanvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;';
      rngCanvas.width=280; rngCanvas.height=180;
      const rngCtx=rngCanvas.getContext('2d');
      let rngRaf, figA=0;
      (function frame(){
        const d=rngCtx.createImageData(280,180);
        for(let i=0;i<d.data.length;i+=4){const v=Math.random()*255;d.data[i]=v;d.data[i+1]=v;d.data[i+2]=v;d.data[i+3]=255;}
        rngCtx.putImageData(d,0,0);
        if(figA>0){
          rngCtx.save(); rngCtx.globalAlpha=figA; rngCtx.fillStyle='#000';
          const bx=140,by=78;
          rngCtx.beginPath(); rngCtx.arc(bx,by-28,12,0,Math.PI*2); rngCtx.fill();
          rngCtx.fillRect(bx-10,by-16,20,42);
          rngCtx.fillRect(bx-16,by+26,12,35);
          rngCtx.fillRect(bx+4,by+26,12,35);
          rngCtx.fillStyle='rgba(0,0,0,'+(figA*0.75)+')';
          for(let h=0;h<5;h++){rngCtx.fillRect(bx-11+h*5,by-40,2,18+h*2);}
          rngCtx.restore();
        }
        if(Math.random()<0.12){
          rngCtx.fillStyle='rgba(200,200,200,'+(0.03+Math.random()*0.05)+')';
          rngCtx.fillRect(0,Math.random()*180,280,1+Math.random()*3);
        }
        rngRaf=requestAnimationFrame(frame);
      })();
      const msg=document.createElement('div');
      msg.style.cssText='position:absolute;bottom:14%;left:0;right:0;text-align:center;font-family:"Courier New",monospace;font-size:min(7vw,6.5vh);color:#ddd;text-shadow:0 0 6px #fff,0 0 25px #aaa;opacity:0;letter-spacing:.2em;';
      msg.textContent=s.boo;
      wrap.append(rngCanvas,msg);
      document.body.appendChild(wrap);
      setTimeout(()=>{figA=0.25;},600);
      setTimeout(()=>{figA=0.6;},1100);
      setTimeout(()=>{figA=0.92; msg.style.opacity='1'; msg.style.transition='opacity .12s';},1600);
      setTimeout(()=>{
        cancelAnimationFrame(rngRaf);
        wrap.style.transition='opacity .35s'; wrap.style.opacity='0';
        setTimeout(()=>{ wrap.remove(); window.speechSynthesis?.cancel(); },400);
      },3000);
    }

    // ── Renderer: mirror shows demon reflection ───────────────────────────────
    function _scareMirror(s) {
      hwSubtitle(s.speak, 2900);
      flashScreen(2);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:flex;align-items:center;justify-content:center;flex-direction:column;pointer-events:none;';
      const frame = document.createElement('div');
      frame.style.cssText = 'position:relative;width:min(50vw,48vh);height:min(70vw,68vh);border:8px solid #8B6914;border-radius:50% 50% 4px 4px/30% 30% 4px 4px;box-shadow:0 0 0 4px #5a3d00,0 0 50px rgba(139,105,20,0.4),inset 0 0 40px #000;background:#050505;overflow:hidden;transition:box-shadow .3s;';
      const faceWrap = document.createElement('div');
      faceWrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:scale(0.05);opacity:0;transition:transform .8s cubic-bezier(.1,.9,.3,1),opacity .15s;';
      faceWrap.innerHTML = `<div style="width:100%">${hwDemonFaceSVG()}</div>`;
      const crackSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      crackSvg.setAttribute('viewBox','0 0 200 300');
      crackSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity .08s;pointer-events:none;';
      crackSvg.innerHTML = '<line x1="100" y1="150" x2="15" y2="20" stroke="rgba(255,255,255,0.85)" stroke-width="1.5"/><line x1="100" y1="150" x2="190" y2="30" stroke="rgba(255,255,255,0.75)" stroke-width="1.2"/><line x1="100" y1="150" x2="5" y2="230" stroke="rgba(255,255,255,0.8)" stroke-width="1.5"/><line x1="100" y1="150" x2="198" y2="240" stroke="rgba(255,255,255,0.7)" stroke-width="1"/><line x1="100" y1="150" x2="110" y2="305" stroke="rgba(255,255,255,0.6)" stroke-width="1"/>';
      frame.append(faceWrap, crackSvg);
      const boo = document.createElement('div');
      boo.style.cssText = 'margin-top:20px;font-family:Impact,Arial Black,sans-serif;font-size:min(6vw,5vh);color:#f00;text-shadow:0 0 20px #f00;letter-spacing:.08em;opacity:0;transition:opacity .25s;text-align:center;';
      boo.textContent = s.boo;
      wrap.append(frame, boo);
      document.body.appendChild(wrap);
      requestAnimationFrame(() => {
        faceWrap.style.transform = 'scale(1)';
        faceWrap.style.opacity = '1';
        setTimeout(() => {
          crackSvg.style.opacity = '1';
          frame.style.boxShadow = '0 0 0 4px #5a3d00,0 0 60px rgba(200,0,0,0.6),inset 0 0 40px #000';
          boo.style.opacity = '1';
        }, 800);
      });
      setTimeout(() => {
        wrap.style.transition = 'opacity .4s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, 2900);
    }

    // ── Renderer: video call from hell ────────────────────────────────────────
    function _scarePhone(s) {
      hwSubtitle(s.speak, 2800);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;pointer-events:none;';
      const card = document.createElement('div');
      card.style.cssText = 'border-radius:20px;background:#0f0f0f;border:3px solid #1a1a1a;width:min(52vw,280px);overflow:hidden;box-shadow:0 0 40px rgba(0,180,0,.12);';
      const header = document.createElement('div');
      header.style.cssText = 'background:#0a0a0a;padding:16px 12px;text-align:center;border-bottom:1px solid #1a1a1a;';
      header.innerHTML = '<div style="color:#0f0;font-family:monospace;font-size:min(2.8vw,13px);letter-spacing:.12em">INCOMING CALL</div><div style="font-size:min(15vw,64px);margin:8px 0;filter:drop-shadow(0 0 12px #f00);line-height:1">☠️</div><div style="color:#ccc;font-family:monospace;font-size:min(3.5vw,16px)">Unknown</div><div style="color:#555;font-family:monospace;font-size:min(2.5vw,11px);margin-top:3px">+1 (000) 666-0000</div>';
      const vidArea = document.createElement('div');
      vidArea.style.cssText = 'position:relative;background:#000;height:min(32vw,170px);display:flex;align-items:center;justify-content:center;overflow:hidden;';
      const connecting = document.createElement('div');
      connecting.style.cssText = 'color:#333;font-family:monospace;font-size:min(2vw,10px);letter-spacing:.1em;transition:opacity .2s;';
      connecting.textContent = 'CONNECTING...';
      const vidFace = document.createElement('div');
      vidFace.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:scale(0.05);opacity:0;transition:transform .3s ease-out,opacity .1s;';
      vidFace.innerHTML = `<div style="width:100%">${hwDemonFaceSVG()}</div>`;
      const booCaption = document.createElement('div');
      booCaption.style.cssText = 'position:absolute;bottom:4px;left:0;right:0;text-align:center;font-family:monospace;font-size:min(3.5vw,14px);color:#f00;text-shadow:0 0 10px #f00;opacity:0;transition:opacity .15s;';
      booCaption.textContent = s.boo;
      vidArea.append(connecting, vidFace, booCaption);
      const footer = document.createElement('div');
      footer.style.cssText = 'background:#0a0a0a;padding:10px;text-align:center;font-family:monospace;font-size:min(2vw,10px);color:#333;letter-spacing:.1em;';
      footer.textContent = 'ANSWER          DECLINE';
      card.append(header, vidArea, footer);
      wrap.appendChild(card);
      document.body.appendChild(wrap);
      setTimeout(() => {
        connecting.style.opacity = '0';
        vidFace.style.transform = 'scale(1.15)';
        vidFace.style.opacity = '1';
        booCaption.style.opacity = '1';
        flashScreen(2);
        document.body.classList.add('hw-screaming');
      }, 1000);
      setTimeout(() => {
        wrap.style.transition = 'opacity .35s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 450);
      }, 2800);
    }

    // ── Renderer: hands reaching in from all edges ────────────────────────────
    function _scareHands(s) {
      hwSubtitle(s.speak, 2600);
      flashScreen(3);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.8);overflow:hidden;pointer-events:none;';
      const HANDS = [
        { style: 'top:0;left:10%;transform:translateY(-120%) rotate(0deg)',   inStyle: 'top:0;left:10%;transform:translateY(0) rotate(0deg)',    e:'🖐' },
        { style: 'top:0;right:12%;transform:translateY(-120%) rotate(10deg)', inStyle: 'top:0;right:12%;transform:translateY(0) rotate(10deg)',   e:'🤚' },
        { style: 'bottom:0;left:8%;transform:translateY(120%) rotate(180deg)', inStyle: 'bottom:0;left:8%;transform:translateY(0) rotate(180deg)', e:'🖐' },
        { style: 'bottom:0;right:14%;transform:translateY(120%) rotate(170deg)', inStyle: 'bottom:0;right:14%;transform:translateY(0) rotate(170deg)', e:'🤚' },
        { style: 'left:0;top:18%;transform:translateX(-120%) rotate(90deg)',  inStyle: 'left:0;top:18%;transform:translateX(0) rotate(90deg)',   e:'🖐' },
        { style: 'left:0;top:55%;transform:translateX(-120%) rotate(90deg)',  inStyle: 'left:0;top:55%;transform:translateX(0) rotate(90deg)',   e:'🤚' },
        { style: 'right:0;top:22%;transform:translateX(120%) rotate(270deg)', inStyle: 'right:0;top:22%;transform:translateX(0) rotate(270deg)', e:'🖐' },
        { style: 'right:0;top:60%;transform:translateX(120%) rotate(270deg)', inStyle: 'right:0;top:60%;transform:translateX(0) rotate(270deg)', e:'🤚' },
      ];
      const handEls = HANDS.map((h, i) => {
        const el = document.createElement('div');
        el.style.cssText = `position:absolute;font-size:min(22vw,22vh);line-height:1;${h.style};filter:brightness(.35) drop-shadow(0 0 18px rgba(200,0,0,.65));transition:transform ${.48+i*.035}s cubic-bezier(.1,.9,.3,1) ${i*30}ms, top ${.48+i*.035}s cubic-bezier(.1,.9,.3,1) ${i*30}ms, bottom ${.48+i*.035}s cubic-bezier(.1,.9,.3,1) ${i*30}ms, left ${.48+i*.035}s cubic-bezier(.1,.9,.3,1) ${i*30}ms, right ${.48+i*.035}s cubic-bezier(.1,.9,.3,1) ${i*30}ms;`;
        el.textContent = h.e;
        wrap.appendChild(el);
        return { el, inStyle: h.inStyle };
      });
      const boo = document.createElement('div');
      boo.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:Impact,Arial Black,sans-serif;font-size:min(9vw,8vh);color:#f00;text-shadow:0 0 30px #f00,0 0 60px #900;text-align:center;opacity:0;transition:opacity .25s;z-index:1;white-space:nowrap;';
      boo.textContent = s.boo;
      wrap.appendChild(boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        handEls.forEach(({ el, inStyle }) => {
          const parts = inStyle.split(';').filter(Boolean);
          parts.forEach(p => {
            const [k, ...v] = p.split(':');
            el.style[k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v.join(':').trim();
          });
        });
        setTimeout(() => { boo.style.opacity = '1'; }, 550);
      }, 80);
      setTimeout(() => {
        wrap.style.transition = 'opacity .4s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, 2600);
    }

    // ── Renderer: single massive eye opening in void ──────────────────────────
    function _scareVoid(s) {
      hwSubtitle(s.speak, 3200);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:flex;align-items:center;justify-content:center;flex-direction:column;pointer-events:none;';
      const eye = document.createElement('div');
      eye.style.cssText = 'font-size:0;line-height:1;transition:font-size 1.5s cubic-bezier(.2,.9,.3,1);filter:drop-shadow(0 0 40px #f00) drop-shadow(0 0 80px rgba(255,0,0,.6));';
      eye.textContent = '👁️';
      const boo = document.createElement('div');
      boo.style.cssText = 'font-family:Impact,Arial Black,sans-serif;font-size:min(7vw,6vh);color:#8b0000;text-shadow:0 0 25px #f00;letter-spacing:.15em;margin-top:24px;opacity:0;transition:opacity .5s;text-align:center;';
      boo.textContent = s.boo;
      wrap.append(eye, boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        eye.style.fontSize = 'min(50vw,50vh)';
        setTimeout(() => {
          boo.style.opacity = '1';
          let p = 0;
          const pulse = setInterval(() => {
            p++;
            eye.style.filter = p % 2 === 0
              ? 'drop-shadow(0 0 40px #f00) drop-shadow(0 0 80px rgba(255,0,0,.6))'
              : 'drop-shadow(0 0 80px #f00) drop-shadow(0 0 120px rgba(255,0,0,.9)) drop-shadow(0 0 20px #fff)';
            if (p >= 4) clearInterval(pulse);
          }, 500);
        }, 1500);
      }, 200);
      setTimeout(() => {
        wrap.style.transition = 'opacity .5s'; wrap.style.opacity = '0';
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 600);
      }, 3200);
    }

    // ── Renderer: countdown 5→0 then demon explosion ─────────────────────────
    function _scareCountdown(s) {
      hwSubtitle(s.speak, 3200);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:flex;align-items:center;justify-content:center;flex-direction:column;overflow:hidden;pointer-events:none;';
      const numEl = document.createElement('div');
      numEl.style.cssText = 'font-family:Impact,Arial Black,sans-serif;font-size:min(38vw,42vh);color:#c0000a;text-shadow:0 0 50px #f00,0 0 100px #900;font-weight:900;line-height:1;transition:transform .08s;';
      numEl.textContent = '5';
      wrap.appendChild(numEl);
      document.body.appendChild(wrap);
      let count = 5;
      const ci = setInterval(() => {
        count--;
        if (count <= 0) {
          clearInterval(ci);
          flashScreen(5);
          wrap.innerHTML = '';
          const faceDiv = document.createElement('div');
          faceDiv.style.cssText = 'width:min(75vw,72vh);transform:scale(0.08);transition:transform .12s cubic-bezier(.05,1.8,.4,.9);';
          faceDiv.innerHTML = hwDemonFaceSVG();
          const booEl = document.createElement('div');
          booEl.style.cssText = 'position:absolute;bottom:8%;left:0;right:0;text-align:center;font-family:Impact,Arial Black,sans-serif;font-size:min(9vw,8vh);color:#f00;text-shadow:0 0 30px #f00;letter-spacing:.1em;animation:hwBooFlash .1s step-end 8;';
          booEl.textContent = s.boo;
          wrap.append(faceDiv, booEl);
          requestAnimationFrame(() => requestAnimationFrame(() => { faceDiv.style.transform = 'scale(1)'; }));
        } else {
          numEl.textContent = String(count);
          numEl.style.transform = 'scale(1.35)';
          setTimeout(() => { numEl.style.transform = 'scale(1)'; }, 80);
        }
      }, 380);
      setTimeout(() => {
        wrap.style.transition = 'opacity .4s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, 3200);
    }

    // ── Renderer: blood spreading across screen ───────────────────────────────
    function _scareBlood(s) {
      hwSubtitle(s.speak, 3000);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;overflow:hidden;';
      const pool = document.createElement('div');
      pool.style.cssText = 'position:absolute;top:-80%;right:-80%;width:200%;height:200%;background:radial-gradient(ellipse at 80% 5%,rgba(120,0,0,.96) 0%,rgba(80,0,0,.72) 40%,transparent 65%);transform:scale(0);transition:transform 1.3s cubic-bezier(.2,.8,.2,1);transform-origin:80% 5%;';
      const drips = ['3% 0%','18% 0%','31% 0%','55% 0%','72% 0%','88% 0%','96% 0%'].map((pos, i) => {
        const d = document.createElement('div');
        const [l, t] = pos.split(' ');
        d.style.cssText = `position:absolute;left:${l};top:${t};font-size:min(${8+i%3*4}vw,${7+i%3*4}vh);opacity:0;transition:opacity .2s;filter:drop-shadow(0 4px 6px rgba(100,0,0,.6));`;
        d.textContent = '🩸';
        return d;
      });
      const hand = document.createElement('div');
      hand.style.cssText = 'position:absolute;top:3%;right:5%;font-size:min(24vw,24vh);opacity:0;transition:opacity .25s;filter:drop-shadow(0 0 14px rgba(150,0,0,.8));';
      hand.textContent = '🩸';
      const boo = document.createElement('div');
      boo.style.cssText = 'position:absolute;bottom:12%;left:50%;transform:translateX(-50%);font-family:Impact,Arial Black,sans-serif;font-size:min(8vw,7vh);color:#fff;text-shadow:3px 3px 0 #8b0000,0 0 25px #f00;letter-spacing:.1em;opacity:0;transition:opacity .3s;white-space:nowrap;';
      boo.textContent = s.boo;
      wrap.append(pool, ...drips, hand, boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        pool.style.transform = 'scale(1)';
        setTimeout(() => {
          hand.style.opacity = '1';
          drips.forEach((d, i) => setTimeout(() => { d.style.opacity = '1'; }, i * 80));
          setTimeout(() => { boo.style.opacity = '1'; }, 200);
        }, 650);
      }, 80);
      setTimeout(() => {
        wrap.style.transition = 'opacity .5s'; wrap.style.opacity = '0';
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 600);
      }, 3000);
    }

    // ── Renderer: asylum corridor patient rush ────────────────────────────────
    function _scareAsylum(s) {
      hwSubtitle(s.speak, 2700);
      flashScreen(2);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#060405;overflow:hidden;pointer-events:none;';
      const ceiling = document.createElement('div');
      ceiling.style.cssText = 'position:absolute;top:0;left:0;right:0;height:34%;background:linear-gradient(to bottom,#111,#0a0a0a);border-bottom:1px solid #1a1a1a;';
      const floor = document.createElement('div');
      floor.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:30%;background:linear-gradient(to top,#0f0e0c,#080808);border-top:1px solid #191917;';
      const corr = document.createElementNS('http://www.w3.org/2000/svg','svg');
      corr.setAttribute('viewBox','0 0 800 500');
      corr.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:.18;';
      corr.innerHTML = '<line x1="0" y1="0" x2="400" y2="250" stroke="#333" stroke-width="1"/><line x1="800" y1="0" x2="400" y2="250" stroke="#333" stroke-width="1"/><line x1="0" y1="500" x2="400" y2="250" stroke="#333" stroke-width="1"/><line x1="800" y1="500" x2="400" y2="250" stroke="#333" stroke-width="1"/>';
      const light = document.createElement('div');
      light.style.cssText = 'position:absolute;top:33%;left:0;right:0;height:3px;background:rgba(180,230,180,.07);box-shadow:0 0 20px rgba(180,230,180,.06);transition:opacity .04s;';
      let flkCount = 0;
      const flicker = setInterval(() => {
        light.style.opacity = flkCount % 2 === 0 ? '1' : '0';
        if (++flkCount > 5) { clearInterval(flicker); light.style.opacity = '0.4'; }
      }, 100);
      const fig = document.createElement('div');
      fig.style.cssText = 'position:absolute;top:8%;left:50%;transform:translateX(-50%) scale(.04);font-size:min(100vw,100vh);line-height:1;filter:brightness(.15) saturate(0) blur(1.5px);opacity:0;transition:transform .45s cubic-bezier(.05,.85,.2,1),filter .4s,opacity .08s;';
      fig.textContent = '🧍';
      const boo = document.createElement('div');
      boo.style.cssText = 'position:absolute;bottom:7%;left:0;right:0;text-align:center;font-family:Impact,Arial Black,sans-serif;font-size:min(7vw,6.5vh);color:#e0dcd0;text-shadow:0 0 20px rgba(255,255,255,.4),3px 3px 0 #000;letter-spacing:.1em;opacity:0;transition:opacity .3s;';
      boo.textContent = s.boo;
      wrap.append(ceiling, floor, corr, light, fig, boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        fig.style.opacity = '.9';
        fig.style.transform = 'translateX(-50%) scale(2)';
        fig.style.filter = 'brightness(.42) saturate(.1) blur(0)';
        setTimeout(() => { boo.style.opacity = '1'; }, 380);
      }, 480);
      setTimeout(() => {
        wrap.style.transition = 'opacity .35s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 450);
      }, 2700);
    }

    // ── Renderer: clown materialises from darkness ────────────────────────────
    function _scareClown(s) {
      hwSubtitle(s.speak, 2900);
      flashScreen(2);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#030003;display:flex;align-items:center;justify-content:center;flex-direction:column;pointer-events:none;transition:background .05s;';
      const clown = document.createElement('div');
      clown.style.cssText = 'font-size:0;line-height:1;filter:drop-shadow(0 0 40px rgba(255,50,50,.9)) drop-shadow(0 0 80px rgba(200,0,0,.6));transition:font-size .4s cubic-bezier(.15,1.6,.3,1);';
      clown.textContent = '🤡';
      const boo = document.createElement('div');
      boo.style.cssText = 'font-family:Impact,Arial Black,sans-serif;font-size:min(7vw,6vh);color:#c0000a;text-shadow:0 0 20px #f00;letter-spacing:.1em;margin-top:14px;opacity:0;transition:opacity .25s;';
      boo.textContent = s.boo;
      wrap.append(clown, boo);
      document.body.appendChild(wrap);
      let fl = 0;
      const fi = setInterval(() => {
        fl++;
        wrap.style.background = fl % 2 === 0 ? '#030003' : '#000';
        if (fl >= 5) { clearInterval(fi); wrap.style.background = '#030003'; }
      }, 115);
      setTimeout(() => {
        clown.style.fontSize = 'min(55vw,58vh)';
        setTimeout(() => { boo.style.opacity = '1'; }, 550);
      }, 320);
      setTimeout(() => {
        wrap.style.transition = 'opacity .4s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, 2900);
    }

    // ── Renderer: rising from the grave ──────────────────────────────────────
    function _scareGrave(s) {
      hwSubtitle(s.speak, 3100);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#060308;overflow:hidden;pointer-events:none;';
      const sky = document.createElement('div');
      sky.style.cssText = 'position:absolute;inset:0;background:radial-gradient(ellipse at 60% 15%,rgba(30,25,60,.8) 0%,transparent 65%);';
      const moon = document.createElement('div');
      moon.style.cssText = 'position:absolute;top:6%;right:14%;font-size:min(13vw,12vh);opacity:.55;filter:drop-shadow(0 0 18px rgba(200,200,100,.3));';
      moon.textContent = '🌕';
      const ground = document.createElement('div');
      ground.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:38%;background:linear-gradient(to top,#0d0b05,#121009);';
      const stone = document.createElement('div');
      stone.style.cssText = 'position:absolute;bottom:35%;left:50%;transform:translateX(-55%);font-size:min(18vw,18vh);filter:drop-shadow(0 0 8px rgba(100,85,50,.25));';
      stone.textContent = '🪦';
      const hand1 = document.createElement('div');
      hand1.style.cssText = 'position:absolute;bottom:-22%;left:48%;transform:translateX(-50%) rotate(-10deg);font-size:min(18vw,18vh);filter:drop-shadow(0 0 14px rgba(180,0,0,.5));transition:bottom .6s cubic-bezier(.1,.85,.3,1);';
      hand1.textContent = '🤚';
      const hand2 = document.createElement('div');
      hand2.style.cssText = 'position:absolute;bottom:-24%;left:60%;transform:translateX(-50%) rotate(20deg);font-size:min(13vw,13vh);filter:drop-shadow(0 0 10px rgba(150,0,0,.4));transition:bottom .65s cubic-bezier(.1,.85,.3,1) 80ms;';
      hand2.textContent = '🖐';
      const boo = document.createElement('div');
      boo.style.cssText = 'position:absolute;top:28%;left:50%;transform:translateX(-50%);font-family:Impact,Arial Black,sans-serif;font-size:min(7vw,6.5vh);color:#b8860b;text-shadow:0 0 20px rgba(200,140,30,.8),2px 2px 0 #000;letter-spacing:.1em;opacity:0;transition:opacity .3s;white-space:nowrap;text-align:center;';
      boo.textContent = s.boo;
      wrap.append(sky, moon, ground, stone, hand1, hand2, boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        flashScreen(1);
        hand1.style.bottom = '22%';
        hand2.style.bottom = '19%';
        setTimeout(() => { boo.style.opacity = '1'; }, 750);
      }, 650);
      setTimeout(() => {
        wrap.style.transition = 'opacity .5s'; wrap.style.opacity = '0';
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 600);
      }, 3100);
    }

    // ── Renderer: words appear one by one then face explodes ─────────────────
    function _scareWhisper(s) {
      const words = s.boo.split(' ');
      const totalDur = 300 + words.length * 320 + 400 + 1200;
      hwSubtitle(s.speak, totalDur);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;overflow:hidden;pointer-events:none;';
      const wordEls = words.map(w => {
        const el = document.createElement('div');
        el.style.cssText = 'font-family:"Courier New",monospace;font-size:min(8vw,7vh);color:#8b0000;text-shadow:0 0 12px rgba(200,0,0,.5);opacity:0;transition:opacity .18s,color .1s;letter-spacing:.12em;';
        el.textContent = w;
        wrap.appendChild(el);
        return el;
      });
      const faceDiv = document.createElement('div');
      faceDiv.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .06s;';
      faceDiv.innerHTML = `<div style="width:min(80vw,80vh)">${hwDemonFaceSVG()}</div>`;
      wrap.appendChild(faceDiv);
      document.body.appendChild(wrap);
      wordEls.forEach((el, i) => {
        setTimeout(() => {
          el.style.opacity = '1';
          if (i === wordEls.length - 1) el.style.color = '#f00';
        }, 300 + i * 320);
      });
      const explodeAt = 300 + words.length * 320 + 400;
      setTimeout(() => {
        flashScreen(4);
        document.body.classList.add('hw-screaming');
        wordEls.forEach(el => { el.style.opacity = '0'; });
        faceDiv.style.opacity = '1';
        setTimeout(() => {
          faceDiv.style.opacity = '0';
          document.body.classList.remove('hw-screaming');
        }, 1000);
      }, explodeAt);
      setTimeout(() => {
        wrap.style.transition = 'opacity .4s'; wrap.style.opacity = '0';
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, totalDur);
    }

    // ── Renderer: figure crawling across ceiling ──────────────────────────────
    function _scareCeiling(s) {
      hwSubtitle(s.speak, 2700);
      flashScreen(2);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(3,0,3,.96);overflow:hidden;pointer-events:none;';
      const ceilBar = document.createElement('div');
      ceilBar.style.cssText = 'position:absolute;top:0;left:0;right:0;height:32%;background:linear-gradient(to bottom,#111,#0a0a0a);border-bottom:2px solid #1a1a1a;';
      const floorBar = document.createElement('div');
      floorBar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:28%;background:linear-gradient(to top,#0f0d0f,#080708);border-top:1px solid #161416;';
      const fig = document.createElement('div');
      fig.style.cssText = 'position:absolute;top:1%;left:-30%;font-size:min(22vw,24vh);line-height:1;transform:rotate(180deg) scaleX(-1);filter:brightness(.25) saturate(0);transition:left 1.55s cubic-bezier(.3,.8,.5,1),filter 1.4s;';
      fig.textContent = '🧟';
      const dustParent = document.createElement('div');
      dustParent.style.cssText = 'position:absolute;top:30%;left:0;right:0;height:15%;pointer-events:none;';
      for (let i = 0; i < 10; i++) {
        const dot = document.createElement('div');
        const lp = 15 + Math.random() * 70;
        dot.style.cssText = `position:absolute;left:${lp}%;top:0;width:2px;height:${4+Math.random()*6}px;background:rgba(180,160,140,${.15+Math.random()*.2});opacity:0;transition:top ${.6+Math.random()*.5}s ease-in,opacity .1s;transition-delay:${200+i*80}ms;`;
        dustParent.appendChild(dot);
        setTimeout(() => { dot.style.opacity = '1'; dot.style.top = `${60+Math.random()*40}px`; }, 400 + i * 50);
      }
      const boo = document.createElement('div');
      boo.style.cssText = 'position:absolute;bottom:8%;left:0;right:0;text-align:center;font-family:Impact,Arial Black,sans-serif;font-size:min(8vw,7vh);color:#f00;text-shadow:0 0 25px #f00;letter-spacing:.1em;opacity:0;transition:opacity .3s;';
      boo.textContent = s.boo;
      wrap.append(ceilBar, floorBar, dustParent, fig, boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        fig.style.left = '130%';
        fig.style.filter = 'brightness(.55) saturate(.15)';
        setTimeout(() => { boo.style.opacity = '1'; }, 550);
      }, 200);
      setTimeout(() => {
        wrap.style.transition = 'opacity .4s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 500);
      }, 2700);
    }

    // ── Renderer: hospital emergency ─────────────────────────────────────────
    function _scareHospital(s) {
      hwSubtitle(s.speak, 2800);
      flashScreen(1);
      document.body.classList.add('hw-screaming');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#020a0a;overflow:hidden;pointer-events:none;';
      const tint = document.createElement('div');
      tint.style.cssText = 'position:absolute;inset:0;background:rgba(0,25,15,.45);';
      const monitor = document.createElement('div');
      monitor.style.cssText = 'position:absolute;top:7%;left:50%;transform:translateX(-50%);font-family:monospace;background:#000;border:2px solid #0f0;padding:8px 18px;border-radius:4px;box-shadow:0 0 18px rgba(0,255,0,.25);text-align:center;';
      monitor.innerHTML = '<div style="color:#0f0;font-size:min(2vw,11px);letter-spacing:.1em">VITAL SIGNS</div><div style="color:#f00;font-size:min(3.5vw,16px);font-weight:bold;letter-spacing:4px;margin-top:4px;animation:hwBooFlash .22s step-end 10">● CRITICAL ●</div>';
      const fig = document.createElement('div');
      fig.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(.03);font-size:min(90vw,90vh);line-height:1;filter:brightness(.2) saturate(.15) blur(1.5px);opacity:0;transition:transform .45s ease-out,filter .4s,opacity .08s;';
      fig.textContent = '🧟';
      const boo = document.createElement('div');
      boo.style.cssText = 'position:absolute;bottom:8%;left:0;right:0;text-align:center;font-family:monospace;font-size:min(7vw,6vh);color:#f00;text-shadow:0 0 18px #f00;letter-spacing:.14em;opacity:0;transition:opacity .3s;';
      boo.textContent = s.boo;
      wrap.append(tint, monitor, fig, boo);
      document.body.appendChild(wrap);
      setTimeout(() => {
        fig.style.transform = 'translate(-50%,-50%) scale(1.8)';
        fig.style.opacity = '.88';
        fig.style.filter = 'brightness(.4) saturate(.3) blur(0)';
        setTimeout(() => { boo.style.opacity = '1'; }, 420);
      }, 520);
      setTimeout(() => {
        wrap.style.transition = 'opacity .35s'; wrap.style.opacity = '0';
        document.body.classList.remove('hw-screaming');
        setTimeout(() => { wrap.remove(); window.speechSynthesis?.cancel(); }, 450);
      }, 2800);
    }
  }
  function scheduleNextScare() {
    if (_scareTimer) clearTimeout(_scareTimer);
    // freq 0 = very rare (15-25 min), freq 50 = normal (5-10 min), freq 100 = frequent (0.5-2 min)
    const minMs = Math.round((15 - hwFreq * 0.145) * 60 * 1000); // 15min → ~0.5min
    const maxMs = Math.round((25 - hwFreq * 0.23)  * 60 * 1000); // 25min → ~2min
    const delay = Math.max(30 * 1000, minMs + Math.random() * Math.max(0, maxMs - minMs));
    _scareTimer = setTimeout(doJumpScare, delay);
  }
  // First scare: scales with frequency (freq 0 = 4-8min, freq 100 = 10-30s)
  if (hwScares) {
    const _firstMin = Math.round((4 - hwFreq * 0.037) * 60 * 1000);
    _scareTimer = setTimeout(doJumpScare, Math.max(10 * 1000, _firstMin + Math.random() * _firstMin));
  }

  // ── One-time welcome toast ──────────────────────────────────────────────────
  if (!sessionStorage.getItem('hw_toast_shown')) {
    sessionStorage.setItem('hw_toast_shown', '1');
    const toast = document.createElement('div');
    toast.className = 'halloween-toast';
    toast.textContent = '🎃 Happy Halloween from character.mind';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6200);
  }
})();

// â”€â”€ Weather Effects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function initWeather() {
  // â”€â”€ Persisted settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _wthOn     = localStorage.getItem('wth_on')    !== '0'; // default ON
  let _wthUnit   = localStorage.getItem('wth_unit')  || 'F';
  let _wthHotF   = parseInt(localStorage.getItem('wth_hot_f')   || '90', 10);
  let _wthFrostF = parseInt(localStorage.getItem('wth_frost_f') || '32', 10);

  // â”€â”€ Runtime state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _wthData = null;
  let _rainActive = false, _snowActive = false, _heatActive = false;
  let _rainTids = [], _snowTids = [];
  let _heatStage = null, _heatOverlay = null;
  let _frostEl = null, _iciclesEl = null;

  // â”€â”€ Widget element â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const _widget = document.createElement('div');
  _widget.id = 'wthWidget';
  _widget.className = 'wth-widget';
  document.body.appendChild(_widget);
  if (!_wthOn) _widget.classList.add('wth-hidden');

  // â”€â”€ Clock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _tick() {
    const now  = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString([], {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
    const tEl = document.getElementById('_wthTime');
    const dEl = document.getElementById('_wthDate');
    if (tEl) tEl.textContent = time;
    if (dEl) dEl.textContent = date;
  }

  // â”€â”€ Widget render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _render() {
    let weatherRow = '<div class="wth-locating">Detecting…</div>';
    if (_wthData) {
      const t = _wthUnit === 'C'
        ? Math.round((_wthData.temp_f - 32) * 5 / 9) + '°C'
        : Math.round(_wthData.temp_f) + '°F';
      weatherRow = '<div class="wth-weather-row">' +
        '<span class="wth-emoji">' + _wthData.emoji + '</span>' +
        '<span class="wth-temp">' + t + '</span>' +
        '<span class="wth-desc">' + _wthData.desc + '</span>' +
        '</div>';
    }
    _widget.innerHTML =
      '<div class="wth-time-row">' +
        '<span class="wth-time" id="_wthTime">--:--</span>' +
        '<span class="wth-date" id="_wthDate"></span>' +
      '</div>' +
      weatherRow;
    _tick();
  }

  // â”€â”€ WMO code helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _wmoInfo(c) {
    if (c === 0)  return { desc: 'Clear sky',     emoji: 'â˜€ï¸' };
    if (c <= 3)   return { desc: 'Partly cloudy', emoji: 'â›…' };
    if (c <= 49)  return { desc: 'Foggy',         emoji: 'ðŸŒ«ï¸' };
    if (c <= 57)  return { desc: 'Drizzle',       emoji: 'ðŸŒ¦ï¸' };
    if (c <= 67)  return { desc: 'Rainy',         emoji: 'ðŸŒ§ï¸' };
    if (c <= 77)  return { desc: 'Snowing',       emoji: 'â„ï¸' };
    if (c <= 82)  return { desc: 'Rain showers',  emoji: 'ðŸŒ§ï¸' };
    if (c <= 86)  return { desc: 'Snow showers',  emoji: 'ðŸŒ¨ï¸' };
    if (c <= 99)  return { desc: 'Thunderstorm',  emoji: 'â›ˆï¸' };
    return { desc: 'Unknown', emoji: 'ðŸŒ¡ï¸' };
  }
  function _isRain(c) { return (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95; }
  function _isSnow(c) { return (c >= 71 && c <= 77) || (c >= 85 && c <= 86); }

  // â”€â”€ Open-Meteo fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _fetchWeather(lat, lon) {
    try {
      const res = await fetch(
        'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
        '&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto',
        { signal: AbortSignal.timeout(8000) }
      );
      const d = await res.json();
      const temp_f = d.current && d.current.temperature_2m != null ? d.current.temperature_2m : null;
      const code   = d.current ? (d.current.weather_code || 0) : 0;
      if (temp_f == null) return;
      _wthData = Object.assign({ temp_f: temp_f, code: code }, _wmoInfo(code));
      _render();
      _applyEffects();
    } catch (_) {}
  }

  function _locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function(p) { _fetchWeather(p.coords.latitude, p.coords.longitude); },
      function() {}
    );
  }

  // â”€â”€ Rain â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _spawnDrop() {
    if (!_rainActive) return;
    var drop = document.createElement('div');
    drop.className = 'wth-drop';
    var x   = Math.random() * 100;
    var w   = 2 + Math.random() * 7;
    var h   = w * (3.5 + Math.random() * 3.5);
    var dur = 0.55 + Math.random() * 1.1;
    var del = Math.random() * 1.8;
    drop.style.cssText = 'left:' + x + '%;width:' + w + 'px;height:' + h + 'px;' +
      'animation-duration:' + dur + 's;animation-delay:' + del + 's';
    document.body.appendChild(drop);
    var tid = setTimeout(function() {
      _spawnSplash(x, w);
      drop.remove();
      if (_rainActive) _spawnDrop();
    }, (dur + del) * 1000);
    _rainTids.push(tid);
  }

  function _spawnSplash(xPct, size) {
    var s = document.createElement('div');
    s.className = 'wth-splash';
    s.style.cssText = 'left:' + xPct + '%;width:' + (size * 3.5) + 'px;height:' + (size * 1.5) + 'px;bottom:' + (Math.random() * 15) + '%';
    document.body.appendChild(s);
    setTimeout(function() { s.remove(); }, 650);
  }

  function _startRain() {
    if (_rainActive) return;
    _rainActive = true;
    document.body.classList.add('wth-raining');
    for (var i = 0; i < 32; i++) _spawnDrop();
  }

  function _stopRain() {
    _rainActive = false;
    document.body.classList.remove('wth-raining');
    _rainTids.forEach(function(t) { clearTimeout(t); }); _rainTids = [];
    document.querySelectorAll('.wth-drop,.wth-splash').forEach(function(el) { el.remove(); });
  }

  // â”€â”€ Snow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  var _FLAKES = ['â„','â…','â†','*','Â·'];

  function _spawnFlake() {
    if (!_snowActive) return;
    var f = document.createElement('div');
    f.className = 'wth-flake';
    var x     = Math.random() * 100;
    var size  = 10 + Math.random() * 16;
    var dur   = 5 + Math.random() * 8;
    var del   = Math.random() * 5;
    var drift = (Math.random() - 0.5) * 90;
    f.textContent = _FLAKES[Math.floor(Math.random() * _FLAKES.length)];
    f.style.cssText = 'left:' + x + '%;font-size:' + size + 'px;' +
      'animation-duration:' + dur + 's;animation-delay:' + del + 's;--wth-drift:' + drift + 'px';
    document.body.appendChild(f);
    var tid = setTimeout(function() {
      f.remove();
      if (_snowActive) _spawnFlake();
    }, (dur + del) * 1000);
    _snowTids.push(tid);
  }

  function _startSnow() {
    if (_snowActive) return;
    _snowActive = true;
    document.body.classList.add('wth-snowing');
    for (var i = 0; i < 26; i++) _spawnFlake();
    _startFrost();
  }

  function _stopSnow() {
    _snowActive = false;
    document.body.classList.remove('wth-snowing');
    _snowTids.forEach(function(t) { clearTimeout(t); }); _snowTids = [];
    document.querySelectorAll('.wth-flake').forEach(function(el) { el.remove(); });
  }

  // â”€â”€ Frost â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _startFrost() {
    if (_frostEl) return;
    document.body.classList.add('wth-frost');
    _frostEl = document.createElement('div');
    _frostEl.id = 'wthFrost';
    document.body.appendChild(_frostEl);

    _iciclesEl = document.createElement('div');
    _iciclesEl.id = 'wthIcicles';
    var cols = Math.floor(window.innerWidth / 38) + 3;
    for (var i = 0; i < cols; i++) {
      var ic = document.createElement('div');
      ic.className = 'wth-icicle';
      var h = 28 + Math.random() * 82;
      var w = 6  + Math.random() * 10;
      ic.style.cssText = 'height:' + h + 'px;width:' + w + 'px;animation-delay:' + (Math.random() * 3) + 's';
      _iciclesEl.appendChild(ic);
    }
    document.body.appendChild(_iciclesEl);
  }

  function _stopFrost() {
    if (!_frostEl) return;
    document.body.classList.remove('wth-frost');
    _frostEl.remove(); _frostEl = null;
    if (_iciclesEl) { _iciclesEl.remove(); _iciclesEl = null; }
  }

  // â”€â”€ Heat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _startHeat() {
    if (_heatActive) return;
    _heatActive = true;
    document.body.classList.add('wth-hot');

    _heatStage = document.createElement('div');
    _heatStage.id = 'wthHeatStage';
    for (var i = 0; i < 14; i++) {
      var wv = document.createElement('div');
      wv.className = 'wth-heat-wave';
      var dur = 1.4 + Math.random() * 2;
      var del = Math.random() * 3;
      var x   = Math.random() * 90;
      var pw  = 70 + Math.random() * 200;
      wv.style.cssText = 'left:' + x + '%;width:' + pw + 'px;' +
        'animation-duration:' + dur + 's;animation-delay:' + del + 's';
      _heatStage.appendChild(wv);
    }
    document.body.appendChild(_heatStage);

    _heatOverlay = document.createElement('div');
    _heatOverlay.className = 'wth-heat-overlay';
    document.body.appendChild(_heatOverlay);
  }

  function _stopHeat() {
    if (!_heatActive) return;
    _heatActive = false;
    document.body.classList.remove('wth-hot');
    if (_heatStage)   { _heatStage.remove();   _heatStage = null; }
    if (_heatOverlay) { _heatOverlay.remove();  _heatOverlay = null; }
  }

  // â”€â”€ Apply effects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _applyEffects() {
    if (!_wthOn || !_wthData) {
      _stopRain(); _stopSnow(); _stopFrost(); _stopHeat(); return;
    }
    var temp_f = _wthData.temp_f;
    var code   = _wthData.code;

    if (_isRain(code)) _startRain(); else _stopRain();

    if (_isSnow(code)) {
      _startSnow();
    } else {
      _stopSnow();
      if (temp_f <= _wthFrostF) _startFrost(); else _stopFrost();
    }

    if (temp_f >= _wthHotF) _startHeat(); else _stopHeat();
  }

  // â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _render();
  setInterval(_tick, 15000);
  if (_wthOn) _locate();
  setInterval(function() { if (_wthOn) _locate(); }, 30 * 60 * 1000);

  // â”€â”€ Public API for settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.wthSettings = {
    toggle: function(on) {
      _wthOn = on;
      localStorage.setItem('wth_on', on ? '1' : '0');
      _widget.classList.toggle('wth-hidden', !on);
      if (on) { _locate(); }
      else { _stopRain(); _stopSnow(); _stopFrost(); _stopHeat(); }
    },
    setUnit: function(u) {
      _wthUnit = u;
      localStorage.setItem('wth_unit', u);
      _render();
    },
    setHotF: function(v) {
      _wthHotF = v;
      localStorage.setItem('wth_hot_f', v);
      if (_wthData) _applyEffects();
    },
    setFrostF: function(v) {
      _wthFrostF = v;
      localStorage.setItem('wth_frost_f', v);
      if (_wthData) _applyEffects();
    },
    getState: function() {
      return { on: _wthOn, unit: _wthUnit, hotF: _wthHotF, frostF: _wthFrostF };
    },
    forceEffect: function(mode) {
      // Stop everything first
      _stopRain(); _stopSnow(); _stopFrost(); _stopHeat();
      if (mode === 'rain')  { _startRain(); }
      if (mode === 'snow')  { _startSnow(); }
      if (mode === 'frost') { _startFrost(); }
      if (mode === 'heat')  { _startHeat(); }
      if (mode === 'clear') { /* already stopped */ }
      // Update preview button states
      document.querySelectorAll('.wth-test-btn').forEach(function(b) {
        b.classList.toggle('wth-test-active', b.dataset.mode === mode);
      });
    }
  };
})();

