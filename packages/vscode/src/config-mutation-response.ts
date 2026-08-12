/**
 * Shared response shape for OMPChamber config mutations.
 *
 * Settings writes persist to disk immediately, but the running OMPChamber
 * server (with its in-process OMP engine) does not hot-reload config, so the
 * changes take effect only after the spawned server restarts. The restart is
 * deferred so the UI can accumulate pending changes and apply them once via
 * api:config/reload ("Apply & Restart"), which restarts the server process.
 */
export function buildDeferredRestartResponse(message: string) {
  return {
    success: true,
    requiresReload: false,
    requiresRestart: true,
    restartDeferred: true,
    message,
  };
}
