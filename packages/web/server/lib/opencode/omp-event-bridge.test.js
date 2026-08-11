import { describe, expect, it } from 'bun:test';

import { domainEventToSseFrames } from './omp-event-bridge.js';

describe('domainEventToSseFrames', () => {
  it('converts a message-update into message.updated + part frames', () => {
    const frames = domainEventToSseFrames({
      type: 'message-update',
      sessionId: 's1',
      message: {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        complete: true,
        createdAt: 1000,
        parts: [
          { type: 'text', text: 'hi' },
          { type: 'thinking', text: 'plan' },
        ],
      },
    });

    expect(frames[0].type).toBe('message.updated');
    expect(frames[0].properties.info).toMatchObject({ id: 'm1', role: 'assistant' });

    expect(frames[1].type).toBe('message.part.updated');
    expect(frames[1].properties.part).toMatchObject({ type: 'text', text: 'hi' });
    expect(frames[1].properties.part.messageID).toBe('m1');

    expect(frames[2].type).toBe('message.part.updated');
    expect(frames[2].properties.part.type).toBe('reasoning');
  });

  it('converts tool-call parts into SDK tool parts', () => {
    const frames = domainEventToSseFrames({
      type: 'message-update',
      sessionId: 's1',
      message: {
        id: 'm2',
        sessionId: 's1',
        role: 'assistant',
        complete: false,
        createdAt: 1,
        parts: [{
          type: 'tool-call',
          call: { id: 'tc1', name: 'bash', input: { command: 'npm test' }, status: 'running' },
        }],
      },
    });
    const toolPart = frames.find((f) => f.type === 'message.part.updated')?.properties.part;
    expect(toolPart.type).toBe('tool');
    expect(toolPart.tool).toBe('bash');
    expect(toolPart.toolCallID).toBe('tc1');
    expect(toolPart.state.input).toEqual({ command: 'npm test' });
  });

  it('returns empty for non-message events', () => {
    expect(domainEventToSseFrames({ type: 'tool-start', sessionId: 's', call: {} })).toEqual([]);
    expect(domainEventToSseFrames({ type: 'session-ended', sessionId: 's' })).toEqual([]);
  });
});

describe('todo projection', () => {
  it('converts todo-update into todo.updated frame', () => {
    const frames = domainEventToSseFrames({
      type: 'todo-update',
      sessionId: 's1',
      todos: [
        { id: 't1', content: 'Fix types', status: 'in_progress', priority: 'medium' },
        { id: 't2', content: 'Run tests', status: 'pending', priority: 'medium' },
      ],
    });
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('todo.updated');
    expect(frames[0].properties.sessionID).toBe('s1');
    expect(frames[0].properties.todos[0].content).toBe('Fix types');
    expect(frames[0].properties.todos[0].status).toBe('in_progress');
  });
});

describe('ask projection', () => {
  it('maps a confirm ask to permission.asked', () => {
    const frames = domainEventToSseFrames({
      type: 'ask',
      sessionId: 's1',
      ask: { id: 'a1', method: 'confirm', title: 'Run tests?', message: 'Allow bash?' },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('permission.asked');
    expect(frames[0].properties.sessionID).toBe('s1');
    expect(frames[0].properties.permission.id).toBe('a1');
    expect(frames[0].properties.permission.permission).toBe('Run tests?');
    expect(frames[0].properties.permission.metadata.omp.kind).toBe('confirm');
  });

  it('maps a select ask to question.asked with options', () => {
    const frames = domainEventToSseFrames({
      type: 'ask',
      sessionId: 's1',
      ask: {
        id: 'a2',
        method: 'select',
        title: 'Pick provider',
        message: 'Which provider?',
        options: ['a', { label: 'b', description: 'bee' }],
      },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('question.asked');
    expect(frames[0].properties.question.id).toBe('a2');
    expect(frames[0].properties.question.questions[0].options).toEqual([
      { label: 'a', description: '' },
      { label: 'b', description: 'bee' },
    ]);
  });

  it('maps an input ask to question.asked', () => {
    const frames = domainEventToSseFrames({
      type: 'ask',
      sessionId: 's1',
      ask: { id: 'a3', method: 'input', title: 'Enter text', message: 'Type something', placeholder: 'text here' },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('question.asked');
    expect(frames[0].properties.question.questions[0].question).toBe('Type something');
    expect(frames[0].properties.question.questions[0].placeholder).toBe('text here');
  });

  it('ignores asks without an id and non-ask events', () => {
    expect(domainEventToSseFrames({ type: 'ask', sessionId: 's1', ask: { method: 'confirm' } })).toEqual([]);
    expect(domainEventToSseFrames({ type: 'session-ended', sessionId: 's1' })).toEqual([]);
  });
});
