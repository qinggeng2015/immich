import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetType } from 'src/enum.js';
import {
  hasAudioAsset,
  supportsAudio,
  supportsAudioAnalysis,
  withLegacyAssetTypes,
} from 'src/utils/client-features.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { getForAsset } from 'test/mappers.js';

describe('supportsAudio', () => {
  it.each([undefined, null, false, 1, {}, 'Audio', 'audio-preview', ['image']].map((value) => ({ value })))(
    'should reject $value',
    ({ value }) => {
      expect(supportsAudio(value)).toBe(false);
    },
  );

  it.each(['audio', 'image, audio', ['image', 'audio']].map((value) => ({ value })))(
    'should accept $value',
    ({ value }) => {
      expect(supportsAudio(value)).toBe(true);
    },
  );
});

describe('supportsAudioAnalysis', () => {
  it.each([undefined, null, false, {}, 'audio', 'Audio-analysis', 'audio-analysis-preview', ['audio']])(
    'should require an explicit audio-analysis token: %s',
    (value) => {
      expect(supportsAudioAnalysis(value)).toBe(false);
    },
  );

  it.each(['audio-analysis', 'audio, audio-analysis', ['audio', 'audio-analysis']])(
    'should recognize audio analysis independently of audio assets: %s',
    (value) => {
      expect(supportsAudioAnalysis(value)).toBe(true);
    },
  );

  it('should not opt an analysis-only client into audio asset enums', () => {
    expect(supportsAudio('audio-analysis')).toBe(false);
  });
});

describe('withLegacyAssetTypes', () => {
  it('should preserve binary and date values as well as unrelated type fields', () => {
    const date = new Date();
    const buffer = Buffer.from('image data');
    const value = {
      date,
      buffer,
      type: AssetType.Audio,
      assets: [{ id: 'audio', type: AssetType.Audio, originalMimeType: 'audio/wav' }],
    };
    const result = withLegacyAssetTypes(value);

    expect(result.date).toBe(date);
    expect(result.buffer).toBe(buffer);
    expect(result.type).toBe(AssetType.Audio);
    expect(result.assets).toEqual([{ ...value.assets[0], type: AssetType.Other }]);
  });

  it('should preserve arbitrary metadata even when it contains complete asset-shaped objects', () => {
    const metadata = {
      key: 'custom',
      value: { id: 'metadata', type: AssetType.Audio, originalMimeType: 'audio/wav', assets: [] },
    };
    const audio = { id: 'audio', type: AssetType.Audio, originalMimeType: 'audio/wav' };
    const value = { assets: [audio], metadata: metadata.value, items: [metadata] };
    const result = withLegacyAssetTypes(value);

    expect(result.assets).toEqual([{ ...audio, type: AssetType.Other }]);
    expect(result.metadata).toBe(metadata.value);
    expect(result.items[0]).toBe(metadata);
    expect(hasAudioAsset(metadata)).toBe(false);
    expect(hasAudioAsset({ metadata: metadata.value })).toBe(false);
  });

  it('should downgrade actual sanitized shared-link asset responses', () => {
    const auth = AuthFactory.from().sharedLink({ showExif: false }).build();
    const asset = mapAsset(getForAsset(AssetFactory.create({ type: AssetType.Audio, originalFileName: 'song.mp3' })), {
      auth,
    });

    expect(asset.hasMetadata).toBe(false);
    expect(asset).not.toHaveProperty('originalFileName');
    expect(asset).not.toHaveProperty('checksum');
    expect(hasAudioAsset(asset)).toBe(true);
    expect(withLegacyAssetTypes(asset)).toEqual({ ...asset, type: AssetType.Other });
  });

  it('should preserve generic objects with id and type properties', () => {
    const value = { id: 'metadata', type: AssetType.Audio };
    expect(withLegacyAssetTypes(value)).toEqual(value);
    expect(hasAudioAsset(value)).toBe(false);
  });

  it('should downgrade search result and explore asset envelopes', () => {
    const audio = { id: 'audio', type: AssetType.Audio, originalMimeType: 'audio/wav' };
    expect(withLegacyAssetTypes({ assets: { items: [audio] } })).toEqual({
      assets: { items: [{ ...audio, type: AssetType.Other }] },
    });
    expect(withLegacyAssetTypes([{ items: [{ value: 'city', data: audio }] }])).toEqual([
      { items: [{ value: 'city', data: { ...audio, type: AssetType.Other } }] },
    ]);
  });

  it('should leave pre-serialized responses untouched', () => {
    expect(withLegacyAssetTypes('{"isImage":[]}')).toBe('{"isImage":[]}');
  });
});

describe('hasAudioAsset', () => {
  it('should recognize both legacy and sync websocket event payloads', () => {
    const audio = { id: 'audio', type: AssetType.Audio, originalMimeType: 'audio/wav' };
    const syncAudio = { id: 'audio', type: AssetType.Audio, originalFileName: 'song.mp3', checksum: 'checksum' };
    expect(hasAudioAsset([audio])).toBe(true);
    expect(hasAudioAsset([{ asset: syncAudio, exif: {} }])).toBe(true);
    expect(hasAudioAsset([{ id: 'image', type: AssetType.Image }])).toBe(false);
    expect(hasAudioAsset([{ id: 'video', type: AssetType.Video }])).toBe(false);
    expect(hasAudioAsset([{ type: AssetType.Audio }])).toBe(false);
  });
});
