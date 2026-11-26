'use strict';
// Batch C through the real window: rooms within locations, item sets, value history and yearly
// drop, and spreadsheet (CSV) import.
// Run: xvfb-run -a npx electron --no-sandbox test/batchC-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bC';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbC-'));
process.env.OPENSAFE_DATA_DIR = dir;
const CSV = path.join(OUT, 'my list.csv');
fs.writeFileSync(CSV, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Item,Make,Where,Price,Date bought,Comments\n"Tent, 4 man",Vango,Home / Loft,£349.00,02/07/2023,Used twice\nCool box,Coleman,Home / Loft,45,2023-07-02,\nMakita drill,Makita,Home / Garage / Shelf 2,129,14/03/2025,duplicate of an existing item\n')]));
const PACK = path.join(OUT, 'claim.pdf');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [CSV] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: PACK });
dialog.showMessageBox = async () => ({ response: 0 });
shell.openPath = async () => '';

const twoYearsAgo = new Date(Date.now() - 2 * 365.25 * 86400000).toISOString().slice(0, 10);
const s = new Store(dir); s.load();
const drill = s.saveAsset({ name: 'Makita drill', brand: 'Makita', category: 'Tools', location: 'Home / Garage / Shelf 2', purchasePrice: 129, purchaseDate: '2025-03-14' });
const bat = s.saveAsset({ name: 'Makita 5Ah battery', category: 'Tools', location: 'Home / Garage / Shelf 2', serial: 'BL1850B', purchasePrice: 60 });
const chg = s.saveAsset({ name: 'Makita charger', category: 'Tools', location: 'Home / Garage', purchasePrice: 40 });
s.saveAsset({ name: 'Mitre saw', category: 'Tools', location: 'Home / Garage', purchasePrice: 1000, purchaseDate: twoYearsAgo });
s.saveAsset({ name: 'Sofa', category: 'Furniture', location: 'Home / Lounge', currentValue: 400 });
s.saveAsset({ name: 'Ring', category: 'Jewellery & Watches', location: 'Home / Bedroom', currentValue: 1000 });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const open = async (name) => { await js(`document.querySelector('[data-nav=items]').click()`); await wait(400); await js(`{ const l = document.querySelector('[data-f=location]'); if (l.value) { l.value = ''; l.dispatchEvent(new Event('change', { bubbles: true })); } }`); await wait(400); await js(`[...document.querySelectorAll('[data-open]')].find(e => e.querySelector('.name') && e.querySelector('.name').innerText.startsWith(${JSON.stringify(name)})).click()`); await wait(500); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // 1. locations: dashboard card and filter
      await js(`document.querySelector('[data-nav=places]').click()`); await wait(500);
      R.dashLocations = await js(`[...document.querySelectorAll('[data-action=placeSel]')].map(e => e.dataset.place + ' ' + e.querySelector('.c').innerText)`);
      await shot('c1-places');
      await js(`document.querySelector('[data-action=placeSel][data-place="Home / Garage"]').click()`); await wait(400);
      await js(`document.querySelector('[data-action=filterLoc]').click()`); await wait(500);
      R.garageFilter = await js(`[...document.querySelectorAll('[data-open] .name')].map(e => e.innerText).sort()`);
      R.locOptions = await js(`[...document.querySelectorAll('[data-f=location] option')].map(o => o.textContent)`);
      // 2. depreciation: Tools 20% a year -> mitre saw estimated ~£640
      await js(`document.querySelector('[data-nav=settings]').click()`); await wait(400);
      await js(`document.querySelector('[data-dep="Tools"]').value = '150'; document.querySelector('[data-action=saveDep]').click()`); await wait(500);
      R.depBad = await js(`document.getElementById('toast').innerText`);
      await js(`document.querySelector('[data-dep="Tools"]').value = '20'; document.querySelector('[data-action=saveDep]').click()`); await wait(600);
      await open('Mitre saw');
      R.sawValue = await js(`[...document.querySelectorAll('.kv > div')].map(d => d.innerText.replace(/\\n/g, ': ')).find(t => t.startsWith('Value now'))`);
      // 3. value history: add a valuation to the ring
      await open('Ring');
      await js(`document.querySelector('[data-action=addValuation]').click()`); await wait(300);
      await js(`{ const f = document.getElementById('valForm'); f.value.value = '£1,350'; f.note.value = 'Jeweller valuation'; f.requestSubmit(); }`); await wait(800);
      R.ringHistory = await js(`[...document.querySelectorAll('.card table.list tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      R.ringHeadValue = await js(`document.querySelector('.detail-head').innerText.includes('£1,350.00')`);
      await shot('c2-ring-value-history');
      // 4. item set: drill with battery and charger
      await open('Makita drill');
      await js(`document.querySelector('[data-action=pickParts]').click()`); await wait(400);
      R.partCandidates = await js(`[...document.querySelectorAll('.partrow b')].map(b => b.innerText)`);
      await js(`for (const n of ['Makita 5Ah battery', 'Makita charger']) [...document.querySelectorAll('.partrow')].find(r => r.querySelector('b').innerText === n).querySelector('input').click(); document.getElementById('partsForm').requestSubmit()`); await wait(800);
      R.setCard = await js(`[...document.querySelectorAll('.card h2')].map(h => h.innerText.replace(/\\s+/g, ' ')).find(t => t.startsWith('Parts in this set'))`);
      await shot('c3-set');
      await js(`document.querySelector('[data-action=claimOne]').click()`); await wait(300);
      await js(`document.getElementById('claimForm').requestSubmit()`);
      for (let i = 0; i < 60 && !fs.existsSync(PACK); i++) await wait(200);
      await wait(800);
      const { PDFDocument } = require('pdf-lib');
      const doc = await PDFDocument.load(fs.readFileSync(PACK));
      R.claimPages = doc.getPageCount();
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      R.listBadges = await js(`[...document.querySelectorAll('[data-open]')].map(r => r.querySelector('.name').innerText.replace(/\\s+/g, ' ') + ' | ' + r.querySelector('.meta').innerText).filter(t => /Set of|Part of/.test(t))`);
      // 5. spreadsheet import
      await js(`document.querySelector('[data-nav=data]').click()`); await wait(400);
      await js(`document.querySelector('[data-action=csvPick]').click()`); await wait(800);
      R.csvMapping = await js(`[...document.querySelectorAll('#csvForm [data-col]')].map(s => s.closest('tr').querySelector('b').innerText + ' -> ' + (s.value || "don't import"))`);
      await shot('c4-csv-map');
      await js(`{ const sel = [...document.querySelectorAll('#csvForm [data-col]')].find(s => s.closest('tr').querySelector('b').innerText === 'Comments'); sel.value = 'notes'; } document.getElementById('csvForm').requestSubmit()`); await wait(1200);
      R.csvResult = await js(`document.querySelector('.dialog .db').innerText.replace(/\\s+/g, ' ')`);
      await shot('c5-csv-done');
      const st = new Store(dir); st.load();
      const tent = st.data.assets.find(a => a.name === 'Tent, 4 man');
      R.tent = tent && { brand: tent.brand, location: tent.location, price: tent.purchasePrice, date: tent.purchaseDate, notes: tent.notes, source: tent.source };
      R.total = st.data.assets.length;
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
