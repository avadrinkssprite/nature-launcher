const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { AdmZip } = require('./lib/deps');
const { Auth } = require('./lib/deps');
const createCore = require('./mc');
const createRpc = require('./discord');

// pinned so the packaged exe (named "Nature Launcher") keeps using the same data folder
app.setPath('userData', path.join(app.getPath('appData'), 'nature-launcher'));
const DATA = app.getPath('userData');
const SHARED = path.join(DATA, 'shared'); // versions/libraries/assets/java shared by all instances
const INST = path.join(DATA, 'instances');
const CFG = path.join(DATA, 'config.json');
const KINDS = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' };
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const MR_LOADERS = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge'] }; // Quilt also runs Fabric mods
const UA = { 'User-Agent': 'nature-launcher/0.2.0' };
const core = createCore(SHARED);
const running = new Map();
let win;

async function getJSON(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const cfg = () => ({ javaPath: '', memory: 4, accounts: [], selected: null, discordRpc: true, ...readJSON(CFG, {}) });
const enc = s => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : 'plain:' + s;
const dec = s => s.startsWith('plain:') ? s.slice(6) : safeStorage.decryptString(Buffer.from(s, 'base64'));
const send = (ch, ...a) => win?.webContents.send(ch, ...a);

// path.basename on every renderer-supplied name keeps writes inside the instance folder
function instDir(id) {
  const d = path.join(INST, path.basename(String(id)));
  if (!fs.existsSync(path.join(d, 'instance.json'))) throw new Error('Instance not found');
  return d;
}
const readInst = id => readJSON(path.join(instDir(id), 'instance.json'));
const saveInst = (id, o) => writeJSON(path.join(instDir(id), 'instance.json'), o);
function kindDir(id, kind) {
  if (!KINDS[kind]) throw new Error('Bad content type');
  const d = path.join(instDir(id), kind);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

// ---------- versions & instances ----------
h('versions', async () => {
  const [m, loaders] = await Promise.all([core.manifest(), core.loaderGames()]);
  return { versions: m.versions.map(v => ({ id: v.id, type: v.type })), loaders };
});

h('instances', () => {
  fs.mkdirSync(INST, { recursive: true });
  return fs.readdirSync(INST)
    .map(id => ({ id, ...readJSON(path.join(INST, id, 'instance.json'), null), running: running.has(id) }))
    .filter(i => i.name)
    .sort((a, b) => (b.lastPlayed || b.created) - (a.lastPlayed || a.created));
});

async function createInstance({ name, version, type, loader, wanted, customId, extra }) {
  name = String(name || '').trim();
  if (!name || !version) throw new Error('Name and version required');
  if (!LOADERS.includes(loader) && loader !== 'custom') throw new Error('Unknown loader');
  const inst = { name, version, type: type || 'release', loader, created: Date.now(), modrinth: {}, ...extra };
  if (MR_LOADERS[loader]) inst.loaderVersion = await core.loaderVersion(loader, version, wanted);
  if (customId) inst.customId = customId;
  const base = name.replace(/[^\w\- ]/g, '').trim() || 'instance';
  let id = base;
  for (let n = 2; fs.existsSync(path.join(INST, id)); n++) id = `${base}-${n}`;
  for (const k of Object.keys(KINDS)) fs.mkdirSync(path.join(INST, id, k), { recursive: true });
  writeJSON(path.join(INST, id, 'instance.json'), inst);
  return id;
}
h('instance:create', ({ name, version, type, loader }) => createInstance({ name, version, type, loader }));

h('instance:custom', ({ name, json, jar }) => {
  const j = readJSON(json, null);
  if (!j?.id || !(j.mainClass || j.inheritsFrom)) throw new Error('Not a Minecraft version json (needs "id" and "mainClass" or "inheritsFrom")');
  if (!jar && !j.inheritsFrom && !j.jar && !j.downloads?.client) throw new Error('This version has no parent or download link, so add its .jar too');
  const cid = path.basename(j.id);
  fs.mkdirSync(core.vdir(cid), { recursive: true });
  fs.copyFileSync(json, core.vjson(cid));
  if (jar) fs.copyFileSync(jar, path.join(core.vdir(cid), cid + '.jar'));
  return createInstance({ name: name || cid, version: j.inheritsFrom || j.id, loader: 'custom', customId: cid });
});

// .mrpack: modrinth.index.json lists files to download, overrides/ is copied as-is
async function importMrpack(buf, name) {
  const zip = new AdmZip(buf);
  const idx = JSON.parse(zip.readAsText('modrinth.index.json') || 'null');
  if (!idx?.dependencies?.minecraft) throw new Error('Not a Modrinth modpack (.mrpack)');
  const dep = idx.dependencies;
  const loader = dep.neoforge ? 'neoforge' : dep.forge ? 'forge' : dep['quilt-loader'] ? 'quilt' : dep['fabric-loader'] ? 'fabric' : 'vanilla';
  const wanted = dep.neoforge || dep.forge || dep['quilt-loader'] || dep['fabric-loader'];
  const id = await createInstance({ name: name || idx.name, version: dep.minecraft, loader, wanted, extra: { modpack: { name: idx.name, version: idx.versionId } } });
  const dir = instDir(id);
  try {
    // pack contents are untrusted: refuse any path that escapes the instance folder
    const inside = p => {
      const d = path.resolve(dir, p);
      if (!d.startsWith(dir + path.sep)) throw new Error(`Unsafe path in modpack: ${p}`);
      return d;
    };
    const files = (idx.files || []).filter(f => f.env?.client !== 'unsupported');
    let done = 0;
    await core.pool(files, 8, async f => {
      await core.download(f.downloads.filter(u => /^https:\/\//.test(u)), inside(f.path), f.hashes.sha1);
      send('progress', id, { label: 'Modpack files', done: ++done, total: files.length });
    });
    for (const prefix of ['overrides/', 'client-overrides/'])
      for (const e of zip.getEntries())
        if (!e.isDirectory && e.entryName.startsWith(prefix) && e.entryName.length > prefix.length) {
          const d = inside(e.entryName.slice(prefix.length));
          fs.mkdirSync(path.dirname(d), { recursive: true });
          fs.writeFileSync(d, e.getData());
        }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return id;
}
h('instance:mrpack', async ({ name, versionId, file }) => {
  if (file) return importMrpack(fs.readFileSync(file), name);
  const v = await getJSON(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`);
  const f = v.files.find(x => x.primary) || v.files[0];
  const tmp = path.join(SHARED, 'installers', `pack-${path.basename(v.id)}.mrpack`);
  const buf = await core.download(f.url, tmp, f.hashes.sha1);
  fs.rmSync(tmp, { force: true });
  return importMrpack(buf, name);
});

h('instance:delete', id => {
  if (running.has(path.basename(id))) throw new Error('Close the game first');
  fs.rmSync(instDir(id), { recursive: true, force: true });
});
h('open', (id, kind) => shell.openPath(id ? (kind ? kindDir(id, kind) : instDir(id)) : DATA));

// ---------- local content ----------
h('content:list', (id, kind) => {
  const d = kindDir(id, kind);
  return fs.readdirSync(d, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.')) // e.g. Prism's .index metadata folder
    .map(e => ({
      file: e.name,
      name: e.name.replace(/\.disabled$/, ''),
      enabled: !e.name.endsWith('.disabled'),
      size: e.isFile() ? fs.statSync(path.join(d, e.name)).size : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

h('content:toggle', (id, kind, file) => {
  const d = kindDir(id, kind), f = path.basename(file);
  fs.renameSync(path.join(d, f), path.join(d, f.endsWith('.disabled') ? f.slice(0, -9) : f + '.disabled'));
});

h('content:remove', (id, kind, file) => fs.rmSync(path.join(kindDir(id, kind), path.basename(file)), { recursive: true, force: true }));

h('content:add', async (id, kind, paths) => {
  const d = kindDir(id, kind);
  if (!paths?.length) {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [kind === 'mods' ? { name: 'Mods', extensions: ['jar'] } : { name: 'Packs', extensions: ['zip'] }],
    });
    paths = r.filePaths;
  }
  for (const p of paths) fs.cpSync(p, path.join(d, path.basename(p)), { recursive: true });
  return paths.length;
});

// ---------- modrinth ----------
h('mr:search', ({ id, query, kind, offset = 0 }) => {
  const facets = [];
  if (kind === 'modpack') facets.push(['project_type:modpack']);
  else {
    if (!KINDS[kind]) throw new Error('Bad content type');
    const inst = readInst(id);
    facets.push([`project_type:${KINDS[kind]}`], [`versions:${inst.version}`]);
    if (kind === 'mods' && MR_LOADERS[inst.loader]) facets.push(MR_LOADERS[inst.loader].map(l => `categories:${l}`));
  }
  const q = new URLSearchParams({ query: query || '', facets: JSON.stringify(facets), limit: 24, offset, index: query ? 'relevance' : 'downloads' });
  return getJSON(`https://api.modrinth.com/v2/search?${q}`);
});

h('mr:versions', async projectId =>
  (await getJSON(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`))
    .map(v => ({ id: v.id, name: v.name, number: v.version_number, games: v.game_versions, loaders: v.loaders })));

h('mr:installed', id => {
  const inst = readInst(id);
  return Object.entries(inst.modrinth || {})
    .filter(([, v]) => { const d = path.join(instDir(id), v.kind); return fs.existsSync(path.join(d, v.file)) || fs.existsSync(path.join(d, v.file + '.disabled')); })
    .map(([k]) => k);
});

async function install(id, kind, projectId, seen, isDep) {
  if (seen.has(projectId)) return;
  seen.add(projectId);
  const inst = readInst(id);
  inst.modrinth ||= {};
  const prev = inst.modrinth[projectId];
  const d = kindDir(id, kind);
  if (isDep && prev && (fs.existsSync(path.join(d, prev.file)) || fs.existsSync(path.join(d, prev.file + '.disabled')))) return;

  const p = new URLSearchParams({ game_versions: JSON.stringify([inst.version]) });
  if (kind === 'mods' && MR_LOADERS[inst.loader]) p.set('loaders', JSON.stringify(MR_LOADERS[inst.loader]));
  const vers = await getJSON(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${p}`);
  if (!vers.length) throw new Error(`No version for Minecraft ${inst.version}${kind === 'mods' ? ' / ' + inst.loader : ''}`);
  const v = vers[0];
  const file = v.files.find(f => f.primary) || v.files[0];
  const name = path.basename(file.filename);
  await core.download(file.url, path.join(d, name), file.hashes.sha1);
  if (prev && prev.file !== name) fs.rmSync(path.join(d, path.basename(prev.file)), { force: true });
  inst.modrinth[projectId] = { kind, file: name, version: v.version_number };
  saveInst(id, inst);

  for (const dep of v.dependencies || [])
    if (dep.dependency_type === 'required' && dep.project_id) await install(id, kind, dep.project_id, seen, true);
}
h('mr:install', (id, kind, projectId) => install(id, kind, projectId, new Set(), false));

// hashes every local file so manually added Modrinth files update too
h('mr:updateAll', async id => {
  const inst = readInst(id);
  inst.modrinth ||= {};
  const updated = [];
  for (const kind of Object.keys(KINDS)) {
    const d = kindDir(id, kind);
    const files = fs.readdirSync(d).filter(f => fs.statSync(path.join(d, f)).isFile());
    if (!files.length) continue;
    const byHash = Object.fromEntries(files.map(f => [core.sha1(fs.readFileSync(path.join(d, f))), f]));
    const loaders = kind === 'mods' ? MR_LOADERS[inst.loader] || ['minecraft'] : kind === 'shaderpacks' ? ['iris', 'optifine', 'canvas', 'vanilla'] : ['minecraft'];
    const res = await getJSON('https://api.modrinth.com/v2/version_files/update', { hashes: Object.keys(byHash), algorithm: 'sha1', loaders, game_versions: [inst.version] });
    for (const [hash, v] of Object.entries(res)) {
      if (v.files.some(f => f.hashes.sha1 === hash)) continue; // already latest
      const file = v.files.find(f => f.primary) || v.files[0];
      const old = byHash[hash];
      const name = path.basename(file.filename) + (old.endsWith('.disabled') ? '.disabled' : '');
      await core.download(file.url, path.join(d, name), file.hashes.sha1);
      if (name !== old) fs.rmSync(path.join(d, old), { force: true });
      inst.modrinth[v.project_id] = { kind, file: path.basename(file.filename), version: v.version_number };
      updated.push(`${old.replace(/\.disabled$/, '')} → ${file.filename}`);
    }
  }
  saveInst(id, inst);
  return updated;
});

// ---------- settings & accounts ----------
const publicCfg = () => { const c = cfg(); return { ...c, accounts: c.accounts.map(({ refresh, ...a }) => a) }; };
h('cfg:get', publicCfg);
h('cfg:set', patch => {
  const c = cfg();
  for (const k of ['javaPath', 'memory', 'selected', 'discordRpc']) if (k in patch) c[k] = patch[k];
  writeJSON(CFG, c);
  updatePresence();
  return publicCfg();
});

// ---------- Discord Rich Presence ----------
// shortcut: presence lives on the launcher's Discord connection, so it clears when the launcher closes even if games keep running
const DISCORD_CLIENT_ID = '1566433771702714368'; // "Nature Launcher" app on the Discord developer portal (public, not a secret)
const SITE = 'https://avadrinkssprite.github.io/nature-launcher/';
const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', custom: 'Custom' };
const rpc = createRpc(DISCORD_CLIENT_ID);
function updatePresence() {
  if (process.platform === 'linux' || !cfg().discordRpc) return rpc.stop(); // Discord presence is Windows-only
  const games = [...running].filter(([, proc]) => proc); // null = still downloading/launching
  const base = { assets: { large_image: SITE + 'icon.png', large_text: 'Nature Launcher' }, buttons: [{ label: 'Get Nature Launcher', url: SITE }] };
  if (!games.length) return rpc.set({ ...base, details: 'In the launcher' });
  const start = Math.min(...games.map(([, p]) => p.startedAt));
  if (games.length > 1) return rpc.set({ ...base, details: `${games.length} instances running`, timestamps: { start } });
  const inst = readJSON(path.join(INST, games[0][0], 'instance.json'), {});
  rpc.set({ ...base, details: `Playing ${inst.name}`, state: `Minecraft ${inst.version} · ${LOADER_NAMES[inst.loader] || inst.loader}`, timestamps: { start } });
}

h('acc:ms', async () => {
  const xbox = await new Auth('select_account').launch('electron');
  const mc = await xbox.getMinecraft();
  const c = cfg();
  c.accounts = c.accounts.filter(a => a.id !== mc.profile.id);
  c.accounts.push({ id: mc.profile.id, type: 'ms', name: mc.profile.name, refresh: enc(xbox.save()) });
  c.selected = mc.profile.id;
  writeJSON(CFG, c);
  return publicCfg();
});

h('acc:offline', name => {
  name = String(name || '').trim();
  if (!/^\w{3,16}$/.test(name)) throw new Error('Username must be 3-16 letters, digits or _');
  const c = cfg();
  const id = 'offline-' + name;
  if (!c.accounts.some(a => a.id === id)) c.accounts.push({ id, type: 'offline', name });
  c.selected = id;
  writeJSON(CFG, c);
  return publicCfg();
});

h('acc:remove', id => {
  const c = cfg();
  c.accounts = c.accounts.filter(a => a.id !== id);
  if (c.selected === id) c.selected = c.accounts[0]?.id || null;
  writeJSON(CFG, c);
  return publicCfg();
});

// ---------- launch ----------
h('launch', async id => {
  id = path.basename(id);
  if (running.has(id)) throw new Error('Already running');
  const inst = readInst(id);
  const c = cfg();
  const acc = c.accounts.find(a => a.id === c.selected);
  if (!acc) throw new Error('Add an account first');
  const log = m => send('log', id, m);

  let auth;
  if (acc.type === 'ms') {
    log('Refreshing Microsoft login…');
    const xbox = await new Auth('select_account').refresh(dec(acc.refresh));
    const mc = (await xbox.getMinecraft()).mclc();
    acc.refresh = enc(xbox.save());
    writeJSON(CFG, c);
    auth = { name: mc.name, uuid: mc.uuid, token: mc.access_token, xuid: mc.meta?.xuid, type: 'msa' };
  } else auth = { name: acc.name, uuid: core.offlineUUID(acc.name), token: '0', type: 'legacy' };

  inst.lastPlayed = Date.now();
  saveInst(id, inst);
  running.set(id, null);
  try {
    const proc = await core.launch({
      inst, gameDir: instDir(id), auth, javaPath: c.javaPath || null, memory: c.memory, log,
      progress: (label, done, total) => send('progress', id, { label, done, total }),
    });
    proc.startedAt = Date.now();
    running.set(id, proc);
    updatePresence();
    let ended = false;
    const end = code => { if (ended) return; ended = true; running.delete(id); updatePresence(); send('closed', id, code); quitIfIdle(); };
    proc.on('error', e => { log('Failed to start Java: ' + e.message); end(-1); });
    proc.on('close', end);
    send('started', id);
  } catch (e) {
    running.delete(id);
    quitIfIdle();
    throw e;
  }
});

// ---------- self-update ----------
// The installer copies the repo's main branch into resources/app, version.txt included.
// A different ID on GitHub means newer code was pushed; the installer then pulls it.
// isPackaged is false under `npm start` (electron.exe), true for the installed "Nature Launcher.exe".
const REPO = 'avadrinkssprite/nature-launcher';
async function checkForUpdate() {
  if (!app.isPackaged) return; // dev runs (npm start) never prompt
  const local = fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8').trim();
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/version.txt?t=${Date.now()}`, { headers: UA });
  const remote = r.ok ? (await r.text()).trim() : '';
  if (!/^[0-9a-f]{32}$/.test(remote) || remote === local) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'info', buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Update available', message: 'A new version of Nature Launcher is available.',
    detail: 'The launcher will close and the installer will update it. Your instances and worlds are kept.',
  });
  if (response !== 0) return;
  const { spawn } = require('child_process');
  if (process.platform === 'linux') {
    // Linux installs come from install.sh in the repo; re-running it is the update
    const sh = path.join(app.getPath('temp'), 'nature-launcher-install.sh');
    await core.download(`https://raw.githubusercontent.com/${REPO}/main/install.sh?t=${Date.now()}`, sh);
    spawn('bash', [sh, '--update'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const setup = path.join(app.getPath('temp'), 'NatureLauncherSetup.exe');
    await core.download(`https://github.com/${REPO}/releases/latest/download/NatureLauncherSetup.exe`, setup);
    spawn(setup, ['/update', '/dir', path.dirname(process.execPath)], { detached: true, stdio: 'ignore' }).unref();
  }
  app.quit();
}

// ---------- window ----------
// Closing the window while a game runs only hides it, so Discord presence and the game log keep going.
// The hidden launcher quits by itself once the last game exits.
let quitting = false;
app.on('before-quit', () => { quitting = true; });
function quitIfIdle() { if (!running.size && win && !win.isVisible()) app.quit(); }

// opening the launcher again shows the existing (maybe hidden) window instead of a second copy
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 780, minWidth: 960, minHeight: 600,
    backgroundColor: '#1a2f5c',
    icon: path.join(__dirname, 'build', 'icon.png'), // the installed exe is stock Electron, so set the taskbar icon here
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e8ecf6', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  updatePresence();
  let told = false;
  win.on('close', e => {
    if (quitting || !running.size) return;
    e.preventDefault();
    win.hide();
    if (!told && Notification.isSupported()) {
      told = true;
      new Notification({ title: 'Nature Launcher', body: 'Still running in the background while your game is open. It closes by itself when you stop playing.', icon: path.join(__dirname, 'build', 'icon.png') }).show();
    }
  });
  win.webContents.once('did-finish-load', () => checkForUpdate().catch(e => console.error('Update check failed:', e.message)));
  // Modrinth links open in the real browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
});
app.on('window-all-closed', () => app.quit());
