#!/usr/bin/env python3
"""Look at any Pond Brawl screen: a screenshot plus a report of page errors, console errors, failed requests and
sideways scrolling, in Chromium and/or WebKit (the Safari engine, closest to iPhone), at phone sizes.

The first call starts a helper in the background that keeps a game server (this checkout's working tree, its own
throwaway data) and the browsers running, so later calls take well under a second. It restarts the game server
when a server-side file changes (index.html is re-read by the server on its own), and exits after 10 idle minutes.
Each call sets up the state it needs through the API (a guest, a practice game, rounds played) and opens the
page straight into it; nothing touches the test app's or prod's data.

  tools/screen.py home                         the home screen (393x710, Chromium)
  tools/screen.py shop --round 4 --sizes all --both    the shop in round 4, three sizes, Chromium + WebKit
  tools/screen.py battle --round 3             that round's battle: after the entrance, the first hit, the result
  tools/screen.py battle --frames 1,2,7 --log  the battle as it stands after frames 1, 2 and 7, and its frame list
  tools/screen.py battle --at 300,900          real time: 300 and 900 ms into the battle (mid-animation)
  tools/screen.py profile --text --no-shot     just the text on screen and the error report
  tools/screen.py shop --do "tap:.pad" --do "wait:300"     interact before capturing
  tools/screen.py home --server http://localhost:8431      a running test server instead (never prod)
  tools/screen.py --stop                       stop the helper now

Scenes: name (first visit), home, queue (looking for a game), waiting (your own pond), picker (set wheel), guide,
  profile, card, ranks, leaders, shop, menu, log (last battle's log), battle, over (game over).
Options:
  --round N          game scenes: play N-1 rounds first (buys whatever is affordable, then Ready vs the Pond Bot)
  --set ID           the game's set (e.g. nature, magic)
  --pvp              game scenes: a custom pond against a second player ("Rival") instead of practice vs the bot
  --opp-ready        --pvp: Rival presses Ready (you're on the ready clock)
  --me-ready         --pvp: you press Ready (Rival is on the clock)
  --clock MS         the ready clock's length (default the server's, 60 s; the helper's server restarts for it)
  --frames K,...     battle: the battle as it stands after frame K (start = after the entrance, fight = the first
                     hit, end = the result screen; all = every frame); default start,fight,end
  --at MS,...        battle: capture in real time, MS after the battle screen appears (instead of --frames)
  --log              battle: print the battle's frames (number, kind, caption)
  --check            battle: at every captured frame, compare the battlefield with the engine's frame (every frog
                     there and nothing extra, its stats, the knocked-out look, order on the pads, no stray stats)
Scene game: a whole two-player game in the page, round after round to game over (--speed N: animation speed,
  default 4); every battle's result is checked like --check and errors are reported (--rounds N stops early)
  --sizes all|WxH,.. default 393x710; all = 393x710,440x820,375x600
  --webkit / --both  WebKit only / Chromium and WebKit (default Chromium)
  --do STEP          (repeatable) tap:CSS | click:TEXT | drag:CSS>CSS | eval:JS (prints its result) | wait:MS |
                     until:JS (wait for it) | rival:ACTION (--pvp: Rival does it, e.g. rival:ready)
  --fresh            a first-time player (onboarding hints on)
  --text             print the text on screen
  --no-shot          no screenshots (report and text only)
  --hd               2x screenshots (default 1x: smaller, faster to look at)
  --live             don't settle animations before capturing (default: finished, loops at their start)
  --out DIR          where screenshots go (default /tmp/pb-screen/<scene>-<time>)
"""
import argparse, contextlib, hashlib, io, json, os, re, shutil, signal, socket, subprocess, sys, tempfile, time, traceback, urllib.parse, urllib.request
from pathlib import Path

VENV = Path.home() / '.local/share/playwright/venv/bin/python'
try:
    from playwright.sync_api import sync_playwright
except ImportError:  # run with the shared Playwright venv
    if VENV.exists() and Path(sys.prefix) != VENV.parent.parent:
        os.execv(str(VENV), [str(VENV), *sys.argv])
    sys.exit('screen.py needs Playwright for Python (see /home/agent/shared/AGENTS.md, Tools)')

# WebKit's media, HTTPS and launch check need these (see ~/.local/share/playwright/README); shells get them from env.sh
LIB = Path.home() / '.local/share/playwright/lib'
if LIB.exists():
    for k, v in {'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS': '1', 'GST_PLUGIN_SYSTEM_PATH_1_0': f'{LIB}/gstreamer-1.0',
                 'GST_PLUGIN_SCANNER_1_0': f'{LIB}/gstreamer-1.0/gst-plugin-scanner', 'GIO_EXTRA_MODULES': f'{LIB}/gio/modules'}.items():
        os.environ.setdefault(k, v)

REPO = Path(__file__).resolve().parent.parent
ME = Path(__file__).resolve()
RUN = Path('/tmp/pb-screen')
SOCK = RUN / f"{hashlib.sha1(str(REPO).encode()).hexdigest()[:10]}.sock"  # one helper per checkout
IDLE = 600
SERVER_FILES = ['engine.js', 'server.js', 'ranks.js', 'telegram.js', 'frogs.json', 'items.json', 'sets.json']
PHONES = ['393x710', '440x820', '375x600']
SHEETS = {'guide': 'openGuide()', 'profile': 'openProfile()', 'card': 'openCard()', 'ranks': 'openRanks()',
          'leaders': 'openLeaders()', 'picker': "pickSet('Practice', () => {})"}
GAME = {'shop': None, 'menu': 'openMenu()', 'log': 'openBattleSheet(S.lastBattle)', 'battle': None, 'over': None}
SCENES = ['name', 'home', 'queue', 'waiting', *SHEETS, *GAME, 'game']
SCREEN_OF = {'name': 'home', 'home': 'home', 'queue': 'search', 'waiting': 'waiting', **{s: 'home' for s in SHEETS},
             'shop': 'game', 'menu': 'game', 'log': 'game', 'over': 'over', 'battle': 'battle', 'game': 'game'}
OPENS_FROM = {**SCREEN_OF, 'queue': 'home'}  # the screen the scene's JS is run on

# Before the page loads: storage for the scene, a count of fetches in flight (so we know when data has arrived),
# and the battle hook (index.html calls pbLook(k) before frame k; we play fast and hold after the wanted frames)
INIT = """
if (!sessionStorage.pbScreen) { sessionStorage.pbScreen = 1; for (const [k, v] of Object.entries(%(store)s)) localStorage.setItem(k, v); }
window.__pbInflight = 0;
const __f = window.fetch;
window.fetch = (...a) => { window.__pbInflight++; return __f(...a).finally(() => window.__pbInflight--); };
window.__pbWant = %(want)s;
if (window.__pbWant) window.pbLook = (k) => new Promise((go) => {
  if (window.__pbWant.includes(k - 1)) window.__pbHold = { k: k - 1, go: () => go(50) }; else go(50);
});
"""
READY = "screen === %s && window.__pbInflight === 0 && document.fonts.status === 'loaded' %s"
FRAMES2 = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
# Settle: short animations jump to their end, loops (breathing, blinking) go to their start and wait there, and long
# ones (the ready clock's ring) pause where they are
SETTLE = """() => { window.__pbLoops = []; for (const a of document.getAnimations()) {
  const t = a.effect && a.effect.getComputedTiming();
  if (t && t.iterations === Infinity) { a.pause(); a.currentTime = 0; window.__pbLoops.push(a); }
  else if (t && t.activeDuration > 5000) { a.pause(); window.__pbLoops.push(a); }
  else { try { a.finish(); } catch (e) {} } } }"""
UNSETTLE = '() => { for (const a of window.__pbLoops || []) a.play(); window.__pbLoops = []; }'
# The battlefield against the engine's frame k (the page's own view of the battle): returns what doesn't match
CHECK = """(k) => {
  const F = viewFrames(S.lastBattle, S.seat), fr = F[k], bad = [], q = (sel) => document.querySelector('#arena ' + sel);
  for (const [side, list] of [[0, fr.mine], [1, fr.theirs]]) {
    const ids = [...document.querySelectorAll(`#arena .bu.s${side}`)].map((e) => +e.dataset.bid), want = list.map((u) => u.id);
    const extra = ids.filter((i) => !want.includes(i)), missing = want.filter((i) => !ids.includes(i));
    if (extra.length) bad.push(`side ${side}: frogs on screen that the frame doesn't have (${extra})`);
    if (missing.length) bad.push(`side ${side}: frogs missing from the screen (${missing})`);
    const xs = [];
    for (const u of list) {
      const el = q(`.bu[data-bid="${u.id}"]`), st = q(`.bst[data-bid="${u.id}"]`);
      if (!el || !st) continue;
      const a = +st.querySelector('.st.atk').textContent, h = +st.querySelector('.st.hp').textContent;
      if (a !== u.atk || h !== Math.max(0, u.hp)) bad.push(`${u.type} #${u.id} shows ${a}/${h}, the frame has ${u.atk}/${Math.max(0, u.hp)}`);
      if (el.classList.contains('ko') !== (u.hp <= 0)) bad.push(`${u.type} #${u.id}: knocked-out look is ${el.classList.contains('ko')} at ${u.hp} health`);
      if (+getComputedStyle(st).opacity < .5) bad.push(`${u.type} #${u.id}: its stats are hidden`);
      xs.push(new DOMMatrix(getComputedStyle(el).transform).m41);
    }
    for (let i = 1; i < xs.length; i++) if (side === 0 ? !(xs[i] < xs[i - 1] - 1) : !(xs[i] > xs[i - 1] + 1)) { bad.push(`side ${side}: frogs out of order or sharing a pad`); break; }
  }
  const stray = [...document.querySelectorAll('#arena .bst')].filter((st) => !q(`.bu[data-bid="${st.dataset.bid}"]`));
  if (stray.length) bad.push(`${stray.length} stat badge(s) left without their frog`);
  return bad;
}"""
PAUSE = "() => { window.__pbLoops = document.getAnimations().filter((a) => a.playState === 'running'); window.__pbLoops.forEach((a) => a.pause()); }"


def parser():
    a = argparse.ArgumentParser(prog='tools/screen.py', add_help=False)
    a.add_argument('scene', choices=SCENES)
    a.add_argument('--round', type=int, default=1)
    a.add_argument('--set')
    a.add_argument('--pvp', action='store_true')
    a.add_argument('--opp-ready', action='store_true')
    a.add_argument('--me-ready', action='store_true')
    a.add_argument('--clock', type=int)
    a.add_argument('--frames', default='start,fight,end')
    a.add_argument('--at')
    a.add_argument('--log', action='store_true')
    a.add_argument('--check', action='store_true')
    a.add_argument('--rounds', type=int, default=40)
    a.add_argument('--speed', type=float, default=4)
    a.add_argument('--sizes', default=PHONES[0])
    a.add_argument('--webkit', action='store_true')
    a.add_argument('--both', action='store_true')
    a.add_argument('--do', action='append', default=[])
    a.add_argument('--fresh', action='store_true')
    a.add_argument('--text', action='store_true')
    a.add_argument('--no-shot', action='store_true')
    a.add_argument('--hd', action='store_true')
    a.add_argument('--live', action='store_true')
    a.add_argument('--server')
    a.add_argument('--out')
    return a


# ---------- the game server ----------
class Game:
    """A throwaway server from this checkout, on a free port, with its own temporary data."""
    def __init__(self): self.proc, self.stamp, self.data, self.base = None, None, None, None

    def stamp_now(self, clock): return [clock, *((REPO / f).stat().st_mtime for f in SERVER_FILES)]

    def ensure(self, clock=None):
        if self.proc and self.proc.poll() is None and self.stamp == self.stamp_now(clock): return self.base
        self.stop()
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
        self.data = tempfile.mkdtemp(prefix='pb-screen-')
        env = {k: v for k, v in os.environ.items() if not k.startswith('TELEGRAM')}  # never talk to the real bot
        env.update(BOT_DELAY_MS='0', PORT=str(port), DATA_DIR=f'{self.data}/data', ROOMS_FILE=f'{self.data}/rooms.json', HISTORY_FILE=f'{self.data}/games.jsonl')
        if clock: env['READY_CLOCK_MS'] = str(clock)
        self.stamp = self.stamp_now(clock)
        self.proc = subprocess.Popen(['node', 'server.js'], cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        self.base = f'http://127.0.0.1:{port}'
        for _ in range(200):
            if self.proc.poll() is not None: raise RuntimeError('the game server failed to start:\n' + self.proc.stderr.read().decode()[-2000:])
            try: urllib.request.urlopen(self.base + '/api/health', timeout=1); return self.base
            except Exception: time.sleep(0.02)
        raise RuntimeError('the game server did not answer on ' + self.base)

    def stop(self):
        if self.proc:
            try: os.killpg(self.proc.pid, signal.SIGTERM); self.proc.wait(3)
            except Exception: pass
        if self.data: shutil.rmtree(self.data, ignore_errors=True)
        self.proc = self.data = None


def check_server(url):
    host = urllib.parse.urlparse(url).hostname or ''
    if not (host in ('localhost', '127.0.0.1') or re.match(r'^(192\.168|10)\.', host)):
        raise SystemExit(f'--server {url}: only local test servers (it creates players and games; never point it at prod)')
    return url.rstrip('/')


class Api:
    def __init__(self, base): self.base, self.who = base, {}

    def post(self, path, body=None):
        req = urllib.request.Request(self.base + path, json.dumps({**self.who, **(body or {})}).encode(), {'Content-Type': 'application/json'})
        return json.loads(urllib.request.urlopen(req, timeout=10).read())

    def guest(self, name):
        me = self.post('/api/me'); self.who = {'uid': me['uid'], 'key': me['key']}
        if name: self.post('/api/profile', {'name': name, 'avatar': me['avatar']})
        return self.who

    def state(self, room):
        q = urllib.parse.urlencode({'room': room['room'], 'token': room['token']})
        return json.loads(urllib.request.urlopen(f'{self.base}/api/state?{q}', timeout=10).read())

    def act(self, room, action): return self.post('/api/action', {**room, 'action': action})

    def shop(self, room):
        """Buy whatever is affordable (merging copies)."""
        st = self.state(room)
        for i, f in enumerate(st['me']['shop']['frogs']):
            if not f: continue
            team, cost = st['me']['team'], f.get('cost', FROGS[f['type']].get('cost', 3))
            slot = next((k for k, t in enumerate(team) if t and t['type'] == f['type'] and t['lvl'] < 3), None)
            if slot is None: slot = next((k for k, t in enumerate(team) if not t), None)
            if slot is not None and st['me']['gold'] >= cost: st = self.act(room, {'type': 'buy', 'shopIdx': i, 'slot': slot})
        return st

    def play_round(self, room, rival=None):
        """Shop and press Ready (and the same for the rival, in a two-player game); wait for the battle."""
        rnd = self.shop(room)['round']
        if rival: rival[0].shop(rival[1]); rival[0].act(rival[1], {'type': 'ready'})
        self.act(room, {'type': 'ready'})
        for _ in range(300):
            st = self.state(room)
            if st['round'] != rnd or st['phase'] != 'shop': return st
            time.sleep(0.02)
        raise RuntimeError('the Pond Bot never got ready')


FROGS = json.loads((REPO / 'frogs.json').read_text())
RIVAL = None  # (Api, room) of the second player in a --pvp game, for rival: steps
GAME_OF = None  # the game scene's (Api, room, (rival Api, rival room))


def setup(o, api):
    """Returns (localStorage for the page, JS to run once it's up, the last battle to watch or None)."""
    store = {} if o.fresh else {'frogOnboarded': '1', 'frogSwipeHint': '1'}
    if o.scene == 'name': return store, None, None
    store['frogGuest'] = json.dumps(api.guest('Tester'))
    if o.scene == 'home': return store, None, None
    if o.scene == 'queue': return store, "startSearch('any')", None
    if o.scene in SHEETS: return store, SHEETS[o.scene], None
    if o.scene == 'waiting':
        return {**store, 'frogSess': json.dumps(api.post('/api/create', {'set': o.set} if o.set else {}))}, None, None
    global RIVAL, GAME_OF
    if o.scene == 'game':  # a whole two-player game, played in the page
        room = api.post('/api/create', {'set': o.set} if o.set else {})
        other = Api(api.base); other.guest('Rival')
        GAME_OF = (api, room, (other, other.post('/api/join', {'room': room['room']})))
        return {**store, 'frogSess': json.dumps(room), 'frogSpeed': str(o.speed)}, None, None
    rival = RIVAL = None
    if o.pvp:  # a custom pond: you make it, a second guest joins
        room = api.post('/api/create', {'set': o.set} if o.set else {})
        other = Api(api.base); other.guest('Rival')
        rival = RIVAL = (other, other.post('/api/join', {'room': room['room']}))
    else:
        room = api.post('/api/practice', {'set': o.set} if o.set else {})
    store['frogSess'] = json.dumps(room)
    # over: play to the end; battle: this round's battle is the one to watch; log: needs a finished battle
    rounds = {'over': 99, 'battle': o.round, 'log': max(o.round - 1, 1)}.get(o.scene, o.round - 1)
    st, seen = None, None
    for _ in range(max(rounds, 0)):
        seen = st and st.get('lastBattle')
        st = api.play_round(room, rival)
        if st['phase'] == 'over': break
    if rival and o.opp_ready: rival[0].act(rival[1], {'type': 'ready'})
    if rival and o.me_ready: api.act(room, {'type': 'ready'})
    if o.scene == 'battle':
        # the page opens straight into this round's battle: every battle before it counts as watched
        if seen: store[f"frogSeen_{room['room']}"] = seen['id']
        return store, None, st['lastBattle']
    if st and st.get('lastBattle'): store[f"frogSeen_{room['room']}"] = st['lastBattle']['id']
    return store, GAME[o.scene], None


# ---------- capturing ----------
def step(p, s):
    kind, _, arg = s.partition(':')
    if kind == 'tap': p.locator(arg).first.click()
    elif kind == 'click': p.get_by_text(arg).first.click()
    elif kind == 'drag': a, b = arg.split('>', 1); p.locator(a).first.drag_to(p.locator(b).first)
    elif kind == 'eval':
        r = p.evaluate(arg)
        if r is not None: print(f'  eval: {json.dumps(r)[:200000]}')
    elif kind == 'wait': p.wait_for_timeout(int(arg))
    elif kind == 'until': p.wait_for_function(arg, timeout=60000, polling=50)
    elif kind == 'rival' and RIVAL: RIVAL[0].act(RIVAL[1], {'type': arg})
    else: raise SystemExit(f'--do {s}: use tap:CSS, click:TEXT, drag:CSS>CSS, eval:JS, wait:MS, until:JS or rival:ACTION (--pvp)')


def frame_list(lb, spec):
    n, out = len(lb['frames']), []
    if spec == 'all': return [*range(n - 1), 'end']
    for x in spec.split(','):
        x = x.strip()
        k = {'start': 0, 'fight': lb.get('fightAt', 1), 'end': 'end'}.get(x, x)
        if k != 'end':
            k = int(k)
            if not 0 <= k < n: raise SystemExit(f'--frames {x}: this battle has frames 0-{n - 1} (--log lists them)')
        out.append(k)
    return out


TG_URL = 'https://telegram.org/js/telegram-web-app.js'


def telegram_js():
    """Telegram's script, which the page loads from telegram.org: fetched once a day and served from here."""
    f = RUN / 'telegram-web-app.js'
    if not f.exists() or time.time() - f.stat().st_mtime > 86400:
        try: f.write_bytes(urllib.request.urlopen(TG_URL, timeout=10).read())
        except Exception: pass
    return f.read_bytes() if f.exists() else None


class Capture:
    def __init__(self, pw, game): self.pw, self.game, self.browsers = pw, game, {}

    def browser(self, name):
        b = self.browsers.get(name)
        if not b or not b.is_connected(): b = self.browsers[name] = getattr(self.pw, name).launch()
        return b

    def run(self, o):
        t0 = time.time()
        base = check_server(o.server) if o.server else self.game.ensure(o.clock)
        api = Api(base)
        store, open_js, lb = setup(o, api)
        want = None
        if lb and not o.at:
            want = frame_list(lb, o.frames)
        if lb and o.log:
            for k, fr in enumerate(lb['frames']): print(f"  {k:>3} {fr['kind']:<8}{fr.get('text') or ''}")
        sizes = PHONES if o.sizes == 'all' else o.sizes.split(',')
        browsers = ['chromium', 'webkit'] if o.both else ['webkit'] if o.webkit else ['chromium']
        out = Path(o.out or RUN / f"{o.scene}-{time.strftime('%H%M%S')}")
        if not o.no_shot: out.mkdir(parents=True, exist_ok=True)
        init = INIT % {'store': json.dumps(store), 'want': json.dumps([k for k in want if k != 'end'] if want else None)}
        for bname in browsers:
            for size in sizes:
                w, h = map(int, size.split('x'))
                ctx = self.browser(bname).new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if o.hd else 1, has_touch=True)
                try: self.view(o, ctx, init, open_js, lb, want, base, out, f'{o.scene}-{bname}-{size}', w)
                finally: ctx.close()
        print(f"{'' if o.no_shot else str(out) + '  '}({time.time() - t0:.1f}s)")

    def view(self, o, ctx, init, open_js, lb, want, base, out, name, w):
        ctx.add_init_script(init)
        tg = telegram_js()
        if tg: ctx.route(TG_URL, lambda r: r.fulfill(body=tg, content_type='application/javascript'))
        p = ctx.new_page()
        errors, shots = [], []
        p.on('pageerror', lambda e: errors.append(f'page error: {e}'))
        p.on('console', lambda m: m.type == 'error' and errors.append(f'console error: {m.text[:300]}'))
        p.on('response', lambda r: r.status >= 400 and errors.append(f'HTTP {r.status} {r.request.method} {r.url[len(base):][:120]}'))
        p.on('requestfailed', lambda r: errors.append(f'request failed: {r.url[:120]} ({r.failure})'))

        def shoot(tag, settle=True):
            if settle and not o.live: p.evaluate(SETTLE)
            elif not settle: p.evaluate(PAUSE)
            if not o.no_shot:
                p.screenshot(path=str(out / f'{name}{tag}.png')); shots.append(f'{name}{tag}.png')
            p.evaluate(UNSETTLE)

        p.goto(base + '/')
        if lb and o.at:  # real time: pictures mid-animation, timed from the battle screen
            p.wait_for_function("screen === 'battle'", timeout=15000, polling=20)
            start = time.time()
            for at in o.at.split(','):
                time.sleep(max(0, start + int(at) / 1000 - time.time()))
                shoot(f'-{at}ms', settle=False)
        elif lb:
            for k in want:
                if k == 'end': p.wait_for_selector('#cont', timeout=30000)
                else: p.wait_for_function(f'window.__pbHold && window.__pbHold.k === {k}', timeout=30000, polling=20)
                if o.check:
                    p.evaluate(SETTLE); p.evaluate(FRAMES2)
                    at = len(lb['frames']) - 1 if k == 'end' else k
                    for b in p.evaluate(CHECK, at): errors.append(f'frame {at}: {b}')
                shoot('-end' if k == 'end' else f'-f{k}')
                if k != 'end': p.evaluate('() => { const h = window.__pbHold; window.__pbHold = null; h.go(); }')
        elif o.scene == 'game':
            api, room, (rv, rroom) = GAME_OF
            p.wait_for_function(READY % ('"game"', ''), timeout=15000, polling=20)
            for rnd in range(o.rounds):
                api.shop(room); rv.shop(rroom); rv.act(rroom, {'type': 'ready'})
                p.wait_for_function("S && S.opp && S.opp.ready && S.me.team.some(Boolean) && !readying", timeout=15000, polling=20)
                p.click('#readyBtn')
                p.wait_for_selector('#cont', timeout=120000)
                p.evaluate(FRAMES2)
                n = p.evaluate('viewFrames(S.lastBattle, S.seat).length')
                for b in p.evaluate(CHECK, n - 1): errors.append(f'round {rnd + 1}, result: {b}')
                p.click('#cont')
                p.wait_for_function("screen === 'game' || screen === 'over'", timeout=15000, polling=20)
                p.wait_for_timeout(300)
                if p.evaluate('screen') == 'over': break
            shots.append(f"{rnd + 1} rounds, ended on '{p.evaluate('screen')}'")
            if not o.no_shot: shoot('')
        else:
            p.wait_for_function(READY % (json.dumps(OPENS_FROM[o.scene]), ''), timeout=15000, polling=20)
            if open_js: p.evaluate(open_js)
            for s in o.do: step(p, s)
            sheet = "&& document.querySelector('.sheet-wrap')" if open_js and o.scene not in ('queue',) else ''
            target = json.dumps(SCREEN_OF[o.scene]) if not o.do else 'screen'  # steps may lead anywhere
            p.wait_for_function(READY % (target, sheet), timeout=15000, polling=20)
            p.evaluate(FRAMES2)
            shoot('')
        width = p.evaluate('document.documentElement.scrollWidth')
        print(f"{name}: {', '.join(shots) or 'ok'}")
        if width > w: print(f'  ! the page scrolls sideways: {width}px wide in a {w}px screen')
        for e in errors: print('  ! ' + e)
        if o.text:
            txt = p.evaluate("() => [...document.querySelectorAll('#root, .sheet-wrap')].map((n) => n.innerText).join('\\n---\\n')")
            print('  text: ' + re.sub(r'\s*\n\s*', ' | ', txt.strip())[:1500])


# ---------- the helper: keeps the game server and browsers warm between calls ----------
def daemon():
    RUN.mkdir(exist_ok=True)
    if SOCK.exists(): SOCK.unlink()
    srv = socket.socket(socket.AF_UNIX); srv.bind(str(SOCK)); os.chmod(SOCK, 0o600); srv.listen(4); srv.settimeout(30)
    version, game, last = ME.stat().st_mtime, Game(), time.time()
    pw = sync_playwright().start()
    cap = Capture(pw, game)
    try:
        while time.time() - last < IDLE:
            try: conn, _ = srv.accept()
            except socket.timeout: continue
            with conn:
                req = json.loads(conn.makefile().readline() or '{}')
                if req.get('stop'): conn.sendall(b'{"out": "stopped", "code": 0}\n'); break
                if 'hello' in req: conn.sendall((json.dumps({'version': version}) + '\n').encode()); continue
                buf, code = io.StringIO(), 0
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    try: cap.run(parser().parse_args(req['argv']))
                    except SystemExit as e: code = e.code if isinstance(e.code, int) else (print(e.code) or 2)
                    except Exception as e:
                        code = 1; print(f'error: {str(e)[:600]}')
                        if os.environ.get('PB_SCREEN_DEBUG'): traceback.print_exc()
                conn.sendall((json.dumps({'out': buf.getvalue(), 'code': code}) + '\n').encode())
                last = time.time()
    finally:
        game.stop()
        try: pw.stop()
        except Exception: pass
        if SOCK.exists(): SOCK.unlink()


def ask(req, timeout=180):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout); s.connect(str(SOCK))
    with s:
        s.sendall((json.dumps(req) + '\n').encode())
        return json.loads(s.makefile().readline())


def client():
    argv = sys.argv[1:]
    if not argv or argv[0] in ('-h', '--help'): print(__doc__); return 0
    if argv[0] == '--stop':
        try: print(ask({'stop': 1}, 10)['out'])
        except OSError: print('not running')
        return 0
    parser().parse_args(argv)  # bad arguments fail here, before any helper starts
    try:
        if ask({'hello': 1}, 5)['version'] != ME.stat().st_mtime: ask({'stop': 1}, 10); time.sleep(0.2); raise OSError
    except OSError:
        RUN.mkdir(exist_ok=True)
        log = open(RUN / f'{SOCK.stem}.log', 'w')
        subprocess.Popen([sys.executable, str(ME), '--daemon'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        for _ in range(300):
            try: ask({'hello': 1}, 2); break
            except OSError: time.sleep(0.05)
        else: sys.exit(f'the helper did not start; see {log.name}')
    r = ask({'argv': argv})
    print(r['out'], end='')
    return r['code']


if __name__ == '__main__':
    if sys.argv[1:] == ['--daemon']: daemon()
    else: sys.exit(client())
