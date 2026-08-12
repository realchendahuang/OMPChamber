# OMP Runtime Module Documentation

## Purpose

This module bridges the OMP agent runtime (Oh My Pi) into OMPChamber. It spawns
`omp --mode rpc-ui` as a supervised child process and normalizes OMP's
stdin/stdout RPC frames into OMPChamber domain events that the UI consumes.

The UI never sees raw OMP frames. Every OMP frame passes through a normalizer
and is projected onto the existing OpenChamber HTTP/SSE surface (or the
`@ompchamber/agent-protocol` domain types) before reaching React.

## Entrypoints and structure

- `index.js`: public entrypoint — `createOmpRuntime(...)` assembles the full
  runtime (process manager + RPC client + session/model managers + normalizers)
  and exposes the domain `AgentRuntime` surface.
- `process-manager.js`: spawns/supervises `omp --mode rpc-ui`. Guarantees
  crash isolation, exit detection, stderr capture, restart with backoff,
  start/ready timeouts, and clean teardown. Windows: `.cmd`/`.bat` launchers
  spawn with `shell: true` (Node EINVAL / CVE-2024-27980) and all spawns use
  `windowsHide: true` (see `resolveSpawnOptions`).
- `rpc-client.js`: JSON-Lines (NDJSON) client over stdin/stdout. Buffers
  stdout into complete frames, correlates command `id` → response promises,
  and reassembles protocol-v2 `rpc_chunk` frames.
- `rpc-types.js`: OMP RPC command names (including `bash`/`abort_bash`/
  `get_branch_messages`/`get_available_commands`), frame discriminators, and
  `extension_ui_request` methods (select/confirm/input/editor/...).
- `event-normalizer.js`: converts OMP `AgentSessionEvent` frames into
  OMPChamber domain events (`message-update`, `tool-start/update/end`,
  `session-ended`, `session-state`, `available-commands-update`, ...) and OMP
  `extension_ui_request` frames into domain `AgentAsk` objects.
- `session-manager.js`: maps OMP session lifecycle (new_session, get_state,
  prompt, steer, abort, compact, branch, switch_session, rename, messages,
  bash/abort_bash, get_branch_messages, get_available_commands). Also derives
  live session state from raw frames (`observeFrame`): the `busy` flag
  (agent_start → agent_end, authoritatively reconciled from get_state
  `isStreaming`/`isCompacting` on every refresh), the last-known todo list
  (todo_reminder/todo_auto_clear, plus todos mined from get_state when
  present), and the available-commands cache. `branch` requires a user-message
  `entryId` from `get_branch_messages`; OMP rejects bare branch requests.
  OMP Session is the conversation source of truth.
- `model-manager.js`: exposes provider/model/thinking from OMP
  (get_available_models, set_model, cycle_model, set_thinking_level).
- `tool-normalizer.js`: standardizes OMP tool calls into a renderable shape
  and describes native vs generic renderer tiers (P0/P1 tools).
- `ui-request-handler.js`: routes `extension_ui_request` asks to the UI and
  forwards answers back to OMP. Keeps a pending-ask registry (track/untrack/
  listPending/clearPending) backing the adapter's `/api/question` and
  `/api/permission` surfaces; entries leave on reply, OMP-side cancel, or
  engine crash.
- `compatibility.js`: parses/checks the OMP version against the pinned floor
  (OMPChamber 0.1 ↔ OMP 17.2.x) and describes incompatibilities.
- `logger.js`: writes `~/.ompchamber/logs/{omp,rpc,crash}.log` with secret
  redaction (Authorization, API keys, OAuth tokens).

## Runtime behavior

- OMP runs as an independent child process (`omp --mode rpc-ui`). It is never
  imported into React or run in the Electron main process directly.
- On process crash the manager reports an `OMP crashed [Restart Agent]`
  state with the crash reason and restarts with exponential backoff.
- Protocol negotiation: the client sends `negotiate_protocol` (v2) after the
  `ready` frame and reassembles `rpc_chunk` frames up to the protocol v2 cap.
- The `index.js` runtime exposes `session`, `models`, `respondAsk`,
  `listPendingAsks`, `subscribe`, `status`, `pid`, `version`, and `rpc`.
  `version` is the real OMP engine version detected via `omp --version` at
  startup (the rpc-ui `ready` frame carries protocol versions only), or null
  when undetectable; detection never blocks startup.

## HTTP/SSE projection

The OMP engine is activated with `OMPCHAMBER_AGENT_ENGINE=omp` (see
`packages/web/server/lib/opencode/omp-adapter-http.js`). When enabled:

- The server spawns `omp --mode rpc-ui` instead of OpenCode.
- `registerOmpAdapterRoutes(app, ...)` serves the UI's core HTTP surface
  (`/api/session`, `/api/session/:id/message`, `/api/model`, abort/compact/
  branch/fork/rename/thinking/ask, command list+execution, shell, summarize,
  todo, question/permission) from OMP RPC state. Notable mappings:
  - `GET /api/session/status` reports busy only while a turn is actually
    running (event-derived, get_state-reconciled); idle sessions are omitted.
  - `GET /api/global/version` + `/api/global/health` report the real OMP
    version (falling back to the SDK-shape constant when unknown).
  - `GET /api/command` serves the real `get_available_commands` list;
    `POST /api/session/:id/command` validates the name and executes it as a
    `/name args` prompt (unknown names get 404 — an unregistered `/name`
    would silently fall through to the agent as plain text).
  - `POST /api/session/:id/shell` maps onto the `bash` RPC (request/response,
    no output streaming).
  - `POST /api/session/:id/summarize` aliases `compact`.
  - `POST /api/session/:id/fork` branches at a user-message entry via
    `get_branch_messages` + `branch` (falls back to new-session when the
    session has no branchable entries; the forked session does not copy
    history).
  - `GET /api/question` + `/api/permission` serve the pending-ask registry.
  - revert/unrevert remain explicit 501s (genuine OMP gap); session delete is
    an intentional ok-true no-op (OMP owns session persistence).
- `omp-event-bridge.js` (`domainEventToSseFrames`) projects normalized OMP
  domain events onto OpenCode-shaped SSE frames (`message.updated`,
  `message.part.updated`, `todo.updated`, `session.status` (busy) /
  `session.idle` from turn begin/end, `permission.asked`/`question.asked`,
  `ompchamber:subagent`, `ompchamber:available-commands`) fed into the
  existing global message-stream hub.
- `global-hub.markConnected()` prevents the WS bridge from trying to reach an
  (absent) OpenCode upstream SSE stream.

OpenCode remains the default engine; flipping the env var moves the agent
engine to OMP without touching the UI. This is the Strangler adapter.

## Notes for contributors

- Keep the UI decoupled: never import OMP types into `packages/ui`. Add to
  `packages/agent-protocol` for domain types and to the normalizers for OMP
  protocol changes.
- Keep the process-manager's lifecycle guarantees intact (restart/backoff/
  teardown). Do not spawn OMP from UI code.
- Preserve secret redaction in `logger.js`; never log raw API keys.
- When OMP upgrades, run the compatibility check and the protocol tests
  (fixtures under this module) before promoting the new pinned version.

## Testing

- `bun test packages/web/server/agent-runtime/omp/event-normalizer.test.js`
- `bun test packages/web/server/agent-runtime/omp/session-manager.test.js`
- `bun test packages/web/server/agent-runtime/omp/ui-request-handler.test.js`
- `bun test packages/web/server/agent-runtime/omp/process-manager.test.js`
- `bun test packages/web/server/agent-runtime/omp/omp-adapter-routes.test.js` — stub-runtime route mapping tests
- `bun test packages/web/server/agent-runtime/omp/omp-adapter-http.test.js` — real-binary integration tests
- `bun test packages/web/server/lib/opencode/omp-event-bridge.test.js`
- `node packages/web/server/agent-runtime/omp/smoke-test.mjs` — real OMP spawn
  smoke test (requires a local `omp` binary with a configured model).
- Repo validation: `bun run type-check`, `bun run lint`, `bun run build`.
