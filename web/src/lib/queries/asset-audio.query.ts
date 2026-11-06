import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
import { queryClient } from '#lib/queries/client.ts';
import {
  AssetJobName,
  getAssetAudioSummary,
  getAssetAudioTranscript,
  getAssetAudioWaveform,
  runAssetJobs,
} from '@immich/sdk';
import { mutationOptions, queryOptions } from '@tanstack/svelte-query';

export const assetAudioQueryKey = ['asset-audio'];

export const runAudioAssetJobMutation = (
  name: AssetJobName.GenerateWaveform | AssetJobName.TranscribeAudio | AssetJobName.SummarizeAudio,
  assetIds: string[],
) =>
  mutationOptions({
    mutationFn: () => runAssetJobs({ assetJobsDto: { name, assetIds } }),
    onSuccess: () =>
      Promise.all(assetIds.map((id) => queryClient.invalidateQueries({ queryKey: [...assetAudioQueryKey, id] }))),
    meta: { success: { toast: 'enqueued' }, error: { toast: 'errors.unable_to_submit_job' } },
  });

export const getAssetAudioWaveformQuery = (id: string) =>
  queryOptions({
    queryKey: [...assetAudioQueryKey, id, 'waveform', authManager.params],
    queryFn: ({ signal }) => getAssetAudioWaveform({ ...authManager.params, id }, { signal }),
    enabled: featureFlagsManager.supportsAudioWaveform,
    staleTime: 30_000,
    refetchOnMount: 'always',
    refetchInterval: ({ state }) =>
      state.data?.status === 'pending' || state.data?.status === 'processing'
        ? state.dataUpdateCount < 6
          ? 5000
          : 30_000
        : false,
  });

export const getAssetAudioTranscriptQuery = (id: string) =>
  queryOptions({
    queryKey: [...assetAudioQueryKey, id, 'transcript'],
    queryFn: ({ signal }) => getAssetAudioTranscript({ id }, { signal }),
    enabled: featureFlagsManager.supportsSpeechToText && !authManager.isSharedLink,
    staleTime: 30_000,
    refetchOnMount: 'always',
    refetchInterval: ({ state }) =>
      state.data?.status === 'pending' || state.data?.status === 'processing'
        ? state.dataUpdateCount < 6
          ? 5000
          : 30_000
        : false,
  });

export const getAssetAudioSummaryQuery = (id: string) =>
  queryOptions({
    queryKey: [...assetAudioQueryKey, id, 'summary'],
    queryFn: ({ signal }) => getAssetAudioSummary({ id }, { signal }),
    enabled: featureFlagsManager.supportsAudioSummary && !authManager.isSharedLink,
    staleTime: 30_000,
    refetchOnMount: 'always',
    refetchInterval: ({ state }) =>
      state.data?.status === 'pending' || state.data?.status === 'processing'
        ? state.dataUpdateCount < 6
          ? 5000
          : 30_000
        : false,
  });
