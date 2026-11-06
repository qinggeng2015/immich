<script lang="ts">
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { getAssetAudioSummaryQuery, runAudioAssetJobMutation } from '#lib/queries/asset-audio.query.ts';
  import { queryClient } from '#lib/queries/client.ts';
  import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
  import { copyToClipboard } from '#lib/utils.ts';
  import { AssetJobName, type AssetResponseDto } from '@immich/sdk';
  import { Button, IconButton } from '@immich/ui';
  import { mdiContentCopy, mdiRefresh } from '@mdi/js';
  import { createMutation, createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  let { asset, hasTranscript }: { asset: AssetResponseDto; hasTranscript: boolean } = $props();
  const query = createQuery(
    () => getAssetAudioSummaryQuery(asset.id),
    () => queryClient,
  );
  const configQuery = createQuery(
    () => ({ ...getUserConfigQuery(), enabled: authManager.authenticated }),
    () => queryClient,
  );
  const generate = createMutation(
    () => runAudioAssetJobMutation(AssetJobName.SummarizeAudio, [asset.id]),
    () => queryClient,
  );
  const summary = $derived(query.data?.summary);
  const status = $derived(query.data?.status);
  const processing = $derived(status === 'pending' || status === 'processing');
  const canGenerate = $derived(
    authManager.authenticated &&
      asset.ownerId === authManager.user.id &&
      configQuery.data?.machineLearning.audioSummary?.enabled,
  );
</script>

<section class="w-full border-t border-slate-600 pt-4" aria-label={$t('audio_summary')}>
  <div class="mb-3 flex items-center justify-between gap-2">
    <h2 class="font-medium">{$t('audio_summary')}</h2>
    {#if summary?.text}
      <IconButton
        icon={mdiContentCopy}
        aria-label={$t('copy_to_clipboard')}
        onclick={() => copyToClipboard(summary.text)}
        variant="ghost"
        color="secondary"
        shape="round"
      />
    {/if}
  </div>
  {#if summary}
    <p class="max-h-64 overflow-y-auto text-sm/relaxed wrap-break-word whitespace-pre-wrap select-text">
      {summary.text || $t('audio_summary_empty')}
    </p>
  {/if}
  {#if status !== 'ready' || query.isError}
    <div class="mt-3 flex items-center justify-between gap-2 text-sm text-slate-300">
      <p>
        {#if query.isError || status === 'failed'}
          {$t('audio_summary_failed')}
        {:else if status === 'pending'}
          {$t('audio_summary_pending')}
        {:else if status === 'processing' || query.isLoading}
          {$t('audio_summary_processing')}
        {:else if status === 'disabled'}
          {$t('audio_summary_disabled')}
        {:else}
          {$t('audio_summary_unavailable')}
        {/if}
      </p>
      <IconButton
        icon={mdiRefresh}
        aria-label={$t('refresh')}
        onclick={() => query.refetch()}
        disabled={query.isFetching}
        variant="ghost"
        color="secondary"
        shape="round"
      />
    </div>
  {/if}
  {#if canGenerate}
    {#if hasTranscript}
      <Button
        class="mt-3"
        size="small"
        shape="round"
        disabled={generate.isPending || processing}
        onclick={() => generate.mutate()}
      >
        {summary ? $t('regenerate_audio_summary') : $t('generate_audio_summary')}
      </Button>
    {:else}
      <p class="mt-3 text-sm text-slate-300">{$t('audio_summary_requires_transcript')}</p>
    {/if}
  {/if}
</section>
