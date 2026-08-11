import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linuxAppImageArchSuffix, readElfArchitecture, verifyExtractedPayload } from './verify-linux-appimage.mjs';

const writeElf = (filePath, architecture) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  fs.writeFileSync(filePath, header, { mode: 0o755 });
};

const createPayload = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ompchamber-payload-test-'));
  fs.writeFileSync(path.join(root, 'ompchamber.desktop'), [
    '[Desktop Entry]', 'Name=OMPChamber', 'Exec=AppRun --no-sandbox %U', 'Icon=ompchamber', 'StartupWMClass=ompchamber', '',
  ].join('\n'));
  writeElf(path.join(root, 'ompchamber'), 'x64');
  // The bundled OMP CLI is a shell launcher that execs cli.js via bun.
  const ompCliDir = path.join(root, 'resources/omp-cli');
  fs.mkdirSync(path.join(ompCliDir, 'node_modules/@oh-my-pi/pi-coding-agent/dist'), { recursive: true });
  fs.writeFileSync(path.join(ompCliDir, 'omp'), '#!/bin/sh\nexec bun "/path/to/cli.js" "$@"\n');
  fs.writeFileSync(path.join(ompCliDir, 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js'), '// @bun\n');
  for (const name of ['pty.node', 'sherpa-onnx.node']) {
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules', name), 'x64');
  }
  return root;
};

test('reads supported ELF architectures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ompchamber-elf-test-'));
  try {
    writeElf(path.join(root, 'x64'), 'x64');
    writeElf(path.join(root, 'arm64'), 'arm64');
    assert.equal(readElfArchitecture(path.join(root, 'x64')), 'x64');
    assert.equal(readElfArchitecture(path.join(root, 'arm64')), 'arm64');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AppImage artifact names use electron-builder arch suffixes', () => {
  assert.equal(linuxAppImageArchSuffix('x64'), 'x86_64');
  assert.equal(linuxAppImageArchSuffix('arm64'), 'arm64');
});

test('verifies identity, version, and native payload architecture', () => {
  const root = createPayload();
  try {
    const result = verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '17.2.12',
      runCliVersion: () => '17.2.12',
    });
    assert.equal(result.nativeModuleCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a missing native module', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'));
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '17.2.12',
      runCliVersion: () => '17.2.12',
    }), /Missing packaged native module: pty\.node/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on wrong CLI version or native architecture', () => {
  const root = createPayload();
  try {
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '17.2.12',
      runCliVersion: () => '17.2.11',
    }), /OMP CLI version mismatch/);
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'), 'arm64');
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '17.2.12',
      runCliVersion: () => '17.2.12',
    }), /Native module architecture mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a missing or malformed OMP launcher', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'resources/omp-cli/omp'));
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '17.2.12',
      runCliVersion: () => '17.2.12',
    }), /Missing bundled OMP launcher/);
    fs.writeFileSync(path.join(root, 'resources/omp-cli/omp'), '#!/bin/sh\necho not-bun\n');
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '17.2.12',
      runCliVersion: () => '17.2.12',
    }), /not the expected bun exec script/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
