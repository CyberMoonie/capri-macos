'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them. On Windows a
// small PowerShell helper does the Win32 calls, and we turn its physical pixels into the overlay's
// coordinates; on macOS her native helper (mac/capri-helper.swift) already speaks in points. It also says when the window in front is another AI (ChatGPT,
// Gemini…: `ai`, the names it matched), for her jealousy, and never passes on a title; which game
// is in front, if one (`game`, its folder in Steam's library or another launcher's); and the USB
// sticks plugged in (`usb`: drive letters, or names in /Volumes on a Mac), and the last device
// plugged in or out (`plug`).

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { screen } = require('electron');
const mac = require('./mac');

// in the installed app it sits next to the app archive (asarUnpack), where PowerShell can read it
const SCRIPT = path.join(__dirname, 'windows.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const WIN = process.platform === 'win32';

// The helper for this system and how to start it, or null when there's none.
function helperCommand(overlay) {
  if (WIN) {
    const handle = overlay.getNativeWindowHandle();
    const self = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, String(self), String(process.pid)],
      stdin: 'ignore',
    };
  }
  if (!mac.available()) return null;
  // her window's number on screen ("window:1234:0"), so it isn't one of the windows she sits on
  const self = /^window:(\d+)/.exec(overlay.getMediaSourceId())?.[1] || '0';
  // stdin stays open: the helper stops when it closes, even if she crashed
  return { file: mac.HELPER, args: ['watch', self, String(process.pid)], stdin: 'pipe' };
}

function startWindowWatch({ overlay, onUpdate }) {
  const command = helperCommand(overlay);
  if (!command) return { stop() {}, refresh() {} };

  let child = null;
  let stopped = false;
  let restarts = 0;
  let last = null; // the helper's last snapshot: it only speaks when something changes

  const toOverlay = (win, bounds) => {
    const dip = WIN ? screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h })
      : { x: win.x, y: win.y, width: win.w, height: win.h };
    return { id: win.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: win.max };
  };

  // the snapshot as seen from her window, wherever it is now
  const send = () => {
    if (!last || overlay.isDestroyed()) return;
    const bounds = overlay.getBounds();
    // only what overlaps Capri's screen
    const here = (w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0;
    const wins = last.wins.map((w) => toOverlay(w, bounds)).filter(here);
    // the Mac's Dock, while it's shown at the bottom of her screen
    const dock = last.dock && toOverlay({ ...last.dock, id: 'dock' }, bounds);
    onUpdate({
      fg: last.fg, taskbar: Boolean(last.taskbar), ai: Array.isArray(last.ai) ? last.ai : [],
      game: last.game || null, usb: Array.isArray(last.usb) ? last.usb : [], plug: last.plug || null,
      dock: dock && here(dock) ? dock : null, space: last.space ?? 0, here: last.here !== false, pid: last.pid || 0,
      titles: last.titles !== false, app: last.app || '', wins,
    });
  };

  const start = () => {
    child = spawn(command.file, command.args, { windowsHide: true, stdio: [command.stdin, 'pipe', 'pipe'] });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        last = JSON.parse(line);
      } catch {
        return;
      }
      send();
    });
    child.stderr.on('data', (d) => console.error('[capri] window watch:', String(d).trim()));
    child.on('error', (err) => console.error('[capri] window watch:', err.message));
    child.on('exit', () => {
      child = null;
      if (!stopped && restarts++ < 3) setTimeout(start, 3000);
    });
  };

  start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
    // her window moved (another screen, the taskbar in it or not): the same windows, from there
    refresh: send,
  };
}

// Other AIs, by what gives them away in a window's title (the same list as the helpers').
const AI_TITLES = [
  ['chatgpt', /\bChatGPT\b/i], ['claude', /\bClaude\b/i], ['codex', /\bCodex\b/i], ['gemini', /\bGemini\b/i],
  ['copilot', /\bCopilot\b/i], ['perplexity', /\bPerplexity\b/i], ['deepseek', /\bDeepSeek\b/i], ['grok', /\bGrok\b/i],
  ['lechat', /\bLe Chat\b|\bMistral AI\b/i], ['characterai', /character\.ai/i], ['metaai', /\bMeta AI\b/i],
];
const aisIn = (title) => AI_TITLES.filter(([, re]) => re.test(title || '')).map(([key]) => key);

// …and by their sites: a browser's title is often just your conversation's name.
const AI_SITES = [
  ['chatgpt', /^(chatgpt\.com|chat\.openai\.com)$/], ['claude', /^claude\.ai$/], ['gemini', /^(gemini|aistudio)\.google\.com$/],
  ['copilot', /^copilot\.(microsoft\.com|cloud\.microsoft)$/], ['perplexity', /^perplexity\.ai$/], ['deepseek', /^chat\.deepseek\.com$/],
  ['grok', /^grok\.com$|^x\.com\/i\/grok/], ['lechat', /^chat\.mistral\.ai$/], ['characterai', /^character\.ai$/], ['metaai', /^meta\.ai$/],
];
function aisAt(address) {
  let where = '';
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol)) return [];
    where = url.hostname.replace(/^www\./, '') + url.pathname;
  } catch {
    return [];
  }
  const host = where.split('/')[0];
  return AI_SITES.filter(([, re]) => re.test(host) || re.test(where)).map(([key]) => key);
}

module.exports = { startWindowWatch, aisIn, aisAt };
