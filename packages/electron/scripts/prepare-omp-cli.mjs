/**
 * Bundles a pinned OMP CLI into the desktop resources directory.
 *
 * OMPChamber pins the bundled OMP version (OMPChamber 1.0 ↔ OMP 17.2.x).
 * This script installs `@oh-my-pi/pi-coding-agent@<pinned>` into
 * resources/omp-cli (complete dependency tree, including the platform
 * `@oh-my-pi/pi-natives-*` packages) so the desktop ships a tested OMP rather
 * than silently tracking the latest release.
 *
 * Run: bun run --cwd packages/electron prepare:omp-cli
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'omp-cli');

/** Pinned OMP version — do not bump without running the compatibility suite. */
export const PINNED_OMP_VERSION = '17.2.12';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}`);
  }
  return result;
};

const ensureExecutable = (filePath) => {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
};

const prepare = async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  // Install the pinned OMP package with its full dependency tree (natives
  // included). --no-save keeps the resource dir a standalone runtime bundle.
  run('npm', [
    'install',
    '--prefix',
    outputDir,
    '--no-save',
    '--omit=dev',
    `@oh-my-pi/pi-coding-agent@${PINNED_OMP_VERSION}`,
  ], { stdio: 'pipe' });

  // npm installs a bin shim at node_modules/.bin/omp (JS entry via bun/node).
  const binShim = path.join(outputDir, 'node_modules', '.bin', 'omp');
  const cliPath = path.join(outputDir, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`OMP CLI entrypoint not found at ${cliPath}`);
  }

  // Write a stable launcher that runs the bundled cli.js with bun (which
  // resolves the package's own node_modules for dependencies/natives). A shell
  // wrapper is used so bun treats cli.js as the entrypoint (its `// @bun`
  // directive and relative deps resolve correctly), not an imported module.
  const launcher = path.join(outputDir, 'omp');
  if (fs.existsSync(launcher)) {
    fs.rmSync(launcher, { recursive: true, force: true });
  }
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexec bun ${JSON.stringify(cliPath)} "$@"\n`,
    { encoding: 'utf8' },
  );
  ensureExecutable(launcher);
  console.log(`OMP CLI bundled: ${cliPath} (v${PINNED_OMP_VERSION})`);
  console.log(`OMP launcher written: ${launcher}`);
};

prepare().catch((error) => {
  console.error(`prepare:omp-cli failed: ${error.message}`);
  process.exit(1);
});
