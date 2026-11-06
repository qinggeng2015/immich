# Immich Machine Learning

- CLIP embeddings
- Facial recognition

# Setup

This project uses [uv](https://docs.astral.sh/uv/getting-started/installation/), so be sure to install it first.
Running `uv sync --extra cpu` will install everything you need in an isolated virtual environment.
CUDA, ROCM and OpenVINO are supported as acceleration APIs. To use them, you can replace `--extra cpu` with either of `--extra cuda`, `--extra rocm` or `--extra openvino`. In the case of CUDA, a [compute capability](https://developer.nvidia.com/cuda-gpus) of 5.2 or higher is required.

To add or remove dependencies, you can use the commands `uv add $PACKAGE_NAME` and `uv remove $PACKAGE_NAME`, respectively.
Be sure to commit the `uv.lock` and `pyproject.toml` files with `uv lock` to reflect any changes in dependencies.

# Load Testing

To measure inference throughput and latency, you can use [Locust](https://locust.io/) using the provided `locustfile.py`.
Locust works by querying the model endpoints and aggregating their statistics, meaning the app must be deployed.
You can change the models or adjust options like score thresholds through the Locust UI.

To get started, you can simply run `locust --web-host 127.0.0.1` and open `localhost:8089` in a browser to access the UI. See the [Locust documentation](https://docs.locust.io/en/stable/index.html) for more info on running Locust.

Note that in Locust's jargon, concurrency is measured in `users`, and each user runs one task at a time. To achieve a particular per-endpoint concurrency, multiply that number by the number of endpoints to be queried. For example, if there are 3 endpoints and you want each of them to receive 8 requests at a time, you should set the number of users to 24.

# Facial Recognition

## Acknowledgements

This project utilizes facial recognition models from the [InsightFace](https://github.com/deepinsight/insightface/tree/master/model_zoo) project. We appreciate the work put into developing these models, which have been beneficial to the machine learning part of this project.

### Used Models

- antelopev2
- buffalo_l
- buffalo_m
- buffalo_s

## License and Use Restrictions

We have received permission to use the InsightFace facial recognition models in our project, as granted via email by Jia Guo (guojia@insightface.ai) on 18th March 2023. However, it's important to note that this permission does not extend to the redistribution or commercial use of their models by third parties. Users and developers interested in using these models should review the licensing terms provided in the InsightFace GitHub repository.

For more information on the capabilities of the InsightFace models and to ensure compliance with their license, please refer to their [official repository](https://github.com/deepinsight/insightface). Adhering to the specified licensing terms is crucial for the respectful and lawful use of their work.

## Speech transcription

The `speech-to-text` pipeline runs SenseVoiceSmall using the existing model cache,
loading lock, TTL and inference request scheduler. It uses a quantized CPU ONNX
session and inherits the configured ONNX thread and memory-arena settings. Other
accelerators are not selected for this model. Image OCR, face recognition and CLIP
retain their existing execution paths.

Send a multipart `audio` file to `/predict` with `entries` set to:

```json
{"speech-to-text":{"transcription":{"modelName":"SenseVoiceSmall","options":{"language":"auto"}}}}
```

Audio must be mono, 16 kHz, PCM16 WAV, at most 30 seconds per request. The Immich
server decodes and splits longer recordings before calling this endpoint. Inputs
are validated before a model is loaded, and audio cannot be combined with image
or text tasks. Languages are `auto`, `zh`, `en`, `yue`, `ja` and `ko`.

The response contains `speech-to-text.text`, `language` and `segments`. Segment
`startMs`/`endMs` describe the input audio window, not word-level forced alignment.
Fixed window boundaries can affect recognition near a cut. Empty/silent audio
results contain no fabricated text. Transcription accuracy depends on speech,
background noise and the model's supported languages.

`MACHINE_LEARNING_PRELOAD__SPEECH_TO_TEXT=SenseVoiceSmall` preloads the model.
The first speech request otherwise downloads the approximately 239 MB INT8 graph
and vocabulary into the configured model cache. `mise //machine-learning:test:speech-model`
runs real Chinese and English audio through the prediction endpoint and prints
the resulting transcript and model checksum.

### Model provenance

- Original weights: [SenseVoiceSmall by FunAudioLLM/Alibaba](https://huggingface.co/FunAudioLLM/SenseVoiceSmall).
- Model weights and derivatives use the [FunASR Model License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE), not the application's source-code license.
- ONNX export: [sherpa-onnx by k2-fsa/Fangjun Kuang](https://github.com/k2-fsa/sherpa-onnx/tree/master/scripts/sense-voice).
- Download: [maintainer's ONNX model](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17), pinned revision `2365baeacb507f821a0c8120fcee3d484dba7a07`, files `model.int8.onnx`, `tokens.txt` and `LICENSE`.
- INT8 graph SHA-256: `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`.
- Audio features follow the exporter's [reference inference frontend](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/sense-voice/test.py): 80-bin Kaldi filter banks, seven stacked frames every six frames, and the graph's CMVN metadata. Inputs shorter than 100 ms are zero-padded for feature extraction; reported timestamps retain the original duration.
- Feature extraction: [kaldi-native-fbank](https://github.com/csukuangfj/kaldi-native-fbank), Apache-2.0.
