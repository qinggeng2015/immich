import io
import wave

import numpy as np

from immich_ml.schemas import AudioInput

SAMPLE_RATE = 16000
MAX_SAMPLES = SAMPLE_RATE * 30
MAX_AUDIO_BYTES = MAX_SAMPLES * 2 + 4096


def decode_audio(payload: bytes) -> AudioInput:
    if len(payload) > MAX_AUDIO_BYTES:
        raise ValueError("Audio exceeds the 30 second request limit")
    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != SAMPLE_RATE:
                raise ValueError("Audio must be mono 16 kHz PCM16 WAV")
            frames = source.getnframes()
            if not 0 < frames <= MAX_SAMPLES:
                raise ValueError("Audio must contain between one sample and 30 seconds")
            samples = source.readframes(frames)
            if len(samples) != frames * 2:
                raise ValueError("Audio data is truncated")
    except (wave.Error, EOFError) as error:
        raise ValueError("Invalid PCM WAV audio") from error
    return AudioInput(np.frombuffer(samples, dtype="<i2").astype(np.float32) / np.float32(32768))
