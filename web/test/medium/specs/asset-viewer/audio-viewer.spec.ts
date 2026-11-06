import { Route } from '#lib/route.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { factory } from '#test/medium/mock/factories.ts';
import { silentAudio } from '#test/medium/mock/helpers.ts';
import { AssetTypeEnum } from '@immich/sdk';

test.describe('audio viewer', () => {
  test('opens an audio cover, plays audio and releases it when closed', async ({ page, data, api, app }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000, originalFileName: 'recording.wav' });
    data.serverFeatures.audio = true;
    data.addAsset(asset);
    api.on({ playAssetVideo: () => ({ body: silentAudio(), contentType: 'audio/wav' }) });

    await page.goto(Route.photos());
    const thumbnail = app.timeline.thumbnail(asset);
    await expect(thumbnail.locator('[data-audio-thumbnail]')).toBeVisible();
    await expect(thumbnail.getByText('0:10')).toBeVisible();
    await expect(thumbnail.locator('img, video, audio')).toHaveCount(0);
    await thumbnail.click();

    const audio = app.viewer.content.locator('audio');
    await expect(audio).toBeVisible();
    await app.viewer.content.getByRole('button', { name: 'play', exact: true }).click();
    await expect.poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
    await expect(app.viewer.content.getByRole('button', { name: 'pause', exact: true })).toBeVisible();
    await expect(app.viewer.root.getByRole('button', { name: 'editor', exact: true })).toHaveCount(0);

    const player = await audio.elementHandle();
    await app.viewer.backButton.click();

    await expect(app.viewer.root).not.toBeVisible();
    expect(
      await player!.evaluate((element) => (element as HTMLAudioElement).paused && !element.hasAttribute('src')),
    ).toBe(true);
    expect(api.playAssetVideo).toHaveBeenCalledWith({ params: expect.objectContaining({ id: asset.id }) });
    expect(api.getAssetOcr).not.toHaveBeenCalled();
    expect(api.getFaces).not.toHaveBeenCalled();
  });

  test('uses the displayed media type when previewing a mixed image and audio stack', async ({
    page,
    data,
    api,
    app,
  }) => {
    const primary = factory.asset();
    const recording = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    data.addStack(factory.stack({ assets: [primary, recording] }));
    api.on({ playAssetVideo: () => ({ body: silentAudio(), contentType: 'audio/wav' }) });
    await page.goto(Route.viewAsset({ id: primary.id }));
    await app.viewer.waitForAsset(primary);

    await app.viewer.stackThumbnail(recording).hover();
    await expect(app.viewer.content.locator('audio')).toHaveAttribute('src', new RegExp(recording.id));
    await expect(app.viewer.content.locator('video')).toHaveCount(0);

    await app.viewer.stackThumbnail(primary).hover();
    await app.viewer.waitForAsset(primary);
    await expect(app.viewer.content.locator('audio')).toHaveCount(0);

    await app.viewer.stackThumbnail(recording).click();
    await app.viewer.content.hover({ position: { x: 200, y: 200 } });
    await expect(app.viewer.content.locator('audio')).toHaveAttribute('src', new RegExp(recording.id));

    await app.viewer.stackThumbnail(primary).hover();
    await app.viewer.waitForAsset(primary);
    await app.viewer.content.hover({ position: { x: 200, y: 200 } });
    await expect(app.viewer.content.locator('audio')).toHaveAttribute('src', new RegExp(recording.id));
  });

  test('keeps audio controls keyboard navigation within the current recording', async ({ page, data, api, app }) => {
    const asset = factory.asset({
      type: AssetTypeEnum.Audio,
      duration: 10_000,
      localDateTime: '2025-03-01T00:00:00.000Z',
      fileCreatedAt: '2025-03-01T00:00:00.000Z',
    });
    data.addAsset(asset).addAsset(
      factory.asset({
        localDateTime: '2025-02-01T00:00:00.000Z',
        fileCreatedAt: '2025-02-01T00:00:00.000Z',
      }),
    );
    api.on({ playAssetVideo: () => ({ body: silentAudio(), contentType: 'audio/wav' }) });
    await page.goto(Route.viewAsset({ id: asset.id }));
    const audio = app.viewer.content.locator('audio');
    await expect(audio).toBeVisible();
    await expect(app.viewer.nextButton).toBeVisible();

    await audio.press('ArrowRight');

    await expect(audio).toHaveAttribute('src', new RegExp(asset.id));
    await expect(page).toHaveURL(Route.viewAsset({ id: asset.id }));
  });

  test('keeps controls available when playback is not ready', async ({ page, data, api, app, logger }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, originalFileName: 'recording.mp3' });
    data.addAsset(asset);
    api.on({ playAssetVideo: () => ({ status: 404 }) });

    await page.goto(Route.viewAsset({ id: asset.id }));

    await expect(app.viewer.content.getByRole('alert')).toHaveText('audio_playback_failed');
    await expect(app.viewer.content.locator('audio')).toHaveAttribute('controls', '');
    await expect(app.viewer.backButton).toBeVisible();
    expect(logger.error).toHaveBeenCalledWith(/404/);
  });
});
