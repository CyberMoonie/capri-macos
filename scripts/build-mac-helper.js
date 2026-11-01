#!/usr/bin/env node
'use strict';

// Builds src/main/mac/capri-helper (her eyes on macOS) from its Swift source, when it's missing or
// older than the source. Nothing to do on Windows and Linux. Needs Apple's command line tools
// (`xcode-select --install`); without them she still starts, only without seeing your windows.
//
//   node scripts/build-mac-helper.js              for this Mac
//   node scripts/build-mac-helper.js --universal  Apple silicon and Intel in one (for `npm run dist:mac`)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '..', 'src', 'main', 'mac');
const SOURCE = path.join(DIR, 'capri-helper.swift');
const OUT = path.join(DIR, 'capri-helper');
const MIN_MACOS = '12.0';

function compile(target, out) {
  const r = spawnSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', target, SOURCE, '-o', out], { stdio: 'inherit' });
  return r.status === 0;
}

function build(universal) {
  if (process.platform !== 'darwin') return true;
  const fresh = fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SOURCE).mtimeMs;
  const arches = spawnSync('lipo', ['-archs', OUT], { encoding: 'utf8' }).stdout?.trim().split(/\s+/) || [];
  if (fresh && (!universal || (arches.includes('arm64') && arches.includes('x86_64')))) return true;
  if (spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status !== 0) {
    console.warn('[capri] Swift not found: run `xcode-select --install`, then start her again to see your windows.');
    return false;
  }
  if (!universal) return compile(`${os.arch() === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos${MIN_MACOS}`, OUT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-helper-'));
  const parts = ['arm64', 'x86_64'].map((arch) => path.join(tmp, arch));
  const ok = compile(`arm64-apple-macos${MIN_MACOS}`, parts[0]) && compile(`x86_64-apple-macos${MIN_MACOS}`, parts[1])
    && spawnSync('lipo', ['-create', ...parts, '-output', OUT], { stdio: 'inherit' }).status === 0;
  fs.rmSync(tmp, { recursive: true, force: true });
  return ok;
}

module.exports = { build, OUT };

if (require.main === module) {
  const universal = process.argv.includes('--universal');
  // starting her (`npm start`): never in the way, even if it can't be built
  if (!build(universal) && universal) process.exit(1);
}
