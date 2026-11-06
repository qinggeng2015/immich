import { BadRequestException, Injectable } from '@nestjs/common';
import { isEqual } from 'lodash-es';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  AdminConfigDto,
  PublicConfigDto,
  UserConfigDto,
  defaults,
  mapAdminConfig,
  mapPublicConfig,
  mapUserConfig,
} from 'src/dtos/config.dto.js';
import { BootstrapEventPriority } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { toPlainObject } from 'src/utils/object.js';

@Injectable()
export class SystemConfigService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.SystemConfig })
  async onBootstrap() {
    const config = await this.getConfig({ withCache: false });
    await this.eventRepository.emit('ConfigInit', { newConfig: config });
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.machineLearningRepository.teardown();
  }

  async getAdminConfig(): Promise<AdminConfigDto> {
    const config = await this.getConfig({ withCache: false });
    return mapAdminConfig(config);
  }

  getAdminConfigDefaults(): AdminConfigDto {
    return mapAdminConfig(defaults);
  }

  async getUserConfig(): Promise<UserConfigDto> {
    const config = await this.getConfig({ withCache: false });
    return mapUserConfig(config);
  }

  getUserConfigDefaults(): UserConfigDto {
    return mapUserConfig(defaults);
  }

  async getPublicConfig(): Promise<PublicConfigDto> {
    const config = await this.getConfig({ withCache: false });
    return mapPublicConfig(config);
  }

  getPublicConfigDefaults(): PublicConfigDto {
    return mapPublicConfig(defaults);
  }

  @OnEvent({ name: 'ConfigInit', priority: -100 })
  onConfigInit({ newConfig: { logging, machineLearning } }: ArgOf<'ConfigInit'>) {
    const { logLevel: envLevel } = this.configRepository.getEnv();
    const configLevel = logging.enabled && logging.level;
    const level = envLevel ?? configLevel;
    this.logger.setLogLevel(level);
    this.logger.log(`LogLevel=${level} ${envLevel ? '(set via IMMICH_LOG_LEVEL)' : '(set via system config)'}`);

    this.machineLearningRepository.setup(machineLearning);
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    this.onConfigInit({ newConfig });
    clearConfigCache();
  }

  @OnEvent({ name: 'ConfigValidate' })
  onConfigValidate({ newConfig, oldConfig }: ArgOf<'ConfigValidate'>) {
    const { logLevel } = this.configRepository.getEnv();
    if (logLevel && !isEqual(toPlainObject(newConfig.logging), oldConfig.logging)) {
      throw new Error('Logging cannot be changed while the environment variable IMMICH_LOG_LEVEL is set.');
    }
  }

  async updateAdminConfig(dto: AdminConfigDto): Promise<AdminConfigDto> {
    const { configFile } = this.configRepository.getEnv();
    if (configFile) {
      throw new BadRequestException('Cannot update configuration while IMMICH_CONFIG_FILE is in use');
    }

    const oldConfig = await this.getConfig({ withCache: false });
    const speechToText = dto.machineLearning.speechToText;
    const previousSummary = oldConfig.machineLearning.audioSummary ?? defaults.machineLearning.audioSummary!;
    const incomingSummary = dto.machineLearning.audioSummary;
    const audioSummary = incomingSummary
      ? {
          ...incomingSummary,
          apiKey: incomingSummary.clearApiKey ? '' : incomingSummary.apiKey?.trim() || previousSummary.apiKey || '',
        }
      : { ...previousSummary };
    delete audioSummary.apiKeyConfigured;
    delete audioSummary.clearApiKey;
    if (audioSummary.enabled) {
      let validUrl: boolean;
      try {
        const url = new URL(audioSummary.baseUrl);
        validUrl =
          ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      } catch {
        validUrl = false;
      }
      if (!validUrl || !audioSummary.apiKey?.trim() || !audioSummary.modelName.trim()) {
        throw new BadRequestException('Audio summary requires a valid API base URL, API key, and model name');
      }
    }
    dto = {
      ...dto,
      job: {
        ...dto.job,
        audioWaveform: dto.job.audioWaveform ?? oldConfig.job.audioWaveform ?? defaults.job.audioWaveform,
        speechToText: dto.job.speechToText ?? oldConfig.job.speechToText ?? defaults.job.speechToText,
        audioSummary: dto.job.audioSummary ?? oldConfig.job.audioSummary ?? defaults.job.audioSummary,
      },
      machineLearning: {
        ...dto.machineLearning,
        audioSummary,
        speechToText: speechToText
          ? {
              ...speechToText,
              autoTranscribe:
                speechToText.autoTranscribe ??
                oldConfig.machineLearning.speechToText?.autoTranscribe ??
                defaults.machineLearning.speechToText?.autoTranscribe,
            }
          : (oldConfig.machineLearning.speechToText ?? defaults.machineLearning.speechToText),
      },
    };

    try {
      await this.eventRepository.emit('ConfigValidate', { newConfig: toPlainObject(dto), oldConfig });
    } catch (error) {
      this.logger.warn(`Unable to save system config due to a validation error: ${error}`);
      throw new BadRequestException(error instanceof Error ? error.message : error);
    }

    const newConfig = await this.updateConfig(dto);

    await this.eventRepository.emit('ConfigUpdate', { newConfig, oldConfig });

    return mapAdminConfig(newConfig);
  }

  async getCustomCss(): Promise<string> {
    const { theme } = await this.getConfig({ withCache: false });
    return theme.customCss;
  }
}
