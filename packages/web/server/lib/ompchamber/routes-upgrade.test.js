import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOmpRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    getOmpUpgradeCapability: () => ({
      supported: false,
      manager: 'ompchamber',
      reason: 'bundled',
    }),
    buildOmpUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOmpAuthHeaders: () => ({}),
    refreshOmpAfterConfigChange: vi.fn(async () => {}),
    ...overrides,
  };
  registerOmpRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OMP upgrade routes', () => {
  it('fails closed without contacting the bundled OMP updater', async () => {
    globalThis.fetch = vi.fn();
    const { app } = createApp();

    await request(app)
      .post('/api/omp/upgrade')
      .send({})
      .expect(409, {
        success: false,
        code: 'OPENCODE_UPGRADE_MANAGED_BY_OMPCHAMBER',
        error: 'OMP is bundled with OMPChamber Desktop and updates with the app.',
      });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports bundled update ownership through the capability contract', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ healthy: true, version: '1.18.8' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { app } = createApp();

    const response = await request(app)
      .get('/api/omp/upgrade-status')
      .expect(200);

    expect(response.body).toEqual({
      available: false,
      currentVersion: '1.18.8',
      latestVersion: null,
      upgrade: {
        supported: false,
        manager: 'ompchamber',
        reason: 'bundled',
      },
    });
  });

  it('serializes supported upgrades and preserves the in-flight lock', async () => {
    let releaseUpgrade;
    const upstreamResponse = new Promise((resolve) => {
      releaseUpgrade = () => resolve(new Response(JSON.stringify({ success: true, version: '1.18.9' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    globalThis.fetch = vi.fn(() => upstreamResponse);
    const { app, dependencies } = createApp({
      getOmpUpgradeCapability: () => ({
        supported: true,
        manager: 'omp',
        reason: null,
      }),
    });

    const first = request(app)
      .post('/api/omp/upgrade')
      .send({})
      .expect(200, {
        success: true,
        version: '1.18.9',
        restarted: true,
      })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    await request(app)
      .post('/api/omp/upgrade')
      .send({})
      .expect(409, {
        success: false,
        code: 'OPENCODE_UPGRADE_IN_PROGRESS',
        error: 'An OMP upgrade is already in progress.',
      });

    releaseUpgrade();
    await first;
    expect(dependencies.refreshOmpAfterConfigChange).toHaveBeenCalledTimes(1);
  });

  it('checks OMP feeds (npm scoped package + oh-my-pi releases) when upgrades are supported', async () => {
    const requestedUrls = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === 'http://127.0.0.1:4096/global/health') {
        return new Response(JSON.stringify({ version: '17.2.12' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest') {
        return new Response(JSON.stringify({ version: '17.2.15' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://api.github.com/repos/can1357/oh-my-pi/releases/latest') {
        return new Response(JSON.stringify({ tag_name: 'v17.2.14' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const { app } = createApp({
      getOmpUpgradeCapability: () => ({
        supported: true,
        manager: 'omp',
        reason: null,
      }),
    });

    const response = await request(app)
      .get('/api/omp/upgrade-status')
      .expect(200);

    expect(response.body).toEqual({
      available: true,
      currentVersion: '17.2.12',
      latestVersion: '17.2.15',
      upgrade: {
        supported: true,
        manager: 'omp',
        reason: null,
      },
    });
    expect(requestedUrls).toContain('https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest');
    expect(requestedUrls).toContain('https://api.github.com/repos/can1357/oh-my-pi/releases/latest');
    expect(requestedUrls.some((url) => url.includes('opencode'))).toBe(false);
  });
});
