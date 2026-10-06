#!/usr/bin/env node
// Balance simulator (tools/simulate.js): plays lots of full games and reports how every frog and item does.
// It changes nothing and decides nothing: the numbers are for the person or agent reading them.
//
//   node tools/simulate.js                         the working tree (uncommitted changes included), every set
//   node tools/simulate.js --set nature            one set
//   node tools/simulate.js --base origin/main      A/B: the working tree (B) against a git ref or a folder (A)
//   node tools/simulate.js --try "king.hp=7 cricket.cost=3"
//                                                  A/B: the working tree (A) against itself with these changes (B);
//                                                  with --base, the changes apply to the working tree side
//   node tools/simulate.js --pair king+necro       also: how boards with both frogs (any levels) do; several
//                                                  pairs space-separated ("king+necro prince+squire")
//   options: --games N (full games per set and side, default 60000), --seed N, --json, --workers N
//
// How games are played: two identical simulated players buy frogs without looking at which frog it is (so every
// frog gets picked about as often), merge copies, feed items, sell to make room for higher tiers, and line up
// by each frog's preferred spot in frogs.json. Nothing about which frogs go well together is scripted: combos
// show up (or not) on their own. Keep it that way (see CLAUDE.md, Balance).
//
// What is measured, per set:
// - each frog: how often boards with it win (50% = average), next to its tier's typical frog (the median),
//   how often it's on a board, and the win rate of boards where it's level 3. "±" is a 95% margin.
// - each item: how often the buyer wins the next 3 battles.
// - the games: rounds, battles, draws, and how often the pond that acts first at start of battle wins.
// A/B runs play the same seeded games on both sides, so a difference comes from the change, not from luck.
// A difference smaller than its own margin is marked as noise ("~").
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Worker, isMainThread, parentPort } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const FILES = ['engine.js', 'frogs.json', 'items.json', 'sets.json']; // what the game rules are made of

// ===================================================================================== worker: play games
if (!isMainThread) {
  const loaded = new Map(); // folder -> { G, pristine } (the engine is loaded once per folder)
  const load = (dir) => {
    if (!loaded.has(dir)) {
      const G = require(path.join(dir, 'engine.js'));
      loaded.set(dir, { G, pristine: JSON.stringify({ frogs: G.FROGS, foods: G.FOODS }) });
    }
    return loaded.get(dir);
  };
  parentPort.on('message', (task) => {
    const { G, pristine } = load(task.dir);
    // start from the folder's own stats every time, then apply this side's changes (--try)
    const p = JSON.parse(pristine);
    for (const k of Object.keys(G.FROGS)) delete G.FROGS[k];
    for (const k of Object.keys(G.FOODS)) delete G.FOODS[k];
    Object.assign(G.FROGS, p.frogs); Object.assign(G.FOODS, p.foods);
    for (const [id, field, value] of task.changes) (G.FROGS[id] || G.FOODS[id])[field] = value;
    parentPort.postMessage(play(G, task));
  });
  return; // eslint-disable-line
}

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// One simulated player's shop turn: type-blind buys, merges, items, selling for higher tiers, then lining up
function shopTurn(G, room, p, buys) {
  const { FROGS, FOODS } = G, r = p.rng, posRank = { front: 0, any: 1, back: 2 };
  const price = (f) => f.cost ?? G.frogCost(f.type);
  for (let rolls = 0; rolls <= 2; rolls++) {
    for (let guard = 0; guard < 8; guard++) {
      const opts = p.shop.frogs.map((f, i) => f && { f, i }).filter((o) => o && p.gold >= price(o.f));
      if (!opts.length) break;
      const o = opts[Math.floor(r() * opts.length)];
      let slot = p.team.findIndex((t) => t && t.type === o.f.type && t.lvl < 3);
      if (slot < 0) slot = p.team.findIndex((t) => !t);
      if (slot < 0) {
        // Pond full: make room only for a frog from a higher tier, selling a level-1 frog of the lowest tier.
        // Frogs whose ability pays out when sold (sell: "first") are what a player sells first.
        const cands = p.team.map((t, j) => [t, j]).filter(([t]) => t.lvl === 1);
        if (!cands.length) break;
        const sellers = cands.filter(([t]) => FROGS[t.type].sell === 'first' && o.f.type !== t.type);
        let pool;
        if (sellers.length) pool = sellers;
        else {
          const low = Math.min(...cands.map(([t]) => FROGS[t.type].tier));
          if (FROGS[o.f.type].tier <= low) break;
          pool = cands.filter(([t]) => FROGS[t.type].tier === low);
        }
        slot = pool[Math.floor(r() * pool.length)][1];
        G.act(room, p, { type: 'sell', slot });
      }
      G.act(room, p, { type: 'buy', shopIdx: o.i, slot });
    }
    const item = p.shop.food;
    if (item && p.gold >= (p.shop.foodCost ?? 3)) {
      const can = p.team.map((t, j) => (G.canTake(t, FOODS[item]) ? j : -1)).filter((j) => j >= 0);
      if (can.length) { G.act(room, p, { type: 'food', slot: can[Math.floor(r() * can.length)] }); buys.push([room.round, room.players.indexOf(p), item]); }
    }
    if (p.gold < G.ROLL_COST + 3) break;
    G.act(room, p, { type: 'roll' });
  }
  const team = p.team.filter(Boolean).sort((a, b) => (posRank[FROGS[a.type].pos] ?? 1) - (posRank[FROGS[b.type].pos] ?? 1) || (b.atk + b.hp) - (a.atk + a.hp));
  p.team = [...team, ...Array(G.TEAM_SIZE - team.length).fill(null)];
  G.act(room, p, { type: 'ready' });
}

// Games [from, to) of one set; returns counts only (the main thread adds them up)
function play(G, { set, from, to, seed, pairs = [] }) {
  const frog = {}, items = {}, both = {}, g = { games: 0, rounds: 0, battles: 0, draws: 0, starterWins: 0, decided: 0 };
  const add = (o, k, w) => { const c = (o[k] ??= [0, 0]); c[0] += w; c[1]++; };
  for (let n = from; n < to; n++) {
    const s = seed + n;
    Math.random = mulberry32(s * 2654435761);
    const room = { code: 'SIM', sim: true, set, v: 0, players: [G.newPlayerState(), G.newPlayerState()] };
    room.players.forEach((p, i) => { p.rng = mulberry32(s * 31 + i); });
    G.resetGame(room);
    const buys = [];
    for (let guard = 0; guard < 40 && room.phase === 'shop'; guard++) {
      const r0 = room.round;
      for (const p of room.players) shopTurn(G, room, p, buys);
      if (room.round === r0 && room.phase === 'shop') break;
    }
    const log = room.log || [];
    g.games++; g.rounds += log.length; g.battles += log.length;
    for (const [round, side, item] of buys) for (const e of log) if (e.round >= round && e.round < round + 3 && e.winner >= 0) add(items, item, e.winner === side ? 1 : 0);
    for (const e of log) {
      if (e.winner < 0) { g.draws++; continue; }
      // the pond acting first at start of battle: seat 0 in odd rounds, seat 1 in even ones (engine.js fight())
      g.decided++; if (e.winner === (e.round % 2 === 0 ? 1 : 0)) g.starterWins++;
      e.teams.forEach((team, side) => {
        const w = e.winner === side ? 1 : 0, best = new Map();
        for (const f of team) if (f) best.set(f.type, Math.max(best.get(f.type) || 0, f.lvl));
        for (const [type, lvl] of best) { const r = (frog[type] ??= {}); add(r, 'all', w); if (lvl === 3) add(r, 'l3', w); }
        for (const [x, y] of pairs) if (best.has(x) && best.has(y)) add(both, `${x}+${y}`, w);
      });
    }
  }
  return { frog, items, both, g };
}

// ===================================================================================== main: run and report
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; };
const GAMES = Number(opt('games', 60000)), SEED = Number(opt('seed', 1000)), JSON_OUT = !!opt('json', false);
const WORKERS = Number(opt('workers', os.cpus().length));
const BASE = opt('base', null), TRY = opt('try', null), ONLY = opt('set', null);
const PAIRS = opt('pair', null);
const CHUNK = 2000; // games per task: small enough to keep every core busy to the end

// A side's rules come from a folder: the working tree, a folder given with --base, or a git ref copied out
function refFolder(ref) {
  if (fs.existsSync(ref) && fs.statSync(ref).isDirectory()) return path.resolve(ref);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-sim-'));
  for (const f of FILES) {
    try { fs.writeFileSync(path.join(dir, f), execFileSync('git', ['-C', ROOT, 'show', `${ref}:${f}`])); }
    catch { throw new Error(`--base ${ref}: can't read ${f} from git (is the ref right, and does it have sets.json?)`); }
  }
  return dir;
}
// --try "king.hp=7 prince=5/7 cricket.cost=3": field changes for frogs or items (id=atk/hp is short for both)
function parseTry(s, dir) {
  if (!s || s === true) return [];
  const G = require(path.join(dir, 'engine.js'));
  return s.trim().split(/\s+/).flatMap((tok) => {
    const m = tok.match(/^([a-z0-9_]+)(?:\.([a-z]+))?=(.+)$/i);
    if (!m) throw new Error(`--try: can't read "${tok}" (use id.field=value or id=atk/hp)`);
    const [, id, field, value] = m;
    if (!G.FROGS[id] && !G.FOODS[id]) throw new Error(`--try: no frog or item "${id}"`);
    if (!field) { const [a, h] = value.split('/').map(Number); return [[id, 'atk', a], [id, 'hp', h]]; }
    const num = Number(value);
    return [[id, field, Number.isNaN(num) ? value : num]];
  });
}

async function main() {
  const t0 = Date.now();
  // Sides: B is always the working tree; A is the base (--base), or the working tree without --try changes
  const work = ROOT, changes = parseTry(TRY, work);
  const sides = BASE ? [{ name: 'A', label: `${BASE}`, dir: refFolder(BASE), changes: [] }, { name: 'B', label: `working tree${changes.length ? ` + ${TRY}` : ''}`, dir: work, changes }]
    : changes.length ? [{ name: 'A', label: 'working tree', dir: work, changes: [] }, { name: 'B', label: `working tree + ${TRY}`, dir: work, changes }]
    : [{ name: 'A', label: 'working tree', dir: work, changes: [] }];
  const SETS = require(path.join(work, 'engine.js')).SETS;
  const sets = ONLY ? [ONLY] : Object.keys(SETS);
  const pairs = !PAIRS || PAIRS === true ? [] : PAIRS.trim().split(/\s+/).map((s) => s.split('+'));
  for (const pr of pairs) if (pr.length !== 2 || pr.some((id) => !require(path.join(work, 'engine.js')).FROGS[id])) throw new Error(`--pair: can't read "${pr.join('+')}" (use frog+frog)`);
  for (const s of sets) if (!SETS[s]) throw new Error(`no set "${s}" (sets: ${Object.keys(SETS).join(', ')})`);

  // every (side, set) is split into chunks; a pool of workers takes chunks until none are left
  const tasks = [];
  for (const side of sides) for (const set of sets) for (let from = 0; from < GAMES; from += CHUNK) tasks.push({ side: side.name, set, dir: side.dir, changes: side.changes, from, to: Math.min(GAMES, from + CHUNK), seed: SEED, pairs });
  const results = {};
  const merge = (task, r) => {
    const acc = (results[`${task.side}:${task.set}`] ??= { frog: {}, items: {}, both: {}, g: {} });
    const sum = (a, b) => [a[0] + b[0], a[1] + b[1]];
    for (const [k, v] of Object.entries(r.frog)) { const t = (acc.frog[k] ??= {}); for (const x in v) t[x] = t[x] ? sum(t[x], v[x]) : v[x]; }
    for (const [k, v] of Object.entries(r.items)) acc.items[k] = acc.items[k] ? sum(acc.items[k], v) : v;
    for (const [k, v] of Object.entries(r.both)) acc.both[k] = acc.both[k] ? sum(acc.both[k], v) : v;
    for (const [k, v] of Object.entries(r.g)) acc.g[k] = (acc.g[k] || 0) + v;
  };
  const pool = Array.from({ length: Math.max(1, WORKERS) }, () => new Worker(__filename));
  await Promise.all(pool.map((w) => new Promise((resolve, reject) => {
    const next = () => {
      const task = tasks.shift();
      if (!task) { w.terminate(); return resolve(); }
      w.once('message', (r) => { merge(task, r); next(); });
      w.postMessage(task);
    };
    w.on('error', reject);
    next();
  })));
  const secs = (Date.now() - t0) / 1000;
  const battles = Object.values(results).reduce((n, r) => n + r.g.battles, 0);
  const report = build(sides, sets, results);
  report.run = { games: GAMES, sets, sides: sides.map((s) => ({ name: s.name, label: s.label })), battles, seconds: +secs.toFixed(1), battlesPerSecond: Math.round(battles / secs), seed: SEED, workers: pool.length };
  if (JSON_OUT) console.log(JSON.stringify(report, null, 1));
  else print(report);
}

// ------------------------------------------------------------------ numbers
const Z = 1.96;
const rate = (c) => (c && c[1] ? c[0] / c[1] : null);
const margin = (c) => { const p = rate(c); return p == null ? null : Z * Math.sqrt((p * (1 - p)) / c[1]); };
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2 : null; };
function build(sides, sets, results) {
  const rules = (dir) => require(path.join(dir, 'engine.js'));
  const out = { sets: {} };
  for (const set of sets) {
    const bySide = {};
    for (const side of sides) {
      const r = results[`${side.name}:${set}`], G = rules(side.dir);
      const stat = (id, k) => { const f = G.FROGS[id], c = Object.fromEntries(side.changes.filter(([i]) => i === id).map(([, f2, v]) => [f2, v])); return { ...f, ...c }[k]; };
      const frogs = {}, boards = 2 * r.g.decided;
      for (const id of G.SETS[set] ? G.SETS[set].frogs : []) {
        const c = r.frog[id] || {};
        frogs[id] = { name: stat(id, 'name'), tier: stat(id, 'tier'), atk: stat(id, 'atk'), hp: stat(id, 'hp'), cost: stat(id, 'cost'),
          win: rate(c.all), margin: margin(c.all), seen: c.all ? c.all[1] / boards : 0, lv3: rate(c.l3), lv3Boards: c.l3 ? c.l3[1] : 0 };
      }
      const tiers = {};
      for (const t of [1, 2, 3, 4]) tiers[t] = { typical: median(Object.values(frogs).filter((f) => f.tier === t).map((f) => f.win)), typicalLv3: median(Object.values(frogs).filter((f) => f.tier === t && f.lv3Boards >= 1000).map((f) => f.lv3)) };
      for (const f of Object.values(frogs)) f.vsTier = f.win == null || tiers[f.tier] == null || tiers[f.tier].typical == null ? null : f.win - tiers[f.tier].typical;
      const items = {};
      for (const [id, c] of Object.entries(r.items)) items[id] = { name: G.FOODS[id] ? G.FOODS[id].name : id, cost: (side.changes.find(([i, f]) => i === id && f === 'cost') || [])[2] ?? (G.FOODS[id] || {}).cost, win: rate(c), margin: margin(c), bought: c[1] };
      const pairs = {};
      for (const [k, c] of Object.entries(r.both)) pairs[k] = { win: rate(c), margin: margin(c), seen: c[1] / boards, boards: c[1] };
      const g = r.g;
      bySide[side.name] = { frogs, tiers, items, pairs, games: { games: g.games, battles: g.battles, roundsPerGame: g.rounds / g.games, drawRate: g.draws / g.battles, starterWinRate: g.starterWins / g.decided, starterMargin: margin([g.starterWins, g.decided]) } };
    }
    out.sets[set] = bySide;
    if (sides.length === 2) {
      // A/B: what changed, with the combined margin of both sides
      const [A, B] = [bySide.A, bySide.B], diff = [];
      for (const id of new Set([...Object.keys(A.frogs), ...Object.keys(B.frogs)])) {
        const a = A.frogs[id], b = B.frogs[id];
        if (!a || !b || a.win == null || b.win == null) { diff.push({ id, kind: 'frog', note: !a ? 'only in B' : 'only in A' }); continue; }
        const d = b.win - a.win, m = Math.hypot(a.margin, b.margin);
        diff.push({ id, kind: 'frog', a: a.win, b: b.win, delta: d, margin: m, real: Math.abs(d) > m, vsTierA: a.vsTier, vsTierB: b.vsTier, statsA: `${a.atk}/${a.hp}`, statsB: `${b.atk}/${b.hp}` });
      }
      for (const id of new Set([...Object.keys(A.items), ...Object.keys(B.items)])) {
        const a = A.items[id], b = B.items[id];
        if (!a || !b) { diff.push({ id, kind: 'item', note: !a ? 'only in B' : 'only in A' }); continue; }
        const d = b.win - a.win, m = Math.hypot(a.margin, b.margin);
        diff.push({ id, kind: 'item', a: a.win, b: b.win, delta: d, margin: m, real: Math.abs(d) > m });
      }
      out.sets[set].diff = diff.sort((x, y) => Math.abs(y.delta || 0) - Math.abs(x.delta || 0));
    }
  }
  return out;
}

// ------------------------------------------------------------------ text report
const pct = (x, d = 1) => (x == null ? '-' : `${(x * 100).toFixed(d)}%`);
const pts = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`);
const pad = (s, n) => String(s).padEnd(n);
function print(rep) {
  const { run } = rep;
  console.log(`Pond Brawl balance report: ${run.games.toLocaleString('en')} full games per set and side, seed ${run.seed}`);
  for (const s of run.sides) console.log(`  ${s.name}: ${s.label}`);
  for (const set of run.sets) {
    const sides = rep.sets[set];
    for (const name of Object.keys(sides).filter((k) => k !== 'diff')) {
      const { frogs, tiers, items, games } = sides[name];
      console.log(`\n=== ${set}${run.sides.length > 1 ? ` · ${name}` : ''}`);
      console.log(`games: ${games.roundsPerGame.toFixed(1)} rounds each · draws ${pct(games.drawRate)} · the pond acting first at start of battle wins ${pct(games.starterWinRate)} ±${pct(games.starterMargin)}`);
      console.log(`tier typical (median): ${[1, 2, 3, 4].map((t) => `T${t} ${pct(tiers[t].typical)}`).join(' · ')}   at Lv3: ${[1, 2, 3, 4].map((t) => `T${t} ${pct(tiers[t].typicalLv3)}`).join(' · ')}`);
      console.log(`${pad('frog', 16)}${pad('tier', 5)}${pad('stats', 7)}${pad('cost', 5)}${pad('win ±', 14)}${pad('vs tier', 9)}${pad('on boards', 11)}Lv3 win (boards)`);
      for (const [id, f] of Object.entries(frogs).sort((a, b) => a[1].tier - b[1].tier || (b[1].win || 0) - (a[1].win || 0))) {
        const flag = f.vsTier != null && Math.abs(f.vsTier) > 0.03 ? ' *' : '';
        console.log(`${pad(id, 16)}${pad(f.tier, 5)}${pad(`${f.atk}/${f.hp}`, 7)}${pad(f.cost ?? '-', 5)}${pad(`${pct(f.win)} ±${(f.margin * 100).toFixed(1)}`, 14)}${pad(pts(f.vsTier) + flag, 9)}${pad(pct(f.seen), 11)}${f.lv3 == null ? '-' : `${pct(f.lv3)} (${f.lv3Boards})`}`);
      }
      console.log(`${pad('item', 16)}${pad('cost', 5)}${pad('bought', 10)}wins the next 3 battles ±`);
      for (const [id, it] of Object.entries(items).sort((a, b) => b[1].win - a[1].win)) console.log(`${pad(id, 16)}${pad(it.cost ?? '-', 5)}${pad(it.bought, 10)}${pct(it.win)} ±${(it.margin * 100).toFixed(1)}`);
      if (Object.keys(sides[name].pairs).length) {
        console.log(`${pad('pair', 21)}${pad('win ±', 14)}on boards`);
        for (const [id, pr] of Object.entries(sides[name].pairs)) console.log(`${pad(id, 21)}${pad(`${pct(pr.win)} ±${(pr.margin * 100).toFixed(1)}`, 14)}${pct(pr.seen)} (${pr.boards})`);
      }
    }
    if (sides.diff) {
      console.log(`\n=== ${set} · A → B (points; "~" = within the margin, i.e. noise)`);
      console.log(`${pad('', 16)}${pad('A', 9)}${pad('B', 9)}${pad('change ±', 16)}vs tier A → B`);
      for (const d of sides.diff) {
        if (d.note) { console.log(`${pad(d.id, 16)}${d.note}`); continue; }
        const stats = d.kind === 'frog' && d.statsA !== d.statsB ? `  (${d.statsA} → ${d.statsB})` : '';
        console.log(`${pad(d.id, 16)}${pad(pct(d.a), 9)}${pad(pct(d.b), 9)}${pad(`${pts(d.delta)} ±${(d.margin * 100).toFixed(1)}${d.real ? '' : ' ~'}`, 16)}${d.kind === 'frog' ? `${pts(d.vsTierA)} → ${pts(d.vsTierB)}` : ''}${stats}`);
      }
    }
  }
  console.log(`\n* more than 3 points from its tier's typical frog (a number to look at, not a verdict)`);
  console.error(`${run.battles.toLocaleString('en')} battles in ${run.seconds}s (${run.battlesPerSecond.toLocaleString('en')}/s on ${run.workers} workers)`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
