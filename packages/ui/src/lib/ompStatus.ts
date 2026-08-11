import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncSessions } from '@/sync/sync-refs';
import { useUIStore } from '@/stores/useUIStore';
import { getRuntimeUrlResolver } from './runtime-url';
import { agentClient } from './agent/client';
import { runtimeFetch } from './runtime-fetch';

declare const __APP_VERSION__: string | undefined;

type ProbeResult = {
  ok: boolean;
  status: number;
  elapsedMs: number;
  summary: string;
};

type OMPChamberHealthSnapshot = {
  ompPort?: unknown;
  ompRunning?: unknown;
  ompSecureConnection?: unknown;
  ompAuthSource?: unknown;
  isOmpReady?: unknown;
  lastOmpError?: unknown;
  lastOmpLaunchDiagnostics?: unknown;
  ompBinaryResolved?: unknown;
  ompBinarySource?: unknown;
  ompLaunchBinary?: unknown;
  ompLaunchArgs?: unknown;
  ompLaunchWrapperType?: unknown;
  nodeBinaryResolved?: unknown;
  bunBinaryResolved?: unknown;
};

type OMPChamberOmpResolution = {
  configured?: unknown;
  resolved?: unknown;
  resolvedDir?: unknown;
  source?: unknown;
  detectedNow?: unknown;
  detectedSourceNow?: unknown;
  launchBinary?: unknown;
  launchArgs?: unknown;
  launchWrapperType?: unknown;
  node?: unknown;
  bun?: unknown;
};

const getCurrentDirectory = (): string => {
  const state = useSessionUIStore.getState();
  const currentSessionId = state.currentSessionId;
  if (!currentSessionId) return '';
  const sessions = getSyncSessions();
  const session = sessions.find((s) => s.id === currentSessionId);
  return typeof session?.directory === 'string' ? session.directory : '';
};

const safeFetch = async (input: string, timeoutMs = 6000): Promise<ProbeResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const resp = await runtimeFetch(input, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;
    const contentType = resp.headers.get('content-type') || '';
    const lower = contentType.toLowerCase();
    const isJson = lower.includes('json') && !lower.includes('text/html');

    let summary = '';
    if (isJson) {
      const json = await resp.json().catch(() => null);
      if (Array.isArray(json)) {
        summary = `json[array] len=${json.length}`;
      } else if (json && typeof json === 'object') {
        const keys = Object.keys(json).slice(0, 8);
        summary = `json[object] keys=${keys.join(',')}${Object.keys(json).length > keys.length ? ',…' : ''}`;
      } else {
        summary = `json[${typeof json}]`;
      }
    } else {
      summary = contentType ? `content-type=${contentType}` : 'no content-type';
    }

    return { ok: resp.ok && isJson, status: resp.status, elapsedMs, summary };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isAbort =
      controller.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted')));
    const message = isAbort
      ? `timeout after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, status: 0, elapsedMs, summary: `error=${message}` };
  } finally {
    clearTimeout(timeout);
  }
};

const formatIso = (timestamp: number | null | undefined): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '(n/a)';
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return '(invalid)';
  }
};

const normalizePort = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const formatUnknown = (value: unknown, fallback = '(n/a)'): string => {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return fallback;
};

const formatLaunchRuntime = (wrapperType: string, node: string, bun: string): string => {
  if (wrapperType === 'node-shebang' || wrapperType === 'node-launcher') {
    return node ? `node (${node})` : 'node';
  }
  if (wrapperType === 'bun-shebang') {
    return bun ? `bun (${bun})` : 'bun';
  }
  if (wrapperType) {
    return wrapperType;
  }
  return 'direct executable';
};

const buildOmpStatusReport = async (): Promise<string> => {
  const now = new Date();
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '(unknown)';
  const platform = typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)';
  const directory = getCurrentDirectory();
  const eventStreamStatus = useUIStore.getState().eventStreamStatus;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const urls = getRuntimeUrlResolver();
  const healthUrl = urls.health();
  const apiBase = urls.api('/api/');

  const ompchamberHealth: OMPChamberHealthSnapshot | null = await (async () => {
    if (!healthUrl) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await runtimeFetch(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const json = (await resp.json().catch(() => null)) as unknown;
      if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
      return json as OMPChamberHealthSnapshot;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })();

  const ompchamberOmpResolutionResult: {
    data: OMPChamberOmpResolution | null;
    status: number | null;
    error: string | null;
  } = await (async () => {
    if (!apiBase) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const resp = await runtimeFetch(urls.api('/api/config/omp-resolution'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const contentType = resp.headers.get('content-type') || '(none)';
      if (!resp.ok) {
        return { data: null, status: resp.status, error: `http ${resp.status} content-type=${contentType}` };
      }
      const raw = await resp.text();
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        const snippet = raw.replace(/\s+/g, ' ').slice(0, 120);
        return {
          data: null,
          status: resp.status,
          error: `invalid json content-type=${contentType} body=${snippet || '(empty)'}`,
        };
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { data: null, status: resp.status, error: `invalid json-shape content-type=${contentType}` };
      }
      return { data: json as OMPChamberOmpResolution, status: resp.status, error: null };
    } catch (error) {
      return {
        data: null,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  })() || { data: null, status: null, error: null };

  const buildProbeUrl = (pathname: string, includeDirectory = true): string | null => {
    if (!apiBase) return null;
    const url = new URL(pathname.replace(/^\/+/, ''), apiBase);
    if (includeDirectory && directory) {
      url.searchParams.set('directory', directory);
    }
    return url.toString();
  };

  const probeTargets: Array<{ label: string; path: string; includeDirectory?: boolean; timeoutMs?: number }> = [
    { label: 'health', path: '/health', includeDirectory: false },
    { label: 'config', path: '/config', includeDirectory: true },
    { label: 'providers', path: '/config/providers', includeDirectory: true },
    { label: 'agents', path: '/agent', includeDirectory: true, timeoutMs: 12000 },
    { label: 'commands', path: '/command', includeDirectory: true, timeoutMs: 10000 },
    { label: 'project', path: '/project/current', includeDirectory: true },
    { label: 'path', path: '/path', includeDirectory: true },
    { label: 'sessions', path: '/session', includeDirectory: true, timeoutMs: 12000 },
    { label: 'sessionStatus', path: '/session/status', includeDirectory: true },
  ];

  const probes = apiBase
    ? await Promise.all(
        probeTargets.map(async (entry) => {
          const url = buildProbeUrl(entry.path, entry.includeDirectory !== false);
          if (!url) return { label: entry.label, url: '(none)', result: null as ProbeResult | null };
          const result = await safeFetch(url, typeof entry.timeoutMs === 'number' ? entry.timeoutMs : undefined);
          return { label: entry.label, url, result };
        })
      )
    : [];

  const lines: string[] = [];
  lines.push(`Time: ${now.toISOString()}`);
  lines.push(`OMPChamber version: ${appVersion}`);
  lines.push(`Runtime: ${origin || '(unknown)'} (api=${apiBase || '(unknown)'})`);
  lines.push(`OMP SDK base: ${agentClient.getBaseUrl()}`);
  lines.push(`Event stream: ${eventStreamStatus}`);
  lines.push(`Directory: ${directory || '(none)'}`);
  lines.push(`Platform: ${platform}`);

  const runtimeOmpPort = normalizePort(ompchamberHealth?.ompPort);
  lines.push(`OMP runtime port: ${runtimeOmpPort ?? '(unknown)'}`);
  if (typeof ompchamberHealth?.ompRunning === 'boolean') {
    lines.push(`OMP runtime running: ${ompchamberHealth.ompRunning ? 'yes' : 'no'}`);
  }
  if (typeof ompchamberHealth?.ompSecureConnection === 'boolean') {
    lines.push(`Secure OMP connection: ${ompchamberHealth.ompSecureConnection ? 'true' : 'false'}`);
  }
  if (typeof ompchamberHealth?.ompAuthSource === 'string' && ompchamberHealth.ompAuthSource.trim()) {
    lines.push(`OMP auth source: ${ompchamberHealth.ompAuthSource}`);
  }

  if (typeof window !== 'undefined') {
    const injected = (window as unknown as { __OMPCHAMBER_MACOS_MAJOR__?: unknown }).__OMPCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      lines.push(`macOS major: ${injected}`);
    }
  }

  const isLikelyMac = /Mac OS X|Macintosh/.test(platform);
  if (isLikelyMac) {
    lines.push('');
    lines.push('OMP CLI resolution:');

    const launchDiagnostics = isRecord(ompchamberHealth?.lastOmpLaunchDiagnostics)
      ? ompchamberHealth.lastOmpLaunchDiagnostics
      : null;
    const actualLaunchArgs = launchDiagnostics && Array.isArray(launchDiagnostics.args)
      ? launchDiagnostics.args.filter((value): value is string => typeof value === 'string')
      : [];
    const ompchamberOmpResolution = ompchamberOmpResolutionResult.data;
    const configured =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.configured === 'string'
        ? ompchamberOmpResolution.configured
        : null;
    const resolved =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.resolved === 'string'
        ? ompchamberOmpResolution.resolved
        : (ompchamberHealth && typeof ompchamberHealth.ompBinaryResolved === 'string' ? ompchamberHealth.ompBinaryResolved : '');
    const resolvedDir =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.resolvedDir === 'string'
        ? ompchamberOmpResolution.resolvedDir
        : '';
    const source =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.source === 'string'
        ? ompchamberOmpResolution.source
        : (ompchamberHealth && typeof ompchamberHealth.ompBinarySource === 'string' ? ompchamberHealth.ompBinarySource : '');
    const configuredLaunchBinary =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.launchBinary === 'string'
        ? ompchamberOmpResolution.launchBinary
        : (ompchamberHealth && typeof ompchamberHealth.ompLaunchBinary === 'string' ? ompchamberHealth.ompLaunchBinary : '');
    const configuredLaunchWrapperType =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.launchWrapperType === 'string'
        ? ompchamberOmpResolution.launchWrapperType
        : (ompchamberHealth && typeof ompchamberHealth.ompLaunchWrapperType === 'string' ? ompchamberHealth.ompLaunchWrapperType : '');
    const configuredLaunchArgs =
      ompchamberOmpResolution && Array.isArray(ompchamberOmpResolution.launchArgs)
        ? ompchamberOmpResolution.launchArgs.filter((value): value is string => typeof value === 'string')
        : (ompchamberHealth && Array.isArray(ompchamberHealth.ompLaunchArgs)
          ? ompchamberHealth.ompLaunchArgs.filter((value): value is string => typeof value === 'string')
          : []);
    const node =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.node === 'string'
        ? ompchamberOmpResolution.node
        : (ompchamberHealth && typeof ompchamberHealth.nodeBinaryResolved === 'string' ? ompchamberHealth.nodeBinaryResolved : '');
    const bun =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.bun === 'string'
        ? ompchamberOmpResolution.bun
        : (ompchamberHealth && typeof ompchamberHealth.bunBinaryResolved === 'string' ? ompchamberHealth.bunBinaryResolved : '');
    const detectedNow =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.detectedNow === 'string'
        ? ompchamberOmpResolution.detectedNow
        : '';
    const detectedSourceNow =
      ompchamberOmpResolution && typeof ompchamberOmpResolution.detectedSourceNow === 'string'
        ? ompchamberOmpResolution.detectedSourceNow
        : '';

    if (configured !== null) {
      lines.push(`- configured: ${configured.trim().length === 0 ? '(cleared)' : configured}`);
    }

    if (resolved) {
      const dir = resolvedDir || (resolved.includes('/') ? resolved.split('/').slice(0, -1).join('/') || '/' : '');
      lines.push(`- omp: ${resolved}${dir ? ` (dir=${dir})` : ''}`);
    } else {
      lines.push('- omp: (n/a)');
    }

    lines.push(`- source: ${source || '(n/a)'}`);
    if (detectedNow) {
      lines.push(`- detected-now: ${detectedNow}`);
      lines.push(`- detected-source: ${detectedSourceNow || '(n/a)'}`);
    }
    if (launchDiagnostics) {
      lines.push(`- launched-at: ${formatUnknown(launchDiagnostics.launchedAt)}`);
      lines.push(`- launch: ${formatUnknown(launchDiagnostics.binary)} ${actualLaunchArgs.join(' ')}`.trim());
      lines.push(`- cwd: ${formatUnknown(launchDiagnostics.cwd)}`);
      lines.push(`- wrapper: ${formatUnknown(launchDiagnostics.wrapperType)}`);
      lines.push(`- runtime: ${formatLaunchRuntime(formatUnknown(launchDiagnostics.wrapperType, ''), node, bun)}`);
      lines.push(`- PATH entries: ${formatUnknown(launchDiagnostics.pathEntryCount, '(unknown)')}`);
      lines.push(`- shell env: ${formatUnknown(launchDiagnostics.hasShellEnv, '(unknown)')} (${formatUnknown(launchDiagnostics.shellEnvKeysCount, '?')} keys)`);
    } else {
      lines.push(`- launch-binary: ${configuredLaunchBinary || '(n/a)'}`);
      lines.push(`- launch-wrapper: ${configuredLaunchWrapperType || '(n/a)'}`);
      lines.push(`- launch-args: ${configuredLaunchArgs.length ? configuredLaunchArgs.join(' ') : '(none)'}`);
      lines.push(`- runtime: ${formatLaunchRuntime(configuredLaunchWrapperType || '', node, bun)}`);
    }
    if (!ompchamberOmpResolution && ompchamberOmpResolutionResult.error) {
      lines.push(`- resolution-endpoint: ${ompchamberOmpResolutionResult.error}`);
    }
  }

  lines.push('');
  if (probes.length) {
    lines.push('OMP API probes:');
    for (const probe of probes) {
      if (!probe.result) {
        lines.push(`- ${probe.label}: (no url)`);
        continue;
      }
      const { ok, status, elapsedMs, summary } = probe.result;
      const suffix = ok ? '' : ` url=${probe.url}`;
      lines.push(`- ${probe.label}: ${ok ? 'ok' : 'fail'} status=${status} time=${elapsedMs}ms ${summary}${suffix}`);
    }
  } else {
    lines.push('OMP API probes: (skipped)');
  }

  lines.push('');
  lines.push(`Generated: ${formatIso(Date.now())}`);
  return lines.join('\n');
};

export const showOmpStatus = async (): Promise<void> => {
  const text = await buildOmpStatusReport();
  const ui = useUIStore.getState();
  ui.setOmpStatusText(text);
  ui.setOmpStatusDialogOpen(true);
};
