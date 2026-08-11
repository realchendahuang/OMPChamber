import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import {
  computeNextRunAt,
  expandCommandGoalObjective,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
  createScheduledTasksRuntime,
} from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });

  it('expands command arguments into the goal objective', () => {
    expect(expandCommandGoalObjective(
      'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
      'LIN-123 --draft',
    )).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
    expect(expandCommandGoalObjective(undefined, 'LIN-123')).toBeNull();
    expect(expandCommandGoalObjective('Move $1 to $2', '"src old" dist extra')).toBe('Move src old to dist extra');
    expect(expandCommandGoalObjective('Review the requested scope.', 'auth module'))
      .toBe('Review the requested scope.\n\nauth module');
  });
});

describe('scheduled-tasks runtime syncProject wiring', () => {
  const createTempProject = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-loop-'));
    const repoPath = path.join(tempRoot, 'repo');
    await mkdir(path.join(repoPath, '.agents', 'loops'), { recursive: true });
    return {
      tempRoot,
      repoPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  };

  const createProjectConfig = async (tempRoot) => createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'config'),
    createTaskID: () => 'task-fixed-id',
  });

  const createRuntimeDeps = (overrides = {}) => ({
    buildOmpUrl: () => 'http://localhost',
    getOmpAuthHeaders: () => ({}),
    waitForOmpReady: async () => {},
    ...overrides,
  });

  it('reconciles discovered loops when the project path is known', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    try {
      await writeFile(path.join(repoPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
      });

      await runtime.syncProject('proj');

      const tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('loop:project:daily');
      expect(tasks[0].loopFile).toBe(path.join(repoPath, '.agents', 'loops', 'daily.md'));
      // syncTaskSchedule computed and persisted the next run for the enabled task.
      expect(tasks[0].state.nextRunAt).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('falls back to plain listing when the project path cannot be resolved', async () => {
    const { tempRoot, cleanup } = await createTempProject();
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const reconcileSpy = vi.spyOn(projectConfigRuntime, 'reconcileLoopTasks');
      const listSpy = vi.spyOn(projectConfigRuntime, 'listScheduledTasks');

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        // Project not registered -> ensureProjectPath cannot resolve a path.
        listProjects: async () => [],
      });

      await runtime.syncProject('proj');

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledWith('proj');
      expect(await projectConfigRuntime.listScheduledTasks('proj')).toEqual([]);
      reconcileSpy.mockRestore();
      listSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});

describe('scheduled-tasks runtime OMP execution path', () => {
  const createTempProject = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-omp-'));
    const repoPath = path.join(tempRoot, 'repo');
    await mkdir(path.join(repoPath, '.agents', 'loops'), { recursive: true });
    return {
      tempRoot,
      repoPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  };

  const createProjectConfig = async (tempRoot) => createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'config'),
    createTaskID: () => 'task-fixed-id',
  });

  const createRuntimeDeps = (overrides = {}) => ({
    buildOmpUrl: () => 'http://localhost',
    getOmpAuthHeaders: () => ({}),
    waitForOmpReady: async () => {},
    ...overrides,
  });

  const createEnabledTask = async (projectConfigRuntime, overrides = {}) => {
    const task = await projectConfigRuntime.upsertScheduledTask('proj', {
      name: 'daily',
      schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      enabled: true,
      execution: {
        providerID: 'openai',
        modelID: 'gpt-5',
        prompt: 'Run daily.',
      },
      ...overrides,
    });
    return task.task;
  };

  it('creates the session and prompts through the OMP adapter with plain fetch', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    const originalFetch = globalThis.fetch;
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const task = await createEnabledTask(projectConfigRuntime);
      const fetchMock = vi.fn(async (url, options) => {
        if (options?.method === 'POST' && String(url).includes('/session?directory=')) {
          return { ok: true, status: 200, json: async () => ({ id: 'sess-1' }), text: async () => '' };
        }
        if (String(url).includes('/session/sess-1/prompt_async')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      });
      globalThis.fetch = fetchMock;

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
      });
      await runtime.syncProject('proj');

      const result = await runtime.runNow('proj', task.id);

      expect(result.ok).toBe(true);
      expect(result.sessionID).toBe('sess-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [createCall, promptCall] = fetchMock.mock.calls;
      expect(String(createCall[0])).toBe('http://localhost/session?directory=' + encodeURIComponent(repoPath));
      expect(JSON.parse(createCall[1].body)).toEqual({ title: expect.stringContaining('daily') });
      expect(String(promptCall[0])).toBe('http://localhost/session/sess-1/prompt_async?directory=' + encodeURIComponent(repoPath));
      const promptBody = JSON.parse(promptCall[1].body);
      expect(promptBody.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
      expect(promptBody.parts[0].text).toBe('Run daily.');
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });

  it('prefers an injected createSession over the default fetch path', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    const originalFetch = globalThis.fetch;
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const task = await createEnabledTask(projectConfigRuntime);
      const createSession = vi.fn(async () => 'injected-session');
      const fetchMock = vi.fn(async (url) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
      }));
      globalThis.fetch = fetchMock;

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
        createSession,
      });
      await runtime.syncProject('proj');

      const result = await runtime.runNow('proj', task.id);

      expect(result.ok).toBe(true);
      expect(result.sessionID).toBe('injected-session');
      expect(createSession).toHaveBeenCalledWith({
        baseUrl: 'http://localhost',
        authHeaders: {},
        directory: repoPath,
        title: expect.stringContaining('daily'),
      });
      // Only the prompt_async call goes through fetch.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/session/injected-session/prompt_async');
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });

  it('runs a slash-command prompt as a plain prompt when no command matches', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    const originalFetch = globalThis.fetch;
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const task = await createEnabledTask(projectConfigRuntime, {
        execution: {
          providerID: 'openai',
          modelID: 'gpt-5',
          prompt: '/review src/components',
        },
      });
      const listCommands = vi.fn(async () => []);
      const runSessionCommand = vi.fn(async () => {});
      const fetchMock = vi.fn(async (url, options) => {
        if (options?.method === 'POST' && String(url).includes('/session?directory=')) {
          return { ok: true, status: 200, json: async () => ({ id: 'sess-1' }), text: async () => '' };
        }
        if (String(url).includes('/prompt_async')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      });
      globalThis.fetch = fetchMock;

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
        listCommands,
        runSessionCommand,
      });
      await runtime.syncProject('proj');

      const result = await runtime.runNow('proj', task.id);

      expect(result.ok).toBe(true);
      expect(listCommands).toHaveBeenCalledWith({ directory: repoPath });
      expect(runSessionCommand).not.toHaveBeenCalled();
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(promptCall).toBeTruthy();
      expect(JSON.parse(promptCall[1].body).parts[0].text).toBe('/review src/components');
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });

  it('dispatches a matched slash command through runSessionCommand', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    const originalFetch = globalThis.fetch;
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const task = await createEnabledTask(projectConfigRuntime, {
        execution: {
          providerID: 'openai',
          modelID: 'gpt-5',
          prompt: '/review src/components',
        },
      });
      const listCommands = vi.fn(async () => [{ name: 'review', template: 'Review $ARGUMENTS' }]);
      const runSessionCommand = vi.fn(async () => {});
      const fetchMock = vi.fn(async (url, options) => {
        if (options?.method === 'POST' && String(url).includes('/session?directory=')) {
          return { ok: true, status: 200, json: async () => ({ id: 'sess-1' }), text: async () => '' };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      });
      globalThis.fetch = fetchMock;

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
        listCommands,
        runSessionCommand,
      });
      await runtime.syncProject('proj');

      const result = await runtime.runNow('proj', task.id);

      expect(result.ok).toBe(true);
      expect(runSessionCommand).toHaveBeenCalledWith({
        projectPath: repoPath,
        sessionID: 'sess-1',
        command: 'review',
        arguments: 'src/components',
        agent: undefined,
        model: 'openai/gpt-5',
        variant: undefined,
      });
      // No prompt_async call when a command matched.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });
});
