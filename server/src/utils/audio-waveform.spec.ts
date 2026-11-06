import {
  AUDIO_WAVEFORM_PEAK_COUNT,
  AUDIO_WAVEFORM_SAMPLE_RATE,
  AudioWaveformAccumulator,
} from 'src/utils/audio-waveform.js';

const pcm = (samples: number[]) => {
  const data = Buffer.alloc(samples.length * 2);
  for (const [index, sample] of samples.entries()) {
    data.writeInt16LE(sample, index * 2);
  }
  return data;
};

describe(AudioWaveformAccumulator.name, () => {
  it('should retain silence without artificially normalizing it', () => {
    const waveform = new AudioWaveformAccumulator();
    waveform.add(Buffer.alloc(AUDIO_WAVEFORM_SAMPLE_RATE * 2));

    expect(waveform.finish()).toEqual({
      version: 1,
      durationMs: 1000,
      peaks: Array.from({ length: AUDIO_WAVEFORM_PEAK_COUNT }, () => 0),
    });
  });

  it('should handle PCM samples split across arbitrary chunks and empty chunks', () => {
    const source = pcm([0, -32_768, 16_384, -8192, 0]);
    const waveform = new AudioWaveformAccumulator();
    for (const byte of source) {
      waveform.add(Buffer.from([byte]));
      waveform.add(Buffer.alloc(0));
    }

    const result = waveform.finish();
    expect(result.peaks[0]).toBe(0);
    expect(result.peaks[300]).toBe(1);
    expect(result.peaks[512]).toBe(0.5);
    expect(result.peaks[700]).toBe(0.25);
    expect(result.peaks[1023]).toBe(0);
    expect(result.peaks).toHaveLength(AUDIO_WAVEFORM_PEAK_COUNT);
  });

  it('should retain beginning, middle and final transients through repeated bounded compaction', () => {
    const waveform = new AudioWaveformAccumulator();
    const sampleCount = AUDIO_WAVEFORM_SAMPLE_RATE * 60;
    const chunk = Buffer.alloc(AUDIO_WAVEFORM_SAMPLE_RATE * 2);
    chunk.writeInt16LE(16_384, 0);
    waveform.add(chunk);
    chunk.fill(0);
    for (let second = 1; second < 59; second++) {
      chunk.writeInt16LE(second === 30 ? -32_768 : 0, 0);
      waveform.add(chunk);
    }
    chunk.fill(0);
    chunk.writeInt16LE(8192, chunk.length - 2);
    waveform.add(chunk);

    const result = waveform.finish();
    expect(result.durationMs).toBe((sampleCount / AUDIO_WAVEFORM_SAMPLE_RATE) * 1000);
    expect(result.peaks).toHaveLength(AUDIO_WAVEFORM_PEAK_COUNT);
    expect(result.peaks[0]).toBe(0.5);
    expect(result.peaks.slice(510, 515)).toContain(1);
    expect(result.peaks.at(-1)).toBe(0.25);
    expect(result.peaks.filter((peak) => peak > 0).length).toBeLessThan(8);
    expect(result.peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true);
  });

  it('should reject empty or incomplete PCM instead of publishing a waveform', () => {
    expect(() => new AudioWaveformAccumulator().finish()).toThrow('no decoded samples');
    const waveform = new AudioWaveformAccumulator();
    waveform.add(Buffer.from([1]));
    expect(() => waveform.finish()).toThrow('Incomplete audio PCM sample');
  });

  it('should keep opposite-phase channel peaks and count sample frames instead of channels', () => {
    const waveform = new AudioWaveformAccumulator(2);
    const second = Buffer.alloc(AUDIO_WAVEFORM_SAMPLE_RATE * 4);
    for (let offset = 0; offset < second.length; offset += 4) {
      second.writeInt16LE(16_384, offset);
      second.writeInt16LE(-16_384, offset + 2);
    }
    waveform.add(second);

    expect(waveform.finish()).toEqual({
      version: 1,
      durationMs: 1000,
      peaks: Array.from({ length: AUDIO_WAVEFORM_PEAK_COUNT }, () => 0.5),
    });
  });
});
