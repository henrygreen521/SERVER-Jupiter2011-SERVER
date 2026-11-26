// Jupiter Incident multiplayer server. Zero dependencies (Node 16+).
// Run: node server.js   (PORT sets the port, MAX_PLAYERS sets room size)
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080, MAX = +process.env.MAX_PLAYERS || 8;
const PUBLIC = path.join(__dirname, 'public');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(); // CODE -> { players: Map(id -> client), host: id, started: bool }
let nextId = 1;

/* ---------- HTTP: game file + room lookup ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (u.pathname === '/health') { res.end('ok'); return; }
  const m = u.pathname.match(/^\/room\/([A-Za-z0-9]{4})$/);
  if (m) {
    const r = rooms.get(m[1].toUpperCase());
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ exists: !!r, count: r ? r.players.size : 0, max: MAX, full: !!r && r.players.size >= MAX, colors: r ? [...r.players.values()].map(c => c.color) : [] }));
    return;
  }
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
const send = (c, o) => { if (c.sock.destroyed) return; const f = frame(JSON.stringify(o)); if (f) c.sock.write(f); };
const bcast = (room, o, except) => { for (const c of room.players.values()) if (c.id !== except) send(c, o); };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const colorDist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) };
const pub = c => ({ id: c.id, name: c.name, color: c.color, s: c.st });
/* Shared terminal state: room.terms[i] = { s: 'act'|'plug'|'clr'|'got', by: playerId }
   act = a wave is running (by = the player simulating the keys), plug = someone is copying the data,
   clr = wave cleared and waiting for a flash drive, got = data copied (counts for everyone). */
function dropTerms(room, id) {
  for (const k of Object.keys(room.terms)) {
    const t = room.terms[k];
    if (t.by !== id) continue;
    if (t.s === 'act') { delete room.terms[k]; bcast(room, { t: 'term', i: +k, s: 'reset' }); }
    else if (t.s === 'plug') { room.terms[k] = { s: 'clr', by: 0 }; bcast(room, { t: 'term', i: +k, s: 'clr', by: 0 }); }
  }
}

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
  const code = (u.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const create = u.searchParams.get('create') === '1';
  const name = (u.searchParams.get('name') || '').replace(/[^\w \-]/g, '').trim().slice(0, 16) || 'Player';
  let color = u.searchParams.get('color') || ''; if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#ffffff';
  const bad = s => sock.end('HTTP/1.1 ' + s + '\r\nConnection: close\r\n\r\n');
  if (!key || code.length !== 4) { sock.destroy(); return; }
  let room = rooms.get(code);
  if (create) { if (room) return bad('409 Code taken'); room = { players: new Map(), host: 0, started: false, co: false, terms: {} }; }
  else if (!room) return bad('404 No such lobby');
  if (room.players.size >= MAX) return bad('503 Lobby full');
  for (const o of room.players.values()) if (colorDist(o.color, color) < 80) return bad('409 Color taken');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: nextId++, name, color, sock, buf: Buffer.alloc(0), st: null, last: 0 };
  if (create) { rooms.set(code, room); room.host = c.id; }
  send(c, { t: 'welcome', id: c.id, room: code, host: room.host, started: room.started, co: room.co, terms: room.terms, players: [...room.players.values()].map(pub) });
  room.players.set(c.id, c);
  bcast(room, { t: 'join', id: c.id, name, color }, c.id);

  const leave = () => {
    if (!room.players.delete(c.id)) return;
    bcast(room, { t: 'leave', id: c.id });
    dropTerms(room, c.id);
    if (!room.players.size) { rooms.delete(code); return; }
    if (room.host === c.id) { room.host = Math.min(...room.players.keys()); bcast(room, { t: 'host', id: room.host }); }
  };
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
    if (m.t === 'state') {
      if (now - c.last < 30) return; c.last = now;
      const n = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
      c.st = { x: n(m.x), y: n(m.y), z: n(m.z), yaw: n(m.yaw), pitch: n(m.pitch), hp: n(m.hp), mode: String(m.mode || '').slice(0, 12), f: m.f ? 1 : 0, g: m.g ? 1 : 0, sf: m.sf ? 1 : 0, dn: m.dn ? 1 : 0, pc: m.pc ? 1 : 0 };
      bcast(room, { t: 'state', id: c.id, s: c.st }, c.id);
    } else if (m.t === 'keys') {
      if (now - (c.lastK || 0) < 70 || !Array.isArray(m.k)) return; c.lastK = now;
      bcast(room, { t: 'keys', id: c.id, k: m.k.slice(0, 60), w: Array.isArray(m.w) ? m.w.slice(0, 7).map(v => +v || 0) : undefined }, c.id);
    } else if (m.t === 'act' && ['talk', 'board', 'launch'].includes(m.a)) {
      bcast(room, { t: 'act', a: m.a, id: c.id }, c.id);
    } else if (m.t === 'khit') {
      const v = room.players.get(m.o); if (v) send(v, { t: 'khit', k: m.k, from: c.id, d: Math.max(1, Math.min(10, +m.d || 1)) });
    } else if (m.t === 'term' && room.started) {
      // Server decides who wins a race, then tells EVERYONE (including the requester).
      const i = m.i | 0, T = room.terms, cur = T[i];
      if (i < 0 || i > 4) return;
      const say = (s, by) => bcast(room, { t: 'term', i, s, by });
      if (m.s === 'start' && !cur) { T[i] = { s: 'act', by: c.id }; say('start', c.id); }
      else if (m.s === 'clr' && cur && cur.s === 'act' && cur.by === c.id) { T[i] = { s: 'clr', by: 0 }; say('clr', c.id); }
      else if (m.s === 'plug' && cur && (cur.s === 'clr' || (cur.s === 'plug' && Date.now() - cur.t > 20000))) { T[i] = { s: 'plug', by: c.id, t: Date.now() }; say('plug', c.id); }
      else if (m.s === 'got' && cur && cur.s === 'plug' && cur.by === c.id) { T[i] = { s: 'got', by: 0 }; say('got', c.id); }
      else if (m.s === 'abort' && cur && cur.by === c.id) {
        if (cur.s === 'act') { delete T[i]; say('reset', 0); }
        else if (cur.s === 'plug') { T[i] = { s: 'clr', by: 0 }; say('clr', 0); }
      }
    } else if (m.t === 'hurt') {
      const v = room.players.get(m.o), q = x => Math.max(-1, Math.min(1, +x || 0));
      if (v && v !== c) send(v, { t: 'hurt', d: Math.max(0, Math.min(3, +m.d || 0)), ux: q(m.ux), uz: q(m.uz) });
    } else if (m.t === 'start' && room.host === c.id) {
      room.terms = {}; room.started = true; room.co = !!m.co; bcast(room, { t: 'start', co: room.co });
    } else if (m.t === 'kick' && room.host === c.id && m.id !== c.id) {
      const v = room.players.get(m.id);
      if (v) { send(v, { t: 'kicked' }); setTimeout(() => v.sock.destroy(), 100); room.players.delete(v.id); bcast(room, { t: 'leave', id: v.id }); dropTerms(room, v.id); }
    }
  }
  sock.on('close', leave); sock.on('error', leave);
});
server.listen(PORT, () => console.log('Multiplayer server listening on port ' + PORT));
