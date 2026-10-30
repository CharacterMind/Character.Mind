"""
Character.Mind Voice AI — free, local voice cloning service.
Default model: YourTTS (~400 MB, faster on CPU, fits in less RAM).
Override with TTS_MODEL=xtts_v2 env var for higher quality (needs ~2 GB RAM + GPU recommended).

Setup (one time):
  pip install -r requirements.txt
  -- first run downloads the model (~400 MB for YourTTS, ~1.8 GB for xtts_v2) --

Run:
  python tts_server.py              (port 8765)
  TTS_PORT=9000 python tts_server.py
  TTS_MODEL=xtts_v2 python tts_server.py   (use XTTS-v2 if you have enough RAM/GPU)
  -- or double-click start.bat on Windows --

Character.Mind server.js calls this at:
  http://127.0.0.1:8765/tts
  (override with TTS_CLONE_URL env var in Character.Mind's .env)

REST API
--------
GET  /health                          -> { ok, model, gpu, voices_dir, voices: [...] }
GET  /voices                          -> [ { id, name, file, size_kb } ]
POST /voices          multipart/form-data  field "file" (.wav) + optional "name"
                                      -> { id, name, file }
POST /tts             application/json
     { text, speaker_wav, language? } -> audio/wav
     { text, voice_id, language? }    -> audio/wav  (use id from /voices)
DELETE /voices/<id>                   -> { ok }
"""

import io
import os
import sys
import uuid
import shutil
import tempfile
import threading
import time
from pathlib import Path

# Store XTTS-v2 model in the tts_server folder, not deep in AppData
os.environ.setdefault("TTS_HOME", str(Path(__file__).resolve().parent / "model"))

def _patch_torchaudio_load():
    """torchaudio 2.9+ routes torchaudio.load through torchcodec, which needs FFmpeg.
    If FFmpeg is absent (typical Windows dev setup), substitute a soundfile-based loader."""
    try:
        import soundfile as sf
        import torch
        import torchaudio

        _orig = torchaudio.load

        def _sf_load(uri, frame_offset=0, num_frames=-1, normalize=True, channels_first=True, **kwargs):
            try:
                # soundfile accepts paths and file-like objects directly
                data, sr = sf.read(uri, dtype='float32', always_2d=True)
            except Exception:
                # Non-WAV or truly unreadable — nothing we can do without FFmpeg
                raise
            # soundfile: (samples, channels) → torchaudio: (channels, samples) when channels_first
            if channels_first:
                waveform = torch.from_numpy(data.T)
                if frame_offset > 0:
                    waveform = waveform[:, frame_offset:]
                if num_frames > 0:
                    waveform = waveform[:, :num_frames]
            else:
                waveform = torch.from_numpy(data)
                if frame_offset > 0:
                    waveform = waveform[frame_offset:]
                if num_frames > 0:
                    waveform = waveform[:num_frames]
            return waveform, int(sr)

        torchaudio.load = _sf_load
    except Exception as e:
        print(f"[voice-ai] torchaudio patch skipped: {e}", flush=True)

_patch_torchaudio_load()

from flask import Flask, request, send_file, jsonify
from werkzeug.utils import secure_filename

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR  = Path(__file__).resolve().parent
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)

# Seed VOICES_DIR with any .wav files already in BASE_DIR (backward-compat)
for _old in BASE_DIR.glob("*.wav"):
    _dst = VOICES_DIR / _old.name
    if not _dst.exists():
        shutil.copy2(_old, _dst)

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app  = Flask(__name__)
_tts       = None
_lock      = threading.Lock()   # TTS models are NOT thread-safe
_gpu       = False
# YourTTS is the default: ~400 MB, works on CPU in 2-5s.
# Set TTS_MODEL=xtts_v2 for higher quality (needs ~2 GB RAM, GPU recommended).
_MODEL_KEY = os.environ.get("TTS_MODEL", "your_tts").lower()
_MODEL_NAMES = {
    "your_tts": "tts_models/multilingual/multi-dataset/your_tts",
    "xtts_v2":  "tts_models/multilingual/multi-dataset/xtts_v2",
}

ALLOWED_EXT = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
MAX_TEXT_CHARS = 500       # XTTS degrades on very long inputs

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
def _load_model():
    global _tts, _gpu
    import torch
    # PyTorch 2.6+ changed weights_only default to True, which breaks model loading.
    _orig_torch_load = torch.load
    def _patched_load(*args, **kwargs):
        kwargs.setdefault('weights_only', False)
        return _orig_torch_load(*args, **kwargs)
    torch.load = _patched_load
    from TTS.api import TTS
    use_gpu = torch.cuda.is_available()
    model_name = _MODEL_NAMES.get(_MODEL_KEY, _MODEL_NAMES["your_tts"])
    size_hint = "~1.8 GB" if "xtts" in model_name else "~400 MB"
    device_label = "GPU" if use_gpu else "CPU"
    if use_gpu:
        gpu_name = torch.cuda.get_device_name(0)
        vram_gb  = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1)
        print(f"[voice-ai] GPU: {gpu_name} ({vram_gb} GB VRAM)", flush=True)
    else:
        print(f"[voice-ai] No GPU — using CPU (synthesis: 2-5s for YourTTS, 30-90s for XTTS)", flush=True)
    print(f"[voice-ai] Loading {model_name} (first run downloads {size_hint})...", flush=True)
    _tts = TTS(model_name=model_name, gpu=use_gpu)
    _gpu = use_gpu
    print(f"[voice-ai] Model ready on {device_label}.", flush=True)
    return _tts

def get_tts():
    global _tts
    if _tts is None:
        _load_model()
    return _tts

# ---------------------------------------------------------------------------
# Voice helpers
# ---------------------------------------------------------------------------
def _voice_id(filename: str) -> str:
    """Stable ID from filename stem."""
    return Path(filename).stem.lower().replace(" ", "_")

def _list_voices():
    voices = []
    for f in sorted(VOICES_DIR.iterdir()):
        if f.suffix.lower() in ALLOWED_EXT:
            voices.append({
                "id":      _voice_id(f.name),
                "name":    f.stem.replace("_", " ").title(),
                "file":    str(f.resolve()),
                "size_kb": round(f.stat().st_size / 1024, 1),
            })
    return voices

def _find_voice(voice_id: str):
    """Return absolute path for a voice id, or None."""
    for v in _list_voices():
        if v["id"] == voice_id.lower():
            return v["file"]
    return None

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/health", methods=["GET"])
def health():
    model_loaded = _tts is not None
    return jsonify({
        "ok":          True,
        "model":       _MODEL_KEY,
        "model_ready": model_loaded,
        "gpu":         _gpu,
        "voices_dir":  str(VOICES_DIR),
        "voices":      _list_voices(),
    })


@app.route("/voices", methods=["GET"])
def list_voices():
    return jsonify(_list_voices())


@app.route("/voices", methods=["POST"])
def upload_voice():
    """Upload a .wav (or other audio) file as a new voice sample."""
    if "file" not in request.files:
        return jsonify({"error": "no file field"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400
    ext = Path(f.filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        return jsonify({"error": f"unsupported format {ext}; use one of {ALLOWED_EXT}"}), 400

    custom_name = (request.form.get("name") or "").strip()
    if custom_name:
        stem = secure_filename(custom_name.replace(" ", "_").lower())
    else:
        stem = secure_filename(Path(f.filename).stem)

    dest = VOICES_DIR / f"{stem}{ext}"
    # Avoid overwriting; add suffix if needed
    if dest.exists():
        dest = VOICES_DIR / f"{stem}_{uuid.uuid4().hex[:6]}{ext}"

    f.save(dest)
    vid = _voice_id(dest.name)
    print(f"[voice-ai] Voice uploaded: {dest.name} (id={vid})", flush=True)
    return jsonify({"id": vid, "name": dest.stem.replace("_", " ").title(), "file": str(dest.resolve())}), 201


@app.route("/voices/<voice_id>", methods=["DELETE"])
def delete_voice(voice_id):
    path = _find_voice(voice_id)
    if not path:
        return jsonify({"error": "voice not found"}), 404
    p = Path(path)
    # Safety: only delete files inside our VOICES_DIR
    try:
        p.relative_to(VOICES_DIR)
    except ValueError:
        return jsonify({"error": "will not delete files outside voices dir"}), 403
    backup = VOICES_DIR / f"_deleted_{p.name}"
    p.rename(backup)
    print(f"[voice-ai] Voice deleted (backed up to {backup.name})", flush=True)
    return jsonify({"ok": True, "backup": str(backup)})


@app.route("/tts", methods=["POST"])
def tts_endpoint():
    data = request.get_json(force=True, silent=True) or {}
    text        = (data.get("text")        or "").strip()
    speaker_wav = (data.get("speaker_wav") or "").strip()
    voice_id    = (data.get("voice_id")    or "").strip()
    language    = (data.get("language")    or "en").strip()
    # YourTTS uses "en-us" not "en" — normalise so the server call doesn't need to know the model
    if language == "en" and _MODEL_KEY == "your_tts":
        language = "en-us"

    if not text:
        return jsonify({"error": "missing text"}), 400

    # Resolve speaker file
    if voice_id:
        speaker_wav = _find_voice(voice_id) or speaker_wav

    # Accept a bare filename inside voices dir as a convenience
    if speaker_wav and not os.path.isabs(speaker_wav):
        candidate = VOICES_DIR / speaker_wav
        if candidate.exists():
            speaker_wav = str(candidate)

    if not speaker_wav or not os.path.isfile(speaker_wav):
        return jsonify({"error": f"speaker voice not found: '{voice_id or speaker_wav}'"}), 400

    text = text[:MAX_TEXT_CHARS]

    t0 = time.time()
    with _lock:
        model = get_tts()
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        out_path = tmp.name
        try:
            model.tts_to_file(
                text=text,
                speaker_wav=speaker_wav,
                language=language,
                file_path=out_path,
            )
            with open(out_path, "rb") as f:
                audio_bytes = f.read()
        except Exception as e:
            print(f"[voice-ai] synthesis error: {e}", flush=True)
            return jsonify({"error": str(e)}), 500
        finally:
            try:
                os.unlink(out_path)
            except OSError:
                pass

    elapsed = round(time.time() - t0, 2)
    print(f"[voice-ai] synthesized {len(text)} chars in {elapsed}s (voice={Path(speaker_wav).stem})", flush=True)

    resp = send_file(io.BytesIO(audio_bytes), mimetype="audio/wav", as_attachment=False)
    resp.headers["X-Synthesis-Time"] = str(elapsed)
    resp.headers["X-TTS-Provider"]   = "character-clone"
    return resp


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "8765"))
    host = os.environ.get("TTS_HOST", "127.0.0.1")

    print("=" * 60, flush=True)
    print(" Character.Mind Voice AI", flush=True)
    print(f" Free local voice cloning — model: {_MODEL_KEY}", flush=True)
    print(f" Voices directory: {VOICES_DIR}", flush=True)
    print(f" Listening on http://{host}:{port}", flush=True)
    print("=" * 60, flush=True)

    # Pre-load model so the first request isn't slow
    try:
        get_tts()
    except Exception as e:
        print(f"[voice-ai] WARNING: model failed to pre-load: {e}", flush=True)
        print("[voice-ai] Server will start anyway; requests will retry model load.", flush=True)

    app.run(host=host, port=port, threaded=False, use_reloader=False)
