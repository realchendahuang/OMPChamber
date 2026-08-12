import { describe, expect, it } from 'bun:test';

import { resolveOmpEngineBinary } from './omp-binary-resolution.js';

describe('resolveOmpEngineBinary precedence', () => {
  it('prefers OMP_BINARY env over settings and OPENCODE_BINARY', () => {
    const result = resolveOmpEngineBinary({
      env: { OMP_BINARY: '/env/omp', OPENCODE_BINARY: '/legacy/omp' },
      settings: { opencodeBinary: '/settings/omp' },
    });
    expect(result).toEqual({ binary: '/env/omp', source: 'OMP_BINARY' });
  });

  it('uses the persisted opencodeBinary setting when OMP_BINARY is unset', () => {
    const result = resolveOmpEngineBinary({
      env: { OPENCODE_BINARY: '/legacy/omp' },
      settings: { opencodeBinary: '/settings/omp' },
    });
    expect(result).toEqual({ binary: '/settings/omp', source: 'settings' });
  });

  it('treats an empty persisted opencodeBinary as cleared and falls through', () => {
    const result = resolveOmpEngineBinary({
      env: { OPENCODE_BINARY: '/legacy/omp' },
      settings: { opencodeBinary: '   ' },
    });
    expect(result).toEqual({ binary: '/legacy/omp', source: 'OPENCODE_BINARY' });
  });

  it('keeps the deprecated OPENCODE_BINARY fallback consistent with the CLI', () => {
    const result = resolveOmpEngineBinary({ env: { OPENCODE_BINARY: '/legacy/omp' }, settings: {} });
    expect(result).toEqual({ binary: '/legacy/omp', source: 'OPENCODE_BINARY' });
  });

  it('defaults to omp on PATH', () => {
    expect(resolveOmpEngineBinary({ env: {}, settings: {} })).toEqual({ binary: 'omp', source: 'default' });
  });

  it('trims values and ignores non-string settings', () => {
    expect(resolveOmpEngineBinary({ env: { OMP_BINARY: '  /env/omp  ' }, settings: {} }))
      .toEqual({ binary: '/env/omp', source: 'OMP_BINARY' });
    expect(resolveOmpEngineBinary({ env: {}, settings: { opencodeBinary: 42 } }))
      .toEqual({ binary: 'omp', source: 'default' });
  });
});
