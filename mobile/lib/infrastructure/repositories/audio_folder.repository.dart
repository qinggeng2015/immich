import 'package:immich_mobile/platform/native_audio_api.g.dart';

class AudioFolderRepository {
  final NativeAudioApi _api;

  const AudioFolderRepository(this._api);

  Future<String?> pickDirectory() => _api.pickDirectory();

  Future<void> removeDirectory(String albumId) => _api.removeDirectory(albumId);
}
