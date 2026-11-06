import 'package:immich_mobile/platform/native_directory_api.g.dart';

class DirectoryRepository {
  final NativeDirectoryApi _api;

  const DirectoryRepository(this._api);

  Future<String?> pickDirectory() => _api.pickDirectory();

  Future<void> removeDirectory(String albumId) => _api.removeDirectory(albumId);

  Future<List<String>> getUnavailableDirectoryIds() => _api.getUnavailableDirectoryIds();
}
