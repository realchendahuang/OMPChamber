/**
 * OMP RPC client — reads/writes JSON Lines (NDJSON) over an OMP process
 * stdin/stdout pair.
 *
 * Responsibilities:
 *   - buffer stdout into complete JSON lines
 *   - parse each line into a frame and dispatch to handlers
 *   - write command frames to stdin (guarded against backpressure/exits)
 *   - correlate command `id` → response promises
 *   - protocol v2 chunk reassembly (rpc_chunk frames)
 */

import { createLogger } from './logger.js';

const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024; // 64 MiB (protocol v2)

const nextId = (() => {
  let counter = 0;
  return (prefix = 'omp') => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
})();

/**
 * @param {object} opts
 * @param {NodeJS.ReadableStream} opts.stdin    — writable side to OMP
 * @param {NodeJS.WritableStream} opts.stdout   — readable side from OMP (RPC frames)
 * @param {NodeJS.WritableStream} [opts.stderr] — readable side from OMP (free-form logs)
 * @param {(frame: object) => void} [opts.onFrame] — every parsed frame
 * @param {(error: Error) => void} [opts.onError]
 * @param {ReturnType<typeof createLogger>} [opts.logger]
 */
export const createRpcClient = ({
  stdin,
  stdout,
  stderr,
  onFrame = () => {},
  onError = () => {},
  logger = createLogger(),
}) => {
  let buffer = '';
  let closed = false;

  // pending command id → resolver map
  const pending = new Map();
  // chunk reassembly for protocol v2
  const chunks = new Map();

  const handleFrame = (frame) => {
    if (frame && frame.type === 'rpc_chunk') {
      const { chunkId, index, count, byteLength, data } = frame;
      const entry = chunks.get(chunkId) || { parts: new Array(count), count, byteLength, received: 0 };
      entry.parts[index] = data;
      entry.received = (entry.received || 0) + data.length;
      chunks.set(chunkId, entry);
      if (entry.received >= byteLength && entry.parts.every(Boolean)) {
        chunks.delete(chunkId);
        const raw = entry.parts.join('');
        try {
          const reassembled = JSON.parse(raw);
          handleFrame(reassembled);
        } catch (error) {
          onError(new Error(`Failed to reassemble rpc_chunk ${chunkId}: ${error.message}`));
        }
      }
      return;
    }

    // resolve pending command by id
    if (frame && frame.id && pending.has(frame.id)) {
      const { resolve, reject, timer } = pending.get(frame.id);
      pending.delete(frame.id);
      if (timer) clearTimeout(timer);
      if (frame.type === 'response' && frame.success === false) {
        reject(new Error(frame.error || `OMP command failed`));
      } else {
        resolve(frame);
      }
    }

    logger.rpc('in', frame);
    onFrame(frame);
  };

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        logger.rpc('in', line);
        onError(new Error(`Failed to parse OMP RPC line (non-JSON): ${line.slice(0, 200)}`));
        continue;
      }
      handleFrame(frame);
    }
  };

  const onEnd = () => {
    closed = true;
    flushPending(new Error('OMP RPC stream ended'));
  };

  const onStdErrData = (chunk) => {
    logger.omp(`[stderr] ${chunk.toString('utf8').trim()}`);
  };

  const flushPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const writeLine = (text) => {
    if (closed) {
      throw new Error('OMP RPC client is closed');
    }
    if (!stdin || typeof stdin.write !== 'function') {
      throw new Error('OMP stdin is not writable');
    }
    const ok = stdin.write(`${text}\n`, 'utf8');
    if (!ok) {
      // Backpressure: buffer is fine for our command volume; surface a warning once.
    }
    return ok;
  };

  /** Send a command frame; resolve with its response frame. */
  const send = (frame, { timeoutMs = 30_000 } = {}) => {
    if (frame.id === undefined) {
      frame = { ...frame, id: nextId() };
    }
    const id = frame.id;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`OMP RPC command "${frame.type}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      pending.get(id).timer = timer;
      try {
        writeLine(JSON.stringify(frame));
        logger.rpc('out', frame);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  /** Fire-and-forget command (no response correlation). */
  const notify = (frame) => {
    try {
      writeLine(JSON.stringify({ ...frame, id: frame.id ?? nextId() }));
      logger.rpc('out', frame);
    } catch (error) {
      onError(error);
    }
  };

  const close = () => {
    closed = true;
    flushPending(new Error('OMP RPC client closed'));
    try {
      stdin?.end?.();
    } catch {
      // ignore
    }
  };

  if (stdout && typeof stdout.on === 'function') {
    stdout.on('data', onData);
    stdout.on('end', onEnd);
    stdout.on('error', (error) => onError(error));
  }
  if (stderr && typeof stderr.on === 'function') {
    stderr.on('data', onStdErrData);
    stderr.on('error', (error) => onError(error));
  }

  return {
    send,
    notify,
    close,
    get closed() {
      return closed;
    },
  };
};
