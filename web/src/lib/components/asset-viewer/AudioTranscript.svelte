<script lang="ts">
  import { copyToClipboard } from '#lib/utils.ts';
  import { formatAudioDuration } from '#lib/utils/audio.ts';
  import type { AudioTranscriptDto } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiContentCopy } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    transcript: AudioTranscriptDto;
    onSeek: (timeMs: number) => void;
  }

  let { transcript, onSeek }: Props = $props();
</script>

<section class="w-full border-t border-slate-600 pt-4" aria-label={$t('audio_transcript')}>
  <div class="mb-3 flex items-center justify-between gap-2">
    <h2 class="font-medium">{$t('audio_transcript')}</h2>
    {#if transcript.text}
      <IconButton
        icon={mdiContentCopy}
        aria-label={$t('copy_to_clipboard')}
        onclick={() => copyToClipboard(transcript.text)}
        variant="ghost"
        color="secondary"
        shape="round"
      />
    {/if}
  </div>
  <div class="max-h-52 overflow-y-auto text-sm/relaxed select-text">
    {#if transcript.segments.length > 0}
      {#each transcript.segments as segment, index (index)}
        <div class="mb-3 flex items-start gap-3">
          <button
            type="button"
            class="shrink-0 rounded-sm px-1 font-mono text-sky-300 underline underline-offset-4 hover:text-white focus-visible:outline-2"
            aria-label="{$t('audio_seek')} {formatAudioDuration(segment.startMs)}"
            onclick={() => onSeek(segment.startMs)}
            onkeydown={(event) => {
              if (event.key.startsWith('Arrow')) {
                event.stopPropagation();
              }
            }}
          >
            {formatAudioDuration(segment.startMs)}
          </button>
          <p class="min-w-0 wrap-break-word whitespace-pre-wrap">{segment.text}</p>
        </div>
      {/each}
    {:else if transcript.text}
      <p class="wrap-break-word whitespace-pre-wrap">{transcript.text}</p>
    {:else}
      <p class="text-slate-300">{$t('audio_transcript_empty')}</p>
    {/if}
  </div>
</section>
