'use strict';
// Scan a room (phone): runs the real MediaPipe engine and EfficientDet-Lite0 model on real photos
// shown to a stand-in camera, saves the draft items, exports them and imports them on the PC.
// Also checks: a model file with the wrong SHA-256 is refused, and nothing reaches Google's
// metrics address (the CSP blocks it).
// Needs: the official model at $MODEL (default /tmp/mdl2/lite0_int8.tflite) and test photos in
// $PHOTOS (default /tmp/cocoimg: COCO val2017 000000000139, 000000000632, 000000000802, 000000001268).
// MediaPipe needs WebGL, so on a machine without a GPU use software WebGL:
// Run: xvfb-run -a npx electron --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist test/roomscan-phone-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/roomscan';
fs.mkdirSync(OUT, { recursive: true });
const MODEL = process.env.MODEL || '/tmp/mdl2/lite0_int8.tflite';
const PHOTOS = process.env.PHOTOS || '/tmp/cocoimg';
const MOBILE = path.join(__dirname, '..', 'mobile');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let badModel = true;
const seen = { model: 0, metrics: [] };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__model') {
    seen.model++;
    const buf = fs.readFileSync(MODEL);
    if (badModel) buf[1000] ^= 0xff; // one changed byte: the SHA-256 check must refuse it
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    return res.end(buf);
  }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(MOBILE, path.normalize(p));
  if (!f.startsWith(MOBILE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const img = (id) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(PHOTOS, id + '.jpg')).toString('base64');

// A camera that shows whichever photo window.__scene points at.
const STUBS = `(() => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 960; const g = c.getContext('2d'); g.fillStyle = '#334'; g.fillRect(0, 0, c.width, c.height);
  window.__img = new Image();
  window.__setScene = (src) => new Promise(r => { window.__img.onload = r; window.__img.src = src; });
  setInterval(() => { if (window.__img.complete && window.__img.naturalWidth) g.drawImage(window.__img, 0, 0, c.width, c.height); else { g.fillStyle = '#334'; g.fillRect(0, 0, c.width, c.height); } }, 50);
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => c.captureStream(15) });
  window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.blockedURI + ' ' + e.violatedDirective));
})()`;

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    if (d.url.startsWith('https://storage.googleapis.com/mediapipe-models/')) return cb({ redirectURL: base + '__model' });
    if (/googleapis\.com/.test(d.url)) { seen.metrics.push(d.url); return cb({ cancel: true }); }
    cb({});
  });
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const logs = [];
  win.webContents.on('console-message', (e) => logs.push(String(e.message || '')));
  const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 140) + ' :: ' + e.message); });
  const shot = async (name) => { await wait(400); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const R = {};
  try {
    await win.loadURL(base); await wait(800);
    await js(STUBS);
    R.button = await js(`document.querySelector('[data-act=roomScan]').innerText.replace(/\\n/g, ' | ')`);
    await shot('r0-home');
    await js(`document.querySelector('[data-act=roomScan]').click()`); await wait(300);
    await shot('r1-start');
    await js(`document.querySelector('#roomForm [name=place]').value = 'Home / Lounge'; document.getElementById('roomForm').requestSubmit()`);
    for (let i = 0; i < 100 && !/isn't the expected/.test(await js(`document.getElementById('roomMsg')?.innerText || ''`)); i++) await wait(200);
    R.badModelMsg = await js(`document.getElementById('roomMsg').innerText`);
    R.badModelStored = await js(`new Promise(r => { const q = indexedDB.open('opensafe-capture'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('detectorModel'); g.onsuccess = () => r(!!g.result); }; })`);
    // the right file this time
    badModel = false;
    const t0 = Date.now();
    await js(`document.getElementById('roomForm').requestSubmit()`);
    for (let i = 0; i < 300 && await js(`document.getElementById('roomScanner').classList.contains('hidden')`); i++) await wait(200);
    R.startSeconds = Math.round((Date.now() - t0) / 100) / 10;
    R.startMsg = await js(`document.getElementById('roomMsg')?.innerText || '(sheet closed) toast: ' + document.getElementById('toast').innerText`);
    R.modelStored = await js(`new Promise(r => { const q = indexedDB.open('opensafe-capture'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('detectorModel'); g.onsuccess = () => r(g.result && g.result.byteLength); }; })`);
    // "walk round": living room, kitchen, bedroom, then outdoors (people and a bird must be ignored)
    for (const [id, name] of [['000000000139', 'lounge'], ['000000000802', 'kitchen'], ['000000000632', 'bedroom'], ['000000001268', 'outdoor']]) {
      await js(`window.__setScene(${JSON.stringify(img(id))})`);
      await wait(3500);
      R['found_' + name] = await js(`document.getElementById('roomFound').innerText`);
      await shot('r2-' + name);
    }
    await js(`document.querySelector('[data-act=roomDone]').click()`); await wait(1200);
    R.results = await js(`[...document.querySelectorAll('.roomrow')].map(r => r.querySelector('[data-room-name]').value + ' / ' + r.querySelector('.m').innerText)`);
    R.cropsOk = await js(`Promise.all([...document.querySelectorAll('.roomrow img')].map(i => i.decode().then(() => i.naturalWidth + 'x' + i.naturalHeight).catch(() => 'bad')))`);
    await shot('r3-results');
    // rename the TV, untick the second chair
    await js(`document.querySelector('[data-room-name="0"]').value = 'Samsung TV'; document.querySelector('[data-room-i="2"]').click()`);
    R.saveLabel = await js(`document.querySelector('[data-act=roomSave]').innerText`);
    await js(`document.querySelector('[data-act=roomSave]').click()`); await wait(1200);
    R.toast = await js(`document.getElementById('toast').innerText`);
    R.homeList = await js(`[...document.querySelectorAll('#list .item .n')].map(e => e.innerText)`);
    await shot('r4-home-after');
    // export and import on the PC
    const exp = await js(`(async () => { const d = await new Promise(r => { const q = indexedDB.open('opensafe-capture'); q.onsuccess = () => r(q.result); }); const all = await new Promise(r => { const g = d.transaction('items').objectStore('items').getAll(); g.onsuccess = () => r(g.result); }); return all.map(i => ({ name: i.name, category: i.category, location: i.location, tags: i.tags, photos: i.photos.length, sizes: i.photos.map(p => p.blob.size) })); })()`);
    R.stored = exp;
    let downloaded = null;
    session.defaultSession.on('will-download', (_e, item) => { const p = path.join(OUT, 'export.opensafe'); item.setSavePath(p); item.once('done', () => { downloaded = p; }); });
    await js(`document.getElementById('exportBtn').click()`); await wait(1500);
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 40 && !downloaded; i++) await wait(250);
    const pcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osroom-'));
    const pc = new Store(pcDir); pc.load();
    await wait(300); const imp = pc.importCapture(JSON.parse(fs.readFileSync(downloaded, 'utf8')));
    R.pcImport = { added: imp.added, photos: imp.photos, errors: imp.errors, items: pc.data.assets.map(a => `${a.name} | ${a.category} | ${a.location} | ${(a.tags || []).join ? a.tags.join(',') : a.tags} | photos ${a.photos.length}`) };
    // the second start reuses the stored model: no new download
    const before = seen.model;
    await js(`document.querySelector('[data-act=roomScan]').click()`); await wait(300);
    await js(`document.getElementById('roomForm').requestSubmit()`);
    for (let i = 0; i < 100 && await js(`document.getElementById('roomScanner').classList.contains('hidden')`); i++) await wait(200);
    R.secondStartDownloads = seen.model - before;
    await js(`document.querySelector('[data-act=roomCancel]').click()`); await wait(300);
    R.cameraOffAfterCancel = await js(`document.getElementById('roomScanner').classList.contains('hidden')`);
    R.modelRequests = seen.model;
    R.metricsRequestsReachingNetwork = seen.metrics;
    R.metricsCallFromPage = await js(`fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST' }).then(() => 'SENT', e => 'blocked: ' + e.message)`);
    R.cspBlocked = await js(`window.__csp`);
    R.logs = logs.slice(0, 15);
  } catch (e) { R.fatal = e.stack; R.logs = logs.filter(l => !/webGL|WebGL|Source Location|gl_context|^===|third_party/.test(l)).slice(0, 15); }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close(); app.exit(0);
});
