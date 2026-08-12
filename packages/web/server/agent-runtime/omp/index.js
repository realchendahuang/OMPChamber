/**
 * OMP runtime assembly — wires the process manager, RPC client, session/model
 * managers, and normalizers into the AgentRuntime surface the UI consumes.
 *
 * Exposes `createOmpRuntime` which implements the domain AgentRuntime contract
 * (see @ompchamber/agent-protocol/src/types.ts). Nothing in here leaks OMP
 * raw frames outward.
 */

import { execFile as defaultExecFile } from 'node:child_process';
import { createOmpProcessManager } from './process-manager.js';
import { createOmpSessionManager } from './session-manager.js';
import { createOmpModelManager } from './model-manager.js';
import { createOmpUiRequestHandler } from './ui-request-handler.js';
import { createLogger } from './logger.js';
import { parseOmpVersion } from './compatibility.js';
import {
  normalizeSessionEvent,
  normalizeAgentMessage,
  normalizeAsk,
  normalizeSubagent,
} from './event-normalizer.js';

/**
 * Resolve the real OMP version via `omp --version` (the rpc-ui `ready` frame
 * carries protocol versions only, no engine version). Output looks like
 * "omp/17.2.12"; the semver core is extracted and validated through the same
 * parser the compatibility floor uses. Returns null when undetectable.
 */
const detectOmpVersion = (execFileImpl, binary) =>
  new Promise((resolve) => {
    try {
      execFileImpl(binary, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        const match = String(stdout ?? '').match(/\d+\.\d+\.\d+/);
        resolve(match && parseOmpVersion(match[0]) ? match[0] : null);
      });
    } catch {
      resolve(null);
    }
  });

/**
 * @param {object} opts
 * @param {string} [opts.binary='omp']
 * @param {string} opts.cwd
 * @param {string} [opts.profile]
 * @param {object} [opts.env]
 * @param {(event: object) => void} [opts.onDomainEvent] — normalized domain events
 * @param {(state: object) => void} [opts.onProcessState]
 * @param {Function} [opts.execFile] — injectable for tests (defaults to node:child_process)
 */
export const createOmpRuntime = ({
  binary = 'omp',
  cwd = process.cwd(),
  profile = undefined,
  env = {},
  onDomainEvent = () => {},
  onProcessState = () => {},
  logger = createLogger(),
  execFile = defaultExecFile,
} = {}) => {
  const domainListeners = new Set();
  let ompVersion = null;

  const processManager = createOmpProcessManager({
    binary,
    cwd,
    profile,
    env,
    onStateChange: (state) => {
      // A crashed engine leaves any outstanding asks unanswerable; drop them
      // so the pending question/permission surface never shows stale entries.
      if (state?.status === 'crashed') uiRequestHandler.clearPending();
      onProcessState(state);
    },
    onFrame: (frame) => {
      // Keep derived session state (busy flag, todos, command cache) current.
      sessionManager.observeFrame(frame);

      // OMP cancels an outstanding ask via method 'cancel' + targetId.
      if (frame?.type === 'extension_ui_request' && frame.method === 'cancel') {
        uiRequestHandler.untrack(frame.targetId);
      }

      // Route raw frames through the UI-request handler and domain normalizer.
      const ask = normalizeAsk(frame);
      if (ask) {
        uiRequestHandler.track(ask, sessionManager.current.sessionId);
        const event = { type: 'ask', ask };
        for (const listener of domainListeners) listener(event);
        onDomainEvent(event);
        return;
      }

      const subagent = frame.type === 'subagent_lifecycle' || frame.type === 'subagent_progress' || frame.type === 'subagent_event'
        ? normalizeSubagent(frame)
        : null;
      if (subagent) {
        const event = { type: 'subagent', sessionId: '', subagent };
        for (const listener of domainListeners) listener(event);
        onDomainEvent(event);
        return;
      }

      for (const domainEvent of normalizeSessionEvent(frame)) {
        for (const listener of domainListeners) listener(domainEvent);
        onDomainEvent(domainEvent);
      }
    },
    logger,
  });

  const getRpc = async () => processManager.rpc;

  const sessionManager = createOmpSessionManager({ rpc: getRpc, cwd });
  const modelManager = createOmpModelManager({ rpc: getRpc });
  const uiRequestHandler = createOmpUiRequestHandler({
    onAsk: (ask) => {
      const event = { type: 'ask', ask };
      for (const listener of domainListeners) listener(event);
      onDomainEvent(event);
    },
    onResponse: () => {},
    rpc: getRpc,
  });

  return {
    async start() {
      const rpc = await processManager.start();
      await sessionManager.refresh();
      // Best-effort version detection; failure never blocks startup (the
      // adapter falls back gracefully when the version is unknown).
      ompVersion = await detectOmpVersion(execFile, binary);
      if (ompVersion) logger.omp(`OMP version: ${ompVersion}`);
      return rpc;
    },
    async stop() {
      await processManager.stop();
    },
    async restart() {
      return await processManager.restart();
    },

    // Session surface
    session: {
      get current() {
        return sessionManager.current;
      },
      refresh: () => sessionManager.refresh(),
      create: (params) => sessionManager.createSession(params),
      prompt: (message, opts) => sessionManager.prompt(message, opts),
      abort: () => sessionManager.abort(),
      compact: (instructions) => sessionManager.compact(instructions),
      branch: (entryId) => sessionManager.branch(entryId),
      getBranchMessages: () => sessionManager.getBranchMessages(),
      runBash: (command) => sessionManager.runBash(command),
      abortBash: () => sessionManager.abortBash(),
      listCommands: () => sessionManager.listCommands(),
      getCachedCommands: () => sessionManager.getCachedCommands(),
      switchSession: (path) => sessionManager.switchSession(path),
      setSessionName: (name) => sessionManager.setSessionName(name),
      getMessages: () => sessionManager.getMessages(),
      getLastAssistantText: () => sessionManager.getLastAssistantText(),
      setTodos: (todoPhases) => sessionManager.setTodos(todoPhases),
      getSubagents: () => sessionManager.getSubagents(),
    },

    // Model surface
    models: {
      list: () => modelManager.listModels(),
      set: (provider, modelId) => modelManager.setModel(provider, modelId),
      cycle: () => modelManager.cycleModel(),
      setThinkingLevel: (level) => modelManager.setThinkingLevel(level),
    },

    // Ask response
    respondAsk: (id, response) => uiRequestHandler.respond(id, response),

    /** Pending ask requests (select/confirm/input) backing /api/question + /api/permission. */
    listPendingAsks: () => uiRequestHandler.listPending(),

    /** Real OMP version (from `omp --version` at startup), or null if unknown. */
    get version() {
      return ompVersion;
    },

    // Domain event subscription
    subscribe(listener) {
      domainListeners.add(listener);
      return () => domainListeners.delete(listener);
    },

    // Process status
    get status() {
      return processManager.state;
    },
    get pid() {
      return processManager.pid;
    },
    get rpc() {
      return processManager.rpc;
    },
  };
};
