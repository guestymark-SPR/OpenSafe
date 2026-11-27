'use strict';
// Shows stored files inside OpenSafe (Documents and Data): PDFs page by page, emails, Word, Excel,
// pictures and text. Everything is done on this PC; nothing is fetched from the internet.
const path = require('path');
const doctext = require('./doctext');

const IMAGES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const TEXTISH = new Set(['.txt', '.csv', '.tsv', '.md', '.json', '.xml', '.log', '.ini', '.rtf', '.odt', '.odp', '.pptx', '.vcf', '.ics']);
const MAX_HTML = 8 * 1048576;

// ---------- PDF: open documents are kept for a short while so pages can be drawn as you scroll ----------
const pdfCache = new Map(); // key -> { task, doc, at }
async function pdfDoc(key, buffer) {
  const hit = pdfCache.get(key);
  if (hit) { hit.at = Date.now(); return hit.doc; }
  const lib = await doctext.pdfjs();
  const task = lib.getDocument(doctext.pdfOptions(buffer));
  const doc = await task.promise;
  pdfCache.set(key, { task, doc, at: Date.now() });
  while (pdfCache.size > 3) { const old = [...pdfCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]; pdfCache.delete(old[0]); old[1].task.destroy().catch(() => {}); }
  return doc;
}
async function pdfPage(key, buffer, n, width) {
  const doc = await pdfDoc(key, buffer);
  if (n < 1 || n > doc.numPages) throw new Error('No such page');
  const page = await doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const w = Math.max(200, Math.min(2600, Number(width) || 1200));
  const { createCanvas } = doctext.canvasModule();
  const vp = page.getViewport({ scale: w / vp1.width });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  page.cleanup();
  return canvas.toBuffer('image/png');
}
function clear() { for (const [, v] of pdfCache) v.task.destroy().catch(() => {}); pdfCache.clear(); }

// ---------- email (.eml): message, formatted version, pictures inside it, attachments ----------
function parseEmail(buf) {
  const raw = buf.toString('latin1');
  const parts = { html: '', text: '', files: [] };
  const walk = (chunk, depth) => {
    const { headers, body } = doctext.mime.splitPart(chunk);
    const ctype = headers['content-type'] || 'text/plain';
    const type = ctype.toLowerCase();
    if (type.startsWith('multipart/') && depth < 10) {
      const b = doctext.mime.param(ctype, 'boundary');
      if (!b) return;
      for (const p of body.split('--' + b).slice(1)) { if (p.startsWith('--')) break; walk(p.replace(/^\r?\n/, ''), depth + 1); }
      return;
    }
    const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
    const bytes = enc === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? doctext.mime.qp(body) : Buffer.from(body, 'latin1');
    const disp = headers['content-disposition'] || '';
    const name = doctext.mime.decodeWords(doctext.mime.param(disp, 'filename') || doctext.mime.param(ctype, 'name'));
    const cid = (headers['content-id'] || '').replace(/[<>\s]/g, '');
    if (!/attachment/i.test(disp) && type.startsWith('text/html') && !parts.html) { parts.html = doctext.mime.charset(bytes, doctext.mime.param(ctype, 'charset') || 'utf-8'); return; }
    if (!/attachment/i.test(disp) && type.startsWith('text/plain') && !name && !parts.text) { parts.text = doctext.mime.charset(bytes, doctext.mime.param(ctype, 'charset') || 'utf-8'); return; }
    if (type.startsWith('message/rfc822')) { parts.files.push({ name: name || 'attached email.eml', type: 'message/rfc822', cid, bytes }); return; }
    parts.files.push({ name: name || (cid ? 'picture' : 'attachment'), type: type.split(';')[0].trim(), cid, bytes });
  };
  walk(raw, 0);
  const { headers } = doctext.mime.splitPart(raw);
  return { headers, ...parts };
}
const escHtml = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function emailView(buf) {
  const m = parseEmail(buf);
  const h = (k) => doctext.mime.decodeWords(m.headers[k] || '').trim();
  return emailFromParsed(m, { subject: h('subject'), from: h('from'), to: h('to'), cc: h('cc'), date: m.headers.date || '' });
}
function emailFromParsed(m, head) {
  let html = m.html;
  const usedCids = new Set();
  let remoteImages = 0;
  if (html) {
    // pictures sent inside the email (cid:) become data: pictures; anything from the web is left blocked
    html = html.replace(/(src\s*=\s*["']?)cid:([^"'\s>]+)/gi, (all, pre, id) => {
      const f = m.files.find(x => x.cid && x.cid === id.trim());
      if (!f || !/^image\//.test(f.type)) return all;
      usedCids.add(f);
      return pre + `data:${f.type};base64,${f.bytes.toString('base64')}`;
    });
    remoteImages = (html.match(/<img\b[^>]*\bsrc\s*=\s*["']?https?:/gi) || []).length + (html.match(/url\(\s*["']?https?:/gi) || []).length;
    // no scripts, no forms, no frames; the page shows it in a sandbox as well
    html = html.replace(/<(script|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\/?(script|iframe|object|embed|form|meta|link|base|noscript|template)\b[^>]*>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src)\s*=\s*(["']?)\s*(javascript|vbscript):[^"'\s>]*\2/gi, '$1="#"');
    if (html.length > MAX_HTML) html = '';
  }
  const attachments = m.files.map((f, i) => ({ index: i, name: f.name, type: f.type, size: f.bytes.length, inline: usedCids.has(f) })).filter(a => !a.inline);
  return {
    kind: 'email', subject: head.subject, from: head.from, to: head.to, cc: head.cc, date: head.date,
    html, text: m.text || (html ? '' : '(This email has no text.)'), remoteImages, attachments
  };
}
function msgView(buf) {
  const m = doctext.msgParse(buf);
  const parsed = { headers: {}, html: m.html, text: m.text, files: m.attachments.map(a => ({ name: a.name, type: a.type || guessType(a.name), cid: a.cid, bytes: a.bytes })) };
  const v = emailFromParsed(parsed, { subject: m.subject, from: m.from, to: m.to, cc: m.cc, date: m.date ? new Date(m.date).toUTCString() : '' });
  return v;
}
function guessType(name) { const x = path.extname(name || '').toLowerCase(); return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.pdf': 'application/pdf' }[x] || 'application/octet-stream'; }
function emailAttachment(buf, index, name) {
  if (/\.msg$/i.test(name || '')) {
    const a = doctext.msgParse(buf).attachments[Number(index)];
    if (!a) throw new Error('Attachment not found');
    return { name: path.basename(a.name.replace(/[\\/:*?"<>|]+/g, '_')) || 'attachment', bytes: a.bytes };
  }
  const f = parseEmail(buf).files[Number(index)];
  if (!f) throw new Error('Attachment not found');
  return { name: path.basename(f.name.replace(/[\\/:*?"<>|]+/g, '_')) || 'attachment', bytes: f.bytes };
}

// ---------- Excel (.xlsx): each sheet as a table ----------
function colNum(ref) { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function xlsxView(buf) {
  const z = doctext.unzip(buf);
  const read = (n) => (z.get(n) ? z.get(n)().toString('utf8') : '');
  const dec = (s) => doctext.decodeEntities(s.replace(/<[^>]+>/g, ''));
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => dec(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  const wb = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map(m => {
    const rel = (rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${m[2]}"`)) || [])[1] || '';
    return { name: doctext.decodeEntities(m[1]), file: rel ? 'xl/' + rel.replace(/^\/?xl\//, '') : '' };
  }).filter(s => s.file);
  const out = [];
  for (const s of sheets.slice(0, 30)) {
    const xml = read(s.file);
    const rows = [];
    let truncated = false;
    for (const rm of xml.matchAll(/<row\b[^>]*?(?:r="(\d+)")?[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= 1000) { truncated = true; break; }
      const r = [];
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], inner = cm[2] || '';
        const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
        const t = (attrs.match(/t="(\w+)"/) || [])[1];
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (t === 's') val = shared[Number(v)] || '';
        else if (t === 'inlineStr') val = dec((inner.match(/<is>([\s\S]*?)<\/is>/) || [, ''])[1]);
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) val = doctext.decodeEntities(v);
        const ci = ref ? colNum(ref) : r.length;
        if (ci < 60) r[ci] = val;
      }
      rows.push(Array.from(r, x => x === undefined ? '' : x));
    }
    out.push({ name: s.name, rows, truncated });
  }
  return { kind: 'sheet', sheets: out };
}

/** What to show for a file. */
async function view(name, buffer) {
  const ext = path.extname(name || '').toLowerCase();
  if (ext === '.pdf') {
    const lib = await doctext.pdfjs();
    const task = lib.getDocument(doctext.pdfOptions(buffer));
    try {
      const doc = await task.promise;
      const pages = [];
      for (let i = 1; i <= Math.min(doc.numPages, 2000); i++) { const vp = (await doc.getPage(i)).getViewport({ scale: 1 }); pages.push({ w: vp.width, h: vp.height }); }
      return { kind: 'pdf', pages };
    } finally { await task.destroy(); }
  }
  if (ext === '.eml') return emailView(buffer);
  if (ext === '.docx' || ext === '.docm') {
    const mammoth = require('mammoth');
    const r = await mammoth.convertToHtml({ buffer });
    if (r.value.length > MAX_HTML) return { kind: 'text', text: await doctext.extractText(name, buffer), note: 'This document is too big to show with its layout, so only its words are shown.' };
    return { kind: 'html', html: r.value, note: 'Shown without the exact page layout. Use Open in another app to see it as it prints.' };
  }
  if (ext === '.xlsx' || ext === '.xlsm') return xlsxView(buffer);
  if (ext === '.html' || ext === '.htm') return { kind: 'html', html: buffer.toString('utf8').slice(0, MAX_HTML), note: 'Saved web page: shown without scripts or anything from the internet.' };
  if (IMAGES.has(ext)) return { kind: 'image' };
  if (TEXTISH.has(ext)) return { kind: 'text', text: await doctext.extractText(name, buffer) };
  if (ext === '.msg') return msgView(buffer);
  if (['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.3gp'].includes(ext)) return { kind: 'none', why: 'Videos open in your video player.' };
  return { kind: 'none', why: 'OpenSafe can\'t show this kind of file. Use Open in another app.' };
}

module.exports = { view, pdfPage, emailAttachment, clear };
