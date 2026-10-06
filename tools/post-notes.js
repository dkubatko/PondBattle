#!/usr/bin/env node
// Patch notes: turns a release's section of CHANGELOG.md into a post for the Pond Brawl group's Patch Notes topic.
//   node tools/post-notes.js            print the newest release's post (nothing is sent)
//   node tools/post-notes.js 1.2.0      print that release's post
//   node tools/post-notes.js --send     post it as the bot (needs TELEGRAM_BOT_TOKEN), then print its link
// Show the user the printed post and send only once they've approved it. Only the bot and admins can post in the
// topic (it's closed); sending needs no polling, so it doesn't clash with the live server's bot.
const fs = require('fs');
const path = require('path');

const GROUP = '@PondBrawl', TOPIC = 4, PLAY = 'https://t.me/PondBrawlBot?startapp';
const ICONS = { New: '✨', Changes: '🔧', Balance: '⚖️', Fixes: '🛠' };

const args = process.argv.slice(2);
const send = args.includes('--send');
const want = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));

const log = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
// Released sections: "## 1.2.0 (2026-10-06)" up to the next "## "
const sections = [...log.matchAll(/^## (\d+\.\d+\.\d+)[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)];
const found = want ? sections.find((m) => m[1] === want) : sections[0];
if (!found) { console.error(want ? `No ${want} in CHANGELOG.md` : 'No released version in CHANGELOG.md'); process.exit(1); }
const [, version, body] = found;

// Telegram HTML: escape, **bold** -> <b>, "### New" -> an icon and a bold heading, "- " -> "• ", wrapped lines of a
// paragraph joined
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const out = [`🐸 <b>Pond Brawl ${version}</b>`, ''];
let para = [];
const flush = () => { if (para.length) out.push(inline(para.join(' '))); para = []; };
for (const l of body.trim().split('\n')) {
  const h = /^### (.+)/.exec(l), b = /^\s*[-*] (.+)/.exec(l);
  if (h) { flush(); out.push('', `${ICONS[h[1].trim()] || '•'} <b>${esc(h[1].trim())}</b>`); }
  else if (b) { flush(); out.push(`• ${inline(b[1])}`); }
  else if (!l.trim()) { flush(); out.push(''); }
  else para.push(l.trim());
}
flush();
const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
if (text.length > 4096) { console.error(`The post is ${text.length} characters; Telegram allows 4096`); process.exit(1); }

if (!send) {
  console.log(text.replace(/<\/?b>/g, '*').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  console.log(`\n[ 🐸 Play Pond Brawl ] -> ${PLAY}\n(not sent: add --send to post it to ${GROUP}, Patch Notes)`);
  process.exit(0);
}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN is not set'); process.exit(1); }
fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: GROUP, message_thread_id: TOPIC, parse_mode: 'HTML', text, link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: '🐸 Play Pond Brawl', url: PLAY }]] },
  }),
}).then((r) => r.json()).then((r) => {
  if (!r.ok) { console.error('Telegram:', r.description); process.exit(1); }
  console.log(`Posted ${version}: https://t.me/${GROUP.slice(1)}/${TOPIC}/${r.result.message_id}`);
});
