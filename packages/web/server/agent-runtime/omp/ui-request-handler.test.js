import { describe, expect, it } from 'bun:test';

import { createOmpUiRequestHandler } from './ui-request-handler.js';

const createHandler = () => {
  const sent = [];
  const client = { notify: async (frame) => sent.push(frame) };
  const handler = createOmpUiRequestHandler({
    onAsk: () => {},
    onResponse: () => {},
    rpc: async () => client,
  });
  return { handler, sent };
};

describe('pending ask registry', () => {
  it('tracks asks with their session id and lists them', () => {
    const { handler } = createHandler();
    handler.track({ id: 'a1', method: 'confirm', title: 'Allow?' }, 'sess-1');
    handler.track({ id: 'a2', method: 'select', title: 'Pick' }, 'sess-1');
    const pending = handler.listPending();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ id: 'a1', sessionId: 'sess-1' });
    expect(pending[1]).toMatchObject({ id: 'a2', sessionId: 'sess-1' });
    expect(typeof pending[0].createdAt).toBe('number');
  });

  it('ignores asks without a valid id', () => {
    const { handler } = createHandler();
    handler.track({ method: 'confirm' }, 's');
    handler.track(null, 's');
    expect(handler.listPending()).toEqual([]);
  });

  it('untracks on respond (answered asks leave the registry)', async () => {
    const { handler, sent } = createHandler();
    handler.track({ id: 'a1', method: 'confirm', title: 'Allow?' }, 'sess-1');
    await handler.respond('a1', { confirmed: true });
    expect(handler.listPending()).toEqual([]);
    expect(sent[0]).toMatchObject({ type: 'extension_ui_response', id: 'a1', confirmed: true });
  });

  it('untracks on OMP-side cancel frames (handleFrame) and untrack()', () => {
    const { handler } = createHandler();
    handler.track({ id: 'a1', method: 'input', title: 'Type' }, 'sess-1');
    const wasAsk = handler.handleFrame({ type: 'extension_ui_request', method: 'cancel', targetId: 'a1' });
    expect(wasAsk).toBe(true);
    expect(handler.listPending()).toEqual([]);

    handler.track({ id: 'a2', method: 'select', title: 'Pick' }, 'sess-1');
    handler.untrack('a2');
    expect(handler.listPending()).toEqual([]);
  });

  it('clearPending drops everything (engine crash)', () => {
    const { handler } = createHandler();
    handler.track({ id: 'a1', method: 'confirm' }, 's');
    handler.track({ id: 'a2', method: 'select' }, 's');
    handler.clearPending();
    expect(handler.listPending()).toEqual([]);
  });
});
