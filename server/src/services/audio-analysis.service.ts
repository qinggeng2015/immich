import { BadRequestException, Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  AssetAudioTranscriptResponseDto,
  AssetAudioWaveformResponseDto,
  AudioTranscriptDto,
} from 'src/dtos/audio.dto.js';
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
import { tokenizeForSearch } from 'src/utils/database.js';
import { batched, getSpeechToTextConfig, isSpeechToTextEnabled } from 'src/utils/misc.js';

const MAX_TRANSCRIPT_CHARACTERS = 2_000_000;
const MAX_TRANSCRIPT_SEGMENTS = 10_000;

const isCurrentSource = (
  checksum: Buffer | null | undefined,
  sourceModifiedAt: Date | null | undefined,
  asset: { checksum: Buffer; fileModifiedAt: Date },
) => checksum?.equals(asset.checksum) && sourceModifiedAt?.getTime() === asset.fileModifiedAt.getTime();

@Injectable()
export class AudioAnalysisService extends BaseService {
  private activeJobs = new Map<string, Set<AbortController>>();

  @OnEvent({ name: 'AssetDelete', server: true })
  onAssetDelete({ assetId }: ArgOf<'AssetDelete'>) {
    for (const controller of this.activeJobs.get(assetId) ?? []) {
      controller.abort(new Error('Audio asset was deleted'));
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    for (const controllers of this.activeJobs.values()) {
      for (const controller of controllers) {
        controller.abort(new Error('Audio analysis worker is stopping'));
      }
    }
  }

  async getWaveform(auth: AuthDto, id: string): Promise<AssetAudioWaveformResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });
    const asset = await this.requireAudioAsset(id);
    const analysis = await this.audioAnalysisRepository.get(id);
    const waveform =
      analysis && isCurrentSource(analysis.waveformChecksum, analysis.waveformSourceModifiedAt, asset)
        ? analysis.waveform
        : null;
    const stale = !!analysis?.waveform && !waveform;
    const status = analysis?.waveformStatus ?? AudioAnalysisStatus.Unprocessed;
    return {
      status: stale && status === AudioAnalysisStatus.Ready ? AudioAnalysisStatus.Unprocessed : status,
      waveform,
    };
  }

  async getTranscript(auth: AuthDto, id: string): Promise<AssetAudioTranscriptResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    const asset = await this.requireAudioAsset(id);
    const analysis = await this.audioAnalysisRepository.get(id);
    const transcript =
      analysis && isCurrentSource(analysis.transcriptChecksum, analysis.transcriptSourceModifiedAt, asset)
        ? analysis.transcript
        : null;
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!transcript && !isSpeechToTextEnabled(machineLearning)) {
      return { status: AudioAnalysisStatus.Disabled, transcript: null };
    }
    const stale = !!analysis?.transcript && !transcript;
    const currentStatus = analysis?.transcriptStatus ?? AudioAnalysisStatus.Unprocessed;
    const status =
      stale && currentStatus === AudioAnalysisStatus.Ready ? AudioAnalysisStatus.Unprocessed : currentStatus;
    return {
      status: transcript && status === AudioAnalysisStatus.Disabled ? AudioAnalysisStatus.Ready : status,
      transcript,
    };
  }

  @OnJob({ name: JobName.AssetGenerateWaveformQueueAll, queue: QueueName.AudioWaveform })
  async queueWaveforms({ force }: JobOf<JobName.AssetGenerateWaveformQueueAll>) {
    for await (const assets of batched(this.assetJobRepository.streamForAudioAnalysis('waveform', force))) {
      const ids = assets.map(({ id }) => id);
      await this.audioAnalysisRepository.setStatus(ids, 'waveform', AudioAnalysisStatus.Pending);
      try {
        await this.jobRepository.queueAll(
          ids.map((id) => ({ name: JobName.AssetGenerateWaveform, data: { id, force } })),
        );
      } catch (error) {
        await this.audioAnalysisRepository.setStatus(ids, 'waveform', AudioAnalysisStatus.Failed);
        throw error;
      }
    }
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetTranscribeQueueAll, queue: QueueName.SpeechToText })
  async queueTranscripts({ force }: JobOf<JobName.AssetTranscribeQueueAll>) {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSpeechToTextEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    for await (const assets of batched(this.assetJobRepository.streamForAudioAnalysis('transcript', force))) {
      const ids = assets.map(({ id }) => id);
      await this.audioAnalysisRepository.setStatus(ids, 'transcript', AudioAnalysisStatus.Pending);
      try {
        await this.jobRepository.queueAll(
          ids.map((id) => ({ name: JobName.AssetTranscribe, data: { id, force, manual: true } })),
        );
      } catch (error) {
        await this.audioAnalysisRepository.setStatus(ids, 'transcript', AudioAnalysisStatus.Failed);
        throw error;
      }
    }
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetGenerateWaveform, queue: QueueName.AudioWaveform })
  async generateWaveform({ id, force }: JobOf<JobName.AssetGenerateWaveform>) {
    const asset = await this.assetJobRepository.getForAudioAnalysis(id);
    if (
      !asset ||
      asset.type !== AssetType.Audio ||
      asset.deletedAt ||
      asset.isOffline ||
      asset.visibility === AssetVisibility.Hidden
    ) {
      if (asset?.type === AssetType.Audio) {
        await this.audioAnalysisRepository.setStatusForSource(
          id,
          'waveform',
          AudioAnalysisStatus.Unprocessed,
          asset.checksum,
          asset.fileModifiedAt,
        );
      }
      return JobStatus.Skipped;
    }
    const previous = await this.audioAnalysisRepository.get(id);
    if (
      !force &&
      previous?.waveform &&
      isCurrentSource(previous.waveformChecksum, previous.waveformSourceModifiedAt, asset)
    ) {
      await this.audioAnalysisRepository.setStatusForSource(
        id,
        'waveform',
        AudioAnalysisStatus.Ready,
        asset.checksum,
        asset.fileModifiedAt,
      );
      return JobStatus.Skipped;
    }
    const started = await this.audioAnalysisRepository.setStatusForSource(
      id,
      'waveform',
      AudioAnalysisStatus.Processing,
      asset.checksum,
      asset.fileModifiedAt,
    );
    if (!started) {
      return JobStatus.Skipped;
    }
    const controller = this.startJob(id);
    try {
      const { audioStreams } = await this.mediaRepository.probe(asset.originalPath);
      if (!audioStreams[0]) {
        throw new Error('Audio asset has no decodable audio stream');
      }
      const waveform = await this.mediaRepository.generateAudioWaveform(
        asset.originalPath,
        audioStreams[0].index,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const saved = await this.audioAnalysisRepository.saveWaveform(id, waveform, asset.checksum, asset.fileModifiedAt);
      if (!saved) {
        await this.audioAnalysisRepository.setStatusForSource(
          id,
          'waveform',
          AudioAnalysisStatus.Unprocessed,
          asset.checksum,
          asset.fileModifiedAt,
        );
      }
      return saved ? JobStatus.Success : JobStatus.Skipped;
    } catch (error) {
      await this.audioAnalysisRepository.setStatusForSource(
        id,
        'waveform',
        controller.signal.aborted ? AudioAnalysisStatus.Unprocessed : AudioAnalysisStatus.Failed,
        asset.checksum,
        asset.fileModifiedAt,
      );
      throw error;
    } finally {
      this.finishJob(id, controller);
    }
  }

  @OnJob({ name: JobName.AssetTranscribe, queue: QueueName.SpeechToText })
  async transcribe({ id, force, manual }: JobOf<JobName.AssetTranscribe>) {
    const asset = await this.assetJobRepository.getForAudioAnalysis(id);
    if (
      !asset ||
      asset.type !== AssetType.Audio ||
      asset.deletedAt ||
      asset.isOffline ||
      asset.visibility === AssetVisibility.Hidden
    ) {
      if (asset?.type === AssetType.Audio) {
        await this.audioAnalysisRepository.setStatusForSource(
          id,
          'transcript',
          AudioAnalysisStatus.Unprocessed,
          asset.checksum,
          asset.fileModifiedAt,
        );
      }
      return JobStatus.Skipped;
    }
    const { machineLearning } = await this.getConfig({ withCache: true });
    const config = getSpeechToTextConfig(machineLearning);
    if (!isSpeechToTextEnabled(machineLearning)) {
      await this.audioAnalysisRepository.setStatusForSource(
        id,
        'transcript',
        AudioAnalysisStatus.Disabled,
        asset.checksum,
        asset.fileModifiedAt,
      );
      return JobStatus.Skipped;
    }
    const previous = await this.audioAnalysisRepository.get(id);
    if (
      !force &&
      previous?.transcript &&
      isCurrentSource(previous.transcriptChecksum, previous.transcriptSourceModifiedAt, asset)
    ) {
      await this.audioAnalysisRepository.setStatusForSource(
        id,
        'transcript',
        AudioAnalysisStatus.Ready,
        asset.checksum,
        asset.fileModifiedAt,
      );
      return JobStatus.Skipped;
    }
    if (!manual && !config.autoTranscribe) {
      await this.audioAnalysisRepository.setStatusForSource(
        id,
        'transcript',
        AudioAnalysisStatus.Unprocessed,
        asset.checksum,
        asset.fileModifiedAt,
      );
      return JobStatus.Skipped;
    }
    const started = await this.audioAnalysisRepository.setStatusForSource(
      id,
      'transcript',
      AudioAnalysisStatus.Processing,
      asset.checksum,
      asset.fileModifiedAt,
    );
    if (!started) {
      return JobStatus.Skipped;
    }
    const controller = this.startJob(id);
    try {
      const { audioStreams } = await this.mediaRepository.probe(asset.originalPath);
      if (!audioStreams[0]) {
        throw new Error('Audio asset has no decodable audio stream');
      }
      const segments: AudioTranscriptDto['segments'] = [];
      const texts: string[] = [];
      const languages = new Set<string>();
      let textLength = 0;
      for await (const chunk of this.mediaRepository.streamAudioChunks(
        asset.originalPath,
        audioStreams[0].index,
        controller.signal,
      )) {
        const current = await this.assetJobRepository.getForAudioAnalysis(id);
        if (
          !current ||
          current.deletedAt ||
          current.isOffline ||
          current.visibility === AssetVisibility.Hidden ||
          !isCurrentSource(asset.checksum, asset.fileModifiedAt, current)
        ) {
          controller.abort(new Error('Audio asset changed while transcribing'));
          controller.signal.throwIfAborted();
        }
        const result = await this.machineLearningRepository.transcribe(chunk.data, config, controller.signal);
        controller.signal.throwIfAborted();
        textLength += result.text.length;
        for (const segment of result.segments) {
          textLength += segment.text.length;
        }
        if (
          textLength > MAX_TRANSCRIPT_CHARACTERS ||
          segments.length + result.segments.length > MAX_TRANSCRIPT_SEGMENTS
        ) {
          throw new Error('Audio transcript exceeds storage limits');
        }
        if (result.text.trim()) {
          texts.push(result.text.trim());
        }
        if (result.language) {
          languages.add(result.language);
        }
        for (const segment of result.segments) {
          if (segment.endMs < segment.startMs || segment.endMs > chunk.durationMs + 1) {
            throw new Error('Speech service returned invalid chunk timestamps');
          }
          segments.push({
            startMs: chunk.startMs + segment.startMs,
            endMs: chunk.startMs + segment.endMs,
            text: segment.text,
          });
        }
      }
      const transcript: AudioTranscriptDto = {
        text: texts.join('\n'),
        language: languages.size === 1 ? [...languages][0] : null,
        modelName: config.modelName,
        segmentType: 'chunk',
        segments,
      };
      const searchText = tokenizeForSearch(transcript.text).join(' ');
      const saved = await this.audioAnalysisRepository.saveTranscript(
        id,
        transcript,
        searchText,
        asset.checksum,
        asset.fileModifiedAt,
      );
      if (!saved) {
        await this.audioAnalysisRepository.setStatusForSource(
          id,
          'transcript',
          AudioAnalysisStatus.Unprocessed,
          asset.checksum,
          asset.fileModifiedAt,
        );
      }
      return saved ? JobStatus.Success : JobStatus.Skipped;
    } catch (error) {
      await this.audioAnalysisRepository.setStatusForSource(
        id,
        'transcript',
        controller.signal.aborted ? AudioAnalysisStatus.Unprocessed : AudioAnalysisStatus.Failed,
        asset.checksum,
        asset.fileModifiedAt,
      );
      throw error;
    } finally {
      this.finishJob(id, controller);
    }
  }

  private async requireAudioAsset(id: string) {
    const asset = await this.assetJobRepository.getForAudioAnalysis(id);
    if (!asset || asset.type !== AssetType.Audio) {
      throw new BadRequestException('Asset is not audio');
    }
    return asset;
  }

  private startJob(id: string) {
    const controller = new AbortController();
    const active = this.activeJobs.get(id) ?? new Set<AbortController>();
    active.add(controller);
    this.activeJobs.set(id, active);
    return controller;
  }

  private finishJob(id: string, controller: AbortController) {
    const active = this.activeJobs.get(id);
    active?.delete(controller);
    if (active?.size === 0) {
      this.activeJobs.delete(id);
    }
  }
}
