'use strict';
// Hiding private details: what's found, that it's really gone from the PDF, and scanned pages via OCR.
const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const redact = require('../src/redact');
const doctext = require('../src/doctext');
const ocr = require('../src/ocr');

test('finds NI, bank, card, phone and email details and chosen words; leaves ordinary numbers', () => {
  const t = 'NI AB 12 34 56 C. Sort code 20-45-77, account 12345678. Card 4111 1111 1111 1111 (and 4111 1111 1111 1112 is not a card). ' +
    'Call 0121 496 0000 or +44 (0) 7700 900123. Email mark@example.co.uk. Child: Sam Smith. Your ref 2026/0042, 14 August 2026.';
  const all = { kinds: Object.keys(redact.KINDS), words: ['sam smith'] };
  const got = redact.findRanges(t, all).map(([a, b, k]) => k + ':' + t.slice(a, b)).sort();
  assert.deepStrictEqual(got, ['bank:12345678', 'bank:20-45-77', 'card:4111 1111 1111 1111', 'email:mark@example.co.uk', 'ni:AB 12 34 56 C', 'phone:+44 (0) 7700 900123', 'phone:0121 496 0000', 'words:Sam Smith'].sort());
  assert.strictEqual(redact.redactText('Ref AB123456C for Sam', { kinds: ['ni'], words: ['sam'] }), 'Ref █████████ for ███');
  assert.strictEqual(redact.active({ kinds: [], words: [' '] }), false);
  assert.strictEqual(redact.active({ kinds: [], words: ['Sam'] }), true);
});

async function textOf(bytes) {
  const lib = await doctext.pdfjs();
  const task = lib.getDocument(doctext.pdfOptions(Buffer.from(bytes))), doc = await task.promise;
  let t = '';
  for (let i = 1; i <= doc.numPages; i++) t += (await (await doc.getPage(i)).getTextContent()).items.map(x => x.str).join(' ');
  await task.destroy();
  return t;
}
// how dark a part of the redrawn page is (0 black … 255 white)
async function darkness(bytes, page, [x0, y0, x1, y1]) {
  const lib = await doctext.pdfjs();
  const task = lib.getDocument(doctext.pdfOptions(Buffer.from(bytes))), doc = await task.promise;
  const p = await doc.getPage(page), vp = p.getViewport({ scale: 1 });
  const { createCanvas } = doctext.canvasModule();
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height)), ctx = c.getContext('2d');
  await p.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
  await task.destroy();
  return s / (d.length / 4);
}

test('a PDF with text: the details are blacked out and gone from the text; the rest stays', async () => {
  const src = await PDFDocument.create(), f = await src.embedFont(StandardFonts.Helvetica);
  const p = src.addPage([595, 842]);
  p.drawText('Dear Mark,', { x: 60, y: 760, size: 14, font: f });
  p.drawText('Your NI number AB 12 34 56 C is on our records.', { x: 60, y: 720, size: 14, font: f });
  p.drawText('Call us on 0121 496 0000.', { x: 60, y: 680, size: 14, font: f });
  const r = await redact.redactPdf(await src.save(), { kinds: ['ni', 'phone'], words: [] }, {}, { width: 595 });
  assert.deepStrictEqual(r.found, { ni: 1, phone: 1 });
  assert.strictEqual(r.pages, 1);
  assert.strictEqual((await textOf(r.bytes)).trim(), '', 'no text left to copy out');
  // where "AB 12 34 56 C" was (y from the top: 842 - 720 ≈ 122)
  const x = 60 + f.widthOfTextAtSize('Your NI number ', 14);
  assert.ok(await darkness(r.bytes, 1, [Math.round(x) + 1, 110, Math.round(x + f.widthOfTextAtSize('AB 12 34 56 C', 14)) - 1, 122]) < 40, 'NI number covered');
  assert.ok(await darkness(r.bytes, 1, [62, 72, 120, 84]) > 150, '"Dear Mark" still there');
});

test('a scanned page with no text: the words are read off the picture and blacked out', { timeout: 120000 }, async () => {
  const { createCanvas } = doctext.canvasModule();
  const c = createCanvas(1240, 1754), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#111'; ctx.font = '44px sans-serif';
  ctx.fillText('Child Maintenance Service', 120, 200);
  ctx.fillText('National Insurance number: AB123456C', 120, 330);
  ctx.fillText('We will write again soon.', 120, 460);
  const src = await PDFDocument.create();
  const img = await src.embedPng(c.toBuffer('image/png'));
  src.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  const r = await redact.redactPdf(await src.save(), { kinds: ['ni'], words: [] }, { ocrWords: ocr.readWords });
  await ocr.stop();
  assert.strictEqual(r.scanned, 1);
  assert.deepStrictEqual(r.found, { ni: 1 });
  // AB123456C sat at about x 690–1000, y 290–335 of 1240×1754 → in points (×0.48)
  assert.ok(await darkness(r.bytes, 1, [345, 147, 420, 157]) < 60, 'NI number covered');
  assert.ok(await darkness(r.bytes, 1, [60, 85, 330, 98]) > 170, 'the heading is not covered');
});
