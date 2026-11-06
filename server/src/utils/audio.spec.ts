import { encodePcmWav, getAudioDecodeArguments, getStreamingWavInputOptions } from 'src/utils/audio.js';

const header = () => {
  const wav = encodePcmWav(Buffer.alloc(32_000), 16_000);
  wav.writeUInt32LE(0xff_ff_ff_ff, 4);
  wav.writeUInt32LE(0xff_ff_ff_ff, 40);
  return wav;
};

describe('streaming WAV input options', () => {
  it('should constrain raw input to validated unknown-length PCM16 while preserving strict errors', () => {
    const wav = header();
    const options = getStreamingWavInputOptions(wav.subarray(0, 44), wav.length);
    expect(options).toEqual(['-f', 's16le', '-ar', '16000', '-ac', '1', '-skip_initial_bytes', '44']);
    expect(getAudioDecodeArguments('/stream.wav', 0, 48_000, null, options)).toEqual([
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      ...options,
      '-i',
      '/stream.wav',
      '-map',
      '0:0',
      '-vn',
      '-sn',
      '-dn',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      'pipe:1',
    ]);
  });

  it.each([
    { offset: 4, value: 32_036, bytes: 4 },
    { offset: 40, value: 32_000, bytes: 4 },
    { offset: 20, value: 3, bytes: 2 },
    { offset: 22, value: 0, bytes: 2 },
    { offset: 24, value: 0, bytes: 4 },
    { offset: 28, value: 1, bytes: 4 },
    { offset: 32, value: 1, bytes: 2 },
    { offset: 34, value: 24, bytes: 2 },
  ])('should retain normal demuxing for incompatible or inconsistent headers: %j', ({ offset, value, bytes }) => {
    const wav = header();
    wav.writeUIntLE(value, offset, bytes);
    expect(getStreamingWavInputOptions(wav, wav.length)).toEqual([]);
  });

  it('should retain normal demuxing for incomplete headers, empty data and partial sample frames', () => {
    const wav = header();
    expect(getStreamingWavInputOptions(wav.subarray(0, 43), wav.length)).toEqual([]);
    expect(getStreamingWavInputOptions(wav, 44)).toEqual([]);
    expect(getStreamingWavInputOptions(wav, wav.length - 1)).toEqual([]);
  });
});
