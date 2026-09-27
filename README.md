# Pond Battle 🐸

**Frog Pond Brawl**: a cozy two-player frog auto-battler, played as a Telegram Mini App
(bot: [@pond_battle_bot](https://t.me/pond_battle_bot)) or in any browser.

## What's where

| File | What it is |
|---|---|
| `engine.js` | Game rules: frogs, items, shop, merging, battles, rounds, Pond Bot's shopping |
| `server.js` | Web side: players, lobbies, rooms, live updates (SSE), game history, serves the page |
| `telegram.js` | Checks Mini App launch data; the bot (Play button, invites, "your move" nudges) |
| `index.html` | The whole client (it only replays battles the server computed) |
| `frogs.json`, `items.json` | Stats, tiers and prices |
| `tools/simulate.js` | Plays 120k full games and reports how every frog and item does (changes nothing) |
| `deploy/compose.yaml` | How it runs on Tower |

No dependencies: plain Node (20+).

## Run locally

```sh
node server.js                 # http://localhost:8420 (browser guests; no bot)
node tools/simulate.js         # balance report
```

State goes to `./data` (`DATA_DIR`): `rooms.json`, `profiles.json`, `games.jsonl`, `secret`. It is not in git.

Environment: `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL` (https, needed for the Telegram buttons),
`ALLOW_GUESTS` (default on), `PORT` (8420), `DATA_DIR`. See `.env.example`.

## Players

Inside Telegram the player id is the Telegram user id, taken from the signed launch data. In a plain
browser it's a guest id kept in the browser. Names and frog avatars are stored on the server.
Lobby: your games, **Nearby** ponds (started from the same network as you), and **Open ponds** from
anyone else.

## Deploy

Pushing to `main` builds `ghcr.io/dkubatko/pondbattle:latest` (GitHub Actions). On Tower,
`/mnt/cache/appdata/pondbattle` holds `compose.yaml` (from `deploy/`), `.env` and `data/`.
Watchtower pulls new images every 5 minutes. Nginx Proxy Manager forwards the public hostname to
port 18420.
