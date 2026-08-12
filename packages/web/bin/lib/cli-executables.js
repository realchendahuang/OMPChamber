import fs from 'fs';
import path from 'path';

const WINDOWS_EXTENSIONS = process.platform === 'win32'
  ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
  : [''];

function isExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExplicitBinary(candidate) {
  if (!candidate) {
    return null;
  }
  if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    return isExecutable(resolved) ? resolved : null;
  }
  return null;
}

function searchPathFor(command, pathValue = process.env.PATH) {
  const segments = String(pathValue || '').split(path.delimiter).filter(Boolean);
  for (const dir of segments) {
    for (const ext of WINDOWS_EXTENSIONS) {
      const fileName = process.platform === 'win32' ? `${command}${ext}` : command;
      const candidate = path.join(dir, fileName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// OMP engine binary resolution contract (shared by serve preflight and
// startup env snapshots):
//   1. OMP_BINARY env override (primary)
//   2. `omp` on PATH
// Invalid overrides are reported (not fatal) so callers can warn and fall
// through to the next source, matching the historical preflight behavior.
function resolveOmpBinary(env = process.env) {
  const invalidOverrides = [];

  const ompOverride = resolveExplicitBinary(env.OMP_BINARY);
  if (ompOverride) {
    return { binary: ompOverride, source: 'OMP_BINARY', invalidOverrides };
  }
  if (typeof env.OMP_BINARY === 'string' && env.OMP_BINARY.trim().length > 0) {
    invalidOverrides.push({ name: 'OMP_BINARY', value: env.OMP_BINARY });
  }

  const ompOnPath = searchPathFor('omp', env.PATH);
  if (ompOnPath) {
    return { binary: ompOnPath, source: 'PATH', command: 'omp', invalidOverrides };
  }

  return { binary: null, source: null, invalidOverrides };
}

export { resolveExplicitBinary, searchPathFor, resolveOmpBinary };
