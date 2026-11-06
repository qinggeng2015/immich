import re
from pathlib import Path
from typing import ClassVar

import kaldi_native_fbank as knf
import numpy as np
from huggingface_hub import snapshot_download
from numpy.typing import NDArray

from immich_ml.config import settings
from immich_ml.models.base import InferenceModel
from immich_ml.models.speech.audio import SAMPLE_RATE
from immich_ml.schemas import (
    AudioInput,
    ModelFormat,
    ModelIdentity,
    ModelSession,
    ModelSource,
    ModelTask,
    ModelType,
    Shape,
    SpeechTranscriptionOptions,
    TranscriptionOutput,
)
from immich_ml.sessions.speech import SpeechSession

MODEL_REPOSITORY = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
MODEL_REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07"
LANGUAGE_TAG = re.compile(r"<\|(zh|en|yue|ja|ko)\|>")
SPECIAL_TAG = re.compile(r"<\|[^|]+\|>")


class SpeechRecognizer(InferenceModel[SpeechTranscriptionOptions]):
    identity = (ModelType.TRANSCRIPTION, ModelTask.SPEECH_TO_TEXT)
    depends: ClassVar[list[ModelIdentity]] = []
    sources = (ModelSource.SENSEVOICE,)

    @property
    def _model_format_default(self) -> ModelFormat:
        return ModelFormat.ONNX

    @property
    def _cache_dir_default(self) -> Path:
        return settings.cache_folder / self.model_task.value / self.model_name / MODEL_REVISION

    @property
    def model_path(self) -> Path:
        return self.model_dir / "model.int8.onnx"

    @property
    def cached(self) -> bool:
        return all((self.model_dir / name).is_file() for name in ("model.int8.onnx", "tokens.txt", "LICENSE"))

    def download(self) -> None:
        if self.cached:
            return
        snapshot_download(
            MODEL_REPOSITORY,
            revision=MODEL_REVISION,
            local_dir=self.model_dir,
            allow_patterns=["model.int8.onnx", "tokens.txt", "LICENSE"],
        )
        if not self.cached:
            raise FileNotFoundError("SenseVoice model, token vocabulary or license is missing")

    def _load(self) -> ModelSession:
        session = SpeechSession(self.model_path, self.threads)
        metadata = session.get_metadata()
        if metadata.get("model_type") != "sense_voice_ctc":
            raise ValueError("Unsupported SenseVoice model graph")
        self.window_size = int(metadata["lfr_window_size"])
        self.window_shift = int(metadata["lfr_window_shift"])
        self.neg_mean = np.fromstring(metadata["neg_mean"], sep=",", dtype=np.float32)
        self.inv_stddev = np.fromstring(metadata["inv_stddev"], sep=",", dtype=np.float32)
        self.language_ids = {
            language: int(metadata[f"lang_{language}"]) for language in ("auto", "zh", "en", "yue", "ja", "ko")
        }
        self.text_norm = int(metadata["with_itn"])
        self.tokens = {}
        for line in (self.model_dir / "tokens.txt").read_text(encoding="utf-8").splitlines():
            token, index = line.rsplit(" ", 1)
            self.tokens[int(index)] = token
        return session

    def _features(self, samples: NDArray[np.float32]) -> NDArray[np.float32]:
        options = knf.FbankOptions()
        options.frame_opts.dither = 0
        options.frame_opts.snip_edges = False
        options.frame_opts.window_type = "hamming"
        options.frame_opts.samp_freq = SAMPLE_RATE
        options.mel_opts.num_bins = 80
        fbank = knf.OnlineFbank(options)
        padded = np.pad(samples, (0, max(0, SAMPLE_RATE // 10 - samples.size)))
        fbank.accept_waveform(SAMPLE_RATE, (padded * 32768).tolist())
        fbank.input_finished()
        frames = np.stack([fbank.get_frame(index) for index in range(fbank.num_frames_ready)])
        if frames.shape[0] < self.window_size:
            frames = np.pad(frames, ((0, self.window_size - frames.shape[0]), (0, 0)), mode="edge")
        windows = np.lib.stride_tricks.sliding_window_view(frames, self.window_size, axis=0)
        stacked = windows[:: self.window_shift].transpose(0, 2, 1).reshape(-1, 80 * self.window_size)
        return np.ascontiguousarray((stacked + self.neg_mean) * self.inv_stddev, dtype=np.float32)

    def _predict(self, audio: AudioInput, options: SpeechTranscriptionOptions) -> TranscriptionOutput:
        if not np.any(audio.samples):
            return {"text": "", "language": None, "segments": []}
        features = self._features(audio.samples)
        graph = self.session.for_shape(Shape(batch=1))
        output = graph.run(
            None,
            {
                "x": features[None],
                "x_length": np.array([features.shape[0]], dtype=np.int32),
                "language": np.array([self.language_ids[options.language]], dtype=np.int32),
                "text_norm": np.array([self.text_norm], dtype=np.int32),
            },
        )[0]
        indices = output[0].argmax(axis=-1)
        unique = indices[np.concatenate(([True], indices[1:] != indices[:-1]))]
        raw = "".join(self.tokens[int(index)] for index in unique if index != 0)
        detected = LANGUAGE_TAG.search(raw)
        text = SPECIAL_TAG.sub("", raw).replace("▁", " ").strip()
        if "<|nospeech|>" in raw:
            text = ""
        return {
            "text": text,
            "language": detected[1] if detected else None,
            "segments": [{"startMs": 0, "endMs": round(audio.samples.size * 1000 / SAMPLE_RATE), "text": text}]
            if text
            else [],
        }
