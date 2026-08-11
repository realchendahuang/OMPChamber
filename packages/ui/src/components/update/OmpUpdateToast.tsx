import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { reloadOmpConfiguration } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { updateDesktopSettings } from '@/lib/persistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import {
  resolveOmpUpdateVersion,
  resolveOmpUpgradeStatusVersion,
  shouldShowOmpUpdateToast,
  type OmpUpgradeStatusLike,
} from './ompUpdateDedup';

const UPDATE_TOAST_ID = 'omp-update-available';
const UPGRADE_TOAST_ID = 'omp-upgrade-progress';
const INITIAL_CHECK_DELAY_MS = 5_000;
const CHECK_RETRY_DELAYS_MS = [10_000, 60_000];
const UPDATE_TOAST_DISMISSED_VERSION_KEY = 'opencode-update-toast-dismissed-version';

export const OmpUpdateToast: React.FC = () => {
  const { t } = useI18n();
  const showOpenCodeUpdateNotifications = useUIStore((state) => state.showOpenCodeUpdateNotifications);
  const seenVersionsRef = React.useRef(new Set<string>());
  const upgradingRef = React.useRef(false);

  React.useEffect(() => {
    if (!showOpenCodeUpdateNotifications) {
      toast.dismiss(UPDATE_TOAST_ID);
    }
  }, [showOpenCodeUpdateNotifications]);

  const reloadOmp = React.useCallback(() => {
    toast.dismiss(UPGRADE_TOAST_ID);
    void reloadOmpConfiguration({
      message: t('ompUpdate.toast.reload.message'),
      mode: 'projects',
      scopes: ['all'],
    }).catch(() => undefined);
  }, [t]);

  const runUpgrade = React.useCallback(async () => {
    if (upgradingRef.current) return;
    upgradingRef.current = true;
    toast.dismiss(UPDATE_TOAST_ID);
    toast.message(t('ompUpdate.toast.upgrading.title'), {
      id: UPGRADE_TOAST_ID,
      description: t('ompUpdate.toast.upgrading.description'),
      duration: Infinity,
      icon: <Icon name="refresh" className="h-4 w-4 animate-spin text-muted-foreground" />,
    });

    try {
      const response = await runtimeFetch('/api/omp/upgrade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => null) as null | { success?: boolean; version?: string; error?: string };
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || response.statusText || t('ompUpdate.toast.failed.description'));
      }

      toast.success(t('ompUpdate.toast.updated.title'), {
        id: UPGRADE_TOAST_ID,
        description: payload?.version
          ? t('ompUpdate.toast.updated.descriptionWithVersion', { version: payload.version })
          : t('ompUpdate.toast.updated.description'),
        duration: Infinity,
        icon: <Icon name="check" className="h-4 w-4 text-[var(--status-success)]" />,
        action: {
          label: t('ompUpdate.toast.actions.reload'),
          onClick: reloadOmp,
        },
      });
    } catch (error) {
      toast.error(t('ompUpdate.toast.failed.title'), {
        id: UPGRADE_TOAST_ID,
        description: error instanceof Error ? error.message : t('ompUpdate.toast.failed.description'),
        duration: Infinity,
      });
    } finally {
      upgradingRef.current = false;
    }
  }, [reloadOmp, t]);

  React.useEffect(() => {
    const showUpdateAvailableToast = (version: string) => {
      // Upstream setting wins over our dedup logic: if user disabled
      // OMP update notifications, dismiss any active toast and bail
      // before consulting dedup state.
      if (!useUIStore.getState().showOpenCodeUpdateNotifications) {
        toast.dismiss(UPDATE_TOAST_ID);
        return;
      }
      const decision = shouldShowOmpUpdateToast({
        version,
        dismissedVersion: getDeferredSafeStorage().getItem(UPDATE_TOAST_DISMISSED_VERSION_KEY),
        seenVersions: seenVersionsRef.current,
      });
      if (!decision) {
        return;
      }
      seenVersionsRef.current.add(version);

      toast.info(t('ompUpdate.toast.available.title'), {
        id: UPDATE_TOAST_ID,
        description: t('ompUpdate.toast.available.description', { version }),
        duration: Infinity,
        action: {
          label: t('ompUpdate.toast.actions.update'),
          onClick: runUpgrade,
        },
        cancel: {
          label: t('ompUpdate.toast.actions.dismiss'),
          onClick: () => {
            getDeferredSafeStorage().setItem(UPDATE_TOAST_DISMISSED_VERSION_KEY, version);
            void updateDesktopSettings({ openCodeUpdateToastDismissedVersion: version });
            toast.dismiss(UPDATE_TOAST_ID);
          },
        },
      });
    };

    let cancelled = false;
    const timeoutIds: Array<ReturnType<typeof setTimeout>> = [];

    const checkForUpdate = async (attempt: number, runtimeKey = getRuntimeKey()) => {
      try {
        const response = await runtimeFetch('/api/omp/upgrade-status', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(response.statusText || 'OMP upgrade status check failed');
        const status = await response.json().catch(() => null) as OmpUpgradeStatusLike | null;
        const version = resolveOmpUpgradeStatusVersion(status);
        if (!cancelled && runtimeKey === getRuntimeKey() && version) {
          showUpdateAvailableToast(version);
        }
      } catch {
        const delay = CHECK_RETRY_DELAYS_MS[attempt];
        if (!cancelled && runtimeKey === getRuntimeKey() && delay !== undefined) {
          timeoutIds.push(setTimeout(() => { void checkForUpdate(attempt + 1, runtimeKey); }, delay));
        }
      }
    };

    const onUpdateAvailable = (event: Event) => {
      const version = resolveOmpUpdateVersion((event as CustomEvent<unknown>).detail);
      if (version) {
        void checkForUpdate(0);
      }
    };

    if (showOpenCodeUpdateNotifications) {
      timeoutIds.push(setTimeout(() => { void checkForUpdate(0); }, INITIAL_CHECK_DELAY_MS));
    }

    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(({ runtimeKey }) => {
      seenVersionsRef.current.clear();
      toast.dismiss(UPDATE_TOAST_ID);
      if (useUIStore.getState().showOpenCodeUpdateNotifications) {
        void checkForUpdate(0, runtimeKey);
      }
    });

    window.addEventListener('ompchamber:omp-update-available', onUpdateAvailable);
    return () => {
      cancelled = true;
      for (const timeoutId of timeoutIds) clearTimeout(timeoutId);
      unsubscribeRuntime();
      window.removeEventListener('ompchamber:omp-update-available', onUpdateAvailable);
    };
  }, [runUpgrade, showOpenCodeUpdateNotifications, t]);

  return null;
};
