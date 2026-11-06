import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
import { uploadAssetsStore } from '#lib/stores/upload.ts';
import { cancelUploadRequests } from '#lib/utils.ts';
import { getSupportedMediaTypes, type ServerMediaTypesResponseDto } from '@immich/sdk';

class UploadManager {
  mediaTypes = $state<ServerMediaTypesResponseDto>({ image: [], sidecar: [], video: [] });

  constructor() {
    eventManager.on({
      AppInit: () => this.#loadExtensions(),
      AuthLogout: () => this.reset(),
    });
  }

  reset() {
    cancelUploadRequests();
    uploadAssetsStore.reset();
  }

  async #loadExtensions() {
    try {
      this.mediaTypes = await getSupportedMediaTypes();
    } catch {
      console.error('Failed to load supported media types');
    }
  }

  getExtensions() {
    return [
      ...this.mediaTypes.image,
      ...this.mediaTypes.video,
      ...(featureFlagsManager.supportsAudio ? (this.mediaTypes.audio ?? []) : []),
    ];
  }
}

export const uploadManager = new UploadManager();
