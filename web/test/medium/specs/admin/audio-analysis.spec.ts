import { Route } from '#lib/route.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { Language, QueueCommand, QueueName, type QueueResponseDto } from '@immich/sdk';

const statistics = { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0 };

test('starts audio analysis queues with the existing queue controls', async ({ page, data, api }) => {
  data.serverFeatures.audioWaveform = true;
  data.serverFeatures.speechToText = true;
  data.userConfig.machineLearning.enabled = true;
  data.userConfig.machineLearning.speechToText = { enabled: true, autoTranscribe: true };
  const queues: QueueResponseDto[] = [QueueName.AudioWaveform, QueueName.SpeechToText].map((name) => ({
    name,
    isPaused: false,
    statistics,
  }));
  api.on({
    getQueues: () => ({ json: queues }),
    runQueueCommandLegacy: () => ({
      json: { jobCounts: statistics, queueStatus: { isActive: false, isPaused: false } },
    }),
  });
  await page.goto(Route.queues());

  for (const name of [QueueName.AudioWaveform, QueueName.SpeechToText]) {
    const response = page.waitForResponse((response) => response.url().endsWith(`/api/jobs/${name}`));
    await page.locator(`[data-queue="${name}"]`).getByRole('button', { name: 'missing', exact: true }).click();
    await response;
    expect(api.runQueueCommandLegacy).toHaveBeenCalledWith({
      params: { name },
      body: { command: QueueCommand.Start, force: false },
    });
  }
});

test('saves transcription language and automatic processing settings', async ({ page, data, api }) => {
  data.serverFeatures.speechToText = true;
  data.adminConfig.machineLearning.enabled = true;
  data.adminConfig.machineLearning.speechToText = {
    enabled: true,
    autoTranscribe: true,
    modelName: 'SenseVoiceSmall',
    language: Language.Auto,
  };
  api.on({
    getAdminConfigDefaults: () => ({ json: data.adminConfig }),
    updateAdminConfig: ({ body }) => ({ json: body }),
  });
  await page.goto(Route.systemSettings());
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_settings admin.machine_learning_settings_description',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: 'admin.machine_learning_audio_transcription admin.machine_learning_audio_transcription_description',
      exact: true,
    })
    .click();

  await page
    .getByRole('combobox', { name: 'admin.machine_learning_audio_transcription_language', exact: true })
    .selectOption('zh');
  await page.getByRole('switch', { name: 'admin.machine_learning_audio_transcription_automatic', exact: true }).click();
  await page.getByRole('button', { name: 'save', exact: true }).click();

  await expect(page.getByText('settings_saved', { exact: true })).toBeVisible();
  expect(api.updateAdminConfig).toHaveBeenCalledWith({
    body: expect.objectContaining({
      machineLearning: expect.objectContaining({
        speechToText: { enabled: true, autoTranscribe: false, modelName: 'SenseVoiceSmall', language: 'zh' },
      }),
    }),
  });
});
