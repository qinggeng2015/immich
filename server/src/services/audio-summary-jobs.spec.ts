import { AssetJobName } from 'src/dtos/asset.dto.js';
import { AssetType, AudioAnalysisStatus, JobName, JobStatus, QueueName } from 'src/enum.js';
import { AssetService } from 'src/services/asset.service.js';
import { JobService } from 'src/services/job.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newTestService } from 'test/utils.js';

const input = () => {
  const asset = AssetFactory.create({ type: AssetType.Audio });
  const analysis = {
    assetId: asset.id,
    waveform: null,
    waveformStatus: null,
    waveformChecksum: null,
    waveformSourceModifiedAt: null,
    transcript: {
      text: 'meeting transcript',
      language: 'en',
      modelName: 'speech-model',
      segmentType: 'chunk' as const,
      segments: [],
    },
    transcriptStatus: AudioAnalysisStatus.Ready,
    transcriptChecksum: asset.checksum,
    transcriptSourceModifiedAt: asset.fileModifiedAt,
    transcriptText: 'meeting transcript',
    transcriptRevision: null,
    summary: null,
    summaryStatus: null,
    summaryChecksum: null,
    summarySourceModifiedAt: null,
    summaryTranscriptRevision: null,
    summaryConfigHash: null,
    summaryJobId: null,
  };
  return { asset, analysis };
};

describe('Audio summary jobs', () => {
  it.each([
    { enabled: true, autoSummarize: true, status: JobStatus.Success, queued: true },
    { enabled: true, autoSummarize: true, status: JobStatus.Skipped, queued: true },
    { enabled: true, autoSummarize: true, status: JobStatus.Failed, queued: false },
    { enabled: false, autoSummarize: true, status: JobStatus.Success, queued: false },
    { enabled: true, autoSummarize: false, status: JobStatus.Success, queued: false },
  ])(
    'chains only ready transcripts with automatic summaries enabled: %j',
    async ({ enabled, autoSummarize, status, queued }) => {
      const { sut, mocks } = newTestService(JobService);
      const { asset, analysis } = input();
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { audioSummary: { enabled, autoSummarize, apiKey: 'test-key' } },
      });
      mocks.job.run.mockResolvedValue(status);
      mocks.assetJob.getForAudioAnalysis.mockResolvedValue(asset);
      mocks.audioAnalysis.get.mockResolvedValue(analysis);
      mocks.audioAnalysis.setStatus.mockResolvedValue(undefined);
      await sut.onJobRun(QueueName.SpeechToText, { name: JobName.AssetTranscribe, data: { id: asset.id } });
      if (queued) {
        expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
          name: JobName.AssetSummarize,
          data: { id: asset.id },
        });
        expect(mocks.audioAnalysis.setStatus).toHaveBeenCalledExactlyOnceWith(
          [asset.id],
          'summary',
          AudioAnalysisStatus.Pending,
        );
      } else {
        expect(mocks.job.queue).not.toHaveBeenCalled();
      }
    },
  );

  it('allows explicitly regenerating summaries with automatic summarization and speech recognition disabled', async () => {
    const { sut, mocks } = newTestService(AssetService);
    const { asset, analysis } = input();
    const auth = AuthFactory.create();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getByIds.mockResolvedValue([asset]);
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        speechToText: { enabled: false },
        audioSummary: { enabled: true, autoSummarize: false, apiKey: 'test-key' },
      },
    });
    mocks.audioAnalysis.get.mockResolvedValue(analysis);
    mocks.audioAnalysis.setStatus.mockResolvedValue(undefined);
    await sut.run(auth, { assetIds: [asset.id], name: AssetJobName.SUMMARIZE_AUDIO });
    expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([
      { name: JobName.AssetSummarize, data: { id: asset.id, force: true, manual: true } },
    ]);
  });

  it('rejects manually summarizing a stale transcript before queuing or calling a provider', async () => {
    const { sut, mocks } = newTestService(AssetService);
    const { asset, analysis } = input();
    const auth = AuthFactory.create();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getByIds.mockResolvedValue([asset]);
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { audioSummary: { enabled: true, apiKey: 'test-key' } },
    });
    mocks.audioAnalysis.get.mockResolvedValue({ ...analysis, transcriptChecksum: Buffer.from('changed') });
    await expect(sut.run(auth, { assetIds: [asset.id], name: AssetJobName.SUMMARIZE_AUDIO })).rejects.toThrow(
      'Audio summaries require a current nonempty transcript',
    );
    expect(mocks.job.queueAll).not.toHaveBeenCalled();
  });
});
