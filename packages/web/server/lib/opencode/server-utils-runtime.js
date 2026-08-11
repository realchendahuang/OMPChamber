import { pathLooksUserConfigured, mergePathValues } from '../path-utils.js';

/**
 * Server utility runtime — OMP-only build.
 *
 * The OpenCode proxy/port/snapshot surface was removed with the OpenCode
 * backend; this module now only provides the generic PATH augmentation used
 * by terminal and fs routes.
 */
export const createServerUtilsRuntime = (dependencies) => {
  const {
    os,
    path,
    process,
    getLoginShellPath,
  } = dependencies;

  const getEnvValue = (name) => {
    const env = process.env || {};
    if (typeof env[name] === 'string') return env[name];
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key && typeof env[key] === 'string' ? env[key] : '';
  };

  const buildAugmentedPath = () => {
    const currentPath = getEnvValue('PATH');
    const loginShellPath = getLoginShellPath();
    const home = os.homedir();
    const currentPathLooksUserConfigured = pathLooksUserConfigured(currentPath, home, path.delimiter);
    const primaryPath = currentPathLooksUserConfigured ? currentPath : loginShellPath;
    const fallbackPath = currentPathLooksUserConfigured ? loginShellPath : currentPath;

    return mergePathValues(primaryPath, fallbackPath, path.delimiter);
  };

  return {
    buildAugmentedPath,
  };
};
