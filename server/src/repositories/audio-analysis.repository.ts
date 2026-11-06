import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import { AudioSummaryDto, AudioTranscriptDto, AudioWaveformDto } from 'src/dtos/audio.dto.js';
import { AssetType, AssetVisibility, AudioAnalysisStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

export type AudioAnalysisKind = 'waveform' | 'transcript' | 'summary';

@Injectable()
export class AudioAnalysisRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('asset_audio_analysis').selectAll().where('assetId', '=', id).executeTakeFirst();
  }

  resetPending(kind: AudioAnalysisKind) {
    const column = `${kind}Status` as const;
    return this.db
      .updateTable('asset_audio_analysis')
      .set({
        [column]: sql<AudioAnalysisStatus>`case when ${sql.ref(kind)} is null then ${AudioAnalysisStatus.Unprocessed} else ${AudioAnalysisStatus.Ready} end`,
      })
      .where(column, '=', AudioAnalysisStatus.Pending)
      .execute();
  }

  @ChunkedArray()
  async setStatus(ids: string[], kind: AudioAnalysisKind, status: AudioAnalysisStatus) {
    if (ids.length === 0) {
      return;
    }

    const column = `${kind}Status` as const;
    await this.db.transaction().execute(async (trx) => {
      const assets = await trx
        .selectFrom('asset')
        .select('id')
        .where('id', 'in', ids)
        .orderBy('id')
        .forShare()
        .execute();
      if (assets.length > 0) {
        await trx
          .insertInto('asset_audio_analysis')
          .values(assets.map(({ id: assetId }) => ({ assetId, [column]: status })))
          .onConflict((oc) => oc.column('assetId').doUpdateSet({ [column]: status }))
          .execute();
      }
    });
  }

  saveWaveform(assetId: string, waveform: AudioWaveformDto, checksum: Buffer, sourceModifiedAt: Date) {
    const values = {
      waveform,
      waveformChecksum: checksum,
      waveformSourceModifiedAt: sourceModifiedAt,
      waveformStatus: AudioAnalysisStatus.Ready,
    };
    return this.save(assetId, checksum, sourceModifiedAt, values);
  }

  setStatusForSource(
    assetId: string,
    kind: AudioAnalysisKind,
    status: AudioAnalysisStatus,
    checksum: Buffer,
    sourceModifiedAt: Date,
  ) {
    const column = `${kind}Status` as const;
    return this.save(assetId, checksum, sourceModifiedAt, { [column]: status }, true);
  }

  saveTranscript(
    assetId: string,
    transcript: AudioTranscriptDto,
    transcriptText: string,
    checksum: Buffer,
    sourceModifiedAt: Date,
  ) {
    const values = {
      transcript,
      transcriptText,
      transcriptChecksum: checksum,
      transcriptSourceModifiedAt: sourceModifiedAt,
      transcriptStatus: AudioAnalysisStatus.Ready,
      transcriptRevision: randomUUID(),
      summaryStatus: AudioAnalysisStatus.Unprocessed,
      summaryJobId: null,
    };
    return this.save(assetId, checksum, sourceModifiedAt, values);
  }

  async claimSummary(
    assetId: string,
    checksum: Buffer,
    sourceModifiedAt: Date,
    transcriptRevision: string | null,
    jobId: string,
  ) {
    return this.updateSummarySource(assetId, checksum, sourceModifiedAt, transcriptRevision, {
      summaryJobId: jobId,
      summaryStatus: AudioAnalysisStatus.Processing,
    });
  }

  finishSummary(
    assetId: string,
    checksum: Buffer,
    sourceModifiedAt: Date,
    transcriptRevision: string | null,
    jobId: string,
    status: AudioAnalysisStatus,
    result?: { summary: AudioSummaryDto; configHash: string },
  ) {
    return this.updateSummarySource(
      assetId,
      checksum,
      sourceModifiedAt,
      transcriptRevision,
      {
        summaryStatus: status,
        summaryJobId: null,
        ...(result && {
          summary: result.summary,
          summaryChecksum: checksum,
          summarySourceModifiedAt: sourceModifiedAt,
          summaryTranscriptRevision: transcriptRevision,
          summaryConfigHash: result.configHash,
        }),
      },
      jobId,
    );
  }

  invalidateSummaryJobs(jobIds: string[]) {
    return this.db
      .updateTable('asset_audio_analysis')
      .set({ summaryJobId: null, summaryStatus: AudioAnalysisStatus.Unprocessed })
      .where('summaryJobId', 'in', jobIds)
      .execute();
  }

  releaseSummaryClaim(assetId: string, jobId: string) {
    return this.db
      .updateTable('asset_audio_analysis')
      .set({ summaryJobId: null, summaryStatus: AudioAnalysisStatus.Unprocessed })
      .where('assetId', '=', assetId)
      .where('summaryJobId', '=', jobId)
      .execute();
  }

  private updateSummarySource(
    assetId: string,
    checksum: Buffer,
    sourceModifiedAt: Date,
    transcriptRevision: string | null,
    values: {
      summaryStatus: AudioAnalysisStatus;
      summaryJobId: string | null;
      summary?: AudioSummaryDto;
      summaryChecksum?: Buffer;
      summarySourceModifiedAt?: Date;
      summaryTranscriptRevision?: string | null;
      summaryConfigHash?: string;
    },
    jobId?: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const asset = await trx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('checksum', '=', checksum)
        .where('fileModifiedAt', '=', sourceModifiedAt)
        .where('deletedAt', 'is', null)
        .where('isOffline', '=', false)
        .where('type', '=', AssetType.Audio)
        .where('visibility', '!=', AssetVisibility.Hidden)
        .forShare()
        .executeTakeFirst();
      if (!asset) {
        return false;
      }
      const result = await trx
        .updateTable('asset_audio_analysis')
        .set(values)
        .where('assetId', '=', assetId)
        .where('transcriptChecksum', '=', checksum)
        .where('transcriptSourceModifiedAt', '=', sourceModifiedAt)
        .where('transcriptRevision', 'is not distinct from', transcriptRevision)
        .$if(!!jobId, (query) => query.where('summaryJobId', '=', jobId!))
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    });
  }

  private save(
    assetId: string,
    checksum: Buffer,
    sourceModifiedAt: Date,
    values: {
      waveform?: AudioWaveformDto;
      waveformChecksum?: Buffer;
      waveformSourceModifiedAt?: Date;
      waveformStatus?: AudioAnalysisStatus;
      transcript?: AudioTranscriptDto;
      transcriptText?: string;
      transcriptChecksum?: Buffer;
      transcriptSourceModifiedAt?: Date;
      transcriptStatus?: AudioAnalysisStatus;
      transcriptRevision?: string;
      summaryStatus?: AudioAnalysisStatus;
      summaryJobId?: string | null;
    },
    includeDeleted = false,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const asset = await trx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('checksum', '=', checksum)
        .where('fileModifiedAt', '=', sourceModifiedAt)
        .$if(!includeDeleted, (query) => query.where('deletedAt', 'is', null))
        .forShare()
        .executeTakeFirst();
      if (!asset) {
        return false;
      }
      await trx
        .insertInto('asset_audio_analysis')
        .values({ assetId, ...values })
        .onConflict((oc) => oc.column('assetId').doUpdateSet(values))
        .execute();
      return true;
    });
  }
}
