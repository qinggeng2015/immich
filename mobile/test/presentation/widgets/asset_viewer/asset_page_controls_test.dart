import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_page.widget.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/audio_cover.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/widgets/photo_view/photo_view.dart';

import '../../../fixtures/asset.stub.dart';
import '../../../unit/factories/remote_asset_factory.dart';
import '../../../unit/presentation/presentation_context.dart';

class _SingleAssetTimelineService extends TimelineService {
  final BaseAsset asset;

  _SingleAssetTimelineService(this.asset)
    : super((
        assetSource: (_, _) async => [],
        bucketSource: () => Stream.value(const [Bucket(assetCount: 1)]),
        origin: TimelineOrigin.main,
      ));

  @override
  int get totalAssets => 1;

  @override
  BaseAsset? getAssetSafe(int index) => index == 0 ? asset : null;
}

void main() {
  late PresentationContext context;

  setUp(() async {
    context = await PresentationContext.create();
  });

  tearDown(() async {
    await context.dispose();
  });

  testWidgets('audio with zero Android media dimensions has a finite viewer layout', (tester) async {
    final audio = RemoteAssetFactory.create(type: .audio).copyWith(width: 0, height: 0, durationMs: 65000);
    final timeline = _SingleAssetTimelineService(audio);
    addTearDown(timeline.dispose);
    await tester.pumpTestWidget(
      context,
      const Material(child: AssetPage(index: 0, heroOffset: 0)),
      overrides: [timelineServiceProvider.overrideWithValue(timeline)],
      expectSettle: false,
    );
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.byType(AudioCover), findsOneWidget);
    final size = tester.getSize(find.byType(AudioCover));
    expect(size.width.isFinite && size.height.isFinite, isTrue);
    expect(size.width, greaterThan(0));
    expect(size.height, greaterThan(0));
    expect(tester.takeException(), isNull);
  });

  testWidgets('keeps controls hidden after zooming back out', (tester) async {
    final timeline = _SingleAssetTimelineService(LocalAssetStub.image1);
    final container = ProviderContainer(
      overrides: [...context.overrides, timelineServiceProvider.overrideWithValue(timeline)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: EasyLocalization(
          supportedLocales: locales.values.toList(),
          path: translationsPath,
          startLocale: locales.values.first,
          fallbackLocale: locales.values.first,
          saveLocale: false,
          useFallbackTranslations: true,
          assetLoader: const CodegenLoader(),
          child: Builder(
            builder: (context) => MaterialApp(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: const Material(child: AssetPage(index: 0, heroOffset: 0)),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 600));

    final controls = container.read(assetViewerProvider.notifier);
    controls.setControls(false);

    final photoView = tester.widget<PhotoView>(find.byType(PhotoView));
    photoView.scaleStateChangedCallback!(PhotoViewScaleState.zoomedIn);
    await tester.pump();
    expect(container.read(assetViewerProvider).isZoomed, isTrue);

    photoView.scaleStateChangedCallback!(PhotoViewScaleState.initial);
    await tester.pump();

    expect(container.read(assetViewerProvider).isZoomed, isFalse);
    expect(container.read(assetViewerProvider).showingControls, isFalse);
  });

  testWidgets('keeps controls hidden after pinching out past the fitted size', (tester) async {
    final timeline = _SingleAssetTimelineService(LocalAssetStub.image1);
    final container = ProviderContainer(
      overrides: [...context.overrides, timelineServiceProvider.overrideWithValue(timeline)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: EasyLocalization(
          supportedLocales: locales.values.toList(),
          path: translationsPath,
          startLocale: locales.values.first,
          fallbackLocale: locales.values.first,
          saveLocale: false,
          useFallbackTranslations: true,
          assetLoader: const CodegenLoader(),
          child: Builder(
            builder: (context) => MaterialApp(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: const Material(child: AssetPage(index: 0, heroOffset: 0)),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 600));

    final controls = container.read(assetViewerProvider.notifier);
    controls.setControls(false);

    final photoView = tester.widget<PhotoView>(find.byType(PhotoView));

    // Pinching smaller than the fitted size reports zoomedOut, not isZoomed,
    // but it still hides controls and must not restore a stale "showing" value.
    photoView.scaleStateChangedCallback!(PhotoViewScaleState.zoomedOut);
    await tester.pump();
    expect(container.read(assetViewerProvider).isZoomed, isFalse);

    photoView.scaleStateChangedCallback!(PhotoViewScaleState.initial);
    await tester.pump();

    expect(container.read(assetViewerProvider).showingControls, isFalse);
  });

  testWidgets('keeps controls hidden after double-tapping back to original size', (tester) async {
    final timeline = _SingleAssetTimelineService(LocalAssetStub.image1);
    final container = ProviderContainer(
      overrides: [...context.overrides, timelineServiceProvider.overrideWithValue(timeline)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: EasyLocalization(
          supportedLocales: locales.values.toList(),
          path: translationsPath,
          startLocale: locales.values.first,
          fallbackLocale: locales.values.first,
          saveLocale: false,
          useFallbackTranslations: true,
          assetLoader: const CodegenLoader(),
          child: Builder(
            builder: (context) => MaterialApp(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: const Material(child: AssetPage(index: 0, heroOffset: 0)),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 600));

    final controls = container.read(assetViewerProvider.notifier);
    controls.setControls(false);

    final photoView = tester.widget<PhotoView>(find.byType(PhotoView));

    // Double-tap cycles through originalSize before returning to initial.
    photoView.scaleStateChangedCallback!(PhotoViewScaleState.originalSize);
    await tester.pump();

    photoView.scaleStateChangedCallback!(PhotoViewScaleState.initial);
    await tester.pump();

    expect(container.read(assetViewerProvider).showingControls, isFalse);
  });

  testWidgets('restores controls after zoom if they were showing beforehand', (tester) async {
    final timeline = _SingleAssetTimelineService(LocalAssetStub.image1);
    final container = ProviderContainer(
      overrides: [...context.overrides, timelineServiceProvider.overrideWithValue(timeline)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: EasyLocalization(
          supportedLocales: locales.values.toList(),
          path: translationsPath,
          startLocale: locales.values.first,
          fallbackLocale: locales.values.first,
          saveLocale: false,
          useFallbackTranslations: true,
          assetLoader: const CodegenLoader(),
          child: Builder(
            builder: (context) => MaterialApp(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: const Material(child: AssetPage(index: 0, heroOffset: 0)),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 600));

    // Controls start out showing (the default), so zooming and returning to
    // the fitted size should bring them back.
    expect(container.read(assetViewerProvider).showingControls, isTrue);

    final photoView = tester.widget<PhotoView>(find.byType(PhotoView));
    photoView.scaleStateChangedCallback!(PhotoViewScaleState.zoomedIn);
    await tester.pump();
    expect(container.read(assetViewerProvider).showingControls, isFalse);

    photoView.scaleStateChangedCallback!(PhotoViewScaleState.initial);
    await tester.pump();

    expect(container.read(assetViewerProvider).showingControls, isTrue);
  });
}
