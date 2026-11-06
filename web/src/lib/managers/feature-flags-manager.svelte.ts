import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import { getServerFeatures, type ServerFeaturesDto } from '@immich/sdk';

class FeatureFlagsManager {
  #value?: ServerFeaturesDto = $state();

  constructor() {
    eventManager.on({
      SystemConfigUpdate: () => void this.#loadFeatureFlags(),
    });
  }

  async init() {
    await this.#loadFeatureFlags();
  }

  get value() {
    if (!this.#value) {
      throw new Error('Feature flags manager must be initialized first');
    }

    return this.#value;
  }

  get supportsAudio() {
    return this.#value?.audio === true;
  }

  get supportsAudioWaveform() {
    return this.#value?.audioWaveform === true;
  }

  get supportsSpeechToText() {
    return this.#value?.speechToText === true;
  }

  get supportsAudioSummary() {
    return this.#value?.audioSummary === true;
  }

  async #loadFeatureFlags() {
    this.#value = await getServerFeatures();
  }
}

export const featureFlagsManager = new FeatureFlagsManager();
