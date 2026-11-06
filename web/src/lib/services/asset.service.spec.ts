import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
import { queryClient } from '#lib/queries/client.ts';
import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
import { getAssetActions, handleDownloadAsset } from '#lib/services/asset.service.ts';
import { setSharedLink } from '#lib/utils.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { factory } from '#test/unit/factories.ts';
import { AssetTypeEnum, getAssetInfo, type UserConfigDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { vitest } from 'vitest';

vitest.mock('@immich/ui', () => ({
  toastManager: {
    primary: vitest.fn(),
  },
}));

vitest.mock('#lib/utils/i18n.js', () => ({
  getFormatter: vitest.fn(),
  getPreferredLocale: vitest.fn(),
}));

vitest.mock('@immich/sdk');

vitest.mock('#lib/utils.js', async () => {
  const originalModule = await vitest.importActual('#lib/utils.js');
  return {
    ...originalModule,
    sleep: vitest.fn(),
    downloadUrl: vitest.fn(),
  };
});

describe('AssetService', () => {
  describe('getAssetActions', () => {
    beforeEach(() => {
      authManager.setPreferences(factory.preferences());
      queryClient.setQueryData(getUserConfigQuery().queryKey, {
        machineLearning: {
          enabled: false,
          clip: { enabled: false },
          duplicateDetection: { enabled: false },
          facialRecognition: { enabled: false },
          ocr: { enabled: false },
        },
      } as UserConfigDto);
    });

    it('should allow shared link downloads if the user owns the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = factory.user({ id: ownerId });
      const asset = factory.asset({ ownerId });
      authManager.setUser(user);
      setSharedLink(factory.sharedLink({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });

    it('gates audio processing actions on ownership, capability and enabled transcription', () => {
      const user = factory.user();
      authManager.setUser(user);
      vitest.spyOn(featureFlagsManager, 'supportsAudioWaveform', 'get').mockReturnValue(true);
      vitest.spyOn(featureFlagsManager, 'supportsSpeechToText', 'get').mockReturnValue(true);
      const asset = factory.asset({ ownerId: user.id, type: AssetTypeEnum.Audio });
      const actions = getAssetActions(() => '', asset);

      expect(actions.GenerateWaveformJob.$if?.()).toBe(true);
      expect(actions.TranscribeAudioJob.$if?.()).toBe(false);
      queryClient.setQueryData(getUserConfigQuery().queryKey, {
        machineLearning: {
          enabled: true,
          clip: { enabled: false },
          duplicateDetection: { enabled: false },
          facialRecognition: { enabled: false },
          ocr: { enabled: false },
          speechToText: { enabled: true, autoTranscribe: false },
        },
      } as UserConfigDto);
      expect(actions.TranscribeAudioJob.$if?.()).toBe(true);
      expect(getAssetActions(() => '', { ...asset, ownerId: 'another-user' }).TranscribeAudioJob.$if?.()).toBe(false);
      const config = queryClient.getQueryData<UserConfigDto>(getUserConfigQuery().queryKey)!;
      queryClient.setQueryData(getUserConfigQuery().queryKey, {
        ...config,
        machineLearning: { ...config.machineLearning, enabled: false },
      });
      expect(actions.TranscribeAudioJob.$if?.()).toBe(false);
      vitest.spyOn(featureFlagsManager, 'supportsAudioWaveform', 'get').mockReturnValue(false);
      expect(actions.GenerateWaveformJob.$if?.()).toBe(false);
    });

    it('should not allow shared link downloads if the user does not own the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = factory.user({ id: 'non-owner' });
      const asset = factory.asset({ ownerId });
      authManager.setUser(user);
      setSharedLink(factory.sharedLink({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(false);
    });

    it('should allow shared link downloads if shared link downloads are enabled regardless of user', () => {
      const asset = factory.asset();
      setSharedLink(factory.sharedLink({ allowDownload: true }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });
  });

  describe('handleDownloadAsset', () => {
    it('should use the asset originalFileName when showing toasts', async () => {
      const $t = vitest.fn().mockReturnValue('formatter');
      vitest.mocked(getFormatter).mockResolvedValue($t);
      const asset = factory.asset({ originalFileName: 'asset.heic' });
      await handleDownloadAsset(asset, { edited: false });
      expect($t).toHaveBeenNthCalledWith(1, 'downloading_asset_filename', { values: { filename: 'asset.heic' } });
      expect(toastManager.primary).toHaveBeenCalledWith('formatter');
    });

    it('should use the motion asset originalFileName when showing toasts', async () => {
      const $t = vitest.fn().mockReturnValue('formatter');
      vitest.mocked(getFormatter).mockResolvedValue($t);
      const motionAsset = factory.asset({ originalFileName: 'asset.mov' });
      vitest.mocked(getAssetInfo).mockResolvedValue(motionAsset);
      const asset = factory.asset({ originalFileName: 'asset.heic', livePhotoVideoId: '1' });
      await handleDownloadAsset(asset, { edited: false });
      expect($t).toHaveBeenNthCalledWith(1, 'downloading_asset_filename', { values: { filename: 'asset.heic' } });
      expect($t).toHaveBeenNthCalledWith(2, 'downloading_asset_filename', { values: { filename: 'asset-motion.mov' } });
      expect(toastManager.primary).toHaveBeenCalledWith('formatter');
    });
  });
});
