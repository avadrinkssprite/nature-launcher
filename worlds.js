// Pure world/level.dat logic (no Electron), so it is testable without the app.
// Every function takes an absolute world folder path (the one holding level.dat).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nbt = require('./nbt');

const levelFile = wp => path.join(wp, 'level.dat');

function readLevel(wp) {
  const raw = fs.readFileSync(levelFile(wp));
  const gz = raw[0] === 0x1f && raw[1] === 0x8b;
  return { tree: nbt.read(gz ? zlib.gunzipSync(raw) : raw), gz };
}

function writeLevel(wp, tree, gz) {
  const plain = nbt.write(tree);
  const f = levelFile(wp), tmp = f + '.nltmp';
  fs.writeFileSync(tmp, gz ? zlib.gzipSync(plain) : plain);
  fs.renameSync(tmp, f); // atomic replace so a crash can't truncate level.dat
}

function data(tree) {
  const d = tree.v.get('Data');
  if (!d || d.t !== nbt.T.COMPOUND) throw new Error('level.dat has no Data compound');
  return d.v;
}

function summary(wp) {
  const info = { icon: fs.existsSync(path.join(wp, 'icon.png')) };
  const d = data(readLevel(wp).tree);
  info.name = d.get('LevelName')?.v ?? '';
  info.gameType = d.get('GameType')?.v ?? 0;
  info.difficulty = d.get('Difficulty')?.v ?? 2;
  info.hardcore = !!d.get('hardcore')?.v;
  info.cheats = !!d.get('allowCommands')?.v;
  info.version = d.get('Version')?.v?.get?.('Name')?.v || '';
  info.lastPlayed = Number(d.get('LastPlayed')?.v ?? 0n);
  return info;
}

function edit(wp, patch) {
  const { tree, gz } = readLevel(wp);
  const d = data(tree);
  const set = (k, t, v) => { const tag = d.get(k); if (tag) tag.v = v; else d.set(k, { t, v }); };
  if ('name' in patch) set('LevelName', nbt.T.STRING, String(patch.name).slice(0, 64));
  if ('gameType' in patch) set('GameType', nbt.T.INT, Math.max(0, Math.min(3, patch.gameType | 0)));
  if ('difficulty' in patch) set('Difficulty', nbt.T.BYTE, Math.max(0, Math.min(3, patch.difficulty | 0)));
  if ('cheats' in patch) set('allowCommands', nbt.T.BYTE, patch.cheats ? 1 : 0);
  if ('hardcore' in patch) set('hardcore', nbt.T.BYTE, patch.hardcore ? 1 : 0);
  writeLevel(wp, tree, gz);
}

// which datapacks level.dat marks disabled (keys are "file/<name>")
function disabledPacks(wp) {
  try { return new Set(data(readLevel(wp).tree).get('DataPacks')?.v.get('Disabled')?.v.items || []); } catch { return new Set(); }
}

// state: true (enable) | false (disable) | null (remove from both lists)
function setPackEnabled(wp, name, state) {
  if (!fs.existsSync(levelFile(wp))) return;
  const { tree, gz } = readLevel(wp);
  const d = data(tree);
  let dp = d.get('DataPacks');
  if (!dp) { dp = { t: nbt.T.COMPOUND, v: new Map() }; d.set('DataPacks', dp); }
  const list = k => { let l = dp.v.get(k); if (!l) { l = { t: nbt.T.LIST, v: { et: nbt.T.STRING, items: [] } }; dp.v.set(k, l); } if (!l.v.items.length) l.v.et = nbt.T.STRING; return l.v.items; };
  const key = 'file/' + name, en = list('Enabled'), dis = list('Disabled');
  const drop = arr => { const i = arr.indexOf(key); if (i >= 0) arr.splice(i, 1); };
  drop(en); drop(dis);
  if (state === true) en.push(key); else if (state === false) dis.push(key);
  writeLevel(wp, tree, gz);
}

module.exports = { readLevel, writeLevel, summary, edit, disabledPacks, setPackEnabled };
