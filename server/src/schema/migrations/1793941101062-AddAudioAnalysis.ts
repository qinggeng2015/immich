import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_audio_analysis" (
  "assetId" uuid NOT NULL,
  "waveform" jsonb,
  "waveformStatus" character varying,
  "waveformChecksum" bytea,
  "waveformSourceModifiedAt" timestamp with time zone,
  "transcript" jsonb,
  "transcriptStatus" character varying,
  "transcriptChecksum" bytea,
  "transcriptSourceModifiedAt" timestamp with time zone,
  "transcriptText" text,
  CONSTRAINT "asset_audio_analysis_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_audio_analysis_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE INDEX "idx_asset_audio_analysis_transcript_text" ON "asset_audio_analysis" USING gin (f_unaccent("transcriptText") gin_trgm_ops);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_idx_asset_audio_analysis_transcript_text', '{"type":"index","name":"idx_asset_audio_analysis_transcript_text","sql":"CREATE INDEX \\"idx_asset_audio_analysis_transcript_text\\" ON \\"asset_audio_analysis\\" USING gin (f_unaccent(\\"transcriptText\\") gin_trgm_ops);"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_audio_analysis";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_idx_asset_audio_analysis_transcript_text';`.execute(db);
}
