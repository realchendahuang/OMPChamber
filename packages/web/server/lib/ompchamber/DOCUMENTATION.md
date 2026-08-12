# OMPChamber Server Module Documentation

## Purpose

This module provides the OMPChamber server runtime utilities: settings persistence,
route registration, session state, and server orchestration. The OpenCode runtime
modules (lifecycle, env-runtime, proxy, watcher, etc.) were physically removed —
the server runs only the OMP engine (`packages/web/server/agent-runtime/omp/`).

## Entrypoints and structure

- `packages/web/server/lib/ompchamber/agents.js`: agent config file CRUD (markdown frontmatter).
- `packages/web/server/lib/ompchamber/auth.js`: provider authentication file operations (`~/.local/share/opencode/auth.json`).
- `packages/web/server/lib/ompchamber/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OMPChamber route wiring.
- `packages/web/server/lib/ompchamber/commands.js`: command config file CRUD.
- `packages/web/server/lib/ompchamber/config-entity-routes.js`: route registration for agent/command/MCP config orchestration with deferred-apply semantics (`restartDeferred` payloads; explicit apply via `POST /api/config/reload`).
- `packages/web/server/lib/ompchamber/config-mutation-response.js`: shared response builders for deferred restarts and external manual-restart guidance.
- `packages/web/server/lib/ompchamber/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/ompchamber/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration.
- `packages/web/server/lib/ompchamber/hmr-state-runtime.js`: HMR-persistent runtime state initialization and HMR sync helpers.
- `packages/web/server/lib/ompchamber/mcp.js`: MCP config file CRUD.
- `packages/web/server/lib/ompchamber/models-metadata.js`: models.dev metadata fetch/cache.
- `packages/web/server/lib/ompchamber/npm-registry.js`: npm registry queries for plugin specs.
- `packages/web/server/lib/ompchamber/omp-binary-resolution.js`: OMP engine binary resolution (`resolveOmpEngineBinary`) — precedence `OMP_BINARY` env > persisted settings `opencodeBinary` (empty string = cleared sentinel) > deprecated `OPENCODE_BINARY` env alias > `omp` on PATH. Used by `index.js` `resolveOmpLaunchConfig`, which logs the winning source at startup.
- `packages/web/server/lib/ompchamber/ompchamber-routes.js`: OMPChamber update and models metadata route registration.
- `packages/web/server/lib/ompchamber/plugin-routes.js`: plugin config CRUD routes.
- `packages/web/server/lib/ompchamber/plugin-spec.js`: plugin spec parsing (npm/path specs).
- `packages/web/server/lib/ompchamber/plugins.js`: plugin entry CRUD.
- `packages/web/server/lib/ompchamber/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/ompchamber/project-icon-routes.js`: project icon upload/read/discovery route registration.
- `packages/web/server/lib/ompchamber/providers.js`: custom OpenAI-compatible provider config CRUD.
- `packages/web/server/lib/ompchamber/pwa-manifest-routes.js`: PWA manifest route registration.
- `packages/web/server/lib/ompchamber/routes.js`: OMP-named settings/auth/upgrade route registration (`/api/omp/*`, `/api/config/omp-resolution`; upgrade is always unsupported under the OMP engine).
- `packages/web/server/lib/ompchamber/server-startup-runtime.js`: server bind/startup tunnel and process handler wiring.
- `packages/web/server/lib/ompchamber/server-utils-runtime.js`: shared server runtime utilities (PATH augmentation only; the OpenCode proxy/port/snapshot surface was removed).
- `packages/web/server/lib/ompchamber/session-runtime.js`: session status/attention/activity runtime for SSE events.
- `packages/web/server/lib/ompchamber/settings-helpers.js`: Settings payload sanitization/format helpers.
- `packages/web/server/lib/ompchamber/settings-normalization-runtime.js`: path/settings/tunnel normalization helpers.
- `packages/web/server/lib/ompchamber/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization).
- `packages/web/server/lib/ompchamber/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/ompchamber/shutdown-runtime.js`: graceful shutdown orchestration runtime.
- `packages/web/server/lib/ompchamber/skill-routes.js`: skill config CRUD routes.
- `packages/web/server/lib/ompchamber/skills.js`: skill file discovery/indexing.
- `packages/web/server/lib/ompchamber/snippets.js`: opencode-snippets-compatible snippet file CRUD.
- `packages/web/server/lib/ompchamber/startup-pipeline-runtime.js`: server startup tail orchestration (terminal/proxy/static/start-listen flow).
- `packages/web/server/lib/ompchamber/static-routes-runtime.js`: static asset/SPA fallback route registration.
- `packages/web/server/lib/ompchamber/theme-runtime.js`: custom theme JSON validation and loading.
- `packages/web/server/lib/ompchamber/tunnel-auth.js`: tunnel auth controller.
- `packages/web/server/lib/ompchamber/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime.

## OMP engine modules

- `packages/web/server/agent-runtime/omp/`: OMP process manager, RPC client, event normalizer, session manager, model manager, tool normalizer, UI request handler.
- `packages/web/server/agent-runtime/omp/omp-adapter-http.js`: OMP-backed HTTP adapter for the UI's core endpoints (session/model/provider/message/abort/compact/branch/fork/todo/ask/permission).
- `packages/web/server/agent-runtime/omp/omp-event-bridge.js`: projects normalized OMP domain events onto the OpenCode-shaped SSE stream the UI sync layer consumes.

## Shared modules (moved from lib/opencode/)

- `packages/web/server/lib/startup-performance.js`: opt-in startup phase diagnostics.
- `packages/web/server/lib/provider-env-aliases.js`: provider credential env alias mirroring (re-exported by `packages/vscode/src/provider-env-aliases.ts`).

## Removed OpenCode runtime modules

The following OpenCode runtime modules were physically deleted (Phase 5 of the OMP migration):

- `lifecycle.js`, `env-runtime.js`, `env-config.js`, `network-runtime.js`, `auth-state-runtime.js`,
  `opencode-resolution-runtime.js`, `upgrade-capability.js`, `watcher.js`, `managed-process-registry.js`,
  `proxy.js`, `cli-entry-runtime.js`, `cli-options.js`, `path-utils.js`

The server now runs only the OMP engine. `index.js` keeps lifecycle compatibility
stubs (`buildOmpUrl`, `getOmpAuthHeaders`, `waitForOmpReady`, etc.) so
internal consumers (permission-auto-accept, ompchamber-sessions, scheduled-tasks,
notifications, context-obligatory) keep working against the OMP adapter surface.

## Storage and configuration

- Provider auth: `~/.local/share/opencode/auth.json`.
- User config: `~/.config/opencode/opencode.json`.
- Project config: `<workingDirectory>/.opencode/opencode.json` or `opencode.json`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Rate limit config: `OMPCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OMPCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars.

## Notes for contributors

- This module serves as foundation for OMPChamber server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.
