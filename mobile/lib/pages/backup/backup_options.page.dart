import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/config/backup_config.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/backup/backup.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/widgets/settings/backup_settings/backup_settings.dart';
import 'package:logging/logging.dart';

@RoutePage()
class BackupOptionsPage extends ConsumerStatefulWidget {
  const BackupOptionsPage({super.key});

  @override
  ConsumerState<BackupOptionsPage> createState() => _BackupOptionsPageState();
}

class _BackupOptionsPageState extends ConsumerState<BackupOptionsPage> {
  late final BackupConfig previousBackup;
  bool hasPopped = false;

  @override
  void initState() {
    super.initState();
    previousBackup = ref.read(appConfigProvider).backup;
  }

  @override
  Widget build(BuildContext context) {
    final previousCellularForVideos = previousBackup.useCellularForVideos;
    final previousCellularForPhotos = previousBackup.useCellularForPhotos;
    final previousCellularForAudio = previousBackup.useCellularForAudio;
    return PopScope(
      onPopInvokedWithResult: (didPop, result) async {
        final currentBackup = ref.read(appConfigProvider).backup;
        final currentCellularForVideos = currentBackup.useCellularForVideos;
        final currentCellularForPhotos = currentBackup.useCellularForPhotos;
        final currentCellularForAudio = currentBackup.useCellularForAudio;

        if (currentCellularForVideos == previousCellularForVideos &&
            currentCellularForPhotos == previousCellularForPhotos &&
            currentCellularForAudio == previousCellularForAudio) {
          return;
        }

        if (didPop && !hasPopped) {
          hasPopped = true;

          final currentUser = ref.read(currentUserProvider);
          if (currentUser == null) {
            return;
          }

          final backupNotifier = ref.read(backupProvider.notifier);
          final backgroundSync = ref.read(backgroundSyncProvider);
          final backgroundUpload = ref.read(backgroundUploadServiceProvider);
          final container = ProviderScope.containerOf(context, listen: false);
          backupNotifier.stopForegroundBackup(reason: "backup settings updated");
          if (CurrentPlatform.isIOS) {
            await backgroundUpload.cancel();
          }
          await backupNotifier.getBackupStatus(currentUser.id);
          final isBackupEnabled = SettingsRepository.instance.appConfig.backup.enabled;
          if (!isBackupEnabled) {
            return;
          }

          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(context.t.network_requirements_updated), duration: const Duration(seconds: 4)),
            );
          }

          unawaited(
            backgroundSync.syncRemote().then((success) async {
              if (!backupNotifier.mounted || !SettingsRepository.instance.appConfig.backup.enabled) {
                return;
              }
              final auth = container.read(authProvider);
              final isForeground = switch (WidgetsBinding.instance.lifecycleState) {
                AppLifecycleState.resumed || AppLifecycleState.inactive => true,
                _ => false,
              };
              if (success && auth.isAuthenticated && auth.userId == currentUser.id && isForeground) {
                return backupNotifier.startForegroundBackup(currentUser.id);
              } else if (!success) {
                Logger('BackupOptionsPage').warning('Background sync failed, not starting backup');
              }
            }),
          );
        }
      },
      child: Scaffold(
        appBar: AppBar(title: Text(context.t.backup_options)),
        body: const BackupSettings(),
      ),
    );
  }
}
