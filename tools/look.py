#!/usr/bin/env python3
"""Look at any Pond Brawl screen: screenshots plus a report of page errors, console errors, failed requests and
sideways scrolling, in Chromium and/or WebKit (the Safari engine, closest to iPhone), at phone sizes.

It starts a throwaway server from this checkout (working tree, uncommitted changes included) with its own temporary
data, sets up the state it needs through the API (a guest, a practice game, rounds played), opens the page straight
into it, captures, and stops the server again. Nothing touches the test app's or prod's data.

  tools/look.py home                          the home screen (393x710, Chromium)
  tools/look.py shop --round 4 --sizes all    the shop in round 4, at 393x710, 440x820 and 375x600
  tools/look.py battle --round 3 --at 0,1500,end --both      a battle at 0 and 1.5 s, and its result; both browsers
  tools/look.py profile --text                a sheet, plus the text on screen
  tools/look.py shop --do "tap:.pad" --do "wait:300"         then interact before capturing
  tools/look.py home --server http://localhost:8431          use a running test server (never prod) instead

Scenes: name (first visit), home, queue (looking for a game), waiting (your own pond), picker (set wheel),
  guide, profile, card, ranks, leaders, shop, menu, log (last battle's log), battle, over (game over).
Options:
  --round N         game scenes: play N-1 rounds first (buys whatever is affordable, then Ready vs the Pond Bot)
  --set ID          the practice game's set (e.g. nature, magic)
  --at MS,MS,...    battle: capture this many ms after the battle screen appears ("end" = the result, before Next round)
  --sizes all|WxH,..  default 393x710; all = 393x710,440x820,375x600
  --webkit / --both   WebKit only / Chromium and WebKit (default Chromium)
  --do STEP         (repeatable) tap:CSS | click:TEXT | drag:CSS>CSS | eval:JS | wait:MS
  --fresh           a first-time player (onboarding hints on)
  --text            print the text on screen
  --live            don't freeze animations before capturing (default: frozen, so no mid-blink frames)
  --out DIR         where screenshots go (default /tmp/pb-look/<scene>-<time>)
"""
import argparse, atexit, json, os, re, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from pathlib import Path

VENV = Path.home() / '.local/share/playwright/venv/bin/python'
try:
    from playwright.sync_api import sync_playwright
except ImportError:  # run with the shared Playwright venv
    if VENV.exists() and Path(sys.prefix) != VENV.parent.parent:
        os.execv(str(VENV), [str(VENV), *sys.argv])
    sys.exit('look.py needs Playwright for Python (see /home/agent/shared/AGENTS.md, Tools)')

# WebKit's media, HTTPS and launch check need these (see ~/.local/share/playwright/README); shells get them from env.sh
LIB = Path.home() / '.local/share/playwright/lib'
if LIB.exists():
    for k, v in {'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS': '1', 'GST_PLUGIN_SYSTEM_PATH_1_0': f'{LIB}/gstreamer-1.0',
                 'GST_PLUGIN_SCANNER_1_0': f'{LIB}/gstreamer-1.0/gst-plugin-scanner', 'GIO_EXTRA_MODULES': f'{LIB}/gio/modules'}.items():
        os.environ.setdefault(k, v)

REPO = Path(__file__).resolve().parent.parent
FROGS = json.loads((REPO / 'frogs.json').read_text())
PHONES = ['393x710', '440x820', '375x600']
SHEETS = {'guide': 'openGuide()', 'profile': 'openProfile()', 'card': 'openCard()', 'ranks': 'openRanks()',
          'leaders': 'openLeaders()', 'picker': "pickSet('Practice', () => {})", 'queue': "startSearch('any')"}
GAME = {'shop': None, 'menu': 'openMenu()', 'log': 'openBattleSheet(S.lastBattle)', 'battle': None, 'over': None}
SCENES = ['name', 'home', 'waiting', *SHEETS, *GAME]
FREEZE = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important }'


def args():
    a = argparse.ArgumentParser(description=__doc__.split('\n')[0], epilog='Run with --help for all scenes and options.')
    a.add_argument('scene', choices=SCENES)
    a.add_argument('--round', type=int, default=1)
    a.add_argument('--set')
    a.add_argument('--at', default='0,1500,4000')
    a.add_argument('--sizes', default=PHONES[0])
    a.add_argument('--webkit', action='store_true')
    a.add_argument('--both', action='store_true')
    a.add_argument('--do', action='append', default=[])
    a.add_argument('--fresh', action='store_true')
    a.add_argument('--text', action='store_true')
    a.add_argument('--live', action='store_true')
    a.add_argument('--server')
    a.add_argument('--out')
    if len(sys.argv) > 1 and sys.argv[1] in ('-h', '--help'): print(__doc__); sys.exit(0)
    return a.parse_args()


# ---------- the server ----------
def start_server():
    """A throwaway server from this checkout, on a free port, with its own temporary data; stopped on exit."""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
    data = tempfile.mkdtemp(prefix='pb-look-')
    env = {k: v for k, v in os.environ.items() if not k.startswith('TELEGRAM')}  # never talk to the real bot
    env.update(BOT_DELAY_MS='0', PORT=str(port), DATA_DIR=f'{data}/data', ROOMS_FILE=f'{data}/rooms.json', HISTORY_FILE=f'{data}/games.jsonl')
    proc = subprocess.Popen(['node', 'server.js'], cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)

    def stop():
        try: os.killpg(proc.pid, signal.SIGTERM); proc.wait(3)
        except Exception: pass
        shutil.rmtree(data, ignore_errors=True)
    atexit.register(stop)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        if proc.poll() is not None: sys.exit('server failed to start:\n' + proc.stderr.read().decode()[-2000:])
        try: urllib.request.urlopen(base + '/api/health', timeout=1); return base
        except Exception: time.sleep(0.05)
    sys.exit('server did not answer on ' + base)


def check_server(url):
    host = urllib.parse.urlparse(url).hostname or ''
    if not (host in ('localhost', '127.0.0.1') or re.match(r'^(192\.168|10)\.', host)):
        sys.exit(f'--server {url}: only local test servers (it creates players and games; never point it at prod)')
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

    def play_round(self, room):
        """Buy whatever is affordable (merging copies), press Ready, and wait for the Pond Bot and the battle."""
        st = self.state(room)
        for i, f in enumerate(st['me']['shop']['frogs']):
            if not f: continue
            team, cost = st['me']['team'], f.get('cost', FROGS[f['type']].get('cost', 3))
            slot = next((k for k, t in enumerate(team) if t and t['type'] == f['type'] and t['lvl'] < 3), None)
            if slot is None: slot = next((k for k, t in enumerate(team) if not t), None)
            if slot is not None and st['me']['gold'] >= cost: st = self.act(room, {'type': 'buy', 'shopIdx': i, 'slot': slot})
        rnd = st['round']
        self.act(room, {'type': 'ready'})
        for _ in range(100):
            st = self.state(room)
            if st['round'] != rnd or st['phase'] != 'shop': return st
            time.sleep(0.2)
        sys.exit('the Pond Bot never got ready')


# ---------- setting up a scene ----------
def setup(o, api):
    """Returns (localStorage to set before the page loads, JS to run once it's up, the game room or None)."""
    store = {} if o.fresh else {'frogOnboarded': '1', 'frogSwipeHint': '1'}
    if o.scene == 'name':
        return {**store}, None, None
    store['frogGuest'] = json.dumps(api.guest('Tester'))
    if o.scene == 'home': return store, None, None
    if o.scene in SHEETS: return store, SHEETS[o.scene], None
    if o.scene == 'waiting':
        room = api.post('/api/create', {'set': o.set} if o.set else {})
        return {**store, 'frogSess': json.dumps(room)}, None, room
    room = api.post('/api/practice', {'set': o.set} if o.set else {})
    rounds = 99 if o.scene == 'over' else o.round - 1
    if o.scene == 'log': rounds = max(rounds, 1)
    st = None
    for _ in range(rounds):
        st = api.play_round(room)
        if st['phase'] == 'over': break
    if o.scene == 'battle' and st and st['phase'] == 'over': sys.exit('the game ended before that round')
    store['frogSess'] = json.dumps(room)
    if st and st.get('lastBattle'): store[f"frogSeen_{room['room']}"] = st['lastBattle']['id']  # don't replay it
    return store, GAME[o.scene], room


# ---------- capture ----------
def report(view, shots, o):
    p = view['page']
    width = p.evaluate('document.documentElement.scrollWidth') if not p.is_closed() else 0
    lines = [f"{view['name']}: " + ', '.join(shots)]
    if width > view['w']: lines.append(f'  ! the page scrolls sideways: {width}px wide in a {view["w"]}px screen')
    for e in view['errors']: lines.append('  ! ' + e)
    if o.text:
        txt = p.evaluate("""() => [...document.querySelectorAll('#root, .sheet-wrap')].map((n) => n.innerText).join('\\n---\\n')""")
        lines.append('  text: ' + re.sub(r'\s*\n\s*', ' | ', txt.strip())[:1500])
    print('\n'.join(lines))


def shoot(view, out, tag, o):
    p, name = view['page'], f"{view['name']}{tag}.png"
    if o.scene == 'battle': p.evaluate('document.getAnimations().forEach((a) => a.pause())')  # a still frame mid-battle
    p.screenshot(path=str(out / name))
    if o.scene == 'battle': p.evaluate('document.getAnimations().forEach((a) => a.play())')
    return name


def step(p, s):
    kind, _, arg = s.partition(':')
    if kind == 'tap': p.locator(arg).first.click()
    elif kind == 'click': p.get_by_text(arg).first.click()
    elif kind == 'drag': a, b = arg.split('>', 1); p.locator(a).first.drag_to(p.locator(b).first)
    elif kind == 'eval': p.evaluate(arg)
    elif kind == 'wait': p.wait_for_timeout(int(arg))
    else: sys.exit(f'--do {s}: use tap:CSS, click:TEXT, drag:CSS>CSS, eval:JS or wait:MS')


def main():
    o = args()
    t0 = time.time()
    base = check_server(o.server) if o.server else start_server()
    api = Api(base)
    store, open_js, room = setup(o, api)
    sizes = PHONES if o.sizes == 'all' else o.sizes.split(',')
    browsers = ['chromium', 'webkit'] if o.both else ['webkit'] if o.webkit else ['chromium']
    out = Path(o.out or f"/tmp/pb-look/{o.scene}-{time.strftime('%H%M%S')}"); out.mkdir(parents=True, exist_ok=True)
    init = ''.join(f'localStorage.setItem({json.dumps(k)}, {json.dumps(v)});' for k, v in store.items())
    with sync_playwright() as pw:
        views = []
        for b in browsers:
            browser = getattr(pw, b).launch()
            for size in sizes:
                w, h = map(int, size.split('x'))
                ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=True)
                ctx.add_init_script(f'if (!sessionStorage.pbLook) {{ sessionStorage.pbLook = 1; {init} }}')
                p = ctx.new_page()
                v = {'name': f'{o.scene}-{b}-{size}', 'w': w, 'page': p, 'errors': []}
                p.on('pageerror', lambda e, v=v: v['errors'].append(f'page error: {e}'))
                p.on('console', lambda m, v=v: m.type == 'error' and v['errors'].append(f'console error: {m.text[:300]}'))
                p.on('response', lambda r, v=v: r.status >= 400 and v['errors'].append(f'HTTP {r.status} {r.request.method} {r.url[len(base):][:120]}'))
                p.on('requestfailed', lambda r, v=v: v['errors'].append(f'request failed: {r.url[:120]} ({r.failure})'))
                p.goto(base + '/')
                p.wait_for_function("typeof screen === 'string' && screen !== ''", timeout=15000)
                if open_js: p.evaluate(open_js)
                views.append(v)
        for v in views:
            for s in o.do: step(v['page'], s)
            v['page'].wait_for_timeout(500)  # sheets slide in, lists load
            if not o.live and o.scene != 'battle': v['page'].add_style_tag(content=FREEZE)
        if o.scene == 'battle':
            api.act(room, {'type': 'ready'})
            views[0]['page'].wait_for_function("screen === 'battle'", timeout=20000, polling=50)  # after the pre-battle gifts
            start = time.time()
            shots = {id(v): [] for v in views}
            for at in o.at.split(','):
                if at == 'end':  # the result is up (it waits for a tap on Next round)
                    views[0]['page'].wait_for_selector('#cont', timeout=120000); views[0]['page'].wait_for_timeout(600)
                else: time.sleep(max(0, start + int(at) / 1000 - time.time()))
                for v in views: shots[id(v)].append(shoot(v, out, f'-{at}', o))
            for v in views: report(v, shots[id(v)], o)
        else:
            for v in views: report(v, [shoot(v, out, '', o)], o)
    print(f'{out}  ({time.time() - t0:.1f}s)')


if __name__ == '__main__':
    main()
