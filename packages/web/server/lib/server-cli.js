/**
 * Server CLI entry helpers.
 *
 * These are engine-agnostic: they only parse `node packages/web/server/index.js`
 * command-line flags (port/host/tunnel/ui-password) and bootstrap the server
 * when the module is executed directly. They live outside `lib/ompchamber/`
 * because they are not OpenCode-specific.
 */

import { realpathSync } from 'fs';

export const parseServeCliOptions = ({
  argv = [],
  env = {},
  defaultPort,
  cloudflareProvider,
  managedLocalMode,
}) => {
  const args = Array.isArray(argv) ? [...argv] : [];
  const envPassword =
    env.OMPCHAMBER_UI_PASSWORD ||
    env.OPENCODE_UI_PASSWORD ||
    null;
  const envCfTunnel = env.OMPCHAMBER_TRY_CF_TUNNEL === 'true';
  const envTunnelProvider = env.OMPCHAMBER_TUNNEL_PROVIDER || undefined;
  const envTunnelMode = env.OMPCHAMBER_TUNNEL_MODE || undefined;
  const envTunnelConfigRaw = env.OMPCHAMBER_TUNNEL_CONFIG;
  const envTunnelConfig = typeof envTunnelConfigRaw === 'string'
    ? (envTunnelConfigRaw.trim().length > 0 ? envTunnelConfigRaw.trim() : null)
    : undefined;
  const envTunnelToken = env.OMPCHAMBER_TUNNEL_TOKEN || undefined;
  const envTunnelHostname = env.OMPCHAMBER_TUNNEL_HOSTNAME || undefined;
  const envApiOnly = env.OMPCHAMBER_API_ONLY === '1' || env.OMPCHAMBER_API_ONLY === 'true';

  const options = {
    port: defaultPort,
    host: undefined,
    uiPassword: envPassword,
    tryCfTunnel: envCfTunnel,
    tunnelProvider: envTunnelProvider,
    tunnelMode: envTunnelMode,
    tunnelConfigPath: envTunnelConfig,
    tunnelToken: envTunnelToken,
    tunnelHostname: envTunnelHostname,
    apiOnly: envApiOnly,
  };

  const consumeValue = (currentIndex, inlineValue) => {
    if (typeof inlineValue === 'string') {
      return { value: inlineValue, nextIndex: currentIndex };
    }
    const nextArg = args[currentIndex + 1];
    if (typeof nextArg === 'string' && !nextArg.startsWith('--')) {
      return { value: nextArg, nextIndex: currentIndex + 1 };
    }
    return { value: undefined, nextIndex: currentIndex };
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const optionName = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    if (optionName === 'port' || optionName === 'p') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      const parsedPort = parseInt(value ?? '', 10);
      options.port = Number.isFinite(parsedPort) ? parsedPort : defaultPort;
      continue;
    }

    if (optionName === 'host') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.host = typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
      continue;
    }

    if (optionName === 'ui-password') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.uiPassword = typeof value === 'string' ? value : '';
      continue;
    }

    if (optionName === 'api-only') {
      options.apiOnly = true;
      continue;
    }

    if (optionName === 'try-cf-tunnel') {
      options.tryCfTunnel = true;
      continue;
    }

    if (optionName === 'tunnel-provider') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = typeof value === 'string' ? value : options.tunnelProvider;
      continue;
    }

    if (optionName === 'tunnel-mode') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelMode = typeof value === 'string' ? value : options.tunnelMode;
      continue;
    }

    if (optionName === 'tunnel-config') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelConfigPath = typeof value === 'string' ? value : null;
      continue;
    }

    if (optionName === 'tunnel-token') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelToken = typeof value === 'string' ? value : options.tunnelToken;
      continue;
    }

    if (optionName === 'tunnel-hostname') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelHostname = typeof value === 'string' ? value : options.tunnelHostname;
      continue;
    }

    if (optionName === 'tunnel') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = cloudflareProvider;
      options.tunnelMode = managedLocalMode;
      options.tunnelConfigPath = typeof value === 'string' ? value : null;
    }
  }

  return options;
};

export const runCliEntryIfMain = (dependencies) => {
  const {
    process,
    currentFilename,
    parseServeCliOptions: parse,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
    setExitOnShutdown,
    startServer,
  } = dependencies;

  // Compare realpaths: on macOS /tmp is a symlink to /private/tmp, so the
  // argv[1] the shell passed and the resolved module filename can differ
  // textually while naming the same file. A strict string compare would
  // silently skip CLI bootstrap for bundled/relocated entrypoints.
  const normalizeEntryPath = (value) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const isCliExecution = normalizeEntryPath(process.argv[1]) === normalizeEntryPath(currentFilename);
  if (!isCliExecution) {
    return;
  }

  const cliOptions = parse({
    argv: process.argv.slice(2),
    env: process.env,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
  });

  setExitOnShutdown(true);
  startServer({
    port: cliOptions.port,
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword,
    apiOnly: cliOptions.apiOnly,
  }).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
};
