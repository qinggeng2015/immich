export const AUDIO_WAVEFORM_SAMPLE_RATE = 48_000;
export const AUDIO_WAVEFORM_PEAK_COUNT = 1024;
const retainedPeakCount = AUDIO_WAVEFORM_PEAK_COUNT * 8;

export type AudioWaveform = {
  version: 1;
  durationMs: number;
  peaks: number[];
};

export class AudioWaveformAccumulator {
  private peaks = new Uint16Array(retainedPeakCount);
  private samplesPerPeak = 1;
  private sampleCount = 0;
  private pendingByte: number | undefined;
  private pendingChannel = 0;
  private framePeak = 0;

  constructor(private channelCount = 1) {
    if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > 64) {
      throw new Error('Audio stream has invalid channel count');
    }
  }

  add(data: Buffer) {
    let offset = 0;
    if (this.pendingByte !== undefined && data.length > 0) {
      const value = this.pendingByte | (data[0] << 8);
      this.addSample(value >= 32_768 ? value - 65_536 : value);
      this.pendingByte = undefined;
      offset = 1;
    }

    for (; offset + 1 < data.length; offset += 2) {
      this.addSample(data.readInt16LE(offset));
    }

    if (offset < data.length) {
      this.pendingByte = data[offset];
    }
  }

  finish(): AudioWaveform {
    if (this.pendingByte !== undefined || this.pendingChannel > 0) {
      throw new Error('Incomplete audio PCM sample');
    }
    if (this.sampleCount === 0) {
      throw new Error('Audio contains no decoded samples');
    }

    const peaks = Array.from({ length: AUDIO_WAVEFORM_PEAK_COUNT }, () => 0);
    const count = Math.ceil(this.sampleCount / this.samplesPerPeak);
    for (let index = 0; index < count; index++) {
      const start = Math.floor((index * this.samplesPerPeak * peaks.length) / this.sampleCount);
      const end = Math.min(
        peaks.length,
        Math.ceil((((index + 1) * this.samplesPerPeak) / this.sampleCount) * peaks.length),
      );
      const peak = Math.round((this.peaks[index] / 32_768) * 1_000_000) / 1_000_000;
      for (let output = start; output < end; output++) {
        peaks[output] = Math.max(peaks[output], peak);
      }
    }

    return {
      version: 1,
      durationMs: Math.max(1, Math.round((this.sampleCount / AUDIO_WAVEFORM_SAMPLE_RATE) * 1000)),
      peaks,
    };
  }

  private addSample(sample: number) {
    this.framePeak = Math.max(this.framePeak, Math.abs(sample));
    this.pendingChannel++;
    if (this.pendingChannel < this.channelCount) {
      return;
    }

    if (this.sampleCount === this.peaks.length * this.samplesPerPeak) {
      const half = this.peaks.length / 2;
      for (let index = 0; index < half; index++) {
        this.peaks[index] = Math.max(this.peaks[index * 2], this.peaks[index * 2 + 1]);
      }
      this.peaks.fill(0, half);
      this.samplesPerPeak *= 2;
    }

    const index = Math.floor(this.sampleCount / this.samplesPerPeak);
    this.peaks[index] = Math.max(this.peaks[index], this.framePeak);
    this.sampleCount++;
    this.pendingChannel = 0;
    this.framePeak = 0;
  }
}
