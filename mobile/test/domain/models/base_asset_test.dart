import 'package:flutter_test/flutter_test.dart';

import '../../unit/factories/local_asset_factory.dart';
import '../../unit/factories/remote_asset_factory.dart';

void main() {
  test('audio uses a square aspect ratio for missing, zero, or embedded-cover dimensions', () {
    for (final dimensions in [(0, 0), (100, 200), (-1, 0)]) {
      final audio = RemoteAssetFactory.create(type: .audio).copyWith(width: dimensions.$1, height: dimensions.$2);
      expect(audio.aspectRatio, 1);
      expect(audio.aspectRatio.isFinite, isTrue);
    }
    expect(RemoteAssetFactory.create(type: .audio).aspectRatio, 1);
  });

  test('photo and video dimensions preserve their display aspect ratio', () {
    final photo = RemoteAssetFactory.create(type: .image).copyWith(width: 1200, height: 600);
    final video = RemoteAssetFactory.create(type: .video).copyWith(width: 600, height: 1200);
    expect(photo.aspectRatio, 2);
    expect(video.aspectRatio, 0.5);
    expect(photo.hasDimensions, isTrue);
    expect(video.hasDimensions, isTrue);
    expect(photo.copyWith(height: 0).aspectRatio, 1);
    expect(photo.copyWith(height: 0).hasDimensions, isFalse);
  });

  test('audio has duration but does not enable image or video features', () {
    final audio = RemoteAssetFactory.create(type: .audio).copyWith(durationMs: 65000);

    expect(audio.isAudio, isTrue);
    expect(audio.isImage, isFalse);
    expect(audio.isVideo, isFalse);
    expect(audio.isEditable, isFalse);
    expect(audio.isMotionPhoto, isFalse);
    expect(audio.duration, const Duration(seconds: 65));
  });

  test('image and video retain their existing type classification', () {
    final image = RemoteAssetFactory.create(type: .image);
    final video = RemoteAssetFactory.create(type: .video);

    expect(image.isImage, isTrue);
    expect(image.isAudio, isFalse);
    expect(image.isEditable, isTrue);
    expect(video.isVideo, isTrue);
    expect(video.isAudio, isFalse);
    expect(video.isEditable, isFalse);
  });

  group('BaseAsset.refersToSameAsset', () {
    test('search/folder copy (localId null) matches the merged DB copy (localId set)', () {
      // #29472: search and folder assets arrive with localId null, then the viewer
      // watches the DB copy which fills localId. heroTag embeds localId, so it
      // diverges for the same asset and isCurrent used to go false.
      final searchCopy = RemoteAssetFactory.create(id: 'asset-1');
      final mergedCopy = searchCopy.copyWith(localId: 'local-1');

      expect(searchCopy.localId, isNull);
      expect(mergedCopy.localId, 'local-1');
      expect(searchCopy.heroTag, isNot(mergedCopy.heroTag));

      expect(searchCopy.refersToSameAsset(mergedCopy), isTrue);
      expect(mergedCopy.refersToSameAsset(searchCopy), isTrue);
    });

    test('different remote assets are not the same', () {
      final a = RemoteAssetFactory.create(id: 'asset-1');
      final b = RemoteAssetFactory.create(id: 'asset-2');

      expect(a.refersToSameAsset(b), isFalse);
    });

    test('same checksum but different remote ids are not the same (duplicate files)', () {
      final a = RemoteAssetFactory.create(id: 'asset-1');
      final b = RemoteAssetFactory.create(id: 'asset-2').copyWith(checksum: a.checksum);

      expect(a.checksum, b.checksum);
      expect(a.refersToSameAsset(b), isFalse);
    });

    test('falls back to checksum when only one side has an id (local-only vs remote-only)', () {
      final remoteOnly = RemoteAssetFactory.create(id: 'asset-1');
      final localOnly = LocalAssetFactory.create(id: 'local-1').copyWith(checksum: remoteOnly.checksum);

      expect(remoteOnly.refersToSameAsset(localOnly), isTrue);
      expect(localOnly.refersToSameAsset(remoteOnly), isTrue);
    });
  });

  group('BaseAsset.id', () {
    test('survives the DB copy filling localId', () {
      final searchCopy = RemoteAssetFactory.create(id: 'asset-1');
      final mergedCopy = searchCopy.copyWith(localId: 'local-1');

      expect(searchCopy.heroTag, isNot(mergedCopy.heroTag));
      expect(mergedCopy.id, searchCopy.id);
    });

    test('survives a local asset gaining a remote id', () {
      final localOnly = LocalAssetFactory.create(id: 'local-1');
      final uploaded = localOnly.copyWith(remoteId: 'asset-1');

      expect(localOnly.heroTag, isNot(uploaded.heroTag));
      expect(uploaded.id, localOnly.id);
    });

    test('differs between assets', () {
      final a = RemoteAssetFactory.create(id: 'asset-1');
      final b = RemoteAssetFactory.create(id: 'asset-2');
      final local = LocalAssetFactory.create(id: 'local-1');

      expect(a.id, isNot(b.id));
      expect(local.id, isNot(a.id));
    });
  });
}
