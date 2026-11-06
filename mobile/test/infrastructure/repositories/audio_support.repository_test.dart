import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/infrastructure/repositories/audio_support.repository.dart';
import 'package:immich_mobile/models/server_info/server_features.model.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../../service.mocks.dart';

void main() {
  test('generated API accepts an old feature response without audio or with a null capability', () {
    final response = <String, dynamic>{
      for (final field in [
        'backups',
        'configFile',
        'duplicateDetection',
        'email',
        'facialRecognition',
        'importFaces',
        'map',
        'oauth',
        'oauthAutoLaunch',
        'ocr',
        'passwordLogin',
        'realtimeTranscoding',
        'reverseGeocoding',
        'search',
        'sidecar',
        'smartSearch',
        'trash',
      ])
        field: false,
    };
    expect(ServerFeatures.fromDto(ServerFeaturesDto.fromJson(response)!).audio, isFalse);
    response['audio'] = null;
    expect(ServerFeatures.fromDto(ServerFeaturesDto.fromJson(response)!).audio, isFalse);
    response['audio'] = true;
    expect(ServerFeatures.fromDto(ServerFeaturesDto.fromJson(response)!).audio, isTrue);
  });

  test('audio is disabled when server features are missing', () async {
    final server = MockServerInfoService();
    when(server.getServerFeatures).thenAnswer((_) async => null);
    expect(await AudioSupportRepository(server).isSupported(), isFalse);
  });

  test('an older server defaults audio to disabled', () async {
    final server = MockServerInfoService();
    when(
      server.getServerFeatures,
    ).thenAnswer((_) async => const ServerFeatures(trash: true, map: true, oauthEnabled: false, passwordLogin: true));
    expect(await AudioSupportRepository(server).isSupported(), isFalse);
  });

  test('capability is rechecked when the connected server changes', () async {
    final server = MockServerInfoService();
    final support = AudioSupportRepository(server);
    when(server.getServerFeatures).thenAnswer(
      (_) async => const ServerFeatures(trash: true, map: true, oauthEnabled: false, passwordLogin: true, audio: true),
    );
    expect(await support.isSupported(), isTrue);
    when(server.getServerFeatures).thenAnswer((_) async => null);
    expect(await support.isSupported(), isFalse);
  });

  test('recognizes common audio filenames without treating images and videos as audio', () {
    for (final file in ['recording.M4A', 'track.mp3', 'lossless.flac', 'sound.wav', 'voice.opus', 'sound.aiff']) {
      expect(AudioSupportRepository.isAudioFilename(file), isTrue, reason: file);
    }
    for (final file in ['image.jpg', 'video.mp4', 'animation.gif', 'audio.mp3.jpg']) {
      expect(AudioSupportRepository.isAudioFilename(file), isFalse, reason: file);
    }
  });
}
