// Pond Brawl — web server: players, lobbies, rooms, live updates and the page.
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
const DEV_STATE = process.env.DEV_STATE === '1'; // tools/screen.py only (see /api/dev/state)
const E = require('./engine');
const TG = require('./telegram');
const R = require('./ranks');
const { FROGS, FOODS, SETS, rand, frogCost, botShop } = E;
// The set a new pond plays (sent by the page); unknown ids get the first set
const cleanSet = (v) => (SETS[v] ? v : E.DEFAULT_SET);

// ---------- Players ----------
// A player id is "tg<telegram id>" (checked with Telegram's signature) or "g<random>" for browser guests.
// The page gets the id plus a key (an HMAC of the id), and sends both back with every request.
const SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const keyFor = (uid) => crypto.createHmac('sha256', SECRET).update(uid).digest('hex').slice(0, 32);
const cleanUid = (u) => String(u || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
// Other players are shown by a public id (pid), never by their Telegram id
const pids = new Map(); // pid -> uid
const pidOf = (uid) => { const pid = crypto.createHmac('sha256', SECRET).update('pid:' + uid).digest('hex').slice(0, 12); pids.set(pid, uid); return pid; };
const uidOf = (pid) => pids.get(pid) || Object.keys(profiles).find((u) => pidOf(u) === pid) || '';
// The verified player id behind a request, or '' if the key doesn't match
function who(q) {
  const uid = cleanUid(q.uid), key = String(q.key || '');
  return uid && key.length === 32 && crypto.timingSafeEqual(Buffer.from(keyFor(uid)), Buffer.from(key)) ? uid : '';
}
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8')); } catch {}
// Saving: at most every half second, and never put off for good by steady play (a debounce would never fire while
// changes keep coming). Written to a temporary file and renamed over the old one, so a crash mid-write can't leave
// half a file; one write at a time (a change during a write is saved right after it).
function saver(file, data) {
  let timer = null, writing = false, again = false;
  const schedule = () => { if (!timer) timer = setTimeout(write, 500); };
  const write = () => {
    timer = null;
    if (writing) { again = true; return; }
    writing = true;
    const done = (e) => { writing = false; if (e) console.error(e); if (again) { again = false; schedule(); } };
    fs.writeFile(file + '.tmp', JSON.stringify(data()), (e) => (e ? done(e) : fs.rename(file + '.tmp', file, done)));
  };
  return schedule;
}
const saveProfiles = saver(PROFILES, () => profiles);
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
const save = saver(SAVE, () => rooms);

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Frog';
// Avatar: a frog body shape in one of 13 colors or 5 gradients, plus eyes, pattern, accessory and a lily pad (the page draws them)
const PAD_COLORS = 12, AV_COLORS = 18, AV_BODIES = ['classic', 'slim', 'tall', 'round', 'toad', 'bull', 'flat', 'tadpole'];
// Eyes, pattern and accessory are short option ids; the page owns the art and falls back to the default for unknown ids
const optId = (v, dflt) => (/^[a-z]{1,12}$/.test(String(v || '')) ? v : dflt);
const cleanAvatar = (a) => ({
  b: AV_BODIES.includes(a && a.b) ? a.b : 'classic', c: Math.max(0, Math.min(AV_COLORS - 1, (a && a.c) | 0)),
  m: optId(a && a.m, 'smile'), e: optId(a && a.e, 'dark'), t: optId(a && a.t, 'none'),
  // extras, one per slot (an avatar from before slots has one extra, `a`: it goes to its slot)
  ...Object.fromEntries(Object.entries(R.EXTRAS).map(([k, ids]) => { const v = a && (a[k] === undefined ? a.a : a[k]); return [k, ids.includes(v) ? v : 'none']; })),
  // lily pad: style id and color (one of PAD_COLORS on the page)
  l: optId(a && a.l, 'classic'), lc: Math.max(0, Math.min(PAD_COLORS - 1, (a && a.lc) | 0)),
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
    const catalog = JSON.stringify(Object.fromEntries(Object.entries(FROGS).map(([k, f]) => [k, { name: f.name, tier: f.tier, atk: f.atk, hp: f.hp, cost: frogCost(k), ...(f.fixed ? { fixed: f.fixed } : {}) }])));
    const items = JSON.stringify(FOODS), sets = JSON.stringify(SETS), unlocks = JSON.stringify({ unlocks: R.UNLOCKS, extras: R.EXTRAS });
    const build = crypto.createHash('sha1').update(raw + catalog + items + sets + unlocks).digest('hex').slice(0, 10);
    page = { mtime: st.mtimeMs, build, html: raw.replace('__BUILD__', build).replace('__CATALOG__', catalog.replace(/</g, '\\u003c')).replace('__ITEMS__', items.replace(/</g, '\\u003c')).replace('__SETS__', sets.replace(/</g, '\\u003c')).replace('__UNLOCKS__', unlocks) };
  }
  return page;
}

// Live updates (Server-Sent Events)
const subs = new Map(); // room code -> Set<{ p, res }>
const online = (room, p) => !!p.bot || [...(subs.get(room.code) || [])].some((s) => s.p === p);

// Ranked games show both players' ranks, and after the game how many rank points you won or lost
const rankView = (room, p) => (room.ranked ? { rank: R.rankOf(p.uid, profiles), ...(p.delta != null ? { delta: p.delta, prev: p.prevRank } : {}) } : {});
// have: the id of the last battle this reader already holds; it's big (every frame of the battle), so it's only sent
// when it's new to them. lastBattleId always says which one it is.
function view(room, me, have) {
  const i = room.players.indexOf(me), opp = room.players[1 - i];
  return {
    v: room.v, build: currentPage().build, code: room.code, set: E.setOf(room), round: room.round, phase: room.phase, seat: i, winner: room.winner, game: room.game, ranked: !!room.ranked,
    me: { name: me.name, avatar: me.avatar || cleanAvatar(), hearts: me.hearts, trophies: me.trophies, gold: me.gold, team: me.team, shop: me.shop, ready: me.ready, fx: me.fx || [], ...rankView(room, me) },
    opp: opp ? { name: opp.name, avatar: opp.avatar || cleanAvatar(), bot: !!opp.bot, ...(opp.uid ? { pid: pidOf(opp.uid) } : {}), hearts: opp.hearts, trophies: opp.trophies, ready: opp.ready, online: online(room, opp), ...(room.ranked ? { rank: R.rankOf(opp.uid, profiles) } : {}), ...(opp.react ? { react: opp.react } : {}) } : null,
    ...(room.lastBattle && have && room.lastBattle.id === have ? {} : { lastBattle: room.lastBattle }), lastBattleId: room.lastBattle ? room.lastBattle.id : null,
    // The ready clock: whether it's you on it, and how long is left (the page counts down from here)
    clock: room.clock ? { mine: room.clock.seat === i, left: Math.max(0, room.clock.until - Date.now()), total: READY_CLOCK_MS } : null,
    // a pond waiting for the friend you challenged
    ...(room.invited && room.players.length === 1 ? { invited: (profiles[room.invited] && profiles[room.invited].name) || 'your friend' } : {}),
  };
}
// The emoji a player can send (the page shows the same list); the Pond Bot picks from the friendly ones
const REACTIONS = ['😂', '👀', '🔥', '😡', '🐸'];
const BOT_REACTIONS = ['😂', '👀', '🔥', '🐸'];
function broadcast(room) {
  for (const s of subs.get(room.code) || []) { s.res.write(`data: ${JSON.stringify(view(room, s.p, s.have))}\n\n`); s.have = room.lastBattle && room.lastBattle.id; }
}
// Ending a game removes it for both players; open phones get told and go back to the lobby
function endRoom(room, byName, extra) {
  const msg = `data: ${JSON.stringify({ ended: true, by: byName, ...extra })}\n\n`;
  const list = [...(subs.get(room.code) || [])];
  subs.delete(room.code);
  delete rooms[room.code];
  save();
  for (const s of list) { try { s.res.write(msg); s.res.end(); } catch {} }
}
function changed(room) { setClock(room); room.v++; room.touched = Date.now(); save(); broadcast(room); scheduleBot(room); }

// ---------- Telegram ----------
// A Telegram player's chat id (players are "tg<id>"), or '' for guests and the bot
const tgId = (p) => (p && /^tg\d+$/.test(p.uid || '') ? p.uid.slice(2) : '');

// ---------- Ready clock ----------
// In a game between two players (ranked or a custom pond; not practice), once one of them is ready the other has
// READY_CLOCK_MS to finish shopping; then they're readied with the pond they have, so nobody can hold a game up.
// room.clock = { seat: who's on the clock, round, until: ms timestamp } (saved with the room, so it survives restarts)
const READY_CLOCK_MS = +process.env.READY_CLOCK_MS || 60e3;
const clockTimers = new Map(); // room code -> timeout
function setClock(room) {
  const waiting = room.players.filter((p) => !p.ready);
  const on = room.players.length === 2 && !room.players.some((p) => p.bot) && room.phase === 'shop' && waiting.length === 1;
  if (!on) { delete room.clock; clearTimeout(clockTimers.get(room.code)); clockTimers.delete(room.code); return; }
  const seat = room.players.indexOf(waiting[0]);
  if (!room.clock || room.clock.seat !== seat || room.clock.round !== room.round) {
    room.clock = { seat, round: room.round, until: Date.now() + READY_CLOCK_MS };
    armClock(room);
  }
}
function armClock(room) {
  clearTimeout(clockTimers.get(room.code));
  const { seat, round, until } = room.clock;
  clockTimers.set(room.code, setTimeout(() => {
    clockTimers.delete(room.code);
    const p = room.players[seat];
    if (rooms[room.code] !== room || !room.clock || room.clock.round !== round || room.phase !== 'shop' || !p || p.ready) return;
    act(room, p, { type: 'ready' });
    changed(room);
  }, Math.max(0, until - Date.now())));
}

// ---------- Practice: Pond Bot shops on its own, then readies up ----------
const botTimers = new Map(); // room code -> pending turn
function newBot() { const b = { ...newPlayer(''), name: 'Pond Bot', avatar: { b: 'round', c: 3, l: 'dew', lc: 3 }, bot: true }; return b; }
// How long the Pond Bot "thinks" before it's ready; BOT_DELAY_MS sets a fixed delay (tools/look.py uses 0)
const BOT_DELAY = process.env.BOT_DELAY_MS ? +process.env.BOT_DELAY_MS : null;
function scheduleBot(room) {
  const bot = room.players.find((x) => x.bot);
  if (!bot || room.phase !== 'shop' || bot.ready || botTimers.has(room.code)) return;
  botTimers.set(room.code, setTimeout(() => {
    botTimers.delete(room.code);
    if (rooms[room.code] !== room || room.phase !== 'shop' || bot.ready) return;
    botShop(room, bot);
    act(room, bot, { type: 'ready' });
    changed(room);
  }, BOT_DELAY ?? 1500 + rand(2000)));
}
const act = (room, p, a) => E.act(room, p, a);

// A ranked game gives or takes rank points once (p.delta and p.prevRank are shown on the game-over screen)
function rateGame(room) {
  if (!room.ranked || room.rated || room.winner == null || room.winner < 0) return;
  room.rated = true;
  const pr = room.players.map((p) => profiles[p.uid] || (profiles[p.uid] = { name: p.name, avatar: p.avatar }));
  const lv = pr.map(R.level);
  room.players.forEach((p) => { p.prevRank = R.rankOf(p.uid, profiles).id; });
  room.players.forEach((p, i) => {
    const now = R.apply(lv[i], R.points(lv[i], lv[1 - i], room.winner === i));
    p.delta = now - lv[i];
    Object.assign(pr[i], { level: now, rgames: (pr[i].rgames | 0) + 1, rwins: (pr[i].rwins | 0) + (room.winner === i ? 1 : 0) }, p.delta ? { levelAt: Date.now() } : {});
  });
  R.forget(); saveProfiles();
}
// Finished games go to the history file (one JSON line each); the profile's match history is read from it
function recordGame(room) {
  rateGame(room);
  if (HISTORY === 'off') return; // simulations
  const entry = {
    v: 1,
    id: crypto.randomBytes(6).toString('hex'),
    room: room.code,
    set: E.setOf(room),
    practice: !!room.practice,
    ...(room.ranked ? { ranked: true } : {}),
    ...(room.forfeit != null ? { forfeit: room.forfeit } : {}), // the seat that left the game
    startedAt: room.gameStarted ? new Date(room.gameStarted).toISOString() : null,
    endedAt: new Date().toISOString(),
    rounds: room.round,
    winner: room.winner,
    players: room.players.map((p, i) => ({ uid: p.uid || null, name: p.name, avatar: p.avatar || null, bot: !!p.bot, won: room.winner === i, hearts: p.hearts, wins: p.trophies,
      ...(p.delta != null ? { level: R.level(profiles[p.uid]), delta: p.delta } : {}) })),
    log: room.log || [],
  };
  indexGame(entry);
  fs.appendFile(HISTORY, JSON.stringify(entry) + '\n', (err) => { if (err) console.error('history write failed:', err.message); });
}
E.hooks.gameOver = recordGame;
// Each player's past games, newest last: uid -> [{ at, set, ranked, won, hearts, rounds, delta, left, opp }]
const played = new Map();
function indexGame(e) {
  if (e.practice) return; // practice games against Pond Bot aren't part of your record
  e.players.forEach((p, i) => {
    if (!p.uid) return;
    const o = e.players[1 - i] || {};
    if (!played.has(p.uid)) played.set(p.uid, []);
    played.get(p.uid).push({ at: e.endedAt, set: e.set, ranked: !!e.ranked, won: !!p.won, hearts: p.hearts, rounds: e.rounds,
      ...(p.delta != null ? { delta: p.delta } : {}), ...(e.forfeit != null ? { left: e.forfeit === i ? 'me' : 'opp' } : {}),
      opp: { name: o.name || 'Frog', avatar: o.avatar || cleanAvatar(), uid: o.uid || '' } });
  });
}
// Leaving a ranked game early is a loss (a forfeit), once the other player has shown up in it
function forfeit(room, p) {
  const i = room.players.indexOf(p);
  if (!room.ranked || room.phase === 'over' || room.players.length < 2 || !(room.came || [])[1 - i]) return null;
  room.phase = 'over'; room.winner = 1 - i; room.forfeit = i;
  recordGame(room);
  return { forfeit: true, delta: room.players[1 - i].delta };
}

// ---------- Friends ----------
// On each profile: friends, asked (requests you sent) and askedBy (requests sent to you), each { uid: when }; both
// sides are always changed together. muteFriends: no "your friend is looking for a game" notes.
// Notes on Telegram: a friend request, a challenge, and a ranked search (each friend at most once an hour).
const FRIENDS_MAX = 100, PING_GAP = 3600e3;
const seenAt = new Map(); // uid -> when they last asked the server anything (who is online)
const pinged = new Map(); // "from>to" -> when a note last went (requests and search alerts)
const book = (uid, k) => { const pr = profiles[uid] || (profiles[uid] = {}); return (pr[k] = pr[k] || {}); }; // to change
const seen = (uid, k) => (profiles[uid] && profiles[uid][k]) || {}; // to read (adds nothing to the profile)
const friendsOf = (uid) => Object.keys(seen(uid, 'friends'));
const isFriend = (a, b) => !!seen(a, 'friends')[b];
// You and them: 'friends', 'sent' (you asked them), 'got' (they asked you) or ''
const friendship = (a, b) => (isFriend(a, b) ? 'friends' : seen(a, 'asked')[b] ? 'sent' : seen(a, 'askedBy')[b] ? 'got' : '');
const searching = (uid) => { const q = queue.get(uid); return !!q && Date.now() - q.seen < QUEUE_STALE; };
const playing = (uid) => Object.values(rooms).some((r) => r.players.length === 2 && !r.practice && r.phase !== 'over' && r.players.some((p) => p.uid === uid && online(r, p)));
// What a friend is up to: 'searching' (for a ranked game), 'playing', 'online' (the app is open) or 'offline'
const statusOf = (uid) => (searching(uid) ? 'searching' : playing(uid) ? 'playing' : Date.now() - (seenAt.get(uid) || 0) < 45e3 ? 'online' : 'offline');
const person = (uid) => ({ pid: pidOf(uid), name: (profiles[uid] && profiles[uid].name) || 'Frog', avatar: cleanAvatar(profiles[uid] && profiles[uid].avatar), rank: R.rankOf(uid, profiles) });
// A note to someone, once per gap for the same sender and kind
function ping(from, to, kind, text, query, button, gap = PING_GAP) {
  const k = `${kind}:${from}>${to}`, now = Date.now();
  if (!tgId({ uid: to }) || now - (pinged.get(k) || 0) < gap) return false;
  pinged.set(k, now); TG.notify(tgId({ uid: to }), text, query, button);
  return true;
}
// Starting a ranked search tells your friends who aren't playing or searching already (unless they muted it)
function pingFriends(uid) {
  const name = (profiles[uid] && profiles[uid].name) || 'A friend';
  for (const f of friendsOf(uid)) {
    if ((profiles[f] && profiles[f].muteFriends) || searching(f) || playing(f)) continue;
    ping(uid, f, 'search', `${name} is searching for a game, join them in a pond battle! 🐸`, `?play=${pidOf(uid)}`, 'Join them');
  }
}
function befriend(a, b) {
  delete book(a, 'asked')[b]; delete book(a, 'askedBy')[b]; delete book(b, 'asked')[a]; delete book(b, 'askedBy')[a];
  book(a, 'friends')[b] = book(b, 'friends')[a] = Date.now();
}

// ---------- Matchmaking: "Play" finds another player looking for a game in the same set (or any set) ----------
// Players stay in the queue while their page keeps asking (every ~1.5 s). The closest level is picked; the
// allowed gap grows the longer either player has been waiting, so after half a minute or so anyone will do.
const queue = new Map(); // uid -> { set: set id or 'any', since, seen }
const matched = new Map(); // uid -> { room, token }: a game found for someone whose page hasn't asked since
const QUEUE_STALE = 8000, reach = (ms) => 2 + ms / 1000 / 2; // levels apart
function findMatch(uid, pref) {
  const now = Date.now();
  for (const [u, q] of queue) if (now - q.seen > QUEUE_STALE) queue.delete(u);
  let me = queue.get(uid);
  if (!me || me.set !== pref) me = { set: pref, since: now };
  me.seen = now; queue.set(uid, me);
  const r = R.level(profiles[uid]);
  let best = null, gap = Infinity;
  for (const [u, q] of queue) {
    if (u === uid || !(q.set === pref || q.set === 'any' || pref === 'any')) continue;
    // a friend who is looking too is picked first, whatever their level; otherwise the closest level
    const g = isFriend(uid, u) ? -1 : Math.abs(R.level(profiles[u]) - r);
    if ((g < 0 || g <= reach(now - Math.min(q.since, me.since))) && g < gap) { best = u; gap = g; }
  }
  if (!best) return null;
  const other = queue.get(best);
  queue.delete(uid); queue.delete(best);
  const set = pref !== 'any' ? pref : other.set !== 'any' ? other.set : Object.keys(SETS)[rand(Object.keys(SETS).length)];
  const c = code(), a = newPlayer(best), b = newPlayer(uid); // whoever waited longer takes the first seat
  rooms[c] = { code: c, created: now, v: 1, set, ranked: true, players: [a, b] };
  resetGame(rooms[c]); changed(rooms[c]);
  matched.set(best, { room: c, token: a.token });
  return { room: c, token: b.token };
}

// ---------- HTTP ----------
const STATIC = path.join(__dirname, 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
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
try { for (const line of fs.readFileSync(HISTORY, 'utf8').split('\n')) if (line.trim()) try { indexGame(JSON.parse(line)); } catch {} } catch {}
for (const r of Object.values(rooms)) for (const p of r.players) {
  for (const f of [...p.team, ...(p.shop?.frogs || [])]) if (f) E.bumpId(f.id + 1);
}
for (const r of Object.values(rooms)) if (r.clock) armClock(r); // clocks that were running before a restart

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
    // commit: the git commit this image was built from ('dev' outside the image); page: the page build clients see
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, commit: process.env.COMMIT || 'dev', page: currentPage().build });
    if (url.pathname === '/api/lobby') {
      // Your own games, then ponds waiting on the same network as you ("nearby"). Ponds from other networks are
      // not listed; those are joined by invite, and strangers meet through Play (matchmaking)
      const uid = who(Object.fromEntries(url.searchParams)), ip = clientIp(req), now = Date.now(), list = Object.values(rooms);
      if (uid) seenAt.set(uid, now);
      const mine = (r) => !!uid && r.players.some((p) => p.uid === uid);
      const seat = (r, p) => ({ name: p.name, avatar: p.avatar || cleanAvatar(), online: online(r, p), bot: !!p.bot });
      const waiting = list.filter((r) => r.players.length === 1 && now - r.created < 6 * 3600e3).sort((x, y) => y.created - x.created);
      const pond = (r) => ({ code: r.code, set: E.setOf(r), mine: mine(r), seats: r.players.map((p) => seat(r, p)) });
      return json(res, 200, {
        nearby: waiting.filter((r) => (mine(r) || r.ip === ip) && r.invited !== uid).map(pond),
        // ponds a friend challenged you to, and how many friend requests are waiting for you
        challenges: uid ? waiting.filter((r) => r.invited === uid).map(pond) : [],
        requests: uid ? Object.keys(seen(uid, 'askedBy')).length : 0,
        active: list.filter((r) => r.players.length === 2 && r.phase !== 'over' && mine(r) && now - (r.touched || r.created) < 24 * 3600e3)
          .sort((x, y) => (y.touched || y.created) - (x.touched || x.created))
          .map((r) => ({ code: r.code, set: E.setOf(r), round: r.round, mine: true, practice: !!r.practice, ranked: !!r.ranked, seats: r.players.map((p) => seat(r, p)) })),
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
      (room.came = room.came || [])[room.players.indexOf(p)] = true;
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
        // New players are called by their first name. Names that were auto-filled with the full name earlier
        // become the first name too; names someone chose themselves are left alone.
        const first = cleanName(tg.user.first_name), full = cleanName([tg.user.first_name, tg.user.last_name].filter(Boolean).join(' '));
        const open = [...Array(AV_COLORS).keys()].filter((c) => !R.needs('c', c)); // a random color new players can wear
        if (!profiles[uid]) profiles[uid] = { name: first, avatar: cleanAvatar({ b: 'classic', c: open[tg.user.id % open.length] }) };
        else if (tg.user.last_name && profiles[uid].name === full && full !== first) {
          profiles[uid].name = first;
          for (const r of Object.values(rooms)) for (const p of r.players) if (p.uid === uid) { p.name = first; changed(r); }
        }
      } else if (who(b) && cleanUid(b.uid).startsWith('g')) uid = cleanUid(b.uid);
      else if (GUESTS) uid = `g${crypto.randomBytes(10).toString('hex')}`;
      else return json(res, 401, { error: 'Open the game from Telegram' });
      const pr = profiles[uid] || (profiles[uid] = { name: '', avatar: cleanAvatar() }); // guests pick a name first
      // Options your rank hasn't earned go back to the default (avatars made before ranks, or a Frog Legend who
      // dropped out of the top 10); the games you're in get the new look too
      const fit = R.fitAvatar(cleanAvatar(pr.avatar), R.rankOf(uid, profiles).id);
      if (JSON.stringify(fit) !== JSON.stringify(cleanAvatar(pr.avatar))) {
        pr.avatar = fit;
        for (const r of Object.values(rooms)) for (const p of r.players) if (p.uid === uid) { p.avatar = fit; changed(r); }
      }
      pr.ip = clientIp(req); pr.seen = Date.now(); saveProfiles();
      return json(res, 200, { uid, key: keyFor(uid), pid: pidOf(uid), name: pr.name, avatar: pr.avatar, rank: R.rankOf(uid, profiles), telegram: !!tg, bot: TG.botUsername(), start: tg ? tg.startParam : '',
        dm: !!(tg && tg.user.allows_write_to_pm), muteFriends: !!pr.muteFriends });
    }
    // Everything below needs to know who is asking
    const uid = who(b);
    if (!uid) return json(res, 401, { error: 'Please reopen the game' });
    seenAt.set(uid, Date.now());
    if (url.pathname === '/api/profile') {
      // Name and frog avatar follow you into every game you're in
      const pr = profiles[uid] || (profiles[uid] = {});
      pr.name = cleanName(b.name); pr.avatar = R.fitAvatar(cleanAvatar(b.avatar), R.rankOf(uid, profiles).id); saveProfiles(); // only options your rank has earned
      for (const r of Object.values(rooms)) for (const p of r.players) if (p.uid === uid) { p.name = pr.name; p.avatar = pr.avatar; changed(r); }
      return json(res, 200, { name: pr.name, avatar: pr.avatar });
    }
    if (url.pathname === '/api/card') {
      // A profile (yours, or another player's by pid): rank, a few numbers and recent games (practice doesn't count)
      const of = b.of ? uidOf(String(b.of)) : uid, pr = profiles[of];
      if (!of || !pr) return json(res, 404, { error: 'No such player' });
      const games = played.get(of) || [];
      return json(res, 200, {
        pid: pidOf(of), mine: of === uid, name: pr.name || 'Frog', avatar: cleanAvatar(pr.avatar), ...(of !== uid ? { friend: friendship(uid, of) } : {}),
        rank: R.rankOf(of, profiles),
        stats: { played: games.length, won: games.filter((g) => g.won).length },
        history: games.slice(-30).reverse().map(({ opp: { uid: ou, ...o }, ...g }) => ({ ...g, opp: { ...o, ...(ou ? { pid: pidOf(ou) } : {}) } })),
      });
    }
    if (url.pathname === '/api/leaders') {
      // The global leaderboard: the top 50 ranked players, and where you are if you're further down
      const all = R.board(profiles), row = (u, i) => ({ pos: i + 1, pid: pidOf(u), name: profiles[u].name || 'Frog', avatar: cleanAvatar(profiles[u].avatar), rank: R.rankOf(u, profiles), me: u === uid });
      const at = all.indexOf(uid);
      return json(res, 200, { top: all.slice(0, 50).map(row), ...(at >= 50 ? { me: row(uid, at) } : {}) });
    }
    if (url.pathname === '/api/play') {
      // Looking for a game: { room, token } once matched, else { waiting: true } (ask again in a moment)
      const found = matched.get(uid);
      if (found) { matched.delete(uid); return json(res, 200, found); }
      const fresh = !searching(uid), m = findMatch(uid, b.set === 'any' ? 'any' : cleanSet(b.set));
      if (!m && fresh) pingFriends(uid);
      // others: how many other players are looking for a game right now (any set), shown while you wait
      return json(res, 200, m || { waiting: true, others: [...queue.keys()].filter((u) => u !== uid).length });
    }
    if (url.pathname === '/api/play/cancel') {
      // Too late if a game was found meanwhile: then you get it (the page goes straight in)
      const found = matched.get(uid);
      if (found) { matched.delete(uid); return json(res, 200, found); }
      queue.delete(uid);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/friends') {
      // Your friends (with what they're up to), requests sent to you and requests you sent
      const order = { searching: 0, online: 1, playing: 2, offline: 3 };
      const friends = friendsOf(uid).map((u) => ({ ...person(u), status: statusOf(u) }))
        .sort((x, y) => order[x.status] - order[y.status] || x.name.localeCompare(y.name));
      const listOf = (k) => Object.entries(seen(uid, k)).sort((x, y) => y[1] - x[1]).map(([u]) => person(u));
      return json(res, 200, { me: pidOf(uid), friends, incoming: listOf('askedBy'), outgoing: listOf('asked'), muteFriends: !!profiles[uid].muteFriends });
    }
    if (url.pathname === '/api/friends/act') {
      // add (or accept, if they already asked you), accept, decline, cancel (your request) or remove
      const other = uidOf(String(b.pid || '')), act = String(b.act || '');
      if (!other || !profiles[other] || other === uid) return json(res, 404, { error: 'No such player' });
      const was = friendship(uid, other);
      if (act === 'add' || act === 'accept') {
        if (was === 'got') befriend(uid, other);
        else if (act === 'add' && !was) {
          if (friendsOf(uid).length >= FRIENDS_MAX || friendsOf(other).length >= FRIENDS_MAX) return json(res, 409, { error: `A frog can have up to ${FRIENDS_MAX} friends` });
          if (Object.keys(seen(uid, 'asked')).length >= FRIENDS_MAX) return json(res, 409, { error: 'Too many requests waiting' });
          book(uid, 'asked')[other] = book(other, 'askedBy')[uid] = Date.now();
          ping(uid, other, 'ask', `${profiles[uid].name || 'A frog'} wants to be your friend in Pond Brawl 🐸`, '?friends=1', 'See request');
        }
      } else if (act === 'decline' || act === 'cancel') {
        const [from, to] = act === 'decline' ? [other, uid] : [uid, other];
        delete book(from, 'asked')[to]; delete book(to, 'askedBy')[from];
      } else if (act === 'remove') {
        delete book(uid, 'friends')[other]; delete book(other, 'friends')[uid];
      } else return json(res, 400, { error: 'Unknown action' });
      saveProfiles();
      return json(res, 200, { friend: friendship(uid, other) });
    }
    if (url.pathname === '/api/friends/mute') {
      profiles[uid].muteFriends = !!b.on; saveProfiles();
      return json(res, 200, { muteFriends: !!b.on });
    }
    if (url.pathname === '/api/friends/link') {
      // "Add me as a friend" card for Telegram's share sheet
      if (!tgId({ uid })) return json(res, 404, { error: 'No Telegram here' });
      const id = await TG.prepareFriendLink(tgId({ uid }), pidOf(uid), profiles[uid].name || 'me');
      return id ? json(res, 200, { id }) : json(res, 502, { error: 'Telegram said no' });
    }
    if (url.pathname === '/api/challenge') {
      // Challenge a friend: your waiting pond (made, or the one you have) is theirs to join; they get a note and see
      // it on their home page
      const other = uidOf(String(b.pid || ''));
      if (!other || !isFriend(uid, other)) return json(res, 404, { error: 'Only friends can be challenged' });
      const set = cleanSet(b.set);
      let room = Object.values(rooms).find((r) => r.players.length === 1 && r.players[0].uid === uid);
      if (room) { if (E.setOf(room) !== set) { room.set = set; resetGame(room); } }
      else { const c = code(); room = rooms[c] = { code: c, created: Date.now(), v: 1, set, ip: clientIp(req), players: [newPlayer(uid)] }; resetGame(room); }
      room.invited = other; changed(room);
      const sent = ping(uid, other, `challenge-${room.code}`, `${profiles[uid].name || 'A friend'} challenged you to a pond battle! 🐸`, `?join=${room.code}`, 'Join the pond', 0);
      return json(res, 200, { room: room.code, token: room.players[0].token, notified: sent });
    }
    if (url.pathname === '/api/create') {
      // One waiting pond per player: starting again just takes you back to it (with the set picked this time)
      const set = cleanSet(b.set);
      const open = Object.values(rooms).find((r) => r.players.length === 1 && r.players[0].uid === uid);
      if (open) {
        if (open.invited) { delete open.invited; changed(open); } // a lobby made from the Lobby page is for anyone
        if (E.setOf(open) !== set) { open.set = set; resetGame(open); changed(open); }
        return json(res, 200, { room: open.code, token: open.players[0].token });
      }
      const c = code(), p = newPlayer(uid);
      rooms[c] = { code: c, created: Date.now(), v: 1, set, ip: clientIp(req), players: [p] };
      resetGame(rooms[c]); save();
      return json(res, 200, { room: c, token: p.token });
    }
    if (url.pathname === '/api/practice') {
      const c = code(), p = newPlayer(uid);
      rooms[c] = { code: c, created: Date.now(), v: 1, set: cleanSet(b.set), practice: true, players: [p, newBot()] };
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
    if (url.pathname === '/api/invite') {
      // Telegram invite card for your pond (the page then opens Telegram's share sheet with it)
      const room = rooms[String(b.room || '').toUpperCase()], p = room && room.players.find((x) => x.uid === uid);
      if (!p || !tgId(p)) return json(res, 404, { error: 'No invite for this pond' });
      const id = await TG.prepareInvite(tgId(p), room.code);
      return id ? json(res, 200, { id }) : json(res, 502, { error: 'Telegram said no' });
    }
    if (url.pathname === '/api/rejoin') {
      const room = rooms[String(b.room || '').toUpperCase()], p = room && room.players.find((x) => x.uid === uid);
      if (!p) return json(res, 404, { error: 'That game has ended' });
      return json(res, 200, { room: room.code, token: p.token });
    }
    if (url.pathname === '/api/end') {
      // Only a player in the pond can end it
      // Leaving a ranked game once both of you are in it counts as a loss
      const room = rooms[String(b.room || '').toUpperCase()], p = room && room.players.find((x) => x.uid === uid);
      const left = p ? forfeit(room, p) : null;
      if (p) endRoom(room, p.name, left);
      return json(res, 200, { ok: true, ...(left ? { delta: p.delta } : {}) });
    }
    // Test tools only: tools/screen.py turns DEV_STATE on for its own throwaway server (never set in production) to start
    // a scene from an exact situation: { room, token, team, shop, food, gold, hearts }, frogs as { type, lvl, xp, atk, hp }
    if (DEV_STATE && url.pathname === '/api/dev/state') {
      const { room, p } = find(b);
      if (!p) return json(res, 404, { error: 'not found' });
      const frog = (x) => { if (!x) return null; const f = E.newFrog(x.type); delete f.cost; return Object.assign(f, x); };
      if (b.team) p.team = Array.from({ length: E.TEAM_SIZE }, (_, i) => frog(b.team[i]));
      if (b.shop) p.shop.frogs = b.shop.map((x) => x && Object.assign(E.newFrog(x.type), x));
      if (b.food !== undefined) Object.assign(p.shop, { food: b.food, foodCost: b.food ? E.FOODS[b.food].cost : 0 });
      if (b.gold != null) p.gold = b.gold;
      if (b.hearts != null) p.hearts = b.hearts;
      changed(room);
      return json(res, 200, view(room, p));
    }
    // Emoji reactions while shopping: each player's latest one, numbered so each phone plays it once. It isn't a
    // move: nothing is saved and the Pond Bot isn't asked to shop
    if (url.pathname === '/api/react') {
      const { room, p } = find(b);
      if (!p) return json(res, 404, { error: 'not found' });
      const emoji = String(b.emoji || ''), now = Date.now();
      if (!REACTIONS.includes(emoji) || room.phase !== 'shop') return json(res, 400, { error: 'not now' });
      if (now - (p.reactAt || 0) < 1000) return json(res, 429, { error: 'slow down' });
      const react = (x, e) => { x.reactAt = Date.now(); x.react = { e, n: ((x.react && x.react.n) || 0) + 1 }; room.v++; broadcast(room); };
      react(p, emoji);
      // the Pond Bot answers about half the time, a moment later
      const bot = room.players.find((x) => x.bot);
      if (bot && Math.random() < .5) setTimeout(() => { if (rooms[room.code] === room && room.phase === 'shop') react(bot, BOT_REACTIONS[Math.floor(Math.random() * BOT_REACTIONS.length)]); }, 700 + Math.random() * 900);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/action') {
      const { room, p } = find(b);
      if (!p) return json(res, 404, { error: 'not found' });
      if (room.ranked && (b.action || {}).type === 'rematch') return json(res, 200, view(room, p)); // ranked: find a new match instead
      act(room, p, b.action || {});
      changed(room);
      return json(res, 200, view(room, p, b.have));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`🐸 Pond Brawl on :${PORT}`));
TG.start().catch((e) => console.error('telegram:', e.message));

setTimeout(() => Object.values(rooms).forEach(scheduleBot), 1000);

// Tell connected phones when the page itself changes, so they pick up the new version
fs.watchFile(INDEX, { interval: 2000 }, () => { for (const r of Object.values(rooms)) broadcast(r); });

// Write ponds out before exiting so a restart never loses a move
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { fs.writeFileSync(SAVE, JSON.stringify(rooms)); fs.writeFileSync(PROFILES, JSON.stringify(profiles)); } catch (e) { console.error(e); } process.exit(0); });

// Drop rooms older than 2 days. A ranked game nobody has touched for a day ends: if one player is ready and
// the other isn't, the one who stopped playing forfeits; otherwise it just ends unrated.
setInterval(() => {
  const now = Date.now();
  for (const c in rooms) {
    const r = rooms[c];
    if (r.ranked && r.phase === 'shop' && now - (r.touched || r.created) > 86400e3) {
      const idle = r.players.filter((p) => !p.ready), gone = idle.length === 1 ? idle[0] : null;
      endRoom(r, gone ? gone.name : '', gone ? forfeit(r, gone) : null);
    } else if (now - r.created > 2 * 86400e3) delete rooms[c];
  }
  save();
}, 3600e3);
}

main();
