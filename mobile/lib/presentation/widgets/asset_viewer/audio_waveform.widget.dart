import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';

class AudioWaveform extends StatelessWidget {
  final List<double> peaks;
  final Duration position;
  final Duration duration;
  final String semanticLabel;
  final Color? activeColor;
  final Color? inactiveColor;
  final ValueChanged<Duration>? onSeek;
  final VoidCallback? onSeekStart;
  final VoidCallback? onSeekEnd;

  const AudioWaveform({
    super.key,
    required this.peaks,
    required this.position,
    required this.duration,
    required this.semanticLabel,
    this.activeColor,
    this.inactiveColor,
    this.onSeek,
    this.onSeekStart,
    this.onSeekEnd,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final playedColor = activeColor ?? colors.primary;
    final remainingColor = inactiveColor ?? colors.onSurfaceVariant.withValues(alpha: 0.45);
    final durationMs = duration.inMilliseconds;
    final canSeek = durationMs > 0 && onSeek != null;
    final progress = durationMs > 0 ? (position.inMilliseconds / durationMs).clamp(0.0, 1.0) : 0.0;
    final hasWaveform = peaks.isNotEmpty;

    return Directionality(
      textDirection: TextDirection.ltr,
      child: Semantics(
        label: semanticLabel,
        child: SizedBox(
          height: 64,
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (hasWaveform)
                Positioned.fill(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                    child: CustomPaint(
                      painter: _AudioWaveformPainter(
                        peaks: peaks,
                        progress: progress,
                        playedColor: playedColor,
                        remainingColor: canSeek ? remainingColor : remainingColor.withValues(alpha: 0.25),
                      ),
                    ),
                  ),
                ),
              SliderTheme(
                data: SliderTheme.of(context).copyWith(
                  thumbColor: playedColor,
                  activeTrackColor: hasWaveform ? Colors.transparent : playedColor,
                  inactiveTrackColor: hasWaveform ? Colors.transparent : remainingColor,
                  disabledActiveTrackColor: hasWaveform ? Colors.transparent : colors.outlineVariant,
                  disabledInactiveTrackColor: hasWaveform ? Colors.transparent : colors.outlineVariant,
                  overlayShape: SliderComponentShape.noOverlay,
                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6, disabledThumbRadius: 6),
                ),
                child: Slider(
                  padding: EdgeInsets.zero,
                  value: progress,
                  semanticFormatterCallback: (value) =>
                      Duration(milliseconds: (value * math.max(durationMs, 0)).round()).format(),
                  onChanged: canSeek ? (value) => onSeek!(Duration(milliseconds: (value * durationMs).round())) : null,
                  onChangeStart: canSeek ? (_) => onSeekStart?.call() : null,
                  onChangeEnd: canSeek ? (_) => onSeekEnd?.call() : null,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AudioWaveformPainter extends CustomPainter {
  final List<double> peaks;
  final double progress;
  final Color playedColor;
  final Color remainingColor;

  const _AudioWaveformPainter({
    required this.peaks,
    required this.progress,
    required this.playedColor,
    required this.remainingColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (peaks.isEmpty || size.width <= 0 || size.height <= 0) {
      return;
    }

    final barCount = math.min(peaks.length, math.max(1, (size.width / 4).floor()));
    final barWidth = size.width / barCount;
    final paint = Paint()
      ..strokeWidth = math.min(2.5, barWidth)
      ..strokeCap = StrokeCap.round;

    for (var bar = 0; bar < barCount; bar++) {
      final firstPeak = (bar * peaks.length / barCount).floor();
      final lastPeak = ((bar + 1) * peaks.length / barCount).ceil();
      var amplitude = 0.0;
      for (var index = firstPeak; index < lastPeak; index++) {
        final peak = peaks[index];
        if (peak.isFinite) {
          amplitude = math.max(amplitude, peak.abs().clamp(0.0, 1.0));
        }
      }

      final x = (bar + 0.5) * barWidth;
      final height = math.max(1.0, amplitude * (size.height - paint.strokeWidth));
      paint.color = x <= size.width * progress ? playedColor : remainingColor;
      canvas.drawLine(Offset(x, (size.height - height) / 2), Offset(x, (size.height + height) / 2), paint);
    }
  }

  @override
  bool shouldRepaint(_AudioWaveformPainter oldDelegate) =>
      !listEquals(peaks, oldDelegate.peaks) ||
      progress != oldDelegate.progress ||
      playedColor != oldDelegate.playedColor ||
      remainingColor != oldDelegate.remainingColor;
}
