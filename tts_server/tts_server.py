"""
Character.Mind local voice-clone TTS server.
Uses Coqui XTTS-v2 to synthesize text in a speaker's cloned voice.

Setup (one time):
  pip install -r requirements.txt

First run downloads the XTTS-v2 model (~1.8 GB) automatically.
GPU strongly recommended for real-time use; CPU works but is slow (~20-60s/sentence).

Run:
  python tts_server.py
  -- or on Windows double-click start.bat --

Node server calls http://localhost:8765/tts with:
  POST { "text": "...", "speaker_wav": "absolute/path/to/voice.wav", "language": "en" }
Returns audio/wav.
"""

import io
import os
import sys
import tempfile
import threading
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)
_tts = None
_lock = threading.Lock()   # XTTS is not thread-safe; serialize requests

def get_tts():
    global _tts
    if _tts is None:
        from TTS.api import TTS
        print("[tts_server] Loading XTTS-v2 model (first run downloads ~1.8 GB)...", flush=True)
        _tts = TTS(model_name="tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
        # Try GPU if available
        try:
            import torch
            if torch.cuda.is_available():
                _tts = TTS(model_name="tts_models/multilingual/multi-dataset/xtts_v2", gpu=True)
                print("[tts_server] GPU detected — using CUDA.", flush=True)
        except Exception:
            pass
        print("[tts_server] Model ready.", flush=True)
    return _tts


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "model": "xtts_v2"})


@app.route("/tts", methods=["POST"])
def tts_endpoint():
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    speaker_wav = (data.get("speaker_wav") or "").strip()
    language = (data.get("language") or "en").strip()

    if not text:
        return jsonify({"error": "missing text"}), 400
    if not speaker_wav or not os.path.isfile(speaker_wav):
        return jsonify({"error": f"speaker_wav not found: {speaker_wav}"}), 400

    # Clamp text length — XTTS degrades on very long inputs
    text = text[:400]

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
            print(f"[tts_server] synthesis error: {e}", flush=True)
            return jsonify({"error": str(e)}), 500
        finally:
            try:
                os.unlink(out_path)
            except OSError:
                pass

    return send_file(
        io.BytesIO(audio_bytes),
        mimetype="audio/wav",
        as_attachment=False,
    )


if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "8765"))
    # Pre-load the model so the first TTS request isn't slow
    try:
        get_tts()
    except Exception as e:
        print(f"[tts_server] WARNING: model failed to load: {e}", flush=True)
        print("[tts_server] Server will still start; requests will retry model load.", flush=True)
    print(f"[tts_server] Listening on http://127.0.0.1:{port}", flush=True)
    app.run(host="127.0.0.1", port=port, threaded=False, use_reloader=False)
