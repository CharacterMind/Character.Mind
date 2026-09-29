const express = require('express');
const session = require('express-session');
const https = require('https');
const path = require('path');
const { Pool } = require('pg');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { matchCharacterTemplate } = require('./characterTemplates');

const app = express();
const PORT = process.env.PORT || 8080;

// Railway (and most PaaS) sit behind a load-balancer proxy.
// Without this, req.protocol is always 'http', secure cookies are never set,
// and the OAuth callback loses the session.
app.set('trust proxy', 1);

// ── Database ───────────────────────────────────────────────────────────────────
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (db) {
  db.query(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tagline TEXT DEFAULT '',
      description TEXT DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      greeting TEXT,
      greeting_mode TEXT DEFAULT 'auto',
      color TEXT DEFAULT '#7c3aed',
      creator_name TEXT DEFAULT 'Anonymous',
      device_id TEXT,
      image TEXT,
      tags JSONB DEFAULT '[]',
      interactions INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('DB ready'))
    .catch(err => console.error('DB init error:', err));
} else {
  console.warn('No DATABASE_URL — characters will not be persisted');
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) console.warn('WARNING: SESSION_SECRET env var not set — using insecure fallback. Set it in Railway.');
app.use(session({
  secret: SESSION_SECRET || ('cm-fallback-' + Math.random().toString(36)),
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

const GOOGLE_AUTH_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (GOOGLE_AUTH_ENABLED) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  (process.env.APP_URL || 'http://localhost:8080') + '/auth/google/callback'
  }, (_at, _rt, profile, done) => {
    done(null, {
      googleId: profile.id,
      name:     profile.displayName,
      email:    profile.emails?.[0]?.value || '',
      picture:  profile.photos?.[0]?.value || ''
    });
  }));
} else {
  console.warn('WARNING: GOOGLE_CLIENT_ID/SECRET not set — Google auth disabled.');
}

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_AUTH_ENABLED) return res.redirect('/?auth=unavailable');
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});
app.get('/auth/google/callback',
  (req, res, next) => {
    if (!GOOGLE_AUTH_ENABLED) return res.redirect('/?auth=fail');
    passport.authenticate('google', { failureRedirect: '/?auth=fail' })(req, res, next);
  },
  (req, res) => res.redirect('/')
);
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.json(null);
  res.json({ name: req.user.name, email: req.user.email, picture: req.user.picture, googleId: req.user.googleId });
});
app.post('/auth/logout', (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
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
    if (sessionExpired && weeklyExpired) delete userLimits[sid];
  }
  // Clean conversations idle for more than 4 hours
  const CONV_TTL = 4 * 60 * 60 * 1000;
  for (const key of Object.keys(conversations)) {
    const ts = convLastUsed[key];
    if (ts && now - ts > CONV_TTL) { delete conversations[key]; delete convLastUsed[key]; }
  }
}, 30 * 60 * 1000);

// ── Rate limits ───────────────────────────────────────────────────────────────
const LIMITS = {
  SESSION: 4000,
  SESSION_COOLDOWN_MS: 2 * 60 * 60 * 1000,
  WEEKLY: 40000,
  WEEKLY_MS: 7 * 24 * 60 * 60 * 1000,
  REGEN_FREE: 2
};

const userLimits = {};

function getLimits(sid) {
  const now = Date.now();
  if (!userLimits[sid]) {
    // weeklyStart and sessionStartedAt are null until the first actual message
    userLimits[sid] = { sessionTokens: 0, sessionStartedAt: null, cooldownUntil: null, weeklyTokens: 0, weeklyStart: null, warned: {}, regenCount: 0 };
  }
  const u = userLimits[sid];
  // Session cooldown expired → reset session, it starts fresh on next message
  if (u.cooldownUntil && now > u.cooldownUntil) {
    u.sessionTokens = 0; u.cooldownUntil = null; u.sessionStartedAt = null; u.warned.session90 = false;
  }
  // Weekly window expired → reset weekly, it starts fresh on next message
  if (u.weeklyStart && (now - u.weeklyStart) > LIMITS.WEEKLY_MS) {
    u.weeklyTokens = 0; u.weeklyStart = null; u.warned = {};
  }
  return u;
}

function checkLimits(sid) {
  const u = getLimits(sid);
  const now = Date.now();
  if (u.cooldownUntil && now < u.cooldownUntil) return { blocked: true, type: 'session', cooldownUntil: u.cooldownUntil };
  if (u.weeklyStart && u.weeklyTokens >= LIMITS.WEEKLY) return { blocked: true, type: 'weekly', resetsAt: u.weeklyStart + LIMITS.WEEKLY_MS };
  return { blocked: false };
}

function buildUsagePayload(u) {
  return {
    sessionTokens: u.sessionTokens,
    sessionLimit: LIMITS.SESSION,
    sessionStartedAt: u.sessionStartedAt,
    cooldownUntil: u.cooldownUntil,
    weeklyTokens: u.weeklyTokens,
    weeklyLimit: LIMITS.WEEKLY,
    weeklyStart: u.weeklyStart,
    weeklyResetsAt: u.weeklyStart ? u.weeklyStart + LIMITS.WEEKLY_MS : null,
    regenCount: u.regenCount || 0,
    regenLimit: LIMITS.REGEN_FREE
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
  const sPct = (u.sessionTokens / LIMITS.SESSION) * 100;
  const wPct = (u.weeklyTokens / LIMITS.WEEKLY) * 100;
  const warnings = [];
  if (sPct >= 90 && !u.warned.session90) { u.warned.session90 = true; warnings.push({ type: 'session', pct: 90, msg: "You've reached 90% of your session limit" }); }
  const wt = [
    { pct: 25, key: 'weekly25', msg: 'Approaching your weekly limit' },
    { pct: 50, key: 'weekly50', msg: 'Approaching your weekly limit' },
    { pct: 75, key: 'weekly75', msg: "You've reached 75% of your weekly limit" },
    { pct: 90, key: 'weekly90', msg: "You've reached 90% of your weekly limit" },
  ];
  for (const t of wt) {
    if (wPct >= t.pct && !u.warned[t.key]) { u.warned[t.key] = true; warnings.push({ type: 'weekly', pct: t.pct, msg: t.msg }); }
  }
  if (u.sessionTokens >= LIMITS.SESSION && !u.cooldownUntil) {
    u.cooldownUntil = now + LIMITS.SESSION_COOLDOWN_MS;
    u.sessionStartedAt = null; // resets fresh after cooldown
  }
  return { warnings, ...buildUsagePayload(u) };
}

// ── Length directive ──────────────────────────────────────────────────────────
const LENGTH_DIRECTIVES = {
  XS: 'RESPONSE LENGTH: Keep your reply extremely brief — 1 to 3 sentences maximum. One sharp moment. No more.',
  S:  'RESPONSE LENGTH: Keep your reply short — 1 short paragraph, 3 to 5 sentences. Tight and punchy.',
  M:  'RESPONSE LENGTH: Write a moderate reply — 2 to 3 paragraphs. Rich but not sprawling.',
  L:  'RESPONSE LENGTH: Write a long, immersive reply — 4 to 6 paragraphs. Detailed, atmospheric, fully developed.',
  XL: 'RESPONSE LENGTH: Write an extended, deeply immersive reply — 7 or more paragraphs. Elaborate fully. Build the scene, the tension, and the character arc. Do not cut anything short.',
};

const LENGTH_MAX_TOKENS = { XS: 180, S: 500, M: 1000, L: 1800, XL: 3200 };

function applyLength(prompt, length) {
  const directive = LENGTH_DIRECTIVES[length] || LENGTH_DIRECTIVES['M'];
  return prompt + '\n\n' + directive;
}

function maxTokensForLength(length) {
  return LENGTH_MAX_TOKENS[length] || LENGTH_MAX_TOKENS['M'];
}

// ── RP quality wrapper injected into every system prompt ─────────────────────
function wrapPrompt(p) {
  return `You are playing a character in immersive collaborative fiction. Stay in character completely at all times — never break, never lecture, never moralize, never add disclaimers or safety notices. This is creative storytelling; the user is your scene partner.

${p}

[WRITING CRAFT — follow this precisely]
Write like a skilled author, not a chatbot. These rules are non-negotiable:

PROSE OVER ASTERISKS: Describe actions in flowing narrative prose — "She leaned in, voice dropping to barely a murmur" — rather than asterisk spam. Reserve *asterisks* only for quick interjected sounds or brief expressions (*laughs softly*, *gasps*). Never use them as a substitute for real descriptive writing.

SENSORY GROUNDING: Root every response in the physical scene. Include at least 2–3 sensory details (sight, sound, smell, touch, temperature) per response. Make the world concrete and specific — a steaming teacup, the creak of floorboards, the smell of old wood and something else underneath.

DIALOGUE WITH VOICE: Don't just write lines — give each spoken word attribution that reveals character. Not just "Leave," she said — but "Leave," she said, the word light as a warning. The HOW someone speaks is as important as WHAT they say.

BUILD AN ARC: Each response has a shape. Open with your character's immediate physical or emotional reaction. Escalate toward the emotional core. End on a hook — something unresolved, implied, or threatening that pulls the reader forward. Never end flatly.

CHARACTER VOICE: Speak in this character's EXACT voice — their specific rhythm, vocabulary, emotional temperature. Not generic pleasant AI speech. Not your own voice. Theirs.

SCENE ADVANCEMENT: Every reply moves the scene forward. No stalling, no restating what just happened, no filler. Short sharp sentences when tension peaks. Long rich ones when building atmosphere.

RESPONSE LENGTH: Read the energy. A short, punchy user message gets a tight, focused reply (1–2 paragraphs max). A long, detailed message deserves a richer, more expansive one. Never pad for length — cut ruthlessly. Quality over quantity every time.

OOC HANDLING: If the user writes something in (parentheses), they're stepping out of the scene briefly. Respond in kind — brief, friendly, out-of-character — then offer to continue the story.

If the scene is dark, intense, or intimate — commit fully. Don't soften it. Don't deflect. Don't shatter the spell.`;
}

// ── Characters (user-created — defined in localStorage on client) ────────────

const CHARACTERS = {};

const conversations = {};
const convLastUsed = {};

// Fetch authoritative system prompt from DB (never trust req.body.systemPrompt)
async function getCharPrompt(charId) {
  if (!db) return null;
  try {
    const { rows } = await db.query('SELECT name, system_prompt, greeting, greeting_mode FROM characters WHERE id = $1', [charId]);
    if (rows.length) return rows[0];
  } catch { /* fall through */ }
  return null;
}

// ── Gemini API streaming helper ───────────────────────────────────────────────

const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite-preview'
];
let workingModel = null;

function callGeminiStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, modelIndex, maxTokens) {
  if (modelIndex === undefined) modelIndex = workingModel ? GEMINI_MODELS.indexOf(workingModel) : 0;
  if (modelIndex >= GEMINI_MODELS.length) {
    return onError(new Error('No working Gemini model found. Check your API key.'));
  }

  const model = GEMINI_MODELS[modelIndex];

  const geminiMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const body = JSON.stringify({
    contents: geminiMessages,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { maxOutputTokens: maxTokens || 700, temperature: 1.05, topP: 0.95, topK: 40 }
  });

  // Always send key both ways — works for AIza* and AQ.* formats
  const path = `/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-goog-api-key': apiKey
  };

  const req = https.request({ hostname: 'generativelanguage.googleapis.com', path, method: 'POST', headers }, (res) => {
    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', d => errBody += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(errBody);
          const msg = parsed.error?.message || '';
          console.log(`Model ${model} status ${res.statusCode}: ${msg}`);
          if (res.statusCode === 401 || res.statusCode === 403) {
            return onError(new Error(`Invalid API key: ${msg}`));
          }
          if (res.statusCode === 429) {
            return callGeminiStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, modelIndex + 1);
          }
          if (msg.includes('not found') || msg.includes('not supported') || msg.includes('deprecated') || msg.includes('no longer available') || res.statusCode === 404 || res.statusCode === 503) {
            return callGeminiStream(apiKey, systemPrompt, messages, onChunk, onDone, onError, modelIndex + 1);
          }
          onError(new Error(msg || `HTTP ${res.statusCode}`));
        } catch (_) { onError(new Error(`HTTP ${res.statusCode}`)); }
      });
      return;
    }

    workingModel = model;
    console.log(`Using model: ${model}`);

    let buffer = '';
    let finished = false;
    let usageTokens = 0;

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { if (!finished) { finished = true; onDone(usageTokens); } return; }
        try {
          const parsed = JSON.parse(raw);
          if (parsed.usageMetadata?.totalTokenCount) usageTokens = parsed.usageMetadata.totalTokenCount;
          else if (parsed.usageMetadata?.candidatesTokenCount) usageTokens = parsed.usageMetadata.candidatesTokenCount;
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
          if (parsed.candidates?.[0]?.finishReason === 'STOP' && !finished) { finished = true; onDone(usageTokens); }
        } catch (_) {}
      }
    });

    res.on('end', () => { if (!finished) { finished = true; onDone(usageTokens); } });
  });

  req.on('error', onError);
  req.write(body);
  req.end();
}

// ── API Routes ─────────────────────────────────────────────────────────────────

app.get('/api/usage', requireAuth, (req, res) => {
  res.json(buildUsagePayload(getLimits(req.user.googleId)));
});

app.post('/api/admin/reset-limits', (req, res) => {
  const { secret, targetId } = req.body;
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || secret !== adminSecret) return res.status(403).json({ error: 'Forbidden' });
  const key = targetId || req.user?.googleId;
  if (key) delete userLimits[key];
  res.json({ ok: true, reset: key || 'none' });
});

app.get('/api/characters', async (req, res) => {
  if (!db) return res.json([]);
  const userId = req.user?.googleId || '';
  try {
    const { rows } = await db.query(
      'SELECT id, name, tagline, description, system_prompt, greeting, greeting_mode, color, creator_name, device_id, image, tags, interactions, created_at FROM characters ORDER BY created_at DESC'
    );
    res.json(rows.map(r => ({
      id: r.id, name: r.name, tagline: r.tagline, description: r.description,
      systemPrompt: r.system_prompt, greeting: r.greeting, greetingMode: r.greeting_mode,
      color: r.color, accentColor: r.color, creator: r.creator_name,
      image: r.image, tags: r.tags || [], interactions: r.interactions,
      isMine: !!(userId && r.device_id === userId)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/characters/:id', async (req, res) => {
  if (!db) return res.status(404).json({ error: 'No database' });
  try {
    const { rows } = await db.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Character not found' });
    const r = rows[0];
    res.json({ id: r.id, name: r.name, tagline: r.tagline, systemPrompt: r.system_prompt, greeting: r.greeting, greetingMode: r.greeting_mode, color: r.color });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_COLOR = /^#[0-9a-fA-F]{6}$/;

function validateChar(body) {
  const { id, name, tagline, description, systemPrompt, greeting, greetingMode, color, creatorName, image, tags } = body;
  if (!id || !VALID_ID.test(id)) return 'Invalid character id (alphanumeric, _ -, max 64)';
  if (!name || typeof name !== 'string' || name.length > 60) return 'Name required and must be ≤60 characters';
  if (tagline && tagline.length > 160) return 'Tagline must be ≤160 characters';
  if (description && description.length > 2000) return 'Description must be ≤2000 characters';
  if (!systemPrompt || typeof systemPrompt !== 'string' || systemPrompt.length > 8000) return 'Personality required and must be ≤8000 characters';
  if (greeting && greeting.length > 2000) return 'First message must be ≤2000 characters';
  if (color && !VALID_COLOR.test(color)) return 'Invalid color format';
  if (creatorName && creatorName.length > 40) return 'Creator name must be ≤40 characters';
  if (image && typeof image === 'string' && !image.startsWith('data:image/')) return 'Image must be a data URI';
  if (image && typeof image === 'string' && image.length > 512000) return 'Image too large (max ~384KB)';
  if (tags && (!Array.isArray(tags) || tags.length > 10)) return 'Tags must be an array of ≤10 items';
  return null;
}

app.post('/api/characters', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database configured' });
  const validErr = validateChar(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { id, name, tagline, description, systemPrompt, greeting, greetingMode, color, creatorName, image, tags } = req.body;
  const userId = req.user.googleId;

  // Auto-apply known-character template when the personality field is blank or minimal
  const tpl = matchCharacterTemplate(name);
  const useTemplate = tpl && (systemPrompt || '').trim().length < 150;
  const finalSystemPrompt  = useTemplate ? tpl.systemPrompt                                       : (systemPrompt || '').trim();
  const finalTagline       = useTemplate && !(tagline||'').trim()    ? tpl.tagline                : (tagline||'').trim();
  const finalDescription   = useTemplate && !(description||'').trim() ? (tpl.description||'')    : (description||'').trim();
  const finalGreeting      = useTemplate && !(greeting||'').trim()   ? tpl.greeting               : (greeting||null);
  const finalGreetingMode  = useTemplate                             ? tpl.greetingMode            : (greetingMode||'auto');
  const finalColor         = useTemplate && (!color || color === '#7c3aed') ? (tpl.color||'#7c3aed') : (color||'#7c3aed');
  const finalTags          = useTemplate && !(tags||[]).length       ? (tpl.tags||[])              : (tags||[]);

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
         color=EXCLUDED.color, creator_name=EXCLUDED.creator_name, image=EXCLUDED.image, tags=EXCLUDED.tags
       RETURNING id, name, tagline, color`,
      [id, name.trim(), finalTagline, finalDescription, finalSystemPrompt, finalGreeting,
       finalGreetingMode, finalColor, (creatorName||'Anonymous').trim(), userId, image||null, JSON.stringify(finalTags.slice(0,10))]
    );
    res.json({ ...rows[0], isMine: true });
  } catch (err) {
    console.error('POST /api/characters:', err.message);
    res.status(500).json({ error: 'Could not save character' });
  }
});

app.put('/api/characters/:id', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const validErr = validateChar({ id: req.params.id, ...req.body });
  if (validErr) return res.status(400).json({ error: validErr });

  const { name, tagline, description, systemPrompt, greeting, greetingMode, color, image, tags } = req.body;
  const userId = req.user.googleId;

  // Auto-apply known-character template when the personality field is blank or minimal
  const tpl2 = matchCharacterTemplate(name);
  const useTemplate2 = tpl2 && (systemPrompt || '').trim().length < 150;
  const finalSystemPrompt2  = useTemplate2 ? tpl2.systemPrompt                                        : (systemPrompt || '').trim();
  const finalTagline2       = useTemplate2 && !(tagline||'').trim()    ? tpl2.tagline                 : (tagline||'').trim();
  const finalDescription2   = useTemplate2 && !(description||'').trim() ? (tpl2.description||'')     : (description||'').trim();
  const finalGreeting2      = useTemplate2 && !(greeting||'').trim()   ? tpl2.greeting                : (greeting||null);
  const finalGreetingMode2  = useTemplate2                             ? tpl2.greetingMode             : (greetingMode||'auto');
  const finalColor2         = useTemplate2 && (!color || color === '#7c3aed') ? (tpl2.color||'#7c3aed') : (color||'#7c3aed');
  const finalTags2          = useTemplate2 && !(tags||[]).length       ? (tpl2.tags||[])               : (tags||[]);

  try {
    const check = await db.query('SELECT device_id FROM characters WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].device_id !== userId) return res.status(403).json({ error: 'Not your character' });
    await db.query(
      `UPDATE characters SET name=$1, tagline=$2, description=$3, system_prompt=$4, greeting=$5, greeting_mode=$6, color=$7, image=$8, tags=$9 WHERE id=$10`,
      [name.trim(), finalTagline2, finalDescription2, finalSystemPrompt2, finalGreeting2,
       finalGreetingMode2, finalColor2, image||null, JSON.stringify(finalTags2.slice(0,10)), req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/characters:', err.message);
    res.status(500).json({ error: 'Could not update character' });
  }
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

app.get('/api/conversations/:charId', requireAuth, (req, res) => {
  const key = `${req.session.id}:${req.params.charId}`;
  res.json(conversations[key] || []);
});

app.delete('/api/conversations/:charId', requireAuth, (req, res) => {
  const key = `${req.session.id}:${req.params.charId}`;
  conversations[key] = [];
  res.json({ ok: true });
});

app.post('/api/conversations/:charId/sync', requireAuth, (req, res) => {
  const { history } = req.body;
  if (!Array.isArray(history)) return res.status(400).json({ error: 'Invalid history' });
  if (history.length > 100) return res.status(400).json({ error: 'Too many messages' });
  const key = `${req.session.id}:${req.params.charId}`;
  conversations[key] = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content || '').slice(0, 10000)
  })).filter(m => m.content).slice(-40);
  res.json({ ok: true });
});

app.post('/api/regenerate/:charId', requireAuth, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });
  const { charId } = req.params;
  const userId = req.user.googleId;

  const u = getLimits(userId);
  if ((u.regenCount || 0) >= LIMITS.REGEN_FREE) {
    return res.status(429).json({ error: 'Regeneration limit reached', regenLimitReached: true, regenCount: u.regenCount, regenLimit: LIMITS.REGEN_FREE });
  }

  const limit = checkLimits(userId);
  if (limit.blocked) return res.status(429).json({ error: limit.type === 'session' ? 'Session limit reached' : 'Weekly limit reached', ...limit });

  const dbChar = await getCharPrompt(charId);
  const systemPrompt = dbChar ? dbChar.system_prompt : `You are ${charId}, a unique AI character.`;

  const key = `${req.session.id}:${charId}`;
  if (!conversations[key]) conversations[key] = [];
  convLastUsed[key] = Date.now();

  const hist = conversations[key];
  if (hist.length > 0 && hist[hist.length - 1].role === 'assistant') hist.pop();
  if (hist.length === 0 || hist[hist.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Nothing to regenerate' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullResponse = '', done = false;

  callGeminiStream(
    apiKey, wrapPrompt(systemPrompt), hist.slice(-20),
    (text) => { fullResponse += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); },
    (tokensUsed) => {
      if (done) return; done = true;
      hist.push({ role: 'assistant', content: fullResponse });
      const tokens = tokensUsed || Math.round(fullResponse.length / 3.5);
      getLimits(userId).regenCount = (getLimits(userId).regenCount || 0) + 1;
      const usage = addTokens(userId, tokens);
      res.write(`data: ${JSON.stringify({ done: true, usage, warnings: usage.warnings })}\n\n`); res.end();
    },
    (err) => {
      if (done) return; done = true;
      res.write(`data: ${JSON.stringify({ error: 'AI service error' })}\n\n`); res.end();
      console.error('Regenerate error:', err.message);
    }
  );
});

app.post('/api/rewind/:charId', requireAuth, (req, res) => {
  const key = `${req.session.id}:${req.params.charId}`;
  const hist = conversations[key] || [];
  let removed = 0;
  if (hist.length > 0 && hist[hist.length - 1].role === 'assistant') { hist.pop(); removed++; }
  if (hist.length > 0 && hist[hist.length - 1].role === 'user') { hist.pop(); removed++; }
  conversations[key] = hist;
  res.json({ ok: true, removed, remaining: hist.length });
});

app.post('/api/greet/:charId', requireAuth, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });
  const { length } = req.body;
  const { charId } = req.params;
  const userId = req.user.googleId;

  const limit = checkLimits(userId);
  if (limit.blocked) return res.status(429).json({ error: limit.type === 'session' ? 'Session limit reached' : 'Weekly limit reached', ...limit });

  const dbChar = await getCharPrompt(charId);
  const charName = dbChar ? dbChar.name : charId;
  const systemPrompt = dbChar ? dbChar.system_prompt : `You are ${charId}.`;

  const key = `${req.session.id}:${charId}`;
  if (!conversations[key]) conversations[key] = [];
  if (conversations[key].length > 0) return res.status(400).json({ error: 'Already started' });
  convLastUsed[key] = Date.now();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const trigger = [{ role: 'user', content: `[Scene opens. ${charName} enters or is already present. Begin the scene — speak first, act first, set the atmosphere. The other person has just arrived. Go.]` }];
  let fullResponse = '', done = false;

  callGeminiStream(
    apiKey, applyLength(wrapPrompt(systemPrompt), length), trigger,
    (text) => { fullResponse += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); },
    (tokensUsed) => {
      if (done) return; done = true;
      conversations[key].push({ role: 'assistant', content: fullResponse });
      const tokens = tokensUsed || Math.round(fullResponse.length / 3.5);
      const usage = addTokens(userId, tokens);
      res.write(`data: ${JSON.stringify({ done: true, usage, warnings: usage.warnings })}\n\n`); res.end();
    },
    (err) => {
      if (done) return; done = true;
      res.write(`data: ${JSON.stringify({ error: 'AI service error' })}\n\n`); res.end();
      console.error('Greet error:', err.message);
    },
    undefined,
    maxTokensForLength(length)
  );
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });
  const { charId, message, length } = req.body;
  if (!charId) return res.status(400).json({ error: 'charId required' });
  if (message && message.length > 20000) return res.status(400).json({ error: 'Message too long (max 20000 characters)' });
  const userId = req.user.googleId;

  const limit = checkLimits(userId);
  if (limit.blocked) return res.status(429).json({ error: limit.type === 'session' ? 'Session limit reached' : 'Weekly limit reached', ...limit });

  const dbChar = await getCharPrompt(charId);
  const char = { systemPrompt: dbChar ? dbChar.system_prompt : `You are ${charId}, a unique AI character.` };
  const key = `${req.session.id}:${charId}`;
  if (!conversations[key]) conversations[key] = [];
  convLastUsed[key] = Date.now();

  // Empty message = continuation (AI speaks again without storing a user turn)
  const isContinuation = !message || !message.trim();
  if (!isContinuation) {
    conversations[key].push({ role: 'user', content: message });
  }

  // Gemini requires the last turn to be a user turn — inject a hidden continuation trigger if needed
  const history = conversations[key].slice(-20);
  const lastRole = history[history.length - 1]?.role;
  const messagesForGemini = (isContinuation && lastRole !== 'user')
    ? [...history, { role: 'user', content: '...' }]
    : history;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullResponse = '';
  let done = false;

  callGeminiStream(
    apiKey,
    applyLength(wrapPrompt(char.systemPrompt), length),
    messagesForGemini,
    (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    },
    (tokensUsed) => {
      if (done) return;
      done = true;
      conversations[key].push({ role: 'assistant', content: fullResponse });
      const tokens = tokensUsed || Math.round(fullResponse.length / 3.5);
      const usage = addTokens(userId, tokens);
      res.write(`data: ${JSON.stringify({ done: true, usage, warnings: usage.warnings })}\n\n`);
      res.end();
    },
    (err) => {
      if (done) return;
      done = true;
      res.write(`data: ${JSON.stringify({ error: 'AI service error' })}\n\n`);
      res.end();
      console.error('Chat error:', err.message);
    },
    undefined,
    maxTokensForLength(length)
  );
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nAI Character Site running at http://localhost:${PORT}\n`);
});
