import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getOmpUpgradeStatus, upgradeManagedOmp, type OmpUpgradeManager } from './omp-upgrade-runtime';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createManager = (mode: 'managed' | 'external' = 'managed') => {
  let restartCount = 0;
  const manager: OmpUpgradeManager = {
    getApiUrl: () => 'http://127.0.0.1:4096',
    getServerAuthHeaders: () => ({ Authorization: 'Basic test' }),
    getDebugInfo: () => ({ mode }),
    restart: async () => { restartCount += 1; },
  };
  return { manager, getRestartCount: () => restartCount };
};

describe('VS Code OMP upgrades', () => {
  test('reports an available update for a managed OMP server process', async () => {
    const { manager } = createManager();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/global/health')) return new Response(JSON.stringify({ version: '17.2.12' }));
      if (url === 'https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest') return new Response(JSON.stringify({ version: '17.2.15' }));
      if (url === 'https://api.github.com/repos/can1357/oh-my-pi/releases/latest') return new Response(JSON.stringify({ tag_name: 'v17.2.14' }));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    assert.deepEqual(await getOmpUpgradeStatus(manager), {
      available: true,
      currentVersion: '17.2.12',
      latestVersion: '17.2.15',
      upgrade: { supported: true, manager: 'omp', reason: null },
    });
  });

  test('fails closed for externally managed OMP without contacting the updater', async () => {
    const { manager } = createManager('external');
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('{}');
    }) as typeof fetch;

    assert.deepEqual(await upgradeManagedOmp(manager), {
      status: 409,
      body: {
        success: false,
        code: 'OPENCODE_UPGRADE_UNSUPPORTED',
        error: 'This OMP runtime cannot be upgraded by OMPChamber.',
      },
    });
    assert.equal(fetchCount, 0);
  });

  test('upgrades then restarts the extension-owned OMP server process', async () => {
    const { manager, getRestartCount } = createManager();
    let request: RequestInit | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(String(input), 'http://127.0.0.1:4096/api/global/upgrade');
      request = init;
      return new Response(JSON.stringify({ success: true, version: '1.18.9' }));
    }) as typeof fetch;

    assert.deepEqual(await upgradeManagedOmp(manager, '1.18.9'), {
      status: 200,
      body: { success: true, version: '1.18.9', restarted: true },
    });
    assert.equal(getRestartCount(), 1);
    assert.equal(request?.method, 'POST');
    assert.deepEqual(JSON.parse(String(request?.body)), { target: '1.18.9' });
    assert.equal((request?.headers as Record<string, string>).Authorization, 'Basic test');
  });

  test('serializes concurrent managed upgrades', async () => {
    const { manager } = createManager();
    let release: (response: Response) => void = () => {};
    globalThis.fetch = (() => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;

    const first = upgradeManagedOmp(manager);
    const second = await upgradeManagedOmp(manager);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'OPENCODE_UPGRADE_IN_PROGRESS');

    release(new Response(JSON.stringify({ success: true })));
    assert.equal((await first).status, 200);
  });
});
