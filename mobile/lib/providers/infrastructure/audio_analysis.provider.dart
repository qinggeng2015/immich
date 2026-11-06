import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/audio_analysis.model.dart';
import 'package:immich_mobile/infrastructure/repositories/audio_analysis.repository.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/app_life_cycle.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/readonly_mode.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';

final audioAnalysisRepositoryProvider = Provider((ref) {
  return AudioAnalysisRepository(ref.watch(apiServiceProvider).assetsApi);
});

final audioAnalysisEditableProvider = FutureProvider.autoDispose.family<bool, BaseAsset>((ref, asset) async {
  final readonly = ref.watch(readonlyModeProvider);
  final userId = ref.watch(currentUserProvider)?.id;
  final remoteId = asset.remoteId;
  if (readonly || userId == null || remoteId == null) {
    return false;
  }
  final remote = asset is RemoteAsset ? asset : await ref.watch(assetServiceProvider).getRemoteAsset(remoteId);
  return remote?.ownerId == userId;
});

final audioTranscriptionEnabledProvider = FutureProvider.autoDispose<bool>((ref) async {
  final supported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.speechToText));
  if (!supported || !_isForeground(ref)) {
    return false;
  }
  final cancellation = Completer<void>();
  ref.onDispose(cancellation.complete);
  return ref.watch(audioAnalysisRepositoryProvider).isTranscriptionEnabled(abortTrigger: cancellation.future);
});

final audioSummaryEnabledProvider = FutureProvider.autoDispose<bool>((ref) async {
  final supported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.audioSummary));
  if (!supported || !_isForeground(ref)) {
    return false;
  }
  final cancellation = Completer<void>();
  ref.onDispose(cancellation.complete);
  return ref.watch(audioAnalysisRepositoryProvider).isSummaryEnabled(abortTrigger: cancellation.future);
});

final audioWaveformProvider = StreamProvider.autoDispose.family<AudioAnalysis<AudioWaveformData>?, String>((
  ref,
  assetId,
) {
  final supported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.audioWaveform));
  if (!supported) {
    return Stream.value(null);
  }
  if (!_isForeground(ref)) {
    return const Stream.empty();
  }
  final repository = ref.watch(audioAnalysisRepositoryProvider);
  return _poll(ref, (abortTrigger) => repository.getWaveform(assetId, abortTrigger: abortTrigger));
});

final audioTranscriptProvider = StreamProvider.autoDispose.family<AudioAnalysis<AudioTranscriptData>?, String>((
  ref,
  assetId,
) {
  final supported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.speechToText));
  if (!supported) {
    return Stream.value(null);
  }
  if (!_isForeground(ref)) {
    return const Stream.empty();
  }
  final repository = ref.watch(audioAnalysisRepositoryProvider);
  return _poll(ref, (abortTrigger) => repository.getTranscript(assetId, abortTrigger: abortTrigger));
});

final audioSummaryProvider = StreamProvider.autoDispose.family<AudioAnalysis<AudioSummaryData>?, String>((
  ref,
  assetId,
) {
  final supported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.audioSummary));
  if (!supported) {
    return Stream.value(null);
  }
  if (!_isForeground(ref)) {
    return const Stream.empty();
  }
  final repository = ref.watch(audioAnalysisRepositoryProvider);
  return _poll(
    ref,
    (abortTrigger) => repository.getSummary(assetId, abortTrigger: abortTrigger),
    retryUnprocessed: (abortTrigger) => repository.isAutomaticSummaryEnabled(abortTrigger: abortTrigger),
  );
});

Stream<AudioAnalysis<T>> _poll<T>(
  Ref ref,
  Future<AudioAnalysis<T>> Function(Future<void>) fetch, {
  Future<bool> Function(Future<void>)? retryUnprocessed,
}) async* {
  var active = true;
  var unprocessedAttempt = 0;
  bool? automatic;
  const handoffDelays = [1, 2, 5];
  final cancellation = Completer<void>();
  ref.onDispose(() {
    active = false;
    cancellation.complete();
  });
  for (var attempt = 0; active; attempt++) {
    final AudioAnalysis<T> result;
    try {
      result = await fetch(cancellation.future);
    } catch (_) {
      if (!active) {
        return;
      }
      rethrow;
    }
    if (!active) {
      return;
    }
    yield result;
    int delay;
    if (result.isProcessing) {
      delay = attempt < 6
          ? 5
          : attempt < 18
          ? 15
          : 30;
    } else if (result.status == AudioAnalysisStatus.unprocessed &&
        retryUnprocessed != null &&
        unprocessedAttempt < handoffDelays.length) {
      try {
        automatic ??= await retryUnprocessed(cancellation.future);
      } catch (_) {
        return;
      }
      if (!active || !automatic) {
        return;
      }
      delay = handoffDelays[unprocessedAttempt++];
    } else {
      return;
    }
    await Future.any([Future<void>.delayed(Duration(seconds: delay)), cancellation.future]);
  }
}

bool _isForeground(Ref ref) => ref.watch(
  appStateProvider.select((state) => state == AppLifeCycleEnum.active || state == AppLifeCycleEnum.resumed),
);
