'use strict';

// Opening things when you ask her to (chat.js): an app from Applications, a Steam or Epic game,
// something on your desktop, a folder, your music (Spotify and Apple Music told directly, else the
// media keys), a song on Spotify or YouTube, a Roblox game, or a website.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, shell } = require('electron');
const mac = require('./mac');

// not things to open from a chat: uninstallers, help pages and the like
const SKIP = /uninstall|désinstaller|desinstalar|deinstall|readme|documentation|release notes|support center|website|manual/i;
const STEAM_SKIP = /redistributable|dedicated server|steamworks/i;
// words that don't tell apps apart ("Roblox Player" is "roblox", "AM Music" is "am")
const FILLER = new Set(['player', 'launcher', 'app', 'the', 'for', 'desktop', 'client', 'beta', 'music', 'musique', 'media', 'audio', 'video', 'videos']);
const CACHE_MS = 10 * 60 * 1000; // installed apps hardly change

let cache = null; // { at, items }

const plain = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const words = (text) => plain(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);

// Everything she can open: [{ name, kind: 'app' | 'steam' | 'epic', id }]
async function launchables() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const items = [];
  const seen = new Set();
  const add = (item) => {
    const key = words(item.name).join(' ');
    if (!key || seen.has(key) || SKIP.test(item.name)) return;
    seen.add(key);
    items.push(item);
  };
  // games first: a game's own entry wins over a shortcut to it
  for (const game of [...steamGames(steamRoot()), ...epicGames()]) add(game);
  // the apps in Applications, by the name Finder shows (in your language) and by their file's
  const apps = await mac.helperJson(['installed']).catch(() => null);
  for (const { name, file, path: id } of apps || []) {
    add({ name, kind: 'app', id });
    if (file && file !== name) add({ name: file, kind: 'app', id });
  }
  if (apps) cache = { at: Date.now(), items }; // a list that failed isn't kept: next time, again
  return items;
}

function steamRoot() {
  const root = path.join(app.getPath('home'), 'Library', 'Application Support', 'Steam');
  return fs.existsSync(root) ? root : null;
}

// Steam's games, from the manifests in each of its libraries
function steamGames(root) {
  if (!root) return [];
  const libraries = new Set([root]);
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(path.normalize(m[1]));
  } catch {
    // one library, the main one
  }
  const games = [];
  for (const library of libraries) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(library, 'steamapps')).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const acf = fs.readFileSync(path.join(library, 'steamapps', file), 'utf8');
        const id = /"appid"\s+"(\d+)"/.exec(acf)?.[1];
        const name = /"name"\s+"([^"]+)"/.exec(acf)?.[1];
        if (id && name && !STEAM_SKIP.test(name)) games.push({ name, kind: 'steam', id });
      } catch {
        // a manifest being written: skip it
      }
    }
  }
  return games;
}

// Epic's games, from its launcher's manifests (not the Unreal Engine plugins it also keeps there)
function epicGames() {
  const dir = path.join(app.getPath('home'), 'Library', 'Application Support', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.item'));
  } catch {
    return [];
  }
  const games = [];
  for (const file of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (m.bIsIncompleteInstall || m.CatalogNamespace === 'ue' || !m.DisplayName || !m.AppName) continue;
      games.push({ name: m.DisplayName, kind: 'epic', id: `${m.CatalogNamespace}:${m.CatalogItemId}:${m.AppName}` });
    } catch {
      // not one of its manifests
    }
  }
  return games;
}

// The one of `items` named in `text` (your message, or the name in her tag): all the words of its
// name in it, else at least half of them; the closest wins. null if nothing fits well enough.
function match(items, text) {
  const said = new Set(words(text));
  const joined = words(text).join('');
  let best = null;
  for (const item of items) {
    const all = words(item.name);
    const key = all.filter((w) => !FILLER.has(w));
    if (!key.length) key.push(...all); // a name made only of those ("Media Player"): all of it
    if (!key.length) continue;
    const hits = key.filter((w) => said.has(w) || (w.length >= 5 && joined.includes(w)));
    // a word of 3 letters or more, or all of a short name ("am" for AM Music)
    if (!(hits.some((w) => w.length >= 3) || hits.length === key.length) || hits.length / key.length < 0.5) continue;
    const rank = (hits.length / key.length) * 10 + hits.join('').length / 10;
    if (!best || rank > best.rank) best = { item, rank };
  }
  return best?.item || null;
}

// What's on your desktop: files, folders and aliases, by name. An app (.app) is a folder, but opening
// it runs it: it counts as a file, behind a button.
function desktopItems() {
  const dir = app.getPath('desktop');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => !e.name.startsWith('.')).map((e) => {
    const folder = e.isDirectory() && !APP_BUNDLE.test(e.name);
    return { name: folder ? e.name : e.name.replace(/\.[^.]+$/, ''), kind: folder ? 'folder' : 'file', id: path.join(dir, e.name) };
  });
}

// files that run something: never opened without a click, even named by you
const RUNS = /\.(app|command|tool|sh|zsh|bash|csh|pkg|mpkg|dmg|scpt|scptd|applescript|workflow|terminal|action|prefpane|saver|osax|kext|jar)$/i;
const APP_BUNDLE = /\.app$/i;
const risky = (item) => item?.kind === 'file' && RUNS.test(item.id);

// Folders asked for by what they are ("ouvre mes téléchargements", "open finder").
const FOLDERS = [
  ['finder', /\bfinder\b|explorateur|file explorer|explorador|проводник/i],
  ['trash', /corbeille|recycle bin|\btrash\b|papelera|lixeira|lixo|корзин/i],
  ['downloads', /t[ée]l[ée]chargements?|downloads?|descargas|transfer[êe]ncias|загрузк/i],
  ['desktop', /\bbureau\b|\bdesktop\b|escritorio|[áa]rea de trabalho|рабоч\S* стол/i],
  ['documents', /\bdocuments?\b|documentos|документ/i],
  ['pictures', /\bimages\b|\bphotos\b|\bpictures\b|im[áa]genes|\bfotos\b|imagens|изображени|фото/i],
  ['music', /dossier (de )?musique|music folder|carpeta de m[úu]sica|pasta de m[úu]sica|папк\S* (с )?музык/i],
  ['videos', /\bvid[ée]os\b|v[íi]deos|видео/i],
];

function knownFolder(text) {
  const hit = FOLDERS.find(([, re]) => re.test(text));
  return hit ? { name: hit[0], kind: 'known', id: hit[0] } : null;
}

// A Finder window on your home folder, the Trash, or the folder itself.
function openKnown(id) {
  if (id === 'finder') return shell.openPath(app.getPath('home'));
  if (id === 'trash') return shell.openPath(path.join(app.getPath('home'), '.Trash'));
  return shell.openPath(app.getPath(id));
}

// What you asked to open: an app or a game, something on your desktop, else a folder by what it is.
async function find(text) {
  return match([...desktopItems(), ...(await launchables())], text) || knownFolder(text);
}

// Opens one of them (only something she listed herself): an app from its folder in Applications, a
// game through its launcher's link, a file or folder from your desktop, a folder by what it is.
async function launch({ kind, id } = {}) {
  if (kind === 'known') {
    if (!FOLDERS.some(([key]) => key === id)) throw new Error('not found');
    await openKnown(id);
    return undefined;
  }
  if (kind === 'file' || kind === 'folder') {
    if (!desktopItems().some((i) => i.id === id)) throw new Error('not found');
    const err = await shell.openPath(id);
    if (err) throw new Error(err);
    return undefined;
  }
  const item = (await launchables()).find((i) => i.kind === kind && i.id === id);
  if (!item) throw new Error('not found');
  if (kind === 'steam') return shell.openExternal(`steam://rungameid/${id}`);
  if (kind === 'epic') return shell.openExternal(`com.epicgames.launcher://apps/${encodeURIComponent(id)}?action=launch&silent=true`);
  const err = await shell.openPath(id); // the app's own folder in Applications
  if (err) throw new Error(err);
  return undefined;
}

// The media keys, as if pressed on the keyboard (the helper): whatever plays music (a browser…)
// reacts. They need Privacy & Security › Accessibility: until you allow her, the volume still moves
// (the way the Sound menu does it), and the rest says what it needs: { need: 'accessibility' }.
const MEDIA = new Set(['pause', 'play', 'next', 'previous', 'volup', 'voldown', 'mute']);
const VOLUME = {
  volup: 'set volume output volume ((output volume of (get volume settings)) + 10)',
  voldown: 'set volume output volume ((output volume of (get volume settings)) - 10)',
  mute: 'set volume output muted (not (output muted of (get volume settings)))',
};

// Spotify and Apple Music, told directly (AppleScript): no Accessibility needed (macOS asks you once
// whether Capri may control each), and she knows whether it's playing. The one playing, else the one
// open. { name, bundle, state: 'playing' | 'paused' | 'stopped' } or null.
const PLAYERS = [['Spotify', 'com.spotify.client'], ['Music', 'com.apple.Music']];
const { osa } = mac;
const SAYS = { pause: 'pause', play: 'play', next: 'next track', previous: 'previous track' };

async function macPlayer() {
  const open = (await mac.helperJson(['apps']).catch(() => [])).map((a) => a.bundle);
  const found = [];
  for (const [name, bundle] of PLAYERS) {
    if (!open.includes(bundle)) continue;
    const state = await osa(`tell application id "${bundle}" to player state as text`);
    if (state) found.push({ name, bundle, state });
  }
  return found.find((p) => p.state === 'playing') || found[0] || null;
}

// Nothing open to play: Spotify if it's installed (it picks up where you left it), else Apple Music.
async function anyPlayer() {
  const spotify = (await launchables()).some((i) => i.kind === 'app' && /\/Spotify\.app$/i.test(i.id));
  return spotify ? PLAYERS[0] : PLAYERS[1];
}

async function media(action) {
  if (!MEDIA.has(action)) return false;
  if (SAYS[action]) {
    const player = await macPlayer();
    if (player) {
      // said twice: "pause" doesn't start it again, and "play" doesn't stop it
      if (action === 'pause' && player.state !== 'playing') return { already: 'paused' };
      if (action === 'play' && player.state === 'playing') return { already: 'playing' };
      if ((await osa(`tell application id "${player.bundle}" to ${SAYS[action]}`)) !== null) return true;
    } else if (action === 'play') {
      const [, bundle] = await anyPlayer();
      if ((await osa(`tell application id "${bundle}" to play`)) !== null) return true;
    }
  }
  const res = await mac.helperJson(['media', action]).catch(() => ({ ok: false }));
  if (res.ok || res.need !== 'accessibility') return Boolean(res.ok);
  if (!VOLUME[action]) return { need: 'accessibility' };
  return (await osa(VOLUME[action], 5000)) !== null;
}

// A song on Spotify by its name, played right away: its track found with a web search (no
// Spotify account needed; DuckDuckGo, else Brave if that one says no), checked by its title, then
// played by the Spotify app. { title } or null.
const TRACK_SEARCH = [
  (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${q} spotify track`)}`,
  (q) => `https://search.brave.com/search?q=${encodeURIComponent(`${q} spotify track`)}`,
];

async function trackIds(q) {
  for (const url of TRACK_SEARCH) {
    try {
      const res = await fetch(url(q), { headers: { 'user-agent': UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const ids = [...new Set([...(await res.text()).matchAll(/open\.spotify\.com(?:\/|%2F)(?:intl-[a-z]+(?:\/|%2F))?track(?:\/|%2F)([A-Za-z0-9]{22})/g)].map((m) => m[1]))];
      if (ids.length) return ids.slice(0, 5);
    } catch {
      // that one's down or slow: the next
    }
  }
  return [];
}

async function spotifyTrack(q) {
  try {
    const ids = await trackIds(q);
    const wanted = words(q);
    let best = null;
    for (const id of ids) {
      const info = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${id}`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json()).catch(() => null);
      if (!info?.title) continue;
      const hits = words(info.title).filter((w) => wanted.includes(w)).length;
      if (!best || hits > best.hits) best = { id, title: info.title, hits };
    }
    if (!best?.hits) {
      console.error('[capri] spotify: no track found for', JSON.stringify(q));
      return null;
    }
    if ((await osa(`tell application id "com.spotify.client" to play track "spotify:track:${best.id}"`)) === null) {
      console.error('[capri] spotify: the Spotify app would not play it (is Capri allowed to control Spotify?)');
      return null;
    }
    return { title: best.title };
  } catch {
    return null;
  }
}

async function music(query) {
  // as her AI writes it ('Blade Runner 2049 - "Common Ground" by Hans Zimmer'): plain words to search
  const q = String(query || '').replace(/["“”«»]/g, ' ').replace(/\s+by\s+/i, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return false;
  // played right away when Spotify's installed, else a search for it (in the app, else on the web)
  if ((await anyPlayer())[0] === 'Spotify') {
    const played = await spotifyTrack(q);
    if (played) return played;
  }
  try {
    await shell.openExternal(`spotify:search:${encodeURIComponent(q)}`);
  } catch {
    await shell.openExternal(`https://open.spotify.com/search/${encodeURIComponent(q)}`);
  }
  return true;
}

// A song on YouTube, the exact video: the first result of a search (no key needed), opened in your
// browser. { title } of what it found, or { title: null } when it could only open the search.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const VIDEO = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/;

async function youtube(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return null;
  const search = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  let video = null;
  try {
    const res = await fetch(search, {
      // the consent cookie skips Europe's cookie page, which would hide the results
      headers: { 'user-agent': UA, 'accept-language': 'en', cookie: 'CONSENT=YES+1; SOCS=CAI' },
      signal: AbortSignal.timeout(8000),
    });
    const m = VIDEO.exec(await res.text());
    if (m) video = { id: m[1], title: JSON.parse(`"${m[2]}"`) };
  } catch {
    // offline or YouTube changed its page: the search still opens
  }
  await shell.openExternal(video ? `https://www.youtube.com/watch?v=${video.id}` : search);
  return { title: video?.title || null };
}

// A Roblox game by its name ("steal a brain rot"): the first one Roblox's own search gives, started
// straight in the Roblox app through its roblox:// link, or its page in the browser without the app.
// { name, app } of what it started, { name: null } if Roblox found nothing.
async function roblox(query) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return null;
  let game = null;
  try {
    const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&pageType=all&sessionId=${randomUUID()}`;
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    game = (body.searchResults || []).filter((r) => r.contentGroupType === 'Game').flatMap((r) => r.contents || [])[0] || null;
  } catch {
    return null;
  }
  if (!game?.rootPlaceId) return { name: null };
  const installed = Boolean(app.getApplicationNameForProtocol('roblox://'));
  await shell.openExternal(installed ? `roblox://experiences/start?placeId=${game.rootPlaceId}` : `https://www.roblox.com/games/${game.rootPlaceId}`);
  // "[💀] Steal a Brainrot" is "Steal a Brainrot"
  const name = String(game.name).replace(/\[[^\]]*\]\s*/g, '').replace(/[\p{Extended_Pictographic}️]/gu, '').trim();
  return { name: name || game.name, app: installed };
}

// A website: http or https, with a real host name.
function siteUrl(address) {
  try {
    const url = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') ? url : null;
  } catch {
    return null;
  }
}

async function site(address) {
  const url = siteUrl(String(address || '').trim());
  if (!url) return false;
  await shell.openExternal(url.toString());
  return true;
}

module.exports = { launchables, match, find, launch, media, music, youtube, roblox, site, siteUrl, risky };
