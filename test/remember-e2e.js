'use strict';
// Phone app: the inventory passphrase is asked once per file, then remembered across restarts.
// Run: xvfb-run -a npx electron --no-sandbox test/remember-e2e.js <outDir>
const fs = require('fs');
const path = require('path');
const http = require('http');
const { app, BrowserWindow } = require('electron');
const pv = require('../src/phoneview');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/rem';
fs.mkdirSync(OUT, { recursive: true });
const MOBILE = path.join(__dirname, '..', 'mobile');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(MOBILE, path.normalize(p));
  if (!f.startsWith(MOBILE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const view = (name) => ({ exportedAt: new Date().toISOString(), count: 1, items: [{ id: ID, name, category: 'Tools', photos: 0, documents: 0, tags: [] }] });
const file1 = pv.encryptView(view('Makita drill'), 'phone pass 1');
const file2 = pv.encryptView(view('Makita drill v2'), 'phone pass 1');

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const restart = async (hash = '') => { await win.loadURL('about:blank'); await win.loadURL(base + hash); await wait(1200); };
  const invTab = async () => { await js(`document.querySelector('#tabs [data-tab=inv]').click()`); await wait(600); };
  const state = () => js(`({ askPass: !document.getElementById('invUnlock').classList.contains('hidden'), open: !document.getElementById('invOpen').classList.contains('hidden'), names: [...document.querySelectorAll('#invList .item .n')].map(e => e.innerText) })`);
  const load = async (text) => { await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], 'inv.opensafe-view')); const i = document.getElementById('invFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`); await wait(600); };
  const unlock = async () => { await js(`document.getElementById('invUnlock').pass.value = 'phone pass 1'; document.getElementById('invUnlock').requestSubmit()`); await wait(2000); };
  const R = {};
  try {
    await win.loadURL(base); await wait(700);
    await invTab(); await load(file1);
    R.firstTime = await state();
    await unlock();
    R.afterUnlock = await state();
    await restart(); await invTab();
    R.afterRestart = await state();
    await restart('#item=' + ID);
    R.labelAfterRestart = await js(`document.getElementById('sheetBody').innerText.split('\\n')[0]`);
    R.keyExportable = await js(`new Promise(res => { const r = indexedDB.open('opensafe-capture'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('inventoryKey'); g.onsuccess = async () => { const k = g.result && g.result.key; try { await crypto.subtle.exportKey('raw', k); res('EXPORTED'); } catch (e) { res('refused: ' + e.name + ' / extractable=' + k.extractable); } }; }; })`);
    R.passphraseStored = await js(`new Promise(res => { const r = indexedDB.open('opensafe-capture'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').getAll(); g.onsuccess = () => res(JSON.stringify(g.result.map(v => v && v.key ? { salt: v.salt } : v)).includes('phone pass 1')); }; })`);
    // Lock asks again
    await restart(); await invTab();
    await js(`document.querySelector('[data-act=lockInv]').click()`); await wait(500);
    R.afterLock = await state();
    await restart(); await invTab();
    R.afterLockRestart = await state();
    await unlock();
    // a new file from the PC asks once more, then is remembered
    await load(file2);
    R.newFile = await state();
    await unlock();
    await restart(); await invTab();
    R.newFileAfterRestart = await state();
  } catch (e) { R.fatal = e.stack; }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close(); app.exit(0);
});
