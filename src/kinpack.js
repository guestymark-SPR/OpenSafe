'use strict';
// "If something happens to me" pack: one HTML file for your next of kin that opens in any web browser,
// with nothing to install and no internet needed. Everything in it is encrypted with its own passphrase
// (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM); the page decrypts it with the browser's own
// Web Crypto when the passphrase is typed in. Without the passphrase the file is unreadable.

const crypto = require('crypto');

const ITER = 600000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function encrypt(obj, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(String(passphrase).normalize('NFC'), 'utf8'), salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final(), c.getAuthTag()]); // Web Crypto expects the tag at the end
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), iter: ITER, data: body.toString('base64') };
}
/** For tests and for checking a pack: the same steps the page does. */
function decrypt(pack, passphrase) {
  const key = crypto.pbkdf2Sync(Buffer.from(String(passphrase).normalize('NFC'), 'utf8'), Buffer.from(pack.salt, 'base64'), pack.iter, 32, 'sha256');
  const buf = Buffer.from(pack.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(pack.iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}

/** How strong a passphrase is, roughly (length and variety). Returns a problem to fix, or ''. */
function weakness(p) {
  const s = String(p || '');
  if (s.length < 12) return 'Use at least 12 characters: a few random words is easy to remember and hard to guess.';
  if (/^(.)\1+$/.test(s) || /^(password|letmein|qwerty|123456)/i.test(s)) return 'That passphrase is too easy to guess.';
  return '';
}

/**
 * @param content { owner, made, letter, where, contacts: [{ name, role, contact }], policies: [...], items: [...],
 *                  documents: [{ title, from, date, files: [{ name, type, data (base64) }] }] }
 */
function build(content, passphrase) {
  const pack = encrypt(content, passphrase);
  // the page itself says nothing about what's inside, apart from whose it is
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; object-src blob:; frame-src blob:">
<title>Information for my family${content.owner ? ' from ' + esc(content.owner) : ''}</title>
<style>
body{font:16px/1.55 "Segoe UI",system-ui,Arial,sans-serif;color:#1d1d1b;background:#f4f3ef;margin:0}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.08);padding:18px 22px;margin:0 0 16px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:0 0 10px}
input,button{font:inherit}input[type=password]{width:100%;max-width:420px;padding:10px 12px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
button{padding:10px 16px;border-radius:8px;border:0;background:#1d4d4f;color:#fff;cursor:pointer;margin-top:10px}
.muted{color:#666}.err{color:#b3261e}.pre{white-space:pre-wrap}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}
.file{display:flex;gap:10px;align-items:center;margin:4px 0}.file a{color:#1d6b62}
@media print{body{background:#fff}.card{box-shadow:none;border:1px solid #ddd}#unlock{display:none}}
</style></head><body><main>
<div class="card" id="unlock"><h1>Information for my family</h1>
<p class="muted">${content.owner ? esc(content.owner) + ' made this file so you have what you need if something happens to them.' : 'This file holds information to help you if something happens to the person who made it.'} It's locked. Type the passphrase you were given to open it. Nothing is sent anywhere: it opens on this computer only.</p>
<form id="f"><input type="password" id="p" autocomplete="off" placeholder="Passphrase" autofocus><br><button type="submit" id="go">Open</button></form><p class="err" id="e"></p></div>
<div id="out"></div>
<script>
const PACK = ${JSON.stringify(pack)};
const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function open(pass) {
  if (!window.crypto || !crypto.subtle) throw new Error('This browser can\\'t open it. Try Chrome, Edge, Firefox or Safari.');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(PACK.salt), iterations: PACK.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(PACK.iv) }, key, b64(PACK.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
function show(c) {
  const sec = (title, html) => html ? '<div class="card"><h2>' + title + '</h2>' + html + '</div>' : '';
  let h = '<div class="card"><h1>Information for my family</h1><p class="muted">From ' + esc(c.owner || '') + (c.made ? ', made ' + esc(c.made) : '') + '. You can print this page (the files below print separately).</p></div>';
  h += sec('A letter to you', c.letter ? '<div class="pre">' + esc(c.letter) + '</div>' : '');
  h += sec('Where things are', c.where ? '<div class="pre">' + esc(c.where) + '</div>' : '');
  h += sec('People to contact', (c.contacts || []).length ? '<table><tr><th>Who</th><th></th><th>How to reach them</th></tr>' + c.contacts.map(x => '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.role) + '</td><td>' + esc(x.contact) + '</td></tr>').join('') + '</table>' : '');
  h += sec('Insurance policies', (c.policies || []).length ? '<table><tr><th>Insurer</th><th>Type</th><th>Policy number</th><th>Claims line</th><th>Renews</th></tr>' + c.policies.map(p => '<tr><td>' + esc(p.insurer) + '</td><td>' + esc(p.type) + '</td><td>' + esc(p.policyNumber) + '</td><td>' + esc(p.claimsPhone) + '</td><td>' + esc(p.renewalDate) + '</td></tr>').join('') + '</table>' : '');
  h += sec('Valuable things', (c.items || []).length ? '<table><tr><th>Item</th><th>Where</th><th>Worth</th><th>Details</th></tr>' + c.items.map(a => '<tr><td>' + esc(a.name) + '</td><td>' + esc(a.location) + '</td><td>' + esc(a.value) + '</td><td>' + esc(a.details) + '</td></tr>').join('') + '</table>' : '');
  let files = 0;
  h += sec('Documents', (c.documents || []).length ? c.documents.map((d, i) => '<div style="margin:0 0 12px"><b>' + esc(d.title) + '</b> <span class="muted">' + esc([d.from, d.date].filter(Boolean).join(' · ')) + '</span>' + d.files.map((f, j) => { files++; return '<div class="file">📄 ' + esc(f.name) + ' — <a href="#" data-d="' + i + '" data-f="' + j + '" data-how="open">Open</a> · <a href="#" data-d="' + i + '" data-f="' + j + '" data-how="save">Save</a></div>'; }).join('') + '</div>').join('') : '');
  document.getElementById('out').innerHTML = h;
  document.getElementById('out').onclick = (ev) => {
    const a = ev.target.closest('a[data-d]'); if (!a) return; ev.preventDefault();
    const f = c.documents[+a.dataset.d].files[+a.dataset.f];
    const url = URL.createObjectURL(new Blob([b64(f.data)], { type: f.type || 'application/octet-stream' }));
    if (a.dataset.how === 'open') window.open(url, '_blank'); else { const l = document.createElement('a'); l.href = url; l.download = f.name; document.body.appendChild(l); l.click(); l.remove(); }
  };
}
document.getElementById('f').onsubmit = async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e'), go = document.getElementById('go');
  e.textContent = ''; go.disabled = true; go.textContent = 'Opening…';
  try { const c = await open(document.getElementById('p').value); document.getElementById('unlock').remove(); show(c); window.__opened = true; }
  catch (err) { e.textContent = err && err.name === 'OperationError' ? 'That passphrase isn\\'t right. Check it and try again.' : String(err.message || err); go.disabled = false; go.textContent = 'Open'; }
};
</script></main></body></html>`;
}

module.exports = { build, encrypt, decrypt, weakness, ITER };
