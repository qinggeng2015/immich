export const getWaveformBars = (peaks: number[], maxBars = 128): number[] => {
  const count = Math.min(peaks.length, maxBars);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * peaks.length) / count);
    const end = Math.floor(((index + 1) * peaks.length) / count);
    let peak = 0;
    for (let sample = start; sample < end; sample++) {
      const value = peaks[sample];
      if (Number.isFinite(value)) {
        peak = Math.max(peak, Math.min(1, value));
      }
    }
    return peak;
  });
};
