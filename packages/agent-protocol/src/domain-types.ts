/**
 * OMPChamber Domain Types — the OMP-shaped surface the UI consumes.
 *
 * These types mirror the wire shapes the OMPChamber server exposes through
 * its HTTP adapter (`/api/session`, `/api/session/:id/message`, ...). They
 * are the single source of truth for the React UI: the UI MUST NOT import
 * harness types (OMP / the former OpenCode SDK). The server adapter normalizes OMP
 * state into these shapes before anything is shown in the UI.
 *
 * This file is intentionally framework- and harness-agnostic. It is a
 * structural mirror of the historical OpenCode SDK v2 client types so the existing UI
 * keeps working unchanged while the engine behind it is OMP.
 */

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SnapshotFileDiff = {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
};

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: PermissionAction;
};

export type PermissionRuleset = Array<PermissionRule>;

export type Session = {
  id: string;
  slug: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  path?: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: Array<SnapshotFileDiff>;
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  share?: {
    url: string;
  };
  title: string;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  version: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    created: number;
    updated: number;
    compacting?: number;
    archived?: number;
  };
  permission?: PermissionRuleset;
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
};

export type SessionStatus =
  | { type: "idle" }
  | {
      type: "retry";
      attempt: number;
      message: string;
      action?: {
        reason: string;
        provider: string;
        title: string;
        message: string;
        label: string;
        link?: string;
      };
      next: number;
    }
  | { type: "busy" };

export type Todo = {
  content: string;
  status: string;
  priority: string;
};

// ---------------------------------------------------------------------------
// Subagents (OMP `task` tool → subagent)
// ---------------------------------------------------------------------------

export type SubagentSnapshot = {
  id: string;
  agent: string;
  description?: string;
  status: "running" | "completed" | "failed" | "waiting";
  task?: string;
  assignment?: string;
  parentToolCallId?: string;
  progress?: {
    toolCalls?: number;
    filesTouched?: string[];
    elapsedMs?: number;
    statusText?: string;
  };
};

// ---------------------------------------------------------------------------
// Messages and parts
// ---------------------------------------------------------------------------

export type OutputFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };

export type UserMessage = {
  id: string;
  sessionID: string;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: {
    title?: string;
    body?: string;
    diffs: Array<SnapshotFileDiff>;
  };
  agent: string;
  model: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
  system?: string;
  tools?: {
    [key: string]: boolean;
  };
};

export type AssistantMessageError = {
  name: string;
  data: {
    message: string;
    [key: string]: unknown;
  };
};

export type AssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: AssistantMessageError;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  structured?: unknown;
  variant?: string;
  finish?: string;
};

export type Message = UserMessage | AssistantMessage;

export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: {
    [key: string]: unknown;
  };
};

export type SubtaskPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  command?: string;
};

export type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end?: number;
  };
};

export type FilePartSourceText = {
  value: string;
  start: number;
  end: number;
};

export type FileSource = {
  text: FilePartSourceText;
  type: "file";
  path: string;
};

export type SymbolSource = {
  text: FilePartSourceText;
  type: "symbol";
  path: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  name: string;
  kind: number;
};

export type ResourceSource = {
  text: FilePartSourceText;
  type: "resource";
  clientName: string;
  uri: string;
};

export type FilePartSource = FileSource | SymbolSource | ResourceSource;

export type FilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};

export type ToolStatePending = {
  status: "pending";
  input: {
    [key: string]: unknown;
  };
  raw: string;
};

export type ToolStateRunning = {
  status: "running";
  input: {
    [key: string]: unknown;
  };
  title?: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
  };
};

export type ToolStateCompleted = {
  status: "completed";
  input: {
    [key: string]: unknown;
  };
  output: string;
  title: string;
  metadata: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: Array<FilePart>;
};

export type ToolStateError = {
  status: "error";
  input: {
    [key: string]: unknown;
  };
  error: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end: number;
  };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: {
    [key: string]: unknown;
  };
};

export type StepStartPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
};

export type StepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

export type SnapshotPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "snapshot";
  snapshot: string;
};

export type PatchPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "patch";
  hash: string;
  files: Array<string>;
};

export type AgentPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

export type RetryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "retry";
  attempt: number;
  error: AssistantMessageError;
  time: {
    created: number;
  };
};

export type CompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "compaction";
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
};

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart;

// ---------------------------------------------------------------------------
// Part inputs (send payloads)
// ---------------------------------------------------------------------------

export type TextPartInput = {
  id?: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: {
    [key: string]: unknown;
  };
};

export type FilePartInput = {
  id?: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};

export type AgentPartInput = {
  id?: string;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

// ---------------------------------------------------------------------------
// Questions and permissions
// ---------------------------------------------------------------------------

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: Array<QuestionOption>;
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionTool = {
  messageID: string;
  callID: string;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: QuestionTool;
};

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: Array<string>;
  metadata: {
    [key: string]: unknown;
  };
  always: Array<string>;
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type PermissionV2Source = {
  type: "tool";
  messageID: string;
  callID: string;
};

export type PermissionV2Effect = "allow" | "deny" | "ask";

export type PermissionV2Request = {
  id: string;
  sessionID: string;
  action: string;
  resources: Array<string>;
  save?: Array<string>;
  metadata?: {
    [key: string]: unknown;
  };
  source?: PermissionV2Source;
};

export type PermissionActionConfig = "ask" | "allow" | "deny";

export type PermissionObjectConfig = {
  [key: string]: PermissionActionConfig;
};

export type PermissionRuleConfig = PermissionActionConfig | PermissionObjectConfig;

export type PermissionConfig =
  | PermissionActionConfig
  | {
      read?: PermissionRuleConfig;
      edit?: PermissionRuleConfig;
      glob?: PermissionRuleConfig;
      grep?: PermissionRuleConfig;
      list?: PermissionRuleConfig;
      bash?: PermissionRuleConfig;
      task?: PermissionRuleConfig;
      external_directory?: PermissionRuleConfig;
      todowrite?: PermissionActionConfig;
      question?: PermissionActionConfig;
      webfetch?: PermissionActionConfig;
      websearch?: PermissionActionConfig;
      lsp?: PermissionRuleConfig;
      doom_loop?: PermissionActionConfig;
      skill?: PermissionRuleConfig;
      [key: string]: PermissionRuleConfig | PermissionActionConfig | undefined;
    };

// ---------------------------------------------------------------------------
// Agents, projects, providers, config
// ---------------------------------------------------------------------------

export type Agent = {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  native?: boolean;
  hidden?: boolean;
  topP?: number;
  temperature?: number;
  color?: string;
  permission: PermissionRuleset;
  model?: {
    modelID: string;
    providerID: string;
  };
  variant?: string;
  prompt?: string;
  options: {
    [key: string]: unknown;
  };
  steps?: number;
};

export type ProjectVcs = "git";

export type ProjectIcon = {
  url?: string;
  override?: string;
  color?: string;
};

export type ProjectCommands = {
  start?: string;
};

export type ProjectTime = {
  created: number;
  updated: number;
  initialized?: number;
};

export type Project = {
  id: string;
  worktree: string;
  vcs?: ProjectVcs;
  name?: string;
  icon?: ProjectIcon;
  commands?: ProjectCommands;
  time: ProjectTime;
  sandboxes: Array<string>;
};

export type Model = {
  id: string;
  providerID: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  name: string;
  family?: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    interleaved: boolean | { field: string };
  };
  cost: {
    input: number;
    output: number;
    cache: {
      read: number;
      write: number;
    };
    tiers?: Array<{
      input: number;
      output: number;
      cache: {
        read: number;
        write: number;
      };
      tier: {
        type: "context";
        size: number;
      };
    }>;
    experimentalOver200K?: {
      input: number;
      output: number;
      cache: {
        read: number;
        write: number;
      };
    };
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: {
    [key: string]: unknown;
  };
  headers: {
    [key: string]: string;
  };
  release_date: string;
  variants?: {
    [key: string]: {
      [key: string]: unknown;
    };
  };
};

export type Provider = {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  env: Array<string>;
  key?: string;
  options: {
    [key: string]: unknown;
  };
  models: {
    [key: string]: Model;
  };
};

export type ProviderListResponse = {
  all: Array<Provider>;
  default: {
    [key: string]: string;
  };
  connected: Array<string>;
};

export type ProviderAuthMethod = {
  type: "oauth" | "api";
  label: string;
  prompts?: Array<{
    type: "text";
    key: string;
    message: string;
    placeholder?: string;
    when?: {
      key: string;
      op: "eq" | "neq";
      value: string;
    };
  }>;
};

export type ProviderAuthResponse = {
  [key: string]: Array<ProviderAuthMethod>;
};

export type Path = {
  home: string;
  state: string;
  config: string;
  worktree: string;
  directory: string;
};

export type VcsInfo = {
  branch?: string;
  default_branch?: string;
};

export type Command = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: "command" | "mcp" | "skill";
  template: string;
  subtask?: boolean;
  hints: Array<string>;
};

export type LspStatus = {
  id: string;
  name: string;
  root: string;
  status: "connected" | "error";
};

export type McpStatusConnected = {
  status: "connected";
};

export type McpStatusDisabled = {
  status: "disabled";
};

export type McpStatusFailed = {
  status: "failed";
  error: string;
};

export type McpStatusNeedsAuth = {
  status: "needs_auth";
};

export type McpStatusNeedsClientRegistration = {
  status: "needs_client_registration";
  error: string;
};

export type McpStatus =
  | McpStatusConnected
  | McpStatusDisabled
  | McpStatusFailed
  | McpStatusNeedsAuth
  | McpStatusNeedsClientRegistration;

export type Config = {
  $schema?: string;
  shell?: string;
  logLevel?: string;
  server?: Record<string, unknown>;
  command?: {
    [key: string]: {
      template: string;
      description?: string;
      agent?: string;
      model?: string;
      variant?: string;
      subtask?: boolean;
    };
  };
  skills?: {
    paths?: Array<string>;
    urls?: Array<string>;
  };
  references?: {
    [key: string]: unknown;
  };
  reference?: {
    [key: string]: unknown;
  };
  watcher?: {
    ignore?: Array<string>;
  };
  snapshot?: boolean;
  plugin?: Array<string | [string, Record<string, unknown>]>;
  share?: "manual" | "auto" | "disabled";
  autoshare?: boolean;
  autoupdate?: boolean | "notify";
  disabled_providers?: Array<string>;
  enabled_providers?: Array<string>;
  model?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Events (SSE / WS frames)
// ---------------------------------------------------------------------------

/**
 * A domain event frame. The `type` discriminates the event; `properties`
 * carries the payload. Kept structurally loose because the server adapter
 * projects OMP domain events into these shapes and the UI reducer consumes
 * them by `type` with its own property narrowing.
 */
export type Event = {
  id?: string;
  type: string;
  properties?: unknown;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// SDK-shaped result envelope
// ---------------------------------------------------------------------------

export type SdkResult<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

// ---------------------------------------------------------------------------
// AgentClient — the client surface the UI consumes
// ---------------------------------------------------------------------------

export type SseEvent = {
  data?: unknown;
  event?: string;
  id?: unknown;
  retry?: number;
};

export type SseStream = {
  stream: AsyncGenerator<unknown, void, unknown>;
};

export type GlobalEventOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  onSseEvent?: (event: SseEvent) => void;
  onSseError?: (error: unknown) => void;
};

export type SessionListOptions = {
  directory?: string;
  archived?: boolean;
  roots?: boolean;
  limit?: number;
  cursor?: number;
};

export type SessionMessagesOptions = {
  sessionID: string;
  directory?: string;
  limit?: number;
  before?: string;
};

export type SessionStatusOptions = {
  directory?: string;
};

export type PromptAsyncOptions = {
  sessionID: string;
  directory?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
  variant?: string;
  messageID?: string;
  delivery?: "steer";
  format?: OutputFormat;
  parts?: Array<TextPartInput | FilePartInput | AgentPartInput>;
};

export type SessionCommandOptions = {
  sessionID: string;
  directory?: string;
  command: string;
  arguments?: string;
  model?: string;
  agent?: string;
  variant?: string;
  parts?: Array<FilePartInput>;
  messageID?: string;
};

export type SessionShellOptions = {
  sessionID: string;
  directory?: string;
  messageID?: string;
  agent: string;
  model: {
    providerID: string;
    modelID: string;
  };
  command: string;
};

export type SessionUpdateOptions = {
  sessionID: string;
  directory?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: {
    archived?: number;
  };
};

export type SessionCreateOptions = {
  directory?: string;
  parentID?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type SessionGetOptions = {
  sessionID: string;
  directory?: string;
};

export type SessionDeleteOptions = {
  sessionID: string;
  directory?: string;
};

export type SessionTodoOptions = {
  sessionID: string;
  directory?: string;
};

export type SessionAbortOptions = {
  sessionID: string;
  directory?: string;
};

export type SessionRevertOptions = {
  sessionID: string;
  directory?: string;
  messageID: string;
  partID?: string;
};

export type SessionSummarizeOptions = {
  sessionID: string;
  directory?: string;
  providerID: string;
  modelID: string;
};

export type SessionUnrevertOptions = {
  sessionID: string;
  directory?: string;
};

export type SessionForkOptions = {
  sessionID: string;
  directory?: string;
  messageID?: string;
};

export type SessionCompactOptions = {
  sessionID: string;
  directory?: string;
  customInstructions?: string;
};

export type SessionBranchOptions = {
  sessionID: string;
  directory?: string;
};

export type SessionShareOptions = {
  sessionID: string;
  directory?: string;
};

export type SessionUpdateBody = {
  title?: string;
  metadata?: Record<string, unknown>;
  time?: {
    archived?: number;
  };
};

export type PermissionReplyOptions = {
  requestID: string;
  directory?: string;
  reply: "once" | "always" | "reject";
  message?: string;
};

export type PermissionListOptions = {
  directory?: string;
};

export type QuestionReplyOptions = {
  requestID: string;
  directory?: string;
  answers: Array<string> | Array<Array<string>>;
};

export type QuestionRejectOptions = {
  requestID: string;
  directory?: string;
};

export type QuestionListOptions = {
  directory?: string;
};

export type V2SessionPermissionCreateOptions = {
  sessionID: string;
  action: string;
  resources: Array<string>;
  id?: string;
  save?: Array<string>;
  metadata?: Record<string, unknown>;
  source?: PermissionV2Source;
  agent?: string;
};

export type V2SessionPermissionGetOptions = {
  sessionID: string;
  requestID: string;
};

export type MoveSessionOptions = {
  sessionID: string;
  destination: {
    directory: string;
  };
  moveChanges: boolean;
};

export type ExperimentalSessionListOptions = {
  directory?: string;
  archived?: boolean;
  roots?: boolean;
  limit?: number;
  cursor?: number;
};

export type FindFilesOptions = {
  query: string;
  limit?: number;
  dirs?: string;
  type?: "file" | "directory";
};

export type FileReadOptions = {
  path: string;
  directory?: string;
};

export type FileListOptions = {
  path: string;
  directory?: string;
};

export type ToolIdsOptions = {
  directory?: string;
};

export type ProviderAuthOptions = {
  directory?: string;
};

export type ProviderListOptions = {
  directory?: string;
};

export type AuthSetOptions = {
  providerID: string;
  auth: unknown;
};

export type ProviderOauthAuthorizeOptions = {
  providerID: string;
  method: number;
  inputs?: Record<string, string>;
};

export type ProviderOauthCallbackOptions = {
  providerID: string;
  method?: number;
  code?: string;
};

export type ProviderOauthCallbackRequestOptions = {
  signal?: AbortSignal;
};

export type SessionPromptOptions = {
  sessionID: string;
  directory?: string;
  messageID?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
  variant?: string;
  parts?: Array<TextPartInput | FilePartInput | AgentPartInput>;
};

export type SessionMessagesResult = Array<{
  info: Message;
  parts: Array<Part>;
}>;

export type SessionListResult = Array<Session>;

export type SessionStatusResult = Record<string, SessionStatus>;

export type CommandListResult = Array<Command>;

export type McpStatusResult = Record<string, McpStatus>;

export type LspStatusResult = Array<LspStatus>;

export type VcsGetResult = VcsInfo;

export type QuestionListResult = Array<QuestionRequest>;

export type PermissionListResult = Array<PermissionRequest>;

export type ProjectListResult = Array<Project>;

export type ProjectCurrentResult = Project;

export type PathGetResult = Path;

export type ConfigGetResult = Config;

export type ConfigUpdateResult = Config;

export type ConfigProvidersResult = {
  providers: Array<Provider>;
  default: {
    [key: string]: string;
  };
};

export type AgentListResult = Array<Agent>;

export type SkillListResult = Array<{
  name: string;
  description?: string;
  location: string;
  content?: string;
}>;

export type ToolIdsResult = Array<string>;

export type FileReadResult = string;

export type FileListResult = Array<Record<string, unknown>>;

export type FindFilesResult = Array<string>;

export type ProviderListResult = ProviderListResponse;

export type ProviderAuthResult = ProviderAuthResponse;

export type AuthSetResult = unknown;

export type ProviderOauthAuthorizeResult = {
  url: string;
  method: "auto" | "code";
  instructions: string;
};

export type ProviderOauthCallbackResult = unknown;

export type SessionPromptResult = {
  info: Message;
  parts: Array<Part>;
};

export type SessionTodoResult = Array<Todo>;

export type SessionCompactResult = boolean;

export type SessionBranchResult = unknown;

export type SessionForkResult = Session;

export type SessionDeleteResult = boolean;

export type SessionAbortResult = boolean;

export type SessionRevertResult = Session;

export type SessionUnrevertResult = Session;

export type SessionSummarizeResult = boolean;

export type SessionShellResult = {
  info: Message;
  parts: Array<Part>;
};

export type PermissionReplyResult = boolean;

export type QuestionReplyResult = boolean;

export type QuestionRejectResult = boolean;

export type V2SessionPermissionCreateResult = {
  id: string;
  effect: PermissionV2Effect;
};

export type V2SessionPermissionGetResult = PermissionV2Request;

export type MoveSessionResult = unknown;

export type GlobalEventResult = SseStream;

export type GlobalConfigGetResult = Config;

export type GlobalHealthResult = {
  healthy: boolean;
  version?: string;
};

export type GlobalVersionResult = {
  version: string;
  clientVersion?: string;
  git?: {
    sha: string;
    branch: string;
  };
};

export type SessionApi = {
  list(options?: SessionListOptions): Promise<SdkResult<SessionListResult>>;
  create(options?: SessionCreateOptions): Promise<SdkResult<Session>>;
  get(options: SessionGetOptions): Promise<SdkResult<Session>>;
  delete(options: SessionDeleteOptions): Promise<SdkResult<SessionDeleteResult>>;
  update(options: SessionUpdateOptions & SessionUpdateBody): Promise<SdkResult<Session>>;
  messages(options: SessionMessagesOptions): Promise<SdkResult<SessionMessagesResult>>;
  todo(options: SessionTodoOptions): Promise<SdkResult<SessionTodoResult>>;
  status(options?: SessionStatusOptions): Promise<SdkResult<SessionStatusResult>>;
  promptAsync(options: PromptAsyncOptions): Promise<SdkResult<unknown> & { response?: Response }>;
  prompt(options: SessionPromptOptions): Promise<SdkResult<SessionPromptResult>>;
  command(options: SessionCommandOptions): Promise<SdkResult<unknown>>;
  shell(options: SessionShellOptions): Promise<SdkResult<SessionShellResult>>;
  abort(options: SessionAbortOptions, opts?: { throwOnError?: boolean }): Promise<SdkResult<SessionAbortResult>>;
  revert(options: SessionRevertOptions): Promise<SdkResult<SessionRevertResult>>;
  unrevert(options: SessionUnrevertOptions): Promise<SdkResult<SessionUnrevertResult>>;
  summarize(options: SessionSummarizeOptions): Promise<SdkResult<SessionSummarizeResult>>;
  fork(options: SessionForkOptions): Promise<SdkResult<SessionForkResult>>;
  compact(options: SessionCompactOptions): Promise<SdkResult<SessionCompactResult>>;
  branch(options: SessionBranchOptions): Promise<SdkResult<SessionBranchResult>>;
  share(options: SessionShareOptions): Promise<SdkResult<Session>>;
  unshare(options: SessionShareOptions): Promise<SdkResult<Session>>;
};

export type GlobalApi = {
  config: {
    get(): Promise<SdkResult<GlobalConfigGetResult>>;
  };
  event(options?: GlobalEventOptions): Promise<GlobalEventResult>;
  health(): Promise<SdkResult<GlobalHealthResult>>;
  version(): Promise<SdkResult<GlobalVersionResult>>;
};

export type ConfigApi = {
  get(options?: { directory?: string }): Promise<SdkResult<ConfigGetResult>>;
  update(options: { config: Config }): Promise<SdkResult<ConfigUpdateResult>>;
  providers(options?: { directory?: string }): Promise<SdkResult<ConfigProvidersResult>>;
};

export type PathApi = {
  get(options?: { directory?: string }): Promise<SdkResult<PathGetResult>>;
};

export type ProjectApi = {
  list(): Promise<SdkResult<ProjectListResult>>;
  current(options?: { directory?: string }): Promise<SdkResult<ProjectCurrentResult>>;
};

export type CommandApi = {
  list(options?: { directory?: string }): Promise<SdkResult<CommandListResult>>;
};

export type McpApi = {
  status(options?: { directory?: string }): Promise<SdkResult<McpStatusResult>>;
  connect(options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>>;
  disconnect(options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>>;
  auth: {
    start(options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<{ authorizationUrl?: string }>>;
    authenticate(options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>>;
    callback(options: { name: string; code: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>>;
    remove(options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>>;
  };
};

export type LspApi = {
  status(options?: { directory?: string }): Promise<SdkResult<LspStatusResult>>;
};

export type VcsApi = {
  get(options?: { directory?: string }): Promise<SdkResult<VcsGetResult>>;
};

export type QuestionApi = {
  list(options?: QuestionListOptions): Promise<SdkResult<QuestionListResult>>;
  reply(options: QuestionReplyOptions): Promise<SdkResult<QuestionReplyResult>>;
  reject(options: QuestionRejectOptions): Promise<SdkResult<QuestionRejectResult>>;
};

export type PermissionApi = {
  list(options?: PermissionListOptions): Promise<SdkResult<PermissionListResult>>;
  reply(options: PermissionReplyOptions): Promise<SdkResult<PermissionReplyResult>>;
};

export type AppApi = {
  agents(options?: { directory?: string }): Promise<SdkResult<AgentListResult>>;
  skills(options?: { directory?: string }): Promise<SdkResult<SkillListResult>>;
};

export type FileApi = {
  read(options: FileReadOptions): Promise<SdkResult<FileReadResult>>;
  list(options: FileListOptions): Promise<SdkResult<FileListResult>>;
};

export type ToolApi = {
  ids(options?: ToolIdsOptions): Promise<SdkResult<ToolIdsResult>>;
};

export type FindApi = {
  files(options: FindFilesOptions): Promise<SdkResult<FindFilesResult>>;
};

export type ProviderApi = {
  list(options?: ProviderListOptions): Promise<SdkResult<ProviderListResult>>;
  auth(options?: ProviderAuthOptions): Promise<SdkResult<ProviderAuthResult>>;
  oauth: {
    authorize(options: ProviderOauthAuthorizeOptions): Promise<SdkResult<ProviderOauthAuthorizeResult>>;
    callback(
      options: ProviderOauthCallbackOptions,
      requestOptions?: ProviderOauthCallbackRequestOptions,
    ): Promise<SdkResult<ProviderOauthCallbackResult>>;
  };
};

export type AuthApi = {
  set(options: AuthSetOptions): Promise<SdkResult<AuthSetResult>>;
};

export type V2SessionPermissionApi = {
  create(options: V2SessionPermissionCreateOptions): Promise<SdkResult<{ data: V2SessionPermissionCreateResult }>>;
  get(options: V2SessionPermissionGetOptions): Promise<SdkResult<{ data: V2SessionPermissionGetResult }>>;
};

export type V2SessionApi = {
  permission: V2SessionPermissionApi;
};

export type V2Api = {
  session: V2SessionApi;
};

export type ExperimentalControlPlaneApi = {
  moveSession(options: MoveSessionOptions): Promise<SdkResult<MoveSessionResult>>;
};

export type ExperimentalApi = {
  controlPlane: ExperimentalControlPlaneApi;
  session: {
    list(options?: ExperimentalSessionListOptions): Promise<SdkResult<SessionListResult>>;
  };
};

/**
 * The client surface the UI consumes. The server adapter implements these
 * endpoints; the UI never reaches for a harness-specific client.
 */
export type AgentClient = {
  session: SessionApi;
  global: GlobalApi;
  config: ConfigApi;
  path: PathApi;
  project: ProjectApi;
  command: CommandApi;
  mcp: McpApi;
  lsp: LspApi;
  vcs: VcsApi;
  question: QuestionApi;
  permission: PermissionApi;
  app: AppApi;
  file: FileApi;
  tool: ToolApi;
  find: FindApi;
  provider: ProviderApi;
  auth: AuthApi;
  v2: V2Api;
  experimental: ExperimentalApi;
};
