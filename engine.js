// Pond Brawl — game rules: frogs, items, shop, merging, battles and rounds.
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
// Sets (sets.json): which frogs a game's shop sells. Picked when a pond is made, the same for both players.
// Ponds saved before sets existed play the first set.
const SETS = JSON.parse(fs.readFileSync(path.join(__dirname, 'sets.json'), 'utf8'));
const DEFAULT_SET = Object.keys(SETS)[0];
const setOf = (room) => (SETS[room.set] ? room.set : DEFAULT_SET);

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
// Some frogs have stats set by their level (frogs.json "fixed": "atk" or "both"): their base stats times their
// level, and nothing else changes them
function fixStats(f) {
  const x = FROGS[f.type] && FROGS[f.type].fixed;
  if (x) { f.atk = FROGS[f.type].atk * f.lvl; if (x === 'both') f.hp = FROGS[f.type].hp * f.lvl; }
}

function maxTier(round) { return round >= 7 ? 4 : round >= 5 ? 3 : round >= 3 ? 2 : 1; }
function rollShop(p, round, set) {
  // p.rng lets the balance simulator give both players matching shops; live games use Math.random
  const r = p.rng ? (arr) => arr[Math.floor(p.rng() * arr.length)] : pick;
  const pool = SETS[set].frogs.filter((k) => FROGS[k].tier <= maxTier(round));
  const n = round >= 5 ? 4 : 3;
  const food = r(Object.keys(FOODS));
  p.shop = { frogs: Array.from({ length: n }, () => newFrog(r(pool))), food, foodCost: foodCost(food) };
}
// A locked shop carries over to the next round: what's left stays, empty slots (and a newly opened
// 4th slot) get fresh frogs. The lock is used up: the new shop is unlocked (rolling before that also unlocks)
function refillShop(p, round, set) {
  const old = p.shop;
  rollShop(p, round, set);
  p.shop.frogs = p.shop.frogs.map((f, i) => old.frogs[i] || f);
  if (old.food) Object.assign(p.shop, { food: old.food, foodCost: old.foodCost });
}

// ---------- Battle engine ----------
// Produces a list of frames (full snapshots of both teams, front first) tagged with
// what just happened, so the client can animate each step.
// Battle copies of frogs all have the same fields (keeps the engine fast; abilities keep their per-battle counters here)
// Frogs with a start-of-battle ability (they take turns, see runBattle)
const START_OF_BATTLE = new Set(['wizard', 'jester', 'princess', 'spitter', 'archer', 'dragon', 'budgett', 'prince', 'squire', 'cleric', 'hypno']);
const unit = (type, atk, hp, lvl, gear, bid) => ({ id: 0, type, atk, hp, xp: 0, lvl, gear: gear || null, bid, blocked: false, bounced: 0, uses: 0, koBy: null, aura: 0 });
function runBattle(teamA, teamB, opts = {}) {
  let bid = 0;
  const T = [teamA, teamB].map((t) => t.filter(Boolean).map((f) => unit(f.type, f.atk, f.hp, f.lvl, f.gear, ++bid)));
  const frames = [];
  const pub = (u) => ({ id: u.bid, type: u.type, atk: u.atk, hp: Math.max(0, u.hp), lvl: u.lvl, ...(u.gear ? { gear: u.blocked ? 'used' : u.gear } : {}) });
  // Simulations skip the animation frames for speed
  // snap?.(…) skips building the caption and frame data entirely when frames are off
  // immune: frogs a hit didn't touch since the last frame (a Rogue, or frogs guarded by a Frog King), so the page can say so
  // gold: frogs a Golden Frog's touch knocked out; shell: [frog, damage its shell kept off] for Turtle Frogs
  const immune = [], gold = [], shell = [];
  const snap = opts.frames === false ? null : (kind, extra = {}) => frames.push({ kind, a: T[0].map(pub), b: T[1].map(pub), ...extra,
    ...(immune.length ? { immune: immune.splice(0) } : {}), ...(gold.length ? { gold: gold.splice(0) } : {}), ...(shell.length ? { shell: shell.splice(0) } : {}) });
  const alive = (s) => T[s].filter((u) => u.hp > 0);
  // New frogs (babies, raised frogs) arrive once everyone knocked out in the same moment has left, in the spots that
  // freed up: arrive() queues them, settle() lets them in when nothing else is left to resolve. next: the frog they
  // line up in front of (the end of the pond if it's gone by then).
  const arrivals = [];
  const arrive = (s, next, make, fill, text, by) => arrivals.push({ s, next, make, fill, text, by });
  function letIn() {
    for (const a of arrivals.splice(0)) {
      const s = a.s, space = TEAM_SIZE - T[s].length;
      if (a.by && !(a.by.hp > 0 && T[s].includes(a.by) && a.by.uses < a.by.lvl)) continue; // its Necromancer is gone or spent
      const n = a.fill ? space : Math.min(1, space);
      if (n <= 0) continue;
      if (a.by) a.by.uses++;
      let at = a.next && T[s].includes(a.next) ? T[s].indexOf(a.next) : T[s].length, firstNew = null;
      for (let k = 0; k < n; k++) { const f = a.make(); hatch(s, at, f); firstNew ??= f; }
      snap?.('summon', { actor: firstNew.bid, ...(a.by ? { by: a.by.bid } : {}), text: a.text(firstNew) });
      hugs();
    }
  }
  const an = (name) => `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`;
  // Fair turns: whenever both ponds have something waiting at the same moment (a start-of-battle frog, a knocked-out
  // frog, a hurt reaction), the pond whose turn it is goes first and the turn passes to the other. Each kind keeps its
  // own turn, and every one of them starts with the round's first pond (opts.first), so no seat is always first.
  const first = opts.first ? 1 : 0, order = [first, 1 - first];
  const turnOf = { start: first, faint: first, hurt: first };
  const take = (kind, has) => {
    if (has[0] && has[1]) { const s = turnOf[kind]; turnOf[kind] = 1 - s; return s; }
    return has[0] ? 0 : has[1] ? 1 : -1;
  };
  const hurts = [[], []]; // per pond, in the order the frogs were hurt
  const nm = (u) => FROGS[u.type].name;
  const fixed = (u) => FROGS[u.type].fixed;

  // Friends behind a living Frog King take no damage (other effects, like a shrink or a swap, still reach them)
  const guarded = (s, u) => {
    for (const k of T[s]) { if (k === u) return false; if (k.type === 'king' && k.hp > 0) return true; }
    return false;
  };
  // src: the frog whose attack this is (null for abilities). Only an attack can hurt a Rogue, and only
  // while it's the front frog (the one being fought). checked: the Frog King's guard was already looked at
  // (hits on many frogs at once are sorted out first, so a King knocked out by the same splash still guards)
  const damage = (s, u, n, src = null, checked = false) => {
    if (n <= 0 || u.hp <= 0) return;
    if ((u.type === 'rogue' && !(src && T[s][0] === u)) || (!checked && guarded(s, u))) { if (snap) immune.push(u.bid); return; }
    if (u.gear === 'bubble' && !u.blocked) { u.blocked = true; return; } // the next frame shows the bubble as popped
    // Golden Frog: its first L hits that land turn the frog to gold (knocked out, whatever shell it has)
    if (src && src.type === 'golden' && src.uses < src.lvl) { src.uses++; n = Math.max(n, u.hp); if (snap) gold.push(u.bid); }
    else if (u.type === 'turtle') { const m = Math.max(1, n - u.lvl); if (snap && m < n) shell.push([u.bid, n - m]); n = m; }
    u.hp -= n;
    if (u.hp > 0) hurts[s].push(u);
  };
  // Fixed stats (Frog King, Pebble Toad's attack) ignore buffs
  const buff = (u, a, h) => {
    const x = fixed(u);
    if (x) { a = 0; if (x === 'both') h = 0; }
    u.atk = Math.min(50, u.atk + a); u.hp = Math.min(50, u.hp + h);
  };
  // Hits every enemy at once (a splash, a fire breath): who the King guards is decided before anyone is hurt
  const unguarded = (s, list, hits) => list.filter((e) => {
    if (!guarded(s, e)) return true;
    if (hits && snap) immune.push(e.bid);
    return false;
  });
  const blast = (s, n) => unguarded(s, alive(s), true).forEach((e) => damage(s, e, n, null, true));
  // A frog joins the pond mid-battle (hatched or raised); every Mama Frog there gives it +L/+L. The hug comes as its
  // own step right after the hatching is shown (hugs()), so you can see who gave what.
  const newborn = [];
  const hatch = (s, i, f) => {
    T[s].splice(i, 0, f);
    newborn.push([s, f]);
    auras();
  };
  const hugs = () => {
    const born = newborn.splice(0);
    for (const s of order) for (const m of T[s]) {
      if (m.type !== 'mama' || m.hp <= 0) continue;
      const kids = born.filter(([side, f]) => side === s && f !== m && f.hp > 0).map(([, f]) => f);
      if (!kids.length) continue;
      for (const f of kids) buff(f, m.lvl, m.lvl);
      snap?.('ability', { actor: m.bid, targets: kids.map((f) => f.bid), text: `${nm(m)} hugs ${kids.length === 1 ? `the ${nm(kids[0])}` : 'the babies'}` });
    }
  };

  function onHurt(s, u) {
    if (u.type === 'toad') { buff(u, u.lvl, 0); snap?.('ability', { actor: u.bid, text: `${nm(u)} shows its claws` }); }
    if (u.type === 'midwife') arrive(s, T[s][T[s].indexOf(u) + 1], () => unit('froglet', u.lvl, u.lvl, 1, null, ++bid), false, () => `A baby hatches from ${nm(u)}`);
    if (u.type === 'rain') {
      const t = T[s][T[s].indexOf(u) + 1];
      if (t && t.hp > 0) { buff(t, u.lvl, u.lvl); snap?.('ability', { actor: u.bid, target: t.bid, text: `${nm(u)} shelters ${nm(t)}` }); }
    }
  }
  // A knocked-out frog stays in its pond (at 0 health) until everyone knocked out in the same moment leaves together.
  // next: the first frog behind it that's still standing (where its babies or raised self will line up)
  const nextOf = (s, u) => T[s].slice(T[s].indexOf(u) + 1).find((x) => x.hp > 0);
  // Its own faint ability
  function faintAbility(s, u) {
    const L = u.lvl;
    // Frogspawn (id 'tadpole'): retired from the shop (tier 0); kept only so ponds saved before still play out
    if (u.type === 'tadpole') arrive(s, nextOf(s, u), () => unit('froglet', L, L, 1, null, ++bid), false, () => `${nm(u)} hatches into a Froglet`);
    if (u.type === 'surinam') {
      // Lays as many L/L Froglets as there's room for in the pond
      arrive(s, nextOf(s, u), () => unit('froglet', L, L, 1, null, ++bid), true, () => `${nm(u)}’s babies hatch`);
    }
    if (u.type === 'tree') {
      const f = alive(s);
      if (f.length) { const t = pick(f); buff(t, 2 * L, L); snap?.('ability', { target: t.bid, text: `${nm(u)} cheers on ${nm(t)}` }); }
    }
    if (u.type === 'goliath') {
      blast(1 - s, 2 * L);
      snap?.('splash', { side: 1 - s, text: `${nm(u)} makes a huge splash` });
    }
  }
  // Other frogs reacting to it: a Bullfrog right behind it, the Hungry Frog that knocked it out, a Necromancer
  function faintReactions(s, u) {
    const behind = T[s][T[s].indexOf(u) + 1];
    if (behind && behind.type === 'bullfrog' && behind.hp > 0) {
      buff(behind, behind.lvl, behind.lvl);
      snap?.('ability', { actor: behind.bid, text: `${nm(behind)} is fired up` });
    }
    const foe = u.koBy;
    if (foe && foe.type === 'hungry' && foe.hp > 0 && T[1 - s].includes(foe)) { buff(foe, foe.lvl, foe.lvl); snap?.('ability', { actor: foe.bid, text: `${nm(foe)} wants seconds` }); }
    // Necromancer: a fainted friend rises again as a 1/1 (L times per battle), in the same spot
    if (u.type !== 'necro') {
      // one raise per Necromancer charge (charges already promised to frogs waiting to come back count as used)
      const waiting = (n) => arrivals.filter((a) => a.by === n).length;
      const n = T[s].find((x) => x.type === 'necro' && x.hp > 0 && x.uses + waiting(x) < x.lvl);
      if (n) arrive(s, nextOf(s, u), () => { const f = unit(u.type, 1, 1, u.lvl, null, ++bid); if (fixed(f)) fixUnit(f); return f; }, false, (f) => `${nm(n)} raises ${nm(f)}`, n);
    }
  }
  const fixUnit = (u) => fixStats(u);
  // Always-on bonuses, kept up to date as frogs come and go: a Paladin has +L/+L for every living enemy, a Guard
  // +L/+L for every friend right beside it. Losing the bonus never takes a stat below 1 (it isn't damage).
  const auras = (only) => {
    for (const s of [0, 1]) T[s].forEach((u, i) => {
      if (u.hp <= 0 || (u.type !== 'paladin' && u.type !== 'guard') || (only && u !== only)) return;
      const n = u.type === 'paladin' ? alive(1 - s).length : (T[s][i - 1]?.hp > 0 ? 1 : 0) + (T[s][i + 1]?.hp > 0 ? 1 : 0);
      const d = n * u.lvl - u.aura;
      if (!d) return;
      u.aura += d; u.atk = Math.max(1, u.atk + d); u.hp = Math.max(1, u.hp + d);
    });
  };
  // Everything an effect sets off, resolved one moment at a time (as in other auto battlers, with fair turns instead of
  // attack order): 1. hurt reactions; 2. knocked-out Bouncy Frogs bounce; 3. every knocked-out frog's own faint
  // ability; 4. the reactions to the knockouts; 5. everyone knocked out leaves together. Whatever a moment hurts or
  // knocks out belongs to the next one. When nothing is left, babies and raised frogs come in (6).
  // In each step the ponds take fair turns, and each pond's frogs go front to back.
  const inTurns = (kind, lists) => { const out = []; lists = lists.map((l) => [...l]); for (let x; (x = take(kind, lists.map((l) => l.length > 0))) >= 0;) out.push([x, lists[x].shift()]); return out; };
  function settle() {
    for (let guard = 0; guard < 200; guard++) {
      const hs = take('hurt', hurts.map((q) => q.length > 0));
      if (hs >= 0) { const u = hurts[hs].shift(); if (u.hp > 0 && T[hs].includes(u)) onHurt(hs, u); continue; }
      const out = () => [0, 1].map((x) => T[x].filter((u) => u.hp <= 0));
      for (const [x, u] of inTurns('faint', out().map((l) => l.filter((u) => u.type === 'bouncy' && !u.bounced)))) {
        T[x].splice(T[x].indexOf(u), 1);
        u.bounced = 1; u.hp = 2 * u.lvl; T[x].push(u);
        auras();
        snap?.('ability', { actor: u.bid, text: `${nm(u)} bounces to the back` });
      }
      const moment = inTurns('faint', out());
      if (!moment.length) {
        if (arrivals.length) { letIn(); continue; } // everyone knocked out has left: babies and raised frogs come in
        return auras();
      }
      for (const [x, u] of moment) faintAbility(x, u);
      for (const [x, u] of moment) faintReactions(x, u);
      for (const [x, u] of moment) T[x].splice(T[x].indexOf(u), 1);
      auras();
      snap?.('faint', { actors: moment.map(([, u]) => u.bid) });
    }
    auras();
  }

  snap?.('start');
  // Chameleons take on the ability of the friend behind them first (back to front, so chains copy the
  // finished copy), so a copied start-of-battle ability still fires below. They keep their own stats, level and gear
  // (unless the ability sets its stats, like the Frog King's).
  for (const s of order) {
    for (let i = T[s].length - 2; i >= 0; i--) {
      const u = T[s][i], b = T[s][i + 1];
      if (u.type !== 'chameleon' || b.type === 'chameleon') continue;
      u.type = b.type;
      fixUnit(u);
      snap?.('morph', { actor: u.bid, text: `Chameleon turns into ${an(nm(b))}` });
    }
  }
  // Paladins and Guards size up the ponds
  for (const s of order) for (const u of T[s]) {
    auras(u);
    if (u.aura && u.type === 'paladin') snap?.('ability', { actor: u.bid, text: `${nm(u)} takes on ${u.aura / u.lvl} ${u.aura === u.lvl ? 'enemy' : 'enemies'}` });
    if (u.aura && u.type === 'guard') snap?.('ability', { actor: u.bid, text: `${nm(u)} stands with its friends` });
  }
  // Start of battle: the ponds take turns, one start-of-battle frog each (each pond's are taken front to back), so
  // two of one pond's never go in a row while the other pond still has one waiting, however many frogs stand
  // before them. opts.first says which pond starts; fight() switches it every round, so neither seat always acts first.
  // Each frog's effect is settled right away (knockouts, hurt reactions, babies), before the next frog acts; frogs
  // that turn up during start of battle (babies, raised frogs) don't get a turn of their own
  const lines = T.map((t) => t.filter((u) => START_OF_BATTLE.has(u.type)));
  // L random enemies from a list (fewer if there aren't that many)
  const some = (pool, L) => { const out = []; pool = [...pool]; while (out.length < L && pool.length) out.push(pool.splice(rand(pool.length), 1)[0]); return out; };
  // a pond's next start-of-battle frog that's still standing in it (knocked-out ones lose their go, not their pond's turn)
  const waiting = (x) => { while (lines[x].length && !(lines[x][0].hp > 0 && T[x].includes(lines[x][0]))) lines[x].shift(); return lines[x].length > 0; };
  for (let s; (s = take('start', [waiting(0), waiting(1)])) >= 0;) {
    {
      const u = lines[s].shift();
      const L = u.lvl;
      if (u.type === 'hypno') {
        // Sends the enemy's front frog to the back, L times (one step each, so you can follow it)
        for (let k = 0; k < L; k++) {
          const line = T[1 - s], e = line.find((x) => x.hp > 0);
          if (!e || alive(1 - s).length < 2) { if (!k) snap?.('ability', { actor: u.bid, text: `${nm(u)} has no one to send away` }); break; }
          line.splice(line.indexOf(e), 1); line.push(e);
          auras();
          snap?.('ability', { actor: u.bid, target: e.bid, text: `${nm(u)} sends ${nm(e)} to the back` });
        }
      }
      if (u.type === 'wizard') {
        // Shrinks the L strongest enemies to 1/1 (skipping ones that already are); they keep their abilities
        const foes = alive(1 - s).filter((e) => e.atk + e.hp > 2 && !fixed(e)).sort((x, y) => y.atk + y.hp - (x.atk + x.hp)).slice(0, L);
        for (const e of foes) { e.atk = 1; e.hp = 1; }
        // (it always casts, so it's clear it acted even when there was no one to shrink)
        snap?.('spell', { actor: u.bid, targets: foes.map((e) => e.bid), text: foes.length ? `${nm(u)} shrinks the enemy` : `${nm(u)}’s spell finds no one to shrink` });
      }
      if (u.type === 'jester') {
        // Swaps attack and health of L random enemies (ones where that changes something)
        const foes = some(alive(1 - s).filter((e) => e.atk !== e.hp && !fixed(e)), L);
        for (const e of foes) { const a = e.atk; e.atk = e.hp; e.hp = a; }
        snap?.('spell', { actor: u.bid, targets: foes.map((e) => e.bid), text: foes.length ? `${nm(u)} turns the enemy upside down` : `${nm(u)}’s trick changes nothing` });
      }
      if (u.type === 'princess') {
        // Charmed by her beauty, the strongest enemies hit themselves
        const foes = alive(1 - s).sort((x, y) => y.atk + y.hp - (x.atk + x.hp)).slice(0, L);
        if (foes.length) {
          for (const e of foes) damage(1 - s, e, e.atk);
          snap?.('charm', { actor: u.bid, targets: foes.map((e) => e.bid), text: `${nm(u)} charms the enemy` });
        }
      }
      if (u.type === 'spitter') {
        const e = alive(1 - s);
        for (let k = 0; k < L && e.length; k++) { const t = e.splice(rand(e.length), 1)[0]; damage(1 - s, t, 2); snap?.('spit', { actor: u.bid, target: t.bid, text: `${nm(u)} spits at ${nm(t)}` }); }
      }
      if (u.type === 'archer') {
        // Shoots the enemy's last L frogs, 2 damage each
        for (const t of alive(1 - s).slice(-L).reverse()) { damage(1 - s, t, 2); snap?.('spit', { actor: u.bid, target: t.bid, arrow: true, text: `${nm(u)} shoots at ${nm(t)}` }); }
      }
      if (u.type === 'dragon') {
        blast(1 - s, L);
        snap?.('splash', { side: 1 - s, actor: u.bid, fire: true, text: `${nm(u)} breathes fire` });
      }
      if (u.type === 'budgett') {
        // A scream so scary that every enemy loses L attack this battle (down to 1)
        const foes = alive(1 - s).filter((e) => !fixed(e) && e.atk > 1);
        for (const e of foes) e.atk = Math.max(1, e.atk - L);
        snap?.('splash', { side: 1 - s, actor: u.bid, scream: true, text: `${nm(u)} screams` });
      }
      if (u.type === 'prince') {
        T[s].forEach((f) => f !== u && buff(f, L, L));
        snap?.('ability', { actor: u.bid, text: `${nm(u)} rallies the pond` });
      }
      if (u.type === 'squire') {
        const t = T[s][T[s].indexOf(u) - 1];
        if (t && t.hp > 0) { buff(t, L, L); snap?.('ability', { actor: u.bid, target: t.bid, text: `${nm(u)} helps ${nm(t)}` }); }
        else snap?.('ability', { actor: u.bid, text: `${nm(u)} has no one ahead to help` });
      }
      if (u.type === 'cleric') {
        // Blesses the L friends ahead of it with a Bubble (not ones already in one)
        const at = T[s].indexOf(u), friends = T[s].slice(Math.max(0, at - L), at).filter((f) => f.hp > 0 && !f.gear);
        for (const f of friends) { f.gear = 'bubble'; f.blocked = false; }
        snap?.('ability', { actor: u.bid, text: friends.length ? `${nm(u)} blesses ${friends.length === 1 ? nm(friends[0]) : 'its friends'}` : `${nm(u)} has no one ahead to bless` });
      }
      settle();
    }
  }

  // frames from here on are the fighting itself (the page's log starts its "Battle" section here)
  const fightAt = frames.length;
  let turns = 0;
  while (T[0].length && T[1].length && turns++ < 60) {
    const a = T[0][0], b = T[1][0];
    for (const u of [a, b]) if (u.type === 'knight') { buff(u, u.lvl, 0); snap?.('ability', { actor: u.bid, text: `${nm(u)} raises its sword` }); }
    // Who each front frog hits: the enemy ahead; a Leapfrog the enemy's last L frogs; a Pebble Toad all of them
    // (frogs guarded by a Frog King are left out; the front frog never is)
    const targets = (u, s) => unguarded(1 - s, u.type === 'leapfrog' ? T[1 - s].slice(-u.lvl) : u.type === 'pebble' ? [...T[1 - s]] : [T[1 - s][0]], true);
    const ta = targets(a, 0), tb = targets(b, 1), da = a.atk, db = b.atk;
    for (const t of ta) { damage(1, t, da, a, true); if (t.hp <= 0 && da > 0) t.koBy = a; }
    for (const t of tb) { damage(0, t, db, b, true); if (t.hp <= 0 && db > 0) t.koBy = b; }
    const leaps = [[a, ta], [b, tb]].filter(([u]) => u.type === 'leapfrog').map(([u, ts]) => [u.bid, ts.map((t) => t.bid)]);
    const wide = [[a, ta], [b, tb]].filter(([u]) => u.type === 'pebble').map(([u, ts]) => [u.bid, ts.map((t) => t.bid)]);
    snap?.('hit', { ids: [a.bid, b.bid], ...(leaps.length ? { leaps } : {}), ...(wide.length ? { wide } : {}) });
    settle();
  }
  const winner = T[0].length && !T[1].length ? 0 : T[1].length && !T[0].length ? 1 : -1;
  snap?.('end');
  return { frames, winner, fightAt };
}

// ---------- Players and rounds ----------
const newPlayerState = () => ({ hearts: START_HEARTS, trophies: 0, gold: START_GOLD, team: Array(TEAM_SIZE).fill(null), shop: null, ready: false });
function resetGame(room) {
  room.round = 1; room.phase = room.players.length === 2 ? 'shop' : 'waiting'; room.lastBattle = null; room.winner = null;
  room.game = (room.game || 0) + 1;
  room.log = []; room.gameStarted = Date.now();
  for (const p of room.players) Object.assign(p, { hearts: START_HEARTS, trophies: 0, gold: START_GOLD, team: Array(TEAM_SIZE).fill(null), ready: false }), rollShop(p, 1, setOf(room));
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

// Who can take an item: one piece of gear per frog; a Cricket only helps below level 3; frogs with fixed
// stats (Frog King) have no use for stat bugs
function canTake(t, food) {
  if (!t) return false;
  if (food.gear) return !t.gear;
  if (food.xp) return t.lvl < 3;
  return FROGS[t.type].fixed !== 'both';
}
// Shop-side ability effects for the page to play (who gave, who got it, how much): a Peeper's or Bard's buy.
// Numbered, so each plays once; only the last few are kept. (End-of-round gifts go with the battle: lastBattle.before)
function shopFx(p, kind, from, to, atk = 0, hp = 0) {
  p.fxN = (p.fxN || 0) + 1;
  p.fx = [...(p.fx || []).slice(-5), { n: p.fxN, kind, from: from.id, to: to.map((t) => t.id), atk, hp }];
}
function afterMerge(t) { t.lvl = levelOf(t.xp); fixStats(t); }

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
      const others = team.filter((x) => x && x !== target);
      if (target.type === 'peeper' && others.length) { const o = pick(others); o.atk += target.lvl; fixStats(o); shopFx(p, 'buy', target, [o], target.lvl, 0); }
      if (target.type === 'bard') {
        const got = [];
        for (let k = 0; k < 2 && others.length; k++) { const o = others.splice(rand(others.length), 1)[0]; o.hp += target.lvl; got.push(o); }
        if (got.length) shopFx(p, 'buy', target, got, 0, target.lvl);
      }
      team.forEach((x) => x && fixStats(x));
      break;
    }
    case 'food': {
      const t = team[slot];
      const cost = shop.foodCost ?? foodCost(shop.food);
      if (!shop.food || !t || p.gold < cost) return;
      const food = FOODS[shop.food];
      if (!canTake(t, food)) return;
      p.gold -= cost; t.atk += food.atk; t.hp += food.hp; shop.food = null;
      if (food.gear) t.gear = food.gear;
      // A Cricket counts as one more copy of the frog: its stats go up by 1/1 and it's a step closer to leveling up
      if (food.xp) { t.xp += food.xp; afterMerge(t); }
      fixStats(t);
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
      p.gold += t.lvl * (t.type === 'merchant' ? 2 : 1); team[slot] = null;
      if (t.type === 'glass') {
        const others = team.filter(Boolean);
        if (others.length) { const f = pick(others); f.atk += t.lvl; f.hp += t.lvl; fixStats(f); }
      }
      break;
    }
    case 'roll': { // also cancels a lock: a fresh shop is never locked
      if (p.gold < ROLL_COST) return;
      p.gold -= ROLL_COST; rollShop(p, room.round, setOf(room));
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
  // End-of-turn abilities (permanent). before: what they did, per seat: the page plays it on your pond right before
  // the battle (from/to are frog ids) and lists it in the battle log
  const before = room.players.map(() => []);
  room.players.forEach((p, seat) => {
    p.team.forEach((f, i) => {
      if (f && f.type === 'lily') {
        for (let j = i - 1; j >= 0; j--) if (p.team[j]) { p.team[j].hp += f.lvl; fixStats(p.team[j]); before[seat].push({ from: f.id, to: p.team[j].id, atk: 0, hp: f.lvl, text: `${FROGS.lily.name} gives ${FROGS[p.team[j].type].name} +${f.lvl} health` }); break; }
      }
      if (f && f.type === 'blacksmith') {
        for (let j = i - 1; j >= 0; j--) if (p.team[j]) { p.team[j].atk += f.lvl; fixStats(p.team[j]); before[seat].push({ from: f.id, to: p.team[j].id, atk: f.lvl, hp: 0, text: `${FROGS.blacksmith.name} gives ${FROGS[p.team[j].type].name} +${f.lvl} attack` }); break; }
      }
    });
  });
  // simulations skip the animation frames; the pond whose frogs act first switches every round
  const { frames, winner, fightAt } = runBattle(A.team, B.team, { frames: !room.sim, first: room.round % 2 === 0 });
  // Bubbles only protect for the battle right after they are given
  for (const p of room.players) for (const f of p.team) if (f && f.gear === 'bubble') delete f.gear;
  if (winner >= 0) { room.players[winner].trophies++; room.players[1 - winner].hearts--; }
  // before / after: per seat, what happened around the battle itself (for the log)
  room.lastBattle = { id: room.sim ? '' : Math.random().toString(36).slice(2, 10), round: room.round, frames, winner, fightAt, before, after: room.players.map(() => []) };
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
    const lucky = p.team.reduce((g, f) => g + (f && f.type === 'lucky' ? f.lvl + 1 : 0), 0);
    p.gold = START_GOLD + lucky;
    if (lucky) room.lastBattle.after[room.players.indexOf(p)].push(`${FROGS.lucky.name}: +${lucky} gold next round`);
    if (p.shop && p.shop.locked) refillShop(p, room.round, setOf(room)); else rollShop(p, room.round, setOf(room));
  }
}

module.exports = {
  TEAM_SIZE, ROLL_COST, LOCK_COST, FROGS, FOODS, SETS, DEFAULT_SET, setOf, canTake, hooks,
  rand, bumpId, frogCost, newFrog, runBattle, newPlayerState, resetGame, botShop, act,
};
