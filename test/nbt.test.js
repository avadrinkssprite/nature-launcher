// node test/nbt.test.js  — round-trips a real level.dat byte-for-byte and checks field edits
const assert = require('assert');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const nbt = require('../nbt');

// synthetic round-trip covering every tag type
const root = { t: nbt.T.COMPOUND, name: '', v: new Map([
  ['', { t: nbt.T.COMPOUND, v: new Map([
    ['LevelName', { t: nbt.T.STRING, v: 'Hello ☃' }],
    ['GameType', { t: nbt.T.INT, v: 1 }],
    ['Difficulty', { t: nbt.T.BYTE, v: 2 }],
    ['Time', { t: nbt.T.LONG, v: 123456789012345n }],
    ['Spawn', { t: nbt.T.INT_ARRAY, v: [1, -2, 3] }],
    ['Bits', { t: nbt.T.LONG_ARRAY, v: [1n, 2n] }],
    ['Bytes', { t: nbt.T.BYTE_ARRAY, v: [0, 127, -128] }],
    ['F', { t: nbt.T.FLOAT, v: 1.5 }],
    ['D', { t: nbt.T.DOUBLE, v: -2.25 }],
    ['Packs', { t: nbt.T.LIST, v: { et: nbt.T.STRING, items: ['a', 'b'] } }],
    ['Players', { t: nbt.T.LIST, v: { et: nbt.T.COMPOUND, items: [new Map([['n', { t: nbt.T.STRING, v: 'x' }]])] } }],
  ]) }],
]) };
const out = nbt.write(root);
const back = nbt.read(out);
assert.deepStrictEqual(nbt.write(back), out, 'synthetic round-trip not byte-identical');
const data = back.v.get('').v;
assert.strictEqual(data.get('LevelName').v, 'Hello ☃');
assert.strictEqual(data.get('Time').v, 123456789012345n);
console.log('nbt synthetic round-trip ok');

// real level.dat, if present: decompress, round-trip byte-for-byte, edit, verify
const APPDATA = process.env.APPDATA;
let real = null;
if (APPDATA) {
  const base = path.join(APPDATA, 'nature-launcher', 'instances');
  try { for (const inst of fs.readdirSync(base)) { const s = path.join(base, inst, 'saves'); if (!fs.existsSync(s)) continue;
    for (const w of fs.readdirSync(s)) { const f = path.join(s, w, 'level.dat'); if (fs.existsSync(f)) { real = f; break; } } if (real) break; } } catch {}
}
if (!real) { console.log('no real level.dat found, skipping'); process.exit(0); }
const raw = fs.readFileSync(real);
const plain = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
const tree = nbt.read(plain);
assert.deepStrictEqual(nbt.write(tree), plain, 'real level.dat round-trip not byte-identical');
const d = tree.v.get('Data').v;
console.log('real level.dat:', real.replace(APPDATA, '%APPDATA%'));
console.log('  LevelName =', JSON.stringify(d.get('LevelName')?.v), '| GameType =', d.get('GameType')?.v, '| Difficulty =', d.get('Difficulty')?.v, '| allowCommands =', d.get('allowCommands')?.v, '| hardcore =', d.get('hardcore')?.v);
console.log('  Version =', d.get('Version')?.v?.get?.('Name')?.v, '| DataPacks =', d.get('DataPacks') ? [...d.get('DataPacks').v.keys()] : 'none');
// edit name and write back in memory only
d.get('LevelName').v = 'Edited Name';
const re = nbt.read(nbt.write(tree));
assert.strictEqual(re.v.get('Data').v.get('LevelName').v, 'Edited Name');
console.log('real level.dat round-trip + edit ok');
