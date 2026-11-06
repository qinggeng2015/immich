import { defaults, mapAdminConfig, mapPublicConfig, mapUserConfig } from 'src/dtos/config.dto.js';
import { Permission, QueueName } from 'src/enum.js';
import { AuthService } from 'src/services/auth.service.js';
import { QueueService } from 'src/services/queue.service.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { factory } from 'test/small.factory.js';
import { newTestService } from 'test/utils.js';

describe('audio summary client compatibility', () => {
  it.each([
    { features: undefined, expected: [] },
    { features: 'audio,audio-analysis', expected: [QueueName.AudioWaveform, QueueName.SpeechToText] },
    {
      features: 'audio,audio-analysis,audio-summary',
      expected: [QueueName.AudioWaveform, QueueName.SpeechToText, QueueName.AudioSummary],
    },
    {
      features: 'audio,audio-analysis,audio-summary-preview',
      expected: [QueueName.AudioWaveform, QueueName.SpeechToText],
    },
  ])('exposes only understood queue names for $features', async ({ features, expected }) => {
    const authentication = newTestService(AuthService);
    const queues = newTestService(QueueService);
    const session = SessionFactory.create();
    authentication.mocks.session.getByToken.mockResolvedValue({
      id: session.id,
      updatedAt: session.updatedAt,
      user: UserFactory.create({ isAdmin: true }),
      pinExpiresAt: null,
      appVersion: null,
    });
    queues.mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());
    queues.mocks.job.isPaused.mockResolvedValue(false);
    const auth = await authentication.sut.authenticate({
      headers: {
        authorization: 'Bearer compatibility-test-token',
        ...(features && { 'x-immich-features': features }),
      },
      queryParams: {},
      metadata: { adminRoute: true, sharedLinkRoute: false, uri: '/queues', permission: Permission.QueueRead },
    });
    const audioQueues = new Set([QueueName.AudioWaveform, QueueName.SpeechToText, QueueName.AudioSummary]);

    const response = await queues.sut.getAll(auth);
    expect(response.map(({ name }) => name).filter((name) => audioQueues.has(name))).toEqual(expected);
    const legacy = await queues.sut.getAllLegacy(auth);
    for (const name of audioQueues) {
      expect(legacy).not.toHaveProperty(name);
    }
  });

  it('redacts admin keys and exposes only feature switches to users', () => {
    const config = structuredClone(defaults);
    config.machineLearning.audioSummary = {
      ...config.machineLearning.audioSummary!,
      enabled: true,
      apiKey: 'compatibility-test-secret',
      baseUrl: 'http://summary.internal/v1',
      modelName: 'private-model',
      prompt: 'Private instructions',
    };

    const admin = mapAdminConfig(config);
    const user = mapUserConfig(config);
    const publicConfig = mapPublicConfig(config);

    expect(admin.machineLearning.audioSummary).toMatchObject({
      apiKey: '',
      apiKeyConfigured: true,
      clearApiKey: false,
    });
    expect(user.machineLearning?.audioSummary).toEqual({ enabled: true, autoSummarize: true });
    expect(publicConfig).not.toHaveProperty('machineLearning');
    expect(JSON.stringify([admin, user, publicConfig])).not.toContain('compatibility-test-secret');
    expect(config.machineLearning.audioSummary.apiKey).toBe('compatibility-test-secret');
  });
});
