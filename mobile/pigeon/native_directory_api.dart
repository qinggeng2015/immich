import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/native_directory_api.g.dart',
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/directories/DirectoryMessages.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.directories'),
    dartPackageName: 'immich_mobile',
  ),
)
@HostApi()
abstract class NativeDirectoryApi {
  @async
  String? pickDirectory();

  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  void removeDirectory(String albumId);

  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  List<String> getUnavailableDirectoryIds();

  @async
  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  String getFile(String assetId);
}
