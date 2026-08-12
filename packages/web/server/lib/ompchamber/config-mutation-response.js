/**
 * Shared response shapes for OMPChamber config mutations.
 *
 * Settings writes persist to disk immediately but defer the server restart
 * so the UI can accumulate pending changes and apply them once via
 * POST /api/config/reload ("Apply & Restart OMPChamber").
 */

export function buildDeferredRestartResponse(message) {
  return {
    success: true,
    requiresReload: false,
    requiresRestart: true,
    restartDeferred: true,
    message,
  };
}

export function buildExternalManualRestartResponse(message) {
  return {
    success: true,
    requiresReload: false,
    requiresManualRestart: true,
    message,
  };
}
