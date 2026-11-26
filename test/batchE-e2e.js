'use strict';
// Batch E on the PC, through the real window: bought abroad (exchange rate service replaced by a
// stand-in with the real reply format), photos and videos of a place, place labels, item video.
// Run: xvfb-run -a npx electron --no-sandbox test/batchE-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { app, dialog, shell } = electron;
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bE';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbE-'));
process.env.OPENSAFE_DATA_DIR = dir;
const VID = path.join(OUT, 'Lounge walk-through.mp4');
fs.writeFileSync(VID, Buffer.from('not really a video, but bytes to store'));
let nextOpen = [VID], nextSave = null;
const fetched = [], openedPaths = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: nextOpen });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: nextSave });
dialog.showMessageBox = async () => ({ response: 0 });
shell.openPath = async (p) => { openedPaths.push(p); return ''; };
electron.net.fetch = async (url) => {
  fetched.push(url);
  if (url.includes('frankfurter')) return { ok: true, status: 200, json: async () => ({ amount: 1.0, base: 'EUR', date: '2025-03-14', rates: { GBP: 0.84183 } }) };
  throw new Error('offline');
};

const s = new Store(dir); s.load();
s.saveAsset({ name: 'Tent', category: 'Camping & Outdoor', location: 'Home / Loft', purchaseDate: '2025-03-15' });
s.saveAsset({ name: 'Sofa', category: 'Furniture', location: 'Home / Lounge', currentValue: 400 });
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
      // bought abroad
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Tent')).click()`); await wait(400);
      await js(`document.querySelector('[data-action=edit]').click()`); await wait(400);
      await js(`{ const f = document.querySelector('#modal form'); f.foreignCurrency.value = 'EUR'; f.foreignCurrency.dispatchEvent(new Event('change')); f.foreignPrice.value = '300'; document.getElementById('fxBtn').click(); }`); await wait(800);
      R.fxUrl = fetched[0];
      R.fxFilled = await js(`document.querySelector('#modal form').purchasePrice.value`);
      R.fxInfo = await js(`document.getElementById('fxInfo').innerText`);
      await shot('e1-fx-form');
      await js(`document.querySelector('#modal form').requestSubmit()`); await wait(800);
      R.pricePaid = await js(`[...document.querySelectorAll('.kv > div')].map(d => d.innerText.replace(/\\n/g, ': ')).find(t => t.startsWith('Price paid'))`);
      // photos and videos of a place
      await js(`document.querySelector('[data-nav=places]').click()`); await wait(400);
      await js(`document.querySelector('[data-action=placeSel][data-place="Home / Lounge"]').click()`); await wait(500);
      R.placeCardEmpty = await js(`[...document.querySelectorAll('.card h2')].map(h => h.innerText).find(t => t.includes('Photos and videos')) + ' | ' + document.querySelector('.places h1, .places h2, .card h1')?.innerText`);
      await js(`document.querySelector('[data-action=placeAdd]').click()`); await wait(800);
      R.placeRows = await js(`[...document.querySelectorAll('[data-action=placeOpen]')].map(b => b.closest('.rowi').innerText.replace(/\\s+/g, ' ').trim())`);
      await js(`document.querySelector('[data-action=placeOpen]').click()`); await wait(500);
      R.openedVideo = openedPaths.slice(-1)[0] && fs.readFileSync(openedPaths.slice(-1)[0], 'utf8');
      await shot('e2-place-videos');
      await js(`document.querySelector('[data-nav=places]').click()`); await wait(400);
      R.dashMarker = await js(`!!document.querySelector('[data-action=placeSel][data-place="Home / Lounge"] svg') && !document.querySelector('[data-action=placeSel][data-place="Home / Bedroom"] svg')`);
      // place labels
      await js(`document.querySelector('[data-nav=reports]').click()`); await wait(400);
      await js(`document.querySelector('[data-action=placeLabelsMany]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('.plab')].find(i => i.value === 'Home / Loft').click(); document.getElementById('plCopies').value = '2'; document.querySelector('[data-action=placeLabels]').click()`);
      nextSave = path.join(OUT, 'place-labels.pdf');
      await js(`document.querySelector('[data-action=placeLabels]').click()`);
      for (let i = 0; i < 60 && !fs.existsSync(nextSave); i++) await wait(200);
      await wait(600);
      R.placeLabelsPdf = fs.existsSync(nextSave) && fs.readFileSync(nextSave).slice(0, 5).toString();
      await shot('e3-reports');
      const st = new Store(dir); st.load();
      const tent = st.data.assets.find(a => a.name === 'Tent');
      R.tentSaved = { price: tent.purchasePrice, cur: tent.foreignCurrency, foreign: tent.foreignPrice, rate: tent.fxRate, date: tent.fxDate };
      R.placesSaved = Object.keys(st.data.places);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
