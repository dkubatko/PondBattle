// Pond Battle — game rules: frogs, items, shop, merging, battles and rounds.
// No web code here: server.js runs rooms on top of it, tools/simulate.js simulates games with it.
'use strict';
const fs = require('fs');
const path = require('path');

const TEAM_SIZE = 5, START_GOLD = 10, FROG_COST = 3, FOOD_COST = 3, ROLL_COST = 1, LOCK_COST = 1;
const START_HEARTS = 5, WIN_TROPHIES = 5;
// The server sets hooks.gameOver to record finished games
const hooks = { gameOver: null };

// ---------- Frog catalogue ----------
// Stats, tiers and prices live in frogs.json (checked with tools/simulate.js); abilities are in runBattle/act.
const FROGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'frogs.json'), 'utf8'));
// Items (bugs give stats; gear like the Bubble is worn by a frog) live in items.json
const FOODS = JSON.parse(fs.readFileSync(path.join(__dirname, 'items.json'), 'utf8'));

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];
const levelOf = (xp) => (xp >= 5 ? 3 : xp >= 2 ? 2 : 1);
let nextId = 1;
// Frog ids continue after the ones in saved rooms
const bumpId = (n) => { nextId = Math.max(nextId, n); };
// Prices live on each shop item so they can differ per frog later
const frogCost = (type) => FROGS[type].cost ?? FROG_COST;
const foodCost = (type) => FOODS[type].cost ?? FOOD_COST;
const newFrog = (type) => ({ id: nextId++, type, atk: FROGS[type].atk, hp: FROGS[type].hp, xp: 0, lvl: 1, cost: frogCost(type) });

function maxTier(round) { return round >= 7 ? 4 : round >= 5 ? 3 : round >= 3 ? 2 : 1; }
function rollShop(p, round) {
  // p.rng lets the balance simulator give both players matching shops; live games use Math.random
  const r = p.rng ? (arr) => arr[Math.floor(p.rng() * arr.length)] : pick;
  const pool = Object.keys(FROGS).filter((k) => FROGS[k].tier >= 1 && FROGS[k].tier <= maxTier(round));
  const n = round >= 5 ? 4 : 3;
  const food = r(Object.keys(FOODS));
  p.shop = { frogs: Array.from({ length: n }, () => newFrog(r(pool))), food, foodCost: foodCost(food) };
}
// A locked shop carries over to the next round: what's left stays, empty slots (and a newly opened
// 4th slot) get fresh frogs. The lock is used up: the new shop is unlocked (rolling before that also unlocks)
function refillShop(p, round) {
  const old = p.shop;
  rollShop(p, round);
  p.shop.frogs = p.shop.frogs.map((f, i) => old.frogs[i] || f);
  if (old.food) Object.assign(p.shop, { food: old.food, foodCost: old.foodCost });
}

// ---------- Battle engine ----------
// Produces a list of frames (full snapshots of both teams, front first) tagged with
// what just happened, so the client can animate each step.
// Battle copies of frogs all have the same fields (keeps the engine fast; abilities keep their per-battle counters here)
const unit = (type, atk, hp, lvl, gear, bid) => ({ id: 0, type, atk, hp, xp: 0, lvl, gear: gear || null, bid, blocked: false, bounced: 0, uses: 0, koBy: null });
function runBattle(teamA, teamB, opts = {}) {
  let bid = 0;
  const T = [teamA, teamB].map((t) => t.filter(Boolean).map((f) => unit(f.type, f.atk, f.hp, f.lvl, f.gear, ++bid)));
  const frames = [];
  const pub = (u) => ({ id: u.bid, type: u.type, atk: u.atk, hp: Math.max(0, u.hp), lvl: u.lvl, ...(u.gear ? { gear: u.blocked ? 'used' : u.gear } : {}) });
  // Simulations skip the animation frames for speed
  // snap?.(…) skips building the caption and frame data entirely when frames are off
  const snap = opts.frames === false ? null : (kind, extra = {}) => frames.push({ kind, a: T[0].map(pub), b: T[1].map(pub), ...extra });
  const alive = (s) => T[s].filter((u) => u.hp > 0);
  const hurts = [];
  const nm = (u) => FROGS[u.type].name;

  const damage = (s, u, n) => {
    if (n <= 0 || u.hp <= 0) return;
    if (u.gear === 'bubble' && !u.blocked) { u.blocked = true; return; } // the next frame shows the bubble as popped
    u.hp -= n;
    if (u.hp > 0) hurts.push([s, u]);
  };
  const buff = (u, a, h) => { u.atk = Math.min(50, u.atk + a); u.hp = Math.min(50, u.hp + h); };

  function onHurt(s, u) {
    if (u.type === 'toad') { buff(u, u.lvl, 0); snap?.('ability', { actor: u.bid, text: `${nm(u)} gets grumpier` }); }
    if (u.type === 'surinam' && T[s].length < TEAM_SIZE) {
      const f = unit('froglet', u.lvl, u.lvl, 1, null, ++bid);
      T[s].splice(T[s].indexOf(u) + 1, 0, f);
      snap?.('summon', { actor: f.bid, text: `A baby hatches from ${nm(u)}` });
    }
    if (u.type === 'rain') {
      const t = T[s][T[s].indexOf(u) + 1];
      if (t && t.hp > 0) { buff(t, u.lvl, u.lvl); snap?.('ability', { actor: u.bid, target: t.bid, text: `${nm(u)} shelters ${nm(t)}` }); }
    }
  }
  function onFaint(s, u, i) {
    const L = u.lvl;
    const behind = T[s][i];
    if (behind && behind.type === 'bullfrog' && behind.hp > 0) {
      buff(behind, behind.lvl, behind.lvl);
      snap?.('ability', { actor: behind.bid, text: `${nm(behind)} is fired up` });
    }
    if (u.type === 'tadpole' && T[s].length < TEAM_SIZE) {
      const f = unit('froglet', L, L, 1, null, ++bid);
      T[s].splice(i, 0, f);
      snap?.('summon', { actor: f.bid, text: `${nm(u)} grew into a Froglet` });
    }
    if (u.type === 'mama') {
      let n = 0;
      for (let k = 0; k < 2 && T[s].length < TEAM_SIZE; k++, n++) T[s].splice(i, 0, unit('tadpole', L, L, 1, null, ++bid));
      if (n) snap?.('summon', { actor: T[s][i].bid, text: `${nm(u)}’s tadpoles hatch` });
    }
    if (u.type === 'tree') {
      const f = alive(s);
      if (f.length) { const t = pick(f); buff(t, 2 * L, L); snap?.('ability', { target: t.bid, text: `${nm(u)} cheers on ${nm(t)}` }); }
    }
    if (u.type === 'goliath') {
      alive(1 - s).forEach((e) => damage(1 - s, e, 2 * L));
      snap?.('splash', { side: 1 - s, text: `${nm(u)} makes a huge splash` });
    }
  }
  function settle() {
    for (let guard = 0; guard < 200; guard++) {
      if (hurts.length) { const [s, u] = hurts.shift(); if (u.hp > 0 && T[s].includes(u)) onHurt(s, u); continue; }
      let found = false;
      for (const s of [0, 1]) {
        const i = T[s].findIndex((u) => u.hp <= 0);
        if (i >= 0 && T[s][i].type === 'bouncy' && !T[s][i].bounced) {
          const [u] = T[s].splice(i, 1);
          u.bounced = 1; u.hp = 2 * u.lvl; T[s].push(u);
          snap?.('ability', { actor: u.bid, text: `${nm(u)} bounces to the back` });
          found = true;
          break;
        }
        if (i >= 0) {
          const [u] = T[s].splice(i, 1);
          snap?.('faint', { actor: u.bid });
          const foe = u.koBy;
          if (foe && foe.type === 'hungry' && foe.hp > 0 && T[1 - s].includes(foe)) { buff(foe, foe.lvl, foe.lvl); snap?.('ability', { actor: foe.bid, text: `${nm(foe)} wants seconds` }); }
          onFaint(s, u, i);
          found = true;
          break;
        }
      }
      if (!found) return;
    }
  }

  snap?.('start');
  // Chameleons take on the ability of the friend behind them first (back to front, so chains copy the
  // finished copy), so a copied start-of-battle ability still fires below. They keep their own stats, level and gear.
  for (const s of [0, 1]) {
    for (let i = T[s].length - 2; i >= 0; i--) {
      const u = T[s][i], b = T[s][i + 1];
      if (u.type !== 'chameleon' || b.type === 'chameleon') continue;
      u.type = b.type;
      snap?.('morph', { actor: u.bid, text: `Chameleon turns into a ${nm(b)}` });
    }
  }
  for (const s of [0, 1]) {
    for (const u of [...T[s]]) {
      if (u.hp <= 0 || !T[s].includes(u)) continue;
      if (u.type === 'wizard') {
        // Shrinks L random enemies to 1/1 (skipping ones that already are); they keep their abilities
        const pool = alive(1 - s).filter((e) => e.atk + e.hp > 2), foes = [];
        while (foes.length < u.lvl && pool.length) foes.push(pool.splice(rand(pool.length), 1)[0]);
        if (foes.length) {
          for (const e of foes) { e.atk = 1; e.hp = 1; }
          snap?.('spell', { actor: u.bid, targets: foes.map((e) => e.bid), text: `${nm(u)} shrinks the enemy` });
        }
      }
      if (u.type === 'princess') {
        // Charmed by her beauty, the strongest enemies hit themselves
        const foes = alive(1 - s).sort((x, y) => y.atk + y.hp - (x.atk + x.hp)).slice(0, u.lvl);
        if (foes.length) {
          for (const e of foes) damage(1 - s, e, e.atk);
          snap?.('charm', { actor: u.bid, targets: foes.map((e) => e.bid), text: `${nm(u)} charms the enemy` });
        }
      }
      if (u.type === 'spitter') {
        const e = alive(1 - s);
        for (let k = 0; k < u.lvl && e.length; k++) { const t = e.splice(rand(e.length), 1)[0]; damage(1 - s, t, 2); snap?.('spit', { actor: u.bid, target: t.bid, text: `${nm(u)} spits at ${nm(t)}` }); }
      }
      if (u.type === 'prince') {
        T[s].forEach((f) => f !== u && buff(f, u.lvl, u.lvl));
        snap?.('ability', { actor: u.bid, text: `${nm(u)} rallies the pond` });
      }
    }
  }
  settle();

  let turns = 0;
  while (T[0].length && T[1].length && turns++ < 60) {
    // Hypno Frog: before attacking, sends the enemy ahead to the back (L times per battle)
    for (const s of [0, 1]) {
      const u = T[s][0], line = T[1 - s];
      if (u.type === 'hypno' && u.uses < u.lvl && line.length > 1) {
        u.uses++;
        const e = line.shift(); line.push(e);
        snap?.('ability', { actor: u.bid, target: e.bid, text: `${nm(u)} sends ${nm(e)} to the back` });
      }
    }
    const a = T[0][0], b = T[1][0];
    for (const u of [a, b]) if (u.type === 'knight') { buff(u, u.lvl, 0); snap?.('ability', { actor: u.bid, text: `${nm(u)} raises its sword` }); }
    // Who each front frog hits: the enemy ahead, or for a Leapfrog the enemy's last L frogs
    const targets = (u, s) => (u.type === 'leapfrog' ? T[1 - s].slice(-u.lvl) : [T[1 - s][0]]);
    const ta = targets(a, 0), tb = targets(b, 1), da = a.atk, db = b.atk;
    for (const t of ta) { damage(1, t, da); if (t.hp <= 0 && da > 0) t.koBy = a; }
    for (const t of tb) { damage(0, t, db); if (t.hp <= 0 && db > 0) t.koBy = b; }
    const leaps = [[a, ta], [b, tb]].filter(([u]) => u.type === 'leapfrog').map(([u, ts]) => [u.bid, ts.map((t) => t.bid)]);
    snap?.('hit', { ids: [a.bid, b.bid], ...(leaps.length ? { leaps } : {}) });
    settle();
  }
  const winner = T[0].length && !T[1].length ? 0 : T[1].length && !T[0].length ? 1 : -1;
  snap?.('end');
  return { frames, winner };
}

// ---------- Players and rounds ----------
const newPlayerState = () => ({ hearts: START_HEARTS, trophies: 0, gold: START_GOLD, team: Array(TEAM_SIZE).fill(null), shop: null, ready: false });
function resetGame(room) {
  room.round = 1; room.phase = room.players.length === 2 ? 'shop' : 'waiting'; room.lastBattle = null; room.winner = null;
  room.game = (room.game || 0) + 1;
  room.log = []; room.gameStarted = Date.now();
  for (const p of room.players) Object.assign(p, { hearts: START_HEARTS, trophies: 0, gold: START_GOLD, team: Array(TEAM_SIZE).fill(null), ready: false }), rollShop(p, 1);
}
// ---------- Pond Bot: shops on its own (practice games) ----------
function botShop(room, bot) {
  const score = (f) => f.atk + f.hp + FROGS[f.type].tier * 2;
  const price = (f) => f.cost ?? frogCost(f.type);
  for (let rolls = 0; rolls < 3; rolls++) {
    for (let guard = 0; guard < 8; guard++) {
      const opts = bot.shop.frogs.map((f, i) => f && { f, i }).filter((o) => o && bot.gold >= price(o.f));
      let best = null;
      for (const o of opts) {
        const merge = bot.team.findIndex((t) => t && t.type === o.f.type && t.lvl < 3);
        const slot = merge >= 0 ? merge : bot.team.findIndex((t) => !t);
        const val = score(o.f) + (merge >= 0 ? 6 : 0);
        if (slot >= 0 && (!best || val > best.val)) best = { ...o, slot, val };
      }
      if (!best && opts.length && bot.team.every(Boolean)) {
        // Pond is full: trade the weakest frog for a clearly better one
        const weakest = bot.team.reduce((m, t, j) => (score(t) < score(bot.team[m]) ? j : m), 0);
        const top = opts.reduce((m, o) => (score(o.f) > score(m.f) ? o : m));
        if (score(top.f) > score(bot.team[weakest]) + 2) { act(room, bot, { type: 'sell', slot: weakest }); best = { ...top, slot: weakest }; }
      }
      if (!best) break;
      act(room, bot, { type: 'buy', shopIdx: best.i, slot: best.slot });
    }
    const front = bot.team.findIndex(Boolean);
    if (bot.shop.food && front >= 0 && bot.gold >= (bot.shop.foodCost ?? FOOD_COST)) act(room, bot, { type: 'food', slot: front });
    if (bot.gold < ROLL_COST + FROG_COST) break;
    act(room, bot, { type: 'roll' });
  }
  // Sturdiest frogs up front
  const order = bot.team.filter(Boolean).sort((x, y) => y.atk + y.hp - (x.atk + x.hp));
  bot.team = [...order, ...Array(TEAM_SIZE - order.length).fill(null)];
}

function afterMerge(t) { t.lvl = levelOf(t.xp); }

function act(room, p, a) {
  if (a.type === 'rematch') { if (room.phase === 'over') resetGame(room); return; }
  if (room.phase !== 'shop' || (p.ready && a.type !== 'unready')) return;
  const team = p.team, shop = p.shop;
  const slot = a.slot | 0;
  const inSlot = slot >= 0 && slot < TEAM_SIZE;
  switch (a.type) {
    case 'buy': {
      const f = shop.frogs[a.shopIdx];
      const cost = f ? f.cost ?? frogCost(f.type) : 0;
      if (!f || p.gold < cost || !inSlot) return;
      const t = team[slot];
      if (t && t.type !== f.type) return;
      if (t && t.lvl >= 3) return;
      p.gold -= cost;
      delete f.cost;
      shop.frogs[a.shopIdx] = null;
      let target = f;
      if (t) { t.atk = Math.max(t.atk, f.atk) + 1; t.hp = Math.max(t.hp, f.hp) + 1; t.xp += 1; afterMerge(t); target = t; }
      else team[slot] = f;
      if (target.type === 'peeper') {
        const others = team.filter((x) => x && x !== target);
        if (others.length) pick(others).atk += target.lvl;
      }
      break;
    }
    case 'food': {
      const t = team[slot];
      const cost = shop.foodCost ?? foodCost(shop.food);
      if (!shop.food || !t || p.gold < cost) return;
      const food = FOODS[shop.food];
      if (food.gear && t.gear) return; // one piece of gear per frog
      p.gold -= cost; t.atk += food.atk; t.hp += food.hp; shop.food = null;
      if (food.gear) t.gear = food.gear;
      break;
    }
    case 'move': {
      const from = a.from | 0;
      if (!inSlot || from < 0 || from >= TEAM_SIZE || from === slot || !team[from]) return;
      const src = team[from], dst = team[slot];
      if (dst && dst.type === src.type && dst.lvl < 3 && src.lvl < 3) {
        dst.atk = Math.max(dst.atk, src.atk) + 1; dst.hp = Math.max(dst.hp, src.hp) + 1; dst.xp += src.xp + 1; afterMerge(dst);
        dst.gear = dst.gear || src.gear;
        team[from] = null;
      } else { team[slot] = src; team[from] = dst; }
      break;
    }
    case 'sell': {
      const t = team[slot];
      if (!t) return;
      p.gold += t.lvl; team[slot] = null;
      if (t.type === 'glass') {
        const others = team.filter(Boolean);
        if (others.length) { const f = pick(others); f.atk += t.lvl; f.hp += t.lvl; }
      }
      break;
    }
    case 'roll': { // also cancels a lock: a fresh shop is never locked
      if (p.gold < ROLL_COST) return;
      p.gold -= ROLL_COST; rollShop(p, room.round);
      break;
    }
    case 'lock': {
      if (shop.locked || p.gold < LOCK_COST) return;
      p.gold -= LOCK_COST; shop.locked = true;
      break;
    }
    case 'ready': p.ready = true; break;
    case 'unready': p.ready = false; break;
  }
  if (room.players.length === 2 && room.players.every((x) => x.ready)) fight(room);
}

const teamSummary = (team) => team.map((f) => f && { type: f.type, atk: f.atk, hp: f.hp, lvl: f.lvl, ...(f.gear ? { gear: f.gear } : {}) });
function fight(room) {
  const [A, B] = room.players;
  // End-of-turn abilities (permanent)
  for (const p of room.players) {
    p.team.forEach((f, i) => {
      if (f && f.type === 'lily') {
        for (let j = i - 1; j >= 0; j--) if (p.team[j]) { p.team[j].hp += f.lvl; break; }
      }
    });
  }
  const { frames, winner } = runBattle(A.team, B.team, { frames: !room.sim }); // simulations skip the animation frames
  // Bubbles only protect for the battle right after they are given
  for (const p of room.players) for (const f of p.team) if (f && f.gear === 'bubble') delete f.gear;
  if (winner >= 0) { room.players[winner].trophies++; room.players[1 - winner].hearts--; }
  room.lastBattle = { id: room.sim ? '' : Math.random().toString(36).slice(2, 10), round: room.round, frames, winner };
  (room.log = room.log || []).push({ round: room.round, winner, teams: [teamSummary(A.team), teamSummary(B.team)] });
  const done = room.players.findIndex((p) => p.trophies >= WIN_TROPHIES || p.hearts <= 0);
  if (done >= 0) {
    const p = room.players[done];
    room.phase = 'over';
    room.winner = p.trophies >= WIN_TROPHIES ? done : 1 - done;
    hooks.gameOver?.(room);
    return;
  }
  room.round++;
  for (const p of room.players) {
    p.ready = false;
    p.gold = START_GOLD + p.team.reduce((g, f) => g + (f && f.type === 'lucky' ? f.lvl : 0), 0);
    if (p.shop && p.shop.locked) refillShop(p, room.round); else rollShop(p, room.round);
  }
}

module.exports = {
  TEAM_SIZE, ROLL_COST, LOCK_COST, FROGS, FOODS, hooks,
  rand, bumpId, frogCost, runBattle, newPlayerState, resetGame, botShop, act,
};
