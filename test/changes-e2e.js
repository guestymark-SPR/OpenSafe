'use strict';
// Phone app: open an item from its QR label link, record changes (lend, move, needs repair),
// undo one, export, then import the file into a PC store and check the result.
// Run: xvfb-run -a npx electron --no-sandbox test/changes-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const pv = require('../src/phoneview');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/chg';
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

// A PC store with two items, and the inventory file made from it
const pcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oschg-'));
const pc = new Store(pcDir); pc.load();
const drill = pc.saveAsset({ name: 'Makita drill', category: 'Tools', location: 'Garage' });
const ladder = pc.saveAsset({ name: 'Ladder', category: 'Tools', location: 'Garage' });
const fileText = pv.encryptView(pv.buildView(pc, {}), 'phone pass 1');

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let downloaded = null;
  session.defaultSession.on('will-download', (_e, item) => { const p = path.join(OUT, 'changes.opensafe'); item.setSavePath(p); item.once('done', () => { downloaded = p; }); });
  const win = new BrowserWindow({ width: 412, height: 915, show: true, webPreferences: { sandbox: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const openLink = async (id) => { await win.loadURL('about:blank'); await win.loadURL(base + '#item=' + id); await wait(900); };
  const sheetText = () => js(`document.getElementById('sheetBody').innerText`);
  const R = {};
  try {
    await win.loadURL(base); await wait(700);
    await shot('c0-home');
    R.scanButton = await js(`document.querySelector('[data-act=scanItem]').innerText`);
    // load + unlock the inventory
    await js(`document.querySelector('#tabs [data-tab=inv]').click()`); await wait(300);
    await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(fileText)}], 'inv.opensafe-view')); const i = document.getElementById('invFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
    await wait(500);
    await js(`document.getElementById('invUnlock').pass.value = 'phone pass 1'; document.getElementById('invUnlock').requestSubmit()`); await wait(2000);
    // open the drill from the inventory, then its actions
    await js(`[...document.querySelectorAll('[data-inv]')].find(e => e.innerText.includes('Makita')).click()`); await wait(300);
    await js(`document.querySelector('[data-act=itemActions]').click()`); await wait(300);
    await shot('c1-actions');
    R.actionsTitle = (await sheetText()).split('\n')[0];
    R.actionCount = await js(`document.querySelectorAll('.action').length`);
    // lend: name missing is refused
    await js(`document.querySelector('[data-kind=lend]').click()`); await wait(300);
    await js(`document.getElementById('actForm').requestSubmit()`); await wait(200);
    R.lendNoName = await js(`document.getElementById('actErr').innerText`);
    await js(`{ const f = document.getElementById('actForm'); f.lentTo.value = 'Dave'; f.lentContact.value = '07700 900123'; f.dueBack.value = '2026-12-05'; f.note.value = 'With the spare battery'; }`);
    await shot('c2-lend-form');
    await js(`document.getElementById('actForm').requestSubmit()`); await wait(600);
    // the ladder, from its label link: move it, then say it needs repairing (empty reason refused)
    await openLink(ladder.id);
    R.ladderLockedTitle = (await sheetText()).split('\n')[0];      // inventory locked again after reload: asks for the passphrase
    await shot('c1b-quick-unlock');
    await js(`document.querySelector('[data-act=skipUnlock]').click()`); await wait(400);
    R.ladderSkippedTitle = (await sheetText()).split('\n')[0];
    await js(`document.querySelector('[data-kind=move]').click()`); await wait(300);
    await js(`{ const f = document.getElementById('actForm'); f.location.value = 'Shed'; f.requestSubmit(); }`); await wait(600);
    await openLink(ladder.id);
    await js(`document.querySelector('#quickUnlock').pass.value = 'phone pass 1'; document.querySelector('#quickUnlock').requestSubmit()`); await wait(1800);
    R.ladderUnlockedTitle = (await sheetText()).split('\n')[0];
    R.ladderWaiting = await js(`[...document.querySelectorAll('.waiting')].map(e => e.innerText)`);
    await js(`document.querySelector('[data-kind=needsRepair]').click()`); await wait(300);
    await js(`document.getElementById('actForm').requestSubmit()`); await wait(200);
    R.repairNoReason = await js(`document.getElementById('actErr').innerText`);
    await js(`{ const f = document.getElementById('actForm'); f.note.value = 'Bent rung'; f.requestSubmit(); }`); await wait(600);
    // a note on the drill, then undo it
    await openLink(drill.id);
    await js(`document.querySelector('#quickUnlock').pass.value = 'phone pass 1'; document.querySelector('#quickUnlock').requestSubmit()`); await wait(1800);
    await js(`document.querySelector('[data-kind=note]').click()`); await wait(300);
    await js(`{ const f = document.getElementById('actForm'); f.note.value = 'Delete me'; f.requestSubmit(); }`); await wait(600);
    await shot('c3-home-changes');
    R.homeCount = await js(`document.getElementById('pendingCount').innerText`);
    R.changeRows = await js(`[...document.querySelectorAll('#changeList .change .t')].map(e => e.innerText.split('\\n').slice(0, 2).join(' | '))`);
    await js(`window.confirm = () => true; [...document.querySelectorAll('#changeList .change')].find(e => e.innerText.includes('Delete me')).click()`); await wait(500);
    R.afterUndo = await js(`document.getElementById('pendingCount').innerText`);
    // export
    await js(`document.getElementById('exportBtn').click()`); await wait(800);
    R.exportTitle = (await sheetText()).split('\n')[0];
    await js(`document.querySelector('[data-act=download]').click()`);
    for (let i = 0; i < 40 && !downloaded; i++) await wait(100);
    await wait(400);
    R.afterExport = await js(`document.getElementById('pendingCount').innerText + ' | ' + document.getElementById('pendingText').innerText`);
    const exp = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
    R.exportVersion = exp.version;
    R.exportSummaries = exp.updates.map(u => u.summary);
    // import on the PC
    const r = pc.importCapture(exp);
    R.pcImported = { changes: r.changes, skipped: r.skippedChanges };
    const d = pc.getAsset(drill.id), l = pc.getAsset(ladder.id);
    R.pcDrill = { status: d.status, lentTo: d.lentTo, lentContact: d.lentContact, dueBack: d.dueBack, notes: d.notes };
    R.pcLadder = { status: l.status, location: l.location, notes: l.notes };
    R.pcReimport = pc.importCapture(exp).changes;
  } catch (e) { R.fatal = e.stack; }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  server.close(); app.exit(0);
});
