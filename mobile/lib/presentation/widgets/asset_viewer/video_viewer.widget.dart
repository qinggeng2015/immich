import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/asset_viewer/is_motion_video_playing.provider.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/providers/cast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/storage.provider.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:logging/logging.dart';
import 'package:native_video_player/native_video_player.dart';

class NativeVideoViewer extends ConsumerStatefulWidget {
  final BaseAsset asset;
  final String? localFilePath;
  final bool isCurrent;
  final Widget image;

  /// Overrides the user's configured loop video setting
  final bool? loopOverride;
  final bool? autoPlayOverride;

  const NativeVideoViewer({
    super.key,
    required this.asset,
    this.localFilePath,
    required this.image,
    this.isCurrent = false,
    this.loopOverride,
    this.autoPlayOverride,
  });

  @override
  ConsumerState<NativeVideoViewer> createState() => NativeVideoViewerState();
}

class NativeVideoViewerState extends ConsumerState<NativeVideoViewer> with WidgetsBindingObserver {
  static final _log = Logger('NativeVideoViewer');

  NativeVideoPlayerController? _controller;
  final _stagedFiles = <File>[];
  @visibleForTesting
  late final Future<VideoSource?> videoSource;
  Timer? _loadTimer;
  bool _isVideoReady = false;
  bool _hasAudioError = false;
  bool _hasTriedRemoteAudio = false;
  bool _shouldPlayOnForeground = true;

  VideoPlayerNotifier get _notifier => ref.read(videoPlayerProvider(widget.asset.id).notifier);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _shouldPlayOnForeground = !widget.asset.isAudio;
    videoSource = _createSource();
  }

  @override
  void didUpdateWidget(NativeVideoViewer oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.isCurrent == oldWidget.isCurrent || _controller == null) {
      return;
    }

    if (!widget.isCurrent) {
      _loadTimer?.cancel();
      unawaited(_notifier.pause());
      return;
    }

    // Prevent unnecessary loading when swiping between assets.
    _loadTimer = Timer(const Duration(milliseconds: 200), _loadVideo);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _loadTimer?.cancel();
    _removeListeners();
    for (final file in _stagedFiles) {
      unawaited(_deleteStagedFile(file));
    }
    super.dispose();
  }

  Future<void> _deleteStagedFile(File file) async {
    try {
      await file.delete();
    } catch (error, stackTrace) {
      _log.warning('Cannot remove staged playback file', error, stackTrace);
    }
  }

  @override
  Future<void> didChangeAppLifecycleState(AppLifecycleState state) async {
    switch (state) {
      case AppLifecycleState.resumed:
        if (_shouldPlayOnForeground && widget.isCurrent) {
          await _notifier.play();
        }
      case AppLifecycleState.paused:
        _shouldPlayOnForeground = await _controller?.isPlaying() ?? !widget.asset.isAudio;
        if (_shouldPlayOnForeground && mounted) {
          await _notifier.pause();
        }
      default:
    }
  }

  Future<VideoSource?> _createSource() async {
    if (!mounted) {
      return null;
    }

    final videoAsset = await ref.read(assetServiceProvider).getAsset(widget.asset) ?? widget.asset;
    if (!mounted) {
      return null;
    }

    try {
      final storageRepository = ref.read(storageRepositoryProvider);
      final localFilePath = widget.localFilePath;
      if (localFilePath != null) {
        final file = File(localFilePath);
        // ignore: avoid_slow_async_io
        if (!await file.exists()) {
          throw Exception('No file found for the video');
        }

        return await VideoSource.init(
          path: CurrentPlatform.isAndroid ? file.uri.toString() : file.path,
          type: VideoSourceType.file,
        );
      }

      // Attempt to retrieve LocalAsset, falling back to remote if it cannot be found
      final localAsset = await _localPlaybackAsset(videoAsset);

      if (localAsset != null) {
        final file = localAsset.isMotionPhoto
            ? await storageRepository.getMotionFileForAsset(localAsset)
            : await storageRepository.getFileForAsset(localAsset.id);

        if (file != null && (localAsset.id.startsWith('saf-file:') || localAsset.id.startsWith('audio-file:'))) {
          if (!mounted) {
            await _deleteStagedFile(file);
            return null;
          }
          _stagedFiles.add(file);
        }
        if (!mounted) {
          return null;
        }

        // Pass a file:// URI so Android's Uri.parse doesn't
        // interpret characters like '#' as fragment identifiers.
        if (file != null) {
          return await VideoSource.init(
            path: CurrentPlatform.isAndroid ? file.uri.toString() : file.path,
            type: VideoSourceType.file,
          );
        }

        if (videoAsset is! RemoteAsset) {
          throw Exception('No file found for the video');
        }
        _log.warning('Local file missing for ${videoAsset.name} (${videoAsset.localId}), playing the remote copy');
      }

      final remoteAsset = videoAsset as RemoteAsset;

      final serverEndpoint = Store.get(StoreKey.serverEndpoint);
      if (!context.mounted) {
        return null;
      }

      final isOriginalVideo = !videoAsset.isAudio && ref.read(appConfigProvider).viewer.loadOriginalVideo;
      final String postfixUrl = isOriginalVideo ? 'original' : 'video/playback';
      final String assetId = remoteAsset.livePhotoVideoId ?? remoteAsset.id;
      final String videoUrl = '$serverEndpoint/assets/$assetId/$postfixUrl';

      return await VideoSource.init(
        path: videoUrl,
        type: VideoSourceType.network,
        headers: ApiService.getRequestHeaders(),
      );
    } catch (error) {
      _log.severe('Error creating video source for asset ${videoAsset.name}: $error');
      return null;
    }
  }

  Future<LocalAsset?> _localPlaybackAsset(BaseAsset baseAsset) async {
    if (!baseAsset.hasLocal) {
      return null;
    }

    LocalAsset? localAsset;

    if (baseAsset is LocalAsset) {
      localAsset = baseAsset;
    } else {
      final localId = (baseAsset as RemoteAsset).localId;
      localAsset = localId != null ? await ref.read(assetServiceProvider).getLocalAsset(localId) : null;
    }

    if (localAsset == null) {
      _log.severe(
        'Invariant violation: asset ${baseAsset.name} (${baseAsset.localId}) is marked `hasLocal` but local asset could not be retrieved',
      );

      return null;
    }

    // Clients (local) may not correctly recognize a given asset as a motion photo. This allows for a scenario where both remote and local
    // have the same asset (hash), but only the remote properly recognizes it as a motion asset
    // If this scenario occurs, fall back to using the remote asset
    if (baseAsset.isMotionPhoto && !localAsset.isMotionPhoto) {
      // Platform mismatch for motion photo, use remote instead
      _log.warning(
        'Mismatched local and remote motion states on ${baseAsset.name} (${baseAsset.localId}), local = ${localAsset.isMotionPhoto}, remote = ${baseAsset.isMotionPhoto}',
      );

      return null;
    }

    return localAsset;
  }

  Future<void> _onPlaybackReady() async {
    if (!mounted || !widget.isCurrent) {
      return;
    }

    _notifier.onNativePlaybackReady();

    // onPlaybackReady may be called multiple times, usually when more data
    // loads. If this is not the first time that the player has become ready, we
    // should not autoplay.
    if (_isVideoReady) {
      return;
    }

    setState(() {
      _isVideoReady = true;
      _hasAudioError = false;
    });

    if (widget.autoPlayOverride == null && ref.read(assetViewerProvider).showingDetails) {
      return;
    }

    final autoPlayVideo =
        widget.autoPlayOverride ?? (!widget.asset.isAudio && ref.read(appConfigProvider).viewer.autoPlayVideo);
    if (autoPlayVideo || widget.asset.isMotionPhoto || (widget.asset.isAudio && _notifier.playRequested)) {
      await _notifier.play();
    }
  }

  void _onPlaybackEnded() {
    if (!mounted) {
      return;
    }

    _notifier.onNativePlaybackEnded();

    if (_controller?.playbackInfo?.status == PlaybackStatus.stopped) {
      ref.read(isPlayingMotionVideoProvider.notifier).playing = false;
    }
  }

  void _onPlaybackPositionChanged() {
    if (!mounted) {
      return;
    }
    _notifier.onNativePositionChanged();
  }

  void _onPlaybackStatusChanged() {
    if (!mounted) {
      return;
    }
    _notifier.onNativeStatusChanged();
  }

  void _onPlaybackError() {
    if (!mounted || !widget.asset.isAudio || _controller?.onError.value == null) {
      return;
    }
    final remoteId = widget.asset.remoteId;
    if (remoteId != null && _controller?.videoSource?.type != VideoSourceType.network && !_hasTriedRemoteAudio) {
      _hasTriedRemoteAudio = true;
      unawaited(_retryRemoteAudio(remoteId));
      return;
    }
    unawaited(_notifier.pause());
    setState(() => _hasAudioError = true);
  }

  Future<void> _retryRemoteAudio(String remoteId) async {
    if (!mounted) {
      return;
    }
    await _notifier.pauseForReload();
    if (!mounted) {
      return;
    }
    setState(() {
      _hasAudioError = false;
      _isVideoReady = false;
    });
    try {
      final endpoint = Store.get(StoreKey.serverEndpoint);
      final source = await VideoSource.init(
        path: '$endpoint/assets/$remoteId/video/playback',
        type: VideoSourceType.network,
        headers: ApiService.getRequestHeaders(),
      );
      if (mounted) {
        await _notifier.load(source);
      }
    } catch (error) {
      _log.warning('Error loading the remote audio copy', error);
      if (mounted) {
        setState(() => _hasAudioError = true);
      }
    }
  }

  void _removeListeners() {
    _controller?.onError.removeListener(_onPlaybackError);
    _controller?.onPlaybackPositionChanged.removeListener(_onPlaybackPositionChanged);
    _controller?.onPlaybackStatusChanged.removeListener(_onPlaybackStatusChanged);
    _controller?.onPlaybackReady.removeListener(_onPlaybackReady);
    _controller?.onPlaybackEnded.removeListener(_onPlaybackEnded);
  }

  Future<void> _loadVideo() async {
    final nc = _controller;
    if (nc == null || !mounted) {
      return;
    }
    if (nc.videoSource != null) {
      if (widget.asset.isAudio && widget.autoPlayOverride == true && widget.isCurrent) {
        await _notifier.play();
      }
      return;
    }

    final source = await videoSource;
    if (!mounted) {
      return;
    }
    if (source == null) {
      if (widget.asset.isAudio) {
        setState(() => _hasAudioError = true);
      }
      return;
    }

    // Grab refs to prevent reading after dispose
    final loopVideo = widget.loopOverride ?? ref.read(appConfigProvider).viewer.loopVideo;
    final localNotifier = _notifier;

    await localNotifier.load(source);
    await localNotifier.setLoop(!widget.asset.isMotionPhoto && !widget.asset.isAudio && loopVideo);
    if (widget.asset.isAudio && nc.videoSource == null && mounted) {
      setState(() => _hasAudioError = true);
    }
    await localNotifier.setVolume(1);
  }

  void _initController(NativeVideoPlayerController nc) {
    if (_controller != null || !mounted) {
      return;
    }

    _notifier.attachController(nc);

    nc.onError.addListener(_onPlaybackError);
    nc.onPlaybackPositionChanged.addListener(_onPlaybackPositionChanged);
    nc.onPlaybackStatusChanged.addListener(_onPlaybackStatusChanged);
    nc.onPlaybackReady.addListener(_onPlaybackReady);
    nc.onPlaybackEnded.addListener(_onPlaybackEnded);

    _controller = nc;

    if (widget.isCurrent) {
      unawaited(_loadVideo());
    }
  }

  @override
  Widget build(BuildContext context) {
    final isCasting = ref.watch(castProvider.select((c) => c.isCasting));
    final status = ref.watch(videoPlayerProvider(widget.asset.id).select((v) => v.status));
    // https://github.com/flutter/flutter/issues/97499: iOS platform views are only disposed in frames containing platform views, or on
    // the first frame after a platform view disappears. Animating this view away uses those disappearing frames. Instead, forcibly remove
    // the view from the tree when we start a route transition, which has the side effect of properly ordering the `dispose`
    final isRouteActive = ModalRoute.of(context)?.isActive ?? true;
    final showPlayer = !isCasting && isRouteActive;

    return IgnorePointer(
      ignoring: !widget.asset.isAudio,
      child: Stack(
        children: [
          if (!widget.asset.isAudio && (!_isVideoReady || widget.asset.isMotionPhoto || !showPlayer))
            Positioned.fill(child: widget.image),
          if (showPlayer)
            Visibility.maintain(
              visible: _isVideoReady && !widget.asset.isAudio,
              child: NativeVideoPlayerView(onViewReady: _initController),
            ),
          if (widget.asset.isAudio) Positioned.fill(child: widget.image),
          if (showPlayer)
            IgnorePointer(
              child: Center(
                child: AnimatedOpacity(
                  opacity: !_hasAudioError && status == VideoPlaybackStatus.buffering ? 1.0 : 0.0,
                  duration: const Duration(milliseconds: 400),
                  child: const CircularProgressIndicator(),
                ),
              ),
            ),
          if (_hasAudioError)
            Align(
              alignment: Alignment.bottomCenter,
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  context.t.audio_playback_failed,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
