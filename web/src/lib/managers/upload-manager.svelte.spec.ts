import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';

describe('audio upload compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    uploadManager.mediaTypes = { image: [], video: [], sidecar: [] };
  });

  it('preserves image and video uploads when the server does not advertise audio', () => {
    vi.spyOn(featureFlagsManager, 'supportsAudio', 'get').mockReturnValue(false);
    uploadManager.mediaTypes = { image: ['.jpg'], video: ['.mp4'], sidecar: ['.xmp'], audio: ['.mp3'] };

    expect(uploadManager.getExtensions()).toEqual(['.jpg', '.mp4']);
  });

  it('accepts only audio extensions advertised by a supporting server', () => {
    vi.spyOn(featureFlagsManager, 'supportsAudio', 'get').mockReturnValue(true);
    uploadManager.mediaTypes = { image: ['.jpg'], video: ['.mp4'], sidecar: ['.xmp'], audio: ['.mp3', '.flac'] };

    expect(uploadManager.getExtensions()).toEqual(['.jpg', '.mp4', '.mp3', '.flac']);
  });

  it('handles a missing audio media types field', () => {
    vi.spyOn(featureFlagsManager, 'supportsAudio', 'get').mockReturnValue(true);
    uploadManager.mediaTypes = { image: ['.jpg'], video: ['.mp4'], sidecar: [] };

    expect(uploadManager.getExtensions()).toEqual(['.jpg', '.mp4']);
  });
});
