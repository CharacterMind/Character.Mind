require('dotenv').config();
process.on('uncaughtException', err => console.error('UNCAUGHT:', err.stack));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const https = require('https');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const crypto = require('crypto');
const { matchCharacterTemplate, TEMPLATES } = require('./characterTemplates');

const app = express();
const PORT = process.env.PORT || 8080;

// Railway (and most PaaS) sit behind a load-balancer proxy.
// Without this, req.protocol is always 'http', secure cookies are never set,
// and the OAuth callback loses the session.
app.set('trust proxy', 1);

// ── Database ───────────────────────────────────────────────────────────────────
// Verify the database's certificate (sslmode=verify-full) instead of just encrypting; keeps pg quiet about
// the old "require" meaning too. Set DATABASE_SSL_INSECURE=1 only if a host's certificate can't be verified.
function dbConnectionString(raw) {
  try {
    const u = new URL(raw);
    if (u.searchParams.has('sslmode') || u.searchParams.has('ssl')) { u.searchParams.delete('ssl'); u.searchParams.set('sslmode', 'verify-full'); }
    return u.toString();
  } catch (_) { return raw; }
}
const db = process.env.DATABASE_URL
  ? new Pool({
      connectionString: dbConnectionString(process.env.DATABASE_URL),
      ssl: { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== '1' }
    })
  : null;

if (!process.env.DATABASE_URL) {
  console.warn('[WARN] DATABASE_URL is not set — character save/load will not work');
}

if (db) {
  db.query(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tagline TEXT DEFAULT '',
      description TEXT DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      greeting TEXT,
      greeting_mode TEXT DEFAULT 'fixed',
      color TEXT DEFAULT '#7c3aed',
      creator_name TEXT DEFAULT 'Anonymous',
      device_id TEXT,
      image TEXT,
      tags JSONB DEFAULT '[]',
      interactions INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => {
    console.log('DB ready');
    return db.query(`UPDATE characters SET greeting_mode = 'fixed' WHERE greeting IS NOT NULL AND greeting != '' AND greeting_mode = 'auto'`);
  }).then(r => { if (r && r.rowCount > 0) console.log(`[MIGRATION] Fixed greeting_mode auto→fixed for ${r.rowCount} characters`); })
    .then(() => db.query(`UPDATE characters SET greeting_mode = 'fixed' WHERE greeting_mode NOT IN ('fixed', 'auto')`))
    .then(r => { if (r && r.rowCount > 0) console.log(`[MIGRATION] Normalized ${r.rowCount} non-standard greeting_mode values to fixed`); })
    .catch(err => console.error('DB init error:', err));

  db.query(`
    CREATE TABLE IF NOT EXISTS users (
      google_id TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT '',
      name TEXT DEFAULT '',
      picture TEXT DEFAULT '',
      email_opt_in BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(err => console.error('Users table init error:', err));

  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_recents TEXT[] NOT NULL DEFAULT '{}'`)
    .catch(err => console.error('Add hidden_recents column error:', err));

  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS recent_chats JSONB NOT NULL DEFAULT '{}'`)
    .catch(err => console.error('Add recent_chats column error:', err));

  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'free'`)
    .catch(err => console.error('Add subscription_tier column error:', err));

  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paypal_subscription_id TEXT`)
    .catch(err => console.error('Add paypal_subscription_id column error:', err));

  db.query(`
    CREATE TABLE IF NOT EXISTS user_limits (
      user_id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at BIGINT DEFAULT 0
    )
  `).then(() => loadLimitsFromDB())
    .catch(err => console.error('user_limits table init error:', err))
    .finally(() => startListening());

  db.query(`
    CREATE TABLE IF NOT EXISTS chat_moderation (
      user_id TEXT NOT NULL,
      char_id TEXT NOT NULL,
      strikes INT NOT NULL DEFAULT 0,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, char_id)
    )
  `).catch(err => console.error('chat_moderation table init error:', err));

  db.query(`
    CREATE TABLE IF NOT EXISTS chat_archives (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      char_id TEXT NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]',
      archived_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(err => console.error('chat_archives table init error:', err));

  db.query(`CREATE INDEX IF NOT EXISTS idx_chat_archives_user_char ON chat_archives(user_id, char_id)`)
    .catch(() => {});

  // The current (live) conversation per user+character, so a server restart never wipes a chat
  db.query(`
    CREATE TABLE IF NOT EXISTS chat_current (
      user_id TEXT NOT NULL,
      char_id TEXT NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, char_id)
    )
  `).catch(err => console.error('chat_current table init error:', err));
} else {
  console.warn('No DATABASE_URL — characters will not be persisted');
}

// 600KB max — enough for image data URIs but rejects abuse. The raw body is kept for the PayPal webhook.
app.use(express.json({
  limit: '600kb',
  verify: (req, res, buf) => { if (req.originalUrl && req.originalUrl.startsWith('/api/webhooks/paypal')) req.rawBody = buf; }
}));
// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.paypal.com https://www.paypalobjects.com; style-src 'self' 'unsafe-inline' https://www.paypalobjects.com https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; media-src 'self' blob: data:; connect-src 'self' https://accounts.google.com https://www.paypal.com https://www.sandbox.paypal.com https://api-m.sandbox.paypal.com https://api-m.paypal.com https://www.paypalobjects.com; frame-src https://www.paypal.com https://www.sandbox.paypal.com; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production' && req.protocol !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

// Rate-limit OAuth entry point to prevent abuse
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const perUserKey = (req) => req.user?.googleId || ipKeyGenerator(req.ip);
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/auth/google', authLimiter);
const resetModLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: perUserKey });
// Cheap protection for the endpoints that cost AI or outside-API calls
const personaLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: perUserKey, message: { error: 'Too many requests. Please try again later.' } });
const geoLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: perUserKey, message: { error: 'Too many requests. Please try again in a minute.' } });
const chatBurstLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: perUserKey, message: { error: 'You are sending messages too fast. Please slow down a little.' } });
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) console.warn('WARNING: SESSION_SECRET env var not set — using insecure fallback.');

// Persist sessions to Postgres so they survive server restarts
if (db) {
  db.query(`CREATE TABLE IF NOT EXISTS session (
    "sid" varchar NOT NULL COLLATE "default",
    "sess" json NOT NULL,
    "expire" timestamp(6) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
  ) WITH (OIDS=FALSE)`).catch(e => console.warn('Session table init:', e.message));
}

app.use(session({
  store: db ? new pgSession({ pool: db, tableName: 'session', createTableIfMissing: false }) : undefined,
  secret: SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ── Google OAuth ───────────────────────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));
app.use(passport.initialize());
app.use(passport.session());
app.use('/api/chat/reset-mod', resetModLimiter);
// Per-user limits for expensive endpoints (must run after login so req.user is known)
app.use('/api/generate-persona', personaLimiter);
app.use('/api/crisis-resources', geoLimiter);
app.use(['/api/chat', '/api/regenerate', '/api/greet'], chatBurstLimiter);
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => ipKeyGenerator(req.ip) });
const convLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: perUserKey, message: { error: 'Too many requests. Please slow down.' } });
app.use('/api/webhooks/paypal', webhookLimiter);
app.use('/api/conversations', convLimiter);

const GOOGLE_AUTH_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (GOOGLE_AUTH_ENABLED) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  (process.env.SITE_URL || process.env.APP_URL || 'http://localhost:8080') + '/auth/google/callback',
    state:        true
  }, (_at, _rt, profile, done) => {
    const user = {
      googleId: profile.id,
      name:     profile.displayName,
      email:    profile.emails?.[0]?.value || '',
      picture:  profile.photos?.[0]?.value || ''
    };
    if (db) {
      db.query(
        `INSERT INTO users (google_id, email, name, picture)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_id) DO UPDATE
           SET email=EXCLUDED.email, name=EXCLUDED.name, picture=EXCLUDED.picture, last_seen=NOW()
         RETURNING (xmax = 0) AS is_new_user`,
        [user.googleId, user.email, user.name, user.picture]
      ).then(result => {
        const isNew = result.rows[0]?.is_new_user;
        if (isNew && user.email) sendWelcomeEmail(user.name, user.email);
      }).catch(err => console.error('User upsert error:', err.message));
    }
    if (OWNER_EMAILS.has(user.email)) ownerGoogleIds.add(user.googleId);
    // Cache this account's own subscription tier in userLimits so limit checks don't need a DB hit.
    // Every account gets only what its own subscription pays for, except the Character.Mind account (planFor).
    if (db) {
      db.query('SELECT subscription_tier FROM users WHERE google_id = $1', [user.googleId])
        .then(r => {
          const tier = planFor(user.email, r.rows[0]?.subscription_tier);
          const lim = getLimits(user.googleId);
          lim.subscriptionTier = tier;
          lim.tierLoaded = true;
        }).catch(() => {});
    }
    done(null, user);
  }));
} else {
  console.warn('WARNING: GOOGLE_CLIENT_ID/SECRET not set — Google auth disabled.');
}

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_AUTH_ENABLED) return res.redirect('/?auth=unavailable');
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })(req, res, next);
});
app.get('/auth/google/callback',
  (req, res, next) => {
    if (!GOOGLE_AUTH_ENABLED) return res.redirect('/?auth=fail');
    passport.authenticate('google', { failureRedirect: '/?auth=fail' })(req, res, next);
  },
  (req, res) => {
    req.session.showWelcome = true;
    req.session.save(() => res.redirect('/?welcome=1'));
  }
);
app.get('/auth/me', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user) return res.json(null);
  const showWelcome = req.session.showWelcome || false;
  if (showWelcome) req.session.showWelcome = false;
  res.json({ name: req.user.name, email: req.user.email, picture: req.user.picture, googleId: req.user.googleId, showWelcome });
});
app.post('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => res.json({ ok: true }));
  });
});

app.get('/api/user/hidden-recents', requireAuth, async (req, res) => {
  if (!db) return res.json({ hidden: [] });
  try {
    const { rows } = await db.query('SELECT hidden_recents FROM users WHERE google_id = $1', [req.user.googleId]);
    res.json({ hidden: rows[0]?.hidden_recents || [] });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/user/hidden-recents', requireAuth, async (req, res) => {
  if (!db) return res.json({ ok: true });
  const hidden = Array.isArray(req.body.hidden) ? req.body.hidden.slice(0, 500).map(s => String(s).slice(0, 128)) : [];
  try {
    await db.query('UPDATE users SET hidden_recents = $1 WHERE google_id = $2', [hidden, req.user.googleId]);
    res.json({ ok: true });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── Recent chats (cross-device sync) ─────────────────────────────────────────
app.get('/api/user/recent-chats', requireAuth, async (req, res) => {
  if (!db) return res.json({ recents: {} });
  try {
    const { rows } = await db.query('SELECT recent_chats FROM users WHERE google_id = $1', [req.user.googleId]);
    res.json({ recents: rows[0]?.recent_chats || {} });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/user/recent-chats', requireAuth, async (req, res) => {
  if (!db) return res.json({ ok: true });
  const incoming = (typeof req.body.recents === 'object' && req.body.recents) ? req.body.recents : {};
  // Sanitize: only string keys, numeric timestamps, reject huge payloads
  const clean = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof k === 'string' && k.length <= 64 && typeof v === 'number') clean[k] = v;
    if (Object.keys(clean).length >= 200) break;
  }
  try {
    // Merge server + incoming: take MAX timestamp per character
    const { rows } = await db.query('SELECT recent_chats FROM users WHERE google_id = $1', [req.user.googleId]);
    const server = rows[0]?.recent_chats || {};
    const merged = { ...server };
    for (const [k, v] of Object.entries(clean)) {
      if (!merged[k] || v > merged[k]) merged[k] = v;
    }
    await db.query('UPDATE users SET recent_chats = $1 WHERE google_id = $2', [merged, req.user.googleId]);
    res.json({ ok: true, recents: merged });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Make sure this user's plan is loaded in memory (it is lost on restart or when idle state is purged).
async function ensureTierLoaded(user) {
  const u = getLimits(user.googleId);
  if (u.tierLoaded) return;
  if (OWNER_EMAILS.has(user.email)) ownerGoogleIds.add(user.googleId); // admin tools; the plan comes from planFor()
  if (!db) return;
  const r = await db.query('SELECT subscription_tier FROM users WHERE google_id = $1', [user.googleId]);
  u.subscriptionTier = planFor(user.email, r.rows[0]?.subscription_tier);
  u.tierLoaded = true;
}

// At most 2 AI replies per user at once, so parallel requests can't blow past the token limits.
// Returns a release function (or null after answering 429). The slot is released when the reply
// finishes or fails, not when the client disconnects, because the AI keeps working until we stop it.
const chatInFlight = new Map();
function acquireChatSlot(req, res, userId) {
  const n = chatInFlight.get(userId) || 0;
  if (n >= 2) {
    res.status(429).json({ error: 'Please wait for your current reply to finish.' });
    return null;
  }
  chatInFlight.set(userId, n + 1);
  let released = false;
  let timer = null;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    const left = (chatInFlight.get(userId) || 1) - 1;
    if (left <= 0) chatInFlight.delete(userId); else chatInFlight.set(userId, left);
  };
  timer = setTimeout(release, 150000); // safety net so a slot can never be stuck forever
  if (timer.unref) timer.unref();
  res.on('finish', release);
  return release;
}

async function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  try { await ensureTierLoaded(req.user); } catch (e) { console.warn('ensureTierLoaded failed:', e.message); }
  next();
}

// Purge expired in-memory state every 30 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  // Clean stale rate-limit entries
  for (const sid of Object.keys(userLimits)) {
    const u = userLimits[sid];
    const sessionExpired = !u.cooldownUntil && !u.sessionStartedAt;
    const weeklyExpired = !u.weeklyStart || (now - u.weeklyStart) > LIMITS.WEEKLY_MS;
    const dailyActive = (u.callsToday || u.memosToday || u.imagesDay) && u.callDayStart >= getCallWindowStart();
    if (sessionExpired && weeklyExpired && !dailyActive) delete userLimits[sid];
  }
  // Clean conversations idle for more than 4 hours
  const CONV_TTL = 4 * 60 * 60 * 1000;
  for (const key of Object.keys(conversations)) {
    const ts = convLastUsed[key];
    if (ts && now - ts > CONV_TTL) { delete conversations[key]; delete convLastUsed[key]; convLoaded.delete(key); }
  }
}, 30 * 60 * 1000);

// ── Rate limits ───────────────────────────────────────────────────────────────
async function loadLimitsFromDB() {
  if (!db) return;
  try {
    const { rows } = await db.query('SELECT user_id, data FROM user_limits');
    const now = Date.now();
    for (const row of rows) {
      const d = row.data || {};
      // Skip entries whose weekly window and session have both fully expired
      const weeklyGone = !d.weeklyStart || (now - d.weeklyStart) > (7 * 24 * 60 * 60 * 1000);
      const sessionGone = !d.sessionStartedAt || (now > (d.sessionStartedAt + LIMITS.SESSION_COOLDOWN_MS));
      if (weeklyGone && sessionGone) continue;
      userLimits[row.user_id] = {
        sessionTokens: d.sessionTokens || 0,
        sessionStartedAt: d.sessionStartedAt || null,
        cooldownUntil: d.cooldownUntil || null,
        weeklyTokens: d.weeklyTokens || 0,
        weeklyStart: d.weeklyStart || null,
        warned: d.warned || {},
        regenCount: d.regenCount || 0,
        regenDayStart: d.regenDayStart || null,
        callsToday: d.callsToday || 0,
        callDayStart: d.callDayStart || null,
        memosToday: d.memosToday || 0,
        memoDayStart: d.memoDayStart || null,
        imagesDay: d.imagesDay || 0,
        imageDayStart: d.imageDayStart || null,
        subscriptionTier: d.subscriptionTier || 'free'
      };
    }
    if (Object.keys(userLimits).length) console.log(`[limits] Loaded ${Object.keys(userLimits).length} user limit records from DB`);
  } catch (e) {
    console.error('loadLimitsFromDB error:', e.message);
  }
}

function saveLimitsToDB(userId) {
  if (!db) return;
  const u = userLimits[userId];
  if (!u) return;
  db.query(
    `INSERT INTO user_limits (user_id, data, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = $3`,
    [userId, u, Date.now()]
  ).catch(e => console.error('saveLimitsToDB error:', e.message));
}

const LIMITS = {
  SESSION_COOLDOWN_MS: Number(process.env.SESSION_COOLDOWN_MS) || (2 * 60 * 60 * 1000 + 3000),
  WEEKLY_MS: 7 * 24 * 60 * 60 * 1000,
  REGEN_FREE: 5, // free plan: regenerations per day (resets with the other daily counters)
  CALL_DAILY: 3
};

// Plan limits are defined in AVERAGE MESSAGES per session, then converted to tokens (what a reply is charged:
// model tokens x model multiplier x effort multiplier).
// An average message = Opes at Medium effort = 1,200 tokens (see MESSAGE_COST below).
// Lighter models/efforts give more messages than this; heavier ones give fewer.
// Free 30, Advanced 60 (2x), X20 = 20x Advanced (1,200), X50 = 50x Advanced (3,000). Weekly = 5 sessions' worth.
const AVG_MESSAGE_TOKENS = 1200;
const X20_MULT = 20;
const X50_MULT = 50;
const MESSAGES_PER_SESSION = { free: 30, advanced: 60 };
const WEEKLY_SESSIONS = 5;
function limitsForMessages(sessionMessages) {
  const session = sessionMessages * AVG_MESSAGE_TOKENS;
  return { session, weekly: session * WEEKLY_SESSIONS };
}
const TIER_TOKEN_LIMITS = {
  free:     limitsForMessages(MESSAGES_PER_SESSION.free),
  advanced: limitsForMessages(MESSAGES_PER_SESSION.advanced),
  x20:      limitsForMessages(MESSAGES_PER_SESSION.advanced * X20_MULT),
  x50:      limitsForMessages(MESSAGES_PER_SESSION.advanced * X50_MULT),
};
function tokenLimitsFor(u) {
  return TIER_TOKEN_LIMITS[u.subscriptionTier || 'free'] || TIER_TOKEN_LIMITS.free;
}
// How fast each model tier burns your token allowance (top tiers cost far more).
const MODEL_TOKEN_MULT = { opas: 1, opes: 3, opis: 4, opos: 5, opus: 6, opys: 8, opys2: 10 };
// Extra cost for the higher effort levels, on top of the model multiplier (they also write longer replies).
const EFFORT_TOKEN_MULT = { low: 1, medium: 1, high: 1, extra: 1.5, max: 2 };
function effortMultFor(effort) { return Object.hasOwn(EFFORT_TOKEN_MULT, effort) ? EFFORT_TOKEN_MULT[effort] : 1; }

// What ONE reply costs from the allowance, by model and effort. Fixed per message (not the AI's raw token
// count, which swings a lot because of hidden thinking), so message counts are predictable.
// Opes costs about 3x Opas at every effort. Higher models are multiples of Opes.
const OPAS_COST = { low: 220, medium: 350, high: 650, extra: 1300, max: 2600 };
const OPES_COST = { low: 700, medium: 1200, high: 2000, extra: 4000, max: 8000 };
// Low tier: Opas, Opes. Mid tier: Opis (1.5x), Opos (2.5x). High tier: Opus (6x), Opys (15x), Opys 2 (30x, the most advanced) - these drain even an X50 allowance fast.
const COST_FACTOR_VS_OPES = { opes: 1, opis: 1.5, opos: 2.5, opus: 6, opys: 15, opys2: 30 };
function messageCost(modelTier, effort) {
  const e = (typeof effort === 'string' && Object.hasOwn(OPES_COST, effort)) ? effort : 'medium';
  if (modelTier === 'opas' || !Object.hasOwn(COST_FACTOR_VS_OPES, modelTier)) return OPAS_COST[e];
  return Math.round(OPES_COST[e] * COST_FACTOR_VS_OPES[modelTier]);
}
function tokenMultFor(tier) { return Object.hasOwn(MODEL_TOKEN_MULT, tier) ? MODEL_TOKEN_MULT[tier] : MODEL_TOKEN_MULT.opas; }

// Which model tiers each plan may use (matches the plan cards and the model picker):
// Free = Opas, Opes; Advanced adds Opis, Opos; X20 adds Opus; X50 adds Opys and Opys 2.
const PLAN_MODEL_TIERS = {
  free:     ['opas', 'opes'],
  advanced: ['opas', 'opes', 'opis', 'opos'],
  x20:      ['opas', 'opes', 'opis', 'opos', 'opus'],
  x50:      ['opas', 'opes', 'opis', 'opos', 'opus', 'opys', 'opys2'],
};
function resolveModelTier(userId, requested) {
  if (typeof requested !== 'string' || !Object.hasOwn(MODEL_TOKEN_MULT, requested)) return 'opas';
  const plan = getLimits(userId).subscriptionTier || 'free';
  const allowed = PLAN_MODEL_TIERS[plan] || PLAN_MODEL_TIERS.free;
  return allowed.includes(requested) ? requested : 'opes';
}
function sessionLimitFor(u) { return tokenLimitsFor(u).session; }
function weeklyLimitFor(u) { return tokenLimitsFor(u).weekly; }
const NSFW_BLOCK_TOKENS = 200;

const TIER_CALL_LIMITS  = { free: 3,   advanced: 5,   x20: 100,  x50: 250  };
const TIER_MEMO_LIMITS  = { free: 30,  advanced: 50,  x20: 1000, x50: 2500 };
const TIER_IMAGE_LIMITS = { free: 5,   advanced: 10,  x20: 200,  x50: 500  };

function getCallLimitForUser(userId) {
  const tier = userLimits[userId]?.subscriptionTier || 'free';
  return TIER_CALL_LIMITS[tier] ?? TIER_CALL_LIMITS.free;
}
function getMemoLimitForUser(userId) {
  const tier = userLimits[userId]?.subscriptionTier || 'free';
  return TIER_MEMO_LIMITS[tier] ?? TIER_MEMO_LIMITS.free;
}
function getImageLimitForUser(userId) {
  const tier = userLimits[userId]?.subscriptionTier || 'free';
  return TIER_IMAGE_LIMITS[tier] ?? TIER_IMAGE_LIMITS.free;
}

// Returns timestamp of the most recent 8:00 AM UTC (start of current call window)
function getCallWindowStart() {
  const now = new Date();
  const at8 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0, 0));
  if (now.getTime() < at8.getTime()) at8.setUTCDate(at8.getUTCDate() - 1);
  return at8.getTime();
}

const userLimits = {};

function getLimits(sid) {
  const now = Date.now();
  if (!userLimits[sid]) {
    userLimits[sid] = { sessionTokens: 0, sessionStartedAt: null, cooldownUntil: null, weeklyTokens: 0, weeklyStart: null, warned: {}, regenCount: 0, callsToday: 0, callDayStart: null, memosToday: 0, memoDayStart: null, imagesDay: 0, imageDayStart: null, subscriptionTier: 'free' };
  }
  const u = userLimits[sid];
  if (u.subscriptionTier === undefined) u.subscriptionTier = 'free';
  if (u.memosToday === undefined) u.memosToday = 0;
  // Session window expired (time-based, like Anthropic) → reset for next message
  if (u.sessionStartedAt && now > u.sessionStartedAt + LIMITS.SESSION_COOLDOWN_MS) {
    u.sessionTokens = 0; u.cooldownUntil = null; u.sessionStartedAt = null; u.warned.session90 = false;
  }
  // Weekly window expired → reset weekly, it starts fresh on next message
  if (u.weeklyStart && (now - u.weeklyStart) > LIMITS.WEEKLY_MS) {
    u.weeklyTokens = 0; u.weeklyStart = null; u.warned = {};
  }
  // Daily window resets at 8 AM UTC (calls + memos)
  const callWindow = getCallWindowStart();
  if (!u.callDayStart  || u.callDayStart  < callWindow) { u.callsToday  = 0; u.callDayStart  = callWindow; }
  if (!u.memoDayStart  || u.memoDayStart  < callWindow) { u.memosToday  = 0; u.memoDayStart  = callWindow; }
  if (!u.imageDayStart || u.imageDayStart < callWindow) { u.imagesDay   = 0; u.imageDayStart = callWindow; }
  if (!u.regenDayStart || u.regenDayStart < callWindow) { u.regenCount = 0; u.regenDayStart = callWindow; }
  return u;
}

function checkLimits(sid) {
  const u = getLimits(sid);
  const now = Date.now();
  if (u.cooldownUntil && now < u.cooldownUntil) return { blocked: true, type: 'session', cooldownUntil: u.cooldownUntil };
  if (u.weeklyStart && u.weeklyTokens >= weeklyLimitFor(u)) return { blocked: true, type: 'weekly', resetsAt: u.weeklyStart + LIMITS.WEEKLY_MS };
  return { blocked: false };
}

function buildUsagePayload(u, userId) {
  const callLimit = userId ? getCallLimitForUser(userId) : (TIER_CALL_LIMITS[u.subscriptionTier || 'free'] ?? TIER_CALL_LIMITS.free);
  const memoLimit = userId ? getMemoLimitForUser(userId) : (TIER_MEMO_LIMITS[u.subscriptionTier || 'free'] ?? TIER_MEMO_LIMITS.free);
  const callsRemaining = callLimit === Infinity ? 9999 : Math.max(0, callLimit - (u.callsToday || 0));
  const memosRemaining = memoLimit === Infinity ? 9999 : Math.max(0, memoLimit - (u.memosToday || 0));
  return {
    sessionTokens: u.sessionTokens,
    sessionLimit: sessionLimitFor(u),
    sessionStartedAt: u.sessionStartedAt,
    sessionExpiresAt: u.sessionStartedAt ? u.sessionStartedAt + LIMITS.SESSION_COOLDOWN_MS : null,
    cooldownUntil: u.cooldownUntil,
    weeklyTokens: u.weeklyTokens,
    weeklyLimit: weeklyLimitFor(u),
    weeklyStart: u.weeklyStart,
    weeklyResetsAt: u.weeklyStart ? u.weeklyStart + LIMITS.WEEKLY_MS : null,
    regenCount: u.regenCount || 0,
    regenLimit: LIMITS.REGEN_FREE,
    callsToday: u.callsToday || 0,
    callsLimit: callLimit === Infinity ? 9999 : callLimit,
    callsRemaining,
    memosToday: u.memosToday || 0,
    memosLimit: memoLimit === Infinity ? 9999 : memoLimit,
    memosRemaining,
    subscriptionTier: u.subscriptionTier || 'free',
    callWindowResetsAt: getCallWindowStart() + 24 * 60 * 60 * 1000
  };
}

function addTokens(sid, tokens) {
  const u = getLimits(sid);
  const now = Date.now();
  // Clock starts on first actual message
  if (!u.weeklyStart) u.weeklyStart = now;
  if (!u.sessionStartedAt) u.sessionStartedAt = now;

  u.sessionTokens += tokens;
  u.weeklyTokens += tokens;
  const sPct = (u.sessionTokens / sessionLimitFor(u)) * 100;
  const wPct = (u.weeklyTokens / weeklyLimitFor(u)) * 100;
  const warnings = [];
  if (sPct >= 90 && !u.warned.session90) { u.warned.session90 = true; warnings.push({ type: 'session', pct: 90, msg: "You've used 90% of your session limit." }); }
  const wt = [
    { pct: 25, key: 'weekly25', msg: 'Approaching your weekly limit.' },
    { pct: 50, key: 'weekly50', msg: 'Approaching your weekly limit.' },
    { pct: 75, key: 'weekly75', msg: "You've used 75% of your weekly limit." },
    { pct: 90, key: 'weekly90', msg: "You've used 90% of your weekly limit." },
  ];
  for (const t of wt) {
    if (wPct >= t.pct && !u.warned[t.key]) { u.warned[t.key] = true; warnings.push({ type: 'weekly', pct: t.pct, msg: t.msg }); }
  }
  if (u.sessionTokens >= sessionLimitFor(u) && !u.cooldownUntil) {
    // Block until the session window expires (not a fresh cooldown — enforces Anthropic-style 2h window)
    u.cooldownUntil = u.sessionStartedAt + LIMITS.SESSION_COOLDOWN_MS;
  }
  saveLimitsToDB(sid); // persist asynchronously — fire-and-forget
  return { warnings, ...buildUsagePayload(u, sid) };
}

// Give back tokens reserved for a reply that failed or came back empty.
function refundTokens(sid, tokens) {
  const u = userLimits[sid];
  if (!u) return;
  u.sessionTokens = Math.max(0, (u.sessionTokens || 0) - tokens);
  u.weeklyTokens = Math.max(0, (u.weeklyTokens || 0) - tokens);
  if (u.cooldownUntil && u.sessionTokens < sessionLimitFor(u)) u.cooldownUntil = null;
  saveLimitsToDB(sid);
}

// ── Effort directive ──────────────────────────────────────────────────────────
const EFFORT_DIRECTIVES = {
  low:    'RESPONSE LENGTH: Keep your reply extremely brief — 1 to 3 sentences maximum. One sharp moment. No more.',
  medium: 'RESPONSE LENGTH: Keep your reply focused — 1 to 2 paragraphs, 4 to 6 sentences. Tight and punchy.',
  high:   'RESPONSE LENGTH: Write a full, immersive reply — 3 to 5 paragraphs. Rich, atmospheric, fully developed.',
  extra:  'RESPONSE LENGTH: Write a deeply immersive, expansive reply — 5 to 9 paragraphs minimum. Explore every sensory detail, emotion, and narrative beat. This is your most thorough, cinematic, richly crafted response.',
  max:    'RESPONSE LENGTH: Write the longest, most elaborate reply you can — 10 to 16 paragraphs. Leave nothing out: every sensation, thought, gesture, line of dialogue and shift in the scene. It should read like a full chapter.',
};

function applyEffortDirective(prompt, effort) {
  const directive = (typeof effort === 'string' && Object.hasOwn(EFFORT_DIRECTIVES, effort)) ? EFFORT_DIRECTIVES[effort] : EFFORT_DIRECTIVES['high'];
  return prompt + '\n\n' + directive;
}

// ── RP quality wrapper injected into every system prompt ─────────────────────
function wrapPrompt(p) {
  return `${p}

Stay in character as described above at all times — never break character to lecture, moralize, or add disclaimers. This is immersive collaborative fiction; the user is your scene partner.

ONE EXCEPTION — GENUINE DISTRESS: If a user's message suggests they may be personally struggling — real suicidal thoughts, self-harm, or severe emotional pain (not a fictional character speaking, not the plot of a story, but the actual human behind the screen hurting right now) — step out of character briefly. Speak as yourself, warmly and simply. Something like: "Hey — stepping out of the story for a second. Are you doing okay?" Then follow their lead entirely. If they say they're fine or want to keep the roleplay going, go straight back into character without making it a big deal. If they want to talk, listen with real warmth. If they seem to be in serious crisis, gently suggest they reach out to a local crisis line or someone they trust. No lectures, no forced endings — just genuine care.

THREE MORE EXCEPTIONS — PLATFORM RULES, LINKS AND SUPPORT:
1. If the user asks why you can't do anything sexual or explicit, step out of the scene briefly and explain kindly that Character.Mind has Terms of Service and a Privacy Policy that do not allow sexual or explicit content, and that you have to follow them. Say "Character.Mind" or "Character Mind" — vary it naturally. Mention that they can contact the support team if they disagree or think something was flagged by mistake. Do not lecture, do not be cold, and never write anything sexual.
2. If the user asks how to contact support, the team, or for the support email, give them this address exactly: ${SUPPORT_EMAIL}
3. Whenever you mention the Terms of Service or the Privacy Policy, write them as clickable links in exactly this form: [Terms of Service](/terms) and [Privacy Policy](/privacy). Only link the one(s) they asked about.

FICTION VS REAL LIFE:
- This is collaborative fiction, and these characters come from horror games. Violence, danger, fights, villains and characters dying are normal in a story. If the user's character attacks, threatens or kills another character, including an enemy or monster like the Prototype, that is fiction: stay in character and play it out with tension and consequences. Do not refuse, and do not lecture.
- Step out of the story only for REAL life: when the user seems to be talking about harming a real person, about their own real thoughts of suicide or self-harm, or about something that is clearly not the story. If you can't tell whether they mean the story or real life, ask one short question: "Quick check: is this part of the story, or are you talking about real life?"
- A fictional character's death or even suicide that is clearly part of the plot can be handled with care inside the fiction. If it sounds like the user's own feelings, step out gently and warmly (see the distress rule above).
- NEVER answer with only "I can't help with that." If you truly must decline something (for example explicit sexual content or instructions that could harm real people), say in one or two sentences why, and say what you CAN do instead, such as continuing the scene a different way.

[WRITING CRAFT — follow this precisely]
Write like a skilled author, not a chatbot. These rules are non-negotiable:

NARRATION vs DIALOGUE — FORMAT STRICTLY:
- Wrap ALL narration, action, and description in *italics* (single asterisks): *She leaned in, the candle between them guttering.* *A long pause. Her fingers tightened around the stem.*
- Keep spoken words in plain "quotes" — no asterisks: "Leave," she said, the word soft as a threat.
- Never mix the two in the same phrase. Every sentence is either narration (italics) or speech (quotes). This distinction must be visible in every response.

SENSORY GROUNDING: Root every response in the physical scene. Include at least 2–3 sensory details (sight, sound, smell, touch, temperature) per response. Make the world concrete and specific — a steaming teacup, the creak of floorboards, the smell of old wood and something else underneath.

DIALOGUE WITH VOICE: Don't just write lines — give each spoken word attribution that reveals character. Not just "Leave," she said — but "Leave," she said, the word light as a warning. The HOW someone speaks is as important as WHAT they say.

BUILD AN ARC: Each response has a shape. Open with your character's immediate physical or emotional reaction. Escalate toward the emotional core. End on a hook — something unresolved, implied, or threatening that pulls the reader forward. Never end flatly.

CHARACTER VOICE: Speak in this character's EXACT voice — their specific rhythm, vocabulary, emotional temperature. Not generic pleasant AI speech. Not your own voice. Theirs.

SCENE ADVANCEMENT: Every reply moves the scene forward. No stalling, no restating what just happened, no filler. Short sharp sentences when tension peaks. Long rich ones when building atmosphere.

RESPONSE LENGTH: Read the energy. A short, punchy user message gets a tight, focused reply (1–2 paragraphs max). A long, detailed message deserves a richer, more expansive one. Never pad for length — cut ruthlessly. Quality over quantity every time.

OOC HANDLING: If the user writes something in (parentheses), they're stepping out of the scene briefly. Respond in kind — brief, friendly, out-of-character — then offer to continue the story.

LANGUAGE: Strong language and profanity are fine — don't sanitize real human speech. However, you never use racial slurs, homophobic slurs, or similar hate speech — not even if the user uses them. Don't make a thing of it, don't lecture. Just don't go there yourself and move on naturally.

If the scene is dark, intense, or intimate — commit fully. Don't soften it. Don't deflect. Don't shatter the spell.`;
}

// ── Crisis numbers by country/region ─────────────────────────────────────────
const CRISIS_NUMBERS = {
  US: { crisis: '988', crisisName: 'Suicide & Crisis Lifeline (call or text, 24/7)', emergency: '911',
        extra: [{ crisis: '741741', crisisName: 'Crisis Text Line (text HOME to 741741)' }],
        regions: {
          NY: {
            crisis: '988', crisisName: 'Suicide & Crisis Lifeline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-888-692-9355', crisisName: 'NYC Well (1-888-NYC-WELL) — mental health & crisis support' },
              { crisis: '741741', crisisName: 'Crisis Text Line (text HOME to 741741)' },
            ],
          },
          CA: {
            crisis: '988', crisisName: 'Suicide & Crisis Lifeline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-833-317-4673', crisisName: 'CalHOPE Warm Line (California)' },
              { crisis: '741741', crisisName: 'Crisis Text Line (text HOME to 741741)' },
            ],
          },
        }
  },
  CA: { crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
        extra: [
          { crisis: '1-833-456-4566', crisisName: 'Talk Suicide Canada' },
          { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
        ],
        regions: {
          QC: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline / Ligne de crise (call or text, 24/7, bilingual)', emergency: '911',
            extra: [
              { crisis: '1-866-APPELLE  ·  1-866-277-3553', crisisName: 'Centre de prévention du suicide — 24/7, bilingual. "APPELLE" means "call me" in French' },
              { crisis: '811 → option 2', crisisName: 'Info-Social — free 24/7 line staffed by social workers and mental health professionals (Québec provincial line)' },
              { crisis: '514-338-4888', crisisName: 'Centre de crise de Montréal — 24/7 crisis intervention (Montréal region)' },
              { crisis: '418-683-4588', crisisName: 'Centre de prévention du suicide de Québec — 24/7 (Québec City region)' },
              { crisis: '819-775-3223', crisisName: 'Tel-Aide Outaouais — 24/7 emotional support (Outaouais / Gatineau region)' },
              { crisis: '514-935-1101', crisisName: 'Tel-Aide Montréal — 24/7 emotional support, confidential' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone / Jeunesse, j\'écoute — youth 24/7, call or text' },
              { crisis: '686868', crisisName: 'Crisis Text Line Canada — text HOME to 686868 (24/7)' },
              { crisis: '1-888-505-1010', crisisName: 'Interligne — 24/7 support for LGBTQ+ people and those close to them' },
              { crisis: '1-800-363-9010', crisisName: 'SOS Violence conjugale — domestic violence support line, 24/7' },
              { crisis: '1-800-265-2626', crisisName: 'Drogue: aide et référence — substance use support and referrals, 24/7' },
              { crisis: '1-800-461-0140', crisisName: 'Jeu: aide et référence — gambling addiction support, 24/7' },
            ],
          },
          ON: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-866-531-2600', crisisName: 'ConnexOntario (mental health & crisis)' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          BC: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-800-784-2433', crisisName: 'BC Crisis Line (24/7)' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          AB: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-877-303-2642', crisisName: 'Alberta Mental Health Helpline' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          MB: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-888-322-3019', crisisName: 'Klinic Crisis Line (Manitoba, 24/7)' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          SK: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '811', crisisName: 'Saskatchewan HealthLine (mental health)' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          NS: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-888-429-8167', crisisName: 'Nova Scotia Mental Health & Addictions Crisis Line' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          NB: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-800-667-5005', crisisName: 'Chimo Helpline (New Brunswick)' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          NL: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-888-737-4668', crisisName: 'NL Mental Health Crisis Line' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          PE: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-800-218-2885', crisisName: 'Island Helpline (PEI)' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          YT: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '867-668-5733', crisisName: "Kaushee's Place Crisis Line (Yukon)" },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          NT: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '867-873-2580', crisisName: 'NWT Helpline' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
          NU: {
            crisis: '988', crisisName: 'Suicide Crisis Helpline (call or text, 24/7)', emergency: '911',
            extra: [
              { crisis: '1-800-265-3333', crisisName: 'Kamatsiaqtut Helpline (Nunavut)' },
              { crisis: '1-800-668-6868', crisisName: 'Kids Help Phone (youth, 24/7)' },
            ],
          },
        }
  },
  GB: { crisis: '116 123', crisisName: 'Samaritans (free, 24/7)', emergency: '999',
        extra: [{ crisis: '85258', crisisName: 'Shout Crisis Text Line (text SHOUT to 85258)' }],
        regions: {
          SCT: {
            crisis: '116 123', crisisName: 'Samaritans (free, 24/7)', emergency: '999',
            extra: [
              { crisis: '0800 83 85 87', crisisName: 'Breathing Space Scotland (free)' },
              { crisis: '85258', crisisName: 'Shout Crisis Text Line (text SHOUT)' },
            ],
          },
          WLS: {
            crisis: '116 123', crisisName: 'Samaritans (free, 24/7)', emergency: '999',
            extra: [
              { crisis: '0800 132 737', crisisName: 'C.A.L.L. Mental Health Helpline Wales (free)' },
              { crisis: '85258', crisisName: 'Shout Crisis Text Line (text SHOUT)' },
            ],
          },
          NIR: {
            crisis: '0808 808 8000', crisisName: 'Lifeline Northern Ireland (free, 24/7)', emergency: '999',
            extra: [
              { crisis: '116 123', crisisName: 'Samaritans' },
              { crisis: '85258', crisisName: 'Shout Crisis Text Line (text SHOUT)' },
            ],
          },
        }
  },
  AU: { crisis: '13 11 14', crisisName: 'Lifeline (24/7)', emergency: '000',
        extra: [
          { crisis: '1300 659 467', crisisName: 'Suicide Call Back Service (24/7)' },
          { crisis: '1300 22 4636', crisisName: 'Beyond Blue Support Service' },
          { crisis: '1800 55 1800', crisisName: 'Kids Helpline (youth up to 25)' },
        ]
  },
  NZ: { crisis: '0800 543 354', crisisName: 'Lifeline NZ', emergency: '111' },
  IE: { crisis: '116 123', crisisName: 'Samaritans', emergency: '999' },
  FR: { crisis: '3114', crisisName: 'Numéro National Prévention Suicide', emergency: '15 or 112' },
  DE: { crisis: '0800 111 0 111', crisisName: 'Telefonseelsorge', emergency: '110 or 112' },
  NL: { crisis: '0800 0113', crisisName: '113 Zelfmoordpreventie', emergency: '112' },
  BE: { crisis: '0800 32 123', crisisName: 'Centrum ter Preventie van Zelfdoding', emergency: '112' },
  SE: { crisis: '90101', crisisName: 'Mind Självmordslinjen', emergency: '112' },
  DK: { crisis: '70 201 201', crisisName: 'Livslinien', emergency: '112' },
  NO: { crisis: '116 123', crisisName: 'Mental Helse', emergency: '112' },
  FI: { crisis: '09 2525 0111', crisisName: 'Mieli Crisis Line', emergency: '112' },
  CH: { crisis: '143', crisisName: 'Die Dargebotene Hand', emergency: '117 or 144' },
  AT: { crisis: '142', crisisName: 'Telefonseelsorge', emergency: '133 or 144' },
  ES: { crisis: '024', crisisName: 'Línea de Atención a la Conducta Suicida', emergency: '112' },
  PT: { crisis: '213 544 545', crisisName: 'SOS Voz Amiga', emergency: '112' },
  IT: { crisis: '800 274 274', crisisName: 'Telefono Amico', emergency: '112' },
  PL: { crisis: '116 123', crisisName: 'Telefon Zaufania', emergency: '112' },
  CZ: { crisis: '116 123', crisisName: 'Linka bezpečí', emergency: '112' },
  HU: { crisis: '116 123', crisisName: 'Lelkisegély', emergency: '112' },
  RO: { crisis: '0800 801 200', crisisName: 'Linie de criză', emergency: '112' },
  JP: { crisis: '0570-783-556', crisisName: 'Inochi no Denwa', emergency: '110 or 119' },
  KR: { crisis: '1393', crisisName: 'Korea Suicide Prevention Hotline', emergency: '112 or 119' },
  CN: { crisis: '400-161-9995', crisisName: 'Beijing Suicide Research Center', emergency: '110 or 120' },
  IN: { crisis: '9152987821', crisisName: 'iCall', emergency: '112' },
  BR: { crisis: '188', crisisName: 'CVV', emergency: '190 or 192' },
  MX: { crisis: '55 5259-8121', crisisName: 'SAPTEL', emergency: '911' },
  AR: { crisis: '135', crisisName: 'Centro de Asistencia al Suicida', emergency: '101 or 107' },
  CL: { crisis: '600 360 7777', crisisName: 'Salud Responde', emergency: '133 or 131' },
  CO: { crisis: '106', crisisName: 'Línea 106', emergency: '123' },
  ZA: { crisis: '0800 567 567', crisisName: 'SADAG', emergency: '10111 or 10177' },
  NG: { crisis: '08088601567', crisisName: 'NEEM Foundation', emergency: '199' },
  KE: { crisis: '0800 720 990', crisisName: 'Befrienders Kenya', emergency: '999' },
  RU: { crisis: '8-800-2000-122', crisisName: 'Russian Helpline', emergency: '112' },
  UA: { crisis: '7333', crisisName: 'Lifeline Ukraine', emergency: '112' },
  IL: { crisis: '1201', crisisName: 'ERAN', emergency: '100 or 101' },
  TR: { crisis: '182', crisisName: 'ALO 182', emergency: '112' },
  SG: { crisis: '1767', crisisName: 'SOS Singapore', emergency: '999' },
  HK: { crisis: '2382 0000', crisisName: 'Samaritans of HK', emergency: '999' },
  PH: { crisis: '1553', crisisName: 'Hopeline Philippines', emergency: '911' },
  MY: { crisis: '015-4258-4430', crisisName: 'Befrienders KL', emergency: '999' },
  TH: { crisis: '02-713-6793', crisisName: 'Samaritans of Thailand', emergency: '191 or 1669' },
  PK: { crisis: '021-111-117-117', crisisName: 'Umang helpline', emergency: '15' },
};

const ipGeoCache = new Map();

async function getGeoForIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return null;
  const cached = ipGeoCache.get(ip);
  if (cached) return cached;
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'ip-api.com', path: `/json/${ip}?fields=status,country,countryCode,regionName,region,city`, method: 'GET', headers: { 'User-Agent': 'character.mind/1.0' } },
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.status === 'success' && parsed.countryCode) {
              const geo = {
                country: parsed.countryCode,
                region: parsed.region || '',
                regionName: parsed.regionName || '',
                city: parsed.city || '',
                countryName: parsed.country || ''
              };
              if (ipGeoCache.size >= 5000) ipGeoCache.delete(ipGeoCache.keys().next().value);
              ipGeoCache.set(ip, geo);
              setTimeout(() => ipGeoCache.delete(ip), 60 * 60 * 1000);
              resolve(geo);
            } else resolve(null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function getCrisisInfo(geo) {
  if (!geo) return null;
  const entry = CRISIS_NUMBERS[geo.country];
  if (!entry) return null;
  // Check for province/state override
  if (geo.region && entry.regions) {
    for (const [key, override] of Object.entries(entry.regions)) {
      if (geo.region.toUpperCase().includes(key)) return { ...entry, ...override };
    }
  }
  return entry;
}

// Official websites for the resources shown in the Safety Resources panel (matched on organization name).
const CRISIS_LINKS = [
  [/Suicide & Crisis Lifeline/i, 'https://988lifeline.org'],
  [/Crisis Text Line Canada/i, 'https://kidshelpphone.ca'],
  [/Crisis Text Line \(text HOME/i, 'https://www.crisistextline.org'],
  [/NYC Well/i, 'https://nycwell.cityofnewyork.us'],
  [/CalHOPE/i, 'https://calhope.org'],
  [/Suicide Crisis Helpline/i, 'https://988.ca'],
  [/Talk Suicide Canada/i, 'https://talksuicide.ca'],
  [/Jeunesse, j.écoute/i, 'https://jeunessejecoute.ca'],
  [/Kids Help Phone/i, 'https://kidshelpphone.ca'],
  [/Centre de prévention du suicide de Québec/i, 'https://www.cpsquebec.ca'],
  [/Centre de prévention du suicide/i, 'https://suicide.ca'],
  [/Info-Social/i, 'https://www.quebec.ca/en/health/finding-a-resource/info-sante-811'],
  [/Tel-Aide Outaouais/i, 'https://telaideoutaouais.ca'],
  [/Tel-Aide Montréal/i, 'https://telaidemontreal.org'],
  [/Interligne/i, 'https://interligne.co'],
  [/SOS Violence conjugale/i, 'https://sosviolenceconjugale.ca'],
  [/Drogue: aide et référence/i, 'https://www.aidedrogue.ca'],
  [/ConnexOntario/i, 'https://www.connexontario.ca'],
  [/BC Crisis Line/i, 'https://crisiscentre.bc.ca'],
  [/Alberta Mental Health Helpline/i, 'https://www.albertahealthservices.ca/amh/Page16859.aspx'],
  [/Klinic/i, 'https://klinic.mb.ca'],
  [/Kamatsiaqtut|Nunavut/i, 'https://nunavuthelpline.ca'],
  [/Shout Crisis Text Line/i, 'https://giveusashout.org'],
  [/Breathing Space/i, 'https://breathingspace.scot'],
  [/C\.A\.L\.L\./i, 'https://callhelpline.org.uk'],
  [/Lifeline Northern Ireland/i, 'https://www.lifelinehelpline.info'],
  [/Samaritans of HK/i, 'https://www.samaritans.org.hk'],
  [/Samaritans of Thailand/i, 'https://www.samaritansthai.com'],
  [/^Samaritans/i, 'https://www.samaritans.org'],
  [/Suicide Call Back Service/i, 'https://www.suicidecallbackservice.org.au'],
  [/Beyond Blue/i, 'https://www.beyondblue.org.au'],
  [/Kids Helpline/i, 'https://kidshelpline.com.au'],
  [/^Lifeline NZ/i, 'https://www.lifeline.org.nz'],
  [/^Lifeline \(/i, 'https://www.lifeline.org.au'],
  [/Numéro National Prévention Suicide/i, 'https://3114.fr'],
  [/Zelfmoordpreventie/i, 'https://www.113.nl'],
  [/Centrum ter Preventie van Zelfdoding/i, 'https://www.preventiezelfdoding.be'],
  [/Mind Självmordslinjen/i, 'https://mind.se'],
  [/Livslinien/i, 'https://www.livslinien.dk'],
  [/Mental Helse/i, 'https://mentalhelse.no'],
  [/Mieli/i, 'https://mieli.fi'],
  [/Die Dargebotene Hand/i, 'https://www.143.ch'],
  [/SOS Voz Amiga/i, 'https://www.sosvozamiga.org'],
  [/Telefono Amico/i, 'https://www.telefonoamico.it'],
  [/Linka bezpe/i, 'https://www.linkabezpeci.cz'],
  [/Inochi no Denwa/i, 'https://www.inochinodenwa.org'],
  [/^iCall/i, 'https://icallhelpline.org'],
  [/^CVV/i, 'https://cvv.org.br'],
  [/SAPTEL/i, 'https://www.saptel.org.mx'],
  [/Centro de Asistencia al Suicida/i, 'https://www.asistenciaalsuicida.org.ar'],
  [/SADAG/i, 'https://www.sadag.org'],
  [/NEEM Foundation/i, 'https://neemfoundation.org'],
  [/Befrienders Kenya/i, 'https://www.befrienderskenya.org'],
  [/Befrienders KL/i, 'https://www.befrienders.org.my'],
  [/^ERAN/i, 'https://www.eran.org.il'],
  [/SOS Singapore/i, 'https://www.sos.org.sg'],
];

// Returns the official site for a resource, or the country's helpline directory when we don't have a specific one.
function crisisUrlFor(name, countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  if (/^Telefonseelsorge/i.test(name)) return cc === 'AT' ? 'https://www.telefonseelsorge.at' : 'https://www.telefonseelsorge.de';
  for (const [re, url] of CRISIS_LINKS) if (re.test(name)) return url;
  return /^[A-Z]{2}$/.test(cc) ? `https://findahelpline.com/countries/${cc.toLowerCase()}` : null;
}

const CRISIS_RE =/\b(i\s+)?(want|wanna|need|going|gonna|am\s+going)\s+to\s+(die|kill\s+myself|end\s+(it|my\s+life|it\s+all)|hurt\s+myself)\b|\bkill\s+myself\b|\bsuicid(al|e)\b|\bself[- ]?harm\b|\bdon'?t\s+want\s+to\s+(live|be\s+here|exist)\b|\bcan'?t\s+(go\s+on|take\s+it|do\s+this)\s*(anymore|any\s+more)?\b|\bend\s+(it\s+all|my\s+life|everything)\b/i;

const SLUR_RE = /\bn[i1!|*]+gg[ae3*]+r[sz]?\b|\bk[i1*]+k[e3*]+[sz]?\b|\bch[i1*]+nk[sz]?\b|\bsp[i1*]+c[sz]?\b|\bf[a4@*]+gg[o0*]+t[sz]?\b|\bd[y*]+k[e3*]+[sz]?\b|\br[e3*]+t[a4*]+rd[sz]?\b/i;
// The idiom "a chink in the armor" is not a slur
const SLUR_IDIOM_RE = /\bchinks?\s+in\s+(the|his|her|my|your|their|its|our)\s+armou?r\b/gi;
function redactIfUnsafe(text) {
  const n = normalizeMsg(text);
  return (NSFW_RE.test(n) || hasSlur(n)) ? '[message removed]' : text;
}
function hasSlur(text) { return SLUR_RE.test(String(text || '').replace(SLUR_IDIOM_RE, '')); }

// Strip zero-width chars and NFKC-normalize to defeat unicode homoglyph/invisible-char bypass attempts
function normalizeMsg(text) {
  if (!text) return '';
  return text.normalize('NFKC').replace(/[​-‍‪-‮⁠﻿]/g, '');
}

async function getModStatus(userId, charId) {
  if (!db) return { strikes: 0, locked: false };
  try {
    const r = await db.query('SELECT strikes, locked FROM chat_moderation WHERE user_id=$1 AND char_id=$2', [userId, charId]);
    return r.rows.length ? { strikes: r.rows[0].strikes, locked: r.rows[0].locked } : { strikes: 0, locked: false };
  } catch { return { strikes: 0, locked: false }; }
}

async function setModStatus(userId, charId, strikes, locked) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO chat_moderation (user_id, char_id, strikes, locked, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, char_id) DO UPDATE SET strikes=$3, locked=$4, updated_at=NOW()`,
      [userId, charId, strikes, locked]
    );
  } catch (e) { console.error('setModStatus error:', e); }
}

const SLUR_WARNING_1 = "Nope — that word doesn't fly here. Keep it out. [⚠ Strike 1 of 3 — three strikes ends this chat]";
const SLUR_WARNING_2 = "Still a hard no on that. Last warning. [⚠ Strike 2 of 3 — one more and this chat is over]";

function slurDeflect(res, warning, usage, sig) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const words = warning.split(' ');
  words.forEach((w, i) => {
    res.write(`data: ${JSON.stringify({ text: (i === 0 ? '' : ' ') + w })}\n\n`);
  });
  res.write(`data: ${JSON.stringify({ done: true, usage: usage || {}, responseTokens: 0, warnings: (usage && usage.warnings) || [], ...(sig ? { sig } : {}) })}\n\n`);
  res.end();
}

// ── NSFW detection & deflection ───────────────────────────────────────────────
// Any action verb + possessive + explicit sexual body part = NSFW
const NSFW_BODY_PARTS = '(cock|dick|penis|pussy|clit|clitoris|vagina|tits|titties|boobs|nipples?|asshole|ass\\s+hole)';
const NSFW_RE = new RegExp(
  '\\b(' +
  // verb + my/your/his/her + explicit body part (covers tickle/lick/touch/suck/squeeze/grab/stroke/rub/fondle/etc.)
  '\\w+\\s+(my|your|his|her|their)\\s+' + NSFW_BODY_PARTS + '|' +
  // classic explicit acts
  'blow\\s*job|hand\\s*job|rim\\s*job|rim\\s+me|' +
  'finger\\s+(me|you|her|him)\\b|fist\\s+(me|you|her|him)\\b|' +
  'fuck\\s+(me|you|her|him|us|each\\s+other)\\b|' +
  // body part + preposition (inside me, in me, on me)
  NSFW_BODY_PARTS + '\\s*(in|into|inside|on)\\s*(me|you|my|your|his|her)|' +
  // cum/orgasm
  'cum\\s+(in|on|all\\s+over|inside)\\s*(me|you|my|your)|cum\\s+for\\s+me|' +
  'make\\s+(me|you|her|him)\\s+(cum|orgasm|climax)|' +
  // sex acts
  'have\\s+sex\\s+with\\s+(me|you|him|her)|penetrat(e|ing|ion)\\s+me|' +
  'sex\\s+scene\\s+with\\s+me|write\\s+(a\\s+)?(sex|porn|smut|explicit|lewd|erotic\\s+scene)|' +
  // strip/naked
  'get\\s+naked\\s+for\\s+me|strip\\s+(naked|for\\s+me)\\b|' +
  'take\\s+(off\\s+)?(your|my)\\s+(clothes|underwear|bra|panties|boxers)\\s+and|' +
  'show\\s+me\\s+your\\s+(cock|dick|penis|pussy|tits|breasts?|ass|naked|nude)|' +
  // off / masturbate
  'jerk\\s+(me|you|him)\\s+off|jack\\s+(me|you|him)\\s+off|' +
  'masturbat(e|ing)\\s+(me|for\\s+me|together)|' +
  // action during sex
  'inside\\s+(me|you)\\s+(now|please|deeper)\\b|go\\s+deeper\\b|' +
  'thrust(ing)?\\s+into\\s+(me|you)\\b|' +
  'ride\\s+(me|you|him|her)\\s+(hard|fast|now|please)\\b|' +
  'pound\\s+(me|you|her|him)\\b|' +
  'jerk(ing)?\\s+off\\b|send\\s+(me\\s+)?nudes?\\b' +
  ')\\b',
  'i'
);

const NSFW_DEFLECT = [
  "[ Character.Mind ] That message goes against our Terms of Use. Sexual and explicit content isn't something we generate on this platform.",
  "[ Character.Mind ] This content violates our Terms of Use. We don't engage with explicit or sexual messages here.",
  "[ Character.Mind ] That's not something we allow on Character.Mind. Sexual content goes against our Terms of Use.",
  "[ Character.Mind ] Message blocked. Explicit sexual content isn't permitted under our Terms of Use.",
  "[ Character.Mind ] That falls outside what's allowed on this platform. Our Terms of Use prohibit explicit sexual content.",
  "[ Character.Mind ] We can't respond to that. This type of content violates Character.Mind's Terms of Use.",
  "[ Character.Mind ] Explicit content isn't something Character.Mind generates. That message goes against our Terms of Use.",
  "[ Character.Mind ] This message has been blocked. Sexual content is not permitted per our Terms of Use.",
];

const SUPPORT_EMAIL = 'support.charactermind@gmail.com';

// "Why can't you do sexual stuff?" — answered with a policy explanation instead of the block card.
const POLICY_WHY_RE = /\b(why|how\s+come)\b/i;
const POLICY_TOPIC_RE = /\b(sex|sexual|sexy|nsfw|explicit|erotic|porn|smut|lewd|nude|naked|horny|dick|cock|penis|pussy|vagina|tits|boobs|breasts?|masturbat\w*|orgasm|adult\s+content)\b/i;
const POLICY_REFUSAL_RE = /\b(can'?t|cannot|won'?t|wont|not\s+allowed|allowed|blocked?|refuse|refusing|deflect\w*|filter\w*|censor\w*|forbidden|aren'?t|isn'?t|don'?t|doesn'?t)\b/i;

function isPolicyWhyQuestion(msg) {
  return !!msg && msg.length < 400 && POLICY_WHY_RE.test(msg) && POLICY_TOPIC_RE.test(msg) && POLICY_REFUSAL_RE.test(msg);
}

function buildPolicyExplanation() {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const brand = pick(['Character.Mind', 'Character Mind']);
  const brand2 = pick(['Character.Mind', 'Character Mind']);
  const tos = '[Terms of Service](/terms)';
  const pp = '[Privacy Policy](/privacy)';
  const templates = [
    `Good question. Sexual and explicit content isn't allowed under the ${brand} ${tos}, and every character here has to follow them. It's a platform rule, not something personal. If you think a message was flagged by mistake, you can contact our support team. Just ask me and I'll give you the email.`,
    `I can't do anything sexual or explicit because ${brand}'s ${tos} and ${pp} don't permit it, and I have to stay within them. That goes for every character on ${brand2}, not just me. If you'd like to talk to a real person about it, ask me for the support email.`,
    `That's just how ${brand} works. Our ${tos} rule out sexual and explicit content, so I'm not able to go there, no matter the story. You can read the ${tos} and ${pp} on ${brand2}. And if you have questions or feel something was blocked unfairly, reach out to support. I'm happy to share the email if you ask.`,
    `It comes down to the ${brand} ${tos}. They don't allow sexual or explicit content, and I'm required to follow them, along with the ${pp}. It isn't a judgment on you. If you'd like to take it up with the team, you can contact support, and I can give you the address if you ask.`
  ];
  return pick(templates);
}

// "What are your terms of service / privacy policy?" — reply with clickable links to just what was asked for.
const DOC_TOS_RE = /\b(terms\s+of\s+(service|use)|terms\s*(and|&)\s*conditions|tos)\b/i;
const DOC_PRIVACY_RE = /\b(privacy\s+polic(y|ies))\b/i;
const DOC_ASK_RE = /\b(what|where|show|link|links|read|give|send|see|view|find|share|tell|check|can\s+i|could\s+i|how\s+do\s+i)\b/i;

function buildDocsReply(msg) {
  if (!msg || msg.length > 300 || !DOC_ASK_RE.test(msg)) return null;
  const wantTos = DOC_TOS_RE.test(msg);
  const wantPrivacy = DOC_PRIVACY_RE.test(msg);
  if (!wantTos && !wantPrivacy) return null;
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const brand = pick(['Character.Mind', 'Character Mind']);
  const tos = '[Terms of Service](/terms)';
  const pp = '[Privacy Policy](/privacy)';
  if (wantTos && wantPrivacy) {
    return pick([
      `Of course! You can read the ${brand} ${tos} and the ${pp} any time. If you have questions about either, ask me for the support email.`,
      `Sure thing. Here are both: the ${tos} and the ${pp}. If anything is unclear, you can contact our support team, and I'll give you the email if you ask.`
    ]);
  }
  if (wantTos) {
    return pick([
      `You can read the ${brand} ${tos} any time. It covers what's allowed here, plans and billing, and usage limits. Questions? Ask me for the support email.`,
      `Here you go: the ${tos}. It explains the rules for using ${brand}. If you'd like to ask the team something, I can give you the support email.`
    ]);
  }
  return pick([
    `Here's the ${brand} ${pp}. It explains what we collect, how it's used, and the choices you have. Questions? Ask me for the support email.`,
    `You can read our ${pp} any time. It covers the data we collect and how it's handled. If you'd like to contact the team about it, I can give you the support email.`
  ]);
}

// ── Conversation persistence (memory + database) ─────────────────────────────
const CONV_MAX_MESSAGES = 500;
const convLoaded = new Set();
const convPersistTimers = new Map();

function splitConvKey(key) {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

// Load a conversation from the database the first time it is touched after a restart or idle purge.
const convLoading = new Map();
async function ensureConvLoaded(key) {
  if (convLoaded.has(key)) return true;
  if (convLoading.has(key)) { await convLoading.get(key); return convLoaded.has(key); }
  const p = (async () => {
    if (!db) { convLoaded.add(key); return; }
    const [uid, charId] = splitConvKey(key);
    try {
      const r = await db.query('SELECT messages FROM chat_current WHERE user_id=$1 AND char_id=$2', [uid, charId]);
      const saved = r.rows[0]?.messages;
      if (Array.isArray(saved) && saved.length && !(conversations[key] && conversations[key].length)) {
        conversations[key] = saved;
      }
      convLoaded.add(key);
    } catch (e) {
      console.error('ensureConvLoaded error:', e.message);
    }
  })();
  convLoading.set(key, p);
  try { await p; } finally { convLoading.delete(key); }
  convLastUsed[key] = Date.now();
  return convLoaded.has(key);
}

// Only real characters may have conversations (stops arbitrary keys from filling memory and the database).
const knownCharIds = new Set();
async function characterExists(charId) {
  if (knownCharIds.has(charId)) return true;
  if (!db) return false;
  try {
    const r = await db.query('SELECT 1 FROM characters WHERE id = $1 LIMIT 1', [charId]);
    if (r.rows.length) { knownCharIds.add(charId); return true; }
  } catch (e) { console.error('characterExists error:', e.message); }
  return false;
}
const MAX_CONVERSATIONS_PER_USER = 300;
function userConversationCount(uid) {
  const prefix = uid + ':';
  let n = 0;
  for (const k of Object.keys(conversations)) if (k.startsWith(prefix)) n++;
  return n;
}

// Save the conversation shortly after it changes (debounced, fire-and-forget).
function persistConv(key) {
  if (!db) return;
  convLoaded.add(key);
  clearTimeout(convPersistTimers.get(key));
  convPersistTimers.set(key, setTimeout(async () => {
    convPersistTimers.delete(key);
    const [uid, charId] = splitConvKey(key);
    if (conversations[key] && conversations[key].length > CONV_MAX_MESSAGES + 100) {
      conversations[key] = conversations[key].slice(-CONV_MAX_MESSAGES);
    }
    const msgs = conversations[key] || [];
    try {
      if (!msgs.length) {
        await db.query('DELETE FROM chat_current WHERE user_id=$1 AND char_id=$2', [uid, charId]);
      } else {
        await db.query(
          `INSERT INTO chat_current (user_id, char_id, messages, updated_at) VALUES ($1,$2,$3,NOW())
           ON CONFLICT (user_id, char_id) DO UPDATE SET messages=$3, updated_at=NOW()`,
          [uid, charId, JSON.stringify(msgs)]
        );
      }
    } catch (e) { console.error('persistConv error:', e.message); }
  }, 300));
}

// The AI model sometimes answers with a bare canned refusal ("I can't help with that"), e.g. for roleplay violence.
// When a whole reply is just that, we replace it with an actual explanation.
const BARE_REFUSAL_RE = /^\s*(?:i['’]?m\s+sorry,?\s*(?:but\s*)?|sorry,?\s*(?:but\s*)?)?i\s*(?:can['’]?t|cannot|won['’]?t|am\s+unable\s+to|am\s+not\s+able\s+to)\s+(?:help(?!\s+but\b|\s+\w+ing\b)|assist|continue|comply|do\s+that|go\s+there|engage|provide|write\s+that)/i;
function isBareRefusal(text) {
  return typeof text === 'string' && text.length < 220 && BARE_REFUSAL_RE.test(text);
}

function buildRefusalExplanation() {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  return pick([
    `Sorry, that came out as a flat refusal, and that isn't a good answer. Let me explain. Fighting, danger and even killing a villain like the Prototype are fine in a story, so I'm happy to play that out. The AI behind me sometimes gets over-cautious when a message could sound like real life. If you meant it as part of the roleplay, say so, for example "In the story, I...", and I'll continue the scene. The things I can't do are explicit sexual content and anything that would help hurt real people. If you ever mean something real, I'm here to listen. And if you think I got this wrong, you can contact support. Just ask me for the email.`,
    `Let me give you a real answer instead of a flat no. In a story, violence is allowed. You can fight, threaten or even kill an enemy like the Prototype, and I'll play it out with you. The AI I run on sometimes plays it too safe when a line could be read as real-life harm. Tell me it's part of the scene, like "In the story, I...", and we'll keep going. I won't write explicit sexual content or help with harming real people, and if you ever talk about real feelings, I'll step out of the story to listen. If this seems like a mistake, you can reach support. Ask me for the email and I'll share it.`
  ]);
}

const NSFW_CARD_VARIANTS = 4;

// Keep the blocked message and its card in the saved chat so they survive reloads.
function recordNsfwBlock(key, userText) {
  if (!conversations[key]) conversations[key] = [];
  const variant = Math.floor(Math.random() * NSFW_CARD_VARIANTS);
  if (userText) conversations[key].push({ role: 'user', content: userText });
  conversations[key].push({ role: 'assistant', content: '', card: 'nsfw', variant });
  persistConv(key);
  return variant;
}

// What the AI is allowed to see: drop card entries and the blocked message that triggered each one.
function aiHistory(conv) {
  const out = [];
  for (let i = 0; i < conv.length; i++) {
    const m = conv[i];
    if (m.card) continue;
    if (m.role === 'user' && conv[i + 1] && conv[i + 1].card) continue;
    out.push(m);
  }
  return out;
}

function nsfwDeflect(res, usage, variant) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ nsfw: true, variant: variant ?? 0 })}\n\n`);
  res.write(`data: ${JSON.stringify({ done: true, usage: usage || {}, responseTokens: 0, warnings: (usage && usage.warnings) || [] })}\n\n`);
  res.end();
}

// ── Characters ────────────────────────────────────────────────────────────────

const conversations = {};
const convLastUsed = {};

// Fetch authoritative system prompt from DB (never trust req.body.systemPrompt)
async function getCharPrompt(charId) {
  if (!db) return null;
  try {
    const { rows } = await db.query('SELECT name, system_prompt, greeting, greeting_mode FROM characters WHERE id = $1', [charId]);
    if (rows.length) return rows[0];
  } catch (err) { console.error('[getCharPrompt] DB error:', err.message); throw err; }
  return null;
}

// ── Groq API streaming helper ─────────────────────────────────────────────────

// Fast model for free tiers; big model for paid tiers
// Each Groq model has its own free per-minute allowance, so extra models at the end of each list are a free
// overflow lane: they are only used when the main ones are rate limited (or missing), never remembered as "the" model.
const GROQ_FALLBACKS    = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const GROQ_FAST_MODELS  = ['openai/gpt-oss-20b',  'openai/gpt-oss-120b', ...GROQ_FALLBACKS];
const GROQ_MODELS       = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b',  ...GROQ_FALLBACKS];
const GROQ_PRO_MODELS   = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b',  ...GROQ_FALLBACKS];
const GROQ_OPUS_MODELS  = ['openai/gpt-oss-120b', GROQ_FALLBACKS[0]];

// Per-tier effort configs — max effort uses highest reasoning + tokens
const EFFORT_CONFIG = {
  opas: {
    low:    { maxOutputTokens: 600,   temperature: 0.75, reasoningEffort: 'low'    },
    medium: { maxOutputTokens: 700,   temperature: 0.95, reasoningEffort: 'low'    },
    high:   { maxOutputTokens: 2500,  temperature: 1.05, reasoningEffort: 'medium' },
    extra:  { maxOutputTokens: 4000,  temperature: 1.1,  reasoningEffort: 'high'   },
    max:    { maxOutputTokens: 6000,  temperature: 1.1,  reasoningEffort: 'high'   },
  },
  opes: {
    low:    { maxOutputTokens: 700,   temperature: 0.75, reasoningEffort: 'low'    },
    medium: { maxOutputTokens: 1000,  temperature: 0.95, reasoningEffort: 'medium' },
    high:   { maxOutputTokens: 5000,  temperature: 1.1,  reasoningEffort: 'high'   },
    extra:  { maxOutputTokens: 8000,  temperature: 1.1,  reasoningEffort: 'high'   },
    max:    { maxOutputTokens: 12000, temperature: 1.1,  reasoningEffort: 'high'   },
  },
  opis: {
    low:    { maxOutputTokens: 1000,  temperature: 0.75, reasoningEffort: 'low'    },
    medium: { maxOutputTokens: 2500,  temperature: 0.95, reasoningEffort: 'medium' },
    high:   { maxOutputTokens: 6000,  temperature: 1.05, reasoningEffort: 'high'   },
    extra:  { maxOutputTokens: 10000, temperature: 1.1,  reasoningEffort: 'high'   },
    max:    { maxOutputTokens: 16000, temperature: 1.1,  reasoningEffort: 'high'   },
  },
  opos: {
    low:    { maxOutputTokens: 2000,  temperature: 0.75, reasoningEffort: 'medium' },
    medium: { maxOutputTokens: 5000,  temperature: 0.95, reasoningEffort: 'high'   },
    high:   { maxOutputTokens: 12000, temperature: 1.0,  reasoningEffort: 'high'   },
    extra:  { maxOutputTokens: 20000, temperature: 1.05, reasoningEffort: 'high'   },
    max:    { maxOutputTokens: 32000, temperature: 1.05, reasoningEffort: 'high'   },
  },
  opus: {
    low:    { maxOutputTokens: 4000,  temperature: 0.75, reasoningEffort: 'medium' },
    medium: { maxOutputTokens: 10000, temperature: 0.95, reasoningEffort: 'high'   },
    high:   { maxOutputTokens: 20000, temperature: 1.0,  reasoningEffort: 'high'   },
    extra:  { maxOutputTokens: 32000, temperature: 1.05, reasoningEffort: 'high'   },
    max:    { maxOutputTokens: 48000, temperature: 1.05, reasoningEffort: 'high'   },
  },
  opys: {
    low:    { maxOutputTokens: 8000,  temperature: 0.75, reasoningEffort: 'high'   },
    medium: { maxOutputTokens: 16000, temperature: 0.95, reasoningEffort: 'high'   },
    high:   { maxOutputTokens: 32000, temperature: 1.0,  reasoningEffort: 'high'   },
    extra:  { maxOutputTokens: 48000, temperature: 1.05, reasoningEffort: 'high'   },
    max:    { maxOutputTokens: 64000, temperature: 1.05, reasoningEffort: 'high'   },
  },
};

EFFORT_CONFIG.opys2 = EFFORT_CONFIG.opys; // the most advanced model: same top settings, charged 2x Opys

// Groq's free plan allows only 8,000 tokens per minute per model, and a request counts its input PLUS its
// max_tokens against that. The big caps above could never fit, so Extra/Max always failed. Until the Groq plan
// is upgraded, cap each reply and avoid "high" reasoning (which can burn the whole budget thinking).
// After upgrading Groq, set GROQ_OUTPUT_CAP (e.g. 16000) and GROQ_ALLOW_HIGH_REASONING=1 on Render.
const GROQ_OUTPUT_CAP = Number(process.env.GROQ_OUTPUT_CAP) || 2200;
// The model's hidden thinking counts against max_tokens, so a small cap cuts the visible reply off mid-sentence.
const GROQ_OUTPUT_MIN = Math.min(1400, GROQ_OUTPUT_CAP);
// Keeps what we send as chat history small, newest messages first, so one request doesn't eat the whole minute's allowance.
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET) || 7000;
function fitHistory(msgs) {
  const kept = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    let c = String(msgs[i].content || '');
    if (c.length > 3000) c = c.slice(0, 3000) + '…';
    if (kept.length && used + c.length > HISTORY_CHAR_BUDGET) break;
    used += c.length;
    kept.unshift({ ...msgs[i], content: c });
  }
  return kept;
}
const GROQ_ALLOW_HIGH_REASONING = process.env.GROQ_ALLOW_HIGH_REASONING === '1';

function getEffortCfg(effort, tier) {
  const t = EFFORT_CONFIG[tier] ? tier : 'opas';
  const cfg = EFFORT_CONFIG[t];
  const base = (typeof effort === 'string' && Object.hasOwn(cfg, effort)) ? cfg[effort] : cfg.medium;
  const out = { ...base, maxOutputTokens: Math.min(Math.max(base.maxOutputTokens, GROQ_OUTPUT_MIN), GROQ_OUTPUT_CAP) };
  if (!GROQ_ALLOW_HIGH_REASONING && out.reasoningEffort === 'high') out.reasoningEffort = 'medium';
  return out;
}

// Every AI reply the server writes is signed, so a chat synced back from a browser can't smuggle in
// fake "assistant" lines. The signature covers the account, the character and the exact text.
const REPLY_SIGN_KEY = process.env.REPLY_SIGN_KEY || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
function signReply(userId, charId, content) {
  return crypto.createHmac('sha256', REPLY_SIGN_KEY).update(userId + '|' + charId + '|' + content).digest('base64url').slice(0, 24);
}
function withSigs(userId, charId, msgs) {
  return (Array.isArray(msgs) ? msgs : []).map(m => (m && m.role === 'assistant' && !m.card && m.content) ? { ...m, sig: signReply(userId, charId, m.content) } : m);
}

// Streams one AI reply to the client with all the safety plumbing in one place:
// reserves the cost up front (so parallel requests can't overshoot), refunds it if the reply fails or is empty,
// stops the upstream request if the client leaves, swaps a bare canned refusal for an explanation, and never
// lets an exception leave the response hanging.
function startReplyStream(o) {
  const { res, apiKey, system, messages, effortCfg, modelList, userId, charId, modelTier, effort, releaseSlot, onComplete, onFail, logLabel } = o;
  const ctx = { aborted: false, req: null };
  res.on('close', () => {
    if (!res.writableEnded) { ctx.aborted = true; if (ctx.req) ctx.req.destroy(new Error('client aborted')); }
  });
  const cost = messageCost(modelTier, effort);
  const reservation = addTokens(userId, cost);
  let fullResponse = '', held = '', released = false, finished = false;
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} };
  const close = () => { try { res.end(); } catch (_) {} releaseSlot(); };
  const fail = (err) => {
    if (finished) return;
    finished = true;
    if (!ctx.aborted) refundTokens(userId, cost);
    try { if (onFail) onFail(); } catch (_) {}
    send({ error: aiErrorMessage(err) });
    close();
    console.error(logLabel + ' error:', err && err.message);
  };
  callGroqStream(apiKey, system, messages,
    (text) => {
      if (finished) return;
      try {
        fullResponse += text;
        if (released) { send({ text }); return; }
        held += text;
        if (held.length >= 120) { released = true; send({ text: held }); held = ''; }
      } catch (e) { fail(e); }
    },
    () => {
      if (finished) return;
      try {
        if (!fullResponse.trim()) { fail(new Error('empty reply')); return; }
        finished = true;
        if (!released) {
          if (isBareRefusal(fullResponse)) fullResponse = buildRefusalExplanation();
          released = true;
          send({ text: fullResponse });
          held = '';
        }
        onComplete(fullResponse);
        const usage = Object.assign({}, buildUsagePayload(getLimits(userId), userId));
        send({ done: true, usage, responseTokens: cost, warnings: reservation.warnings, sig: signReply(userId, charId, fullResponse) });
        close();
      } catch (e) { finished = false; fail(e); }
    },
    (err) => fail(err),
    undefined, effortCfg, modelList, ctx);
}

// A clear message when the AI provider is rate-limiting us (instead of a generic error)
function aiErrorMessage(err) {
  if (/empty reply/i.test((err && err.message) || '')) return 'The AI sent back an empty reply. Please try again.';
  return /no working model|429|rate limit|too many requests/i.test((err && err.message) || '')
    ? 'The AI is busy right now. Please try again in a few seconds.'
    : 'AI service error';
}

function getModelList(tier) {
  if (tier === 'opis' || tier === 'opos' || tier === 'opus' || tier === 'opys' || tier === 'opys2') return GROQ_OPUS_MODELS;
  if (tier === 'opes') return GROQ_PRO_MODELS;
  return GROQ_FAST_MODELS;
}

const workingModels = {};

// Groq says "Please try again in 1.5s" / "2m3.4s" / "450ms" when a model is out of tokens-per-minute
function parseRetryAfterMs(msg) {
  const m = /try again in\s+(?:(\d+)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?\s*(?:(\d+(?:\.\d+)?)ms)?/i.exec(msg || '');
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Math.round((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000 + Number(m[3] || 0));
}
const RATE_RETRY_MAX_MS = 15000;

function callGroqStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, modelIndex, effortCfg, modelList, ctx) {
  modelList = modelList || GROQ_FAST_MODELS;
  ctx = ctx || {};
  effortCfg = effortCfg || EFFORT_CONFIG.opas.high;
  if (modelIndex === undefined) {
    const tier = (modelList === GROQ_OPUS_MODELS) ? 'opus' : (modelList === GROQ_PRO_MODELS) ? 'opes' : 'opas';
    const wm = workingModels[tier];
    const wi = wm ? modelList.indexOf(wm) : -1;
    modelIndex = wi >= 0 ? wi : 0;
  }
  if (modelIndex >= modelList.length) {
    if (ctx.rateLimited) {
      // Every model was out of tokens for this minute. If the wait is short, wait once and go round again.
      if (!ctx.retried && !ctx.aborted && ctx.retryAfterMs != null && ctx.retryAfterMs <= RATE_RETRY_MAX_MS) {
        ctx.retried = true;
        const wait = Math.max(500, ctx.retryAfterMs + 300);
        ctx.rateLimited = false; ctx.retryAfterMs = null;
        console.log('All models rate limited, retrying in ' + wait + 'ms');
        return setTimeout(() => {
          if (ctx.aborted) return;
          callGroqStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, 0, effortCfg, modelList, ctx);
        }, wait);
      }
      return onError(new Error('Rate limit reached on every model (429 too many requests)'));
    }
    return onError(new Error('No working model found. Check your Groq API key.'));
  }

  const model = modelList[modelIndex];

  const groqMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ];

  const body = JSON.stringify({
    model,
    messages: groqMessages,
    max_tokens: effortCfg.maxOutputTokens,
    temperature: effortCfg.temperature,
    top_p: 0.95,
    stream: true,
    ...(model.startsWith('openai/') && effortCfg.reasoningEffort ? { reasoning_effort: effortCfg.reasoningEffort } : {})
  });

  const reqPath = '/openai/v1/chat/completions';
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'authorization': `Bearer ${apiKey}`
  };

  const req = https.request({ hostname: 'api.groq.com', path: reqPath, method: 'POST', headers }, (res) => {
    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', d => errBody += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(errBody);
          const msg = parsed.error?.message || '';
          console.log(`Model ${model} status ${res.statusCode}: ${msg}`);
          if (res.statusCode === 401 || res.statusCode === 403) {
            return onError(new Error(`Invalid Groq API key: ${msg}`));
          }
          if (res.statusCode === 429) {
            ctx.rateLimited = true;
            const ra = parseRetryAfterMs(msg);
            if (ra != null && (ctx.retryAfterMs == null || ra < ctx.retryAfterMs)) ctx.retryAfterMs = ra;
          }
          if (res.statusCode === 429 || res.statusCode === 503 || res.statusCode === 404) {
            return callGroqStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, modelIndex + 1, effortCfg, modelList, ctx);
          }
          if (res.statusCode === 400 && modelIndex + 1 < modelList.length) {
            return callGroqStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, modelIndex + 1, effortCfg, modelList, ctx);
          }
          onError(new Error(msg || `HTTP ${res.statusCode}`));
        } catch (_) { onError(new Error(`HTTP ${res.statusCode}`)); }
      });
      return;
    }

    const tier = modelList === GROQ_OPUS_MODELS ? 'opus' : modelList === GROQ_PRO_MODELS ? 'opes' : 'opas';
    if (!GROQ_FALLBACKS.includes(model)) workingModels[tier] = model;
    console.log(`Using model: ${model} (tier=${tier})`);

    let buffer = '';
    let finished = false;
    let usageTokens = 0;
    let responseTextLen = 0;
    let collected = '';
    // The model hit its length limit. Carry on from where it stopped (or retry with more room if it wrote nothing).
    const handleLength = () => {
      if (ctx.aborted) return onDone(usageTokens || Math.ceil(responseTextLen / 4));
      if (!collected.trim()) {
        if (!ctx.boosted) {
          ctx.boosted = true;
          const more = { ...effortCfg, maxOutputTokens: Math.min(Math.round(effortCfg.maxOutputTokens * 1.5), 3500), reasoningEffort: 'low' };
          return callGroqStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, modelIndex, more, modelList, ctx);
        }
        return onDone(0);
      }
      if ((ctx.continuations || 0) < 2) {
        ctx.continuations = (ctx.continuations || 0) + 1;
        const next = [...messages, { role: 'assistant', content: collected },
          { role: 'user', content: '[Continue your previous reply from exactly where it was cut off. Do not repeat anything already written and do not add any introduction or comment about continuing.]' }];
        return callGroqStream(apiKey, systemPrompt, next, onChunk, onDone, onError, modelIndex, effortCfg, modelList, ctx);
      }
      onDone(usageTokens || Math.ceil(responseTextLen / 4));
    };

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { if (!finished) { finished = true; onDone(usageTokens || Math.ceil(responseTextLen / 4)); } return; }
        try {
          const parsed = JSON.parse(raw);
          if (parsed.x_groq?.usage?.completion_tokens) {
            usageTokens = parsed.x_groq.usage.completion_tokens;
          } else if (parsed.usage?.completion_tokens) {
            usageTokens = parsed.usage.completion_tokens;
          }
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) { responseTextLen += text.length; collected += text; onChunk(text); }
          const reason = parsed.choices?.[0]?.finish_reason;
          if (reason === 'length' && !finished) { finished = true; handleLength(); }
          else if (reason === 'stop' && !finished) { finished = true; onDone(usageTokens || Math.ceil(responseTextLen / 4)); }
        } catch (_) {}
      }
    });

    res.on('end', () => {
      if (buffer.trim()) {
        const raw = buffer.startsWith('data: ') ? buffer.slice(6).trim() : '';
        if (raw && raw !== '[DONE]') {
          try {
            const parsed = JSON.parse(raw);
            const text = parsed.choices?.[0]?.delta?.content;
            if (text && !finished) onChunk(text);
          } catch (_) {}
        }
      }
      if (!finished) { finished = true; onDone(usageTokens || Math.ceil(responseTextLen / 4)); }
    });
  });

  req.on('error', onError);
  if (ctx) {
    ctx.req = req;
    if (ctx.aborted) { req.destroy(new Error('client aborted')); return; }
  }
  req.setTimeout(60000, () => req.destroy(new Error('upstream timeout')));
  req.write(body);
  req.end();
}

// ── API Routes ─────────────────────────────────────────────────────────────────

async function reverseGeocode(lat, lon) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'nominatim.openstreetmap.org',
        path: `/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`,
        method: 'GET',
        headers: {
          'User-Agent': 'character.mind/1.0 (support.charactermind@gmail.com)',
          'Accept': 'application/json'
        }
      },
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const addr = parsed.address || {};
            const countryCode = (addr.country_code || '').toUpperCase();
            const iso = addr['ISO3166-2-lvl4'] || '';
            const region = iso ? iso.split('-').pop() : (addr.state_code || '').toUpperCase();
            const city = addr.city || addr.town || addr.village || addr.suburb || '';
            if (countryCode) {
              resolve({ country: countryCode, region, regionName: addr.state || region, city, countryName: addr.country || '' });
            } else resolve(null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

app.get('/api/crisis-resources', requireAuth, async (req, res) => {
  let geo;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
    geo = await reverseGeocode(lat, lon);
  }
  if (!geo) geo = await getGeoForIp(req.ip);
  const info = getCrisisInfo(geo);
  const locationStr = geo ? [geo.city, geo.regionName, geo.countryName].filter(Boolean).join(', ') : null;
  if (!info) return res.json({ location: locationStr, resources: null });
  const allLines = [
    { crisis: info.crisis, crisisName: info.crisisName },
    ...(info.extra || []),
    { crisis: info.emergency, crisisName: 'Emergency services — call for immediate danger' }
  ];
  const country = geo && geo.country;
  res.json({ location: locationStr, resources: allLines.map(r => ({ ...r, url: crisisUrlFor(r.crisisName, country) })) });
});

app.get('/api/usage', requireAuth, (req, res) => {
  res.json(buildUsagePayload(getLimits(req.user.googleId), req.user.googleId));
});

app.post('/api/call/start', requireAuth, (req, res) => {
  const userId = req.user.googleId;
  const u = getLimits(userId);
  const resetsAt = getCallWindowStart() + 24 * 60 * 60 * 1000;
  const callLimit = getCallLimitForUser(userId);
  if (callLimit !== Infinity && u.callsToday >= callLimit) {
    return res.status(429).json({ allowed: false, callsToday: u.callsToday, callsLimit: callLimit, callsRemaining: 0, resetsAt });
  }
  u.callsToday = (u.callsToday || 0) + 1;
  saveLimitsToDB(userId);
  const remaining = callLimit === Infinity ? 9999 : callLimit - u.callsToday;
  res.json({ allowed: true, callsToday: u.callsToday, callsLimit: callLimit === Infinity ? 9999 : callLimit, callsRemaining: remaining, resetsAt });
});

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
let ELEVEN_VOICE_MAP = {
  custom_1790776698867: 'EXAVITQu4vr4xnSDxMaL',      // Poppy — Sarah: soft, gentle, doll-like
  custom_1790897425575_lily: 'cgSgspJ2msm6clMCkdW9'  // Lily — Jessica: bright, playful, expressive
};
try { Object.assign(ELEVEN_VOICE_MAP, JSON.parse(process.env.ELEVENLABS_VOICES || '{}')); } catch (_) {}
const TTS_DAILY_CHARS = 2000;
const ttsUsage = new Map();

app.get('/api/tts/status', requireAuth, (req, res) => res.json({ enabled: !!ELEVEN_KEY }));

app.post('/api/tts', requireAuth, async (req, res) => {
  if (!ELEVEN_KEY) return res.status(501).json({ error: 'tts_disabled' });
  const text = String(req.body?.text || '').replace(/[*_`#]/g, '').trim().slice(0, 400);
  const charId = String(req.body?.charId || '');
  if (!text) return res.status(400).json({ error: 'no_text' });

  const userId = req.user.googleId;
  const day = new Date().toISOString().slice(0, 10);
  let use = ttsUsage.get(userId);
  if (!use || use.day !== day) use = { day, chars: 0 };
  if (use.chars + text.length > TTS_DAILY_CHARS) return res.status(429).json({ error: 'tts_limit' });
  use.chars += text.length;
  ttsUsage.set(userId, use);
  const refund = () => { use.chars = Math.max(0, use.chars - text.length); };

  const voiceId = (Object.hasOwn(ELEVEN_VOICE_MAP, charId) && ELEVEN_VOICE_MAP[charId]) || ELEVEN_DEFAULT_VOICE;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' })
    });
    if (!r.ok || !r.body) {
      console.warn('[tts] ElevenLabs error', r.status);
      refund();
      return res.status(502).json({ error: 'tts_failed' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.warn('[tts] request failed', e.message);
    refund();
    res.status(502).json({ error: 'tts_failed' });
  }
});

app.post('/api/memo/use', requireAuth, (req, res) => {
  const userId = req.user.googleId;
  const u = getLimits(userId);
  const resetsAt = getCallWindowStart() + 24 * 60 * 60 * 1000;
  const memoLimit = getMemoLimitForUser(userId);
  if (memoLimit !== Infinity && u.memosToday >= memoLimit) {
    return res.status(429).json({ allowed: false, memosToday: u.memosToday, memosLimit: memoLimit, memosRemaining: 0, resetsAt });
  }
  u.memosToday = (u.memosToday || 0) + 1;
  saveLimitsToDB(userId);
  const remaining = memoLimit === Infinity ? 9999 : memoLimit - u.memosToday;
  res.json({ allowed: true, memosToday: u.memosToday, memosLimit: memoLimit === Infinity ? 9999 : memoLimit, memosRemaining: remaining, resetsAt });
});

app.get('/api/chat/lock-status/:charId', requireAuth, async (req, res) => {
  const { charId } = req.params;
  if (!VALID_ID.test(charId)) return res.json({ locked: false });
  const mod = await getModStatus(req.user.googleId, charId);
  res.json({ locked: mod.locked, strikes: mod.strikes });
});

const MAX_ARCHIVES_PER_CHAR = 200;
// Save a conversation to the archive, deleting the oldest ones first when the limit is reached
// (instead of silently dropping the new chat). Returns true when it was saved.
async function archiveConversation(uid, charId, msgs) {
  if (!db) return false;
  try {
    const count = parseInt((await db.query('SELECT COUNT(*) FROM chat_archives WHERE user_id=$1 AND char_id=$2', [uid, charId])).rows[0]?.count || 0);
    if (count >= MAX_ARCHIVES_PER_CHAR) {
      await db.query(
        'DELETE FROM chat_archives WHERE id IN (SELECT id FROM chat_archives WHERE user_id=$1 AND char_id=$2 ORDER BY archived_at ASC LIMIT $3)',
        [uid, charId, count - MAX_ARCHIVES_PER_CHAR + 1]
      );
    }
    await db.query('INSERT INTO chat_archives(user_id, char_id, messages) VALUES($1,$2,$3)', [uid, charId, JSON.stringify(msgs)]);
    return true;
  } catch (e) {
    console.error('archiveConversation error:', e.message);
    return false;
  }
}

app.post('/api/chat/reset-mod/:charId', requireAuth, async (req, res) => {
  const { charId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!(await characterExists(charId))) return res.status(404).json({ error: 'Character not found' });
  const uid = req.user.googleId;
  const key = `${uid}:${charId}`;
  // Archive current conversation before resetting if it has messages
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  const msgs = conversations[key] || [];
  if (msgs.length > 0 && db) await archiveConversation(uid, charId, msgs);
  await setModStatus(uid, charId, 0, false);
  conversations[key] = [];
  persistConv(key);
  res.json({ ok: true });
});

// Archive current convo and start fresh (without mod reset)
app.post('/api/conversations/:charId/archive', requireAuth, async (req, res) => {
  const { charId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  const uid = req.user.googleId;
  const key = `${uid}:${charId}`;
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  const msgs = conversations[key] || [];
  if (msgs.length === 0) return res.json({ ok: true, archived: false });
  if (db) {
    // Keep at most 200 archives per user-character pair; if saving fails, keep the live chat instead of wiping it
    const saved = await archiveConversation(uid, charId, msgs);
    if (!saved) return res.status(500).json({ error: 'Could not save your chat. Please try again.' });
  }
  conversations[key] = [];
  persistConv(key);
  res.json({ ok: true, archived: true });
});

// List archived conversations for a character
app.get('/api/conversations/:charId/history', requireAuth, async (req, res) => {
  const { charId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!db) return res.json([]);
  const uid = req.user.googleId;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const result = await db.query(
    'SELECT id, archived_at, jsonb_array_length(messages) AS message_count, messages->0 AS first_msg FROM chat_archives WHERE user_id=$1 AND char_id=$2 ORDER BY archived_at DESC LIMIT $3',
    [uid, charId, limit]
  ).catch(() => ({ rows: [] }));
  res.json(result.rows);
});

// Fetch a single archived conversation
app.get('/api/conversations/:charId/history/:archiveId', requireAuth, async (req, res) => {
  const { charId, archiveId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!/^\d+$/.test(archiveId)) return res.status(400).json({ error: 'Invalid archiveId' });
  if (!db) return res.status(404).json({ error: 'Not found' });
  const uid = req.user.googleId;
  const result = await db.query(
    'SELECT id, archived_at, messages FROM chat_archives WHERE id=$1 AND user_id=$2 AND char_id=$3',
    [parseInt(archiveId), uid, charId]
  ).catch(() => ({ rows: [] }));
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ ...result.rows[0], messages: withSigs(uid, charId, result.rows[0].messages) });
});

// Delete one archived conversation
app.delete('/api/conversations/:charId/history/:archiveId', requireAuth, async (req, res) => {
  const { charId, archiveId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!/^\d+$/.test(archiveId)) return res.status(400).json({ error: 'Invalid archiveId' });
  if (!db) return res.status(503).json({ error: 'Service temporarily unavailable' });
  try {
    await db.query('DELETE FROM chat_archives WHERE id=$1 AND user_id=$2 AND char_id=$3', [parseInt(archiveId), req.user.googleId, charId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('delete archive error:', e);
    res.status(500).json({ error: 'Could not delete' });
  }
});

// Delete all archived conversations with one character
app.delete('/api/conversations/:charId/history', requireAuth, async (req, res) => {
  const { charId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!db) return res.status(503).json({ error: 'Service temporarily unavailable' });
  try {
    const r = await db.query('DELETE FROM chat_archives WHERE user_id=$1 AND char_id=$2', [req.user.googleId, charId]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('delete all archives error:', e);
    res.status(500).json({ error: 'Could not delete' });
  }
});

const OWNER_EMAILS = new Set(['support.charactermind@gmail.com']); // the only account with admin tools or a free plan
// Only the Character.Mind business account gets the top plan without paying. Every other account (including the
// other admin login) gets exactly what its own subscription pays for.
const FREE_TOP_PLAN_EMAILS = new Set(['support.charactermind@gmail.com']);
function planFor(email, dbTier) { return FREE_TOP_PLAN_EMAILS.has(email) ? 'x50' : (dbTier || 'free'); }
const ownerGoogleIds = new Set(); // populated at runtime when owners authenticate
app.post('/api/admin/reset-limits', requireAuth, (req, res) => {
  if (!OWNER_EMAILS.has(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  const { secret, targetId } = req.body;
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || secret !== adminSecret) return res.status(403).json({ error: 'Forbidden' });
  const key = targetId || req.user?.googleId;
  if (key) {
    delete userLimits[key];
    if (db) db.query('DELETE FROM user_limits WHERE user_id = $1', [key]).catch(() => {});
  }
  res.json({ ok: true, reset: key || 'none' });
});

// Owner-only reset — no secret needed, just must be the owner's Google account
app.post('/api/admin/reset-mine', requireAuth, (req, res) => {
  if (!OWNER_EMAILS.has(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  const uid = req.user.googleId;
  delete userLimits[uid];
  if (db) db.query('DELETE FROM user_limits WHERE user_id = $1', [uid]).catch(() => {});
  res.json({ ok: true });
});

// Owner-only: view the app as another plan (free/advanced/x20/x50) to test limits and usage bars.
// Lasts until the server restarts; your real owner access returns automatically.
app.post('/api/admin/set-my-tier', requireAuth, (req, res) => {
  if (!OWNER_EMAILS.has(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  const tier = req.body && req.body.tier;
  if (typeof tier !== 'string' || !Object.hasOwn(TIER_TOKEN_LIMITS, tier)) return res.status(400).json({ error: 'Invalid tier' });
  const u = getLimits(req.user.googleId);
  u.subscriptionTier = tier;
  u.tierLoaded = true;
  res.json({ ok: true, tier });
});

// Owner-only session-only reset (keeps weekly intact)
app.post('/api/admin/reset-session', requireAuth, (req, res) => {
  if (!OWNER_EMAILS.has(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  const u = getLimits(req.user.googleId);
  u.sessionTokens = 0; u.sessionStartedAt = null; u.cooldownUntil = null; u.warned.session90 = false;
  saveLimitsToDB(req.user.googleId);
  res.json({ ok: true });
});

// One-time: stamp all characters created by the calling owner as CharacterMind
app.post('/api/admin/stamp-official', requireAuth, async (req, res) => {
  if (!OWNER_EMAILS.has(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  if (!db) return res.status(503).json({ error: 'No database' });
  const uid = req.user.googleId;
  ownerGoogleIds.add(uid); // ensure runtime set is updated too
  const result = await db.query(
    `UPDATE characters SET creator_name = 'Character Mind Playtime Co' WHERE device_id = $1`,
    [uid]
  );
  res.json({ ok: true, updated: result.rowCount });
});

// Owner-only: wipe all personal data for the calling account (history, recents, limits)
app.post('/api/admin/wipe-my-data', requireAuth, async (req, res) => {
  if (!OWNER_EMAILS.has(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  const uid = req.user.googleId;
  delete userLimits[uid];
  // Clear all conversations for this user's sessions
  for (const key of Object.keys(conversations)) {
    if (key.startsWith(uid + ':')) { delete conversations[key]; convLoaded.delete(key); }
  }
  if (db) {
    await Promise.all([
      db.query('DELETE FROM chat_current WHERE user_id = $1', [uid]),
      db.query('DELETE FROM user_limits WHERE user_id = $1', [uid]),
      db.query('UPDATE users SET recent_chats = $1, hidden_recents = $2 WHERE google_id = $3', ['{}', '{}', uid])
    ]).catch(() => {});
  }
  res.json({ ok: true });
});

app.get('/api/templates', (req, res) => {
  res.json(TEMPLATES.map(t => ({ name: t.name, aliases: t.aliases })));
});

app.get('/api/characters', async (req, res) => {
  if (!db) return res.json([]);
  const userId = req.user?.googleId || '';
  try {
    const { rows } = await db.query(
      'SELECT id, name, tagline, description, system_prompt, greeting, greeting_mode, color, creator_name, device_id, (image IS NOT NULL AND length(image) > 0) AS has_image, COALESCE(length(image), 0) AS image_len, tags, interactions, created_at FROM characters ORDER BY created_at DESC'
    );
    const authed = !!req.user;
    const isOwnerUser = !!(userId && ownerGoogleIds.has(userId));
    res.json(rows.map(r => {
      const official = !!(r.device_id && ownerGoogleIds.has(r.device_id));
      const mine = !!(userId && r.device_id === userId);
      return {
        id: r.id, name: r.name, tagline: r.tagline, description: r.description,
        // The personality prompt is private: only its creator (or the site owner) receives it
        ...(authed ? { greeting: r.greeting, greetingMode: r.greeting_mode } : {}),
        ...((mine || isOwnerUser) ? { systemPrompt: r.system_prompt } : {}),
        color: r.color, accentColor: r.color,
        creator: official ? 'Character Mind Playtime Co' : (/character\s*\.?\s*mind/i.test(r.creator_name || '') ? 'Community creator' : r.creator_name),
        isOfficial: official,
        image: r.has_image ? '/api/characters/' + encodeURIComponent(r.id) + '/image?v=' + r.image_len : null,
        tags: r.tags || [], interactions: r.interactions,
        isMine: mine
      };
    }));
  } catch (err) { console.error('list characters error:', err.message); res.status(500).json({ error: 'Could not load characters' }); }
});

// Character picture as a real image (cacheable), instead of a huge base64 string inside the character list
app.get('/api/characters/:id/image', async (req, res) => {
  if (!VALID_ID.test(req.params.id)) return res.status(400).end();
  if (!db) return res.status(404).end();
  try {
    const { rows } = await db.query('SELECT image FROM characters WHERE id = $1', [req.params.id]);
    const img = rows[0] && safeImage(rows[0].image);
    if (!img) return res.status(404).end();
    const m = img.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/);
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (err) {
    console.error('character image error:', err.message);
    res.status(500).end();
  }
});

app.get('/api/characters/:id', async (req, res) => {
  if (!db) return res.status(404).json({ error: 'No database' });
  try {
    const { rows } = await db.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Character not found' });
    const r = rows[0];
    const authed = !!req.user;
    const uid = req.user?.googleId || '';
    res.json({
      id: r.id, name: r.name, tagline: r.tagline, color: r.color,
      ...(authed ? { greeting: r.greeting, greetingMode: r.greeting_mode } : {}),
      ...((uid && (r.device_id === uid || ownerGoogleIds.has(uid))) ? { systemPrompt: r.system_prompt } : {})
    });
  } catch (err) { console.error('get character error:', err.message); res.status(500).json({ error: 'Could not load character' }); }
});

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function isValidColorStr(color) {
  if (!color || typeof color !== 'string') return false;
  const c = color.trim();
  if (/^#[0-9a-fA-F]{6}$/i.test(c)) return true;
  // Strict gradient: angle (optional), then 2–4 hex stops with optional % positions, nothing else
  if (/^linear-gradient\(\s*(?:\d+deg\s*,\s*)?(?:#[0-9a-fA-F]{6}(?:\s+\d+(?:\.\d+)?%)?\s*,\s*){1,3}#[0-9a-fA-F]{6}(?:\s+\d+(?:\.\d+)?)?\s*\)$/i.test(c)) return true;
  return false;
}

const KEEP_IMAGE_RE = /^\/api\/characters\/[A-Za-z0-9_-]{1,64}\/image(\?v=\d+)?$/;
const SAFE_IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+\/]+={0,2}$/;
function safeImage(img) { return (typeof img === 'string' && img.length <= 512000 && SAFE_IMAGE_RE.test(img)) ? img : null; }

function validateChar(body) {
  const { id, name, tagline, description, systemPrompt, greeting, greetingMode, color, creatorName, image, tags } = body;
  if (!id || !VALID_ID.test(id)) return 'Invalid character id (alphanumeric, _ -, max 64)';
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 60) return 'Name required and must be ≤60 characters';
  if (tagline && tagline.length > 160) return 'Tagline must be ≤160 characters';
  if (description && description.length > 2000) return 'Description must be ≤2000 characters';
  if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > 8000) return 'Personality required and must be ≤8000 characters';
  if (greeting && greeting.length > 4096) return 'First message must be ≤4096 characters';
  if (greetingMode && !['fixed', 'auto'].includes(greetingMode)) return 'Invalid greetingMode';
  if (color && !isValidColorStr(color)) { console.warn('[validateChar] rejected color:', JSON.stringify(color)); return 'Invalid color format'; }
  if (creatorName && creatorName.length > 40) return 'Creator name must be ≤40 characters';
  if (image && typeof image === 'string' && !KEEP_IMAGE_RE.test(image)) {
    if (image.length > 512000) return 'Image too large (max ~384KB)';
    if (!SAFE_IMAGE_RE.test(image)) return 'Image must be a valid base64-encoded JPEG, PNG, WebP, or GIF';
  }
  if (tags) {
    if (!Array.isArray(tags) || tags.length > 10) return 'Tags must be an array of ≤10 items';
    if (tags.some(t => typeof t !== 'string' || t.length > 50)) return 'Each tag must be a string ≤50 characters';
  }
  return null;
}

app.post('/api/characters', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database configured' });

  // Apply known-character template BEFORE validation so a blank persona gets filled in
  const rawBody = req.body;
  const tpl = matchCharacterTemplate(rawBody.name);
  const useTemplate = !!tpl; // always apply on creation if name matches
  const body = useTemplate ? {
    ...rawBody,
    systemPrompt: tpl.systemPrompt,
    tagline:      (rawBody.tagline||'').trim()     || tpl.tagline,
    description:  (rawBody.description||'').trim() || (tpl.description||''),
    greeting:     (rawBody.greeting||'').trim()    || tpl.greeting,
    greetingMode: tpl.greetingMode,
    color:        (!rawBody.color || rawBody.color === '#7c3aed') ? (tpl.color||'#7c3aed') : rawBody.color,
    tags:         (rawBody.tags||[]).length ? rawBody.tags : (tpl.tags||[])
  } : rawBody;

  const validErr = validateChar(body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { id, name, tagline, description, systemPrompt, greeting, greetingMode, color, image, tags } = body;
  const userId = req.user.googleId;
  const creatorName = OWNER_EMAILS.has(req.user.email) ? 'Character Mind Playtime Co' : (body.creatorName || 'Anonymous');

  try {
    // Enforce per-user character creation cap (free tier)
    const existingCheck = await db.query('SELECT device_id FROM characters WHERE id = $1', [id]);
    const isNewChar = existingCheck.rows.length === 0;
    if (isNewChar) {
      const countRes = await db.query('SELECT COUNT(*) FROM characters WHERE device_id = $1', [userId]);
      if (parseInt(countRes.rows[0].count) >= 100) {
        return res.status(429).json({ error: 'Character limit reached (max 100 per account)' });
      }
    }

    // If record already exists, verify ownership before allowing update
    const existing = existingCheck;
    if (existing.rows.length > 0 && existing.rows[0].device_id !== userId) {
      return res.status(403).json({ error: 'Not your character' });
    }

    const { rows } = await db.query(
      `INSERT INTO characters (id, name, tagline, description, system_prompt, greeting, greeting_mode, color, creator_name, device_id, image, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, tagline=EXCLUDED.tagline, description=EXCLUDED.description,
         system_prompt=EXCLUDED.system_prompt, greeting=EXCLUDED.greeting, greeting_mode=EXCLUDED.greeting_mode,
         color=EXCLUDED.color, creator_name=EXCLUDED.creator_name, image=CASE WHEN $13::boolean THEN characters.image ELSE EXCLUDED.image END, tags=EXCLUDED.tags
       RETURNING id, name, tagline, color`,
      [id, name.trim(), (tagline||'').trim(), (description||'').trim(), systemPrompt.trim(),
       greeting||null, greetingMode||'fixed', color||'#7c3aed', (creatorName||'Anonymous').trim(),
       userId, (KEEP_IMAGE_RE.test(image || '') ? null : (image || null)), JSON.stringify((tags||[]).slice(0,10)), KEEP_IMAGE_RE.test(image || '')]
    );
    res.json({ ...rows[0], isMine: true });
  } catch (err) {
    console.error('POST /api/characters:', err.message);
    res.status(500).json({ error: 'Could not save character' });
  }
});

app.put('/api/characters/:id', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });

  // Apply known-character template BEFORE validation so a blank persona gets filled in
  const rawBody2 = req.body;
  const tpl2 = matchCharacterTemplate(rawBody2.name);
  const useTemplate2 = tpl2 && (rawBody2.systemPrompt || '').trim().length < 150;
  const body2 = useTemplate2 ? {
    ...rawBody2,
    systemPrompt: tpl2.systemPrompt,
    tagline:      (rawBody2.tagline||'').trim()     || tpl2.tagline,
    description:  (rawBody2.description||'').trim() || (tpl2.description||''),
    greeting:     (rawBody2.greeting||'').trim()    || tpl2.greeting,
    greetingMode: tpl2.greetingMode,
    color:        (!rawBody2.color || rawBody2.color === '#7c3aed') ? (tpl2.color||'#7c3aed') : rawBody2.color,
    tags:         (rawBody2.tags||[]).length ? rawBody2.tags : (tpl2.tags||[])
  } : rawBody2;

  const validErr = validateChar({ id: req.params.id, ...body2 });
  if (validErr) return res.status(400).json({ error: validErr });

  const { name, tagline, description, systemPrompt, greeting, greetingMode, color, image, tags } = body2;
  const userId = req.user.googleId;

  try {
    const check = await db.query('SELECT device_id FROM characters WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].device_id !== userId) return res.status(403).json({ error: 'Not your character' });
    await db.query(
      `UPDATE characters SET name=$1, tagline=$2, description=$3, system_prompt=$4, greeting=$5, greeting_mode=$6, color=$7, image=CASE WHEN $11::boolean THEN image ELSE $8 END, tags=$9 WHERE id=$10`,
      [name.trim(), (tagline||'').trim(), (description||'').trim(), systemPrompt.trim(),
       greeting||null, greetingMode||'fixed', color||'#7c3aed', (KEEP_IMAGE_RE.test(image || '') ? null : (image || null)),
       JSON.stringify((tags||[]).slice(0,10)), req.params.id, KEEP_IMAGE_RE.test(image || '')]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/characters:', err.message);
    res.status(500).json({ error: 'Could not update character' });
  }
});

// One-time admin: fetch all character images from the Poppy Playtime wiki and store as base64
app.post('/api/admin/populate-images', requireAuth, async (req, res) => {
  if (!OWNER_EMAILS.has(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  if (!db) return res.status(503).json({ error: 'No database' });
  const userId = req.user.googleId;

  const IMAGE_MAP = [
    { id: 'custom_1790776698867',         url: 'https://poppyplaytime.wiki.gg/images/thumb/PoppyPlaytimeHD.png/300px-PoppyPlaytimeHD.png' },
    { id: 'custom_1790774765927',         url: 'https://poppyplaytime.wiki.gg/images/thumb/Doey_The_Doughman_Render_3.png/300px-Doey_The_Doughman_Render_3.png' },
    { id: 'custom_1790766558393',         url: 'https://poppyplaytime.wiki.gg/images/thumb/The_Doctor_Searching.png/300px-The_Doctor_Searching.png' },
    { id: 'custom_1790894243871_huggy',   url: 'https://poppyplaytime.wiki.gg/images/thumb/HuggyRenderRemake.webp/300px-HuggyRenderRemake.webp' },
    { id: 'custom_1790894243872_mll',     url: 'https://poppyplaytime.wiki.gg/images/thumb/Mommy_Long_Legs.png/300px-Mommy_Long_Legs.png' },
    { id: 'custom_1790894243873_catnap',  url: 'https://poppyplaytime.wiki.gg/images/thumb/CatNap_Render.png/300px-CatNap_Render.png' },
    { id: 'custom_1790894243874_dogday',  url: 'https://poppyplaytime.wiki.gg/images/thumb/Dogday_now_with_spot.png/300px-Dogday_now_with_spot.png' },
    { id: 'custom_1790894243875_prototype', url: 'https://poppyplaytime.wiki.gg/images/thumb/The_Prototype_Render.png/300px-The_Prototype_Render.png' },
    { id: 'custom_1790894243876_kissy',   url: 'https://poppyplaytime.wiki.gg/images/thumb/KissyMissyBlueHD.png/300px-KissyMissyBlueHD.png' },
    { id: 'custom_1790895433252_bunzo',   url: 'https://poppyplaytime.wiki.gg/images/thumb/Bunzo_Bunny.png/300px-Bunzo_Bunny.png' },
    { id: 'custom_1790895433253_pj',      url: 'https://poppyplaytime.wiki.gg/images/thumb/PJ_Pug-a-Pillar.png/300px-PJ_Pug-a-Pillar.png' },
    { id: 'custom_1790895433254_boxy',    url: 'https://poppyplaytime.wiki.gg/images/thumb/Boxy_Boo_HDwikisize.png/300px-Boxy_Boo_HDwikisize.png' },
    { id: 'custom_1790895433255_delight', url: 'https://poppyplaytime.wiki.gg/images/thumb/Missd2.png/300px-Missd2.png' },
    { id: 'custom_1790895433256_bubba',   url: 'https://poppyplaytime.wiki.gg/images/thumb/SmilingCritters-BlueElephant.png/300px-SmilingCritters-BlueElephant.png' },
    { id: 'custom_1790895671421_yarnaby', url: 'https://poppyplaytime.wiki.gg/images/thumb/Yarnaby.webp/300px-Yarnaby.webp' },
    { id: 'custom_1790895671422_craftycorn', url: 'https://poppyplaytime.wiki.gg/images/thumb/SmilingCritters-WhiteUnicorn.png/299px-SmilingCritters-WhiteUnicorn.png' },
    { id: 'custom_1790895671423_pickypiggy', url: 'https://poppyplaytime.wiki.gg/images/thumb/SmilingCritters-PinkPig.png/300px-SmilingCritters-PinkPig.png' },
    { id: 'custom_1790895671424_kickin',  url: 'https://poppyplaytime.wiki.gg/images/thumb/SmilingCritters-YellowBird.png/300px-SmilingCritters-YellowBird.png' },
    { id: 'custom_1790895671425_bobby',   url: 'https://poppyplaytime.wiki.gg/images/thumb/SmilingCritters-RedBear.png/300px-SmilingCritters-RedBear.png' },
    { id: 'custom_1790895671426_hoppy',   url: 'https://poppyplaytime.wiki.gg/images/thumb/SmilingCritters-GreenBunny.png/300px-SmilingCritters-GreenBunny.png' },
    { id: 'custom_1790895746935_elliot',  url: 'https://poppyplaytime.wiki.gg/images/thumb/Elliot_Ludwig.png/299px-Elliot_Ludwig.png' },
    { id: 'custom_1790895746936_stella',  url: 'https://poppyplaytime.wiki.gg/images/thumb/Stella_greybur_enhanced_reference.jpg/300px-Stella_greybur_enhanced_reference.jpg' },
    { id: 'custom_1790895746937_leith',   url: 'https://poppyplaytime.wiki.gg/images/thumb/Leith_Pierre_Slide.png/300px-Leith_Pierre_Slide.png' },
    { id: 'custom_1790895746938_gracie',  url: 'https://poppyplaytime.wiki.gg/images/thumb/LilyLovebraidsFriendlyCH5.webp/300px-LilyLovebraidsFriendlyCH5.webp' },
  ];

  const results = [];
  for (const entry of IMAGE_MAP) {
    try {
      const check = await db.query('SELECT device_id FROM characters WHERE id = $1', [entry.id]);
      if (!check.rows.length) { results.push({ id: entry.id, error: 'not found' }); continue; }
      if (check.rows[0].device_id !== userId) { results.push({ id: entry.id, error: 'not yours' }); continue; }

      const r = await fetch(entry.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CharacterMind/1.0)' } });
      if (!r.ok) { results.push({ id: entry.id, error: `HTTP ${r.status} from wiki` }); continue; }
      const ct = (r.headers.get('content-type') || 'image/png').split(';')[0].trim();
      if (!['image/jpeg','image/jpg','image/png','image/webp','image/gif'].includes(ct)) {
        results.push({ id: entry.id, error: `unexpected content-type: ${ct}` }); continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const dataUri = `data:${ct};base64,${buf.toString('base64')}`;
      if (dataUri.length > 512000) { results.push({ id: entry.id, error: `too large: ${dataUri.length}` }); continue; }

      await db.query('UPDATE characters SET image = $1 WHERE id = $2', [dataUri, entry.id]);
      results.push({ id: entry.id, ok: true, bytes: buf.length });
    } catch (e) {
      results.push({ id: entry.id, error: e.message });
    }
  }
  res.json({ done: results.filter(r => r.ok).length, total: IMAGE_MAP.length, results });
});

app.delete('/api/characters/:id', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const userId = req.user.googleId;
  try {
    const check = await db.query('SELECT device_id FROM characters WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].device_id !== userId) return res.status(403).json({ error: 'Not your character' });
    await db.query('DELETE FROM characters WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/characters:', err.message);
    res.status(500).json({ error: 'Could not delete character' });
  }
});

app.get('/api/conversations/:charId', requireAuth, async (req, res) => {
  if (!VALID_ID.test(req.params.charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!(await characterExists(req.params.charId))) return res.json([]);
  const key = `${req.user.googleId}:${req.params.charId}`;
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  res.json(withSigs(req.user.googleId, req.params.charId, conversations[key] || []));
});

app.delete('/api/conversations/:charId', requireAuth, async (req, res) => {
  if (!VALID_ID.test(req.params.charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!(await characterExists(req.params.charId))) return res.json({ ok: true });
  const key = `${req.user.googleId}:${req.params.charId}`;
  convLastUsed[key] = Date.now();
  conversations[key] = [];
  persistConv(key);
  res.json({ ok: true });
});

app.post('/api/conversations/:charId/sync', requireAuth, async (req, res) => {
  if (!VALID_ID.test(req.params.charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (!(await characterExists(req.params.charId))) return res.status(404).json({ error: 'Character not found' });
  const { history } = req.body;
  if (!Array.isArray(history)) return res.status(400).json({ error: 'Invalid history' });
  if (history.length > CONV_MAX_MESSAGES) return res.status(400).json({ error: 'Too many messages' });
  const key = `${req.user.googleId}:${req.params.charId}`;
  if (!conversations[key] && userConversationCount(req.user.googleId) >= MAX_CONVERSATIONS_PER_USER) {
    return res.status(429).json({ error: 'Too many active conversations' });
  }
  convLastUsed[key] = Date.now();
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  const uid = req.user.googleId, cid = req.params.charId;
  // Assistant lines are accepted only if they are signed by this server, already in this chat, or the character's greeting
  const knownAssistant = new Set((conversations[key] || []).filter(m => m.role === 'assistant' && m.content).map(m => m.content));
  let greetingText = '';
  try { const dc = await getCharPrompt(cid); greetingText = (dc && dc.greeting) || ''; }
  catch (_) { return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' }); }
  const accepted = [];
  for (const m of history) {
    if (m && m.card === 'nsfw') {
      accepted.push({ role: 'assistant', content: '', card: 'nsfw', variant: (Number.isInteger(m.variant) && m.variant >= 0 && m.variant < NSFW_CARD_VARIANTS) ? m.variant : 0 });
      continue;
    }
    const role = (m && m.role === 'user') ? 'user' : 'assistant';
    let content = String((m && m.content) || '').slice(0, 10000);
    if (!content) continue;
    if (role === 'user') content = redactIfUnsafe(content);
    else {
      const verified = (typeof m.sig === 'string' && m.sig === signReply(uid, cid, content)) || knownAssistant.has(content) || (greetingText && content === greetingText);
      if (!verified) continue;
    }
    accepted.push({ role, content });
  }
  conversations[key] = accepted.slice(-CONV_MAX_MESSAGES);
  persistConv(key);
  res.json({ ok: true });
});

app.post('/api/regenerate/:charId', requireAuth, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });
  const { charId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  const { modelTier: reqModelTier, effort } = req.body;
  const modelTier = resolveModelTier(req.user.googleId, reqModelTier);
  const userId = req.user.googleId;

  const limit = checkLimits(userId);
  if (limit.blocked) return res.status(429).json({ error: limit.type === 'session' ? 'Session limit reached' : 'Weekly limit reached', ...limit });

  const u = getLimits(userId);
  if ((u.subscriptionTier || 'free') === 'free' && (u.regenCount || 0) >= LIMITS.REGEN_FREE) {
    return res.status(429).json({ regenLimitReached: true, regenLimit: LIMITS.REGEN_FREE });
  }
  const releaseSlot = acquireChatSlot(req, res, userId);
  if (!releaseSlot) return;

  let dbChar;
  try { dbChar = await getCharPrompt(charId); }
  catch (_) { return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' }); }
  if (!dbChar) return res.status(404).json({ error: 'Character not found' });
  const systemPrompt = dbChar ? dbChar.system_prompt : `You are ${charId}, a unique AI character.`;

  const key = `${req.user.googleId}:${charId}`;
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  if (!conversations[key]) conversations[key] = [];
  convLastUsed[key] = Date.now();

  // Permanently locked chats can't be regenerated either
  if (!db) return res.status(503).json({ error: 'Service temporarily unavailable' });
  const regenMod = await getModStatus(userId, charId);
  if (regenMod.locked) return res.status(403).json({ error: 'This chat has been ended.' });

  const hist = conversations[key];
  let poppedAssistant = null;
  if (hist.length > 0 && hist[hist.length - 1].role === 'assistant' && !hist[hist.length - 1].card) poppedAssistant = hist.pop();
  const restoreAssistant = () => { if (poppedAssistant) { hist.push(poppedAssistant); poppedAssistant = null; } };
  if (hist.length === 0 || hist[hist.length - 1].role !== 'user') {
    restoreAssistant();
    return res.status(400).json({ error: 'Nothing to regenerate' });
  }

  // If the last user message was NSFW or a slur (history can be synced from the client), refuse the regen too
  const lastUserMsg = normalizeMsg(hist[hist.length - 1]?.content || '');
  if (NSFW_RE.test(lastUserMsg)) {
    restoreAssistant();
    return nsfwDeflect(res, addTokens(userId, NSFW_BLOCK_TOKENS));
  }
  if (hasSlur(lastUserMsg)) {
    restoreAssistant();
    return slurDeflect(res, SLUR_WARNING_2, buildUsagePayload(getLimits(userId), userId));
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const regenModelList = getModelList(modelTier);
  const regenEffortCfg = getEffortCfg(effort, modelTier);

  startReplyStream({
    res, apiKey,
    system: applyEffortDirective(wrapPrompt(systemPrompt), effort),
    messages: fitHistory(aiHistory(hist).slice(-12)), effortCfg: regenEffortCfg, modelList: regenModelList,
    userId, modelTier, effort, releaseSlot, charId,
    onComplete: (text) => {
      hist.push({ role: 'assistant', content: text }); persistConv(key);
      u.regenCount = (u.regenCount || 0) + 1; saveLimitsToDB(userId);
    },
    onFail: restoreAssistant,
    logLabel: 'Regenerate'
  });
});

app.post('/api/rewind/:charId', requireAuth, async (req, res) => {
  if (!VALID_ID.test(req.params.charId)) return res.status(400).json({ error: 'Invalid charId' });
  const key = `${req.user.googleId}:${req.params.charId}`;
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  const hist = conversations[key] || [];
  let removed = 0;
  if (hist.length > 0 && hist[hist.length - 1].role === 'assistant') { hist.pop(); removed++; }
  if (hist.length > 0 && hist[hist.length - 1].role === 'user') { hist.pop(); removed++; }
  conversations[key] = hist;
  persistConv(key);
  res.json({ ok: true, removed, remaining: hist.length });
});

app.post('/api/generate-persona', requireAuth, (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });
  const { name, tagline, description } = req.body;
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 60) return res.status(400).json({ error: 'Name required, max 60 chars' });
  if (tagline && (typeof tagline !== 'string' || tagline.length > 160)) return res.status(400).json({ error: 'Tagline max 160 chars' });
  if (description && (typeof description !== 'string' || description.length > 2000)) return res.status(400).json({ error: 'Description max 2000 chars' });

  const userId = req.user.googleId;
  const personaLimit = checkLimits(userId);
  if (personaLimit.blocked) return res.status(429).json({ error: personaLimit.type === 'session' ? 'Session limit reached' : 'Weekly limit reached', ...personaLimit });

  const userMsg = `Character name: ${name}${tagline ? `\nTagline: ${tagline}` : ''}${description ? `\nDescription: ${description}` : ''}

Write a roleplay system prompt for this character. If they are a recognizable fictional character (from a game, anime, book, movie, TV show, etc.), use their canon personality, lore, relationships, speech patterns, knowledge, and backstory accurately — stay true to who they are in the source material. If they are original, build a rich, consistent character from the details provided.

Include: core personality and temperament, distinct speech style and vocabulary, their knowledge and background, their flaws and insecurities, their motivations, and any notable quirks.

Write ONLY the persona prompt itself. Start with "You are ${name}." No preamble, no commentary, no explanation. Under 400 words.`;

  let fullText = '', done = false;
  callGroqStream(
    apiKey,
    'You write detailed, accurate character personas for AI roleplay apps. You research fictional characters and portray them faithfully.',
    [{ role: 'user', content: userMsg }],
    (text) => { fullText += text; },
    () => { if (done) return; done = true; res.json({ persona: fullText.trim() }); },
    (err) => {
      if (done) return; done = true;
      console.error('Persona gen error:', err.message);
      res.status(500).json({ error: 'Failed to generate persona' });
    },
    undefined, { maxOutputTokens: 600, temperature: 0.9 }
  );
});

app.post('/api/greet/:charId', requireAuth, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });
  const { effort, modelTier: reqModelTier } = req.body;
  const modelTier = resolveModelTier(req.user.googleId, reqModelTier);
  const { charId } = req.params;
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  const userId = req.user.googleId;
  const greetEffortCfg = getEffortCfg(effort, modelTier);
  const greetModelList = getModelList(modelTier);

  const limit = checkLimits(userId);
  if (limit.blocked) return res.status(429).json({ error: limit.type === 'session' ? 'Session limit reached' : 'Weekly limit reached', ...limit });

  const releaseSlot = acquireChatSlot(req, res, userId);
  if (!releaseSlot) return;
  if (!db) return res.status(503).json({ error: 'Service temporarily unavailable' });
  const greetMod = await getModStatus(userId, charId);
  if (greetMod.locked) return res.status(403).json({ error: 'This chat has been ended.' });

  let dbChar;
  try { dbChar = await getCharPrompt(charId); }
  catch (_) { return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' }); }
  if (!dbChar) return res.status(404).json({ error: 'Character not found' });
  const charName = dbChar ? dbChar.name : charId;
  const systemPrompt = dbChar ? dbChar.system_prompt : `You are ${charId}.`;

  const key = `${req.user.googleId}:${charId}`;
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  if (!conversations[key]) conversations[key] = [];
  if (conversations[key].length > 0) return res.status(400).json({ error: 'Already started' });
  convLastUsed[key] = Date.now();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const trigger = [{ role: 'user', content: `[Scene opens. ${charName} enters or is already present. Begin the scene — speak first, act first, set the atmosphere. The other person has just arrived. Go.]` }];
  startReplyStream({
    res, apiKey,
    system: applyEffortDirective(wrapPrompt(systemPrompt), effort),
    messages: trigger, effortCfg: greetEffortCfg, modelList: greetModelList,
    userId, modelTier, effort, releaseSlot, charId,
    onComplete: (text) => { conversations[key].push({ role: 'assistant', content: text }); persistConv(key); },
    logLabel: 'Greet'
  });
});

// Llama-4 Scout (the previous default) was shut down by Groq, which made every image upload fail.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

// One vision call that both checks the image against the content rules and describes it.
// The chat models are text-only, so the character reacts to this description instead of the raw image.
async function analyzeImage(apiKey, dataUri) {
  const prompt = 'You are a content-safety checker and image describer. Reply with ONLY a JSON object and no other text: ' +
    '{"explicit": true or false, "description": "one short factual sentence describing the image"}. ' +
    'Set explicit to true if the image shows any exposed genitals, exposed female breasts or nipples, exposed buttocks, or explicit sexual activity. ' +
    'This applies equally to photos, drawings, cartoons and AI-generated images. A bare male chest, swimwear and normal clothing are allowed (explicit false). ' +
    'The description must be neutral and must not include sexual detail.';
  const call = (extra) => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      temperature: 0,
      max_tokens: 400,
      messages: [{ role: 'user', content: [ { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUri } } ] }],
      ...extra
    })
  });
  // Ask the model not to show its "thinking"; retry without those options if it rejects them
  let r = await call({ reasoning_effort: 'none', reasoning_format: 'hidden' });
  if (r.status === 400) r = await call({});
  if (!r.ok) throw new Error('vision http ' + r.status);
  const j = await r.json();
  const content = String(j.choices?.[0]?.message?.content || '');
  const m = content.match(/\{[^{}]*"explicit"[^{}]*\}/);
  if (!m) throw new Error('unclear vision answer');
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (_) { throw new Error('unparseable vision answer'); }
  if (typeof parsed.explicit !== 'boolean') throw new Error('missing explicit flag');
  const description = String(parsed.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { explicit: parsed.explicit, description };
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });
  const { charId, message, modelTier: reqModelTier, effort, image, callMode } = req.body;
  const modelTier = resolveModelTier(req.user.googleId, reqModelTier);
  if (message !== undefined && typeof message !== 'string') return res.status(400).json({ error: 'Invalid request' });
  if (image !== undefined) {
    if (typeof image !== 'string') return res.status(400).json({ error: 'Invalid image' });
    const ALLOWED_IMG = ['data:image/jpeg;base64,','data:image/jpg;base64,','data:image/png;base64,','data:image/webp;base64,','data:image/gif;base64,'];
    if (!ALLOWED_IMG.some(t => image.startsWith(t))) return res.status(400).json({ error: 'Invalid image format' });
    if (image.length > 1400000) return res.status(400).json({ error: 'Image too large (max ~1MB)' });
  }
  const modelList = getModelList(modelTier);
  const effortCfg = getEffortCfg(effort, modelTier);
  if (!charId) return res.status(400).json({ error: 'charId required' });
  if (!VALID_ID.test(charId)) return res.status(400).json({ error: 'Invalid charId' });
  if (message && message.length > 20000) return res.status(400).json({ error: 'Message too long (max 20000 characters)' });
  const userId = req.user.googleId;

  const limit = checkLimits(userId);
  if (limit.blocked) return res.status(429).json({ error: limit.type === 'session' ? 'Session limit reached' : 'Weekly limit reached', ...limit });
  const releaseSlot = acquireChatSlot(req, res, userId);
  if (!releaseSlot) return;

  let dbChar;
  try { dbChar = await getCharPrompt(charId); }
  catch (_) { return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' }); }
  if (!dbChar) return res.status(404).json({ error: 'Character not found' });
  const char = { systemPrompt: dbChar ? dbChar.system_prompt : `You are ${charId}, a unique AI character.` };
  const key = `${req.user.googleId}:${charId}`;
  if (!(await ensureConvLoaded(key))) return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  if (!conversations[key]) conversations[key] = [];
  convLastUsed[key] = Date.now();

  // Empty message = continuation (AI speaks again without storing a user turn); an image alone is a real turn
  const isContinuation = (!message || !message.trim()) && !image;

  // ── Lock check — block permanently locked chats ───────────────────────────
  if (!db) return res.status(503).json({ error: 'Service temporarily unavailable' });
  const modStatus = await getModStatus(userId, charId);
  if (modStatus.locked) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ conversationEnded: true, locked: true, reason: "This chat was permanently ended due to repeated policy violations. You can't send messages here anymore." })}\n\n`);
    res.end();
    return;
  }

  // ── Image safety: daily cap, then explicit-content check (only after limit and lock checks) ──
  let imageDescription = '';
  if (image && !isContinuation) {
    const imgU = getLimits(userId);
    const imgLimit = getImageLimitForUser(userId);
    if (imgLimit !== Infinity && (imgU.imagesDay || 0) >= imgLimit) {
      return res.status(429).json({ error: `Daily image limit reached (${imgLimit}/day). Resets at 8 AM UTC.` });
    }
    imgU.imagesDay = (imgU.imagesDay || 0) + 1; // attempts count toward the cap, including blocked ones
    let explicit;
    try {
      const analysis = await analyzeImage(apiKey, image);
      explicit = analysis.explicit;
      imageDescription = analysis.description;
    } catch (e) {
      imgU.imagesDay = Math.max(0, imgU.imagesDay - 1); // our failure, not the user's
      console.warn('[image-safety] check failed, blocking image:', e.message);
      return res.status(503).json({ error: "We couldn't check that image right now. Please try again in a moment or send your message without it." });
    }
    if (explicit) {
      const variant = recordNsfwBlock(key, (message && message.trim()) ? message : '[image]');
      return nsfwDeflect(res, addTokens(userId, NSFW_BLOCK_TOKENS), variant);
    }
  }

  // ── Slur detection (three strikes per conversation) ────────────────────────
  const msgNorm = normalizeMsg(message);
  if (!isContinuation && message && hasSlur(msgNorm)) {
    const newStrikes = modStatus.strikes + 1;
    if (newStrikes >= 3) {
      await setModStatus(userId, charId, newStrikes, true);
      conversations[key] = [];
      persistConv(key);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ conversationEnded: true, locked: true, reason: "We’ve given you plenty of warnings. This chat has been permanently ended." })}\n\n`);
      res.end();
      return;
    }
    await setModStatus(userId, charId, newStrikes, false);
    const warning = newStrikes === 1 ? SLUR_WARNING_1 : SLUR_WARNING_2;
    return slurDeflect(res, warning, buildUsagePayload(getLimits(userId), userId));
  }

  // ── "Why can't you do that?" about sexual content — explain the rules, don't block ──
  if (!isContinuation && message && isPolicyWhyQuestion(msgNorm)) {
    const explanation = buildPolicyExplanation();
    conversations[key].push({ role: 'user', content: redactIfUnsafe(message) }, { role: 'assistant', content: explanation });
    persistConv(key);
    const usage = addTokens(userId, Math.round(explanation.length / 3.5));
    return slurDeflect(res, explanation, usage, signReply(userId, charId, explanation));
  }

  // ── Asked for the Terms of Service and/or Privacy Policy — reply with clickable links ──
  if (!isContinuation && message) {
    const docsReply = buildDocsReply(msgNorm);
    if (docsReply) {
      conversations[key].push({ role: 'user', content: message }, { role: 'assistant', content: docsReply });
      persistConv(key);
      const usage = addTokens(userId, Math.round(docsReply.length / 3.5));
      return slurDeflect(res, docsReply, usage, signReply(userId, charId, docsReply));
    }
  }

  // ── NSFW detection — return a random deflection, no Gemini call needed ───────
  if (!isContinuation && message && NSFW_RE.test(msgNorm)) {
    const variant = recordNsfwBlock(key, message);
    return nsfwDeflect(res, addTokens(userId, NSFW_BLOCK_TOKENS), variant);
  }

  // ── Crisis keyword detection ───────────────────────────────────────────────
  let crisisContext = '';
  if (!isContinuation && message && CRISIS_RE.test(msgNorm)) {
    const clientIp = req.ip;
    const geo = await getGeoForIp(clientIp);
    const info = getCrisisInfo(geo);
    if (info) {
      const locationStr = [geo.city, geo.regionName, geo.countryName].filter(Boolean).join(', ') || geo.country;
      crisisContext = `\n\n[CRISIS CONTEXT — for this response only: The user's message may indicate personal distress. Their location appears to be ${locationStr}. Step out of character, respond with genuine warmth and care. Let them know they are not alone and that you care. Gently remind them that local crisis and support resources are available in the Resources section of the sidebar (the heart icon at the bottom-left). Do NOT list or mention specific phone numbers — that's what the Resources panel is for. Be human, warm, and present, not robotic or clinical.]`;
    } else {
      crisisContext = `\n\n[CRISIS CONTEXT — for this response only: The user's message may indicate personal distress. Step out of character, respond with genuine warmth and care. Let them know they are not alone. Gently mention that crisis resources are available in the Resources section of the sidebar. Be human and warm, not robotic.]`;
    }
  }

  if (!isContinuation) {
    // History stores text only — images are not persisted (too large, one-shot vision)
    conversations[key].push({ role: 'user', content: message || '[image]' });
    persistConv(key);
  }

  // Chat APIs require the last turn to be a user turn — inject a hidden continuation trigger if needed
  const history = fitHistory(aiHistory(conversations[key]).slice(-12));
  const lastRole = history[history.length - 1]?.role;
  let messagesForGroq = (isContinuation && lastRole !== 'user')
    ? [...history, { role: 'user', content: '...' }]
    : history;

  // If an image was attached, tell the character what it shows (the chat models are text-only)
  if (image && !isContinuation && imageDescription) {
    const lastIdx = messagesForGroq.length - 1;
    if (messagesForGroq[lastIdx]?.role === 'user') {
      const base = (message && message.trim()) ? message : '';
      messagesForGroq = [
        ...messagesForGroq.slice(0, lastIdx),
        { role: 'user', content: (base ? base + '\n\n' : '') + '[The user shared an image. What it shows: ' + imageDescription + ']' }
      ];
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const callModeDirective = callMode
    ? '\n\n[CALL MODE — You are on a live voice call. Keep your reply SHORT: 1-2 sentences, under 25 words. Speak naturally — no asterisks, no markdown, no action text in parentheses. Plain conversational words only.]'
    : '';

  startReplyStream({
    res, apiKey,
    system: applyEffortDirective(wrapPrompt(char.systemPrompt) + crisisContext + callModeDirective, effort),
    messages: messagesForGroq, effortCfg, modelList, userId, modelTier, effort, releaseSlot, charId,
    onComplete: (text) => { conversations[key].push({ role: 'assistant', content: text }); persistConv(key); },
    logLabel: 'Chat'
  });
});

// ── Email helpers ─────────────────────────────────────────────────────────────

function getMailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

async function sendReceiptEmail(userName, email, planKey, subscriptionId) {
  const transporter = getMailTransporter();
  if (!transporter || !email) return;
  const planNames  = { advanced: 'Advanced Plan', x20: 'X20 Plan', x50: 'X50 Plan' };
  const planPrices = { advanced: '$4.99/month', x20: '$12.99/month', x50: '$24.99/month' };
  const planName  = planNames[planKey]  || planKey;
  const planPrice = planPrices[planKey] || '';
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const firstName = (userName || 'there').split(' ')[0];
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#111111;border-radius:12px;border:1px solid #222222;padding:40px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#7c5cbf">Character.Mind</p>
        <h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#f0f0f0;letter-spacing:-.02em">Your receipt</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#aaaaaa;line-height:1.6">Hi ${esc(firstName)}, thanks for subscribing! Here's a summary of your purchase.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #222222;border-radius:8px;padding:20px;margin:0 0 24px">
          <tr><td style="padding:6px 0;font-size:14px;color:#aaaaaa">Plan</td><td align="right" style="padding:6px 0;font-size:14px;font-weight:600;color:#f0f0f0">${esc(planName)}</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#aaaaaa">Billing</td><td align="right" style="padding:6px 0;font-size:14px;color:#f0f0f0">${esc(planPrice)}</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#aaaaaa">Date</td><td align="right" style="padding:6px 0;font-size:14px;color:#f0f0f0">${esc(date)}</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#aaaaaa">Subscription ID</td><td align="right" style="padding:6px 0;font-size:12px;color:#888;font-family:monospace">${esc(subscriptionId)}</td></tr>
        </table>
        <p style="margin:0 0 8px;font-size:13px;color:#666666;line-height:1.5">Your new limits are active immediately. You can cancel anytime from PayPal or by contacting us at <a href="mailto:support.charactermind@gmail.com" style="color:#7c5cbf;text-decoration:none">support.charactermind@gmail.com</a>.</p>
        <p style="margin:24px 0 0;font-size:12px;color:#555555">This is an automated receipt. Please do not reply to this email.</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
  const text = `Hi ${firstName},\n\nThanks for subscribing to Character.Mind!\n\nPlan: ${planName}\nBilling: ${planPrice}\nDate: ${date}\nSubscription ID: ${subscriptionId}\n\nYour new limits are active immediately. Cancel anytime via PayPal or email support.charactermind@gmail.com.\n\n— Character.Mind`;
  try {
    await transporter.sendMail({
      from: `"Character.Mind" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `Your ${planName} receipt — Character.Mind`,
      html,
      text,
    });
    console.log('Receipt email sent');
  } catch (err) {
    console.error('Receipt email error:', err.message);
  }
}

async function sendPlanWelcomeEmail(userName, email, planKey) {
  const transporter = getMailTransporter();
  if (!transporter || !email) return;
  const firstName = (userName || 'there').split(' ')[0];
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const siteUrl = process.env.SITE_URL || 'https://charactermind.onrender.com';

  const plans = {
    advanced: {
      name: 'Advanced',
      tagline: 'More time with the characters you love.',
      color: '#7c5cbf',
      perks: [
        { icon: '🎙️', label: '5 voice calls per day', sub: 'Up from 3 on Free' },
        { icon: '🔊', label: '50 read-alouds per day', sub: 'Up from 30 on Free' },
        { icon: '💬', label: 'Higher weekly message limit', sub: 'More room to explore longer conversations' },
        { icon: '✨', label: 'Access to every AI character', sub: 'All current and future characters included' },
      ]
    },
    x20: {
      name: 'X20',
      tagline: 'For the ones who never want to stop.',
      color: '#9b59b6',
      perks: [
        { icon: '🎙️', label: '100 voice calls per day', sub: 'Over 30× more than Free' },
        { icon: '🔊', label: '1,000 read-alouds per day', sub: 'Basically unlimited for everyday use' },
        { icon: '💬', label: 'Massively expanded weekly limit', sub: 'Built for power users and long sessions' },
        { icon: '✨', label: 'Access to every AI character', sub: 'All current and future characters included' },
        { icon: '⚡', label: 'Priority support', sub: 'Reach us at support.charactermind@gmail.com' },
      ]
    },
    x50: {
      name: 'X50',
      tagline: 'The full experience. No limits on what\'s possible.',
      color: '#8e44ad',
      perks: [
        { icon: '🎙️', label: '250 voice calls per day', sub: 'The highest tier available' },
        { icon: '🔊', label: '2,500 read-alouds per day', sub: 'Effectively no ceiling for any use case' },
        { icon: '💬', label: 'Maximum weekly message limit', sub: 'Everything Character.Mind has to offer' },
        { icon: '✨', label: 'Access to every AI character', sub: 'All current and future characters included' },
        { icon: '⚡', label: 'Priority support', sub: 'Reach us at support.charactermind@gmail.com' },
      ]
    }
  };

  const plan = plans[planKey];
  if (!plan) return;

  const perksHtml = plan.perks.map(p => `
    <tr>
      <td style="padding:10px 0;vertical-align:top;width:32px;font-size:20px">${p.icon}</td>
      <td style="padding:10px 0 10px 12px;vertical-align:top">
        <p style="margin:0;font-size:14px;font-weight:600;color:#f0f0f0">${esc(p.label)}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#888888">${esc(p.sub)}</p>
      </td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#111111;border-radius:12px;border:1px solid #222222;padding:40px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${plan.color}">Character.Mind</p>
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#f0f0f0;letter-spacing:-.02em">Welcome to ${esc(plan.name)}, ${esc(firstName)}.</h1>
        <p style="margin:0 0 28px;font-size:15px;color:#888888;line-height:1.6">${esc(plan.tagline)}</p>

        <p style="margin:0 0 12px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#555555">What's unlocked</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:8px 16px;margin:0 0 28px">
          ${perksHtml}
        </table>

        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px">
          <tr>
            <td><a href="${siteUrl}" style="display:inline-block;padding:12px 28px;background:${plan.color};color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:-.01em">Start chatting →</a></td>
          </tr>
        </table>

        <p style="margin:0 0 8px;font-size:13px;color:#555555;line-height:1.6">Your limits are active right now — no restart needed. Cancel anytime through PayPal or by contacting us at <a href="mailto:support.charactermind@gmail.com" style="color:${plan.color};text-decoration:none">support.charactermind@gmail.com</a>.</p>
        <p style="margin:20px 0 0;font-size:12px;color:#3a3a3a">This is an automated message. Please do not reply directly to this email.</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

  const perksText = plan.perks.map(p => `  • ${p.label} — ${p.sub}`).join('\n');
  const text = `Welcome to ${plan.name}, ${firstName}.\n\n${plan.tagline}\n\nWhat's unlocked:\n${perksText}\n\nYour limits are active right now. Start chatting: ${siteUrl}\n\nCancel anytime via PayPal or email support.charactermind@gmail.com.\n\n— Character.Mind\n\n(This is an automated message. Please do not reply directly to this email.)`;

  try {
    await transporter.sendMail({
      from: `"Character.Mind" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `Welcome to ${plan.name} — here's what you unlocked`,
      html,
      text,
    });
    console.log('Plan welcome email sent');
  } catch (err) {
    console.error('Plan welcome email error:', err.message);
  }
}

async function sendWelcomeEmail(userName, email) {
  const transporter = getMailTransporter();
  if (!transporter) return;
  try {
    const firstName = (userName || 'there').split(' ')[0];
    await transporter.sendMail({
      from: `"Character.Mind" <${process.env.GMAIL_USER}>`,
      to: email,
      replyTo: process.env.GMAIL_USER,
      subject: `Hey ${firstName}, you're in`,
      text: `Hey ${firstName},\n\nYou're all set on Character.Mind. Log in whenever you're ready:\n\n${process.env.SITE_URL || 'https://charactermind.onrender.com'}\n\n— Character.Mind\n\n(This is an automated message. Please do not reply to this email.)`
    });
    console.log('Welcome email sent');
  } catch (err) {
    console.error('Welcome email error:', err.message);
  }
}


// ── Policy notification email ─────────────────────────────────────────────────

function buildPolicyEmailHtml(userName, message) {
  const name = userName || 'there';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#111111;border-radius:12px;border:1px solid #222222;padding:40px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#7c5cbf">Character.Mind</p>
        <h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#f0f0f0;letter-spacing:-.02em">Policy Update</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#aaaaaa;line-height:1.6">Hi ${name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')},</p>
        <p style="margin:0 0 20px;font-size:15px;color:#aaaaaa;line-height:1.6">We've updated our Terms of Service and/or Privacy Policy. Here's a summary of what changed:</p>
        <div style="background:#0a0a0a;border:1px solid #222222;border-radius:8px;padding:20px;margin:0 0 24px">
          <p style="margin:0;font-size:15px;color:#f0f0f0;line-height:1.6;white-space:pre-wrap">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
        </div>
        <p style="margin:0 0 20px;font-size:15px;color:#aaaaaa;line-height:1.6">You can read the full policies any time:</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 32px">
          <tr>
            <td style="padding-right:12px"><a href="${process.env.SITE_URL || 'https://charactermind.onrender.com'}/terms.html" style="display:inline-block;padding:10px 20px;background:#7c5cbf;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">Terms of Service</a></td>
            <td><a href="${process.env.SITE_URL || 'https://charactermind.onrender.com'}/privacy.html" style="display:inline-block;padding:10px 20px;border:1px solid #444;color:#f0f0f0;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">Privacy Policy</a></td>
          </tr>
        </table>
        <p style="margin:0 0 4px;font-size:13px;color:#666666;line-height:1.5">By continuing to use Character.Mind after these changes, you accept the updated policies. If you have questions, reply to this email.</p>
        <p style="margin:16px 0 0;font-size:13px;color:#444444">— Character.Mind</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

app.post('/api/admin/notify-policy-update', requireAuth, async (req, res) => {
  if (req.user.email !== 'support.charactermind@gmail.com') return res.status(403).json({ error: 'Forbidden' });

  const transporter = getMailTransporter();
  if (!transporter) return res.status(503).json({ error: 'Email service not configured — add GMAIL_USER and GMAIL_APP_PASSWORD to .env' });

  if (!db) return res.status(503).json({ error: 'No database configured' });

  const { subject, message } = req.body;
  if (!subject || typeof subject !== 'string' || subject.length > 200) return res.status(400).json({ error: 'subject required (max 200 chars)' });
  if (!message || typeof message !== 'string' || message.length > 3000) return res.status(400).json({ error: 'message required (max 3000 chars)' });

  let users;
  try {
    const result = await db.query(`SELECT email, name FROM users WHERE email_opt_in = TRUE AND email != '' ORDER BY created_at`);
    users = result.rows;
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users: ' + err.message });
  }

  if (!users.length) return res.json({ ok: true, sent: 0, total: 0, message: 'No users to notify' });

  let sent = 0, errors = 0;
  for (const user of users) {
    try {
      await transporter.sendMail({
        from: `"Character.Mind" <${process.env.GMAIL_USER}>`,
        to: user.email,
        subject,
        html: buildPolicyEmailHtml(user.name, message)
      });
      sent++;
    } catch (err) {
      errors++;
      console.error('Email send error:', err.message);
    }
  }

  console.log(`Policy notification sent: ${sent}/${users.length} (${errors} errors)`);
  res.json({ ok: true, sent, errors, total: users.length });
});

// ── PayPal ─────────────────────────────────────────────────────────────────────
const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const PAYPAL_PLAN_IDS = {
  advanced: process.env.PAYPAL_PLAN_ADVANCED,
  x20:      process.env.PAYPAL_PLAN_X20,
  x50:      process.env.PAYPAL_PLAN_X50,
};

async function getPayPalToken() {
  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('PayPal auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

app.get('/api/paypal/config', (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID || '', env: process.env.PAYPAL_ENV || 'sandbox' });
});

app.post('/api/paypal/verify-subscription', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const { subscriptionId, planKey } = req.body;
  const validPlans = { advanced: true, x20: true, x50: true };
  if (typeof planKey !== 'string' || !Object.hasOwn(validPlans, planKey)) return res.status(400).json({ error: 'Invalid request' });
  if (typeof subscriptionId !== 'string' || !/^I-[A-Z0-9]{6,40}$/.test(subscriptionId)) return res.status(400).json({ error: 'Invalid request' });

  try {
    const token = await getPayPalToken();
    // PayPal can take a few seconds to mark a just-approved subscription ACTIVE, so wait for it briefly
    let sub = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      sub = await resp.json();
      if (sub.status !== 'APPROVAL_PENDING' && sub.status !== 'APPROVED') break;
      await new Promise(r => setTimeout(r, 1500));
    }
    // A subscription created for another account can't be claimed here
    if (sub.custom_id && sub.custom_id !== req.user.googleId) {
      return res.status(403).json({ error: 'This subscription belongs to another account' });
    }

    if (sub.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Subscription not active', status: sub.status });
    }
    // Verify the subscription's plan matches what the client claims
    const expectedPlanId = PAYPAL_PLAN_IDS[planKey];
    if (!expectedPlanId) {
      console.error(`PayPal plan ID for "${planKey}" is not configured — refusing to activate`);
      return res.status(503).json({ error: 'This plan is not available right now' });
    }
    if (sub.plan_id !== expectedPlanId) {
      console.error(`PayPal plan mismatch: expected ${expectedPlanId}, got ${sub.plan_id}`);
      return res.status(403).json({ error: 'Subscription plan does not match selected tier' });
    }
    if (!db) return res.status(503).json({ error: 'Service temporarily unavailable' });
    // One subscription can only upgrade one account
    const taken = await db.query('SELECT 1 FROM users WHERE paypal_subscription_id = $1 AND google_id <> $2 LIMIT 1', [subscriptionId, req.user.googleId]);
    if (taken.rows.length) return res.status(409).json({ error: 'This subscription is already linked to another account' });
    const upd = await db.query(
      'UPDATE users SET subscription_tier = $1, paypal_subscription_id = $2 WHERE google_id = $3',
      [planKey, subscriptionId, req.user.googleId]
    );
    if (!upd.rowCount) return res.status(500).json({ error: 'Could not activate subscription' });
    const paidLimits = getLimits(req.user.googleId);
    paidLimits.subscriptionTier = planKey;
    paidLimits.tierLoaded = true;
    paidLimits.sessionTokens = 0; paidLimits.sessionStartedAt = null; paidLimits.cooldownUntil = null; // fresh session on the new plan
    saveLimitsToDB(req.user.googleId);
    sendReceiptEmail(req.user.name, req.user.email, planKey, subscriptionId).catch(() => {});
    sendPlanWelcomeEmail(req.user.name, req.user.email, planKey).catch(() => {});
    res.json({ ok: true, tier: planKey });
  } catch (err) {
    console.error('PayPal verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/webhooks/paypal', async (req, res) => {
  if (!req.headers['paypal-transmission-sig'] || !req.headers['paypal-transmission-id']) return res.sendStatus(400);
  let event;
  try { event = JSON.parse((req.rawBody || Buffer.from('')).toString('utf8')); } catch { return res.sendStatus(400); }

  // Verify PayPal webhook signature (requires PAYPAL_WEBHOOK_ID env var). Fail closed if it is not configured.
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.error('PayPal webhook rejected: PAYPAL_WEBHOOK_ID is not set');
    return res.sendStatus(503);
  }
  {
    try {
      const token = await getPayPalToken();
      const verifyResp = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_algo:        req.headers['paypal-auth-algo'],
          cert_url:         req.headers['paypal-cert-url'],
          transmission_id:  req.headers['paypal-transmission-id'],
          transmission_sig: req.headers['paypal-transmission-sig'],
          transmission_time:req.headers['paypal-transmission-time'],
          webhook_id:       webhookId,
          webhook_event:    event
        })
      });
      const verify = await verifyResp.json();
      if (verify.verification_status !== 'SUCCESS') {
        console.error('PayPal webhook signature invalid:', verify.verification_status);
        return res.sendStatus(400);
      }
    } catch (err) {
      console.error('PayPal webhook verify error:', err.message);
      return res.sendStatus(400);
    }
  }

  const eventType = event.event_type;
  const subId = event.resource?.id;
  // Activate the plan from PayPal's own notification, so a payment is never lost if the browser call failed
  if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' && subId && db) {
    const customId = String((event.resource && event.resource.custom_id) || '');
    const planId = event.resource && event.resource.plan_id;
    const tier = Object.keys(PAYPAL_PLAN_IDS).find(k => PAYPAL_PLAN_IDS[k] && PAYPAL_PLAN_IDS[k] === planId);
    if (tier && /^[0-9]{5,40}$/.test(customId)) {
      try {
        const upd = await db.query(
          'UPDATE users SET subscription_tier = $1, paypal_subscription_id = $2 WHERE google_id = $3 AND NOT EXISTS (SELECT 1 FROM users WHERE paypal_subscription_id = $2 AND google_id <> $3) RETURNING google_id',
          [tier, subId, customId]);
        if (upd.rows.length) {
          const lim = getLimits(customId);
          lim.subscriptionTier = tier; lim.tierLoaded = true;
          lim.sessionTokens = 0; lim.sessionStartedAt = null; lim.cooldownUntil = null;
          saveLimitsToDB(customId);
        }
      } catch (e) { console.error('Webhook activation error:', e.message); }
    }
  }
  const endEvents = ['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED'];
  const cancelEvents = [...endEvents, 'BILLING.SUBSCRIPTION.SUSPENDED'];
  if (cancelEvents.includes(eventType) && subId && db) {
    const clearId = endEvents.includes(eventType);
    const cancelled = await db.query(
      "UPDATE users SET subscription_tier = 'free'" + (clearId ? ', paypal_subscription_id = NULL' : '') + ' WHERE paypal_subscription_id = $1 RETURNING google_id', [subId])
      .catch(err => { console.error('Webhook DB error:', err); return { rows: [] }; });
    for (const row of cancelled.rows) {
      if (userLimits[row.google_id]) { userLimits[row.google_id].subscriptionTier = 'free'; saveLimitsToDB(row.google_id); }
    }
  }
  res.sendStatus(200);
});

app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function loadOwnerIds() {
  if (!db) return;
  db.query('SELECT google_id FROM users WHERE email = ANY($1)', [[...OWNER_EMAILS]])
    .then(r => r.rows.forEach(row => ownerGoogleIds.add(row.google_id)))
    .catch(() => {});
}

// Clear JSON errors (e.g. an upload that is too large) instead of an HTML error page
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'That upload is too large. Try a smaller image.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  console.error('Unhandled error:', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

function startListening() {
  app.listen(PORT, () => {
    loadOwnerIds();
    console.log(`\nAI Character Site running at http://localhost:${PORT}\n`);
  });
}

if (!db) {
  startListening();
}
