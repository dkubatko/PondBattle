# Pond Battle 🐸

**Pond Battle**: a cozy two-player frog auto-battler, played as a Telegram Mini App
(bot: [@pond_battle_bot](https://t.me/pond_battle_bot)) or in any browser.

## What's where

| File | What it is |
|---|---|
| `engine.js` | Game rules: frogs, items, shop, merging, battles, rounds, Pond Bot's shopping |
| `server.js` | Web side: players, lobbies, rooms, live updates (SSE), game history, serves the page |
| `ranks.js` | Ranked play: rank tiers (Tadpole, Froglet, Frog, Master Frog, 5 points each) and the top-10 Frog Legends |
| `telegram.js` | Checks Mini App launch data; the bot (Play button, invites, "your move" nudges) |
| `index.html` | The whole client (it only replays battles the server computed) |
| `frogs.json`, `items.json` | Stats, tiers and prices |
| `sets.json` | Frog sets: which frogs a pond's shop sells (picked when the pond is made) |
| `tools/simulate.js` | Plays 120k full games per set and reports how every frog and item does (changes nothing) |
| `deploy/compose.yaml` | How it runs on Tower |

No dependencies: plain Node (20+).

## Run locally

```sh
node server.js                 # http://localhost:8420 (browser guests; no bot)
node tools/simulate.js         # balance report
```

State goes to `./data` (`DATA_DIR`): `rooms.json`, `profiles.json`, `games.jsonl`, `secret`. It is not in git.

Environment: `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL` (https, needed for the Telegram buttons),
`ALLOW_GUESTS` (default on), `PORT` (8420), `DATA_DIR`, `TELEGRAM_POLL=0` (check Telegram sign-in without
listening to the bot, for local testing with the real token). See `.env.example`.

## Players

Inside Telegram the player id is the Telegram user id, taken from the signed launch data. In a plain
browser it's a guest id kept in the browser. Names and frog avatars are stored on the server.
Home: **Play**, **My ponds** (start a pond to invite someone, your games in progress, and **Nearby** ponds
started from the same network as you), **Practice**, **Join with a code**. **Play** finds a ranked
game against anyone else looking, in the same set or any set (closest rank first; the allowed gap grows
while you wait). Only those games count for rank: +1 for a win and −1 for a loss against a similar player
(+2 / ±0 against one 3+ points higher, −2 losing to one 3+ lower); 5 points fill a tier, a tier once
reached is kept, and the top 10 full Master Frogs are Frog Legends. Leaving a ranked game counts as a loss.
Invite and practice games are unrated. Profiles (your frog or name on the home page; any player's plate in a
game, a leaderboard row or a recent game) show rank, games played/won and recent games, read from
`games.jsonl` (practice games aren't listed). Other players are addressed by a public id, never their
Telegram id. The trophy button opens the global leaderboard (top 50).

## Deploy

Pushing to `main` builds `ghcr.io/dkubatko/pondbattle:latest` (GitHub Actions). On Tower,
`/mnt/cache/appdata/pondbattle` holds `compose.yaml` (from `deploy/`), `.env` and `data/`.
Watchtower pulls new images within a minute. Nginx Proxy Manager forwards the public hostname to
port 18420.
