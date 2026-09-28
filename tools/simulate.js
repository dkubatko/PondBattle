#!/usr/bin/env node
// Frog simulation report (tools/simulate.js) — plays lots of full games with every frog in the pool and reports how each
// frog and item does. It changes nothing: the numbers are for a person to read and decide on.
//
//   node tools/simulate.js [--games N] [--set ID]   (default 120000 full games per set, spread over all CPU cores;
//                                                    every set in sets.json, or just the one given)
//
// Each set is its own game (its shop only sells that set's frogs), so each set gets its own report.
// How it works: two identical simulated players play complete games (seeded, fast). They buy
// frogs without looking at which frog it is (so every frog gets picked about as often), merge
// copies, feed, sell to make room for higher tiers and arrange by each frog's preferred spot.
// Nothing is scripted about which frogs go well together: combos show up (or not) on their own.
// Every battle records both boards; a frog's score is how often boards that include it won
// (50% = average), next to the typical frog of its tier (they unlock in the same round and show up
// about as often, so that is the fair comparison). Also shown: win rate of boards where the frog is
// level 3. Items are scored by how often the buyer wins the next 3 battles.
//
// Trying a change: edit frogs.json / items.json / engine.js in a copy of the game, run this there,
// and compare with the report from before the change.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const G = require('../engine.js'); // game rules only; never touches rooms or game history
const { FROGS, FOODS, SETS } = G;
const ITEMS = Object.keys(FOODS);
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const GAMES = Number(flag('games', 120000));
const ONLY = flag('set', null);
const BAND = 0.03;       // more than 3 points from its tier's typical frog is worth a look
let SET = Object.keys(SETS)[0]; // the set being simulated
const REAL = () => SETS[SET].frogs;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- one simulated game ----------
const posRank = { front: 0, any: 1, back: 2 };
function simTier(type) { return FROGS[type].tier; }
function botTurn(room, p, tier) {
  const r = () => p.rng();
  const price = (f) => f.cost ?? G.frogCost(f.type);
  for (let rolls = 0; rolls <= 2; rolls++) {
    for (let guard = 0; guard < 8; guard++) {
      const opts = p.shop.frogs.map((f, i) => f && { f, i }).filter((o) => o && p.gold >= price(o.f));
      if (!opts.length) break;
      const o = opts[Math.floor(r() * opts.length)]; // type-blind: any affordable frog
      let slot = p.team.findIndex((t) => t && t.type === o.f.type && t.lvl < 3);
      if (slot < 0) slot = p.team.findIndex((t) => !t);
      if (slot < 0) {
        // Pond full: make room only for a frog from a higher tier, replacing a level-1 frog of the lowest tier
        const cands = p.team.map((t, j) => [t, j]).filter(([t]) => t.lvl === 1);
        if (!cands.length) break;
        // Frogs whose ability pays out when sold (sell: "first") are what a player sells to make room
        const sellers = cands.filter(([t]) => FROGS[t.type].sell === 'first' && o.f.type !== t.type);
        let pool;
        if (sellers.length) pool = sellers;
        else {
          const low = Math.min(...cands.map(([t]) => simTier(t.type)));
          if (simTier(o.f.type) <= low) break;
          pool = cands.filter(([t]) => simTier(t.type) === low);
        }
        slot = pool[Math.floor(r() * pool.length)][1];
        G.act(room, p, { type: 'sell', slot });
      }
      G.act(room, p, { type: 'buy', shopIdx: o.i, slot });
    }
    if (p.shop.food && p.gold >= (p.shop.foodCost ?? 3)) {
      // Any frog that can use it (gear only for a frog without any, a Cricket below level 3)
      const item = p.shop.food;
      const idx = p.team.map((t, j) => (G.canTake(t, FOODS[item]) ? j : -1)).filter((j) => j >= 0);
      if (idx.length) { G.act(room, p, { type: 'food', slot: idx[Math.floor(r() * idx.length)] }); room.buys.push([room.round, room.players.indexOf(p), item]); }
    }
    if (p.gold < G.ROLL_COST + 3) break;
    G.act(room, p, { type: 'roll' });
  }
  // Arrange: frogs that want the front go first, then by toughness; back-row frogs last
  const team = p.team.filter(Boolean).sort((a, b) => (posRank[FROGS[a.type].pos] ?? 1) - (posRank[FROGS[b.type].pos] ?? 1) || (b.atk + b.hp) - (a.atk + a.hp));
  p.team = [...team, ...Array(G.TEAM_SIZE - team.length).fill(null)];
  G.act(room, p, { type: 'ready' });
}

// One full game; returns the per-round log (both boards and who won)
function playGame(seed) {
  Math.random = mulberry32(seed * 2654435761);
  const room = { code: 'SIM', sim: true, set: SET, v: 0, players: [G.newPlayerState(), G.newPlayerState()], buys: [] };
  room.players.forEach((p, i) => { p.rng = mulberry32(seed * 31 + i); });
  G.resetGame(room);
  for (let guard = 0; guard < 40 && room.phase === 'shop'; guard++) {
    const r0 = room.round;
    for (const p of room.players) botTurn(room, p, 0);
    if (room.round === r0 && room.phase === 'shop') break;
  }
  const log = room.log || [];
  log.buys = room.buys; // items bought: [round, player, item]
  return log;
}
// ---------- counting (runs in the worker threads) ----------
// [wins, boards] per frog: overall and at level 3; [wins, battles] per item
function count(from, to) {
  const frog = {}, items = {};
  let rounds = 0;
  const add = (o, k, w) => { const r = (o[k] ??= [0, 0]); r[0] += w; r[1]++; };
  for (let g = from; g < to; g++) {
    const log = playGame(1000 + g);
    for (const [round, side, item] of log.buys) {
      for (const e of log) if (e.round >= round && e.round < round + 3 && e.winner >= 0) add(items, item, e.winner === side ? 1 : 0);
    }
    for (const e of log) {
      if (e.winner < 0) continue;
      rounds++;
      e.teams.forEach((team, side) => {
        const w = e.winner === side ? 1 : 0, best = new Map();
        for (const f of team) if (f) best.set(f.type, Math.max(best.get(f.type) || 0, f.lvl));
        for (const [type, lvl] of best) {
          const r = (frog[type] ??= {});
          add(r, 'all', w);
          if (lvl === 3) add(r, 'l3', w);

        }
      });
    }
  }
  return { frog, items, rounds };
}
if (!isMainThread) {
  parentPort.on('message', ({ frogs, foods, set, from, to }) => {
    SET = set;
    for (const k in frogs) FROGS[k] = frogs[k];
    for (const k in foods) FOODS[k] = foods[k];
    parentPort.postMessage(count(from, to));
  });
  return; // eslint-disable-line
}

// ---------- simulate: spread the games over all cores ----------
let pool = null;
async function simulate() {
  pool ??= Array.from({ length: Math.max(1, os.cpus().length) }, () => new Worker(__filename));
  const per = Math.ceil(GAMES / pool.length);
  const parts = await Promise.all(pool.map((w, i) => new Promise((res, rej) => {
    w.once('error', rej); w.once('message', (m) => { w.off('error', rej); res(m); });
    w.postMessage({ frogs: FROGS, foods: FOODS, set: SET, from: i * per, to: Math.min(GAMES, (i + 1) * per) });
  })));
  const sum = (a, b) => (b ? [a[0] + b[0], a[1] + b[1]] : a);
  const frog = {}, items = {};
  let rounds = 0;
  for (const p of parts) {
    rounds += p.rounds;
    for (const [k, r] of Object.entries(p.frog)) { const t = (frog[k] ??= {}); for (const x in r) t[x] = sum(r[x], t[x]); }
    for (const [k, r] of Object.entries(p.items)) items[k] = sum(r, items[k]);
  }
  const out = {};
  const rate = (r) => (r && r[1] ? r[0] / r[1] : null);
  for (const k of REAL()) {
    const r = frog[k] || {};
    out[k] = { wr: rate(r.all) ?? 0.5, seen: (r.all ? r.all[1] : 0) / Math.max(1, 2 * rounds), l3: rate(r.l3), l3n: r.l3 ? r.l3[1] : 0 };
  }
  for (const k of ITEMS) { const r = items[k] || [0, 0]; out[k] = { wr: rate(r) ?? 0.5, seen: r[1] }; }
  return out;
}
// A tier's yardstick is its typical frog (the median), so one far-off newcomer doesn't shift the rest
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2 : null; };
function tierAverages(res, key = 'wr') {
  const t = {};
  for (let tier = 1; tier <= 4; tier++) t[tier] = median(REAL().filter((k) => FROGS[k].tier === tier).map((k) => res[k][key]));
  return t;
}

const ITEM_BAND = 0.015; // an item moves a board less than a frog does, so the band is tighter
const itemAverage = (res) => ITEMS.reduce((a, k) => a + res[k].wr, 0) / ITEMS.length;
const pad = (s, n) => String(s).padEnd(n);
const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
function table(res, avg) {
  const l3 = tierAverages(res, 'l3');
  console.log(`\n${pad('frog', 12)}${pad('tier', 5)}${pad('price', 6)}${pad('stats', 7)}${pad('on boards', 10)}${pad('wins', 7)}${pad('typical', 9)}${pad('verdict', 20)}at Lv3`);
  for (const k of REAL().sort((a, b) => FROGS[a].tier - FROGS[b].tier || res[b].wr - res[a].wr)) {
    const f = FROGS[k], r = res[k], d = r.wr - avg[f.tier];
    const v = Math.abs(d) <= BAND ? 'ok' : d > 0 ? `strong (+${(d * 100).toFixed(1)})` : `weak (${(d * 100).toFixed(1)})`;
    // Level 3 is rare; under 1000 boards the number is only a hint
    const lv3 = r.l3 == null ? '-' : `${pct(r.l3)} ${r.l3 - l3[f.tier] >= 0 ? '+' : ''}${((r.l3 - l3[f.tier]) * 100).toFixed(0)}${r.l3n < 1000 ? '?' : ''}`;
    console.log(`${pad(k, 12)}${pad(f.tier, 5)}${pad(f.cost, 6)}${pad(`${f.atk}/${f.hp}`, 7)}${pad(pct(r.seen), 10)}${pad(pct(r.wr), 7)}${pad(pct(avg[f.tier]), 9)}${pad(v, 20)}${lv3}`);
  }
  console.log(`typical frog per tier: ${[1, 2, 3, 4].map((t) => `tier ${t} ${pct(avg[t])}`).join(', ')}`);
  console.log(`  at level 3:  ${[1, 2, 3, 4].map((t) => `tier ${t} ${pct(l3[t])}`).join(', ')}`);
  const ia = itemAverage(res);
  console.log(`\n${pad('item', 12)}${pad('price', 7)}${pad('bought', 9)}${pad('wins next 3', 13)}${pad('item avg', 10)}verdict`);
  for (const k of [...ITEMS].sort((a, b) => res[b].wr - res[a].wr)) {
    const d = res[k].wr - ia, v = Math.abs(d) <= ITEM_BAND ? 'ok' : d > 0 ? `strong (+${(d * 100).toFixed(1)})` : `weak (${(d * 100).toFixed(1)})`;
    console.log(`${pad(k, 12)}${pad(FOODS[k].cost, 7)}${pad(res[k].seen, 9)}${pad(pct(res[k].wr), 13)}${pad(pct(ia), 10)}${v}`);
  }
}

async function main() {
  const t0 = Date.now();
  for (const set of ONLY ? [ONLY] : Object.keys(SETS)) {
    SET = set;
    console.log(`\n=== ${SETS[set].name}: ${GAMES.toLocaleString('en')} full games on ${os.cpus().length} cores`);
    const res = await simulate();
    table(res, tierAverages(res));
  }
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const w of pool || []) w.terminate();
}
main();
