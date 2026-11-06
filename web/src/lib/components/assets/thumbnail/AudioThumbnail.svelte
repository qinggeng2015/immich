<script lang="ts">
  import { formatAudioDuration } from '#lib/utils/audio.ts';
  import { Icon } from '@immich/ui';
  import { mdiPlayCircleOutline } from '@mdi/js';

  interface Props {
    duration: number | null;
    label: string;
    curve?: boolean;
  }

  let { duration, label, curve = false }: Props = $props();
</script>

<div
  role="img"
  aria-label={label}
  class="absolute flex size-full flex-col items-center justify-center gap-2 bg-slate-700 text-white group-focus-visible:rounded-lg"
  class:rounded-xl={curve}
  data-audio-thumbnail
>
  <Icon icon={mdiPlayCircleOutline} size="48" />
  <span class="text-sm tabular-nums">{formatAudioDuration(duration)}</span>
</div>
