/**
 * Shared PATH heuristics, binary resolution, and environment-snapshot
 * utilities for server and Electron runtimes.
 *
 * The heuristic decides whether the current process.env.PATH looks like it was
 * configured by the user (or their session manager) vs. a minimal system default.
 * When the PATH looks user-configured we keep it; otherwise we prefer the login
 * shell PATH which typically has the full toolchain.
 *
 * This module is engine-agnostic: the functions here were historically part of
 * the OpenCode runtime module but are consumed by generic surfaces (git, fs,
 * terminal, notifications, scheduled tasks), so they live in the shared `lib/`
 * layer.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clearAppImageArgv0FromProcessEnv } from './inherited-env.js';

const TOOLCHAIN_SEGMENTS = [
  '/opt/homebrew/',
  '/opt/pkg/',
  '/opt/pmk/',
  '/snap/',
];

const TOOLCHAIN_BASENAMES = new Set([
  '.cargo',
  '.bun',
  '.nvm',
  '.pyenv',
  '.rbenv',
  '.sdkman',
  '.asdf',
  '.volta',
  '.fnm',
  '.local',
  '.opencode',
  'node_modules',
]);

/**
 * Returns true when `value` (a PATH string) contains at least one segment that
 * suggests the PATH was configured by the user or their session manager rather
 * than being a bare system default.
 *
 * @param {string} value  - The PATH string to inspect.
 * @param {string} home   - The user's home directory (os.homedir()).
 * @param {string} delim  - The PATH delimiter (':' on POSIX, ';' on Windows).
 */
export function pathLooksUserConfigured(value, home, delim) {
  if (typeof value !== 'string' || !value) {
    return false;
  }

  const normalizedHome = typeof home === 'string' ? home.replaceAll('\\', '/') : '';
  const homeWithSep = normalizedHome ? normalizedHome + '/' : '';

  return value.split(delim).some((segment) => {
    if (!segment) return false;
    const normalizedSegment = segment.replaceAll('\\', '/');

    // Any path under the user's home directory.
    if (normalizedHome && (normalizedSegment === normalizedHome || normalizedSegment.startsWith(homeWithSep))) {
      return true;
    }

    // Well-known package-manager / toolchain prefixes.
    if (TOOLCHAIN_SEGMENTS.some((prefix) => normalizedSegment.startsWith(prefix))) {
      return true;
    }

    // Well-known dot-directories inside home (e.g. ~/.cargo/bin).
    const parts = normalizedSegment.split('/').filter(Boolean);
    if (parts.some((part) => TOOLCHAIN_BASENAMES.has(part))) {
      return true;
    }

    return false;
  });
}

/**
 * Merges two PATH strings, deduplicating segments while preserving the order of
 * `primary` and appending any segments from `fallback` that are not already
 * present.
 *
 * @param {string} primary  - The preferred PATH (e.g. user-configured or login shell).
 * @param {string} fallback - The secondary PATH to fill gaps from.
 * @param {string} delim    - The PATH delimiter.
 */
export function mergePathValues(primary, fallback, delim) {
  const seen = new Set();
  const result = [];

  const addSegments = (value) => {
    if (typeof value !== 'string' || !value) return;
    for (const segment of value.split(delim)) {
      if (segment && !seen.has(segment)) {
        seen.add(segment);
        result.push(segment);
      }
    }
  };

  addSegments(primary);
  addSegments(fallback);

  return result.join(delim);
}

/**
 * Returns true when `filePath` is a regular, executable file on the current
 * platform. On Windows only the known executable extensions are accepted.
 *
 * @param {string} filePath - The candidate path to inspect.
 */
export function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const resolveWindowsExecutablePath = (candidate) => {
  if (process.platform !== 'win32' || typeof candidate !== 'string' || candidate.trim().length === 0) {
    return candidate;
  }

  const trimmed = candidate.trim();
  const ext = path.extname(trimmed).toLowerCase();
  if (ext) {
    return isExecutable(trimmed) ? trimmed : null;
  }

  const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
  for (const rawExt of pathExt.split(';')) {
    const normalizedExt = rawExt.trim();
    if (!normalizedExt) continue;
    const withExt = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
    if (isExecutable(withExt)) {
      return withExt;
    }
  }

  return isExecutable(trimmed) ? trimmed : null;
};

/**
 * Resolves the absolute path of a binary by searching the provided PATH (or
 * process.env.PATH by default). On Windows, the PATHEXT extensions are tried
 * in addition to the bare name.
 *
 * @param {string} binaryName   - The binary name to search for.
 * @param {string} [searchPath] - PATH-like string to search; defaults to process.env.PATH.
 * @returns {string|null} The first executable candidate, or null.
 */
export function searchPathFor(binaryName, searchPath = process.env.PATH || '') {
  const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
  if (!trimmed) {
    return null;
  }

  const parts = searchPath.split(path.delimiter).filter(Boolean);
  const candidateNames = [];

  if (process.platform === 'win32' && !path.extname(trimmed)) {
    const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
    for (const ext of pathExt.split(';')) {
      const normalizedExt = ext.trim();
      if (!normalizedExt) continue;
      const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
      if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
        candidateNames.push(candidateName);
      }
    }
  }

  candidateNames.push(trimmed);

  for (const dir of parts) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

const state = {
  resolvedGitBinary: undefined,
  cachedLoginShellEnvSnapshot: undefined,
};

const parseNullSeparatedEnvSnapshot = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const result = {};
  const entries = raw.split('\0');
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const idx = entry.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    result[key] = value;
  }

  if (Object.keys(result).length === 0) {
    return null;
  }

  if (process.platform === 'win32' && typeof result.PATH !== 'string') {
    const pathEntry = Object.entries(result).find(([key]) => key.toLowerCase() === 'path');
    if (pathEntry && typeof pathEntry[1] === 'string') {
      result.PATH = pathEntry[1];
    }
  }

  return result;
};

const getWindowsShellEnvSnapshot = () => {
  const parseResult = (stdout) => parseNullSeparatedEnvSnapshot(typeof stdout === 'string' ? stdout : '');

  const psScript = [
    '$entries = [ordered]@{}',
    'Get-ChildItem Env: | ForEach-Object { $entries[$_.Name] = $_.Value }',
    "$pathValues = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Process')) | Where-Object { $_ }",
    "if ($pathValues.Count -gt 0) { $entries['Path'] = ($pathValues -join ';') }",
    "$entries.GetEnumerator() | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }",
  ].join('; ');

  const powershellCandidates = [
    'pwsh.exe',
    'powershell.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const shellPath of powershellCandidates) {
    try {
      const result = spawnSync(shellPath, ['-NoLogo', '-Command', psScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      if (result.status !== 0) {
        continue;
      }
      const parsed = parseResult(result.stdout);
      if (parsed) {
        return parsed;
      }
    } catch {
    }
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  try {
    const result = spawnSync(comspec, ['/d', '/s', '/c', 'set'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.length > 0) {
      return parseNullSeparatedEnvSnapshot(result.stdout.replace(/\r?\n/g, '\0'));
    }
  } catch {
  }

  return null;
};

/**
 * Returns a snapshot of the login-shell environment (a plain object mapping
 * environment variable names to values), or null when no shell snapshot can be
 * produced. The snapshot is computed once and cached.
 *
 * On POSIX this shells out to the login shell (`env -0`); on Windows it
 * assembles Machine + User + Process PATH entries.
 */
export function getLoginShellEnvSnapshot() {
  if (state.cachedLoginShellEnvSnapshot !== undefined) {
    return state.cachedLoginShellEnvSnapshot;
  }

  if (process.platform === 'win32') {
    const windowsSnapshot = getWindowsShellEnvSnapshot();
    state.cachedLoginShellEnvSnapshot = windowsSnapshot;
    return windowsSnapshot;
  }

  const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);

  for (const shellPath of shellCandidates) {
    if (!isExecutable(shellPath)) {
      continue;
    }

    try {
      const result = spawnSync(shellPath, ['-lic', 'env -0'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });

      if (result.status !== 0) {
        continue;
      }

      const parsed = parseNullSeparatedEnvSnapshot(result.stdout || '');
      if (parsed) {
        state.cachedLoginShellEnvSnapshot = parsed;
        return parsed;
      }
    } catch {
    }
  }

  state.cachedLoginShellEnvSnapshot = null;
  return null;
}

/**
 * Applies the login-shell environment snapshot onto the current process.env,
 * filling only keys that are not already set. Also always clears a leaked
 * AppImage ARGV0 from the process environment.
 */
export function applyLoginShellEnvSnapshot() {
  // Always clear AppImage ARGV0, even when no login-shell snapshot is available.
  // Otherwise a leaked process.env.ARGV0 survives into later child spawns (#2588).
  clearAppImageArgv0FromProcessEnv();

  const snapshot = getLoginShellEnvSnapshot();
  if (!snapshot) {
    return;
  }

  const skipKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'ARGV0']);
  for (const [key, value] of Object.entries(snapshot)) {
    if (skipKeys.has(key)) {
      continue;
    }
    const existing = process.env[key];
    if (typeof existing === 'string' && existing.length > 0) {
      continue;
    }
    process.env[key] = value;
  }
}

/**
 * Resolves the git binary to use for spawning subprocesses. On non-Windows
 * platforms this is always `git`; on Windows it probes explicit env overrides,
 * the PATH, and standard install locations. The result is cached.
 *
 * @returns {string} The resolved git binary path.
 */
export function resolveGitBinaryForSpawn() {
  if (process.platform !== 'win32') {
    return 'git';
  }

  if (state.resolvedGitBinary) {
    return state.resolvedGitBinary;
  }

  const explicit = [process.env.GIT_BINARY, process.env.OMPCHAMBER_GIT_BINARY]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      state.resolvedGitBinary = candidate;
      return state.resolvedGitBinary;
    }
  }

  const candidates = [];
  const normalizeGitCandidate = (candidate) => {
    if (typeof candidate !== 'string') {
      return '';
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      return '';
    }
    const ext = path.extname(trimmed).toLowerCase();
    if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
      const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
      if (isExecutable(exeCandidate)) {
        return exeCandidate;
      }
    }
    return trimmed;
  };

  const pathCandidate = normalizeGitCandidate(searchPathFor('git'));
  if (pathCandidate && isExecutable(pathCandidate)) {
    candidates.push(pathCandidate);
  }

  const pathExeCandidate = normalizeGitCandidate(searchPathFor('git.exe'));
  if (pathExeCandidate && isExecutable(pathExeCandidate)) {
    candidates.push(pathExeCandidate);
  }

  const programRoots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const root of programRoots) {
    const installCandidates = [
      path.join(root, 'Git', 'cmd', 'git.exe'),
      path.join(root, 'Git', 'bin', 'git.exe'),
      path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'),
      path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'),
      path.join(root, 'Programs', 'Git', 'bin', 'git.exe'),
    ];
    for (const candidate of installCandidates) {
      const normalized = normalizeGitCandidate(candidate);
      if (normalized && isExecutable(normalized)) {
        candidates.push(normalized);
      }
    }
  }

  const preferredExe = candidates.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  state.resolvedGitBinary = preferredExe || candidates[0] || 'git.exe';
  return state.resolvedGitBinary;
}
