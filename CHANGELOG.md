# Pond Brawl changelog

Changes players notice, newest first, in their words ("Hypno Frog now acts at the start of battle", not
"fix act() ordering"). The newest numbered heading is the game's version: the server reads it, and only tagged
releases go live (see CLAUDE.md, Releases). Each release's section is also its patch notes in the Pond Brawl
group (`tools/post-notes.js`): a short intro line if you like, then `### New`, `### Changes`, `### Balance`,
`### Fixes` with one bullet per change.

## Unreleased

## 1.3.0 (2026-10-08)

A Nature update: a frog-eating Cane Toad, and a reworked Turtle Frog and Pebble Toad.

### New
- **Cane Toad** joins Nature in place of the Golden Frog: tier 4, 4/4. End of round: eats the friend ahead and gains +3/+3 (+5/+5 at level 2, +7/+7 at level 3) for good

### Changes
- **Turtle Frog** reworked: takes at most 5 damage per hit (4 at level 2, 3 at level 3)
- **Pebble Toad** reworked: hits the enemy ahead for its attack and every other enemy for 2 (4, 6); its attack now grows like other frogs'
- **Golden Frog** is removed from Nature
- The Hungry Frog is now called the **Horned Frog**, its real name

## 1.2.5 (2026-10-07)

### New
- **Invite friends** while you look for a ranked game: send a "Join me" card to any chat; it opens the game straight into a search, so you get matched

## 1.2.4 (2026-10-06)

### Fixes
- The winner's crown is as big as the crown a frog can wear
- Frog descriptions no longer show in huge text on iPhones after a battle

## 1.2.3 (2026-10-06)

### Balance
- **Leapfrog** leaps over the enemy’s front 1, 2 or 3 frogs (by level) and hits the next one (was always the last frog)

## 1.2.2 (2026-10-06)

### Changes
- How to play shows what each level does: numbers like 1 › 2 › 3 are levels 1, 2 and 3

## 1.2.1 (2026-10-06)

### Balance
- **Vampire Frog** 2/2 → 1/1

## 1.2.0 (2026-10-06)

A balance update: the Necromancer, Frog King and Wizard are toned down, and the Vampire Frog gets a new bite.

### Changes
- **Vampire Frog** reworked. Start of battle: bites a random enemy and steals 1 health (2 at level 2, 3 at level 3) to keep for good. A bite never knocks a frog out
- New animations: the Vampire's bite, and the Berserker now throws its axe

### Balance
- **Necromancer** raises one friend per battle at every level, now as a 1/1, 3/3 or 5/5 (was 1, 2 or 3 friends as 1/1)
- **Frog King** 3/6 · 6/12 · 9/18 → 2/4 · 4/6 · 6/8
- **Wizard** shrinks the 1, 2 or 3 strongest enemies to 2/2 (was 1/1)

## 1.1.1 (2026-10-06)

### Changes
- Behind the scenes: game records now note the version each game was played on, to help with balancing

## 1.1.0 (2026-10-06)

A new frog joins Might & Magic.

### New
- **Vampire Frog** (tier 2, 2/2). Start of battle: bites a random enemy and steals 1/1 (2/2 at level 2, 3/3 at level 3). A bite never knocks a frog out

### Changes
- **Jester Frog** is removed from Might & Magic

## 1.0.0 (2026-10-06)

The first official release of Pond Brawl! A cozy frog auto-battler: build a pond, merge frogs to level them up,
and brawl other players.

### New
- Two frog sets, Nature and Might & Magic, with 20 frogs each
- Ranked play: Play finds an opponent near your rank. Climb from Tadpole to Master Frog; the top 10 are Frog Legends
- Leaderboard, player profiles and match history
- Friends: add friends, see when they're online, and challenge them to a pond
- Invite anyone with a link, or practice against Pond Bot
- Make your frog yours: body, colors, eyes, patterns, extras and lily pads, with rarer looks unlocked by rank
- Battle reactions, music and sound effects
