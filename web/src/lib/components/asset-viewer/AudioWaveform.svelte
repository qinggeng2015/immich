<script lang="ts">
  import { formatAudioDuration } from '#lib/utils/audio.ts';
  import { getWaveformBars } from '#lib/utils/waveform.ts';
  import { t } from 'svelte-i18n';

  interface Props {
    peaks: number[];
    durationMs: number;
    currentTimeMs: number;
    onSeek: (timeMs: number) => void;
  }

  let { peaks, durationMs, currentTimeMs, onSeek }: Props = $props();

  const clipId = $props.id();
  const bars = $derived(getWaveformBars(peaks));
  const duration = $derived(Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0);
  const currentTime = $derived(Number.isFinite(currentTimeMs) ? Math.max(0, Math.min(duration, currentTimeMs)) : 0);
  const progress = $derived(duration > 0 ? currentTime / duration : 0);
  const path = $derived(
    bars
      .map((peak, index) => {
        const height = Math.max(1, peak * 38);
        return `M${index + 0.5} ${40 - height}v${height * 2}`;
      })
      .join(' '),
  );
</script>

<div
  class="relative w-full rounded-md focus-within:outline-2 focus-within:outline-offset-4"
  dir="ltr"
  data-audio-waveform
>
  <svg class="h-24 w-full" viewBox="0 0 {Math.max(1, bars.length)} 80" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <clipPath id={clipId}>
        <rect width={bars.length * progress} height="80" />
      </clipPath>
    </defs>
    <path d={path} stroke="currentColor" stroke-width="0.7" class="text-slate-500" />
    <path d={path} stroke="currentColor" stroke-width="0.7" clip-path="url(#{clipId})" class="text-white" />
  </svg>
  <input
    type="range"
    min="0"
    max={Math.max(1, duration)}
    step="100"
    value={currentTime}
    disabled={duration === 0}
    aria-label={$t('audio_seek')}
    aria-valuetext="{formatAudioDuration(currentTime)} / {formatAudioDuration(duration)}"
    class="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
    oninput={(event) => onSeek(event.currentTarget.valueAsNumber)}
    onkeydown={(event) => {
      if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
        event.stopPropagation();
      }
    }}
  />
</div>
