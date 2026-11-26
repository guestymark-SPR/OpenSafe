'use strict';
// Batch B (phone): add photos and a receipt to an existing item after scanning its label, and a
// stock check with continuous scanning. The camera and BarcodeDetector are replaced by stand-ins
// that "see" a queue of label codes. Then the export is imported into a PC store.
// Run: xvfb-run -a npx electron --no-sandbox test/batchB-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const pv = require('../src/phoneview');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bB';
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

const pcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbB-'));
const pc = new Store(pcDir); pc.load();
const I = {};
for (const [k, loc, extra] of [['drill', 'Garage'], ['ladder', 'Garage'], ['saw', 'Garage'], ['mower', 'Shed'], ['bench', 'Garden'], ['bike', 'Garage', { status: 'Lent out', lentTo: 'Sam' }]]) {
  I[k] = pc.saveAsset(Object.assign({ name: k[0].toUpperCase() + k.slice(1), location: loc, category: 'Tools' }, extra || {})).id;
}
const fileText = pv.encryptView(pv.buildView(pc, {}), 'phone pass 1');
const link = (id) => `https://guestymark-spr.github.io/OpenSafe/#item=${id}`;
const photoB64 = fs.readFileSync('/tmp/okshots/photos/p1.jpg').toString('base64');

const STUBS = `(() => {
  window.__codes = [];
  window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code', 'ean_13']; } async detect() { const c = window.__codes.shift(); return c ? [{ rawValue: c }] : []; } };
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { const c = document.createElement('canvas'); c.width = 16; c.height = 16; c.getContext('2d').fillRect(0, 0, 16, 16); return c.captureStream(5); } });
})()`;

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let downloaded = null;
  session.defaultSession.on('will-download', (_e, item) => { const p = path.join(OUT, 'export.opensafe'); item.setSavePath(p); item.once('done', () => { downloaded = p; }); });
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const sheetText = () => js(`document.getElementById('sheetBody').innerText`);
  const R = {};
  try {
    await win.loadURL(base); await wait(700);
    await js(STUBS);
    // load and unlock the inventory
    await js(`document.querySelector('#tabs [data-tab=inv]').click()`); await wait(300);
    await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(fileText)}], 'inv.opensafe-view')); const i = document.getElementById('invFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
    await wait(500);
    await js(`document.getElementById('invUnlock').pass.value = 'phone pass 1'; document.getElementById('invUnlock').requestSubmit()`); await wait(2000);
    await js(`document.querySelector('#tabs [data-tab=home]').click()`); await wait(300);
    // 1. scan the drill's label, add two photos and a PDF receipt
    await js(`window.__codes.push(${JSON.stringify(link(I.drill))}); document.querySelector('[data-act=scanItem]').click()`); await wait(1200);
    R.scanOpened = (await sheetText()).split('\n')[0];
    await js(`document.querySelector('[data-kind=photos]').click()`); await wait(300);
    await js(`document.getElementById('actForm').requestSubmit()`); await wait(200);
    R.noPhotoErr = await js(`document.getElementById('actErr').innerText`);
    const addFile = (sel, name, type, b64) => js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })); const i = document.querySelector(${JSON.stringify(sel)}); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await addFile('input[data-attach=photo][multiple]', 'damage1.jpg', 'image/jpeg', photoB64); await wait(800);
    await addFile('input[data-attach=photo][multiple]', 'damage2.jpg', 'image/jpeg', photoB64); await wait(800);
    R.photoRows = await js(`document.querySelectorAll('#attList .attrow').length`);
    await js(`document.getElementById('actForm').note.value = 'Chuck is scratched'`);
    await shot('b1-add-photos');
    await js(`document.getElementById('actForm').requestSubmit()`); await wait(700);
    await js(`window.__codes.push(${JSON.stringify(link(I.drill))}); document.querySelector('[data-act=scanItem]').click()`); await wait(1200);
    await js(`document.querySelector('[data-kind=receipt]').click()`); await wait(300);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
    await addFile('input[data-attach=doc][multiple]', 'Screwfix receipt.pdf', 'application/pdf', pdf); await wait(500);
    await js(`document.getElementById('actForm').requestSubmit()`); await wait(700);
    R.homeChanges = await js(`[...document.querySelectorAll('#changeList .change .t')].map(e => e.innerText.split('\\n').slice(0, 2).join(' | '))`);
    // 2. stock check of the Garage
    await js(`document.querySelector('[data-act=stockCheck]').click()`); await wait(500);
    R.places = await js(`[...document.querySelectorAll('#stockForm select option')].map(o => o.innerText)`);
    await js(`document.querySelector('#stockForm').loc.value = 'Garage'`);
    await shot('b2-stock-start');
    await js(`window.__codes.push(${JSON.stringify([link(I.drill), link(I.ladder), link(I.mower), link('ffffffff-ffff-4fff-8fff-ffffffffffff'), link(I.drill), 'https://example.com/not-a-label'])}.flat ? '' : ''); window.__codes.push(...${JSON.stringify([link(I.drill), link(I.ladder), link(I.mower), link('ffffffff-ffff-4fff-8fff-ffffffffffff'), link(I.drill), 'https://example.com/not-a-label'])}); document.getElementById('stockForm').requestSubmit()`);
    await wait(1200);
    R.liveMsg = await js(`document.getElementById('scanMsg').innerText + ' / ' + document.getElementById('scanCount').innerText`);
    await shot('b3-scanning');
    await wait(1500);
    R.finishLabel = await js(`document.getElementById('scanCloseBtn').innerText`);
    await js(`document.getElementById('scanCloseBtn').click()`); await wait(600);
    await shot('b4-results');
    R.results = await sheetText();
    await js(`document.querySelector('[data-act=stockMove]').click()`); await wait(700);
    R.afterMove = (await sheetText()).includes('In the wrong place');
    await js(`document.querySelector('[data-act=stockDone]').click()`); await wait(500);
    // 3. export and import on the PC
    await js(`document.getElementById('exportBtn').click()`); await wait(1200);
    R.exportSheet = (await sheetText()).split('\n').filter(Boolean).slice(0, 3).join(' | ');
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 40 && !downloaded; i++) await wait(100);
    await wait(300);
    const exp = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
    R.exportVersion = exp.version;
    R.exportFiles = exp.updates.map(u => `${u.summary}: ${(u.photos || []).length}p ${(u.documents || []).length}d`);
    const r = pc.importCapture(exp);
    R.pcResult = { changes: r.changes, photos: r.photos, documents: r.documents, errors: r.errors, skipped: r.skippedChanges };
    const d = pc.getAsset(I.drill);
    R.pcDrill = { photos: d.photos.map(p => p.name), docs: d.documents.map(x => `${x.name} (${x.type})`), photoBytes: pc.readAttachment(I.drill, d.photos[0].file).length, notes: d.notes };
    R.pcMower = pc.getAsset(I.mower).location;
    const again = pc.importCapture(JSON.parse(JSON.stringify(exp)));
    R.reimport = { changes: again.changes, photos: again.photos, drillPhotos: pc.getAsset(I.drill).photos.length };
  } catch (e) { R.fatal = e.stack; }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close(); app.exit(0);
});
