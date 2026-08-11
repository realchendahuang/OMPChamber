export const createHmrStateRuntime = (dependencies) => {
  const {
    globalThisLike,
    os,
    processLike,
    stateKey,
  } = dependencies;

  const getInitialOmpWorkingDirectory = () => {
    const configured = typeof processLike.env.OMPCHAMBER_WORKING_DIRECTORY === 'string'
      ? processLike.env.OMPCHAMBER_WORKING_DIRECTORY.trim()
      : '';
    return configured || os.homedir();
  };

  const getOrCreateHmrState = () => {
    if (!globalThisLike[stateKey]) {
      globalThisLike[stateKey] = {
        ompProcess: null,
        ompPort: null,
        ompWorkingDirectory: getInitialOmpWorkingDirectory(),
        isShuttingDown: false,
        signalsAttached: false,
        userProvidedOmpPassword: undefined,
        ompAuthPassword: null,
        ompAuthSource: null,
      };
    }
    return globalThisLike[stateKey];
  };

  const ensureUserProvidedOmpPassword = (hmrState) => {
    if (typeof hmrState.userProvidedOmpPassword !== 'undefined') {
      return;
    }
    const initialPassword = typeof processLike.env.OPENCODE_SERVER_PASSWORD === 'string'
      ? processLike.env.OPENCODE_SERVER_PASSWORD.trim()
      : '';
    hmrState.userProvidedOmpPassword = initialPassword || null;
  };

  const getUserProvidedOmpPassword = (hmrState) => (
    typeof hmrState.userProvidedOmpPassword === 'string' && hmrState.userProvidedOmpPassword.length > 0
      ? hmrState.userProvidedOmpPassword
      : null
  );

  const resolveOmpAuthFromState = ({ hmrState, userProvidedOmpPassword }) => ({
    ompAuthPassword:
      typeof hmrState.ompAuthPassword === 'string' && hmrState.ompAuthPassword.length > 0
        ? hmrState.ompAuthPassword
        : userProvidedOmpPassword,
    ompAuthSource:
      typeof hmrState.ompAuthSource === 'string' && hmrState.ompAuthSource.length > 0
        ? hmrState.ompAuthSource
        : (userProvidedOmpPassword ? 'user-env' : null),
  });

  const syncStateFromRuntime = (hmrState, runtime) => {
    hmrState.ompProcess = runtime.ompProcess;
    hmrState.ompPort = runtime.ompPort;
    hmrState.ompBaseUrl = runtime.ompBaseUrl;
    hmrState.isShuttingDown = runtime.isShuttingDown;
    hmrState.signalsAttached = runtime.signalsAttached;
    hmrState.ompWorkingDirectory = runtime.ompWorkingDirectory;
    hmrState.ompAuthPassword = runtime.ompAuthPassword;
    hmrState.ompAuthSource = runtime.ompAuthSource;
  };

  const restoreRuntimeFromState = ({ hmrState, userProvidedOmpPassword }) => {
    const auth = resolveOmpAuthFromState({ hmrState, userProvidedOmpPassword });
    return {
      ompProcess: hmrState.ompProcess,
      ompPort: hmrState.ompPort,
      ompBaseUrl: hmrState.ompBaseUrl ?? null,
      isShuttingDown: hmrState.isShuttingDown,
      signalsAttached: hmrState.signalsAttached,
      ompWorkingDirectory: hmrState.ompWorkingDirectory,
      ompAuthPassword: auth.ompAuthPassword,
      ompAuthSource: auth.ompAuthSource,
    };
  };

  return {
    getOrCreateHmrState,
    ensureUserProvidedOmpPassword,
    getUserProvidedOmpPassword,
    resolveOmpAuthFromState,
    syncStateFromRuntime,
    restoreRuntimeFromState,
  };
};
