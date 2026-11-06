import 'dart:async';

import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/backup/backup_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/directory.provider.dart';
import 'package:logging/logging.dart';

class ChooseBackupDirectory extends ConsumerStatefulWidget {
  final VoidCallback? onSelected;
  final bool compact;

  const ChooseBackupDirectory({super.key, this.onSelected, this.compact = false});

  @override
  ConsumerState<ChooseBackupDirectory> createState() => _ChooseBackupDirectoryState();
}

class _ChooseBackupDirectoryState extends ConsumerState<ChooseBackupDirectory> with WidgetsBindingObserver {
  final _log = Logger('ChooseBackupDirectory');
  bool _busy = false;
  Completer<bool>? _foreground;

  bool get _isForeground => switch (WidgetsBinding.instance.lifecycleState) {
    AppLifecycleState.resumed || AppLifecycleState.inactive => true,
    _ => false,
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _foreground?.complete(false);
    _foreground = null;
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_isForeground || state == AppLifecycleState.detached) {
      _foreground?.complete(_isForeground);
      _foreground = null;
    }
  }

  Future<bool> _waitForForeground() => _isForeground ? Future.value(true) : (_foreground ??= Completer<bool>()).future;

  Future<void> _chooseDirectory() async {
    setState(() => _busy = true);
    String? albumId;
    var operation = 'picking directory';
    try {
      albumId = await ref.read(directoryRepositoryProvider).pickDirectory();
      if (albumId == null || !mounted) {
        return;
      }
      if (!await _waitForForeground() || !mounted) {
        return;
      }
      final existing = ref.read(backupAlbumProvider).firstWhereOrNull((album) => album.id == albumId);
      final preserveSelection = existing != null && (widget.compact || existing.backupSelection != .none);

      operation = 'synchronizing directory';
      final completed = await ref
          .read(backgroundSyncProvider)
          .awaitFullLocalSync(shouldContinue: () => mounted && _isForeground);
      if (!completed || !mounted) {
        return;
      }
      final unavailable = await ref.read(directoryRepositoryProvider).getUnavailableDirectoryIds();
      if (!mounted) {
        return;
      }
      if (unavailable.contains(albumId)) {
        throw StateError('Selected directory scan was incomplete');
      }

      operation = 'loading directory album';
      final albums = ref.read(backupAlbumProvider.notifier);
      await albums.getAll();
      if (!mounted) {
        return;
      }

      final added = ref.read(backupAlbumProvider).firstWhereOrNull((album) => album.id == albumId);
      if (added == null) {
        throw StateError('Selected directory was not synchronized');
      }
      if (!preserveSelection) {
        operation = 'selecting directory album';
        await albums.selectAlbum(added);
      }
      if (mounted) {
        ref.invalidate(unavailableDirectoryIdsProvider);
        widget.onSelected?.call();
      }
    } catch (error, stackTrace) {
      _log.warning('Directory selection failed while $operation (${error.runtimeType})', null, stackTrace);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              albumId == null ? context.t.backup_directory_unavailable : context.t.backup_directory_sync_failed,
            ),
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.compact) {
      return IconButton(
        tooltip: context.t.backup_directory_reselect,
        onPressed: _busy ? null : _chooseDirectory,
        icon: _busy
            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
            : const Icon(Icons.folder_open_outlined),
      );
    }
    return ListTile(
      leading: const Icon(Icons.create_new_folder_outlined),
      title: Text(context.t.backup_choose_directory),
      subtitle: Text(context.t.backup_choose_directory_description),
      trailing: _busy
          ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))
          : const Icon(Icons.chevron_right),
      onTap: _busy ? null : _chooseDirectory,
    );
  }
}
