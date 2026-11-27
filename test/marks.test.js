'use strict';
// Highlights and notes on PDF pages: kept, searched, the words under them, and drawn in bundles.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const { Store } = require('../src/store');
const viewer = require('../src/viewer');
const bundle = require('../src/bundle');
const doctext = require('../src/doctext');

async function letterPdf(rotate = 0) {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595, 842]);
  p.drawText('Child Maintenance Service', { x: 60, y: 760, size: 14, font: f });
  p.drawText('Your income is 52,000 a year.', { x: 60, y: 600, size: 14, font: f });
  p.drawText('Please reply by 1 December.', { x: 60, y: 400, size: 14, font: f });
  if (rotate) p.setRotation(degrees(rotate));
  return Buffer.from(await d.save());
}
// the colour at a point given as fractions of the page as shown
async function colourAt(bytes, pageNo, u, v) {
  const lib = await doctext.pdfjs();
  const task = lib.getDocument(doctext.pdfOptions(Buffer.from(bytes))), doc = await task.promise;
  const p = await doc.getPage(pageNo), vp = p.getViewport({ scale: 1 });
  const { createCanvas } = doctext.canvasModule();
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height)), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
  const px = ctx.getImageData(Math.round(u * vp.width), Math.round(v * vp.height), 1, 1).data;
  await task.destroy();
  return [px[0], px[1], px[2]];
}
const isYellow = ([r, g, b]) => r > 230 && g > 200 && b < 200; // a 38% yellow tint over white

test('marks: kept with the entry, checked, searched, and removed with their file', () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'osmarks-'))); s.load();
  const e = s.saveLibraryEntry({ kind: 'document', title: 'Decision' });
  const f = s.addLibraryFile(e.id, 'd.pdf', Buffer.from('%PDF-1.4 x'));
  assert.throws(() => s.addMark(e.id, { fileId: f.id, page: 1, x0: 0.1, x1: 0.1, y0: 0.1, y1: 0.2 }), /too small/);
  assert.throws(() => s.addMark(e.id, { fileId: 'nope', page: 1, x0: 0, x1: 0.5, y0: 0, y1: 0.5 }), /not found/);
  const m = s.addMark(e.id, { fileId: f.id, page: 2, x0: 0.6, x1: 0.1, y0: 0.3, y1: 0.35, color: 'purple', text: 'income is 52,000', note: '' });
  assert.deepStrictEqual([m.x0, m.x1, m.color, m.page], [0.1, 0.6, 'yellow', 2], 'corners put in order, unknown colour → yellow');
  s.updateMark(e.id, m.id, { note: 'Wrong: my pension is less', color: 'pink' });
  assert.strictEqual(s.getLibraryEntry(e.id).marks[0].note, 'Wrong: my pension is less');
  assert.ok(s.librarySearch('document', 'pension').some(x => x.id === e.id), 'notes are searched');
  assert.ok(s.librarySearch('document', '52,000').some(x => x.id === e.id), 'highlighted words are searched');
  s.saveLibraryEntry({ id: e.id, title: 'Decision letter' });
  assert.strictEqual(s.getLibraryEntry(e.id).marks.length, 1, 'editing details keeps highlights');
  s.removeLibraryFile(e.id, f.id);
  assert.strictEqual(s.getLibraryEntry(e.id).marks.length, 0);
});

test('the words under a highlight are read from the page', async () => {
  const buf = await letterPdf();
  // "Your income…" sits at y 600 of 842 → about 0.27–0.30 down the page
  assert.strictEqual(await viewer.pdfTextIn('t1', buf, 1, { x0: 0.05, x1: 0.9, y0: 0.26, y1: 0.31 }), 'Your income is 52,000 a year.');
  assert.strictEqual(await viewer.pdfTextIn('t1', buf, 1, { x0: 0.05, x1: 0.9, y0: 0.45, y1: 0.5 }), '');
  viewer.clear();
});

test('bundles: highlights drawn where they were (also on turned pages), notes on the contents page', async () => {
  const html = [];
  const renderHtml = async (h) => { html.push(h); const d = await PDFDocument.create(); d.addPage([595, 842]); return d.save(); };
  const files = { a: { name: 'a.pdf', buffer: await letterPdf() }, b: { name: 'b.pdf', buffer: await letterPdf(90) } };
  const k = { x0: 0.08, x1: 0.6, y0: 0.26, y1: 0.31, color: 'yellow' };
  const entries = [{ id: 'e1', title: 'Decision', docDate: '2026-01-01', files: [{ id: 'a', name: 'a.pdf' }, { id: 'b', name: 'b.pdf' }],
    marks: [Object.assign({ id: 'm1', fileId: 'a', page: 1, note: 'This figure is wrong' }, k), Object.assign({ id: 'm2', fileId: 'b', page: 1, note: '' }, k)] }];
  const r = await bundle.buildBundle({ entries, readFile: (_e, f) => files[f], renderHtml, viewer, marks: true, numbers: false });
  assert.strictEqual(r.pages, 3);
  assert.ok(isYellow(await colourAt(r.bytes, 2, 0.5, 0.285)), 'highlight on page 2');
  assert.deepStrictEqual(await colourAt(r.bytes, 2, 0.5, 0.6), [255, 255, 255], 'nothing elsewhere');
  assert.ok(isYellow(await colourAt(r.bytes, 3, 0.5, 0.285)), 'highlight in the same place on the turned page');
  assert.match(html.filter(h => h.includes('Contents ·')).pop(), /p\.2: This figure is wrong/);
  // without the option, nothing is drawn
  const plain = await bundle.buildBundle({ entries, readFile: (_e, f) => files[f], renderHtml, viewer, numbers: false });
  assert.deepStrictEqual(await colourAt(plain.bytes, 2, 0.5, 0.285).then(c => isYellow(c)), false);
});
