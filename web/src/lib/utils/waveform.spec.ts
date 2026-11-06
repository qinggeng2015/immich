import { getWaveformBars } from '#lib/utils/waveform.ts';

describe('getWaveformBars', () => {
  it('preserves short waveforms', () => {
    expect(getWaveformBars([0, 0.2, 1, 0.7])).toEqual([0, 0.2, 1, 0.7]);
  });

  it('preserves brief peaks when reducing large waveforms', () => {
    const peaks = Array.from({ length: 1024 }, () => 0);
    peaks[1000] = 0.9;
    peaks[1023] = 1;

    const bars = getWaveformBars(peaks);

    expect(bars).toHaveLength(128);
    expect(bars[125]).toBe(0.9);
    expect(bars[127]).toBe(1);
  });

  it('clamps invalid samples and handles empty waveforms', () => {
    expect(getWaveformBars([NaN, Infinity, -0.5, 2])).toEqual([0, 0, 0, 1]);
    expect(getWaveformBars([])).toEqual([]);
  });
});
