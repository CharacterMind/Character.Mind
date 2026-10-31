"""
Character.Mind Voice AI — free, local voice cloning service.
Default model: F5-TTS (zero-shot voice cloning, ~1.2 GB, GPU recommended).
Override with TTS_MODEL=xtts_v2 env var for XTTS-v2 (needs ~2 GB RAM + GPU).

Setup (one time):
  pip install -r requirements.txt
  -- first run downloads the model --

Run:
  python tts_server.py              (port 8765)
  TTS_PORT=9000 python tts_server.py
  TTS_MODEL=xtts_v2 python tts_server.py   (use XTTS-v2 instead of F5-TTS)
  -- or double-click start.bat on Windows --

Voice reference transcriptions:
  For each voices/name.wav, create voices/name.txt with the transcript.
  This avoids Whisper ASR on every F5-TTS request (saves ~2s per request).

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
     { text, speaker_wav, language? }            -> audio/wav  (F5-TTS or XTTS)
     { text, voice_id, language? }               -> audio/wav  (use id from /voices)
     { text, voice_id, tts_engine: "f5tts" }     -> audio/wav  (force F5-TTS)
     { text, voice_id, tts_engine: "xtts" }      -> audio/wav  (force XTTS-v2)
     { text, kokoro_voice: "af_bella", ... }      -> audio/wav  (Kokoro preset voice)
DELETE /voices/<id>                   -> { ok }
"""

import contextlib
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

# ---------------------------------------------------------------------------
# Kokoro ONNX — lightweight local TTS, no speaker sample needed
# ---------------------------------------------------------------------------
_kokoro       = None
_kokoro_lock  = threading.Lock()
_KOKORO_DIR   = Path(__file__).resolve().parent / "model" / "kokoro"
_KOKORO_ONNX  = _KOKORO_DIR / "kokoro-v1.0.onnx"
_KOKORO_VOICES = _KOKORO_DIR / "voices-v1.0.bin"

KOKORO_VOICE_LIST = [
    {"id": "af_bella",   "name": "Bella",   "accent": "American", "gender": "F"},
    {"id": "af_heart",   "name": "Heart",   "accent": "American", "gender": "F"},
    {"id": "af_nicole",  "name": "Nicole",  "accent": "American", "gender": "F"},
    {"id": "af_sky",     "name": "Sky",     "accent": "American", "gender": "F"},
    {"id": "af_sarah",   "name": "Sarah",   "accent": "American", "gender": "F"},
    {"id": "am_adam",    "name": "Adam",    "accent": "American", "gender": "M"},
    {"id": "am_michael", "name": "Michael", "accent": "American", "gender": "M"},
    {"id": "bf_emma",    "name": "Emma",    "accent": "British",  "gender": "F"},
    {"id": "bf_isabella","name": "Isabella","accent": "British",  "gender": "F"},
    {"id": "bm_george",  "name": "George",  "accent": "British",  "gender": "M"},
    {"id": "bm_lewis",   "name": "Lewis",   "accent": "British",  "gender": "M"},
]

def _kokoro_available():
    return _KOKORO_ONNX.exists() and _KOKORO_VOICES.exists()

def get_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    if not _kokoro_available():
        return None
    with _kokoro_lock:
        if _kokoro is None:
            from kokoro_onnx import Kokoro as _K
            _kokoro = _K(str(_KOKORO_ONNX), str(_KOKORO_VOICES))
            print(f"[voice-ai] Kokoro loaded ({len(_kokoro.get_voices())} voices)", flush=True)
    return _kokoro

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

# ---------------------------------------------------------------------------
# F5-TTS — zero-shot voice cloning using real reference audio
# ---------------------------------------------------------------------------
_f5tts      = None
_f5tts_lock = threading.Lock()

def get_f5tts():
    global _f5tts
    if _f5tts is not None:
        return _f5tts
    with _f5tts_lock:
        if _f5tts is None:
            from f5_tts.api import F5TTS
            _f5tts = F5TTS()
            print("[voice-ai] F5-TTS loaded", flush=True)
    return _f5tts

def _f5tts_ref_text(voice_wav_path: str) -> str:
    """Load sidecar .txt transcript for a voice wav, or return '' for auto-ASR."""
    txt = Path(voice_wav_path).with_suffix(".txt")
    if txt.exists():
        return txt.read_text(encoding="utf-8").strip()
    return ""

# ---------------------------------------------------------------------------
# KokoClone — Kokoro-ONNX TTS + Kanade zero-shot voice conversion
# ---------------------------------------------------------------------------
_kokoclone      = None
_kokoclone_lock = threading.Lock()
_KOKOCLONE_DIR  = Path(__file__).resolve().parent / "kokoclone"

def get_kokoclone():
    global _kokoclone
    if _kokoclone is not None:
        return _kokoclone
    with _kokoclone_lock:
        if _kokoclone is None:
            import sys as _sys
            if str(_KOKOCLONE_DIR) not in _sys.path:
                _sys.path.insert(0, str(_KOKOCLONE_DIR))
            from core.cloner import KokoClone as _KC
            _kokoclone = _KC()
            print("[voice-ai] KokoClone loaded", flush=True)
    return _kokoclone

# ---------------------------------------------------------------------------
# Chatterbox TTS — ResembleAI, MIT license, #1 free zero-shot cloner 2025
# ---------------------------------------------------------------------------
_chatterbox      = None
_chatterbox_lock = threading.Lock()
_last_chatterbox_voice = None  # path of the last prepared speaker wav

def get_chatterbox():
    global _chatterbox
    if _chatterbox is not None:
        return _chatterbox
    with _chatterbox_lock:
        if _chatterbox is None:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            print(f"[voice-ai] Loading Chatterbox TTS on {device.upper()}...", flush=True)
            from chatterbox.tts import ChatterboxTTS
            _chatterbox = ChatterboxTTS.from_pretrained(device=device)
            if device == "cuda":
                torch.cuda.empty_cache()
                used = round(torch.cuda.memory_allocated() / 1e9, 2)
                print(f"[voice-ai] VRAM after load: {used} GB", flush=True)
            print(f"[voice-ai] Chatterbox TTS ready on {device.upper()}", flush=True)
    return _chatterbox

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

# ---------------------------------------------------------------------------
# LRU audio cache — avoids re-synthesising repeated phrases (instant on hit)
# ---------------------------------------------------------------------------
_audio_cache: dict = {}
_AUDIO_CACHE_MAX = 80

def _cache_key(engine: str, speaker_stem: str, text: str) -> str:
    return f"{engine}:{speaker_stem}:{text[:120]}"

def _cache_get(key: str):
    val = _audio_cache.pop(key, None)
    if val is not None:
        _audio_cache[key] = val  # move to end (LRU order)
    return val

def _cache_set(key: str, data: bytes):
    _audio_cache.pop(key, None)
    _audio_cache[key] = data
    while len(_audio_cache) > _AUDIO_CACHE_MAX:
        _audio_cache.pop(next(iter(_audio_cache)))
# YourTTS is the default: ~400 MB, works on CPU in 2-5s.
# Set TTS_MODEL=xtts_v2 for higher quality (needs ~2 GB RAM, GPU recommended).
_MODEL_KEY = os.environ.get("TTS_MODEL", "f5tts").lower()  # f5tts | chatterbox | kokoclone | xtts_v2 | your_tts
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
    model_loaded = (_chatterbox is not None) if _MODEL_KEY == 'chatterbox' else (_tts is not None)
    return jsonify({
        "ok":          True,
        "model":       _MODEL_KEY,
        "model_ready": model_loaded,
        "gpu":         _gpu,
        "voices_dir":  str(VOICES_DIR),
        "voices":      _list_voices(),
        "kokoro": {
            "available": _kokoro_available(),
            "loaded":    _kokoro is not None,
            "voices":    KOKORO_VOICE_LIST,
        },
        "f5tts": {
            "loaded": _f5tts is not None,
            "is_default": _MODEL_KEY == "f5tts",
        },
        "kokoclone": {
            "available": _KOKOCLONE_DIR.exists(),
            "loaded": _kokoclone is not None,
            "is_default": _MODEL_KEY == "kokoclone",
        },
        "chatterbox": {
            "loaded": _chatterbox is not None,
            "is_default": _MODEL_KEY == "chatterbox",
        },
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
    text         = (data.get("text")        or "").strip()
    speaker_wav  = (data.get("speaker_wav") or "").strip()
    voice_id     = (data.get("voice_id")    or "").strip()
    language     = (data.get("language")    or "en").strip()
    kokoro_voice = (data.get("kokoro_voice") or "").strip()
    tts_engine   = (data.get("tts_engine")  or _MODEL_KEY).lower()
    # YourTTS accepts "en" directly (not "en-us")
    if language == "en-us" and _MODEL_KEY == "your_tts":
        language = "en"

    if not text:
        return jsonify({"error": "missing text"}), 400

    # Kokoro path — synthesize with a named voice style, no speaker sample needed
    if kokoro_voice:
        import numpy as np
        import wave
        kok = get_kokoro()
        if kok is None:
            return jsonify({"error": "Kokoro model not installed — download model files first"}), 503
        valid_ids = {v["id"] for v in KOKORO_VOICE_LIST}
        if kokoro_voice not in valid_ids:
            kokoro_voice = "af_bella"
        text = text[:MAX_TEXT_CHARS]
        t0 = time.time()
        try:
            samples, sr = kok.create(text, voice=kokoro_voice, speed=1.0, lang="en-us")
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm.tobytes())
        elapsed = round(time.time() - t0, 2)
        print(f"[voice-ai] kokoro {len(text)} chars in {elapsed}s (voice={kokoro_voice})", flush=True)
        resp = send_file(io.BytesIO(buf.getvalue()), mimetype="audio/wav", as_attachment=False)
        resp.headers["X-Synthesis-Time"] = str(elapsed)
        resp.headers["X-TTS-Provider"]   = "kokoro"
        return resp

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

    # F5-TTS path — zero-shot voice cloning (default engine)
    if tts_engine in ("f5tts", "f5-tts"):
        import numpy as np
        import soundfile as sf_lib
        ck = _cache_key("f5tts", Path(speaker_wav).stem, text)
        cached = _cache_get(ck)
        if cached:
            print(f"[voice-ai] f5tts cache hit ({len(text)} chars, voice={Path(speaker_wav).stem})", flush=True)
            resp = send_file(io.BytesIO(cached), mimetype="audio/wav", as_attachment=False)
            resp.headers["X-Synthesis-Time"] = "0"
            resp.headers["X-TTS-Provider"]   = "f5tts-cache"
            return resp
        t0 = time.time()
        try:
            with _lock:
                model = get_f5tts()
                ref_text = _f5tts_ref_text(speaker_wav)
                wav, sr, _ = model.infer(
                    ref_file=speaker_wav,
                    ref_text=ref_text,
                    gen_text=text,
                    seed=-1,
                    nfe_step=16,
                )
        except Exception as e:
            print(f"[voice-ai] F5-TTS error: {e}", flush=True)
            return jsonify({"error": str(e)}), 500
        buf = io.BytesIO()
        sf_lib.write(buf, wav, sr, format="WAV")
        audio_bytes = buf.getvalue()
        _cache_set(ck, audio_bytes)
        try:
            import torch
            if torch.cuda.is_available(): torch.cuda.empty_cache()
        except Exception: pass
        elapsed = round(time.time() - t0, 2)
        print(f"[voice-ai] f5tts {len(text)} chars in {elapsed}s (voice={Path(speaker_wav).stem})", flush=True)
        resp = send_file(io.BytesIO(audio_bytes), mimetype="audio/wav", as_attachment=False)
        resp.headers["X-Synthesis-Time"] = str(elapsed)
        resp.headers["X-TTS-Provider"]   = "f5tts"
        return resp

    # KokoClone path — Kokoro TTS + Kanade zero-shot voice conversion
    if tts_engine in ("kokoclone", "koko"):
        ck = _cache_key("kokoclone", Path(speaker_wav).stem, text)
        cached = _cache_get(ck)
        if cached:
            print(f"[voice-ai] kokoclone cache hit ({len(text)} chars, voice={Path(speaker_wav).stem})", flush=True)
            resp = send_file(io.BytesIO(cached), mimetype="audio/wav", as_attachment=False)
            resp.headers["X-Synthesis-Time"] = "0"
            resp.headers["X-TTS-Provider"]   = "kokoclone-cache"
            return resp
        t0 = time.time()
        tmp_out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_out.close()
        try:
            with _lock:
                model = get_kokoclone()
                model.generate(
                    text=text,
                    lang="en",
                    reference_audio=speaker_wav,
                    output_path=tmp_out.name,
                )
            with open(tmp_out.name, "rb") as f:
                audio_bytes = f.read()
        except Exception as e:
            print(f"[voice-ai] KokoClone error: {e}", flush=True)
            return jsonify({"error": str(e)}), 500
        finally:
            try:
                os.unlink(tmp_out.name)
            except OSError:
                pass
        _cache_set(ck, audio_bytes)
        elapsed = round(time.time() - t0, 2)
        print(f"[voice-ai] kokoclone {len(text)} chars in {elapsed}s (voice={Path(speaker_wav).stem})", flush=True)
        resp = send_file(io.BytesIO(audio_bytes), mimetype="audio/wav", as_attachment=False)
        resp.headers["X-Synthesis-Time"] = str(elapsed)
        resp.headers["X-TTS-Provider"]   = "kokoclone"
        return resp

    # Chatterbox TTS path — ResembleAI zero-shot cloning (best free quality 2025)
    if tts_engine in ("chatterbox",):
        import torchaudio
        ck = _cache_key("chatterbox", Path(speaker_wav).stem, text)
        cached = _cache_get(ck)
        if cached:
            print(f"[voice-ai] chatterbox cache hit ({len(text)} chars)", flush=True)
            resp = send_file(io.BytesIO(cached), mimetype="audio/wav", as_attachment=False)
            resp.headers["X-Synthesis-Time"] = "0"
            resp.headers["X-TTS-Provider"]   = "chatterbox-cache"
            return resp
        t0 = time.time()
        try:
            import torch
            with _lock:
                global _last_chatterbox_voice
                model = get_chatterbox()
                _autocast = torch.autocast("cuda", dtype=torch.float16) if torch.cuda.is_available() else contextlib.nullcontext()
                with torch.inference_mode(), _autocast:
                    if speaker_wav == _last_chatterbox_voice and model.conds is not None:
                        wav = model.generate(
                            text,
                            exaggeration=0.65,
                            cfg_weight=0.4,
                            temperature=0.7,
                        )
                    else:
                        wav = model.generate(
                            text,
                            audio_prompt_path=speaker_wav,
                            exaggeration=0.65,
                            cfg_weight=0.4,
                            temperature=0.7,
                        )
                        _last_chatterbox_voice = speaker_wav
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            buf = io.BytesIO()
            torchaudio.save(buf, wav, model.sr, format="wav")
            audio_bytes = buf.getvalue()
        except Exception as e:
            import traceback
            print(f"[voice-ai] Chatterbox error: {e}", flush=True)
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500
        _cache_set(ck, audio_bytes)
        elapsed = round(time.time() - t0, 2)
        print(f"[voice-ai] chatterbox {len(text)} chars in {elapsed}s (voice={Path(speaker_wav).stem})", flush=True)
        resp = send_file(io.BytesIO(audio_bytes), mimetype="audio/wav", as_attachment=False)
        resp.headers["X-Synthesis-Time"] = str(elapsed)
        resp.headers["X-TTS-Provider"]   = "chatterbox"
        return resp

    # XTTS-v2 / YourTTS path — fallback when TTS_MODEL=xtts_v2 or tts_engine=xtts
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
                speed=1.0,
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
    print(f" Engine: {_MODEL_KEY}  |  Voices: {VOICES_DIR}", flush=True)
    print(f" Listening on http://{host}:{port}", flush=True)
    print("=" * 60, flush=True)

    # Pre-load model so the first request isn't slow
    if _MODEL_KEY == "chatterbox":
        try:
            get_chatterbox()
        except Exception as e:
            print(f"[voice-ai] WARNING: Chatterbox failed to pre-load: {e}", flush=True)
            print("[voice-ai] Server will start anyway; requests will retry model load.", flush=True)
    elif _MODEL_KEY == "kokoclone":
        try:
            model = get_kokoclone()
            # Pre-warm Kokoro ONNX (first synthesis loads it; do it now so first real request is fast)
            _prewarm_voices = [str(VOICES_DIR / "poppy.wav"), str(VOICES_DIR / "huggy.wav")]
            _prewarm_voice  = next((v for v in _prewarm_voices if os.path.exists(v)), None)
            if _prewarm_voice:
                _pw_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                _pw_tmp.close()
                try:
                    model.generate(text="Hi.", lang="en", reference_audio=_prewarm_voice, output_path=_pw_tmp.name)
                    # Store in cache so "Hi." is also instant
                    with open(_pw_tmp.name, "rb") as _f:
                        _cache_set(_cache_key("kokoclone", Path(_prewarm_voice).stem, "Hi."), _f.read())
                    print("[voice-ai] KokoClone pre-warmed (Kokoro ONNX ready)", flush=True)
                except Exception as _e:
                    print(f"[voice-ai] KokoClone pre-warm skipped: {_e}", flush=True)
                finally:
                    try: os.unlink(_pw_tmp.name)
                    except OSError: pass
        except Exception as e:
            print(f"[voice-ai] WARNING: KokoClone failed to pre-load: {e}", flush=True)
            print("[voice-ai] Server will start anyway; requests will retry model load.", flush=True)
    elif _MODEL_KEY == "f5tts":
        try:
            get_f5tts()
        except Exception as e:
            print(f"[voice-ai] WARNING: F5-TTS failed to pre-load: {e}", flush=True)
            print("[voice-ai] Server will start anyway; requests will retry model load.", flush=True)
    else:
        try:
            get_tts()
        except Exception as e:
            print(f"[voice-ai] WARNING: model failed to pre-load: {e}", flush=True)
            print("[voice-ai] Server will start anyway; requests will retry model load.", flush=True)

    # threaded=True lets Flask accept multiple connections concurrently.
    # The _lock inside each synthesis route still serializes GPU access,
    # but HTTP overhead (accepting connections, reading request bodies)
    # no longer adds to synthesis latency for queued sentences.
    app.run(host=host, port=port, threaded=True, use_reloader=False)
