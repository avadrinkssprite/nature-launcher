// Minimal Discord Rich Presence over Discord's local IPC pipe (no dependency).
// Frames are: int32 LE opcode, int32 LE length, JSON payload.
const net = require('net');
const path = require('path');

const HANDSHAKE = 0, FRAME = 1, CLOSE = 2;
const pipe = i => process.platform === 'win32'
  ? `\\\\.\\pipe\\discord-ipc-${i}`
  : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp', `discord-ipc-${i}`);

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

// returns complete frames and leaves any partial one in the buffer
function decode(state, chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  const out = [];
  while (state.buf.length >= 8) {
    const len = state.buf.readInt32LE(4);
    if (state.buf.length < 8 + len) break;
    out.push({ op: state.buf.readInt32LE(0), data: JSON.parse(state.buf.subarray(8, 8 + len)) });
    state.buf = state.buf.subarray(8 + len);
  }
  return out;
}

module.exports = function createRpc(clientId) {
  let sock = null, ready = false, wanted, retry, enabled = false;

  const push = () => sock.write(encode(FRAME, {
    cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: wanted || null }, nonce: `${Date.now()}-${Math.random()}`,
  }));

  function reset() {
    if (sock) sock.destroy();
    sock = null; ready = false;
    clearTimeout(retry);
    if (enabled) retry = setTimeout(() => connect(0), 15000); // Discord may be started later
  }

  function connect(i) {
    if (!clientId || sock || !enabled) return;
    const s = net.createConnection(pipe(i));
    const state = { buf: Buffer.alloc(0) };
    s.once('connect', () => { sock = s; s.write(encode(HANDSHAKE, { v: 1, client_id: clientId })); });
    s.on('data', chunk => {
      for (const f of decode(state, chunk)) {
        if (f.op === CLOSE || f.data.evt === 'ERROR') return reset();
        if (f.data.evt === 'READY') { ready = true; push(); }
      }
    });
    s.on('error', () => { if (!sock && i < 9) connect(i + 1); else if (!sock) reset(); }); // try the next pipe
    s.on('close', () => { if (sock === s) reset(); });
  }

  return {
    set(activity) {
      wanted = activity; enabled = true;
      if (ready) push(); else connect(0);
    },
    stop() {
      enabled = false; wanted = null; clearTimeout(retry);
      if (ready) push(); // clears the status before disconnecting
      if (sock) sock.end();
      sock = null; ready = false;
    },
  };
};

module.exports.decode = decode;
module.exports.encode = encode;
