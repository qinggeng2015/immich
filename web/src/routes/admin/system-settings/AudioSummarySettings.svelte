<script lang="ts">
  import OnEvents from '#lib/components/OnEvents.svelte';
  import SettingInputField from '#lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '#lib/components/shared-components/settings/SettingSwitch.svelte';
  import { SettingInputFieldType } from '#lib/constants.ts';
  import type { AdminConfigDto } from '@immich/sdk';
  import { Button } from '@immich/ui';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import SettingSelect from './SettingSelect.svelte';
  import SettingTextarea from './SettingTextarea.svelte';

  type SummaryConfig = NonNullable<AdminConfigDto['machineLearning']['audioSummary']>;
  let {
    saved,
    value = $bindable(),
    disabled,
  }: { saved: SummaryConfig; value: SummaryConfig; disabled: boolean } = $props();
  let apiKeyInput = $state('');
  const presets = $derived([
    {
      value: 'concise',
      text: $t('admin.audio_summary_prompt_concise'),
      prompt: $t('admin.audio_summary_prompt_concise_text'),
    },
    {
      value: 'meeting',
      text: $t('admin.audio_summary_prompt_meeting'),
      prompt: $t('admin.audio_summary_prompt_meeting_text'),
    },
    {
      value: 'study',
      text: $t('admin.audio_summary_prompt_study'),
      prompt: $t('admin.audio_summary_prompt_study_text'),
    },
  ]);
  const preset = $derived(presets.find(({ prompt }) => prompt === value.prompt)?.value ?? 'custom');

  const resetApiKey = (latest: SummaryConfig, editing: SummaryConfig = value) => {
    apiKeyInput = '';
    editing.apiKey = '';
    editing.clearApiKey = false;
    editing.apiKeyConfigured = latest.apiKeyConfigured;
  };

  $effect(() => {
    const latest = saved;
    const editing = value;
    untrack(() => resetApiKey(latest, editing));
  });
</script>

<OnEvents
  onSystemConfigUpdate={(config) => {
    if (config.machineLearning.audioSummary) {
      resetApiKey(config.machineLearning.audioSummary);
    }
  }}
/>

<div class="mt-4 ml-4 flex flex-col gap-4">
  <SettingSwitch
    title={$t('admin.audio_summary_enabled')}
    subtitle={$t('admin.audio_summary_enabled_description')}
    bind:checked={value.enabled}
    {disabled}
  />
  <SettingSwitch
    title={$t('admin.audio_summary_automatic')}
    subtitle={$t('admin.audio_summary_automatic_description')}
    bind:checked={value.autoSummarize}
    disabled={disabled || !value.enabled}
  />
  <SettingInputField
    inputType={SettingInputFieldType.TEXT}
    label={$t('admin.audio_summary_base_url')}
    description={$t('admin.audio_summary_base_url_description')}
    bind:value={value.baseUrl}
    required
    {disabled}
    isEdited={value.baseUrl !== saved.baseUrl}
  />
  <div>
    <SettingInputField
      inputType={SettingInputFieldType.PASSWORD}
      label={$t('admin.audio_summary_api_key')}
      description={$t('admin.audio_summary_api_key_description')}
      passwordAutocomplete="new-password"
      bind:value={
        () => apiKeyInput,
        (key) => {
          apiKeyInput = key;
          value.apiKey = key;
          value.clearApiKey = false;
        }
      }
      {disabled}
      isEdited={Boolean(value.apiKey) || value.clearApiKey === true}
    />
    <p class="text-sm" role="status">
      {#if value.clearApiKey}
        {$t('admin.audio_summary_api_key_clear_pending')}
      {:else if saved.apiKeyConfigured}
        {$t('admin.audio_summary_api_key_configured')}
      {:else}
        {$t('admin.audio_summary_api_key_not_configured')}
      {/if}
    </p>
    {#if saved.apiKeyConfigured}
      {#if value.enabled}
        <p class="mt-2 text-sm">{$t('admin.audio_summary_api_key_clear_description')}</p>
      {/if}
      <Button
        class="mt-2"
        size="small"
        variant="ghost"
        shape="round"
        disabled={disabled || value.enabled}
        onclick={() => {
          apiKeyInput = '';
          value.apiKey = '';
          value.clearApiKey = !value.clearApiKey;
        }}
      >
        {value.clearApiKey ? $t('admin.audio_summary_api_key_undo_clear') : $t('admin.audio_summary_api_key_clear')}
      </Button>
    {/if}
  </div>
  <SettingInputField
    inputType={SettingInputFieldType.TEXT}
    label={$t('admin.audio_summary_model')}
    description={$t('admin.audio_summary_model_description')}
    bind:value={value.modelName}
    required
    {disabled}
    isEdited={value.modelName !== saved.modelName}
  />
  <SettingSelect
    label={$t('admin.audio_summary_protocol')}
    name="audio-summary-protocol"
    options={[
      { value: 'chat-completions', text: $t('admin.audio_summary_protocol_chat') },
      { value: 'responses', text: $t('admin.audio_summary_protocol_responses') },
    ]}
    bind:value={value.protocol}
    {disabled}
    isEdited={value.protocol !== saved.protocol}
  />
  <SettingSelect
    label={$t('admin.audio_summary_prompt_preset')}
    desc={$t('admin.audio_summary_prompt_preset_description')}
    name="audio-summary-prompt-preset"
    value={preset}
    options={[{ value: 'custom', text: $t('admin.audio_summary_prompt_custom') }, ...presets]}
    onSelect={(selected) => {
      const template = presets.find(({ value }) => value === selected);
      if (template) {
        value.prompt = template.prompt;
      }
    }}
    {disabled}
  />
  <SettingTextarea
    label={$t('admin.audio_summary_prompt')}
    description={$t('admin.audio_summary_prompt_description')}
    bind:value={value.prompt}
    required
    {disabled}
    isEdited={value.prompt !== saved.prompt}
  />
</div>
