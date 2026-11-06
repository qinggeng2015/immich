import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/native_audio_api.g.dart',
    swiftOut: 'ios/Runner/Audio/AudioMessages.g.swift',
    dartPackageName: 'immich_mobile',
  ),
)
@HostApi()
abstract class NativeAudioApi {
  @async
  String? pickDirectory();

  void removeDirectory(String albumId);

  @async
  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  String getFile(String assetId);
}
