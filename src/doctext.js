'use strict';
// Reads the text inside stored files so Documents and Data can be searched. Fully offline.
// PDF: pdf.js (Mozilla, Apache-2.0); pages with no text layer (scans) are drawn and read with Tesseract.
// Word/Excel/PowerPoint/OpenDocument: the XML inside the zip. Emails (.eml): the message text.
// Photos and scans: Tesseract (src/ocr.js).
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const ocr = require('./ocr');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.pbm']);
const PLAIN = new Set(['.txt', '.csv', '.tsv', '.md', '.json', '.xml', '.log', '.ini', '.vcf', '.ics']);
const MAX_PDF_PAGES = 300;
const MAX_OCR_PAGES = 40; // scanned PDF pages read per file

// ---------- zip (docx, xlsx, pptx, odt, ods) ----------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    files.set(name, () => {
      if (usize > 200 * 1048576) throw new Error('Too large');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.slice(start, start + csize);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 200 * 1048576 }) : Buffer.alloc(0);
    });
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', copy: '©' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (_) { return m; } }
    return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
  });
}
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
function xmlText(xml, paraTags) {
  let s = xml.replace(new RegExp(`</(${paraTags})>`, 'g'), '\n').replace(/<(w:tab|text:tab)\b[^>]*\/>/g, '\t').replace(/<(w:br|text:line-break|a:br)\b[^>]*\/>/g, '\n');
  return tidy(decodeEntities(s.replace(/<[^>]+>/g, '')));
}
function officeText(buf, ext) {
  const z = unzip(buf);
  const read = (n) => (z.get(n) ? z.get(n)().toString('utf8') : '');
  if (ext === '.docx' || ext === '.docm') return ['word/document.xml', ...[...z.keys()].filter(n => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n))].map(n => xmlText(read(n), 'w:p')).filter(Boolean).join('\n\n');
  if (ext === '.xlsx' || ext === '.xlsm') {
    const shared = read('xl/sharedStrings.xml');
    const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '')));
    const sheets = [...z.keys()].filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    const nums = sheets.map(n => [...read(n).matchAll(/<c\b[^>]*?(?:t="(\w+)")?[^>]*>(?:<f>[\s\S]*?<\/f>)?<v>([^<]*)<\/v>/g)].map(m => (m[1] === 's' ? '' : m[2])).filter(Boolean).join(' ')).join('\n');
    const inline = sheets.map(n => [...read(n).matchAll(/<is>([\s\S]*?)<\/is>/g)].map(m => decodeEntities(m[1].replace(/<[^>]+>/g, ''))).join('\n')).join('\n');
    return tidy([strings.join('\n'), inline, nums].join('\n'));
  }
  if (ext === '.pptx') return [...z.keys()].filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).map(n => xmlText(read(n), 'a:p')).join('\n\n');
  if (ext === '.odt' || ext === '.ods' || ext === '.odp') return xmlText(read('content.xml'), 'text:p|text:h|table:table-row');
  return '';
}

// ---------- email (.eml) ----------
function decodeWords(s) { // =?utf-8?B?...?= and =?utf-8?Q?...?=
  return String(s || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : qp(data.replace(/_/g, ' '));
      return charset(bytes, cs);
    } catch (_) { return m; }
  });
}
function qp(s) {
  const out = []; const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { out.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
function charset(bytes, cs) {
  const c = String(cs || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(c === 'us-ascii' ? 'utf-8' : c).decode(bytes); } catch (_) { return bytes.toString('utf8'); }
}
function splitPart(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i), body = i < 0 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const m = line.match(/^([\w-]+):\s*(.*)$/); if (m && !(m[1].toLowerCase() in headers)) headers[m[1].toLowerCase()] = m[2]; }
  return { headers, body };
}
const param = (h, name) => { const m = String(h || '').match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i')); return m ? m[1] : ''; };
function partText(raw, depth = 0) {
  const { headers, body } = splitPart(raw);
  const type = (headers['content-type'] || 'text/plain').toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const b = param(headers['content-type'], 'boundary');
    if (!b) return { plain: '', html: '', files: [] };
    const parts = body.split('--' + b).slice(1).filter(p => !p.startsWith('--'));
    const res = { plain: '', html: '', files: [] };
    for (const p of parts) {
      const r = partText(p.replace(/^\r?\n/, ''), depth + 1);
      if (r.plain && (!res.plain || !type.includes('alternative'))) res.plain += (res.plain ? '\n\n' : '') + r.plain;
      if (r.html) res.html += r.html;
      res.files.push(...r.files);
    }
    return res;
  }
  const disp = headers['content-disposition'] || '';
  const fname = decodeWords(param(disp, 'filename') || param(headers['content-type'], 'name'));
  if (/attachment/i.test(disp) || (fname && !type.startsWith('text/'))) return { plain: '', html: '', files: [fname || 'attachment'] };
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? qp(body) : Buffer.from(body, 'latin1');
  const text = charset(bytes, param(headers['content-type'], 'charset') || 'utf-8');
  if (type.startsWith('text/html')) return { plain: '', html: text, files: [] };
  if (type.startsWith('text/')) return { plain: text, html: '', files: [] };
  return { plain: '', html: '', files: [] };
}
function htmlText(html) {
  return tidy(decodeEntities(String(html).replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')));
}
const EMAIL_MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
/** Subject, sender, date and text of an .eml file. */
function emailInfo(buf) {
  const raw = buf.toString('latin1');
  const { headers } = splitPart(raw);
  const r = partText(raw);
  const from = decodeWords(headers.from || '').replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '').trim() || (headers.from || '').replace(/[<>]/g, '');
  const dm = String(headers.date || '').match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/);
  const date = dm && EMAIL_MONTHS[dm[2].toLowerCase()] ? `${dm[3]}-${EMAIL_MONTHS[dm[2].toLowerCase()]}-${dm[1].padStart(2, '0')}` : '';
  const subject = decodeWords(headers.subject || '').trim();
  const body = tidy(r.plain || htmlText(r.html));
  const head = [subject && 'Subject: ' + subject, from && 'From: ' + decodeWords(headers.from), headers.to && 'To: ' + decodeWords(headers.to), headers.date && 'Date: ' + headers.date, r.files.length && 'Attachments: ' + r.files.join(', ')].filter(Boolean).join('\n');
  return { subject, from, date, attachments: r.files, text: head + '\n\n' + body };
}

// ---------- Outlook email (.msg) ----------
function msgParse(buf) {
  const MsgReader = require('@kenjiuno/msgreader').default;
  const r = new MsgReader(buf);
  const d = r.getFileData();
  if (d.error) throw new Error(d.error);
  let html = '';
  if (d.compressedRtf) {
    try {
      const { decompressRTF } = require('@kenjiuno/decompressrtf');
      const { deEncapsulateSync } = require('rtf-stream-parser');
      const iconv = require('iconv-lite');
      const res = deEncapsulateSync(Buffer.from(decompressRTF(d.compressedRtf)), { decode: iconv.decode });
      if (res.mode === 'html') html = String(res.text);
    } catch (_) { /* plain text only */ }
  }
  if (!html && d.bodyHtml) html = String(d.bodyHtml);
  const atts = (d.attachments || []).map((a, i) => {
    let bytes = Buffer.alloc(0);
    try { const x = r.getAttachment(a); bytes = Buffer.from(x.content || []); } catch (_) { /* unreadable */ }
    return { index: i, name: a.fileName || a.name || 'attachment', type: a.attachMimeTag || '', cid: (a.pidContentId || '').replace(/[<>]/g, ''), bytes, hidden: !!a.attachmentHidden };
  });
  const to = (d.recipients || []).filter(x => !x.recipType || x.recipType === 'to').map(x => x.name && x.email && x.name !== x.email ? `${x.name} <${x.email}>` : (x.name || x.email)).filter(Boolean).join(', ');
  const cc = (d.recipients || []).filter(x => x.recipType === 'cc').map(x => x.name || x.email).filter(Boolean).join(', ');
  const fromName = d.senderName || '', fromMail = d.senderSmtpAddress || d.senderEmail || '';
  const date = d.messageDeliveryTime || d.clientSubmitTime || d.creationTime || '';
  return { subject: d.subject || '', fromName, from: fromName && fromMail && fromName !== fromMail ? `${fromName} <${fromMail}>` : (fromName || fromMail), to, cc, date, text: d.body || '', html, attachments: atts };
}
function msgInfo(buf) {
  const m = msgParse(buf);
  const dt = m.date ? new Date(m.date) : null;
  const date = dt && !isNaN(dt) ? dt.toISOString().slice(0, 10) : '';
  const head = [m.subject && 'Subject: ' + m.subject, m.from && 'From: ' + m.from, m.to && 'To: ' + m.to, m.date && 'Date: ' + m.date, m.attachments.length && 'Attachments: ' + m.attachments.map(a => a.name).join(', ')].filter(Boolean).join('\n');
  return { subject: m.subject, from: m.fromName || m.from, date, attachments: m.attachments.map(a => a.name), text: head + '\n\n' + (tidy(m.text || '') || tidy(htmlText(m.html || ''))) };
}

// ---------- PDF ----------
// The drawing library must be the very same copy pdf.js loads (from app.asar.unpacked in the installed app),
// or its Path2D shapes aren't recognised and pages with embedded fonts or clipping fail to draw.
let canvasLib = null;
function canvasModule() { if (!canvasLib) canvasLib = require(unpacked(require.resolve('@napi-rs/canvas'))); return canvasLib; }

// pdf.js's own decoders (JPEG 2000 and JBIG2 images, often used in official letters), the standard
// PDF fonts and character maps. Paths must end in "/"; Windows reads them with forward slashes too.
function pdfOptions(buf) {
  const dir = unpacked(path.dirname(require.resolve('pdfjs-dist/package.json'))).replace(/\\/g, '/');
  return { data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0,
    wasmUrl: dir + '/wasm/', standardFontDataUrl: dir + '/standard_fonts/', cMapUrl: dir + '/cmaps/', cMapPacked: true };
}

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      const dir = path.dirname(require.resolve('pdfjs-dist/package.json'));
      const lib = await import(pathToFileURL(unpacked(path.join(dir, 'legacy', 'build', 'pdf.mjs'))).href);
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(unpacked(path.join(dir, 'legacy', 'build', 'pdf.worker.mjs'))).href;
      return lib;
    })().catch((e) => { pdfjsP = null; throw e; });
  }
  return pdfjsP;
}
async function renderPage(page, longSide = 2200) {
  const { createCanvas } = canvasModule();
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(3, longSide / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  return canvas.toBuffer('image/png');
}
async function pdfText(buf) {
  const lib = await pdfjs();
  const task = lib.getDocument(pdfOptions(buf));
  const doc = await task.promise;
  const out = []; let read = 0;
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let t = tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('');
      if (t.replace(/\s/g, '').length < 25 && read < MAX_OCR_PAGES) { // probably a scanned page: draw it and read it
        try { const r = await ocr.readText(await renderPage(page)); read++; if (r.trim().length > t.trim().length) t = r; } catch (_) { /* keep what we have */ }
      }
      out.push(tidy(t));
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return out.filter(Boolean).join('\n\n');
}

/** A PNG picture of the first page of a PDF (for previews). */
async function pdfFirstPage(buf, longSide = 1000) {
  const lib = await pdfjs();
  const task = lib.getDocument(pdfOptions(buf));
  try { const doc = await task.promise; return { png: await renderPage(await doc.getPage(1), longSide), pages: doc.numPages }; }
  finally { await task.destroy(); }
}

/** The searchable text in a file ('' if none can be read). */
async function extractText(name, buf) {
  const ext = path.extname(name || '').toLowerCase();
  if (ext === '.pdf') return pdfText(buf);
  if (['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.odt', '.ods', '.odp'].includes(ext)) return officeText(buf, ext);
  if (ext === '.eml') return emailInfo(buf).text;
  if (ext === '.msg') return msgInfo(buf).text;
  if (ext === '.html' || ext === '.htm') return htmlText(buf.toString('utf8'));
  if (ext === '.rtf') return tidy(buf.toString('latin1').replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/g, ''));
  if (PLAIN.has(ext)) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
    return buf.toString('utf8').replace(/^﻿/, '');
  }
  if (IMAGE.has(ext)) return tidy(await ocr.readText(buf));
  return '';
}
/** Whether extractText can read anything from this kind of file. */
function canRead(name) {
  const ext = path.extname(name || '').toLowerCase();
  return ext === '.pdf' || IMAGE.has(ext) || PLAIN.has(ext) || ['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.odt', '.ods', '.odp', '.eml', '.msg', '.html', '.htm', '.rtf'].includes(ext);
}

module.exports = { msgParse, msgInfo, extractText, canRead, emailInfo, unzip, pdfText, pdfFirstPage, pdfjs, canvasModule, pdfOptions, decodeEntities, mime: { splitPart, param, qp, decodeWords, charset } };
