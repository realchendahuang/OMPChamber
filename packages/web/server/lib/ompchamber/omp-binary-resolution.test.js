import { describe, expect, it } from 'bun:test';

import { resolveOmpEngineBinary } from './omp-binary-resolution.js';

describe('resolveOmpEngineBinary precedence', () => {
  it('prefers OMP_BINARY env over settings', () => {
    const result = resolveOmpEngineBinary({
      env: { OMP_BINARY: '/env/omp' },
      settings: { ompBinary: '/settings/omp' },
    });
    expect(result).toEqual({ binary: '/env/omp', source: 'OMP_BINARY' });
  });

  it('uses the persisted ompBinary setting when OMP_BINARY is unset', () => {
    const result = resolveOmpEngineBinary({
      env: {},
      settings: { ompBinary: '/settings/omp' },
    });
    expect(result).toEqual({ binary: '/settings/omp', source: 'settings' });
  });

  it('treats an empty persisted ompBinary as cleared and falls through', () => {
    const result = resolveOmpEngineBinary({
      env: {},
      settings: { ompBinary: '   ' },
    });
    expect(result).toEqual({ binary: 'omp', source: 'default' });
  });

  it('defaults to omp on PATH', () => {
    expect(resolveOmpEngineBinary({ env: {}, settings: {} })).toEqual({ binary: 'omp', source: 'default' });
  });

  it('trims values and ignores non-string settings', () => {
    expect(resolveOmpEngineBinary({ env: { OMP_BINARY: '  /env/omp  ' }, settings: {} }))
      .toEqual({ binary: '/env/omp', source: 'OMP_BINARY' });
    expect(resolveOmpEngineBinary({ env: {}, settings: { ompBinary: 42 } }))
      .toEqual({ binary: 'omp', source: 'default' });
  });
});
