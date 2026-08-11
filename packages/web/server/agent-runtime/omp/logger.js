/**
 * OMPChamber OMP runtime logging.
 *
 * Logs to ~/.ompchamber/logs/:
 *   - omp.log     — OMP process lifecycle and normal operational messages
 *   - rpc.log     — NDJSON RPC frames (outbound + inbound), redacted
 *   - crash.log   — OMP crash details (stderr tail, exit code, crash reason)
 *
 * Sensitive values (Authorization headers, API keys, OAuth tokens, secrets)
 * are redacted before anything is written to disk.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const OMPCHAMBER_LOG_DIR = path.join(os.homedir(), '.ompchamber', 'logs');

const MAX_LOG_LINE_LENGTH = 20_000;

/** Redact sensitive substrings from a log line. */
export const redact = (text) => {
  if (typeof text !== 'string') return String(text ?? '');
  let out = text;
  // Whole-line redaction for Authorization headers / Bearer tokens.
  out = out.replace(/(Authorization\s*[:=]\s*)(["']?)([^\s"']+)(["']?)/gi, '$1$2[REDACTED]$4');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  // Token/secret values.
  out = out.replace(/(api[_-]?key|apikey|token|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, '$1=[REDACTED]');
  // Well-known key prefixes.
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]');
  out = out.replace(/\bghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]');
  return out;
};

const clampLine = (line) => {
  const str = typeof line === 'string' ? line : JSON.stringify(line);
  if (str.length <= MAX_LOG_LINE_LENGTH) return str;
  return `${str.slice(0, MAX_LOG_LINE_LENGTH)}…[truncated ${str.length - MAX_LOG_LINE_LENGTH} chars]`;
};

let logDirOverride = null;
export const setLogDir = (dir) => {
  logDirOverride = dir;
};
export const getLogDir = () => logDirOverride || OMPCHAMBER_LOG_DIR;

let writeQueue = Promise.resolve();
const writeLine = (file, line) => {
  const timestamp = new Date().toISOString();
  const content = `${timestamp} ${clampLine(line)}\n`;
  writeQueue = writeQueue
    .then(async () => {
      const dir = getLogDir();
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, file), content, 'utf8');
    })
    .catch(() => {
      // Never let logging failure crash the runtime.
    });
};

export const createLogger = (labels = {}) => {
  const { prefix = '' } = labels;
  const fmt = (msg) => (prefix ? `[${prefix}] ${msg}` : String(msg));
  return {
    omp(message) {
      writeLine('omp.log', fmt(redact(message)));
    },
    rpc(direction, frame) {
      let serialized;
      try {
        serialized = redact(typeof frame === 'string' ? frame : JSON.stringify(frame));
      } catch {
        serialized = '[unserializable frame]';
      }
      writeLine('rpc.log', `[${direction}] ${fmt(serialized)}`);
    },
    crash(message) {
      writeLine('crash.log', fmt(redact(message)));
    },
    error(message) {
      writeLine('omp.log', `[error] ${fmt(redact(message))}`);
    },
  };
};

export const defaultLogger = createLogger();
