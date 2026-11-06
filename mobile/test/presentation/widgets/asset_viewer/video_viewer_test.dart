import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/video_viewer.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/providers/infrastructure/storage.provider.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:native_video_player/native_video_player.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../unit/factories/local_asset_factory.dart';
import '../../../unit/factories/remote_asset_factory.dart';
import '../../../unit/presentation/presentation_context.dart';

class MockPlaybackController extends Mock implements NativeVideoPlayerController {}

class ReadinessPlayer extends VideoPlayerNotifier {
  VideoSource? loaded;
  int playCalls = 0;

  @override
  Future<void> load(VideoSource source) async {
    loaded = source;
  }

  @override
  Future<void> setLoop(bool loop) async {}

  @override
  Future<void> setVolume(double volume) async {}

  @override
  void onNativePlaybackReady() {}

  @override
  Future<void> play() async {
    playCalls++;
  }
}

void main() {
  late PresentationContext context;
  late MockStorageRepository storage;

  final local = LocalAssetFactory.create(id: 'local-1').copyWith(type: .video, playbackStyle: .video);
  final remote = RemoteAssetFactory.create(type: .video, localId: local.id);

  setUp(() async {
    context = await PresentationContext.create();
    storage = MockStorageRepository();
    final assets = context.service.asset.service;
    when(() => assets.getAsset(remote)).thenAnswer((_) async => remote);
    when(() => assets.getAsset(local)).thenAnswer((_) async => local);
    when(() => assets.getLocalAsset(local.id)).thenAnswer((_) async => local);
  });

  tearDown(() async {
    await context.dispose();
  });

  Future<VideoSource?> pumpViewer(WidgetTester tester, BaseAsset asset) async {
    await tester.pumpTestWidget(
      context,
      NativeVideoViewer(asset: asset, image: const SizedBox()),
      overrides: [storageRepositoryProvider.overrideWithValue(storage)],
      expectSettle: false,
    );
    return tester.state<NativeVideoViewerState>(find.byType(NativeVideoViewer)).videoSource;
  }

  testWidgets('plays the local file when it exists', (tester) async {
    final file = File('/videos/local-1.mp4');
    when(() => storage.getFileForAsset(local.id)).thenAnswer((_) async => file);

    final source = await pumpViewer(tester, remote);

    expect(source?.type, VideoSourceType.file);
    expect(source?.path, endsWith(file.path));
  });

  testWidgets('plays the server copy when the local file cannot be read', (tester) async {
    when(() => storage.getFileForAsset(local.id)).thenAnswer((_) async => null);

    final source = await pumpViewer(tester, remote);

    expect(source?.type, VideoSourceType.network);
    expect(source?.path, endsWith('/assets/${remote.id}/video/playback'));
  });

  testWidgets('gives up when a local only asset has no file', (tester) async {
    when(() => storage.getFileForAsset(local.id)).thenAnswer((_) async => null);

    final source = await pumpViewer(tester, local);

    expect(source, isNull);
  });

  testWidgets('plays a local audio file without requesting an image', (tester) async {
    final audio = local.copyWith(type: .audio, playbackStyle: .unknown, name: 'recording.mp3');
    final file = File('/audio/recording.mp3');
    when(() => context.service.asset.service.getAsset(audio)).thenAnswer((_) async => audio);
    when(() => storage.getFileForAsset(audio.id)).thenAnswer((_) async => file);

    final source = await pumpViewer(tester, audio);

    expect(source?.type, VideoSourceType.file);
    expect(source?.path, endsWith(file.path));
  });

  testWidgets('plays remote audio through authenticated media playback', (tester) async {
    final audio = RemoteAssetFactory.create(type: .audio, name: 'recording.flac');
    when(() => context.service.asset.service.getAsset(audio)).thenAnswer((_) async => audio);

    final source = await pumpViewer(tester, audio);

    expect(source?.type, VideoSourceType.network);
    expect(source?.path, endsWith('/assets/${audio.id}/video/playback'));
    expect(source?.headers, ApiService.getRequestHeaders());
  });

  testWidgets('falls back to the remote audio when the local copy is missing', (tester) async {
    final audio = remote.copyWith(type: .audio);
    final localAudio = local.copyWith(type: .audio, playbackStyle: .unknown);
    when(() => context.service.asset.service.getAsset(audio)).thenAnswer((_) async => audio);
    when(() => context.service.asset.service.getLocalAsset(local.id)).thenAnswer((_) async => localAudio);
    when(() => storage.getFileForAsset(local.id)).thenAnswer((_) async => null);

    final source = await pumpViewer(tester, audio);

    expect(source?.type, VideoSourceType.network);
    expect(source?.path, endsWith('/assets/${audio.id}/video/playback'));
  });

  for (final scenario in [
    (type: AssetType.audio, autoplay: null, plays: 0),
    (type: AssetType.audio, autoplay: true, plays: 1),
    (type: AssetType.audio, autoplay: false, plays: 0),
    (type: AssetType.video, autoplay: null, plays: 1),
  ]) {
    testWidgets('${scenario.type} honors autoplay ${scenario.autoplay} when the native player becomes ready', (
      tester,
    ) async {
      final asset = RemoteAssetFactory.create(type: scenario.type);
      final player = ReadinessPlayer();
      final controller = MockPlaybackController();
      final ready = ChangeNotifier();
      when(() => controller.videoSource).thenAnswer((_) => player.loaded);
      when(() => controller.onPlaybackReady).thenReturn(ready);
      when(() => controller.onPlaybackEnded).thenReturn(ChangeNotifier());
      when(() => controller.onPlaybackPositionChanged).thenReturn(ValueNotifier(0));
      when(() => controller.onPlaybackStatusChanged).thenReturn(ValueNotifier(PlaybackStatus.stopped));
      when(() => controller.onError).thenReturn(ValueNotifier<String?>(null));
      when(() => context.service.asset.service.getAsset(asset)).thenAnswer((_) async => asset);

      await tester.pumpTestWidget(
        context,
        NativeVideoViewer(asset: asset, image: const SizedBox(), isCurrent: true, autoPlayOverride: scenario.autoplay),
        overrides: [videoPlayerProvider(asset.id).overrideWith((ref) => player)],
        expectSettle: false,
      );
      tester.widget<NativeVideoPlayerView>(find.byType(NativeVideoPlayerView, skipOffstage: false)).onViewReady!(
        controller,
      );
      await tester.pump();
      ready.notifyListeners();
      await tester.pump();
      expect(player.playCalls, scenario.plays);
      ready.notifyListeners();
      await tester.pump();
      expect(player.playCalls, scenario.plays);
      await tester.pumpWidget(const SizedBox.shrink());
    }, variant: const TargetPlatformVariant({TargetPlatform.linux}));
  }
}
