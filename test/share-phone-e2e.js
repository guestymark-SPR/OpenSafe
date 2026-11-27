'use strict';
// Share to OpenSafe on the phone: a PDF and an email shared from another app arrive through the
// service worker (a real form POST to ./share-target, as Android sends it), are kept, exported, and
// imported on the PC with the same bytes.
// Run: xvfb-run -a npx electron --no-sandbox test/share-phone-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, session } = require('electron');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/share-phone-e2e';
fs.mkdirSync(OUT, { recursive: true });
const MOBILE = path.join(__dirname, '..', 'mobile');
const F = path.join(__dirname, 'fixtures', 'library');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST') { res.writeHead(500); return res.end('the service worker should have answered this'); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(MOBILE, path.normalize(p));
  if (!f.startsWith(MOBILE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const R = {};
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const ses = session.fromPartition('share-test');
  const dl = path.join(OUT, 'export.opensafe');
  try { fs.unlinkSync(dl); } catch (_) {}
  ses.on('will-download', (_e, item) => item.setSavePath(dl));
  const w = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { session: ses, sandbox: true } });
  const js = (c) => w.webContents.executeJavaScript(c);
  const shot = async (n) => { await wait(500); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  try {
    await w.loadURL(base); await wait(500);
    // the app registers its worker only on https; here (http://127.0.0.1) the test registers it
    await js(`navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => true)`);
    await w.loadURL(base); await wait(800);
    R.controlled = await js(`!!navigator.serviceWorker.controller`);
    R.manifestShare = JSON.parse(fs.readFileSync(path.join(MOBILE, 'manifest.webmanifest'), 'utf8')).share_target.action;
    // "share" two files: Android sends a multipart POST to the share target; the same request is sent here
    // with fetch (Electron's form submit drops in-memory files, which Android's share doesn't use)
    const pdf = fs.readFileSync(path.join(F, 'statement.pdf')).toString('base64'), eml = fs.readFileSync(path.join(F, 'mail.eml')).toString('base64');
    const go = await js(`(async () => {
      const b = (s, n, t) => new File([Uint8Array.from(atob(s), c => c.charCodeAt(0))], n, { type: t });
      const fd = new FormData(); fd.append('title', ''); fd.append('files', b(${JSON.stringify(pdf)}, 'Council tax bill.pdf', 'application/pdf')); fd.append('files', b(${JSON.stringify(eml)}, 'Booking.eml', 'message/rfc822'));
      const r = await fetch('share-target', { method: 'POST', body: fd });
      return r.url;
    })()`);
    R.redirectTo = go.replace(base, '');
    await w.loadURL(go);
    await wait(3000);
    R.urlAfter = w.webContents.getURL().replace(base, '');
    R.sheet = await js(`document.getElementById('sheetBody') ? document.getElementById('sheetBody').innerText.replace(/\\s+/g, ' ').slice(0, 300) : ''`);
    await shot('s1-shared');
    await js(`document.getElementById('shTitle').value = 'Council tax and booking'; document.querySelector('[data-act=sharedSave]').click()`); await wait(1200);
    R.list = await js(`[...document.querySelectorAll('#docList .item')].map(x => x.innerText.replace(/\\s+/g, ' '))`);
    R.waitingAfter = await js(`caches.open('opensafe-shared').then(c => c.keys()).then(k => k.length)`);
    await shot('s2-saved');
    // export and import on the PC
    await js(`document.getElementById('exportBtn').click()`); await wait(1200);
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 40 && !fs.existsSync(dl); i++) await wait(250);
    await wait(500);
    const obj = JSON.parse(fs.readFileSync(dl, 'utf8'));
    R.exportVersion = obj.version;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osshare-'));
    const { Store } = require('../src/store'); const s = new Store(dir); s.load();
    s.importCapture(obj);
    const r = await require('../src/phonedocs').importPhoneDocuments(s, obj);
    R.imported = r;
    const e = s.libraryView('document')[0];
    R.pcEntry = { title: e.title, files: e.files.map(f => f.name), source: e.source };
    R.sameBytes = s.readLibraryFile(e.id, e.files[0].id).buffer.equals(fs.readFileSync(path.join(F, 'statement.pdf'))) && s.readLibraryFile(e.id, e.files[1].id).buffer.equals(fs.readFileSync(path.join(F, 'mail.eml')));
    R.again = await require('../src/phonedocs').importPhoneDocuments(s, obj);
  } catch (e) { R.fatal = e.stack; }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close();
  app.exit(0);
});
