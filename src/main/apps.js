'use strict';

// Closing an app when you ask her to (chat.js), after you've confirmed with a click. The apps in the
// Dock, by name; closing one like Cmd+Q does (it can still ask you to save), and only if you ask
// again, forcing it.

const mac = require('./mac');

// never these: Finder, her (Capri), Claude (she watches it) and Ollama (she talks through it)
const KEEP = new Set(['finder', 'capri', 'electron', 'claude', 'codex', 'ollama']);

// [{ name, process, label, ids }]: one per app in the Dock ("Spotify", "Discord"...), not the
// background helpers
async function list() {
  const rows = await mac.helperJson(['apps']);
  const apps = new Map();
  for (const { pid, name } of rows) {
    if (!name || pid === process.pid || KEEP.has(name.toLowerCase())) continue;
    const app = apps.get(name) || { name, process: name, label: name, ids: [] };
    app.ids.push(pid);
    apps.set(name, app);
  }
  return [...apps.values()];
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The open app that `wanted` names, by its name ("discord", "Apple Music").
async function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const apps = await list();
  const score = (app) => {
    const names = [simple(app.name), simple(app.label)].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = apps.map((app) => [score(app), app]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

// Quits it like Cmd+Q would; `force` ends it outright (unsaved work is lost).
// Resolves with what's left: { running } (true when it stayed open, asking to save something say).
async function close(name, { force = false } = {}) {
  const app = (await list()).find((a) => a.process === name);
  if (!app) return { running: false };
  const left = await mac.helper(['quit', ...(force ? ['--force'] : []), ...app.ids.map(String)], 15000);
  return { running: Number(left) > 0 };
}

module.exports = { list, find, close };
