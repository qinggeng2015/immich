enum AudioAnalysisStatus { unprocessed, pending, processing, ready, failed, disabled, unavailable }

class AudioAnalysis<T> {
  final AudioAnalysisStatus status;
  final T? data;

  const AudioAnalysis({required this.status, this.data});

  bool get isProcessing => status == AudioAnalysisStatus.pending || status == AudioAnalysisStatus.processing;
}

class AudioWaveformData {
  final Duration duration;
  final List<double> peaks;

  const AudioWaveformData({required this.duration, required this.peaks});
}

class AudioTranscriptData {
  final String text;
  final String? language;
  final List<AudioTranscriptSegment> segments;

  const AudioTranscriptData({required this.text, this.language, required this.segments});
}

class AudioTranscriptSegment {
  final Duration start;
  final Duration end;
  final String text;

  const AudioTranscriptSegment({required this.start, required this.end, required this.text});
}

class AudioSummaryData {
  final String text;

  const AudioSummaryData({required this.text});
}
