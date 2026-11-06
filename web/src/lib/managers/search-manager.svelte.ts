import { MediaType, QueryType, validQueryTypes } from '#lib/constants.ts';
import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
import { Route } from '#lib/route.ts';
import type { SearchFilter } from '#lib/types.ts';
import { asLocalTimeISO, parseUtcDate } from '#lib/utils/date-time.ts';
import { normalizeAudioSearchQuery } from '#lib/utils/search.ts';
import { AssetTypeEnum, AssetVisibility, type MetadataSearchDto, type SmartSearchDto } from '@immich/sdk';
import type { DateTime } from 'luxon';
import { SvelteSet } from 'svelte/reactivity';
import { goto } from '$app/navigation';

const QUERY_TYPE_STORAGE_KEY = 'searchQueryType';

class SearchManager {
  #filter = $state<SearchFilter>(this.#fromQuery({}));

  get filter() {
    return this.#filter;
  }

  get queryType() {
    return this.filter.queryType === QueryType.TRANSCRIPT && !featureFlagsManager.supportsSpeechToText
      ? QueryType.METADATA
      : this.filter.queryType;
  }

  reset() {
    this.#filter = this.#fromQuery({});
  }

  setQuery(query: MetadataSearchDto | SmartSearchDto) {
    this.#filter = this.#fromQuery(query);
  }

  setQueryType(queryType: SearchFilter['queryType']) {
    this.#filter.queryType = queryType;
    localStorage.setItem(QUERY_TYPE_STORAGE_KEY, queryType);
  }

  async submit() {
    await goto(Route.search(this.#toQuery()));
  }

  #fromQuery(searchQuery: MetadataSearchDto | SmartSearchDto): SearchFilter {
    searchQuery = normalizeAudioSearchQuery(
      searchQuery,
      featureFlagsManager.supportsAudio,
      featureFlagsManager.supportsSpeechToText,
    );
    let query = 'query' in searchQuery && searchQuery.query ? searchQuery.query : '';
    let queryType = query ? QueryType.SMART : this.#defaultQueryType();

    if ('originalFileName' in searchQuery && searchQuery.originalFileName) {
      query = searchQuery.originalFileName;
      queryType = QueryType.METADATA;
    }

    if ('originalPath' in searchQuery && searchQuery.originalPath) {
      query = searchQuery.originalPath;
      queryType = QueryType.FULL_PATH;
    }

    if ('description' in searchQuery && searchQuery.description) {
      query = searchQuery.description;
      queryType = QueryType.DESCRIPTION;
    }

    if (searchQuery.ocr) {
      query = searchQuery.ocr;
      queryType = QueryType.OCR;
    }

    if (searchQuery.transcript) {
      query = searchQuery.transcript;
      queryType = QueryType.TRANSCRIPT;
    }

    if (searchQuery.type === AssetTypeEnum.Audio && (queryType === QueryType.SMART || queryType === QueryType.OCR)) {
      queryType = QueryType.METADATA;
    }

    return {
      query,
      ocr: searchQuery.ocr,
      queryType,
      queryAssetId: 'queryAssetId' in searchQuery ? searchQuery.queryAssetId : undefined,
      personIds: new SvelteSet('personIds' in searchQuery ? searchQuery.personIds : []),
      tagIds:
        'tagIds' in searchQuery
          ? searchQuery.tagIds === null
            ? null
            : new SvelteSet(searchQuery.tagIds)
          : new SvelteSet(),
      location: {
        country: this.#withNullAsEmptyString(searchQuery.country),
        state: this.#withNullAsEmptyString(searchQuery.state),
        city: this.#withNullAsEmptyString(searchQuery.city),
      },
      camera: {
        make: this.#withNullAsEmptyString(searchQuery.make),
        model: this.#withNullAsEmptyString(searchQuery.model),
        lensModel: this.#withNullAsEmptyString(searchQuery.lensModel),
      },
      date: {
        takenAfter: searchQuery.takenAfter ? this.#toStartOfDayDate(searchQuery.takenAfter) : undefined,
        takenBefore: searchQuery.takenBefore ? this.#toStartOfDayDate(searchQuery.takenBefore) : undefined,
      },
      display: {
        isArchive: searchQuery.visibility === AssetVisibility.Archive,
        isFavorite: searchQuery.isFavorite ?? false,
        isNotInAlbum: 'isNotInAlbum' in searchQuery && (searchQuery.isNotInAlbum ?? false),
      },
      mediaType:
        searchQuery.type === AssetTypeEnum.Image
          ? MediaType.Image
          : searchQuery.type === AssetTypeEnum.Video
            ? MediaType.Video
            : searchQuery.type === AssetTypeEnum.Audio
              ? MediaType.Audio
              : MediaType.All,
      rating: searchQuery.rating,
    };
  }

  #toQuery(): MetadataSearchDto | SmartSearchDto {
    const type = {
      [MediaType.All]: undefined,
      [MediaType.Image]: AssetTypeEnum.Image,
      [MediaType.Video]: AssetTypeEnum.Video,
      [MediaType.Audio]: AssetTypeEnum.Audio,
    }[this.filter.mediaType];

    const query = this.filter.query || undefined;
    const queryType = this.queryType;

    return normalizeAudioSearchQuery(
      {
        query: queryType === 'smart' ? query : undefined,
        queryAssetId: queryType === 'transcript' ? undefined : this.filter.queryAssetId || undefined,
        ocr: queryType === 'ocr' ? query : undefined,
        transcript: queryType === 'transcript' ? query : undefined,
        originalFileName: queryType === 'metadata' ? query : undefined,
        description: queryType === 'description' ? query : undefined,
        originalPath: queryType === 'fullPath' ? this.filter.query.trim() || undefined : undefined,
        country: this.#emptyStringToNull(this.filter.location.country),
        state: this.#emptyStringToNull(this.filter.location.state),
        city: this.#emptyStringToNull(this.filter.location.city),
        make: this.#emptyStringToNull(this.filter.camera.make),
        model: this.#emptyStringToNull(this.filter.camera.model),
        lensModel: this.#emptyStringToNull(this.filter.camera.lensModel),
        takenAfter: this.filter.date.takenAfter
          ? asLocalTimeISO(this.filter.date.takenAfter.startOf('day') as DateTime<true>)
          : undefined,
        takenBefore: this.filter.date.takenBefore
          ? asLocalTimeISO(this.filter.date.takenBefore.endOf('day') as DateTime<true>)
          : undefined,
        visibility: this.filter.display.isArchive ? AssetVisibility.Archive : undefined,
        isFavorite: this.filter.display.isFavorite || undefined,
        isNotInAlbum: this.filter.display.isNotInAlbum || undefined,
        personIds: this.filter.personIds.size > 0 ? [...this.filter.personIds] : undefined,
        tagIds: this.filter.tagIds === null ? null : this.filter.tagIds.size > 0 ? [...this.filter.tagIds] : undefined,
        type,
        rating: this.filter.rating,
      },
      featureFlagsManager.supportsAudio,
      featureFlagsManager.supportsSpeechToText,
    );
  }

  #withNullAsEmptyString<T>(value: T | null) {
    return value === null ? '' : value;
  }

  #emptyStringToNull(value: string | undefined) {
    return value === '' ? null : value;
  }

  #toStartOfDayDate(dateString: string) {
    return parseUtcDate(dateString)?.startOf('day') || undefined;
  }

  #defaultQueryType(): QueryType {
    const storedQueryType = localStorage.getItem(QUERY_TYPE_STORAGE_KEY) as QueryType;
    return validQueryTypes.has(storedQueryType) ? storedQueryType : QueryType.SMART;
  }
}

export const searchManager = new SearchManager();
