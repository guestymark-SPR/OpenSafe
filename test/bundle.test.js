'use strict';
// Bundle PDF: order, contents page, page numbers (also on turned pages), and files left out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument, degrees } = require('pdf-lib');
const bundle = require('../src/bundle');
const viewer = require('../src/viewer');
const doctext = require('../src/doctext');

const FX = path.join(__dirname, 'fixtures', 'library');
const fx = (n) => fs.readFileSync(path.join(FX, n));

// Stand-in for Electron's printToPDF: one page per 40 table rows (contents) or one page otherwise,
// with the HTML's text kept so tests can see what was drawn.
const rendered = [];
async function renderHtml(html) {
  rendered.push(html);
  const d = await PDFDocument.create();
  const rows = (html.match(/<tr>/g) || []).length;
  const n = /<h1>[^<]*<\/h1><div class="muted">Contents/.test(html) ? Math.max(1, Math.ceil(rows / 40)) : 1;
  for (let i = 0; i < n; i++) d.addPage([595.28, 841.89]);
  return d.save();
}
async function pageTexts(bytes) {
  const lib = await doctext.pdfjs();
  const task = lib.getDocument(doctext.pdfOptions(Buffer.from(bytes))), doc = await task.promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    out.push({ text: tc.items.map(x => x.str).join(' '), items: tc.items, rotate: p.rotate });
  }
  await task.destroy();
  return out;
}

function lib(entries) {
  const files = {};
  const list = entries.map((e, i) => {
    const id = 'e' + i;
    const fl = e.files.map((f, j) => { const fid = id + 'f' + j; files[id + '/' + fid] = { name: f.name, buffer: f.buffer }; return { id: fid, name: f.name }; });
    return Object.assign({ id, createdAt: `2026-01-0${i + 1}T00:00:00Z` }, e, { files: fl });
  });
  const readFile = (id, fid) => { const f = files[id + '/' + fid]; if (!f) { const e = new Error('vault'); e.code = 'VAULT_LOCKED'; throw e; } return f; };
  return { list, readFile };
}

test('entries go in date order, undated last, with a contents page that lists the right pages', async () => {
  const text = await PDFDocument.load(fx('text.pdf')), statement = await PDFDocument.load(fx('statement.pdf'));
  const { list, readFile } = lib([
    { title: 'Reply from MP', from: 'House of Commons', docDate: '2026-09-10', files: [{ name: 'reply.pdf', buffer: fx('statement.pdf') }] },
    { title: 'Undated note', files: [{ name: 'note.png', buffer: fx('letter.png') }] },
    { title: 'First letter', from: 'Child Maintenance Service', docDate: '2026-03-02', ref: 'CMS 12345', files: [{ name: 'a.pdf', buffer: fx('text.pdf') }, { name: 'b.png', buffer: fx('letter.png') }] }
  ]);
  rendered.length = 0;
  const r = await bundle.buildBundle({ entries: list, readFile, renderHtml, viewer, title: 'Appeal bundle — CMS', now: new Date('2026-11-27') });
  const expectBody = text.getPageCount() + 1 + statement.getPageCount() + 1;
  assert.strictEqual(r.pages, 1 + expectBody);
  assert.strictEqual(r.front, 1);
  assert.deepStrictEqual(r.rows.map(x => x.title), ['First letter', 'Reply from MP', 'Undated note']);
  assert.deepStrictEqual(r.rows.map(x => x.start), [2, 2 + text.getPageCount() + 1, 2 + text.getPageCount() + 1 + statement.getPageCount()]);
  assert.deepStrictEqual(r.skipped, []);
  // the contents page that went in lists those same pages
  const contents = rendered.filter(h => h.includes('Contents ·')).pop();
  assert.match(contents, /First letter[\s\S]*Ref: CMS 12345[\s\S]*>2–3</);
  assert.match(contents, /<td class="d">—<\/td><td><\/td>\s*<td>Undated note/, 'no date shows a dash');
  assert.match(contents, new RegExp(`${r.pages} pages`));
  // every page is numbered, title first
  const pages = await pageTexts(r.bytes);
  pages.forEach((p, i) => assert.ok(p.text.includes(`Page ${i + 1} of ${r.pages}`), `page ${i + 1}: ${p.text.slice(-80)}`));
  assert.ok(pages[0].text.includes('Appeal bundle - CMS'), 'the long dash becomes one the PDF font has');
});

test('newest first, and no contents or numbers when switched off', async () => {
  const { list, readFile } = lib([
    { title: 'Old', docDate: '2025-01-01', files: [{ name: 'o.png', buffer: fx('letter.png') }] },
    { title: 'New', docDate: '2026-01-01', files: [{ name: 'n.png', buffer: fx('letter.png') }] }
  ]);
  const r = await bundle.buildBundle({ entries: list, readFile, renderHtml, viewer, order: 'newest', contents: false, numbers: false });
  assert.deepStrictEqual(r.rows.map(x => x.title), ['New', 'Old']);
  assert.strictEqual(r.pages, 2); assert.strictEqual(r.front, 0);
  const pages = await pageTexts(r.bytes);
  assert.ok(!pages.some(p => /Page \d+ of/.test(p.text)));
});

test('a long contents list that runs onto a second page shifts the page numbers it lists', async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ title: 'Letter ' + (i + 1), docDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, files: [{ name: 'p.png', buffer: fx('letter.png') }] }));
  const { list, readFile } = lib(many);
  rendered.length = 0;
  const r = await bundle.buildBundle({ entries: list, readFile, renderHtml, viewer });
  assert.strictEqual(r.front, 2);
  assert.strictEqual(r.pages, 47);
  assert.strictEqual(r.rows[0].start, 3);
  assert.match(rendered.filter(h => h.includes('Contents ·')).pop(), /47 pages/);
});

test('emails, Word and Excel files become pages; files that can\'t are listed as left out', async () => {
  const { list, readFile } = lib([
    { title: 'Emails', docDate: '2026-02-01', files: [{ name: 'mail.eml', buffer: fx('mail.eml') }, { name: 'o.msg', buffer: fx('outlook-inline.msg') }] },
    { title: 'Office', docDate: '2026-02-02', files: [{ name: 'tenancy.docx', buffer: fx('tenancy.docx') }, { name: 'costs.xlsx', buffer: fx('costs.xlsx') }, { name: 'clip.mp4', buffer: Buffer.from('not really a video') }, { name: 'gone.pdf' }] }
  ]);
  list[1].files[3].id = 'missing';
  rendered.length = 0;
  const r = await bundle.buildBundle({ entries: list, readFile, renderHtml, viewer });
  assert.strictEqual(r.rows[0].pages, 2);
  assert.strictEqual(r.rows[1].pages, 2);
  assert.strictEqual(r.skipped.length, 2);
  assert.match(r.skipped[0], /clip\.mp4 \(this kind of file can't go in a PDF\)/);
  assert.match(r.skipped[1], /gone\.pdf \(in the locked vault\)/);
  const pagesHtml = rendered.filter(h => !h.includes('Contents ·'));
  assert.ok(pagesHtml.every(h => h.includes("default-src 'none'; img-src data:")), 'nothing can load from the internet');
  assert.ok(pagesHtml[0].includes('<b>From:</b>'), 'emails get a header');
  assert.ok(pagesHtml.some(h => h.includes('<table class="sheet">')), 'spreadsheet drawn as a table');
  assert.match(rendered.find(h => h.includes('Contents ·')), /Not included: clip\.mp4, gone\.pdf/);
});

test('page numbers sit the right way up on turned (rotated) pages', async () => {
  const src = await PDFDocument.create();
  for (const a of [0, 90, 180, 270]) { const p = src.addPage([595.28, 841.89]); p.setRotation(degrees(a)); }
  const { list, readFile } = lib([{ title: 'Turned', docDate: '2026-01-01', files: [{ name: 't.pdf', buffer: Buffer.from(await src.save()) }] }]);
  const r = await bundle.buildBundle({ entries: list, readFile, renderHtml, viewer, contents: false, title: 'T' });
  const pages = await pageTexts(r.bytes);
  for (const [i, p] of pages.entries()) {
    const it = p.items.find(x => /Page \d of 4/.test(x.str));
    assert.ok(it, 'number on page ' + (i + 1));
    // the text's direction, turned by the page's own rotation, must read left to right on screen
    const [a, b] = it.transform; const textAngle = Math.round(Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    // a page turned clockwise by R shows text drawn at angle A at (A - R), so A must equal R
    assert.strictEqual(textAngle, p.rotate, `page ${i + 1}: page turned ${p.rotate}, text at ${textAngle}`);
  }
});

test('nothing usable is an error, not an empty PDF', async () => {
  const { list, readFile } = lib([{ title: 'Video', files: [{ name: 'v.mp4', buffer: Buffer.from('x') }] }]);
  await assert.rejects(bundle.buildBundle({ entries: list, readFile, renderHtml, viewer }), /None of the chosen files/);
  await assert.rejects(bundle.buildBundle({ entries: [], readFile, renderHtml, viewer }), /at least one/);
});
