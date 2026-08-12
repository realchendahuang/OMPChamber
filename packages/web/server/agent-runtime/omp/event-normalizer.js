/**
 * OMP event normalizer — converts OMP AgentSessionEvent frames into
 * OMPChamber domain events (see @ompchamber/agent-protocol/src/types.ts).
 *
 * The UI NEVER consumes raw OMP frames; everything goes through here (or the
 * sibling normalizers). When OMP changes its protocol, only this module changes.
 */

import { OMP_FRAME_TYPES, OMP_SESSION_EVENT_TYPES } from './rpc-types.js';

const asString = (value, fallback = '') =>
  typeof value === 'string' ? value : fallback;

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * Normalize an OMP content block into a domain part.
 * Handles TextContent, ThinkingContent, RedactedThinkingContent, ToolCall,
 * and ImageContent (dropped or summarized — images need file resolution).
 */
export const normalizeContentPart = (block) => {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text':
      return { type: 'text', text: asString(block.text) };
    case 'thinking':
      return { type: 'thinking', text: asString(block.thinking), streaming: false };
    case 'redactedThinking':
      return { type: 'thinking', text: '[encrypted thinking]', streaming: false };
    case 'toolCall':
      return {
        type: 'tool-call',
        call: {
          id: asString(block.id),
          name: asString(block.name),
          input: block.arguments ?? {},
          status: 'completed',
        },
      };
    case 'image':
      // Images need to be resolved through file access; represent as a
      // placeholder text part for now so the message still renders.
      return { type: 'text', text: `[image attachment]` };
    default:
      return null;
  }
};

/**
 * Normalize an OMP AgentMessage (UserMessage / AssistantMessage /
 * ToolResultMessage) into a domain AgentMessage.
 */
export const normalizeAgentMessage = (message) => {
  if (!message || typeof message !== 'object') return null;
  const role = message.role === 'user' ? 'user'
    : message.role === 'assistant' ? 'assistant'
    : message.role === 'toolResult' ? 'assistant' // tool results fold into assistant turns for rendering
    : message.role === 'developer' ? 'system'
    : 'user';

  const id = message.responseId
    || message.id
    || (message.role === 'toolResult' ? `tool:${asString(message.toolCallId)}` : undefined)
    || `msg-${asString(message.timestamp)}-${role}`;

  // OMP messages carry no explicit sessionId on message_update frames; the
  // caller (normalizeSessionEvent) patches it in from the frame. Default to
  // empty string here; the runtime layer fills it.
  const sessionId = asString(message.sessionId ?? '');
  const parts = [];
  const content = message.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];

  if (message.role === 'toolResult') {
    parts.push({
      type: 'tool-result',
      callId: asString(message.toolCallId),
      name: asString(message.toolName),
      status: message.isError ? 'failed' : 'completed',
      error: message.isError ? 'tool error' : undefined,
      result: blocks,
    });
  } else {
    for (const block of blocks) {
      const part = normalizeContentPart(block);
      if (part) parts.push(part);
    }
  }

  return {
    id,
    sessionId,
    role,
    parts,
    createdAt: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
    complete: true,
    error: asString(message.errorMessage) || undefined,
  };
};

/**
 * Convert an OMP tool_execution_* frame into a domain ToolCall snapshot.
 */
export const normalizeToolFrame = (frame) => {
  const status = frame.type === 'tool_execution_start' ? 'running'
    : frame.type === 'tool_execution_end' ? (frame.isError ? 'failed' : 'completed')
    : 'running';
  return {
    id: asString(frame.toolCallId),
    name: asString(frame.toolName),
    input: frame.args ?? {},
    status,
    result: frame.result,
    error: frame.isError ? asString(frame.result?.error) || 'tool failed' : undefined,
  };
};

/**
 * Normalize an OMP AgentSessionEvent frame into zero or more domain events.
 * Returns an array (some frames produce multiple domain events).
 */
export const normalizeSessionEvent = (frame) => {
  if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return [];

  switch (frame.type) {
    case OMP_SESSION_EVENT_TYPES.AGENT_START:
      return [{ type: 'session-state', state: { sessionId: '', status: 'running', streaming: true } }];
    case OMP_SESSION_EVENT_TYPES.TURN_START:
      return [];
    case OMP_SESSION_EVENT_TYPES.MESSAGE_UPDATE: {
      const message = normalizeAgentMessage(frame.message);
      if (!message) return [];
      // OMP messages don't carry a sessionId; derive it from the frame if
      // present, else from the message's session field.
      const frameSessionId = asString(frame.sessionId)
        || asString(frame.assistantMessageEvent?.sessionId)
        || asString(frame.message?.sessionId ?? '');
      if (frameSessionId) message.sessionId = frameSessionId;
      return [{
        type: 'message-update',
        sessionId: frameSessionId,
        message,
      }];
    }
    case OMP_SESSION_EVENT_TYPES.MESSAGE_START:
    case OMP_SESSION_EVENT_TYPES.MESSAGE_END:
    case OMP_SESSION_EVENT_TYPES.TURN_END: {
      const message = normalizeAgentMessage(frame.message);
      if (!message) return [];
      return [{ type: 'message-update', sessionId: asString(frame.message?.sessionId ?? ''), message }];
    }
    case OMP_SESSION_EVENT_TYPES.TOOL_EXECUTION_START: {
      const call = normalizeToolFrame(frame);
      return [
        { type: 'tool-start', sessionId: '', call },
        { type: 'tool-update', sessionId: '', callId: call.id, patch: { status: 'running' } },
      ];
    }
    case OMP_SESSION_EVENT_TYPES.TOOL_EXECUTION_UPDATE:
      return [{
        type: 'tool-update',
        sessionId: '',
        callId: asString(frame.toolCallId),
        patch: { status: 'running', result: frame.partialResult },
      }];
    case OMP_SESSION_EVENT_TYPES.TOOL_EXECUTION_END: {
      const call = normalizeToolFrame(frame);
      return [{ type: 'tool-end', sessionId: '', call }];
    }
    case OMP_SESSION_EVENT_TYPES.TOOL_EXECUTION_CANCEL:
      return [{
        type: 'tool-update',
        sessionId: '',
        callId: asString(frame.toolCallId),
        patch: { status: 'failed', error: 'cancelled' },
      }];
    case 'agent_end':
    case OMP_SESSION_EVENT_TYPES.SESSION_END:
      return [{ type: 'session-ended', sessionId: '', reason: asString(frame.reason) || undefined }];
    case 'notice':
      return frame.level === 'error'
        ? [{ type: 'error', sessionId: '', error: asString(frame.message) }]
        : [];
    case 'todo_reminder':
      return [{
        type: 'todo-update',
        sessionId: '',
        todos: normalizeTodos(frame.todos),
      }];
    case 'todo_auto_clear':
      return [{ type: 'todo-update', sessionId: '', todos: [] }];
    case OMP_FRAME_TYPES.AVAILABLE_COMMANDS_UPDATE:
      // Live slash-command list refresh (extensions/skills hot-reload). The
      // session manager also caches these frames; this domain event feeds the
      // SSE projection so the UI palette can update without a refetch.
      return [{
        type: 'available-commands-update',
        sessionId: '',
        commands: Array.isArray(frame.commands) ? frame.commands : [],
      }];
    default:
      // Unknown frame types pass through as no-ops so future OMP events don't
      // break rendering.
      return [];
  }
};

/**
 * Normalize an OMP TodoItem[] (from `todo_reminder` events) into the OpenCode
 * Todo shape the UI's todo store consumes. OMP statuses map onto the UI's
 * status vocabulary (pending/in_progress/completed).
 */
export const normalizeTodos = (todos) => {
  if (!Array.isArray(todos)) return [];
  return todos
    .map((todo, index) => {
      if (!todo || typeof todo !== 'object') return null;
      const status = todo.status === 'completed' ? 'completed'
        : todo.status === 'in_progress' ? 'in_progress'
        : todo.status === 'blocked' ? 'in_progress'
        : 'pending';
      return {
        id: `${asString(todo.id) || `todo-${index}`}`,
        content: asString(todo.content),
        status,
        priority: 'medium',
        ...(typeof todo.blocker === 'string' && todo.blocker ? { blocker: todo.blocker } : {}),
      };
    })
    .filter(Boolean);
};

/**
 * Normalize an OMP extension_ui_request frame into a domain AgentAsk.
 */
export const normalizeAsk = (frame) => {
  if (!frame || frame.type !== 'extension_ui_request') return null;
  const method = frame.method === 'select' ? 'select'
    : frame.method === 'confirm' ? 'confirm'
    : frame.method === 'input' ? 'input'
    : frame.method === 'editor' ? 'input'
    : null;
  if (!method) return null; // notify/setStatus/setWidget etc. are not asks

  return {
    id: asString(frame.id),
    method,
    title: asString(frame.title) || 'Agent request',
    message: asString(frame.message) || undefined,
    options: asArray(frame.options),
    placeholder: asString(frame.placeholder) || undefined,
    timeout: typeof frame.timeout === 'number' ? frame.timeout : undefined,
  };
};

/**
 * Normalize a subagent_* frame into a domain SubagentSnapshot.
 */
export const normalizeSubagent = (frame) => {
  const payload = frame?.payload ?? {};
  return {
    id: asString(payload.subagentId ?? payload.id ?? frame.id ?? ''),
    agent: asString(payload.agent ?? payload.agentName ?? ''),
    description: asString(payload.description) || undefined,
    status: payload.status === 'running' ? 'running'
      : payload.status === 'completed' ? 'completed'
      : payload.status === 'failed' ? 'failed'
      : 'running',
    task: asString(payload.task) || undefined,
    assignment: asString(payload.assignment) || undefined,
    parentToolCallId: asString(payload.parentToolCallId) || undefined,
    progress: {
      toolCalls: typeof payload.toolCalls === 'number' ? payload.toolCalls : undefined,
      elapsedMs: typeof payload.elapsedMs === 'number' ? payload.elapsedMs : undefined,
      statusText: asString(payload.statusText) || undefined,
    },
  };
};
