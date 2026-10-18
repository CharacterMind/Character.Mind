require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const TEST_ONLY = process.argv[2] !== '--all';
const SITE_URL = process.env.SITE_URL || 'https://charactermind.onrender.com';

const EMAIL_HTML = `
<div style="font-family:'Segoe UI',Arial,sans-serif;background:#060c0d;color:#c8e8ea;max-width:600px;margin:0 auto;border-radius:12px;overflow:hidden">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#001f22 0%,#00383f 40%,#001f22 100%);padding:36px 32px 28px;text-align:center;border-bottom:3px solid #00C8D4">
    <img src="${SITE_URL}/logo.png" alt="Character Mind" width="140" style="display:block;margin:0 auto 20px;height:auto" />
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:#00C8D4">Character Drop · Oct 2026</p>
    <h1 style="margin:0 0 8px;font-size:28px;font-weight:800;color:#fff;line-height:1.25">DOEY has joined the Chat.</h1>
    <p style="margin:0;font-size:15px;color:#a8d8dc">The Doughman is here — and he brought a patch.</p>
  </div>

  <!-- Color strip -->
  <div style="height:4px;background:linear-gradient(90deg,#007A85,#00C8D4,#FFD600,#FF7C00,#E53030,#FF7C00,#FFD600,#00C8D4)"></div>

  <!-- Character intro -->
  <div style="padding:32px;background:#0a1416">

    <div style="background:#071010;border:1px solid #0e2a2e;border-left:4px solid #00C8D4;border-radius:0 10px 10px 0;padding:22px 20px;margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#00C8D4;margin-bottom:8px">Now Available</div>
      <div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:4px">🫓 DOEY the Doughman</div>
      <div style="font-size:13px;color:#3a7880;margin-bottom:16px">Playtime Co. — Kitchen Division</div>
      <p style="margin:0;font-size:14px;line-height:1.75;color:#a8d8dc">
        He's warm. He's soft. He just wants to cook for you, talk with you, and make sure you're having a good time.<br><br>
        DOEY is exactly who you think he is — enthusiastic, playful, a little overwhelming — and he's now live on Character Mind with his full personality from the game. Bring up food. Bring up the factory. See what happens when the fun stops being fun.
      </p>
    </div>

    <!-- Patch notes -->
    <h2 style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#00C8D4;margin:0 0 14px;padding-bottom:6px;border-bottom:1px solid #0e2a2e">Patch Notes — v254</h2>

    <!-- Added -->
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#4ade80;margin-bottom:8px">Added</div>
      <ul style="margin:0;padding-left:18px;list-style:disc">
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">DOEY the Doughman — now available to chat with</li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">Hangman wins now award <strong style="color:#c8e8ea">5–20 coins</strong> based on word length, with a visible "+X coins!" popup</li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">Hangman and Tic-Tac-Toe now <strong style="color:#c8e8ea">survive page reloads</strong> — your game picks up right where you left off</li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">Hangman words now range from <strong style="color:#c8e8ea">3 to 11+ letters</strong> with varying difficulty</li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">Usage panel now warns you if you're on pace to <strong style="color:#c8e8ea">hit your session limit early</strong></li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;">Custom character creation — build and chat with your own characters</li>
      </ul>
    </div>

    <!-- Fixed -->
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#facc15;margin-bottom:8px">Fixed</div>
      <ul style="margin:0;padding-left:18px;list-style:disc">
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">Hangman no longer shows wrong guesses as letters below the word — the keyboard highlights them instead</li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;">Coin display now updates correctly after a win even when the usage panel hasn't loaded yet</li>
      </ul>
    </div>

    <!-- Changed -->
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#60a5fa;margin-bottom:8px">Changed</div>
      <ul style="margin:0;padding-left:18px;list-style:disc">
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">5-minute cooldown between games has been <strong style="color:#c8e8ea">removed</strong> — play back-to-back</li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;margin-bottom:4px">Free accounts now get <strong style="color:#c8e8ea">~7 messages per session</strong> (up from ~4)</li>
        <li style="font-size:13px;color:#a8d8dc;line-height:1.75;">Paid tiers now use exact token multipliers — X20 is a true 20× free, no rounding</li>
      </ul>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin:8px 0 4px">
      <a href="${SITE_URL}" style="display:inline-block;background:linear-gradient(135deg,#007A85,#00C8D4);color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.5px;border:1px solid rgba(0,200,212,0.4)">Chat with DOEY →</a>
    </div>

  </div>

  <!-- Footer -->
  <div style="background:#050e0f;padding:20px 32px;text-align:center;border-top:1px solid #0e2a2e">
    <p style="margin:0;font-size:12px;color:#3a7880">Character Mind · You're receiving this because you have an account.<br>This is a no-reply address — questions? <a href="mailto:support.charactermind@gmail.com" style="color:#00C8D4;text-decoration:none">support.charactermind@gmail.com</a></p>
  </div>

</div>
`.trim();

const EMAIL_TEXT = `CHARACTER MIND — Character Drop · Oct 2026

DOEY has joined the Chat.

DOEY the Doughman is now live on Character Mind with his full personality from Poppy Playtime. He's warm, enthusiastic, a little overwhelming — and exactly who you think he is. Bring up food. Bring up the factory. See what happens.

--- PATCH NOTES v254 ---

ADDED
- DOEY the Doughman — now available to chat with
- Hangman wins now award 5-20 coins based on word length, with a visible popup
- Hangman and Tic-Tac-Toe survive page reloads — game picks up where you left off
- Hangman words now range from 3 to 11+ letters with varying difficulty
- Usage panel warns you if you're on pace to hit your session limit early
- Custom character creation — build your own characters

FIXED
- Hangman no longer shows wrong guesses as letters below the word
- Coin display updates correctly after a win even when usage panel hasn't loaded

CHANGED
- 5-minute cooldown between games removed — play back-to-back
- Free accounts now get ~7 messages per session (up from ~4)
- Paid tiers use exact token multipliers — X20 is a true 20x free

Open Character Mind: ${SITE_URL}

— Character Mind`;

async function send(to) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Character Mind (no-reply) <onboarding@resend.dev>',
      to: [to],
      subject: 'DOEY has joined the Chat — Character Mind',
      text: EMAIL_TEXT,
      html: EMAIL_HTML,
    })
  });
  if (!res.ok) throw new Error(await res.text());
  console.log('Sent to', to);
}

async function main() {
  if (!RESEND_API_KEY) { console.error('RESEND_API_KEY not set'); process.exit(1); }

  if (TEST_ONLY) {
    console.log('TEST MODE — sending to owner only');
    await send('davey2525727@gmail.com');
  } else {
    console.log('SENDING TO ALL USERS...');
    const { rows } = await db.query(`SELECT DISTINCT email FROM users WHERE email IS NOT NULL AND email != ''`);
    console.log(`Found ${rows.length} users`);
    for (const row of rows) {
      try {
        await send(row.email);
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        console.error('Failed for', row.email, ':', e.message);
      }
    }
  }

  db.end();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
