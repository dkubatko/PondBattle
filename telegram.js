// Telegram side of Pond Battle: checks Mini App launch data and runs the bot (long polling, no webhook).
// No dependencies: uses Node's built-in fetch and crypto.
'use strict';
const crypto = require('crypto');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const api = (method, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());

// ---------- Mini App launch data ----------
// Telegram signs initData with a key derived from the bot token; a valid hash proves who opened the app.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const MAX_AGE = 7 * 86400; // seconds; old launch data is refused
function verifyInitData(initData) {
  if (!TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const expect = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (expect.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > MAX_AGE) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? { user, startParam: params.get('start_param') || '' } : null;
  } catch { return null; }
}

// ---------- Bot ----------
let username = '';
const playButton = (text, query = '') => ({ inline_keyboard: [[{ text, web_app: { url: `${PUBLIC_URL}/${query}` } }]] });

async function onMessage(m) {
  const text = (m.text || '').trim();
  if (!m.chat || m.chat.type !== 'private' || !/^\/(start|play)\b/.test(text)) return;
  // Invite links are t.me/<bot>?start=join_ABCD
  const code = (text.match(/^\/start\s+join_([A-Z]{4})$/i) || [])[1];
  await api('sendMessage', code
    ? { chat_id: m.chat.id, text: `You're invited to pond ${code.toUpperCase()} 🐸`, reply_markup: playButton('Join the pond', `?join=${code.toUpperCase()}`) }
    : { chat_id: m.chat.id, text: 'Frog Pond Brawl: a cozy frog battler for two. 🐸', reply_markup: playButton('Play') });
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const r = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      if (!r.ok) { console.error('telegram getUpdates:', r.description); await new Promise((f) => setTimeout(f, 10000)); continue; }
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.message) onMessage(u.message).catch((e) => console.error('telegram message:', e.message));
      }
    } catch (e) {
      console.error('telegram poll:', e.message);
      await new Promise((f) => setTimeout(f, 5000));
    }
  }
}

async function start() {
  if (!TOKEN) return console.log('telegram: no TELEGRAM_BOT_TOKEN, bot off (browser guests only)');
  const me = await api('getMe').catch(() => null);
  if (!me || !me.ok) return console.error('telegram: bot token rejected');
  username = me.result.username;
  if (PUBLIC_URL.startsWith('https://')) {
    // The menu button next to the chat's text box opens the game
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Play', web_app: { url: `${PUBLIC_URL}/` } } });
    await api('setMyCommands', { commands: [{ command: 'play', description: 'Open the pond' }] });
  } else console.log('telegram: PUBLIC_URL is not https, so the Play buttons are off (Telegram requires https)');
  console.log(`telegram: bot @${username} running`);
  poll();
}

// A short note with a button back into the game (used when someone joins your pond or is waiting for you)
function notify(tgId, text, query) {
  if (!TOKEN || !PUBLIC_URL.startsWith('https://')) return;
  api('sendMessage', { chat_id: tgId, text, disable_notification: false, reply_markup: playButton('Open the pond', query) })
    .then((r) => { if (!r.ok) console.error('telegram notify:', r.description); })
    .catch((e) => console.error('telegram notify:', e.message));
}

module.exports = { verifyInitData, start, notify, botUsername: () => username, enabled: () => !!TOKEN };
