#!/usr/bin/env node
// Battle audit: plays many random battles in every set with battle frames on and checks the rules every frame
// must follow. Exits 1 on any broken rule (CI runs it before an image is published). It makes no balance
// judgements; that's tools/simulate.js.
//
//   node tools/audit.js              20,000 battles per set (a few seconds)
//   node tools/audit.js --battles N  more or fewer
//   node tools/audit.js --seed N     other random teams (default 1)
const G = require('../engine.js');
const { FROGS, FOODS, SETS } = G;

const opt = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? +process.argv[i + 1] : d; };
const BATTLES = opt('battles', 20000), SEED = opt('seed', 1);
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const KINDS = new Set(['start', 'ability', 'spell', 'charm', 'spit', 'splash', 'summon', 'morph', 'hit', 'faint', 'end']);
const CAPTIONED = new Set(['ability', 'spell', 'charm', 'spit', 'splash', 'summon', 'morph']);
const START_ONCE = new Set(['spell', 'charm', 'splash']); // a start-of-battle frog's own move, once per battle
const GEAR = Object.keys(FOODS).filter((k) => FOODS[k].gear).map((k) => FOODS[k].gear);
const issues = new Map();
const flag = (rule, ex) => { const i = issues.get(rule) || { n: 0, ex }; i.n++; issues.set(rule, i); };
let battles = 0, frames = 0;
const t0 = Date.now();

for (const set of Object.keys(SETS)) {
  const r = mulberry32(SEED * 7919 + set.length); // the teams; the engine's own dice use this too
  Math.random = r;
  const pool = SETS[set].frogs;
  // A random pond: 1-5 frogs of any tier and level, with some growth from the shop, some wearing gear
  const pond = () => Array.from({ length: 1 + Math.floor(r() * 5) }, () => {
    const type = pool[Math.floor(r() * pool.length)], f = FROGS[type], lvl = r() < .6 ? 1 : r() < .7 ? 2 : 3;
    const u = { type, lvl, atk: f.atk + (lvl - 1) * 2 + Math.floor(r() * 3), hp: f.hp + (lvl - 1) * 2 + Math.floor(r() * 4), gear: GEAR.length && r() < .1 ? GEAR[Math.floor(r() * GEAR.length)] : null };
    if (f.fixed) { const [a, h] = G.fixedStats(type, lvl); u.atk = a; if (f.fixed === 'both') u.hp = h; }
    return u;
  });
  for (let g = 0; g < BATTLES; g++) {
    const A = pond(), B = pond();
    const ex = { set, A: A.map((u) => `${u.type}${u.lvl} ${u.atk}/${u.hp}${u.gear ? ` ${u.gear}` : ''}`), B: B.map((u) => `${u.type}${u.lvl} ${u.atk}/${u.hp}${u.gear ? ` ${u.gear}` : ''}`) };
    let res;
    try { res = G.runBattle(A, B, { first: r() < .5 }); } catch (e) { flag(`the battle throws: ${e.message}`, ex); continue; }
    const F = res.frames; battles++; frames += F.length;
    if (F[0].kind !== 'start') flag('the first frame is not "start"', ex);
    const end = F[F.length - 1];
    if (end.kind !== 'end') flag('the last frame is not "end"', ex);
    const w = end.a.length && !end.b.length ? 0 : end.b.length && !end.a.length ? 1 : -1;
    if (w !== res.winner) flag('the winner doesn\'t match the ponds left at the end', ex);
    if ([...end.a, ...end.b].some((u) => u.hp <= 0)) flag('a knocked-out frog is still there at the end', ex);
    if (!(res.fightAt > 0 && res.fightAt <= F.length)) flag('fightAt is outside the battle', ex);
    const acted = new Set();
    for (let k = 1; k < F.length; k++) {
      const fr = F[k], pv = F[k - 1], at = { ...ex, frame: k, kind: fr.kind, text: fr.text };
      if (!KINDS.has(fr.kind)) flag(`unknown frame kind "${fr.kind}"`, at);
      const now = new Map([...fr.a, ...fr.b].map((u) => [u.id, u])), was = new Map([...pv.a, ...pv.b].map((u) => [u.id, u]));
      for (const id of now.keys()) if (!was.has(id) && fr.kind !== 'summon') flag(`a frog appears in a "${fr.kind}" frame`, at);
      for (const id of was.keys()) if (!now.has(id) && fr.kind !== 'faint') flag(`a frog vanishes in a "${fr.kind}" frame`, at);
      if (fr.kind === 'faint' && [...was.keys()].every((id) => now.has(id))) flag('a "faint" frame where nobody leaves', at);
      if (fr.a.length > 5 || fr.b.length > 5) flag('more than 5 frogs in a pond', at);
      // knocked-out frogs stay (at 0 health) only until their moment is over: never into the next hit or the end
      if ((fr.kind === 'hit' || fr.kind === 'end') && [...pv.a, ...pv.b].some((u) => u.hp <= 0)) flag(`a knocked-out frog is still there at a "${fr.kind}"`, at);
      for (const u of now.values()) if (u.atk < 0) flag('negative attack', at);
      // whoever acts must be in the battle, and standing (knocked-out frogs only act as they faint or are raised)
      for (const key of ['actor', 'target', 'by']) {
        const id = fr[key]; if (id == null) continue;
        const u = was.get(id) || now.get(id);
        if (!u) flag(`the "${fr.kind}" frame's ${key} isn't in the battle`, at);
        else if (key !== 'target' && !['summon', 'faint'].includes(fr.kind) && !(fr.text || '').includes('bounces') && was.get(id) && was.get(id).hp <= 0) flag(`a knocked-out frog acts in a "${fr.kind}" frame`, at);
      }
      for (const id of fr.targets || []) if (!was.has(id) && !now.has(id)) flag(`a "${fr.kind}" frame targets a frog that isn't there`, at);
      if (CAPTIONED.has(fr.kind) && !fr.text) flag(`a "${fr.kind}" frame has no caption`, at);
      if (k < res.fightAt && fr.actor != null && START_ONCE.has(fr.kind)) {
        const key = `${fr.actor}:${fr.kind}`;
        if (acted.has(key)) flag('a start-of-battle frog acts twice', at);
        acted.add(key);
      }
    }
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (!issues.size) { console.log(`audit ok: ${battles.toLocaleString('en-US')} battles, ${frames.toLocaleString('en-US')} frames, no broken rules (${secs}s)`); process.exit(0); }
console.log(`audit FAILED: ${battles.toLocaleString('en-US')} battles (${secs}s)`);
for (const [rule, { n, ex }] of issues) console.log(`  ${n}× ${rule}\n     e.g. ${JSON.stringify(ex)}`);
process.exit(1);
