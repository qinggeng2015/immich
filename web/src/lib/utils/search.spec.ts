import { normalizeAudioSearchQuery, type SearchQuery } from '#lib/utils/search.ts';
import { AssetTypeEnum } from '@immich/sdk';

describe('normalizeAudioSearchQuery', () => {
  it('searches transcripts without visual search fields', () => {
    expect(
      normalizeAudioSearchQuery(
        {
          type: AssetTypeEnum.Audio,
          transcript: 'spoken words',
          query: 'sunset',
          queryAssetId: 'image-id',
          ocr: 'sign',
        },
        true,
        true,
      ),
    ).toEqual({ type: AssetTypeEnum.Audio, transcript: 'spoken words' });
  });

  it('falls back to filename text when transcript search is unsupported', () => {
    expect(normalizeAudioSearchQuery({ transcript: 'spoken words' }, true, false)).toEqual({
      originalFileName: 'spoken words',
    });
  });

  it('preserves an explicit path when dropping unsupported transcript filters', () => {
    expect(normalizeAudioSearchQuery({ transcript: 'spoken words', originalPath: '/recordings' }, true, false)).toEqual(
      {
        originalPath: '/recordings',
      },
    );
  });

  it.each(['query', 'ocr'] as const)('searches audio %s text by filename', (field) => {
    expect(normalizeAudioSearchQuery({ type: AssetTypeEnum.Audio, [field]: 'recording' }, true)).toEqual({
      type: AssetTypeEnum.Audio,
      originalFileName: 'recording',
    });
  });

  it.each(['originalFileName', 'originalPath', 'description'] as const)(
    'preserves explicit audio %s searches',
    (field) => {
      expect(
        normalizeAudioSearchQuery({ type: AssetTypeEnum.Audio, [field]: 'recording', query: 'ignored' }, true),
      ).toEqual({ type: AssetTypeEnum.Audio, [field]: 'recording' });
    },
  );

  it('drops visual similarity filters while preserving other audio filters', () => {
    expect(
      normalizeAudioSearchQuery(
        { type: AssetTypeEnum.Audio, queryAssetId: 'image-id', isFavorite: true, tagIds: ['tag-id'] },
        true,
      ),
    ).toEqual({ type: AssetTypeEnum.Audio, isFavorite: true, tagIds: ['tag-id'] });
  });

  it('omits unsupported audio types on older servers while retaining filename text', () => {
    expect(normalizeAudioSearchQuery({ type: AssetTypeEnum.Audio, query: 'recording' }, false)).toEqual({
      originalFileName: 'recording',
    });
  });

  it.each([undefined, AssetTypeEnum.Image, AssetTypeEnum.Video])(
    'preserves ordinary search queries with type %s',
    (type) => {
      const query: SearchQuery = { type, query: 'sunset', queryAssetId: 'image-id', ocr: 'sign' };
      expect(normalizeAudioSearchQuery(query, true)).toEqual(query);
    },
  );
});
