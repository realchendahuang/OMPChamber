import { describe, expect, mock, test } from 'bun:test';

describe('deferred OMP restart helpers', () => {
  test('isDeferredRestartPayload detects deferred responses', async () => {
    const { isDeferredRestartPayload } = await import('./deferredRestart');

    expect(isDeferredRestartPayload({
      requiresReload: false,
      requiresRestart: true,
      restartDeferred: true,
    })).toBe(true);

    expect(isDeferredRestartPayload({
      requiresReload: false,
      requiresRestart: true,
    })).toBe(true);

    expect(isDeferredRestartPayload({
      requiresReload: true,
      message: 'reloading',
    })).toBe(false);

    expect(isDeferredRestartPayload({
      requiresManualRestart: true,
      requiresRestart: true,
      restartDeferred: true,
    })).toBe(false);
  });

  test('noteDeferredRestartFromPayload records pending changes', async () => {
    const { usePendingOmpRestartStore } = await import('@/stores/usePendingOmpRestartStore');
    usePendingOmpRestartStore.getState().clear();

    const { noteDeferredRestartFromPayload } = await import('./deferredRestart');
    const noted = noteDeferredRestartFromPayload({
      requiresReload: false,
      requiresRestart: true,
      restartDeferred: true,
    }, 'mcp', { id: 'filesystem' });

    expect(noted).toBe(true);
    expect(usePendingOmpRestartStore.getState().changes).toHaveLength(1);
    expect(usePendingOmpRestartStore.getState().changes[0]?.scope).toBe('mcp');
  });

  test('noteDeferredRestartFromPayload ignores non-deferred payloads', async () => {
    const { usePendingOmpRestartStore } = await import('@/stores/usePendingOmpRestartStore');
    usePendingOmpRestartStore.getState().clear();

    const { noteDeferredRestartFromPayload } = await import('./deferredRestart');
    const noted = noteDeferredRestartFromPayload({
      requiresReload: false,
      message: 'Provider was not connected',
    }, 'providers', { id: 'openai' });

    expect(noted).toBe(false);
    expect(usePendingOmpRestartStore.getState().changes).toHaveLength(0);
  });

  test('applyPendingOmpRestart clears pending changes after success', async () => {
    mock.module('@/stores/useAgentsStore', () => ({
      reloadOmpConfiguration: async () => undefined,
    }));

    const { usePendingOmpRestartStore } = await import('@/stores/usePendingOmpRestartStore');
    usePendingOmpRestartStore.getState().clear();
    usePendingOmpRestartStore.getState().recordChange({ scope: 'agents', id: 'demo' });

    const { applyPendingOmpRestart } = await import('./deferredRestart');
    const result = await applyPendingOmpRestart({ message: 'Applying…' });

    expect(result).toEqual({ ok: true });
    expect(usePendingOmpRestartStore.getState().changes).toHaveLength(0);
    expect(usePendingOmpRestartStore.getState().isApplying).toBe(false);
  });

  test('applyPendingOmpRestart clears pending changes on manual restart', async () => {
    mock.module('@/stores/useAgentsStore', () => ({
      reloadOmpConfiguration: async () => {
        const error = new Error('Restart your connected OMP server');
        (error as Error & { requiresManualRestart?: boolean }).requiresManualRestart = true;
        throw error;
      },
    }));

    const { usePendingOmpRestartStore } = await import('@/stores/usePendingOmpRestartStore');
    usePendingOmpRestartStore.getState().clear();
    usePendingOmpRestartStore.getState().recordChange({ scope: 'mcp', id: 'filesystem' });

    const { applyPendingOmpRestart } = await import('./deferredRestart');
    const result = await applyPendingOmpRestart({ message: 'Applying…' });

    expect(result).toEqual({ ok: false, requiresManualRestart: true });
    expect(usePendingOmpRestartStore.getState().changes).toHaveLength(0);
    expect(usePendingOmpRestartStore.getState().isApplying).toBe(false);
  });
});
