import AudioViewer from '#lib/components/asset-viewer/AudioViewer.svelte';
import { getAssetPlaybackUrl } from '#lib/utils.ts';
import { factory } from '#test/unit/factories.ts';
import { renderWithTooltips } from '#test/unit/helpers.ts';
import { AssetTypeEnum } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';

describe('AudioViewer', () => {
  afterEach(() => vi.restoreAllMocks());

  const asset = factory.asset({ type: AssetTypeEnum.Audio, originalFileName: 'recording.mp3', duration: 125_000 });

  it('renders authenticated playback with controls and duration', () => {
    const { getByLabelText, getByText, container } = renderWithTooltips(AudioViewer, { asset });
    const audio = getByLabelText('audio');

    expect(audio.getAttribute('src')).toBe(getAssetPlaybackUrl({ id: asset.id, cacheKey: asset.thumbhash }));
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.hasAttribute('autoplay')).toBe(false);
    expect(getByText('2:05')).toBeTruthy();
    expect(getByText('recording.mp3')).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
  });

  it('handles unavailable or unsupported audio without breaking the viewer', async () => {
    const { getByLabelText, getByRole } = renderWithTooltips(AudioViewer, { asset });

    await fireEvent.error(getByLabelText('audio'));

    expect(getByRole('alert').textContent).toBe('audio_playback_failed');
    expect(getByLabelText('audio').hasAttribute('controls')).toBe(true);
  });

  it('exposes playback events for slideshow progression', async () => {
    const onStarted = vi.fn();
    const onEnded = vi.fn();
    const { getByLabelText, getByRole } = renderWithTooltips(AudioViewer, {
      asset,
      autoplay: true,
      onStarted,
      onEnded,
    });
    const audio = getByLabelText('audio');
    expect(audio.hasAttribute('autoplay')).toBe(true);

    await fireEvent.play(audio);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(getByRole('button', { name: 'pause' })).toBeTruthy();
    await fireEvent.pause(audio);
    expect(getByRole('button', { name: 'play' })).toBeTruthy();
    await fireEvent.ended(audio);
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('handles a rejected play request', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('Unsupported codec'));
    const { getByRole } = renderWithTooltips(AudioViewer, { asset });

    await fireEvent.click(getByRole('button', { name: 'play' }));

    await waitFor(() => expect(getByRole('alert').textContent).toBe('audio_playback_failed'));
  });

  it('reloads playback when retrying a previously unavailable stream', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const { getByLabelText, getByRole } = renderWithTooltips(AudioViewer, { asset });
    await fireEvent.error(getByLabelText('audio'));

    await fireEvent.click(getByRole('button', { name: 'play' }));

    expect(load).toHaveBeenCalledOnce();
  });

  it('releases playback on close', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const { getByLabelText, unmount } = renderWithTooltips(AudioViewer, { asset });
    const audio = getByLabelText('audio');

    unmount();

    expect(pause).toHaveBeenCalled();
    expect(load).toHaveBeenCalled();
    expect(audio.hasAttribute('src')).toBe(false);
  });
});
