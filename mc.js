// Minecraft core: version resolution (inheritsFrom), libraries, natives, assets,
// Mojang Java runtimes, loader installs (Fabric/Quilt/Forge/NeoForge) and launching.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { AdmZip } = require('./lib/deps');

const UA = { 'User-Agent': 'nature-launcher/0.2.0' };
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const OS = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
const ARCH = process.arch === 'ia32' ? 'x86' : process.arch;

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

// tries each mirror (2 attempts each), verifies sha1 when known
async function download(urls, dest, hash) {
  let err = new Error(`No download URL for ${path.basename(dest)}`);
  for (const url of [...new Set([].concat(urls).filter(Boolean))]) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(url, { headers: UA });
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (hash && sha1(buf) !== hash) throw new Error(`Hash mismatch for ${url}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        return buf;
      } catch (e) { err = e; if (/HTTP 4\d\d/.test(e.message)) break; }
    }
  }
  throw err;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function allowed(rules) {
  if (!rules) return true;
  let ok = false;
  for (const r of rules) {
    const osOk = !r.os || ((!r.os.name || r.os.name === OS) && (!r.os.arch || r.os.arch === ARCH) && (!r.os.version || new RegExp(r.os.version).test(os.release())));
    const featOk = !r.features || Object.values(r.features).every(v => !v); // demo, custom resolution, quick play: all off
    if (osOk && featOk) ok = r.action === 'allow';
  }
  return ok;
}

function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [g, a, v, c] = coords.split(':');
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.${ext}`;
}

// "21.1.77" -> "1.21.1", "21.0.5" -> "1.21", "26.1.0.3" -> "26.1"
function neoMc(v) {
  const p = v.split('-')[0].split('.');
  if (p[0] === '0') return null;
  if (+p[0] >= 26) return `${p[0]}.${p[1]}${p[2] && p[2] !== '0' ? '.' + p[2] : ''}`;
  return `1.${p[0]}${p[1] !== '0' ? '.' + p[1] : ''}`;
}
const cmpVer = (a, b) => { const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

function offlineUUID(name) {
  const b = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  b[6] = (b[6] & 0x0f) | 0x30; b[8] = (b[8] & 0x3f) | 0x80;
  return b.toString('hex');
}

module.exports = function createCore(ROOT) {
  const vdir = id => path.join(ROOT, 'versions', id);
  const vjson = id => path.join(vdir(id), id + '.json');
  let manifestP;
  const manifest = () => (manifestP ||= getJSON(MANIFEST).catch(e => { manifestP = null; throw e; }));

  async function versionJson(id) {
    if (fs.existsSync(vjson(id))) return JSON.parse(fs.readFileSync(vjson(id), 'utf8'));
    const v = (await manifest()).versions.find(x => x.id === id);
    if (!v) throw new Error(`Unknown Minecraft version ${id}`);
    return JSON.parse(await download(v.url, vjson(id), v.sha1));
  }

  // flatten an inheritsFrom chain into one version object; child entries win
  async function resolve(id) {
    const v = await versionJson(id);
    if (!v.inheritsFrom) return { ...v, chain: [id] };
    const p = await resolve(v.inheritsFrom);
    const key = l => { const [g, a, , c] = l.name.split(':'); return `${g}:${a}:${c || ''}`; };
    const mine = new Set((v.libraries || []).map(key));
    const args = (p.arguments || v.arguments) && {
      game: [...(p.arguments?.game || []), ...(v.arguments?.game || [])],
      jvm: [...(p.arguments?.jvm || []), ...(v.arguments?.jvm || [])],
    };
    return {
      ...p, ...v,
      libraries: [...(v.libraries || []), ...p.libraries.filter(l => !mine.has(key(l)))],
      arguments: args,
      minecraftArguments: v.minecraftArguments || p.minecraftArguments,
      chain: [id, ...p.chain],
    };
  }

  // ---------- Java ----------
  async function java(component, progress) {
    const dir = path.join(ROOT, 'java', component);
    const exe = path.join(dir, process.platform === 'darwin' ? 'jre.bundle/Contents/Home/bin/java' : process.platform === 'win32' ? 'bin/javaw.exe' : 'bin/java');
    if (fs.existsSync(path.join(dir, '.complete'))) return exe;
    const plat = process.platform === 'win32' ? `windows-${ARCH === 'x86' ? 'x86' : ARCH}` : process.platform === 'darwin' ? (ARCH === 'arm64' ? 'mac-os-arm64' : 'mac-os') : ARCH === 'x86' ? 'linux-i386' : 'linux';
    const all = await getJSON(JAVA_ALL);
    // arm machines fall back to x64 builds (emulated) when Mojang ships no native one
    const entry = all[plat]?.[component]?.[0] || all[plat.replace('-arm64', process.platform === 'win32' ? '-x64' : '')]?.[component]?.[0];
    if (!entry) throw new Error(`Mojang has no ${component} Java for ${plat}. Set a Java path in Settings.`);
    const files = Object.entries((await getJSON(entry.manifest.url)).files);
    const dl = files.filter(([, f]) => f.type === 'file');
    let done = 0;
    await pool(dl, 16, async ([p, f]) => {
      const d = path.join(dir, p);
      await download(f.downloads.raw.url, d, f.downloads.raw.sha1);
      if (f.executable && process.platform !== 'win32') fs.chmodSync(d, 0o755);
      progress(`Java (${component})`, ++done, dl.length);
    });
    for (const [p, f] of files) if (f.type === 'link') try { fs.symlinkSync(f.target, path.join(dir, p)); } catch {}
    fs.writeFileSync(path.join(dir, '.complete'), '');
    return exe;
  }
  const javaFor = async (id, progress) => java((await resolve(id)).javaVersion?.component || 'jre-legacy', progress);

  // ---------- loaders ----------
  async function loaderGames() {
    const [fab, qui, forge, neo] = await Promise.all([
      getJSON('https://meta.fabricmc.net/v2/versions/game').catch(() => []),
      getJSON('https://meta.quiltmc.org/v3/versions/game').catch(() => []),
      getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json').catch(() => ({ promos: {} })),
      getJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge').catch(() => ({ versions: [] })),
    ]);
    return {
      fabric: fab.map(v => v.version),
      quilt: qui.map(v => v.version),
      forge: [...new Set(Object.keys(forge.promos).map(k => k.replace(/-(latest|recommended)$/, '')))],
      neoforge: [...new Set(neo.versions.map(neoMc).filter(Boolean))],
    };
  }

  // wanted = exact version from a modpack, otherwise pick latest stable
  async function loaderVersion(loader, mc, wanted) {
    if (loader === 'fabric') {
      if (wanted) return wanted;
      const l = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`);
      if (!l.length) throw new Error(`Fabric does not support ${mc}`);
      return (l.find(x => x.loader.stable) || l[0]).loader.version;
    }
    if (loader === 'quilt') {
      if (wanted) return wanted;
      const l = (await getJSON(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`)).map(x => x.loader.version);
      if (!l.length) throw new Error(`Quilt does not support ${mc}`);
      const stable = l.filter(v => !v.includes('-'));
      return (stable.length ? stable : l).sort(cmpVer).pop();
    }
    if (loader === 'forge') {
      const promos = (await getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
      const v = wanted || promos[`${mc}-recommended`] || promos[`${mc}-latest`];
      if (!v) throw new Error(`Forge does not support ${mc}`);
      const all = [...(await getText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml')).matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
      const full = all.find(x => x === `${mc}-${v}` || x.startsWith(`${mc}-${v}-`)) || all.find(x => x === v);
      if (!full) throw new Error(`Forge ${v} not found for ${mc}`);
      return full;
    }
    if (loader === 'neoforge') {
      if (wanted) return wanted;
      const l = (await getJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions.filter(v => neoMc(v) === mc);
      if (!l.length) throw new Error(`NeoForge does not support ${mc}`);
      const stable = l.filter(v => !v.includes('beta'));
      return (stable.length ? stable : l).sort(cmpVer).pop();
    }
    return null;
  }

  function run(cmd, args, log) {
    return new Promise((res, rej) => {
      const p = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
      // installers print every class they patch; keep only the meaningful lines
      const out = d => { const t = String(d).split(/\r?\n/).filter(l => l.trim() && !/^\s|Can'?t Find Class|Considering library|Downloading library|File exists|Reading patch|Patching /.test(l)).join('\n'); if (t) log(t); };
      p.stdout.on('data', out);
      p.stderr.on('data', out);
      p.on('error', rej);
      p.on('close', c => (c === 0 ? res() : rej(new Error(`Installer exited with code ${c}, see the Log tab`))));
    });
  }

  // returns the version id to launch, installing the loader on first use
  async function installLoader(inst, javaPath, progress, log) {
    const { loader, version: mc, loaderVersion: lv } = inst;
    if (loader === 'vanilla') return mc;
    if (loader === 'custom') return inst.customId;
    if (loader === 'fabric' || loader === 'quilt') {
      const id = `${loader}-loader-${lv}-${mc}`;
      if (!fs.existsSync(vjson(id))) {
        const base = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
        const j = await getJSON(`${base}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(lv)}/profile/json`);
        j.id = id;
        fs.mkdirSync(vdir(id), { recursive: true });
        fs.writeFileSync(vjson(id), JSON.stringify(j, null, 2));
      }
      return id;
    }
    if (loader !== 'forge' && loader !== 'neoforge') throw new Error(`Unknown loader ${loader}`);

    const marker = path.join(ROOT, 'installers', `${loader}-${lv}.id`);
    if (fs.existsSync(marker)) {
      const id = fs.readFileSync(marker, 'utf8');
      if (fs.existsSync(vjson(id))) return id;
    }
    const jar = path.join(ROOT, 'installers', `${loader}-${lv}-installer.jar`);
    if (!fs.existsSync(jar)) {
      progress(`Downloading ${loader} installer`, 0, 1);
      await download(loader === 'forge'
        ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${lv}/forge-${lv}-installer.jar`
        : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`, jar);
    }
    const zip = new AdmZip(jar);
    const profile = JSON.parse(zip.readAsText('install_profile.json'));
    let id;
    if (profile.versionInfo) {
      // legacy Forge (<= 1.12): no processors, just place the version json and universal jar
      id = profile.versionInfo.id;
      fs.mkdirSync(vdir(id), { recursive: true });
      fs.writeFileSync(vjson(id), JSON.stringify(profile.versionInfo, null, 2));
      const lib = path.join(ROOT, 'libraries', mavenPath(profile.install.path));
      fs.mkdirSync(path.dirname(lib), { recursive: true });
      fs.writeFileSync(lib, zip.getEntry(profile.install.filePath).getData());
    } else {
      id = JSON.parse(zip.readAsText('version.json')).id;
      const lp = path.join(ROOT, 'launcher_profiles.json'); // the official installer refuses to run without it
      if (!fs.existsSync(lp)) fs.writeFileSync(lp, '{"profiles":{}}');
      const javaExe = javaPath || await javaFor(mc, progress);
      progress(`Running ${loader} installer`, 0, 1);
      log(`Running ${loader} ${lv} installer…`);
      await run(javaExe, ['-jar', jar, '--installClient', ROOT], log);
    }
    fs.writeFileSync(marker, id);
    return id;
  }

  // ---------- libraries, natives, assets ----------
  function mavenUrls(l, cls) {
    const p = mavenPath(cls ? `${l.name}:${cls}` : l.name);
    let base = (l.url || 'https://libraries.minecraft.net/').replace(/^http:/, 'https:').replace('files.minecraftforge.net/maven', 'maven.minecraftforge.net');
    if (!base.endsWith('/')) base += '/';
    return [base + p, 'https://libraries.minecraft.net/' + p, 'https://maven.minecraftforge.net/' + p, 'https://repo1.maven.org/maven2/' + p];
  }

  function libEntries(v) {
    const out = [];
    for (const l of v.libraries || []) {
      if (!allowed(l.rules) || l.clientreq === false) continue;
      const art = l.downloads?.artifact;
      if (art) out.push({ path: art.path || mavenPath(l.name), url: art.url, sha1: art.sha1, cp: true, native: /:natives-/.test(l.name) });
      else if (!l.natives) out.push({ path: mavenPath(l.name), url: mavenUrls(l), cp: true });
      const cls = l.natives?.[OS]?.replace('${arch}', ARCH === 'x86' ? '32' : '64');
      if (cls) {
        const d = l.downloads?.classifiers?.[cls];
        out.push({ path: d?.path || mavenPath(`${l.name}:${cls}`), url: d?.url || mavenUrls(l, cls), sha1: d?.sha1, cp: false, native: true });
      }
    }
    return out;
  }

  async function assets(v, gameDir, progress) {
    const root = path.join(ROOT, 'assets');
    const idx = v.assetIndex;
    if (!idx) return { root, index: v.assets || 'legacy', legacy: root };
    const f = path.join(root, 'indexes', idx.id + '.json');
    const data = JSON.parse(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : await download(idx.url, f, idx.sha1));
    const obj = h => path.join(root, 'objects', h.slice(0, 2), h);
    const objs = Object.entries(data.objects);
    const missing = objs.filter(([, o]) => !fs.existsSync(obj(o.hash)));
    let done = 0;
    await pool(missing, 16, async ([, o]) => {
      await download(`https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`, obj(o.hash), o.hash);
      progress('Assets', ++done, missing.length);
    });
    // very old versions read assets from plain files instead of the hashed store
    const legacy = data.map_to_resources ? path.join(gameDir, 'resources') : data.virtual ? path.join(root, 'virtual', idx.id) : null;
    if (legacy) for (const [name, o] of objs) {
      const d = path.join(legacy, name);
      if (!fs.existsSync(d)) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(obj(o.hash), d); }
    }
    return { root, index: idx.id, legacy: legacy || root };
  }

  // log4j XML console layout -> readable lines
  function logParser(log) {
    let buf = '';
    return chunk => {
      buf += chunk;
      const out = [];
      let m;
      const re = /<log4j:Event[^>]*?level="(\w+)"[^>]*?thread="([^"]*)"[^>]*>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/log4j:Event>/g;
      let last = 0;
      while ((m = re.exec(buf))) { out.push(buf.slice(last, m.index).trim(), `[${m[2]}/${m[1]}] ${m[3]}`); last = re.lastIndex; }
      buf = buf.slice(last);
      if (!buf.includes('<log4j:Event')) { out.push(buf.trim()); buf = ''; }
      const text = out.filter(Boolean).join('\n');
      if (text) log(text);
    };
  }

  // ---------- launch ----------
  async function launch({ inst, gameDir, auth, javaPath, memory, log, progress }) {
    const id = await installLoader(inst, javaPath, progress, log);
    const v = await resolve(id);

    // client jar: download for the base version, copy next to the child like the official launcher
    const base = v.chain[v.chain.length - 1];
    const baseJson = await versionJson(base);
    const baseJar = path.join(vdir(base), base + '.jar');
    if (!fs.existsSync(baseJar)) {
      if (!baseJson.downloads?.client) throw new Error(`${base} has no client jar. Add one to versions/${base}/`);
      progress('Minecraft jar', 0, 1);
      await download(baseJson.downloads.client.url, baseJar, baseJson.downloads.client.sha1);
    }
    let jar = v.jar ? path.join(vdir(v.jar), v.jar + '.jar') : path.join(vdir(id), id + '.jar');
    if (!fs.existsSync(jar)) fs.copyFileSync(baseJar, jar);

    const javaExe = javaPath || await java(v.javaVersion?.component || 'jre-legacy', progress);

    const libDir = path.join(ROOT, 'libraries');
    const libs = libEntries(v);
    const missing = libs.filter(l => !fs.existsSync(path.join(libDir, l.path)));
    let done = 0;
    await pool(missing, 8, async l => {
      await download(l.url, path.join(libDir, l.path), l.sha1);
      progress('Libraries', ++done, missing.length);
    });

    const natives = path.join(ROOT, 'natives', id);
    if (!fs.existsSync(path.join(natives, '.done'))) {
      fs.mkdirSync(natives, { recursive: true });
      for (const l of libs.filter(l => l.native)) {
        for (const e of new AdmZip(path.join(libDir, l.path)).getEntries())
          if (!e.isDirectory && !e.entryName.startsWith('META-INF') && /\.(dll|so|dylib|jnilib)$/.test(e.entryName))
            fs.writeFileSync(path.join(natives, path.basename(e.entryName)), e.getData());
      }
      fs.writeFileSync(path.join(natives, '.done'), '');
    }

    const a = await assets(v, gameDir, progress);
    const cp = [...new Set(libs.filter(l => l.cp).map(l => path.join(libDir, l.path))), jar].join(path.delimiter);

    const vars = {
      auth_player_name: auth.name, version_name: id, game_directory: gameDir, assets_root: a.root, game_assets: a.legacy,
      assets_index_name: a.index, auth_uuid: auth.uuid, auth_access_token: auth.token, auth_session: `token:${auth.token}:${auth.uuid}`,
      clientid: '', auth_xuid: auth.xuid || '', user_type: auth.type, version_type: v.type || 'release', user_properties: '{}',
      natives_directory: natives, launcher_name: 'nature-launcher', launcher_version: '0.2.0', classpath: cp,
      library_directory: libDir, classpath_separator: path.delimiter,
    };
    const sub = s => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    const flat = list => list.flatMap(x => (typeof x === 'string' ? [x] : allowed(x.rules) ? [].concat(x.value) : []));
    let jvm = v.arguments ? flat(v.arguments.jvm || []) : [];
    const game = v.arguments?.game?.length ? flat(v.arguments.game) : (v.minecraftArguments || '').split(' ').filter(Boolean);
    if (!jvm.some(x => x.includes('${classpath}'))) jvm.push('-Djava.library.path=${natives_directory}', '-cp', '${classpath}');

    // Mojang's patched log4j config: required to block Log4Shell on 1.7 - 1.18
    const lc = v.logging?.client;
    if (lc?.file) {
      const f = path.join(ROOT, 'assets', 'log_configs', lc.file.id);
      if (!fs.existsSync(f)) await download(lc.file.url, f, lc.file.sha1);
      jvm.unshift(lc.argument.replace('${path}', f));
    }

    const args = [`-Xmx${memory}G`, '-Xms512M', ...jvm.map(sub), v.mainClass, ...game.map(sub)];
    log(`Launching ${id} with ${javaExe}`);
    // detached: Electron kills attached children when it quits; the game should outlive the launcher
    const proc = spawn(javaExe, args, { cwd: gameDir, windowsHide: true, detached: true });
    const parse = logParser(log);
    proc.stdout.on('data', d => parse(String(d)));
    proc.stderr.on('data', d => log(String(d).trimEnd()));
    return proc;
  }

  return { launch, loaderGames, loaderVersion, manifest, offlineUUID, download, pool, sha1, vdir, vjson };
};
