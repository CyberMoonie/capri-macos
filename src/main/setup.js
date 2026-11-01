'use strict';

// Setting her up with buttons, so nobody has to type in a terminal: Ollama (installed with winget,
// or on a Mac its own app from ollama.com, woken up, a model fetched with its progress), an API key
// pasted in her panel (kept encrypted with your Windows account, or in your Mac's keychain), and
// Claude Code or Codex run through Ollama in a window of their own. Windows and macOS; elsewhere the
// buttons open the right pages instead.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { safeStorage } = require('electron');
const ollama = require('./ollama');
const mac = require('./mac');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
// Ollama's app for Macs, as its site hands it out (signed by its makers, checked before it goes in)
const OLLAMA_MAC = 'https://ollama.com/download/Ollama-darwin.zip';

// The models she offers for her chat, with what they weigh (as Ollama lists them)
const MODELS = [
  { name: 'gemma3:4b', bytes: 3.3e9 }, // better in languages other than English
  { name: 'llama3.2', bytes: 2.0e9 },  // lighter
];

// Where to get a key, by provider (llm.js)
const KEY_PAGES = {
  groq: 'https://console.groq.com/keys',
  gemini: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/keys',
  openai: 'https://platform.openai.com/api-keys',
  mistral: 'https://console.mistral.ai/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
};

async function which(cmd) {
  await mac.pathReady(); // on a Mac, the PATH your shell gives
  return new Promise((resolve) => {
    execFile(WIN ? 'where.exe' : 'which', [cmd], { windowsHide: true, timeout: 5000 }, (err, out) => (
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
  });
}

// Ollama's own app (it runs the server from the tray) and its command, where its installer puts them
function ollamaFiles() {
  if (MAC) {
    const app = [path.join('/Applications', 'Ollama.app'), path.join(os.homedir(), 'Applications', 'Ollama.app')]
      .find((p) => fs.existsSync(p)) || path.join('/Applications', 'Ollama.app');
    return { app, cli: path.join(app, 'Contents', 'Resources', 'ollama') };
  }
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama');
  return { app: path.join(dir, 'ollama app.exe'), cli: path.join(dir, 'ollama.exe') };
}

// { running, installed, models, winget }: how far along Ollama is on this PC. `winget`: she can
// install it herself (with winget on Windows; on a Mac, always).
async function ollamaState() {
  const models = await ollama.models().catch(() => null);
  if (models) return { running: true, installed: true, models, winget: false };
  const [onPath, winget] = await Promise.all([which('ollama'), WIN ? which('winget') : null]);
  const installed = fs.existsSync(ollamaFiles().cli) || (MAC && fs.existsSync(ollamaFiles().app)) || Boolean(onPath);
  return { running: false, installed, models: null, winget: MAC || Boolean(winget) };
}

// On a Mac: Ollama's app from its site, unpacked, checked (signed by its makers, approved by Apple),
// and put in Applications (yours, if you can't write in the shared one).
async function installOllamaMac(onLine) {
  const run = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out))));
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-ollama-'));
  try {
    const res = await fetch(OLLAMA_MAC);
    if (!res.ok) throw new Error(`ollama.com answered ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const zip = path.join(tmp, 'Ollama.zip');
    const out = fs.createWriteStream(zip);
    let got = 0;
    let shown = -1;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const percent = total ? Math.floor((100 * got) / total) : -1;
      if (percent >= 0 && percent !== shown && percent % 5 === 0) onLine?.(`Downloading Ollama… ${percent} %`);
      shown = percent;
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    onLine?.('Unpacking…');
    await run('ditto', ['-x', '-k', zip, tmp]);
    const unpacked = path.join(tmp, 'Ollama.app');
    if (!fs.existsSync(unpacked)) throw new Error('no Ollama.app in the download');
    onLine?.('Checking its signature…');
    await run('codesign', ['--verify', '--deep', '--strict', unpacked]);
    await run('spctl', ['--assess', '--type', 'execute', unpacked]);
    let dir = '/Applications';
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      dir = path.join(os.homedir(), 'Applications');
      fs.mkdirSync(dir, { recursive: true });
    }
    const target = path.join(dir, 'Ollama.app');
    onLine?.(`Installing in ${dir}…`);
    fs.rmSync(target, { recursive: true, force: true });
    await run('ditto', [unpacked, target]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Installs Ollama with winget (Windows' own package manager); onLine(text) for what it prints.
function installOllama(onLine) {
  if (MAC) return installOllamaMac(onLine);
  return new Promise((resolve) => {
    const child = spawn('winget', [
      'install', '--id', 'Ollama.Ollama', '--exact', '--silent',
      '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity',
    ], { windowsHide: true });
    // its progress bars redraw with \r: the last state of each line is enough
    const read = (chunk) => String(chunk).split(/[\r\n]+/).map((l) => l.trim()).filter((l) => /[a-z]{3}/i.test(l)).forEach((l) => onLine?.(l));
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

// Wakes Ollama up (its app, else `ollama serve` in the background) and waits for it to answer.
async function startOllama() {
  const { app, cli } = ollamaFiles();
  const run = (file, args) => spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  await mac.pathReady();
  if (fs.existsSync(app)) run(MAC ? 'open' : app, MAC ? ['-g', '-a', app] : []); // a Mac app: in the background
  else run(fs.existsSync(cli) ? cli : 'ollama', ['serve']);
  for (let i = 0; i < 40; i++) {
    if (await ollama.models().catch(() => null)) return { ok: true };
    await new Promise((r) => setTimeout(r, 750));
  }
  return { ok: false, error: 'Ollama did not answer' };
}

// Fetches a model. Ollama sends its pieces one after the other: onProgress({ completed, total })
// adds them up, so the bar goes once from empty to full. A piece that stalled and starts over is
// reported lower for a while: what it had reached counts, so the bar never goes back.
async function pullModel(name, onProgress, signal) {
  const res = await fetch(`${ollama.base()}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  const pieces = new Map(); // digest -> { completed, total }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.digest && msg.total) {
        const before = pieces.get(msg.digest)?.completed || 0;
        pieces.set(msg.digest, { completed: Math.max(before, msg.completed || 0), total: msg.total });
      }
      let completed = 0;
      let total = 0;
      for (const p of pieces.values()) {
        completed += p.completed;
        total += p.total;
      }
      onProgress?.({ completed, total, status: msg.status });
      if (msg.status === 'success') return;
    }
  }
}

// Claude Code (or Codex) through Ollama, in a window of its own: Ollama fetches what's missing and
// asks which model to use. She sees it like any other session, through her hooks.
// On a Mac: a little script opened in your terminal (Terminal, or the one you picked for .command files).
function launchThroughOllamaMac(integration) {
  const { cli } = ollamaFiles();
  const ollamaCmd = fs.existsSync(cli) ? `'${cli.replace(/'/g, "'\\''")}'` : 'ollama';
  const script = path.join(os.tmpdir(), `capri-ollama-${integration}.command`);
  fs.writeFileSync(script, `#!/bin/zsh -l\ncd ~\n${ollamaCmd} launch ${integration}\nexec "$SHELL" -l\n`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  spawn('open', [script], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  return { ok: true };
}

function launchThroughOllama(integration) {
  if (MAC && ['claude', 'codex'].includes(integration)) return launchThroughOllamaMac(integration);
  if (!WIN || !['claude', 'codex'].includes(integration)) return { ok: false };
  const { cli } = ollamaFiles();
  // `start` opens a new console window (its first quoted argument is the window's title); cmd /k
  // strips the outer quotes of what follows, so a path with spaces in it keeps its own
  const command = `""${fs.existsSync(cli) ? cli : 'ollama'}" launch ${integration}"`;
  spawn('cmd.exe', ['/d', '/c', 'start', '"Capri"', 'cmd.exe', '/k', command], {
    detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
  }).on('error', () => {}).unref();
  return { ok: true };
}

// API keys are kept encrypted in config.json, with your Windows account (DPAPI) or your Mac's
// keychain: "enc:<base64>".
function sealKey(key) {
  return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(key).toString('base64')}` : key;
}

function openKey(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc:')) return stored || '';
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  } catch {
    return '';
  }
}

const openKeys = (apiKeys = {}) => Object.fromEntries(Object.entries(apiKeys).map(([id, v]) => [id, openKey(v)]));

module.exports = {
  MODELS, KEY_PAGES, ollamaState, installOllama, startOllama, pullModel, launchThroughOllama, sealKey, openKeys,
};
