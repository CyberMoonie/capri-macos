'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

const { TRAY } = require('../src/main/labels');
const mac = require('../src/main/mac');

// Load the unchanged browser modules in Node without changing package module type.
function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

// launch.js and files.js ask Electron for a few paths: a stand-in, in plain Node
function withElectron() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-home-'));
  require.cache[require.resolve('electron')] = {
    id: 'electron', filename: 'electron', loaded: true,
    exports: { app: { getPath: (k) => path.join(home, k === 'home' ? '' : k) }, shell: {}, desktopCapturer: {}, screen: {} },
  };
  return home;
}

test('her menu speaks of macOS in every language, with the same items in each', () => {
  const keys = Object.keys(TRAY.en).sort();
  for (const [lang, labels] of Object.entries(TRAY)) {
    assert.deepEqual(Object.keys(labels).sort(), keys, lang);
    const words = Object.values(labels).filter((v) => typeof v === 'string').join('\n');
    assert.doesNotMatch(words, /Windows|\bPC\b|ПК|taskbar|barre des tâches|barra de tareas|barra de tarefas|панел\S* задач/, lang);
    assert.match(labels.restDock, /Dock/, lang);
    assert.match(labels.motionAuto, /macOS/, lang);
  }
});

test('her lines: the Dock, Finder, the keychain, System Settings; nothing of Windows, in every language', async () => {
  const { LINES, linesFor } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/lines.js')));
  const strings = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);
  // two levels deep: below that, plurals differ between languages (an array, or Russian's forms)
  const shape = (value, depth = 0) => (value && typeof value === 'object' && !Array.isArray(value) && depth < 2
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)])) : typeof value);
  // things only Windows has, in the five languages
  const WINDOWS = /Windows|\bPC\b|ПК|Ctrl\+Alt\+C|Start menu|menu Démarrer|menú Inicio|menu Iniciar|«Пуск»|taskbar|barre des tâches|barra de tareas|barra de tarefas|панел\S* задач|winget|Explorer|\^/;
  for (const lang of Object.keys(LINES)) {
    for (const assistant of ['claude', 'codex', 'agy']) {
      const t = linesFor(lang, assistant);
      assert.deepEqual(strings(t).filter((s) => WINDOWS.test(s)), [], `${lang}/${assistant}`);
      const p = t.permission;
      assert.ok(p.screen && p.screenHow && p.access && p.accessHow && p.settings, lang);
      assert.ok(t.chat.folders.finder && t.chat.folders.trash, lang);
      assert.match(t.chat.shot, /\{name\}/, lang);
      assert.match(t.chat.shot, /\{where\}/, lang);
      assert.match(t.pc.usb[0], /\(\{drive\}\)/, lang); // a volume's name
    }
    // every language has the same lines as English
    assert.deepEqual(shape(LINES[lang]), shape(LINES.en), lang);
  }
});

test('an app on your desktop or anything that runs waits for your click', () => {
  const home = withElectron();
  const { risky, match } = require('../src/main/launch');
  for (const file of ['Tool.app', 'run.command', 'setup.sh', 'Installer.pkg', 'Disk.dmg', 'do.scpt', 'Flow.workflow', 'x.tool', 'go.zsh', 'app.jar']) {
    assert.equal(risky({ kind: 'file', id: path.join(home, 'Desktop', file) }), true, file);
  }
  for (const file of ['notes.txt', 'photo.png', 'Report.pages', 'cv.pdf']) {
    assert.equal(risky({ kind: 'file', id: path.join(home, 'Desktop', file) }), false, file);
  }
  assert.equal(risky({ kind: 'app', id: '/Applications/Spotify.app' }), false); // from Applications, named by you
  const items = [{ name: 'Spotify', kind: 'app', id: '/Applications/Spotify.app' }, { name: 'Visual Studio Code', kind: 'app', id: '/Applications/Visual Studio Code.app' }];
  assert.equal(match(items, 'open spotify please')?.id, '/Applications/Spotify.app');
  assert.equal(match(items, 'launch visual studio code')?.name, 'Visual Studio Code');
  assert.equal(match(items, 'open photoshop'), null);
});

test('the PATH an app started from Finder gets is completed, in order, without duplicates', () => {
  assert.equal(mac.mergePath('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/bin', '']), '/usr/bin:/bin:/opt/homebrew/bin');
  const dirs = mac.usualDirs('/Users/me');
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/Users/me/.local/bin', '/Users/me/.claude/local']) assert.ok(dirs.includes(dir), dir);
});

const onMac = process.platform === 'darwin' && fs.existsSync(mac.HELPER);

test('the Mac helper: one snapshot of your windows, in the shape the overlay reads, and it stops with her', { skip: !onMac && 'macOS with the helper built' }, async () => {
  const child = spawn(mac.HELPER, ['watch', '0', String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const [chunk] = await once(child.stdout, 'data');
  const snap = JSON.parse(String(chunk).split('\n')[0]);
  for (const key of ['fg', 'pid', 'app', 'ai', 'game', 'usb', 'plug', 'dock', 'space', 'overview', 'titles', 'here', 'wins']) assert.ok(key in snap, key);
  assert.equal(snap.space, 0); // no desktop switch yet
  assert.equal(typeof snap.overview, 'boolean');
  assert.equal(typeof snap.fg, 'number');
  assert.ok(Array.isArray(snap.ai) && Array.isArray(snap.usb) && Array.isArray(snap.wins));
  for (const w of snap.wins) {
    for (const key of ['id', 'x', 'y', 'w', 'h']) assert.equal(typeof w[key], 'number', key);
    assert.equal(typeof w.max, 'boolean');
    assert.ok(w.w >= 200 && w.h >= 120);
  }
  // her input closed (she quit, or crashed): it's gone
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('the Mac helper: apps, permissions, and media keys that say what they need', { skip: !onMac && 'macOS with the helper built' }, () => {
  const run = (...args) => JSON.parse(execFileSync(mac.HELPER, args, { encoding: 'utf8' }));
  const perms = run('perms');
  assert.equal(typeof perms.screen, 'boolean');
  assert.equal(typeof perms.accessibility, 'boolean');
  const apps = run('apps');
  assert.ok(Array.isArray(apps) && apps.every((a) => Number.isInteger(a.pid) && typeof a.name === 'string'));
  assert.ok(!apps.some((a) => a.pid === process.pid));
  const installed = run('installed');
  assert.ok(installed.length > 0 && installed.every((a) => a.path.endsWith('.app')));
  assert.deepEqual(run('media', 'nonsense'), { ok: false });
  if (!perms.accessibility) assert.deepEqual(run('media', 'play'), { ok: false, need: 'accessibility' });
  // nothing to close: nothing left
  assert.equal(execFileSync(mac.HELPER, ['quit', '999999'], { encoding: 'utf8' }).trim(), '0');
});

test('another AI spotted in the title of the window in front, whatever the browser adds to it', () => {
  withElectron();
  const { aisIn } = require('../src/main/windows');
  assert.deepEqual(aisIn('ChatGPT'), ['chatgpt']);
  assert.deepEqual(aisIn('ChatGPT — Safari'), ['chatgpt']);
  assert.deepEqual(aisIn('Gemini - Google Chrome'), ['gemini']);
  assert.deepEqual(aisIn('character.ai | Chat'), ['characterai']);
  assert.deepEqual(aisIn('Le Chat - Mistral AI'), ['lechat']);
  assert.deepEqual(aisIn('Inbox (3) - Gmail'), []);
  assert.deepEqual(aisIn(''), []);
  assert.deepEqual(aisIn(undefined), []);
});

test('her chat: pause and play said plainly, her picks, "from spotify", and "play it"', async (t) => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  t.after(() => { delete globalThis.matchMedia; });
  const { Chat } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  const chat = new Chat({ capri: {}, panel: {}, voice: {}, host: { onChatDelta() {} }, brain: {} });
  const asked = (text) => chat.asked(text);
  for (const text of ['pause', 'pause the music', 'stop the music']) assert.deepEqual(asked(text), { kind: 'media', action: 'pause' }, text);
  for (const text of ['play', 'play.', 'play the music', 'play music', 'play spotify', 'resume', 'unpause']) {
    assert.deepEqual(asked(text), { kind: 'media', action: 'play' }, text);
  }
  // she picks: her AI answers with a song (no action read off your message)
  for (const text of ['play something of your choice', 'play any song', 'play any song from spotify', 'play whatever you want', 'play something random']) {
    assert.equal(asked(text), null, text);
  }
  assert.deepEqual(asked('play bohemian rhapsody from spotify'), { kind: 'music', song: 'bohemian rhapsody' });
  assert.deepEqual(asked('play daft punk on spotify'), { kind: 'music', song: 'daft punk' });
  // "play it": nothing named yet, then the song she just named
  assert.equal(asked('play it'), null); // nothing named yet: she's asked which
  assert.equal(asked('yeah play that'), null);
  chat.suggested = 'Queen - Bohemian Rhapsody';
  assert.deepEqual(asked('play it'), { kind: 'play', song: 'Queen - Bohemian Rhapsody' });
  assert.deepEqual(asked('yes, play that one'), { kind: 'play', song: 'Queen - Bohemian Rhapsody' });
  assert.deepEqual(asked('play it on spotify'), { kind: 'music', song: 'Queen - Bohemian Rhapsody' });
  assert.deepEqual(asked('put it on youtube'), { kind: 'youtube', song: 'Queen - Bohemian Rhapsody' });
  assert.deepEqual(asked('play that on spotifu'), { kind: 'music', song: 'Queen - Bohemian Rhapsody' });
  assert.deepEqual(asked('play daft punk on spotfy'), { kind: 'music', song: 'daft punk' });
});

test('a song she names in her answer without her tag is still found', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { songIn } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  delete globalThis.matchMedia;
  assert.equal(songIn('How about “Bohemian Rhapsody” by Queen, choom?'), 'Queen - Bohemian Rhapsody');
  assert.equal(songIn('Try "Midnight City" by M83. Preem.'), 'M83 - Midnight City');
  assert.equal(songIn('Écoute « Get Lucky » de Daft Punk'), 'Daft Punk - Get Lucky');
  assert.equal(songIn('Put on "Blinding Lights", you will thank me'), 'Blinding Lights');
  assert.equal(songIn('No song for you today.'), null);
});

test('another AI spotted by the address of the tab in front, whatever the conversation is called', () => {
  withElectron();
  const { aisAt } = require('../src/main/windows');
  assert.deepEqual(aisAt('https://chatgpt.com/c/6721f0a2-mac-port'), ['chatgpt']);
  assert.deepEqual(aisAt('https://chat.openai.com/'), ['chatgpt']);
  assert.deepEqual(aisAt('https://claude.ai/chat/123'), ['claude']);
  assert.deepEqual(aisAt('https://gemini.google.com/app'), ['gemini']);
  assert.deepEqual(aisAt('https://www.perplexity.ai/search?q=x'), ['perplexity']);
  assert.deepEqual(aisAt('https://x.com/i/grok'), ['grok']);
  assert.deepEqual(aisAt('https://x.com/home'), []);
  assert.deepEqual(aisAt('https://www.google.com/search?q=chatgpt.com'), []); // only where you are, not what's in the address
  assert.deepEqual(aisAt('https://notchatgpt.com.example.org/'), []);
  assert.deepEqual(aisAt(null), []);
  assert.deepEqual(aisAt('not a url'), []);
});
