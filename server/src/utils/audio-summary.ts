import { createHash } from 'node:crypto';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { getAudioSummaryConfig, isAudioSummaryEnabled } from 'src/utils/misc.js';

export const getAudioSummaryConfigHash = (machineLearning: SystemConfig['machineLearning']) => {
  const { autoSummarize, baseUrl, apiKey, modelName, prompt, protocol, maxOutputTokens, timeoutMs } =
    getAudioSummaryConfig(machineLearning);
  return createHash('sha256')
    .update(
      JSON.stringify({
        enabled: isAudioSummaryEnabled(machineLearning),
        autoSummarize,
        baseUrl,
        apiKey,
        modelName,
        prompt,
        protocol,
        maxOutputTokens,
        timeoutMs,
      }),
    )
    .digest('hex');
};

export const isCurrentAudioSource = (
  checksum: Buffer | null | undefined,
  sourceModifiedAt: Date | null | undefined,
  asset: { checksum: Buffer; fileModifiedAt: Date },
) => !!checksum && checksum.equals(asset.checksum) && sourceModifiedAt?.getTime() === asset.fileModifiedAt.getTime();
