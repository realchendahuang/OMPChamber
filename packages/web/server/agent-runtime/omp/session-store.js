/**
 * OMP on-disk session store — reads (and deletes) the JSONL session files the
 * OMP engine persists, so the HTTP adapter can serve a real session list,
 * resume arbitrary sessions, and delete sessions for real.
 *
 * Layout (verified against the OMP 17.2.12 binary):
 *   <sessionsRoot>/<bucket>/<ISO-timestamp>_<sessionId>.jsonl
 *
 * - sessionsRoot resolution mirrors OMP (`Yh.agentSubdir(profile,'sessions','data')`):
 *     base config dir = $PI_CONFIG_DIR || '.omp' (relative to the home dir)
 *     configRoot      = profile ? <home>/<base>/profiles/<profile> : <home>/<base>
 *     agentDir        = $PI_CODING_AGENT_DIR (default profile only) or <configRoot>/agent
 *     dataRoot        = $XDG_DATA_HOME/omp[/profiles/<profile>] when that dir
 *                       exists (linux/darwin, default agentDir), else agentDir
 *     sessionsRoot    = <dataRoot>/sessions
 * - bucket encodes the session cwd (mirrors OMP's KXi):
 *     under home dir  → '-<relative path with separators replaced by -">'
 *     under tmpdir    → '-tmp-<relative, same encoding>'
 *     anything else   → '--<absolute path without leading sep, separators→'-' >--'
 *   Comparisons realpath both sides (macOS /tmp → /private/tmp).
 * - File format: line 1 is a fixed-width title slot
 *   ({"type":"title","v":1,"title":...,"updatedAt":...,"pad":...}); line 2 is
 *   the session header ({"type":"session","version":3,"id":...,"timestamp":...,
 *   "cwd":...}); later lines are entries (model_change, message, ...).
 * - A session whose subagents ran has a companion directory named after the
 *   file without the .jsonl extension; it is deleted together with the file.
 *
 * Robustness contract: one unreadable/corrupt file is skipped and never breaks
 * the rest of the list (AGENTS.md: one failed entity must not erase others).
 */

import { statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How many bytes of a session file to read for header parsing. */
const HEADER_READ_BYTES = 8192;

const realpathOrSelf = async (value) => {
  try {
    return await fs.realpath(value);
  } catch {
    return value;
  }
};

/**
 * Encode a working directory into OMP's session bucket name.
 * Mirrors KXi in the OMP binary (see module docstring).
 */
const encodeOmpSessionBucketName = async (cwd, {
  homedir = os.homedir(),
  tmpdir = os.tmpdir(),
} = {}) => {
  const resolved = await realpathOrSelf(path.resolve(String(cwd ?? '')));
  const home = await realpathOrSelf(path.resolve(homedir));
  const tmp = await realpathOrSelf(path.resolve(tmpdir));
  const encode = (prefix, rel) => {
    const cleaned = rel.replace(/[/\\:]/g, '-');
    return cleaned ? `${prefix}-${cleaned}` : prefix;
  };
  const relHome = path.relative(home, resolved);
  if (relHome === '' || (!relHome.startsWith('..') && !path.isAbsolute(relHome))) {
    return encode('-', relHome);
  }
  const relTmp = path.relative(tmp, resolved);
  if (relTmp === '' || (!relTmp.startsWith('..') && !path.isAbsolute(relTmp))) {
    return encode('-tmp', relTmp);
  }
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
};

/**
 * Resolve OMP's sessions root directory. Mirrors the data-dir chain in the
 * OMP binary (PI_CONFIG_DIR → profiles → PI_CODING_AGENT_DIR → XDG_DATA_HOME).
 * Returns an absolute path.
 */
export const resolveOmpSessionsRoot = ({
  env = process.env,
  profile = undefined,
  homedir = os.homedir(),
  platform = process.platform,
  existsSync = defaultExistsSync,
} = {}) => {
  const base = typeof env.PI_CONFIG_DIR === 'string' && env.PI_CONFIG_DIR.trim()
    ? env.PI_CONFIG_DIR.trim()
    : '.omp';
  const configRoot = profile
    ? path.join(homedir, base, 'profiles', profile)
    : path.join(homedir, base);
  const agentDirOverride = !profile && typeof env.PI_CODING_AGENT_DIR === 'string'
    ? env.PI_CODING_AGENT_DIR.trim()
    : '';
  const agentDir = agentDirOverride ? path.resolve(agentDirOverride) : path.join(configRoot, 'agent');
  let dataRoot = agentDir;
  const isDefaultAgentDir = agentDir === path.join(configRoot, 'agent');
  if ((platform === 'linux' || platform === 'darwin') && isDefaultAgentDir) {
    const xdg = typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : '';
    if (xdg) {
      let candidate = path.join(xdg, 'omp');
      if (profile) candidate = path.join(candidate, 'profiles', profile);
      if (existsSync(candidate)) dataRoot = candidate;
    }
  }
  return path.join(dataRoot, 'sessions');
};

function defaultExistsSync(candidate) {
  // Synchronous by design: sessions-root resolution is memoized by callers.
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse the header of an OMP session JSONL file (title slot + session header).
 * Returns null when the header cannot be located/parsed (corrupt file).
 *
 * @param {string} text — first chunk of the file (HEADER_READ_BYTES is enough)
 * @returns {{ id: string, cwd: string|null, title: string|null,
 *   parentSession: string|null, timestamp: string|null } | null}
 */
const parseOmpSessionHeader = (text) => {
  if (typeof text !== 'string' || !text) return null;
  let title = null;
  let header = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && i < 4; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A truncated tail line inside the read window is fine; a corrupt
      // session header line means we simply never match type==='session'.
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'title' && typeof entry.title === 'string' && entry.title.trim()) {
      title = entry.title.trim();
      continue;
    }
    if (entry.type === 'session' && typeof entry.id === 'string' && entry.id) {
      header = entry;
      break;
    }
  }
  if (!header) return null;
  return {
    id: header.id,
    cwd: typeof header.cwd === 'string' && header.cwd ? header.cwd : null,
    title: title ?? (typeof header.title === 'string' && header.title.trim() ? header.title.trim() : null),
    parentSession: typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : null,
    timestamp: typeof header.timestamp === 'string' ? header.timestamp : null,
  };
};

const readHeaderChunk = async (file) => {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // ignore
    }
  }
};

/**
 * List OMP sessions for a working directory, newest activity first.
 * Corrupt/unreadable files are skipped individually; a missing bucket yields
 * an empty list (that is authoritative empty, not failure).
 *
 * @returns {Promise<Array<{ id: string, title: string|null, cwd: string|null,
 *   parentSession: string|null, file: string, createdAt: number, updatedAt: number }>>}
 */
export const listOmpSessions = async ({ sessionsRoot, directory }) => {
  const bucket = path.join(sessionsRoot, await encodeOmpSessionBucketName(directory));
  let names;
  try {
    names = await fs.readdir(bucket);
  } catch {
    return [];
  }
  const directoryReal = await realpathOrSelf(path.resolve(directory));
  const sessions = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl') || name.includes('.bak')) continue;
    const file = path.join(bucket, name);
    const chunk = await readHeaderChunk(file);
    const header = chunk ? parseOmpSessionHeader(chunk) : null;
    if (!header) continue; // corrupt/unreadable — skip this file only
    // Scope guard: the bucket name is derived from the directory, but the
    // header cwd is authoritative — drop entries that belong elsewhere.
    if (header.cwd) {
      const headerReal = await realpathOrSelf(path.resolve(header.cwd));
      if (headerReal !== directoryReal) continue;
    }
    let stats = null;
    try {
      stats = await fs.stat(file);
    } catch {
      continue;
    }
    const created = header.timestamp ? Date.parse(header.timestamp) : NaN;
    sessions.push({
      id: header.id,
      title: header.title,
      cwd: header.cwd,
      parentSession: header.parentSession,
      file,
      createdAt: Number.isFinite(created) ? created : Math.floor(stats.birthtimeMs || stats.mtimeMs),
      updatedAt: Math.floor(stats.mtimeMs),
    });
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
};

/**
 * Locate the on-disk file for a session id within a directory's bucket.
 * Fast path: the filename embeds the id (`<ISO>_<id>.jsonl`); the header id
 * is always verified before a path is trusted (OMP switch_session fabricates
 * an empty session when pointed at a nonexistent path, so callers must only
 * pass verified-existing files).
 *
 * @returns {Promise<{ file: string, header: object } | null>}
 */
export const findOmpSessionFile = async ({ sessionsRoot, directory, sessionId }) => {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const bucket = path.join(sessionsRoot, await encodeOmpSessionBucketName(directory));
  let names;
  try {
    names = await fs.readdir(bucket);
  } catch {
    return null;
  }
  const candidates = names.filter((name) => name.endsWith('.jsonl') && !name.includes('.bak'));
  candidates.sort((a, b) => {
    const aFast = a.endsWith(`_${sessionId}.jsonl`) ? 0 : 1;
    const bFast = b.endsWith(`_${sessionId}.jsonl`) ? 0 : 1;
    return aFast - bFast;
  });
  for (const name of candidates) {
    const file = path.join(bucket, name);
    const chunk = await readHeaderChunk(file);
    const header = chunk ? parseOmpSessionHeader(chunk) : null;
    if (header && header.id === sessionId) {
      return { file, header };
    }
  }
  return null;
};

/**
 * Delete a session file and its companion subagent directory (named after the
 * file without the .jsonl extension). Returns what was actually removed.
 */
export const deleteOmpSessionFile = async (file) => {
  const removed = { file: false, companionDir: false };
  try {
    await fs.rm(file, { force: false });
    removed.file = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const companion = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : null;
  if (companion) {
    try {
      const stats = await fs.stat(companion);
      if (stats.isDirectory()) {
        await fs.rm(companion, { recursive: true, force: true });
        removed.companionDir = true;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return removed;
};
