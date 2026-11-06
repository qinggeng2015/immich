import hashlib
import json

from fastapi.testclient import TestClient
from huggingface_hub import hf_hub_download

from immich_ml.config import settings
from immich_ml.main import app
from immich_ml.models.speech.recognition import MODEL_REPOSITORY, MODEL_REVISION, SpeechRecognizer


def main() -> None:
    entries = {"speech-to-text": {"transcription": {"modelName": "SenseVoiceSmall"}}}
    with TestClient(app) as client:
        for language in ("zh", "en"):
            fixture = hf_hub_download(
                MODEL_REPOSITORY,
                f"test_wavs/{language}.wav",
                revision=MODEL_REVISION,
                cache_dir=settings.cache_folder / "speech-fixtures",
            )
            with open(fixture, "rb") as audio:
                response = client.post("/predict", data={"entries": json.dumps(entries)}, files={"audio": audio})
            response.raise_for_status()
            result = response.json()["speech-to-text"]
            assert result["language"] == language, result
            assert len(result["text"].strip()) > 2, result
            assert ("开放时间" if language == "zh" else "tribal chieftain") in result["text"], result
            assert len(result["segments"]) == 1, result
            assert result["segments"][0]["startMs"] == 0
            assert 0 < result["segments"][0]["endMs"] <= 30000
            print(json.dumps({"fixture": language, **result}, ensure_ascii=False))
    path = SpeechRecognizer("SenseVoiceSmall").model_path
    with path.open("rb") as model:
        digest = hashlib.file_digest(model, "sha256").hexdigest()
    assert digest == "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51", digest
    print(json.dumps({"model": str(path), "sha256": digest, "revision": MODEL_REVISION}))


if __name__ == "__main__":
    main()
