'use strict';

// Setting her up with buttons, so nobody has to type in a terminal: Ollama (its app from ollama.com,
// woken up, a model fetched with its progress), an API key pasted in her panel (kept in your Mac's
// keychain), and Claude Code or Codex run through Ollama in a Terminal window of their own.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { safeStorage } = require('electron');
const ollama = require('./ollama');
const mac = require('./mac');

// Ollama's app, as its site hands it out (signed by its makers, checked before it goes in)
const OLLAMA_ZIP = 'https://ollama.com/download/Ollama-darwin.zip';

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
  await mac.pathReady(); // the PATH your shell gives
  return new Promise((resolve) => {
    execFile('which', [cmd], { timeout: 5000 }, (err, out) => (
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
  });
}

// Ollama's own app (it runs the server from the menu bar) and its command, in Applications
function ollamaFiles() {
  const app = [path.join('/Applications', 'Ollama.app'), path.join(os.homedir(), 'Applications', 'Ollama.app')]
    .find((p) => fs.existsSync(p)) || path.join('/Applications', 'Ollama.app');
  return { app, cli: path.join(app, 'Contents', 'Resources', 'ollama') };
}

// { running, installed, models }: how far along Ollama is on this Mac
async function ollamaState() {
  const models = await ollama.models().catch(() => null);
  if (models) return { running: true, installed: true, models };
  const installed = fs.existsSync(ollamaFiles().app) || Boolean(await which('ollama'));
  return { running: false, installed, models: null };
}

// Installs Ollama: its app from its site, unpacked, checked (signed by its makers, approved by Apple),
// and put in Applications (yours, if you can't write in the shared one). onLine(text): how it goes.
async function installOllama(onLine) {
  const run = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out))));
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-ollama-'));
  try {
    const res = await fetch(OLLAMA_ZIP);
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


// Wakes Ollama up (its app, else `ollama serve` in the background) and waits for it to answer.
async function startOllama() {
  const { app, cli } = ollamaFiles();
  const run = (file, args) => spawn(file, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  await mac.pathReady();
  if (fs.existsSync(app)) run('open', ['-g', '-a', app]); // in the background: no window to show
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
// asks which model to use. She sees it like any other session, through her hooks. A little script,
// opened in your terminal (Terminal, or the one you picked for .command files).
function launchThroughOllama(integration) {
  if (!['claude', 'codex'].includes(integration)) return { ok: false };
  const { cli } = ollamaFiles();
  const ollamaCmd = fs.existsSync(cli) ? `'${cli.replace(/'/g, "'\\''")}'` : 'ollama';
  const script = path.join(os.tmpdir(), `capri-ollama-${integration}.command`);
  fs.writeFileSync(script, `#!/bin/zsh -l\ncd ~\n${ollamaCmd} launch ${integration}\nexec "$SHELL" -l\n`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  spawn('open', [script], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  return { ok: true };
}

// API keys are kept encrypted in config.json, with a key from your Mac's keychain: "enc:<base64>".
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
