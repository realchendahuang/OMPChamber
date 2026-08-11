import { createUpstreamSseReader } from './upstream-reader.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;

export function createGlobalMessageStreamHub({
  buildOmpUrl,
  getOmpAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
}) {
  const eventSubscribers = new Set();
  const statusSubscribers = new Set();
  const replay = [];

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;
  // Set when an external engine (OMP) drives events via publishEvent, so
  // start() does not spawn an upstream OpenCode SSE reader.
  let externallyConnected = false;

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const notifyStatus = (status) => {
    for (const subscriber of Array.from(statusSubscribers)) {
      notifySubscriber('status', subscriber, status);
    }
  };

  const normalizeEvent = ({ envelope, payload }) => {
    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = typeof envelope?.eventId === 'string' && envelope.eventId.length > 0 ? envelope.eventId : undefined;
    return {
      envelope,
      payload,
      directory,
      eventId,
    };
  };

  const start = () => {
    if (reader) {
      return;
    }

    // When the hub is externally driven (OMP engine markConnected), there is no
    // upstream OpenCode SSE to read. Do not spawn an upstream reader that would
    // fail building an OpenCode URL.
    if (externallyConnected) {
      return;
    }

    controller = new AbortController();
    reader = createUpstreamSseReader({
      signal: controller.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      buildUrl: () => {
        buildUrlFailed = false;
        try {
          return new URL(buildOmpUrl('/global/event', ''));
        } catch {
          buildUrlFailed = true;
          throw new Error('OpenCode service unavailable');
        }
      },
      getHeaders: getOmpAuthHeaders,
      onConnect() {
        connected = true;
        const wasReady = everConnected;
        everConnected = true;
        notifyStatus({ type: 'connect', wasReady });
      },
      onDisconnect({ reason }) {
        connected = false;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent(event) {
        const normalized = normalizeEvent(event);
        if (normalized.eventId) {
          replay.push(normalized);
          if (replay.length > replayLimit) {
            replay.splice(0, replay.length - replayLimit);
          }
        }

        for (const subscriber of Array.from(eventSubscribers)) {
          notifySubscriber('event', subscriber, normalized);
        }
      },
      onError(error) {
        if (controller?.signal.aborted) {
          return;
        }

        notifyStatus({
          type: everConnected ? 'error' : 'initial-error',
          error,
          buildUrlFailed,
        });
      },
    });

    void reader.start();
  };

  const stop = () => {
    connected = false;
    reader?.stop();
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    reader = null;
    controller = null;
    everConnected = false;
    buildUrlFailed = false;
    externallyConnected = false;
  };

  return {
    start,
    stop,
    isConnected() {
      return connected;
    },
    hasConnected() {
      return everConnected;
    },
    /**
     * Mark the hub connected without an upstream SSE reader. Used by the OMP
     * engine: the event source is OMP's own domain events (publishEvent), not
     * OpenCode SSE, so no upstream URL is built or fetched.
     */
    markConnected() {
      if (connected) return;
      connected = true;
      everConnected = true;
      externallyConnected = true;
      notifyStatus({ type: 'connect', wasReady: false });
    },
    /**
     * Inject a synthetic event into the hub without an upstream SSE reader.
     * Used by the OMP engine (OMPCHAMBER_AGENT_ENGINE=omp) to feed the UI
     * event stream from normalized OMP domain events instead of OpenCode SSE.
     */
    publishEvent({ payload, directory = 'global', eventId }) {
      const normalized = {
        envelope: { directory, ...(eventId ? { eventId } : {}) },
        payload,
        directory,
        eventId,
      };
      if (eventId) {
        replay.push(normalized);
        if (replay.length > replayLimit) {
          replay.splice(0, replay.length - replayLimit);
        }
      }
      for (const subscriber of Array.from(eventSubscribers)) {
        notifySubscriber('event', subscriber, normalized);
      }
    },
    subscribeEvent(subscriber) {
      eventSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
      };
    },
    subscribeStatus(subscriber) {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },
    replayAfter(eventId) {
      if (!eventId) {
        return [];
      }

      const index = replay.findIndex((entry) => entry.eventId === eventId);
      return index === -1 ? [] : replay.slice(index + 1);
    },
  };
}
