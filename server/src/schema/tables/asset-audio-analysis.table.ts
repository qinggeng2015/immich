import { Column, ForeignKeyColumn, Index, Table, Timestamp } from '@immich/sql-tools';
import { AudioSummaryDto, AudioTranscriptDto, AudioWaveformDto } from 'src/dtos/audio.dto.js';
import { AudioAnalysisStatus } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_audio_analysis')
@Index({
  name: 'idx_asset_audio_analysis_transcript_text',
  using: 'gin',
  expression: 'f_unaccent("transcriptText") gin_trgm_ops',
})
export class AssetAudioAnalysisTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'jsonb', nullable: true })
  waveform!: AudioWaveformDto | null;

  @Column({ type: 'character varying', nullable: true })
  waveformStatus!: AudioAnalysisStatus | null;

  @Column({ type: 'bytea', nullable: true })
  waveformChecksum!: Buffer | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  waveformSourceModifiedAt!: Timestamp | null;

  @Column({ type: 'jsonb', nullable: true })
  transcript!: AudioTranscriptDto | null;

  @Column({ type: 'character varying', nullable: true })
  transcriptStatus!: AudioAnalysisStatus | null;

  @Column({ type: 'bytea', nullable: true })
  transcriptChecksum!: Buffer | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  transcriptSourceModifiedAt!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  transcriptText!: string | null;

  @Column({ type: 'uuid', nullable: true })
  transcriptRevision!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  summary!: AudioSummaryDto | null;

  @Column({ type: 'character varying', nullable: true })
  summaryStatus!: AudioAnalysisStatus | null;

  @Column({ type: 'bytea', nullable: true })
  summaryChecksum!: Buffer | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  summarySourceModifiedAt!: Timestamp | null;

  @Column({ type: 'uuid', nullable: true })
  summaryTranscriptRevision!: string | null;

  @Column({ type: 'character varying', nullable: true })
  summaryConfigHash!: string | null;

  @Column({ type: 'uuid', nullable: true })
  summaryJobId!: string | null;
}
