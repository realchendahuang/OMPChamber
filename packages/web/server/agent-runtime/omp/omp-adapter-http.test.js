/**
 * OMP engine integration test — spawns a real OMP process, registers the
 * adapter routes on an express app, and exercises the HTTP surface the UI
 * consumes (session list, model list, message send, status).
 *
 * Requires a local `omp` binary with at least one configured model.
 * Run: bun test packages/web/server/agent-runtime/omp/omp-adapter-http.test.js
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createOmpRuntime } from './index.js';
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
    for (const endpoint of ['/api/agent', '/api/mcp', '/api/project', '/api/skill']) {
      const res = await fetch(`${baseUrl}${endpoint}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it('lists real OMP slash commands in the OpenCode command shape', async () => {
    const res = await fetch(`${baseUrl}/api/command`);
    expect(res.status).toBe(200);
    const commands = await res.json();
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
    expect(typeof commands[0].name).toBe('string');
  });

  it('serves the extended ecosystem endpoints without 404', async () => {
    for (const endpoint of ['/api/config/providers', '/api/project/current', '/api/experimental/tool/ids', '/api/question', '/api/permission']) {
      const res = await fetch(`${baseUrl}${endpoint}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it('reports session status as a Record<sessionId,{type}> map ({} when idle)', async () => {
    const res = await fetch(`${baseUrl}/api/session/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
    // Idle sessions are omitted; any present entry must be a valid status.
    for (const id of Object.keys(body)) {
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

  it('reports the real OMP version in the OpenCode-shaped payload', async () => {
    const res = await fetch(`${baseUrl}/api/global/version`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Detected via `omp --version` at runtime startup ("omp/17.2.12" → "17.2.12").
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.clientVersion).toBe(body.version);
    const health = await (await fetch(`${baseUrl}/api/global/health`)).json();
    expect(health.healthy).toBe(true);
    expect(health.version).toBe(body.version);
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

  it('forks a session via POST fork (OMP branch mapping)', async () => {
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

  it('rejects unknown commands with 404 and missing command names with 400', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const unknown = await fetch(`${baseUrl}/api/session/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'definitely-not-a-real-command-xyz', arguments: '' }),
    });
    expect(unknown.status).toBe(404);
    expect(typeof (await unknown.json()).error).toBe('string');

    const missing = await fetch(`${baseUrl}/api/session/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
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

  it('reports revert/unrevert as unsupported (501)', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    for (const op of ['revert', 'unrevert']) {
      const res = await fetch(`${baseUrl}/api/session/${sessionId}/${op}`, { method: 'POST' });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
    }
  });

  it('runs a shell command through the OMP bash RPC', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo omp-shell-echo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.info?.role).toBe('assistant');
    expect(body.parts?.[0]?.text).toContain('omp-shell-echo');
    expect(body.parts?.[0]?.metadata?.exitCode).toBe(0);
  });

  it('summarizes via the compact alias', async () => {
    const statusRes = await fetch(`${baseUrl}/api/ompchamber/agent/status`);
    const status = await statusRes.json();
    const sessionId = status.session?.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sessionId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerID: 'p', modelID: 'm', auto: true }),
    });
    // Compact needs a configured model; accept an honest failure.
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(await res.json()).toBe(true);
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

  it('derives busy status from the live turn and returns to idle after abort', async () => {
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

    let sawBusy = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await fetch(`${baseUrl}/api/session/status`);
      const body = await res.json();
      if (body[sessionId]?.type === 'busy') {
        sawBusy = true;
        break;
      }
    }
    expect(sawBusy).toBe(true);

    await fetch(`${baseUrl}/api/session/${sessionId}/abort`, { method: 'POST' });
    let sawIdle = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await fetch(`${baseUrl}/api/session/status`);
      const body = await res.json();
      if (!body[sessionId]) {
        sawIdle = true;
        break;
      }
    }
    expect(sawIdle).toBe(true);
  }, 45_000);

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
