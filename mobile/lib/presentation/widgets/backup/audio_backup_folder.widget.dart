import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/backup/backup.provider.dart';
import 'package:immich_mobile/providers/backup/backup_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/audio.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_ui/immich_ui.dart';

class AudioBackupFolder extends ConsumerStatefulWidget {
  const AudioBackupFolder({super.key});

  @override
  ConsumerState<AudioBackupFolder> createState() => _AudioBackupFolderState();
}

class _AudioBackupFolderState extends ConsumerState<AudioBackupFolder> {
  bool _busy = false;

  Future<void> _changeFolder({String? removeId}) async {
    setState(() => _busy = true);
    try {
      final api = ref.read(audioFolderRepositoryProvider);
      final manager = ref.read(backgroundSyncProvider);
      final albums = ref.read(backupAlbumProvider.notifier);
      String? addedId;
      if (removeId != null) {
        ref.read(backupProvider.notifier).stopForegroundBackup(reason: 'audio backup folder removed');
        final assetIds = await ref.read(driftProvider).localAlbumRepository.getAssetIds(removeId);
        if (!mounted) {
          return;
        }
        await ref.read(backgroundUploadServiceProvider).cancelAudioFolderUploads(removeId, assetIds);
        await api.removeDirectory(removeId);
      } else {
        addedId = await api.pickDirectory();
        if (addedId == null) {
          return;
        }
      }
      if (!mounted) {
        return;
      }
      ref.read(backupProvider.notifier).stopForegroundBackup(reason: 'audio backup folders updated');
      await manager.syncLocal(full: true);
      await albums.getAll();
      if (!mounted) {
        return;
      }
      final added = ref.read(backupAlbumProvider).firstWhereOrNull((album) => album.id == addedId);
      if (added != null) {
        await albums.selectAlbum(added);
      }
      if (!mounted) {
        return;
      }
      final user = ref.read(currentUserProvider);
      if (user == null) {
        return;
      }
      final backup = ref.read(backupProvider.notifier);
      final syncServer = ref.read(appConfigProvider).backup.enabled;
      final synced = await manager.prepareBackup(syncServer: syncServer);
      if (!mounted || !backup.mounted) {
        return;
      }
      await backup.getBackupStatus(user.id);
      if (!mounted || !backup.mounted || !synced || !SettingsRepository.instance.appConfig.backup.enabled) {
        return;
      }
      final auth = ref.read(authProvider);
      final isForeground = switch (WidgetsBinding.instance.lifecycleState) {
        AppLifecycleState.resumed || AppLifecycleState.inactive => true,
        _ => false,
      };
      if (syncServer && auth.isAuthenticated && auth.userId == user.id && isForeground) {
        await backup.startForegroundBackup(user.id);
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.t.error_title)));
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final supported = ref.watch(serverInfoProvider.select((state) => state.serverFeatures.audio));
    final folders = ref.watch(backupAlbumProvider).where((album) => album.id.startsWith('audio-folder:'));

    return Column(
      children: [
        SettingListTile(
          title: context.t.audio_backup_folder,
          subtitle: supported ? context.t.audio_backup_folder_description : context.t.audio_not_supported,
          leading: const Icon(Icons.audio_file_outlined),
          trailing: _busy ? const CircularProgressIndicator.adaptive() : const Icon(Icons.create_new_folder_outlined),
          onTap: supported && !_busy ? () => _changeFolder() : null,
        ),
        for (final folder in folders)
          SettingListTile(
            title: folder.name,
            trailing: IconButton(
              tooltip: context.t.audio_backup_folder_remove,
              icon: const Icon(Icons.remove_circle_outline),
              onPressed: _busy ? null : () => _changeFolder(removeId: folder.id),
            ),
          ),
      ],
    );
  }
}
