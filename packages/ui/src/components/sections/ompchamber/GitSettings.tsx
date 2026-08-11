import React from 'react';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  SettingsSection,
  SettingsControlGroup,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const GitSettings: React.FC = () => {
  const { t } = useI18n();
  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const setSettingsGitmojiEnabled = useConfigStore((state) => state.setSettingsGitmojiEnabled);
  const showGitignored = useFilesViewShowGitignored();
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const setGitChangesViewMode = useUIStore((state) => state.setGitChangesViewMode);

  const [isLoading, setIsLoading] = React.useState(true);
  const viewOptions = React.useMemo(
    () => [
      { id: 'flat' as const, label: t('settings.ompchamber.git.option.flatList') },
      { id: 'tree' as const, label: t('settings.ompchamber.git.option.treeView') },
    ],
    [t]
  );

  type GitSettingsPayload = {
    gitmojiEnabled?: boolean;
    gitChangesViewMode?: 'flat' | 'tree';
  };

  // Load current settings
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: GitSettingsPayload | null = null;

        // 1. Runtime settings API (VSCode)
        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                data = {
                  gitmojiEnabled: typeof (settings as Record<string, unknown>).gitmojiEnabled === 'boolean'
                    ? ((settings as Record<string, unknown>).gitmojiEnabled as boolean)
                    : undefined,
                  gitChangesViewMode:
                    (settings as Record<string, unknown>).gitChangesViewMode === 'flat'
                    || (settings as Record<string, unknown>).gitChangesViewMode === 'tree'
                      ? ((settings as Record<string, unknown>).gitChangesViewMode as 'flat' | 'tree')
                      : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        // 2. Fetch API (Web/server)
        if (!data) {
          const response = await runtimeFetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

        if (data) {
          if (typeof data.gitmojiEnabled === 'boolean') {
            setSettingsGitmojiEnabled(data.gitmojiEnabled);
          }
          if (data.gitChangesViewMode === 'flat' || data.gitChangesViewMode === 'tree') {
            setGitChangesViewMode(data.gitChangesViewMode);
          }
        }

      } catch (error) {
        console.warn('Failed to load git settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setGitChangesViewMode, setSettingsGitmojiEnabled]);

  const handleGitmojiChange = React.useCallback(async (enabled: boolean) => {
    setSettingsGitmojiEnabled(enabled);
    try {
      await updateDesktopSettings({
        gitmojiEnabled: enabled,
      });
    } catch (error) {
      console.warn('Failed to save gitmoji setting:', error);
    }
  }, [setSettingsGitmojiEnabled]);

  const handleGitChangesViewModeChange = React.useCallback((mode: 'flat' | 'tree') => {
    if (mode === gitChangesViewMode) {
      return;
    }

    setGitChangesViewMode(mode);
    void updateDesktopSettings({ gitChangesViewMode: mode });
  }, [gitChangesViewMode, setGitChangesViewMode]);

  if (isLoading) {
    return null;
  }

  return (
    <SettingsSection title={t('settings.ompchamber.git.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsControlGroup
          settingsItem="git.changes-view"
          title={t('settings.ompchamber.git.changesViewTitle')}
        >
          <SettingsRadioGroup aria-label={t('settings.ompchamber.git.changesViewAria')}>
            {viewOptions.map((option) => (
              <SettingsRadioOption
                key={option.id}
                selected={gitChangesViewMode === option.id}
                onSelect={() => {
                  handleGitChangesViewModeChange(option.id);
                }}
                label={option.label}
                ariaLabel={t('settings.ompchamber.git.optionAria', { option: option.label })}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>

        <SettingsCheckboxRow
          settingsItem="git.gitmoji"
          checked={settingsGitmojiEnabled}
          onChange={(checked) => {
            void handleGitmojiChange(checked);
          }}
          label={t('settings.ompchamber.git.enableGitmoji')}
          ariaLabel={t('settings.ompchamber.git.enableGitmojiAria')}
        />

        <SettingsCheckboxRow
          settingsItem="git.gitignored-files"
          checked={showGitignored}
          onChange={setFilesViewShowGitignored}
          label={t('settings.ompchamber.git.showGitignored')}
          ariaLabel={t('settings.ompchamber.git.showGitignoredAria')}
        />
      </div>
    </SettingsSection>
  );
};
