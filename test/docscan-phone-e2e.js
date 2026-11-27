'use strict';
// Scan a document (phone) through to Documents on the PC.
// The stand-in camera shows a letter lying at an angle on a dark table, with a shadow across it.
// Run: xvfb-run -a npx electron --no-sandbox test/docscan-phone-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const { Store } = require('../src/store');
const { importPhoneDocuments } = require('../src/phonedocs');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/docscan';
fs.mkdirSync(OUT, { recursive: true });
const MOBILE = path.join(__dirname, '..', 'mobile');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(MOBILE, path.normalize(p));
  if (!f.startsWith(MOBILE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

// Draws a sheet of A4 (with the given lines of text) rotated on a dark wood-like table, shadow across one side.
const SCENE = `(() => {
  window.__drawScene = (g, W, H, lines, angle) => {
    const grd = g.createLinearGradient(0, 0, W, H); grd.addColorStop(0, '#4a3324'); grd.addColorStop(1, '#2c1d14');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { g.strokeStyle = 'rgba(0,0,0,.12)'; g.beginPath(); g.moveTo(0, i * H / 40 + 7); g.bezierCurveTo(W / 3, i * H / 40 - 9, W * 2 / 3, i * H / 40 + 11, W, i * H / 40); g.stroke(); }
    const pw = W * 0.62, ph = pw * 1.414;
    g.save(); g.translate(W / 2, H / 2); g.rotate(angle);
    g.fillStyle = '#f7f6f1'; g.fillRect(-pw / 2, -ph / 2, pw, ph);
    g.fillStyle = '#16161a'; g.font = Math.round(pw / 22) + 'px serif';
    lines.forEach((t, i) => g.fillText(t, -pw / 2 + pw * 0.1, -ph / 2 + ph * 0.12 + i * pw / 13));
    g.restore();
    const sh = g.createLinearGradient(0, 0, W, 0); sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(0.55, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = sh; g.fillRect(0, 0, W, H);
    return { pw, ph };
  };
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1920; const g = c.getContext('2d');
  window.__scene = { lines: ['Loading'], angle: 0.1 };
  setInterval(() => window.__drawScene(g, c.width, c.height, window.__scene.lines, window.__scene.angle), 60);
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => c.captureStream(15) });
})()`;
const PAGE1 = ['Veterans UK', 'Armed Forces Compensation Scheme', 'Your reference: AFCS/2026/88123', 'Dear Mr Smith', 'We have reviewed your claim and', 'awarded tariff level 8.', 'Please reply by 30 June 2027.'];
const PAGE2 = ['Page 2', 'How to ask for a reconsideration', 'Write to us within 90 days', 'quoting reference AFCS/2026/88123'];

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 140) + ' :: ' + e.message); });
  const shot = async (name) => { await wait(400); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const R = {};
  try {
    await win.loadURL(base); await wait(800);
    await js(SCENE);
    await js(`window.__scene = { lines: ${JSON.stringify(PAGE1)}, angle: 0.12 }`);
    R.button = await js(`document.querySelector('[data-act=docScan]').innerText.split('\\n')[0]`);
    await js(`document.querySelector('[data-act=docScan]').click()`); await wait(1500);
    R.hint = await js(`document.getElementById('docHint').innerText`);
    await shot('d1-camera');
    await js(`document.querySelector('[data-act=docShoot]').click()`); await wait(800);
    R.adjustMsg = await js(`document.getElementById('docAdjMsg').innerText`);
    // the page's real corners in the 1080x1920 picture, to compare with what was found
    R.cornerError = await js(`(() => {
      const W = 1080, H = 1920, pw = W * 0.62, ph = pw * 1.414, a = 0.12;
      const rot = (x, y) => ({ x: W / 2 + x * Math.cos(a) - y * Math.sin(a), y: H / 2 + x * Math.sin(a) + y * Math.cos(a) });
      const real = [rot(-pw / 2, -ph / 2), rot(pw / 2, -ph / 2), rot(pw / 2, ph / 2), rot(-pw / 2, ph / 2)];
      const hs = [0, 1, 2, 3].map(i => document.getElementById('docH' + i).getBoundingClientRect());
      const box = document.getElementById('docAdjBox'), bw = box.clientWidth, bh = box.clientHeight, s = Math.min(bw / W, bh / H), ox = (bw - W * s) / 2, oy = (bh - H * s) / 2, br = box.getBoundingClientRect();
      return Math.round(Math.max(...hs.map((h, i) => Math.hypot((h.left + h.width / 2 - br.left - ox) / s - real[i].x, (h.top + h.height / 2 - br.top - oy) / s - real[i].y))));
    })()`);
    await shot('d2-adjust');
    await js(`document.querySelector('[data-act=docUse]').click()`);
    for (let i = 0; i < 40 && await js(`document.getElementById('docScanner').classList.contains('hidden')`); i++) await wait(250);
    // second page, in colour, after dragging one corner a little
    await js(`window.__scene = { lines: ${JSON.stringify(PAGE2)}, angle: -0.08 }`); await wait(500);
    await js(`document.querySelector('[data-act=docShoot]').click()`); await wait(800);
    await js(`(() => { const h = document.getElementById('docH0'), r = h.getBoundingClientRect(); const ev = (t, x, y) => h.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, clientX: x, clientY: y })); ev('pointerdown', r.left + 17, r.top + 17); ev('pointermove', r.left + 20, r.top + 19); ev('pointerup', r.left + 20, r.top + 19); })()`);
    await js(`document.querySelector('[data-act=docMode][data-mode=colour]').click()`);
    R.colourOn = await js(`document.querySelector('[data-act=docMode][data-mode=colour]').classList.contains('on')`);
    await js(`document.querySelector('[data-act=docUse]').click()`);
    for (let i = 0; i < 40 && await js(`document.getElementById('docScanner').classList.contains('hidden')`); i++) await wait(250);
    R.doneLabel = await js(`document.getElementById('docDoneBtn').innerText`);
    await js(`document.querySelector('[data-act=docDone]').click()`); await wait(500);
    R.pages = await js(`Promise.all([...document.querySelectorAll('.docpage img')].map(i => i.decode().then(() => i.naturalWidth + 'x' + i.naturalHeight)))`);
    await shot('d3-details');
    // page 1 should now be upright, white paper and dark text: check the corners are white and some ink is present
    R.page1Look = await js(`(async () => { const im = document.querySelector('.docpage img'); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data;
      const at = (x, y) => d[(y * c.width + x) * 4]; let dark = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 100) dark++;
      return { cornersWhite: [at(5, 5), at(c.width - 6, 5), at(5, c.height - 6), at(c.width - 6, c.height - 6)].every(v => v > 200), shadowEvened: at(c.width - 6, c.height >> 1) > 200, inkPixels: dark, aspect: (c.height / c.width).toFixed(2) }; })()`);
    // choose a photo from the gallery as a third page
    await js(`(async () => { const c = document.createElement('canvas'); c.width = 1200; c.height = 1600; window.__drawScene(c.getContext('2d'), 1200, 1600, ['Page 3 from the gallery'], 0.03); const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)); const dt = new DataTransfer(); dt.items.add(new File([b], 'IMG_2041.jpg', { type: 'image/jpeg' })); const inp = document.getElementById('docPick'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); })()`); await wait(1500);
    R.pickedAdjust = await js(`!document.getElementById('docAdjust').classList.contains('hidden') && document.getElementById('docAdjMsg').innerText`);
    await js(`document.querySelector('[data-act=docUse]').click()`); await wait(1500);
    R.pagesAfterPick = await js(`document.querySelectorAll('.docpage').length`);
    // remove page 3 again, then fill in details and save
    await js(`document.querySelector('[data-act=docDelPage][data-i="2"]').click()`); await wait(300);
    R.pagesAfterRemove = await js(`document.querySelectorAll('.docpage').length`);
    await js(`(() => { const f = document.getElementById('docForm'); f.title.value = 'AFCS award letter'; f.docType.value = 'Benefits & pension'; f.from.value = 'Veterans UK'; f.ref.value = 'AFCS/2026/88123'; f.actBy.value = '2027-06-30'; f.dispatchEvent(new Event('input')); f.requestSubmit(); })()`); await wait(800);
    R.toast = await js(`document.getElementById('toast').innerText`);
    R.home = await js(`({ pending: document.getElementById('pendingCount').innerText + ' ' + document.getElementById('pendingText').innerText, docs: [...document.querySelectorAll('#docList .item')].map(e => e.innerText.replace(/\\s+/g, ' ')) })`);
    await shot('d4-home');
    // export
    let downloaded = null;
    session.defaultSession.on('will-download', (_e, item) => { const p = path.join(OUT, 'export.opensafe'); item.setSavePath(p); item.once('done', () => { downloaded = p; }); });
    await js(`document.getElementById('exportBtn').click()`); await wait(1500);
    R.exportSheet = await js(`document.getElementById('sheetBody').innerText.replace(/\\s+/g, ' ').slice(0, 300)`);
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 40 && !downloaded; i++) await wait(250);
    await wait(300);
    const obj = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
    R.exportFile = { version: obj.version, items: obj.items.length, documents: obj.documents.map(d => ({ title: d.title, pages: d.pages.length, kb: d.pages.map(p => Math.round(p.data.length * 0.75 / 1024)) })) };
    R.afterExport = await js(`document.getElementById('pendingText').innerText + ' | ' + document.querySelector('#docList .pill').innerText`);
    await js(`document.querySelector('#docList .item').click()`); await wait(500);
    R.exportedSheet = await js(`document.getElementById('sheetBody').innerText.replace(/\\s+/g, ' ').slice(0, 260)`);
    await js(`document.querySelector('[data-act=closeSheet]').click()`);
    // the PC
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osdocscan-'));
    const pc = new Store(dir); pc.load();
    const itemsRes = pc.importCapture(obj);
    const docRes = await importPhoneDocuments(pc, obj);
    const again = await importPhoneDocuments(pc, obj);
    const e = pc.libraryView('document')[0];
    const { buffer } = pc.readLibraryFile(e.id, e.files[0].id);
    const { PDFDocument } = require('pdf-lib');
    const pdf = await PDFDocument.load(buffer);
    fs.writeFileSync(path.join(OUT, 'scanned.pdf'), buffer);
    R.pc = { itemsAdded: itemsRes.added, docAdded: docRes.added, errors: docRes.errors, secondImportSkipped: again.skipped, title: e.title, type: e.docType, from: e.from, ref: e.ref, actBy: e.actBy, source: e.source, file: e.files[0].name, pdfPages: pdf.getPageCount(), pdfTitle: pdf.getTitle() };
    R.pc.searchTariff = pc.librarySearch('document', 'tariff').length;
    R.pc.searchReconsideration = pc.librarySearch('document', 'reconsideration').length;
    R.pc.text = pc.libraryText(e.id, e.files[0].id).slice(0, 400);
    R.pc.reminder = pc.reminders(new Date('2027-06-20'), 30).filter(x => x.libraryId).map(x => x.kind + ' ' + x.date);
    await require('../src/ocr').stop();
  } catch (e) { R.fatal = e.stack; }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close(); app.exit(0);
});
