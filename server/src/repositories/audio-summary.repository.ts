import { Injectable } from '@nestjs/common';
import z from 'zod';
import {
  AUDIO_SUMMARY_LIMITS,
  AudioSummaryCompletion,
  AudioSummaryError,
  AudioSummaryResult,
  summarizeTranscript,
} from 'src/utils/audio-summary-text.js';

export type AudioSummaryClientConfig = {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  protocol?: 'chat-completions' | 'responses';
};

const configSchema = z.object({
  baseUrl: z.string().trim().min(1).max(4096),
  apiKey: z.string().trim().min(1).max(4096),
  modelName: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(16_000),
  maxOutputTokens: z.number().int().min(128).max(8192),
  timeoutMs: z.number().int().min(1000).max(600_000),
  protocol: z.enum(['chat-completions', 'responses']).default('chat-completions'),
});

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          content: z.string().nullable(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .length(1),
});

const responseSchema = z.object({
  status: z.string(),
  error: z.unknown().optional(),
  incomplete_details: z.unknown().optional(),
  output: z.array(z.object({ type: z.string() }).passthrough()),
});

const responseMessageSchema = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  status: z.literal('completed'),
  content: z.array(z.object({ type: z.literal('output_text'), text: z.string() })),
});

const MAX_RESPONSE_BYTES = 512 * 1024;

const getEndpoint = (baseUrl: string, protocol: 'chat-completions' | 'responses'): URL => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AudioSummaryError('invalid_config');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AudioSummaryError('invalid_config');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  url.pathname += protocol === 'responses' ? '/responses' : '/chat/completions';
  return url;
};

const readJsonResponse = async (response: Response): Promise<unknown> => {
  if (!response.body) {
    throw new AudioSummaryError('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new AudioSummaryError('response_limit');
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        throw new AudioSummaryError('response_limit');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => null);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new AudioSummaryError('invalid_response');
  }
};

const parseText = (data: unknown, protocol: 'chat-completions' | 'responses'): string => {
  if (protocol === 'chat-completions') {
    const parsed = chatResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new AudioSummaryError('invalid_response');
    }
    const choice = parsed.data.choices[0];
    if (choice.finish_reason === 'length') {
      throw new AudioSummaryError('truncated_output');
    }
    if (choice.finish_reason !== 'stop' || choice.message.refusal || choice.message.tool_calls?.length) {
      throw new AudioSummaryError('invalid_response');
    }
    return choice.message.content ?? '';
  }
  const parsed = responseSchema.safeParse(data);
  if (!parsed.success) {
    throw new AudioSummaryError('invalid_response');
  }
  if (parsed.data.status === 'incomplete' || parsed.data.incomplete_details) {
    throw new AudioSummaryError('truncated_output');
  }
  if (parsed.data.status !== 'completed' || parsed.data.error) {
    throw new AudioSummaryError('invalid_response');
  }
  const texts: string[] = [];
  for (const item of parsed.data.output) {
    if (item.type === 'reasoning') {
      continue;
    }
    const message = responseMessageSchema.safeParse(item);
    if (!message.success) {
      throw new AudioSummaryError('invalid_response');
    }
    for (const content of message.data.content) {
      texts.push(content.text);
    }
  }
  return texts.join('\n');
};

@Injectable()
export class AudioSummaryRepository {
  async summarize({
    transcript,
    config,
    signal,
  }: {
    transcript: string;
    config: AudioSummaryClientConfig;
    signal?: AbortSignal;
  }): Promise<AudioSummaryResult> {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new AudioSummaryError('invalid_config');
    }
    const validated = parsed.data;
    const endpoint = getEndpoint(validated.baseUrl, validated.protocol);
    const deadlineController = new AbortController();
    const deadline = setTimeout(() => deadlineController.abort(), AUDIO_SUMMARY_LIMITS.totalDurationMs);
    const summarySignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
    try {
      return await summarizeTranscript({
        transcript,
        prompt: validated.prompt,
        maxOutputTokens: validated.maxOutputTokens,
        signal: summarySignal,
        complete: (request) => this.complete(endpoint, validated, request, summarySignal),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new AudioSummaryError('cancelled');
      }
      if (deadlineController.signal.aborted) {
        throw new AudioSummaryError('processing_timeout');
      }
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  private async complete(
    endpoint: URL,
    config: z.infer<typeof configSchema>,
    request: AudioSummaryCompletion,
    signal?: AbortSignal,
  ): Promise<string> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    const body =
      config.protocol === 'responses'
        ? {
            model: config.modelName,
            instructions: request.instruction,
            input: [{ role: 'user', content: [{ type: 'input_text', text: request.content }] }],
            max_output_tokens: request.maxOutputTokens,
            store: false,
            stream: false,
          }
        : {
            model: config.modelName,
            messages: [
              { role: 'system', content: request.instruction },
              { role: 'user', content: request.content },
            ],
            max_completion_tokens: request.maxOutputTokens,
            store: false,
            stream: false,
          };
    try {
      if (requestSignal.aborted) {
        throw new AudioSummaryError('cancelled');
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => null);
        throw new AudioSummaryError('request_failed');
      }
      return parseText(await readJsonResponse(response), config.protocol);
    } catch (error) {
      if (signal?.aborted) {
        throw new AudioSummaryError('cancelled');
      }
      if (timeoutController.signal.aborted) {
        throw new AudioSummaryError('request_timeout');
      }
      if (error instanceof AudioSummaryError) {
        throw error;
      }
      throw new AudioSummaryError('request_failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}
