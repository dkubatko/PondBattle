// Pond Battle — ranked play: rank tiers with 5 points each, and the Frog Legends. No dependencies.
// A player's standing is one number, their level: 5 points per tier (Tadpole 0-4, Froglet 5-9, Frog 10-14,
// Master Frog 15+).
// Only games found with the Play button count.
'use strict';
const PIPS = 5; // points per tier
const TIERS = [
  { id: 'tadpole', name: 'Tadpole' },
  { id: 'froglet', name: 'Froglet' },
  { id: 'frog', name: 'Frog' },
  { id: 'master', name: 'Master Frog' },
];
const TOP = (TIERS.length - 1) * PIPS; // where the last tier starts
const FULL = TIERS.length * PIPS; // the last tier full: points past this count toward Frog Legend
const LEGEND = { id: 'legend', name: 'Frog Legend' }, LEGENDS = 10;
// Players this many levels apart are "much stronger/weaker"
const GAP = 3;

const level = (pr) => Math.max(0, (pr && pr.level) | 0);
// Points for one game: +1 for a win and −1 for a loss against a similar player. Beating a much stronger
// player is +2 and losing to one costs nothing; losing to a much weaker player is −2.
function points(mine, theirs, won) {
  const d = theirs - mine;
  if (won) return d >= GAP ? 2 : 1;
  return d >= GAP ? 0 : d <= -GAP ? -2 : -1;
}
// A tier once reached is kept: losses stop at its first point
const floor = (lvl) => Math.min(TOP, Math.floor(lvl / PIPS) * PIPS);
const apply = (lvl, pts) => Math.max(floor(lvl), lvl + pts);

// Everyone who has played a ranked game, best first (more points, then whoever got there first). The first
// LEGENDS of them with a full top tier are the Frog Legends. Cached until levels change.
let boardCache = null, legendCache = null;
function board(profiles) {
  if (!boardCache) {
    boardCache = Object.entries(profiles).filter(([, p]) => p.rgames > 0)
      .sort(([, a], [, b]) => level(b) - level(a) || (a.levelAt || 0) - (b.levelAt || 0)).map(([uid]) => uid);
  }
  return boardCache;
}
function legends(profiles) {
  if (!legendCache) legendCache = board(profiles).filter((uid) => level(profiles[uid]) >= FULL).slice(0, LEGENDS);
  return legendCache;
}
const forget = () => { boardCache = legendCache = null; };
// A player's rank: { id, name, level, pips (points in the tier, 0-5), extra (points past a full top tier), pos (Frog Legends: 1-10) }
function rankOf(uid, profiles) {
  const lvl = level(profiles[uid]), t = Math.min(TIERS.length - 1, Math.floor(lvl / PIPS));
  const pos = legends(profiles).indexOf(uid) + 1;
  return {
    id: pos ? LEGEND.id : TIERS[t].id, name: pos ? LEGEND.name : TIERS[t].name, level: lvl,
    pips: Math.min(PIPS, lvl - t * PIPS), extra: Math.max(0, lvl - FULL), ...(pos ? { pos } : {}),
  };
}

// Avatar options earned with rank; anything not listed is open to everyone. Keys are the avatar fields: b body,
// c color (index), e eyes, t pattern, a extra, l lily pad style, lc lily pad color (index). The page gets this table
// too (it lists each setting's options by the rank that unlocks them); the server enforces it. Every setting
// has something at every rank.
const RANK_IDS = [...TIERS.map((t) => t.id), LEGEND.id];
const UNLOCKS = {
  froglet: { b: ['tadpole'], c: [4, 11], e: ['lashes', 'brows'], t: ['freckles'], a: ['coin', 'pearls', 'horns', 'umbrella', 'robin', 'turban'], l: ['clover'], lc: [5, 6] },
  frog: { b: ['tall'], c: [10], e: ['violet'], t: ['bands'], a: ['tiara', 'helmet', 'wizard', 'jester', 'mitre', 'kettle', 'mask'], l: ['dew'], lc: [7, 8] },
  master: { b: ['flat'], c: [6], e: ['red'], t: ['stripes'], a: ['crown', 'pendulum', 'wings'], l: ['heart'], lc: [11] },
  legend: { b: ['bull'], c: [12], e: ['spiral'], t: ['glass'], a: ['kingcrown', 'halo', 'cape'], l: ['lotus'], lc: [9] },
};
const AVATAR_DEFAULTS = { b: 'classic', c: 0, e: 'dark', t: 'none', a: 'none', l: 'classic', lc: 0 };
// The rank an option needs, or '' if it's open
const needs = (key, id) => Object.keys(UNLOCKS).find((tier) => (UNLOCKS[tier][key] || []).includes(id)) || '';
// An avatar with everything the rank hasn't earned yet put back to the default
function fitAvatar(av, rankId) {
  const have = RANK_IDS.indexOf(rankId), out = { ...av };
  for (const k of Object.keys(AVATAR_DEFAULTS)) { const t = needs(k, out[k]); if (t && RANK_IDS.indexOf(t) > have) out[k] = AVATAR_DEFAULTS[k]; }
  return out;
}

module.exports = { PIPS, TIERS, LEGEND, LEGENDS, GAP, level, points, apply, rankOf, board, forget, UNLOCKS, needs, fitAvatar };
