import { Controller, ExecutionContext, Get, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { AssetType } from 'src/enum.js';
import { ClientFeaturesInterceptor } from 'src/middleware/client-features.interceptor.js';
import { CLIENT_FEATURES_HEADER } from 'src/utils/client-features.js';

@Controller('assets')
class TestAssetController {
  @Get(':id')
  getAssetInfo() {}

  @Get(':id/metadata/:key')
  getMetadata() {}
}

@Controller('users')
class TestUserController {
  @Get('me/metadata')
  getMetadata() {}
}

@Controller('search')
class TestSearchController {
  @Post('metadata')
  searchMetadata() {}
}

@Controller('timeline')
class TestTimelineController {
  @Get('bucket')
  getTimeBucket() {}
}

@Controller('queues')
class TestQueueController {
  @Get()
  getQueues() {}
}

const contextFor = (
  features?: string,
  handler = TestAssetController.prototype.getAssetInfo,
  controller: object = TestAssetController,
) => {
  const vary = vitest.fn();
  const context = {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ headers: { [CLIENT_FEATURES_HEADER]: features } }),
      getResponse: () => ({ vary }),
    }),
  } as unknown as ExecutionContext;
  return { context, vary };
};

describe(ClientFeaturesInterceptor.name, () => {
  it.each([undefined, 'audio', 'audio,audio-analysis'])(
    'should vary queue responses without rewriting job payloads for %s',
    async (features) => {
      const body = [
        { name: 'audioWaveform', data: { id: 'data', type: AssetType.Audio, originalMimeType: 'audio/wav' } },
      ];
      const { context, vary } = contextFor(features, TestQueueController.prototype.getQueues, TestQueueController);

      const result = await firstValueFrom(
        new ClientFeaturesInterceptor(new Reflector()).intercept(context, { handle: () => of(body) }),
      );

      expect(result).toBe(body);
      expect(vary).toHaveBeenCalledWith(CLIENT_FEATURES_HEADER);
    },
  );

  it.each([{ body: '{"id":[],"isAudio":[]}' }, { body: [{ timeBucket: '2024-05-01', count: 1 }] }])(
    'should vary timeline responses by capability without rewriting the payload',
    async ({ body }) => {
      const { context, vary } = contextFor(
        undefined,
        TestTimelineController.prototype.getTimeBucket,
        TestTimelineController,
      );

      const result = await firstValueFrom(
        new ClientFeaturesInterceptor(new Reflector()).intercept(context, { handle: () => of(body) }),
      );

      expect(result).toBe(body);
      expect(vary).toHaveBeenCalledWith(CLIENT_FEATURES_HEADER);
    },
  );

  it('should downgrade asset search results from the metadata search route', async () => {
    const audio = { id: 'audio', type: AssetType.Audio, originalMimeType: 'audio/wav' };
    const body = { assets: { items: [audio], total: 1, nextPage: null } };
    const { context } = contextFor(undefined, TestSearchController.prototype.searchMetadata, TestSearchController);

    const result = await firstValueFrom(
      new ClientFeaturesInterceptor(new Reflector()).intercept(context, { handle: () => of(body) }),
    );

    expect(result).toEqual({ assets: { ...body.assets, items: [{ ...audio, type: AssetType.Other }] } });
  });

  it.each([undefined, '', 'video', 'audio-preview'])(
    'should downgrade nested audio assets for %s',
    async (features) => {
      const body = {
        assets: [
          { id: 'audio', type: AssetType.Audio, originalMimeType: 'audio/wav' },
          { id: 'image', type: AssetType.Image },
          { id: 'video', type: AssetType.Video },
        ],
        nextPage: 'next',
      };
      const { context, vary } = contextFor(features);

      const result = await firstValueFrom(
        new ClientFeaturesInterceptor(new Reflector()).intercept(context, { handle: () => of(body) }),
      );

      expect(result).toEqual({
        ...body,
        assets: [{ ...body.assets[0], type: AssetType.Other }, body.assets[1], body.assets[2]],
      });
      expect(body.assets[0].type).toBe(AssetType.Audio);
      expect(vary).toHaveBeenCalledWith(CLIENT_FEATURES_HEADER);
    },
  );

  it('should preserve the original response for audio-capable clients', async () => {
    const body = { id: 'audio', type: AssetType.Audio, originalMimeType: 'audio/wav' };
    const { context } = contextFor('video, audio');

    const result = await firstValueFrom(
      new ClientFeaturesInterceptor(new Reflector()).intercept(context, { handle: () => of(body) }),
    );

    expect(result).toBe(body);
  });

  it.each([
    { controller: TestUserController, handler: TestUserController.prototype.getMetadata },
    { controller: TestAssetController, handler: TestAssetController.prototype.getMetadata },
  ])('should leave unrelated or metadata route payloads untouched', async ({ controller, handler }) => {
    const body = { id: 'metadata', type: AssetType.Audio, originalMimeType: 'audio/wav' };
    const { context, vary } = contextFor(undefined, handler, controller);
    const result = await firstValueFrom(
      new ClientFeaturesInterceptor(new Reflector()).intercept(context, { handle: () => of(body) }),
    );

    expect(result).toBe(body);
    expect(vary).not.toHaveBeenCalled();
  });
});
