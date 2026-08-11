/**
 * OMP event bridge — projects normalized OMP domain events onto the
 * OpenCode-shaped SSE stream the existing UI sync layer consumes, so the
 * chat timeline updates live while running on the OMP engine.
 *
 * Only active when OMPCHAMBER_AGENT_ENGINE=omp. It feeds the existing
 * global message-stream hub with frames in the shape the UI's event-reducer
 * already understands (`message.updated`, `message.part.updated`, ...).
 *
 * This is an adapter: the UI stays unchanged; only the event source changes.
 */

const OPENCODE_SDK_VERSION = '1.0.0';

const partToSdkPart = (part, messageId, sessionId) => {
  const base = { id: `${messageId}_${part.type}`, messageID: messageId, sessionID: sessionId };
  if (part.type === 'text') return { ...base, type: 'text', text: part.text };
  if (part.type === 'thinking') return { ...base, type: 'reasoning', text: part.text };
  if (part.type === 'tool-call') return {
    ...base,
    type: 'tool',
    tool: part.call.name,
    toolCallID: part.call.id,
    state: { input: part.call.input, status: part.call.status },
  };
  if (part.type === 'tool-result') return {
    ...base,
    type: 'tool-result',
    tool: part.name,
    toolCallID: part.callId,
    state: { output: part.result, status: part.status, error: part.error },
  };
  return { ...base, type: 'text', text: part.error ?? '' };
};

const messageToSdkInfo = (message, sessionId) => ({
  id: message.id,
  sessionID: sessionId,
  role: message.role,
  time: { created: message.createdAt, completed: message.complete ? message.createdAt : undefined },
  version: OPENCODE_SDK_VERSION,
});

/**
 * Convert a normalized domain event into zero or more OpenCode-shaped SSE
 * frames for the UI sync layer.
 */
export const domainEventToSseFrames = (event) => {
  const frames = [];
  switch (event.type) {
    case 'message-update': {
      const { message, sessionId } = event;
      frames.push({
        type: 'message.updated',
        properties: { info: messageToSdkInfo(message, sessionId), sessionID: sessionId },
      });
      for (const part of message.parts) {
        frames.push({
          type: 'message.part.updated',
          properties: { part: partToSdkPart(part, message.id, sessionId), sessionID: sessionId },
        });
      }
      break;
    }
    case 'tool-start':
    case 'tool-update':
    case 'tool-end': {
      // Tool activity is surfaced through part updates when messages arrive;
      // these are kept for future materialization. No-op for now.
      break;
    }
    case 'todo-update': {
      const { sessionId, todos } = event;
      frames.push({
        type: 'todo.updated',
        properties: { sessionID: sessionId, todos: todos ?? [] },
      });
      break;
    }
    case 'ask': {
      // OMP extension_ui_request asks map onto the OpenCode-shaped
      // permission/question surfaces the UI already renders:
      //   confirm → permission.asked (PermissionRequest)
      //   select/input → question.asked (QuestionRequest)
      const { ask, sessionId } = event;
      if (!ask || typeof ask.id !== 'string') break;
      if (ask.method === 'confirm') {
        frames.push({
          type: 'permission.asked',
          properties: {
            sessionID: sessionId,
            permission: {
              id: ask.id,
              sessionID: sessionId,
              permission: ask.title || 'Agent request',
              patterns: [],
              metadata: {
                omp: {
                  kind: 'confirm',
                  title: ask.title,
                  message: ask.message,
                },
              },
              always: [],
            },
          },
        });
      } else {
        // select / input → a single-question QuestionRequest. Options carry
        // OMP's select choices; input renders an open text question.
        const options = Array.isArray(ask.options) && ask.options.length > 0
          ? ask.options.map((option) => typeof option === 'string'
            ? { label: option, description: '' }
            : { label: option?.label ?? String(option?.value ?? ''), description: option?.description ?? '' })
          : [];
        frames.push({
          type: 'question.asked',
          properties: {
            sessionID: sessionId,
            question: {
              id: ask.id,
              sessionID: sessionId,
              questions: [{
                question: ask.message || ask.title || 'Agent request',
                header: ask.title || 'Agent request',
                ...(options.length > 0 ? { options } : {}),
                ...(ask.placeholder ? { placeholder: ask.placeholder } : {}),
              }],
            },
          },
        });
      }
      break;
    }
    case 'session-ended':
      break;
    default:
      break;
  }
  return frames;
};
