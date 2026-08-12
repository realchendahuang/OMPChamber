import { describe, expect, it } from 'bun:test';

import { resolveSpawnOptions } from './process-manager.js';

describe('resolveSpawnOptions', () => {
  it('always sets windowsHide', () => {
    expect(resolveSpawnOptions({ binary: 'omp', platform: 'darwin' }).windowsHide).toBe(true);
    expect(resolveSpawnOptions({ binary: 'omp', platform: 'win32' }).windowsHide).toBe(true);
  });

  it('enables shell for .cmd/.bat launchers on win32 (CVE-2024-27980 EINVAL)', () => {
    expect(resolveSpawnOptions({ binary: 'C:\\tools\\omp.cmd', platform: 'win32' })).toEqual({ windowsHide: true, shell: true });
    expect(resolveSpawnOptions({ binary: 'C:\\tools\\omp.BAT', platform: 'win32' })).toEqual({ windowsHide: true, shell: true });
  });

  it('does not enable shell for plain binaries on win32', () => {
    expect(resolveSpawnOptions({ binary: 'C:\\tools\\omp.exe', platform: 'win32' })).toEqual({ windowsHide: true });
    expect(resolveSpawnOptions({ binary: 'omp', platform: 'win32' })).toEqual({ windowsHide: true });
  });

  it('never enables shell off win32', () => {
    expect(resolveSpawnOptions({ binary: '/usr/local/bin/omp.cmd', platform: 'darwin' })).toEqual({ windowsHide: true });
    expect(resolveSpawnOptions({ binary: 'omp', platform: 'linux' })).toEqual({ windowsHide: true });
  });
});
