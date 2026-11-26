'use strict';
// Batch G through the real window: reminders while closed (setting, schedule file, close keeps the
// app running and locked), premium history, read label (real OCR), date bought from photo date.
// Run: xvfb-run -a npx electron --no-sandbox test/batchG-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, BrowserWindow } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bG';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbG-'));
process.env.OPENSAFE_DATA_DIR = dir;
dialog.showMessageBox = async () => ({ response: 0 });
const FIX = path.join(__dirname, 'fixtures');
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// Set up the encrypted data first, in a separate Node process (OpenSafe must start straight away).
require('child_process').execFileSync('node', ['-e', `
  const fs = require('fs'), path = require('path'); const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'store'))});
  const FIX = ${JSON.stringify(FIX)}; const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  (async () => {
    const s = new Store(${JSON.stringify(dir)}); s.load();
    const drill = s.saveAsset({ name: 'Makita drill', category: 'Tools' });
    s.addPhoto(drill.id, 'label.png', fs.readFileSync(path.join(FIX, 'label.png')));
    const tent = s.saveAsset({ name: 'Tent', category: 'Camping & Outdoor' });
    s.addPhoto(tent.id, 'tent.jpg', fs.readFileSync(path.join(FIX, 'exif-2023-07-15.jpg')));
    s.saveAsset({ name: 'Mercedes C220d estate', category: 'Vehicles', details: { kind: 'vehicle', motDue: inDays(3) } });
    s.savePolicy({ insurer: 'Aviva', type: 'Home contents', renewalDate: '2026-12-01', premium: 240 });
    await s.enableEncryption('a good long password');
  })();`]);
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const prefs = () => JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'));
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1200);
      await js(`{ const f = document.querySelector('#lockForm, form'); f.querySelector('input[type=password]').value = 'a good long password'; f.requestSubmit(); }`); await wait(2500);
      // premium history
      await js(`document.querySelector('[data-nav=policies]').click()`); await wait(400);
      await js(`document.querySelector('[data-action=polRenew]').click()`); await wait(300);
      R.renewDefaultDate = await js(`document.getElementById('renewForm').renewalDate.value`);
      await js(`{ const f = document.getElementById('renewForm'); f.premium.value = '281.50'; f.insurer.value = 'Direct Line'; f.note.value = 'Aviva wanted £320'; f.requestSubmit(); }`); await wait(800);
      R.premiumRows = await js(`[...document.querySelectorAll('.card table.list tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('g1-premium-history');
      // read label (real offline OCR)
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Makita')).click()`); await wait(400);
      await js(`[...document.querySelectorAll('[data-tab]')].find(t => /Photos/.test(t.innerText)).click()`); await wait(400);
      await js(`document.querySelector('[data-action=ocrLabel]').click()`);
      for (let i = 0; i < 80; i++) { await wait(500); if (await js(`!!document.getElementById('lblForm')`)) break; }
      R.labelDialog = await js(`document.getElementById('lblForm').innerText.split('\\n').filter(l => /Serial|Model/.test(l)).join(' | ')`);
      await shot('g2-read-label');
      await js(`document.getElementById('lblForm').requestSubmit()`); await wait(800);
      // date bought suggested from the photo date
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Tent')).click()`); await wait(500);
      R.dateHint = await js(`(document.querySelector('[data-action=useDateHint]') || {}).innerText || null`);
      await shot('g3-date-hint');
      await js(`document.querySelector('[data-action=useDateHint]').click()`); await wait(700);
      // reminders while closed
      await js(`document.querySelector('[data-nav=settings]').click()`); await wait(800);
      R.bgCard = await js(`document.getElementById('bgCard').innerText.replace(/\\s+/g, ' ').slice(0, 200)`);
      await js(`{ const c = document.getElementById('bgOn'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }`); await wait(2500);
      await shot('g4-settings');
      const p = prefs();
      R.prefs = { background: p.background, named: p.schedule && p.schedule.named, entries: p.schedule && p.schedule.entries.length, sample: p.schedule && p.schedule.entries[0] };
      R.prefsHasNames = /Mercedes|Makita|Aviva|MOT/.test(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'));
      // close the window: the app should keep running, locked
      win.close(); await wait(2500);
      R.windowsAfterClose = BrowserWindow.getAllWindows().length;
      R.stillRunning = true;
      const st = new Store(dir);
      R.dataStillEncrypted = st.isEncrypted() && st.isLocked();
      const s2 = new Store(dir); await s2.unlock('a good long password');
      const d = s2.data.assets.find(a => a.name === 'Makita drill'), t = s2.data.assets.find(a => a.name === 'Tent');
      R.saved = { drillSerial: d.serial, drillModel: d.model, tentDate: t.purchaseDate, policyHistory: s2.data.policies[0].history.length };
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
