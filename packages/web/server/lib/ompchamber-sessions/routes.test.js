import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeMock = vi.fn(async () => ({
  head: 'abc123',
  name: 'side-task',
  branch: 'ompchamber/side-task',
  path: '/repo/worktrees/side-task',
}));
const getWorktreeBootstrapStatusMock = vi.fn(async () => ({
  status: 'ready',
  phase: 'setup-ready',
  error: null,
  updatedAt: Date.now(),
}));
let existingSessionMessages = [];
let dispatchedUserMessageSeq = 0;

// The service confirms a prompt landed by watching for a new user message, so
// the default message-list mock behaves like the OMP adapter recording each
// dispatched prompt.
const setSessionMessages = (messages) => {
  existingSessionMessages = messages;
};

const recordedSessionMessages = () => {
  dispatchedUserMessageSeq += 1;
  return [
    ...existingSessionMessages,
    {
      info: {
        id: `msg_dispatched_${dispatchedUserMessageSeq}`,
        role: 'user',
        time: { created: 1000 + dispatchedUserMessageSeq },
      },
    },
  ];
};

// Selection inputs are fetched whenever a request names a model, agent, or
// variant, so every prompt-dispatching fetch mock must answer them.
const selectionInputResponse = (url) => {
  const text = String(url);
  if (text.includes('/config/providers')) {
    return {
      ok: true,
      json: async () => ({
        providers: [
          { id: 'openai', models: [{ id: 'gpt-5.5', variants: { high: {} } }] },
          { id: 'anthropic', models: [{ id: 'claude-sonnet-5', variants: { high: {} } }] },
        ],
      }),
    };
  }
  if (text.includes('/agent')) {
    return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }] };
  }
  if (text.includes('/config')) return { ok: true, json: async () => ({}) };
  return null;
};

// Shared fetch mock matching the OMP adapter surface: POST /session creates,
// POST /session/:id/prompt_async dispatches, POST /session/:id/fork forks,
// GET /session/:id/message lists messages, and selection inputs answer their
// JSON shapes.
const createFetchMock = (options = {}) => {
  const {
    sessionID = 'ses_123',
    forkID = 'ses_fork',
    messages = recordedSessionMessages,
  } = options;
  return vi.fn(async (url, requestOptions = {}) => {
    const text = String(url);
    const method = (requestOptions && requestOptions.method) || 'GET';
    if (method === 'POST' && text.includes('/prompt_async')) {
      return { ok: true, text: async () => '' };
    }
    if (method === 'GET' && /\/session\/[^/]+\/message/.test(text)) {
      const list = await messages();
      const records = Array.isArray(list) ? list : (Array.isArray(list?.data) ? list.data : []);
      return { ok: true, json: async () => records };
    }
    if (method === 'POST' && /\/session\/[^/]+\/fork/.test(text)) {
      return { ok: true, json: async () => ({ id: forkID, title: 'Forked session' }) };
    }
    if (method === 'POST' && text.includes('/session?directory')) {
      return { ok: true, json: async () => ({ id: sessionID }) };
    }
    const selection = selectionInputResponse(url);
    if (selection) return selection;
    return { ok: true, json: async () => ({ id: sessionID }) };
  });
};

globalThis.__ompchamberCreateWorktreeMock = createWorktreeMock;
globalThis.__ompchamberGetWorktreeBootstrapStatusMock = getWorktreeBootstrapStatusMock;

let registerOMPChamberSessionRoutes;

vi.mock('../git/index.js', () => ({
  createWorktree: (...args) => globalThis.__ompchamberCreateWorktreeMock(...args),
  getWorktreeBootstrapStatus: (...args) => globalThis.__ompchamberGetWorktreeBootstrapStatusMock(...args),
}));

const createApp = (overrides = {}, options = {}) => {
  const app = express();
  if (options.globalJson !== false) {
    app.use(express.json());
  }
  const calls = [];
  registerOMPChamberSessionRoutes(app, {
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    waitForOpenCodeReady: vi.fn(async () => undefined),
    ...overrides,
  });
  return { app, calls };
};

describe('ompchamber session routes', () => {
  beforeAll(async () => {
    ({ registerOMPChamberSessionRoutes } = await import('./routes.js'));
  });

  beforeEach(() => {
    createWorktreeMock.mockClear();
    getWorktreeBootstrapStatusMock.mockClear();
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
      updatedAt: Date.now(),
    }));
    existingSessionMessages = [];
    dispatchedUserMessageSeq = 0;
  });

  it('creates a session for a directory', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(response.body.sessionId).toBeTruthy();
      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.directory).toBe('/repo/app');
      expect(response.body.promptDispatched).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session?directory=%2Frepo%2Fapp',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ directory: '/repo/app', title: 'Side task' }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses JSON body without global middleware', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp({}, { globalJson: false });
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.directory).toBe('/repo/app');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits a session-created event after creating a session', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/repo/app',
        title: 'Side task',
        promptDispatched: false,
        dispatchedAsCommand: false,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves default model and agent when prompt omits them', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      if (/\/session\/[^/]+\/message/.test(text)) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      if (text.includes('/config/providers')) {
        return { ok: true, json: async () => ({ providers: [{ id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }] }) };
      }
      if (text.includes('/agent')) {
        return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }] };
      }
      if (text.includes('/config')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    globalThis.fetch = fetchMock;
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    try {
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this' })
        .expect(200);

      expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
      expect(response.body.agent).toBe('build');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/config/providers?directory=%2Frepo%2Fapp',
        expect.any(Object),
      );
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(JSON.parse(promptCall?.[1]?.body)).toMatchObject({
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        agent: 'build',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('dispatches an initial prompt when model is provided', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.promptDispatched).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates goal metadata before dispatching the initial goal prompt', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) return { ok: true, text: async () => '' };
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    const createSessionGoal = vi.fn(async () => undefined);
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Finish and verify the migration',
          model: 'openai/gpt-5.5',
          goal: true,
          goalTokenBudget: 200000,
        })
        .expect(200);

      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      const promptPayload = JSON.parse(promptCall[1].body);
      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/repo/app',
        objective: 'Finish and verify the migration',
        tokenBudget: 200000,
        providerID: 'openai',
        modelID: 'gpt-5.5',
      }));
      expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder.at(-1));
      expect(promptPayload.parts).toEqual([
        { type: 'text', text: 'Finish and verify the migration' },
        expect.objectContaining({ type: 'text', synthetic: true }),
      ]);
      expect(response.body).toMatchObject({ goalEnabled: true, goalTokenBudget: 200000, promptDispatched: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects invalid goal requests before creating a session', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', goal: true })
        .expect(400, { error: 'prompt is required when goal is enabled' });
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run', goalTokenBudget: 200000 })
        .expect(400, { error: 'goalTokenBudget requires goal' });
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run', goal: true, goalTokenBudget: 999 })
        .expect(400, { error: 'goalTokenBudget must be an integer from 1000 to 100000000' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates a worktree before creating a session', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task', branchName: 'ompchamber/side-task', startRef: 'main' },
          setUpstream: false,
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
        })
        .expect(200);

      expect(createWorktreeMock).toHaveBeenCalledWith('/repo/app', {
        mode: 'new',
        name: 'side-task',
        branchName: 'ompchamber/side-task',
        startRef: 'main',
        setUpstream: false,
      });
      expect(response.body.directory).toBe('/repo/worktrees/side-task');
      expect(response.body.worktree.path).toBe('/repo/worktrees/side-task');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Frepo%2Fworktrees%2Fside-task',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('waits for the worktree bootstrap to complete before creating the session', async () => {
    const statuses = [
      { status: 'pending', phase: 'directory-created', error: null, updatedAt: 1 },
      { status: 'pending', phase: 'git-ready', error: null, updatedAt: 2 },
      { status: 'ready', phase: 'setup-ready', error: null, updatedAt: 3 },
    ];
    getWorktreeBootstrapStatusMock.mockImplementation(async () => statuses.shift() || statuses[statuses.length - 1]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task' },
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
        })
        .expect(200);

      expect(response.body.promptDispatched).toBe(true);
      const sessionCreateCalls = globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/session?directory'));
      const promptCalls = globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/prompt_async'));
      expect(sessionCreateCalls.length).toBeGreaterThanOrEqual(1);
      expect(promptCalls.length).toBeGreaterThanOrEqual(1);
      const createIndex = globalThis.fetch.mock.calls.indexOf(sessionCreateCalls[0]);
      const promptIndex = globalThis.fetch.mock.calls.indexOf(promptCalls[0]);
      expect(getWorktreeBootstrapStatusMock).toHaveBeenCalled();
      expect(createIndex).toBeGreaterThan(-1);
      expect(promptIndex).toBeGreaterThan(createIndex);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails the create when the worktree bootstrap failed', async () => {
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'failed',
      phase: 'directory-created',
      error: 'branch already exists',
      updatedAt: Date.now(),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task' },
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
        })
        .expect(500, { error: 'Worktree bootstrap failed: branch already exists' });
      const promptCalls = globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/prompt_async'));
      expect(promptCalls.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends a goal prompt to an existing session after creating goal metadata', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return selectionInputResponse(url) || { ok: true, text: async () => '' };
    });
    const createSessionGoal = vi.fn(async () => undefined);
    globalThis.fetch = fetchMock;
    try {
      setSessionMessages([{ info: { id: 'msg_before', role: 'assistant', time: { created: 10, completed: 20 } } }]);
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/ompchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: 'Apply and verify the review feedback',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
          goal: true,
          goalTokenBudget: 200000,
        })
        .expect(200);

      expect(response.body).toMatchObject({
        action: 'send',
        sessionId: 'ses_source',
        directory: '/repo/app',
        promptDispatched: true,
        goalEnabled: true,
        baselineAssistantMessageId: 'msg_before',
      });
      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_source',
        directory: '/repo/app',
        objective: 'Apply and verify the review feedback',
      }));
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(promptCall?.[0]).toBe('http://opencode.test/session/ses_source/prompt_async?directory=%2Frepo%2Fapp');
      expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder.at(-1));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('degrades a slash-command prompt to a plain prompt on the OMP engine', async () => {
    const originalFetch = globalThis.fetch;
    const createSessionGoal = vi.fn(async () => undefined);
    globalThis.fetch = vi.fn(async (url) => {
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return selectionInputResponse(url) || { ok: true, text: async () => '' };
    });
    try {
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/ompchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: '/issue--to-pr LIN-123',
          model: 'openai/gpt-5.5',
          agent: 'build',
          goal: true,
        })
        .expect(200);

      // The OMP engine has no command surface: the slash-command text is sent
      // verbatim as a plain prompt and the goal objective is the raw prompt.
      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        objective: '/issue--to-pr LIN-123',
      }));
      expect(response.body).toMatchObject({ goalEnabled: true, dispatchedAsCommand: false });
      const promptCall = globalThis.fetch.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(JSON.parse(promptCall?.[1]?.body)).toMatchObject({
        parts: expect.arrayContaining([{ type: 'text', text: '/issue--to-pr LIN-123' }]),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reuses the previous session selection when send omits model, agent, and variant', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return selectionInputResponse(url) || { ok: true, text: async () => '' };
    });
    globalThis.fetch = fetchMock;
    try {
      setSessionMessages([
          {
            info: {
              id: 'msg_user',
              role: 'user',
              agent: 'plan',
              model: { providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high' },
              time: { created: 5 },
            },
          },
          { info: { id: 'msg_before', role: 'assistant', time: { created: 10, completed: 20 } } },
      ]);
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue where you left off' })
        .expect(200);

      expect(response.body).toMatchObject({
        action: 'send',
        sessionId: 'ses_source',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
        agent: 'plan',
        variant: 'high',
        promptDispatched: true,
      });
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      const promptBody = JSON.parse(promptCall[1].body);
      expect(promptBody).toMatchObject({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
        agent: 'plan',
        variant: 'high',
      });
      // The default-selection inputs (config/providers/agents) must not be consulted.
      const nonPromptCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('/prompt_async'));
      expect(nonPromptCalls.every(([url]) => /\/session\/[^/]+\/message/.test(String(url)))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forks from a message, dispatches the prompt, and emits the new session', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    globalThis.fetch = vi.fn(async (url) => {
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      if (/\/session\/[^/]+\/fork/.test(String(url))) {
        return { ok: true, json: async () => ({ id: 'ses_fork', title: 'Forked session' }) };
      }
      return selectionInputResponse(url) || { ok: true, text: async () => '' };
    });
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      const response = await request(app)
        .post('/api/ompchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          messageId: 'msg_branch_point',
          prompt: 'Try the alternative implementation',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(200);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_source/fork?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(response.body).toMatchObject({
        action: 'fork',
        sourceSessionId: 'ses_source',
        sessionId: 'ses_fork',
        directory: '/repo/app',
        promptDispatched: true,
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_fork/prompt_async?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_fork',
        sourceSessionID: 'ses_source',
        directory: '/repo/app',
        promptDispatched: true,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects send and fork requests without a prompt before calling OpenCode', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/ompchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app' })
        .expect(400, { error: 'prompt is required' });
      await request(app)
        .post('/api/ompchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app' })
        .expect(400, { error: 'prompt is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the forked session when prompt dispatch fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      if (/\/session\/[^/]+\/fork/.test(String(url))) {
        return { ok: true, json: async () => ({ id: 'ses_fork', title: 'Forked session' }) };
      }
      return selectionInputResponse(url) || { ok: false, status: 500, text: async () => 'dispatch failed' };
    });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          prompt: 'Try another approach',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(500);

      expect(response.body).toMatchObject({
        partial: true,
        partialAction: 'fork-created',
        sessionId: 'ses_fork',
        directory: '/repo/app',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not apply a default variant to an explicitly requested model', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/prompt_async')) return { ok: true, text: async () => '' };
      if (/\/session\/[^/]+\/message/.test(text)) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      if (text.includes('/config/providers')) {
        return {
          ok: true,
          json: async () => ({
            providers: [
              { id: 'openai', models: { requested: { id: 'requested' }, default: { id: 'default', variants: { high: {} } } } },
            ],
          }),
        };
      }
      if (text.includes('/agent')) return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }] };
      if (text.includes('/config')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp({
        readSettingsFromDiskMigrated: async () => ({
          defaultModel: 'openai/default',
          defaultVariant: 'high',
          projects: [{ id: 'proj_1', path: '/repo/app' }],
        }),
      });
      await request(app)
        .post('/api/ompchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue', model: 'openai/requested', agent: 'build' })
        .expect(200);

      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(JSON.parse(promptCall[1].body)).not.toHaveProperty('variant');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an unknown agent before creating a session or worktree', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => ({ id: 'ses_123' }) });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          agent: 'not-an-agent',
          worktree: { name: 'side-task' },
        })
        .expect(400, { error: "Unknown agent 'not-an-agent' for /repo/app" });

      expect(createWorktreeMock).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => String(url) === 'http://opencode.test/session?directory=%2Frepo%2Fapp')).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an unknown model and an unknown variant before dispatching', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => ({ id: 'ses_123' }) });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-nope' })
        .expect(400, { error: "Unknown model 'openai/gpt-nope' for /repo/app" });
      await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5', variant: 'ultra' })
        .expect(400, { error: "Unknown variant 'ultra' for model 'openai/gpt-5.5'" });

      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports promptDispatched false when the accepted prompt never reaches the session', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) return { ok: true, text: async () => '' };
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => [] };
      }
      return selectionInputResponse(url) || { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.promptDispatched).toBe(false);
      expect(response.body.promptError).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 20_000);

  it('sends a slash-command prompt verbatim as a plain prompt on the OMP engine', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (/\/session\/[^/]+\/message/.test(String(url))) {
        return { ok: true, json: async () => recordedSessionMessages() };
      }
      return selectionInputResponse(url) || { ok: true, text: async () => '' };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/ompchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: '/review fix this',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(200);

      expect(response.body).toMatchObject({ promptDispatched: true, dispatchedAsCommand: false });
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(JSON.parse(promptCall[1].body)).toMatchObject({
        parts: [{ type: 'text', text: '/review fix this' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
