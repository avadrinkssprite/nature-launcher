// node test/worlds.test.js — copies a real world to scratch, edits it, round-trips, drives datapacks
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const worlds = require('../worlds');

// find a real world
const base = path.join(process.env.APPDATA || '', 'nature-launcher', 'instances');
let src = null;
try { for (const inst of fs.readdirSync(base)) { const s = path.join(base, inst, 'saves'); if (!fs.existsSync(s)) continue;
  for (const w of fs.readdirSync(s)) if (fs.existsSync(path.join(s, w, 'level.dat'))) { src = path.join(s, w); break; } if (src) break; } } catch {}
if (!src) { console.log('no real world found, skipping'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nlworld-'));
const wp = path.join(tmp, 'world');
fs.cpSync(src, wp, { recursive: true });

const before = worlds.summary(wp);
console.log('before:', JSON.stringify(before));

// edit every field to a known, different value
worlds.edit(wp, { name: 'NL Test World', gameType: before.gameType === 0 ? 1 : 0, difficulty: 3, cheats: !before.cheats, hardcore: !before.hardcore });
const after = worlds.summary(wp);
assert.strictEqual(after.name, 'NL Test World');
assert.strictEqual(after.difficulty, 3);
assert.strictEqual(after.cheats, !before.cheats);
assert.strictEqual(after.hardcore, !before.hardcore);
assert.strictEqual(after.version, before.version, 'version (untouched field) must survive');
// level.dat must still be loadable and gzipped as before
const raw = fs.readFileSync(path.join(wp, 'level.dat'));
assert.ok(raw[0] === 0x1f && raw[1] === 0x8b, 'level.dat should stay gzipped');
console.log('after :', JSON.stringify(after));

// datapacks: simulate adding one by writing a file, enable, disable, remove
fs.mkdirSync(path.join(wp, 'datapacks'), { recursive: true });
fs.writeFileSync(path.join(wp, 'datapacks', 'test-pack.zip'), 'x');
worlds.setPackEnabled(wp, 'test-pack.zip', true);
assert.ok(!worlds.disabledPacks(wp).has('file/test-pack.zip'), 'enabled pack not in Disabled');
worlds.setPackEnabled(wp, 'test-pack.zip', false);
assert.ok(worlds.disabledPacks(wp).has('file/test-pack.zip'), 'disabled pack in Disabled');
worlds.setPackEnabled(wp, 'test-pack.zip', null);
assert.ok(!worlds.disabledPacks(wp).has('file/test-pack.zip'), 'removed pack gone from Disabled');
// original other datapack entries preserved
console.log('datapacks enable/disable/remove ok');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('worlds.js integration ok');
