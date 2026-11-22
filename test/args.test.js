// node test/args.test.js  — checks how instance launch args are split
const assert = require('assert');
const os = require('os');
const { splitArgs } = require('../mc')(os.tmpdir());

assert.deepStrictEqual(splitArgs(''), []);
assert.deepStrictEqual(splitArgs(undefined), []);
assert.deepStrictEqual(splitArgs('  -Xmx6G   -XX:+UseG1GC '), ['-Xmx6G', '-XX:+UseG1GC']);
assert.deepStrictEqual(splitArgs(`--server "my server.net" -Dx='a b'`), ['--server', 'my server.net', '-Dx=a b']);
assert.deepStrictEqual(splitArgs(String.raw`"-Dpath=C:\Program Files\x"`), [String.raw`-Dpath=C:\Program Files\x`]);
console.log('args ok');
