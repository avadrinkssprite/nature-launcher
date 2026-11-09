const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { AdmZip } = require('./lib/deps');
const { Auth } = require('./lib/deps');
const createCore = require('./mc');
const createRpc = require('./discord');
const worlds = require('./worlds');

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
const cfg = () => ({ javaPath: '', memory: 4, accounts: [], selected: null, discordRpc: true, curseforgeKey: '', ...readJSON(CFG, {}) });
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

// ---------- content icons ----------
// pack.png (packs) or the mod's declared icon (mods), as a data URL. Cached by file mtime.
const iconCache = new Map();
const zipPng = (zip, name) => { const e = name && zip.getEntry(name); return e ? e.getData() : null; };
function extractIcon(file, kind) {
  const zip = new AdmZip(file);
  if (kind !== 'mods') return zipPng(zip, 'pack.png');
  let ic;
  const fm = zip.getEntry('fabric.mod.json');
  if (fm) { try { ic = JSON.parse(fm.getData().toString('utf8')).icon; } catch {} }
  if (!ic) { const q = zip.getEntry('quilt.mod.json'); if (q) { try { ic = JSON.parse(q.getData().toString('utf8'))?.quilt_loader?.metadata?.icon; } catch {} } }
  if (ic && typeof ic === 'object') ic = Object.values(ic).pop(); // { "128": "path" }
  return zipPng(zip, ic) || zipPng(zip, 'pack.png') || zipPng(zip, 'logo.png') || zipPng(zip, 'icon.png')
    || (() => { const e = zip.getEntries().find(e => /^assets\/[^/]+\/icon\.png$/.test(e.entryName)); return e ? e.getData() : null; })();
}
h('content:icon', (id, kind, file) => {
  const p = path.join(kindDir(id, kind), path.basename(file));
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = iconCache.get(p);
  if (hit && hit.mtime === st.mtimeMs) return hit.url;
  let url = null;
  try { const png = extractIcon(p, kind); if (png) url = 'data:image/png;base64,' + png.toString('base64'); } catch {}
  iconCache.set(p, { mtime: st.mtimeMs, url });
  return url;
});

// ---------- screenshots ----------
const shotsDir = id => path.join(instDir(id), 'screenshots');
h('shots:list', id => {
  const d = shotsDir(id);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f => /\.(png|jpe?g)$/i.test(f))
    .map(f => { const s = fs.statSync(path.join(d, f)); return { file: f, size: s.size, mtime: s.mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
});
h('shots:thumb', (id, file) => {
  const p = path.join(shotsDir(id), path.basename(file));
  if (!fs.existsSync(p)) return null;
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return null;
  const { width } = img.getSize();
  return (width > 480 ? img.resize({ width: 480 }) : img).toDataURL();
});
h('shots:open', (id, file) => shell.openPath(path.join(shotsDir(id), path.basename(file))));
h('shots:remove', (id, file) => fs.rmSync(path.join(shotsDir(id), path.basename(file)), { force: true }));
h('shots:folder', id => { const d = shotsDir(id); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

// ---------- schematics (Litematica / WorldEdit) ----------
const SCHEM_EXT = /\.(litematic|schem|schematic|nbt)$/i;
const schDir = id => path.join(instDir(id), 'schematics');
// allow subfolders (Litematica supports them) but never escape the schematics folder
function schFile(id, rel) {
  const base = schDir(id), p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Bad schematic path');
  return p;
}
function walkSchem(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSchem(full, base));
    else if (SCHEM_EXT.test(e.name)) { const s = fs.statSync(full); out.push({ file: path.relative(base, full).split(path.sep).join('/'), size: s.size, mtime: s.mtimeMs }); }
  }
  return out;
}
h('sch:has', id => fs.existsSync(schDir(id)));
h('sch:list', id => { const d = schDir(id); return fs.existsSync(d) ? walkSchem(d, d).sort((a, b) => b.mtime - a.mtime) : []; });
h('sch:add', async (id, paths) => {
  const d = schDir(id); fs.mkdirSync(d, { recursive: true });
  if (!paths?.length) {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Schematics', extensions: ['litematic', 'schem', 'schematic', 'nbt'] }] });
    paths = r.filePaths;
  }
  let n = 0;
  for (const p of paths) if (SCHEM_EXT.test(p)) { fs.cpSync(p, path.join(d, path.basename(p))); n++; }
  return n;
});
h('sch:remove', (id, file) => fs.rmSync(schFile(id, file), { force: true }));
h('sch:open', (id, file) => shell.openPath(schFile(id, file)));
h('sch:folder', id => { const d = schDir(id); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

// ---------- worlds & datapacks ----------
const savesDir = id => path.join(instDir(id), 'saves');
const worldDir = (id, folder) => path.join(savesDir(id), path.basename(folder));
const hasLevel = wp => fs.existsSync(path.join(wp, 'level.dat'));
const notRunning = id => { if (running.has(path.basename(id))) throw new Error('Close the game first'); };

h('worlds:list', id => {
  const s = savesDir(id);
  if (!fs.existsSync(s)) return [];
  return fs.readdirSync(s).reduce((out, folder) => {
    const wp = path.join(s, folder);
    if (!hasLevel(wp)) return out;
    const info = { folder, name: folder, icon: fs.existsSync(path.join(wp, 'icon.png')) };
    try { Object.assign(info, worlds.summary(wp)); if (!info.name) info.name = folder; }
    catch (e) { info.error = e.message; }
    out.push(info);
    return out;
  }, []).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
});
h('worlds:icon', (id, folder) => {
  const p = path.join(worldDir(id, folder), 'icon.png');
  if (!fs.existsSync(p)) return null;
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? null : img.toDataURL();
});
h('worlds:save', (id, folder, patch) => {
  notRunning(id);
  const wp = worldDir(id, folder);
  if (!hasLevel(wp)) throw new Error('World not found');
  worlds.edit(wp, patch);
  return true;
});
h('worlds:open', (id, folder) => shell.openPath(worldDir(id, folder)));
h('worlds:delete', (id, folder) => { notRunning(id); fs.rmSync(worldDir(id, folder), { recursive: true, force: true }); });

// raw NBT tree of level.dat (Maps/BigInts survive structured-clone over IPC)
h('nbt:read', (id, folder) => {
  const wp = worldDir(id, folder);
  if (!hasLevel(wp)) throw new Error('World not found');
  return worlds.readLevel(wp).tree;
});
h('nbt:write', (id, folder, tree) => {
  notRunning(id);
  const wp = worldDir(id, folder);
  if (!hasLevel(wp)) throw new Error('World not found');
  if (!tree || tree.t !== 10 || !(tree.v instanceof Map)) throw new Error('Root must be a compound tag');
  const bak = path.join(wp, 'level.dat_nlbak'); // one-time backup before the first raw edit
  if (!fs.existsSync(bak)) fs.copyFileSync(path.join(wp, 'level.dat'), bak);
  worlds.writeLevel(wp, { t: 10, name: '', v: tree.v }, worlds.readLevel(wp).gz);
  return true;
});

const dpDir = (id, folder) => { const d = path.join(worldDir(id, folder), 'datapacks'); fs.mkdirSync(d, { recursive: true }); return d; };
h('dp:list', (id, folder) => {
  const dir = dpDir(id, folder);
  const dis = worlds.disabledPacks(worldDir(id, folder));
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.'))
    .map(e => ({ file: e.name, dir: e.isDirectory(), enabled: !dis.has('file/' + e.name), size: e.isFile() ? fs.statSync(path.join(dir, e.name)).size : null }))
    .sort((a, b) => a.file.localeCompare(b.file));
});
h('dp:add', async (id, folder, paths) => {
  notRunning(id);
  const dir = dpDir(id, folder), wp = worldDir(id, folder);
  if (!paths?.length) {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Datapacks', extensions: ['zip'] }] });
    paths = r.filePaths;
  }
  for (const p of paths) { const name = path.basename(p); fs.cpSync(p, path.join(dir, name), { recursive: true }); worlds.setPackEnabled(wp, name, true); }
  return paths.length;
});
h('dp:toggle', (id, folder, file, enabled) => { notRunning(id); worlds.setPackEnabled(worldDir(id, folder), path.basename(file), enabled); });
h('dp:remove', (id, folder, file) => { notRunning(id); fs.rmSync(path.join(dpDir(id, folder), path.basename(file)), { recursive: true, force: true }); worlds.setPackEnabled(worldDir(id, folder), path.basename(file), null); });

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

// ---------- curseforge (needs the user's own API key from console.curseforge.com) ----------
const CF_CLASS = { mods: 6, resourcepacks: 12, shaderpacks: 6552 };
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }; // CurseForge modLoaderType ids
// Browser UA so Cloudflare lets the proxy through; path is the API suffix after /v1 (e.g. "/mods/search?…").
const CF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// key set → CurseForge API directly; no key → api.curse.tools, a public proxy with Minecraft-approved access
const cfFetch = (pathq, key) => fetch(key ? 'https://api.curseforge.com/v1' + pathq : 'https://api.curse.tools/v1/cf' + pathq,
  { headers: key ? { ...UA, 'x-api-key': key, Accept: 'application/json' } : { 'User-Agent': CF_UA, Accept: 'application/json' } });
async function cfJSON(pathq) {
  const key = (cfg().curseforgeKey || '').trim().replace(/^["']+|["']+$/g, ''); // drop stray quotes/spaces from pasting
  let r = await cfFetch(pathq, key);
  // a key that isn't approved for Minecraft 401/403s — fall back to the no-key proxy so it still works
  if (key && (r.status === 401 || r.status === 403)) r = await cfFetch(pathq, '');
  if (!r.ok) throw new Error(`CurseForge search unavailable (HTTP ${r.status})`);
  return r.json();
}
h('cf:search', ({ id, query, kind, offset = 0 }) => {
  if (!CF_CLASS[kind]) throw new Error('Bad content type');
  const inst = readInst(id);
  const p = new URLSearchParams({ gameId: '432', classId: String(CF_CLASS[kind]), gameVersion: inst.version, searchFilter: query || '', pageSize: '24', index: String(offset), sortField: '2', sortOrder: 'desc' });
  if (kind === 'mods' && CF_LOADER[inst.loader]) p.set('modLoaderType', String(CF_LOADER[inst.loader]));
  return cfJSON(`/mods/search?${p}`).then(j => ({
    hits: (j.data || []).map(m => ({ project_id: String(m.id), title: m.name, author: m.authors?.[0]?.name || '', description: m.summary || '', downloads: m.downloadCount || 0, icon_url: m.logo?.url || '', url: m.links?.websiteUrl || '' })),
    total_hits: j.pagination?.totalCount || 0,
  }));
});
h('cf:installed', id => {
  const inst = readInst(id);
  return Object.entries(inst.curseforge || {})
    .filter(([, v]) => { const d = path.join(instDir(id), v.kind); return fs.existsSync(path.join(d, v.file)) || fs.existsSync(path.join(d, v.file + '.disabled')); })
    .map(([k]) => k);
});
async function cfInstall(id, kind, modId, seen) {
  if (seen.has(modId)) return;
  seen.add(modId);
  const inst = readInst(id);
  inst.curseforge ||= {};
  const d = kindDir(id, kind);
  const q = new URLSearchParams({ gameVersion: inst.version, pageSize: '50' });
  if (kind === 'mods' && CF_LOADER[inst.loader]) q.set('modLoaderType', String(CF_LOADER[inst.loader]));
  const j = await cfJSON(`/mods/${encodeURIComponent(modId)}/files?${q}`);
  const files = (j.data || []).filter(f => f.isAvailable !== false);
  if (!files.length) throw new Error(`No CurseForge file for Minecraft ${inst.version}${kind === 'mods' ? ' / ' + inst.loader : ''}`);
  const f = files.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))[0];
  if (!f.downloadUrl) { // some authors forbid third-party downloads via the API
    let site = 'its CurseForge page';
    try { site = (await cfJSON(`/mods/${encodeURIComponent(modId)}`)).data?.links?.websiteUrl || site; } catch {}
    throw new Error('This project blocks third-party downloads. Get it from ' + site);
  }
  const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
  const prev = inst.curseforge[modId], name = path.basename(f.fileName);
  await core.download(f.downloadUrl, path.join(d, name), sha1);
  if (prev && prev.file !== name) fs.rmSync(path.join(d, path.basename(prev.file)), { force: true });
  inst.curseforge[modId] = { kind, file: name, fileId: f.id };
  saveInst(id, inst);
  for (const dep of f.dependencies || [])
    if (dep.relationType === 3 && dep.modId) await cfInstall(id, kind, String(dep.modId), seen); // 3 = required
}
h('cf:install', (id, kind, modId) => cfInstall(id, kind, String(modId), new Set()));

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
const publicCfg = () => { const c = cfg(); return { ...c, accounts: c.accounts.map(({ refresh, token, ...a }) => a) }; };
h('cfg:get', publicCfg);
h('cfg:set', patch => {
  const c = cfg();
  for (const k of ['javaPath', 'memory', 'selected', 'discordRpc', 'curseforgeKey']) if (k in patch) c[k] = patch[k];
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

// Add an account from a Minecraft session (access) token, with an optional Microsoft
// refresh token for auto-renewal. The token is verified against the profile API so we
// get the real name and uuid and reject a dead token up front.
h('acc:token', async ({ token, refresh }) => {
  token = String(token || '').trim();
  refresh = String(refresh || '').trim();
  if (!token) throw new Error('Session token required');
  const r = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { ...UA, Authorization: 'Bearer ' + token } });
  if (r.status === 401) throw new Error('Session token was rejected (expired or invalid)');
  if (!r.ok) throw new Error(`Profile lookup failed: HTTP ${r.status}`);
  const p = await r.json();
  if (!p.id || !p.name) throw new Error('This token has no Minecraft profile');
  const c = cfg();
  c.accounts = c.accounts.filter(a => a.id !== p.id);
  c.accounts.push({ id: p.id, type: 'token', name: p.name, uuid: p.id, token: enc(token), ...(refresh ? { refresh: enc(refresh) } : {}) });
  c.selected = p.id;
  writeJSON(CFG, c);
  updatePresence();
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
  } else if (acc.type === 'token') {
    let renewed = null;
    if (acc.refresh) {
      try {
        log('Renewing session…');
        const xbox = await new Auth('select_account').refresh(dec(acc.refresh));
        const mc = (await xbox.getMinecraft()).mclc();
        acc.token = enc(mc.access_token); acc.refresh = enc(xbox.save()); acc.name = mc.name; acc.uuid = mc.uuid;
        writeJSON(CFG, c);
        renewed = { name: mc.name, uuid: mc.uuid, token: mc.access_token, xuid: mc.meta?.xuid, type: 'msa' };
      } catch (e) { log('Auto-renew failed, using the stored session token: ' + e.message); }
    }
    // no refresh token, or renewal failed: use the stored session token as-is (expires on its own)
    auth = renewed || { name: acc.name, uuid: acc.uuid, token: dec(acc.token), type: 'msa' };
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
