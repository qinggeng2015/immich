import { formatAudioDuration } from '#lib/utils/audio.ts';

describe('formatAudioDuration', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [61_999, '1:01'],
    [3_661_000, '1:01:01'],
    [90_000_000, '25:00:00'],
    [null, '--:--'],
    [undefined, '--:--'],
    [-1000, '--:--'],
    [NaN, '--:--'],
    [Infinity, '--:--'],
  ])('formats %s milliseconds as %s', (duration, expected) => {
    expect(formatAudioDuration(duration)).toBe(expected);
  });
});
