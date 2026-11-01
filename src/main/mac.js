'use strict';

// macOS: her native helper (mac/capri-helper.swift), what the Mac lets her do (Screen Recording,
// Accessibility), and the shell's PATH, which an app started from Finder or the Dock doesn't get.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAC = process.platform === 'darwin';
// in the installed app it sits next to the app archive (asarUnpack), where it can be run
const HELPER = path.join(__dirname, 'mac', 'capri-helper').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const available = () => MAC && fs.existsSync(HELPER);

// One of its commands, its answer as text.
function helper(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error('macOS helper missing'));
    execFile(HELPER, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}

const helperJson = (args, timeout) => helper(args, timeout).then((out) => JSON.parse(out));

// An AppleScript line, its answer as text, or null when it fails (or you said no to it).
function osa(script, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}

// What she's allowed: { screen, accessibility }, false for both when it can't be asked.
const perms = () => helperJson(['perms']).catch(() => ({ screen: false, accessibility: false }));

// System Settings, on the right page of Privacy & Security.
const SETTINGS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

// Where her programs might be, before the shell says: Homebrew, the Claude Code and npm installers…
function usualDirs(home = os.homedir()) {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin')];
}

function mergePath(current, extra) {
  const parts = String(current || '').split(':').filter(Boolean);
  for (const dir of extra) if (dir && !parts.includes(dir)) parts.push(dir);
  return parts.join(':');
}

// Started from Finder or the Dock, an app gets a bare PATH (/usr/bin:/bin…): `claude`, `ollama` and
// `node` wouldn't be found. The usual folders go in right away, then whatever your login shell adds
// (nvm, fnm, asdf…), asked once in the background. Resolves when that's done.
let ready = Promise.resolve();
function fixPath() {
  if (!MAC) return ready;
  process.env.PATH = mergePath(process.env.PATH, usualDirs());
  const shell = process.env.SHELL || '/bin/zsh';
  const mark = '__CAPRI_PATH__';
  ready = new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }, (err, out) => {
      const found = new RegExp(`${mark}(.*?)${mark}`).exec(String(out || ''))?.[1];
      if (found) process.env.PATH = mergePath(found, process.env.PATH.split(':'));
      resolve();
    });
  });
  return ready;
}

const pathReady = () => ready;

module.exports = { MAC, HELPER, available, helper, helperJson, osa, perms, SETTINGS, fixPath, pathReady, mergePath, usualDirs };
