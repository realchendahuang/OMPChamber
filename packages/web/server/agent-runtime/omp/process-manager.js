/**
 * OMP process manager — spawns, supervises, restarts and tears down the
 * `omp --mode rpc-ui` child process.
 *
 * Hard guarantees (OMP_MIGRATION_MAP §5, §22):
 *   - OMP runs in its own process (crash isolation, version isolation).
 *   - heartbeat / exit detection / stderr capture / restart / backoff /
 *     timeout / abort.
 *   - On crash the runtime reports an `OMP crashed [Restart Agent][View Logs]`
 *     state to the UI — never an infinite spinner.
 */

import { spawn } from 'node:child_process';
import { createLogger } from './logger.js';
import { createRpcClient } from './rpc-client.js';

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_RESTART_BACKOFF_MS = 750;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 15_000;
const READY_FRAME_TIMEOUT_MS = 20_000;

/**
 * Windows cannot spawn .cmd/.bat launchers directly (Node EINVAL since the
 * CVE-2024-27980 fix); they require a shell. The staged OMP CLI is a plain
 * script on POSIX but resolves to `omp.cmd` on win32, so shell mode is enabled
 * only for batch launchers on Windows. `windowsHide` keeps the console window
 * from flashing on packaged desktop builds.
 */
export const resolveSpawnOptions = ({ binary, platform = process.platform } = {}) => ({
  windowsHide: true,
  ...(platform === 'win32' && /\.(cmd|bat)$/i.test(String(binary ?? '')) ? { shell: true } : {}),
});

export const OMP_CRASH_STATES = {
  EXITED: 'exited',
  START_TIMEOUT: 'start-timeout',
  READY_TIMEOUT: 'ready-timeout',
  SPAWN_ERROR: 'spawn-error',
};

/**
 * @param {object} opts
 * @param {string} [opts.binary='omp']   OMP binary path (bundled or system).
 * @param {string} opts.cwd              Working directory for OMP.
 * @param {string[]} [opts.args=[]]      Extra CLI args passed before --mode.
 * @param {string} [opts.profile]        OMP profile name (isolates config/auth).
 * @param {object} [opts.env]            Extra env vars for the child.
 * @param {number} [opts.startTimeoutMs]
 * @param {number} [opts.restartBackoffMs]
 * @param {(state: object) => void} [opts.onStateChange]
 * @param {(frame: object) => void} [opts.onFrame]
 * @param {ReturnType<typeof createLogger>} [opts.logger]
 */
export const createOmpProcessManager = ({
  binary = 'omp',
  cwd = process.cwd(),
  args = [],
  profile = undefined,
  env = {},
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  restartBackoffMs = DEFAULT_RESTART_BACKOFF_MS,
  onStateChange = () => {},
  onFrame = () => {},
  logger = createLogger(),
}) => {
  let child = null;
  let rpc = null;
  let state = { status: 'stopped', crash: null, pid: null, restartCount: 0 };
  let shuttingDown = false;
  let restartTimer = null;

  // Internal frame observers (readiness probe + external subscribers).
  const frameObservers = new Set();
  if (typeof onFrame === 'function') frameObservers.add(onFrame);

  const setState = (patch) => {
    state = { ...state, ...patch };
    onStateChange(state);
  };

  const buildArgs = () => {
    const withMode = args.includes('--mode') ? [...args] : [...args, '--mode', 'rpc-ui'];
    if (profile) withMode.push('--profile', profile);
    return withMode;
  };

  const hasExited = (p) => !p || p.exitCode !== null || p.signalCode !== null;

  const spawnOmp = () =>
    new Promise((resolve, reject) => {
      const spawnArgs = buildArgs();
      logger.omp(`spawning: ${binary} ${spawnArgs.join(' ')} (cwd=${cwd})`);
      setState({ status: 'starting', crash: null });

      let childProcess;
      try {
        childProcess = spawn(binary, spawnArgs, {
          cwd,
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          ...resolveSpawnOptions({ binary }),
        });
      } catch (error) {
        setState({ status: 'crashed', crash: { kind: OMP_CRASH_STATES.SPAWN_ERROR, message: error.message } });
        reject(error);
        return;
      }

      let settled = false;
      const startTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        setState({ status: 'crashed', crash: { kind: OMP_CRASH_STATES.START_TIMEOUT } });
        reject(new Error(`OMP failed to spawn within ${startTimeoutMs}ms`));
      }, startTimeoutMs);

      childProcess.once('spawn', () => {
        if (settled) return;
        clearTimeout(startTimer);
        settled = true;
        logger.omp(`spawned pid=${childProcess.pid}`);
        setState({ pid: childProcess.pid || null, status: 'running' });
        resolve(childProcess);
      });

      childProcess.once('error', (error) => {
        if (!settled) {
          clearTimeout(startTimer);
          settled = true;
          setState({ status: 'crashed', crash: { kind: OMP_CRASH_STATES.SPAWN_ERROR, message: error.message } });
          reject(error);
          return;
        }
        logger.error(`OMP process error: ${error.message}`);
      });
    });

  const start = async () => {
    if (shuttingDown) return null;
    if (child && !hasExited(child)) return rpc;

    try {
      child = await spawnOmp();
      if (!child) return null;

      rpc = createRpcClient({
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onFrame: (frame) => {
          for (const observer of frameObservers) observer(frame);
        },
        onError: (error) => logger.error(`RPC error: ${error.message}`),
        logger,
      });

      child.once('exit', (code, signal) => {
        logger.omp(`OMP exited code=${code} signal=${signal}`);
        if (!shuttingDown) {
          setState({ status: 'crashed', crash: { kind: OMP_CRASH_STATES.EXITED, code, signal } });
          scheduleRestart();
        }
      });

      // Wait for the `ready` frame.
      await new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          setState({ status: 'crashed', crash: { kind: OMP_CRASH_STATES.READY_TIMEOUT } });
          reject(new Error(`OMP did not send a ready frame within ${READY_FRAME_TIMEOUT_MS}ms`));
        }, READY_FRAME_TIMEOUT_MS);
        const observer = (frame) => {
          if (done) return;
          if (frame && frame.type === 'ready') {
            done = true;
            clearTimeout(timer);
            frameObservers.delete(observer);
            resolve();
          }
        };
        frameObservers.add(observer);
      });

      logger.omp('OMP ready (protocol ready frame received)');
      setState({ status: 'ready', crash: null });
      return rpc;
    } catch (error) {
      logger.error(`OMP start failed: ${error.message}`);
      throw error;
    }
  };

  const scheduleRestart = () => {
    if (shuttingDown || restartTimer) return;
    const delay = Math.min(restartBackoffMs * 2 ** state.restartCount, DEFAULT_MAX_RESTART_BACKOFF_MS);
    logger.omp(`scheduling restart in ${delay}ms (restart #${state.restartCount + 1})`);
    setState({ restartCount: state.restartCount + 1 });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void start().catch((error) => {
        logger.error(`restart failed: ${error.message}`);
        setState({ status: 'crashed', crash: { kind: OMP_CRASH_STATES.SPAWN_ERROR, message: error.message } });
      });
    }, delay);
  };

  const stop = async () => {
    shuttingDown = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child && !hasExited(child)) {
      try {
        rpc?.notify({ type: 'abort' });
      } catch {
        // ignore
      }
      try {
        child.kill('SIGTERM');
        const exited = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (!exited) child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    rpc?.close();
    child = null;
    rpc = null;
    setState({ status: 'stopped', pid: null });
    logger.omp('OMP stopped');
  };

  const restart = async () => {
    await stop();
    shuttingDown = false;
    setState({ restartCount: 0, status: 'stopped' });
    return await start();
  };

  return {
    start,
    stop,
    restart,
    /** Subscribe to raw OMP RPC frames. Returns unsubscribe. */
    subscribeFrames(callback) {
      frameObservers.add(callback);
      return () => frameObservers.delete(callback);
    },
    get rpc() {
      return rpc;
    },
    get state() {
      return state;
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
};
