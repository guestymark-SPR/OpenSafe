'use strict';
// Reply writer and hiding private details in a bundle, through the window.
// Run: xvfb-run -a npx electron --no-sandbox test/letters-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, dialog, shell } = require('electron');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const mammoth = require('mammoth');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/letters-e2e';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osletters-'));
process.env.OPENSAFE_DATA_DIR = dir;
const SAVE = path.join(OUT, 'bundle.pdf');
try { fs.unlinkSync(SAVE); } catch (_) {}
const msgs = [];
dialog.showMessageBox = async (_w, o) => { msgs.push(o.message + ' | ' + (o.detail || '')); return { response: 0 }; };
dialog.showSaveDialog = async () => ({ canceled: false, filePath: SAVE });
shell.openPath = async () => '';
const pdftext = (f) => execFileSync('pdftotext', ['-layout', f, '-']).toString();

(async () => {
  const src = await PDFDocument.create(), font = await src.embedFont(StandardFonts.Helvetica);
  const p = src.addPage([595, 842]);
  ['Child Maintenance Service', 'Annual review', 'Dear Mark,', 'National Insurance number: AB 12 34 56 C', 'Child: Sam Smith', 'Please tell us about any change in income.']
    .forEach((t, i) => p.drawText(t, { x: 60, y: 760 - i * 30, size: 13, font }));
  const s = new Store(dir); s.load();
  const e = s.saveLibraryEntry({ kind: 'document', title: 'Annual review', from: 'Child Maintenance Service', docDate: '2026-11-10', ref: '12345 678', caseName: 'CMS recalculation' });
  s.addLibraryFile(e.id, 'annual-review.pdf', Buffer.from(await src.save()));
  require('../src/main.js');
})();

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const more = async (action) => { await js(`document.querySelector('#view .head [data-action=moreMenu], .libhead [data-action=moreMenu]').click()`); await wait(300); await js(`[...document.querySelectorAll('[data-action=${action}]')].find(b => b.offsetParent).click()`); await wait(700); };
    const filesOf = async (id) => { const e = await js(`window.keep.libGet(${JSON.stringify(id)})`); return e.files.map(f => ({ name: f.name, path: path.join(dir, 'attachments', id, f.file) })); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(600);
      await js(`document.querySelector('#libList tbody tr').click()`); await wait(800);
      // ---- 43: write a reply
      await more('libLetterReply');
      R.draft = await js(`(() => { const el = document.getElementById('letterForm').elements; return { to: el.toName.value, ref: el.yourRef.value, theirDate: el.theirDate.value, subject: el.subject.value, body: el.body.value, caseName: el.caseName.value, expect: el.expect.value, yourDetailsOpen: document.querySelector('#letterForm details').open }; })()`);
      await js(`(() => { const el = document.getElementById('letterForm').elements;
        el.fromName.value = 'Mark Example'; el.fromAddress.value = '1 High Street\\nSheldon\\nBirmingham B26 1AA';
        el.toAddress.value = 'PO Box 249\\nMitcheldean\\nGL14 9AJ';
        el.body.value += 'Since 1 May 2026 my income is my Armed Forces pension and EDP, not my Army salary.\\n\\nPlease recalculate from that date.'; })()`);
      await shot('l1-reply-form');
      await js(`document.getElementById('letterForm').requestSubmit()`); await wait(4000);
      R.page = await js(`document.querySelector('.libhead').innerText.replace(/\\s+/g, ' ')`);
      const newId = await js(`(window.keep.getData().then(d => d.data.library.find(x => x.sent).id))`);
      let fl = await filesOf(newId);
      R.files = fl.map(f => f.name);
      const pdf = fl.find(f => f.name.endsWith('.pdf')), docx = fl.find(f => f.name.endsWith('.docx'));
      R.pdfText = pdftext(pdf.path).replace(/[ \t]+/g, ' ').split('\n').map(l => l.trim()).filter(Boolean);
      R.docxText = (await mammoth.extractRawText({ path: docx.path })).value.split('\n').filter(Boolean);
      await shot('l2-letter-saved');
      execFileSync('pdftoppm', ['-r', '60', '-png', '-singlefile', pdf.path, path.join(OUT, 'l3-letter-page')]);
      // ---- change it: the files are replaced
      await more('libLetterEdit');
      await js(`(() => { const el = document.getElementById('letterForm').elements; el.body.value = el.body.value.replace('Please recalculate', 'Please urgently recalculate'); document.getElementById('letterForm').requestSubmit(); })()`); await wait(4000);
      fl = await filesOf(newId);
      R.afterEdit = { files: fl.length, changed: pdftext(fl.find(f => f.name.endsWith('.pdf')).path).includes('urgently') };
      // ---- next time, your details and their address are remembered
      R.remembered = await js(`window.keep.letterDraft('').then(d => [d.letter.fromName, d.addresses['child maintenance service']])`);
      // ---- the case: both letters, the reply waiting
      await js(`document.querySelector('.libhead [data-action=libCaseOpen]').click()`); await wait(700);
      R.case = await js(`[...document.querySelectorAll('.titem')].map(t => t.innerText.replace(/\\s+/g, ' '))`);
      await shot('l4-case');
      // ---- 44: bundle with private details hidden
      await js(`document.querySelector('#view .head [data-action=libBundle]').click()`); await wait(600);
      R.bundleTitle = await js(`document.getElementById('bundleForm').elements.title.value`);
      await js(`(() => { const f = document.getElementById('bundleForm'); f.querySelector('.hidebox').open = true; f.elements.hide_ni.checked = true; f.elements.hideWords.value = 'Sam Smith'; })()`);
      await shot('l5-bundle-hide');
      await js(`document.getElementById('bundleForm').requestSubmit()`);
      for (let i = 0; i < 120 && !fs.existsSync(SAVE); i++) await wait(500);
      await wait(2500);
      R.messages = msgs.slice();
      const bt = pdftext(SAVE);
      R.bundle = { hasNI: /AB ?12 ?34 ?56 ?C/.test(bt), hasName: /Sam Smith/.test(bt), textChars: bt.replace(/\s/g, '').length };
      execFileSync('pdftoppm', ['-r', '50', '-png', '-f', '2', '-l', '2', SAVE, path.join(OUT, 'l6-bundle-page')]);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
