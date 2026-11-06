import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { IBaseJob, IEntityJob } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AssetAudioSummaryResponseDto } from 'src/dtos/audio.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetType,
  AssetVisibility,
  AudioAnalysisStatus,
  JobName,
  JobStatus,
  Permission,
  QueueName,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { AudioSummaryError } from 'src/utils/audio-summary-text.js';
import { getAudioSummaryConfigHash, isCurrentAudioSource } from 'src/utils/audio-summary.js';
import { batched, getAudioSummaryConfig, isAudioSummaryEnabled } from 'src/utils/misc.js';

const summaryFailure = (error: unknown) =>
  error instanceof AudioSummaryError ? new AudioSummaryError(error.code) : new Error('Audio summary generation failed');

type ActiveSummaryJob = { controller: AbortController; jobId: string; configHash: string };

@Injectable()
export class AudioSummaryService extends BaseService {
  private activeJobs = new Map<string, Set<ActiveSummaryJob>>();

  @OnEvent({ name: 'AssetDelete', server: true })
  onAssetDelete({ assetId: id }: ArgOf<'AssetDelete'>) {
    for (const { controller } of this.activeJobs.get(id) ?? []) {
      controller.abort();
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    for (const controllers of this.activeJobs.values()) {
      for (const { controller } of controllers) {
        controller.abort();
      }
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  async onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    if (getAudioSummaryConfigHash(oldConfig.machineLearning) === getAudioSummaryConfigHash(newConfig.machineLearning)) {
      return;
    }

    const configHash = getAudioSummaryConfigHash(newConfig.machineLearning);
    const jobIds: string[] = [];
    for (const jobs of this.activeJobs.values()) {
      for (const job of jobs) {
        if (job.configHash === configHash) {
          continue;
        }
        job.controller.abort();
        jobIds.push(job.jobId);
      }
    }
    if (jobIds.length > 0) {
      await this.audioAnalysisRepository.invalidateSummaryJobs(jobIds);
    }
  }

  async getSummary(auth: AuthDto, id: string): Promise<AssetAudioSummaryResponseDto> {
    if (auth.sharedLink) {
      throw new ForbiddenException('Audio summaries are unavailable through shared links');
    }
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    const asset = await this.assetJobRepository.getForAudioAnalysis(id);
    if (!asset || asset.type !== AssetType.Audio) {
      throw new BadRequestException('Audio summaries require an audio asset');
    }
    const analysis = await this.audioAnalysisRepository.get(id);
    const { machineLearning } = await this.getConfig({ withCache: true });
    const currentTranscript =
      analysis && isCurrentAudioSource(analysis.transcriptChecksum, analysis.transcriptSourceModifiedAt, asset);
    const summary =
      analysis?.summary &&
      isCurrentAudioSource(analysis.summaryChecksum, analysis.summarySourceModifiedAt, asset) &&
      currentTranscript &&
      analysis.summaryTranscriptRevision === analysis.transcriptRevision
        ? analysis.summary
        : null;
    const status = isAudioSummaryEnabled(machineLearning)
      ? currentTranscript
        ? (analysis?.summaryStatus === AudioAnalysisStatus.Ready &&
            (!summary || analysis.summaryConfigHash !== getAudioSummaryConfigHash(machineLearning))) ||
          analysis?.summaryStatus === AudioAnalysisStatus.Disabled
          ? AudioAnalysisStatus.Unprocessed
          : (analysis?.summaryStatus ?? AudioAnalysisStatus.Unprocessed)
        : AudioAnalysisStatus.Unprocessed
      : AudioAnalysisStatus.Disabled;
    return { status, summary };
  }

  @OnJob({ name: JobName.AssetSummarizeQueueAll, queue: QueueName.AudioSummary })
  async queueSummaries({ force }: IBaseJob) {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isAudioSummaryEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    for await (const batch of batched(
      this.assetJobRepository.streamForAudioSummary(force, getAudioSummaryConfigHash(machineLearning)),
    )) {
      const ids = batch.map(({ id }) => id);
      await this.audioAnalysisRepository.setStatus(ids, 'summary', AudioAnalysisStatus.Pending);
      try {
        await this.jobRepository.queueAll(
          ids.map((id) => ({ name: JobName.AssetSummarize, data: { id, force, manual: true } })),
        );
      } catch (error) {
        await this.audioAnalysisRepository.setStatus(ids, 'summary', AudioAnalysisStatus.Failed);
        throw error;
      }
    }
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetSummarize, queue: QueueName.AudioSummary })
  async summarize({ id, force, manual }: IEntityJob & { manual?: boolean }) {
    const asset = await this.assetJobRepository.getForAudioAnalysis(id);
    if (
      !asset ||
      asset.type !== AssetType.Audio ||
      asset.deletedAt ||
      asset.isOffline ||
      asset.visibility === AssetVisibility.Hidden
    ) {
      return JobStatus.Skipped;
    }
    const { machineLearning } = await this.getConfig({ withCache: false });
    const config = getAudioSummaryConfig(machineLearning);
    if (!isAudioSummaryEnabled(machineLearning)) {
      await this.audioAnalysisRepository.setStatus([id], 'summary', AudioAnalysisStatus.Disabled);
      return JobStatus.Skipped;
    }
    const analysis = await this.audioAnalysisRepository.get(id);
    if (
      !analysis?.transcript?.text.trim() ||
      !isCurrentAudioSource(analysis.transcriptChecksum, analysis.transcriptSourceModifiedAt, asset)
    ) {
      await this.audioAnalysisRepository.setStatus([id], 'summary', AudioAnalysisStatus.Unprocessed);
      return JobStatus.Skipped;
    }
    const configHash = getAudioSummaryConfigHash(machineLearning);
    if (
      !force &&
      analysis.summary &&
      analysis.summaryTranscriptRevision === analysis.transcriptRevision &&
      analysis.summaryConfigHash === configHash &&
      isCurrentAudioSource(analysis.summaryChecksum, analysis.summarySourceModifiedAt, asset)
    ) {
      await this.audioAnalysisRepository.setStatus([id], 'summary', AudioAnalysisStatus.Ready);
      return JobStatus.Skipped;
    }
    if (!manual && !config.autoSummarize) {
      await this.audioAnalysisRepository.setStatus([id], 'summary', AudioAnalysisStatus.Unprocessed);
      return JobStatus.Skipped;
    }
    const jobId = randomUUID();
    const revision = analysis.transcriptRevision;
    const claimed = await this.audioAnalysisRepository.claimSummary(
      id,
      asset.checksum,
      asset.fileModifiedAt,
      revision,
      jobId,
    );
    if (!claimed) {
      return JobStatus.Skipped;
    }
    const controller = new AbortController();
    const controllers = this.activeJobs.get(id) ?? new Set<ActiveSummaryJob>();
    const activeJob = { controller, jobId, configHash };
    controllers.add(activeJob);
    this.activeJobs.set(id, controllers);
    try {
      const beforeRequest = await this.getConfig({ withCache: false });
      if (controller.signal.aborted || getAudioSummaryConfigHash(beforeRequest.machineLearning) !== configHash) {
        return JobStatus.Skipped;
      }
      const result = await this.audioSummaryRepository.summarize({
        transcript: analysis.transcript.text,
        config,
        signal: controller.signal,
      });
      const latest = await this.getConfig({ withCache: false });
      if (controller.signal.aborted || getAudioSummaryConfigHash(latest.machineLearning) !== configHash) {
        await this.audioAnalysisRepository.finishSummary(
          id,
          asset.checksum,
          asset.fileModifiedAt,
          revision,
          jobId,
          AudioAnalysisStatus.Unprocessed,
        );
        return JobStatus.Skipped;
      }
      const saved = await this.audioAnalysisRepository.finishSummary(
        id,
        asset.checksum,
        asset.fileModifiedAt,
        revision,
        jobId,
        AudioAnalysisStatus.Ready,
        {
          summary: { text: result.text, modelName: config.modelName, updatedAt: new Date().toISOString() },
          configHash,
        },
      );
      return saved ? JobStatus.Success : JobStatus.Skipped;
    } catch (error) {
      await this.audioAnalysisRepository.finishSummary(
        id,
        asset.checksum,
        asset.fileModifiedAt,
        revision,
        jobId,
        controller.signal.aborted ? AudioAnalysisStatus.Unprocessed : AudioAnalysisStatus.Failed,
      );
      if (controller.signal.aborted) {
        return JobStatus.Skipped;
      }
      throw summaryFailure(error);
    } finally {
      controllers.delete(activeJob);
      if (controllers.size === 0) {
        this.activeJobs.delete(id);
      }
      await this.audioAnalysisRepository.releaseSummaryClaim(id, jobId);
    }
  }
}
