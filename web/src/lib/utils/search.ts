import { AssetTypeEnum, type MetadataSearchDto, type SmartSearchDto } from '@immich/sdk';

export type SearchQuery = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;

export const normalizeAudioSearchQuery = (
  searchQuery: SearchQuery,
  supportsAudio: boolean,
  supportsSpeechToText = false,
): SearchQuery => {
  if (!supportsSpeechToText && 'transcript' in searchQuery) {
    const { transcript, ...metadata } = searchQuery;
    const hasText =
      metadata.originalFileName || metadata.originalPath || metadata.description || metadata.query || metadata.ocr;
    searchQuery = { ...metadata, ...(!hasText && transcript && { originalFileName: transcript }) };
  }

  if (supportsSpeechToText && searchQuery.transcript) {
    searchQuery = { ...searchQuery };
    delete searchQuery.query;
    delete searchQuery.queryAssetId;
    delete searchQuery.ocr;
  }

  if (searchQuery.type !== AssetTypeEnum.Audio) {
    return searchQuery;
  }

  const { query, queryAssetId: _, ocr, type, ...metadata } = searchQuery;
  const fileName =
    metadata.originalFileName || metadata.originalPath || metadata.description || metadata.transcript
      ? undefined
      : query || ocr;

  return {
    ...metadata,
    ...(supportsAudio && { type }),
    ...(fileName && { originalFileName: fileName }),
  };
};
