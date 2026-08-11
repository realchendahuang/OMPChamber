import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createGlobalUiEventBroadcaster, createMessageStreamWsRuntime, registerGlobalEventSseRoute } from './runtime.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {
    void 0;
  }

  close(code, reason) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.emit('close');
  }
}

function createSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              const next = blocks[index++];
              return { value: encoder.encode(next), done: false };
            }

            if (!holdOpen) {
              return { value: undefined, done: true };
            }

            return new Promise((resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        };
      },
    },
  };
}

describe('event stream broadcaster', () => {
  it('fans out synthetic events to SSE and WS clients', () => {
    const sseEvents = [];
    const wsPayloads = [];
    const sseClient = { id: 'sse-1' };
    const wsClient = {
      readyState: 1,
      send(payload) {
        wsPayloads.push(JSON.parse(payload));
      },
    };

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set([sseClient]),
      wsClients: new Set([wsClient]),
      writeSseEvent(res, payload) {
        sseEvents.push({ res, payload });
      },
    });

    broadcast({ type: 'ompchamber:session-status' }, { eventId: 'evt-1', directory: '/tmp/project' });

    expect(sseEvents).toEqual([
      {
        res: sseClient,
        payload: { type: 'ompchamber:session-status' },
      },
    ]);
    expect(wsPayloads).toEqual([
      {
        type: 'event',
        payload: { type: 'ompchamber:session-status' },
        eventId: 'evt-1',
        directory: '/tmp/project',
      },
    ]);
  });

  it('removes websocket clients that fail to receive a payload', () => {
    const wsClients = new Set([
      {
        readyState: 1,
        send() {
          throw new Error('socket write failed');
        },
      },
    ]);

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set(),
      wsClients,
      writeSseEvent() {
        throw new Error('should not be called');
      },
    });

    broadcast({ type: 'ompchamber:notification' });

    expect(wsClients.size).toBe(0);
  });
});

describe('message stream websocket runtime', () => {
  it('shares one global upstream SSE reader across multiple websocket clients', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
    });

    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/global/event/ws' });
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchCalls).toBe(1);
    expect(firstSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(firstSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'server.connected', properties: {} },
      eventId: 'evt-1',
      directory: 'global',
    });
    expect(secondSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'server.connected', properties: {} },
      eventId: 'evt-1',
      directory: 'global',
    });

    firstSocket.close();
    secondSocket.close();
    await runtime.close();
  });

  it('replays buffered global events after a reconnecting client Last-Event-ID', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
              'id: evt-2\ndata: {"type":"session.updated","properties":{"directory":"/tmp/project"}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [],
        });
      },
    });

    const firstSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));
    firstSocket.close();

    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/global/event/ws?lastEventId=evt-1' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(secondSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'session.updated', properties: { directory: '/tmp/project' } },
      eventId: 'evt-2',
      directory: '/tmp/project',
    });

    secondSocket.close();
    await runtime.close();
  });

  it('keeps directory websocket streams on separate upstream readers', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    const fetchUrls = [];

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (url, options) => {
        fetchUrls.push(url);
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
    });

    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/event/ws?directory=/tmp/one' });
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/event/ws?directory=/tmp/two' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchUrls).toHaveLength(2);
    expect(new URL(fetchUrls[0]).searchParams.get('directory')).toBe('/tmp/one');
    expect(new URL(fetchUrls[1]).searchParams.get('directory')).toBe('/tmp/two');
    expect(firstSocket.sent).toContainEqual({ type: 'ready', scope: 'directory' });
    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'directory' });

    firstSocket.close();
    secondSocket.close();
    await runtime.close();
  });

  it('closes the websocket and triggers health check on initial upstream unavailable response', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      upstreamReconnectDelayMs: 0,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: null,
      }),
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toEqual([
      {
        type: 'error',
        message: 'OpenCode event stream unavailable (503)',
      },
    ]);
    expect(socket.closeCalls).toEqual([
      {
        code: 1011,
        reason: 'OpenCode event stream unavailable',
      },
    ]);
    expect(triggerHealthCheckCalls).toBe(1);
    expect(wsClients.size).toBe(0);

    await runtime.close();
  });

  it('closes the websocket without health check when OpenCode URL cannot be built', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl() {
        throw new Error('missing OpenCode port');
      },
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      upstreamReconnectDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('fetch should not be called');
      },
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toEqual([
      {
        type: 'error',
        message: 'OpenCode service unavailable',
      },
    ]);
    expect(socket.closeCalls).toEqual([
      {
        code: 1011,
        reason: 'OpenCode service unavailable',
      },
    ]);
    expect(fetchCalls).toBe(0);
    expect(triggerHealthCheckCalls).toBe(0);

    await runtime.close();
  });

  it('reconnects a stalled upstream SSE stream and resumes from the last event id', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;
    const fetchCalls = [];
    let upstreamAttempt = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      heartbeatIntervalMs: 50,
      upstreamStallTimeoutMs: 20,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        const lastEventId = options?.headers?.['Last-Event-ID'] ?? null;
        fetchCalls.push(lastEventId);
        upstreamAttempt += 1;

        if (upstreamAttempt === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'id: evt-2\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 35));

    const readyFrames = socket.sent.filter((frame) => frame.type === 'ready');
    const eventFrames = socket.sent.filter((frame) => frame.type === 'event' && frame.payload?.type === 'server.connected');

    expect(readyFrames.length).toBeGreaterThanOrEqual(2);
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);
    expect(fetchCalls.slice(0, 2)).toEqual([null, 'evt-1']);
    expect(triggerHealthCheckCalls).toBe(0);

    socket.close();
    await runtime.close();
  });

  it('keeps synthetic event processing on forwarded upstream events', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload(payload, emitSynthetic) {
        if (payload.type === 'session.updated') {
          emitSynthetic({ type: 'ompchamber:session-status', sessionID: 'ses_1' });
        }
      },
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{"directory":"/tmp/project"}}\n\n',
        ],
      }),
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'session.updated', properties: { directory: '/tmp/project' } },
      eventId: 'evt-1',
      directory: '/tmp/project',
    });
    expect(socket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'ompchamber:session-status', sessionID: 'ses_1' },
      directory: 'global',
    });

    socket.close();
    await runtime.close();
  });
});

describe('global event SSE route', () => {
  const createHub = () => {
    const subscribers = new Set();
    const replay = [];
    return {
      subscribeEvent(subscriber) {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      },
      publishEvent({ payload, directory = 'global', eventId }) {
        const entry = { payload, directory, eventId };
        if (eventId) {
          replay.push(entry);
          if (replay.length > 10) replay.shift();
        }
        for (const subscriber of Array.from(subscribers)) {
          subscriber(entry);
        }
      },
      replayAfter(eventId) {
        const index = replay.findIndex((entry) => entry.eventId === eventId);
        return index === -1 ? [] : replay.slice(index + 1);
      },
    };
  };

  const createApp = () => {
    const express = { routes: [] };
    const app = {
      get(path, handler) {
        express.routes.push({ path, handler });
      },
    };
    return { app, express };
  };

  const createRes = () => {
    const chunks = [];
    const headers = {};
    return {
      chunks,
      headers,
      setHeader(name, value) {
        headers[name] = value;
      },
      flushHeaders() {},
      write(chunk) {
        chunks.push(chunk);
      },
    };
  };

  it('streams hub events as SSE frames with event ids', () => {
    const hub = createHub();
    const { app, express } = createApp();
    const writeSseEvent = (res, payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    registerGlobalEventSseRoute({ app, globalEventHub: hub, writeSseEvent });

    expect(express.routes).toHaveLength(1);
    expect(express.routes[0].path).toBe('/api/global/event');

    const res = createRes();
    const req = new EventEmitter();
    req.headers = {};
    express.routes[0].handler(req, res);

    hub.publishEvent({
      payload: { type: 'session.updated', properties: { id: 'ses_1' } },
      directory: '/repo',
      eventId: 'evt-1',
    });

    expect(res.chunks.join('')).toContain('id: evt-1\n');
    expect(res.chunks.join('')).toContain('data: {"type":"session.updated","properties":{"id":"ses_1"},"directory":"/repo"}');
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');

    req.emit('close');
  });

  it('replays buffered events after the requested Last-Event-ID', () => {
    const hub = createHub();
    const { app, express } = createApp();
    const writeSseEvent = (res, payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    registerGlobalEventSseRoute({ app, globalEventHub: hub, writeSseEvent });

    hub.publishEvent({ payload: { type: 'session.updated', properties: { id: 'ses_1' } }, eventId: 'evt-1' });
    hub.publishEvent({ payload: { type: 'session.updated', properties: { id: 'ses_2' } }, eventId: 'evt-2' });

    const res = createRes();
    const req = new EventEmitter();
    req.headers = { 'last-event-id': 'evt-1' };
    express.routes[0].handler(req, res);

    const output = res.chunks.join('');
    expect(output).toContain('id: evt-2\n');
    expect(output).toContain('"id":"ses_2"');
    expect(output).not.toContain('"id":"ses_1"');

    req.emit('close');
  });

  it('emits heartbeats while the client stays connected', async () => {
    const hub = createHub();
    const { app, express } = createApp();
    const writeSseEvent = (res, payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    registerGlobalEventSseRoute({ app, globalEventHub: hub, writeSseEvent, heartbeatIntervalMs: 5 });

    const res = createRes();
    const req = new EventEmitter();
    req.headers = {};
    express.routes[0].handler(req, res);

    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(res.chunks.join('')).toContain('ompchamber:heartbeat');

    req.emit('close');
  });
});
