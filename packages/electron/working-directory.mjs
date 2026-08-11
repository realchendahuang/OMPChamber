export const resolveManagedWorkingDirectory = ({ env, homedir }) => {
  const configured = typeof env?.OMPCHAMBER_WORKING_DIRECTORY === 'string'
    ? env.OMPCHAMBER_WORKING_DIRECTORY.trim()
    : '';
  if (configured) {
    return configured;
  }

  const home = typeof homedir === 'function' ? homedir() : '';
  return typeof home === 'string' && home.trim() ? home : process.cwd();
};
