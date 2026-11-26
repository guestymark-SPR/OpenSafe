'use strict';
// Batch A: wider search, change several items at once, QR label from an item's page.
// Run: xvfb-run -a npx electron --no-sandbox test/batchA-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bA';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbA-'));
process.env.OPENSAFE_DATA_DIR = dir;
const LABEL = path.join(OUT, 'one-label.pdf');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: LABEL });
dialog.showMessageBox = async () => ({ response: 0 });
shell.openPath = async () => '';

const s = new Store(dir); s.load();
s.saveAsset({ name: 'Mercedes C220d estate', category: 'Vehicles', location: 'Driveway', details: { kind: 'vehicle', reg: 'AB21 CDE', vin: 'WDD2052041F000001' } });
s.saveAsset({ name: 'Makita drill', category: 'Tools', location: 'Garage', barcode: '0088381640111', status: 'Lent out', lentTo: 'Dave Smith', lentContact: '07700 900123' });
s.saveAsset({ name: 'Ladder', category: 'Tools', location: 'Garage' });
s.saveAsset({ name: 'Garden bench', category: 'Furniture', location: 'Garden' });
s.savePolicy({ insurer: 'Aviva', type: 'Home contents', policyNumber: 'HC123', renewalDate: '2027-03-01' });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const rows = () => js(`[...document.querySelectorAll('[data-open] .name')].map(e => e.innerText)`);
    const search = async (q) => { await js(`{ const i = document.getElementById('q'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); }`); await wait(500); return rows(); };
    const R = {};
    try {
      win.setSize(1320, 860); await wait(1500);
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      R.searchReg = await search('ab21');
      R.searchVin = await search('wdd2052041');
      R.searchBarcode = await search('0088381640111');
      R.searchBorrower = await search('dave');
      R.searchPhone = await search('07700');
      await search('');
      // select Ladder and Garden bench (re-query after each click: the list re-renders)
      for (const n of ['Ladder', 'Garden bench']) { await js(`[...document.querySelectorAll('[data-open]')].find(r => r.querySelector('.name').innerText === ${JSON.stringify(n)}).querySelector('.selbox').click()`); await wait(300); }
      R.selBar = await js(`document.querySelector('.selbar').innerText.replace(/\\n/g, ' | ')`);
      await js(`document.querySelector('[data-action=bulkSel]').click()`); await wait(400);
      await js(`document.getElementById('bulkForm').requestSubmit()`); await wait(300);
      R.emptyErr = await js(`document.getElementById('bkErr').innerText`);
      await js(`{ const f = document.getElementById('bulkForm'); f.location.value = 'Shed'; f.status.value = 'Lent out'; f.status.dispatchEvent(new Event('change')); }`); await wait(200);
      await js(`document.getElementById('bulkForm').requestSubmit()`); await wait(500);
      R.lentErr = await js(`document.getElementById('bkErr').innerText`);
      await js(`{ const f = document.getElementById('bulkForm'); f.lentTo.value = 'Sam'; f.dueBack.value = '2026-12-24'; f.policyId.selectedIndex = 2; }`);
      await shot('a1-bulk-form');
      await js(`document.getElementById('bulkForm').requestSubmit()`); await wait(900);
      R.toast = await js(`document.getElementById('toast').innerText`);
      R.selBarGone = await js(`!document.querySelector('.selbar')`);
      const st = new Store(dir); st.load();
      R.saved = st.data.assets.map(a => `${a.name}: ${a.location} / ${a.status}${a.lentTo ? ' / ' + a.lentTo : ''}${a.policyId ? ' / policy' : ''}`);
      // item page label button
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Ladder')).click()`); await wait(400);
      R.itemButtons = await js(`[...document.querySelectorAll('.btn')].map(b => b.innerText).filter(t => /label|Claim/i.test(t))`);
      await js(`document.querySelector('[data-action=labelOne]').click()`); await wait(300);
      R.labelForm = await js(`document.getElementById('labForm').innerText.split('\\n').slice(0, 2).join(' | ')`);
      await js(`document.getElementById('labForm').requestSubmit()`);
      for (let i = 0; i < 60 && !fs.existsSync(LABEL); i++) await wait(150);
      await wait(600);
      R.labelPdf = fs.existsSync(LABEL) && fs.readFileSync(LABEL).slice(0, 5).toString();
      await shot('a2-item');
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
