'use strict';
// PC side of batch 3: QR labels PDF and the encrypted inventory file for the phone,
// driven through the real window. Barcode lookup is checked separately (needs the internet).
// Run: xvfb-run -a npx electron --no-sandbox test/batch3-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { Store } = require('../src/store');
const pv = require('../src/phoneview');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/b3';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osb3-'));
process.env.OPENSAFE_DATA_DIR = dir;
let nextSave = null;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: nextSave });
dialog.showMessageBox = async () => ({ response: 0 });
shell.openPath = async () => '';
shell.showItemInFolder = () => {};

const s = new Store(dir); s.load();
const car = s.saveAsset({ name: 'Mercedes C220d estate', category: 'Vehicles', location: 'Driveway', currentValue: 14500, details: { kind: 'vehicle', reg: 'AB21 CDE' } });
s.addPhoto(car.id, 'p1.jpg', fs.readFileSync('/tmp/okshots/photos/p1.jpg'));
s.saveAsset({ name: 'Makita combi drill', category: 'Tools', location: 'Garage', serial: 'MK-0099', barcode: '0088381640111' });
s.saveAsset({ name: 'Garden bench', location: 'Garden' });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const R = {};
    try {
      win.setSize(1320, 860); await wait(1500);
      // inventory for the phone
      await js(`document.querySelector('[data-nav=phone]').click()`); await wait(400);
      nextSave = path.join(OUT, 'inv.opensafe-view');
      await js(`document.getElementById('pvPass').value = 'abc'; document.querySelector('[data-action=phoneView]').click()`); await wait(400);
      R.shortPassToast = await js(`document.getElementById('toast') ? document.getElementById('toast').innerText : ''`);
      R.shortPassNoFile = !fs.existsSync(nextSave);
      await js(`document.getElementById('pvPass').value = 'phone pass 1'; document.querySelector('[data-action=phoneView]').click()`);
      for (let i = 0; i < 40 && !fs.existsSync(nextSave); i++) await wait(150);
      await wait(400);
      await shot('b3-1-phone-card');
      const text = fs.readFileSync(nextSave, 'utf8');
      R.fileHasPlainNames = /Mercedes|Makita|AB21/.test(text);
      const view = pv.decryptView(text, 'phone pass 1');
      R.viewCount = view.count;
      R.viewNames = view.items.map(i => i.name).sort();
      R.carHasThumb = !!view.items.find(i => i.name.startsWith('Mercedes')).thumb;
      R.drillBarcode = view.items.find(i => i.name.startsWith('Makita')).barcode;
      R.passFieldCleared = await js(`document.getElementById('pvPass').value === ''`);
      // QR labels
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('.selbox')].slice(0, 2).forEach(b => b.click())`); await wait(400);
      await shot('b3-2-selection');
      R.selBar = await js(`document.querySelector('.selbar').innerText`);
      nextSave = path.join(OUT, 'labels.pdf');
      await js(`document.querySelector('[data-action=labelsSel]').click()`); await wait(400);
      await shot('b3-3-labels-form');
      await js(`document.getElementById('labForm').requestSubmit()`);
      for (let i = 0; i < 60 && !fs.existsSync(nextSave); i++) await wait(150);
      await wait(800);
      const pdf = fs.readFileSync(nextSave);
      R.labelsPdfBytes = pdf.length;
      R.labelsIsPdf = pdf.slice(0, 5).toString() === '%PDF-';
      R.toastAfterLabels = await js(`document.getElementById('toast') ? document.getElementById('toast').innerText : ''`);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
