import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';

const execute = promisify(execFile);
const media = new MediaRepository({ setContext: () => {} } as unknown as LoggingRepository);
const ffmpeg = (args: string[]) => execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'immich-audio-processing-'));
});

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

test('waveform preserves silent gaps, quiet and loud sections across the complete recording', async () => {
  const path = join(directory, 'envelope.wav');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='if(between(t,1,2),0.25*sin(2*PI*440*t),if(gte(t,3),0.75*sin(2*PI*440*t),0))':s=48000:d=4",
    path,
  ]);

  const waveform = await media.generateAudioWaveform(path, 0);
  expect(waveform.durationMs).toBe(4000);
  expect(waveform.peaks).toHaveLength(1024);
  expect(waveform.peaks.slice(5, 250).every((peak) => peak === 0)).toBe(true);
  expect(waveform.peaks.slice(270, 500).every((peak) => Math.abs(peak - 0.25) < 0.002)).toBe(true);
  expect(waveform.peaks.slice(525, 755).every((peak) => peak === 0)).toBe(true);
  expect(waveform.peaks.slice(780, 1020).every((peak) => Math.abs(peak - 0.75) < 0.002)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(waveform))).toBeLessThan(12_000);
});

test('waveform uses decoded duration for a FLAC stream without declared total samples', async () => {
  const path = join(directory, 'streamed.flac');
  const { stdout } = await execute(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'flac', '-f', 'flac', 'pipe:1'],
    { encoding: 'buffer' },
  );
  await writeFile(path, stdout);

  const waveform = await media.generateAudioWaveform(path, 0);
  expect(waveform.durationMs).toBe(500);
  expect(waveform.peaks.some((peak) => peak > 0.1)).toBe(true);
});

test('unknown-length PCM WAV retains every sample without modifying the streamed file', async () => {
  const { stdout } = await execute(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1',
    ],
    { encoding: 'buffer' },
  );
  const path = join(directory, 'streamed.wav');
  const finalizedPath = join(directory, 'finalized.wav');
  const dataOffset = stdout.indexOf('data') + 8;
  expect(stdout.readUInt32LE(4)).toBe(0xff_ff_ff_ff);
  expect(stdout.readUInt32LE(dataOffset - 4)).toBe(0xff_ff_ff_ff);
  const finalized = Buffer.from(stdout);
  finalized.writeUInt32LE(stdout.length - 8, 4);
  finalized.writeUInt32LE(stdout.length - dataOffset, dataOffset - 4);
  await writeFile(path, stdout);
  await writeFile(finalizedPath, finalized);

  const waveform = await media.generateAudioWaveform(path, 0);
  expect(waveform).toEqual(await media.generateAudioWaveform(finalizedPath, 0));
  expect(waveform.durationMs).toBe(1000);
  expect(waveform.peaks.some((peak) => peak > 0)).toBe(true);
  const chunks = await Array.fromAsync(media.streamAudioChunks(path, 0));
  expect(chunks).toEqual(await Array.fromAsync(media.streamAudioChunks(finalizedPath, 0)));
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ startMs: 0, durationMs: 1000 });
  expect(chunks[0].data).toHaveLength(32_044);
  expect(await readFile(path)).toEqual(stdout);
});

test('strict decoding still rejects truncated finite WAV data and incomplete streaming PCM frames', async () => {
  const completePath = join(directory, 'complete.wav');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:a',
    'pcm_s16le',
    completePath,
  ]);
  const complete = await readFile(completePath);
  const dataOffset = complete.indexOf('data') + 8;
  const streamed = Buffer.from(complete);
  streamed.writeUInt32LE(0xff_ff_ff_ff, 4);
  streamed.writeUInt32LE(0xff_ff_ff_ff, dataOffset - 4);
  for (const [name, bytes] of [
    ['truncated', complete.subarray(0, -2)],
    ['incomplete-frame', streamed.subarray(0, -1)],
  ] as const) {
    const path = join(directory, `${name}.wav`);
    await writeFile(path, bytes);
    await expect(media.generateAudioWaveform(path, 0)).rejects.toThrow('Audio decoder exited');
    await expect(Array.fromAsync(media.streamAudioChunks(path, 0))).rejects.toThrow('Audio decoder exited');
  }
});

test('waveform selects the requested audio track', async () => {
  const path = join(directory, 'tracks.m4a');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=mono',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-map',
    '0:a',
    '-map',
    '1:a',
    '-t',
    '1',
    '-c:a',
    'aac',
    path,
  ]);

  const silence = await media.generateAudioWaveform(path, 0);
  const tone = await media.generateAudioWaveform(path, 1);
  expect(silence.peaks.every((peak) => peak === 0)).toBe(true);
  expect(tone.peaks.some((peak) => peak > 0.1)).toBe(true);
});

test('opposite-phase stereo channels keep their waveform amplitude', async () => {
  const path = join(directory, 'opposite.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t)|-0.5*sin(2*PI*440*t):s=48000:d=1', path]);

  const waveform = await media.generateAudioWaveform(path, 0);
  expect(waveform.durationMs).toBe(1000);
  expect(waveform.peaks.every((peak) => Math.abs(peak - 0.5) < 0.002)).toBe(true);
});

test('speech input streams as individually decodable bounded WAV chunks covering the entire recording', async () => {
  const path = join(directory, 'speech.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=61.25', '-ar', '48000', '-ac', '2', path]);
  const timings = [];
  for await (const chunk of media.streamAudioChunks(path, 0)) {
    expect(chunk.data.length).toBeLessThanOrEqual(960_044);
    expect(chunk.data.readUInt32LE(24)).toBe(16_000);
    expect(chunk.data.readUInt16LE(22)).toBe(1);
    expect(chunk.data.readUInt16LE(34)).toBe(16);
    const chunkPath = join(directory, `speech-${chunk.startMs}.wav`);
    await writeFile(chunkPath, chunk.data);
    await ffmpeg(['-xerror', '-i', chunkPath, '-f', 'null', '-']);
    timings.push([chunk.startMs, chunk.durationMs]);
  }

  expect(timings).toEqual([
    [0, 30_000],
    [30_000, 30_000],
    [60_000, 1250],
  ]);
});

test('malformed input and canceled decoding reject instead of publishing waveform data', async () => {
  const path = join(directory, 'broken.mp3');
  await writeFile(path, 'not an audio recording');

  await expect(media.generateAudioWaveform(path, 0)).rejects.toThrow('Audio decoder exited');
  await expect(media.generateAudioWaveform(path, 0, AbortSignal.abort())).rejects.toThrow();
});
