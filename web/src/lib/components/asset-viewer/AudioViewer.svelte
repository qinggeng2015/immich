<script lang="ts">
  import AudioTranscript from '#lib/components/asset-viewer/AudioTranscript.svelte';
  import AudioSummary from '#lib/components/asset-viewer/AudioSummary.svelte';
  import AudioWaveform from '#lib/components/asset-viewer/AudioWaveform.svelte';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
  import {
    assetAudioQueryKey,
    getAssetAudioTranscriptQuery,
    getAssetAudioWaveformQuery,
    runAudioAssetJobMutation,
  } from '#lib/queries/asset-audio.query.ts';
  import { queryClient } from '#lib/queries/client.ts';
  import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
  import { getAssetPlaybackUrl } from '#lib/utils.ts';
  import { formatAudioDuration } from '#lib/utils/audio.ts';
  import { AssetJobName, type AssetResponseDto } from '@immich/sdk';
  import { Button, IconButton } from '@immich/ui';
  import { mdiPauseCircleOutline, mdiPlayCircleOutline, mdiRefresh } from '@mdi/js';
  import { createMutation, createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    autoplay?: boolean;
    onStarted?: () => void;
    onEnded?: () => void;
  }

  let { asset, autoplay = false, onStarted, onEnded }: Props = $props();
  let player: HTMLAudioElement | undefined = $state();
  let paused = $state(true);
  let failed = $state(false);
  let currentTimeMs = $state(0);
  let loadedDurationMs = $state<number>();
  let pendingSeekMs = $state<number>();

  const waveformQuery = createQuery(
    () => getAssetAudioWaveformQuery(asset.id),
    () => queryClient,
  );
  const transcriptQuery = createQuery(
    () => getAssetAudioTranscriptQuery(asset.id),
    () => queryClient,
  );
  const configQuery = createQuery(
    () => ({ ...getUserConfigQuery(), enabled: authManager.authenticated }),
    () => queryClient,
  );
  const generateWaveform = createMutation(
    () => runAudioAssetJobMutation(AssetJobName.GenerateWaveform, [asset.id]),
    () => queryClient,
  );
  const transcribeAudio = createMutation(
    () => runAudioAssetJobMutation(AssetJobName.TranscribeAudio, [asset.id]),
    () => queryClient,
  );
  const waveform = $derived(waveformQuery.data?.waveform);
  const transcript = $derived(transcriptQuery.data?.transcript);
  const durationMs = $derived(loadedDurationMs ?? waveform?.durationMs ?? asset.duration ?? NaN);
  const showTranscript = $derived(featureFlagsManager.supportsSpeechToText && !authManager.isSharedLink);
  const isOwner = $derived(authManager.authenticated && asset.ownerId === authManager.user.id);

  $effect(() => {
    if (
      !transcriptQuery.dataUpdatedAt ||
      transcriptQuery.data?.status !== 'ready' ||
      !transcript?.text.trim() ||
      !featureFlagsManager.supportsAudioSummary ||
      authManager.isSharedLink ||
      !configQuery.data?.machineLearning.audioSummary?.enabled ||
      !configQuery.data.machineLearning.audioSummary.autoSummarize
    ) {
      return;
    }
    const id = asset.id;
    const summaryRefreshTimers = [0, 2000, 5000].map((delay) =>
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...assetAudioQueryKey, id, 'summary'] }), delay),
    );
    return () => {
      for (const timer of summaryRefreshTimers) {
        clearTimeout(timer);
      }
    };
  });

  const seek = (timeMs: number) => {
    if (!player || !Number.isFinite(timeMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    const time = Math.max(0, Math.min(durationMs, timeMs));
    if (player.readyState === 0) {
      pendingSeekMs = time;
      return;
    }
    player.currentTime = time / 1000;
    currentTimeMs = time;
  };

  const updateDuration = () => {
    if (player && Number.isFinite(player.duration) && player.duration > 0) {
      loadedDurationMs = player.duration * 1000;
    }
    if (pendingSeekMs !== undefined && player && player.readyState > 0) {
      seek(pendingSeekMs);
      pendingSeekMs = undefined;
    }
  };

  $effect(() => {
    const audio = player;
    return () => {
      audio?.pause();
      audio?.removeAttribute('src');
      audio?.load();
    };
  });

  const togglePlayback = async () => {
    if (!player) {
      return;
    }
    if (!player.paused) {
      player.pause();
      return;
    }
    try {
      if (failed) {
        player.load();
      }
      failed = false;
      await player.play();
    } catch {
      failed = true;
    }
  };
</script>

<div class="flex size-full items-center justify-center p-4 sm:p-12">
  <div
    class="dark flex max-h-full w-full max-w-lg flex-col items-center gap-5 overflow-y-auto rounded-2xl bg-slate-800 p-8 text-white"
  >
    <IconButton
      icon={paused ? mdiPlayCircleOutline : mdiPauseCircleOutline}
      aria-label={paused ? $t('play') : $t('pause')}
      onclick={togglePlayback}
      size="large"
      variant="ghost"
      color="secondary"
      shape="round"
    />
    <p class="max-w-full truncate text-lg">{asset.originalFileName}</p>
    <p class="tabular-nums">{formatAudioDuration(durationMs)}</p>
    {#if waveform?.peaks.length}
      <AudioWaveform peaks={waveform.peaks} {durationMs} {currentTimeMs} onSeek={seek} />
    {:else if featureFlagsManager.supportsAudioWaveform}
      <div class="flex w-full items-center justify-between gap-2 text-sm text-slate-300">
        <p>
          {waveformQuery.data?.status === 'processing' || waveformQuery.isLoading
            ? $t('audio_waveform_generating')
            : $t('audio_waveform_unavailable')}
        </p>
        <IconButton
          icon={mdiRefresh}
          aria-label={$t('refresh')}
          onclick={() => waveformQuery.refetch()}
          disabled={waveformQuery.isFetching}
          variant="ghost"
          color="secondary"
          shape="round"
        />
      </div>
      {#if isOwner && (waveformQuery.data?.status === 'unprocessed' || waveformQuery.data?.status === 'failed')}
        <Button
          onclick={() => generateWaveform.mutate()}
          disabled={generateWaveform.isPending}
          size="small"
          shape="round"
        >
          {$t('generate_audio_waveform')}
        </Button>
      {/if}
    {/if}
    <audio
      bind:this={player}
      src={getAssetPlaybackUrl({ id: asset.id, cacheKey: asset.thumbhash })}
      controls
      {autoplay}
      preload="metadata"
      class="w-full"
      aria-label={$t('audio')}
      onloadedmetadata={updateDuration}
      ondurationchange={updateDuration}
      ontimeupdate={() => (currentTimeMs = (player?.currentTime ?? 0) * 1000)}
      onplay={() => {
        paused = false;
        failed = false;
        onStarted?.();
      }}
      onkeydown={(event) => {
        if (event.key.startsWith('Arrow')) {
          event.stopPropagation();
        }
      }}
      onpause={() => (paused = true)}
      onended={onEnded}
      onerror={() => (failed = true)}
    ></audio>
    {#if failed}
      <p role="alert">{$t('audio_playback_failed')}</p>
    {/if}
    {#if showTranscript}
      {#if transcript}
        <AudioTranscript {transcript} onSeek={seek} />
      {/if}
      {#if transcriptQuery.data?.status !== 'ready' || transcriptQuery.isError}
        <div class="flex w-full items-center justify-between gap-2 text-sm text-slate-300">
          <p>
            {#if transcriptQuery.isError || transcriptQuery.data?.status === 'failed'}
              {$t('audio_transcript_failed')}
            {:else if transcriptQuery.data?.status === 'disabled'}
              {$t('audio_transcript_disabled')}
            {:else if transcriptQuery.data?.status === 'processing'}
              {$t('audio_transcript_processing')}
            {:else if transcriptQuery.data?.status === 'pending' || transcriptQuery.isLoading}
              {$t('audio_transcript_pending')}
            {:else}
              {$t('audio_transcript_unavailable')}
            {/if}
          </p>
          <IconButton
            icon={mdiRefresh}
            aria-label={$t('refresh')}
            onclick={() => transcriptQuery.refetch()}
            disabled={transcriptQuery.isFetching}
            variant="ghost"
            color="secondary"
            shape="round"
          />
        </div>
        {#if isOwner && configQuery.data?.machineLearning.speechToText?.enabled && (transcriptQuery.data?.status === 'unprocessed' || transcriptQuery.data?.status === 'failed')}
          <Button
            onclick={() => transcribeAudio.mutate()}
            disabled={transcribeAudio.isPending}
            size="small"
            shape="round"
          >
            {$t('transcribe_audio')}
          </Button>
        {/if}
      {/if}
    {/if}
    {#if featureFlagsManager.supportsAudioSummary && !authManager.isSharedLink}
      <AudioSummary {asset} hasTranscript={Boolean(transcript?.text.trim())} />
    {/if}
  </div>
</div>
