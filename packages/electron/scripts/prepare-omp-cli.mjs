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

import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'omp-cli');

/** Pinned OMP version — do not bump without running the compatibility suite. */
export const PINNED_OMP_VERSION = '17.2.12';

const run = (command, args, options = {}) => {
  // .cmd shims (npm on Windows) are batch files: CreateProcess cannot execute
  // them directly, so they must go through cmd.exe via the shell option.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    shell: needsShell,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout?.trim(), result.stderr?.trim()]
      .filter(Boolean)
      .join('\n');
    throw new Error(`Command failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
  return result;
};

const ensureExecutable = (filePath) => {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
};

/**
 * The build target the staged tree is pruned for. Arch comes from the explicit
 * env/CLI signals the packaging pipeline already uses (OMPCHAMBER_TARGET_ARCH,
 * ELECTRON_BUILDER_ARCH, --x64/--arm64/--arch) and falls back to the host.
 * The platform is always the host: desktop builds package natively per OS.
 */
export const resolveOmpCliTarget = ({
  platform = process.platform,
  hostArchitecture = process.arch,
  environment = process.env,
  builderArgs = [],
} = {}) => ({
  platform,
  arch: resolveTargetArchitecture({ platform, hostArchitecture, environment, builderArgs }).node,
});

const COMPILE_TIME_PRUNE_PATTERNS = [/\.d\.ts$/, /\.map$/];

// The prebuilt natives live under bin/napi-v<ABI>/ (v3 for onnxruntime-node
// 1.21, v6 for the nested 1.24 copy under @huggingface/transformers).
const isOnnxRuntimeNapiDir = (directory) => (
  /^napi-v\d+$/.test(path.basename(directory))
  && path.basename(path.dirname(directory)) === 'bin'
  && path.basename(path.dirname(path.dirname(directory))) === 'onnxruntime-node'
);

/**
 * Prunes the staged OMP tree down to what the target runtime actually loads:
 * - compile-time-only artifacts (.d.ts/.map) that double the macOS signing walk
 *   (EMFILE) and inflate every installer;
 * - npm node_modules/.bin shim dirs — the launchers below bypass them, and the
 *   relative symlinks risk EPERM on Windows CI hosts and NSIS mangling;
 * - onnxruntime-node prebuilt natives (bin/napi-v<ABI>/<platform>/<arch>) for
 *   every platform/arch except the build target — both the top-level copy and
 *   the nested @huggingface/transformers copy. The loader resolves only the
 *   matching path, so the rest is dead weight (~335MB per package).
 * pi-natives-* and sherpa-onnx-* stay untouched: they are arch-scoped optional
 * deps, and the pi-natives linux-x64 baseline/modern variants are both needed.
 */
export const pruneStagedTree = (root, target) => {
  let prunedFiles = 0;
  let prunedBinDirs = 0;
  let prunedOnnxDirs = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (path.basename(directory) === '.bin' && path.basename(path.dirname(directory)) === 'node_modules') {
      fs.rmSync(directory, { recursive: true, force: true });
      prunedBinDirs += 1;
      continue;
    }
    if (isOnnxRuntimeNapiDir(directory)) {
      for (const platformEntry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!platformEntry.isDirectory()) continue;
        const platformPath = path.join(directory, platformEntry.name);
        if (platformEntry.name !== target.platform) {
          fs.rmSync(platformPath, { recursive: true, force: true });
          prunedOnnxDirs += 1;
          continue;
        }
        for (const archEntry of fs.readdirSync(platformPath, { withFileTypes: true })) {
          if (archEntry.isDirectory() && archEntry.name !== target.arch) {
            fs.rmSync(path.join(platformPath, archEntry.name), { recursive: true, force: true });
            prunedOnnxDirs += 1;
          }
        }
      }
      // The remaining native blobs hold nothing else worth pruning.
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && COMPILE_TIME_PRUNE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        fs.rmSync(fullPath);
        prunedFiles += 1;
      }
    }
  }
  return { prunedFiles, prunedBinDirs, prunedOnnxDirs };
};

/**
 * Writes both launchers so the staged tree works regardless of which platform
 * builds or consumes it: `omp` (POSIX sh) and `omp.cmd` (Windows batch —
 * CreateProcess cannot execute the sh script). Both run the bundled cli.js
 * with bun (which resolves the package's own node_modules for
 * dependencies/natives). A wrapper is used so bun treats cli.js as the
 * entrypoint (its `// @bun` directive and relative deps resolve correctly),
 * not an imported module.
 */
export const writeOmpLaunchers = (cliDir) => {
  // Resolve cli.js relative to the launcher's own location: an absolute
  // build-machine path would break inside packaged installs, where the
  // resource tree lives under a different root.
  const shLauncher = path.join(cliDir, 'omp');
  fs.writeFileSync(
    shLauncher,
    '#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec bun "$SCRIPT_DIR/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" "$@"\n',
    { encoding: 'utf8' },
  );
  ensureExecutable(shLauncher);
  const cmdLauncher = path.join(cliDir, 'omp.cmd');
  fs.writeFileSync(
    cmdLauncher,
    '@echo off\r\nbun "%~dp0node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*\r\n',
    { encoding: 'utf8' },
  );
  return { shLauncher, cmdLauncher };
};

const main = async () => {
  const target = resolveOmpCliTarget({ builderArgs: process.argv.slice(2) });
  console.log(`Staging OMP CLI for ${target.platform}-${target.arch}.`);

  fs.mkdirSync(outputDir, { recursive: true });
  // Install the pinned OMP package with its full dependency tree (natives
  // included). --no-save keeps the resource dir a standalone runtime bundle.
  // npm is npm.cmd on Windows; spawnSync cannot resolve .cmd shims without a shell.
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npmCommand, [
    'install',
    '--prefix',
    outputDir,
    '--no-save',
    '--omit=dev',
    `@oh-my-pi/pi-coding-agent@${PINNED_OMP_VERSION}`,
  ], { stdio: 'pipe' });

  const { prunedFiles, prunedBinDirs, prunedOnnxDirs } = pruneStagedTree(
    path.join(outputDir, 'node_modules'),
    target,
  );
  console.log(`Pruned ${prunedFiles} compile-time-only files (.d.ts/.map), ${prunedBinDirs} .bin shim dir(s), and ${prunedOnnxDirs} off-target onnxruntime native dir(s) from the bundled OMP tree.`);

  const cliPath = path.join(outputDir, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`OMP CLI entrypoint not found at ${cliPath}`);
  }

  const { shLauncher, cmdLauncher } = writeOmpLaunchers(outputDir);
  console.log(`OMP CLI bundled: ${cliPath} (v${PINNED_OMP_VERSION})`);
  console.log(`OMP launchers written: ${shLauncher}, ${cmdLauncher}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`prepare:omp-cli failed: ${error.message}`);
    process.exit(1);
  });
}
