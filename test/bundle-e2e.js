'use strict';
// Bundle PDF from the Documents page: tick letters, make the bundle, check the real PDF.
// Run: xvfb-run -a npx electron --no-sandbox test/bundle-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, dialog, shell } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/bundle-e2e';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osbundle-'));
process.env.OPENSAFE_DATA_DIR = dir;
const SAVE = path.join(OUT, 'bundle.pdf');
try { fs.unlinkSync(SAVE); } catch (_) {}
let saveTitle = '';
dialog.showMessageBox = async () => ({ response: 0 });
dialog.showSaveDialog = async (_w, o) => { saveTitle = o.defaultPath; return { canceled: false, filePath: SAVE }; };
shell.openPath = async () => '';

// a web server the email's picture points at: it must never be asked for anything
let webHits = 0;
const server = http.createServer((q, r) => { webHits++; r.end('x'); }).listen(0, '127.0.0.1');

const s = new Store(dir); s.load();
const add = (o, files) => { const e = s.saveLibraryEntry(Object.assign({ kind: 'document' }, o)); for (const [n, b] of files) s.addLibraryFile(e.id, n, b); return e; };
add({ title: 'Reply from MP', from: 'House of Commons', docDate: '2026-09-10', docType: 'Letter' }, [['reply.pdf', fs.readFileSync(path.join(F, 'statement.pdf'))]]);
add({ title: 'CMS decision', from: 'Child Maintenance Service', docDate: '2026-03-02', ref: '12345 678', docType: 'Letter' }, [['decision.pdf', fs.readFileSync(path.join(F, 'text.pdf'))], ['page2.png', fs.readFileSync(path.join(F, 'letter.png'))]]);
add({ title: 'Tenancy', docDate: '2026-05-20', docType: 'Contract' }, [['tenancy.docx', fs.readFileSync(path.join(F, 'tenancy.docx'))]]);
add({ title: 'Not in the bundle', docDate: '2026-04-01' }, [['x.png', fs.readFileSync(path.join(F, 'letter.png'))]]);
server.on('listening', () => {
  const port = server.address().port;
  const eml = fs.readFileSync(path.join(F, 'mail.eml'), 'utf8').replace('<p>Bike: Harley Low Rider S</p>', `<p>Bike: Harley Low Rider S</p><img src=3D"http://127.0.0.1:${port}/track.png">`);
  add({ title: 'Email to Veterans UK', from: 'Mark', docDate: '2026-06-01' }, [['mail.eml', Buffer.from(eml)]]);
  require('../src/main.js');
});

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
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(700);
      // tick everything except "Not in the bundle"
      for (const t of ['Reply from MP', 'CMS decision', 'Tenancy', 'Email to Veterans UK']) { await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes(${JSON.stringify(t)})).querySelector('input[type=checkbox]').click()`); await wait(250); }
      R.selbar = await js(`document.querySelector('.selbar').innerText.replace(/\\s+/g, ' ')`);
      await shot('b1-ticked');
      await js(`document.querySelector('.selbar [data-action=libBundle]').click()`); await wait(600);
      R.form = await js(`document.querySelector('#bundleForm').innerText.replace(/\\s+/g, ' ')`);
      await shot('b2-form');
      await js(`{ const f = document.querySelector('#bundleForm'); f.elements.title.value = 'Bundle for Jess Phillips MP'; f.requestSubmit(); }`);
      for (let i = 0; i < 60 && !fs.existsSync(SAVE); i++) await wait(500);
      await wait(1500);
      R.toast = await js(`(document.querySelector('.toast') || {}).innerText`);
      R.saveName = path.basename(saveTitle);
      R.saved = fs.existsSync(SAVE) ? fs.statSync(SAVE).size : 0;
      R.webHits = webHits;
      await shot('b3-done');
      // right-click on one row offers it too
      await js(`document.querySelector('[data-action=libSelClear]') && document.querySelector('[data-action=libSelClear]').click()`); await wait(300);
      await js(`{ const r = document.querySelector('#libList tbody tr'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 })); }`); await wait(400);
      R.ctx = await js(`[...document.querySelectorAll('.menu.ctx [data-action]')].map(b => b.innerText.trim()).filter(Boolean)`);
      await shot('b4-rightclick');
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    server.close();
    app.exit(0);
  });
});
