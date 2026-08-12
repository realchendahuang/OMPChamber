/**
 * OMP RPC-UI protocol constants and frame discriminators.
 *
 * OMP (`omp --mode rpc-ui`) speaks JSON Lines over stdin/stdout. Commands are
 * written to stdin; responses and events are read as NDJSON lines from stdout.
 *
 * This module mirrors the subset of OMP's official rpc-types.ts that
 * OMPChamber consumes. It is NOT part of the UI domain protocol — the adapter
 * normalizes these frames into @ompchamber/agent-protocol types before the UI
 * sees anything.
 */

/** Frames OMP emits on stdout before protocol negotiation. */
export const OMP_PROTOCOL_VERSION = 1;
export const OMP_SUPPORTED_PROTOCOL_VERSIONS = [1, 2];

/** Maximum frame bytes for protocol v1 (single JSON object per line). */
export const OMP_MAX_FRAME_BYTES_V1 = 1024 * 1024;

/** stdin command types we send. */
export const OMP_COMMANDS = {
  NEGOTIATE: 'negotiate_protocol',
  PROMPT: 'prompt',
  STEER: 'steer',
  FOLLOW_UP: 'follow_up',
  ABORT: 'abort',
  ABORT_AND_PROMPT: 'abort_and_prompt',
  NEW_SESSION: 'new_session',
  GET_STATE: 'get_state',
  SET_MODEL: 'set_model',
  CYCLE_MODEL: 'cycle_model',
  GET_AVAILABLE_MODELS: 'get_available_models',
  SET_THINKING_LEVEL: 'set_thinking_level',
  COMPACT: 'compact',
  GET_MESSAGES: 'get_messages',
  GET_MESSAGES_PAGE: 'get_messages_page',
  SWITCH_SESSION: 'switch_session',
  BRANCH: 'branch',
  GET_LAST_ASSISTANT_TEXT: 'get_last_assistant_text',
  SET_SESSION_NAME: 'set_session_name',
  HANDOFF: 'handoff',
  GET_SESSION_STATS: 'get_session_stats',
  SET_TODOS: 'set_todos',
  GET_AVAILABLE_COMMANDS: 'get_available_commands',
  BASH: 'bash',
  ABORT_BASH: 'abort_bash',
  GET_BRANCH_MESSAGES: 'get_branch_messages',
  GET_SUBAGENTS: 'get_subagents',
  GET_SUBAGENT_MESSAGES: 'get_subagent_messages',
  SET_SUBAGENT_SUBSCRIPTION: 'set_subagent_subscription',
  SET_FAST_MODE: 'set_fast_mode',
  SET_AUTO_COMPACTION: 'set_auto_compaction',
  GET_LOGIN_PROVIDERS: 'get_login_providers',
  LOGIN: 'login',
};

/** stdout frame `type` discriminators we handle. */
export const OMP_FRAME_TYPES = {
  READY: 'ready',
  RPC_CHUNK: 'rpc_chunk',
  RESPONSE: 'response',
  EXTENSION_UI_REQUEST: 'extension_ui_request',
  SUBAGENT_LIFECYCLE: 'subagent_lifecycle',
  SUBAGENT_PROGRESS: 'subagent_progress',
  SUBAGENT_EVENT: 'subagent_event',
  AVAILABLE_COMMANDS_UPDATE: 'available_commands_update',
};

/** extension_ui_request methods (ask / confirm / input / dialog). */
export const OMP_UI_REQUEST_METHODS = {
  SELECT: 'select',
  CONFIRM: 'confirm',
  INPUT: 'input',
  EDITOR: 'editor',
  CANCEL: 'cancel',
  NOTIFY: 'notify',
  SET_STATUS: 'setStatus',
  SET_WIDGET: 'setWidget',
  SET_TITLE: 'setTitle',
  SET_EDITOR_TEXT: 'set_editor_text',
  OPEN_URL: 'open_url',
};

/** OMP RPC session event types (AgentSessionEvent). */
export const OMP_SESSION_EVENT_TYPES = {
  AGENT_START: 'agent_start',
  MESSAGE_UPDATE: 'message_update',
  TOOL_EXECUTION_START: 'tool_execution_start',
  TOOL_EXECUTION_UPDATE: 'tool_execution_update',
  TOOL_EXECUTION_END: 'tool_execution_end',
  TOOL_EXECUTION_CANCEL: 'tool_execution_cancel',
  SESSION_END: 'session_end',
  PROMPT_START: 'prompt_start',
};
