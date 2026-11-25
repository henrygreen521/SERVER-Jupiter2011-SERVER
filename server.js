// Jupiter Incident multiplayer relay server. Zero dependencies (Node 16+).
// Run: node server.js   (PORT env var sets the port, default 8080)
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080, MAX_PER_ROOM = +process.env.MAX_PLAYERS || 8;
const PUBLIC = path.join(__dirname, 'public');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(); // code -> Map(id -> client)
let nextId = 1;

/* ---------- static hosting: drop the game html in ./public/index.html ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.end('ok'); return; }
  const f = path.join(PUBLIC, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not found. Put the game at public/index.html'); return; }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(d);
  });
});

/* ---------- minimal WebSocket (text frames) ---------- */
function frame(str, op = 1) {
  const p = Buffer.from(str), n = p.length;
  const h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : null;
  return h ? Buffer.concat([h, p]) : null;
}
function send(c, obj) { if (c.sock.destroyed) return; const f = frame(JSON.stringify(obj)); if (f) c.sock.write(f); }
function bcast(room, obj, except) { for (const c of room.values()) if (c.id !== except) send(c, obj); }

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const room = (u.searchParams.get('room') || 'public').replace(/[^\w-]/g, '').slice(0, 24) || 'public';
  const name = (u.searchParams.get('name') || 'Player').replace(/[^\w \-]/g, '').slice(0, 16) || 'Player';
  const players = rooms.get(room) || new Map();
  if (players.size >= MAX_PER_ROOM) { sock.end('HTTP/1.1 503 Room full\r\n\r\n'); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  rooms.set(room, players);
  const c = { id: nextId++, name, sock, buf: Buffer.alloc(0), st: null, last: 0 };
  send(c, { t: 'welcome', id: c.id, room, players: [...players.values()].map(p => ({ id: p.id, name: p.name, s: p.st })) });
  players.set(c.id, c);
  bcast(players, { t: 'join', id: c.id, name }, c.id);

  const leave = () => { if (!players.delete(c.id)) return; bcast(players, { t: 'leave', id: c.id }); if (!players.size) rooms.delete(room); };
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 1 << 16) { sock.destroy(); return; }
    for (;;) {
      const b = c.buf; if (b.length < 2) return;
      const op = b[0] & 15, masked = b[1] & 128; let len = b[1] & 127, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; } else if (len === 127) { sock.destroy(); return; }
      if (b.length < o + (masked ? 4 : 0) + len) return;
      const mk = masked ? b.slice(o, o + 4) : null; if (masked) o += 4;
      const pl = Buffer.from(b.slice(o, o + len)); if (mk) for (let i = 0; i < len; i++) pl[i] ^= mk[i & 3];
      c.buf = b.slice(o + len);
      if (op === 8) { sock.end(frame('', 8)); return; }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, pl.length]), pl])); continue; }
      if (op === 1) handle(pl.toString());
    }
  });
  function handle(txt) {
    let m; try { m = JSON.parse(txt) } catch (e) { return }
    const now = Date.now();
    if (m.t === 'state') { // throttle to ~30/s; clamp to numbers
      if (now - c.last < 30) return; c.last = now;
      const n = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
      c.st = { x: n(m.x), y: n(m.y), z: n(m.z), yaw: n(m.yaw), pitch: n(m.pitch), hp: n(m.hp) };
      bcast(players, { t: 'state', id: c.id, s: c.st }, c.id);
    } else if (m.t === 'shot') {
      bcast(players, { t: 'shot', id: c.id, x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, dx: +m.dx || 0, dy: +m.dy || 0, dz: +m.dz || 0 }, c.id);
    } else if (m.t === 'chat') {
      bcast(players, { t: 'chat', id: c.id, name, text: String(m.text || '').slice(0, 120) });
    }
  }
  sock.on('close', leave); sock.on('error', leave);
});
server.listen(PORT, () => console.log('Multiplayer server listening on port ' + PORT));
