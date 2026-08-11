import { describe, expect, it } from 'vitest';

import { createHmrStateRuntime } from './hmr-state-runtime.js';

const createRuntime = (env = {}) => createHmrStateRuntime({
  globalThisLike: {},
  os: { homedir: () => '/Users/example' },
  processLike: { env },
  stateKey: '__testHmrState',
});

describe('hmr state runtime', () => {
  it('uses configured working directory when provided', () => {
    const runtime = createRuntime({ OMPCHAMBER_WORKING_DIRECTORY: '/tmp/ompchamber-data' });

    expect(runtime.getOrCreateHmrState().ompWorkingDirectory).toBe('/tmp/ompchamber-data');
  });

  it('falls back to home directory without configured working directory', () => {
    const runtime = createRuntime();

    expect(runtime.getOrCreateHmrState().ompWorkingDirectory).toBe('/Users/example');
  });
});
