import { Route } from '#lib/route.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { audioSummaryConfig } from '#test/medium/mock/audio-summary.ts';
import { Protocol, QueueCommand, QueueName } from '@immich/sdk';

test.beforeEach(({ data, api }) => {
  data.serverFeatures.audioSummary = true;
  data.adminConfig.machineLearning.audioSummary = audioSummaryConfig();
  data.adminConfig.machineLearning.enabled = true;
  api.on({
    getAdminConfigDefaults: () => ({ json: data.adminConfig }),
    updateAdminConfig: ({ body }) => {
      const summary = body.machineLearning.audioSummary;
      return {
        json: {
          ...body,
          machineLearning: {
            ...body.machineLearning,
            audioSummary: summary && {
              ...summary,
              apiKey: '',
              clearApiKey: false,
              apiKeyConfigured: !summary.clearApiKey,
            },
          },
        },
      };
    },
  });
});

test('saves provider, protocol and editable prompt template while preserving a saved key', async ({
  page,
  data,
  api,
}) => {
  await page.goto(Route.systemSettings());
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_settings admin.machine_learning_settings_description',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_audio_summary admin.machine_learning_audio_summary_description',
      exact: true,
    })
    .click();
  await expect(page.getByLabel('admin.audio_summary_api_key', { exact: true })).toHaveValue('');
  await expect(page.getByText('admin.audio_summary_api_key_configured', { exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'admin.audio_summary_enabled', exact: true }).click();
  await page.getByRole('switch', { name: 'admin.audio_summary_automatic', exact: true }).click();
  await page.getByLabel('admin.audio_summary_base_url', { exact: true }).fill('https://provider.example/v1');
  await page.getByLabel('admin.audio_summary_model', { exact: true }).fill('custom-model');
  await page
    .getByRole('combobox', { name: 'admin.audio_summary_protocol', exact: true })
    .selectOption(Protocol.Responses);
  await page.getByRole('combobox', { name: 'admin.audio_summary_prompt_preset', exact: true }).selectOption('meeting');
  await expect(page.getByLabel('admin.audio_summary_prompt', { exact: true })).toHaveValue(
    'admin.audio_summary_prompt_meeting_text',
  );
  await page
    .getByLabel('admin.audio_summary_prompt', { exact: true })
    .fill('Only summarize decisions present in the transcript.');
  await expect(page.getByRole('combobox', { name: 'admin.audio_summary_prompt_preset', exact: true })).toHaveValue(
    'custom',
  );
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expect(page.getByText('settings_saved', { exact: true })).toBeVisible();
  expect(api.updateAdminConfig).toHaveBeenCalledWith({
    body: expect.objectContaining({
      machineLearning: expect.objectContaining({
        audioSummary: {
          ...data.adminConfig.machineLearning.audioSummary,
          enabled: true,
          autoSummarize: false,
          baseUrl: 'https://provider.example/v1',
          modelName: 'custom-model',
          protocol: Protocol.Responses,
          prompt: 'Only summarize decisions present in the transcript.',
          apiKey: '',
          clearApiKey: false,
        },
      }),
    }),
  });
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_audio_summary admin.machine_learning_audio_summary_description',
      exact: true,
    })
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: test.info().outputPath('audio-summary-settings.png') });
});

test('clears typed keys after save and explicitly clears a saved key', async ({ page, api }) => {
  await page.goto(Route.systemSettings());
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_settings admin.machine_learning_settings_description',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_audio_summary admin.machine_learning_audio_summary_description',
      exact: true,
    })
    .click();
  const key = page.getByLabel('admin.audio_summary_api_key', { exact: true });
  await key.fill('replacement-test-key');
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expect(key).toHaveValue('');
  expect(api.updateAdminConfig).toHaveBeenCalledWith({
    body: expect.objectContaining({
      machineLearning: expect.objectContaining({
        audioSummary: expect.objectContaining({ apiKey: 'replacement-test-key', clearApiKey: false }),
      }),
    }),
  });
  await page.getByRole('button', { name: 'admin.audio_summary_api_key_clear', exact: true }).click();
  await expect(page.getByText('admin.audio_summary_api_key_clear_pending', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expect(page.getByText('admin.audio_summary_api_key_not_configured', { exact: true })).toBeVisible();
  expect(api.updateAdminConfig).toHaveBeenCalledWith({
    body: expect.objectContaining({
      machineLearning: expect.objectContaining({
        audioSummary: expect.objectContaining({ apiKey: '', clearApiKey: true }),
      }),
    }),
  });
});

test('does not show summary settings on an older server', async ({ page, data }) => {
  delete data.serverFeatures.audioSummary;
  delete data.adminConfig.machineLearning.audioSummary;
  await page.goto(Route.systemSettings());
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_settings admin.machine_learning_settings_description',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'admin.machine_learning_audio_summary admin.machine_learning_audio_summary_description',
      exact: true,
    }),
  ).toHaveCount(0);
});

test('starts the missing-summary queue and saves its concurrency', async ({ page, data, api }) => {
  data.userConfig.machineLearning.enabled = true;
  data.userConfig.machineLearning.audioSummary = { enabled: true, autoSummarize: true };
  data.adminConfig.job.audioSummary = { concurrency: 1 };
  const statistics = { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0 };
  api.on({
    getQueues: ({ request }) => {
      expect(request.headers()['x-immich-features']).toContain('audio-summary');
      return { json: [{ name: QueueName.AudioSummary, isPaused: false, statistics }] };
    },
    runQueueCommandLegacy: () => ({
      json: { jobCounts: statistics, queueStatus: { isActive: false, isPaused: false } },
    }),
  });
  await page.goto(Route.queues());
  const response = page.waitForResponse((response) => response.url().endsWith('/api/jobs/audioSummary'));
  await page.locator('[data-queue="audioSummary"]').getByRole('button', { name: 'missing', exact: true }).click();
  await response;
  expect(api.runQueueCommandLegacy).toHaveBeenCalledWith({
    params: { name: QueueName.AudioSummary },
    body: { command: QueueCommand.Start, force: false },
  });
  await page.goto(Route.systemSettings());
  await page.getByRole('button', { name: 'admin.job_settings admin.job_settings_description', exact: true }).click();
  await page.locator('[data-queue-settings="audioSummary"]').getByRole('spinbutton').fill('2');
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expect(page.getByText('settings_saved', { exact: true })).toBeVisible();
  expect(api.updateAdminConfig).toHaveBeenCalledWith({
    body: expect.objectContaining({ job: expect.objectContaining({ audioSummary: { concurrency: 2 } }) }),
  });
});
