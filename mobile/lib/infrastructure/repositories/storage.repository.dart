// ignore_for_file: avoid_slow_async_io

import 'dart:io';

import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/platform/native_audio_api.g.dart';
import 'package:immich_mobile/platform/native_directory_api.g.dart';
import 'package:logging/logging.dart';
import 'package:photo_manager/photo_manager.dart';

class StorageRepository {
  final log = Logger('StorageRepository');

  StorageRepository();

  Future<File?> getFileForAsset(String assetId) async {
    if (CurrentPlatform.isAndroid && assetId.startsWith('saf-file:')) {
      try {
        return File(await NativeDirectoryApi().getFile(assetId));
      } catch (error, stackTrace) {
        log.warning('Cannot read selected directory file $assetId', error, stackTrace);
        return null;
      }
    }
    if (CurrentPlatform.isIOS && assetId.startsWith('audio-file:')) {
      try {
        return File(await NativeAudioApi().getFile(assetId));
      } catch (error, stackTrace) {
        log.warning('Cannot read audio file $assetId', error, stackTrace);
        return null;
      }
    }
    File? file;

    try {
      final entity = await AssetEntity.fromId(assetId);
      file = await entity?.originFile;
      if (file == null) {
        log.warning("Cannot get file for asset $assetId");
        return null;
      }

      final exists = await file.exists();
      if (!exists) {
        log.warning("File for asset $assetId does not exist");
        return null;
      }
    } catch (error, stackTrace) {
      log.warning("Error getting file for asset $assetId", error, stackTrace);
    }
    return file;
  }

  // TODO(agg23): Unify these methods
  Future<File?> getMotionFileForAsset(LocalAsset asset) async {
    File? file;
    final log = Logger('StorageRepository');

    try {
      final entity = await AssetEntity.fromId(asset.id);
      file = await entity?.originFileWithSubtype;
      if (file == null) {
        log.warning(
          "Cannot get motion file for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        );
        return null;
      }

      final exists = await file.exists();
      if (!exists) {
        log.warning("Motion file for asset ${asset.id} does not exist");
        return null;
      }
    } catch (error, stackTrace) {
      log.warning(
        "Error getting motion file for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        error,
        stackTrace,
      );
    }
    return file;
  }

  Future<AssetEntity?> getAssetEntityForAsset(LocalAsset asset) async {
    if (asset.id.startsWith('saf-file:')) {
      return null;
    }
    final log = Logger('StorageRepository');

    AssetEntity? entity;

    try {
      entity = await AssetEntity.fromId(asset.id);
      if (entity == null) {
        log.warning(
          "Cannot get AssetEntity for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        );
      }
    } catch (error, stackTrace) {
      log.warning(
        "Error getting AssetEntity for asset ${asset.id}, name: ${asset.name}, created on: ${asset.createdAt}",
        error,
        stackTrace,
      );
    }
    return entity;
  }

  Future<bool> isAssetAvailableLocally(String assetId) async {
    if (assetId.startsWith('saf-file:')) {
      return false;
    }
    if (CurrentPlatform.isIOS && assetId.startsWith('audio-file:')) {
      return false;
    }
    try {
      final entity = await AssetEntity.fromId(assetId);
      if (entity == null) {
        log.warning("Cannot get AssetEntity for asset $assetId");
        return false;
      }

      return await entity.isLocallyAvailable(isOrigin: true);
    } catch (error, stackTrace) {
      log.warning("Error checking if asset is locally available $assetId", error, stackTrace);
      return false;
    }
  }

  Future<File?> loadFileFromCloud(String assetId, {PMProgressHandler? progressHandler}) async {
    if (assetId.startsWith('saf-file:')) {
      return getFileForAsset(assetId);
    }
    if (CurrentPlatform.isIOS && assetId.startsWith('audio-file:')) {
      return getFileForAsset(assetId);
    }
    try {
      final entity = await AssetEntity.fromId(assetId);
      if (entity == null) {
        log.warning("Cannot get AssetEntity for asset $assetId");
        return null;
      }

      return await entity.loadFile(progressHandler: progressHandler);
    } catch (error, stackTrace) {
      log.warning("Error loading file from cloud for asset $assetId", error, stackTrace);
      return null;
    }
  }

  Future<File?> loadMotionFileFromCloud(String assetId, {PMProgressHandler? progressHandler}) async {
    try {
      final entity = await AssetEntity.fromId(assetId);
      if (entity == null) {
        log.warning("Cannot get AssetEntity for asset $assetId");
        return null;
      }

      return await entity.loadFile(withSubtype: true, progressHandler: progressHandler);
    } catch (error, stackTrace) {
      log.warning("Error loading motion file from cloud for asset $assetId", error, stackTrace);
      return null;
    }
  }

  Future<void> clearCache() async {
    final log = Logger('StorageRepository');

    try {
      await PhotoManager.clearFileCache();
    } catch (error, stackTrace) {
      log.warning("Error clearing cache", error, stackTrace);
    }

    if (!CurrentPlatform.isIOS) {
      return;
    }

    try {
      if (await Directory.systemTemp.exists()) {
        await Directory.systemTemp.delete(recursive: true);
      }
    } catch (error, stackTrace) {
      log.warning("Error deleting temporary directory", error, stackTrace);
    }
  }
}
