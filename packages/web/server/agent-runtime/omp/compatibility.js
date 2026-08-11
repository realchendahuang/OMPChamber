/**
 * OMP compatibility — detects OMP version capabilities so OMPChamber can
 * adapt its protocol usage and surface a clear "unsupported OMP" state.
 *
 * OMPChamber pins a bundled OMP version (OMPChamber 0.1 ↔ OMP 17.2.x). The
 * bundled binary is tested; "Use system OMP" is an advanced escape hatch.
 */

/** The OMP major.minor floor OMPChamber 0.1 is built and tested against. */
export const MIN_SUPPORTED_OMP_VERSION = { major: 17, minor: 2 };

export const parseOmpVersion = (versionString) => {
  if (typeof versionString !== 'string') return null;
  const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

export const isVersionAtLeast = (version, floor) => {
  if (!version || !floor) return false;
  if (version.major !== floor.major) return version.major > floor.major;
  return version.minor >= floor.minor;
};

export const isOmpCompatible = (version) =>
  isVersionAtLeast(version, MIN_SUPPORTED_OMP_VERSION);

export const describeOmpIncompatibility = (version) => {
  if (!version) return 'Could not determine OMP version.';
  if (isOmpCompatible(version)) return null;
  return `OMP ${version.major}.${version.minor}.${version.patch} is older than the supported floor (${MIN_SUPPORTED_OMP_VERSION.major}.${MIN_SUPPORTED_OMP_VERSION.minor}). ` +
    'Use the bundled OMP or upgrade your system OMP.';
};
