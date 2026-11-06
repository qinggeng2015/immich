import { audioSummaryConfig } from '#test/medium/mock/audio-summary.ts';
import { renderWithTooltips } from '#test/unit/helpers.ts';
import AudioSummarySettings from './AudioSummarySettings.svelte';

describe('AudioSummarySettings', () => {
  it('never populates the key input with a stored API key', () => {
    const saved = audioSummaryConfig({ apiKey: 'stored-secret-must-not-be-rendered' });
    const { container, queryByText } = renderWithTooltips(AudioSummarySettings, {
      saved,
      value: structuredClone(saved),
      disabled: false,
    });

    const keyInput = container.querySelector<HTMLInputElement>(':scope input[type="password"]');
    expect(keyInput).not.toBeNull();
    expect(keyInput?.value).toBe('');
    expect(queryByText('stored-secret-must-not-be-rendered')).toBeNull();
  });

  it('requires disabling summaries before removing the saved key', () => {
    const saved = audioSummaryConfig({ enabled: true });
    const { getByRole, getByText } = renderWithTooltips(AudioSummarySettings, {
      saved,
      value: structuredClone(saved),
      disabled: false,
    });

    expect((getByRole('button', { name: 'admin.audio_summary_api_key_clear' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(getByText('admin.audio_summary_api_key_clear_description')).toBeTruthy();
  });
});
