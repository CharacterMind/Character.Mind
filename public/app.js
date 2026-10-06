// ── State ─────────────────────────────────────────────────────────────────────
let knownTemplateAliases = [];
let templatesLoaded = false;
let currentUser = null;
let characters = [];
let currentChar = null;
let currentChatLocked = false;
let isStreaming = false;
let callModeActive = false;
let chatEpoch = 0; // bumps whenever the open chat changes, so an old reply can't land in the new chat
let currentFilter = 'all';
let lastUserMessage = '';
// ── Model & Effort state ───────────────────────────────────────────────────────
const EFFORT_LEVELS = ['low','medium','high','extra','max'];
const BASE_TIERS = ['opas','opes','opis','opos','opus','opys','opys5'];
const ALL_TIERS = BASE_TIERS;
// Older saved choices such as "opys5" mean the base model
const baseTierOf = (t) => {
  if (typeof t !== 'string') return null;
  if (BASE_TIERS.includes(t)) return t;                       // "opys5" is the flagship model itself
  const b = t.replace(/[2-5]$/, '');
  return (b !== 'opys5' && BASE_TIERS.includes(b)) ? b : null;
};
// The chosen model and effort are remembered per account (see loadAccountPrefs), never shared between accounts
let selectedModelTier = 'opas';
let selectedEffort = 'medium';
let prefsLoadedFor = null;
function loadAccountPrefs() {
  if (!currentUser || prefsLoadedFor === currentUser.googleId) return;
  prefsLoadedFor = currentUser.googleId;
  selectedModelTier = 'opas';
  selectedEffort = 'medium';
  try {
    const t = localStorage.getItem(userKey('cm_model_tier'));
    if (baseTierOf(t)) selectedModelTier = baseTierOf(t);
    const e = localStorage.getItem(userKey('cm_effort'));
    if (EFFORT_LEVELS.includes(e)) selectedEffort = e;
  } catch (_) {}
  updateModelBarLabel();
}

const MODEL_LABELS  = { opas:'Opas', opes:'Opes', opis:'Opis', opos:'Opos', opus:'Opus', opys:'Opys', opys5:'Opys 5' };
// Must match OPAS_COST / OPES_COST / COST_FACTOR_VS_OPES in server.js — what one reply costs from the allowance.
const OPAS_COST = { low: 220, medium: 350, high: 540, extra: 800, max: 1200 };
const OPES_COST = { low: 700, medium: 1200, high: 1800, extra: 2600, max: 4000 };
const COST_FACTOR_VS_OPES = { opes: 1, opis: 1.25, opos: 1.5, opus: 2, opys: 3, opys5: 10 };
const BASE_PLAN_RANK = { opas: 0, opes: 0, opis: 1, opos: 1, opus: 2, opys: 3, opys5: 4 };
const PLAN_RANK = { free: 0, advanced: 1, x20: 2, x50: 3, x100: 4 };
function clientMessageCost(tier, effort) {
  tier = baseTierOf(tier) || tier;
  if (tier === 'opas' || !(tier in COST_FACTOR_VS_OPES)) return OPAS_COST[effort];
  return Math.round(OPES_COST[effort] * COST_FACTOR_VS_OPES[tier]);
}
// Roughly how many visible characters a full reply has at each effort (used to ramp the live counter up to the cost)
const EXPECTED_REPLY_CHARS = { low: 250, medium: 500, high: 1200, extra: 2500, max: 4000 };
// Every model is asked for a set number of words at High, Extra and Max (must match WORDS_BY_EFFORT / MODEL_WORDS in server.js)
const WORDS_BY_EFFORT = { high: 350, extra: 600, max: 900 };
const MODEL_WORDS = { opas: 0.7, opes: 1, opis: 1.1, opos: 1.3, opus: 1.6, opys: 1.9, opys5: 3.5 };
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
  if (!(PLAN_MODEL_TIERS[plan] || PLAN_MODEL_TIERS.free).includes(tier)) tier = 'opes';
  const effort = callModeActive ? 'low' : (OPES_COST[selectedEffort] ? selectedEffort : 'medium');
  return { cost: clientMessageCost(tier, effort), effort, tier };
}
// The live counter under a reply: it ramps up to the price of the reply and then KEEPS counting at the same pace for as long
// as the reply keeps writing (long replies run far past the "expected" length). The usage bars still stop at the real price.
function liveTokensShown(chars) {
  const { cost, effort, tier } = liveReplyCost();
  return Math.round(cost * chars / expectedReplyChars(tier, effort));
}
const EFFORT_LABELS = { low:'Low', medium:'Medium', high:'High', extra:'Extra', max:'Max' };

// Token usage multiplier shown on Max effort warning per tier.
// Each value = max effort cost on that model ÷ OPAS medium (the cheapest baseline reply).
// This shows the true usage escalation from OPAS → Opys 5 at Max effort.
const MAX_EFFORT_MULTIPLIERS = {};
{
  const baseline = OPAS_COST.medium; // 350 tokens — cheapest normal reply
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

  // Update effort picker checks and max multiplier label
  EFFORT_LEVELS.forEach(e => {
    const el = document.getElementById('effortOpt' + e.charAt(0).toUpperCase() + e.slice(1));
    if (el) el.classList.toggle('active', e === selectedEffort);
  });
  const maxWarn = document.getElementById('effortMaxWarn');
  if (maxWarn) maxWarn.textContent = '⚠ ' + (MAX_EFFORT_MULTIPLIERS[selectedModelTier] || '3.4×') + ' vs baseline usage';
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
    key: 'free', name: 'Free', monthly: 0, annual: 0,
    callsPerDay: 3, memosPerDay: 30,
    features: [
      'Opas & Opes: fast, capable AI for casual chats',
      'Every character unlocked — no paywalled cast',
      '3 messages per day to try it out',
      '1 image upload per day',
    ],
  },
  {
    key: 'advanced', name: 'Advanced', monthly: 4.99, annual: 44.99,
    callsPerDay: 5, memosPerDay: 50,
    features: [
      'Opis: sharp at logic, riddles, and light banter',
      'Opos: GM-mode — sets scenes, runs NPCs, drives drama',
      '5 messages per day — enough for daily check-ins',
      '10 image uploads per day',
      'Everything in Free',
    ],
  },
  {
    key: 'x20', name: 'X20', badge: 'Recommended', monthly: 24.99, annual: 199.99,
    callsPerDay: 100, memosPerDay: 1000,
    features: [
      'Opus: writes full story chapters with real emotional depth',
      'Tracks your story from the first message — no repetition, no forgetting',
      'Replies are 3–5× longer and more immersive than free models',
      '100 messages per day — enough for a serious writing session',
      '200 image uploads per day',
      'Everything in Advanced',
    ],
  },
  {
    key: 'x50', name: 'X50', badge: 'Best Value', monthly: 49.99, annual: 399.99,
    callsPerDay: 250, memosPerDay: 2500,
    features: [
      'Opys: the full novelist — handles multi-chapter arcs and complex casts',
      'Remembers your entire story history across every session',
      'Plans scenes before writing them: outlines, tension beats, payoffs',
      'Builds full story arcs — not just replies, but structured narratives',
      '250 messages per day — enough to write a novel chapter by chapter',
      '500 image uploads per day',
      'Everything in X20',
    ],
  },
  {
    key: 'x100', name: 'X100', badge: 'Ultimate', monthly: 99.99, annual: 799.99,
    callsPerDay: 500, memosPerDay: 5000,
    features: [
      'Opys 5: the most powerful creative AI available — exclusive to X100',
      'Writes full novel-length chapters: rich prose, deep character voice, layered subtext',
      'Triple-pass refinement: outlines the scene, drafts it, then rewrites for quality',
      'Zero repetition — tracks every plot point, line, and character detail ever written',
      'Handles full novels, series arcs, and long-running collaborative stories',
      '500 messages per day — built for dedicated writers and daily storytellers',
      '1,000 image uploads per day',
      'Everything in X50',
    ],
  },
];

const PLAN_LABELS = { free: 'Free', advanced: 'Advanced', x20: 'X20', x50: 'X50', x100: 'X100' };
const PLAN_SUBS = {
  free:     'Free plan',
  advanced: 'Advanced plan',
  x20:      'X20 plan',
  x50:      'X50 plan',
  x100:     'X100 plan',
};
// X100 is sold only once its own PayPal plans are set up on the server (until then its card says "Coming soon")
function planBuyable(key) {
  if (key !== 'x100') return true;
  return !!(PAYPAL_PLAN_IDS.x100 && (pricingPeriod !== 'annual' || PAYPAL_PLAN_IDS_YEARLY.x100));
}

let pricingPeriod = 'monthly';

function openPricingModal() {
  loadPaypalConfig().then(() => { setPricingPeriod(pricingPeriod); });
  renderPricingCards();
  document.getElementById('pricingModal').style.display = 'flex';
}
function closePricingModal() {
  document.getElementById('pricingModal').style.display = 'none';
}
function setPricingPeriod(period) {
  // Yearly prices are only shown when yearly PayPal plans really exist (otherwise the person would be charged the monthly price).
  if (!yearlyAvailable) period = 'monthly';
  pricingPeriod = period;
  document.getElementById('pricingBtnMonthly').classList.toggle('pt-active', period === 'monthly');
  document.getElementById('pricingBtnAnnual').classList.toggle('pt-active', period === 'annual');
  renderPricingCards();
}

function renderPricingCards() {
  const container = document.getElementById('pricingCards');
  if (!container) return;
  const currentTier = lastKnownUsage?.subscriptionTier || 'free';
  container.innerHTML = PLAN_DATA.map(plan => {
    const isCurrent = plan.key === currentTier;
    const price = pricingPeriod === 'annual' ? plan.annual : plan.monthly;
    const priceStr = price === 0 ? 'Free' : `$${price.toFixed(2)}`;
    const periodStr = price === 0 ? 'forever' : pricingPeriod === 'annual' ? '/ year' : '/ month';
    let perMonth = '<div class="pc-per-month"></div>';
    if (plan.annual > 0 && pricingPeriod === 'annual') {
      const savePct = Math.round((1 - plan.annual / (plan.monthly * 12)) * 100);
      perMonth = `<div class="pc-per-month">~$${(plan.annual / 12).toFixed(2)}/mo &nbsp;<span class="pc-save-pct">Save ${savePct}%</span></div>`;
    }
    const badge = plan.badge ? `<div class="pc-badge">${escHtml(plan.badge)}</div>` : '';
    const features = plan.features.map(f => `<li>✓ ${escHtml(f)}</li>`).join('');
    const soon = !isCurrent && !planBuyable(plan.key);
    const ctaText = isCurrent ? 'Current plan' : soon ? 'Coming soon' : 'Upgrade';
    const ctaClass = 'pc-cta' + (isCurrent || soon ? ' pc-cta-current' : '');
    return `<div class="pricing-card${isCurrent ? ' pc-current' : ''}${plan.badge ? ' pc-featured' : ''}">
      ${badge}
      <div class="pc-name">${escHtml(plan.name)}</div>
      <div class="pc-price">${priceStr}<span class="pc-period"> ${periodStr}</span></div>
      ${perMonth}
      <ul class="pc-features">${features}</ul>
      <button class="${ctaClass}" ${isCurrent || soon ? 'disabled' : `onclick="handleUpgradeCta('${plan.key}')"`}>${ctaText}</button>
    </div>`;
  }).join('');
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
let paypalCardFields = null;

function handleUpgradeCta(planKey) {
  if (planKey === 'free' || !planBuyable(planKey)) return;
  openPaypalCheckout(planKey, yearlyAvailable && pricingPeriod === 'annual' ? 'annual' : 'monthly');
}

async function openPaypalCheckout(planKey, period) {
  const plan = PLAN_DATA.find(p => p.key === planKey);
  if (!plan) return;
  currentCheckoutPlan = planKey;
  await loadPaypalConfig();
  currentCheckoutPeriod = (period === 'annual' && yearlyAvailable) ? 'annual' : 'monthly';
  const yearly = currentCheckoutPeriod === 'annual';

  document.getElementById('paypalCheckoutTitle').textContent = `${plan.name} Plan${yearly ? ' (yearly)' : ''}`;
  const price = yearly ? plan.annual : plan.monthly;
  const priceStr = `$${price.toFixed(2)} / ${yearly ? 'yr' : 'mo'}`;
  document.getElementById('paypalCheckoutPrice').textContent = priceStr;
  const tot = document.getElementById('co-total-display');
  if (tot) tot.textContent = `$${price.toFixed(2)}`;
  document.getElementById('paypal-checkout-status').textContent = '';
  document.getElementById('paypal-checkout-status').style.color = '';
  document.getElementById('paypalCheckoutModal').style.display = 'flex';


  if (!paypalSdkLoaded && !paypalSdkLoading) {
    paypalSdkLoading = true;
    document.getElementById('paypal-checkout-status').textContent = 'Loading payment system…';
    try {
      const cfg = await fetch('/api/paypal/config').then(r => r.json());
      if (cfg && cfg.planIds) Object.assign(PAYPAL_PLAN_IDS, cfg.planIds);
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.clientId)}&vault=true&intent=subscription&components=buttons,card-fields`;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      paypalSdkLoaded = true;
      document.getElementById('paypal-checkout-status').textContent = '';
    } catch (err) {
      document.getElementById('paypal-checkout-status').textContent = 'Failed to load payment system. Please refresh and try again.';
      paypalSdkLoading = false;
      return;
    }
  }

  if (paypalSdkLoaded) initPayPalWidgets(planKey);
}

function initPayPalWidgets(planKey) {
  const planId = (currentCheckoutPeriod === 'annual' ? PAYPAL_PLAN_IDS_YEARLY : PAYPAL_PLAN_IDS)[planKey];
  if (!planId || typeof paypal === 'undefined') return;

  // PayPal wallet button
  try {
    const ppContainer = document.getElementById('paypal-button-container');
    if (ppContainer) ppContainer.innerHTML = '';
    paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'subscribe' },
      createSubscription(data, actions) {
        return actions.subscription.create({ plan_id: planId, custom_id: String(currentUser.googleId) });
      },
      onApprove(data) { return verifyAndActivateSubscription(data.subscriptionID, planKey); },
      onError(err) {
        document.getElementById('paypal-checkout-status').textContent = 'Payment failed. Please try again.';
        console.error('PayPal error:', err);
      }
    }).render('#paypal-button-container');
  } catch (err) { console.error('PayPal button render error:', err); }

  // Credit card fields
  try {
    paypalCardFields = null;
    const eligible = paypal.CardFields && paypal.CardFields({
      createSubscription(data, actions) {
        return actions.subscription.create({ plan_id: planId, custom_id: String(currentUser.googleId) });
      },
      onApprove(data) { return verifyAndActivateSubscription(data.subscriptionID, planKey); },
      onError(err) {
        document.getElementById('paypal-checkout-status').textContent = 'Card payment failed. Please try again.';
        document.getElementById('card-submit-btn').disabled = false;
        document.getElementById('card-submit-btn').textContent = 'Subscribe Now';
        console.error('Card error:', err);
      }
    });

    if (eligible && eligible.isEligible()) {
      paypalCardFields = eligible;
      ['card-name-field-container', 'card-number-field-container', 'card-expiry-field-container', 'card-cvv-field-container'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
      });
      paypalCardFields.NameField().render('#card-name-field-container');
      paypalCardFields.NumberField().render('#card-number-field-container');
      paypalCardFields.ExpiryField().render('#card-expiry-field-container');
      paypalCardFields.CVVField().render('#card-cvv-field-container');
      document.getElementById('card-submit-btn').style.display = 'block';
      document.getElementById('card-not-eligible').style.display = 'none';
    } else {
      document.getElementById('card-submit-btn').style.display = 'none';
      document.getElementById('card-not-eligible').style.display = 'block';
    }
  } catch (err) {
    console.error('CardFields init error:', err);
    document.getElementById('card-submit-btn').style.display = 'none';
    document.getElementById('card-not-eligible').style.display = 'block';
  }
}

async function submitCardPayment() {
  if (!paypalCardFields) return;
  const btn = document.getElementById('card-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Processing…';
  try {
    await paypalCardFields.submit();
  } catch (err) {
    document.getElementById('paypal-checkout-status').textContent = 'Card payment failed. Please check your details and try again.';
    btn.disabled = false;
    btn.textContent = 'Subscribe Now';
  }
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
}

function coPayBtnClick() {
  document.getElementById('card-submit-btn').click();
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
  if (!paypalConfigLoaded) loadPaypalConfig().then(() => renderSettingsTiers(currentTier));
  const el = document.getElementById('settingsTiersSection');
  if (!el) return;
  const t = currentTier || lastKnownUsage?.subscriptionTier || 'free';
  const period = pricingPeriod;
  const icons = {
    advanced: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M13 2.05v2.02c3.95.49 7 3.85 7 7.93 0 3.21-1.81 6-4.72 7.72L13 18v4l-1.73-1-1.27.73V18l-2.28 1.65C4.78 18 3 15.21 3 12c0-4.08 3.05-7.44 7-7.93V2.05h3zm-1 2.96C9.03 5.44 7 8.5 7 12c0 2.42 1.17 4.65 3 6.07V14h4v4.07c1.83-1.42 3-3.65 3-6.07 0-3.5-2.03-6.56-5-7z"/></svg>`,
    x20: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
    x50: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>`,
    x100: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>`,
  };
  const plans = PLAN_DATA.filter(p => p.key !== 'free');
  el.innerHTML = `
    <div class="st2-header">
      <span class="st2-title">Plans</span>
      ${yearlyAvailable ? `<div class="st2-toggle"><button class="st2-toggle-btn${period === 'monthly' ? ' st2-toggle-active' : ''}" onclick="setSettingsPeriod('monthly')">Monthly</button><button class="st2-toggle-btn${period === 'annual' ? ' st2-toggle-active' : ''}" onclick="setSettingsPeriod('annual')">Yearly</button></div>` : ''}
    </div>
    <div class="st2-cards-wrap">
      ${plans.map(p => {
        const isCurrent = p.key === t;
        const price = period === 'annual' ? p.annual : p.monthly;
        const badge = p.badge ? `<div class="st2-badge">${escHtml(p.badge)}</div>` : '';
        const feats = p.features.slice(0, 3).map(f =>
          `<li class="st2-feat"><svg viewBox="0 0 12 12" width="10" height="10" fill="none" style="flex-shrink:0;margin-top:2px"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>${escHtml(f)}</li>`
        ).join('');
        return `<div class="st2-card${isCurrent ? ' st2-current' : ''}${p.badge ? ' st2-featured' : ''}">
          ${badge}
          <div class="st2-icon-wrap">${icons[p.key] || ''}</div>
          <div class="st2-plan-name">${escHtml(p.name)}</div>
          <div class="st2-price-row"><span class="st2-price">$${price.toFixed(2)}</span><span class="st2-period">${period === 'annual' ? '/yr' : '/mo'}</span></div>
          <ul class="st2-feats">${feats}</ul>
          <button class="st2-btn${isCurrent || !planBuyable(p.key) ? ' st2-btn-current' : ''}" ${isCurrent || !planBuyable(p.key) ? 'disabled' : `onclick="handleUpgradeCta('${p.key}')"`}>${isCurrent ? 'Current' : !planBuyable(p.key) ? 'Coming soon' : 'Subscribe'}</button>
        </div>`;
      }).join('')}
    </div>`;
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

  document.getElementById('appLoading').style.display = 'none';

  if (currentUser) {
    document.getElementById('authLanding').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    renderUserBadge();
    await loadCharacters();
    renderHome();
    renderDiscover();
    renderFeed();
    loadUsage();
    maybeShowWelcome();
    initSidebarState();
    initRpMode();
    updateModelBarLabel();
  } else {
    document.getElementById('authLanding').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    // Show error toast if auth failed or isn't configured yet
    const authParam = new URLSearchParams(window.location.search).get('auth');
    if (authParam === 'fail') showWarning('Sign-in failed. Please try again.');
    if (authParam === 'unavailable') showWarning('Google sign-in is not set up yet. Check back soon!');
    if (authParam) history.replaceState({}, '', '/');
  }
});

async function loadCharacters() {
  await Promise.all([syncHiddenRecentsFromServer(), syncRecentChatsFromServer()]);
  try {
    const res = await fetch('/api/characters');
    if (res.status === 401) { characters = []; renderSidebarChats(); return; }
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
    // Only luminance — no hue is visible, only brightness difference matters
    colors: ['#ffffff','#d4d4d4','#a3a3a3','#737373','#404040','#1a1a1a','#e5e5e5','#525252'],
    defaults: ['#d4d4d4','#525252']
  }
};

function _applyGCPalette(mode) {
  const container = document.getElementById('gradientSwatches');
  const colorRow = document.getElementById('gcColorRow');
  const achroNote = document.getElementById('gcAchroNote');
  const strip = document.getElementById('gcPaletteStrip');

  // Achromatopsia — hide the whole picker, show a note instead
  if (mode === 'achromatopsia') {
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
  badge.innerHTML = `
    ${avatarHtml(currentUser, 32)}
    <span class="ub-text-wrap">
      <span class="ub-name">${escHtml(getDisplayName())}</span>
      <span class="ub-plan">${PLAN_LABELS[lastKnownUsage?.subscriptionTier || 'free'] || 'Free'}</span>
    </span>
    <svg class="ub-chevron" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
  `;
  badge.onclick = toggleUserDropdown;

  const udAvatar = document.getElementById('udAvatar');
  const udName   = document.getElementById('udName');
  if (udAvatar) udAvatar.innerHTML = avatarHtml(currentUser, 38);
  if (udName)   udName.textContent  = getDisplayName();
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

const WELCOME_VERSION = 'v4'; // bumped so everyone sees the new welcome once

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
}

function updateSettingsUsage(u) {
  if (!u) return;
  applyUsageResets(u);
  if (isStreaming) return;   // not while a reply is being written (see updateUsageBars)
  const settingsModal = document.getElementById('settingsModal');
  if (!settingsModal || settingsModal.style.display === 'none') return;
  const sPct = Math.min(100, Math.round((u.sessionTokens / u.sessionLimit) * 100));
  const wPct = Math.min(100, Math.round((u.weeklyTokens / u.weeklyLimit) * 100));
  const fillClass = p => p >= 90 ? 'danger' : p >= 75 ? 'warn' : '';   // the same steps as the usage window (50 / 75 / 90)
  const sBar = document.getElementById('settingsSessionBar');
  if (sBar) { sBar.style.width = sPct + '%'; sBar.className = 'settings-usage-bar-fill ' + fillClass(sPct); }
  const sPctEl = document.getElementById('settingsSessionPct');
  if (sPctEl) sPctEl.textContent = sPct + '%';
  const wBar = document.getElementById('settingsWeeklyBar');
  if (wBar) { wBar.style.width = wPct + '%'; wBar.className = 'settings-usage-bar-fill ' + fillClass(wPct); }
  const wPctEl = document.getElementById('settingsWeeklyPct');
  if (wPctEl) wPctEl.textContent = wPct + '%';
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
      <button class="home-announce-btn" onclick="openAnnouncement()" title="What's new">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.66 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"/></svg>
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
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  // Ensure minimum perceived brightness so colors are legible on dark backgrounds
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 70) {
    const scale = 70 / Math.max(lum, 1);
    r = Math.min(255, Math.round(r * scale));
    g = Math.min(255, Math.round(g * scale));
    b = Math.min(255, Math.round(b * scale));
  }
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}
// Build name HTML with each non-space character wrapped in a random-color span.
function colorizeNameHtml(name, c) {
  const hexes = String(c || '').match(/#[0-9a-fA-F]{6}/gi);
  if (!hexes || !hexes.length) return escHtml(name || '');
  const colors = hexes.map(boostColor);
  return [...(name || '')].map(ch =>
    /\s/.test(ch) ? escHtml(ch) : `<span style="color:${colors[Math.floor(Math.random()*colors.length)]};font-weight:700">${escHtml(ch)}</span>`
  ).join('');
}
// Wrap every non-whitespace character in the bubble in a random-colored span.
function colorizeLetters(bubble, c) {
  if (!bubble) return;
  const hexes = String(c || '').match(/#[0-9a-fA-F]{6}/gi);
  if (!hexes || !hexes.length) return;
  const colors = hexes.map(boostColor);
  // Clear any gradient text style so child span colors aren't swallowed
  bubble.style.background = '';
  bubble.style.webkitBackgroundClip = '';
  bubble.style.backgroundClip = '';
  bubble.style.webkitTextFillColor = '';
  bubble.style.color = '';
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let nd;
  while (nd = walker.nextNode()) nodes.push(nd);
  for (const tn of nodes) {
    if (tn.parentNode.closest && tn.parentNode.closest('code, pre')) continue;
    const frag = document.createDocumentFragment();
    for (const ch of tn.textContent) {
      if (/\s/.test(ch)) { frag.appendChild(document.createTextNode(ch)); continue; }
      const sp = document.createElement('span');
      sp.style.color = colors[Math.floor(Math.random() * colors.length)];
      sp.style.fontWeight = '700';
      sp.textContent = ch;
      frag.appendChild(sp);
    }
    tn.parentNode.replaceChild(frag, tn);
  }
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
  return `<div class="char-row" data-id="${safeId}" onclick="openChat(this.dataset.id)">
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
  return `<div class="char-card" data-id="${escHtml(c.id)}" onclick="openChat(this.dataset.id)">
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
    const name = item.querySelector('.chat-item-name').textContent.toLowerCase();
    item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ── Local history persistence (survives server restarts) ─────────────────────
function saveHistoryLocal() {
  if (!currentChar) return;
  try {
    const msgs = document.getElementById('messages');
    const items = [...msgs.querySelectorAll('.msg')].map(el => el.classList.contains('nsfw-msg')
      ? { role: 'ai', content: '', card: 'nsfw', variant: Number(el.dataset.nsfwVariant) || 0 }
      : {
          role: el.classList.contains('user') ? 'user' : 'ai',
          content: bubbleToRaw(el.querySelector('.bubble')),
          ...(el.dataset.sig ? { sig: el.dataset.sig } : {})
        }).filter(m => (m.content || m.card) && !(m.role === 'ai' && /^\s*⚠️/.test(m.content)));
    const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
    all[currentChar.id] = items.slice(-150);
    localStorage.setItem(userKey('cm_history'), JSON.stringify(all));
  } catch (_) {}
}

function loadHistoryLocal(charId) {
  try {
    const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
    return all[charId] || [];
  } catch (_) { return []; }
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
  abandonStream();
  releaseChatInput();
  clearPendingImage();   // an attached picture belongs to the chat it was attached in
  const openEpoch = chatEpoch;
  currentChar = nextChar;
  applyChatTheme(currentChar);
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
  }
  if (mobNmEl) { mobNmEl.innerHTML = colorizeNameHtml(currentChar.name, currentChar.color); }

  // Update info panel
  const ia = document.getElementById('infoAvatar');
  if (ia) {
    if (isCharImg(currentChar.image)) { ia.style.background = '#111'; ia.style.borderRadius = '12px'; ia.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`; }
    else { ia.style.background = safeColor(currentChar.color); ia.style.borderRadius = '12px'; ia.textContent = currentChar.name[0]||'?'; }
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

  // Load conversation history — server first, localStorage fallback
  let history = [];
  try {
    const res = await fetch(`/api/conversations/${charId}`);
    if (chatEpoch !== openEpoch) return; // preempted by a newer openChat call
    if (res.ok) history = await res.json();
  } catch (_) { /* server temporarily unavailable; use localStorage */ }
  if (chatEpoch !== openEpoch) return;

  const messagesDiv = document.getElementById('messages');
  warnedThresholds.clear();
  loadUsage();

  // If the server only has part of the chat (it restarted mid-conversation), the fuller local copy wins and is re-synced.
  if (history.length > 0 && shownLocal.length > history.length) history = [];
  const lastOf = (h) => { const m = h[h.length - 1]; return m ? String(m.content || '') + (m.card || '') : ''; };
  const sameAsShown = history.length > 0 && history.length === shownLocal.length && lastOf(history) === lastOf(shownLocal);

  if (history.length === 0) {
    const localHistory = shownLocal;                      // already on screen
    if (localHistory.length > 0) {
      // Auto-save prior session to local past chats before restoring
      savePastChatLocal(charId, localHistory);
      document.getElementById('chatWelcome').innerHTML = '';
      updateCtxBar();
      // Re-sync server so AI has context for next message
      fetch(`/api/conversations/${charId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: localHistory })
      }).catch(() => {});
    } else {
      messagesDiv.innerHTML = '';
      document.getElementById('chatWelcome').innerHTML = '';
      if (currentChar.greeting && currentChar.greetingMode !== 'auto') {
        appendMessage('ai', currentChar.greeting);
        saveHistoryLocal();
        fetch(`/api/conversations/${charId}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: [{ role: 'assistant', content: currentChar.greeting }] })
        }).catch(() => {});
      } else {
        generateGreeting();
      }
    }
  } else if (sameAsShown) {
    document.getElementById('chatWelcome').innerHTML = '';   // what is shown is already right
    // ...but its signatures must be the server's current ones, or a later re-sync would drop these replies
    const aiEls = [...messagesDiv.querySelectorAll('.msg.ai:not(.nsfw-msg)')];
    const aiHist = history.filter(m => (m.role === 'assistant' || m.role === 'ai') && !m.card);
    if (aiEls.length === aiHist.length) aiEls.forEach((el, i) => { if (aiHist[i].sig) el.dataset.sig = aiHist[i].sig; else delete el.dataset.sig; });
  } else {
    messagesDiv.innerHTML = '';
    document.getElementById('chatWelcome').innerHTML = '';
    history.forEach((m, i) => appendHistoryItem(m, i < history.length - LIVE_COLOUR_MESSAGES));
  }

  renderSidebarChats();
  if (currentChatLocked) {
    showLockedBar();
    return;
  }
  document.getElementById('messageInput').focus();
  scrollToBottom();
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
  document.getElementById('sendBtn').disabled = true;

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
        if (data.done && data.usage) { markStreamDone(); streamRealTokens = data.responseTokens || null; streamSig = data.sig || null; pendingUsage = data.usage; }
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
    }
  } finally {
    if (myEpoch === chatEpoch) showTyping(false);
  }
}

// ── Image attachment ──────────────────────────────────────────────────────────
let rpMode = true; // true = roleplay mode (default), false = normal chat mode

function toggleRpMode() {
  rpMode = !rpMode;
  try { localStorage.setItem('cm_rp_mode', rpMode ? '1' : '0'); } catch (_) {}
  updateRpModeUI();
}

function updateRpModeUI() {
  const btn = document.getElementById('mbRpBtn');
  if (!btn) return;
  if (rpMode) {
    btn.textContent = 'RP';
    btn.title = 'Switch to normal chat mode';
    btn.classList.remove('rp-off');
  } else {
    btn.textContent = 'Chat';
    btn.title = 'Switch to roleplay mode';
    btn.classList.add('rp-off');
  }
}

function initRpMode() {
  try { rpMode = localStorage.getItem('cm_rp_mode') !== '0'; } catch (_) {}
  updateRpModeUI();
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
  if (thumb) thumb.src = '';
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
async function sendMessage(overrideText, skipAppend, allowEmpty) {
  if (!currentChar) return;
  const myEpoch = chatEpoch;   // taken BEFORE any waiting, so a chat switch during the request is noticed
  // If we're locked out (limit reached), re-show the modal with a new message every attempt
  const lockoutBarEl = document.getElementById('lockoutBar');
  if (lockoutBarEl && lockoutBarEl.style.display !== 'none') {
    const lockoutType = document.getElementById('lockoutMsg')?.textContent?.toLowerCase().includes('session') ? 'session' : 'weekly';
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
  const bumpIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => streamAbortCtrl.abort(), 45000); };
  const capTimer = setTimeout(() => streamAbortCtrl.abort(), 360000);
  const streamTimeout = { clear() { clearTimeout(idleTimer); clearTimeout(capTimer); } };
  bumpIdle();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ charId: currentChar.id, message: text, modelTier: callModeActive ? 'opas' : selectedModelTier, effort: callModeActive ? 'low' : selectedEffort, ...(imgB64 ? { image: imgB64 } : {}), ...(callModeActive ? { callMode: true } : {}), ...(bookExtra ? { book: bookExtra } : {}), chatMode: rpMode ? 'rp' : 'chat' }),
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
      let convEnded = false;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data; try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }
        if (data.error) throw new Error(data.error);
        if (data.nsfw) { showTyping(false); appendNsfwCard(data.variant); }
        if (data.conversationEnded) {
          convEnded = true;
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
        if (data.done && data.usage) { markStreamDone(); streamRealTokens = data.responseTokens || null; streamSig = data.sig || null; pendingUsage = data.usage; }
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
      if (convEnded) { isStreaming = false; streamTimeout.clear(); return; }
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
    appendMessage('ai', `⚠️ ${errMsg}`);
    if (callModeActive) setTimeout(() => listenForSpeech(), 2000);
  }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

// ── Usage / rate-limit system ─────────────────────────────────────────────────
let cooldownTimer = null;
let cooldownSyncTimeout = null;

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
  renderUsageBanners(usage);
  updateUsageModal(usage);
  updateSettingsUsage(usage);
  updateImageAttachState(usage);
  if (usage.cooldownUntil && Date.now() < usage.cooldownUntil) {
    startCooldown(usage.cooldownUntil, 'session');
  } else if (usage.weeklyTokens >= usage.weeklyLimit) {
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
  if (inp) inp.disabled = true;
  // keep send button enabled so clicks re-show the limit modal with a new message

  const cd = document.getElementById('lockoutCountdown');

  function updateCountdown() {
    if (Date.now() >= until) { clearLockout(); loadUsage(); return; }
    const str = formatResetTime(until);
    if (cd) cd.textContent = str;
    if (type === 'session') {
      const sub = document.getElementById('limitModalSub');
      if (sub && document.getElementById('limitModal')?.style.display !== 'none') sub.textContent = str;
      const sSubEl = document.getElementById('usageSessionSub');
      if (sSubEl) sSubEl.textContent = str;
    }
  }

  if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  if (cooldownSyncTimeout) { clearTimeout(cooldownSyncTimeout); cooldownSyncTimeout = null; }
  updateCountdown();
  // 1-second interval: always exactly in sync, no drift possible
  cooldownTimer = setInterval(updateCountdown, 1000);

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
  const msgEl = document.getElementById('limitOutdoorMsg');
  if (title) title.textContent = type === 'session' ? 'Session limit reached' : 'Weekly limit reached';
  if (sub) sub.textContent = displayStr
    ? (type === 'weekly' ? displayStr + '.' : displayStr)
    : '';
  if (msgEl) msgEl.textContent = OUTDOOR_MESSAGES[Math.floor(Math.random() * OUTDOOR_MESSAGES.length)];
  modal.style.display = 'flex';
}

function closeLimitModal() {
  const modal = document.getElementById('limitModal');
  if (modal) modal.style.display = 'none';
}

function clearLockout() {
  if (cooldownSyncTimeout) { clearTimeout(cooldownSyncTimeout); cooldownSyncTimeout = null; }
  if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  const bar = document.getElementById('lockoutBar');
  if (bar) bar.style.display = 'none';
  // Auto-close the limit modal after a 2s grace period so the user briefly sees it unlock
  const modal = document.getElementById('limitModal');
  if (modal && modal.style.display !== 'none') {
    setTimeout(() => { if (modal) modal.style.display = 'none'; }, 2000);
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
const WEEKLY_BANNER_TEXT = { 50: "You're approaching your weekly limit.", 75: "You've used 75% of your weekly limit.", 90: "You've used 90% of your weekly limit — upgrade for more." };
const SESSION_BANNER_TEXT = { 90: "You're approaching your session limit." };   // a session is short and resets by itself, so one warning is enough
function usagePctOf(used, limit) { return (limit > 0 && typeof used === 'number') ? Math.min(100, Math.round(used / limit * 100)) : 0; }   // the same rounding the bars show
function usageStep(pct) { return pct >= 90 ? 90 : pct >= 75 ? 75 : pct >= 50 ? 50 : 0; }
function bannerDismissKey() { return 'cm_usage_banner_dismissed_' + (currentUser?.googleId || 'anon'); }
function loadBannerDismissals() { try { return JSON.parse(localStorage.getItem(bannerDismissKey()) || '{}') || {}; } catch (_) { return {}; } }
function saveBannerDismissal(kind, level, windowStart) { try { const d = loadBannerDismissals(); d[kind] = { level, windowStart }; localStorage.setItem(bannerDismissKey(), JSON.stringify(d)); } catch (_) {} }
// closing a banner hides that level until the usage reaches a higher level or a new week / session begins
function bannerDismissed(w) { const d = loadBannerDismissals()[w.kind]; return !!d && d.windowStart === w.windowStart && d.level >= w.level; }

function renderUsageBanners(usage) {
  const container = document.getElementById('warningBanners');
  if (!container || !usage) return;
  const want = [];
  const wStep = usageStep(usagePctOf(usage.weeklyTokens, usage.weeklyLimit));
  if (wStep) want.push({ kind: 'weekly', level: wStep, msg: WEEKLY_BANNER_TEXT[wStep], windowStart: usage.weeklyStart || 0, upgrade: true, persistent: wStep === 90 });
  const sStep = usageStep(usagePctOf(usage.sessionTokens, usage.sessionLimit));
  if (SESSION_BANNER_TEXT[sStep]) want.push({ kind: 'session', level: sStep, msg: SESSION_BANNER_TEXT[sStep], windowStart: usage.sessionStartedAt || 0, upgrade: false, persistent: false });
  const imgsLeft = (usage.imageLimit || 0) - (usage.imagesDay || 0);
  if (imgsLeft === 1 && (usage.imageLimit || 0) > 0) {
    want.push({ kind: 'image', level: 1, msg: `One image remaining — resets ${formatImageResetTime(usage.imageResetAt || getNextDailyResetAt())}.`, windowStart: usage.imageResetAt || 0, upgrade: false, persistent: false });
  }
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
    text.textContent = w.msg + (w.upgrade ? ' ' : '');
    banner.appendChild(text);
    if (w.upgrade) {
      const link = document.createElement('button');
      link.className = 'warning-upgrade-link'; link.textContent = 'Upgrade \u2192'; link.onclick = () => openPricingModal();
      banner.appendChild(link);
    }
    const close = document.createElement('button');
    close.className = 'warning-banner-close'; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '\u2715';
    if (w.persistent) close.style.display = 'none';   // the 90% weekly warning stays until the week resets
    else close.onclick = () => { saveBannerDismissal(w.kind, w.level, w.windowStart); banner.remove(); };
    banner.appendChild(close);
    container.appendChild(banner);
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
    loadAccountPrefs();
    updateUsageBars(usage);
    updateUsageTimestamp();
    updateSettingsPlanCard(usage.subscriptionTier);
    renderUserBadge();
    updateModelPickerLocks();
  } catch (_) {}
}

// Legacy stub so old callers (rewind, etc.) don't break
function updateCtxBar() {}

// ── Admin reset (Ctrl+Shift+0 or button in usage modal — owner only) ─────────
function isOwner() {
  return currentUser?.email === 'support.charactermind@gmail.com';
}

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

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === '0') { e.preventDefault(); adminResetLimits(); }
});

async function adminNotifyUsers() {
  if (!isOwner()) return;
  const subject = document.getElementById('notifySubject')?.value?.trim();
  const message = document.getElementById('notifyMsg')?.value?.trim();
  if (!subject || !message) { showWarning('Subject and message required'); return; }
  const btn = document.getElementById('notifyBtn');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/notify-policy-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message })
    }).then(r => r.json());
    if (d.ok) {
      showWarning(`Sent to ${d.sent} user(s) ✓`, 5000);
      document.getElementById('notifySubject').value = '';
      document.getElementById('notifyMsg').value = '';
    } else {
      showWarning(d.error || 'Send failed.');
    }
  } catch (_) { showWarning('Send failed.'); }
  if (btn) { btn.textContent = 'Send to all users'; btn.disabled = false; }
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
  if (remaining <= 0) return 'Resetting now…';
  const DAY = 24 * 60 * 60 * 1000;
  if (remaining < DAY) {
    // Floor to whole minutes (no seconds): 2h 0m 3s shows "2 hrs", then "1 hr 59 min" as it counts down
    const totalMins = Math.floor(remaining / 60000);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const hStr = h === 1 ? 'hr' : 'hrs';
    const mStr = 'min';
    if (h > 0 && m > 0) return `Resets in ${h} ${hStr} ${m} ${mStr}`;
    if (h > 0) return `Resets in ${h} ${hStr}`;
    if (m > 0) return `Resets in ${m} ${mStr}`;
    return 'Resetting now…';
  }
  const d = new Date(timestamp);
  const day = d.toLocaleDateString(undefined, { weekday: 'long' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `Resets ${day}, ${time}`;
}

function generateUsageHeadline(u) {
  const { sessionTokens, sessionLimit, weeklyTokens, weeklyLimit, cooldownUntil, weeklyResetsAt, weeklyStart } = u;
  if (!weeklyStart) return 'Ready to go — your limits are fresh and waiting.';
  const sPct = (sessionTokens / sessionLimit) * 100;
  const wPct = (weeklyTokens / weeklyLimit) * 100;
  if (cooldownUntil && Date.now() < cooldownUntil) {
    const t = formatResetTime(cooldownUntil);
    return `Session paused. ${t}.`;
  }
  if (weeklyTokens >= weeklyLimit) return 'Weekly limit reached. Take a break — you\'ll be back soon.';
  if (wPct >= 90) return 'Almost at your weekly limit. Wrapping up soon.';
  if (wPct >= 75) return 'You\'ve used most of your weekly limit — pace yourself.';
  if (wPct >= 50) return 'Halfway through your weekly limit. You\'re doing great.';
  if (sPct >= 90) return 'Session almost full. Your next cooldown is close.';
  if (sPct >= 75) return 'Session getting full. Consider a fresh chat soon.';
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
  if (u.sessionExpiresAt && now >= u.sessionExpiresAt) {
    u.sessionTokens = 0; u.sessionStartedAt = null; u.sessionExpiresAt = null; u.cooldownUntil = null;
  }
  if (u.weeklyResetsAt && now >= u.weeklyResetsAt) {
    u.weeklyTokens = 0; u.weeklyStart = null; u.weeklyResetsAt = null;
  }
  return u;
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

  const sPct = Math.min(100, Math.round((u.sessionTokens / u.sessionLimit) * 100));
  const wPct = Math.min(100, Math.round((u.weeklyTokens / u.weeklyLimit) * 100));

  const sBar = document.getElementById('usageSessionBar');
  if (sBar) { sBar.style.width = sPct + '%'; sBar.className = 'usage-fill-modal ' + usageFillClass(sPct); }

  const sPctEl = document.getElementById('usageSessionPct');
  if (sPctEl) sPctEl.textContent = sPct + '%';

  const sSubEl = document.getElementById('usageSessionSub');
  if (sSubEl) {
    if (u.cooldownUntil && Date.now() < u.cooldownUntil) {
      sSubEl.textContent = formatResetTime(u.cooldownUntil);
    } else if (u.sessionTokens > 0 && u.sessionExpiresAt) {
      sSubEl.textContent = formatResetTime(u.sessionExpiresAt);
    } else {
      sSubEl.textContent = 'Starts fresh when you send your first message';
    }
  }

  const wBar = document.getElementById('usageWeeklyBar');
  if (wBar) { wBar.style.width = wPct + '%'; wBar.className = 'usage-fill-modal ' + usageFillClass(wPct); }

  const wPctEl = document.getElementById('usageWeeklyPct');
  if (wPctEl) wPctEl.textContent = wPct + '%';

  const wSubEl = document.getElementById('usageWeeklySub');
  if (wSubEl) wSubEl.textContent = u.weeklyResetsAt ? formatResetTime(u.weeklyResetsAt) : 'Resets weekly';
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

async function openUsageModal() {
  document.getElementById('usageModal').style.display = 'flex';
  const wrap = document.getElementById('resetLimitsWrap');
  if (wrap) wrap.hidden = !isOwner();
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
       <button class='msg-di' onclick='editMsgText(this)'>${MI.edit}Edit response</button>
       <button class='msg-di danger' onclick='removeMsgEl(this)'>${MI.remove}Remove message</button>
       <button class='msg-di' onclick='rewindToHere(this)'>${MI.rewind}Rewind to here</button>`;
  return `<div class='msg-menu-wrap'><button class='msg-menu-btn' onclick='toggleMsgMenu(this)'>⋯</button><div class='msg-dropdown hidden'>${items}</div></div>`;
}

function toggleMsgMenu(btn) {
  document.querySelectorAll('.msg-dropdown:not(.hidden)').forEach(d => d.classList.add('hidden'));
  const dd = btn.nextElementSibling;
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) {
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!dd.contains(e.target) && e.target !== btn) {
          dd.classList.add('hidden');
          document.removeEventListener('click', close, true);
        }
      }, true);
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
    ctrl.innerHTML = `<button onclick="saveEdit(this)">Save & Resend</button><button onclick="cancelEdit(this)">Cancel</button>`;
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
  // Remove everything after this user message
  const msgs = [...document.getElementById('messages').querySelectorAll('.msg')];
  const idx = msgs.indexOf(msgEl);
  msgs.slice(idx + 1).forEach(m => m.remove());
  bubble.textContent = newText;
  // Sync history without the last user turn, then resend
  saveHistoryLocal();
  if (!currentChar) return;
  const localHistory = loadHistoryLocal(currentChar.id);
  // Remove the last entry (the user message we're re-sending) from the sync
  const histWithout = localHistory.slice(0, -1);
  // Clear first, then sync, in order (running them together could leave the server chat empty)
  pushHistoryToServer(currentChar.id, histWithout).then(() => sendMessage(newText, true)).catch(() => sendMessage(newText, true));
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

function rewindToHere(btn) {
  btn.closest('.msg-dropdown').classList.add('hidden');
  if (isStreaming) { showWarning('Wait for the reply to finish first.'); return; }
  const msgEl = btn.closest('.msg');
  const msgs = [...document.getElementById('messages').querySelectorAll('.msg')];
  const idx = msgs.indexOf(msgEl);
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
        if (b.dataset.lite) { delete b.dataset.lite; if (typeof b.dataset.raw === 'string') { b.innerHTML = renderMarkdown(b.dataset.raw); colorizeLetters(b, currentChar?.color); } }
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

  if (role === 'ai') {
    div.innerHTML = `
      <div class="msg-header">
        ${msgAvatarHtml('msg-avatar')}
        <span class="msg-name">${colorizeNameHtml(currentChar?.name || 'AI', currentChar?.color)}</span>
        <span class="msg-badge">C.M</span>
        <button class="tts-btn" onclick="toggleTTS(this)" title="Read aloud (coming soon)"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></button>
        ${msgMenuHtml('ai')}
      </div>
      <div class="bubble">${renderMarkdown(text, undefined, lite ? { lite: true } : undefined)}</div>
      <div class="msg-footer">
        ${regenBtn()}${likeBtn()}${dislikeBtn()}
      </div>`;
    const ab = div.querySelector('.bubble');
    ab.dataset.raw = String(text == null ? '' : text);
    colorizeLetters(ab, currentChar?.color);
    if (lite && liteObserver) { ab.dataset.lite = '1'; liteObserver.observe(ab); }
  } else {
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name" style="color:var(--text3)">You</span>
        ${msgMenuHtml('user')}
      </div>
      ${imgB64 ? `<img class="msg-img" src="${imgB64}" alt="attachment">` : ''}
      ${text ? `<div class="bubble">${escHtml(text)}</div>` : ''}`;
  }
  document.getElementById('messages').appendChild(div);
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
      <button class="tts-btn" onclick="toggleTTS(this)" title="Read aloud (coming soon)"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></button>
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
  twOnDrain = () => { flushTypewriter(); if (cb) cb(); };
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
  if (bubble) { setBubbleRaw(bubble, store.texts[store.idx]); colorizeLetters(bubble, currentChar?.color); }
  if (store.sigs && store.sigs[store.idx]) msgEl.dataset.sig = store.sigs[store.idx]; else delete msgEl.dataset.sig;   // the signature of the version shown
  msgEl.querySelectorAll('.like-btn.active, .dislike-btn.active').forEach(b => b.classList.remove('active'));
  regenNavUpdate(msgEl);
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

function getCharVoiceKey() { return currentChar ? `cm_voice_${currentChar.id}` : null; }

function loadCharVoice() {
  selectedVoice = null;
  const key = getCharVoiceKey();
  if (!key) return;
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return;
    const voices = window.speechSynthesis.getVoices();
    selectedVoice = voices.find(v => v.voiceURI === saved) || null;
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

function renderVoiceList() {
  const list = document.getElementById('voiceList');
  if (!list) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) {
    // Voices may not be loaded yet — try again shortly
    setTimeout(renderVoiceList, 400);
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
  if (voiceURI) {
    selectedVoice = window.speechSynthesis.getVoices().find(v => v.voiceURI === voiceURI) || null;
  } else { selectedVoice = null; }
}

function previewVoiceURI(voiceURI, e) {
  e?.stopPropagation();
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

async function toggleTTS(btn) {
  // Read-aloud is not live yet: the speaker is shown with a "Soon" tag and explains itself when clicked
  if (!document.body.classList.contains('voice-on')) { showWarning('Read aloud is coming soon! 🔊', 4500); return; }
  const bubble = btn.closest('.msg').querySelector('.bubble');
  const text = (bubble.innerText || bubble.textContent).trim();
  if (!text) return;

  if (activeTTSUtterance) {
    window.speechSynthesis.cancel();
    if (activeTTSBtn) activeTTSBtn.classList.remove('playing');
    const wasSame = activeTTSBtn === btn;
    activeTTSUtterance = null;
    activeTTSBtn = null;
    if (wasSame) return;
  }

  // Check memo limit before playing
  try {
    const r = await fetch('/api/memo/use', { method: 'POST' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      showMemoLimitBanner(data.resetsAt);
      return;
    }
  } catch (_) { /* offline — allow */ }

  const utterance = new SpeechSynthesisUtterance(text);
  applyVoice(utterance);
  utterance.onend = () => {
    btn.classList.remove('playing');
    activeTTSUtterance = null;
    activeTTSBtn = null;
    if (callModeActive) listenForSpeech();
  };
  utterance.onerror = () => {
    btn.classList.remove('playing');
    activeTTSUtterance = null;
    activeTTSBtn = null;
  };
  btn.classList.add('playing');
  activeTTSUtterance = utterance;
  activeTTSBtn = btn;
  window.speechSynthesis.speak(utterance);
}

function showMemoLimitBanner(resetsAt) {
  const banner = document.getElementById('memoLimitBanner');
  if (!banner) return;
  const timeEl = banner.querySelector('.memo-limit-time');
  if (timeEl && resetsAt) {
    timeEl.textContent = formatResetTime(resetsAt);
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
  window.speechSynthesis.cancel();
  stopCallAudio();
  // No browser-voice fallback: if the HD voice is unavailable the reply stays as text and the call keeps listening.
  if (elevenTTSOk) { callModeElevenTTS(text); return; }
  listenForSpeech();
}

let elevenTTSOk = true;
let callAudio = null;

function stopCallAudio() {
  if (callAudio) { try { callAudio.pause(); } catch (_) {} callAudio = null; }
}

async function playCallBlob(blob) {
  if (!callModeActive) return;
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

async function callModeElevenTTS(text) {
  const gen = callGen;
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, charId: currentChar?.id })
    });
    if (!r.ok) {
      if (r.status === 501) elevenTTSOk = false;
      throw new Error('tts ' + r.status);
    }
    const blob = await r.blob();
    if (gen !== callGen) return; // call ended or interrupted while the voice was loading
    await playCallBlob(blob);
  } catch (_) {
    if (callModeActive) listenForSpeech();
  }
}

// ── Call mode ─────────────────────────────────────────────────────────────────
let callGen = 0; // bumped when a call ends or is interrupted so late async results are dropped
let callMuted = false;
let callFirstConnect = false;
let callInactivityTimer = null;
let callStarting = false; // mutex: prevents double-start race condition
const CALL_INACTIVITY_MS = 15 * 60 * 1000;

function resetCallInactivityTimer() {
  clearTimeout(callInactivityTimer);
  if (!callModeActive) return;
  callInactivityTimer = setTimeout(() => {
    if (!callModeActive) return;
    endCallMode();
    showCallInactivityBanner();
  }, CALL_INACTIVITY_MS);
}

function clearCallInactivityTimer() {
  clearTimeout(callInactivityTimer);
  callInactivityTimer = null;
}

function showCallInactivityBanner() {
  const banner = document.getElementById('callInactivityBanner');
  if (!banner) return;
  banner.style.display = '';
  setTimeout(() => { banner.style.display = 'none'; }, 5000);
}

let callRecognition = null;

function toggleCallMode() {
  // Voice is not live yet: the button is shown with a "Soon" tag and explains itself when clicked
  if (!document.body.classList.contains('voice-on')) { showWarning('Voice calls are coming soon! 🎙️', 4500); return; }
  if (callModeActive) { endCallMode(); } else { startCallMode(); }
}

async function startCallMode() {
  if (callStarting || callModeActive) return;  // block concurrent/double starts
  callStarting = true;
  const startGen = callGen;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { callStarting = false; alert('Voice calls need a browser with speech recognition — try Chrome.'); return; }
  if (!currentChar) { callStarting = false; return; }
  // Check daily call limit
  try {
    const r = await fetch('/api/call/start', { method: 'POST' });
    const data = await r.json();
    if (!data.allowed) {
      callStarting = false;
      showCallLimitModal(data.resetsAt);
      return;
    }
    if (data.callsRemaining <= 1) showCallWarningBanner();
  } catch(e) { /* offline — allow call anyway */ }

  if (startGen !== callGen) { callStarting = false; return; } // call was cancelled while starting
  callStarting = false;
  callModeActive = true;
  callMuted = false;
  callFirstConnect = true;
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
    if (vob) { vob.style.display = ''; setTimeout(() => { if (callModeActive) vob.style.display = 'none'; }, 5000); }
    setCallState('calling');
    setTimeout(() => { if (callModeActive) listenForSpeech(); }, 500);
  }
}

// Per-character color palettes for the call screen swirl animation
const CHAR_CALL_PALETTES = {
  'custom_1790776698867':          ['#2255cc', '#cc1122', '#f0eaff'],  // Poppy — blue dress, red hair
  'custom_1790774765927':          ['#e8c87a', '#c4763a', '#f5e0b0'],  // Doey — warm dough
  'custom_1790766558393':          ['#446688', '#223344', '#99ccee'],  // The Doctor — cool slate
  'custom_1790894243871_huggy':    ['#1155dd', '#001133', '#00aacc'],  // Huggy Wuggy — deep blue
  'custom_1790894243872_mll':      ['#ff1493', '#cc0099', '#ffaad4'],  // Mommy Long Legs — hot pink
  'custom_1790894243873_catnap':   ['#bb22aa', '#4d0040', '#ee77dd'],  // CatNap — warm magenta-purple
  'custom_1790894243874_dogday':   ['#ffcc00', '#ff8800', '#fffff0'],  // DogDay — yellow/orange
  'custom_1790894243875_prototype':['#888899', '#1a1a22', '#0044cc'],  // The Prototype — steel/electric
  'custom_1790894243876_kissy':    ['#ffaac8', '#ff77aa', '#aaccff'],  // Kissy Missy — baby pink
  'custom_1790895433252_bunzo':    ['#ff2200', '#ffdd00', '#fff5cc'],  // Bunzo — red/yellow
  'custom_1790895433253_pj':       ['#44aa44', '#005500', '#aaffaa'],  // PJ Pug-a-Pillar — green
  'custom_1790895433254_boxy':     ['#cc44cc', '#660066', '#ffaaff'],  // Boxy Boo — purple-pink
  'custom_1790895433255_delight':  ['#ff6688', '#cc2244', '#ffccdd'],  // Miss Delight — deep rose
  'custom_1790895433256_bubba':    ['#4488dd', '#0033aa', '#99ccff'],  // Bubba Bubbaphant — blue
  'custom_1790895671421_yarnaby':  ['#cc3333', '#882222', '#ffaaaa'],  // Yarnaby — red
  'custom_1790895671422_craftycorn':['#cc88ff','#8833cc', '#ffeeff'],  // CraftyCorn — unicorn purple
  'custom_1790895671423_pickypiggy':['#ff99bb','#ee5588', '#ffddee'],  // PickyPiggy — pink
  'custom_1790895671424_kickin':   ['#ffee44', '#dd9900', '#fffbcc'],  // KickinChicken — yellow
  'custom_1790895671425_bobby':    ['#dd3333', '#880000', '#ffbbbb'],  // BobbyBearhug — red
  'custom_1790895671426_hoppy':    ['#44cc44', '#227722', '#ccffcc'],  // HoppyHopscotch — green
  'custom_1790895746935_elliot':   ['#334477', '#1a2244', '#7799cc'],  // Elliot Ludwig — navy
  'custom_1790895746936_stella':   ['#cc9955', '#886633', '#ffe5aa'],  // Stella — warm brown
  'custom_1790895746937_leith':    ['#557788', '#334455', '#99bbcc'],  // Leith Pierre — teal slate
  'custom_1790897425575_lily':     ['#7722cc', '#1a0033', '#f0c030'],  // Lily Lovebraids — violet, black overalls, gold star
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
  const c1 = hex;
  const c2 = hslToHex((h+130)%360, Math.min(s*100+10,100), Math.max(l*100-10,15));
  const c3 = hslToHex((h+250)%360, Math.min(s*100+5,100), Math.max(l*100+5,20));
  return [c1, c2, c3];
}

let _callLimitTimer = null;
function showCallLimitModal(resetsAt) {
  const modal = document.getElementById('callLimitModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const cdEl = document.getElementById('callLimitCountdown');
  if (!cdEl || !resetsAt) return;
  function tick() {
    const diff = resetsAt - Date.now();
    if (diff <= 0) { cdEl.textContent = 'now'; return; }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    cdEl.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
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
  clearCallInactivityTimer();
  stopCallAudio();
  if (callRecognition) { try { callRecognition.abort(); } catch(_){} callRecognition = null; }
  if (activeTTSUtterance) { window.speechSynthesis.cancel(); if (activeTTSBtn) activeTTSBtn.classList.remove('playing'); activeTTSUtterance = null; activeTTSBtn = null; }
  document.getElementById('callBtn')?.classList.remove('active');
  const overlay = document.getElementById('callOverlay');
  if (overlay) overlay.style.display = 'none';
  const imgEl = document.getElementById('callCharImg');
  if (imgEl) imgEl.style.backgroundImage = '';
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
  window.speechSynthesis.cancel();
  if (callAudio) { const a = callAudio; stopCallAudio(); a.onended && a.onended(); return; }
  activeTTSUtterance = null;
  if (callModeActive) listenForSpeech();
}

function listenForSpeech() {
  if (!callModeActive || callMuted) return;
  setCallState('listening');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (callRecognition) { try { callRecognition.abort(); } catch(_){} callRecognition = null; }
  callRecognition = new SR();
  callRecognition.continuous = false;
  callRecognition.interimResults = false;
  callRecognition.lang = 'en-US';
  let handled = false;
  callRecognition.onresult = (e) => {
    handled = true;
    const transcript = e.results[0][0].transcript.trim();
    if (transcript) { resetCallInactivityTimer(); sendCallMessage(transcript); }
  };
  callRecognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      handled = true;
      showCallMicError();
      setCallState('listening');
    }
  };
  callRecognition.onend = () => {
    if (handled || !callModeActive || callMuted) return;
    const state = document.getElementById('callOverlay')?.dataset.state;
    if (state === 'listening') setTimeout(() => listenForSpeech(), 250);
  };
  try { callRecognition.start(); } catch(_) {
    setTimeout(() => listenForSpeech(), 1000);
  }
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
          showWarning(`Free plan limit: ${err.regenLimit} regenerations used today. Upgrade for unlimited.`);
        } else if (err.type === 'session') { startCooldown(err.cooldownUntil, 'session', true); }
        else if (err.type === 'weekly') { startCooldown(err.resetsAt, 'weekly', true); }
        // Restore current version
        const store = regenStore.get(id);
        if (bubble && store) { bubble.classList.remove('streaming'); setBubbleRaw(bubble, store.texts[store.idx]); }
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
      if (store?.texts?.length) setBubbleRaw(bubble, store.texts[store.idx]); else { delete bubble.dataset.raw; bubble.innerHTML = `<p>⚠️ ${escHtml(err.name === 'AbortError' ? 'The connection went quiet, so the reply stopped. Please try again.' : err.message)}</p>`; }
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
      out += '<pre class="code-block"><div class="code-head"><span class="code-lang">' + escHtml(lang || 'code') + '</span><button type="button" class="code-copy" onclick="copyCodeBlock(this)">Copy</button></div><code>' + escHtml(String(m[2]).replace(/\n$/, '')) + '</code></pre>';
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
      return escHtml(part);
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
  document.getElementById('typingIndicator').classList.toggle('hidden', !v);
  if (v) scrollToBottom();
}

function scrollToBottom() {
  const body = document.getElementById('chatBody');
  body.scrollTop = body.scrollHeight;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

async function newChat() {
  if (!currentChar) return;
  abandonStream();
  releaseChatInput();
  // Archive the chat on the server first. If saving fails (the server then keeps the live chat), do NOT clear it.
  // Retry once after 15 s — covers Render free-tier cold-start which can take up to 30 s.
  let arch = await fetch(`/api/conversations/${currentChar.id}/archive`, { method: 'POST' }).catch(() => null);
  if (!arch || !arch.ok) {
    const firstStatus = arch ? arch.status : 0;
    showWarning("Saving your chat — please wait a moment…", 16000);
    await new Promise(r => setTimeout(r, 15000));
    arch = await fetch(`/api/conversations/${currentChar.id}/archive`, { method: 'POST' }).catch(() => null);
    if (!arch || !arch.ok) {
      const status = arch ? arch.status : firstStatus;
      showWarning(`Couldn't save your current chat (error ${status || 'network'}), so it was left as it is. Please try again in a moment.`);
      return;
    }
  }
  savePastChatLocal(currentChar.id, loadHistoryLocal(currentChar.id));
  // If this chat was permanently banned, unlock it so the new conversation can proceed
  if (currentChatLocked) {
    await fetch(`/api/chat/unlock/${currentChar.id}`, { method: 'POST' }).catch(() => {});
    currentChatLocked = false;
  }
  // Await the DELETE so the server clears history before we try to greet
  await fetch(`/api/conversations/${currentChar.id}`, { method: 'DELETE' }).catch(() => {});
  // Clear stale local history so reload starts fresh
  try {
    const all = JSON.parse(localStorage.getItem(userKey('cm_history')) || '{}');
    delete all[currentChar.id];
    localStorage.setItem(userKey('cm_history'), JSON.stringify(all));
  } catch(_) {}
  document.getElementById('messages').innerHTML = '';
  document.getElementById('chatWelcome').innerHTML = '';
  warnedThresholds.clear();
  if (currentChar.greeting && currentChar.greetingMode !== 'auto') {
    appendMessage('ai', currentChar.greeting);
    saveHistoryLocal();
    fetch(`/api/conversations/${currentChar.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'assistant', content: currentChar.greeting }] })
    }).catch(() => {});
  } else {
    generateGreeting();
  }
}

function toggleInfoPanel() {
  const panel = document.getElementById('infoPanel');
  const expandBtn = document.getElementById('infoPanelExpandBtn');
  if (window.innerWidth <= 768) {
    // Mobile: full show/hide with backdrop
    const opening = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = opening ? 'flex' : 'none';
    let bd = document.getElementById('info-backdrop');
    if (opening) {
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'info-backdrop';
        bd.style.cssText = 'position:fixed;inset:0;z-index:599;background:rgba(0,0,0,.55)';
        bd.onclick = toggleInfoPanel;
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

  const creatorName = String(currentUser?.name || localStorage.getItem('cm_creator_name') || '@you').slice(0, 40);
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
    setGreetingMode('fixed');
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

  spawnParticles(event.emojis, event.count);
  if (event.accent) setAccentOverride(event.accent);
  setTimeout(() => transformLogoForEvent(event.name), 500);
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
        '<span class="season-c">🌙</span>hara<span class="season-c">🌙</span>ter' +
        '<span class="season-dot season-dot--halloween">💀</span>' +
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
    <button onclick="this.closest('.event-banner').remove()" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 10000);
}

// Voice features (call button, read-aloud) stay hidden until a TTS provider is configured server-side.
fetch('/api/tts/status').then(r => (r.ok ? r.json() : null)).then(d => {
  if (d && d.enabled) document.body.classList.add('voice-on');
}).catch(() => {});
