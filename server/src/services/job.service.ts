import { BadRequestException, Injectable } from '@nestjs/common';
import type { JobItem } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { JobCreateDto } from 'src/dtos/job.dto.js';
import {
  AssetType,
  AssetVisibility,
  AudioAnalysisStatus,
  IntegrityReport,
  JobName,
  JobStatus,
  ManualJobName,
} from 'src/enum.js';
import { ArgsOf } from 'src/repositories/event.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { isCurrentAudioSource } from 'src/utils/audio-summary.js';
import { hexOrBufferToBase64 } from 'src/utils/bytes.js';
import {
  getAudioSummaryConfig,
  getSpeechToTextConfig,
  isAudioSummaryEnabled,
  isSpeechToTextEnabled,
} from 'src/utils/misc.js';

const asJobItem = (dto: JobCreateDto): JobItem => {
  switch (dto.name) {
    case ManualJobName.TagCleanup: {
      return { name: JobName.TagCleanup };
    }

    case ManualJobName.PersonCleanup: {
      return { name: JobName.PersonCleanup };
    }

    case ManualJobName.UserCleanup: {
      return { name: JobName.UserDeleteCheck };
    }

    case ManualJobName.MemoryCleanup: {
      return { name: JobName.MemoryCleanup };
    }

    case ManualJobName.MemoryCreate: {
      return { name: JobName.MemoryGenerate };
    }

    case ManualJobName.BackupDatabase: {
      return { name: JobName.DatabaseBackup };
    }

    case ManualJobName.IntegrityMissingFiles: {
      return { name: JobName.IntegrityMissingFilesQueueAll };
    }

    case ManualJobName.IntegrityUntrackedFiles: {
      return { name: JobName.IntegrityUntrackedFilesQueueAll };
    }

    case ManualJobName.IntegrityChecksumFiles: {
      return { name: JobName.IntegrityChecksumFiles };
    }

    case ManualJobName.IntegrityMissingFilesRefresh: {
      return { name: JobName.IntegrityMissingFilesQueueAll, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityUntrackedFilesRefresh: {
      return { name: JobName.IntegrityUntrackedFilesQueueAll, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityChecksumFilesRefresh: {
      return { name: JobName.IntegrityChecksumFiles, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityMissingFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.MissingFile } };
    }

    case ManualJobName.IntegrityUntrackedFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.UntrackedFile } };
    }

    case ManualJobName.IntegrityChecksumFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.ChecksumFail } };
    }

    default: {
      throw new BadRequestException('Invalid job name');
    }
  }
};

@Injectable()
export class JobService extends BaseService {
  async create(dto: JobCreateDto): Promise<void> {
    await this.jobRepository.queue(asJobItem(dto));
  }

  @OnEvent({ name: 'JobRun' })
  async onJobRun(...[queueName, job]: ArgsOf<'JobRun'>) {
    try {
      await this.eventRepository.emit('JobStart', queueName, job);
      const response = await this.jobRepository.run(job);
      await this.eventRepository.emit('JobSuccess', { job, response });
      if (response && typeof response === 'string' && [JobStatus.Success, JobStatus.Skipped].includes(response)) {
        await this.onDone(job);
      }
    } catch (error: Error | any) {
      await this.eventRepository.emit('JobError', { job, error });
    } finally {
      await this.eventRepository.emit('JobComplete', queueName, job);
    }
  }

  /** Queue follow up jobs */
  private async onDone(item: JobItem) {
    switch (item.name) {
      case JobName.AssetTranscribe: {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!isAudioSummaryEnabled(machineLearning) || !getAudioSummaryConfig(machineLearning).autoSummarize) {
          break;
        }
        const asset = await this.assetJobRepository.getForAudioAnalysis(item.data.id);
        const analysis = await this.audioAnalysisRepository.get(item.data.id);
        if (
          !asset ||
          asset.deletedAt ||
          asset.isOffline ||
          asset.visibility === AssetVisibility.Hidden ||
          !analysis?.transcript?.text.trim() ||
          !isCurrentAudioSource(analysis.transcriptChecksum, analysis.transcriptSourceModifiedAt, asset)
        ) {
          break;
        }
        await this.audioAnalysisRepository.setStatus([asset.id], 'summary', AudioAnalysisStatus.Pending);
        try {
          await this.jobRepository.queue({ name: JobName.AssetSummarize, data: { id: asset.id } });
        } catch (error) {
          await this.audioAnalysisRepository.setStatus([asset.id], 'summary', AudioAnalysisStatus.Failed);
          throw error;
        }
        break;
      }

      case JobName.SidecarCheck: {
        await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: item.data });
        break;
      }

      case JobName.SidecarWrite: {
        await this.jobRepository.queue({
          name: JobName.AssetExtractMetadata,
          data: { id: item.data.id, source: 'sidecar-write' },
        });
        break;
      }

      case JobName.StorageTemplateMigrationSingle: {
        if (item.data.source === 'upload' || item.data.source === 'copy') {
          await this.jobRepository.queue({ name: JobName.AssetGenerateThumbnails, data: item.data });
        }
        break;
      }

      case JobName.PersonGenerateThumbnail: {
        const { ownerId, personGroupId } = item.data;
        this.websocketRepository.clientSend('on_person_thumbnail', ownerId, personGroupId);
        break;
      }

      case JobName.AssetEditThumbnailGeneration: {
        const asset = await this.assetRepository.getById(item.data.id);
        const edits = await this.assetEditRepository.getWithSyncInfo(item.data.id);

        if (asset) {
          this.websocketRepository.clientSend('AssetEditReadyV2', asset.ownerId, {
            asset: {
              id: asset.id,
              ownerId: asset.ownerId,
              originalFileName: asset.originalFileName,
              thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
              checksum: hexOrBufferToBase64(asset.checksum),
              fileCreatedAt: asset.fileCreatedAt,
              fileModifiedAt: asset.fileModifiedAt,
              createdAt: asset.createdAt,
              localDateTime: asset.localDateTime,
              duration: asset.duration,
              type: asset.type,
              deletedAt: asset.deletedAt,
              isFavorite: asset.isFavorite,
              visibility: asset.visibility,
              livePhotoVideoId: asset.livePhotoVideoId,
              stackId: asset.stackId,
              libraryId: asset.libraryId,
              width: asset.width,
              height: asset.height,
              isEdited: asset.isEdited,
            },
            edit: edits,
          });
        }

        break;
      }

      case JobName.AssetGenerateThumbnails: {
        if (!item.data.notify && item.data.source !== 'upload') {
          break;
        }

        const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([item.data.id]);
        if (!asset) {
          this.logger.warn(`Could not find asset ${item.data.id} after generating thumbnails`);
          break;
        }

        const jobs: JobItem[] =
          asset.type === AssetType.Audio
            ? []
            : [
                { name: JobName.SmartSearch, data: item.data },
                { name: JobName.AssetDetectFaces, data: item.data },
                { name: JobName.Ocr, data: item.data },
              ];

        if (asset.type === AssetType.Audio) {
          await this.audioAnalysisRepository.setStatus([asset.id], 'waveform', AudioAnalysisStatus.Pending);
          jobs.push({ name: JobName.AssetGenerateWaveform, data: { id: asset.id } });
          const { machineLearning } = await this.getConfig({ withCache: true });
          if (isSpeechToTextEnabled(machineLearning) && getSpeechToTextConfig(machineLearning).autoTranscribe) {
            await this.audioAnalysisRepository.setStatus([asset.id], 'transcript', AudioAnalysisStatus.Pending);
            jobs.push({ name: JobName.AssetTranscribe, data: { id: asset.id } });
          }
        }

        if (asset.type === AssetType.Video || asset.type === AssetType.Audio) {
          jobs.push({ name: JobName.AssetEncodeVideo, data: item.data });
        }

        try {
          await this.jobRepository.queueAll(jobs);
        } catch (error) {
          if (asset.type === AssetType.Audio) {
            await this.audioAnalysisRepository.setStatus([asset.id], 'waveform', AudioAnalysisStatus.Failed);
            if (jobs.some((job) => job.name === JobName.AssetTranscribe)) {
              await this.audioAnalysisRepository.setStatus([asset.id], 'transcript', AudioAnalysisStatus.Failed);
            }
          }
          throw error;
        }
        if (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive) {
          this.websocketRepository.clientSend('on_upload_success', asset.ownerId, mapAsset(asset));
          if (asset.exifInfo) {
            const exif = asset.exifInfo;
            this.websocketRepository.clientSend('AssetUploadReadyV2', asset.ownerId, {
              // TODO remove `on_upload_success` and then modify the query to select only the required fields)
              asset: {
                id: asset.id,
                ownerId: asset.ownerId,
                originalFileName: asset.originalFileName,
                thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
                checksum: hexOrBufferToBase64(asset.checksum),
                fileCreatedAt: asset.fileCreatedAt,
                fileModifiedAt: asset.fileModifiedAt,
                createdAt: asset.createdAt,
                localDateTime: asset.localDateTime,
                duration: asset.duration,
                type: asset.type,
                deletedAt: asset.deletedAt,
                isFavorite: asset.isFavorite,
                visibility: asset.visibility,
                livePhotoVideoId: asset.livePhotoVideoId,
                stackId: asset.stackId,
                libraryId: asset.libraryId,
                width: asset.width,
                height: asset.height,
                isEdited: asset.isEdited,
              },
              exif: {
                assetId: exif.assetId,
                description: exif.description,
                exifImageWidth: exif.exifImageWidth,
                exifImageHeight: exif.exifImageHeight,
                fileSizeInByte: exif.fileSizeInByte,
                orientation: exif.orientation,
                dateTimeOriginal: exif.dateTimeOriginal ? new Date(exif.dateTimeOriginal) : null,
                modifyDate: exif.modifyDate ? new Date(exif.modifyDate) : null,
                timeZone: exif.timeZone,
                latitude: exif.latitude,
                longitude: exif.longitude,
                projectionType: exif.projectionType,
                city: exif.city,
                state: exif.state,
                country: exif.country,
                make: exif.make,
                model: exif.model,
                lensModel: exif.lensModel,
                fNumber: exif.fNumber,
                focalLength: exif.focalLength,
                iso: exif.iso,
                exposureTime: exif.exposureTime,
                profileDescription: exif.profileDescription,
                rating: exif.rating,
                fps: exif.fps,
              },
            });
          }
        }

        break;
      }

      case JobName.SmartSearch: {
        if (item.data.source === 'upload') {
          await this.jobRepository.queue({ name: JobName.AssetDetectDuplicates, data: item.data });
        }
        break;
      }

      // no default
    }
  }
}
