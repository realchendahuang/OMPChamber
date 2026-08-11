/**
 * OMP protocol compatibility tests — recorded RPC fixtures.
 *
 * These fixtures capture the OMP RPC frames observed on the wire (from
 * real `omp --mode rpc-ui` sessions) and assert the normalizer projects them
 * into the domain protocol correctly. Every OMP upgrade must keep these
 * green (OMP_MIGRATION_MAP §7, Protocol Test).
 *
 * The fixtures are static snapshots, so these tests do not require a live
 * OMP process.
 */
import { describe, expect, it } from 'bun:test';

import {
  normalizeAgentMessage,
  normalizeAsk,
  normalizeSessionEvent,
  normalizeSubagent,
  normalizeTodos,
  normalizeToolFrame,
} from './event-normalizer.js';
import { domainEventToSseFrames } from '../../lib/opencode/omp-event-bridge.js';
describe('OMP protocol fixtures (recorded from omp 17.2.x)', () => {
  it('normalizes a ready frame as a no-op (readiness is handled by the process manager)', () => {
    expect(normalizeSessionEvent({ type: 'ready' })).toEqual([]);
  });

  it('normalizes agent_start to a running session state', () => {
    const events = normalizeSessionEvent({ type: 'agent_start' });
    expect(events[0]).toMatchObject({ type: 'session-state', state: { status: 'running', streaming: true } });
  });

  it('normalizes a message_update with thinking + text (recorded shape)', () => {
    // Recorded from a real OMP session: assistant message with thinking block
    // and text block, responseId for identity.
    const frame = {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'EVT_OK', partial: {} },
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', thinkingSignature: '{"type":"reasoning","summary":[{"text":"plan the reply"}]}' },
          { type: 'text', text: 'EVT_OK', textSignature: '{"v":1,"id":"msg_593460"}' },
        ],
        api: 'openai-responses',
        provider: 'oc',
        model: 'deepseek-v4-flash:cloud',
        responseId: 'resp_274047',
        timestamp: 1786370098000,
      },
    };
    const events = normalizeSessionEvent(frame);
    expect(events[0].type).toBe('message-update');
    const message = events[0].message;
    expect(message.id).toBe('resp_274047');
    expect(message.role).toBe('assistant');
    expect(message.parts[0].type).toBe('thinking');
    expect(message.parts[1]).toMatchObject({ type: 'text', text: 'EVT_OK' });

    // Bridge projection to the UI SSE shape.
    const sse = domainEventToSseFrames(events[0]);
    expect(sse[0].type).toBe('message.updated');
    expect(sse[0].properties.info.id).toBe('resp_274047');
    expect(sse.some((f) => f.type === 'message.part.updated' && f.properties.part.type === 'reasoning')).toBe(true);
  });

  it('normalizes a tool_execution_start frame', () => {
    const call = normalizeToolFrame({
      type: 'tool_execution_start',
      toolCallId: 'tool_001',
      toolName: 'read',
      args: { path: '/project/src/app.ts' },
    });
    expect(call).toMatchObject({ id: 'tool_001', name: 'read', status: 'running', input: { path: '/project/src/app.ts' } });
  });

  it('normalizes a tool_execution_end frame', () => {
    const call = normalizeToolFrame({
      type: 'tool_execution_end',
      toolCallId: 'tool_001',
      toolName: 'edit',
      result: { success: true, filePath: '/project/src/app.ts' },
    });
    expect(call).toMatchObject({ id: 'tool_001', name: 'edit', status: 'completed' });
  });

  it('normalizes an extension_ui_request select as an ask', () => {
    const ask = normalizeAsk({
      type: 'extension_ui_request',
      id: 'ask_1',
      method: 'select',
      title: 'Choose a model',
      options: ['fast', 'balanced', 'max'],
    });
    expect(ask).toMatchObject({ id: 'ask_1', method: 'select', title: 'Choose a model', options: ['fast', 'balanced', 'max'] });
  });

  it('normalizes an extension_ui_request confirm as an ask', () => {
    const ask = normalizeAsk({
      type: 'extension_ui_request',
      id: 'ask_2',
      method: 'confirm',
      title: 'Run this command?',
      message: 'npm run deploy -- --prod',
    });
    expect(ask).toMatchObject({ id: 'ask_2', method: 'confirm', title: 'Run this command?' });
  });

  it('ignores non-ask extension_ui_request frames', () => {
    expect(normalizeAsk({ type: 'extension_ui_request', id: 'x', method: 'notify', message: 'hello' })).toBeNull();
    expect(normalizeAsk({ type: 'extension_ui_request', id: 'x', method: 'setWidget', widgetKey: 'k' })).toBeNull();
  });

  it('normalizes a todo_reminder frame into todos', () => {
    const events = normalizeSessionEvent({
      type: 'todo_reminder',
      todos: [
        { content: 'Review', status: 'in_progress' },
        { content: 'Ship', status: 'pending' },
      ],
    });
    expect(events[0].type).toBe('todo-update');
    expect(events[0].todos.map((t) => t.content)).toEqual(['Review', 'Ship']);

    // Bridge projection → UI todo.updated
    const sse = domainEventToSseFrames(events[0]);
    expect(sse[0].type).toBe('todo.updated');
    expect(sse[0].properties.todos[0].content).toBe('Review');
  });

  it('normalizes a subagent_progress frame', () => {
    const sub = normalizeSubagent({
      type: 'subagent_progress',
      payload: { subagentId: 'sub_1', agent: 'scout', status: 'running', toolCalls: 8, elapsedMs: 23000 },
    });
    expect(sub).toMatchObject({ id: 'sub_1', agent: 'scout', status: 'running' });
    expect(sub.progress.toolCalls).toBe(8);
  });

  it('maps a user message with string content', () => {
    const msg = normalizeAgentMessage({ role: 'user', content: 'Fix the type errors', timestamp: 100 });
    expect(msg.role).toBe('user');
    expect(msg.parts).toEqual([{ type: 'text', text: 'Fix the type errors' }]);
  });

  it('treats unknown frame types as forward-compatible no-ops', () => {
    expect(normalizeSessionEvent({ type: 'future_event_2027', payload: {} })).toEqual([]);
    expect(normalizeSessionEvent(null)).toEqual([]);
    expect(normalizeSessionEvent(undefined)).toEqual([]);
  });

  it('normalizes todo_auto_clear to an empty todo list', () => {
    const events = normalizeSessionEvent({ type: 'todo_auto_clear' });
    expect(events[0]).toEqual({ type: 'todo-update', sessionId: '', todos: [] });
  });
});
