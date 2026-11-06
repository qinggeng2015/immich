import 'package:immich_mobile/domain/models/audio_analysis.model.dart';
import 'package:openapi/api.dart' as api;

class AudioAnalysisRepository {
  final api.AssetsApi _api;

  const AudioAnalysisRepository(this._api);

  Future<void> generateWaveform(String assetId) =>
      _api.runAssetJobs(api.AssetJobsDto(assetIds: [assetId], name: api.AssetJobName.generateWaveform));

  Future<void> transcribe(String assetId) =>
      _api.runAssetJobs(api.AssetJobsDto(assetIds: [assetId], name: api.AssetJobName.transcribeAudio));

  Future<void> generateSummary(String assetId) =>
      _api.runAssetJobs(api.AssetJobsDto(assetIds: [assetId], name: api.AssetJobName.summarizeAudio));

  Future<bool> isTranscriptionEnabled({Future<void>? abortTrigger}) async {
    final config = await api.ConfigUserApi(_api.apiClient).getUserConfig(abortTrigger: abortTrigger);
    final machineLearning = config?.machineLearning;
    return machineLearning?.enabled == true && (machineLearning?.speechToText.orElse(null)?.enabled ?? false);
  }

  Future<bool> isSummaryEnabled({Future<void>? abortTrigger}) async {
    final config = await api.ConfigUserApi(_api.apiClient).getUserConfig(abortTrigger: abortTrigger);
    final machineLearning = config?.machineLearning;
    return machineLearning?.enabled == true && (machineLearning?.audioSummary.orElse(null)?.enabled ?? false);
  }

  Future<bool> isAutomaticSummaryEnabled({Future<void>? abortTrigger}) async {
    final config = await api.ConfigUserApi(_api.apiClient).getUserConfig(abortTrigger: abortTrigger);
    final machineLearning = config?.machineLearning;
    final summary = machineLearning?.audioSummary.orElse(null);
    return machineLearning?.enabled == true && summary?.enabled == true && summary?.autoSummarize == true;
  }

  Future<AudioAnalysis<AudioWaveformData>> getWaveform(String assetId, {Future<void>? abortTrigger}) async {
    try {
      final response = await _api.getAssetAudioWaveform(assetId, abortTrigger: abortTrigger);
      final waveform = response?.waveform;
      return AudioAnalysis(
        status: _status(response?.status.toString()),
        data: waveform == null || waveform.version != api.AudioWaveformDtoVersionEnum.number1
            ? null
            : AudioWaveformData(
                duration: Duration(milliseconds: waveform.durationMs.round()),
                peaks: List.unmodifiable(waveform.peaks.map((peak) => peak.clamp(0.0, 1.0))),
              ),
      );
    } on api.ApiException catch (error) {
      if ({403, 404, 405, 501}.contains(error.code)) {
        return const AudioAnalysis(status: AudioAnalysisStatus.unavailable);
      }
      rethrow;
    }
  }

  Future<AudioAnalysis<AudioTranscriptData>> getTranscript(String assetId, {Future<void>? abortTrigger}) async {
    try {
      final response = await _api.getAssetAudioTranscript(assetId, abortTrigger: abortTrigger);
      final transcript = response?.transcript;
      return AudioAnalysis(
        status: _status(response?.status.toString()),
        data: transcript == null
            ? null
            : AudioTranscriptData(
                text: transcript.text,
                language: transcript.language,
                segments: List.unmodifiable(
                  transcript.segments
                      .where((segment) => segment.startMs >= 0 && segment.endMs > segment.startMs)
                      .map(
                        (segment) => AudioTranscriptSegment(
                          start: Duration(milliseconds: segment.startMs.round()),
                          end: Duration(milliseconds: segment.endMs.round()),
                          text: segment.text,
                        ),
                      ),
                ),
              ),
      );
    } on api.ApiException catch (error) {
      if ({403, 404, 405, 501}.contains(error.code)) {
        return const AudioAnalysis(status: AudioAnalysisStatus.unavailable);
      }
      rethrow;
    }
  }

  Future<AudioAnalysis<AudioSummaryData>> getSummary(String assetId, {Future<void>? abortTrigger}) async {
    try {
      final response = await _api.getAssetAudioSummary(assetId, abortTrigger: abortTrigger);
      final summary = response?.summary;
      return AudioAnalysis(
        status: _status(response?.status.toString()),
        data: summary == null ? null : AudioSummaryData(text: summary.text),
      );
    } on api.ApiException catch (error) {
      if ({403, 404, 405, 501}.contains(error.code)) {
        return const AudioAnalysis(status: AudioAnalysisStatus.unavailable);
      }
      rethrow;
    }
  }

  static AudioAnalysisStatus _status(String? value) => switch (value) {
    'unprocessed' => AudioAnalysisStatus.unprocessed,
    'pending' => AudioAnalysisStatus.pending,
    'processing' => AudioAnalysisStatus.processing,
    'ready' => AudioAnalysisStatus.ready,
    'failed' => AudioAnalysisStatus.failed,
    'disabled' => AudioAnalysisStatus.disabled,
    _ => AudioAnalysisStatus.unavailable,
  };
}
