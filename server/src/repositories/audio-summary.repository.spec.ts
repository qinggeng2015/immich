import { AudioSummaryClientConfig, AudioSummaryRepository } from 'src/repositories/audio-summary.repository.js';
import { AUDIO_SUMMARY_LIMITS, AudioSummaryError } from 'src/utils/audio-summary-text.js';

const config: AudioSummaryClientConfig = {
  baseUrl: 'https://summary.example/v1',
  apiKey: 'test-summary-key',
  modelName: 'summary-model',
  prompt: '请用中文总结。',
  maxOutputTokens: 2048,
  timeoutMs: 120_000,
};
const transcript = '会议结论：周五完成发布。';
const chatResponse = (content = '周五完成发布。', finishReason = 'stop') =>
  Response.json({ choices: [{ finish_reason: finishReason, message: { content } }] });

describe('AudioSummaryRepository', () => {
  const sut = new AudioSummaryRepository();
  const fetchMock = vitest.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vitest.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
    vitest.useRealTimers();
  });

  it.each([
    ['https://summary.example', 'https://summary.example/v1/chat/completions'],
    ['https://summary.example/', 'https://summary.example/v1/chat/completions'],
    ['https://summary.example/v1/', 'https://summary.example/v1/chat/completions'],
    ['http://127.0.0.1:4000/proxy/v1', 'http://127.0.0.1:4000/proxy/v1/chat/completions'],
  ])('joins the API path for %s and sends bounded text-only requests', async (baseUrl, endpoint) => {
    fetchMock.mockResolvedValue(chatResponse());

    await expect(sut.summarize({ transcript, config: { ...config, baseUrl } })).resolves.toEqual({
      text: '周五完成发布。',
      requestCount: 1,
      chunkCount: 1,
    });

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toEqual(new URL(endpoint));
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    });
    const body = JSON.parse(request?.body as string);
    expect(body).toMatchObject({ model: 'summary-model', max_completion_tokens: 2048, stream: false, store: false });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(JSON.parse(body.messages[1].content).parts[0].text).toBe(transcript);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('supports the explicitly selected Responses protocol', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          { type: 'reasoning', summary: [] },
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '中文总结。' }],
          },
        ],
      }),
    );

    await expect(sut.summarize({ transcript, config: { ...config, protocol: 'responses' } })).resolves.toMatchObject({
      text: '中文总结。',
    });

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toEqual(new URL('https://summary.example/v1/responses'));
    const body = JSON.parse(request?.body as string);
    expect(body).toMatchObject({ model: 'summary-model', max_output_tokens: 2048, stream: false, store: false });
    expect(body.input[0].content[0].type).toBe('input_text');
    expect(JSON.parse(body.input[0].content[0].text).parts[0].text).toBe(transcript);
    expect(body.instructions).toContain(config.prompt);
  });

  it.each([
    'file:///tmp/model',
    'ftp://summary.example',
    'not a URL',
    'https://key@summary.example/v1',
    'https://summary.example/v1?api_key=private',
    'https://summary.example/v1#private',
  ])('rejects unsafe or ambiguous endpoint %s before sending credentials', async (baseUrl) => {
    await expect(sut.summarize({ transcript, config: { ...config, baseUrl } })).rejects.toEqual(
      new AudioSummaryError('invalid_config'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: '' },
    { prompt: '' },
    { modelName: '' },
    { maxOutputTokens: 8193 },
    { maxOutputTokens: 127 },
    { timeoutMs: 999 },
    { timeoutMs: 600_001 },
  ])('rejects invalid limits and missing configuration', async (patch) => {
    await expect(sut.summarize({ transcript, config: { ...config, ...patch } })).rejects.toEqual(
      new AudioSummaryError('invalid_config'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([301, 401, 429, 500])('sanitizes HTTP %s without retrying or retaining the provider body', async (status) => {
    fetchMock.mockResolvedValue(new Response(`private body ${config.apiKey} ${transcript}`, { status }));

    await expect(sut.summarize({ transcript, config })).rejects.toEqual(new AudioSummaryError('request_failed'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes network failures and discards their cause', async () => {
    fetchMock.mockRejectedValue(new Error(`private endpoint?key=${config.apiKey}`, { cause: transcript }));
    await expect(sut.summarize({ transcript, config })).rejects.toEqual(new AudioSummaryError('request_failed'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { response: () => chatResponse('unfinished', 'length'), code: 'truncated_output' },
    { response: () => chatResponse(' \n '), code: 'empty_output' },
    { response: () => new Response('private invalid JSON'), code: 'invalid_response' },
    { response: () => Response.json({ choices: [] }), code: 'invalid_response' },
    { response: () => chatResponse('blocked', 'content_filter'), code: 'invalid_response' },
    {
      response: () =>
        Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'text', refusal: 'refused' } }] }),
      code: 'invalid_response',
    },
    {
      response: () =>
        Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'text', tool_calls: [{}] } }] }),
      code: 'invalid_response',
    },
  ])('rejects unusable Chat Completions output with $code', async ({ response, code }) => {
    fetchMock.mockResolvedValue(response());
    await expect(sut.summarize({ transcript, config })).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
    { status: 'completed', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
  ])('rejects truncated Responses output', async (response) => {
    fetchMock.mockResolvedValue(Response.json(response));
    await expect(sut.summarize({ transcript, config: { ...config, protocol: 'responses' } })).rejects.toEqual(
      new AudioSummaryError('truncated_output'),
    );
  });

  it('stops reading an oversized streaming response and cancels the body', async () => {
    const cancel = vitest.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(300_000));
        controller.enqueue(new Uint8Array(300_000));
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body));

    await expect(sut.summarize({ transcript, config })).rejects.toEqual(new AudioSummaryError('response_limit'));

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized declared response before parsing', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { headers: { 'Content-Length': '1000000' } }));
    await expect(sut.summarize({ transcript, config })).rejects.toEqual(new AudioSummaryError('response_limit'));
  });

  it('does not make a request after external cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private reason'));
    await expect(sut.summarize({ transcript, config, signal: controller.signal })).rejects.toEqual(
      new AudioSummaryError('cancelled'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates cancellation to the active fetch and sanitizes the reason', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        }),
    );
    const result = sut.summarize({ transcript, config, signal: controller.signal });
    const assertion = expect(result).rejects.toEqual(new AudioSummaryError('cancelled'));
    controller.abort(new Error(`private ${transcript}`));
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts timed-out calls and clears all task timers', async () => {
    vitest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        }),
    );
    const result = sut.summarize({ transcript, config: { ...config, timeoutMs: 1000 } });
    const assertion = expect(result).rejects.toEqual(new AudioSummaryError('request_timeout'));

    await vitest.advanceTimersByTimeAsync(1001);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vitest.getTimerCount()).toBe(0);
  });

  it('enforces a total task deadline across successful calls', async () => {
    vitest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, request) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(chatResponse('分段总结')), 500_000);
          request?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(request.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const result = sut.summarize({ transcript: '字'.repeat(32_001), config: { ...config, timeoutMs: 600_000 } });
    const assertion = expect(result).rejects.toEqual(new AudioSummaryError('processing_timeout'));

    await vitest.advanceTimersByTimeAsync(AUDIO_SUMMARY_LIMITS.totalDurationMs + 1);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vitest.getTimerCount()).toBe(0);
  });
});
