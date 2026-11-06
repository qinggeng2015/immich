import { getAssetAudioTranscriptQuery } from '#lib/queries/asset-audio.query.ts';
import { AudioAnalysisStatus, type AssetAudioTranscriptResponseDto } from '@immich/sdk';
import { QueryClient } from '@tanstack/svelte-query';

describe('audio analysis polling', () => {
  it.each([AudioAnalysisStatus.Pending, AudioAnalysisStatus.Processing])(
    'keeps refreshing long-running %s jobs at a slower rate',
    (status) => {
      const client = new QueryClient();
      const options = getAssetAudioTranscriptQuery('recording');
      const query = client
        .getQueryCache()
        .build<AssetAudioTranscriptResponseDto, Error, AssetAudioTranscriptResponseDto, string[]>(client, options);
      query.setData({ status, transcript: null });
      const interval = options.refetchInterval;
      expect(typeof interval).toBe('function');
      if (typeof interval !== 'function') {
        throw new TypeError('Expected a polling interval callback');
      }

      expect(interval(query)).toBe(5000);
      for (let index = 0; index < 130; index++) {
        query.setData({ status, transcript: null });
      }
      expect(interval(query)).toBe(30_000);
      client.clear();
    },
  );

  it.each([
    AudioAnalysisStatus.Unprocessed,
    AudioAnalysisStatus.Ready,
    AudioAnalysisStatus.Failed,
    AudioAnalysisStatus.Disabled,
  ])('does not poll %s audio', (status) => {
    const client = new QueryClient();
    const options = getAssetAudioTranscriptQuery('recording');
    const query = client
      .getQueryCache()
      .build<AssetAudioTranscriptResponseDto, Error, AssetAudioTranscriptResponseDto, string[]>(client, options);
    query.setData({ status, transcript: null });
    const interval = options.refetchInterval;
    expect(typeof interval === 'function' && interval(query)).toBe(false);
    client.clear();
  });
});
