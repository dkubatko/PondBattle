// Pond Battle — web server: players, lobbies, rooms, live updates and the page.
// Game rules are in engine.js, Telegram (launch data + bot) in telegram.js. No dependencies.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8420;
// Everything the server writes lives in DATA_DIR (a volume in Docker)
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const SAVE = process.env.ROOMS_FILE || path.join(DATA, 'rooms.json');
const PROFILES = path.join(DATA, 'profiles.json');
// Completed games, one JSON object per line, kept for future stats
const HISTORY = process.env.HISTORY_FILE || path.join(DATA, 'games.jsonl');
// Browser players without Telegram get a guest id (handy on the home network); ALLOW_GUESTS=0 turns that off
const GUESTS = process.env.ALLOW_GUESTS !== '0';
const E = require('./engine');
const TG = require('./telegram');
const { FROGS, FOODS, rand, frogCost, botShop } = E;

// ---------- Players ----------
// A player id is "tg<telegram id>" (checked with Telegram's signature) or "g<random>" for browser guests.
// The page gets the id plus a key (an HMAC of the id), and sends both back with every request.
const SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const keyFor = (uid) => crypto.createHmac('sha256', SECRET).update(uid).digest('hex').slice(0, 32);
const cleanUid = (u) => String(u || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
// The verified player id behind a request, or '' if the key doesn't match
function who(q) {
  const uid = cleanUid(q.uid), key = String(q.key || '');
  return uid && key.length === 32 && crypto.timingSafeEqual(Buffer.from(keyFor(uid)), Buffer.from(key)) ? uid : '';
}
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8')); } catch {}
let profTimer = null;
const saveProfiles = () => { clearTimeout(profTimer); profTimer = setTimeout(() => fs.writeFile(PROFILES, JSON.stringify(profiles), () => {}), 500); };
const profile = (uid) => profiles[uid] || { name: 'Frog', avatar: { b: 'classic', c: 0 } };
// Players on the same home network share a public address; that is how "nearby" ponds are found.
// Behind Cloudflare + Nginx Proxy Manager the real address arrives in CF-Connecting-IP / X-Forwarded-For.
function clientIp(req) {
  const h = req.headers;
  const ip = String(h['cf-connecting-ip'] || h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
  // Direct connections from the local network all count as one home
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$|f[cd])/i.test(ip) ? 'lan' : ip;
}

// ---------- Rooms ----------
let rooms = {};
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(SAVE, JSON.stringify(rooms), () => {}), 500); };

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Frog';
// Avatar: a frog body shape in one of 10 colours, plus eyes, pattern and accessory (the page draws them)
const AV_COLORS = 10, AV_BODIES = ['classic', 'slim', 'tall', 'round', 'toad', 'bull', 'tadpole'];
// Eyes, pattern and accessory are short option ids; the page owns the art and falls back to the default for unknown ids
const optId = (v, dflt) => (/^[a-z]{1,12}$/.test(String(v || '')) ? v : dflt);
const cleanAvatar = (a) => ({
  b: AV_BODIES.includes(a && a.b) ? a.b : 'classic', c: Math.max(0, Math.min(AV_COLORS - 1, (a && a.c) | 0)),
  e: optId(a && a.e, 'dark'), t: optId(a && a.t, 'none'), a: optId(a && a.a, 'none'),
});
function newPlayer(uid) {
  const pr = profile(uid);
  return { name: cleanName(pr.name), uid, avatar: cleanAvatar(pr.avatar), token: crypto.randomBytes(12).toString('hex'), ...E.newPlayerState() };
}
const resetGame = E.resetGame;
function code() {
  const L = 'BCDFGHJKLMNPQRSTVWXZ';
  let c; do c = Array.from({ length: 4 }, () => L[rand(L.length)]).join(''); while (rooms[c]);
  return c;
}

// The page carries a build id; clients reload themselves when it changes
const INDEX = path.join(__dirname, 'index.html');
let page = { mtime: -1, build: '', html: '' };
function currentPage() {
  const st = fs.statSync(INDEX);
  if (st.mtimeMs !== page.mtime) {
    const raw = fs.readFileSync(INDEX, 'utf8');
    const catalog = JSON.stringify(Object.fromEntries(Object.entries(FROGS).map(([k, f]) => [k, { name: f.name, tier: f.tier, atk: f.atk, hp: f.hp, cost: frogCost(k) }])));
    const items = JSON.stringify(FOODS);
    const build = crypto.createHash('sha1').update(raw + catalog + items).digest('hex').slice(0, 10);
    page = { mtime: st.mtimeMs, build, html: raw.replace('__BUILD__', build).replace('__CATALOG__', catalog.replace(/</g, '\\u003c')).replace('__ITEMS__', items.replace(/</g, '\\u003c')) };
  }
  return page;
}

// Live updates (Server-Sent Events)
const subs = new Map(); // room code -> Set<{ p, res }>
const online = (room, p) => !!p.bot || [...(subs.get(room.code) || [])].some((s) => s.p === p);

function view(room, me) {
  const i = room.players.indexOf(me), opp = room.players[1 - i];
  return {
    v: room.v, build: currentPage().build, code: room.code, round: room.round, phase: room.phase, seat: i, winner: room.winner, game: room.game,
    me: { name: me.name, avatar: me.avatar || cleanAvatar(), hearts: me.hearts, trophies: me.trophies, gold: me.gold, team: me.team, shop: me.shop, ready: me.ready },
    opp: opp ? { name: opp.name, avatar: opp.avatar || cleanAvatar(), bot: !!opp.bot, hearts: opp.hearts, trophies: opp.trophies, ready: opp.ready, online: online(room, opp) } : null,
    lastBattle: room.lastBattle,
  };
}
function broadcast(room) {
  for (const s of subs.get(room.code) || []) s.res.write(`data: ${JSON.stringify(view(room, s.p))}\n\n`);
}
// Ending a game removes it for both players; open phones get told and go back to the lobby
function endRoom(room, byName) {
  const msg = `data: ${JSON.stringify({ ended: true, by: byName })}\n\n`;
  const list = [...(subs.get(room.code) || [])];
  subs.delete(room.code);
  delete rooms[room.code];
  save();
  for (const s of list) { try { s.res.write(msg); s.res.end(); } catch {} }
}
function changed(room) { room.v++; room.touched = Date.now(); save(); broadcast(room); scheduleBot(room); nudge(room); }

// ---------- Telegram nudges ----------
// A Telegram player who isn't looking at the game gets one message per round when their partner is waiting
const tgId = (p) => (p && /^tg\d+$/.test(p.uid || '') ? p.uid.slice(2) : '');
function nudge(room) {
  if (room.practice || room.phase !== 'shop' || room.players.length < 2) return;
  room.players.forEach((p, i) => {
    const o = room.players[1 - i], id = tgId(p);
    if (!id || online(room, p) || p.ready || !o.ready) return;
    room.nudged = room.nudged || {};
    if (room.nudged[p.uid] === room.round) return;
    room.nudged[p.uid] = room.round;
    TG.notify(id, `${o.name} is ready for round ${room.round}. Your move! 🐸`, `?room=${room.code}`);
  });
}

// ---------- Practice: Pond Bot shops on its own, then readies up ----------
const botTimers = new Map(); // room code -> pending turn
function newBot() { const b = { ...newPlayer(''), name: 'Pond Bot', avatar: { b: 'round', c: 3 }, bot: true }; return b; }
function scheduleBot(room) {
  const bot = room.players.find((x) => x.bot);
  if (!bot || room.phase !== 'shop' || bot.ready || botTimers.has(room.code)) return;
  botTimers.set(room.code, setTimeout(() => {
    botTimers.delete(room.code);
    if (rooms[room.code] !== room || room.phase !== 'shop' || bot.ready) return;
    botShop(room, bot);
    act(room, bot, { type: 'ready' });
    changed(room);
  }, 1500 + rand(2000)));
}
const act = (room, p, a) => E.act(room, p, a);

// Finished games go to the history file (one JSON line each)
function recordGame(room) {
  if (HISTORY === 'off') return; // simulations
  const entry = {
    v: 1,
    id: crypto.randomBytes(6).toString('hex'),
    room: room.code,
    practice: !!room.practice,
    startedAt: room.gameStarted ? new Date(room.gameStarted).toISOString() : null,
    endedAt: new Date().toISOString(),
    rounds: room.round,
    winner: room.winner,
    players: room.players.map((p, i) => ({ uid: p.uid || null, name: p.name, avatar: p.avatar || null, bot: !!p.bot, won: room.winner === i, hearts: p.hearts, wins: p.trophies })),
    log: room.log || [],
  };
  fs.appendFile(HISTORY, JSON.stringify(entry) + '\n', (err) => { if (err) console.error('history write failed:', err.message); });
}
E.hooks.gameOver = recordGame;

// ---------- HTTP ----------
const STATIC = path.join(__dirname, 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function sendFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
function find(q) {
  const room = rooms[String(q.room || '').toUpperCase()];
  const p = room && room.players.find((x) => x.token === q.token);
  return { room, p };
}

function main() {
try { rooms = JSON.parse(fs.readFileSync(SAVE, 'utf8')); } catch {}
for (const r of Object.values(rooms)) for (const p of r.players) {
  for (const f of [...p.team, ...(p.shop?.frogs || [])]) if (f) E.bumpId(f.id + 1);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(currentPage().html);
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') return sendFile(res, path.join(STATIC, 'manifest.webmanifest'), 'no-cache');
    if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
      return sendFile(res, path.join(STATIC, path.basename(url.pathname)), 'public, max-age=86400');
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/lobby') {
      // Your own games, then open ponds: "nearby" = started from the same network as you, "open" = everyone else's
      const uid = who(Object.fromEntries(url.searchParams)), ip = clientIp(req), now = Date.now(), list = Object.values(rooms);
      const mine = (r) => !!uid && r.players.some((p) => p.uid === uid);
      const seat = (r, p) => ({ name: p.name, avatar: p.avatar || cleanAvatar(), online: online(r, p), bot: !!p.bot });
      const waiting = list.filter((r) => r.players.length === 1 && now - r.created < 6 * 3600e3).sort((x, y) => y.created - x.created);
      const pond = (r) => ({ code: r.code, mine: mine(r), seats: r.players.map((p) => seat(r, p)) });
      return json(res, 200, {
        nearby: waiting.filter((r) => mine(r) || r.ip === ip).map(pond),
        open: waiting.filter((r) => !mine(r) && r.ip !== ip).slice(0, 12).map(pond),
        active: list.filter((r) => r.players.length === 2 && r.phase !== 'over' && mine(r) && now - (r.touched || r.created) < 24 * 3600e3)
          .sort((x, y) => (y.touched || y.created) - (x.touched || x.created))
          .map((r) => ({ code: r.code, round: r.round, mine: true, practice: !!r.practice, seats: r.players.map((p) => seat(r, p)) })),
      });
    }
    if (url.pathname === '/api/state') {
      const { room, p } = find(Object.fromEntries(url.searchParams));
      if (!p) return json(res, 404, { error: 'not found' });
      return json(res, 200, view(room, p));
    }
    if (url.pathname === '/api/events') {
      const { room, p } = find(Object.fromEntries(url.searchParams));
      if (!p) return json(res, 404, { error: 'not found' });
      // X-Accel-Buffering: no stops Nginx (Proxy Manager) from holding the stream back
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      const sub = { p, res };
      if (!subs.has(room.code)) subs.set(room.code, new Set());
      subs.get(room.code).add(sub);
      broadcast(room); // sends our state and tells the partner we're here
      scheduleBot(room);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); subs.get(room.code)?.delete(sub); if (rooms[room.code]) broadcast(room); });
      return;
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const b = await body(req);
    if (url.pathname === '/api/me') {
      // Who is this? Telegram launch data wins; otherwise a returning or new browser guest
      const tg = TG.verifyInitData(b.initData);
      let uid = '';
      if (tg) {
        uid = `tg${tg.user.id}`;
        if (!profiles[uid]) profiles[uid] = { name: cleanName([tg.user.first_name, tg.user.last_name].filter(Boolean).join(' ')), avatar: cleanAvatar({ b: 'classic', c: tg.user.id % 10 }) };
      } else if (who(b) && cleanUid(b.uid).startsWith('g')) uid = cleanUid(b.uid);
      else if (GUESTS) uid = `g${crypto.randomBytes(10).toString('hex')}`;
      else return json(res, 401, { error: 'Open the game from Telegram' });
      const pr = profiles[uid] || (profiles[uid] = { name: '', avatar: cleanAvatar() }); // guests pick a name first
      pr.ip = clientIp(req); pr.seen = Date.now(); saveProfiles();
      return json(res, 200, { uid, key: keyFor(uid), name: pr.name, avatar: pr.avatar, telegram: !!tg, bot: TG.botUsername(), start: tg ? tg.startParam : '' });
    }
    // Everything below needs to know who is asking
    const uid = who(b);
    if (!uid) return json(res, 401, { error: 'Please reopen the game' });
    if (url.pathname === '/api/profile') {
      // Name and frog avatar follow you into every game you're in
      const pr = profiles[uid] || (profiles[uid] = {});
      pr.name = cleanName(b.name); pr.avatar = cleanAvatar(b.avatar); saveProfiles();
      for (const r of Object.values(rooms)) for (const p of r.players) if (p.uid === uid) { p.name = pr.name; p.avatar = pr.avatar; changed(r); }
      return json(res, 200, { name: pr.name, avatar: pr.avatar });
    }
    if (url.pathname === '/api/create') {
      // One waiting pond per player: starting again just takes you back to it
      const open = Object.values(rooms).find((r) => r.players.length === 1 && r.players[0].uid === uid);
      if (open) return json(res, 200, { room: open.code, token: open.players[0].token });
      const c = code(), p = newPlayer(uid);
      rooms[c] = { code: c, created: Date.now(), v: 1, ip: clientIp(req), players: [p] };
      resetGame(rooms[c]); save();
      return json(res, 200, { room: c, token: p.token });
    }
    if (url.pathname === '/api/practice') {
      const c = code(), p = newPlayer(uid);
      rooms[c] = { code: c, created: Date.now(), v: 1, practice: true, players: [p, newBot()] };
      resetGame(rooms[c]); changed(rooms[c]);
      return json(res, 200, { room: c, token: p.token });
    }
    if (url.pathname === '/api/join') {
      const room = rooms[String(b.room || '').toUpperCase()];
      if (!room) return json(res, 404, { error: 'No pond with that code' });
      // Joining a pond you're already in just puts you back in your own seat
      const own = room.players.find((x) => x.uid === uid);
      if (own) return json(res, 200, { room: room.code, token: own.token });
      if (room.players.length >= 2 || room.practice) return json(res, 409, { error: 'That pond is full' });
      const p = newPlayer(uid), host = room.players[0];
      room.players.push(p); resetGame(room); changed(room);
      if (tgId(host) && !online(room, host)) TG.notify(tgId(host), `${p.name} joined your pond! 🐸`, `?room=${room.code}`);
      return json(res, 200, { room: room.code, token: p.token });
    }
    if (url.pathname === '/api/rejoin') {
      const room = rooms[String(b.room || '').toUpperCase()], p = room && room.players.find((x) => x.uid === uid);
      if (!p) return json(res, 404, { error: 'That game has ended' });
      return json(res, 200, { room: room.code, token: p.token });
    }
    if (url.pathname === '/api/end') {
      // Only a player in the pond can end it
      const room = rooms[String(b.room || '').toUpperCase()], p = room && room.players.find((x) => x.uid === uid);
      if (p) endRoom(room, p.name);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/action') {
      const { room, p } = find(b);
      if (!p) return json(res, 404, { error: 'not found' });
      act(room, p, b.action || {});
      changed(room);
      return json(res, 200, view(room, p));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`🐸 Pond Battle on :${PORT}`));
TG.start().catch((e) => console.error('telegram:', e.message));

setTimeout(() => Object.values(rooms).forEach(scheduleBot), 1000);

// Tell connected phones when the page itself changes, so they pick up the new version
fs.watchFile(INDEX, { interval: 2000 }, () => { for (const r of Object.values(rooms)) broadcast(r); });

// Write ponds out before exiting so a restart never loses a move
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { fs.writeFileSync(SAVE, JSON.stringify(rooms)); fs.writeFileSync(PROFILES, JSON.stringify(profiles)); } catch (e) { console.error(e); } process.exit(0); });

// Drop rooms older than 2 days
setInterval(() => { const now = Date.now(); for (const c in rooms) if (now - rooms[c].created > 2 * 86400e3) delete rooms[c]; save(); }, 3600e3);
}

main();
