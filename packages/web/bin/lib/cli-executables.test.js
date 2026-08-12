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
  it('prefers OMP_BINARY over PATH', () => {
    withTempBinDir((dir) => {
      const ompPath = writeExecutable(dir, 'custom-omp');
      const resolution = resolveOmpBinary({
        OMP_BINARY: ompPath,
        PATH: dir,
      });
      expect(resolution.binary).toBe(ompPath);
      expect(resolution.source).toBe('OMP_BINARY');
      expect(resolution.invalidOverrides).toEqual([]);
    });
  });

  it('reports an invalid OMP_BINARY override and falls through to PATH', () => {
    withTempBinDir((dir) => {
      const ompPath = writeExecutable(dir, 'omp');
      const resolution = resolveOmpBinary({
        OMP_BINARY: path.join(dir, 'missing-omp'),
        PATH: dir,
      });
      expect(resolution.binary).toBe(ompPath);
      expect(resolution.source).toBe('PATH');
      expect(resolution.command).toBe('omp');
      expect(resolution.invalidOverrides).toEqual([
        { name: 'OMP_BINARY', value: path.join(dir, 'missing-omp') },
      ]);
    });
  });

  it('resolves omp on PATH', () => {
    withTempBinDir((dir) => {
      const ompPath = writeExecutable(dir, 'omp');
      const resolution = resolveOmpBinary({ PATH: dir });
      expect(resolution.binary).toBe(ompPath);
      expect(resolution.source).toBe('PATH');
      expect(resolution.command).toBe('omp');
    });
  });

  it('returns null when nothing resolves', () => {
    const resolution = resolveOmpBinary({ PATH: '' });
    expect(resolution.binary).toBeNull();
    expect(resolution.source).toBeNull();
  });
});
