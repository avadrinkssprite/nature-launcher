// Minimal NBT (Named Binary Tag) reader/writer for editing Minecraft level.dat. No dependency.
// Tags keep their type so edits round-trip untouched fields exactly.
//   tag = { t: <typeId>, v: <value> }
//   compound v = Map(name -> tag)   list v = { et: elemType, items: [value, ...] }
//   long/longArray values are BigInt.
const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

function read(buf) {
  let o = 0;
  const str = () => { const n = buf.readUInt16BE(o); o += 2; const s = buf.toString('utf8', o, o + n); o += n; return s; };
  function payload(t) {
    switch (t) {
      case T.BYTE: return buf.readInt8(o++);
      case T.SHORT: { const v = buf.readInt16BE(o); o += 2; return v; }
      case T.INT: { const v = buf.readInt32BE(o); o += 4; return v; }
      case T.LONG: { const v = buf.readBigInt64BE(o); o += 8; return v; }
      case T.FLOAT: { const v = buf.readFloatBE(o); o += 4; return v; }
      case T.DOUBLE: { const v = buf.readDoubleBE(o); o += 8; return v; }
      case T.BYTE_ARRAY: { const n = buf.readInt32BE(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(buf.readInt8(o++)); return a; }
      case T.STRING: return str();
      case T.LIST: { const et = buf.readInt8(o++); const n = buf.readInt32BE(o); o += 4; const items = []; for (let i = 0; i < n; i++) items.push(payload(et)); return { et, items }; }
      case T.COMPOUND: { const m = new Map(); for (;;) { const ct = buf.readInt8(o++); if (ct === T.END) break; const name = str(); m.set(name, { t: ct, v: payload(ct) }); } return m; }
      case T.INT_ARRAY: { const n = buf.readInt32BE(o); o += 4; const a = []; for (let i = 0; i < n; i++) { a.push(buf.readInt32BE(o)); o += 4; } return a; }
      case T.LONG_ARRAY: { const n = buf.readInt32BE(o); o += 4; const a = []; for (let i = 0; i < n; i++) { a.push(buf.readBigInt64BE(o)); o += 8; } return a; }
      default: throw new Error('Unknown NBT tag ' + t);
    }
  }
  const t = buf.readInt8(o++);
  const name = str();
  return { t, name, v: payload(t) };
}

function write(root) {
  const chunks = [];
  const u8 = n => chunks.push(Buffer.from([n & 0xff]));
  const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n | 0); chunks.push(b); };
  const str = s => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); chunks.push(h, b); };
  function payload(t, v) {
    switch (t) {
      case T.BYTE: { const b = Buffer.alloc(1); b.writeInt8(v); chunks.push(b); break; }
      case T.SHORT: { const b = Buffer.alloc(2); b.writeInt16BE(v); chunks.push(b); break; }
      case T.INT: i32(v); break;
      case T.LONG: { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); chunks.push(b); break; }
      case T.FLOAT: { const b = Buffer.alloc(4); b.writeFloatBE(v); chunks.push(b); break; }
      case T.DOUBLE: { const b = Buffer.alloc(8); b.writeDoubleBE(v); chunks.push(b); break; }
      case T.BYTE_ARRAY: { i32(v.length); const b = Buffer.alloc(v.length); for (let i = 0; i < v.length; i++) b.writeInt8(v[i], i); chunks.push(b); break; }
      case T.STRING: str(v); break;
      case T.LIST: { u8(v.et); i32(v.items.length); for (const it of v.items) payload(v.et, it); break; }
      case T.COMPOUND: { for (const [name, tag] of v) { u8(tag.t); str(name); payload(tag.t, tag.v); } u8(T.END); break; }
      case T.INT_ARRAY: { i32(v.length); const b = Buffer.alloc(v.length * 4); for (let i = 0; i < v.length; i++) b.writeInt32BE(v[i] | 0, i * 4); chunks.push(b); break; }
      case T.LONG_ARRAY: { i32(v.length); const b = Buffer.alloc(v.length * 8); for (let i = 0; i < v.length; i++) b.writeBigInt64BE(BigInt(v[i]), i * 8); chunks.push(b); break; }
      default: throw new Error('Unknown NBT tag ' + t);
    }
  }
  u8(root.t); str(root.name); payload(root.t, root.v);
  return Buffer.concat(chunks);
}

module.exports = { read, write, T };
