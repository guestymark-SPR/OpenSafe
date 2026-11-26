'use strict';
// End-to-end test of OpenSafe Capture (the phone app) in a phone-sized window:
// add two items (photos + receipt), export, then import the file with the PC store.
// Run: xvfb-run -a npx electron --no-sandbox test/capture-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv[process.argv.length - 1].startsWith('/') ? process.argv[process.argv.length - 1] : '/tmp/okshots/capture';
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

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const result = { steps: [] };
  const exportPath = path.join(OUT, 'export.opensafe');
  let downloaded = null;
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSavePath(exportPath);
    result.suggestedName = item.getFilename();
    item.once('done', (_ev, state) => { downloaded = state; });
  });
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (ev) => { const lvl = ev.level; if (lvl === 'error' || lvl === 3) errors.push(ev.message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadURL(url);
    await wait(800);
    await shot('c1-empty');
    // Item 1: photo from "gallery" + PDF receipt + details
    await js(`(async () => {
      document.querySelector('[data-act=new]').click();
      await new Promise(r => setTimeout(r, 200));
      const f = document.getElementById('form');
      f.name.value = 'Makita drill'; f.category.value = 'Tools'; f.location.value = 'Garage';
      f.brand.value = 'Makita'; f.model.value = 'DHP485'; f.serial.value = 'MK-123'; f.purchasePrice.value = '189.99';
      f.purchaseDate.value = '2024-04-12'; f.warrantyExpiry.value = '2027-04-12'; f.notes.value = 'Two batteries';
      const blob = await (await fetch('icons/icon-512.png')).blob();
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'drill.png', { type: 'image/png' })); dt.items.add(new File([blob], 'drill2.png', { type: 'image/png' }));
      const g = document.getElementById('gallery'); g.files = dt.files; g.dispatchEvent(new Event('change'));
      const dt2 = new DataTransfer(); dt2.items.add(new File(['%PDF-1.4 test'], 'screwfix-receipt.pdf', { type: 'application/pdf' }));
      const r = document.getElementById('receipt'); r.files = dt2.files; r.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 1200));
    })()`);
    await shot('c2-form');
    await js(`document.getElementById('saveBtn').click()`);
    await wait(800);
    // Item 2: name only (validation check first)
    const valMsg = await js(`(async () => {
      document.querySelector('[data-act=new]').click(); await new Promise(r => setTimeout(r, 200));
      document.getElementById('saveBtn').click(); await new Promise(r => setTimeout(r, 200));
      const msg = document.getElementById('formErr').textContent;
      document.getElementById('form').name.value = 'Garden bench';
      document.getElementById('saveBtn').click(); await new Promise(r => setTimeout(r, 600));
      return msg;
    })()`);
    result.validation = valMsg;
    await shot('c3-list');
    result.listText = await js(`document.getElementById('list').innerText + ' | ' + document.getElementById('pendingCount').textContent`);
    // Export
    await js(`document.getElementById('exportBtn').click()`);
    await wait(1200);
    await shot('c4-export-sheet');
    result.sheet = await js(`document.getElementById('sheetBody').innerText`);
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 50 && downloaded === null; i++) await wait(100);
    result.download = downloaded;
    await wait(600);
    await shot('c5-after-export');
    result.afterExport = await js(`document.getElementById('pendingCount').textContent + ' ' + document.getElementById('pendingText').textContent + ' | pills: ' + [...document.querySelectorAll('.pill')].map(p => p.textContent).join(',')`);
    // Persistence: reload and check items survive
    await win.reload(); await wait(800);
    result.afterReload = await js(`document.querySelectorAll('.item').length`);
    // Import into a fresh PC store, then import again (no duplicates)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okimp-'));
    const s = new Store(dir); s.load();
    const parsed = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    const r1 = s.importCapture(parsed);
    const r2 = s.importCapture(parsed);
    result.import1 = { added: r1.added, photos: r1.photos, documents: r1.documents, errors: r1.errors };
    result.import2 = { added: r2.added, unchanged: r2.unchanged };
    result.imported = s.data.assets.map(a => ({ name: a.name, cat: a.category, loc: a.location, price: a.purchasePrice, serial: a.serial, warranty: a.warrantyExpiry, photos: a.photos.length, docs: a.documents.map(d => d.name + ':' + d.type), files: a.photos.concat(a.documents).every(x => fs.existsSync(s.attachmentPath(a.id, x.file))) }));
    result.fileSizeKB = Math.round(fs.statSync(exportPath).size / 1024);
  } catch (e) {
    result.fatal = e.stack;
  }
  result.errors = errors;
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  server.close();
  app.exit(0);
});
