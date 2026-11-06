import { Route } from '#lib/route.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AssetTypeEnum } from '@immich/sdk';

test.describe('audio search', () => {
  test.beforeEach(({ api }) => {
    api.on({ getSearchSuggestions: () => ({ json: [] }) });
  });

  test('searches existing transcripts even when new transcription is disabled', async ({ page, data, api }) => {
    data.serverFeatures.audio = true;
    data.serverFeatures.speechToText = true;
    data.userConfig.machineLearning.enabled = false;
    data.userConfig.machineLearning.speechToText = { enabled: false, autoTranscribe: false };
    await page.goto(Route.search({ type: AssetTypeEnum.Audio, transcript: 'spoken words' }));

    const input = page.getByRole('combobox', { name: 'search_your_photos', exact: true });
    await expect(input).toHaveValue('spoken words');
    await input.click();
    await expect(input).toHaveAttribute('placeholder', 'search_by_transcript_example');
    expect(api.searchAssets).toHaveBeenCalledWith({
      body: { page: 1, withExif: true, visibility: 'timeline', type: AssetTypeEnum.Audio, transcript: 'spoken words' },
    });
    expect(api.searchSmart).not.toHaveBeenCalled();
  });

  test('falls back to filenames for transcript links on older servers', async ({ page, data, api }) => {
    delete data.serverFeatures.speechToText;
    await page.goto(Route.search({ transcript: 'spoken words' }));

    const input = page.getByRole('combobox', { name: 'search_your_photos', exact: true });
    await expect(input).toHaveValue('spoken words');
    await input.click();
    await expect(input).toHaveAttribute('placeholder', 'search_by_filename_example');
    await expect(page.getByRole('button', { name: 'audio_transcript', exact: true })).toHaveCount(0);
    expect(api.searchAssets).toHaveBeenCalledWith({
      body: { page: 1, withExif: true, visibility: 'timeline', originalFileName: 'spoken words' },
    });
  });

  for (const field of ['query', 'ocr'] as const) {
    test(`restores audio ${field} links as filename searches`, async ({ page, data, api }) => {
      data.serverFeatures.audio = true;
      data.userConfig.machineLearning.clip.enabled = true;
      data.userConfig.machineLearning.ocr.enabled = true;

      await page.goto(Route.search({ type: AssetTypeEnum.Audio, [field]: 'recording' }));

      const input = page.getByRole('combobox', { name: 'search_your_photos', exact: true });
      await expect(input).toHaveValue('recording');
      await input.click();
      await expect(input).toHaveAttribute('placeholder', 'search_by_filename_example');
      await expect(page.getByRole('button', { name: 'context', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'ocr', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'description', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'full_path_or_folder', exact: true })).toBeVisible();
      expect(api.searchAssets).toHaveBeenCalledWith({
        body: {
          page: 1,
          withExif: true,
          visibility: 'timeline',
          type: AssetTypeEnum.Audio,
          originalFileName: 'recording',
        },
      });
      expect(api.searchSmart).not.toHaveBeenCalled();
    });
  }

  test('searches filenames after restoring an audio-only filter and keeps the saved preference', async ({
    page,
    data,
    api,
  }) => {
    data.serverFeatures.audio = true;
    await page.goto(Route.photos());
    await page.evaluate(() => localStorage.setItem('searchQueryType', 'smart'));
    await page.goto(Route.search({ type: AssetTypeEnum.Audio }));

    const input = page.getByRole('combobox', { name: 'search_your_photos', exact: true });
    await input.fill('recording');
    await expect(input).toHaveAttribute('placeholder', 'search_by_filename_example');
    await input.press('Enter');

    await expect(page).toHaveURL(Route.search({ originalFileName: 'recording', type: AssetTypeEnum.Audio }));
    expect(api.searchAssets).toHaveBeenCalledWith({
      body: {
        page: 1,
        withExif: true,
        visibility: 'timeline',
        type: AssetTypeEnum.Audio,
        originalFileName: 'recording',
      },
    });
    expect(api.searchSmart).not.toHaveBeenCalled();
    expect(await page.evaluate(() => localStorage.getItem('searchQueryType'))).toBe('smart');
  });

  test('omits audio from restored queries on an older server', async ({ page, data, api }) => {
    delete data.serverFeatures.audio;
    await page.goto(Route.search({ type: AssetTypeEnum.Audio, query: 'recording' }));

    await expect(page.getByRole('combobox', { name: 'search_your_photos', exact: true })).toHaveValue('recording');
    expect(api.searchAssets).toHaveBeenCalledWith({
      body: { page: 1, withExif: true, visibility: 'timeline', originalFileName: 'recording' },
    });
    expect(api.searchSmart).not.toHaveBeenCalled();
  });
});
