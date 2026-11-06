import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:background_downloader/background_downloader.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/providers/asset_viewer/download.provider.dart';
import 'package:immich_mobile/routing/router.dart';

class DownloadStatusFloatingButton extends ConsumerWidget {
  const DownloadStatusFloatingButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shouldShow = ref.watch(downloadStateProvider.select((state) => state.showProgress));
    final tasks = ref.watch(downloadStateProvider.select((state) => state.taskProgress)).values;
    final isDownloading = tasks.any(
      (task) =>
          task.status == TaskStatus.enqueued ||
          task.status == TaskStatus.running ||
          task.status == TaskStatus.waitingToRetry,
    );
    final hasError = tasks.any((task) => task.status == TaskStatus.failed || task.status == TaskStatus.notFound);
    final isComplete = tasks.isNotEmpty && tasks.every((task) => task.status == TaskStatus.complete);
    final icon = hasError
        ? Icons.error_outline
        : isDownloading
        ? Icons.downloading_rounded
        : isComplete
        ? Icons.download_done
        : Icons.download_rounded;
    final iconColor = hasError
        ? context.colorScheme.error
        : isComplete
        ? (context.isDarkTheme ? Colors.green[200] : Colors.green[400])
        : context.colorScheme.primary;

    return shouldShow
        ? Badge.count(
            count: tasks.length,
            textColor: context.colorScheme.onPrimary,
            backgroundColor: context.colorScheme.primary,
            child: FloatingActionButton(
              shape: RoundedRectangleBorder(
                borderRadius: const BorderRadius.all(Radius.circular(20)),
                side: BorderSide(color: context.colorScheme.outlineVariant, width: 1),
              ),
              backgroundColor: context.isDarkTheme
                  ? context.colorScheme.surfaceContainer
                  : context.colorScheme.surfaceBright,
              elevation: 2,
              onPressed: () {
                unawaited(context.pushRoute(const DownloadInfoRoute()));
              },
              child: Stack(
                alignment: AlignmentDirectional.center,
                children: [
                  Icon(icon, color: iconColor, size: 28),
                  if (isDownloading)
                    const SizedBox(
                      height: 31,
                      width: 31,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        backgroundColor: Colors.transparent,
                        value: null, // Indeterminate progress
                      ),
                    ),
                ],
              ),
            ),
          )
        : const SizedBox.shrink();
  }
}
