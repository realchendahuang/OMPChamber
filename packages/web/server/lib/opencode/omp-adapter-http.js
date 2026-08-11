/**
 * OMP HTTP adapter — projects OMP RPC state onto the HTTP surface the
 * existing OpenChamber UI consumes (`/api/session`, `/api/session/:id/message`,
 * `/api/model`, ...), so the React UI keeps working without redesign while
 * running on the OMP engine.
 *
 * Active only when `OMPCHAMBER_AGENT_ENGINE=omp` (see index.js wiring). When
 * off, the OpenCode proxy path is unchanged. This is the Strangler adapter —
 * it intentionally reuses the existing OpenCode-shaped JSON so the UI is
 * untouched; domain-type convergence happens incrementally afterwards.
 */

import express from 'express';
import { normalizeAgentMessage } from '../../agent-runtime/omp/event-normalizer.js';

const OPENCODE_SDK_VERSION = '1.0.0';

export const ompJsonParser = express.json({ limit: '10mb' });

const toSdkSession = (ompState, { cwd, directory }) => {
  const now = Date.now();
  return {
    id: ompState?.sessionId ?? `omp-${now}`,
    slug: ompState?.sessionId?.slice(0, 12) ?? 'omp-session',
    projectID: directory ?? cwd ?? '',
    directory: directory ?? cwd ?? '',
    title: ompState?.sessionName ?? 'OMP session',
    model: ompState?.model
      ? { id: ompState.model.id ?? '', providerID: ompState.model.provider ?? '', variant: undefined }
      : undefined,
    version: OPENCODE_SDK_VERSION,
    metadata: { engine: 'omp' },
    time: { created: now, updated: now },
  };
};

const toSdkModel = (model) => ({
  id: model?.modelId ?? model?.id ?? '',
  providerID: model?.provider ?? model?.providerId ?? '',
  label: model?.label ?? model?.name ?? undefined,
});

/**
 * Register OMP-backed handlers for the UI's core endpoints.
 *
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {() => import('../../agent-runtime/omp/index.js')} deps.getOmpRuntime
 * @param {(req) => string} deps.getDirectory — resolve requested directory
 * @param {(msg: string) => void} deps.log
 */
export const registerOmpAdapterRoutes = (app, { getOmpRuntime, getDirectory = () => process.cwd(), log = console.log }) => {
  app.get('/api/ompchamber/agent/status', async (_req, res) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return res.status(503).json({ engine: 'omp', connected: false, error: 'OMP runtime not available' });
    }
    const state = runtime.status;
    const session = runtime.session.current;
    return res.json({
      engine: 'omp',
      connected: state.status === 'ready' || state.status === 'running',
      status: state.status,
      pid: runtime.pid,
      restartCount: state.restartCount,
      crash: state.crash,
      session: session,
      model: state.model ?? undefined,
    });
  });

  // Session list — the UI sidebar.
  app.get('/api/session', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const directory = getDirectory(req);
      const session = runtime.session.current;
      const sessions = session?.sessionId ? [toSdkSession(session, { cwd: directory, directory })] : [];
      return res.json(sessions);
    } catch (error) {
      log(`[OMP] session list failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP session list failed' });
    }
  });

  // Session activity status. MUST be registered before the generic
  // /api/session/:sessionId route (express matches in registration order) —
  // otherwise "status" is captured as a session id and the UI receives a
  // session object where it expects a Record<sessionId, {type}> map.
  app.get('/api/session/status', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const session = runtime.session.current;
      if (session?.sessionId) {
        return res.json({ [session.sessionId]: { type: 'busy' } });
      }
      return res.json({});
    } catch (error) {
      log(`[OMP] session status failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP session status failed' });
    }
  });

  // Create a session.
  app.post('/api/session', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const directory = getDirectory(req);
      const result = await runtime.session.create({ parentID: req.body?.parentID });
      const session = runtime.session.current;
      return res.json(toSdkSession(session, { cwd: directory, directory }));
    } catch (error) {
      log(`[OMP] session create failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP session create failed' });
    }
  });

  // Send a message.
  app.post('/api/session/:sessionId/message', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
      const text = parts.map((part) => (part?.type === 'text' ? part.text : '')).join('').trim()
        || req.body?.content || req.body?.text || '';
      if (!text) {
        return res.status(400).json({ error: 'Empty message' });
      }
      await runtime.session.prompt(text);
      return res.status(200).json({ ok: true });
    } catch (error) {
      log(`[OMP] message send failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP message send failed' });
    }
  });

  // UI sends messages via the SDK `session.promptAsync` endpoint
  // (POST /session/{id}/prompt_async). Same prompt handling as the message
  // endpoint above — extract text parts and start the OMP turn.
  app.post('/api/session/:sessionId/prompt_async', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
      const text = parts.map((part) => (part?.type === 'text' ? part.text : '')).join('').trim()
        || req.body?.content || req.body?.text || '';
      if (!text) {
        return res.status(400).json({ error: 'Empty message' });
      }
      await runtime.session.prompt(text);
      return res.status(200).json({ ok: true, messageID: req.body?.messageID ?? null });
    } catch (error) {
      log(`[OMP] prompt_async failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP prompt_async failed' });
    }
  });

  // Message list for a session.
  app.get('/api/session/:sessionId/message', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const rawMessages = await runtime.session.getMessages();
      const messages = (rawMessages || [])
        .map((message) => normalizeAgentMessage(message))
        .filter(Boolean);
      const mapped = messages
        .map((message) => ({
          info: {
            id: message.id,
            sessionId: req.params.sessionId,
            role: message.role,
            time: { created: message.createdAt },
            version: OPENCODE_SDK_VERSION,
          },
          parts: message.parts.map((part) => {
            if (part.type === 'text') return { type: 'text', text: part.text, sessionId: req.params.sessionId };
            if (part.type === 'thinking') return { type: 'reasoning', text: part.text, sessionId: req.params.sessionId };
            if (part.type === 'tool-call') return {
              type: 'tool',
              tool: part.call.name,
              toolCallID: part.call.id,
              state: { input: part.call.input, status: part.call.status },
              sessionId: req.params.sessionId,
            };
            if (part.type === 'tool-result') return {
              type: 'tool-result',
              tool: part.name,
              toolCallID: part.callId,
              state: { output: part.result, status: part.status, error: part.error },
              sessionId: req.params.sessionId,
            };
            return { type: 'text', text: part.error ?? '', sessionId: req.params.sessionId };
          }),
        }))
        .filter(Boolean);
      return res.json(mapped);
    } catch (error) {
      log(`[OMP] message list failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP message list failed' });
    }
  });

  // Model list.
  app.get('/api/model', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const models = await runtime.models.list();
      return res.json(models.map(toSdkModel));
    } catch (error) {
      log(`[OMP] model list failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP model list failed' });
    }
  });

  // Provider list (derived from the OMP model list, grouped by provider).
  app.get('/api/provider', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const models = await runtime.models.list();
      const providers = new Map();
      for (const model of models) {
        if (!model.provider) continue;
        if (!providers.has(model.provider)) {
          providers.set(model.provider, { id: model.provider, name: model.provider, models: [] });
        }
        providers.get(model.provider).models.push({
          id: model.modelId,
          name: model.label ?? model.modelId,
          providerID: model.provider,
        });
      }
      return res.json(Array.from(providers.values()));
    } catch (error) {
      log(`[OMP] provider list failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP provider list failed' });
    }
  });

  // Global config — OMPChamber owns its settings surface (/api/config/settings);
  // the OpenCode-shaped /api/config returns an empty object so the UI settings
  // pages don't crash when the agent engine is OMP.
  app.get('/api/config', async (_req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    return res.json({});
  });

  // Set model.
  app.post('/api/model', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const { providerID, modelID } = req.body ?? {};
      if (!providerID || !modelID) {
        return res.status(400).json({ error: 'providerID and modelID are required' });
      }
      await runtime.models.set(providerID, modelID);
      return res.json({ ok: true });
    } catch (error) {
      log(`[OMP] set model failed: ${error.message}`);
      return res.status(500).json({ error: error.message || 'OMP set model failed' });
    }
  });

  // Abort.
  app.post('/api/session/:sessionId/abort', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      await runtime.session.abort();
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP abort failed' });
    }
  });

  // Compact the conversation.
  app.post('/api/session/:sessionId/compact', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const ok = await runtime.session.compact(req.body?.customInstructions);
      return res.json({ ok });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP compact failed' });
    }
  });

  // Branch the session.
  // Branch session (OMP `branch` command).
  app.post('/api/session/:sessionId/branch', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const result = await runtime.session.branch();
      return res.json(result ?? { ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP branch failed' });
    }
  });

  // Fork session from a message. OMP has no per-message fork; the closest
  // native operation is a new session, which OMP itself treats as a fork of
  // the current conversation (the OMP session remains the source of truth).
  // The UI consumes the returned session object to insert into its sidebar.
  app.post('/api/session/:sessionId/fork', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const cwd = getDirectory(req);
      const created = await runtime.session.create({ parentID: req.params.sessionId });
      if (created?.cancelled === true) {
        return res.status(400).json({ error: 'Session creation cancelled' });
      }
      const session = toSdkSession(runtime.session.current, { cwd, directory: req.query?.directory ?? cwd });
      return res.json({ ...session, id: session.id });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP fork failed' });
    }
  });

  // Delete session. OMP owns session persistence and has no delete command;
  // the OMP session is the source of truth, so a delete is a no-op at the
  // engine level (the UI's local session cache is what actually clears). Return
  // ok:true so the UI's confirmed-deletion path runs and the view updates.
  app.delete('/api/session/:sessionId', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    return res.json({ ok: true });
  });

  // Execute a command (SDK `session.command`). OMP exposes no command
  // registry in the RPC surface (get_available_commands lists UI commands, not
  // an execution path), so command invocations are not supported by the OMP
  // engine. The UI never sends commands here in practice — its slash-command
  // detection relies on the command list, which is empty under OMP — so this
  // is a defensive explicit failure rather than a silent no-op.
  app.post('/api/session/:sessionId/command', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    return res.status(501).json({ error: 'commands are not supported by the OMP engine' });
  });

  // Get session todos (SDK `session.todo`). OMP pushes todo updates via
  // todo_reminder events (bridged to the UI); the GET surface returns the
  // current OMP session's todo state when known, otherwise an empty list.
  app.get('/api/session/:sessionId/todo', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const todos = runtime.session.current?.todos ?? [];
      return res.json(Array.isArray(todos) ? todos : []);
    } catch {
      return res.json([]);
    }
  });

  // Revert/unrevert/shell/summarize have no OMP RPC equivalent. These are
  // OpenCode-specific session operations; return an explicit failure so the
  // UI's catch paths surface a message instead of a bare 404.
  app.post('/api/session/:sessionId/revert', async (_req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    return res.status(501).json({ error: 'revert is not supported by the OMP engine' });
  });
  app.post('/api/session/:sessionId/unrevert', async (_req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    return res.status(501).json({ error: 'unrevert is not supported by the OMP engine' });
  });
  app.post('/api/session/:sessionId/shell', async (_req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    return res.status(501).json({ error: 'shell is not supported by the OMP engine' });
  });
  app.post('/api/session/:sessionId/summarize', async (_req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    return res.status(501).json({ error: 'summarize is not supported by the OMP engine' });
  });

  // Rename session.
  app.post('/api/session/:sessionId/update', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      if (typeof req.body?.title === 'string' && req.body.title) {
        await runtime.session.setSessionName(req.body.title);
      }
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP rename failed' });
    }
  });

  // Get a single session (session resume). The OMP runtime tracks one active
  // session at a time; returning the current session for any requested id lets
  // the UI open the selected conversation (source of truth stays the OMP
  // session, whose messages are read back via GET /api/session/:id/message).
  app.get('/api/session/:sessionId', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const state = runtime.status;
      const cwd = getDirectory(req);
      const session = toSdkSession(runtime.session.current, { cwd, directory: req.query?.directory ?? cwd });
      return res.json({ ...session, id: req.params.sessionId });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP session get failed' });
    }
  });

  // Update session properties (SDK `session.update` uses PATCH). Handles the
  // rename path the UI exercises when editing a session title.
  app.patch('/api/session/:sessionId', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const { title, metadata } = req.body ?? {};
      if (typeof title === 'string' && title) {
        await runtime.session.setSessionName(title);
      }
      const state = runtime.status;
      const cwd = getDirectory(req);
      const session = toSdkSession(runtime.session.current, { cwd, directory: req.query?.directory ?? cwd });
      if (metadata && typeof metadata === 'object') {
        session.metadata = { ...(session.metadata ?? {}), ...metadata };
      }
      return res.json(session);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP session update failed' });
    }
  });

  // Thinking level.
  app.post('/api/ompchamber/thinking', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      await runtime.models.setThinkingLevel(req.body?.level);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP thinking failed' });
    }
  });

  // Answer an OMP ask (extension_ui_request → UI question).
  app.post('/api/ompchamber/ask/:askId', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const { value, confirmed, cancelled } = req.body ?? {};
      await runtime.respondAsk(req.params.askId, { value, confirmed, cancelled: !!cancelled });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP ask response failed' });
    }
  });

  // OpenCode-shaped permission/question reply endpoints. The UI answers an
  // OMP ask (confirm/select/input → permission.asked/question.asked) through
  // the SDK permission/question surfaces; map them back to respondAsk.
  // - permission reply (confirm): reply 'once' → confirmed, 'reject' → cancelled
  // - question reply (select/input): answers[0][0] → value
  // - question reject: cancelled
  app.post('/api/session/:sessionId/permissions/:permissionId', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const reply = req.body?.reply;
      const confirmed = reply !== 'reject';
      await runtime.respondAsk(req.params.permissionId, { confirmed, cancelled: !confirmed });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP permission reply failed' });
    }
  });
  app.post('/api/session/:sessionId/question/:requestId/reply', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const answers = req.body?.answers ?? [];
      const value = Array.isArray(answers[0]) ? answers[0][0] : answers[0];
      await runtime.respondAsk(req.params.requestId, { value, confirmed: true, cancelled: false });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP question reply failed' });
    }
  });
  app.post('/api/session/:sessionId/question/:requestId/reject', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      await runtime.respondAsk(req.params.requestId, { cancelled: true, confirmed: false });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP question reject failed' });
    }
  });

  // Set the session todo plan (Phase 4 todo UI).
  app.post('/api/ompchamber/todo', ompJsonParser, async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      await runtime.session.setTodos(req.body?.todoPhases ?? []);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP todo failed' });
    }
  });

  // Subagent list (Phase 4 task/subagent UI).
  app.get('/api/ompchamber/subagents', async (req, res, next) => {
    const runtime = getOmpRuntime();
    if (!runtime) {
      return next();
    }
    try {
      const subagents = await runtime.session.getSubagents();
      return res.json(subagents);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'OMP subagents failed' });
    }
  });

  // OpenCode-ecosystem data endpoints the UI still polls (agents/mcp/skills/
  // commands/projects). The OMP engine owns its own configuration model, so
  // these return explicit empty shapes instead of 404 — the UI renders an
  // empty state rather than surfacing repeated fetch errors. Domain mapping
  // for these surfaces is Phase 6 work (OMP-native equivalents).
  const EMPTY_LIST = [];
  const openCodeEcosystemEndpoints = [
    '/api/agent',
    '/api/command',
    '/api/mcp',
    '/api/project',
    '/api/skill',
    // Provider config registry — the OMP engine owns its model/provider
    // configuration (surfaced via /api/model and /api/provider), so the
    // OpenCode-shaped config.providers list is empty rather than a 404.
    '/api/config/providers',
    // Current project — OMP tracks one working directory per session; the
    // OpenCode-shaped project.current query returns an empty list.
    '/api/project/current',
    // Experimental tool id registry (used by tool state checks).
    '/api/experimental/tool/ids',
    // Pending permission/question requests — OMP asks flow through the
    // /api/ompchamber/ask endpoints, not the OpenCode permission surface.
    '/api/question',
    '/api/permission',
  ];
  for (const endpoint of openCodeEcosystemEndpoints) {
    app.get(endpoint, (req, res, next) => {
      if (!getOmpRuntime()) {
        return next();
      }
      return res.json(EMPTY_LIST);
    });
  }
  // Path normalization — OMP operates on real filesystem paths (no OpenCode
  // path indirection), so report the requested directory with its own fields.
  app.get('/api/path', (req, res, next) => {
    if (!getOmpRuntime()) {
      return next();
    }
    const directory = req.query?.directory || req.query?.path || '';
    const value = typeof directory === 'string' ? directory : String(directory);
    return res.json({ directory: value, worktree: value, state: value });
  });
  app.get('/api/global/version', (req, res, next) => {
    if (!getOmpRuntime()) {
      return next();
    }
    return res.json({
      version: OPENCODE_SDK_VERSION,
      clientVersion: OPENCODE_SDK_VERSION,
      git: { sha: '', branch: '' },
    });
  });
};
