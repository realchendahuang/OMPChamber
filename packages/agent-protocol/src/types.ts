/**
 * OMPChamber Agent Domain Protocol — the single source of truth for the
 * domain model that both the React UI and the OMP adapter speak.
 *
 * The React UI MUST NOT import harness types (OMP / OpenCode). It only ever
 * sees these domain types. The OMP adapter (in the server) normalizes OMP
 * raw frames into these types before anything is shown in the UI.
 *
 * This file is intentionally framework- and harness-agnostic.
 */

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type AgentSessionStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface AgentSession {
  id: string;
  title?: string;
  /** Working directory the agent runs in (typically an OMPChamber worktree). */
  cwd: string;
  status: AgentSessionStatus;
  createdAt: number;
  updatedAt: number;
  /** OMP session file path, when one is active. OMP is the source of truth. */
  sessionFile?: string;
  /** Model currently selected in this session (provider + modelId). */
  model?: AgentModelRef;
  /** Optional metadata kept by the UI (pinned/archived/icon/draft/etc.). */
  metadata?: Record<string, unknown>;
}

export interface AgentModelRef {
  provider: string;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Messages and parts
// ---------------------------------------------------------------------------

export type AgentMessageRole = 'user' | 'assistant' | 'system';

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  parts: AgentPart[];
  createdAt: number;
  /** Set once the message is fully streamed. */
  complete: boolean;
  error?: string;
}

export type AgentPart =
  | TextPart
  | ThinkingPart
  | ToolCallPart
  | ToolResultPart
  | ReasoningPart
  | ErrorPart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkingPart {
  type: 'thinking';
  /** Encrypted thinking summary or transcript fragment as delivered by OMP. */
  text?: string;
  /** True when the thinking block is still streaming. */
  streaming?: boolean;
}

export interface ReasoningPart {
  type: 'reasoning';
  text?: string;
}

export interface ErrorPart {
  type: 'error';
  error: string;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface ToolCallPart {
  type: 'tool-call';
  call: ToolCall;
}

export interface ToolResultPart {
  type: 'tool-result';
  callId: string;
  name: string;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Subagents (OMP `task` tool → subagent)
// ---------------------------------------------------------------------------

export interface SubagentSnapshot {
  id: string;
  agent: string;
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'waiting';
  task?: string;
  assignment?: string;
  parentToolCallId?: string;
  progress?: {
    toolCalls?: number;
    filesTouched?: string[];
    elapsedMs?: number;
    statusText?: string;
  };
}

// ---------------------------------------------------------------------------
// Ask / Question UI (OMP extension_ui_request → native Question UI)
// ---------------------------------------------------------------------------

export type AgentAskMethod = 'select' | 'confirm' | 'input';

export interface AgentAsk {
  id: string;
  method: AgentAskMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  timeout?: number;
}

export interface AgentAskResponse {
  id: string;
  cancelled: boolean;
  value?: string;
  confirmed?: boolean;
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// Status / streaming snapshot
// ---------------------------------------------------------------------------

export interface AgentSessionState {
  sessionId: string;
  status: AgentSessionStatus;
  streaming: boolean;
  compressing: boolean;
  model?: AgentModelRef;
  todo?: unknown;
}

// ---------------------------------------------------------------------------
// Session events (UI consumes these)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'session-state'; state: AgentSessionState }
  | { type: 'message-update'; sessionId: string; message: AgentMessage }
  | { type: 'message-part'; sessionId: string; messageId: string; part: AgentPart }
  | { type: 'tool-start'; sessionId: string; call: ToolCall }
  | { type: 'tool-update'; sessionId: string; callId: string; patch: Partial<ToolCall> }
  | { type: 'tool-end'; sessionId: string; call: ToolCall }
  | { type: 'ask'; ask: AgentAsk }
  | { type: 'subagent'; sessionId: string; subagent: SubagentSnapshot }
  | { type: 'session-ended'; sessionId: string; reason?: string }
  | { type: 'error'; sessionId: string; error: string };

// ---------------------------------------------------------------------------
// Adapter interface (implemented by the server OMP adapter)
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  listSessions(cwd: string): Promise<AgentSession[]>;
  createSession(params?: {
    parentID?: string;
    title?: string;
    cwd?: string;
  }): Promise<AgentSession>;
  getSession(id: string): Promise<AgentSession>;
  deleteSession(id: string): Promise<boolean>;
  getMessages(sessionId: string): Promise<AgentMessage[]>;
  sendMessage(sessionId: string, content: string): Promise<void>;
  abort(sessionId: string): Promise<boolean>;
  compact(sessionId: string): Promise<boolean>;
  listModels(): Promise<Array<{ provider: string; modelId: string; label?: string }>>;
  setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
  /** Subscribe to normalized agent events. Returns unsubscribe. */
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
