'use strict';
// Hide private details in a PDF before it's sent (used by Bundle PDF).
// Every page is redrawn as a picture with black boxes over what's hidden, so the hidden words are
// really gone: not just covered, and not left in the PDF's text where they could be copied out.
// Words are found in the PDF's own text, or, on scanned pages with no text, by reading the page (OCR).

const { PDFDocument } = require('pdf-lib');
const doctext = require('./doctext');

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = +digits[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
const KINDS = {
  ni: { label: 'National Insurance numbers', res: [/\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi] },
  bank: { label: 'Bank sort codes and account numbers', res: [/\b\d{2}[- ]\d{2}[- ]\d{2}\b/g, /\b\d{8}\b/g] },
  card: { label: 'Card numbers', res: [/\b(?:\d[ -]?){12,18}\d\b/g], ok: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); } },
  phone: { label: 'Phone numbers', res: [/(?:\+44 ?(?:\(0\) ?)?|\b0)\d(?:[ -]?\d){8,9}\b/g] },
  email: { label: 'Email addresses', res: [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi] }
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ranges [start, end, kind] to hide in a piece of text. opts: { kinds: ['ni', ...], words: ['Smith', ...] } */
function findRanges(text, opts) {
  const out = [];
  for (const k of opts.kinds || []) {
    const K = KINDS[k];
    if (!K) continue;
    for (const re of K.res) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) { if (!K.ok || K.ok(m[0])) out.push([m.index, m.index + m[0].length, k]); if (!m[0].length) re.lastIndex++; }
    }
  }
  for (const w of (opts.words || []).map(x => String(x).trim()).filter(x => x.length >= 2)) {
    const re = new RegExp(escRe(w).replace(/\s+/g, '\\s+'), 'gi');
    let m;
    while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length, 'words']);
  }
  // a match inside a longer one (a sort-code-like part of an NI number) isn't counted twice
  out.sort((x, y) => x[0] - y[0] || (y[1] - y[0]) - (x[1] - x[0]));
  const kept = [];
  for (const m of out) { const last = kept[kept.length - 1]; if (last && m[1] <= last[1]) continue; kept.push(m); }
  return kept;
}
/** The same text with hidden parts blacked out (for the contents page and the page footer). */
function redactText(text, opts) {
  const s = String(text || '');
  const rs = findRanges(s, opts).sort((a, b) => a[0] - b[0]);
  let out = '', i = 0;
  for (const [a, b] of rs) { if (b <= i) continue; out += s.slice(i, Math.max(i, a)) + '█'.repeat(Math.min(12, b - Math.max(i, a))); i = b; }
  return out + s.slice(i);
}
const active = (opts) => !!opts && ((opts.kinds || []).length > 0 || (opts.words || []).some(w => String(w).trim().length >= 2));

/** Join pieces of text (each with its box) into one string, remembering where each piece is. */
function joinPieces(pieces) {
  let text = '';
  const spans = [];
  for (const p of pieces) {
    if (text && !/\s$/.test(text)) text += ' ';
    spans.push({ start: text.length, end: text.length + p.str.length, p });
    text += p.str;
  }
  return { text, spans };
}
/** Boxes to black out for these ranges; part of a piece gets the matching part of its box. */
function boxesFor(ranges, spans) {
  const boxes = [];
  for (const [a, b] of ranges) {
    for (const s of spans) {
      if (s.end <= a || s.start >= b) continue;
      const len = Math.max(1, s.end - s.start);
      const i0 = Math.max(0, a - s.start), i1 = Math.min(len, b - s.start);
      const frac = s.p.frac || ((i) => i / len);
      const f0 = s.p.whole ? 0 : frac(i0), f1 = s.p.whole ? 1 : frac(i1);
      const { x0, y0, x1, y1 } = s.p;
      // part of a line: widths are worked out, not exact, so reach a little further each side
      const slack = s.p.whole ? 0 : (y1 - y0) * 0.3;
      boxes.push({ x0: x0 + (x1 - x0) * f0 - (i0 > 0 ? slack : 0), x1: x0 + (x1 - x0) * f1 + (i1 < len ? slack : 0), y0, y1 });
    }
  }
  return boxes;
}

/**
 * @param bytes  a PDF
 * @param opts   { kinds, words }
 * @param tools  { ocrWords(png) -> [{ text, x0, y0, x1, y1 }] }  (pixels of that picture)
 * @returns { bytes, found: { kind: count }, pages, scanned }
 */
async function redactPdf(bytes, opts, tools = {}, { width = 1650, quality = 82 } = {}) {
  const lib = await doctext.pdfjs();
  const task = lib.getDocument(doctext.pdfOptions(Buffer.from(bytes)));
  const doc = await task.promise;
  const out = await PDFDocument.create();
  const { createCanvas } = doctext.canvasModule();
  const found = {};
  let scanned = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / vp1.width });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      // the page's own text, with a box for each piece
      const tc = await page.getTextContent();
      const pieces = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const [, , c, d, e, f] = it.transform, h = Math.hypot(c, d) || 10;
        const [A, B, C, D, E, Fv] = vp.transform, pt = (x, y) => [A * x + C * y + E, B * x + D * y + Fv];
        const p1 = pt(e, f - h * 0.25), p2 = pt(e + (it.width || h * it.str.length * 0.5), f + h * 0.95);
        // where each letter starts, measured in a similar font (letters aren't all the same width)
        const str = it.str;
        const frac = (i) => { ctx.font = '40px Helvetica, Arial, "Liberation Sans", sans-serif'; const all = ctx.measureText(str).width || 1; return Math.min(1, ctx.measureText(str.slice(0, i)).width / all); };
        pieces.push({ str, frac, x0: Math.min(p1[0], p2[0]), x1: Math.max(p1[0], p2[0]), y0: Math.min(p1[1], p2[1]), y1: Math.max(p1[1], p2[1]) });
      }
      let boxes = [];
      const own = joinPieces(pieces);
      const rangesOwn = findRanges(own.text, opts);
      boxes.push(...boxesFor(rangesOwn, own.spans));
      rangesOwn.forEach(r => { found[r[2]] = (found[r[2]] || 0) + 1; });
      if (own.text.replace(/\s/g, '').length < 40 && tools.ocrWords) { // a scan: read the words off the picture
        scanned++;
        const words = (await tools.ocrWords(canvas.toBuffer('image/png'))).filter(w => w.text && w.text.trim());
        const ocr = joinPieces(words.map(w => ({ str: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, whole: true })));
        const rangesOcr = findRanges(ocr.text, opts);
        boxes.push(...boxesFor(rangesOcr, ocr.spans));
        rangesOcr.forEach(r => { found[r[2]] = (found[r[2]] || 0) + 1; });
      }
      ctx.fillStyle = '#000';
      const pad = Math.max(2, Math.round(width / 600));
      for (const b of boxes) ctx.fillRect(Math.floor(b.x0 - pad), Math.floor(b.y0 - pad), Math.ceil(b.x1 - b.x0 + 2 * pad), Math.ceil(b.y1 - b.y0 + 2 * pad));
      const jpg = await out.embedJpg(canvas.toBuffer('image/jpeg', quality));
      const p = out.addPage([vp1.width, vp1.height]);
      p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return { bytes: await out.save(), found, pages: out.getPageCount(), scanned };
}

module.exports = { KINDS, findRanges, redactText, redactPdf, active };
