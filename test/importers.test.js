// node test/importers.test.js  — builds fake launcher folders and checks what the scanners find
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, scanFolder } = require('../importers');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-import-'));
const data = path.join(home, 'AppData', 'Roaming');
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof s === 'string' ? s : JSON.stringify(s)); };

try {
  // Prism: fabric instance with overridden JVM args, game folder "minecraft"
  const pi = path.join(data, 'PrismLauncher', 'instances', 'Pack');
  put(path.join(pi, 'instance.cfg'), '[General]\nname=My Pack\nOverrideJavaArgs=true\nJvmArgs="-XX:+UseG1GC"\n');
  put(path.join(pi, 'mmc-pack.json'), { components: [{ uid: 'net.minecraft', version: '1.21.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.16.5' }] });
  put(path.join(pi, 'minecraft', 'mods', 'a.jar'), 'x');

  // CurseForge: forge
  put(path.join(home, 'curseforge', 'minecraft', 'Instances', 'CF', 'minecraftinstance.json'), { name: 'CF Pack', gameVersion: '1.20.1', baseModLoader: { name: 'forge-47.2.0' } });

  // ATLauncher: quilt
  put(path.join(data, 'ATLauncher', 'instances', 'AT', 'instance.json'), { id: '1.20.4', launcher: { name: 'AT Pack', loaderVersion: { type: 'Quilt', version: '0.26.0' } } });

  // Modrinth App: app.db
  const mr = path.join(data, 'ModrinthApp');
  fs.mkdirSync(path.join(mr, 'profiles', 'mrp'), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(mr, 'app.db'));
  db.exec('CREATE TABLE profiles (path TEXT, name TEXT, game_version TEXT, mod_loader TEXT, mod_loader_version TEXT)');
  db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?)').run('mrp', 'MR Pack', '1.21.4', 'neoforge', '21.4.1');
  db.close();

  // .minecraft: a fabric version and a custom client inheriting 1.8.9
  const mc = path.join(data, '.minecraft', 'versions');
  put(path.join(mc, 'fabric-loader-0.19.5-1.21.5', 'fabric-loader-0.19.5-1.21.5.json'), { id: 'fabric-loader-0.19.5-1.21.5', inheritsFrom: '1.21.5', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5' }] });
  put(path.join(mc, 'Client', 'Client.json'), { id: 'Client', inheritsFrom: '1.8.9', libraries: [] });

  const got = scan(home, { APPDATA: data }, 'win32');
  const by = n => got.find(c => c.name === n);
  assert.deepStrictEqual([by('My Pack').loader, by('My Pack').mc, by('My Pack').loaderVersion, by('My Pack').jvmArgs], ['fabric', '1.21.1', '0.16.5', '-XX:+UseG1GC']);
  assert.ok(by('My Pack').dir.endsWith(path.join('Pack', 'minecraft')));
  assert.deepStrictEqual([by('CF Pack').loader, by('CF Pack').loaderVersion], ['forge', '47.2.0']);
  assert.deepStrictEqual([by('AT Pack').loader, by('AT Pack').mc, by('AT Pack').loaderVersion], ['quilt', '1.20.4', '0.26.0']);
  assert.deepStrictEqual([by('MR Pack').loader, by('MR Pack').mc, by('MR Pack').loaderVersion], ['neoforge', '1.21.4', '21.4.1']);
  assert.deepStrictEqual([by('fabric-loader-0.19.5-1.21.5').loader, by('fabric-loader-0.19.5-1.21.5').mc], ['fabric', '1.21.5']);
  assert.deepStrictEqual([by('Client').loader, by('Client').mc], ['custom', '1.8.9']);
  assert.strictEqual(new Set(got.map(c => c.key)).size, got.length);

  // picking a folder: the instances folder, or one instance
  assert.deepStrictEqual(scanFolder(path.join(data, 'PrismLauncher', 'instances')).map(c => c.name), ['My Pack']);
  assert.deepStrictEqual(scanFolder(pi).map(c => c.name), ['My Pack']);
  assert.deepStrictEqual(scanFolder(path.join(home, 'nothing')), []);
  console.log('importers ok');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
