const fs = require('node:fs');
const path = require('node:path');

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');

  // Stage the bundled OMP CLI runtime ourselves. electron-builder's file
  // matcher silently drops the node_modules tree from extraResources, which
  // would ship a launcher without the engine.
  const ompCliSource = path.join(__dirname, '..', 'resources', 'omp-cli');
  const ompCliTarget = path.join(resourcesPath, 'omp-cli');
  const engineEntry = path.join(ompCliTarget, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js');
  if (!fs.existsSync(engineEntry)) {
    if (!fs.existsSync(path.join(ompCliSource, 'node_modules'))) {
      throw new Error(`Missing staged OMP CLI dependencies at ${ompCliSource}; run "bun run prepare:omp-cli" first`);
    }
    fs.rmSync(ompCliTarget, { recursive: true, force: true });
    // verbatimSymlinks: npm's .bin shims are relative symlinks; the default
    // would rewrite them as absolute build-machine paths, which breaks
    // packaged installs and macOS codesign ("invalid destination for
    // symbolic link in bundle").
    fs.cpSync(ompCliSource, ompCliTarget, { recursive: true, verbatimSymlinks: true });
  }
  if (!fs.existsSync(engineEntry)) {
    throw new Error(`OMP CLI engine entry missing after staging: ${engineEntry}`);
  }

  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
