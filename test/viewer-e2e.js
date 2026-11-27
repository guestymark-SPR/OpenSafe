'use strict';
// Reading files inside OpenSafe (Documents and Data) through the real window.
// Run: xvfb-run -a npx electron --no-sandbox test/viewer-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell, session } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/viewer';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osview-'));
process.env.OPENSAFE_DATA_DIR = dir;
const savedTo = path.join(OUT, 'saved-attachment.pdf');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedTo });
const asked = [];
dialog.showMessageBox = async (_w, o) => { asked.push(o.detail || o.message); return { response: 2 }; };
const external = [];
shell.openExternal = async (u) => { external.push(u); };
shell.openPath = async () => '';

const s = new Store(dir); s.load();
const add = (kind, title, files, extra) => { const e = s.saveLibraryEntry(Object.assign({ kind, title }, extra || {})); for (const f of files) s.addLibraryFile(e.id, f, fs.readFileSync(path.join(F, f))); return e; };
add('document', 'Bank statement March', ['statement.pdf', 'letter.png'], { docType: 'Bank statement', from: 'Nationwide' });
add('data', 'Your crossing is booked', ['booking.eml'], { folder: 'Emails' });
add('data', 'Tenancy agreement', ['tenancy.docx']);
add('data', 'House costs', ['costs.xlsx']);
const msg = s.saveLibraryEntry({ kind: 'data', title: 'Outlook email' }); s.addLibraryFile(msg.id, 'old.msg', Buffer.from('not really a msg file'));
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  const requests = [];
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => { if (/^https?:/.test(d.url)) requests.push(d.url); cb({}); });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(700); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const openEntry = async (nav, title) => { await js(`document.querySelector('[data-nav=${nav}]').click()`); await wait(500); await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes(${JSON.stringify(title)})).click()`); await wait(800); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // ---- PDF, page by page
      await openEntry('docs', 'Bank statement');
      R.viewButtons = await js(`[...document.querySelectorAll('[data-action=libFileView].btn')].map(b => b.innerText.trim())`);
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(2500);
      R.pdfBar = await js(`document.querySelector('.vbar').innerText.replace(/\\s+/g, ' ')`);
      R.pdfPages = await js(`document.querySelectorAll('.vpage').length`);
      R.pdfDrawnAtStart = await js(`document.querySelectorAll('.vpage img').length`);
      await shot('v1-pdf');
      await js(`{ const b = document.querySelector('.vbody'); b.scrollTop = b.scrollHeight; }`); await wait(2000);
      R.pdfDrawnAfterScroll = await js(`document.querySelectorAll('.vpage img').length`);
      const w0 = await js(`document.querySelector('.vpage').getBoundingClientRect().width`);
      await js(`document.querySelector('[data-action=libViewZoom][data-z="1"]').click()`); await wait(1500);
      R.zoom = { before: Math.round(w0), after: Math.round(await js(`document.querySelector('.vpage').getBoundingClientRect().width`)), label: await js(`document.querySelector('.vz').innerText`) };
      await js(`document.querySelector('[data-action=libViewZoom][data-z="0"]').click()`); await wait(300);
      R.zoomFit = await js(`document.querySelector('.vz').innerText`);
      // next file in the same document: the photo
      await js(`document.querySelector('[data-action=libViewFile][data-step="1"]').click()`); await wait(1500);
      R.nextFile = await js(`document.querySelector('.vtitle b').innerText + ' | ' + document.querySelector('.vnav .meta').innerText + ' | img ' + (document.querySelector('.vimg') || {}).naturalWidth`);
      await shot('v2-photo');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(300);
      R.escCloses = await js(`document.getElementById('viewer').classList.contains('hidden') && !!document.querySelector('.libhead')`);
      // clicking the big preview opens the reader too
      await js(`document.querySelector('.libbigwrap').click()`); await wait(1500);
      R.previewOpensReader = await js(`!document.getElementById('viewer').classList.contains('hidden')`);
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(300);
      // one click on a file shows it in the preview box; a double-click opens it
      R.previewBefore = await js(`document.querySelector('.libpreview p').innerText`);
      await js(`document.querySelectorAll('[data-libsel]')[1].querySelector('b').click()`); await wait(1500);
      R.previewAfterClick = await js(`document.querySelector('.libpreview p').innerText + ' | selected: ' + document.querySelector('.libfile.on b').innerText + ' | img ' + ((document.querySelector('img.libbig') || {}).naturalWidth || 0) + ' | reader open: ' + !document.getElementById('viewer').classList.contains('hidden')`);
      await shot('v1b-preview-photo');
      await js(`document.querySelectorAll('[data-libsel]')[0].querySelector('b').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await wait(1500);
      R.dblclickOpens = await js(`!document.getElementById('viewer').classList.contains('hidden') && document.querySelector('.vtitle b').innerText`);
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(300);

      // ---- email
      await openEntry('files', 'Your crossing');
      await wait(800);
      R.emailPreview = await js(`document.getElementById('libMsg').innerText.slice(0, 80)`);
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(2500);
      R.emailHead = await js(`document.querySelector('.vmhead').innerText.replace(/\\s+/g, ' ')`);
      R.emailFrame = await js(`(() => { const d = document.querySelector('.vframe').contentDocument; const imgs = [...d.images]; return { text: d.body.innerText.replace(/\\s+/g, ' ').slice(0, 120), title: d.title, scripts: d.querySelectorAll('script').length, inlinePicture: imgs[0] && imgs[0].naturalWidth, trackerLoaded: imgs[1] && imgs[1].naturalWidth, sandbox: document.querySelector('.vframe').getAttribute('sandbox'), height: document.querySelector('.vframe').offsetHeight }; })()`);
      R.trackerRequests = requests.filter(u => u.includes('tracker.example.com'));
      await shot('v3-email');
      // a link asks first; cancelling opens nothing
      await js(`document.querySelector('.vframe').contentDocument.querySelector('a').click()`); await wait(600);
      R.linkAsked = asked.slice(-1)[0] || '';
      R.linkOpened = external.slice();
      // attachment: save a copy, then keep it in Data
      await js(`document.querySelector('.vatt [data-action=moreMenu]').click()`); await wait(200);
      await js(`document.querySelector('[data-action=libAttSave]').click()`); await wait(600);
      R.attachmentSaved = fs.existsSync(savedTo) && fs.readFileSync(savedTo).equals(fs.readFileSync(path.join(F, 'text.pdf')));
      await js(`document.querySelector('[data-action=libAttKeep]').click()`); await wait(1200);
      R.keptInData = (await js(`window.keep.getData().then(d => d.data.library.filter(e => e.folder === 'Email attachments').map(e => e.title + ' / ' + e.files[0].name))`));
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(300);

      // ---- Word
      await openEntry('files', 'Tenancy');
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(2000);
      R.word = await js(`({ heading: document.querySelector('.vframe').contentDocument.querySelector('h1').innerText, note: document.querySelector('.vnote').innerText })`);
      await shot('v4-word');
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(300);
      // ---- Excel
      await openEntry('files', 'House costs');
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(1500);
      R.excel = await js(`[...document.querySelectorAll('.vsheet tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('v5-excel');
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(300);
      // ---- Outlook .msg
      await openEntry('files', 'Outlook email');
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(1200);
      R.msg = await js(`document.querySelector('.vmsg').innerText.replace(/\\s+/g, ' ')`);
      // going to another page closes the reader
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      R.navCloses = await js(`document.getElementById('viewer').classList.contains('hidden')`);
      // ---- dark mode
      await js(`document.querySelector('[data-nav=settings]').click()`); await wait(300);
      await js(`document.querySelector('[data-theme=dark]').click()`); await wait(800);
      await openEntry('files', 'Your crossing');
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(2000);
      await shot('v6-email-dark');
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(300);
      await openEntry('docs', 'Bank statement');
      await js(`document.querySelector('.btn[data-action=libFileView]').click()`); await wait(2500);
      await shot('v7-pdf-dark');
      R.allRequests = [...new Set(requests.map(u => new URL(u).host))];
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
