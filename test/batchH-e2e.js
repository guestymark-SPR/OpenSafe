'use strict';
// Batch H through the real window: packing lists and the sale listing.
// Run: xvfb-run -a npx electron --no-sandbox test/batchH-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell, clipboard } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bH';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbH-'));
process.env.OPENSAFE_DATA_DIR = dir;
const PHOTOS = path.join(OUT, 'for-sale');
fs.rmSync(PHOTOS, { recursive: true, force: true }); fs.mkdirSync(PHOTOS, { recursive: true });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PHOTOS] });
dialog.showMessageBox = async () => ({ response: 0 });
shell.openPath = async () => '';

const s = new Store(dir); s.load();
const drill = s.saveAsset({ name: 'Cordless drill', brand: 'Makita', model: 'DHP485', condition: 'Good', purchaseDate: '2025-03-14', supplier: 'Screwfix', serial: 'SECRET-1', category: 'Tools' });
s.addPhoto(drill.id, 'a.jpg', fs.readFileSync('/tmp/okshots/photos/p1.jpg'));
s.addPhoto(drill.id, 'b.jpg', fs.readFileSync('/tmp/okshots/photos/p2.jpg'));
for (const [n, loc] of [['Tent', 'Home / Loft'], ['Sleeping bag', 'Home / Loft'], ['Stove', 'Garage'], ['Helmet', 'Hall']]) s.saveAsset({ name: n, location: loc, category: 'Camping & Outdoor' });
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
      win.setSize(1320, 900); await wait(1500);
      await js(`document.querySelector('[data-nav=trips]').click()`); await wait(400);
      R.emptyText = await js(`document.querySelector('.card.empty').innerText.slice(0, 60)`);
      await js(`document.querySelector('[data-action=tripNew]').click()`); await wait(300);
      await js(`{ const f = document.getElementById('tripForm'); f.name.value = 'Ardennes tour'; f.startDate.value = '2027-06-29'; f.endDate.value = '2027-07-04'; f.requestSubmit(); }`); await wait(700);
      await js(`document.querySelector('[data-action=tripPick]').click()`); await wait(400);
      await js(`for (const n of ['Tent', 'Sleeping bag', 'Stove', 'Helmet']) [...document.querySelectorAll('#tripPickForm .partrow')].find(r => r.querySelector('b').innerText === n).querySelector('input').click(); document.getElementById('tripPickForm').requestSubmit()`); await wait(800);
      await js(`{ const f = document.getElementById('extraForm'); f.text.value = 'Sun cream'; f.requestSubmit(); }`); await wait(700);
      await js(`[...document.querySelectorAll('.tick')].find(c => c.closest('tr').innerText.includes('Tent') && c.dataset.which === 'packed').click()`); await wait(600);
      await js(`[...document.querySelectorAll('.tick')].find(c => c.closest('tr').innerText.includes('Sun cream') && c.dataset.which === 'back').click()`); await wait(600);
      R.tripRows = await js(`[...document.querySelectorAll('table.list tbody tr')].map(r => r.querySelector('td').innerText + ' | ' + [...r.querySelectorAll('.tick')].map(c => c.checked ? 'Y' : 'n').join(''))`);
      R.tripSummary = await js(`document.querySelector('.card .muted').innerText.split('.')[0]`);
      await shot('h1-packing');
      // sale listing
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Cordless drill')).click()`); await wait(500);
      await js(`document.querySelector('[data-action=sell]').click()`); await wait(700);
      R.title = await js(`document.getElementById('lsTitle').value`);
      R.text = await js(`document.getElementById('lsText').value`);
      R.titleLen = await js(`document.getElementById('ttlLen').innerText`);
      await js(`document.querySelector('[data-action=lsCopyText]').click()`); await wait(400);
      R.clipboardHasText = String(await Promise.resolve(clipboard.readText())).startsWith('Makita Cordless drill DHP485');
      await js(`document.querySelector('[data-action=lsPhotos]').click()`); await wait(800);
      R.savedPhotos = fs.readdirSync(PHOTOS).sort();
      await shot('h2-sell');
      const st = new Store(dir); st.load();
      R.savedTrip = st.data.trips.map(t => ({ name: t.name, items: t.items.length, extras: t.extras.map(x => x.text), packed: [...t.items, ...t.extras].filter(r => r.packed).length }));
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
