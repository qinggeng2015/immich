import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { map } from 'rxjs';
import {
  CLIENT_FEATURES_HEADER,
  hasAudioAsset,
  supportsAudio,
  withLegacyAssetTypes,
} from 'src/utils/client-features.js';

const assetControllers = new Set([
  'assets',
  'albums',
  'search',
  'memories',
  'shared-links',
  'duplicates',
  'stacks',
  'timeline',
  'view',
]);

@Injectable()
export class ClientFeaturesInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const controllerPath = this.reflector.get<unknown>(PATH_METADATA, context.getClass());
    const routePath = this.reflector.get<unknown>(PATH_METADATA, context.getHandler());
    if (
      typeof controllerPath !== 'string' ||
      (!assetControllers.has(controllerPath) && controllerPath !== 'queues') ||
      (controllerPath === 'assets' && typeof routePath === 'string' && routePath.split('/').includes('metadata'))
    ) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.vary(CLIENT_FEATURES_HEADER);

    return controllerPath === 'queues' || supportsAudio(request.headers[CLIENT_FEATURES_HEADER])
      ? next.handle()
      : next.handle().pipe(map((value) => (hasAudioAsset(value) ? withLegacyAssetTypes(value) : value)));
  }
}
