'use strict';
// Batch D through the real window: deleted items bin, report by room, grab list, web page link.
// Run: xvfb-run -a npx electron --no-sandbox test/batchD-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bD';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbD-'));
process.env.OPENSAFE_DATA_DIR = dir;
let nextSave = null;
const boxes = [], opened = [];
dialog.showSaveDialog = async () => ({ canceled: false, filePath: nextSave });
dialog.showMessageBox = async (_w, o) => { boxes.push(o || _w); return { response: 0 }; };
shell.openPath = async () => '';
shell.openExternal = async (u) => { opened.push(u); };

const s = new Store(dir); s.load();
const drill = s.saveAsset({ name: 'Makita drill', category: 'Tools', location: 'Home / Garage', currentValue: 120 });
s.addPhoto(drill.id, 'p.jpg', fs.readFileSync('/tmp/okshots/photos/p2.jpg'));
s.saveAsset({ name: 'Passport', category: 'Documents', location: 'Home / Bedroom', grab: true });
s.saveAsset({ name: 'Laptop', category: 'Computers & Phones', location: 'Home / Office', currentValue: 900 });
s.saveAsset({ name: 'Sofa', category: 'Furniture', location: 'Home / Lounge', currentValue: 400 });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const open = async (name) => { await js(`document.querySelector('[data-nav=items]').click()`); await wait(400); await js(`[...document.querySelectorAll('[data-open]')].find(e => e.querySelector('.name').innerText.startsWith(${JSON.stringify(name)})).click()`); await wait(500); };
    const waitFile = async (f) => { for (let i = 0; i < 60 && !fs.existsSync(f); i++) await wait(200); await wait(500); return fs.existsSync(f); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // web link + grab list on the laptop via the edit form
      await open('Laptop');
      await js(`document.querySelector('[data-action=edit]').click()`); await wait(400);
      await js(`{ const f = document.querySelector('#modal form'); f.webLink.value = 'www.lenovo.com/gb/en/p/laptops/legion'; f.grab.checked = true; f.requestSubmit(); }`); await wait(900);
      R.linkShown = await js(`[...document.querySelectorAll('.kv > div')].map(d => d.innerText.replace(/\\n/g, ': ')).find(t => t.startsWith('Web page'))`);
      R.grabPill = await js(`document.querySelector('.detail-head').innerText.includes('Grab list')`);
      await js(`document.querySelector('[data-action=openLink]').click()`); await wait(400);
      R.opened = opened.slice();
      await shot('d1-item-link');
      // delete the drill -> bin -> restore -> delete again -> delete for good
      await open('Makita drill');
      await js(`document.querySelector('[data-action=del]').click()`); await wait(800);
      R.deleteDialog = boxes[boxes.length - 1] && boxes[boxes.length - 1].detail;
      R.binButton = await js(`(document.querySelector('[data-nav=bin]') || {}).innerText`);
      await js(`document.querySelector('[data-nav=bin]').click()`); await wait(400);
      R.binRows = await js(`[...document.querySelectorAll('table.list tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('d2-bin');
      await js(`document.querySelector('[data-action=binRestore]').click()`); await wait(800);
      R.afterRestore = await js(`document.getElementById('toast').innerText`);
      const st1 = new Store(dir); st1.load();
      R.restoredPhotos = st1.getAsset(drill.id) && st1.getAsset(drill.id).photos.length;
      await open('Makita drill');
      await js(`document.querySelector('[data-action=del]').click()`); await wait(800);
      await js(`document.querySelector('[data-nav=bin]').click()`); await wait(400);
      await js(`document.querySelector('[data-action=binPurge]').click()`); await wait(800);
      R.binAfterPurge = await js(`document.querySelector('.empty') ? document.querySelector('.empty').innerText : 'not empty'`);
      R.filesGone = !fs.existsSync(path.join(dir, 'attachments', drill.id));
      // reports: by room for Home, and the grab list
      await js(`document.querySelector('[data-nav=reports]').click()`); await wait(400);
      R.grabCard = await js(`[...document.querySelectorAll('.card')].find(c => c.innerText.includes('Grab list')).innerText.replace(/\\s+/g, ' ').slice(0, 160)`);
      nextSave = path.join(OUT, 'by-room.pdf');
      await js(`document.getElementById('rGroup').value = 'location'; document.getElementById('rPlace').value = 'Home'; document.querySelector('[data-action=report]').click()`);
      R.reportSaved = await waitFile(nextSave);
      nextSave = path.join(OUT, 'grab.pdf');
      await js(`document.querySelector('[data-action=grabPdf]').click()`);
      R.grabSaved = await waitFile(nextSave);
      await shot('d3-reports');
      // bulk: take the passport off the grab list
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('[data-open]')].find(r => r.querySelector('.name').innerText === 'Passport').querySelector('.selbox').click()`); await wait(300);
      await js(`document.querySelector('[data-action=bulkSel]').click()`); await wait(300);
      await js(`{ const f = document.getElementById('bulkForm'); f.grab.value = 'remove'; f.requestSubmit(); }`); await wait(800);
      const st2 = new Store(dir); st2.load();
      R.grabNow = st2.data.assets.filter(a => a.grab).map(a => a.name);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
