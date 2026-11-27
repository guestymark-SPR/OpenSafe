'use strict';
// Documents and Data through the real window, with password protection and a vault.
// Sample files: test/fixtures/library (a text PDF, a scanned PDF, Word, Excel, an email and a photo of a letter).
// Run: xvfb-run -a npx electron --no-sandbox test/library-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell } = require('electron');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/library';
fs.mkdirSync(OUT, { recursive: true });
const SAMPLES = process.env.SAMPLES || path.join(__dirname, 'fixtures', 'library');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oslibe2e-'));
process.env.OPENSAFE_DATA_DIR = dir;
const PW = 'correct horse battery';
let pick = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: pick });
dialog.showMessageBox = async () => ({ response: 0 });
const opened = [];
shell.openPath = async (p) => { opened.push({ p, bytes: fs.readFileSync(p) }); return ''; };
const savedTo = path.join(OUT, 'copy-out.bin');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedTo });
const exe = path.join(OUT, 'setup.exe'); fs.writeFileSync(exe, 'MZ not really');

// set-up needs await, which can't run before the app starts, so do it in a separate Node process
require('child_process').execFileSync('node', ['-e', `
  const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'store'))});
  (async () => { const s = new Store(${JSON.stringify(dir)}); s.load(); s.saveAsset({ name: 'Laptop' });
    await s.enableEncryption(${JSON.stringify(PW)}); await s.setupVault('4826'); })().catch(e => { console.error(e); process.exit(1); });`]);
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(700); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const lib = () => js(`window.keep.getData().then(d => d.data.library)`);
    const waitRead = async () => { for (let i = 0; i < 120; i++) { const l = await lib(); if (l.every(e => !e.textPending)) return true; await wait(500); } return false; };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1200);
      await js(`{ const f = document.getElementById('unlockForm'); f.querySelector('input[type=password]').value = ${JSON.stringify(PW)}; f.requestSubmit(); }`); await wait(1500);
      R.menu = await js(`[...document.querySelectorAll('#nav > *')].map(e => e.innerText.trim()).filter(Boolean)`);

      // ---- Documents: empty page, then add a scanned PDF (picture only, no text layer)
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(400);
      R.docsEmpty = await js(`document.querySelector('.card.empty').innerText.slice(0, 120)`);
      await shot('l1-docs-empty');
      pick = [path.join(SAMPLES, 'scanned.pdf')];
      await js(`document.querySelector('[data-action=libAdd]').click()`); await wait(1500);
      R.newFormTitle = await js(`document.querySelector('#libForm h2').innerText + ' | ' + document.querySelector('#libForm [name=title]').value`);
      await shot('l2-new-doc-form');
      await js(`{ const f = document.getElementById('libForm'); f.title.value = 'AFCS award letter'; f.docType.value = 'Benefits & pension'; f.from.value = 'Veterans UK'; f.docDate.value = '2026-06-02'; f.ref.value = 'AFCS/2026/88123'; f.actBy.value = '${inDays(5)}'; f.tags.value = 'afcs, pension'; f.requestSubmit(); }`); await wait(800);
      R.readAll1 = await waitRead();
      // a second document with a text layer, added by "drop" path (main's addPaths)
      pick = [path.join(SAMPLES, 'text.pdf')];
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(300);
      await js(`document.querySelector('[data-action=libAdd]').click()`); await wait(1200);
      await js(`{ const f = document.getElementById('libForm'); f.title.value = 'Council tax bill 2027'; f.docType.value = 'Bill'; f.from.value = 'Sandwell Council'; f.requestSubmit(); }`); await wait(600);
      R.readAll2 = await waitRead();
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(1500);
      R.docsList = await js(`[...document.querySelectorAll('#libList tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      R.thumbs = await js(`document.querySelectorAll('#libList img.lthumb').length`);
      await shot('l3-docs-list');
      // search inside the scan (words only on the picture)
      await js(`{ const q = document.getElementById('libQ'); q.value = 'tariff'; q.dispatchEvent(new Event('input')); }`); await wait(800);
      R.searchTariff = await js(`[...document.querySelectorAll('#libList tbody tr')].map(r => r.querySelector('b').innerText + ' :: ' + (r.querySelector('.snippet') || {}).innerText)`);
      await shot('l4-docs-search');
      await js(`{ const q = document.getElementById('libQ'); q.value = 'CT-55-4471'; q.dispatchEvent(new Event('input')); }`); await wait(800);
      R.searchRef = await js(`[...document.querySelectorAll('#libList tbody tr b')].map(b => b.innerText)`);
      await js(`{ const q = document.getElementById('libQ'); q.value = 'zebra'; q.dispatchEvent(new Event('input')); }`); await wait(800);
      R.searchNone = await js(`document.getElementById('libList').innerText.trim()`);
      await js(`{ const q = document.getElementById('libQ'); q.value = ''; q.dispatchEvent(new Event('input')); }`); await wait(600);

      // ---- a document's page
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('AFCS award')).click()`); await wait(2500);
      R.docPage = await js(`document.querySelector('.libhead').innerText.replace(/\\s+/g, ' ') + ' || ' + document.querySelector('.dash-side').innerText.replace(/\\s+/g, ' ')`);
      R.docPreview = await js(`(document.querySelector('img.libbig') || {}).naturalWidth || 0`);
      R.fileState = await js(`document.querySelector('[data-textstate]').innerText`);
      await shot('l5-doc-page');
      await js(`document.querySelector('[data-action=libFileText]').click()`); await wait(600);
      R.wordsFound = await js(`document.querySelector('.libtext').innerText.slice(0, 200)`);
      await js(`document.querySelector('[data-action=close]').click()`); await wait(200);
      await js(`document.querySelector('[data-action=libFileOpen]').click()`); await wait(600);
      R.openedCopyIsPdf = opened.length === 1 && opened[0].bytes.slice(0, 5).toString() === '%PDF-' && opened[0].bytes.equals(fs.readFileSync(path.join(SAMPLES, 'scanned.pdf')));
      // add a second page file by "Add more" (picker)
      pick = [path.join(SAMPLES, 'letter.png')];
      await js(`document.querySelector('[data-action=libAddMore]').click()`); await wait(1000);
      R.readAll3 = await waitRead();
      R.filesNow = await js(`[...document.querySelectorAll('.libfile b')].map(b => b.innerText)`);

      // ---- Reminders: the reply-by date
      await js(`document.querySelector('[data-nav=reminders]').click()`); await wait(400);
      R.reminderRow = await js(`[...document.querySelectorAll('.rowi')].map(r => r.innerText.replace(/\\s+/g, ' ')).find(t => t.includes('Reply')) || ''`);
      await js(`[...document.querySelectorAll('.rowi')].find(r => r.innerText.includes('Reply')).click()`); await wait(800);
      R.reminderOpens = await js(`document.querySelector('.libhead h1').innerText`);
      await js(`document.querySelector('[data-action=libDone]').click()`); await wait(800);
      R.afterDone = await js(`document.querySelector('.libhead').innerText.replace(/\\s+/g, ' ')`);

      // ---- Data: email, Word, Excel, and a program (refused)
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(400);
      R.dataHighlighted = await js(`document.querySelector('.side [data-nav=files]').classList.contains('on')`);
      pick = [path.join(SAMPLES, 'mail.eml'), path.join(SAMPLES, 'tenancy.docx'), path.join(SAMPLES, 'costs.xlsx'), exe];
      await js(`document.querySelector('[data-action=libAdd]').click()`); await wait(1500);
      R.dataToast = await js(`document.getElementById('toast').innerText`);
      R.readAll4 = await waitRead();
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(1000);
      R.dataList = await js(`[...document.querySelectorAll('#libList tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('l6-data-list');
      await js(`{ const q = document.getElementById('libQ'); q.value = 'DPS-998877'; q.dispatchEvent(new Event('input')); }`); await wait(800);
      R.dataSearchDocx = await js(`[...document.querySelectorAll('#libList tbody tr b')].map(b => b.innerText)`);
      await js(`{ const q = document.getElementById('libQ'); q.value = 'Low Rider'; q.dispatchEvent(new Event('input')); }`); await wait(800);
      R.dataSearchEmail = await js(`[...document.querySelectorAll('#libList tbody tr b')].map(b => b.innerText)`);
      await js(`{ const q = document.getElementById('libQ'); q.value = ''; q.dispatchEvent(new Event('input')); }`); await wait(600);
      await js(`document.getElementById('libFolder').value = 'Emails'; document.getElementById('libFolder').dispatchEvent(new Event('change'))`); await wait(300);
      R.folderFilter = await js(`[...document.querySelectorAll('#libList tbody tr b')].map(b => b.innerText)`);
      // save a copy of the Word file
      await js(`document.getElementById('libFolder').value = ''; document.getElementById('libFolder').dispatchEvent(new Event('change'))`); await wait(300);
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('tenancy')).click()`); await wait(800);
      await js(`document.querySelector('[data-action=libFileCopy]').click()`); await wait(600);
      R.savedCopyMatches = fs.existsSync(savedTo) && fs.readFileSync(savedTo).equals(fs.readFileSync(path.join(SAMPLES, 'tenancy.docx')));
      // delete it and restore it
      await js(`window.confirm = () => true; document.querySelector('[data-action=libDel]').click()`); await wait(800);
      R.afterDeleteView = await js(`document.querySelector('.head h1').innerText + ' | ' + (document.querySelector('[data-action=libBin]') || {}).innerText`);
      await js(`document.querySelector('[data-action=libBin]').click()`); await wait(400);
      await shot('l7-data-bin');
      await js(`document.querySelector('[data-action=libRestore]').click()`); await wait(800);
      R.afterRestore = (await lib()).filter(e => e.kind === 'data').map(e => e.title).sort();
      await js(`document.querySelector('[data-action=close]') && document.querySelector('[data-action=close]').click()`); await wait(200);

      // ---- Vault: move the award letter in, lock, it disappears; nothing readable on disk
      await js(`window.keep.vaultUnlock('4826')`); await wait(600);
      const afcs = (await lib()).find(e => e.title === 'AFCS award letter');
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(300);
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('AFCS award')).click()`); await wait(800);
      await js(`document.querySelector('[data-action=libVault]').click()`); await wait(800);
      R.inVaultPill = await js(`!!document.querySelector('.libhead .pill.vault')`);
      await js(`window.keep.vaultLock()`); await wait(800);
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      R.docsWhileVaultLocked = await js(`[...document.querySelectorAll('#libList tbody tr b')].map(b => b.innerText)`);
      R.vaultNote = await js(`document.getElementById('view').innerText.includes('Unlock the vault')`);
      R.searchVaultLocked = await js(`window.keep.libSearch('document', 'tariff')`);
      const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(dir);
      R.plaintextOnDisk = ['tariff', 'AFCS award', 'Veterans UK', 'CT-55-4471', 'DPS-998877', 'Low Rider', 'Eurotunnel'].filter(n => files.some(f => fs.readFileSync(f).includes(Buffer.from(n))));
      R.afcsId = !!afcs;

      // ---- dark mode
      await js(`document.querySelector('[data-nav=settings]').click()`); await wait(300);
      await js(`document.querySelector('[data-theme=dark]').click()`); await wait(800);
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(1200);
      await shot('l8-data-dark');
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('Booking')).click()`); await wait(1500);
      await shot('l9-email-dark');
      R.emailPage = await js(`document.querySelector('.dash-side').innerText.replace(/\\s+/g, ' ')`);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
