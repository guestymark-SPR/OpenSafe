'use strict';
// Bundle PDF: chosen Documents and Data entries in one PDF, in date order, with a contents page
// and page numbers on every page (for an MP, a tribunal, a solicitor or an appeal).
// Electron-free so it can be tested: main.js passes in renderHtml(html) -> PDF bytes.

const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const redact = require('./redact');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ukDate = (s) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const extOf = (f) => path.extname(f || '').toLowerCase();
const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
const A4 = [595.28, 841.89];
// Nothing from the internet is loaded while pages are drawn (emails can contain web pictures).
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
const PAGE_CSS = `<style>*{box-sizing:border-box} body{font:10.5pt/1.45 "Segoe UI",Arial,sans-serif;color:#1d1d1b;margin:0}
  img{max-width:100%} table{border-collapse:collapse} td,th{vertical-align:top} pre{white-space:pre-wrap;word-break:break-word;font:9.5pt/1.4 Consolas,monospace}
  .eh{border-bottom:1px solid #bbb;padding-bottom:6pt;margin-bottom:10pt} .eh h1{font-size:14pt;margin:0 0 4pt} .eh div{font-size:9pt;color:#444}
  img:not([src^="data:"]){display:none} .note{font-size:8.5pt;color:#777;margin-bottom:8pt} .sheet{font-size:8.5pt} .sheet td{border:1px solid #ddd;padding:2pt 4pt}</style>`;
const page = (body, title) => `<!doctype html><html><head><meta charset="utf-8">${CSP}<title>${esc(title || '')}</title>${PAGE_CSS}</head><body>${body}</body></html>`;

/** Order entries: by the date on them (no date last, then by when added). */
function orderEntries(entries, order = 'oldest') {
  const key = (e) => e.docDate || '';
  const out = entries.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka && kb && ka !== kb) return order === 'newest' ? kb.localeCompare(ka) : ka.localeCompare(kb);
    if (!ka !== !kb) return ka ? -1 : 1;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
  return out;
}

// Characters the built-in PDF font can draw (for page numbers)
function winAnsi(s) {
  return String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

/** HTML for a file that isn't a PDF or JPEG/PNG picture, or null if it can't go in a PDF. */
async function fileHtml(name, buffer, viewer) {
  const ext = extOf(name);
  if (IMG_MIME[ext]) return page(`<img style="display:block;margin:0 auto;max-height:250mm;object-fit:contain" src="data:${IMG_MIME[ext]};base64,${buffer.toString('base64')}">`, name);
  const v = await viewer.view(name, buffer);
  if (v.kind === 'email') {
    const head = `<div class="eh"><h1>${esc(v.subject || '(no subject)')}</h1>${v.from ? `<div><b>From:</b> ${esc(v.from)}</div>` : ''}${v.to ? `<div><b>To:</b> ${esc(v.to)}</div>` : ''}${v.cc ? `<div><b>Cc:</b> ${esc(v.cc)}</div>` : ''}${v.date ? `<div><b>Date:</b> ${esc(v.date)}</div>` : ''}${v.attachments && v.attachments.length ? `<div><b>Attachments:</b> ${v.attachments.map(a => esc(a.name)).join(', ')}</div>` : ''}</div>`;
    return page(head + (v.html ? v.html : `<pre>${esc(v.text)}</pre>`), v.subject);
  }
  if (v.kind === 'html') return page(v.html, name);
  if (v.kind === 'sheet' || v.kind === 'xlsx') {
    const sheets = v.sheets || [];
    return page(sheets.map(s => `<h3>${esc(s.name)}</h3><table class="sheet">${(s.rows || []).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`).join(''), name);
  }
  if (v.kind === 'text') return page(`<pre>${esc(v.text)}</pre>`, name);
  return null;
}

async function imagePage(out, name, buffer) {
  const img = extOf(name) === '.png' ? await out.embedPng(buffer) : await out.embedJpg(buffer);
  const landscape = img.width > img.height;
  const [W, H] = landscape ? [A4[1], A4[0]] : A4;
  const m = 28, s = Math.min((W - 2 * m) / img.width, (H - 2 * m - 14) / img.height);
  const p = out.addPage([W, H]);
  p.drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2 + 7, width: img.width * s, height: img.height * s });
  return 1;
}

/** Number every page at the bottom centre, the right way up whatever the page's rotation. */
async function stampNumbers(doc, label = '') {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages(), N = pages.length, size = 9;
  pages.forEach((p, i) => {
    const text = winAnsi(`${label ? label + '  ·  ' : ''}Page ${i + 1} of ${N}`);
    const tw = font.widthOfTextAtSize(text, size);
    const box = p.getCropBox(), r = ((p.getRotation().angle % 360) + 360) % 360;
    const gap = 16, padX = 5, padY = 3;
    // anchor (start of the text baseline) and direction for each rotation
    let x, y;
    if (r === 90) { x = box.x + box.width - gap; y = box.y + box.height / 2 - tw / 2; }
    else if (r === 180) { x = box.x + box.width / 2 + tw / 2; y = box.y + box.height - gap; }
    else if (r === 270) { x = box.x + gap; y = box.y + box.height / 2 + tw / 2; }
    else { x = box.x + box.width / 2 - tw / 2; y = box.y + gap; }
    const a = [0, 90, 180, 270].includes(r) ? r : 0, rad = a * Math.PI / 180;
    const map = (du, dv) => [x + du * Math.cos(rad) - dv * Math.sin(rad), y + du * Math.sin(rad) + dv * Math.cos(rad)];
    const [rx, ry] = map(-padX, -padY - 2);
    p.drawRectangle({ x: rx, y: ry, width: tw + 2 * padX, height: size + 2 * padY, color: rgb(1, 1, 1), opacity: 0.85, rotate: degrees(a) });
    p.drawText(text, { x, y, size, font, color: rgb(0.2, 0.2, 0.2), rotate: degrees(a) });
  });
}

function contentsHtml(title, rows, total, { prepared }) {
  return page(`<style>h1{font-size:18pt;margin:0 0 2pt} .muted{color:#666;font-size:9pt} table{width:100%;margin-top:14pt}
    th{text-align:left;font-size:8.5pt;color:#666;font-weight:600;padding:4pt;border-bottom:1px solid #999}
    td{padding:5pt 4pt;border-bottom:1px solid #e4e4e4;font-size:9.5pt} .n{width:24pt;color:#666} .r{text-align:right;white-space:nowrap} .d{white-space:nowrap}
    .sub{color:#666;font-size:8.5pt} .miss{color:#a33;font-size:8.5pt}</style>
    <h1>${esc(title)}</h1><div class="muted">Contents · ${rows.length} document${rows.length === 1 ? '' : 's'} · ${total} pages · prepared ${esc(prepared)}</div>
    <table><thead><tr><th class="n">No.</th><th>Date</th><th>From</th><th>Title</th><th class="r">Pages</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td class="n">${i + 1}</td><td class="d">${esc(ukDate(r.docDate)) || '—'}</td><td>${esc(r.from || '')}</td>
      <td>${esc(r.title)}${r.ref ? `<div class="sub">Ref: ${esc(r.ref)}</div>` : ''}${r.missing.length ? `<div class="miss">Not included: ${r.missing.map(esc).join(', ')}</div>` : ''}</td>
      <td class="r">${r.pages ? (r.pages === 1 ? r.start : `${r.start}–${r.start + r.pages - 1}`) : '—'}</td></tr>`).join('')}
    </tbody></table>`, title);
}

/**
 * @param entries   library entries ({ id, title, from, docDate, ref, createdAt, files:[{id,name}] })
 * @param readFile  (entryId, fileId) -> { name, buffer }
 * @param renderHtml (html) -> Promise<Uint8Array> PDF (A4)
 * @param viewer    ./viewer (to turn emails, Word and Excel files into pages)
 * @returns { bytes, pages, documents, skipped: string[] }
 */
async function buildBundle({ entries, readFile, renderHtml, viewer, title = 'Bundle', order = 'oldest', contents = true, numbers = true, now = new Date(), redact: hide = null, ocrWords = null, progress = () => {} }) {
  if (!entries || !entries.length) throw new Error('Choose at least one document.');
  const list = orderEntries(entries, order);
  const body = await PDFDocument.create();
  const rows = [], skipped = [];
  for (const e of list) {
    const row = { title: e.title, from: e.from, docDate: e.docDate, ref: e.ref, start: body.getPageCount() + 1, pages: 0, missing: [] };
    for (const f of e.files || []) {
      let name = f.name;
      try {
        const r = readFile(e.id, f.id);
        name = r.name || name;
        const ext = extOf(name);
        let added = 0;
        if (ext === '.pdf') {
          let src;
          try { src = await PDFDocument.load(r.buffer, { ignoreEncryption: true }); } catch (_) { throw new Error('the PDF couldn\'t be read'); }
          const pages = await body.copyPages(src, src.getPageIndices());
          pages.forEach(p => body.addPage(p)); added = pages.length;
        } else if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
          try { added = await imagePage(body, name, r.buffer); } catch (_) { added = 0; }
        }
        if (!added && ext !== '.pdf') {
          const html = await fileHtml(name, r.buffer, viewer);
          if (!html) throw new Error('this kind of file can\'t go in a PDF');
          const src = await PDFDocument.load(await renderHtml(html));
          const pages = await body.copyPages(src, src.getPageIndices());
          pages.forEach(p => body.addPage(p)); added = pages.length;
        }
        if (!added) throw new Error('nothing to show');
        row.pages += added;
      } catch (err) {
        row.missing.push(name);
        skipped.push(`${e.title}: ${name} (${err.code === 'VAULT_LOCKED' ? 'in the locked vault' : err.message || 'couldn\'t be read'})`);
      }
    }
    rows.push(row);
  }
  if (!body.getPageCount()) throw new Error('None of the chosen files could be put in a PDF.\n\n' + skipped.join('\n'));
  // hide private details: every page becomes a picture with the details blacked out
  let found = null, body2 = body;
  if (redact.active(hide)) {
    progress('Hiding private details…');
    const r = await redact.redactPdf(await body.save(), hide, { ocrWords });
    found = r.found;
    body2 = await PDFDocument.load(r.bytes);
    title = redact.redactText(title, hide);
    for (const row of rows) { row.title = redact.redactText(row.title, hide); row.from = redact.redactText(row.from, hide); row.ref = redact.redactText(row.ref, hide); row.missing = row.missing.map(m => redact.redactText(m, hide)); }
  }

  const out = await PDFDocument.create();
  let front = 0;
  if (contents) {
    const prepared = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    // The contents page count changes the page numbers it lists, so draw it until it settles.
    let pdf = null;
    for (let tries = 0, guess = 1; tries < 4; tries++) {
      const shifted = rows.map(r => Object.assign({}, r, { start: r.start + guess }));
      pdf = await PDFDocument.load(await renderHtml(contentsHtml(title, shifted, body2.getPageCount() + guess, { prepared })));
      if (pdf.getPageCount() === guess) break;
      guess = pdf.getPageCount();
    }
    const cp = await out.copyPages(pdf, pdf.getPageIndices());
    cp.forEach(p => out.addPage(p)); front = cp.length;
  }
  const bp = await out.copyPages(body2, body2.getPageIndices());
  bp.forEach(p => out.addPage(p));
  if (numbers) await stampNumbers(out, winAnsi(title.replace(/█+/g, '[hidden]')).slice(0, 60));
  out.setTitle(title); out.setProducer('OpenSafe'); out.setCreator('OpenSafe');
  return { bytes: await out.save(), pages: out.getPageCount(), documents: rows.length, front, found, rows: rows.map(r => Object.assign({}, r, { start: r.start + front })), skipped };
}

module.exports = { buildBundle, fileHtml, orderEntries, stampNumbers, winAnsi, contentsHtml };
