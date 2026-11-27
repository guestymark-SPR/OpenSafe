'use strict';
// Scanned documents exported from OpenSafe Capture (export version 4): each one's page pictures
// become one PDF in Documents, and the words are read from the pictures (offline) for search.
/** Scanned documents from the phone: page photos become one PDF; their text is read on this PC. */
async function importPhoneDocuments(store, obj) {
  const out = { added: 0, skipped: 0, errors: [] };
  const docs = Array.isArray(obj && obj.documents) ? obj.documents.slice(0, 500) : [];
  if (!docs.length) return out;
  const { PDFDocument } = require('pdf-lib');
  const known = new Set(store.libraryView('document').map(e => e.phoneId).filter(Boolean));
  for (const d of docs) {
    const title = String((d && d.title) || 'Scanned document').slice(0, 200);
    try {
      if (!d || !d.id || !Array.isArray(d.pages) || !d.pages.length) throw new Error('no pages');
      if (known.has(String(d.id))) { out.skipped++; continue; }
      const pdf = await PDFDocument.create();
      const pageTexts = [];
      for (const pg of d.pages.slice(0, 100)) {
        const buf = Buffer.from(String(pg.data || ''), 'base64');
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        if (!(isPng || (buf[0] === 0xff && buf[1] === 0xd8))) throw new Error('a page isn\'t a JPEG or PNG picture');
        const img = isPng ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
        // A4 width (595pt), height from the picture's shape
        const w = 595, h = Math.round(595 * img.height / img.width);
        pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
        pageTexts.push(buf);
      }
      pdf.setTitle(title); pdf.setCreator('OpenSafe Capture'); pdf.setProducer('OpenSafe');
      const e = store.saveLibraryEntry({ kind: 'document', title, docType: d.docType, from: d.from, docDate: d.docDate, ref: d.ref, actBy: d.actBy, notes: d.notes, tags: d.tags, source: 'phone', phoneId: String(d.id) });
      const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Scanned document';
      const f = store.addLibraryFile(e.id, safe + '.pdf', Buffer.from(await pdf.save()));
      // Read the text from the page photos now (they're sharper than the PDF copy), so the background reader skips it.
      try {
        const ocr = require('./ocr');
        const texts = [];
        for (const b of pageTexts) texts.push((await ocr.readText(b)).trim());
        store.setLibraryText(e.id, f.id, texts.join('\n\n'));
      } catch (_) { /* the background reader will try the PDF */ }
      known.add(String(d.id));
      out.added++;
    } catch (err) { out.errors.push(`${title}: ${err.message}`); }
  }
  return out;
}

module.exports = { importPhoneDocuments };
