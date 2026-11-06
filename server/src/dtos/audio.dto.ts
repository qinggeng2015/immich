import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AudioAnalysisStatusSchema } from 'src/enum.js';

export const AudioWaveformSchema = z
  .object({
    version: z.literal(1).meta({ type: 'integer', format: 'int32' }).describe('Waveform data format version'),
    durationMs: z
      .number()
      .finite()
      .positive()
      .meta({ format: 'double' })
      .describe('Decoded audio duration in milliseconds'),
    peaks: z
      .array(z.number().min(0).max(1).meta({ format: 'double' }))
      .length(1024)
      .describe('Normalized peak amplitudes across equal time intervals'),
  })
  .meta({ id: 'AudioWaveformDto' });

export const AudioTranscriptSegmentSchema = z
  .object({
    startMs: z.number().finite().min(0).meta({ format: 'double' }).describe('Input audio chunk start in milliseconds'),
    endMs: z.number().finite().min(0).meta({ format: 'double' }).describe('Input audio chunk end in milliseconds'),
    text: z.string().describe('Recognized text for the chunk'),
  })
  .meta({ id: 'AudioTranscriptSegmentDto' });

export const AudioTranscriptSchema = z
  .object({
    text: z.string().describe('Full recognized transcript; empty for audio without recognized speech'),
    language: z.string().nullable().describe('Detected language, when available'),
    modelName: z.string().describe('Speech recognition model used'),
    segmentType: z.literal('chunk').describe('Segment timestamps mark input chunks rather than word alignment'),
    segments: z.array(AudioTranscriptSegmentSchema).describe('Recognized audio chunks in playback order'),
  })
  .meta({ id: 'AudioTranscriptDto' });

const AssetAudioWaveformResponseSchema = z
  .object({
    status: AudioAnalysisStatusSchema.describe('Waveform processing state'),
    waveform: AudioWaveformSchema.nullable().describe('Most recent successful waveform, when available'),
  })
  .meta({ id: 'AssetAudioWaveformResponseDto' });

const AssetAudioTranscriptResponseSchema = z
  .object({
    status: AudioAnalysisStatusSchema.describe('Transcription processing state'),
    transcript: AudioTranscriptSchema.nullable().describe('Most recent successful transcript, when available'),
  })
  .meta({ id: 'AssetAudioTranscriptResponseDto' });

export class AudioWaveformDto extends createZodDto(AudioWaveformSchema) {}
export class AudioTranscriptSegmentDto extends createZodDto(AudioTranscriptSegmentSchema) {}
export class AudioTranscriptDto extends createZodDto(AudioTranscriptSchema) {}
export class AssetAudioWaveformResponseDto extends createZodDto(AssetAudioWaveformResponseSchema) {}
export class AssetAudioTranscriptResponseDto extends createZodDto(AssetAudioTranscriptResponseSchema) {}

export const AudioSummarySchema = z
  .object({
    text: z.string().describe('Generated summary of the transcript'),
    modelName: z.string().describe('Model used to generate the summary'),
    updatedAt: z.iso.datetime().describe('Time the summary was generated'),
  })
  .meta({ id: 'AudioSummaryDto' });

export class AudioSummaryDto extends createZodDto(AudioSummarySchema) {}
export class AssetAudioSummaryResponseDto extends createZodDto(
  z
    .object({
      status: AudioAnalysisStatusSchema.describe('Summary processing state'),
      summary: AudioSummarySchema.nullable().describe('Most recent successful summary for the current transcript'),
    })
    .meta({ id: 'AssetAudioSummaryResponseDto' }),
) {}
