import { AssetType } from 'src/enum.js';

export const CLIENT_FEATURES_HEADER = 'x-immich-features';

const supportsFeature = (features: unknown, feature: string): boolean => {
  const values = Array.isArray(features) ? features : [features];
  return values.some((value) => typeof value === 'string' && value.split(',').some((item) => item.trim() === feature));
};

export const supportsAudio = (features: unknown): boolean => supportsFeature(features, 'audio');

export const supportsAudioAnalysis = (features: unknown): boolean => supportsFeature(features, 'audio-analysis');

export const supportsAudioSummary = (features: unknown): boolean => supportsFeature(features, 'audio-summary');

const assetContainerKeys = new Set(['asset', 'assets', 'items', 'data']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;

const isAssetResponse = (value: Record<string, unknown>): boolean =>
  typeof value.id === 'string' &&
  (typeof value.originalMimeType === 'string' ||
    (typeof value.originalFileName === 'string' && typeof value.checksum === 'string'));

const isMetadataResponse = (value: Record<string, unknown>): boolean =>
  typeof value.key === 'string' && Object.hasOwn(value, 'value');

export const hasAudioAsset = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => hasAudioAsset(item));
  }

  const record = asRecord(value);
  if (!record || isMetadataResponse(record)) {
    return false;
  }

  if (isAssetResponse(record)) {
    return record.type === AssetType.Audio;
  }

  return Object.entries(record).some(([key, item]) => assetContainerKeys.has(key) && hasAudioAsset(item));
};

export const withLegacyAssetTypes = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => withLegacyAssetTypes(item)) as T;
  }

  const record = asRecord(value);
  if (!record || isMetadataResponse(record)) {
    return value;
  }

  if (isAssetResponse(record)) {
    return record.type === AssetType.Audio ? { ...value, type: AssetType.Other } : value;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, assetContainerKeys.has(key) ? withLegacyAssetTypes(item) : item]),
  ) as T;
};
