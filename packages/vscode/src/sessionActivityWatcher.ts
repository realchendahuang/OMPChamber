import type { OmpServerManager } from './serverProcess';

// Session activity tracking (mirrors web server and desktop behavior)
type ActivityPhase = 'idle' | 'busy' | 'cooldown';

interface SessionActivity {
  sessionId: string;
  phase: ActivityPhase;
}

const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
const sessionActivityCooldowns = new Map<string, NodeJS.Timeout>();
const SESSION_COOLDOWN_DURATION_MS = 2000;

let globalEventWatcherAbortController: AbortController | null = null;
let chatViewProvider: { postMessage: (message: unknown) => void } | null = null;
let globalEventWatcherRetryTimer: NodeJS.Timeout | null = null;
let globalEventWatcherStartToken = 0;

const clearGlobalEventWatcherRetry = (): void => {
  if (!globalEventWatcherRetryTimer) {
    return;
  }
  clearTimeout(globalEventWatcherRetryTimer);
  globalEventWatcherRetryTimer = null;
};

const unwrapGlobalEventPayload = (eventData: unknown): Record<string, unknown> | null => {
  if (!eventData || typeof eventData !== 'object') {
    return null;
  }

  const record = eventData as { payload?: unknown };
  if (record.payload && typeof record.payload === 'object') {
    return record.payload as Record<string, unknown>;
  }

  return eventData as Record<string, unknown>;
};

const reconcileSessionActivityFromStatus = async (manager: OmpServerManager): Promise<void> => {
  const baseUrl = manager.getApiUrl();
  if (!baseUrl) {
    return;
  }

  const url = new URL('/api/session/status', baseUrl);
  const response = await fetch(url.toString(), {
    headers: manager.getServerAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`session status fetch failed (${response.status})`);
  }

  const statuses = await response.json() as Record<string, { type?: string }>;
  const knownSessionIds = new Set(Object.keys(statuses || {}));

  for (const [sessionId, data] of Object.entries(statuses || {})) {
    const type = typeof data?.type === 'string' ? data.type : 'idle';
    const phase: ActivityPhase = type === 'busy' || type === 'retry' ? 'busy' : 'idle';
    setSessionActivityPhase(sessionId, phase);
  }

  // Drop stale in-memory activity entries not present in authoritative status.
  for (const sessionId of Array.from(sessionActivityPhases.keys())) {
    if (!knownSessionIds.has(sessionId)) {
      setSessionActivityPhase(sessionId, 'idle');
    }
  }
};

const setSessionActivityPhase = (sessionId: string, phase: ActivityPhase): void => {
  if (!sessionId) return;

  const existingTimer = sessionActivityCooldowns.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionActivityCooldowns.delete(sessionId);
  }

  const current = sessionActivityPhases.get(sessionId);
  if (current?.phase === phase) return;

  sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

  chatViewProvider?.postMessage({
    type: 'ompchamber:session-activity',
    properties: {
      sessionId,
      phase,
    },
  });

  if (phase === 'cooldown') {
    const timer = setTimeout(() => {
      const now = sessionActivityPhases.get(sessionId);
      if (now?.phase === 'cooldown') {
        sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
        chatViewProvider?.postMessage({
          type: 'ompchamber:session-activity',
          properties: {
            sessionId,
            phase: 'idle',
          },
        });
      }
      sessionActivityCooldowns.delete(sessionId);
    }, SESSION_COOLDOWN_DURATION_MS);
    sessionActivityCooldowns.set(sessionId, timer);
  }
};

export const getSessionActivitySnapshot = (): Record<string, { type: ActivityPhase }> => {
  const snapshot: Record<string, { type: ActivityPhase }> = {};
  for (const [sessionId, data] of sessionActivityPhases.entries()) {
    snapshot[sessionId] = { type: data.phase };
  }
  return snapshot;
};

const deriveSessionActivity = (payload: Record<string, unknown>): SessionActivity | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const type = payload.type as string;
  const properties = (payload.properties ?? payload) as Record<string, unknown>;

  if (type === 'session.status') {
    const status = properties?.status as Record<string, unknown> | undefined;
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = (properties?.sessionID ?? properties?.sessionId) as string;
    const statusType = (status?.type ?? info?.type) as string;

    if (typeof sessionId === 'string' && sessionId.length > 0 && typeof statusType === 'string') {
      const phase = statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle';
      return { sessionId, phase };
    }
  }

  if (type === 'message.updated' || type === 'message.part.updated' || type === 'message.part.delta') {
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = (info?.sessionID ?? info?.sessionId ?? properties?.sessionID ?? properties?.sessionId) as string;
    const role = info?.role as string;
    const finish = info?.finish as string;
    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }
  }

  if (type === 'session.idle') {
    const sessionId = (properties?.sessionID ?? properties?.sessionId) as string;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { sessionId, phase: 'idle' };
    }
  }

  return null;
};

const waitForServerPort = async (manager: OmpServerManager, timeoutMs = 30000): Promise<number | null> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const apiUrl = manager.getApiUrl();
    if (apiUrl) {
      try {
        const url = new URL(apiUrl);
        if (url.port) {
          return parseInt(url.port, 10);
        }
      } catch {
        // ignore
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
};

export const startGlobalEventWatcher = async (
  manager: OmpServerManager,
  provider: { postMessage: (message: unknown) => void }
): Promise<void> => {
  if (globalEventWatcherAbortController) {
    return;
  }

  const startToken = ++globalEventWatcherStartToken;
  clearGlobalEventWatcherRetry();
  chatViewProvider = provider;

  const port = await waitForServerPort(manager);
  if (startToken !== globalEventWatcherStartToken) {
    return;
  }
  if (!port) {
    console.warn('[VSCode:Activity] Server port unavailable; will retry');
    globalEventWatcherRetryTimer = setTimeout(() => {
      globalEventWatcherRetryTimer = null;
      if (startToken === globalEventWatcherStartToken) {
        void startGlobalEventWatcher(manager, provider);
      }
    }, 2000);
    return;
  }

  globalEventWatcherAbortController = new AbortController();
  const signal = globalEventWatcherAbortController.signal;

  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      attempt += 1;

      try {
        const baseUrl = manager.getApiUrl();
        if (!baseUrl) {
          throw new Error('Server API URL not available');
        }

        try {
          await reconcileSessionActivityFromStatus(manager);
        } catch (error) {
          console.warn(
            '[VSCode:Activity] session status reconcile failed',
            error instanceof Error ? error.message : error,
          );
        }

        // Native SSE stream against the OMPChamber server's OpenCode-compatible
        // global event endpoint (GET /api/global/event). The server heartbeats
        // every 25s, so a stall here means the connection is dead.
        const eventUrl = new URL('/api/global/event', baseUrl);
        const response = await fetch(eventUrl.toString(), {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...manager.getServerAuthHeaders(),
          },
          signal,
        });
        if (!response.ok) {
          throw new Error(`global event stream failed (${response.status})`);
        }
        if (!response.body) {
          throw new Error('global event stream missing body');
        }

        console.log('[VSCode:Activity] connected');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const block of events) {
              const dataLine = block
                .split('\n')
                .find((line) => line.startsWith('data:'));
              if (!dataLine) {
                continue;
              }
              const raw = dataLine.slice(5).trim();
              if (!raw) {
                continue;
              }
              let eventData: unknown;
              try {
                eventData = JSON.parse(raw);
              } catch {
                continue;
              }
              const payload = unwrapGlobalEventPayload(eventData);
              if (payload) {
                const activity = deriveSessionActivity(payload);
                if (activity) {
                  setSessionActivityPhase(activity.sessionId, activity.phase);
                }
              }
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[VSCode:Activity] disconnected', error instanceof Error ? error.message : error);
      }

      const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  };

  void run();
};

export const stopGlobalEventWatcher = (): void => {
  globalEventWatcherStartToken += 1;
  clearGlobalEventWatcherRetry();

  if (globalEventWatcherAbortController) {
    try {
      globalEventWatcherAbortController.abort();
    } catch {
      // ignore
    }
  }
  globalEventWatcherAbortController = null;
  chatViewProvider = null;

  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
  sessionActivityPhases.clear();
};

export const setChatViewProvider = (provider: { postMessage: (message: unknown) => void } | null): void => {
  chatViewProvider = provider;
};
