/**
 * OMP session manager — owns the mapping between OMPChamber domain sessions
 * and OMP's session lifecycle.
 *
 * OMP Session is the source of truth for the conversation. OMPChamber keeps
 * only UI metadata (pinned/archived/icon/draft/etc.) in its own store.
 */

import { OMP_COMMANDS } from './rpc-types.js';
import { normalizeTodos } from './event-normalizer.js';
import {
  resolveOmpSessionsRoot,
  listOmpSessions,
  findOmpSessionFile,
  deleteOmpSessionFile,
} from './session-store.js';

/**
 * @param {object} opts
 * @param {() => Promise<object|null>} opts.rpc — returns the active RPC client
 * @param {string} opts.cwd
 * @param {string} [opts.profile] — OMP profile (isolates the on-disk store)
 * @param {object} [opts.env] — extra env passed to the OMP child (affects the
 *   data-dir resolution: PI_CONFIG_DIR / PI_CODING_AGENT_DIR / XDG_DATA_HOME)
 */
export const createOmpSessionManager = ({ rpc, cwd, profile = undefined, env = {} }) => {
  // Memoized sessions-root resolution (mirrors OMP's data-dir chain; see
  // session-store.js). Resolved lazily so test doubles need no filesystem.
  let sessionsRootCache = null;
  const getSessionsRoot = () => {
    if (!sessionsRootCache) {
      sessionsRootCache = resolveOmpSessionsRoot({
        env: { ...process.env, ...env },
        profile,
      });
    }
    return sessionsRootCache;
  };
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

    /**
     * Real session list for a directory, read from the OMP on-disk session
     * store (see session-store.js). The live current session is merged in even
     * when it has no file on disk yet (OMP only writes the file once the
     * session has content) and its live name wins over the on-disk title.
     * Disk reads happen per request — no cache — so the list never goes
     * stale; corrupt files are skipped individually by the store reader.
     */
    async listSessions(directory) {
      const dir = directory || cwd;
      const entries = await listOmpSessions({ sessionsRoot: getSessionsRoot(), directory: dir });
      const liveId = current.sessionId;
      const seen = new Set();
      const list = entries.map((entry) => {
        seen.add(entry.id);
        return {
          id: entry.id,
          title: entry.id === liveId
            ? (current.sessionName ?? entry.title ?? 'OMP session')
            : (entry.title ?? 'OMP session'),
          directory: dir,
          parentID: entry.parentSession ?? undefined,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        };
      });
      if (liveId && !seen.has(liveId)) {
        const now = Date.now();
        list.unshift({
          id: liveId,
          title: current.sessionName ?? 'OMP session',
          directory: dir,
          createdAt: now,
          updatedAt: now,
        });
      }
      return list;
    },

    /**
     * Resume a session by id. The live session short-circuits; any other id
     * is resolved to its on-disk file and loaded via switch_session.
     * Verified against the real binary: switch_session with a session FILE
     * PATH loads that session (get_state + get_messages reflect it), but with
     * a path that does not exist OMP silently fabricates a NEW empty session
     * at that path — so the file must be verified on disk before switching,
     * and the post-switch session id is checked to catch a race where the
     * file disappeared in between.
     */
    async resumeSession(sessionId, directory) {
      if (!sessionId || typeof sessionId !== 'string') return { status: 'not-found' };
      if (current.sessionId === sessionId) {
        await refreshState();
        return { status: 'current', state: { ...current } };
      }
      const dir = directory || cwd;
      const found = await findOmpSessionFile({
        sessionsRoot: getSessionsRoot(),
        directory: dir,
        sessionId,
      });
      if (!found) return { status: 'not-found' };
      await this.switchSession(found.file);
      if (current.sessionId !== sessionId) {
        // The file vanished between lookup and switch and OMP created a fresh
        // session at that path instead of loading the requested one.
        return { status: 'failed', error: 'session switch did not land on the requested session' };
      }
      return { status: 'resumed', state: { ...current }, file: found.file };
    },

    /**
     * Delete a session for real: removes its on-disk JSONL file (plus the
     * companion subagent directory). Deleting the ACTIVE session first moves
     * the engine onto a fresh session (verified: OMP tolerates its active
     * file disappearing — it would recreate it on the next write — so the
     * switch must happen before the unlink). If the new-session step fails,
     * the file is left untouched. Missing sessions report 'not-found'.
     */
    async deleteSession(sessionId, directory) {
      if (!sessionId || typeof sessionId !== 'string') return { status: 'not-found' };
      const dir = directory || cwd;
      const isActive = current.sessionId === sessionId;
      let file = null;
      if (isActive) {
        file = current.sessionFile ?? null;
      } else {
        const found = await findOmpSessionFile({
          sessionsRoot: getSessionsRoot(),
          directory: dir,
          sessionId,
        });
        if (!found) return { status: 'not-found' };
        file = found.file;
      }
      if (isActive) {
        // Move the engine off the session being deleted. Throws on failure,
        // leaving the session and its file intact.
        await this.createSession();
      }
      if (file) {
        await deleteOmpSessionFile(file);
      }
      return { status: 'deleted', wasActive: isActive, file };
    },
  };
};
