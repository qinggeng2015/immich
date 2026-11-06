import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/backup/choose_backup_directory.widget.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/backup/backup.provider.dart';
import 'package:immich_mobile/providers/backup/backup_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/directory.provider.dart';
import 'package:immich_mobile/widgets/backup/album_info_list_tile.dart';

class BackupDirectoryTile extends ConsumerStatefulWidget {
  final LocalAlbum album;
  final VoidCallback? onChanged;

  const BackupDirectoryTile({super.key, required this.album, this.onChanged});

  @override
  ConsumerState<BackupDirectoryTile> createState() => _BackupDirectoryTileState();
}

class _BackupDirectoryTileState extends ConsumerState<BackupDirectoryTile> {
  bool _busy = false;

  Future<void> _removeDirectory() async {
    setState(() => _busy = true);
    try {
      ref.read(backupProvider.notifier).stopForegroundBackup(reason: 'backup directory removed');
      await ref.read(directoryRepositoryProvider).removeDirectory(widget.album.id);
      if (!mounted) {
        return;
      }
      final albums = ref.read(backupAlbumProvider.notifier);
      await albums.deselectAlbum(widget.album);
      if (!mounted) {
        return;
      }
      widget.onChanged?.call();
      await ref.read(backgroundSyncProvider).syncLocal(full: true);
      await albums.getAll();
      if (mounted) {
        ref.invalidate(unavailableDirectoryIdsProvider);
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
    final unavailable = ref.watch(unavailableDirectoryIdsProvider).value?.contains(widget.album.id) ?? false;
    return AlbumInfoListTile(
      album: widget.album,
      statusText: unavailable ? context.t.backup_directory_unavailable : null,
      previewAction: unavailable ? ChooseBackupDirectory(compact: true, onSelected: widget.onChanged) : null,
      trailingAction: IconButton(
        tooltip: context.t.backup_directory_remove,
        onPressed: _busy ? null : _removeDirectory,
        icon: _busy
            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
            : const Icon(Icons.remove_circle_outline),
      ),
    );
  }
}
