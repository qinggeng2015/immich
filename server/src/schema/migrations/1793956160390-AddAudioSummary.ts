import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_audio_analysis" ADD "transcriptRevision" uuid;`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" ADD "summary" jsonb;`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" ADD "summaryStatus" character varying;`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" ADD "summaryChecksum" bytea;`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" ADD "summarySourceModifiedAt" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" ADD "summaryTranscriptRevision" uuid;`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" ADD "summaryConfigHash" character varying;`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" ADD "summaryJobId" uuid;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "transcriptRevision";`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "summary";`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "summaryStatus";`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "summaryChecksum";`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "summarySourceModifiedAt";`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "summaryTranscriptRevision";`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "summaryConfigHash";`.execute(db);
  await sql`ALTER TABLE "asset_audio_analysis" DROP COLUMN "summaryJobId";`.execute(db);
}
