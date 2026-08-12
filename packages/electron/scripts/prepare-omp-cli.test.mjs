import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pruneStagedTree, resolveOmpCliTarget, writeOmpLaunchers } from './prepare-omp-cli.mjs';

const writeFile = (filePath, content = 'x') => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const createStagedTree = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ompchamber-omp-cli-test-'));
  const modules = path.join(root, 'node_modules');
  // Two onnxruntime-node copies: top-level (napi-v3) and nested under
  // @huggingface/transformers (napi-v6, as shipped by onnxruntime-node 1.24).
  for (const [base, abi] of [
    [path.join(modules, 'onnxruntime-node'), 'napi-v3'],
    [path.join(modules, '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node'), 'napi-v6'],
  ]) {
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        writeFile(path.join(base, 'bin', abi, platform, arch, 'onnxruntime_binding.node'));
      }
    }
  }
  // npm bin shims, top-level and nested.
  writeFile(path.join(modules, '.bin', 'omp'));
  writeFile(path.join(modules, '@huggingface', 'transformers', 'node_modules', '.bin', 'jiti'));
  // Compile-time-only artifacts.
  writeFile(path.join(modules, 'some-pkg', 'index.d.ts'));
  writeFile(path.join(modules, 'some-pkg', 'index.js.map'));
  writeFile(path.join(modules, 'some-pkg', 'index.js'));
  // Arch-scoped optional deps that must survive pruning untouched.
  writeFile(path.join(modules, '@oh-my-pi', 'pi-natives-linux-x64', 'baseline', 'lib.node'));
  writeFile(path.join(modules, '@oh-my-pi', 'pi-natives-linux-x64', 'modern', 'lib.node'));
  writeFile(path.join(modules, 'sherpa-onnx-linux-x64', 'sherpa-onnx.node'));
  return { root, modules };
};

test('prunes compile-time artifacts, .bin shims, and off-target onnxruntime natives', () => {
  const { root, modules } = createStagedTree();
  try {
    const result = pruneStagedTree(modules, { platform: 'darwin', arch: 'arm64' });
    assert.equal(result.prunedFiles, 2);
    assert.equal(result.prunedBinDirs, 2);
    // Per copy: 2 off-target platforms + 1 off-target arch inside darwin.
    assert.equal(result.prunedOnnxDirs, 6);

    for (const [base, abi] of [
      [path.join(modules, 'onnxruntime-node'), 'napi-v3'],
      [path.join(modules, '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node'), 'napi-v6'],
    ]) {
      assert.deepEqual(fs.readdirSync(path.join(base, 'bin', abi)), ['darwin']);
      assert.deepEqual(fs.readdirSync(path.join(base, 'bin', abi, 'darwin')), ['arm64']);
      assert.ok(fs.existsSync(path.join(base, 'bin', abi, 'darwin', 'arm64', 'onnxruntime_binding.node')));
    }
    assert.ok(!fs.existsSync(path.join(modules, '.bin')));
    assert.ok(!fs.existsSync(path.join(modules, '@huggingface', 'transformers', 'node_modules', '.bin')));
    assert.ok(!fs.existsSync(path.join(modules, 'some-pkg', 'index.d.ts')));
    assert.ok(!fs.existsSync(path.join(modules, 'some-pkg', 'index.js.map')));
    assert.ok(fs.existsSync(path.join(modules, 'some-pkg', 'index.js')));
    // pi-natives variants and sherpa-onnx are arch-scoped runtime deps: untouched.
    assert.ok(fs.existsSync(path.join(modules, '@oh-my-pi', 'pi-natives-linux-x64', 'baseline', 'lib.node')));
    assert.ok(fs.existsSync(path.join(modules, '@oh-my-pi', 'pi-natives-linux-x64', 'modern', 'lib.node')));
    assert.ok(fs.existsSync(path.join(modules, 'sherpa-onnx-linux-x64', 'sherpa-onnx.node')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps the matching target arch for a different target', () => {
  const { root, modules } = createStagedTree();
  try {
    pruneStagedTree(modules, { platform: 'win32', arch: 'x64' });
    const napi = path.join(modules, 'onnxruntime-node', 'bin', 'napi-v3');
    assert.deepEqual(fs.readdirSync(napi), ['win32']);
    assert.deepEqual(fs.readdirSync(path.join(napi, 'win32')), ['x64']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writes both POSIX and Windows launchers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ompchamber-launcher-test-'));
  try {
    const { shLauncher, cmdLauncher } = writeOmpLaunchers(root);
    const sh = fs.readFileSync(shLauncher, 'utf8');
    assert.match(sh, /^#!\/bin\/sh\n/);
    assert.ok(sh.includes('exec bun "$SCRIPT_DIR/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" "$@"'));
    const cmd = fs.readFileSync(cmdLauncher, 'utf8');
    assert.match(cmd, /^@echo off\r\n/);
    assert.ok(cmd.includes('bun "%~dp0node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolves the build target from explicit env, falling back to the host', () => {
  assert.deepEqual(
    resolveOmpCliTarget({
      platform: 'darwin',
      hostArchitecture: 'arm64',
      environment: { ELECTRON_BUILDER_ARCH: 'x64' },
    }),
    { platform: 'darwin', arch: 'x64' },
  );
  assert.deepEqual(
    resolveOmpCliTarget({ platform: 'darwin', hostArchitecture: 'arm64', environment: {} }),
    { platform: 'darwin', arch: 'arm64' },
  );
  assert.throws(
    () => resolveOmpCliTarget({
      platform: 'linux',
      hostArchitecture: 'x64',
      environment: { OMPCHAMBER_TARGET_ARCH: 'arm64' },
    }),
    /must be built natively/,
  );
});
