# Pond Brawl: notes for coding agents

Read `README.md` first: what each file is, how the game runs, how deploys work.
Home infrastructure (Tower, Docker, Nginx Proxy Manager, Cloudflare) is described in
`/home/agent/shared/AGENTS.md`.

## Working alongside other agents

- Several agents work on this repo at once. Work in your own git worktree
  (`git worktree add ../PondBattle-<name> -b <branch>`), never in another agent's checkout or worktree.
- Before committing: `git fetch`, rebase onto `origin/main`, and check that `git diff` holds only your
  own changes. Stage only your files or hunks.
- Deploying is `git push origin HEAD:main`: GitHub Actions builds the image, Watchtower on Tower picks it
  up in 1–2 minutes. Put changes on the test app first and push when the user says to ship or deploy.
  Small fixes can go straight out once the checks below pass. If unsure, ask.

## Testing

- One test server per session, each on its own port with its own scratch data. The user tests on
  `http://192.168.1.237:8431` (data in `/tmp/pbtest`, no bot token):
  `PORT=8431 DATA_DIR=/tmp/pbtest/data ROOMS_FILE=/tmp/pbtest/rooms.json HISTORY_FILE=/tmp/pbtest/games.jsonl node server.js`
- 8431 belongs to one session at a time. Before restarting it, check which checkout it runs from
  (`readlink /proc/<pid>/cwd`). Never stop, restart or edit the worktree of a server you didn't start. If
  8431 is taken, use another port with its own copy of the data, tell the user the URL, and stop it when
  you're done.
- Stop servers by PID (`ss -ltnp | grep :<port>`). `pkill -f <pattern>` also matches your own shell and
  kills it.
- Put anything the user should try on the test app itself, not in screenshots or a separate file server.
- Never test against prod or live data, and never "clean up" live data. The user's own account on 8431 is
  "Abiba" (a seeded Frog Legend with fake history): never log in as it and save anything.
- A server reloads open phones whenever `index.html` in its own checkout changes. Changes to
  `engine.js`, `server.js`, `ranks.js` or the JSON files need a restart.
- Look at screens with `tools/screen.py <scene>` (`--help` lists scenes and options): it sets up the state
  through its own throwaway server, captures in Chromium and WebKit (`--both`) at 393×710 and 440×820
  (iPhones in Telegram) and 375×600 (short screens) (`--sizes all`), and reports page errors, console
  errors, failed requests and sideways scrolling. Battles: any frame (`--frames`, `--log` lists them) or
  real time (`--at`). `--no-shot --text` when words are enough. Animations are settled before capturing (a
  mid-blink frame looks like a bug). Its background helper exits after 10 idle minutes (`--stop` ends it).
  Exact situations: `--setup` / `--bot-setup` set a pond, shop, bug, gold or hearts (through
  `/api/dev/state`, which only the tool's own throwaway server turns on; never set `DEV_STATE` anywhere else).
  `--video` records each view (with `--touches` showing the finger) to watch animations play.
  WebKit is the Safari engine but not iPhone Telegram: for iPhone-only bugs, ask the user for a screen
  recording. For anything the tool doesn't cover, extend it rather than writing a throwaway script.

## Before pushing

1. Rebase onto `origin/main`; `git diff` shows only your changes.
2. The Dockerfile copies an explicit list of files. A new runtime file must be added there. Start the
   server from exactly those files to be sure it boots (a missing `sets.json` once took prod down).
3. Battles or balance touched: `node tools/audit.js` (CI runs it too), `node tools/simulate.js`,
   `tools/screen.py battle --frames all --check` on a range of rounds and both sets (the battlefield must match the
   engine at every frame), and a few `tools/screen.py game` runs (whole games in the page, no errors reported).
4. UI touched: `tools/screen.py <scene> --sizes all --both` for the affected screens, with no errors reported.
5. Chain checks, commit and push with `&&`, never `;` (a `;` chain once pushed despite a failed test).
6. After pushing, confirm prod with a read-only request: `GET https://pondbrawl.3rdplacelounge.com/api/health`
   returns ok and `commit` equals your pushed `git rev-parse HEAD`. Poll it in the background and keep
   talking to the user; report when it's live. Not live within about 10 minutes: CI probably failed (the
   image starts and the battle audit must pass before anything is published), so look at GitHub Actions.
   Never POST to prod to check it: even `/api/me` creates a guest profile in the live data. If prod is
   down, look at the container on Tower and fix it directly rather than waiting.

## Balance

- `tools/simulate.js` plays full games (about 1M battles in ~20 s) and only reports. There is no
  autotuner: read the report, decide changes yourself, and report numbers. Compare candidates with
  `--try "id.field=value"` (no file edits) or `--base <git ref>` (your working tree against it); both
  sides play the same seeded games, and changes within the margin are marked as noise. `--json` for
  machine-readable output.
- Simulated players stay generic: random affordable buys, merges, the front/any/back placement from
  `frogs.json`. Never add frog-specific placement or buying logic to make a number look right.
- Compare each frog with its own tier's typical frog (the median); within about 3 points is fine. Higher
  tiers should feel stronger through unique effects, not higher win rates.
- A set has 20 frogs, 5 per tier (tiers unlock in rounds 1/3/5/7). That pool size keeps level-ups
  common without making level 3 routine.

## Battle rules

- Stats, tiers and prices live in `frogs.json`; sets in `sets.json`; abilities in `engine.js`
  (`runBattle`, `act`, `fight`). Ability strength scales with level (L = 1–3).
- Never rename or delete a frog id: ids are stored in saved rooms, match history and profiles. Rename only
  its `name`. To retire a frog, set its tier to 0 (it leaves the shop; saved ponds still play), as was done
  for Frogspawn (`tadpole`).
- Fair turns: whenever both ponds have something waiting at the same moment (a start-of-battle frog, a
  knocked-out frog, a hurt reaction), the pond whose turn it is goes first and the turn passes to the other.
  Each kind keeps its own turn; all start with the round's first pond: the first seat in odd rounds, the
  second in even ones (the first seat is the pond's creator; in matchmaking, whoever waited longer). No
  seat may be favoured anywhere else either: anything both ponds do at once follows the round's order.
- What an effect sets off resolves one moment at a time (`settle()`): hurt reactions; every knocked-out
  frog's own faint ability (it stays, faded at 0 health); reactions to the knockouts (Bullfrog, Hungry Frog,
  Necromancer); then everyone knocked out leaves together. Whatever a moment hurts or knocks out belongs to the
  next one; babies, raised frogs and hatched Egg Frogs arrive when nothing is left.
- `damage(s, u, n, src)` records who did it with each hurt (`hurts` holds `{ u, by }`), so a Berserker strikes back
  at its attacker; pass the attacking frog as `src` for anything a frog does (arrows, spits, fire). A strike back is
  made with `reply = false`, so it is never struck back at.
  Within a pond, front to back. Start of battle settles after each frog. Every start-of-battle ability
  always plays, and says so when there's nothing to affect.
- Babies and raised frogs arrive once the frogs knocked out in the same moment have left. A pond never
  holds more than five.
- "Immune" means no damage; effects like shrink, swap or scream still apply. Frogs behind a Frog King
  take no damage; a Rogue is only hurt by the enemy it's fighting.
- End-of-round gifts (Lily Frog, Blacksmith) happen when both players press Ready, before the battle.

## Ranked play and profiles

- `ranks.js` owns ranks and the avatar unlock table (`UNLOCKS`). The server enforces it on profile save (`fitAvatar`
  reverts anything above the player's rank that the frog doesn't already wear: dropping a rank or the Frog Legend title
  never takes an item off, it only can't be put on again); the page gets the same table injected as `__UNLOCKS__`.
- Rank points: losses stop at 0 in a tier; a loss at 0 drops to the tier below with 4 points (`R.apply`).
- Every customization setting (body, color, eyes, pattern, extras, pad style, pad color) has at least one
  option at every rank, and each option list runs in unlock order (`byRank`). Locked options can be tried
  on in the editor; Save stays greyed out, with no extra text.
- Adding an avatar color or pad color: also raise `AV_COLORS` / `PAD_COLORS` in `server.js`, or
  `cleanAvatar` clamps the new ids away.
- Games between two players (ranked and custom ponds, not practice) have a ready clock: once one player is
  ready, the other has 60 s (`READY_CLOCK_MS`), then is readied with the pond they have (`setClock` in
  `server.js`). The page shows it as a draining ring on that player's portrait and on the Ready button.
- Only matchmade rooms (`room.ranked`) change rank. Ranked games have no rematch, and leaving one after the
  partner has joined counts as a loss.
- Other players are only ever sent by public id (`pid`, an HMAC). Never put a uid or Telegram id in an API
  response.
- Friends live on the profile (`friends`, `asked`, `askedBy`: `{ uid: when }`). Change both sides together
  (`befriend`, the `/api/friends/act` actions), read with `seen()` so a lookup never writes to a profile. Telegram
  notes go through `ping()`: one per sender, kind and hour; a search tells friends only after 5 s with no match (times saved in `DATA_DIR/pings.json`, kept a day, flushed on
  shutdown with rooms and profiles), and a friend's search alert respects `muteFriends`. With no
  bot token (test servers), `TG.notify` logs `telegram (off) to <id>: ...` to the server log instead, so check notes
  there.
- Profiles and match history read `games.jsonl` at startup. Keep history lines backward compatible: old
  lines have no ranked or delta fields.

## Client (`index.html`)

- `api(path)` with no body is a GET with the uid/key in the query; POST endpoints need `api(path, {})`.
- The whole client is one file with no dependencies. It only replays battle frames the server computed.
  Every ability needs a visible moment on screen and a line in the battle log.
- Interaction: a tap only selects; actions happen by dragging or with the one main button. Keep text
  minimal: no persistent hints or instructions.
- Ability wording uses a fixed vocabulary (Buy, Sell, Start of round, End of round, Start of battle,
  Before attack, Attack, Hurt, Faint, Friend ahead faints, Knocks out an enemy, Friend hatches) and stays
  concise (`+1/+1`, not "+1 attack and +1 health").
- Battle layout: your plaque bottom-left, your partner's top-right, along the diagonal of pads between
  them. Stats sit at one fixed spot on each frog's outer side (left of yours, right of theirs), whatever
  the frog's size.
- Notifications (play-by-play, shop messages) are plain text with a soft shadow, no pill.
- Sheets: `sheet()` gives every sheet a fixed ✕ in the top-right corner (it closes like tapping outside,
  so a dialog answers "no"). No bottom Close / Got it buttons. A sheet opened from another stacks on top
  and closes back to it.
- Stacked buttons share one height; ghost buttons have the same raised lip as solid ones.
- Portrait only.

## Art

- Every frog type is its own hand-built SVG in the `ART` table, built from shared body shapes and
  helpers. No emoji on frogs.
- Within a set, frogs must be told apart at a glance by body shape and colour family, not a small detail.
- Extras hang off each body's anchors (hat line, eyes, cheeks, neck, measured outline) so they fit every
  body shape. Hats sit behind the eyes. Items a frog holds need an arm and a hand gripping them, never an
  item floating beside the body.
- Gradients go through `gradPal()`, which defines each gradient once in the page-level `#grad-lib` svg.
  Never inline gradient defs in frog art: if the first copy sits in a hidden element, every frog using it
  loses its colour.
- Frogs always stand on their pad. Level shows as size (`.sz1`–`.sz3`), plus a Lv2/Lv3 tag in the shop
  pond and the log's lineup, never on the battlefield.
- After new art: render all frogs side by side, and set `ART_SIZE` from the drawing's measured area so
  every frog appears the same size.

## Pitfalls

- Popups that size to their text need `width: max-content`. iPhone WebKit otherwise squeezes them into
  the room left of their previous position.
- iPhone WebKit may skip CSS `filter` on animated elements. Put visual effects in the SVG itself, or
  avoid filters on animated frogs.
- iPhone audio: fade the gain out before suspending or closing the AudioContext; cutting off mid-note
  buzzes when the app is swiped away.
- Sound (`Snd` in `index.html`): effects and the lullaby are synthesized once into buffers
  (OfflineAudioContext) after the first tap and played as buffer sources; music passages are queued ~3 s
  ahead on the audio clock, never by page timers. The audio session is "ambient" (the user's choice): the
  game mixes with other apps' audio and respects the silent switch, so don't reintroduce "playback" or the
  silent `<audio>` trick. Long-press a music button for the sound readout (engine state, mode, recent
  events): ask the user for a screenshot of it when sound breaks on a phone.
- Use component-prefixed CSS class names: generic names (`.ghost`, `.top`, `.bubble`) have collided.
- Highlight rings use borders, not box-shadow: iPhone WebKit painted pulsing box-shadows as rectangles.
- The bot token lives outside the repo (`~/claude/workspace/.env`). Never commit it. Only one process may
  poll the bot at a time, so test servers run without a token.

## Working with the user

- Change only what the user names. Mention related changes instead of making them.
- Support balance decisions with simulation numbers, and say plainly when the numbers disagree with a
  preference.
- Parked by the user, not to be merged or brought up unprompted: a Dota frog set (branch `dota`) and
  economy frogs for Nature.
