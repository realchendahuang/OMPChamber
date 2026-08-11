import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

const originalFetch = globalThis.fetch;

const { handleSpecialGitBridgeMessage } = await import('./bridge-git-special-runtime');

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const createDeps = () => ({
  readSettings: () => ({}),
  execGit: mock(),
  getGitRangeFiles: mock(async () => ['src/a.ts']),
  getGitRangeDiff: mock(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line' })),
});

describe('bridge git special runtime', () => {
  beforeEach(() => {
    rawFetch.mockClear();
    globalThis.fetch = rawFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('generates PR descriptions through the OMPChamber session flow', async () => {
    rawFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/api/model')) {
        return jsonResponse([{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }]);
      }
      if (u.includes('/api/session') && init?.method === 'POST' && u.includes('/prompt_async')) {
        return jsonResponse({ ok: true, messageID: 'msg_1' });
      }
      if (u.includes('/api/session') && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_1' });
      }
      if (u.includes('/api/session/ses_1/message')) {
        return jsonResponse([{
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: '{"title":"PR title","body":"PR body"}' }],
        }]);
      }
      if (u.includes('/api/session/ses_1') && init?.method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const response = await handleSpecialGitBridgeMessage({
      id: '1',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, createDeps());

    expect(response).toEqual({
      id: '1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'PR title', body: 'PR body' },
    });

    const calls = rawFetch.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method || 'GET' }));
    expect(calls).toContainEqual({ url: 'http://opencode.test/api/model', method: 'GET' });
    expect(calls).toContainEqual({ url: 'http://opencode.test/api/session?directory=%2Frepo', method: 'POST' });
    expect(calls).toContainEqual({ url: 'http://opencode.test/api/session/ses_1/prompt_async?directory=%2Frepo', method: 'POST' });
    expect(calls).toContainEqual({ url: 'http://opencode.test/api/session/ses_1/message?limit=10&directory=%2Frepo', method: 'GET' });
    expect(calls).toContainEqual({ url: 'http://opencode.test/api/session/ses_1?directory=%2Frepo', method: 'DELETE' });
  });

  it('falls back to the zen model when the requested model is not in the catalog', async () => {
    rawFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/api/model')) {
        return jsonResponse([{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }]);
      }
      if (u.includes('/api/session') && init?.method === 'POST' && u.includes('/prompt_async')) {
        const body = JSON.parse(init?.body || '{}');
        expect(body.model).toEqual({ providerID: 'zen', modelID: 'gpt-5-nano' });
        return jsonResponse({ ok: true, messageID: 'msg_1' });
      }
      if (u.includes('/api/session') && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_2' });
      }
      if (u.includes('/api/session/ses_2/message')) {
        return jsonResponse([{
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: '{"title":"T","body":"B"}' }],
        }]);
      }
      if (u.includes('/api/session/ses_2') && init?.method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const response = await handleSpecialGitBridgeMessage({
      id: '2',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'unknown-provider',
        modelId: 'unknown-model',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({}),
      },
    }, createDeps());

    expect(response).toEqual({
      id: '2',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'T', body: 'B' },
    });
  });
});
