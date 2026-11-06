import { ForbiddenException } from '@nestjs/common';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetType, AudioAnalysisStatus, JobName, JobStatus } from 'src/enum.js';
import { AudioSummaryService } from 'src/services/audio-summary.service.js';
import { AudioSummaryError } from 'src/utils/audio-summary-text.js';
import { getAudioSummaryConfigHash } from 'src/utils/audio-summary.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { makeStream, newTestService } from 'test/utils.js';

const setup = () => {
  const { sut, mocks } = newTestService(AudioSummaryService);
  const asset = AssetFactory.create({ type: AssetType.Audio });
  const auth = AuthFactory.create();
  const config = structuredClone(defaults);
  config.machineLearning.audioSummary = { ...config.machineLearning.audioSummary!, enabled: true, apiKey: 'test-key' };
  const analysis = {
    assetId: asset.id,
    waveform: null,
    waveformStatus: null,
    waveformChecksum: null,
    waveformSourceModifiedAt: null,
    transcript: {
      text: '会议决定周五发布。',
      language: 'zh',
      modelName: 'SenseVoiceSmall',
      segmentType: 'chunk' as const,
      segments: [],
    },
    transcriptStatus: AudioAnalysisStatus.Ready,
    transcriptChecksum: asset.checksum,
    transcriptSourceModifiedAt: asset.fileModifiedAt,
    transcriptText: '会议决定周五发布。',
    transcriptRevision: 'transcript-1',
    summary: { text: '周五发布。', modelName: 'test-model', updatedAt: '2026-11-06T00:00:00.000Z' },
    summaryStatus: AudioAnalysisStatus.Ready,
    summaryChecksum: asset.checksum,
    summarySourceModifiedAt: asset.fileModifiedAt,
    summaryTranscriptRevision: 'transcript-1',
    summaryConfigHash: getAudioSummaryConfigHash(config.machineLearning),
    summaryJobId: null,
  };
  mocks.systemMetadata.get.mockResolvedValue(config);
  mocks.assetJob.getForAudioAnalysis.mockResolvedValue(asset);
  mocks.audioAnalysis.get.mockResolvedValue(analysis);
  mocks.audioAnalysis.setStatus.mockResolvedValue(undefined);
  mocks.audioAnalysis.claimSummary.mockResolvedValue(true);
  mocks.audioAnalysis.finishSummary.mockResolvedValue(true);
  mocks.audioAnalysis.invalidateSummaryJobs.mockResolvedValue([]);
  mocks.audioAnalysis.releaseSummaryClaim.mockResolvedValue([]);
  mocks.audioSummary.summarize.mockResolvedValue({ text: '摘要', chunkCount: 1, requestCount: 1 });
  mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
  return { sut, mocks, asset, auth, config, analysis };
};

describe(AudioSummaryService.name, () => {
  it('retains the last successful summary when the feature is disabled', async () => {
    const { sut, mocks, asset, auth, config, analysis } = setup();
    config.machineLearning.audioSummary!.enabled = false;
    mocks.systemMetadata.get.mockResolvedValue(config);
    await expect(sut.getSummary(auth, asset.id)).resolves.toEqual({
      status: AudioAnalysisStatus.Disabled,
      summary: analysis.summary,
    });
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.audioSummary.summarize).not.toHaveBeenCalled();
  });

  it('never exposes private summaries through shared links', async () => {
    const { sut, asset, auth } = setup();
    await expect(
      sut.getSummary({ ...auth, sharedLink: {} as NonNullable<typeof auth.sharedLink> }, asset.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('hides a summary after the transcript revision changes', async () => {
    const { sut, mocks, asset, auth, analysis } = setup();
    mocks.audioAnalysis.get.mockResolvedValue({ ...analysis, transcriptRevision: 'transcript-2' });
    await expect(sut.getSummary(auth, asset.id)).resolves.toEqual({
      status: AudioAnalysisStatus.Unprocessed,
      summary: null,
    });
  });

  it('skips silence without calling the external provider', async () => {
    const { sut, mocks, asset, analysis } = setup();
    mocks.audioAnalysis.get.mockResolvedValue({ ...analysis, transcript: { ...analysis.transcript, text: ' \n ' } });
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.audioSummary.summarize).not.toHaveBeenCalled();
  });

  it('preserves existing results on failure and exposes only a sanitized job error', async () => {
    const { sut, mocks, asset, analysis } = setup();
    mocks.audioSummary.summarize.mockRejectedValue(new Error('private transcript and API key'));
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).rejects.toThrow(
      'Audio summary generation failed',
    );
    expect(mocks.audioAnalysis.finishSummary).toHaveBeenCalledExactlyOnceWith(
      asset.id,
      asset.checksum,
      asset.fileModifiedAt,
      analysis.transcriptRevision,
      expect.any(String),
      AudioAnalysisStatus.Failed,
    );
  });

  it('does not save a result after the model or prompt changes', async () => {
    const { sut, mocks, asset, config } = setup();
    const changed = structuredClone(config);
    changed.machineLearning.audioSummary!.prompt = '另一个提示词';
    mocks.systemMetadata.get.mockResolvedValueOnce(config).mockResolvedValueOnce(config).mockResolvedValue(changed);
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.audioAnalysis.finishSummary).toHaveBeenCalledWith(
      asset.id,
      asset.checksum,
      asset.fileModifiedAt,
      'transcript-1',
      expect.any(String),
      AudioAnalysisStatus.Unprocessed,
    );
  });

  it('does not report success when the source or transcript changed during generation', async () => {
    const { sut, mocks, asset } = setup();
    mocks.audioAnalysis.finishSummary.mockResolvedValue(false);
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.audioAnalysis.releaseSummaryClaim).toHaveBeenCalledExactlyOnceWith(asset.id, expect.any(String));
  });

  it('does not send a transcript if configuration changes while acquiring the claim', async () => {
    const { sut, mocks, asset, config } = setup();
    const disabled = structuredClone(config);
    disabled.machineLearning.audioSummary!.enabled = false;
    mocks.systemMetadata.get.mockResolvedValueOnce(config).mockResolvedValue(disabled);
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.audioSummary.summarize).not.toHaveBeenCalled();
    expect(mocks.audioAnalysis.releaseSummaryClaim).toHaveBeenCalledExactlyOnceWith(asset.id, expect.any(String));
  });

  it('retains safe provider error codes without copying an attached cause or response', async () => {
    const { sut, mocks, asset } = setup();
    const error = new AudioSummaryError('request_timeout');
    error.cause = 'private transcript and API key';
    mocks.audioSummary.summarize.mockRejectedValue(error);
    const result = sut.summarize({ id: asset.id, force: true, manual: true });
    await expect(result).rejects.toMatchObject({
      code: 'request_timeout',
      message: 'Audio summary provider request timed out',
    });
    await expect(result).rejects.not.toHaveProperty('cause');
  });

  it('aborts an in-flight request when its asset is deleted', async () => {
    const { sut, mocks, asset } = setup();
    mocks.audioSummary.summarize.mockImplementation(({ signal }) => {
      sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
      expect(signal?.aborted).toBe(true);
      return Promise.reject(new AudioSummaryError('cancelled'));
    });
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
  });

  it('aborts active requests and clears claims on configuration change', async () => {
    const { sut, mocks, asset, config } = setup();
    mocks.audioSummary.summarize.mockImplementation(async ({ signal }) => {
      const changed = structuredClone(config);
      changed.machineLearning.audioSummary!.enabled = false;
      await sut.onConfigUpdate({ oldConfig: config, newConfig: changed });
      expect(signal?.aborted).toBe(true);
      throw new Error('aborted');
    });
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.audioAnalysis.invalidateSummaryJobs).toHaveBeenCalledOnce();
  });

  it('queues only identifiers and supports manual missing/all jobs with speech recognition disabled', async () => {
    const { sut, mocks, asset, config } = setup();
    config.machineLearning.speechToText!.enabled = false;
    mocks.assetJob.streamForAudioSummary.mockReturnValue(makeStream([{ id: asset.id }]));
    await expect(sut.queueSummaries({ force: true })).resolves.toBe(JobStatus.Success);
    expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([
      { name: JobName.AssetSummarize, data: { id: asset.id, force: true, manual: true } },
    ]);
  });

  it('keeps a request using the new settings when its config event arrives late', async () => {
    const { sut, mocks, asset, config } = setup();
    const previous = structuredClone(config);
    previous.machineLearning.audioSummary!.modelName = 'previous-model';
    mocks.audioSummary.summarize.mockImplementation(async ({ signal }) => {
      await sut.onConfigUpdate({ oldConfig: previous, newConfig: config });
      expect(signal?.aborted).toBe(false);
      return { text: 'summary', requestCount: 1, chunkCount: 1 };
    });
    await expect(sut.summarize({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Success);
    expect(mocks.audioAnalysis.invalidateSummaryJobs).not.toHaveBeenCalled();
  });
});
