'use strict';
// Batch F through the real window: borrowed items, owner, spending by year, duplicates and merge,
// delete several, recall check (GOV.UK search replaced by a stand-in with the real reply format).
// Run: xvfb-run -a npx electron --no-sandbox test/batchF-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { app, dialog, shell } = electron;
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bF';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbF-'));
process.env.OPENSAFE_DATA_DIR = dir;
const fetched = [], opened = [];
dialog.showMessageBox = async () => ({ response: 0 });
shell.openExternal = async (u) => { opened.push(u); };
electron.net.fetch = async (url) => {
  fetched.push(url);
  const recall = { title: 'Product Recall: LG ESS Battery Division - RESU ESS Home Batteries (2103-0025)', link: '/product-safety-alerts-reports-recalls/product-recall-resu-ess-home-batteries-lg-ess-battery-division-2103-0025', public_timestamp: '2022-03-25T22:11:24Z', description: 'Product recall for ESS Home Batteries presenting a risk of fire.', product_alert_type: 'product-recall', product_risk_level: 'low' };
  const other = { title: 'Product Recall: Ridgeback Comet, Speed and Motion Bicycles (2609-0070)', link: '/product-safety-alerts-reports-recalls/product-recall-ridgeback-comet-speed-and-motion-bicycles-2609-0070', public_timestamp: '2026-10-01T12:57:08Z' };
  return { ok: true, status: 200, json: async () => ({ results: url.includes('RESU') ? [recall, other] : [other], total: 2 }) };
};

const s = new Store(dir); s.load();
s.saveAsset({ name: 'Home battery', brand: 'LG', model: 'RESU', category: 'Electrical', purchasePrice: 4000, purchaseDate: '2021-06-01' });
s.saveAsset({ name: 'Makita drill', brand: 'Makita', model: 'DHP485', serial: 'MK-1234', purchasePrice: 129, purchaseDate: '2025-03-14', category: 'Tools' });
s.saveAsset({ name: 'Drill', serial: 'mk 1234', category: 'Tools', notes: 'From the old spreadsheet' });
s.saveAsset({ name: 'TV', purchasePrice: 600, purchaseDate: '2024-11-29', category: 'Electronics' });
s.saveAsset({ name: 'Old chair', category: 'Furniture' });
s.saveAsset({ name: 'Broken lamp', category: 'Furniture' });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const items = () => js(`[...document.querySelectorAll('[data-open] .name')].map(e => e.innerText)`);
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // borrowed item + owner through the add form
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`document.querySelector('[data-action=new]').click()`); await wait(400);
      await js(`{ const f = document.getElementById('itemForm'); f.name.value = "Dave's trailer"; f.status.value = 'Borrowed'; f.status.dispatchEvent(new Event('change')); f.borrowedFrom.value = 'Dave'; f.borrowedContact.value = '07700 900456'; f.returnBy.value = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10); f.currentValue.value = '800'; }`);
      R.borrowBoxShown = await js(`!document.getElementById('borrowBox').classList.contains('hidden')`);
      await js(`document.getElementById('itemForm').requestSubmit()`); await wait(900);
      R.trailerPage = await js(`[...document.querySelectorAll('.kv > div')].map(d => d.innerText.replace(/\\n/g, ': ')).filter(t => /Belongs|contact|Give back|Status/.test(t))`);
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('TV')).click()`); await wait(300);
      await js(`document.querySelector('[data-action=edit]').click()`); await wait(300);
      await js(`{ const f = document.getElementById('itemForm'); f.owner.value = 'Mark'; f.requestSubmit(); }`); await wait(800);
      // dashboard: borrowed not counted, owner card, recalls
      await js(`document.querySelector('[data-nav=dashboard]').click()`); await wait(400);
      R.itemsFoot = await js(`[...document.querySelectorAll('.stat')].find(c => c.innerText.startsWith('Items')).innerText.replace(/\\n/g, ' | ')`);
      R.ownerCard = await js(`[...document.querySelectorAll('.card h2')].some(h => h.innerText === 'Who owns what')`);
      await js(`document.querySelector('[data-action=checkRecalls]').click()`); await wait(2500);
      R.recallQueries = fetched.map(u => decodeURIComponent(u.split('q=')[1].split('&')[0]));
      R.recallCard = await js(`[...document.querySelectorAll('.card')].find(c => c.innerText.startsWith('Product recalls')).innerText.replace(/\\s+/g, ' ').slice(0, 300)`);
      await shot('f1-dashboard');
      await js(`document.querySelector('[data-action=openRecall]').click()`); await wait(300);
      R.openedRecall = opened[0];
      // duplicates
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`document.querySelector('[data-action=findDupes]').click()`); await wait(600);
      R.dupGroups = await js(`[...document.querySelectorAll('#dupDlg [data-group] h3')].map(h => h.innerText)`);
      await shot('f2-duplicates');
      await js(`window.confirm = () => true; document.querySelector('#dupDlg [data-action=dupMerge]').click()`); await wait(900);
      R.afterMerge = (await items()).sort();
      // delete two at once
      for (const n of ['Old chair', 'Broken lamp']) { await js(`[...document.querySelectorAll('[data-open]')].find(r => r.querySelector('.name').innerText === ${JSON.stringify(n)}).querySelector('.selbox').click()`); await wait(300); }
      await js(`document.querySelector('[data-action=deleteSel]').click()`); await wait(900);
      R.afterDelete = (await items()).sort();
      R.binButton = await js(`(document.querySelector('[data-nav=bin]') || {}).innerText`);
      // owner filter
      await js(`{ const o = document.querySelector('[data-f=owner]'); o.value = 'Mark'; o.dispatchEvent(new Event('change', { bubbles: true })); }`); await wait(400);
      R.ownerFilter = await items();
      // reports: spending by year
      await js(`document.querySelector('[data-nav=reports]').click()`); await wait(900);
      R.spending = await js(`document.getElementById('spendCard').innerText.replace(/\\s+/g, ' ')`);
      await shot('f3-spending');
      const st = new Store(dir); st.load();
      const drill = st.data.assets.find(a => a.name === 'Makita drill');
      R.merged = drill && { notes: drill.notes, serial: drill.serial };
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
