'use strict';
// Receipt reading and claim pack, driven through the real window.
// Run: xvfb-run -a npx electron --no-sandbox test/batch2-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/b2';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osb2-'));
process.env.OPENSAFE_DATA_DIR = dir;
const PACK = path.join(OUT, 'claim-pack.pdf');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: PACK });
const boxes = [];
dialog.showMessageBox = async (_w, o) => { boxes.push(o); return { response: 0 }; };
shell.openPath = async () => '';

(async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) doc.addPage().drawText(`Currys receipt page ${i + 1}`, { x: 50, y: 700, size: 20, font });
  const pdfBuf = Buffer.from(await doc.save());

  const s = new Store(dir); s.load();
  const drill = s.saveAsset({ name: 'Makita combi drill', category: 'Tools', brand: 'Makita', model: 'DHP485Z', serial: 'MK-0099' });
  s.addPhoto(drill.id, 'p2.jpg', fs.readFileSync('/tmp/okshots/photos/p2.jpg'));
  s.addPhoto(drill.id, 'p3.jpg', fs.readFileSync('/tmp/okshots/photos/p3.jpg'));
  s.addDocument(drill.id, 'screwfix receipt.jpg', fs.readFileSync('/tmp/okshots/receipts/screwfix.jpg'), 'Receipt');
  const laptop = s.saveAsset({ name: 'Lenovo Legion 5', category: 'Computers & Phones', serial: 'PF4XK2LM', purchaseDate: '2025-08-02', purchasePrice: 1299, supplier: 'Currys' });
  s.addPhoto(laptop.id, 'p4.jpg', fs.readFileSync('/tmp/okshots/photos/p4.jpg'));
  s.addDocument(laptop.id, 'Currys invoice.pdf', pdfBuf, 'Receipt');
  s.saveAsset({ name: 'Garden bench' });
  require('../src/main.js');
})();

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
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Makita')).click()`); await wait(300);
      await js(`document.querySelector('[data-tab=docs]').click()`); await wait(300);
      await js(`document.querySelector('[data-action=ocr]').click()`);
      for (let i = 0; i < 60 && !(await js(`!!document.getElementById('ocrForm')`)); i++) await wait(250);
      await shot('c1-receipt-read');
      R.ocrModal = await js(`document.getElementById('ocrForm').innerText.slice(0, 300)`);
      await js(`document.getElementById('ocrForm').requestSubmit()`); await wait(800);
      await js(`document.querySelector('[data-tab=overview]').click()`); await wait(300);
      R.afterOcr = await js(`[...document.querySelectorAll('.kv > div')].map(d => d.innerText.replace(/\\n/g, ': ')).filter(t => /Bought|Price paid/.test(t))`);
      // select two items and make a claim pack
      await js(`document.querySelector('[data-action=back]').click()`); await wait(300);
      for (const name of ['Makita', 'Legion']) { await js(`[...document.querySelectorAll('tr[data-open]')].find(r => r.innerText.includes('${name}')).querySelector('.selbox').click()`); await wait(200); }
      await shot('c2-selected');
      R.selbar = await js(`(document.querySelector('.selbar') || {}).innerText`);
      await js(`document.querySelector('[data-action=claimSel]').click()`); await wait(300);
      await js(`const f = document.getElementById('claimForm'); f.incidentDate.value = '2026-11-20'; f.crimeRef.value = 'CR/12345/26'; f.whatHappened.value = 'Garage broken into overnight; tools and laptop taken.'`);
      await shot('c3-claim-form');
      await js(`document.getElementById('claimForm').requestSubmit()`);
      for (let i = 0; i < 80 && !fs.existsSync(PACK); i++) await wait(250);
      await wait(800);
      const { PDFDocument } = require('pdf-lib');
      const pdf = await PDFDocument.load(fs.readFileSync(PACK));
      R.packPages = pdf.getPageCount();
      R.packKB = Math.round(fs.statSync(PACK).size / 1024);
      R.warnings = boxes.map(b => b.detail);
      R.toast = await js(`document.getElementById('toast').innerText`);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
