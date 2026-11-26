'use strict';
// Phone app: load an inventory file encrypted by the PC, unlock it with Web Crypto,
// search, open an item, open an item from a QR label link, and check barcodes export.
// Run: xvfb-run -a npx electron --no-sandbox test/inventory-e2e.js <outDir>
const fs = require('fs');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const pv = require('../src/phoneview');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/inv';
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

const thumb = 'data:image/jpeg;base64,' + fs.readFileSync('/tmp/okshots/photos/p1.jpg').toString('base64');
const view = { exportedAt: new Date().toISOString(), count: 3, items: [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Mercedes C220d estate', category: 'Vehicles', location: 'Driveway', currentValue: 14500, details: { kind: 'vehicle', reg: 'AB21 CDE', motDue: '2026-12-05' }, photos: 3, documents: 2, thumb, tags: [] },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Makita drill', category: 'Tools', location: 'Garage', serial: 'MK-0099', brand: 'Makita', photos: 1, documents: 1, thumb: null, tags: ['diy'] },
  { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Moody 37', category: 'Marine', details: { kind: 'boat', hin: 'GB-MOD37' }, photos: 0, documents: 0, tags: [] }
] };
const fileText = pv.encryptView(view, 'phone pass 1');

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let downloaded = null;
  session.defaultSession.on('will-download', (_e, item) => { const p = path.join(OUT, 'export.opensafe'); item.setSavePath(p); item.once('done', () => { downloaded = p; }); });
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const R = {};
  try {
    await win.loadURL(base); await wait(700);
    await js(`document.querySelector('#tabs [data-tab=inv]').click()`); await wait(400);
    await shot('i1-empty');
    R.noneShown = await js(`!document.getElementById('invNone').classList.contains('hidden')`);
    await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(fileText)}], 'OpenSafe-inventory.opensafe-view')); const i = document.getElementById('invFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
    await wait(600);
    await js(`document.getElementById('invUnlock').pass.value = 'wrong pass'; document.getElementById('invUnlock').requestSubmit()`); await wait(2000);
    R.wrongPass = await js(`document.getElementById('invErr').innerText`);
    await js(`document.getElementById('invUnlock').pass.value = 'phone pass 1'; document.getElementById('invUnlock').requestSubmit()`); await wait(2000);
    await shot('i2-list');
    R.list = await js(`[...document.querySelectorAll('#invList .item .n')].map(e => e.innerText)`);
    await js(`{ const q = document.getElementById('invQ'); q.value = 'mk-0099'; q.dispatchEvent(new Event('input')) }`); await wait(200);
    R.search = await js(`[...document.querySelectorAll('#invList .item .n')].map(e => e.innerText)`);
    await js(`{ const q = document.getElementById('invQ'); q.value = ''; q.dispatchEvent(new Event('input')); document.querySelector('[data-inv]').click() }`); await wait(400);
    await shot('i3-detail');
    R.detail = await js(`document.getElementById('sheetBody').innerText`);
    await js(`document.querySelector('[data-act=closeSheet]').click()`);
    // QR label link while locked: reload page with #item= (inventory locked after reload)
    await win.loadURL('about:blank'); await win.loadURL(base + '#item=cccccccc-3333-4333-8333-333333333333'); await wait(900);
    R.afterLinkTab = await js(`document.querySelector('#tabs .on').dataset.tab`);
    R.lockedAfterReload = await js(`!document.getElementById('invUnlock').classList.contains('hidden')`);
    await js(`document.getElementById('invUnlock').pass.value = 'phone pass 1'; document.getElementById('invUnlock').requestSubmit()`); await wait(2000);
    R.linkOpened = await js(`document.getElementById('sheetBody').innerText.split('\\n')[0]`);
    await shot('i4-from-label');
    await js(`document.querySelector('[data-act=closeSheet]').click()`);
    // barcode scanning button shows a clear message where BarcodeDetector is missing
    await js(`document.querySelector('#tabs [data-tab=home]').click()`); await wait(300);
    await js(`document.querySelector('[data-act=new]').click()`); await wait(300);
    await js(`document.querySelector('[data-act=scanBarcode]').click()`); await wait(500);
    R.scanMsg = await js(`document.getElementById('toast').innerText`);
    await js(`{ const f = document.getElementById('form'); f.name.value = 'Kettle'; f.barcode.value = '5011773060820'; document.getElementById('saveBtn').click() }`); await wait(700);
    await js(`document.getElementById('exportBtn').click()`); await wait(900);
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 40 && !downloaded; i++) await wait(100);
    R.exportedBarcode = JSON.parse(fs.readFileSync(downloaded, 'utf8')).items[0].barcode;
  } catch (e) { R.fatal = e.stack; }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close(); app.exit(0);
});
