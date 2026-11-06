<script lang="ts">
  import { MediaType, QueryType } from '#lib/constants.ts';
  import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { searchManager } from '#lib/managers/search-manager.svelte.ts';
  import SearchButton from './SearchButton.svelte';

  let filteredMedia = $derived(searchManager.filter.mediaType);
</script>

<div id="media-type-selection">
  <fieldset>
    <Text class="pb-5">{$t('media_type_description')}</Text>

    <div class="flex flex-wrap gap-2">
      <SearchButton
        checked
        active={filteredMedia === MediaType.All}
        onclick={() => (searchManager.filter.mediaType = MediaType.All)}
      >
        {$t('all')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Image}
        onclick={() => (searchManager.filter.mediaType = MediaType.Image)}
      >
        {$t('image')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Video}
        onclick={() => (searchManager.filter.mediaType = MediaType.Video)}
      >
        {$t('video')}
      </SearchButton>
      {#if featureFlagsManager.supportsAudio}
        <SearchButton
          checked
          active={filteredMedia === MediaType.Audio}
          onclick={() => {
            searchManager.filter.mediaType = MediaType.Audio;
            if (
              searchManager.filter.queryType === QueryType.SMART ||
              searchManager.filter.queryType === QueryType.OCR
            ) {
              searchManager.filter.queryType = QueryType.METADATA;
            }
          }}
        >
          {$t('audio')}
        </SearchButton>
      {/if}
    </div>
  </fieldset>
</div>
