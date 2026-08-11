import {
  usePendingOmpRestartStore,
  type PendingOmpRestartScope,
} from '@/stores/usePendingOmpRestartStore';

export type ConfigMutationPayload = {
  requiresReload?: boolean;
  requiresRestart?: boolean;
  restartDeferred?: boolean;
  requiresManualRestart?: boolean;
  reloadFailed?: boolean;
  message?: string;
  warning?: string;
  reloadDelayMs?: number;
} | null | undefined;

export function isDeferredRestartPayload(payload: ConfigMutationPayload): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (payload.requiresManualRestart === true) {
    return false;
  }
  return payload.restartDeferred === true || (payload.requiresRestart === true && payload.requiresReload !== true);
}

export function recordDeferredOmpRestart(
  scope: PendingOmpRestartScope,
  options?: { id?: string; label?: string },
): void {
  usePendingOmpRestartStore.getState().recordChange({
    scope,
    id: options?.id,
    label: options?.label,
  });
}

/**
 * If the mutation response deferred the OMP restart, record it and return true.
 * Callers should skip immediate refresh overlays when this returns true.
 */
export function noteDeferredRestartFromPayload(
  payload: ConfigMutationPayload,
  scope: PendingOmpRestartScope,
  options?: { id?: string; label?: string },
): boolean {
  if (!isDeferredRestartPayload(payload)) {
    return false;
  }
  recordDeferredOmpRestart(scope, options);
  return true;
}

export async function applyPendingOmpRestart(options?: {
  message?: string;
}): Promise<{ ok: boolean; requiresManualRestart?: boolean }> {
  const store = usePendingOmpRestartStore.getState();
  if (store.isApplying) {
    return { ok: false };
  }

  store.setApplying(true);
  try {
    const { reloadOmpConfiguration } = await import('@/stores/useAgentsStore');
    await reloadOmpConfiguration({
      message: options?.message,
      mode: 'projects',
      scopes: ['all'],
    });
    usePendingOmpRestartStore.getState().clear();
    return { ok: true };
  } catch (error) {
    if ((error as Error & { requiresManualRestart?: boolean })?.requiresManualRestart) {
      // Changes are already on disk; clear the badge after delivering manual-restart guidance.
      usePendingOmpRestartStore.getState().clear();
      return { ok: false, requiresManualRestart: true };
    }
    usePendingOmpRestartStore.getState().setApplying(false);
    throw error;
  }
}
