import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/audio_analysis.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/audio_analysis.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

class AudioSummarySheet extends ConsumerWidget {
  final BaseAsset asset;

  const AudioSummarySheet({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remoteId = asset.remoteId!;
    ref.listen(audioTranscriptProvider(remoteId), (previous, next) {
      final transcript = next.valueOrNull;
      if (previous?.valueOrNull?.isProcessing == true &&
          transcript?.status == AudioAnalysisStatus.ready &&
          (transcript?.data?.text.trim().isNotEmpty ?? false)) {
        ref.invalidate(audioSummaryProvider(remoteId));
      }
    });
    final response = ref.watch(audioSummaryProvider(remoteId));
    final transcript = ref.watch(audioTranscriptProvider(remoteId));
    final transcriptResult = transcript.valueOrNull;
    final hasTranscript = transcriptResult?.data?.text.trim().isNotEmpty ?? false;
    final result = response.valueOrNull;
    final summary = result?.data;
    final status = response.isLoading
        ? context.t.loading
        : response.hasError
        ? context.t.audio_summary_unavailable
        : switch (result?.status) {
            AudioAnalysisStatus.pending => context.t.audio_summary_pending,
            AudioAnalysisStatus.processing => context.t.audio_summary_processing,
            AudioAnalysisStatus.failed => context.t.audio_summary_failed,
            AudioAnalysisStatus.disabled => context.t.audio_summary_disabled,
            AudioAnalysisStatus.unprocessed ||
            AudioAnalysisStatus.unavailable ||
            null => context.t.audio_summary_unavailable,
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
                Expanded(child: Text(context.t.audio_summary, style: Theme.of(context).textTheme.titleLarge)),
                IconButton(
                  tooltip: context.t.refresh,
                  onPressed: () {
                    ref.invalidate(audioSummaryProvider(remoteId));
                    ref.invalidate(audioSummaryEnabledProvider);
                    ref.invalidate(audioTranscriptProvider(remoteId));
                  },
                  icon: const Icon(Icons.refresh_rounded),
                ),
                IconButton(
                  tooltip: context.t.copy_to_clipboard,
                  onPressed: summary == null || summary.text.isEmpty
                      ? null
                      : () {
                          unawaited(Clipboard.setData(ClipboardData(text: summary.text)));
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
            _AudioSummaryJobButton(asset: asset, firstRun: summary == null, hasTranscript: hasTranscript),
          Expanded(
            child: ListView(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                if (status != null) Padding(padding: const EdgeInsets.only(bottom: 16), child: Text(status)),
                if (!transcript.isLoading &&
                    !transcript.hasError &&
                    transcriptResult != null &&
                    transcriptResult.status != AudioAnalysisStatus.unavailable &&
                    !hasTranscript)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Text(switch (transcriptResult.status) {
                      AudioAnalysisStatus.pending => context.t.audio_transcript_pending,
                      AudioAnalysisStatus.processing => context.t.audio_transcript_processing,
                      _ => context.t.audio_summary_requires_transcript,
                    }),
                  ),
                if (summary != null)
                  if (summary.text.isEmpty) Text(context.t.audio_summary_empty) else SelectableText(summary.text),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AudioSummaryJobButton extends ConsumerStatefulWidget {
  final BaseAsset asset;
  final bool firstRun;
  final bool hasTranscript;

  const _AudioSummaryJobButton({required this.asset, required this.firstRun, required this.hasTranscript});

  @override
  ConsumerState<_AudioSummaryJobButton> createState() => _AudioSummaryJobButtonState();
}

class _AudioSummaryJobButtonState extends ConsumerState<_AudioSummaryJobButton> {
  bool _busy = false;

  Future<void> _run() async {
    final remoteId = widget.asset.remoteId;
    if (remoteId == null ||
        _busy ||
        !widget.hasTranscript ||
        !(ref.read(audioAnalysisEditableProvider(widget.asset)).valueOrNull ?? false)) {
      return;
    }
    setState(() => _busy = true);
    try {
      final repository = ref.read(audioAnalysisRepositoryProvider);
      if (!await repository.isSummaryEnabled()) {
        if (mounted) {
          ref.invalidate(audioSummaryEnabledProvider);
          ImmichToast.show(context: context, msg: context.t.audio_summary_disabled);
        }
        return;
      }
      if (!mounted) {
        return;
      }
      final transcript = await repository.getTranscript(remoteId);
      if (!mounted) {
        return;
      }
      if (!(transcript.data?.text.trim().isNotEmpty ?? false)) {
        ref.invalidate(audioTranscriptProvider(remoteId));
        ImmichToast.show(context: context, msg: context.t.audio_summary_requires_transcript);
        return;
      }
      if (!(ref.read(audioAnalysisEditableProvider(widget.asset)).valueOrNull ?? false)) {
        return;
      }
      await repository.generateSummary(remoteId);
      if (mounted) {
        ref.invalidate(audioSummaryProvider(remoteId));
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
    if (!editable || !(ref.watch(audioSummaryEnabledProvider).valueOrNull ?? false)) {
      return const SizedBox.shrink();
    }
    return TextButton.icon(
      onPressed: _busy || !widget.hasTranscript ? null : _run,
      icon: _busy
          ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : const Icon(Icons.summarize_rounded),
      label: Text(widget.firstRun ? context.t.generate_audio_summary : context.t.regenerate_audio_summary),
    );
  }
}
