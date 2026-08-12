import { describe, expect, it } from 'bun:test';

import {
  normalizeAgentMessage,
  normalizeContentPart,
  normalizeSessionEvent,
  normalizeAsk,
  normalizeSubagent,
  normalizeToolFrame,
} from './event-normalizer.js';

describe('normalizeContentPart', () => {
  it('maps TextContent to text part', () => {
    expect(normalizeContentPart({ type: 'text', text: 'hello' })).toEqual({
      type: 'text',
      text: 'hello',
    });
  });

  it('maps ThinkingContent to thinking part', () => {
    expect(normalizeContentPart({ type: 'thinking', thinking: 'deep' })).toEqual({
      type: 'thinking',
      text: 'deep',
      streaming: false,
    });
  });

  it('maps ToolCall to tool-call part', () => {
    const part = normalizeContentPart({
      type: 'toolCall',
      id: 'tc1',
      name: 'bash',
      arguments: { command: 'npm test' },
    });
    expect(part.type).toBe('tool-call');
    expect(part.call).toMatchObject({ id: 'tc1', name: 'bash', input: { command: 'npm test' }, status: 'completed' });
  });

  it('returns null for unknown blocks', () => {
    expect(normalizeContentPart({ type: 'mystery' })).toBeNull();
    expect(normalizeContentPart(null)).toBeNull();
  });
});

describe('normalizeAgentMessage', () => {
  it('normalizes a user message with string content', () => {
    const msg = normalizeAgentMessage({ role: 'user', content: 'hi', timestamp: 1000 });
    expect(msg.role).toBe('user');
    expect(msg.parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect(msg.createdAt).toBe(1000);
  });

  it('normalizes an assistant message with thinking + text', () => {
    const msg = normalizeAgentMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'done' },
      ],
      timestamp: 2000,
    });
    expect(msg.role).toBe('assistant');
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0]).toEqual({ type: 'thinking', text: 'plan', streaming: false });
    expect(msg.parts[1]).toEqual({ type: 'text', text: 'done' });
  });

  it('normalizes a tool result message', () => {
    const msg = normalizeAgentMessage({
      role: 'toolResult',
      toolCallId: 'tc9',
      toolName: 'bash',
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
      timestamp: 3000,
    });
    expect(msg.parts[0]).toMatchObject({
      type: 'tool-result',
      callId: 'tc9',
      name: 'bash',
      status: 'failed',
    });
  });
});

describe('normalizeToolFrame', () => {
  it('maps tool_execution_start to running', () => {
    const call = normalizeToolFrame({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'edit', args: { filePath: '/x' } });
    expect(call.status).toBe('running');
    expect(call.input).toEqual({ filePath: '/x' });
  });

  it('maps tool_execution_end error to failed', () => {
    const call = normalizeToolFrame({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', isError: true, result: 'nope' });
    expect(call.status).toBe('failed');
    expect(call.error).toBeDefined();
  });
});

describe('normalizeSessionEvent', () => {
  it('maps agent_start to running session state', () => {
    const events = normalizeSessionEvent({ type: 'agent_start' });
    expect(events[0]).toEqual({ type: 'session-state', state: { sessionId: '', status: 'running', streaming: true } });
  });

  it('maps message_update to message-update event', () => {
    const events = normalizeSessionEvent({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
    });
    expect(events[0].type).toBe('message-update');
    expect(events[0].message.parts[0]).toEqual({ type: 'text', text: 'hi' });
  });

  it('maps tool_execution_start to tool-start + tool-update', () => {
    const events = normalizeSessionEvent({ type: 'tool_execution_start', toolCallId: 't', toolName: 'bash', args: {} });
    expect(events.map((e) => e.type)).toEqual(['tool-start', 'tool-update']);
  });

  it('maps agent_end to session-ended', () => {
    const events = normalizeSessionEvent({ type: 'agent_end', messages: [] });
    expect(events[0].type).toBe('session-ended');
  });

  it('maps available_commands_update to available-commands-update', () => {
    const events = normalizeSessionEvent({
      type: 'available_commands_update',
      commands: [{ name: 'compact', description: 'Compact' }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('available-commands-update');
    expect(events[0].commands[0].name).toBe('compact');
  });

  it('ignores unknown frames (forward compatibility)', () => {
    expect(normalizeSessionEvent({ type: 'brand_new_event_2027' })).toEqual([]);
    expect(normalizeSessionEvent(null)).toEqual([]);
  });
});

describe('normalizeAsk', () => {
  it('maps select requests', () => {
    const ask = normalizeAsk({ type: 'extension_ui_request', id: 'q1', method: 'select', title: 'Pick', options: ['a', 'b'] });
    expect(ask).toMatchObject({ id: 'q1', method: 'select', title: 'Pick', options: ['a', 'b'] });
  });

  it('maps confirm requests', () => {
    const ask = normalizeAsk({ type: 'extension_ui_request', id: 'q2', method: 'confirm', title: 'Sure?', message: 'Really?' });
    expect(ask.method).toBe('confirm');
  });

  it('ignores non-ask methods', () => {
    expect(normalizeAsk({ type: 'extension_ui_request', id: 'x', method: 'notify', message: 'hi' })).toBeNull();
    expect(normalizeAsk({ type: 'extension_ui_request', id: 'x', method: 'setWidget', widgetKey: 'k' })).toBeNull();
  });
});

describe('normalizeSubagent', () => {
  it('maps subagent_progress frames', () => {
    const sub = normalizeSubagent({
      type: 'subagent_progress',
      payload: { subagentId: 's1', agent: 'scout', status: 'running', toolCalls: 8, elapsedMs: 23000 },
    });
    expect(sub).toMatchObject({ id: 's1', agent: 'scout', status: 'running' });
    expect(sub.progress.toolCalls).toBe(8);
  });
});

describe('normalizeTodos / todo_reminder', () => {
  it('normalizes OMP TodoItems to OpenCode Todo shape', () => {
    const todos = normalizeSessionEvent({
      type: 'todo_reminder',
      todos: [
        { content: 'Review', status: 'in_progress' },
        { content: 'Test', status: 'completed' },
        { content: 'Ship', status: 'pending' },
        { content: 'Blocked', status: 'blocked', blocker: 'waiting on CI' },
      ],
    });
    expect(todos[0].type).toBe('todo-update');
    const list = todos[0].todos;
    expect(list.map((t) => [t.content, t.status])).toEqual([
      ['Review', 'in_progress'],
      ['Test', 'completed'],
      ['Ship', 'pending'],
      ['Blocked', 'in_progress'],
    ]);
    expect(list[3].blocker).toBe('waiting on CI');
  });

  it('todo_auto_clear empties the todo list', () => {
    const events = normalizeSessionEvent({ type: 'todo_auto_clear' });
    expect(events[0]).toEqual({ type: 'todo-update', sessionId: '', todos: [] });
  });
});
