import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll as after, beforeAll as before, test } from 'vitest';
import { getAudioTranscodeCommand } from 'src/utils/audio.js';

const execute = promisify(execFile);
const ffmpeg = (args) => execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
const probe = async (path) => {
  const { stdout } = await execute(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(stdout);
};

let directory;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'immich-audio-'));
});
after(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

const verifyPlayback = async (input, output, expectedDuration) => {
  const original = await probe(input);
  const audio = original.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(audio);
  await ffmpeg(['-xerror', '-i', input, '-f', 'null', '-']);
  const command = getAudioTranscodeCommand(audio.index);
  await ffmpeg([...command.inputOptions, '-i', input, ...command.outputOptions, output]);
  const result = await probe(output);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].codec_type, 'audio');
  assert.equal(result.streams[0].codec_name, 'aac');
  assert.equal(result.streams[0].channels, 2);
  assert.equal(result.streams[0].sample_rate, '48000');
  assert.ok(Math.abs(Number(result.format.duration) - (expectedDuration ?? Number(original.format.duration))) < 0.2);
  const bytes = await readFile(output);
  assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'));
  await ffmpeg(['-i', output, '-f', 'null', '-']);
  await ffmpeg(['-ss', '0.25', '-i', output, '-t', '0.1', '-f', 'null', '-']);
};

const fixtures = [
  { extension: 'aac', codec: 'aac' },
  { extension: 'aif', codec: 'pcm_s16be' },
  { extension: 'aiff', codec: 'pcm_s16be' },
  { extension: 'alac', codec: 'alac', format: 'ipod' },
  { extension: 'caf', codec: 'pcm_s16le' },
  { extension: 'flac', codec: 'flac' },
  { extension: 'm4a', codec: 'aac' },
  { extension: 'm4b', codec: 'aac', format: 'ipod' },
  { extension: 'mp3', codec: 'libmp3lame' },
  { extension: 'oga', codec: 'vorbis', format: 'ogg' },
  { extension: 'ogg', codec: 'vorbis' },
  { extension: 'opus', codec: 'libopus' },
  { extension: 'wav', codec: 'pcm_s16le' },
  { extension: 'wma', codec: 'wmav2' },
];

for (const { extension, codec, format } of fixtures) {
  test(`${extension} produces seekable AAC playback without video`, async () => {
    const input = join(directory, `input.${extension}`);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.5',
      '-ac',
      '2',
      '-c:a',
      codec,
      '-strict',
      '-2',
      ...(format ? ['-f', format] : []),
      input,
    ]);
    await verifyPlayback(input, join(directory, `${extension}.mp4`));
  });
}

test('FLAC written to a nonseekable stream remains playable without a container duration', async () => {
  const input = join(directory, 'streamed.flac');
  const { stdout } = await execute(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'flac', '-f', 'flac', 'pipe:1'],
    { encoding: 'buffer' },
  );
  await writeFile(input, stdout);
  assert.equal((await probe(input)).format.duration, undefined);
  await verifyPlayback(input, join(directory, 'streamed.mp4'), 0.5);
});

test('AMR-NB speech frames produce seekable AAC playback', async () => {
  const input = join(directory, 'input.amr');
  const frame475 = Buffer.alloc(13);
  frame475[0] = 0x04;
  await writeFile(input, Buffer.concat([Buffer.from('#!AMR\n'), ...Array.from({ length: 25 }, () => frame475)]));

  const source = await probe(input);
  assert.equal(source.streams[0].codec_name, 'amr_nb');
  assert.equal(source.streams[0].sample_rate, '8000');
  assert.ok(Math.abs(Number(source.format.duration) - 0.5) < 0.01);
  await verifyPlayback(input, join(directory, 'amr.mp4'));
});

test('embedded cover art is omitted from the audio playback derivative', async () => {
  const input = join(directory, 'cover.m4a');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.5',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x64:d=0.1',
    '-map',
    '0:a',
    '-map',
    '1:v',
    '-c:a',
    'aac',
    '-c:v',
    'mjpeg',
    '-frames:v',
    '1',
    '-disposition:v',
    'attached_pic',
    input,
  ]);
  const source = await probe(input);
  assert.ok(source.streams.some((stream) => stream.disposition.attached_pic === 1));
  await verifyPlayback(input, join(directory, 'cover.mp4'));
});

test('malformed audio fails without producing a playable derivative', async () => {
  const input = join(directory, 'malformed.mp3');
  const output = join(directory, 'malformed.mp4');
  await writeFile(input, 'This is not an audio stream');
  const command = getAudioTranscodeCommand(0);

  await assert.rejects(ffmpeg(['-i', input, ...command.outputOptions, output]));
  await assert.rejects(probe(output));
});
