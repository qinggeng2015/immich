import 'package:flutter/material.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';

class AudioCover extends StatelessWidget {
  final BaseAsset asset;
  final bool showName;
  final VoidCallback? onPressed;
  final bool isPlaying;
  final Duration? durationOverride;

  const AudioCover({
    super.key,
    required this.asset,
    this.showName = false,
    this.onPressed,
    this.isPlaying = false,
    this.durationOverride,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final duration =
        (durationOverride != null && durationOverride! > Duration.zero ? durationOverride! : asset.duration).format();

    return Semantics(
      label: '${context.t.audio}, ${asset.name}, $duration',
      image: true,
      child: ColoredBox(
        color: colors.surfaceContainerHighest,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (onPressed != null)
                    IconButton(
                      onPressed: onPressed,
                      tooltip: isPlaying ? context.t.pause : context.t.play,
                      iconSize: 80,
                      color: colors.primary,
                      icon: Icon(isPlaying ? Icons.pause_circle_outline_rounded : Icons.play_circle_outline_rounded),
                    )
                  else
                    Icon(Icons.play_circle_outline_rounded, size: showName ? 80 : 40, color: colors.primary),
                  const SizedBox(height: 4),
                  Text(
                    duration,
                    style: TextStyle(color: colors.onSurface, fontWeight: FontWeight.bold),
                  ),
                  if (showName) ...[
                    const SizedBox(height: 12),
                    Text(asset.name, style: TextStyle(color: colors.onSurface)),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
