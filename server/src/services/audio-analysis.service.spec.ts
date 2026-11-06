import { AudioTranscriptDto, AudioWaveformDto } from 'src/dtos/audio.dto.js';
import { AssetType, AssetVisibility, AudioAnalysisStatus, JobName, JobStatus } from 'src/enum.js';
import { AudioAnalysisService } from 'src/services/audio-analysis.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { videoInfoStub } from 'test/fixtures/media.stub.js';
import { makeStream, newTestService } from 'test/utils.js';

const waveform: AudioWaveformDto = { version: 1, durationMs: 1000, peaks: Array.from({ length: 1024 }, () => 0.5) };
const transcript: AudioTranscriptDto = {
  text: '你好 world',
  language: 'zh',
  modelName: 'SenseVoiceSmall',
  segmentType: 'chunk',
  segments: [{ startMs: 0, endMs: 1000, text: '你好 world' }],
};

const setup = () => {
  const { sut, mocks } = newTestService(AudioAnalysisService);
  const asset = AssetFactory.create({ type: AssetType.Audio, originalPath: '/speech.flac' });
  const auth = AuthFactory.create();
  const analysis = {
    assetId: asset.id,
    waveform,
    waveformStatus: AudioAnalysisStatus.Ready,
    waveformChecksum: asset.checksum,
    waveformSourceModifiedAt: asset.fileModifiedAt,
    transcript,
    transcriptStatus: AudioAnalysisStatus.Ready,
    transcriptChecksum: asset.checksum,
    transcriptSourceModifiedAt: asset.fileModifiedAt,
    transcriptText: transcript.text,
    transcriptRevision: null,
    summary: null,
    summaryStatus: null,
    summaryChecksum: null,
    summarySourceModifiedAt: null,
    summaryTranscriptRevision: null,
    summaryConfigHash: null,
    summaryJobId: null,
  };
  mocks.assetJob.getForAudioAnalysis.mockResolvedValue(asset);
  mocks.audioAnalysis.get.mockResolvedValue(undefined);
  mocks.audioAnalysis.setStatus.mockResolvedValue(undefined);
  mocks.audioAnalysis.setStatusForSource.mockResolvedValue(true);
  mocks.audioAnalysis.saveWaveform.mockResolvedValue(true);
  mocks.audioAnalysis.saveTranscript.mockResolvedValue(true);
  mocks.media.probe.mockResolvedValue(videoInfoStub.noVideoStreams);
  mocks.media.generateAudioWaveform.mockResolvedValue(waveform);
  mocks.media.streamAudioChunks.mockReturnValue(
    makeStream([{ data: Buffer.from('wav'), startMs: 0, durationMs: 1000 }]),
  );
  mocks.machineLearning.transcribe.mockResolvedValue({
    text: transcript.text,
    language: transcript.language,
    segments: transcript.segments,
  });
  mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
  return { sut, mocks, asset, auth, analysis };
};

describe(AudioAnalysisService.name, () => {
  it.each(['generateWaveform', 'transcribe'] as const)(
    'should skip %s when its source changes before processing starts',
    async (method) => {
      const { sut, mocks, asset } = setup();
      mocks.audioAnalysis.setStatusForSource.mockResolvedValue(false);
      await expect(sut[method]({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.media.probe).not.toHaveBeenCalled();
      expect(mocks.machineLearning.transcribe).not.toHaveBeenCalled();
      expect(mocks.audioAnalysis.setStatus).not.toHaveBeenCalled();
    },
  );

  it.each(['getWaveform', 'getTranscript'] as const)('should authorize before reading %s', async (method) => {
    const { sut, mocks, asset, auth } = setup();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(sut[method](auth, asset.id)).rejects.toThrow();
    expect(mocks.audioAnalysis.get).not.toHaveBeenCalled();
    expect(mocks.assetJob.getForAudioAnalysis).not.toHaveBeenCalled();
  });

  it('should distinguish unprocessed audio from successful silence', async () => {
    const { sut, mocks, asset, auth, analysis } = setup();
    await expect(sut.getTranscript(auth, asset.id)).resolves.toEqual({
      status: AudioAnalysisStatus.Unprocessed,
      transcript: null,
    });
    mocks.audioAnalysis.get.mockResolvedValue({ ...analysis, transcript: { ...transcript, text: '', segments: [] } });
    await expect(sut.getTranscript(auth, asset.id)).resolves.toMatchObject({
      status: AudioAnalysisStatus.Ready,
      transcript: { text: '', segments: [] },
    });
  });

  it('should keep saved transcripts readable when new transcription is disabled', async () => {
    const { sut, mocks, asset, auth, analysis } = setup();
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { speechToText: { enabled: false } } });
    await expect(sut.getTranscript(auth, asset.id)).resolves.toEqual({
      status: AudioAnalysisStatus.Disabled,
      transcript: null,
    });
    mocks.audioAnalysis.get.mockResolvedValue(analysis);
    await expect(sut.getTranscript(auth, asset.id)).resolves.toEqual({ status: AudioAnalysisStatus.Ready, transcript });
  });

  it.each([
    AudioAnalysisStatus.Pending,
    AudioAnalysisStatus.Processing,
    AudioAnalysisStatus.Failed,
    AudioAnalysisStatus.Ready,
  ])('should hide stale payloads while retaining %s processing state', async (status) => {
    const { sut, mocks, asset, auth, analysis } = setup();
    mocks.audioAnalysis.get.mockResolvedValue({
      ...analysis,
      waveformStatus: status,
      transcriptStatus: status,
      waveformChecksum: Buffer.from('old'),
      transcriptSourceModifiedAt: new Date(0),
    });
    const expected = status === AudioAnalysisStatus.Ready ? AudioAnalysisStatus.Unprocessed : status;
    await expect(sut.getWaveform(auth, asset.id)).resolves.toEqual({ status: expected, waveform: null });
    await expect(sut.getTranscript(auth, asset.id)).resolves.toEqual({ status: expected, transcript: null });
  });

  it.each([AssetType.Image, AssetType.Video])('should preserve %s processing by skipping audio jobs', async (type) => {
    const { sut, mocks, asset } = setup();
    mocks.assetJob.getForAudioAnalysis.mockResolvedValue({ ...asset, type });
    await expect(sut.generateWaveform({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
    await expect(sut.transcribe({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.media.probe).not.toHaveBeenCalled();
    expect(mocks.machineLearning.transcribe).not.toHaveBeenCalled();
  });

  it.each([{ isOffline: true }, { deletedAt: new Date() }, { visibility: AssetVisibility.Hidden }])(
    'should clear pending state when audio becomes unavailable: %j',
    async (changes) => {
      const { sut, mocks, asset } = setup();
      mocks.assetJob.getForAudioAnalysis.mockResolvedValue({ ...asset, ...changes });
      await expect(sut.generateWaveform({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      await expect(sut.transcribe({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.audioAnalysis.setStatusForSource).toHaveBeenCalledWith(
        asset.id,
        'transcript',
        AudioAnalysisStatus.Unprocessed,
        asset.checksum,
        asset.fileModifiedAt,
      );
      expect(mocks.media.probe).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'should enqueue missing or forced waveforms without deleting prior results: force=%s',
    async (force) => {
      const { sut, mocks, asset } = setup();
      mocks.assetJob.streamForAudioAnalysis.mockReturnValue(makeStream([{ id: asset.id }]));
      await expect(sut.queueWaveforms({ force })).resolves.toBe(JobStatus.Success);
      expect(mocks.assetJob.streamForAudioAnalysis).toHaveBeenCalledWith('waveform', force);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetGenerateWaveform, data: { id: asset.id, force } },
      ]);
    },
  );

  it.each(['queueWaveforms', 'queueTranscripts'] as const)(
    'should expose an enqueue failure from %s',
    async (method) => {
      const { sut, mocks, asset } = setup();
      mocks.assetJob.streamForAudioAnalysis.mockReturnValue(makeStream([{ id: asset.id }]));
      mocks.job.queueAll.mockRejectedValue(new Error('Redis unavailable'));
      await expect(sut[method]({ force: true })).rejects.toThrow('Redis unavailable');
      expect(mocks.audioAnalysis.setStatus).toHaveBeenLastCalledWith(
        [asset.id],
        method === 'queueWaveforms' ? 'waveform' : 'transcript',
        AudioAnalysisStatus.Failed,
      );
    },
  );

  it('should generate and persist a waveform against the captured source version', async () => {
    const { sut, mocks, asset } = setup();
    await expect(sut.generateWaveform({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.audioAnalysis.saveWaveform).toHaveBeenCalledWith(
      asset.id,
      waveform,
      asset.checksum,
      asset.fileModifiedAt,
    );
  });

  it('should skip fresh results but regenerate changed source versions', async () => {
    const { sut, mocks, asset, analysis } = setup();
    mocks.audioAnalysis.get.mockResolvedValue(analysis);
    await expect(sut.generateWaveform({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
    mocks.audioAnalysis.get.mockResolvedValue({ ...analysis, waveformSourceModifiedAt: new Date(0) });
    await expect(sut.generateWaveform({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.media.generateAudioWaveform).toHaveBeenCalledOnce();
  });

  it('should retain old data when a forced waveform refresh fails', async () => {
    const { sut, mocks, asset, analysis } = setup();
    mocks.audioAnalysis.get.mockResolvedValue(analysis);
    mocks.media.generateAudioWaveform.mockRejectedValue(new Error('Corrupt audio'));
    await expect(sut.generateWaveform({ id: asset.id, force: true })).rejects.toThrow('Corrupt audio');
    expect(mocks.audioAnalysis.saveWaveform).not.toHaveBeenCalled();
    expect(mocks.audioAnalysis.setStatusForSource).toHaveBeenLastCalledWith(
      asset.id,
      'waveform',
      AudioAnalysisStatus.Failed,
      asset.checksum,
      asset.fileModifiedAt,
    );
  });

  it('should allow manual transcription while automatic transcription is disabled', async () => {
    const { sut, mocks, asset } = setup();
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { speechToText: { autoTranscribe: false } } });
    await expect(sut.transcribe({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
    await expect(sut.transcribe({ id: asset.id, manual: true })).resolves.toBe(JobStatus.Success);
    expect(mocks.machineLearning.transcribe).toHaveBeenCalledOnce();
  });

  it('should not call ML or decode when speech processing is disabled', async () => {
    const { sut, mocks, asset } = setup();
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });
    await expect(sut.transcribe({ id: asset.id, force: true, manual: true })).resolves.toBe(JobStatus.Skipped);
    expect(mocks.media.probe).not.toHaveBeenCalled();
    expect(mocks.machineLearning.transcribe).not.toHaveBeenCalled();
  });

  it('should combine chunk offsets and index CJK text only after all chunks finish', async () => {
    const { sut, mocks, asset } = setup();
    mocks.media.streamAudioChunks.mockReturnValue(
      makeStream([
        { data: Buffer.from('first'), startMs: 0, durationMs: 30_000 },
        { data: Buffer.from('second'), startMs: 30_000, durationMs: 1000 },
      ]),
    );
    await expect(sut.transcribe({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.audioAnalysis.saveTranscript).toHaveBeenCalledWith(
      asset.id,
      expect.objectContaining({
        text: '你好 world\n你好 world',
        segmentType: 'chunk',
        segments: [transcript.segments[0], { startMs: 30_000, endMs: 31_000, text: transcript.text }],
      }),
      '你好 world 你好 world',
      asset.checksum,
      asset.fileModifiedAt,
    );
  });

  it('should not publish a partial transcript after a late decoder error', async () => {
    const { sut, mocks, asset } = setup();
    mocks.media.streamAudioChunks.mockReturnValue(
      (async function* () {
        yield { data: Buffer.from('first'), startMs: 0, durationMs: 1000 };
        await Promise.reject(new Error('Truncated audio'));
      })(),
    );
    await expect(sut.transcribe({ id: asset.id })).rejects.toThrow('Truncated audio');
    expect(mocks.audioAnalysis.saveTranscript).not.toHaveBeenCalled();
    expect(mocks.audioAnalysis.setStatusForSource).toHaveBeenLastCalledWith(
      asset.id,
      'transcript',
      AudioAnalysisStatus.Failed,
      asset.checksum,
      asset.fileModifiedAt,
    );
  });

  it('should count segment text toward the memory bound even when full text is empty', async () => {
    const { sut, mocks, asset } = setup();
    mocks.machineLearning.transcribe.mockResolvedValue({
      text: '',
      language: null,
      segments: [{ startMs: 0, endMs: 1, text: 'a'.repeat(2_000_001) }],
    });
    await expect(sut.transcribe({ id: asset.id })).rejects.toThrow('storage limits');
    expect(mocks.audioAnalysis.saveTranscript).not.toHaveBeenCalled();
  });

  it('should reject timestamps outside the actual final audio chunk', async () => {
    const { sut, mocks, asset } = setup();
    mocks.machineLearning.transcribe.mockResolvedValue({
      text: 'word',
      language: 'en',
      segments: [{ startMs: 0, endMs: 2000, text: 'word' }],
    });
    await expect(sut.transcribe({ id: asset.id })).rejects.toThrow('invalid chunk timestamps');
    expect(mocks.audioAnalysis.saveTranscript).not.toHaveBeenCalled();
  });

  it('should stop before ML when an asset disappears during decoding', async () => {
    const { sut, mocks, asset } = setup();
    mocks.assetJob.getForAudioAnalysis.mockResolvedValueOnce(asset).mockResolvedValue(undefined);
    await expect(sut.transcribe({ id: asset.id })).rejects.toThrow('changed while transcribing');
    expect(mocks.machineLearning.transcribe).not.toHaveBeenCalled();
    expect(mocks.audioAnalysis.saveTranscript).not.toHaveBeenCalled();
  });

  it('should stop before ML when the source changes during decoding', async () => {
    const { sut, mocks, asset } = setup();
    mocks.assetJob.getForAudioAnalysis
      .mockResolvedValueOnce(asset)
      .mockResolvedValue({ ...asset, fileModifiedAt: new Date(0) });
    await expect(sut.transcribe({ id: asset.id })).rejects.toThrow('changed while transcribing');
    expect(mocks.machineLearning.transcribe).not.toHaveBeenCalled();
    expect(mocks.audioAnalysis.saveTranscript).not.toHaveBeenCalled();
    expect(mocks.audioAnalysis.setStatusForSource).toHaveBeenLastCalledWith(
      asset.id,
      'transcript',
      AudioAnalysisStatus.Unprocessed,
      asset.checksum,
      asset.fileModifiedAt,
    );
  });

  it.each(['delete', 'shutdown'] as const)(
    'should cancel active waveform work on %s without publishing its result',
    async (event) => {
      const { sut, mocks, asset } = setup();
      mocks.media.generateAudioWaveform.mockImplementation((_path, _stream, signal) => {
        if (event === 'delete') {
          sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
        } else {
          sut.onShutdown();
        }
        expect(signal?.aborted).toBe(true);
        return Promise.resolve(waveform);
      });
      await expect(sut.generateWaveform({ id: asset.id })).rejects.toThrow();
      expect(mocks.audioAnalysis.saveWaveform).not.toHaveBeenCalled();
      expect(mocks.audioAnalysis.setStatusForSource).toHaveBeenLastCalledWith(
        asset.id,
        'waveform',
        AudioAnalysisStatus.Unprocessed,
        asset.checksum,
        asset.fileModifiedAt,
      );
    },
  );

  it('should cancel the in-flight speech request on deletion without publishing returned text', async () => {
    const { sut, mocks, asset } = setup();
    mocks.machineLearning.transcribe.mockImplementation((_buffer, _config, signal) => {
      sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
      expect(signal?.aborted).toBe(true);
      return Promise.resolve({ text: transcript.text, language: transcript.language, segments: transcript.segments });
    });
    await expect(sut.transcribe({ id: asset.id })).rejects.toThrow('deleted');
    expect(mocks.audioAnalysis.saveTranscript).not.toHaveBeenCalled();
  });

  it.each(['generateWaveform', 'transcribe'] as const)(
    'should clear processing when %s loses its source-version race',
    async (method) => {
      const { sut, mocks, asset } = setup();
      mocks.audioAnalysis.saveWaveform.mockResolvedValue(false);
      mocks.audioAnalysis.saveTranscript.mockResolvedValue(false);
      await expect(sut[method]({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.audioAnalysis.setStatusForSource).toHaveBeenLastCalledWith(
        asset.id,
        method === 'generateWaveform' ? 'waveform' : 'transcript',
        AudioAnalysisStatus.Unprocessed,
        asset.checksum,
        asset.fileModifiedAt,
      );
    },
  );
});
