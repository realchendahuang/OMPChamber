import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveOmpBinary } from './cli-executables.js';

function withTempBinDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompchamber-bin-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeExecutable(dir, name) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

describe('resolveOmpBinary', () => {
  it('prefers OMP_BINARY over OPENCODE_BINARY and PATH', () => {
    withTempBinDir((dir) => {
      const ompPath = writeExecutable(dir, 'custom-omp');
      const legacyPath = writeExecutable(dir, 'custom-opencode');
      const resolution = resolveOmpBinary({
        OMP_BINARY: ompPath,
        OPENCODE_BINARY: legacyPath,
        PATH: dir,
      });
      expect(resolution.binary).toBe(ompPath);
      expect(resolution.source).toBe('OMP_BINARY');
      expect(resolution.invalidOverrides).toEqual([]);
    });
  });

  it('falls back to OPENCODE_BINARY when OMP_BINARY is unset', () => {
    withTempBinDir((dir) => {
      const legacyPath = writeExecutable(dir, 'custom-opencode');
      const resolution = resolveOmpBinary({
        OPENCODE_BINARY: legacyPath,
        PATH: '',
      });
      expect(resolution.binary).toBe(legacyPath);
      expect(resolution.source).toBe('OPENCODE_BINARY');
    });
  });

  it('reports an invalid OMP_BINARY override and falls through to OPENCODE_BINARY', () => {
    withTempBinDir((dir) => {
      const legacyPath = writeExecutable(dir, 'custom-opencode');
      const resolution = resolveOmpBinary({
        OMP_BINARY: path.join(dir, 'missing-omp'),
        OPENCODE_BINARY: legacyPath,
        PATH: '',
      });
      expect(resolution.binary).toBe(legacyPath);
      expect(resolution.source).toBe('OPENCODE_BINARY');
      expect(resolution.invalidOverrides).toEqual([
        { name: 'OMP_BINARY', value: path.join(dir, 'missing-omp') },
      ]);
    });
  });

  it('prefers omp over opencode on PATH', () => {
    withTempBinDir((dir) => {
      const ompPath = writeExecutable(dir, 'omp');
      writeExecutable(dir, 'opencode');
      const resolution = resolveOmpBinary({ PATH: dir });
      expect(resolution.binary).toBe(ompPath);
      expect(resolution.source).toBe('PATH');
      expect(resolution.command).toBe('omp');
    });
  });

  it('falls back to opencode on PATH when omp is absent', () => {
    withTempBinDir((dir) => {
      const opencodePath = writeExecutable(dir, 'opencode');
      const resolution = resolveOmpBinary({ PATH: dir });
      expect(resolution.binary).toBe(opencodePath);
      expect(resolution.source).toBe('PATH');
      expect(resolution.command).toBe('opencode');
    });
  });

  it('returns null when nothing resolves', () => {
    const resolution = resolveOmpBinary({ PATH: '' });
    expect(resolution.binary).toBeNull();
    expect(resolution.source).toBeNull();
  });
});
