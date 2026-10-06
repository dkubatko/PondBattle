#!/usr/bin/env node
// Live stats (tools/live-stats.js): how frogs do in games real players played, per release. It reads the game history
// (games.jsonl) from Tower over ssh, read-only, and prints a report; it changes nothing.
//
//   node tools/live-stats.js                    every set, every release, practice games left out
//   node tools/live-stats.js --set magic        one set
//   node tools/live-stats.js --since 1.1.0      only games from that release on
//   node tools/live-stats.js --version 1.2      only games on that release or series (1.2 = 1.2.0, 1.2.1, ...)
//   node tools/live-stats.js --pair king+necro  also: boards with both frogs (several space-separated)
//   options: --ranked (ranked games only), --practice (include games against Pond Bot), --file PATH (a local copy
//            instead of Tower's), --json
//
// Each battle gives two boards (one per player) and, unless it was a draw, one winner. A frog's win rate is how often
// boards with it won their battle (draws left out), so 50% is average; ± is a 95% margin (Wilson), and "few" marks numbers
// from under 30 boards, which say little. Lv2+ is how many of its boards had it at level 2 or 3.
// The release a game was played on: its "version" (recorded since 1.1.1). Older games are placed by when they
// ended, against the release tags' times (a game that straddled a deploy can land one release off); games from before
// the first release show as "pre-1.0". Unfinished games (ended early) count: their battles were real.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REMOTE = { host: 'tower', file: '/mnt/cache/appdata/pondbattle/data/games.jsonl' };
const FROGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'frogs.json'), 'utf8'));
const SETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'sets.json'), 'utf8'));
const DEFAULT_SET = Object.keys(SETS)[0]; // games from before sets existed played the first set (engine.js setOf)

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; };
const ONLY = opt('set', null), SINCE = opt('since', null), VER = opt('version', null), RANKED = !!opt('ranked', false), PRACTICE = !!opt('practice', false);
const FILE = opt('file', null), PAIRS = opt('pair', null), JSON_OUT = !!opt('json', false);
const FEW = 30;

// versions in order: "pre-1.0" first, then by number
const vkey = (v) => (v === 'pre-1.0' ? [-1] : v.split('.').map(Number));
const vcmp = (a, b) => { const x = vkey(a), y = vkey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
// release tags and when they were made (newest last)
const tags = execFileSync('git', ['-C', ROOT, 'for-each-ref', '--sort=creatordate', '--format=%(refname:short) %(creatordate:iso-strict)', 'refs/tags/v*'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).map((l) => { const [t, at] = l.split(' '); return { version: t.slice(1), at: Date.parse(at) }; });
const versionOf = (g) => {
  if (g.version) return g.version;
  const t = Date.parse(g.endedAt || g.startedAt || 0);
  let v = 'pre-1.0';
  for (const tag of tags) if (tag.at <= t) v = tag.version;
  return v;
};

const text = FILE ? fs.readFileSync(FILE, 'utf8') : execFileSync('ssh', [REMOTE.host, `cat ${REMOTE.file}`], { encoding: 'utf8', maxBuffer: 1 << 30 });
const games = [];
for (const line of text.split('\n')) { if (!line.trim()) continue; try { games.push(JSON.parse(line)); } catch {} }

const pairs = !PAIRS || PAIRS === true ? [] : PAIRS.trim().split(/\s+/).map((s) => s.split('+'));
const vs = {}; // version -> { games, unfinished, battles, draws }
const stat = {}; // set -> frog -> version -> [wins, boards, lv2]
const pairStat = {}; // set -> pair -> version -> [wins, boards]
let used = 0, first = null, last = null;
for (const g of games) {
  const bot = (g.players || []).some((p) => p.bot);
  if ((g.practice || bot) && !PRACTICE) continue;
  if (RANKED && !g.ranked) continue;
  const set = g.set || DEFAULT_SET, v = versionOf(g);
  if (ONLY && set !== ONLY) continue;
  if (SINCE && vcmp(v, SINCE) < 0) continue;
  if (VER && v !== VER && !v.startsWith(`${VER}.`)) continue;
  used++; first = first && first < g.endedAt ? first : g.endedAt; last = last && last > g.endedAt ? last : g.endedAt;
  const V = (vs[v] ??= { games: 0, unfinished: 0, battles: 0, draws: 0 });
  V.games++; if (g.unfinished) V.unfinished++;
  for (const e of g.log || []) {
    V.battles++;
    if (e.winner == null || e.winner < 0) { V.draws++; continue; }
    (e.teams || []).forEach((team, side) => {
      const w = e.winner === side ? 1 : 0, best = new Map();
      for (const f of team || []) if (f) best.set(f.type, Math.max(best.get(f.type) || 0, f.lvl || 1));
      for (const [type, lvl] of best) { const c = ((stat[set] ??= {})[type] ??= {})[v] ??= [0, 0, 0]; c[0] += w; c[1]++; if (lvl >= 2) c[2]++; }
      for (const [x, y] of pairs) if (best.has(x) && best.has(y)) { const c = ((pairStat[set] ??= {})[`${x}+${y}`] ??= {})[v] ??= [0, 0]; c[0] += w; c[1]++; }
    });
  }
}

const Z = 1.96;
// the margin is half the Wilson interval's width, so it stays honest for small counts and for 0% or 100%
const num = (c) => {
  const n = c[1], p = c[0] / n, z2 = Z * Z;
  return { boards: n, win: p, margin: (Z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n)), lv2: c[2] != null ? c[2] / n : undefined, few: n < FEW };
};
const out = { games: used, from: first, to: last, versions: vs, sets: {} };
for (const set of Object.keys(stat).sort()) {
  const frogs = {};
  for (const [type, byV] of Object.entries(stat[set])) frogs[type] = Object.fromEntries(Object.entries(byV).sort((a, b) => vcmp(a[0], b[0])).map(([v, c]) => [v, num(c)]));
  const pr = {};
  for (const [k, byV] of Object.entries(pairStat[set] || {})) pr[k] = Object.fromEntries(Object.entries(byV).sort((a, b) => vcmp(a[0], b[0])).map(([v, c]) => [v, num(c)]));
  out.sets[set] = { frogs, pairs: pr };
}
if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

const pad = (s, n) => String(s).padEnd(n);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const row = (r) => `${pad(r.boards, 8)}${pad(`${pct(r.win)} ±${(r.margin * 100).toFixed(1)}`, 15)}${pad(r.lv2 == null ? '' : `${Math.round(r.lv2 * 100)}%`, 6)}${r.few ? 'few' : ''}`;
console.log(`Pond Brawl live stats: ${used} games${PRACTICE ? '' : ' (practice left out)'}${RANKED ? ', ranked only' : ''}${ONLY ? `, ${ONLY}` : ''}${SINCE ? `, from ${SINCE}` : ''}${VER ? `, ${VER}${/^\d+\.\d+$/.test(VER) ? '.x' : ''}` : ''}, ${first ? first.slice(0, 10) : '-'} to ${last ? last.slice(0, 10) : '-'}${FILE ? '' : ' (from Tower)'}`);
console.log(`\n${pad('release', 10)}${pad('games', 7)}${pad('unfinished', 12)}${pad('battles', 9)}draws`);
for (const v of Object.keys(vs).sort(vcmp)) console.log(`${pad(v, 10)}${pad(vs[v].games, 7)}${pad(vs[v].unfinished || '-', 12)}${pad(vs[v].battles, 9)}${vs[v].battles ? pct(vs[v].draws / vs[v].battles) : '-'}`);
for (const [set, r] of Object.entries(out.sets)) {
  console.log(`\n=== ${SETS[set] ? SETS[set].name : set}`);
  console.log(`${pad('frog', 14)}${pad('tier', 6)}${pad('release', 10)}${pad('boards', 8)}${pad('win ±', 15)}Lv2+`);
  const inSet = SETS[set] ? SETS[set].frogs : [];
  const order = Object.keys(r.frogs).sort((a, b) => (inSet.includes(b) - inSet.includes(a)) || ((FROGS[a] || {}).tier || 9) - ((FROGS[b] || {}).tier || 9) || a.localeCompare(b));
  for (const type of order) {
    const tier = !FROGS[type] ? '?' : inSet.includes(type) ? FROGS[type].tier : FROGS[type].tier === 0 ? 'gone' : 'other';
    Object.entries(r.frogs[type]).forEach(([v, x], i) => console.log(`${pad(i ? '' : type, 14)}${pad(i ? '' : tier, 6)}${pad(v, 10)}${row(x)}`));
  }
  for (const [k, byV] of Object.entries(r.pairs)) Object.entries(byV).forEach(([v, x], i) => console.log(`${pad(i ? '' : `pair ${k}`, 20)}${pad(v, 10)}${row(x)}`));
}
console.log(`\nwin = how often boards with the frog won their battle (draws left out; 50% is average); few = under ${FEW} boards`);
