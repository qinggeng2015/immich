import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/infrastructure/repositories/directory.repository.dart';
import 'package:immich_mobile/platform/native_directory_api.g.dart';
import 'package:immich_mobile/providers/backup/backup_album.provider.dart';

final directoryRepositoryProvider = Provider((ref) => DirectoryRepository(NativeDirectoryApi()));

final unavailableDirectoryIdsProvider = FutureProvider((ref) async {
  ref.watch(backupAlbumProvider);
  final ids = await ref.watch(directoryRepositoryProvider).getUnavailableDirectoryIds();
  return ids.toSet();
});
