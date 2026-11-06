import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/audio_cover.widget.dart';
import 'package:immich_mobile/presentation/widgets/images/full_image.widget.dart';
import 'package:immich_mobile/presentation/widgets/images/image_provider.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail.widget.dart';

import '../../../unit/factories/local_asset_factory.dart';
import '../../../unit/factories/remote_asset_factory.dart';
import '../../../unit/presentation/presentation_context.dart';

void main() {
  late PresentationContext context;

  setUp(() async {
    context = await PresentationContext.create();
  });

  tearDown(() async {
    await context.dispose();
  });

  testWidgets('local audio thumbnail shows play and duration without a media image request', (tester) async {
    final audio = LocalAssetFactory.create().copyWith(type: .audio, durationMs: 65000);
    final thumbnail = Thumbnail.fromAsset(asset: audio);

    expect(thumbnail.imageProvider, isNull);
    expect(thumbnail.thumbhashProvider, isNull);
    expect(getThumbnailImageProvider(audio), isNull);

    await tester.pumpTestWidget(context, SizedBox(width: 100, height: 100, child: thumbnail));

    expect(find.byIcon(Icons.play_circle_outline_rounded), findsOneWidget);
    expect(find.text('01:05'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('remote audio uses the same cover even before server thumbnails exist', (tester) async {
    final audio = RemoteAssetFactory.create(type: .audio, name: 'recording.flac').copyWith(durationMs: 3661000);

    await tester.pumpTestWidget(context, FullImage(audio, size: const Size(200, 200)));

    expect(find.byType(AudioCover), findsOneWidget);
    expect(find.text('01:01:01'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('audio cover fits compact album previews with missing duration', (tester) async {
    final audio = RemoteAssetFactory.create(type: .audio);

    await tester.pumpTestWidget(context, SizedBox(width: 60, height: 40, child: Thumbnail.fromAsset(asset: audio)));

    expect(find.text('00:00'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the viewer cover exposes an operable play button', (tester) async {
    final audio = RemoteAssetFactory.create(type: .audio);
    var presses = 0;
    await tester.pumpTestWidget(context, AudioCover(asset: audio, showName: true, onPressed: () => presses++));

    await tester.tap(find.byType(IconButton));

    expect(presses, 1);
  });
}
