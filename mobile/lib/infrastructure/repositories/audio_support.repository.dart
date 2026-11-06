import 'package:immich_mobile/services/server_info.service.dart';

class AudioSupportRepository {
  final ServerInfoService _serverInfoService;

  const AudioSupportRepository(this._serverInfoService);

  Future<bool> isSupported() async => (await _serverInfoService.getServerFeatures())?.audio ?? false;

  static bool isAudioFilename(String filename) {
    final extension = filename.split('.').last.toLowerCase();
    return const {
      'mp3',
      'm4a',
      'aac',
      'flac',
      'wav',
      'ogg',
      'oga',
      'opus',
      'wma',
      'aif',
      'aiff',
      'alac',
      'm4b',
      'amr',
      'caf',
    }.contains(extension);
  }
}
