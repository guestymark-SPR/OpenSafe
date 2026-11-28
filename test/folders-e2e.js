'use strict';
// Through the window: a PDF statement (and its balance check), a folder of statements (PDFs and a CSV covering some
// of the same months), and adding whole folders to Documents and Data by button and by dropping (nested folders,
// a file already kept, Windows' hidden files left out).
// Run: xvfb-run -a npx electron --no-sandbox test/folders-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/folders-e2e';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osfolders-'));
const dir = path.join(root, 'data'); fs.mkdirSync(dir);
process.env.OPENSAFE_DATA_DIR = dir;
const ST = path.join(__dirname, 'fixtures', 'statements'), LIB = path.join(__dirname, 'fixtures', 'library');
// a folder of statements: two PDFs of the same account, plus a CSV covering October again
const stmts = path.join(root, 'Statements'); fs.mkdirSync(path.join(stmts, '2026'), { recursive: true });
fs.copyFileSync(path.join(ST, 'two-columns.pdf'), path.join(stmts, '2026', 'Oct-Nov.pdf'));
fs.copyFileSync(path.join(ST, 'scanned.pdf'), path.join(stmts, 'scanned copy.pdf'));
fs.writeFileSync(path.join(stmts, 'october.csv'), 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n01/10/2026,Veterans UK,AFCS PAYMENT,FASTER PAYMENT,1450.00,1650.00\n01/10/2026,Landlord,RENT OCT,STANDING ORDER,-650.00,1000.00\n');
fs.writeFileSync(path.join(stmts, 'notes.docx'), 'not a statement');
// a folder of documents with folders inside
const docs = path.join(root, 'Army papers'); fs.mkdirSync(path.join(docs, 'Medical', 'Scans'), { recursive: true });
fs.copyFileSync(path.join(LIB, 'text.pdf'), path.join(docs, 'Discharge letter.pdf'));
fs.writeFileSync(path.join(docs, 'Medical', 'F Med 23.txt'), 'Form F Med 23 notes');
fs.writeFileSync(path.join(docs, 'Medical', 'Scans', 'page1.txt'), 'scan page one');
fs.writeFileSync(path.join(docs, 'Thumbs.db'), 'x'); fs.writeFileSync(path.join(docs, 'desktop.ini'), 'x'); fs.writeFileSync(path.join(docs, '~$draft.docx'), 'x');
fs.writeFileSync(path.join(docs, 'Medical', 'copy of notes.txt'), 'Form F Med 23 notes'); // the same file twice in the folder
const data = path.join(root, 'Receipts'); fs.mkdirSync(data); for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(data, n + '.txt'), 'receipt ' + n);
{ const s = new Store(dir); s.load(); const e = s.saveLibraryEntry({ kind: 'document', title: 'Already here' }); s.addLibraryFile(e.id, 'x.pdf', fs.readFileSync(path.join(LIB, 'text.pdf'))); s.save(); }
let nextPick = null;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: nextPick });
dialog.showMessageBox = async () => ({ response: 0 }); // "Skip those" for files already kept
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const until = async (code, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(code)) return true; await wait(500); } return false; };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`window.confirm = () => true; 1`);
      // ---- one PDF statement
      await js(`document.querySelector('[data-nav=budget]').click()`); await wait(600);
      await js(`document.querySelector('[data-action=bImport]').click()`); await wait(700);
      await js(`(() => { const s = document.getElementById('bkBank'); s.value = 'nationwide'; s.dispatchEvent(new Event('change')); })()`);
      nextPick = [path.join(ST, 'type-column.pdf')];
      await js(`document.getElementById('bkPick').click()`);
      await until(`!/Reading/.test(document.getElementById('bkOut').innerText) && document.getElementById('bkOut').innerText.length > 20`);
      R.onePdf = await js(`document.getElementById('bkOut').innerText.replace(/\\s+/g, ' ').slice(0, 330)`);
      await shot('f1-pdf-preview');
      await js(`document.querySelector('#bkForm [type=submit]').click()`); await wait(1500);
      R.oneImported = await js(`document.querySelector('.modal .dialog').innerText.replace(/\\s+/g, ' ').slice(0, 120)`);
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      // ---- a folder of statements (same months again: everything should be "already in")
      await js(`document.querySelector('[data-action=bImport]').click()`); await wait(700);
      await js(`(() => { const s = document.getElementById('bkBank'); s.value = 'nationwide'; s.dispatchEvent(new Event('change')); })()`);
      nextPick = [stmts];
      await js(`document.getElementById('bkFolder').click()`);
      await until(`!!document.querySelector('#bkOut table')`, 120000);
      R.folder = await js(`[...document.querySelectorAll('#bkOut tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      R.folderHead = await js(`document.querySelector('#bkOut .card').firstChild.textContent + document.querySelector('#bkOut .card').innerText.split('\\n')[1]`);
      R.folderImportDisabled = await js(`document.getElementById('bkGo').disabled`);
      await shot('f2-folder-preview');
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      // ---- Documents: add a folder
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(700);
      R.docButtons = await js(`[...document.querySelectorAll('#view .head .btn')].map(b => b.innerText.trim())`);
      nextPick = [docs];
      await js(`document.querySelector('[data-action=libAddFolder]').click()`); await wait(3000);
      R.toast = await js(`[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')`);
      await shot('f3-docs');
      // ---- Data: drop a folder
      R.drop = await js(`keep.libAddDropped('data', [${JSON.stringify(data)}], [], '').then(r => ({ added: r.added, errors: r.errors }))`);
      await wait(800);
      const st = new Store(dir); st.load();
      const lib = st.data.library;
      R.docs = lib.filter(e => e.kind === 'document' && e.title !== 'Already here').map(e => [e.title, e.folder]).sort();
      R.data = lib.filter(e => e.kind === 'data').map(e => [e.title, e.folder]).sort();
      R.imports = st.data.budget.imports.map(i => [i.file, i.added]);
      R.txCount = st.data.budget.transactions.length;
      R.originalsStillThere = fs.existsSync(path.join(docs, 'Discharge letter.pdf')) && fs.existsSync(path.join(data, 'a.txt'));
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
      console.log(JSON.stringify(R, null, 2));
    } catch (err) { console.error('E2E FAILED:', err); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(Object.assign(R, { error: String(err) }), null, 2)); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  });
});
