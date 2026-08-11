import 'reflect-metadata';
import express from 'express';
import compression from 'compression';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import http2 from 'node:http2';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { createTunnelAuth } from './lib/opencode/tunnel-auth.js';
import { createOmpRuntime } from './agent-runtime/omp/index.js';
import * as pathUtils from './lib/path-utils.js';
import { registerOmpAdapterRoutes } from './lib/opencode/omp-adapter-http.js';
import { domainEventToSseFrames } from './lib/opencode/omp-event-bridge.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createNgrokTunnelProvider } from './lib/tunnels/providers/ngrok.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import {
  getUnauthenticatedLanErrorMessage,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
} from './lib/security/bind-host.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  normalizeOptionalPath,
  normalizeTunnelStartRequest,
  normalizeTunnelMode,
  normalizeTunnelProvider,
} from './lib/tunnels/types.js';
import { prepareNotificationLastMessage } from './lib/notifications/index.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { detectSayTtsCapability } from './lib/tts/capability-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { createDictationRuntime } from './lib/dictation/runtime.js';
import {
  createGlobalUiEventBroadcaster,
  createGlobalMessageStreamHub,
  createMessageStreamWsRuntime,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS,
} from './lib/event-stream/index.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { createOpenCodeLifecycleRuntime } from './lib/opencode/lifecycle.js';
import { createOpenCodeEnvRuntime } from './lib/opencode/env-runtime.js';
import { resolveOpenCodeEnvConfig } from './lib/opencode/env-config.js';
import { createHmrStateRuntime } from './lib/opencode/hmr-state-runtime.js';
import { createOpenCodeNetworkRuntime } from './lib/opencode/network-runtime.js';
import { createOpenCodeAuthStateRuntime } from './lib/opencode/auth-state-runtime.js';
import { createProjectDirectoryRuntime } from './lib/opencode/project-directory-runtime.js';
import { createSettingsNormalizationRuntime } from './lib/opencode/settings-normalization-runtime.js';
import { createSettingsHelpers } from './lib/opencode/settings-helpers.js';
import { createThemeRuntime } from './lib/opencode/theme-runtime.js';
import { createFeatureRoutesRuntime } from './lib/opencode/feature-routes-runtime.js';
import { parseServeCliOptions } from './lib/server-cli.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/opencode/core-routes.js';
import { registerOMPChamberRoutes } from './lib/opencode/ompchamber-routes.js';
import { createServerUtilsRuntime } from './lib/opencode/server-utils-runtime.js';
import { createStaticRoutesRuntime } from './lib/opencode/static-routes-runtime.js';
import { createSettingsRuntime } from './lib/opencode/settings-runtime.js';
import { createOpenCodeResolutionRuntime } from './lib/opencode/opencode-resolution-runtime.js';
import { resolveOpenCodeUpgradeCapability } from './lib/opencode/upgrade-capability.js';
import { createBootstrapRuntime } from './lib/opencode/bootstrap-runtime.js';
import { createSessionRuntime } from './lib/opencode/session-runtime.js';
import { createOpenCodeWatcherRuntime } from './lib/opencode/watcher.js';
import { createSessionAssistRuntime } from './lib/session-assist/runtime.js';
import { createSessionGoalRuntime } from './lib/session-goal/runtime.js';
import { createContextObligatoryRuntime } from './lib/context-obligatory/runtime.js';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createServerStartupRuntime } from './lib/opencode/server-startup-runtime.js';
import { createTunnelWiringRuntime } from './lib/opencode/tunnel-wiring-runtime.js';
import { createStartupPipelineRuntime } from './lib/opencode/startup-pipeline-runtime.js';
import { runCliEntryIfMain } from './lib/server-cli.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { createNotificationTriggerRuntime } from './lib/notifications/runtime.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createApnsRuntime } from './lib/notifications/apns-runtime.js';
import { createNotificationTemplateRuntime } from './lib/notifications/template-runtime.js';
import { createPermissionAutoAcceptRuntime } from './lib/permission-auto-accept/runtime.js';
import { createGracefulShutdownRuntime } from './lib/opencode/shutdown-runtime.js';
import { createProjectConfigRuntime } from './lib/projects/project-config.js';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from './lib/client-auth/pairing.js';
import { createPreviewProxyRuntime } from './lib/preview/proxy-runtime.js';
import { attachRealtimeProxy } from './lib/realtime-proxy.js';
import { createRelayService } from './lib/relay/service.js';
import { createRelayHostLock } from './lib/relay/host-lock.js';
import { createAgentToolRuntime } from './lib/agent-tool/runtime.js';
import { createSystemPromptRuntime } from './lib/system-prompt/runtime.js';
import { createOMPChamberSessionService } from './lib/ompchamber-sessions/routes.js';
import { createScheduledTaskService } from './lib/scheduled-tasks/service.js';
import { createOMPChamberControlService } from './lib/ompchamber-control/service.js';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import webPush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 3000;
const DESKTOP_NOTIFY_PREFIX = '[OMPChamberDesktopNotify] ';
const uiNotificationClients = new Set();
const uiNotificationWsClients = new Set();
const uiOMPChamberEventClients = new Set();
const HEALTH_CHECK_INTERVAL = 15000;
const SHUTDOWN_TIMEOUT = 10000;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL = 5 * 60 * 1000;
const CLIENT_RELOAD_DELAY_MS = 800;
const OPEN_CODE_READY_GRACE_MS = 12000;
const LONG_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

function headerIncludesEventStream(value) {
  if (typeof value === 'string') {
    return value.toLowerCase().includes('text/event-stream');
  }

  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'));
  }

  return false;
}

/**
 * SSE endpoint paths that must never be compressed by the compression middleware.
 *
 * The compression middleware filter runs before route handlers, so
 * `res.getHeader('Content-Type')` is still undefined at that point.
 * This means the Accept-header check alone is not sufficient for
 * non-standard clients (e.g. curl, fetch) that omit Accept.
 * Path-based exclusion acts as a deterministic fallback.
 */
const SSE_PATH_PREFIXES = [
  '/api/event',
  '/api/global/event',
  '/api/notifications/stream',
  '/api/ompchamber/events',
  '/api/ompchamber/realtime-proxy/sse',
];

function shouldSkipCompression(req, res) {
  if (process.env.OMPCHAMBER_RUNTIME === 'desktop') {
    return true;
  }

  if (headerIncludesEventStream(req.headers.accept)) {
    return true;
  }

  const pathname = req.path || req.url || '';
  if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) {
    return true;
  }

  for (const prefix of SSE_PATH_PREFIXES) {
    if (pathname === prefix) {
      return true;
    }
  }

  return headerIncludesEventStream(res.getHeader('Content-Type'));
}

const OMPCHAMBER_VERSION = (() => {
  try {
    const packagePath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
  }
  return 'unknown';
})();

const isEnvFlagEnabled = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const isEnvFlagDisabled = (value) => {
  if (value === false || value === 0) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
};

const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.OMPCHAMBER_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.OMPCHAMBER_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.OMPCHAMBER_COMPRESS_API)) return true;
  return process.env.OMPCHAMBER_RUNTIME === 'desktop';
};

const OMPCHAMBER_VERBOSE_REQUEST_LOGS = isEnvFlagEnabled(process.env.OMPCHAMBER_VERBOSE_REQUEST_LOGS);

const PLAN_MODE_EXPERIMENT_ENABLED =
  isEnvFlagEnabled(process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE)
  || isEnvFlagEnabled(process.env.OPENCODE_EXPERIMENTAL);

const fsPromises = fs.promises;

const settingsNormalizationRuntime = createSettingsNormalizationRuntime({
  os,
  path,
  processLike: process,
  realpathSync: fs.realpathSync,
  tunnelBootstrapTtlDefaultMs: TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS,
  tunnelBootstrapTtlMinMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
  tunnelBootstrapTtlMaxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
  tunnelSessionTtlDefaultMs: TUNNEL_SESSION_TTL_DEFAULT_MS,
  tunnelSessionTtlMinMs: TUNNEL_SESSION_TTL_MIN_MS,
  tunnelSessionTtlMaxMs: TUNNEL_SESSION_TTL_MAX_MS,
});

const normalizeDirectoryPath = (...args) => settingsNormalizationRuntime.normalizeDirectoryPath(...args);
const normalizePathForPersistence = (...args) => settingsNormalizationRuntime.normalizePathForPersistence(...args);
const normalizeSettingsPaths = (...args) => settingsNormalizationRuntime.normalizeSettingsPaths(...args);
const normalizeTunnelBootstrapTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs(...args);
const normalizeTunnelSessionTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelSessionTtlMs(...args);
const normalizeManagedRemoteTunnelHostname = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname(...args);
const normalizeManagedRemoteTunnelPresets = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets(...args);
const normalizeManagedRemoteTunnelPresetTokens = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens(...args);
const isUnsafeSkillRelativePath = (...args) => settingsNormalizationRuntime.isUnsafeSkillRelativePath(...args);
const sanitizeTypographySizesPartial = (...args) =>
  settingsNormalizationRuntime.sanitizeTypographySizesPartial(...args);
const normalizeStringArray = (...args) => settingsNormalizationRuntime.normalizeStringArray(...args);
const sanitizeModelRefs = (...args) => settingsNormalizationRuntime.sanitizeModelRefs(...args);
const sanitizeSkillCatalogs = (...args) => settingsNormalizationRuntime.sanitizeSkillCatalogs(...args);
const sanitizeProjects = (...args) => settingsNormalizationRuntime.sanitizeProjects(...args);

const OMPCHAMBER_USER_CONFIG_ROOT = path.join(os.homedir(), '.config', 'ompchamber');
const OMPCHAMBER_USER_THEMES_DIR = path.join(OMPCHAMBER_USER_CONFIG_ROOT, 'themes');
const OMPCHAMBER_PROJECTS_CONFIG_DIR = path.join(OMPCHAMBER_USER_CONFIG_ROOT, 'projects');

const MAX_THEME_JSON_BYTES = 512 * 1024;


const themeRuntime = createThemeRuntime({
  fsPromises,
  path,
  themesDir: OMPCHAMBER_USER_THEMES_DIR,
  maxThemeJsonBytes: MAX_THEME_JSON_BYTES,
  logger: console,
});

const readCustomThemesFromDisk = (...args) => themeRuntime.readCustomThemesFromDisk(...args);

let notificationTemplateRuntime = null;
let agentToolRuntime = null;
let systemPromptRuntime = null;

const createTimeoutSignal = (...args) => notificationTemplateRuntime.createTimeoutSignal(...args);
const formatProjectLabel = (...args) => notificationTemplateRuntime.formatProjectLabel(...args);
const resolveNotificationTemplate = (...args) => notificationTemplateRuntime.resolveNotificationTemplate(...args);
const shouldApplyResolvedTemplateMessage = (...args) => notificationTemplateRuntime.shouldApplyResolvedTemplateMessage(...args);
const fetchFreeZenModels = (...args) => notificationTemplateRuntime.fetchFreeZenModels(...args);
const extractTextFromParts = (...args) => notificationTemplateRuntime.extractTextFromParts(...args);
const extractLastMessageText = (...args) => notificationTemplateRuntime.extractLastMessageText(...args);
const fetchLastAssistantMessageText = (...args) => notificationTemplateRuntime.fetchLastAssistantMessageText(...args);
const maybeCacheSessionInfoFromEvent = (...args) => notificationTemplateRuntime.maybeCacheSessionInfoFromEvent(...args);
const buildTemplateVariables = (...args) => notificationTemplateRuntime.buildTemplateVariables(...args);
const getCachedZenModels = (...args) => notificationTemplateRuntime.getCachedZenModels(...args);

const OMPCHAMBER_DATA_DIR = process.env.OMPCHAMBER_DATA_DIR
  ? path.resolve(process.env.OMPCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'ompchamber');
const SETTINGS_FILE_PATH = path.join(OMPCHAMBER_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OMPCHAMBER_DATA_DIR, 'push-subscriptions.json');
const APNS_TOKENS_FILE_PATH = path.join(OMPCHAMBER_DATA_DIR, 'apns-tokens.json');
const REMOTE_CLIENTS_FILE_PATH = path.join(OMPCHAMBER_DATA_DIR, 'remote-clients.json');
const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(OMPCHAMBER_DATA_DIR, 'client-pairing-sessions.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(OMPCHAMBER_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(OMPCHAMBER_DATA_DIR, 'cloudflare-named-tunnels.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION = 1;

const managedTunnelConfigRuntime = createManagedTunnelConfigRuntime({
  fsPromises,
  path,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  },
});

const readManagedRemoteTunnelConfigFromDisk = (...args) => managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk(...args);
const syncManagedRemoteTunnelConfigWithPresets = (...args) => managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets(...args);
const upsertManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken(...args);

const settingsHelpers = createSettingsHelpers({
  normalizePathForPersistence,
  normalizeDirectoryPath,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  sanitizeTypographySizesPartial,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeProjects,
});

const normalizePwaAppName = (...args) => settingsHelpers.normalizePwaAppName(...args);
const normalizePwaOrientation = (...args) => settingsHelpers.normalizePwaOrientation(...args);
const sanitizeSettingsUpdate = (...args) => settingsHelpers.sanitizeSettingsUpdate(...args);
const mergePersistedSettings = (...args) => settingsHelpers.mergePersistedSettings(...args);
const formatSettingsResponse = (...args) => settingsHelpers.formatSettingsResponse(...args);

const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDiskMigrated: () => readSettingsFromDiskMigrated,
  sanitizeProjects,
});

const resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const validateDirectoryPath = (...args) => projectDirectoryRuntime.validateDirectoryPath(...args);
const resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);
const resolveOptionalProjectDirectory = (...args) => projectDirectoryRuntime.resolveOptionalProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
  normalizeStringArray,
  formatSettingsResponse,
  resolveDirectoryCandidate,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
});

const readSettingsFromDiskMigrated = (...args) => settingsRuntime.readSettingsFromDiskMigrated(...args);
const readSettingsFromDisk = (...args) => settingsRuntime.readSettingsFromDisk(...args);
const readSettingsFromDiskStrict = (...args) => settingsRuntime.readSettingsFromDiskStrict(...args);
const writeSettingsToDisk = (...args) => settingsRuntime.writeSettingsToDisk(...args);
const persistSettings = (...args) => settingsRuntime.persistSettings(...args);

const requestSecurityRuntime = createRequestSecurityRuntime({
  readSettingsFromDiskMigrated,
});

const getUiSessionTokenFromRequest = (...args) => requestSecurityRuntime.getUiSessionTokenFromRequest(...args);

const pushRuntime = createPushRuntime({
  fsPromises,
  path,
  webPush,
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
});

const getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions = (...args) => pushRuntime.sendPushToAllUiSessions(...args);
// Set once the notification trigger runtime exists (declared later). When a UI
// client reports it became visible, reset the native push badge set — the same
// moment the device zeroes its icon badge on becomeActive, keeping them in sync.
let clearPendingPushBadge = () => {};
const updateUiVisibility = (token, visible, platform) => {
  if (visible === true) clearPendingPushBadge();
  return pushRuntime.updateUiVisibility(token, visible, platform);
};
const isAnyUiVisible = (...args) => pushRuntime.isAnyUiVisible(...args);
const isAnyInteractiveClientVisible = (...args) => pushRuntime.isAnyInteractiveClientVisible(...args);
const isUiVisible = (...args) => pushRuntime.isUiVisible(...args);
const ensurePushInitialized = (...args) => pushRuntime.ensurePushInitialized(...args);
const setPushInitialized = (...args) => pushRuntime.setPushInitialized(...args);

const apnsRuntime = createApnsRuntime({
  fsPromises,
  path,
  crypto,
  http2,
  APNS_TOKENS_FILE_PATH,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
  readSettingsStrict: readSettingsFromDiskStrict,
});

const addOrUpdateApnsToken = (...args) => apnsRuntime.addOrUpdateApnsToken(...args);
const removeApnsToken = (...args) => apnsRuntime.removeApnsToken(...args);
const sendApnsToAllUiSessions = (...args) => apnsRuntime.sendApnsToAllUiSessions(...args);

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade = (...args) => requestSecurityRuntime.rejectWebSocketUpgrade(...args);


const isRequestOriginAllowed = (...args) => requestSecurityRuntime.isRequestOriginAllowed(...args);

const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => ENV_DESKTOP_NOTIFY,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});

const writeSseEvent = (...args) => notificationEmitterRuntime.writeSseEvent(...args);
const emitDesktopNotification = (...args) => notificationEmitterRuntime.emitDesktopNotification(...args);
const broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
});
const broadcastUiNotification = (...args) => notificationEmitterRuntime.broadcastUiNotification(...args);

const sessionRuntime = createSessionRuntime({
  writeSseEvent,
  getNotificationClients: () => uiNotificationClients,
  broadcastEvent: broadcastGlobalUiEvent,
});

const getActiveSessionCount = () => sessionRuntime.getActiveSessionCount();

const getUpstreamStallTimeoutMs = () => (
  getActiveSessionCount() > 1
    ? UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS
    : DEFAULT_UPSTREAM_STALL_TIMEOUT_MS
);

const projectConfigRuntime = createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: OMPCHAMBER_PROJECTS_CONFIG_DIR,
});

// HMR-persistent state via globalThis
// These values survive Vite HMR reloads to prevent zombie processes
const hmrStateRuntime = createHmrStateRuntime({
  globalThisLike: globalThis,
  os,
  processLike: process,
  stateKey: '__ompchamberHmrState',
});
const hmrState = hmrStateRuntime.getOrCreateHmrState();

// Non-HMR state (safe to reset on reload)
let server = null;
let expressApp = null;
let exitOnShutdown = true;
let uiAuthController = null;
let activeTunnelController = null;
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
  createNgrokTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname = '';
let terminalRuntime = null;
let dictationRuntime = null;
let messageStreamRuntime = null;

// Sync helper - call after modifying any HMR state variable
const syncToHmrState = () => {
  hmrStateRuntime.syncStateFromRuntime(hmrState, {
    isShuttingDown,
    signalsAttached,
  });
};

// Sync helper - call to restore state from HMR (e.g., on module reload)
const syncFromHmrState = () => {
  const restored = hmrStateRuntime.restoreRuntimeFromState({ hmrState });
  isShuttingDown = restored.isShuttingDown;
  signalsAttached = restored.signalsAttached;
};

// Module-level variables that shadow HMR state
// These are synced to/from hmrState to survive HMR reloads
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;

const ENV_DESKTOP_NOTIFY = (() => {
  if (process.env.OMPCHAMBER_DESKTOP_NOTIFY === 'true') {
    return true;
  }

  if (process.env.OMPCHAMBER_RUNTIME === 'desktop') {
    return true;
  }

  const argv0 = typeof process.argv?.[0] === 'string' ? process.argv[0] : '';
  const argv1 = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return /ompchamber-server/i.test(argv0) || /ompchamber-server/i.test(argv1);
})();

// OpenCode auth compatibility — the OMP adapter runs in-process on the same
// server, so there is no upstream Basic Auth header to attach.
const getOpenCodeAuthHeaders = () => ({});
const isOpenCodeConnectionSecure = () => false;
const ensureLocalOpenCodeServerPassword = async () => {};

// OpenCode-shaped URL builder — the OMP adapter registers its surface under
// /api on this server, so OpenCode-style paths (e.g. /session/xyz) are
// prefixed with /api to reach it. Consumers such as permission-auto-accept,
// ompchamber-sessions and scheduled-tasks rely on this mapping.
const buildOpenCodeUrl = (path, prefixOverride) => {
  const address = server?.address?.();
  const effectivePort = typeof address === 'object' && address
    ? address.port
    : (process.env.OMPCHAMBER_PORT || '3199');
  const base = `http://127.0.0.1:${effectivePort}/api`;
  const normalizedPath = typeof path === 'string' && path.startsWith('/') ? path : `/${path ?? ''}`;
  return `${base}${normalizedPath}`;
};

const normalizeApiPrefix = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw === '/') return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
};

const ENV_CONFIGURED_API_PREFIX = normalizeApiPrefix(
  process.env.OPENCODE_API_PREFIX || process.env.OMPCHAMBER_API_PREFIX || ''
);

if (ENV_CONFIGURED_API_PREFIX && ENV_CONFIGURED_API_PREFIX !== '') {
  console.warn('Ignoring configured OpenCode API prefix; API runs at root.');
}

const applyLoginShellEnvSnapshot = (...args) => pathUtils.applyLoginShellEnvSnapshot(...args);
const getLoginShellEnvSnapshot = (...args) => pathUtils.getLoginShellEnvSnapshot(...args);
const isExecutable = (...args) => pathUtils.isExecutable(...args);
const searchPathFor = (...args) => pathUtils.searchPathFor(...args);
const resolveGitBinaryForSpawn = (...args) => pathUtils.resolveGitBinaryForSpawn(...args);

applyLoginShellEnvSnapshot();

notificationTemplateRuntime = createNotificationTemplateRuntime({
  readSettingsFromDisk,
  persistSettings,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveGitBinaryForSpawn,
});

const notificationTriggerRuntime = createNotificationTriggerRuntime({
  readSettingsFromDisk,
  prepareNotificationLastMessage,
  buildTemplateVariables,
  extractLastMessageText,
  fetchLastAssistantMessageText,
  resolveNotificationTemplate,
  shouldApplyResolvedTemplateMessage,
  emitDesktopNotification,
  broadcastUiNotification,
  sendPushToAllUiSessions,
  sendApnsToAllUiSessions,
  isAnyInteractiveClientVisible,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
});

const maybeSendPushForTrigger = (...args) => notificationTriggerRuntime.maybeSendPushForTrigger(...args);
const setAutoAcceptSession = (sessionId, enabled) => permissionAutoAcceptRuntime.setSessionPolicy(sessionId, enabled);
clearPendingPushBadge = () => notificationTriggerRuntime.clearPendingPushBadge();

const sessionAssistRuntime = createSessionAssistRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
});

const sessionGoalRuntime = createSessionGoalRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
  emitGoalNotification: async ({ sessionId, directory, status, goal }) => {
    // The goal settle notification replaces the per-turn ready notifications
    // (suppressed while the goal is active) — so it obeys the same toggle.
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) {
      return;
    }
    const title = status === 'complete'
      ? 'Goal complete'
      : (status === 'budgetLimited' ? 'Goal reached its token budget' : 'Goal blocked');
    const detail = goal?.statusReason && goal.statusReason !== 'verified by audit' && goal.statusReason !== 'reported by agent'
      ? goal.statusReason
      : (goal?.note || '');
    const objective = typeof goal?.objective === 'string' ? goal.objective.slice(0, 140) : '';
    const notificationPayload = {
      title,
      body: [objective, detail].filter(Boolean).join(' — ').slice(0, 240),
      tag: `goal-${sessionId}`,
      kind: 'goal',
      sessionId,
      directory,
    };
    const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
    broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
    void notificationTriggerRuntime.sendGoalSettlePush({
      sessionId,
      directory,
      status,
      title,
      body: notificationPayload.body,
    }).catch((error) => {
      console.warn('[session-goal] push fanout failed:', error?.message || error);
    });
  },
});
const contextObligatoryRuntime = createContextObligatoryRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
});

const globalMessageStreamHub = createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
});

const permissionAutoAcceptRuntime = createPermissionAutoAcceptRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent,
});
permissionAutoAcceptRuntime.start();
notificationTriggerRuntime.setGetIsSessionAutoAccepting(
  (sessionId, directory) => permissionAutoAcceptRuntime.isSessionAutoAccepting(sessionId, directory),
);

// Session-assist subscribes to the hub directly: it needs the envelope's
// directory to route its own OpenCode calls to the right instance.
console.log('[session-assist] listening for session events');
globalMessageStreamHub.subscribeEvent((event) => {
  const raw = event?.payload;
  const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
  if (!payload || typeof payload !== 'object') return;
  const directory = typeof event?.directory === 'string' && event.directory && event.directory !== 'global'
    ? event.directory
    : '';
  // Former OpenCode watcher fan-out: session cache, push triggers and the
  // session state runtime all consume the same event stream.
  maybeCacheSessionInfoFromEvent(payload);
  void maybeSendPushForTrigger(payload);
  sessionRuntime.processOpenCodeSsePayload(payload);
  sessionAssistRuntime.processPayload(payload, directory);
  sessionGoalRuntime.processPayload(payload, directory);
  contextObligatoryRuntime.processPayload(payload, directory);
});

const processForwardedEventPayload = (payload, emitSyntheticEvent) => {
  if (!payload || typeof payload !== 'object' || typeof emitSyntheticEvent !== 'function') {
    return;
  }

  maybeCacheSessionInfoFromEvent(payload);

  if (payload.type !== 'session.status') {
    return;
  }

  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const statusInfo = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const status = typeof statusInfo.type === 'string'
    ? statusInfo.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');

  if (!sessionId || !status) {
    return;
  }

  emitSyntheticEvent({
    type: 'ompchamber:session-status',
    properties: {
      sessionID: sessionId,
      status,
      timestamp: Date.now(),
      metadata: {
        attempt: typeof statusInfo.attempt === 'number'
          ? statusInfo.attempt
          : (typeof info.attempt === 'number' ? info.attempt : undefined),
        message: typeof statusInfo.message === 'string'
          ? statusInfo.message
          : (typeof info.message === 'string' ? info.message : undefined),
        next: typeof statusInfo.next === 'number'
          ? statusInfo.next
          : (typeof info.next === 'number' ? info.next : undefined),
      },
      needsAttention: false,
    },
  });

  emitSyntheticEvent({
    type: 'ompchamber:session-activity',
    properties: {
      sessionId,
      phase: status === 'busy' || status === 'retry' ? 'busy' : 'idle',
    },
  });
};


const serverUtilsRuntime = createServerUtilsRuntime({
  os,
  path,
  process,
  getLoginShellPath: () => {
    const snapshot = getLoginShellEnvSnapshot();
    if (!snapshot || typeof snapshot.PATH !== 'string' || snapshot.PATH.length === 0) {
      return null;
    }
    return snapshot.PATH;
  },
});

const buildAugmentedPath = (...args) => serverUtilsRuntime.buildAugmentedPath(...args);
const staticRoutesRuntime = createStaticRoutesRuntime({
  fs,
  path,
  process,
  __dirname,
  express,
  resolveProjectDirectory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  normalizePwaAppName,
  normalizePwaOrientation,
});
const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
  fsPromises,
  path,
  crypto,
  storePath: REMOTE_CLIENTS_FILE_PATH,
});
const clientPairingRuntime = createClientPairingRuntime({
  fsPromises,
  path,
  crypto,
  storePath: CLIENT_PAIRING_SESSIONS_FILE_PATH,
  remoteClientAuthRuntime,
});
const featureRoutesRuntime = createFeatureRoutesRuntime({
  clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
});
const bootstrapRuntime = createBootstrapRuntime({
  createUiAuth,
  registerServerStatusRoutes,
  registerCommonRequestMiddleware,
  registerAuthAndAccessRoutes,
  registerTtsRoutes,
  registerNotificationRoutes,
  registerOMPChamberRoutes,
  registerAgentToolRoutes: (app, options) => options.agentToolRuntime.registerRoutes(app, options.express),
  express,
});
const tunnelWiringRuntime = createTunnelWiringRuntime({
  crypto,
  URL,
  tunnelProviderRegistry,
  tunnelAuthController,
  readSettingsFromDiskMigrated,
  readManagedRemoteTunnelConfigFromDisk,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  isSupportedTunnelMode,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  getRuntimeManagedRemoteTunnelHostname: () => runtimeManagedRemoteTunnelHostname,
  setRuntimeManagedRemoteTunnelHostname: (value) => {
    runtimeManagedRemoteTunnelHostname = value;
  },
  getRuntimeManagedRemoteTunnelToken: () => runtimeManagedRemoteTunnelToken,
  setRuntimeManagedRemoteTunnelToken: (value) => {
    runtimeManagedRemoteTunnelToken = value;
  },
});
const startupPipelineRuntime = createStartupPipelineRuntime({
  createTerminalRuntime,
  createDictationRuntime,
  createMessageStreamWsRuntime,
  createServerStartupRuntime,
});

// The OMP engine ships a fixed bundled version and owns configuration
// reloads; there is no OpenCode binary resolution or runtime upgrade path.
const getOpenCodeResolutionSnapshot = () => ({
  resolved: null,
  source: null,
  useWsl: false,
  wslBinary: null,
  wslPath: null,
  wslDistro: null,
  nodeBinaryResolved: null,
  bunBinaryResolved: null,
  gitBinaryResolved: null,
});

const getOpenCodeUpgradeCapability = () => ({
  supported: false,
  reason: 'bundled',
  version: PINNED_OMP_VERSION,
});

// OpenCode lifecycle compatibility stubs — under the OMP engine the agent
// process is managed by the OMP runtime, so these never touch a spawned
// OpenCode server.
const restartOpenCode = async () => {};
const waitForOpenCodeReady = async () => {};
const waitForAgentPresence = async () => null;
const refreshOpenCodeAfterConfigChange = async () => ({ reloaded: true, external: false });
const startHealthMonitoring = () => {};
const triggerHealthCheck = () => {};
const scheduledTasksRuntime = createScheduledTasksRuntime({
  projectConfigRuntime,
  listProjects: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []);
  },
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  setSessionAutoAccept: (sessionId, enabled, directory) => permissionAutoAcceptRuntime.setSessionPolicy(sessionId, enabled, directory),
  emitTaskRunEvent: (event) => {
    for (const client of uiOMPChamberEventClients) {
      try {
        writeSseEvent(client, {
          type: 'ompchamber:scheduled-task-ran',
          properties: {
            projectId: event.projectID,
            taskId: event.taskID,
            ranAt: event.ranAt,
            status: event.status,
            ...(event.sessionID ? { sessionId: event.sessionID } : {}),
          },
        });
      } catch {
        uiOMPChamberEventClients.delete(client);
      }
    }
  },
  logger: console,
});
const emitSessionCreatedEvent = (event) => {
  for (const client of uiOMPChamberEventClients) {
    try {
      writeSseEvent(client, {
        type: 'ompchamber:session-created',
        properties: {
          sessionId: event.sessionID,
          directory: event.directory,
          createdAt: event.createdAt,
          promptDispatched: event.promptDispatched === true,
          dispatchedAsCommand: event.dispatchedAsCommand === true,
          ...(event.projectID ? { projectId: event.projectID } : {}),
          ...(event.title ? { title: event.title } : {}),
        },
      });
    } catch {
      uiOMPChamberEventClients.delete(client);
    }
  }
};
const scheduledTaskService = createScheduledTaskService({
  readSettingsFromDiskMigrated,
  sanitizeProjects,
  projectConfigRuntime,
  scheduledTasksRuntime,
});
const ompchamberSessionService = createOMPChamberSessionService({
  readSettingsFromDiskMigrated,
  sanitizeProjects,
  validateDirectoryPath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  emitSessionCreatedEvent,
});
const ompchamberControlService = createOMPChamberControlService({
  readSettingsFromDiskMigrated,
  sanitizeProjects,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  sessionService: ompchamberSessionService,
  scheduledTaskService,
});

// The OMP engine is the only engine: start `omp --mode rpc-ui` at startup.
const bootstrapOpenCodeAtStartup = async () => {
  try {
    await startOmpEngine();
  } catch (error) {
    console.error(`[OMP] engine startup failed: ${error.message}`);
  }
};

// The former OpenCode SSE watcher is replaced by the direct hub subscription
// above; kept as a no-op for consumers that still gate on it.
const ensureGlobalWatcherStarted = async () => {};
// Kept as a rename-compatible alias for the startup pipeline (which no longer
// knows about OpenCode).
const bootstrapAgentEngineAtStartup = bootstrapOpenCodeAtStartup;

// ---------------------------------------------------------------------------
// OMP engine (OMPCHAMBER_AGENT_ENGINE=omp)
//
// When enabled, the server spawns `omp --mode rpc-ui` instead of OpenCode and
// serves the UI's core HTTP surface through the OMP adapter. This is the
// Strangler adapter: the OpenCode path stays intact and is still the default;
// flipping the env var moves the agent engine to OMP without touching the UI.
// ---------------------------------------------------------------------------
let ompRuntime = null;
const ompEngineEnabled = () => true; // OMP is the only engine
const getOmpRuntime = () => ompRuntime;

const startOmpEngine = async () => {
  if (ompRuntime) return ompRuntime;
  const { binary, profile } = resolveOmpLaunchConfig();
  ompRuntime = createOmpRuntime({
    binary,
    cwd: process.cwd(),
    profile,
    env: {},
    onProcessState: (state) => {
      if (state.status === 'crashed') {
        console.error(`[OMP] engine crashed: ${JSON.stringify(state.crash)}`);
      }
    },
  });
  // Bridge normalized OMP domain events to the UI event stream. The UI treats
  // these as OpenCode-shaped SSE frames; the OMP engine keeps the surface
  // compatible (Strangler adapter).
  ompRuntime.subscribe((domainEvent) => {
    for (const frame of domainEventToSseFrames(domainEvent)) {
      // OMP message_update frames don't carry a sessionId; the runtime knows
      // the current session via get_state, so stamp it onto the frames.
      const sessionId = ompRuntime.session.current.sessionId;
      const patched = stampSessionId(frame, sessionId);
      globalMessageStreamHub.publishEvent({ payload: patched, directory: 'global' });
    }
  });
  try {
    await ompRuntime.start();
    // The OMP engine feeds the UI event stream via publishEvent, not OpenCode
    // SSE. Mark the hub connected so WS clients don't see an initial-error
    // from the (absent) OpenCode upstream.
    globalMessageStreamHub.markConnected();
    console.log(`[OMP] engine ready (pid=${ompRuntime.pid})`);
  } catch (error) {
    console.error(`[OMP] engine failed to start: ${error.message}`);
    throw error;
  }
  return ompRuntime;
};

const stopOmpEngine = async () => {
  if (!ompRuntime) return;
  try {
    await ompRuntime.stop();
  } catch (error) {
    console.warn(`[OMP] engine stop error: ${error?.message || error}`);
  }
  ompRuntime = null;
};

const resolveOmpLaunchConfig = () => {
  const binary = process.env.OMP_BINARY || 'omp';
  const profile = process.env.OMP_PROFILE || undefined;
  return { binary, profile };
};

const fetchAgentsSnapshot = (...args) => serverUtilsRuntime.fetchAgentsSnapshot(...args);
const fetchProvidersSnapshot = (...args) => serverUtilsRuntime.fetchProvidersSnapshot(...args);
const fetchModelsSnapshot = (...args) => serverUtilsRuntime.fetchModelsSnapshot(...args);

// Stamp the active OMP session id onto OpenCode-shaped SSE frames. OMP's
// message_update frames don't carry a sessionId; the runtime learns it from
// get_state, and the UI groups messages by sessionID, so we fill it in here.
const stampSessionId = (frame, sessionId) => {
  if (!sessionId) return frame;
  if (frame?.properties?.info) {
    return { ...frame, properties: { ...frame.properties, info: { ...frame.properties.info, sessionID: sessionId }, sessionID: sessionId } };
  }
  if (frame?.properties?.part) {
    return { ...frame, properties: { ...frame.properties, part: { ...frame.properties.part, sessionID: sessionId }, sessionID: sessionId } };
  }
  if (frame?.properties?.todos) {
    return { ...frame, properties: { ...frame.properties, sessionID: sessionId } };
  }
  // OMP ask projections carry the session id inside the permission/question
  // payload; stamp both the envelope and the nested object.
  if (frame?.properties?.permission) {
    return { ...frame, properties: { ...frame.properties, permission: { ...frame.properties.permission, sessionID: sessionId }, sessionID: sessionId } };
  }
  if (frame?.properties?.question) {
    return { ...frame, properties: { ...frame.properties, question: { ...frame.properties.question, sessionID: sessionId }, sessionID: sessionId } };
  }
  return frame;
};
const setupAgentProxy = (app) => {
  // OMP engine: serve the UI's core HTTP surface through the OMP adapter
  // instead of proxying to OpenCode. The remaining /api routes (git, fs,
  // terminal, preview, ...) are OMPChamber-owned and registered elsewhere.
  registerOmpAdapterRoutes(app, {
    getOmpRuntime,
    getDirectory: () => process.cwd(),
    log: (msg) => console.log(msg),
  });
};
// Kept as a rename-compatible alias for the startup pipeline.
const setupProxy = setupAgentProxy;
const gracefulShutdownRuntime = createGracefulShutdownRuntime({
  process,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT,
  getExitOnShutdown: () => exitOnShutdown,
  getIsShuttingDown: () => isShuttingDown,
  setIsShuttingDown: (value) => {
    isShuttingDown = value;
  },
  syncToHmrState,
  sessionAssistRuntime,
  sessionGoalRuntime,
  contextObligatoryRuntime,
  sessionRuntime,
  getHealthCheckInterval: () => healthCheckInterval,
  clearHealthCheckInterval: (value) => clearInterval(value),
  getTerminalRuntime: () => terminalRuntime,
  setTerminalRuntime: (value) => {
    terminalRuntime = value;
  },
  getMessageStreamRuntime: () => messageStreamRuntime,
  setMessageStreamRuntime: (value) => {
    messageStreamRuntime = value;
  },
  getServer: () => server,
  getUiAuthController: () => uiAuthController,
  setUiAuthController: (value) => {
    uiAuthController = value;
  },
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  tunnelAuthController,
  scheduledTasksRuntime,
});

const gracefulShutdown = async (...args) => {
  if (ompEngineEnabled()) {
    await stopOmpEngine();
  }
  return gracefulShutdownRuntime.gracefulShutdown(...args);
};

async function main(options = {}) {
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
  const effectiveBindHost = host
    || (typeof process.env.OMPCHAMBER_HOST === 'string' && process.env.OMPCHAMBER_HOST.trim().length > 0
      ? process.env.OMPCHAMBER_HOST.trim()
      : '127.0.0.1');
  agentToolRuntime = createAgentToolRuntime({
    crypto,
    fsPromises,
    path,
    dataDir: OMPCHAMBER_DATA_DIR,
    env: process.env,
    executeAction: (...args) => ompchamberControlService.execute(...args),
    getActivePort: () => {
      const address = server?.address?.();
      return typeof address === 'object' && address ? address.port : null;
    },
  });
  systemPromptRuntime = createSystemPromptRuntime({
    fsPromises,
    path,
    dataDir: OMPCHAMBER_DATA_DIR,
  });

  // Pairing transports advertised to the create-device dialog. LAN reachability is
  // derived from the SERVER's actual bind (a wildcard bind → the machine's LAN IP;
  // a specific non-loopback host → that host), NOT from how the UI was opened — so
  // "Local network" works even when the UI is opened on localhost, and is absent
  // when the server is only bound to loopback (a LAN link would not connect).
  // The IPv4 the requesting client actually reached this server on (if any).
  // Strips the IPv6-mapped prefix; loopback means "not a LAN path".
  const requestReachedLanAddress = (req) => {
    const raw = typeof req?.socket?.localAddress === 'string' ? req.socket.localAddress : '';
    const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
    if (address.startsWith('127.')) return null;
    return address;
  };
  const resolvePairingTransports = (req) => {
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const local = `http://127.0.0.1:${activePort}`;
    let lanHost = null;
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      // Prefer the address the client is ALREADY talking to us on — it is the
      // one interface guaranteed to be routable from that client's network.
      // Interface scanning is only a fallback: on servers with virtual bridges
      // (docker0 etc.) the first non-internal IPv4 can be an address no other
      // machine can reach, which produced pairing links whose LAN candidate
      // silently failed and forced devices onto the relay.
      lanHost = requestReachedLanAddress(req);
      try {
        if (!lanHost) {
          for (const list of Object.values(os.networkInterfaces())) {
            for (const entry of (list || [])) {
              if (entry.family === 'IPv4' && !entry.internal) { lanHost = entry.address; break; }
            }
            if (lanHost) break;
          }
        }
      } catch {
        lanHost = null;
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') lanHost = effectiveBindHost;
    }
    const lan = lanHost ? `http://${lanHost.includes(':') ? `[${lanHost}]` : lanHost}:${activePort}` : null;
    return { local, lan, relayAvailable: true };
  };
  // ALL direct LAN URLs this server is currently reachable on, for the
  // candidates-refresh endpoint: the address the requesting client already
  // reached us on first (guaranteed routable from its network — over the relay
  // tunnel this is loopback and yields nothing), then every non-internal IPv4
  // interface. A client that paired while the machine had a different DHCP
  // lease uses this to replace its stale LAN candidate.
  const resolveDirectLanUrls = (req) => {
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const urls = [];
    const push = (host) => {
      if (typeof host !== 'string' || !host) return;
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${activePort}`;
      if (!urls.includes(url)) urls.push(url);
    };
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      push(requestReachedLanAddress(req));
      try {
        for (const list of Object.values(os.networkInterfaces())) {
          for (const entry of (list || [])) {
            if (entry.family === 'IPv4' && !entry.internal) push(entry.address);
          }
        }
      } catch {
        // interface scan failure → whatever we already collected
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') push(effectiveBindHost);
    }
    return urls;
  };
  const uiPassword = typeof options.uiPassword === 'string'
    ? options.uiPassword
    : (typeof process.env.OMPCHAMBER_UI_PASSWORD === 'string' ? process.env.OMPCHAMBER_UI_PASSWORD : null);
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !(typeof uiPassword === 'string' && uiPassword.trim().length > 0)
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  const tryCfTunnel = options.tryCfTunnel === true;
  const apiOnly = options.apiOnly === true || isEnvFlagEnabled(process.env.OMPCHAMBER_API_ONLY);
  const shouldUseCanonicalTunnelConfig = typeof options.tunnelMode === 'string'
    || typeof options.tunnelProvider === 'string'
    || options.tunnelConfigPath === null
    || typeof options.tunnelConfigPath === 'string'
    || typeof options.tunnelToken === 'string'
    || typeof options.tunnelHostname === 'string';
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: typeof options.tunnelToken === 'string' ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
      })
    : (tryCfTunnel
      ? {
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          configPath: undefined,
          token: '',
          hostname: undefined,
        }
      : null);
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : null;
  if (typeof options.exitOnShutdown === 'boolean') {
    exitOnShutdown = options.exitOnShutdown;
  }
  if (typeof options.onDesktopNotification === 'function') {
    notificationEmitterRuntime.setOnDesktopNotification(options.onDesktopNotification);
  }
  if (typeof options.getIsWindowFocused === 'function') {
    notificationTriggerRuntime.setGetIsWindowFocused(options.getIsWindowFocused);
  }
  const getDesktopRuntimeConfig = typeof options.getDesktopRuntimeConfig === 'function'
    ? options.getDesktopRuntimeConfig
    : null;

  console.log(`Starting OMPChamber on port ${port === 0 ? 'auto' : port}`);

  // Voice enumeration is independent from route registration. Start it now,
  // but do not hold server listen or managed OpenCode startup on `say -v "?"`.
  const sayTTSCapability = detectSayTtsCapability(process);

  const app = express();
  const serverStartedAt = new Date().toISOString();
  const packagedClientOrigins = new Set([
    'ompchamber-ui://app',
    'capacitor://localhost',
    'http://localhost',
    'https://localhost',
  ]);
  const isLocalDevClientOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  app.set('trust proxy', true);
  // Keep self-hosted instances out of search engines. The app shell is served
  // publicly (it loads before prompting for the UI password), so without this
  // even a password-protected instance gets crawled and indexed. Applies to
  // every response; the robots.txt route makes the intent explicit for crawlers.
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });
  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (packagedClientOrigins.has(origin) || isLocalDevClientOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding');
      res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });
  app.use(compression({
    filter: (req, res) => {
      if (shouldSkipCompression(req, res)) return false;
      return compression.filter(req, res);
    },
    threshold: 1024,
  }));
  expressApp = app;
  server = http.createServer(app);
  let realtimeProxyRuntime = { stop: () => {} };

  // The relay service is constructed further below (it depends on the tunnel
  // runtime's active port). The pairing routes registered here only read the
  // relay candidate lazily at request time, so a late-bound holder is enough.
  let relayServiceInstance = null;

  // Same pattern for the tunnel runtime: created after the base routes so
  // /api/system/info resolves port + tunnel URL lazily at request time.
  let tunnelRuntimeContextHolder = null;

  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    process,
    ompchamberVersion: OMPCHAMBER_VERSION,
    runtimeName: process.env.OMPCHAMBER_RUNTIME || 'web',
    serverStartedAt,
    gracefulShutdown,
    getHealthSnapshot: () => {
      const launchSpec = resolvedOpencodeBinary && !useWslForOpencode
        ? resolveManagedOpenCodeLaunchSpec(resolvedOpencodeBinary)
        : null;
      return {
        openCodePort,
        openCodeRunning: Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
        openCodeSecureConnection: isOpenCodeConnectionSecure(),
        openCodeAuthSource: openCodeAuthSource || null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: true,
        isOpenCodeReady,
        lastOpenCodeError,
        lastOpenCodeLaunchDiagnostics,
        opencodeBinaryResolved: resolvedOpencodeBinary || null,
        opencodeBinarySource: resolvedOpencodeBinarySource || null,
        opencodeLaunchBinary: launchSpec?.binary || null,
        opencodeLaunchArgs: launchSpec?.args || [],
        opencodeLaunchWrapperType: launchSpec?.wrapperType || null,
        opencodeViaWsl: useWslForOpencode,
        opencodeWslBinary: resolvedWslBinary || null,
        opencodeWslPath: resolvedWslOpencodePath || null,
        opencodeWslDistro: resolvedWslDistro || null,
        nodeBinaryResolved: resolvedNodeBinary || null,
        bunBinaryResolved: resolvedBunBinary || null,
        desktopNotifyEnabled: ENV_DESKTOP_NOTIFY,
        planModeExperimentalEnabled: PLAN_MODE_EXPERIMENT_ENABLED,
        apiOnly,
      };
    },
    // Port this instance serves on and the active tunnel's public URL (if
    // any), for /api/system/info. Resolved lazily because the tunnel runtime
    // is created after these base routes are registered.
    getServerPort: () => {
      const activePort = tunnelRuntimeContextHolder?.getActivePort?.();
      if (Number.isFinite(activePort) && activePort > 0) return activePort;
      return Number.isFinite(port) && port > 0 ? port : null;
    },
    getTunnelUrl: () => tunnelRuntimeContextHolder?.tunnelService?.getPublicUrl?.() ?? null,
    verboseRequestLogs: OMPCHAMBER_VERBOSE_REQUEST_LOGS,
    uiPassword,
    tunnelAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    getRelayPairingCandidate: (options) => {
      if (!relayServiceInstance) return null;
      // A relay pairing link enables the relay on demand; a plain link only
      // advertises relay when it is already on.
      return options?.ensureEnabled
        ? relayServiceInstance.ensureEnabledForPairing()
        : relayServiceInstance.getPairingCandidate();
    },
    // Re-evaluate the relay lifecycle after pairing/device changes (a revoked or
    // redeemed device can flip relay demand on or off).
    reconcileRelay: () => (relayServiceInstance ? relayServiceInstance.reconcile() : Promise.resolve()),
    getPairingTransports: resolvePairingTransports,
    getDirectCandidateUrls: resolveDirectLanUrls,
    // Stable server identity for client-side verification of learned addresses.
    // Lazily resolved: the relay service is constructed after these routes.
    getServerId: () => (relayServiceInstance ? relayServiceInstance.getServerId() : Promise.resolve(null)),
    // The display name a paired device shows for THIS server. Devices name the
    // connection by the issuing machine's hostname, not the per-device pairing
    // label typed by the operator.
    getServerLabel: () => {
      try {
        const name = os.hostname();
        return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'OMPChamber';
      } catch {
        return 'OMPChamber';
      }
    },
    readSettingsFromDiskMigrated,
    normalizeTunnelSessionTtlMs,
    sayTTSCapability,
    ensurePushInitialized,
    ensureGlobalWatcherStarted,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    writeSettingsToDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge: () => clearPendingPushBadge(),
    isUiVisible,
    getUiNotificationClients: () => uiNotificationClients,
    writeSseEvent,
    sessionRuntime,
    setPushInitialized,
    fs,
    os,
    path,
    server,
    __dirname,
    ompchamberDataDir: OMPCHAMBER_DATA_DIR,
    modelsDevApiUrl: MODELS_DEV_API_URL,
    modelsMetadataCacheTtl: MODELS_METADATA_CACHE_TTL,
    fetchFreeZenModels,
    getCachedZenModels,
    setAutoAcceptSession,
    agentToolRuntime,
  });
  uiAuthController = bootstrapResult.uiAuthController;
  realtimeProxyRuntime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig,
    getUiAuthController: () => uiAuthController,
    isRequestOriginAllowed,
  });

  const tunnelRuntimeContext = tunnelWiringRuntime.initialize(app, port);
  const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;
  tunnelRuntimeContextHolder = tunnelRuntimeContext;

  // Private relay host service: config + management routes + host client
  // lifecycle. Loopback port comes from the same source the tunnel uses so
  // relay-tunneled requests hit the local Express app on 127.0.0.1.
  const relayService = createRelayService({
    crypto,
    os,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    readSettingsStrict: readSettingsFromDiskStrict,
    remoteClientAuthRuntime,
    getLocalPort: () => tunnelRuntimeContext.getActivePort(),
    // One relay host per machine: every instance sharing this data dir shares
    // the relay identity (serverId), so concurrent hosts evict each other at
    // the relay worker and devices land on a random local instance.
    hostLock: createRelayHostLock({
      lockFilePath: path.join(OMPCHAMBER_DATA_DIR, 'relay-host.lock'),
      fs,
      process,
    }),
    // Relay demand = any paired device or pending pairing session that uses the
    // relay transport. Drives the auto on/off lifecycle.
    hasRelayDemand: async () => {
      const [pendingRelay, deviceRelay] = await Promise.all([
        clientPairingRuntime.hasActiveRelaySession().catch(() => false),
        remoteClientAuthRuntime.hasActiveRelayClients().catch(() => false),
      ]);
      return pendingRelay || deviceRelay;
    },
  });
  relayServiceInstance = relayService;
  relayService.registerRoutes(app);

  await featureRoutesRuntime.registerRoutes(app, {
    crypto,
    fs,
    os,
    path,
    fsPromises,
    spawn,
    resolveGitBinaryForSpawn,
    createFsSearchRuntime: createFsSearchRuntimeFactory,
    ompchamberDataDir: OMPCHAMBER_DATA_DIR,
    ompchamberUserConfigRoot: OMPCHAMBER_USER_CONFIG_ROOT,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    validateDirectoryPath,
    readCustomThemesFromDisk,
    refreshOpenCodeAfterConfigChange,
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort: () => openCodePort,
    buildAugmentedPath,
    projectConfigRuntime,
    scheduledTasksRuntime,
    scheduledTaskService,
    ompchamberSessionService,
    ompchamberControlService,
    waitForOpenCodeReady,
    emitSessionCreatedEvent,
    getOMPChamberEventClients: () => uiOMPChamberEventClients,
    writeSseEvent,
    permissionAutoAcceptRuntime,
  });

  const previewProxyRuntime = createPreviewProxyRuntime({
    crypto,
    URL,
    createProxyMiddleware,
    responseInterceptor,
  });
  previewProxyRuntime.attach(app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
  });

  const startupPipelineResult = await startupPipelineRuntime.run({
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    globalEventHub: globalMessageStreamHub,
    processForwardedEventPayload,
    messageStreamWsClients: uiNotificationWsClients,
    upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
    terminalHeartbeatIntervalMs: TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    terminalRebindWindowMs: TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
    terminalMaxRebindsPerWindow: TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
    setupProxy: setupAgentProxy,
    bootstrapAgentEngineAtStartup,
    triggerHealthCheck,
    staticRoutesRuntime,
    process,
    crypto,
    normalizeTunnelBootstrapTtlMs,
    readSettingsFromDiskMigrated,
    tunnelAuthController,
    startTunnelWithNormalizedRequest,
    gracefulShutdown,
    getSignalsAttached: () => signalsAttached,
    setSignalsAttached: (value) => {
      signalsAttached = value;
    },
    syncToHmrState,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    host,
    port,
    startupTunnelRequest,
    onTunnelReady,
    tunnelRuntimeContext,
    attachSignals,
    apiOnly,
    dictationModelsDir: path.join(OMPCHAMBER_USER_CONFIG_ROOT, 'speech-models'),
  });
  terminalRuntime = startupPipelineResult.terminalRuntime;
  dictationRuntime = startupPipelineResult.dictationRuntime;
  messageStreamRuntime = startupPipelineResult.messageStreamRuntime;

  try {
    await scheduledTasksRuntime.start();
  } catch (error) {
    console.warn('[ScheduledTasks] Failed to start runtime:', error?.message || error);
  }

  // Only opens a relay control socket when the user opted in (config enabled).
  // Reconcile the relay lifecycle from demand on startup: run it if any relay
  // device/session exists, stop it (and clear a stale enabled flag) otherwise.
  void relayService.reconcile();

  // Relay demand can change outside our routes: `ompchamber connect-url
  // --relay` writes a pending relay session straight to the on-disk store, and
  // pending sessions expire without any request hitting us. Poll reconcile so a
  // headless instance picks the relay up (or drops it) within a minute.
  const relayReconcileTimer = setInterval(() => {
    void relayService.reconcile();
  }, 60_000);
  relayReconcileTimer.unref?.();

  return {
    expressApp: app,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getOpenCodePort: () => openCodePort,
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getQuitRiskStatus: () => ({
      tunnel: {
        active: Boolean(tunnelService.getPublicUrl()),
      },
      scheduledTasks: scheduledTasksRuntime.getStatus(),
    }),
    isReady: () => isOpenCodeReady,
    restartOpenCode: () => restartOpenCode(),
    getOpenCodeProcessInfo: () => {
      const managed = Boolean((openCodeProcess || openCodePort) && !ENV_SKIP_OPENCODE_START && !isExternalOpenCode);
      // Only ever expose pid/port for a server WE manage. The Electron-side
      // killer kills by port (lsof + kill -KILL), so returning a port we don't
      // own — e.g. an external/desktop OpenCode on 4096 we attached to — would
      // let a single miscomputed `managed` flag take down the user's separate
      // server. Structurally withhold what isn't ours so the killer has no
      // target, instead of relying on the flag check alone.
      return {
        managed,
        pid: managed && typeof openCodeProcess?.pid === 'number' ? openCodeProcess.pid : null,
        port: managed ? openCodePort : null,
      };
    },
    stop: (shutdownOptions = {}) => {
      realtimeProxyRuntime.stop();
      clearInterval(relayReconcileTimer);
      try {
        relayService.stop();
      } catch {
        // best-effort teardown of the relay host client
      }
      try {
        dictationRuntime?.stop?.();
      } catch {
        // best-effort shutdown of the dictation worker
      }
      return gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false });
    }
  };
}

runCliEntryIfMain({
  process,
  currentFilename: __filename,
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: TUNNEL_PROVIDER_CLOUDFLARE,
  managedLocalMode: TUNNEL_MODE_MANAGED_LOCAL,
  setExitOnShutdown: (value) => {
    exitOnShutdown = value;
  },
  startServer: main,
});

export {
  gracefulShutdown,
  setupProxy,
  restartOpenCode,
  main as startWebUiServer,
  parseServeCliOptions as parseArgs,
};
