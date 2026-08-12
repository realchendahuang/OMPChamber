/**
 * OMP engine binary resolution.
 *
 * Precedence:
 *   1. `OMP_BINARY` env override (explicit operator/desktop injection).
 *   2. Persisted settings `opencodeBinary` — the desktop settings UI writes
 *      this key with a "restart to apply" toast; reading it here makes that
 *      field real. An empty string is the persisted "cleared" sentinel and is
 *      treated as absent.
 *   3. `OPENCODE_BINARY` env (deprecated alias kept consistent with the CLI
 *      precheck, which exports both names — see bin/lib/cli-executables.js).
 *   4. `omp` on PATH.
 *
 * Note: Electron injects OMP_BINARY (bundled CLI) into the server env when
 * unset, so on desktop the env override wins over the persisted setting by
 * design; the setting applies to CLI/standalone runs where OMP_BINARY is
 * absent.
 */

const normalize = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {object} input
 * @param {object} [input.env]      — defaults to process.env
 * @param {object} [input.settings] — parsed settings.json payload
 * @returns {{ binary: string, source: 'OMP_BINARY' | 'settings' | 'OPENCODE_BINARY' | 'default' }}
 */
export const resolveOmpEngineBinary = ({ env = process.env, settings = {} } = {}) => {
  const envOverride = normalize(env?.OMP_BINARY);
  if (envOverride) {
    return { binary: envOverride, source: 'OMP_BINARY' };
  }
  const persisted = normalize(settings?.opencodeBinary);
  if (persisted) {
    return { binary: persisted, source: 'settings' };
  }
  const legacy = normalize(env?.OPENCODE_BINARY);
  if (legacy) {
    return { binary: legacy, source: 'OPENCODE_BINARY' };
  }
  return { binary: 'omp', source: 'default' };
};
