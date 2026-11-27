'use strict';
// Statement builder and filling in PDF forms, through the window.
// Run: xvfb-run -a npx electron --no-sandbox test/statement-forms-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, dialog } = require('electron');
const { PDFDocument, PDFName, PDFHexString, StandardFonts } = require('pdf-lib');
const mammoth = require('mammoth');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/statement-forms-e2e';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osstmt-'));
process.env.OPENSAFE_DATA_DIR = dir;
dialog.showMessageBox = async () => ({ response: 0 });

async function letter(text) { const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica); const p = d.addPage([595, 842]); p.drawText(text, { x: 60, y: 600, size: 13, font: f }); return Buffer.from(await d.save()); }
async function form() {
  const d = await PDFDocument.create(), f = d.getForm(), font = await d.embedFont(StandardFonts.Helvetica), p = d.addPage([595, 842]);
  [['Your full name', 760], ['Address line 1', 720], ['Postcode', 680], ['National Insurance number', 640], ['Date', 600]].forEach(([tip, y], i) => {
    p.drawText(tip, { x: 50, y: y + 4, size: 11, font });
    const t = f.createTextField('topmostSubform[0].Page1[0].T' + i + '[0]'); t.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tip)); t.addToPage(p, { x: 260, y, width: 260, height: 20 });
  });
  p.drawText('I agree', { x: 50, y: 564, size: 11, font }); f.createCheckBox('Agree').addToPage(p, { x: 260, y: 560, width: 14, height: 14 });
  return Buffer.from(await d.save());
}

(async () => {
  const s = new Store(dir); s.load();
  s.data.settings.letterFrom = { name: 'Mark Example', address: '1 High Street\nSheldon\nBirmingham B26 1AA', phone: '07700 900123', email: '' };
  const a = s.saveLibraryEntry({ kind: 'document', title: 'Calculation decision', from: 'Child Maintenance Service', ref: '12345 678', docDate: '2026-02-01', caseName: 'CMS recalculation' });
  const fa = s.addLibraryFile(a.id, 'decision.pdf', await letter('We have worked out your income as 52,000 a year.'));
  s.addMark(a.id, { fileId: fa.id, page: 1, x0: 0.05, x1: 0.9, y0: 0.26, y1: 0.31, text: 'We have worked out your income as 52,000 a year.', note: 'That was my Army salary, not my pension' });
  s.saveLibraryEntry({ kind: 'document', title: 'My appeal', from: 'Child Maintenance Service', sent: true, docDate: '2026-03-01', expectBy: '2026-03-29', caseName: 'CMS recalculation' });
  const fe = s.saveLibraryEntry({ kind: 'document', title: 'Appeal form', docType: 'Benefits & pension' });
  s.addLibraryFile(fe.id, 'appeal-form.pdf', await form());
  require('../src/main.js');
})();

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const filesOf = async (id) => { const e = await js(`window.keep.libGet(${JSON.stringify(id)})`); return e.files.map(f => ({ name: f.name, path: path.join(dir, 'attachments', id, f.file) })); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // ---- 61: statement from the case
      await js(`window.location.hash = ''; document.querySelector('[data-nav=docs]').click()`); await wait(600);
      await js(`document.querySelector('[data-action=libMode][data-v=cases]').click()`); await wait(400);
      await js(`document.querySelector('.casecard').click()`); await wait(700);
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(300);
      await js(`document.querySelector('#view .head .menu [data-action=libStatementNew]').click()`); await wait(900);
      R.draft = await js(`document.getElementById('stForm').elements.text.value`);
      await shot('f1-statement-draft');
      await js(`(() => { const el = document.getElementById('stForm').elements; el.text.value = el.text.value.replace(/\\[Add anything else[^\\]]*\\]/, 'On 15 April 2026 I phoned the CMS and was told my appeal was still waiting.'); el.fmtPdf.checked = true; document.getElementById('stForm').requestSubmit(); })()`);
      await wait(4000);
      R.stPage = await js(`document.querySelector('.libhead').innerText.replace(/\\s+/g, ' ')`);
      const sid = await js(`window.keep.getData().then(d => d.data.library.find(x => x.statement).id)`);
      const sf = await filesOf(sid);
      R.stFiles = sf.map(f => f.name);
      R.stWord = (await mammoth.extractRawText({ path: sf.find(f => f.name.endsWith('.docx')).path })).value.split('\n').filter(Boolean).slice(0, 8);
      execFileSync('pdftoppm', ['-r', '50', '-png', '-singlefile', sf.find(f => f.name.endsWith('.pdf')).path, path.join(OUT, 'f2-statement-pdf')]);
      // the statement doesn't put itself into the next draft
      R.redraft = await js(`window.keep.statementDraft('CMS recalculation').then(d => d.count)`);
      // ---- 62: fill in a form
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      await js(`document.querySelector('[data-action=libMode][data-v=list]') && document.querySelector('[data-action=libMode][data-v=list]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes('Appeal form')).click()`); await wait(800);
      await js(`document.querySelector('#libFiles .menuwrap [data-action=moreMenu]').click()`); await wait(300);
      await js(`document.querySelector('#libFiles [data-action=libFormFill]').click()`); await wait(1200);
      R.form = await js(`[...document.querySelectorAll('#ffForm .frow')].map(r => r.querySelector('span').innerText.replace(/\\s+/g, ' ') + ' = ' + (r.querySelector('input,select').type === 'checkbox' ? r.querySelector('input').checked : r.querySelector('input,select').value))`);
      await shot('f3-form');
      await js(`(() => { const rows = [...document.querySelectorAll('#ffForm .frow')]; rows.find(r => r.innerText.includes('National Insurance')).querySelector('input').value = 'AB123456C'; rows.find(r => r.innerText.includes('Agree')).querySelector('input').checked = true; document.getElementById('ffForm').requestSubmit(); })()`);
      await wait(2500);
      const ff = await filesOf(await js(`window.keep.getData().then(d => d.data.library.find(x => x.title === 'Appeal form').id)`));
      R.formFiles = ff.map(f => f.name);
      const filled = ff.find(f => f.name.includes('filled in'));
      R.filledValues = (await require('../src/pdfform').read(fs.readFileSync(filled.path))).fields.map(f => f.label + '=' + f.value);
      execFileSync('pdftoppm', ['-r', '60', '-png', '-singlefile', filled.path, path.join(OUT, 'f4-filled')]);
      // next time, the NI number is offered from before
      const eid = await js(`window.keep.getData().then(d => d.data.library.find(x => x.title === 'Appeal form').id)`);
      const firstId = await js(`window.keep.libGet(${JSON.stringify(eid)}).then(e => e.files[0].id)`);
      R.remembered = await js(`window.keep.formRead(${JSON.stringify(eid)}, ${JSON.stringify(firstId)}).then(r => r.fields.find(f => f.label.includes('National')).suggest)`);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
