import { Protocol, type AdminConfigAudioSummaryDto } from '@immich/sdk';

export const audioSummaryConfig = (
  overrides: Partial<AdminConfigAudioSummaryDto> = {},
): AdminConfigAudioSummaryDto => ({
  enabled: false,
  autoSummarize: true,
  baseUrl: 'https://summary.example/v1',
  modelName: 'summary-model',
  apiKey: '',
  apiKeyConfigured: true,
  clearApiKey: false,
  protocol: Protocol.ChatCompletions,
  prompt: 'Summarize the transcript without adding facts.',
  maxOutputTokens: 2048,
  timeoutMs: 120_000,
  ...overrides,
});
