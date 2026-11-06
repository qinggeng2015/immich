import { MediaType } from '#lib/constants.ts';
import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
import { searchManager } from '#lib/managers/search-manager.svelte.ts';
import { AssetTypeEnum } from '@immich/sdk';
import { goto } from '$app/navigation';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

describe('SearchManager', () => {
  beforeEach(() => {
    vi.spyOn(featureFlagsManager, 'supportsAudio', 'get').mockReturnValue(true);
    vi.spyOn(featureFlagsManager, 'supportsSpeechToText', 'get').mockReturnValue(false);
    localStorage.clear();
    searchManager.reset();
  });

  it('restores and submits transcript searches through metadata search', async () => {
    vi.spyOn(featureFlagsManager, 'supportsSpeechToText', 'get').mockReturnValue(true);
    searchManager.setQuery({ type: AssetTypeEnum.Audio, transcript: 'spoken words' });

    expect(searchManager.queryType).toBe('transcript');
    expect(searchManager.filter.query).toBe('spoken words');
    await searchManager.submit();

    const [url] = vi.mocked(goto).mock.lastCall!;
    expect(JSON.parse(new URL(url, 'http://localhost').searchParams.get('query')!)).toEqual({
      type: AssetTypeEnum.Audio,
      transcript: 'spoken words',
    });
  });

  it('keeps saved transcript preferences while older servers use filename search', () => {
    const supportsSpeech = vi.spyOn(featureFlagsManager, 'supportsSpeechToText', 'get').mockReturnValue(false);
    localStorage.setItem('searchQueryType', 'transcript');
    searchManager.reset();

    expect(searchManager.queryType).toBe('metadata');
    expect(localStorage.getItem('searchQueryType')).toBe('transcript');
    supportsSpeech.mockReturnValue(true);
    expect(searchManager.queryType).toBe('transcript');
  });

  it('preserves audio media filters from the URL', () => {
    searchManager.setQuery({ type: AssetTypeEnum.Audio });
    expect(searchManager.filter.mediaType).toBe(MediaType.Audio);
    expect(searchManager.filter.queryType).toBe('metadata');
  });

  it.each(['smart', 'ocr'])('restores an audio filter without changing the saved %s preference', (queryType) => {
    localStorage.setItem('searchQueryType', queryType);

    searchManager.setQuery({ type: AssetTypeEnum.Audio });

    expect(searchManager.filter.queryType).toBe('metadata');
    expect(localStorage.getItem('searchQueryType')).toBe(queryType);
    searchManager.reset();
    expect(searchManager.filter.queryType).toBe(queryType);
  });

  it.each(['smart', 'ocr'] as const)('submits an audio %s query as a filename search', async (queryType) => {
    searchManager.filter.mediaType = MediaType.Audio;
    searchManager.filter.queryType = queryType;
    searchManager.filter.query = 'recording';
    searchManager.filter.queryAssetId = 'image-id';

    await searchManager.submit();

    const [url] = vi.mocked(goto).mock.lastCall!;
    const query = new URL(url, 'http://localhost').searchParams.get('query')!;
    expect(JSON.parse(query)).toEqual({ type: AssetTypeEnum.Audio, originalFileName: 'recording' });
  });

  it('removes audio filters restored on an older server', () => {
    vi.spyOn(featureFlagsManager, 'supportsAudio', 'get').mockReturnValue(false);

    searchManager.setQuery({ type: AssetTypeEnum.Audio, query: 'recording' });

    expect(searchManager.filter.mediaType).toBe(MediaType.All);
    expect(searchManager.filter.queryType).toBe('metadata');
    expect(searchManager.filter.query).toBe('recording');
  });

  it('omits audio when submitting to an older server', async () => {
    vi.spyOn(featureFlagsManager, 'supportsAudio', 'get').mockReturnValue(false);
    searchManager.filter.mediaType = MediaType.Audio;
    searchManager.filter.query = 'recording';

    await searchManager.submit();

    const [url] = vi.mocked(goto).mock.lastCall!;
    const query = new URL(url, 'http://localhost').searchParams.get('query')!;
    expect(JSON.parse(query)).toEqual({ originalFileName: 'recording' });
  });

  it('defaults to smart search', () => {
    expect(searchManager.filter.queryType).toBe('smart');
  });

  it('remembers the selected query type', () => {
    searchManager.setQueryType('metadata');
    expect(searchManager.filter.queryType).toBe('metadata');

    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('metadata');
  });

  it('overrides a previously stored query type', () => {
    localStorage.setItem('searchQueryType', 'metadata');
    searchManager.reset();

    searchManager.setQueryType('smart');
    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('smart');
  });

  it('ignores an invalid stored query type', () => {
    localStorage.setItem('searchQueryType', 'invalid');
    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('smart');
  });
});
