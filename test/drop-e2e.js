'use strict';
// Dropping files on the Documents and Data pages, including files with no path on disk
// (as some apps, such as Outlook, drop them). Real drags from File Explorer can't be simulated here.
// Run: xvfb-run -a npx electron --no-sandbox test/drop-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/drop';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osdrop-'));
process.env.OPENSAFE_DATA_DIR = dir;
dialog.showMessageBox = async () => ({ response: 0 });
const EML = fs.readFileSync(path.join(__dirname, 'fixtures', 'library', 'booking.eml')).toString('base64');
const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'library', 'text.pdf')).toString('base64');
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    // drop File objects (no disk path) on whatever element matches the selector
    const drop = (sel, files) => js(`(() => {
      const dt = new DataTransfer();
      for (const [name, b64, type] of ${JSON.stringify(files)}) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type }));
      const el = document.querySelector(${JSON.stringify(sel)});
      el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    const lib = () => js(`window.keep.getData().then(d => d.data.library.map(e => e.kind + ': ' + e.title + ' [' + e.files.map(f => f.name).join(', ') + ']' + (e.folder ? ' in ' + e.folder : '')))`);
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // Data, empty page: drop an email on the page title (outside the dashed box)
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(400);
      R.emptyText = await js(`document.querySelector('.card.empty p').innerText`);
      await drop('.head h1', [['Your crossing is booked.eml', EML, 'message/rfc822']]); await wait(1500);
      R.afterEmailDrop = await lib();
      R.toast1 = await js(`document.getElementById('toast').innerText`);
      // Documents: drop two files on the list area -> one document, then its details form opens
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(400);
      await drop('.lead', [['page1.pdf', PDF, 'application/pdf'], ['page2.pdf', PDF, 'application/pdf']]); await wait(1500);
      R.newDocForm = await js(`!!document.getElementById('libForm')`);
      await js(`document.querySelector('[data-action=close]').click()`); await wait(300);
      // on that document's page: drop another file anywhere
      R.onDocPage = await js(`!!document.querySelector('.libhead')`);
      await drop('.libhead', [['page3.pdf', PDF, 'application/pdf']]); await wait(1500);
      R.afterDocDrops = await lib();
      // a drop with no files (for example dragged text)
      await js(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hello'); const el = document.querySelector('.libhead'); el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`); await wait(400);
      R.noFilesToast = await js(`document.getElementById('toast').innerText`);
      // a .txt dropped on Data is stored, not treated as a phone export
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(400);
      await drop('.head h1', [['notes.txt', Buffer.from('Boiler code 1234').toString('base64'), 'text/plain']]); await wait(1500);
      R.afterTxt = await lib();
      // a file from File Explorer arrives as a path on disk (the same call the drop makes)
      const xlsx = path.join(__dirname, 'fixtures', 'library', 'costs.xlsx');
      R.pathDrop = await js(`window.keep.libAddDropped('data', [${JSON.stringify(xlsx)}, ${JSON.stringify(path.join(__dirname, 'fixtures'))}], [], '').then(r => ({ added: r.added, errors: r.errors }))`);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
