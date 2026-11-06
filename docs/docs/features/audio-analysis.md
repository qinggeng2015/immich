# Audio waveforms, speech transcription, and summaries

Audio playback in this fork includes a waveform and an optional speech transcript. Both are processed in the background, so playback can begin before analysis finishes.

An optional summary turns a completed transcript into a concise overview using an OpenAI-compatible text model. The web and mobile audio viewers let you read and copy the summary or generate it again. Summary processing does not delay audio playback.

## Playback and transcripts

Open an uploaded audio file in the web or mobile viewer. Once its waveform is ready, click or drag along the waveform to seek. Before processing finishes, the normal audio controls remain available.

The transcript panel shows recognized text and lets you copy it or select a timestamp to seek to that section of the recording. Timestamps mark processing windows of up to 30 seconds; they do not locate individual words. Fixed window boundaries can affect recognition around a cut.

Use the viewer's processing action to generate missing results or retry a failed job. Reprocessing keeps the last successful result available until the replacement is ready. If the source file changes, results from the previous source are hidden until the new source has been processed.

To find recordings by their spoken content, select **Audio transcript** in search. This searches saved transcripts and respects normal asset access and visibility filters. Filename search remains available separately. Public share links can display a waveform for an accessible audio file, but do not expose or search transcripts.

## Processing settings

In **Administration → Settings → Machine Learning Settings → Audio transcription**, configure:

- **Enabled**: allow speech processing. The machine learning service must also be enabled.
- **Automatically transcribe new audio**: queue transcription when newly uploaded or reprocessed audio completes thumbnail generation. Disable this to use manual or batch processing.
- **Model**: `SenseVoiceSmall`.
- **Language**: automatic detection, Mandarin Chinese, English, Cantonese, Japanese, or Korean.

Speech processing and automatic transcription are enabled by default. Disabling processing preserves completed transcripts, which remain readable and searchable. It does not remove them from the database.

The first transcription downloads the pinned model into the machine learning model cache. The INT8 graph is approximately 239 MB. Inference uses CPU ONNX Runtime through the existing Immich machine learning service. A remote machine learning deployment receives audio chunks at its configured URL, just as it receives inputs for other model tasks. Update that service along with the server to enable the speech pipeline.

## Audio summary settings

In **Administration → Settings → Machine Learning Settings → Audio summaries**, configure:

- **Enabled**: allow summary processing. This is off by default and also requires the main machine learning switch.
- **Automatically summarize transcribed audio**: queue a summary after transcription completes successfully. Enabling this does not automatically process existing transcripts; use the summary queue's **Missing** action for those.
- **Base URL**: the provider's API base, such as `https://api.openai.com/v1`. Include any provider-specific path prefix. The server appends the selected protocol's endpoint.
- **Protocol**: Chat Completions or Responses. Select the protocol your provider supports; requests are not retried using another protocol.
- **API key**: a provider key. Saved keys are hidden. Leave the field blank to retain the saved key, enter a replacement, or explicitly clear it and save.
- **Model ID**: the provider's text model identifier. The default is `gpt-6.1-terra`.
- **Prompt**: choose a general, meeting, or study preset, then edit it as needed. The default asks for a faithful summary in the transcript's language.
- **Maximum output tokens** and **request timeout**: limit each provider request. Models may count internal reasoning toward the output limit.

Summary requests send transcript text and the configured prompt to the selected provider. They do not send the audio file. Provider usage may incur charges. The server supports the current Chat Completions `max_completion_tokens` field or Responses `max_output_tokens`; older gateways that only accept `max_tokens` need an updated compatible endpoint.

Long transcripts are summarized in chunks and then combined. Processing is bounded to one million transcript characters, 128 provider requests, and 15 minutes per asset. Oversized input or incomplete output is reported as a failed job instead of silently dropping content. Review generated summaries against the transcript when accuracy matters.

Disabling summaries stops new requests and preserves completed results. Existing nonempty transcripts can be summarized even if automatic transcription is disabled. A new transcription invalidates an in-flight summary so it cannot overwrite a result for newer text. Public share links do not expose summaries.

## Job queues

**Administration → Jobs** contains separate **Audio waveform generation**, **Audio transcription**, and **Audio summary** queues. Each defaults to one concurrent job; adjust concurrency in the job settings according to available CPU, memory, and provider limits.

- **Missing** processes audio without a current successful result, including previously failed jobs.
- **All** regenerates results for eligible audio, including files that already have a result. Use this after changing transcription language or model settings.

Existing recordings can be processed with these queues. Waveform generation runs on the server using FFmpeg and does not require the machine learning service. Speech transcription decodes recordings into bounded mono 16 kHz chunks before sending them to the machine learning service.

The summary queue processes recordings with a current, nonempty transcript. With automatic summaries enabled, a successful transcription queues the summary as its next step. Changing the model or prompt makes previous summaries eligible for **Missing** processing; **All** regenerates every eligible summary. Both actions can create multiple billable provider requests.

The queues exclude images, videos, hidden assets, offline files, and trashed assets. Removing an asset removes its saved analysis. Audio analysis does not run image OCR, face recognition, or visual search on recordings.

## Model and accuracy

SenseVoiceSmall supports Mandarin Chinese, Cantonese, English, Japanese, and Korean. Recognition quality depends on speech clarity, background noise, and language. Music or silence may have no transcript. This integration does not provide speaker identification, translation, or word-level alignment.

The model comes from the pinned [sherpa-onnx SenseVoice export](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07). Model weights have their own [FunASR Model License](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE). The `machine-learning/README.md` file in this fork records implementation details, the exact model checksum, and inference verification commands.
