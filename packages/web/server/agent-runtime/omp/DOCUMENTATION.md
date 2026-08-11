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
  start/ready timeouts, and clean teardown.
- `rpc-client.js`: JSON-Lines (NDJSON) client over stdin/stdout. Buffers
  stdout into complete frames, correlates command `id` → response promises,
  and reassembles protocol-v2 `rpc_chunk` frames.
- `rpc-types.js`: OMP RPC command names, frame discriminators, and
  `extension_ui_request` methods (select/confirm/input/editor/...).
- `event-normalizer.js`: converts OMP `AgentSessionEvent` frames into
  OMPChamber domain events (`message-update`, `tool-start/update/end`,
  `session-ended`, ...) and OMP `extension_ui_request` frames into domain
  `AgentAsk` objects.
- `session-manager.js`: maps OMP session lifecycle (new_session, get_state,
  prompt, steer, abort, compact, branch, switch_session, rename, messages).
  OMP Session is the conversation source of truth.
- `model-manager.js`: exposes provider/model/thinking from OMP
  (get_available_models, set_model, cycle_model, set_thinking_level).
- `tool-normalizer.js`: standardizes OMP tool calls into a renderable shape
  and describes native vs generic renderer tiers (P0/P1 tools).
- `ui-request-handler.js`: routes `extension_ui_request` asks to the UI and
  forwards answers back to OMP.
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
  `subscribe`, `status`, `pid`, and `rpc`.

## HTTP/SSE projection

The OMP engine is activated with `OMPCHAMBER_AGENT_ENGINE=omp` (see
`packages/web/server/lib/opencode/omp-adapter-http.js`). When enabled:

- The server spawns `omp --mode rpc-ui` instead of OpenCode.
- `registerOmpAdapterRoutes(app, ...)` serves the UI's core HTTP surface
  (`/api/session`, `/api/session/:id/message`, `/api/model`, abort/compact/
  branch/rename/thinking/ask) from OMP RPC state.
- `omp-event-bridge.js` (`domainEventToSseFrames`) projects normalized OMP
  domain events onto OpenCode-shaped SSE frames (`message.updated`,
  `message.part.updated`) fed into the existing global message-stream hub.
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
- `bun test packages/web/server/lib/opencode/omp-adapter-http.test.js`
- `bun test packages/web/server/lib/opencode/omp-event-bridge.test.js`
- `node packages/web/server/agent-runtime/omp/smoke-test.mjs` — real OMP spawn
  smoke test (requires a local `omp` binary with a configured model).
- Repo validation: `bun run type-check`, `bun run lint`, `bun run build`.
