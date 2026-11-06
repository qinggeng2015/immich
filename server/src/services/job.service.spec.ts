import type { JobItem } from 'src/types.js';
import { AssetType, AudioAnalysisStatus, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { JobService } from 'src/services/job.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForAsset } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(JobService.name, () => {
  let sut: JobService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onJobRun', () => {
    it('should queue metadata extraction when sidecar discovery is skipped', async () => {
      const job: JobItem = { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } };
      mocks.job.run.mockResolvedValue(JobStatus.Skipped);

      await sut.onJobRun(QueueName.Sidecar, job);

      expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
        name: JobName.AssetExtractMetadata,
        data: job.data,
      });
    });

    it('should process a successful job', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      const job: JobItem = { name: JobName.FileDelete, data: { files: ['path/to/file'] } };
      await sut.onJobRun(QueueName.BackgroundTask, job);

      expect(mocks.event.emit).toHaveBeenCalledWith('JobStart', QueueName.BackgroundTask, job);
      expect(mocks.event.emit).toHaveBeenCalledWith('JobSuccess', { job, response: JobStatus.Success });
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.BackgroundTask, job);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it.each([JobStatus.Success, JobStatus.Skipped])(
      'should queue metadata extraction after a %s sidecar check and preserve its source',
      async (status) => {
        mocks.job.run.mockResolvedValue(status);
        const job: JobItem = { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } };

        await sut.onJobRun(QueueName.Sidecar, job);

        expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
          name: JobName.AssetExtractMetadata,
          data: { id: 'asset-1', source: 'upload' },
        });
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      },
    );

    it('should not queue metadata extraction after a failed sidecar check', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Failed);

      await sut.onJobRun(QueueName.Sidecar, { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } });

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it.each([
      { enabled: true, speechEnabled: true, autoTranscribe: true, transcribe: true },
      { enabled: true, speechEnabled: true, autoTranscribe: false, transcribe: false },
      { enabled: true, speechEnabled: false, autoTranscribe: true, transcribe: false },
      { enabled: false, speechEnabled: true, autoTranscribe: true, transcribe: false },
    ])(
      'should chain audio jobs without vision jobs: %j',
      async ({ enabled, speechEnabled, autoTranscribe, transcribe }) => {
        const asset = AssetFactory.create({ type: AssetType.Audio });
        const data = { id: asset.id, source: 'upload' as const };
        mocks.job.run.mockResolvedValue(JobStatus.Success);
        mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([{ ...getForAsset(asset), faces: [] }]);
        mocks.audioAnalysis.setStatus.mockResolvedValue(undefined);
        mocks.systemMetadata.get.mockResolvedValue({
          machineLearning: { enabled, speechToText: { enabled: speechEnabled, autoTranscribe } },
        });

        await sut.onJobRun(QueueName.ThumbnailGeneration, { name: JobName.AssetGenerateThumbnails, data });

        expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([
          { name: JobName.AssetGenerateWaveform, data: { id: asset.id } },
          ...(transcribe ? [{ name: JobName.AssetTranscribe, data: { id: asset.id } }] : []),
          { name: JobName.AssetEncodeVideo, data },
        ]);
        expect(mocks.audioAnalysis.setStatus.mock.calls).toEqual([
          [[asset.id], 'waveform', AudioAnalysisStatus.Pending],
          ...(transcribe ? [[[asset.id], 'transcript', AudioAnalysisStatus.Pending]] : []),
        ]);
        expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
          'on_upload_success',
          asset.ownerId,
          expect.objectContaining({ id: asset.id, type: AssetType.Audio }),
        );
      },
    );

    it.each([false, true])(
      'should mark scheduled audio analysis failed if automatic enqueue fails: autoTranscribe=%s',
      async (autoTranscribe) => {
        const asset = AssetFactory.create({ type: AssetType.Audio });
        const job: JobItem = { name: JobName.AssetGenerateThumbnails, data: { id: asset.id, source: 'upload' } };
        const error = new Error('Redis unavailable');
        mocks.job.run.mockResolvedValue(JobStatus.Success);
        mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([{ ...getForAsset(asset), faces: [] }]);
        mocks.audioAnalysis.setStatus.mockResolvedValue(undefined);
        mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { speechToText: { autoTranscribe } } });
        mocks.job.queueAll.mockRejectedValue(error);

        await sut.onJobRun(QueueName.ThumbnailGeneration, job);

        expect(mocks.audioAnalysis.setStatus.mock.calls).toEqual([
          [[asset.id], 'waveform', AudioAnalysisStatus.Pending],
          ...(autoTranscribe ? [[[asset.id], 'transcript', AudioAnalysisStatus.Pending]] : []),
          [[asset.id], 'waveform', AudioAnalysisStatus.Failed],
          ...(autoTranscribe ? [[[asset.id], 'transcript', AudioAnalysisStatus.Failed]] : []),
        ]);
        expect(mocks.event.emit).toHaveBeenCalledWith('JobError', { job, error });
        expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
      },
    );

    const tests: Array<{ item: JobItem; jobs: JobName[]; stub?: any }> = [
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.AssetGenerateThumbnails],
      },
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.PersonGenerateThumbnail, data: { ownerId: 'owner-1', personGroupId: 'person-group-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [],
        stub: [AssetFactory.create({ id: 'asset-1' })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr],
        stub: [AssetFactory.create({ id: 'asset-1', livePhotoVideoId: newUuid() })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr, JobName.AssetEncodeVideo],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        item: { name: JobName.SmartSearch, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.AssetDetectFaces, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.FacialRecognition, data: { id: 'asset-1' } },
        jobs: [],
      },
    ];

    for (const { item, jobs, stub } of tests) {
      it(`should queue ${jobs.length} jobs when a ${item.name} job finishes successfully`, async () => {
        if (stub) {
          mocks.asset.getById.mockResolvedValue(stub[0]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue(stub);
        }

        mocks.job.run.mockResolvedValue(JobStatus.Success);

        await sut.onJobRun(QueueName.BackgroundTask, item);

        if (jobs.length > 1) {
          expect(mocks.job.queueAll).toHaveBeenCalledWith(
            jobs.map((jobName) => ({ name: jobName, data: expect.anything() })),
          );
        } else {
          expect(mocks.job.queue).toHaveBeenCalledTimes(jobs.length);
          for (const jobName of jobs) {
            expect(mocks.job.queue).toHaveBeenCalledWith({ name: jobName, data: expect.anything() });
          }
        }
      });

      it(`should not queue any jobs when ${item.name} fails`, async () => {
        mocks.job.run.mockResolvedValue(JobStatus.Failed);

        await sut.onJobRun(QueueName.BackgroundTask, item);

        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      });
    }
  });
});
