/**
 * OMP session manager — owns the mapping between OMPChamber domain sessions
 * and OMP's session lifecycle.
 *
 * OMP Session is the source of truth for the conversation. OMPChamber keeps
 * only UI metadata (pinned/archived/icon/draft/etc.) in its own store.
 */

import { OMP_COMMANDS } from './rpc-types.js';
import { normalizeTodos } from './event-normalizer.js';

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
    // Event-derived liveness: true between agent_start and agent_end. Reconciled
    // against the authoritative get_state isStreaming/isCompacting flags on
    // every refresh, so a missed event cannot wedge the status endpoint.
    busy: false,
    // Last known todo list (todo_reminder/todo_auto_clear events, or todos
    // mined from get_state when OMP includes them). Drives GET …/todo.
    todos: [],
  };
  // Latest get_available_commands result (RPC response or live
  // available_commands_update frame). Used by /api/command and command
  // validation for POST …/command.
  let availableCommands = [];

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
      // Authoritative reconciliation of the event-derived busy flag.
      if (typeof data.isStreaming === 'boolean' || typeof data.isCompacting === 'boolean') {
        current.busy = data.isStreaming === true || data.isCompacting === true;
      }
      // Mine todos from get_state when OMP includes them (the live path stays
      // the todo_reminder event stream; todoPhases is the plan-phase surface,
      // not the OpenCode-shaped todo list, so it is intentionally not mapped).
      if (Array.isArray(data.todos)) {
        current.todos = normalizeTodos(data.todos);
      }
    }
    return data ?? null;
  };

  /**
   * Observe a raw OMP frame to keep derived session state current. Called by
   * the runtime for every frame before normalization.
   */
  const observeFrame = (frame) => {
    if (!frame || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'agent_start':
        current.busy = true;
        break;
      case 'agent_end':
      case 'session_end':
        current.busy = false;
        break;
      case 'todo_reminder':
        current.todos = normalizeTodos(frame.todos);
        break;
      case 'todo_auto_clear':
        current.todos = [];
        break;
      case 'available_commands_update':
        if (Array.isArray(frame.commands)) availableCommands = frame.commands;
        break;
      default:
        break;
    }
  };

  return {
    /** Current OMP session identity (id/file/name) plus derived live state. */
    get current() {
      return { ...current, todos: [...current.todos] };
    },

    observeFrame,

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

    /**
     * Branch the session at a user-message entry. OMP requires an `entryId`
     * (from get_branch_messages); branching with no entry is rejected by the
     * engine ("Invalid entry ID for branching"). The branched session is new
     * and starts empty — OMP returns the entry text for the caller to re-send.
     */
    async branch(entryId) {
      const client = await ensureRpc();
      const frame = { type: OMP_COMMANDS.BRANCH };
      if (typeof entryId === 'string' && entryId) frame.entryId = entryId;
      const resp = await client.send(frame, { timeoutMs: 60_000 });
      return resp?.data ?? null;
    },

    /**
     * List branchable user-message entries ([{ entryId, text }]). Fork uses
     * this to resolve a target entry (exact match on messageID, else the
     * latest entry) before branching.
     */
    async getBranchMessages() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.GET_BRANCH_MESSAGES }, { timeoutMs: 15_000 });
      return resp?.data?.messages ?? [];
    },

    /**
     * Run a shell command through OMP's bash RPC. Request/response only: OMP
     * returns the captured output after completion ({ exitCode, output,
     * truncated, cancelled, workingDir, ... }); there is no output streaming.
     */
    async runBash(command) {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.BASH, command }, { timeoutMs: 120_000 });
      if (resp?.success === false) {
        throw new Error(resp?.error || 'OMP bash failed');
      }
      return resp?.data ?? null;
    },

    async abortBash() {
      const client = await ensureRpc();
      await client.send({ type: OMP_COMMANDS.ABORT_BASH }, { timeoutMs: 10_000 });
    },

    /**
     * Fetch the available slash-command list from OMP. Updates the cache that
     * available_commands_update frames also keep warm.
     */
    async listCommands() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.GET_AVAILABLE_COMMANDS }, { timeoutMs: 15_000 });
      const commands = resp?.data?.commands;
      if (Array.isArray(commands)) {
        availableCommands = commands;
        return availableCommands;
      }
      throw new Error(resp?.error || 'OMP get_available_commands failed');
    },

    /** Last known command list (may be empty before the first fetch). */
    getCachedCommands() {
      return availableCommands;
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
