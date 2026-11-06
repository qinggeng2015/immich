import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';
import { uploadAssetsStore } from '#lib/stores/upload.ts';
import { UploadState } from '#lib/types.ts';
import * as utils from '#lib/utils.ts';
import { factory } from '#test/unit/factories.ts';
import { AssetMediaStatus, type AssetMediaResponseDto, type UserAdminResponseDto } from '@immich/sdk';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileUploadHandler } from './file-uploader';

describe('fileUploader error handling', () => {
  const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
  const mockUserObject = { id: 'user-123', email: 'test@example.com' } as UserAdminResponseDto;
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    authManager.reset();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      it(`should transition successful uploads to done`, async () => {
        vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      it('should capture errors', async () => {
        vi.spyOn(utils, 'uploadRequest').mockRejectedValue(mockError);

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
      });
    });
  }

  it('uploads audio accepted by the server', async () => {
    const audio = new File(['audio'], 'recording.MP3', { type: 'audio/mpeg' });
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg', '.mp3']);
    const upload = vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 201, data: mockUploadResponse });

    expect(await fileUploadHandler({ files: [audio] })).toEqual(['mock-id']);
    expect(upload).toHaveBeenCalledOnce();
    expect(get(uploadAssetsStore)[0]).toMatchObject({ state: UploadState.DONE, assetId: 'mock-id' });
  });

  it('skips unsupported audio while continuing to upload images', async () => {
    const audio = new File(['audio'], 'recording.mp3', { type: 'audio/mpeg' });
    const upload = vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 201, data: mockUploadResponse });

    expect(await fileUploadHandler({ files: [audio, mockFile] })).toEqual(['mock-id']);
    expect(upload).toHaveBeenCalledOnce();
    expect(get(uploadAssetsStore)).toHaveLength(1);
    expect(get(uploadAssetsStore)[0].file).toBe(mockFile);
  });

  it('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(factory.preferences());
    vi.spyOn(utils, 'uploadRequest').mockImplementationOnce(() => {
      authManager.reset();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [mockFile] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });
});
