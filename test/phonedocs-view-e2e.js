'use strict';
// Documents on the phone: mark documents on the PC, save the inventory file for the phone,
// then open it in OpenSafe Capture and read the documents there (pages, search, linked item).
// Run: xvfb-run -a npx electron --no-sandbox test/phonedocs-view-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, dialog, shell, BrowserWindow } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/phonedocs-view-e2e';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osphdocs-'));
process.env.OPENSAFE_DATA_DIR = dir;
const SAVE = path.join(OUT, 'inv.opensafe-view');
try { fs.unlinkSync(SAVE); } catch (_) {}
dialog.showMessageBox = async () => ({ response: 0 });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: SAVE });
shell.showItemInFolder = () => {};

const s = new Store(dir); s.load();
const boiler = s.saveAsset({ name: 'Worcester boiler', category: 'Appliances', location: 'Home' });
s.saveAsset({ name: 'Drill', category: 'Tools', location: 'Garage' });
const add = (o, files) => { const e = s.saveLibraryEntry(Object.assign({ kind: 'document' }, o)); for (const [n, b] of files) s.addLibraryFile(e.id, n, b); return e; };
add({ title: 'AFCS award', from: 'Veterans UK', docDate: '2026-08-14', ref: 'AFCS/2026/88123' }, [['letter.png', fs.readFileSync(path.join(F, 'letter.png'))]]);
add({ title: 'Boiler guarantee', from: 'Worcester Bosch', docDate: '2025-11-02', assetIds: [boiler.id] }, [['guarantee.pdf', fs.readFileSync(path.join(F, 'statement.pdf'))]]);
add({ title: 'Not for the phone', docDate: '2026-01-01' }, [['x.pdf', fs.readFileSync(path.join(F, 'text.pdf'))]]);
add({ kind: 'data', title: 'Eurotunnel booking', folder: 'Emails' }, [['mail.eml', fs.readFileSync(path.join(F, 'mail.eml'))]]);
require('../src/main.js');

const MOBILE = path.join(__dirname, '..', 'mobile');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(MOBILE, path.normalize(p));
  if (!f.startsWith(MOBILE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (w, name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await w.webContents.capturePage()).toPNG()); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // ---- PC: right-click a document → Keep a copy on my phone
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(600);
      await js(`{ const r = [...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('AFCS award')); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 })); }`); await wait(400);
      await js(`[...document.querySelectorAll('.menu.ctx [data-action]')].find(b => b.innerText.includes('Keep a copy on my phone')).click()`); await wait(800);
      // the guarantee, from its own page's More menu
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('Boiler guarantee')).click()`); await wait(800);
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(400);
      R.moreMenu = await js(`[...document.querySelectorAll('#view .head .menuwrap .menu button')].map(b => b.innerText.trim() + (b.closest('.menu').classList.contains('hidden') ? ' (hidden)' : ''))`);
      await js(`document.querySelector('#view .head .menu [data-action=libOnPhone]').click()`); await wait(800);
      R.pagePill = await js(`document.querySelector('.libhead').innerText.replace(/\\s+/g, ' ')`);
      // the email in Data, by ticking it and using Move to ▾
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(600);
      await js(`document.querySelector('#libList tbody tr input[type=checkbox]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('.selbar .menuwrap > button')][0].click()`); await wait(300);
      await js(`[...document.querySelectorAll('.selbar .menu [data-action=libOnPhone]')][0].click()`); await wait(800);
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(600);
      R.docsList = await js(`[...document.querySelectorAll('#libList tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot(win, 'p1-docs-marked');
      // ---- PC: save the inventory file for the phone
      await js(`document.querySelector('[data-nav=phone]').click()`); await wait(800);
      R.phoneCard = await js(`[...document.querySelectorAll('.card.tile')].find(c => c.innerText.includes('Send your inventory')).innerText.replace(/\\s+/g, ' ')`);
      await js(`document.getElementById('pvPass').value = 'phone pass 1'; document.querySelector('[data-action=phoneView]').click()`);
      for (let i = 0; i < 120 && !fs.existsSync(SAVE); i++) await wait(500);
      await wait(1500);
      R.toast = await js(`(document.querySelector('.toast') || {}).innerText`);
      R.fileKB = Math.round(fs.statSync(SAVE).size / 1024);
      await shot(win, 'p2-phone-page');
      // ---- phone: load and read
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const ph = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
      const pj = (code) => ph.webContents.executeJavaScript(code);
      await ph.loadURL(`http://127.0.0.1:${server.address().port}/`); await wait(800);
      await pj(`document.querySelector('#tabs [data-tab=inv]').click()`); await wait(300);
      await pj(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(fs.readFileSync(SAVE, 'utf8'))}], 'inv.opensafe-view')); const i = document.getElementById('invFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
      await wait(600);
      await pj(`document.getElementById('invUnlock').pass.value = 'phone pass 1'; document.getElementById('invUnlock').requestSubmit()`); await wait(2500);
      R.chip = await pj(`(() => { const c = document.getElementById('docsChip'); return c.classList.contains('hidden') ? 'hidden' : c.innerText; })()`);
      await shot(ph, 'p3-phone-inventory');
      await pj(`document.getElementById('docsChip').click()`); await wait(400);
      R.phoneDocs = await pj(`[...document.querySelectorAll('#sheetBody li')].map(l => l.innerText.replace(/\\s+/g, ' '))`);
      await shot(ph, 'p4-phone-docs');
      await pj(`{ const q = document.getElementById('docQ'); q.value = 'tariff'; q.dispatchEvent(new Event('input')); }`); await wait(400);
      R.search = await pj(`[...document.querySelectorAll('#sheetBody li')].map(l => l.innerText.replace(/\\s+/g, ' '))`);
      await pj(`document.querySelector('#sheetBody li').click()`); await wait(800);
      R.doc = await pj(`({ text: document.getElementById('sheetBody').innerText.replace(/\\s+/g, ' ').slice(0, 300), pages: [...document.querySelectorAll('.readpages img')].map(i => i.naturalWidth + 'x' + i.naturalHeight) })`);
      await shot(ph, 'p5-phone-letter');
      // the boiler's page lists its guarantee, which opens with all its pages
      await pj(`document.querySelector('[data-act=closeSheet]').click(); document.getElementById('invQ').value = ''; document.getElementById('invQ').dispatchEvent(new Event('input'))`); await wait(300);
      await pj(`[...document.querySelectorAll('[data-inv]')].find(d => d.innerText.includes('Worcester')).click()`); await wait(500);
      R.itemLinked = await pj(`[...document.querySelectorAll('#sheetBody li[data-act=doc]')].map(l => l.innerText.replace(/\\s+/g, ' '))`);
      await pj(`document.querySelector('#sheetBody li[data-act=doc]').click()`); await wait(900);
      R.guarantee = await pj(`({ pages: document.querySelectorAll('.readpages img').length, sizes: [...document.querySelectorAll('.readpages img')].map(i => i.naturalWidth), linked: (document.querySelector('[data-act=invItemOpen]') || {}).innerText })`);
      await pj(`document.querySelector('.readpages').scrollIntoView()`); await wait(200);
      await shot(ph, 'p6-phone-guarantee');
      await pj(`document.querySelector('[data-act=docs]').click()`); await wait(400);
      await pj(`[...document.querySelectorAll('#sheetBody li')].find(l => l.innerText.includes('Eurotunnel')).click()`); await wait(900);
      R.email = await pj(`({ pages: document.querySelectorAll('.readpages img').length, w: [...document.querySelectorAll('.readpages img')].map(i => i.naturalWidth) })`);
      await shot(ph, 'p7-phone-email');
      ph.destroy();
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    server.close();
    app.exit(0);
  });
});
