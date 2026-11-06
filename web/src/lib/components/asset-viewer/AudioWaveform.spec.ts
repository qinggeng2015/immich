import AudioWaveform from '#lib/components/asset-viewer/AudioWaveform.svelte';
import { fireEvent, render } from '@testing-library/svelte';

describe('AudioWaveform', () => {
  it('shows playback progress and exposes an accessible seek control', async () => {
    const onSeek = vi.fn();
    const { container, getByRole } = render(AudioWaveform, {
      peaks: [0.1, 0.6, 1, 0.2],
      durationMs: 10_000,
      currentTimeMs: 2500,
      onSeek,
    });

    const slider = getByRole('slider', { name: 'audio_seek' });
    expect(slider.getAttribute('aria-valuetext')).toBe('0:02 / 0:10');
    expect(container.querySelector(':scope clipPath rect')?.getAttribute('width')).toBe('1');

    await fireEvent.input(slider, { target: { value: '5000' } });

    expect(onSeek).toHaveBeenCalledWith(5000);
  });

  it('disables seeking until duration is known', () => {
    const { getByRole, container } = render(AudioWaveform, {
      peaks: [0.1],
      durationMs: NaN,
      currentTimeMs: Infinity,
      onSeek: vi.fn(),
    });

    expect((getByRole('slider') as HTMLInputElement).disabled).toBe(true);
    expect(container.querySelector(':scope clipPath rect')?.getAttribute('width')).toBe('0');
  });
});
