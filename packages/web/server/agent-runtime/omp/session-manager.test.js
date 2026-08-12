import { describe, expect, it } from 'bun:test';

import { createOmpSessionManager } from './session-manager.js';
import { OMP_COMMANDS } from './rpc-types.js';

/** Build a session manager with a stub RPC client. `handler(frame)` produces the response. */
const createManagerWithRpc = (handler) => {
  const sent = [];
  const client = {
    send: async (frame) => {
      sent.push(frame);
      return handler(frame);
    },
    notify: async () => {},
  };
  const manager = createOmpSessionManager({ rpc: async () => client, cwd: '/tmp' });
  return { manager, sent };
};

describe('createOmpSessionManager derived state', () => {
  it('derives busy from agent_start/agent_end events', () => {
    const { manager } = createManagerWithRpc(() => ({ data: {} }));
    expect(manager.current.busy).toBe(false);
    manager.observeFrame({ type: 'agent_start' });
    expect(manager.current.busy).toBe(true);
    manager.observeFrame({ type: 'agent_end' });
    expect(manager.current.busy).toBe(false);
  });

  it('clears busy on session_end too', () => {
    const { manager } = createManagerWithRpc(() => ({ data: {} }));
    manager.observeFrame({ type: 'agent_start' });
    manager.observeFrame({ type: 'session_end', reason: 'done' });
    expect(manager.current.busy).toBe(false);
  });

  it('reconciles busy authoritatively from get_state on refresh', async () => {
    let streaming = true;
    const { manager } = createManagerWithRpc((frame) => {
      if (frame.type === OMP_COMMANDS.GET_STATE) {
        return { data: { sessionId: 's1', isStreaming: streaming, isCompacting: false } };
      }
      return { data: {} };
    });
    await manager.refresh();
    expect(manager.current.busy).toBe(true);
    streaming = false;
    await manager.refresh();
    expect(manager.current.busy).toBe(false);
  });

  it('records todos from todo_reminder and clears on todo_auto_clear', () => {
    const { manager } = createManagerWithRpc(() => ({ data: {} }));
    manager.observeFrame({
      type: 'todo_reminder',
      todos: [
        { id: 't1', content: 'Write tests', status: 'in_progress' },
        { id: 't2', content: 'Ship it', status: 'pending' },
      ],
    });
    expect(manager.current.todos).toHaveLength(2);
    expect(manager.current.todos[0]).toMatchObject({ id: 't1', content: 'Write tests', status: 'in_progress' });
    manager.observeFrame({ type: 'todo_auto_clear' });
    expect(manager.current.todos).toEqual([]);
  });

  it('mines todos from get_state when present', async () => {
    const { manager } = createManagerWithRpc((frame) => {
      if (frame.type === OMP_COMMANDS.GET_STATE) {
        return { data: { sessionId: 's1', todos: [{ id: 'x', content: 'From state', status: 'blocked' }] } };
      }
      return { data: {} };
    });
    await manager.refresh();
    expect(manager.current.todos).toHaveLength(1);
    expect(manager.current.todos[0]).toMatchObject({ content: 'From state', status: 'in_progress' });
  });

  it('caches commands from available_commands_update frames and listCommands RPC', async () => {
    const { manager, sent } = createManagerWithRpc((frame) => {
      if (frame.type === OMP_COMMANDS.GET_AVAILABLE_COMMANDS) {
        return { data: { commands: [{ name: 'compact' }] } };
      }
      return { data: {} };
    });
    manager.observeFrame({ type: 'available_commands_update', commands: [{ name: 'session' }] });
    expect(manager.getCachedCommands()).toEqual([{ name: 'session' }]);
    const commands = await manager.listCommands();
    expect(commands).toEqual([{ name: 'compact' }]);
    expect(manager.getCachedCommands()).toEqual([{ name: 'compact' }]);
    expect(sent.some((frame) => frame.type === OMP_COMMANDS.GET_AVAILABLE_COMMANDS)).toBe(true);
  });

  it('throws instead of returning an empty list when get_available_commands fails', async () => {
    const { manager } = createManagerWithRpc(() => ({ success: false, error: 'boom' }));
    await expect(manager.listCommands()).rejects.toThrow('boom');
  });
});

describe('branch / fork support', () => {
  it('sends branch with an entryId when given one', async () => {
    const { manager, sent } = createManagerWithRpc((frame) => {
      if (frame.type === OMP_COMMANDS.BRANCH) {
        return { success: true, data: { text: 'hi', cancelled: false } };
      }
      if (frame.type === OMP_COMMANDS.GET_STATE) return { data: { sessionId: 's2' } };
      return { data: {} };
    });
    const result = await manager.branch('abc123');
    expect(result).toMatchObject({ text: 'hi', cancelled: false });
    const branchFrame = sent.find((frame) => frame.type === OMP_COMMANDS.BRANCH);
    expect(branchFrame.entryId).toBe('abc123');
  });

  it('omits entryId when branch is called without one', async () => {
    const { manager, sent } = createManagerWithRpc(() => ({ success: false, error: 'Invalid entry ID for branching' }));
    await manager.branch();
    const branchFrame = sent.find((frame) => frame.type === OMP_COMMANDS.BRANCH);
    expect('entryId' in branchFrame).toBe(false);
  });

  it('lists branchable user-message entries', async () => {
    const { manager } = createManagerWithRpc((frame) => {
      if (frame.type === OMP_COMMANDS.GET_BRANCH_MESSAGES) {
        return { data: { messages: [{ entryId: 'e1', text: 'first' }] } };
      }
      return { data: {} };
    });
    expect(await manager.getBranchMessages()).toEqual([{ entryId: 'e1', text: 'first' }]);
  });
});

describe('bash RPC', () => {
  it('runs a command and returns the captured result', async () => {
    const { manager, sent } = createManagerWithRpc((frame) => {
      if (frame.type === OMP_COMMANDS.BASH) {
        return { success: true, data: { exitCode: 0, output: 'hi\n', cancelled: false, workingDir: '/tmp' } };
      }
      return { data: {} };
    });
    const result = await manager.runBash('echo hi');
    expect(result).toMatchObject({ exitCode: 0, output: 'hi\n' });
    expect(sent.find((frame) => frame.type === OMP_COMMANDS.BASH).command).toBe('echo hi');
  });

  it('throws when the bash RPC reports failure', async () => {
    const { manager } = createManagerWithRpc(() => ({ success: false, error: 'no session' }));
    await expect(manager.runBash('echo hi')).rejects.toThrow('no session');
  });

  it('sends abort_bash', async () => {
    const { manager, sent } = createManagerWithRpc(() => ({ success: true }));
    await manager.abortBash();
    expect(sent.some((frame) => frame.type === OMP_COMMANDS.ABORT_BASH)).toBe(true);
  });
});
