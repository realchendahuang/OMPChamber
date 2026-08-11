# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OMPChamber-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Markdown loop discovery/parsing is owned by `packages/web/server/lib/scheduled-tasks/loops.js`.
- Runtime orchestration and execution is owned by `packages/web/server/lib/scheduled-tasks/runtime.js`.
- This module is OMPChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Concurrency controls
  - Session create + prompt_async execution
  - Emits OMPChamber task-run events
  - Execution talks to the OMP engine through the adapter's OpenCode-shaped
    HTTP surface with plain `fetch` (no `@opencode-ai/sdk` dependency):
    `createSession` / `listCommands` / `runSessionCommand` are injectable
    defaults; the defaults POST `/session` and `/session/:id/prompt_async`.
    OMP has no command surface, so slash-command prompts resolve to no
    command and run as plain prompts.

- `packages/web/server/lib/scheduled-tasks/loops.js`
  - Discovery of `.agents/loops/*.md` (project scope, ancestors up to the worktree root) and `~/.agents/loops/*.md` (user scope)
  - Frontmatter parsing into scheduled-task definitions
  - `syncProject` reconciles discovered loops with the persisted task list on every project sync (startup, task list load, task save/delete)

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Scheduled task CRUD endpoints
  - Listing tasks reconciles loop files first, so opening the Scheduled Tasks UI discovers file additions, edits, and removals without a server restart
  - Loop-file endpoints toggle `enabled` in frontmatter or delete the authoritative markdown file, then reconcile the project
  - Manual run endpoint
  - OMPChamber events SSE stream endpoint

## Loop file format

Portable, git-commit-able scheduled-task definitions:

```markdown
---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: anthropic/claude-sonnet-4-5
agent: plan
timezone: Europe/Kyiv
---
Summarize repository changes since yesterday.
```

Field mapping (model: `packages/ui/src/lib/scheduledTasksApi.ts`):

| Frontmatter | Task field |
|---|---|
| `name` | `name` (required, max 80 characters — longer names are rejected as malformed) |
| `schedule` | `schedule.kind: "cron"` + `schedule.cron` (required, cron-only in the portable format) |
| `enabled` | `enabled` (default `false` — a loop only runs when the file explicitly enables it; add `enabled: true` to activate) |
| `model` | split on the first `/` into `execution.providerID` / `execution.modelID` (required) |
| `agent` | `execution.agent` (optional) |
| `timezone` | `schedule.timezone` (optional, IANA; defaults to the server zone) |
| body | `execution.prompt` (required) |

`thinking_level` and `goalEnabled`/`goalTokenBudget` are not part of the portable
format (UI/JSON-only today); `daily`/`weekly`/`once` schedules remain UI/JSON-only.
Runtime state (`lastRunAt`, `nextRunAt`, `lastStatus`, `lastError`, `lastSessionId`,
`lastDurationMs`) is never written to the markdown file — it continues to live in
the project config state store.

## Loop reconciliation rules

`projectConfigRuntime.reconcileLoopTasks(projectID, loops)` runs inside the
project write lock on every `syncProject` when the project path is known:

- **Identity.** For loop-owned tasks (carrying the `loopFile` marker) identity
  is the loop file path: a loop takes its task over regardless of the task's
  current name, so renaming the loop (the `name` field, or a UI rename) renames
  the task in place instead of leaving a stale duplicate behind. A loop whose
  name matches a JSON task (no `loopFile`) takes that task over instead: its
  schedule/execution/enabled are overwritten from the file while the task's
  `id` and runtime `state` are preserved (markdown wins on conflict).
- **UI-only fields survive adoption.** Execution fields the file format does
  not define (`goalEnabled`, `goalTokenBudget`, `permissionAutoAccept`,
  `variant`) are preserved from the task when a loop adopts it; only fields the
  file defines are re-applied.
- **Deletion.** A task carrying the `loopFile` marker whose loop file is no
  longer discovered (removed or renamed) is unscheduled (removed from the
  config). The marker is persisted in the config file, so removal is detected
  across restarts. JSON-configured tasks without the marker are never removed.
  A task whose loop file still exists but is currently unparseable is KEPT with
  its last good definition — a transiently malformed file (mid-edit, bad merge)
  never deletes a task or its runtime state.
- **Creation.** Loops without a matching task are created under a deterministic
  `loop:<scope>:<name>` id so runtime state survives restarts. At most one task
  is driven per loop file; orphan duplicates of the same file are unscheduled.
- **Scope precedence.** Project-scope loops shadow user-scope loops with the
  same name; among project files the nearest ancestor wins.
- **Malformed files** (missing `name`/`schedule`/`model`/body, invalid cron,
  unreadable) are reported to the scheduler as `definition: null` entries and
  warned about; they never block valid loops in the same or other scopes.
- **Loop-file mutations.** The loop file remains authoritative. The scheduled-
  tasks UI opens it in the built-in file editor, updates its `enabled`
  frontmatter through the loop-file endpoint, and deletes the file through the
  loop-file endpoint after confirmation. Each mutation reconciles the project.
  The general task deletion API still rejects loop-sourced tasks while their
  file exists; once the file is gone, deleting an orphan task is allowed.

## Execution on the OMP engine

The runtime talks to the agent engine exclusively through the adapter's
OpenCode-shaped HTTP surface with plain `fetch` — it never imports
`@opencode-ai/sdk`. The three engine touch points are injectable so tests and
future engines can swap them:

| Hook | Default (OMP) | Notes |
|---|---|---|
| `createSession({ baseUrl, authHeaders, directory, title })` | `POST {baseUrl}/session?directory=…` with `{ title }`; returns the session `id` from the adapter's `toSdkSession` shape | Throws `session create failed (status)` on non-2xx and `failed to create session` when no id comes back |
| `listCommands({ directory })` | `[]` | OMP has no command surface; the adapter degrades `/api/command` to an empty list, so slash-command prompts resolve to no command |
| `runSessionCommand({ projectPath, sessionID, command, arguments, agent, model, variant })` | no-op | OMP has no session command RPC (adapter answers 501); a matched command would be dispatched here, but with the default it never matches |

Consequences on the OMP engine:

- A task whose prompt starts with `/` (e.g. `/review src/components`) runs as a
  **plain prompt** through `prompt_async` — the slash text is sent verbatim.
  This is intentional: failing the run would be worse than sending the text.
- `permissionAutoAccept` enrollment and session-goal creation still run before
  the prompt (unchanged behavior).
- The watchdog, concurrency limits, one-time-task consumption, and run-state
  bookkeeping are engine-agnostic and unchanged.

## Public exports (runtime.js)

- `createScheduledTasksRuntime(dependencies)`
- Returned API:
  - `start()`
  - `stop()`
  - `syncAllProjects()`
  - `syncProject(projectId)`
  - `runNow(projectId, taskId)`
- Injectable execution hooks (defaults use plain `fetch` against the OMP
  adapter surface; see "Execution on the OMP engine" above):
  - `createSession({ baseUrl, authHeaders, directory, title })` → session id
  - `listCommands({ directory })` → command list (OMP: always `[]`)
  - `runSessionCommand({ projectPath, sessionID, command, arguments, agent, model, variant })` (OMP: no-op)

## Public exports (routes.js)

- `registerScheduledTaskRoutes(app, dependencies)`
- Registers:
  - `GET /api/projects/:projectId/scheduled-tasks`
  - `PUT /api/projects/:projectId/scheduled-tasks`
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId`
  - `PATCH /api/projects/:projectId/scheduled-tasks/:taskId/loop-file`
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId/loop-file`
  - `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
  - `GET /api/ompchamber/scheduled-tasks/status`
  - `GET /api/ompchamber/events`
