/**
 * OMP runtime assembly — wires the process manager, RPC client, session/model
 * managers, and normalizers into the AgentRuntime surface the UI consumes.
 *
 * Exposes `createOmpRuntime` which implements the domain AgentRuntime contract
 * (see @ompchamber/agent-protocol/src/types.ts). Nothing in here leaks OMP
 * raw frames outward.
 */

import { createOmpProcessManager } from './process-manager.js';
import { createOmpSessionManager } from './session-manager.js';
import { createOmpModelManager } from './model-manager.js';
import { createOmpUiRequestHandler } from './ui-request-handler.js';
import { createLogger } from './logger.js';
import {
  normalizeSessionEvent,
  normalizeAgentMessage,
  normalizeAsk,
  normalizeSubagent,
} from './event-normalizer.js';

/**
 * @param {object} opts
 * @param {string} [opts.binary='omp']
 * @param {string} opts.cwd
 * @param {string} [opts.profile]
 * @param {object} [opts.env]
 * @param {(event: object) => void} [opts.onDomainEvent] — normalized domain events
 * @param {(state: object) => void} [opts.onProcessState]
 */
export const createOmpRuntime = ({
  binary = 'omp',
  cwd = process.cwd(),
  profile = undefined,
  env = {},
  onDomainEvent = () => {},
  onProcessState = () => {},
  logger = createLogger(),
} = {}) => {
  const domainListeners = new Set();

  const processManager = createOmpProcessManager({
    binary,
    cwd,
    profile,
    env,
    onStateChange: onProcessState,
    onFrame: (frame) => {
      // Route raw frames through the UI-request handler and domain normalizer.
      const ask = normalizeAsk(frame);
      if (ask) {
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
      branch: () => sessionManager.branch(),
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
