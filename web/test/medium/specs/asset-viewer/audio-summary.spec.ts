import { Route } from '#lib/route.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { factory } from '#test/medium/mock/factories.ts';
import { silentAudio } from '#test/medium/mock/helpers.ts';
import { AssetJobName, AssetTypeEnum, AudioAnalysisStatus, SegmentType, SharedLinkType } from '@immich/sdk';

const summary = {
  text: '会议决定下周完成原型，并检查播放体验。',
  modelName: 'summary-model',
  updatedAt: '2026-11-06T10:00:00Z',
};
const transcript = {
  text: '我们下周完成原型，随后检查播放体验。',
  language: 'zh',
  modelName: 'SenseVoiceSmall',
  segmentType: SegmentType.Chunk,
  segments: [],
};

test.beforeEach(({ data, api }) => {
  data.serverFeatures.audio = true;
  data.serverFeatures.speechToText = true;
  data.serverFeatures.audioSummary = true;
  data.userConfig.machineLearning.enabled = true;
  data.userConfig.machineLearning.audioSummary = { enabled: true, autoSummarize: false };
  api.on({
    playAssetVideo: () => ({ body: silentAudio(), contentType: 'audio/wav' }),
    getAssetAudioTranscript: () => ({ json: { status: AudioAnalysisStatus.Ready, transcript } }),
    getAssetAudioSummary: () => ({ json: { status: AudioAnalysisStatus.Ready, summary } }),
  });
});

test('copies a summary and regenerates it while retaining the previous result', async ({
  page,
  context,
  data,
  api,
  app,
}) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio, originalFileName: 'meeting.m4a', duration: 10_000 });
  data.addAsset(asset);
  let queued = false;
  let pendingRequests = 0;
  api.on({
    getAssetAudioSummary: ({ request }) => {
      expect(request.headers()['x-immich-features']).toContain('audio-summary');
      return {
        json: {
          status: queued && ++pendingRequests === 1 ? AudioAnalysisStatus.Processing : AudioAnalysisStatus.Ready,
          summary,
        },
      };
    },
    runAssetJobs: () => {
      queued = true;
      return { status: 204 };
    },
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(Route.viewAsset({ id: asset.id }));
  const section = app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true });
  await expect(section.getByText(summary.text)).toBeVisible();
  await section.getByRole('button', { name: 'copy_to_clipboard' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(summary.text);
  await section.getByRole('button', { name: 'regenerate_audio_summary' }).click();
  await expect(section.getByText('audio_summary_processing')).toBeVisible();
  await expect(section.getByText(summary.text)).toBeVisible();
  await expect(section.getByRole('button', { name: 'regenerate_audio_summary' })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'regenerate_audio_summary' })).toBeEnabled();
  expect(api.runAssetJobs).toHaveBeenCalledWith({ body: { name: AssetJobName.SummarizeAudio, assetIds: [asset.id] } });
  await page.screenshot({ path: test.info().outputPath('audio-summary-player.png') });
  await context.clearPermissions();
});

test('follows automatic summary creation after transcription and an enqueue delay', async ({
  page,
  data,
  api,
  app,
}) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio });
  data.addAsset(asset);
  data.userConfig.machineLearning.audioSummary = { enabled: true, autoSummarize: true };
  let transcriptRequests = 0;
  let readySummaryRequests = 0;
  api.on({
    getAssetAudioTranscript: () => ({
      json:
        ++transcriptRequests === 1
          ? { status: AudioAnalysisStatus.Processing, transcript: null }
          : { status: AudioAnalysisStatus.Ready, transcript },
    }),
    getAssetAudioSummary: () => ({
      json:
        transcriptRequests > 1 && ++readySummaryRequests > 1
          ? { status: AudioAnalysisStatus.Ready, summary }
          : { status: AudioAnalysisStatus.Unprocessed, summary: null },
    }),
  });
  await page.goto(Route.viewAsset({ id: asset.id }));
  await expect(app.viewer.content.getByText('audio_transcript_processing')).toBeVisible();
  await expect(
    app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true }).getByText(summary.text),
  ).toBeVisible();
});

test('keeps summaries readable when global machine learning is disabled', async ({ page, data, app }) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio });
  data.addAsset(asset);
  data.userConfig.machineLearning.enabled = false;
  await page.goto(Route.viewAsset({ id: asset.id }));
  const section = app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true });
  await expect(section.getByText(summary.text)).toBeVisible();
  await expect(section.getByRole('button', { name: 'copy_to_clipboard' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'regenerate_audio_summary' })).toHaveCount(0);
});

test('retains the last successful summary when regeneration fails', async ({ page, data, api, app }) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio });
  data.addAsset(asset);
  api.on({ getAssetAudioSummary: () => ({ json: { status: AudioAnalysisStatus.Failed, summary } }) });
  await page.goto(Route.viewAsset({ id: asset.id }));
  const section = app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true });
  await expect(section.getByText(summary.text)).toBeVisible();
  await expect(section.getByText('audio_summary_failed')).toBeVisible();
});

test('requires nonempty transcript text before generating a summary', async ({ page, data, api, app }) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio });
  data.addAsset(asset);
  api.on({
    getAssetAudioTranscript: () => ({
      json: { status: AudioAnalysisStatus.Ready, transcript: { ...transcript, text: '' } },
    }),
    getAssetAudioSummary: () => ({ json: { status: AudioAnalysisStatus.Unprocessed, summary: null } }),
  });
  await page.goto(Route.viewAsset({ id: asset.id }));
  const section = app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true });
  await expect(section.getByText('audio_summary_requires_transcript')).toBeVisible();
  await expect(section.getByRole('button', { name: 'generate_audio_summary' })).toHaveCount(0);
});

test('renders model output as text without executing markup', async ({ page, data, api, app }) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio });
  data.addAsset(asset);
  const text = '<img src=x onerror="alert(1)">';
  api.on({
    getAssetAudioSummary: () => ({ json: { status: AudioAnalysisStatus.Ready, summary: { ...summary, text } } }),
  });
  await page.goto(Route.viewAsset({ id: asset.id }));
  const section = app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true });
  await expect(section.getByText(text)).toBeVisible();
  await expect(section.locator('img')).toHaveCount(0);
});

test('does not request summaries from unsupported servers', async ({ page, data, api, app }) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio });
  data.addAsset(asset);
  delete data.serverFeatures.audioSummary;
  delete data.userConfig.machineLearning.audioSummary;
  await page.goto(Route.viewAsset({ id: asset.id }));
  await expect(app.viewer.content.locator('audio')).toBeVisible();
  await expect(app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true })).toHaveCount(0);
  expect(api.getAssetAudioSummary).not.toHaveBeenCalled();
});

test('does not expose summary requests or content through shared links', async ({ page, context, data, api, app }) => {
  const asset = factory.asset({ type: AssetTypeEnum.Audio });
  const link = factory.sharedLink({ type: SharedLinkType.Individual, assets: [asset] });
  data.addSharedLink(link);
  await context.clearCookies();
  await page.goto(Route.viewSharedLink({ key: link.key }));
  await expect(app.viewer.content.locator('audio')).toBeVisible();
  await expect(app.viewer.content.getByRole('region', { name: 'audio_summary', exact: true })).toHaveCount(0);
  expect(api.getAssetAudioSummary).not.toHaveBeenCalled();
});
