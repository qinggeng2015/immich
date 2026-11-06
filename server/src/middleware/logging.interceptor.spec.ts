import { ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { LoggingInterceptor } from 'src/middleware/logging.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const setup = (body: object, statusCode = 200) => {
  const logger = { setContext: vitest.fn(), debug: vitest.fn(), verbose: vitest.fn() };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'PUT', url: '/api/admin/config', ip: '127.0.0.1', body }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
  const sut = new LoggingInterceptor(logger as unknown as LoggingRepository);
  return { sut, context, logger };
};

describe(LoggingInterceptor.name, () => {
  it('should redact nested credentials without changing the configuration or response', async () => {
    const body = {
      machineLearning: { audioSummary: { apiKey: 'provider-secret', modelName: 'model', maxOutputTokens: 2048 } },
      oauth: { clientSecret: 'oauth-secret' },
      notifications: { smtp: { transport: { password: 'smtp-secret' } } },
      credentials: [
        { API_KEY: 'uppercase-secret', 'client-secret': 'hyphenated-secret' },
        { access_token: 'access-secret', refreshToken: 'refresh-secret', idToken: 'id-secret', token: 'token-secret' },
      ],
    };
    const original = structuredClone(body);
    const response = { enabled: true };
    const { sut, context, logger } = setup(body);

    await expect(firstValueFrom(sut.intercept(context, { handle: () => of(response) }))).resolves.toBe(response);

    expect(JSON.parse(logger.verbose.mock.calls[0][0])).toEqual({
      machineLearning: { audioSummary: { apiKey: '********', modelName: 'model', maxOutputTokens: 2048 } },
      oauth: { clientSecret: '********' },
      notifications: { smtp: { transport: { password: '********' } } },
      credentials: [
        { API_KEY: '********', 'client-secret': '********' },
        { access_token: '********', refreshToken: '********', idToken: '********', token: '********' },
      ],
    });
    expect(body).toEqual(original);
  });

  it('should redact credentials when the request fails validation', async () => {
    const body = { machineLearning: { audioSummary: { apiKey: 'rejected-secret' } } };
    const { sut, context, logger } = setup(body, 400);
    const error = new Error('Invalid configuration');

    await expect(firstValueFrom(sut.intercept(context, { handle: () => throwError(() => error) }))).rejects.toBe(error);

    expect(logger.verbose).toHaveBeenCalledWith('{"machineLearning":{"audioSummary":{"apiKey":"********"}}}');
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('rejected-secret');
  });
});
