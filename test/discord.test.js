// node test/discord.test.js — checks the Discord IPC frame encoder/decoder
const assert = require('assert');
const { encode, decode } = require('../discord');
const a = encode(1, { evt: 'READY' }), b = encode(2, { code: 4000 });
const state = { buf: Buffer.alloc(0) };
const both = Buffer.concat([a, b]);
assert.deepStrictEqual(decode(state, both.subarray(0, 5)), []);             // partial header waits
assert.deepStrictEqual(decode(state, both.subarray(5)).map(f => f.op), [1, 2]); // two frames in one chunk
assert.strictEqual(state.buf.length, 0);
assert.strictEqual(a.readInt32LE(4), a.length - 8);
console.log('discord frames ok');
