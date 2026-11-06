import { Route } from '#lib/route.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { factory } from '#test/medium/mock/factories.ts';
import { silentAudio } from '#test/medium/mock/helpers.ts';
import {
  AssetJobName,
  AssetTypeEnum,
  AudioAnalysisStatus,
  SharedLinkType,
  SegmentType,
  type AudioTranscriptDto,
  type AudioWaveformDto,
} from '@immich/sdk';

const waveform: AudioWaveformDto = {
  version: 1,
  durationMs: 10_000,
  peaks: Array.from({ length: 1024 }, (_, index) => (index % 128) / 127),
};
const transcript: AudioTranscriptDto = {
  text: '你好，这是测试录音。第二段内容。',
  language: 'zh',
  modelName: 'SenseVoiceSmall',
  segmentType: SegmentType.Chunk,
  segments: [
    { startMs: 0, endMs: 5000, text: '你好，这是测试录音。' },
    { startMs: 5000, endMs: 10_000, text: '第二段内容。' },
  ],
};

test.describe('audio waveform and transcript', () => {
  test.beforeEach(({ data, api }) => {
    data.serverFeatures.audio = true;
    data.serverFeatures.audioWaveform = true;
    data.serverFeatures.speechToText = true;
    data.userConfig.machineLearning.enabled = true;
    data.userConfig.machineLearning.speechToText = { enabled: true, autoTranscribe: false };
    api.on({
      playAssetVideo: ({ request }) => {
        const body = silentAudio();
        const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = Number(range?.[1] ?? 0);
        const end = range?.[2] ? Number(range[2]) : body.length - 1;
        return {
          body: body.subarray(start, end + 1),
          contentType: 'audio/wav',
          status: range ? 206 : 200,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            ...(range && { 'Content-Range': `bytes ${start}-${end}/${body.length}` }),
          },
        };
      },
      getAssetAudioWaveform: () => ({ json: { status: AudioAnalysisStatus.Ready, waveform } }),
      getAssetAudioTranscript: () => ({ json: { status: AudioAnalysisStatus.Ready, transcript } }),
    });
  });

  test('seeks with waveform and transcript controls, shows progress and copies recognized text', async ({
    page,
    context,
    data,
    app,
  }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    data.addAsset(asset);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(Route.viewAsset({ id: asset.id }));

    const audio = app.viewer.content.locator('audio');
    const slider = app.viewer.content.getByRole('slider', { name: 'audio_seek' });
    await expect(slider).toBeEnabled();
    await expect.poll(() => audio.evaluate((element) => (element as HTMLAudioElement).duration)).toBe(10);
    await slider.press('Home');
    await slider.press('ArrowRight');
    await expect.poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
    await expect(page).toHaveURL(Route.viewAsset({ id: asset.id }));

    const section = app.viewer.content.getByRole('region', { name: 'audio_transcript' });
    await section.getByRole('button', { name: 'audio_seek 0:05', exact: true }).click();
    await expect.poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime)).toBe(5);
    await expect(slider).toHaveValue('5000');
    await expect(app.viewer.content.locator('clipPath rect')).toHaveAttribute('width', '64');
    await section.getByRole('button', { name: 'copy_to_clipboard' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(transcript.text);
    await page.screenshot({ path: test.info().outputPath('audio-analysis-player.png') });
    await context.clearPermissions();
  });

  for (const status of [AudioAnalysisStatus.Pending, AudioAnalysisStatus.Processing]) {
    test(`refreshes ${status} analysis without interrupting playback`, async ({ page, data, api, app }) => {
      const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
      data.addAsset(asset);
      let requests = 0;
      api.on({
        getAssetAudioTranscript: () => ({
          json: ++requests === 1 ? { status, transcript: null } : { status: AudioAnalysisStatus.Ready, transcript },
        }),
      });
      await page.goto(Route.viewAsset({ id: asset.id }));
      await expect(app.viewer.content.getByText(`audio_transcript_${status}`)).toBeVisible();
      await app.viewer.content.getByRole('button', { name: 'play', exact: true }).click();
      await expect(app.viewer.content.getByText(transcript.segments[0].text)).toBeVisible();
      await expect(app.viewer.content.getByRole('button', { name: 'pause', exact: true })).toBeVisible();
    });
  }

  test('keeps the last waveform and transcript when reprocessing fails', async ({ page, data, api, app }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    data.addAsset(asset);
    api.on({
      getAssetAudioWaveform: () => ({ json: { status: AudioAnalysisStatus.Failed, waveform } }),
      getAssetAudioTranscript: () => ({ json: { status: AudioAnalysisStatus.Failed, transcript } }),
    });
    await page.goto(Route.viewAsset({ id: asset.id }));

    await expect(app.viewer.content.getByRole('slider')).toBeVisible();
    await expect(app.viewer.content.getByText(transcript.segments[0].text)).toBeVisible();
    await expect(app.viewer.content.getByText('audio_transcript_failed')).toBeVisible();
    await expect(app.viewer.content.locator('audio')).toHaveAttribute('controls', '');
  });

  test('keeps native playback when waveform retrieval fails', async ({ page, data, api, app, logger }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    data.addAsset(asset);
    api.on({ getAssetAudioWaveform: () => ({ status: 500 }) });
    await page.goto(Route.viewAsset({ id: asset.id }));

    await expect(app.viewer.content.getByText('audio_waveform_unavailable')).toBeVisible();
    await expect(app.viewer.content.locator('audio')).toHaveAttribute('controls', '');
    await app.viewer.content.getByRole('button', { name: 'play', exact: true }).click();
    await expect(app.viewer.content.getByRole('button', { name: 'pause', exact: true })).toBeVisible();
    expect(logger.error).toHaveBeenCalledWith(/500/);
  });

  test('keeps existing transcripts readable when new processing is disabled', async ({ page, data, app }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    data.addAsset(asset);
    data.userConfig.machineLearning.enabled = false;
    data.userConfig.machineLearning.speechToText = { enabled: false, autoTranscribe: false };
    await page.goto(Route.viewAsset({ id: asset.id }));

    await expect(app.viewer.content.getByText(transcript.segments[0].text)).toBeVisible();
    await expect(app.viewer.content.getByRole('button', { name: 'copy_to_clipboard' })).toBeVisible();
  });

  test('allows manual processing of unprocessed audio', async ({ page, data, api, app }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    data.addAsset(asset);
    let queued = false;
    api.on({
      getAssetAudioTranscript: () => ({
        json: { status: queued ? AudioAnalysisStatus.Pending : AudioAnalysisStatus.Unprocessed, transcript: null },
      }),
      runAssetJobs: () => {
        queued = true;
        return { status: 204 };
      },
    });
    await page.goto(Route.viewAsset({ id: asset.id }));
    await app.viewer.content.getByRole('button', { name: 'transcribe_audio', exact: true }).click();

    await expect(app.viewer.content.getByText('audio_transcript_pending')).toBeVisible();
    expect(api.runAssetJobs).toHaveBeenCalledWith({
      body: { name: AssetJobName.TranscribeAudio, assetIds: [asset.id] },
    });
  });

  test('does not request unsupported analysis from an older server', async ({ page, data, api, app }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    data.addAsset(asset);
    delete data.serverFeatures.audioWaveform;
    delete data.serverFeatures.speechToText;
    delete data.userConfig.machineLearning.speechToText;
    await page.goto(Route.viewAsset({ id: asset.id }));

    await expect(app.viewer.content.locator('audio')).toBeVisible();
    await expect(app.viewer.content.getByRole('slider')).toHaveCount(0);
    await expect(app.viewer.content.getByRole('region', { name: 'audio_transcript' })).toHaveCount(0);
    expect(api.getAssetAudioWaveform).not.toHaveBeenCalled();
    expect(api.getAssetAudioTranscript).not.toHaveBeenCalled();
  });

  test('shares the waveform without exposing private transcripts', async ({ page, context, data, api, app }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Audio, duration: 10_000 });
    const link = factory.sharedLink({ type: SharedLinkType.Individual, assets: [asset] });
    data.addSharedLink(link);
    await context.clearCookies();
    await page.goto(Route.viewSharedLink({ key: link.key }));

    await expect(app.viewer.content.getByRole('slider')).toBeVisible();
    await expect(app.viewer.content.getByRole('region', { name: 'audio_transcript' })).toHaveCount(0);
    expect(api.getAssetAudioWaveform).toHaveBeenCalledWith({
      params: expect.objectContaining({ id: asset.id, key: link.key }),
    });
    expect(api.getAssetAudioTranscript).not.toHaveBeenCalled();
  });
});
