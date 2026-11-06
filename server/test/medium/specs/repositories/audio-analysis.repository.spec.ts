import { Insertable, Kysely, Selectable } from 'kysely';
import { AudioTranscriptDto, AudioWaveformDto } from 'src/dtos/audio.dto.js';
import { AssetType, AssetVisibility, AudioAnalysisStatus } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AudioAnalysisKind, AudioAnalysisRepository } from 'src/repositories/audio-analysis.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { tokenizeForSearch } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
const userIds = new Set<string>();
const waveform: AudioWaveformDto = { version: 1, durationMs: 1000, peaks: Array.from({ length: 1024 }, () => 0.5) };
const transcript: AudioTranscriptDto = {
  text: '今天讨论语音识别功能',
  language: 'zh',
  modelName: 'test-model',
  segmentType: 'chunk',
  segments: [{ startMs: 0, endMs: 1000, text: '今天讨论语音识别功能' }],
};

type AnalysisSource = Pick<Selectable<AssetTable>, 'id' | 'checksum' | 'fileModifiedAt'>;

const saveAnalysis = (repository: AudioAnalysisRepository, kind: AudioAnalysisKind, asset: AnalysisSource) =>
  kind === 'waveform'
    ? repository.saveWaveform(asset.id, waveform, asset.checksum, asset.fileModifiedAt)
    : repository.saveTranscript(
        asset.id,
        transcript,
        tokenizeForSearch(transcript.text).join(' '),
        asset.checksum,
        asset.fileModifiedAt,
      );

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  userIds.add(user.id);
  return {
    ctx,
    user,
    sut: new AudioAnalysisRepository(database),
    jobs: ctx.get(AssetJobRepository),
    search: ctx.get(SearchRepository),
    newAsset: async (values: Partial<Insertable<AssetTable>> = {}) => {
      const { result } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Audio, ...values });
      return result;
    },
  };
};

beforeAll(async () => {
  database = await getKyselyDB();
});

afterEach(async () => {
  if (userIds.size === 0) {
    return;
  }

  await database
    .deleteFrom('user')
    .where('id', 'in', [...userIds])
    .execute();
  userIds.clear();
});

describe(AudioAnalysisRepository.name, () => {
  it('should retain waveform and transcript when both are saved concurrently', async () => {
    const { sut, newAsset } = await setup();
    const asset = await newAsset();

    await expect(
      Promise.all([saveAnalysis(sut, 'waveform', asset), saveAnalysis(sut, 'transcript', asset)]),
    ).resolves.toEqual([true, true]);

    await expect(sut.get(asset.id)).resolves.toEqual({
      assetId: asset.id,
      waveform,
      waveformChecksum: asset.checksum,
      waveformSourceModifiedAt: asset.fileModifiedAt,
      waveformStatus: AudioAnalysisStatus.Ready,
      transcript,
      transcriptText: tokenizeForSearch(transcript.text).join(' '),
      transcriptChecksum: asset.checksum,
      transcriptSourceModifiedAt: asset.fileModifiedAt,
      transcriptStatus: AudioAnalysisStatus.Ready,
      transcriptRevision: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
      summary: null,
      summaryStatus: AudioAnalysisStatus.Unprocessed,
      summaryChecksum: null,
      summarySourceModifiedAt: null,
      summaryTranscriptRevision: null,
      summaryConfigHash: null,
      summaryJobId: null,
    });
  });

  it.each([
    ['waveform', 'checksum'],
    ['waveform', 'fileModifiedAt'],
    ['transcript', 'checksum'],
    ['transcript', 'fileModifiedAt'],
  ] as const)('should reject a stale %s after the source %s changes', async (kind, changedField) => {
    const { sut, newAsset } = await setup();
    const asset = await newAsset();
    await saveAnalysis(sut, kind, asset);
    const saved = await sut.get(asset.id);
    const updated = await database
      .updateTable('asset')
      .set(
        changedField === 'checksum'
          ? { checksum: Buffer.from('updated-source-checksum') }
          : { fileModifiedAt: new Date(asset.fileModifiedAt.getTime() + 60_000) },
      )
      .where('id', '=', asset.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await expect(saveAnalysis(sut, kind, asset)).resolves.toBe(false);
    await expect(sut.get(asset.id)).resolves.toEqual(saved);
    await expect(saveAnalysis(sut, kind, updated)).resolves.toBe(true);
    await expect(
      sut.setStatusForSource(asset.id, kind, AudioAnalysisStatus.Failed, asset.checksum, asset.fileModifiedAt),
    ).resolves.toBe(false);
    await expect(sut.get(asset.id)).resolves.toMatchObject(
      kind === 'waveform'
        ? {
            waveformChecksum: updated.checksum,
            waveformSourceModifiedAt: updated.fileModifiedAt,
            waveformStatus: AudioAnalysisStatus.Ready,
          }
        : {
            transcriptChecksum: updated.checksum,
            transcriptSourceModifiedAt: updated.fileModifiedAt,
            transcriptStatus: AudioAnalysisStatus.Ready,
          },
    );
  });

  it.each(['waveform', 'transcript'] as const)('should reject a late %s after an asset is trashed', async (kind) => {
    const { sut, newAsset } = await setup();
    const asset = await newAsset();
    await database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();

    await expect(saveAnalysis(sut, kind, asset)).resolves.toBe(false);
    await expect(sut.get(asset.id)).resolves.toBeUndefined();
  });

  it('should cascade analysis deletion and ignore late saves and statuses for deleted assets', async () => {
    const { sut, newAsset } = await setup();
    const asset = await newAsset();
    await saveAnalysis(sut, 'waveform', asset);
    await saveAnalysis(sut, 'transcript', asset);

    await database.deleteFrom('asset').where('id', '=', asset.id).execute();

    await expect(sut.get(asset.id)).resolves.toBeUndefined();
    await expect(saveAnalysis(sut, 'waveform', asset)).resolves.toBe(false);
    await expect(saveAnalysis(sut, 'transcript', asset)).resolves.toBe(false);
    await expect(sut.setStatus([asset.id], 'waveform', AudioAnalysisStatus.Failed)).resolves.toBeUndefined();
    await expect(sut.setStatus([asset.id], 'transcript', AudioAnalysisStatus.Failed)).resolves.toBeUndefined();
    await expect(sut.get(asset.id)).resolves.toBeUndefined();
  });

  it('should update each status independently without deleting successful results or inserting missing assets', async () => {
    const { sut, newAsset } = await setup();
    const asset = await newAsset();
    const missingId = factory.uuid();
    await saveAnalysis(sut, 'waveform', asset);
    await saveAnalysis(sut, 'transcript', asset);

    await sut.setStatus([asset.id, missingId], 'waveform', AudioAnalysisStatus.Pending);
    await sut.setStatus([asset.id, missingId], 'transcript', AudioAnalysisStatus.Failed);
    await sut.setStatus([], 'waveform', AudioAnalysisStatus.Processing);

    await expect(sut.get(asset.id)).resolves.toMatchObject({
      waveform,
      transcript,
      waveformStatus: AudioAnalysisStatus.Pending,
      transcriptStatus: AudioAnalysisStatus.Failed,
    });
    await expect(sut.get(missingId)).resolves.toBeUndefined();
  });

  it.each(['waveform', 'transcript'] as const)(
    'should select missing and stale %s without selecting ineligible assets',
    async (kind) => {
      const { sut, jobs, newAsset } = await setup();
      const missing = await newAsset();
      const archived = await newAsset({ visibility: AssetVisibility.Archive });
      const ready = await newAsset();
      const staleChecksum = await newAsset();
      const staleModifiedAt = await newAsset();
      const otherAnalysisOnly = await newAsset();
      await newAsset({ type: AssetType.Image });
      await newAsset({ type: AssetType.Video });
      await newAsset({ visibility: AssetVisibility.Hidden });
      await newAsset({ isOffline: true });
      await newAsset({ deletedAt: new Date() });
      for (const asset of [ready, staleChecksum, staleModifiedAt]) {
        await saveAnalysis(sut, kind, asset);
      }
      await saveAnalysis(sut, kind === 'waveform' ? 'transcript' : 'waveform', otherAnalysisOnly);
      await database
        .updateTable('asset')
        .set({ checksum: Buffer.from('replacement-checksum') })
        .where('id', '=', staleChecksum.id)
        .execute();
      await database
        .updateTable('asset')
        .set({ fileModifiedAt: new Date(staleModifiedAt.fileModifiedAt.getTime() + 60_000) })
        .where('id', '=', staleModifiedAt.id)
        .execute();

      const missingAssets = await Array.fromAsync(jobs.streamForAudioAnalysis(kind));
      const forcedAssets = await Array.fromAsync(jobs.streamForAudioAnalysis(kind, true));
      const missingIds = missingAssets.map(({ id }) => id).sort();
      const forceIds = forcedAssets.map(({ id }) => id).sort();

      expect(missingIds).toEqual(
        [missing, archived, staleChecksum, staleModifiedAt, otherAnalysisOnly].map(({ id }) => id).sort(),
      );
      expect(forceIds).toEqual(
        [missing, archived, ready, staleChecksum, staleModifiedAt, otherAnalysisOnly].map(({ id }) => id).sort(),
      );
    },
  );

  it.each(['legacy', 'filter'] as const)(
    'should search CJK transcripts within the owner scope and exclude stale results using %s search',
    async (api) => {
      const { ctx, sut, search, user, newAsset } = await setup();
      const { user: otherUser } = await ctx.newUser();
      userIds.add(otherUser.id);
      const current = await newAsset();
      const foreign = await newAsset({ ownerId: otherUser.id });
      const staleChecksum = await newAsset();
      const staleModifiedAt = await newAsset();
      const unrelated = await newAsset();
      for (const asset of [current, foreign, staleChecksum, staleModifiedAt]) {
        await saveAnalysis(sut, 'transcript', asset);
      }
      await sut.saveTranscript(
        unrelated.id,
        { ...transcript, text: '周末天气晴朗', segments: [] },
        tokenizeForSearch('周末天气晴朗').join(' '),
        unrelated.checksum,
        unrelated.fileModifiedAt,
      );
      await database
        .updateTable('asset')
        .set({ checksum: Buffer.from('changed-transcript-source') })
        .where('id', '=', staleChecksum.id)
        .execute();
      await database
        .updateTable('asset')
        .set({ fileModifiedAt: new Date(staleModifiedAt.fileModifiedAt.getTime() + 60_000) })
        .where('id', '=', staleModifiedAt.id)
        .execute();
      const searchOwner = (ownerId: string) =>
        api === 'legacy'
          ? search.searchMetadata({ page: 1, size: 100 }, { userIds: [ownerId], transcript: '语音识别' })
          : search.searchMetadataV3(
              { take: 100 },
              { filter: { transcript: { matches: '语音识别' } } },
              { userIds: [ownerId], lockedOwnerId: ownerId },
            );

      await expect(searchOwner(user.id)).resolves.toMatchObject({ items: [{ id: current.id }], hasNextPage: false });
      await expect(searchOwner(otherUser.id)).resolves.toMatchObject({
        items: [{ id: foreign.id }],
        hasNextPage: false,
      });
    },
  );
});
