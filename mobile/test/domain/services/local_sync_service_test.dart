import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/local_sync.service.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/local_album.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/trashed_local_asset.repository.dart';
import 'package:immich_mobile/platform/native_sync_api.g.dart';
import 'package:immich_mobile/repositories/asset_media.repository.dart';
import 'package:mocktail/mocktail.dart';

import '../../fixtures/asset.stub.dart';
import '../../infrastructure/repository.mock.dart';
import '../../repository.mocks.dart';
import '../../service.mocks.dart';
import '../../unit/factories/local_asset_factory.dart';

void main() {
  late LocalSyncService sut;
  late LocalAlbumRepository mockLocalAlbumRepository;
  late TrashedLocalAssetRepository mockTrashedLocalAssetRepository;
  late AssetMediaRepository mockAssetMediaRepository;
  late MockPermissionRepository mockPermissionRepository;
  late MockNativeSyncApi mockNativeSyncApi;
  late Drift db;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
  });

  tearDownAll(() async {
    debugDefaultTargetPlatformOverride = null;
    await Store.clear();
    await db.close();
  });

  setUp(() async {
    mockLocalAlbumRepository = MockLocalAlbumRepository();
    mockTrashedLocalAssetRepository = MockTrashedLocalAssetRepository();
    mockAssetMediaRepository = MockAssetMediaRepository();
    mockPermissionRepository = MockPermissionRepository();
    mockNativeSyncApi = MockNativeSyncApi();

    when(() => mockNativeSyncApi.shouldFullSync()).thenAnswer((_) async => false);
    when(() => mockNativeSyncApi.getMediaChanges()).thenAnswer(
      (_) async => SyncDelta(hasChanges: false, updates: const [], deletes: const [], assetAlbums: const {}),
    );
    when(() => mockNativeSyncApi.getTrashedAssets()).thenAnswer((_) async => {});
    when(() => mockTrashedLocalAssetRepository.processTrashSnapshot(any())).thenAnswer((_) async {});
    when(() => mockTrashedLocalAssetRepository.getToRestore()).thenAnswer((_) async => []);
    when(() => mockTrashedLocalAssetRepository.getToTrash()).thenAnswer((_) async => {});
    when(() => mockTrashedLocalAssetRepository.applyRestoredAssets(any())).thenAnswer((_) async {});
    when(() => mockTrashedLocalAssetRepository.trashLocalAsset(any())).thenAnswer((_) async {});
    when(() => mockAssetMediaRepository.deleteAll(any())).thenAnswer((invocation) async {
      final ids = invocation.positionalArguments.first as List<String>;
      return ids;
    });

    sut = LocalSyncService(
      localAlbumRepository: mockLocalAlbumRepository,
      trashedLocalAssetRepository: mockTrashedLocalAssetRepository,
      assetMediaRepository: mockAssetMediaRepository,
      permissionRepository: mockPermissionRepository,
      nativeSyncApi: mockNativeSyncApi,
    );

    await Store.put(StoreKey.manageLocalMediaAndroid, false);
    when(() => mockPermissionRepository.hasManageMediaPermission()).thenAnswer((_) async => false);
  });

  test('folder rescans detect replacements even when album count and timestamp are unchanged', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = TargetPlatform.android);
    final folder = LocalAlbum(id: 'audio-folder:one', name: 'Recordings', updatedAt: DateTime(2026), assetCount: 1);
    registerFallbackValue(folder);
    final oldAudio = LocalAssetFactory.create(id: 'audio-file:old').copyWith(type: .audio);
    final newAudio = PlatformAsset(
      id: 'audio-file:new',
      name: 'recording.mp3',
      type: AssetType.audio.index,
      durationMs: 65000,
      orientation: 0,
      isFavorite: false,
      playbackStyle: PlatformAssetPlaybackStyle.unknown,
    );
    when(() => mockNativeSyncApi.getAssetsForAlbum(folder.id)).thenAnswer((_) async => [newAudio]);
    when(() => mockLocalAlbumRepository.getAssets(folder.id)).thenAnswer((_) async => [oldAudio]);
    when(
      () => mockLocalAlbumRepository.upsert(
        any(),
        toUpsert: any(named: 'toUpsert'),
        toDelete: any(named: 'toDelete'),
      ),
    ).thenAnswer((_) async {});

    await sut.updateAlbum(folder, folder);

    final captured = verify(
      () => mockLocalAlbumRepository.upsert(
        any(),
        toUpsert: captureAny(named: 'toUpsert'),
        toDelete: captureAny(named: 'toDelete'),
      ),
    ).captured;
    expect((captured[0] as Iterable<LocalAsset>).single.id, newAudio.id);
    expect(captured[1], [oldAudio.id]);
    verifyNever(() => mockNativeSyncApi.getCloudIdForAssetIds(any()));
  });

  test('revoked folder access leaves the stored assets intact', () async {
    final folder = LocalAlbum(id: 'audio-folder:revoked', name: 'Recordings', updatedAt: DateTime(2026), assetCount: 1);
    when(() => mockNativeSyncApi.getAssetsForAlbum(folder.id)).thenThrow(PlatformException(code: 'NO_ACCESS'));

    await sut.updateAlbum(folder, folder);

    verify(() => mockNativeSyncApi.getAssetsForAlbum(folder.id)).called(1);
    verifyZeroInteractions(mockLocalAlbumRepository);
  });

  for (final selection in [BackupSelection.selected, BackupSelection.excluded]) {
    test('Android audio retains $selection when permission is revoked and regained', () async {
      var storedAlbum = LocalAlbum(
        id: 'immich-audio',
        name: 'Audio',
        updatedAt: DateTime.fromMillisecondsSinceEpoch(1000000, isUtc: true),
        assetCount: 1,
        backupSelection: selection,
      );
      registerFallbackValue(storedAlbum);
      final audio = LocalAssetFactory.create(id: '123').copyWith(type: .audio);
      final platformAudio = PlatformAsset(
        id: audio.id,
        name: 'recording.mp3',
        type: AssetType.audio.index,
        durationMs: 65000,
        orientation: 0,
        isFavorite: false,
        playbackStyle: PlatformAssetPlaybackStyle.unknown,
      );
      var deviceCount = 0;
      final changes = <(LocalAlbum, List<LocalAsset>, List<String>)>[];
      when(() => mockNativeSyncApi.getAlbums()).thenAnswer(
        (_) async => [
          PlatformAlbum(id: 'immich-audio', name: 'Audio', updatedAt: 1000, isCloud: false, assetCount: deviceCount),
        ],
      );
      when(() => mockNativeSyncApi.getAssetsForAlbum('immich-audio')).thenAnswer((_) async => [platformAudio]);
      when(() => mockNativeSyncApi.getAssetsCountSince(any(), any())).thenAnswer((_) async => 0);
      when(() => mockNativeSyncApi.checkpointSync()).thenAnswer((_) async {});
      when(
        () => mockLocalAlbumRepository.getAll(sortBy: {SortLocalAlbumsBy.id}),
      ).thenAnswer((_) async => [storedAlbum]);
      when(() => mockLocalAlbumRepository.getAssets('immich-audio')).thenAnswer((_) async => [audio]);
      when(
        () => mockLocalAlbumRepository.upsert(
          any(),
          toUpsert: any(named: 'toUpsert'),
          toDelete: any(named: 'toDelete'),
        ),
      ).thenAnswer((invocation) async {
        storedAlbum = invocation.positionalArguments.single as LocalAlbum;
        changes.add((
          storedAlbum,
          (invocation.namedArguments[#toUpsert] as Iterable<LocalAsset>).toList(),
          (invocation.namedArguments[#toDelete] as Iterable<String>).toList(),
        ));
      });

      await sut.fullSync();

      expect(storedAlbum.assetCount, 0);
      expect(storedAlbum.backupSelection, selection);
      expect(changes.single.$3, [audio.id]);
      verifyNever(() => mockLocalAlbumRepository.deleteAlbum(any()));

      deviceCount = 1;
      await sut.fullSync();

      expect(storedAlbum.assetCount, 1);
      expect(storedAlbum.backupSelection, selection);
      expect(changes.last.$2.single.id, audio.id);
      verify(() => mockNativeSyncApi.checkpointSync()).called(2);
      verifyNever(() => mockLocalAlbumRepository.deleteAlbum(any()));
    });
  }

  group('LocalSyncService - syncTrashedAssets gating', () {
    test('invokes syncTrashedAssets when Android flag enabled and permission granted', () async {
      await Store.put(StoreKey.manageLocalMediaAndroid, true);
      when(() => mockPermissionRepository.hasManageMediaPermission()).thenAnswer((_) async => true);

      await sut.sync();

      verify(() => mockNativeSyncApi.getTrashedAssets()).called(1);
      verify(() => mockTrashedLocalAssetRepository.processTrashSnapshot(any())).called(1);
    });

    test('skips syncTrashedAssets when store flag disabled', () async {
      await Store.put(StoreKey.manageLocalMediaAndroid, false);
      when(() => mockPermissionRepository.hasManageMediaPermission()).thenAnswer((_) async => true);

      await sut.sync();

      verifyNever(() => mockNativeSyncApi.getTrashedAssets());
    });

    test('skips syncTrashedAssets when MANAGE_MEDIA permission absent', () async {
      await Store.put(StoreKey.manageLocalMediaAndroid, true);
      when(() => mockPermissionRepository.hasManageMediaPermission()).thenAnswer((_) async => false);

      await sut.sync();

      verifyNever(() => mockNativeSyncApi.getTrashedAssets());
    });

    test('skips syncTrashedAssets on non-Android platforms', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = TargetPlatform.android);

      await Store.put(StoreKey.manageLocalMediaAndroid, true);
      when(() => mockPermissionRepository.hasManageMediaPermission()).thenAnswer((_) async => true);

      await sut.sync();

      verifyNever(() => mockNativeSyncApi.getTrashedAssets());
    });
  });

  group('LocalSyncService - syncTrashedAssets behavior', () {
    test('processes trashed snapshot, restores assets, and trashes local files', () async {
      final platformAsset = PlatformAsset(
        id: 'remote-id',
        name: 'remote.jpg',
        type: AssetType.image.index,
        durationMs: 0,
        orientation: 0,
        isFavorite: false,
        playbackStyle: PlatformAssetPlaybackStyle.image,
      );

      final assetsToRestore = [LocalAssetStub.image1];
      when(() => mockTrashedLocalAssetRepository.getToRestore()).thenAnswer((_) async => assetsToRestore);
      final restoredIds = ['image1'];
      when(() => mockAssetMediaRepository.restoreAssetsFromTrash(any())).thenAnswer((invocation) async {
        final Iterable<LocalAsset> requested = invocation.positionalArguments.first as Iterable<LocalAsset>;
        expect(requested, orderedEquals(assetsToRestore));
        return restoredIds;
      });

      final localAssetToTrash = LocalAssetStub.image2.copyWith(id: 'local-trash', checksum: 'checksum-trash');
      when(() => mockTrashedLocalAssetRepository.getToTrash()).thenAnswer(
        (_) async => {
          'album-a': [localAssetToTrash],
        },
      );

      await sut.processTrashedAssets({
        'album-a': [platformAsset],
      });

      final trashedSnapshot =
          verify(() => mockTrashedLocalAssetRepository.processTrashSnapshot(captureAny())).captured.single
              as Iterable<TrashedAsset>;
      expect(trashedSnapshot.length, 1);
      final trashedEntry = trashedSnapshot.single;
      expect(trashedEntry.albumId, 'album-a');
      expect(trashedEntry.asset.id, platformAsset.id);
      expect(trashedEntry.asset.name, platformAsset.name);
      verify(() => mockTrashedLocalAssetRepository.getToTrash()).called(1);

      verify(() => mockAssetMediaRepository.restoreAssetsFromTrash(any())).called(1);
      verify(() => mockTrashedLocalAssetRepository.applyRestoredAssets(restoredIds)).called(1);

      final moveArgs = verify(() => mockAssetMediaRepository.deleteAll(captureAny())).captured.single as List<String>;
      expect(moveArgs, ['local-trash']);
      final trashArgs =
          verify(() => mockTrashedLocalAssetRepository.trashLocalAsset(captureAny())).captured.single
              as Map<String, List<LocalAsset>>;
      expect(trashArgs.keys, ['album-a']);
      expect(trashArgs['album-a'], [localAssetToTrash]);
    });

    test('records only local assets that were moved to device trash', () async {
      final movedAsset = LocalAssetStub.image1.copyWith(id: 'moved-local', checksum: 'checksum-moved');
      final skippedAsset = LocalAssetStub.image2.copyWith(id: 'skipped-local', checksum: 'checksum-skipped');
      when(() => mockTrashedLocalAssetRepository.getToTrash()).thenAnswer(
        (_) async => {
          'album-a': [movedAsset],
          'album-b': [skippedAsset],
        },
      );
      when(() => mockAssetMediaRepository.deleteAll(any())).thenAnswer((_) async => ['moved-local']);

      await sut.processTrashedAssets({});

      final trashArgs =
          verify(() => mockTrashedLocalAssetRepository.trashLocalAsset(captureAny())).captured.single
              as Map<String, List<LocalAsset>>;
      expect(trashArgs.keys, ['album-a']);
      expect(trashArgs['album-a'], [movedAsset]);
    });

    test('does not attempt restore when repository has no assets to restore', () async {
      when(() => mockTrashedLocalAssetRepository.getToRestore()).thenAnswer((_) async => []);

      await sut.processTrashedAssets({});

      final trashedSnapshot =
          verify(() => mockTrashedLocalAssetRepository.processTrashSnapshot(captureAny())).captured.single
              as Iterable<TrashedAsset>;
      expect(trashedSnapshot, isEmpty);
      verifyNever(() => mockAssetMediaRepository.restoreAssetsFromTrash(any()));
      verifyNever(() => mockTrashedLocalAssetRepository.applyRestoredAssets(any()));
    });

    test('does not move local assets when repository finds nothing to trash', () async {
      when(() => mockTrashedLocalAssetRepository.getToTrash()).thenAnswer((_) async => {});

      await sut.processTrashedAssets({});

      verifyNever(() => mockAssetMediaRepository.deleteAll(any()));
      verifyNever(() => mockTrashedLocalAssetRepository.trashLocalAsset(any()));
    });
  });

  group('LocalSyncService - PlatformAsset conversion', () {
    test('toLocalAsset uses correct updatedAt timestamp', () {
      final platformAsset = PlatformAsset(
        id: 'test-id',
        name: 'test.jpg',
        type: AssetType.image.index,
        durationMs: 0,
        orientation: 0,
        isFavorite: false,
        createdAt: 1700000000,
        updatedAt: 1732000000,
        playbackStyle: PlatformAssetPlaybackStyle.image,
      );

      final localAsset = platformAsset.toLocalAsset();

      expect(localAsset.createdAt.millisecondsSinceEpoch ~/ 1000, 1700000000);
      expect(localAsset.updatedAt.millisecondsSinceEpoch ~/ 1000, 1732000000);
      expect(localAsset.updatedAt, isNot(localAsset.createdAt));
    });
  });
}
