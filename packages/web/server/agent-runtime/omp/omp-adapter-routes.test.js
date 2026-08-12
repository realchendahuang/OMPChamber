/**
 * OMP adapter route tests with a stub runtime (no real OMP process) — covers
 * the endpoint mappings that previously returned fakes (status, version,
 * todos, command list/exec, shell, summarize, fork, pending asks).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';

import { registerOmpAdapterRoutes } from './omp-adapter-http.js';

const createFakeRuntime = (overrides = {}) => {
  const calls = { prompt: [], branch: [], compact: 0, runBash: [], create: [], refresh: 0, listCommands: 0, listSessions: 0, resumeSession: [], deleteSession: [] };
  const runtime = {
    status: { status: 'ready', restartCount: 0, crash: null },
    pid: 4242,
    version: '17.2.12',
    session: {
      current: { sessionId: 'sess-1', sessionName: 'Test session', busy: false, todos: [] },
      prompt: async (text) => { calls.prompt.push(text); },
      abort: async () => {},
      compact: async () => { calls.compact += 1; return true; },
      branch: async (entryId) => { calls.branch.push(entryId); return { text: 'entry text', cancelled: false }; },
      getBranchMessages: async () => [{ entryId: 'e1', text: 'first' }, { entryId: 'e2', text: 'second' }],
      create: async () => { calls.create.push(true); return { cancelled: false }; },
      refresh: async () => { calls.refresh += 1; return {}; },
      runBash: async (command) => { calls.runBash.push(command); return { exitCode: 0, output: 'hello\n', cancelled: false, workingDir: '/tmp' }; },
      listCommands: async () => { calls.listCommands += 1; return [{ name: 'compact', description: 'Compact session' }, { name: 'skill:review', description: 'Review skill' }]; },
      getCachedCommands: () => [],
      setSessionName: async () => {},
      getMessages: async () => [],
      getSubagents: async () => [],
      setTodos: async () => {},
      listSessions: async () => { calls.listSessions += 1; return []; },
      resumeSession: async (sessionId) => { calls.resumeSession.push(sessionId); return { status: 'current' }; },
      deleteSession: async (sessionId) => { calls.deleteSession.push(sessionId); return { status: 'deleted', wasActive: false }; },
    },
    models: {
      list: async () => [],
      set: async () => {},
      setThinkingLevel: async () => {},
    },
    respondAsk: async () => {},
    listPendingAsks: () => [],
  };
  return { runtime: { ...runtime, ...overrides }, calls };
};

let server = null;
let baseUrl = '';

const startApp = async (runtime) => {
  const app = express();
  app.use(express.json());
  registerOmpAdapterRoutes(app, {
    getOmpRuntime: () => runtime,
    getDirectory: () => '/tmp',
    log: () => {},
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
};

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

describe('session status', () => {
  it('returns {} when the session is idle (missing sessionId means idle)', async () => {
    const { runtime } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('reports busy only while the session is actually busy', async () => {
    const { runtime } = createFakeRuntime();
    runtime.session.current = { ...runtime.session.current, busy: true };
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'sess-1': { type: 'busy' } });
  });
});

describe('version + health', () => {
  it('reports the real OMP version', async () => {
    const { runtime } = createFakeRuntime();
    await startApp(runtime);
    const version = await (await fetch(`${baseUrl}/api/global/version`)).json();
    expect(version.version).toBe('17.2.12');
    expect(version.clientVersion).toBe('17.2.12');
    const health = await (await fetch(`${baseUrl}/api/global/health`)).json();
    expect(health.healthy).toBe(true);
    expect(health.version).toBe('17.2.12');
  });

  it('falls back gracefully when the version is unknown', async () => {
    const { runtime } = createFakeRuntime({ version: null });
    await startApp(runtime);
    const version = await (await fetch(`${baseUrl}/api/global/version`)).json();
    expect(version.version).toBe('1.0.0');
  });
});

describe('todos', () => {
  it('returns the last-known todo list recorded from events', async () => {
    const { runtime } = createFakeRuntime();
    runtime.session.current = {
      ...runtime.session.current,
      todos: [{ id: 't1', content: 'Do thing', status: 'in_progress', priority: 'medium' }],
    };
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/todo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ content: 'Do thing', status: 'in_progress' });
  });
});

describe('command list + execution', () => {
  it('serves the real command list in the OpenCode shape', async () => {
    const { runtime } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/command`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ name: 'compact', description: 'Compact session' });
    expect(body[1]).toMatchObject({ name: 'skill:review', source: 'skill' });
  });

  it('executes a known command via a /name args prompt', async () => {
    const { runtime, calls } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'compact', arguments: 'focus on types' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls.prompt).toEqual(['/compact focus on types']);
  });

  it('rejects unknown commands with 404 instead of sending text to the agent', async () => {
    const { runtime, calls } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'bogus-xyz' }),
    });
    expect(res.status).toBe(404);
    expect(calls.prompt).toEqual([]);
  });

  it('requires a command name', async () => {
    const { runtime } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('shell via bash RPC', () => {
  it('maps the bash result into the OpenCode info/parts shape', async () => {
    const { runtime, calls } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo hello', agent: 'a', model: { providerID: 'p', modelID: 'm' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(calls.runBash).toEqual(['echo hello']);
    expect(body.info).toMatchObject({ sessionID: 'sess-1', role: 'assistant' });
    expect(body.parts[0]).toMatchObject({ type: 'text', text: 'hello\n' });
    expect(body.parts[0].metadata).toMatchObject({ engine: 'omp', exitCode: 0 });
  });

  it('requires a command', async () => {
    const { runtime } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('summarize alias', () => {
  it('returns true when compact succeeds', async () => {
    const { runtime, calls } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerID: 'p', modelID: 'm', auto: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(true);
    expect(calls.compact).toBe(1);
  });

  it('fails honestly when compact does not complete', async () => {
    const { runtime } = createFakeRuntime();
    runtime.session.compact = async () => false;
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
  });
});

describe('fork via branch', () => {
  it('branches at the latest entry when messageID does not match an entryId', async () => {
    const { runtime, calls } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID: 'ui-normalized-id' }),
    });
    expect(res.status).toBe(200);
    expect(calls.branch).toEqual(['e2']);
    expect(calls.refresh).toBe(1);
    const body = await res.json();
    expect(body.metadata?.engine).toBe('omp');
  });

  it('branches at the exact entry when messageID matches an entryId', async () => {
    const { runtime, calls } = createFakeRuntime();
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID: 'e1' }),
    });
    expect(res.status).toBe(200);
    expect(calls.branch).toEqual(['e1']);
  });

  it('keeps the 400-on-cancelled behavior', async () => {
    const { runtime } = createFakeRuntime();
    runtime.session.branch = async () => ({ cancelled: true });
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('falls back to new-session when there are no branchable entries', async () => {
    const { runtime, calls } = createFakeRuntime();
    runtime.session.getBranchMessages = async () => [];
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1/fork`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(calls.create).toHaveLength(1);
    expect(calls.branch).toEqual([]);
  });
});

describe('pending question/permission registry', () => {
  it('serves pending confirm asks as PermissionRequests and others as QuestionRequests', async () => {
    const { runtime } = createFakeRuntime({
      listPendingAsks: () => [
        { id: 'ask-1', method: 'confirm', title: 'Allow bash?', message: 'Run tests?', sessionId: 'sess-1' },
        { id: 'ask-2', method: 'select', title: 'Pick one', message: 'Which?', options: ['a', 'b'], sessionId: 'sess-1' },
      ],
    });
    await startApp(runtime);

    const permissions = await (await fetch(`${baseUrl}/api/permission`)).json();
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({ id: 'ask-1', sessionID: 'sess-1', permission: 'Allow bash?' });

    const questions = await (await fetch(`${baseUrl}/api/question`)).json();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ id: 'ask-2', sessionID: 'sess-1' });
    expect(questions[0].questions[0].options).toEqual([
      { label: 'a', description: '' },
      { label: 'b', description: '' },
    ]);
  });

  it('returns empty lists when nothing is pending', async () => {
    const { runtime } = createFakeRuntime();
    await startApp(runtime);
    expect(await (await fetch(`${baseUrl}/api/permission`)).json()).toEqual([]);
    expect(await (await fetch(`${baseUrl}/api/question`)).json()).toEqual([]);
  });
});

describe('session list/get/delete', () => {
  it('lists sessions from the on-disk store', async () => {
    const { runtime, calls } = createFakeRuntime();
    runtime.session.listSessions = async () => {
      calls.listSessions += 1;
      return [
        {
          id: 'sess-disk-1',
          title: 'Disk session',
          directory: '/tmp',
          parentID: 'parent-1',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_100_000,
        },
      ];
    };
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: 'sess-disk-1',
      title: 'Disk session',
      directory: '/tmp',
      parentID: 'parent-1',
      metadata: { engine: 'omp' },
    });
    expect(calls.listSessions).toBe(1);
  });

  it('returns 404 when resuming a missing session', async () => {
    const { runtime, calls } = createFakeRuntime();
    runtime.session.resumeSession = async (sessionId) => { calls.resumeSession.push(sessionId); return { status: 'not-found' }; };
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/missing-id`);
    expect(res.status).toBe(404);
    expect(calls.resumeSession).toEqual(['missing-id']);
  });

  it('deletes a session and reports whether it was active', async () => {
    const { runtime, calls } = createFakeRuntime();
    runtime.session.deleteSession = async (sessionId) => { calls.deleteSession.push(sessionId); return { status: 'deleted', wasActive: true }; };
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/sess-1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.wasActive).toBe(true);
    expect(calls.deleteSession).toEqual(['sess-1']);
  });

  it('returns 404 when deleting a missing session', async () => {
    const { runtime } = createFakeRuntime();
    runtime.session.deleteSession = async () => ({ status: 'not-found' });
    await startApp(runtime);
    const res = await fetch(`${baseUrl}/api/session/missing-id`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
