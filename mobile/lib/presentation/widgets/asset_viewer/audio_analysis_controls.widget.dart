import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/audio_analysis.model.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/cast/cast_manager_state.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/audio_summary_sheet.widget.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/audio_waveform.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/providers/cast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/audio_analysis.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/widgets/asset_viewer/video_controls.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

class AudioAnalysisControls extends ConsumerWidget {
  final BaseAsset asset;

  const AudioAnalysisControls({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final transcriptSupported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.speechToText));
    final summarySupported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.audioSummary));

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (asset.remoteId != null && (transcriptSupported || summarySupported))
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 8,
            children: [
              if (transcriptSupported)
                TextButton.icon(
                  style: TextButton.styleFrom(foregroundColor: Colors.white),
                  icon: const Icon(Icons.notes_rounded),
                  label: Text(context.t.audio_transcript),
                  onPressed: () => showModalBottomSheet<void>(
                    context: context,
                    isScrollControlled: true,
                    showDragHandle: true,
                    useSafeArea: true,
                    builder: (_) => _AudioTranscriptSheet(asset: asset),
                  ),
                ),
              if (summarySupported)
                TextButton.icon(
                  style: TextButton.styleFrom(foregroundColor: Colors.white),
                  icon: const Icon(Icons.summarize_rounded),
                  label: Text(context.t.audio_summary),
                  onPressed: () => showModalBottomSheet<void>(
                    context: context,
                    isScrollControlled: true,
                    showDragHandle: true,
                    useSafeArea: true,
                    builder: (_) => AudioSummarySheet(asset: asset),
                  ),
                ),
            ],
          ),
        VideoControls(
          videoPlayerName: asset.id,
          seekControl: _AudioWaveformControl(asset: asset),
        ),
      ],
    );
  }
}

class _AudioWaveformControl extends ConsumerWidget {
  final BaseAsset asset;

  const _AudioWaveformControl({required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remoteId = asset.remoteId;
    final supported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.audioWaveform));
    final waveform = remoteId != null && supported
        ? ref.watch(audioWaveformProvider(remoteId))
        : const AsyncData<AudioAnalysis<AudioWaveformData>?>(null);
    final result = waveform.valueOrNull;
    final cast = ref.watch(castProvider);
    final player = ref.watch(videoPlayerProvider(asset.id));
    final position = cast.isCasting ? cast.currentTime : player.position;
    final playerDuration = cast.isCasting ? cast.duration : player.duration;
    final duration = playerDuration > Duration.zero ? playerDuration : result?.data?.duration ?? Duration.zero;
    final notifier = ref.read(videoPlayerProvider(asset.id).notifier);
    final status = waveform.isLoading || result?.isProcessing == true
        ? context.t.audio_waveform_generating
        : result?.status == AudioAnalysisStatus.failed && result?.data != null
        ? context.t.error_title
        : waveform.hasError || (result != null && result.data == null)
        ? context.t.audio_waveform_unavailable
        : null;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AudioWaveform(
          peaks: result?.data?.peaks ?? const [],
          position: position,
          duration: duration,
          semanticLabel: context.t.audio_seek,
          activeColor: Colors.white,
          inactiveColor: Colors.white54,
          onSeek: playerDuration > Duration.zero
              ? (position) {
                  if (cast.isCasting) {
                    ref.read(castProvider.notifier).seekTo(position);
                  } else {
                    notifier.seekTo(position);
                  }
                }
              : null,
          onSeekStart: notifier.hold,
          onSeekEnd: notifier.release,
        ),
        if (remoteId != null && supported && status != null)
          Row(
            children: [
              Expanded(
                child: Text(status, style: const TextStyle(color: Colors.white70)),
              ),
              IconButton(
                tooltip: context.t.refresh,
                color: Colors.white,
                onPressed: () => ref.invalidate(audioWaveformProvider(remoteId)),
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
        if (remoteId != null &&
            supported &&
            result != null &&
            !result.isProcessing &&
            result.status != AudioAnalysisStatus.unavailable)
          _AudioAnalysisJobButton(asset: asset, waveform: true, firstRun: result.data == null),
      ],
    );
  }
}

class _AudioTranscriptSheet extends ConsumerWidget {
  final BaseAsset asset;

  const _AudioTranscriptSheet({required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remoteId = asset.remoteId!;
    final response = ref.watch(audioTranscriptProvider(remoteId));
    final result = response.valueOrNull;
    final transcript = result?.data;
    final player = ref.watch(videoPlayerProvider(asset.id));
    final cast = ref.watch(castProvider);
    final duration = cast.isCasting ? cast.duration : player.duration;
    final playing = cast.isCasting
        ? cast.castState == CastState.playing
        : player.status == VideoPlaybackStatus.playing || player.status == VideoPlaybackStatus.buffering;
    final status = response.isLoading
        ? context.t.loading
        : response.hasError
        ? context.t.audio_transcript_unavailable
        : switch (result?.status) {
            AudioAnalysisStatus.pending => context.t.audio_transcript_pending,
            AudioAnalysisStatus.processing => context.t.audio_transcript_processing,
            AudioAnalysisStatus.failed => context.t.audio_transcript_failed,
            AudioAnalysisStatus.disabled => context.t.audio_transcript_disabled,
            AudioAnalysisStatus.unprocessed ||
            AudioAnalysisStatus.unavailable ||
            null => context.t.audio_transcript_unavailable,
            AudioAnalysisStatus.ready => null,
          };

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.65,
      minChildSize: 0.3,
      maxChildSize: 0.9,
      builder: (context, scrollController) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Row(
              children: [
                Expanded(child: Text(context.t.audio_transcript, style: Theme.of(context).textTheme.titleLarge)),
                IconButton(
                  tooltip: playing ? context.t.pause : context.t.play,
                  onPressed: () {
                    if (cast.isCasting) {
                      ref.read(castProvider.notifier).toggle();
                    } else {
                      ref.read(videoPlayerProvider(asset.id).notifier).toggle();
                    }
                  },
                  icon: Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded),
                ),
                IconButton(
                  tooltip: context.t.refresh,
                  onPressed: () {
                    ref.invalidate(audioTranscriptProvider(remoteId));
                    ref.invalidate(audioTranscriptionEnabledProvider);
                  },
                  icon: const Icon(Icons.refresh_rounded),
                ),
                IconButton(
                  tooltip: context.t.copy_to_clipboard,
                  onPressed: transcript == null || transcript.text.isEmpty
                      ? null
                      : () {
                          unawaited(Clipboard.setData(ClipboardData(text: transcript.text)));
                          ImmichToast.show(context: context, msg: context.t.copied_to_clipboard);
                        },
                  icon: const Icon(Icons.copy_rounded),
                ),
              ],
            ),
          ),
          if (result != null &&
              !result.isProcessing &&
              result.status != AudioAnalysisStatus.disabled &&
              result.status != AudioAnalysisStatus.unavailable)
            _AudioAnalysisJobButton(asset: asset, waveform: false),
          Expanded(
            child: ListView(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                if (status != null) Padding(padding: const EdgeInsets.only(bottom: 16), child: Text(status)),
                if (transcript != null)
                  if (transcript.text.isEmpty)
                    Text(context.t.audio_transcript_empty)
                  else if (transcript.segments.isEmpty)
                    SelectableText(transcript.text)
                  else
                    for (final segment in transcript.segments)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            TextButton.icon(
                              icon: const Icon(Icons.access_time_rounded),
                              label: Text('${segment.start.format()} – ${segment.end.format()}'),
                              onPressed: duration > Duration.zero && segment.start < duration
                                  ? () {
                                      if (cast.isCasting) {
                                        ref.read(castProvider.notifier).seekTo(segment.start);
                                      } else {
                                        ref.read(videoPlayerProvider(asset.id).notifier).seekTo(segment.start);
                                      }
                                    }
                                  : null,
                            ),
                            SelectableText(segment.text),
                          ],
                        ),
                      ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AudioAnalysisJobButton extends ConsumerStatefulWidget {
  final BaseAsset asset;
  final bool waveform;
  final bool firstRun;

  const _AudioAnalysisJobButton({required this.asset, required this.waveform, this.firstRun = false});

  @override
  ConsumerState<_AudioAnalysisJobButton> createState() => _AudioAnalysisJobButtonState();
}

class _AudioAnalysisJobButtonState extends ConsumerState<_AudioAnalysisJobButton> {
  bool _busy = false;

  Future<void> _run() async {
    final remoteId = widget.asset.remoteId;
    if (remoteId == null || _busy) {
      return;
    }
    setState(() => _busy = true);
    try {
      final repository = ref.read(audioAnalysisRepositoryProvider);
      if (widget.waveform) {
        await repository.generateWaveform(remoteId);
      } else {
        if (!await repository.isTranscriptionEnabled()) {
          if (mounted) {
            ref.invalidate(audioTranscriptionEnabledProvider);
            ImmichToast.show(context: context, msg: context.t.audio_transcript_disabled);
          }
          return;
        }
        await repository.transcribe(remoteId);
      }
      if (!mounted) {
        return;
      }
      if (widget.waveform) {
        ref.invalidate(audioWaveformProvider(remoteId));
      } else {
        ref.invalidate(audioTranscriptProvider(remoteId));
      }
    } catch (_) {
      if (mounted) {
        ImmichToast.show(context: context, msg: context.t.error_title, toastType: ToastType.error);
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final editable = ref.watch(audioAnalysisEditableProvider(widget.asset)).valueOrNull ?? false;
    if (!editable) {
      return const SizedBox.shrink();
    }
    if (!widget.waveform && !(ref.watch(audioTranscriptionEnabledProvider).valueOrNull ?? false)) {
      return const SizedBox.shrink();
    }
    return TextButton.icon(
      style: widget.waveform ? TextButton.styleFrom(foregroundColor: Colors.white) : null,
      onPressed: _busy ? null : _run,
      icon: _busy
          ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : Icon(widget.waveform ? Icons.graphic_eq_rounded : Icons.transcribe_rounded),
      label: Text(
        widget.waveform
            ? widget.firstRun
                  ? context.t.generate_audio_waveform
                  : context.t.regenerate_audio_waveform
            : context.t.transcribe_audio,
      ),
    );
  }
}
