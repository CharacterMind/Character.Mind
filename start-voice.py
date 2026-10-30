"""
start-voice.py — run Poppy's voice on your PC, auto-connects to Character.Mind.

Usage:  python start-voice.py

What it does:
  1. Installs Python requirements (once)
  2. Starts tts_server/tts_server.py (loads the voice model)
  3. Downloads cloudflared.exe if needed (free, no account)
  4. Opens a free HTTPS tunnel to localhost:8765
  5. Registers the tunnel URL with charactermind.onrender.com automatically

Keep this window open while you use Character.Mind.
Poppy's cloned voice will be active. Close the window to stop.
"""

import subprocess, time, urllib.request, urllib.error, json, sys, re, os, shutil, threading

SITE_URL   = "https://charactermind.onrender.com"
TTS_PORT   = 8765
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def pip_install():
    req = os.path.join(SCRIPT_DIR, "tts_server", "requirements.txt")
    if not os.path.exists(req):
        print("  [skip] tts_server/requirements.txt not found — skipping pip install")
        return
    print("  Installing/verifying Python packages (may take a minute the first time)...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", req], check=False)

def wait_for_health(port, timeout=180):
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except Exception:
            sys.stdout.write(".")
            sys.stdout.flush()
            time.sleep(2)
    return False

def get_cloudflared():
    exe = os.path.join(SCRIPT_DIR, "cloudflared.exe")
    if os.path.exists(exe):
        return exe
    if shutil.which("cloudflared"):
        return "cloudflared"
    print("  Downloading cloudflared (free tunnel tool, ~30 MB)...")
    dl_url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    try:
        urllib.request.urlretrieve(dl_url, exe)
        print("  Done.")
        return exe
    except Exception as e:
        print(f"  ERROR downloading cloudflared: {e}")
        print("  Download manually: https://github.com/cloudflare/cloudflared/releases")
        sys.exit(1)

def register_url(tunnel_url):
    payload = json.dumps({"url": tunnel_url}).encode()
    req = urllib.request.Request(
        f"{SITE_URL}/api/tts/announce",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=15)
    return json.loads(resp.read())

# ── main ─────────────────────────────────────────────────────────────────────

print()
print("╔══════════════════════════════════════════════════╗")
print("║   Character.Mind — Poppy Voice Server            ║")
print("╚══════════════════════════════════════════════════╝")
print()

# 1. Install requirements
print("[1/4] Checking Python packages...")
pip_install()
print("  OK")

# 2. Start tts_server
tts_script = os.path.join(SCRIPT_DIR, "tts_server", "tts_server.py")
if not os.path.exists(tts_script):
    print(f"ERROR: {tts_script} not found. Is this the Character.Mind folder?")
    sys.exit(1)

print("[2/4] Starting voice model (first load ~30s, later loads ~5s)...")
tts_proc = subprocess.Popen(
    [sys.executable, tts_script],
    cwd=os.path.join(SCRIPT_DIR, "tts_server"),
    env={**os.environ, "TTS_PORT": str(TTS_PORT)},
)
print(f"  Waiting for model to be ready", end="", flush=True)
if not wait_for_health(TTS_PORT):
    print("\n  ERROR: voice model did not start in time.")
    tts_proc.terminate()
    sys.exit(1)
print("\n  Voice model ready!")

# 3. Get cloudflared
print("[3/4] Setting up tunnel...")
cf_exe = get_cloudflared()

# 4. Start tunnel and capture URL
print("[4/4] Starting free HTTPS tunnel (no account needed)...")
cf_proc = subprocess.Popen(
    [cf_exe, "tunnel", "--url", f"http://localhost:{TTS_PORT}"],
    stderr=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)

tunnel_url = None
for line in cf_proc.stderr:
    line = line.strip()
    if line:
        print(f"  cloudflared: {line}")
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if m:
        tunnel_url = m.group(0)
        break

if not tunnel_url:
    print("  ERROR: could not find tunnel URL in cloudflared output.")
    cf_proc.terminate()
    tts_proc.terminate()
    sys.exit(1)

print()
print(f"  Tunnel URL: {tunnel_url}")

print()
print("═══════════════════════════════════════════════════")
print("  Poppy's cloned voice is active.                 ")
print("  Keep this window open while using Character.Mind.")
print("  Press Ctrl+C to stop.                           ")
print("═══════════════════════════════════════════════════")

# Register with Character.Mind in a background thread (retries until it works).
# This handles Render being in the middle of a deploy when the script first runs.
_registered = threading.Event()
def _register_loop():
    for attempt in range(1, 31):  # try for up to ~15 minutes
        try:
            result = register_url(tunnel_url)
            print(f"\n  ✓ Poppy's voice registered with Character.Mind! (attempt {attempt})")
            _registered.set()
            return
        except Exception as e:
            if attempt == 1:
                print(f"\n  Render may still be deploying — retrying in background (attempt {attempt})...")
        time.sleep(30)
    print(f"\n  Could not auto-register after 30 attempts.")
    print(f"  Manual fallback: set TTS_CLONE_URL={tunnel_url} on Render.")

reg_thread = threading.Thread(target=_register_loop, daemon=True)
reg_thread.start()

# Keep tailing cloudflared output so the window stays informative
try:
    for line in cf_proc.stderr:
        pass  # drain stderr so the process doesn't block
    cf_proc.wait()
except KeyboardInterrupt:
    print("\nStopping...")
finally:
    cf_proc.terminate()
    tts_proc.terminate()
    print("Done.")
