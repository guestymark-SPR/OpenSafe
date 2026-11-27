'use strict';
// Highlights and notes in the reader, drawn with real mouse events, then searched and put in a bundle.
// Run: xvfb-run -a npx electron --no-sandbox test/marks-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, dialog, shell } = require('electron');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/marks-e2e';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osmarkse2e-'));
process.env.OPENSAFE_DATA_DIR = dir;
const SAVE = path.join(OUT, 'bundle.pdf');
try { fs.unlinkSync(SAVE); } catch (_) {}
dialog.showMessageBox = async () => ({ response: 0 });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: SAVE });
shell.openPath = async () => '';

(async () => {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) {
    const p = d.addPage([595, 842]);
    p.drawText('Child Maintenance Service', { x: 60, y: 760, size: 14, font: f });
    p.drawText(n === 1 ? 'We have worked out your income as 52,000 a year.' : 'You must pay 640 a month from 1 December.', { x: 60, y: 600, size: 14, font: f });
  }
  const s = new Store(dir); s.load();
  const e = s.saveLibraryEntry({ kind: 'document', title: 'CMS decision', from: 'Child Maintenance Service', docDate: '2026-11-01' });
  s.addLibraryFile(e.id, 'decision.pdf', Buffer.from(await d.save()));
  require('../src/main.js');
})();

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const mouse = async (type, x, y) => { win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }); await wait(60); };
    // drag across a page, from/to fractions of the page as shown
    const drag = async (n, u0, v0, u1, v1) => {
      await js(`document.querySelector('#viewer .vpage[data-n="${n}"]').scrollIntoView({ block: 'center' })`); await wait(500);
      const r = await js(`(() => { const b = document.querySelector('#viewer .vpage[data-n="${n}"]').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
      await mouse('mouseDown', r.x + r.w * u0, r.y + r.h * v0);
      for (let i = 1; i <= 6; i++) await mouse('mouseMove', r.x + r.w * (u0 + (u1 - u0) * i / 6), r.y + r.h * (v0 + (v1 - v0) * i / 6));
      await mouse('mouseUp', r.x + r.w * u1, r.y + r.h * v1);
      await wait(1500);
    };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(600);
      await js(`document.querySelector('#libList tbody tr').click()`); await wait(800);
      // open the PDF in the reader (double-click on its file row)
      await js(`document.querySelectorAll('[data-libsel]')[0].querySelector('b').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await wait(2000);
      R.readerOpen = await js(`!document.getElementById('viewer').classList.contains('hidden')`);
      await js(`document.querySelector('[data-action=libMarkMode]').click()`); await wait(300);
      R.modeButton = await js(`document.querySelector('[data-action=libMarkMode]').innerText`);
      // highlight the income line on page 1: y 600 of 842 → 0.27–0.30 down
      await drag(1, 0.08, 0.265, 0.85, 0.30);
      R.editor = await js(`document.getElementById('markForm') ? document.getElementById('markForm').innerText.replace(/\\s+/g, ' ').slice(0, 160) : null`);
      await js(`(() => { const f = document.getElementById('markForm'); f.elements.note.value = 'Wrong: my income is my pension now'; f.requestSubmit(); })()`); await wait(1000);
      // and the payment on page 2, in green
      await drag(2, 0.08, 0.265, 0.8, 0.30);
      await js(`(() => { const f = document.getElementById('markForm'); f.querySelector('input[value=green]').checked = true; f.requestSubmit(); })()`); await wait(1000);
      R.marksShown = await js(`[...document.querySelectorAll('#viewer .vmark')].map(m => m.className + ' @' + m.closest('.vpage').dataset.n)`);
      R.notesMenu = await js(`[...document.querySelectorAll('#viewer .vbar .ddbtn')].map(b => b.innerText.trim())`);
      await js(`document.querySelector('#viewer .vpage[data-n="1"]').scrollIntoView({ block: 'center' })`);
      await shot('m1-reader');
      // click a highlight to change it
      await js(`document.querySelector('#viewer .vmark.pink, #viewer .vmark.yellow').click()`); await wait(500);
      R.clickOpens = await js(`!!document.getElementById('markForm')`);
      await js(`document.querySelector('#markForm [data-action=close]').click()`); await wait(300);
      await js(`document.querySelector('[data-action=libViewClose]').click()`); await wait(800);
      // the document page lists them; search finds the note
      R.pageCard = await js(`[...document.querySelectorAll('.card h2')].map(h => h.innerText).find(t => t.includes('highlights'))`);
      R.pageList = await js(`[...document.querySelectorAll('[data-action=libMarkOpen]')].map(r => r.innerText.replace(/\\s+/g, ' '))`);
      await shot('m2-doc-page');
      R.search = await js(`window.keep.searchAll('pension').then(r => r.library.map(x => x.id).length)`);
      // bundle with highlights and notes
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(300);
      await js(`document.querySelector('#view .head .menu [data-action=libBundle]').click()`); await wait(600);
      await js(`(() => { const f = document.getElementById('bundleForm'); f.elements.marks.checked = true; f.requestSubmit(); })()`);
      for (let i = 0; i < 60 && !fs.existsSync(SAVE); i++) await wait(500);
      await wait(1500);
      R.contents = execFileSync('pdftotext', ['-f', '1', '-l', '1', SAVE, '-']).toString().replace(/\s+/g, ' ');
      execFileSync('pdftoppm', ['-r', '50', '-png', '-f', '2', '-l', '3', SAVE, path.join(OUT, 'm3-bundle')]);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
