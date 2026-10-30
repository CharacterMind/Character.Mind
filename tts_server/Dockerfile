FROM python:3.11-slim

WORKDIR /app

# Install system deps for audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tts_server.py .

# HF Spaces requires port 7860 and 0.0.0.0
ENV TTS_PORT=7860
ENV TTS_HOST=0.0.0.0
ENV TTS_MODEL=your_tts

EXPOSE 7860

CMD ["python", "tts_server.py"]
