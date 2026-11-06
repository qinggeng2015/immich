import type { TranscodeCommand } from 'src/types.js';

export const AUDIO_TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const AUDIO_TRANSCRIPTION_CHUNK_SECONDS = 30;

export type AudioChunk = { data: Buffer; startMs: number; durationMs: number };

export const getStreamingWavInputOptions = (header: Buffer, fileSize: number): string[] => {
  if (
    header.length < 44 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.readUInt32LE(4) !== 0xff_ff_ff_ff ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return [];
  }

  let format: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  for (let offset = 12; offset + 8 <= header.length;) {
    const name = header.toString('ascii', offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (name === 'data') {
      if (!format || size !== 0xff_ff_ff_ff || fileSize <= start || (fileSize - start) % format.blockAlign !== 0) {
        return [];
      }
      return [
        '-f',
        's16le',
        '-ar',
        String(format.sampleRate),
        '-ac',
        String(format.channels),
        '-skip_initial_bytes',
        String(start),
      ];
    }
    if (start + size > header.length) {
      return [];
    }
    if (name === 'fmt ') {
      if (format || size < 16 || header.readUInt16LE(start) !== 1 || header.readUInt16LE(start + 14) !== 16) {
        return [];
      }
      const channels = header.readUInt16LE(start + 2);
      const sampleRate = header.readUInt32LE(start + 4);
      const blockAlign = header.readUInt16LE(start + 12);
      if (
        channels < 1 ||
        channels > 64 ||
        sampleRate < 1 ||
        sampleRate > 768_000 ||
        blockAlign !== channels * 2 ||
        header.readUInt32LE(start + 8) !== sampleRate * blockAlign
      ) {
        return [];
      }
      format = { channels, sampleRate, blockAlign };
    }
    offset = start + size + (size % 2);
  }
  return [];
};

export const getAudioDecodeArguments = (
  input: string,
  streamIndex: number,
  sampleRate: number,
  channels: number | null = 1,
  inputOptions: string[] = [],
) => {
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) {
    throw new Error('Invalid audio stream index');
  }

  return [
    '-v',
    'error',
    '-nostdin',
    '-xerror',
    ...inputOptions,
    '-i',
    input,
    '-map',
    `0:${streamIndex}`,
    '-vn',
    '-sn',
    '-dn',
    ...(channels === null ? [] : ['-ac', String(channels)]),
    '-ar',
    String(sampleRate),
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ];
};

export const encodePcmWav = (pcm: Buffer, sampleRate: number) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

export const getAudioTranscodeCommand = (streamIndex: number): TranscodeCommand => ({
  inputOptions: [],
  outputOptions: [
    '-map',
    `0:${streamIndex}`,
    '-vn',
    '-sn',
    '-dn',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
  ],
  twoPass: false,
  progress: { frameCount: 0, percentInterval: 10 },
});
