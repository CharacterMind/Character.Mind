/**
 * Creates Halloween sale PayPal billing plans (40% off) for all tiers.
 * Run once with your live credentials:
 *
 *   $env:PAYPAL_CLIENT_ID="<your live client id>"
 *   $env:PAYPAL_SECRET="<your live secret>"
 *   node create_halloween_plans.js
 *
 * Then copy the printed env vars into Render.
 */

const BASE = 'https://api-m.paypal.com';   // live endpoint
const DISCOUNT = 0.40;

const PLANS = [
  { key: 'advanced', name: 'Advanced', monthly: 9.99,   annual: 59.99   },
  { key: 'x20',      name: 'X20',      monthly: 39.99,  annual: 239.99  },
  { key: 'x50',      name: 'X50',      monthly: 79.99,  annual: 479.99  },
  { key: 'x100',     name: 'X100',     monthly: 159.99, annual: 959.99  },
  { key: 'x200',     name: 'X200',     monthly: 399.99, annual: 2399.99 },
];

function discounted(price) {
  return (Math.round(price * (1 - DISCOUNT) * 100) / 100).toFixed(2);
}

async function getToken() {
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString('base64');
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function getProductId(token, existingPlanId) {
  if (!existingPlanId) throw new Error('Pass an existing plan ID as first arg, e.g.: node create_halloween_plans.js P-XXXXXX');
  const r = await fetch(`${BASE}/v1/billing/plans/${existingPlanId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  if (!d.product_id) throw new Error('Could not fetch product_id from plan ' + existingPlanId + ': ' + JSON.stringify(d));
  console.log(`Product ID: ${d.product_id}`);
  return d.product_id;
}

async function createPlan(token, productId, key, name, price, interval, label) {
  const body = {
    product_id: productId,
    name: `Character Mind ${name} — Halloween Sale (${label})`,
    description: `40% Halloween discount — ${name} plan, ${label}`,
    status: 'ACTIVE',
    billing_cycles: [
      {
        frequency: { interval_unit: interval === 'MONTH' ? 'MONTH' : 'YEAR', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: price, currency_code: 'USD' } },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: '0', currency_code: 'USD' },
      setup_fee_failure_action: 'CONTINUE',
      payment_failure_threshold: 3,
    },
  };

  const r = await fetch(`${BASE}/v1/billing/plans`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!d.id) throw new Error(`Failed to create plan for ${key} ${label}: ` + JSON.stringify(d));
  return d.id;
}

async function main() {
  const existingPlanId = process.argv[2];
  if (!existingPlanId) {
    console.error('Usage: node create_halloween_plans.js <any-existing-live-plan-id>');
    console.error('Example: node create_halloween_plans.js P-5ML4271244454362WXNWU5NQ');
    process.exit(1);
  }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) {
    console.error('Set PAYPAL_CLIENT_ID and PAYPAL_SECRET env vars first.');
    process.exit(1);
  }

  console.log('Getting PayPal token...');
  const token = await getToken();
  const productId = await getProductId(token, existingPlanId);

  console.log('\nCreating Halloween plans (40% off)...\n');
  const envVars = [];

  for (const plan of PLANS) {
    const monthlyPrice = discounted(plan.monthly);
    const annualPrice  = discounted(plan.annual);

    process.stdout.write(`  ${plan.name} monthly $${monthlyPrice}... `);
    const mId = await createPlan(token, productId, plan.key, plan.name, monthlyPrice, 'MONTH', 'monthly');
    console.log(mId);
    envVars.push(`PAYPAL_PLAN_${plan.key.toUpperCase()}_HALLOWEEN=${mId}`);

    process.stdout.write(`  ${plan.name} annual  $${annualPrice}... `);
    const yId = await createPlan(token, productId, plan.key, plan.name, annualPrice, 'YEAR', 'annual');
    console.log(yId);
    envVars.push(`PAYPAL_PLAN_${plan.key.toUpperCase()}_HALLOWEEN_YEARLY=${yId}`);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Add these to Render → Character Mind → Environment:');
  console.log('═══════════════════════════════════════════════════════');
  envVars.forEach(v => console.log(v));
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nDeploy the updated server.js and the sale prices go live.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
