'use strict';
// One search for everything, words in item receipts, suggested letter details, Outlook emails.
// Run: xvfb-run -a npx electron --no-sandbox test/search-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/search';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ossearch-'));
process.env.OPENSAFE_DATA_DIR = dir;
dialog.showMessageBox = async () => ({ response: 0 });
let pick = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: pick });

const s = new Store(dir); s.load();
const boiler = s.saveAsset({ name: 'Worcester boiler', category: 'Appliances', location: 'Home' });
s.addDocument(boiler.id, 'boiler-invoice.pdf', fs.readFileSync(path.join(F, 'statement.pdf')), 'Receipt'); // mentions "Sandwell Council"
s.saveAsset({ name: 'Council recycling bin', category: 'Other' });
const letter = s.saveLibraryEntry({ kind: 'document', title: 'Scanned letter' });
s.addLibraryFile(letter.id, 'letter.png', fs.readFileSync(path.join(F, 'letter.png'))); // Veterans UK, AFCS/2026/88123, tariff
const bill = s.saveLibraryEntry({ kind: 'document', title: 'Council tax', docType: 'Bill', from: 'Sandwell Council' });
s.addLibraryFile(bill.id, 'text.pdf', fs.readFileSync(path.join(F, 'text.pdf')));
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const typeSearch = async (q) => { await js(`{ const g = document.getElementById('gSearch'); g.value = ${JSON.stringify(q)}; g.dispatchEvent(new Event('input')); }`); await wait(900); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // wait for the background reading (receipt, scanned letter, bill)
      for (let i = 0; i < 120; i++) { const r = await js(`window.keep.searchAll('tariff')`); if (r.library.length) break; await wait(500); }
      for (let i = 0; i < 60; i++) { const r = await js(`window.keep.searchAll('direct debit')`); if (r.items.length) break; await wait(500); }
      R.placeholder = await js(`document.getElementById('gSearch').placeholder`);
      // ---- one search: "Sandwell" is in the boiler's invoice and in a document's sender
      await typeSearch('sandwell');
      R.searchPage = await js(`document.querySelector('.head').innerText.replace(/\\s+/g, ' ')`);
      R.sections = await js(`[...document.querySelectorAll('.srch')].map(c => c.querySelector('h2').innerText.replace(/\\s+/g, ' ').trim() + ' :: ' + [...c.querySelectorAll('.rowi')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()).join(' || '))`);
      R.highlighted = await js(`[...document.querySelectorAll('.srch mark')].map(m => m.innerText).slice(0, 3)`);
      await shot('s1-search');
      // Show in Items: the boiler is found by its invoice, with the reason shown
      await js(`document.querySelector('[data-action=srchItems]').click()`); await wait(1200);
      R.itemsPage = await js(`[...document.querySelectorAll('table.list tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('s2-items-receipt-hit');
      // a word only inside the scanned letter
      await typeSearch('tariff');
      R.tariff = await js(`[...document.querySelectorAll('.srch .rowi')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await js(`document.querySelector('[data-action=srchLib]').click()`); await wait(800);
      R.docsFiltered = await js(`document.getElementById('libQ').value + ' | ' + [...document.querySelectorAll('#libList tbody tr b')].map(b => b.innerText).join(', ')`);
      R.noResults = await (async () => { await typeSearch('zebracrossing'); return js(`document.querySelector('.card.empty').innerText.slice(0, 40)`); })();
      // ---- suggested details on the scanned letter
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('Scanned letter')).click()`); await wait(1000);
      R.suggestion = await js(`(document.querySelector('.sugbar') || {}).innerText`);
      await shot('s3-suggestion');
      await js(`document.querySelector('[data-action=libSugUse]').click()`); await wait(800);
      R.afterUse = await js(`window.keep.getData().then(d => { const e = d.data.library.find(x => x.title === 'Scanned letter'); return { from: e.from, ref: e.ref, docDate: e.docDate, suggest: e.suggest || null }; })`);
      R.bannerGone = await js(`!document.querySelector('.sugbar')`);
      // ---- Outlook emails: added to Data with their subject, shown in the reader, searchable
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(400);
      pick = [path.join(F, 'outlook-inline.msg'), path.join(F, 'outlook-plain.msg')];
      await js(`document.querySelector('.head [data-action=libAdd]').click()`); await wait(2000);
      R.msgEntries = await js(`window.keep.getData().then(d => d.data.library.filter(e => e.kind === 'data').map(e => e.title + ' [' + e.folder + '] ' + e.docDate))`);
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(500);
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('Attach and inline')).click()`); await wait(800);
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(2000);
      R.msgReader = await js(`({ head: document.querySelector('.vmhead').innerText.replace(/\\s+/g, ' '), inlinePicture: (document.querySelector('.vframe') && [...document.querySelector('.vframe').contentDocument.images].map(i => i.naturalWidth)) || [] })`);
      await shot('s4-outlook');
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(300);
      for (let i = 0; i < 40; i++) { const r = await js(`window.keep.searchAll('body')`); if (r.library.length) { R.msgSearch = r.library.length; break; } await wait(500); }
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
