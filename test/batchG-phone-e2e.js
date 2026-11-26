'use strict';
// Batch G (phone): photo dates: add photos and a receipt to an existing item after scanning its label, and a
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

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bGp';
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

const pcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbGp-'));
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

const exifB64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'exif-2023-07-15.jpg')).toString('base64');
app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let downloaded = null;
  session.defaultSession.on('will-download', (_e, item) => { const p = path.join(OUT, 'export.opensafe'); item.setSavePath(p); item.once('done', () => { downloaded = p; }); });
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const R = {};
  try {
    await win.loadURL(base); await wait(700);
    await js(`document.querySelector('[data-act=new]').click()`); await wait(300);
    await js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(exifB64)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'IMG_0001.jpg', { type: 'image/jpeg' })); const i = document.getElementById('gallery'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`); await wait(1200);
    await js(`{ const f = document.getElementById('form'); f.name.value = 'Tent'; document.getElementById('saveBtn').click(); }`); await wait(700);
    await js(`document.getElementById('exportBtn').click()`); await wait(1000);
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 40 && !downloaded; i++) await wait(100);
    await wait(300);
    const exp = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
    const ph = exp.items[0].photos[0];
    R.takenAt = ph.takenAt;
    R.exifStillInShrunkFile = require('../src/exif').takenAt(Buffer.from(ph.data, 'base64'));
    const r = pc.importCapture(exp);
    R.pcTakenAt = pc.getAsset(exp.items[0].id).photos[0].takenAt;
    R.pcHint = pc.photoDateHint(pc.getAsset(exp.items[0].id));
  } catch (e) { R.fatal = e.stack; }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close(); app.exit(0);
});
