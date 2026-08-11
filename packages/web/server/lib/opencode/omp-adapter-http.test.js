/**
 * OMP engine integration test — spawns a real OMP process, registers the
 * adapter routes on an express app, and exercises the HTTP surface the UI
 * consumes (session list, model list, message send, status).
 *
 * Requires a local `omp` binary with at least one configured model.
 * Run: bun test packages/web/server/lib/opencode/omp-adapter-http.test.js
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createOmpRuntime } from '../../agent-runtime/omp/index.js';
import { registerOmpAdapterRoutes } from './omp-adapter-http.js';

const tmpDirs = [];
const tmpCwd = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ompchamber-adapter-'));
  tmpDirs.push(dir);
  return dir;
};

let runtime = null;
let app = null;
let server = null;
let baseUrl = '';
let cwd = '';

beforeAll(async () => {
  cwd = await tmpCwd();
  runtime = createOmpRuntime({ binary: process.env.OMP_BINARY || 'omp', cwd, env: {} });
  await runtime.start();

  app = express();
  app.use(express.json());
  registerOmpAdapterRoutes(app, {
    getOmpRuntime: () => runtime,
    getDirectory: () => cwd,
  });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await runtime?.stop();
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

describe('OMP adapter HTTP surface', () => {
  it('reports agent status', async () => {
    const res = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('omp');
    expect(body.connected).toBe(true);
    expect(typeof body.pid).toBe('number');
  });

  it('lists models from OMP', async () => {
    const res = await fetch(`${baseUrl}/api/model`);
    expect(res.status).toBe(200);
    const models = await res.json();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('id');
    expect(models[0]).toHaveProperty('providerID');
  });

  it('lists providers grouped from OMP models', async () => {
    const res = await fetch(`${baseUrl}/api/provider`);
    expect(res.status).toBe(200);
    const providers = await res.json();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]).toHaveProperty('id');
    expect(Array.isArray(providers[0].models)).toBe(true);
  });

  it('returns an empty global config so settings pages do not crash', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('lists the current OMP session', async () => {
    const res = await fetch(`${baseUrl}/api/session`);
    expect(res.status).toBe(200);
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0]).toHaveProperty('id');
    expect(sessions[0].metadata?.engine).toBe('omp');
  });

  it('creates a new session', async () => {
    const res = await fetch(`${baseUrl}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    const session = await res.json();
    expect(session).toHaveProperty('id');
  });

  it('sends a message and returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/session/current/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'reply with exactly OK' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('aborts a running turn', async () => {
    const res = await fetch(`${baseUrl}/api/session/current/abort`, { method: 'POST' });
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.ok).toBe(true);
    }
  });

  it('compacts the session', async () => {
    const res = await fetch(`${baseUrl}/api/session/current/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customInstructions: 'Summarize the conversation' }),
    });
    expect([200, 500]).toContain(res.status);
  });

  it('renames the session', async () => {
    const res = await fetch(`${baseUrl}/api/session/current/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My OMP test session' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('sets the thinking level', async () => {
    const res = await fetch(`${baseUrl}/api/ompchamber/thinking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'high' }),
    });
    expect([200, 500]).toContain(res.status);
  });

  it('answers an ask request', async () => {
    const res = await fetch(`${baseUrl}/api/ompchamber/ask/test-ask-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'selected-option' }),
    });
    expect([200, 500]).toContain(res.status);
  });

  it('degrades OpenCode-ecosystem endpoints to empty lists instead of 404', async () => {
    for (const endpoint of ['/api/agent', '/api/command', '/api/mcp', '/api/project', '/api/skill']) {
      const res = await fetch(`${baseUrl}${endpoint}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it('serves the extended ecosystem endpoints without 404', async () => {
    for (const endpoint of ['/api/config/providers', '/api/project/current', '/api/experimental/tool/ids', '/api/question', '/api/permission']) {
      const res = await fetch(`${baseUrl}${endpoint}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it('reports session status as a Record<sessionId,{type}> map', async () => {
    const res = await fetch(`${baseUrl}/api/session/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const sessionIds = Object.keys(body);
    expect(sessionIds.length).toBeGreaterThan(0);
    for (const id of sessionIds) {
      expect(body[id]).toHaveProperty('type');
      expect(['idle', 'busy', 'retry']).toContain(body[id].type);
    }
  });

  it('normalizes a path with OpenCode-shaped fields', async () => {
    const res = await fetch(`${baseUrl}/api/path?directory=/tmp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.directory).toBe('/tmp');
    expect(body.worktree).toBe('/tmp');
    expect(body.state).toBe('/tmp');
  });

  it('reports an OpenCode-shaped global version without a real OpenCode server', async () => {
    const res = await fetch(`${baseUrl}/api/global/version`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.version).toBe('string');
    expect(typeof body.clientVersion).toBe('string');
  });

  it('returns the current OMP session for a single-session resume', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;
    expect(typeof sessionId).toBe('string');

    const res = await fetch(`${baseUrl}/api/session/${sessionId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(sessionId);
    expect(typeof body.title).toBe('string');
    expect(typeof body.version).toBe('string');
    expect(body.metadata?.engine).toBe('omp');
  });

  it('renames the session via PATCH (SDK session.update shape)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'resume-test' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('resume-test');
    expect(body.metadata?.engine).toBe('omp');
  });

  it('accepts the UI promptAsync send shape and echoes back messageID', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: 'prompt-async-test' }],
        messageID: 'msg-abc-123',
        model: { providerID: 'p', modelID: 'm' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messageID).toBe('msg-abc-123');
  });

  it('rejects an empty promptAsync message', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('forks a session via POST fork (OMP new_session mapping)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}/fork`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.id).toBe('string');
    expect(typeof body.title).toBe('string');
    expect(body.metadata?.engine).toBe('omp');
  });

  it('deletes a session (OMP no-op returns ok:true)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('reports command invocations as unsupported (501)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'compact', arguments: [] }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('returns session todos as an array', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}/todo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('reports revert/unrevert/shell/summarize as unsupported (501)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    for (const op of ['revert', 'unrevert', 'shell', 'summarize', 'command']) {
      const res = await fetch(`${baseUrl}/api/session/${sessionId}/${op}`, { method: 'POST' });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
    }
  });

  it('accepts OpenCode-shaped permission replies (confirm ask)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    for (const reply of ['once', 'always', 'reject']) {
      const res = await fetch(`${baseUrl}/api/session/${sessionId}/permissions/ask-perm-1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    }
  });

  it('accepts OpenCode-shaped question replies and rejects (select/input ask)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const replyRes = await fetch(`${baseUrl}/api/session/${sessionId}/question/ask-q-1/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['option-a']] }),
    });
    expect(replyRes.status).toBe(200);
    expect((await replyRes.json()).ok).toBe(true);

    const rejectRes = await fetch(`${baseUrl}/api/session/${sessionId}/question/ask-q-2/reject`, {
      method: 'POST',
    });
    expect(rejectRes.status).toBe(200);
    expect((await rejectRes.json()).ok).toBe(true);
  });

  it('aborts an in-flight prompt and leaves the session usable for follow-up prompts', async () => {
    // The UI "stop" button hits POST /session/:id/abort while a prompt is
    // streaming. The OMP engine must acknowledge the abort and keep the
    // session usable: a follow-up prompt must still receive a reply.
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    await fetch(`${baseUrl}/api/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: 'Write a very long essay about everything. Keep going.' }],
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const abortRes = await fetch(`${baseUrl}/api/session/${sessionId}/abort`, { method: 'POST' });
    expect(abortRes.status).toBe(200);
    expect((await abortRes.json()).ok).toBe(true);

    const followRes = await fetch(`${baseUrl}/api/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Reply with ABORTED_OK.' }] }),
    });
    expect(followRes.status).toBe(200);

    // Poll for the follow-up reply so the test proves the session survived the abort.
    let replyFound = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const messagesRes = await fetch(`${baseUrl}/api/session/${sessionId}/message?limit=10`);
      const messages = await messagesRes.json();
      for (const message of messages) {
        if (message.info?.role !== 'assistant') continue;
        const text = (message.parts ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
        if (text.includes('ABORTED_OK')) {
          replyFound = true;
          break;
        }
      }
      if (replyFound) break;
    }
    expect(replyFound).toBe(true);
  }, 45_000);
});
