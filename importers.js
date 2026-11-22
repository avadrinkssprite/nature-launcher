// Finds instances made by other launchers so they can be copied into Nature Launcher.
// Each candidate: { key, source, name, dir, mc, loader, loaderVersion?, jvmArgs?, versionDir? }
// dir is the game folder (mods, saves, config…). versionDir is set for .minecraft versions,
// whose own json is used as a custom version when the loader isn't recognised.
const fs = require('fs');
const path = require('path');
const os = require('os');

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(d, e.name)); } catch { return []; } };
const firstDir = (...ds) => ds.find(d => fs.existsSync(d));
const LOADER = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge', vanilla: 'vanilla' };

// Prism, PolyMC, MultiMC and their forks: instance.cfg + mmc-pack.json
function prismInstance(d, source) {
  const pack = readJSON(path.join(d, 'mmc-pack.json'));
  let cfg = '';
  try { cfg = fs.readFileSync(path.join(d, 'instance.cfg'), 'utf8'); } catch { return null; }
  if (!pack?.components) return null;
  const ini = k => (cfg.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
  const comp = uid => pack.components.find(c => c.uid === uid)?.version;
  const mc = comp('net.minecraft');
  if (!mc) return null;
  const loaders = [['net.neoforged', 'neoforge'], ['net.minecraftforge', 'forge'], ['org.quiltmc.quilt-loader', 'quilt'], ['net.fabricmc.fabric-loader', 'fabric']];
  const [uid, loader] = loaders.find(([u]) => comp(u)) || [null, 'vanilla'];
  return {
    source, name: ini('name') || path.basename(d), dir: firstDir(path.join(d, '.minecraft'), path.join(d, 'minecraft')) || path.join(d, '.minecraft'),
    mc, loader, loaderVersion: uid && comp(uid), jvmArgs: ini('OverrideJavaArgs') === 'true' ? ini('JvmArgs') : '',
  };
}
function prismRoot(root, source) {
  let instDir = path.join(root, 'instances');
  for (const f of ['prismlauncher.cfg', 'polymc.cfg', 'multimc.cfg']) {
    const m = (() => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } })().match(/^InstanceDir=(.+)$/m);
    if (m) { instDir = path.resolve(root, m[1].trim()); break; }
  }
  return dirs(instDir).map(d => prismInstance(d, source)).filter(Boolean);
}

// Modrinth App: profiles are listed in app.db (SQLite); older versions kept a profile.json in each folder
function modrinth(root, source) {
  const profiles = path.join(root, 'profiles');
  const out = [];
  const db = path.join(root, 'app.db');
  if (fs.existsSync(db)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const s = new DatabaseSync(db, { readOnly: true });
      try {
        for (const r of s.prepare('SELECT * FROM profiles').all())
          if (r.path && r.game_version) out.push({ source, name: r.name || r.path, dir: path.join(profiles, r.path), mc: r.game_version, loader: LOADER[r.mod_loader] || 'vanilla', loaderVersion: r.mod_loader_version || undefined });
      } finally { s.close(); }
    } catch (e) { console.error('Modrinth App database:', e.message); }
  }
  if (!out.length)
    for (const d of dirs(profiles)) {
      const m = readJSON(path.join(d, 'profile.json'))?.metadata;
      if (m?.game_version) out.push({ source, name: m.name || path.basename(d), dir: d, mc: m.game_version, loader: LOADER[m.loader] || 'vanilla', loaderVersion: m.loader_version?.id });
    }
  return out.filter(c => fs.existsSync(c.dir));
}

// CurseForge app: minecraftinstance.json, baseModLoader.name like "forge-47.2.0" or "fabric-0.15.7-1.20.1"
function curseforge(root, source) {
  return dirs(root).map(d => {
    const j = readJSON(path.join(d, 'minecraftinstance.json'));
    if (!j?.gameVersion) return null;
    const m = /^(neoforge|forge|fabric|quilt)-([^-]+)/.exec(j.baseModLoader?.name || '');
    return { source, name: j.name || path.basename(d), dir: d, mc: j.gameVersion, loader: m ? m[1] : 'vanilla', loaderVersion: m?.[2] };
  }).filter(Boolean);
}

// ATLauncher: instance.json, "id" is the Minecraft version
function atlauncher(root, source) {
  return dirs(path.join(root, 'instances')).map(d => {
    const j = readJSON(path.join(d, 'instance.json'));
    if (!j?.id || !j.launcher) return null;
    const lv = j.launcher.loaderVersion;
    const loader = LOADER[String(lv?.type || '').toLowerCase()] || 'vanilla';
    return { source, name: j.launcher.name || path.basename(d), dir: d, mc: j.id, loader, loaderVersion: loader === 'vanilla' ? undefined : lv?.version };
  }).filter(Boolean);
}

// GDLauncher (old): config.json; GDLauncher Carbon: instance.json + an "instance" game folder
function gdlauncher(root, source) {
  const old = dirs(path.join(root, 'instances')).map(d => {
    const l = readJSON(path.join(d, 'config.json'))?.loader;
    if (!l?.mcVersion) return null;
    const loader = LOADER[l.loaderType] || 'vanilla';
    return { source, name: path.basename(d), dir: d, mc: l.mcVersion, loader, loaderVersion: loader === 'vanilla' ? undefined : l.loaderVersion };
  });
  const carbon = dirs(path.join(root, 'data', 'instances')).map(d => {
    const j = readJSON(path.join(d, 'instance.json'));
    const v = j?.game_configuration?.version?.Standard || j?.game_configuration?.version;
    if (!v?.release) return null;
    const ml = (v.modloaders || [])[0];
    return { source, name: j.name || path.basename(d), dir: path.join(d, 'instance'), mc: v.release, loader: LOADER[String(ml?.type || '').toLowerCase()] || 'vanilla', loaderVersion: ml?.version };
  });
  return [...old, ...carbon].filter(c => c && fs.existsSync(c.dir));
}

// the official launcher's folder (also used by TLauncher and others): one candidate per installed version
function versionInfo(j) {
  const libs = (j.libraries || []).map(l => l.name || '');
  const lib = p => libs.find(n => n.startsWith(p))?.slice(p.length);
  const game = (j.arguments?.game || []).filter(a => typeof a === 'string');
  const arg = k => { const i = game.indexOf(k); return i >= 0 ? game[i + 1] : undefined; };
  const mc = j.inheritsFrom || j.id;
  if (lib('net.fabricmc:fabric-loader:')) return { mc, loader: 'fabric', loaderVersion: lib('net.fabricmc:fabric-loader:') };
  if (lib('org.quiltmc:quilt-loader:')) return { mc, loader: 'quilt', loaderVersion: lib('org.quiltmc:quilt-loader:') };
  if (arg('--fml.neoForgeVersion')) return { mc, loader: 'neoforge', loaderVersion: arg('--fml.neoForgeVersion') };
  if (arg('--fml.forgeVersion')) return { mc, loader: 'forge', loaderVersion: arg('--fml.forgeVersion') };
  const old = lib('net.minecraftforge:forge:'); // 1.12.2 and older: "1.12.2-14.23.5.2860"
  if (old) return { mc, loader: 'forge', loaderVersion: old };
  return { mc, loader: j.inheritsFrom ? 'custom' : 'vanilla' }; // vanilla is checked against Mojang's list on import
}
function dotMinecraft(root, source) {
  const profiles = readJSON(path.join(root, 'launcher_profiles.json'))?.profiles || {};
  const named = {};
  for (const p of Object.values(profiles)) if (p.lastVersionId && p.name && !p.gameDir) named[p.lastVersionId] = p.name;
  return dirs(path.join(root, 'versions')).map(vd => {
    const id = path.basename(vd);
    const j = readJSON(path.join(vd, id + '.json'));
    if (!j?.id) return null;
    return { source, name: named[id] || id, dir: root, versionDir: vd, ...versionInfo(j) };
  }).filter(Boolean);
}

function places(home = os.homedir(), env = process.env, platform = process.platform) {
  const data = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dotmc = platform === 'win32' ? path.join(data, '.minecraft') : platform === 'darwin' ? path.join(data, 'minecraft') : path.join(home, '.minecraft');
  return [
    ['Prism Launcher', path.join(data, 'PrismLauncher'), prismRoot],
    ['PolyMC', path.join(data, 'PolyMC'), prismRoot],
    ['MultiMC', path.join(data, 'MultiMC'), prismRoot],
    ['Modrinth App', path.join(data, 'ModrinthApp'), modrinth],
    ['Modrinth App', path.join(data, 'com.modrinth.theseus'), modrinth],
    ['CurseForge', path.join(home, 'curseforge', 'minecraft', 'Instances'), curseforge],
    ['ATLauncher', path.join(data, 'ATLauncher'), atlauncher],
    ['GDLauncher', path.join(data, 'gdlauncher_next'), gdlauncher],
    ['GDLauncher', path.join(data, 'gdlauncher_carbon'), gdlauncher],
    ['Minecraft folder', dotmc, dotMinecraft],
  ];
}

const keyed = list => list.map(c => ({ ...c, key: `${c.dir}|${c.versionDir || ''}` }));

function scan(...a) {
  const out = [];
  for (const [source, root, fn] of places(...a))
    if (fs.existsSync(root)) try { out.push(...fn(root, source)); } catch (e) { console.error(`${source} scan failed:`, e.message); }
  return keyed(out);
}

// a folder the user picked: a launcher's data folder, its instances folder, or one instance
function scanFolder(d) {
  const tries = [
    () => prismRoot(d, 'Folder'), () => dirs(d).map(x => prismInstance(x, 'Folder')).filter(Boolean), () => [prismInstance(d, 'Folder')].filter(Boolean),
    () => modrinth(d, 'Folder'), () => curseforge(d, 'Folder'), () => curseforge(path.dirname(d), 'Folder').filter(c => c.dir === d),
    () => atlauncher(d, 'Folder'), () => atlauncher(path.join(d, '..', '..'), 'Folder').filter(c => c.dir === d), () => gdlauncher(d, 'Folder'), () => dotMinecraft(d, 'Folder'),
  ];
  for (const t of tries) { try { const r = t(); if (r.length) return keyed(r); } catch {} }
  return [];
}

// top-level entries never copied: launcher internals we keep in our own shared folder, or would clash
const SKIP = new Set(['versions', 'libraries', 'assets', 'runtime', 'natives', 'logs', 'crash-reports', 'downloads', 'webcache', 'webcache2', 'instance.json', 'minecraftinstance.json', 'profile.json']);

module.exports = { scan, scanFolder, versionInfo, SKIP };
