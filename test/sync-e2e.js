'use strict';
// Two PCs in step, run as three separate OpenSafe sessions sharing one folder:
//   a1: laptop (password protected) chooses the shared folder; its copy goes there
//   b1: a new desktop chooses the same folder, takes the copy, locks, opens with the laptop's password, adds an item
//   a2: the laptop starts with an unsent change of its own: OpenSafe asks; "use the desktop's copy" keeps a backup
// Run: node test/sync-e2e.js <outDir>   (it starts Electron three times)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PHASE = process.env.SYNC_PHASE;
if (!PHASE) {
  // ---- driver ----
  const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/sync-e2e';
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ossynce2e-'));
  const env = { SYNC_ROOT: root, SYNC_OUT: OUT };
  const R = {};
  const { Store } = require('../src/store');
  (async () => {
  for (const ph of ['a1', 'b1', 'a2']) {
    const pcDir = path.join(root, ph[0] === 'a' ? 'laptop' : 'desktop'); fs.mkdirSync(pcDir, { recursive: true });
    if (!fs.existsSync(path.join(pcDir, 'sync.json'))) fs.writeFileSync(path.join(pcDir, 'sync.json'), JSON.stringify({ deviceId: require('crypto').randomUUID(), deviceName: ph[0] === 'a' ? 'MARK-LAPTOP' : 'MARK-DESKTOP' }));
    if (ph === 'a1') { const st = new Store(pcDir); st.load(); st.saveAsset({ name: 'Laptop drill', location: 'Garage' }); await st.enableEncryption('correct horse battery'); st.lock(); }
    if (ph === 'a2') { const f = path.join(pcDir, 'sync.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.dirty = true; fs.writeFileSync(f, JSON.stringify(c)); } // a laptop change that never reached the folder
    const r = spawnSync('npx', ['electron', '--no-sandbox', '--disable-gpu', __filename], { env: Object.assign({}, process.env, env, { SYNC_PHASE: ph }), timeout: 240000, encoding: 'utf8' });
    try { R[ph] = JSON.parse(fs.readFileSync(path.join(OUT, ph + '.json'), 'utf8')); } catch (_) { R[ph] = { fatal: 'no result: ' + (r.stderr || '').slice(-500) }; }
    if (R[ph].fatal) { R.fatal = ph + ': ' + R[ph].fatal; break; }
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
  process.exit(0);
  })();
  return;
}

// ---- one PC session (inside Electron) ----
const { app, dialog } = require('electron');
const { Store } = require('../src/store');
const ROOT = process.env.SYNC_ROOT, OUT = process.env.SYNC_OUT;
const SHARED = path.join(ROOT, 'OneDrive'); fs.mkdirSync(SHARED, { recursive: true });
const PC = PHASE[0] === 'a' ? 'laptop' : 'desktop';
const dir = path.join(ROOT, PC); fs.mkdirSync(dir, { recursive: true });
process.env.OPENSAFE_DATA_DIR = dir;
const PW = 'correct horse battery';
const answers = [];
dialog.showMessageBox = async (_w, o) => { answers.push(o.message); return { response: /already has an inventory|were changed on this PC/.test(o.message) ? 0 : 0 }; };
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SHARED] });

require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const unlock = async () => { await js(`document.querySelector('#unlockForm [name=pw]').value = ${JSON.stringify(PW)}; document.querySelector('#unlockForm button[type=submit]').click()`); await wait(2500); };
    const locked = () => js(`!document.getElementById('lockscreen').classList.contains('hidden')`);
    const items = () => js(`window.keep.getData().then(d => d.data.assets.map(a => a.name).sort())`);
    const card = () => js(`(document.getElementById('syncCard') || {}).innerText`);
    const R = { pc: PC };
    try {
      win.setSize(1320, 900); await wait(2500);
      if (PHASE === 'a1') {
        await unlock();
        await js(`document.querySelector('[data-nav=reports]') ? 0 : 0`);
        await js(`window.keep.getData()`);
        await js(`document.querySelector('nav [data-nav=data], [data-nav=data]').click()`); await wait(800);
        R.before = (await card() || '').replace(/\s+/g, ' ').slice(0, 120);
        await js(`document.querySelector('[data-action=syncChoose]').click()`); await wait(2500);
        R.after = (await card() || '').replace(/\s+/g, ' ');
        R.sharedHasCopy = fs.existsSync(path.join(SHARED, 'OpenSafe sync', 'state.json'));
        R.sharedEncrypted = fs.existsSync(path.join(SHARED, 'OpenSafe sync', 'data', 'opensafe-data.bin')) && !fs.readFileSync(path.join(SHARED, 'OpenSafe sync', 'data', 'opensafe-data.bin')).includes('Laptop drill');
        await js(`document.getElementById('syncCard').scrollIntoView()`); await shot('a1-in-step');
      }
      if (PHASE === 'b1') {
        R.startItems = await items();
        await js(`document.querySelector('nav [data-nav=data], [data-nav=data]').click()`); await wait(800);
        await js(`document.querySelector('[data-action=syncChoose]').click()`); await wait(3000);
        R.lockedAfterTaking = await locked(); // the laptop's copy is password protected
        await shot('b1-locked');
        await unlock();
        R.items = await items();
        await js(`window.keep.saveAsset({ name: 'Desktop ladder', location: 'Shed' })`); await wait(500);
        await js(`document.querySelector('nav [data-nav=data], [data-nav=data]').click()`); await wait(800);
        await js(`document.querySelector('[data-action=syncNow]').click()`); await wait(2500);
        R.card = (await card() || '').replace(/\s+/g, ' ');
        await shot('b1-in-step');
      }
      if (PHASE === 'a2') {
        await wait(2500); // the question about both copies
        R.asked = answers.slice();
        await unlock();
        R.items = await items();
        R.backups = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('OpenSafe-backup-'));
        await js(`document.querySelector('nav [data-nav=data], [data-nav=data]').click()`); await wait(800);
        R.card = (await card() || '').replace(/\s+/g, ' ');
        await js(`document.getElementById('syncCard').scrollIntoView()`); await shot('a2-after-choice');
      }
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, PHASE + '.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
