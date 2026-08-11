/**
 * OMP session manager — owns the mapping between OMPChamber domain sessions
 * and OMP's session lifecycle.
 *
 * OMP Session is the source of truth for the conversation. OMPChamber keeps
 * only UI metadata (pinned/archived/icon/draft/etc.) in its own store.
 */

import { OMP_COMMANDS } from './rpc-types.js';

const normalizeSessionList = (frames) => {
  // OMP's get_state returns the current session. Session listing across
  // directories is derived from OMP's session store on disk; the RPC surface
  // exposes the current session plus branch/resume operations.
  return [];
};

/**
 * @param {object} opts
 * @param {() => Promise<object|null>} opts.rpc — returns the active RPC client
 * @param {string} opts.cwd
 */
export const createOmpSessionManager = ({ rpc, cwd }) => {
  const current = {
    sessionId: null,
    sessionFile: null,
    sessionName: null,
  };

  const ensureRpc = async () => {
    const client = await rpc();
    if (!client) throw new Error('OMP runtime is not connected');
    return client;
  };

  const refreshState = async () => {
    const client = await ensureRpc();
    const resp = await client.send({ type: OMP_COMMANDS.GET_STATE }, { timeoutMs: 10_000 });
    const data = resp?.data;
    if (data) {
      current.sessionId = data.sessionId ?? current.sessionId;
      current.sessionFile = data.sessionFile ?? current.sessionFile;
      current.sessionName = data.sessionName ?? current.sessionName;
    }
    return data ?? null;
  };

  return {
    /** Current OMP session identity (id/file/name). */
    get current() {
      return { ...current };
    },

    async refresh() {
      return await refreshState();
    },

    /** Create a new session (optionally forked from a parent). */
    async createSession({ parentID } = {}) {
      const client = await ensureRpc();
      const resp = await client.send({
        type: OMP_COMMANDS.NEW_SESSION,
        ...(parentID ? { parentSession: parentID } : {}),
      }, { timeoutMs: 15_000 });
      await refreshState();
      // Enable the subagent event bus so get_subagents returns real entries
      // after subagents run (bus is off by default).
      try {
        await this.setSubagentSubscription('events');
      } catch {
        // Subscription is best-effort; older OMP versions may reject it.
      }
      return { ...current, cancelled: resp?.data?.cancelled === true };
    },

    /** Send a prompt to the current session. */
    async prompt(message, { steer = false } = {}) {
      const client = await ensureRpc();
      const frame = {
        type: steer ? OMP_COMMANDS.STEER : OMP_COMMANDS.PROMPT,
        message,
      };
      await client.send(frame, { timeoutMs: 30_000 });
      await refreshState();
    },

    async abort() {
      const client = await ensureRpc();
      await client.send({ type: OMP_COMMANDS.ABORT }, { timeoutMs: 10_000 });
    },

    async compact(customInstructions) {
      const client = await ensureRpc();
      const frame = { type: OMP_COMMANDS.COMPACT };
      if (customInstructions) frame.customInstructions = customInstructions;
      const resp = await client.send(frame, { timeoutMs: 120_000 });
      return resp?.success === true;
    },

    async branch() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.BRANCH }, { timeoutMs: 60_000 });
      return resp?.data ?? null;
    },

    async switchSession(sessionPath) {
      const client = await ensureRpc();
      await client.send({ type: OMP_COMMANDS.SWITCH_SESSION, sessionPath }, { timeoutMs: 30_000 });
      await refreshState();
    },

    async setSessionName(name) {
      const client = await ensureRpc();
      await client.send({ type: OMP_COMMANDS.SET_SESSION_NAME, name }, { timeoutMs: 10_000 });
      current.sessionName = name;
    },

    async getMessages() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.GET_MESSAGES }, { timeoutMs: 15_000 });
      return resp?.data?.messages ?? [];
    },

    async getLastAssistantText() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.GET_LAST_ASSISTANT_TEXT }, { timeoutMs: 10_000 });
      return resp?.data?.text ?? null;
    },

    async setTodos(todoPhases) {
      const client = await ensureRpc();
      await client.send({ type: OMP_COMMANDS.SET_TODOS, phases: todoPhases }, { timeoutMs: 10_000 });
    },

    /**
     * Enable the OMP subagent event bus. Without an active subscription the
     * bus is off and get_subagents always returns an empty list even after
     * subagents have run. Level 'events' streams lifecycle/state events into
     * the bus so the UI subagent panel sees real entries.
     */
    async setSubagentSubscription(level = 'events') {
      const client = await ensureRpc();
      await client.send(
        { type: OMP_COMMANDS.SET_SUBAGENT_SUBSCRIPTION, level },
        { timeoutMs: 10_000 },
      );
    },

    async getSubagents() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.GET_SUBAGENTS }, { timeoutMs: 15_000 });
      return resp?.data?.subagents ?? [];
    },
  };
};

export { normalizeSessionList };
