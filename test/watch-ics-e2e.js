'use strict';
// Watch a folder and Add to my calendar, through the window.
// Run: xvfb-run -a npx electron --no-sandbox test/watch-ics-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/watch-ics-e2e';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oswatche2e-'));
const dir = path.join(root, 'data'), scans = path.join(root, 'Scans');
fs.mkdirSync(dir); fs.mkdirSync(scans);
process.env.OPENSAFE_DATA_DIR = dir;
const ICS = path.join(OUT, 'reminders.ics');
try { fs.unlinkSync(ICS); } catch (_) {}
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [scans] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: ICS });
dialog.showMessageBox = async () => ({ response: 0 });

const s = new Store(dir); s.load();
const soon = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
s.saveAsset({ name: 'Mercedes C220d', category: 'Vehicles', warrantyExpiry: soon(20) });
s.saveLibraryEntry({ kind: 'document', title: 'Annual review', from: 'CMS', actBy: soon(10) });
s.saveLibraryEntry({ kind: 'document', title: 'Old letter', actBy: soon(-5) }); // overdue: not in the calendar
const kept = s.saveLibraryEntry({ kind: 'document', title: 'Already here' });
s.addLibraryFile(kept.id, 'text.pdf', fs.readFileSync(path.join(F, 'text.pdf')));
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // ---- 49: calendar file
      await js(`document.querySelector('[data-nav=reminders]').click()`); await wait(500);
      await js(`document.querySelector('[data-action=remIcs]').click()`); await wait(1200);
      R.icsDialog = await js(`document.querySelector('.modal .dialog').innerText.replace(/\\s+/g, ' ').slice(0, 160)`);
      const t = fs.readFileSync(ICS, 'utf8').replace(/\r\n /g, '');
      R.ics = t.split('\r\n').filter(l => /^(SUMMARY|DTSTART|UID)/.test(l));
      await shot('w1-ics');
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      // ---- 47: watch a folder
      await js(`document.querySelector('[data-nav=data]').click()`); await wait(600);
      await js(`document.querySelector('#watchCard [data-action=watchChoose][data-kind=document]').click()`); await wait(1000);
      R.card = await js(`document.getElementById('watchCard').innerText.replace(/\\s+/g, ' ')`);
      fs.copyFileSync(path.join(F, 'statement.pdf'), path.join(scans, 'Scan 2026-11-27.pdf'));
      fs.copyFileSync(path.join(F, 'text.pdf'), path.join(scans, 'copy of a kept one.pdf'));
      fs.writeFileSync(path.join(scans, 'half.pdf.crdownload'), 'x');
      for (let i = 0; i < 60 && fs.readdirSync(scans).filter(f => f.endsWith('.pdf')).length; i++) await wait(500);
      await wait(1000);
      R.folderNow = fs.readdirSync(scans).sort();
      R.moved = fs.readdirSync(path.join(scans, 'Added to OpenSafe')).sort();
      R.docs = await js(`window.keep.getData().then(d => d.data.library.map(e => e.title + ' (' + e.files.length + ')').sort())`);
      R.cardAfter = await js(`document.getElementById('watchCard').innerText.replace(/\\s+/g, ' ')`);
      R.watchJson = JSON.parse(fs.readFileSync(path.join(dir, 'watch.json'), 'utf8')).folder === scans;
      await js(`document.getElementById('watchCard').scrollIntoView()`); await shot('w2-watch');
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
