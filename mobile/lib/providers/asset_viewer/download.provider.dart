import 'package:background_downloader/background_downloader.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/models/download/download_state.model.dart';
import 'package:immich_mobile/services/download.service.dart';

class DownloadStateNotifier extends StateNotifier<DownloadState> {
  final DownloadService _downloadService;

  DownloadStateNotifier(this._downloadService)
    : super(
        const DownloadState(
          downloadStatus: TaskStatus.complete,
          showProgress: false,
          taskProgress: <String, DownloadInfo>{},
        ),
      ) {
    _downloadService.onImageDownloadStatus = _downloadStatusCallback;
    _downloadService.onVideoDownloadStatus = _downloadStatusCallback;
    _downloadService.onAudioDownloadStatus = _downloadStatusCallback;
    _downloadService.onLivePhotoDownloadStatus = _downloadStatusCallback;
    _downloadService.onTaskProgress = _taskProgressCallback;
  }

  void _downloadStatusCallback(TaskStatusUpdate update) {
    if (update.status == TaskStatus.canceled) {
      return;
    }

    final existing =
        state.taskProgress[update.task.taskId] ??
        DownloadInfo(progress: 0, fileName: update.task.filename, status: update.status);

    state = state.copyWith(
      showProgress: true,
      taskProgress: <String, DownloadInfo>{}
        ..addAll(state.taskProgress)
        ..addAll({
          update.task.taskId: existing.copyWith(
            status: update.status,
            progress: update.status == TaskStatus.complete ? 1 : existing.progress,
          ),
        }),
    );
  }

  void _taskProgressCallback(TaskProgressUpdate update) {
    // Ignore if the task is canceled or completed
    if (update.progress < 0 || state.taskProgress[update.task.taskId]?.status.isFinalState == true) {
      return;
    }

    final progress = update.task.group == kDownloadGroupAudio && update.progress == 1 ? 0.99 : update.progress;
    state = state.copyWith(
      showProgress: true,
      taskProgress: <String, DownloadInfo>{}
        ..addAll(state.taskProgress)
        ..addAll({
          update.task.taskId: DownloadInfo(
            progress: progress,
            fileName: update.task.filename,
            status: TaskStatus.running,
          ),
        }),
    );
  }

  Future<void> cancelDownload(String id) async {
    final isCanceled = await _downloadService.cancelDownload(id);

    if (isCanceled) {
      state = state.copyWith(
        taskProgress: <String, DownloadInfo>{}
          ..addAll(state.taskProgress)
          ..remove(id),
      );
    }

    if (state.taskProgress.isEmpty) {
      state = state.copyWith(showProgress: false);
    }
  }
}

final downloadStateProvider = StateNotifierProvider<DownloadStateNotifier, DownloadState>(
  (ref) => DownloadStateNotifier(ref.watch(downloadServiceProvider)),
);
