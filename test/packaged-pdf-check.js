'use strict';
// Checks PDF drawing and reading with the code as packaged in the installer (app.asar), which the other
// tests don't use. Two problems only showed up there: two copies of the drawing library being loaded
// (pages with embedded fonts failed), and pdf.js's image decoders being left out (JPEG 2000 logos blank).
// Build first:  npx electron-builder --linux dir -c.directories.output=/tmp/pkgtest
// Run:          ELECTRON_RUN_AS_NODE=1 /tmp/pkgtest/linux-unpacked/opensafe test/packaged-pdf-check.js /tmp/pkgtest/linux-unpacked/resources
const fs = require('fs');
const path = require('path');
const R = path.resolve(process.argv[2]);
const viewer = require(path.join(R, 'app.asar', 'src', 'viewer.js'));
const doctext = require(path.join(R, 'app.asar', 'src', 'doctext.js'));
const F = path.join(__dirname, 'fixtures', 'library');
(async () => {
  let bad = 0;
  for (const f of ['embedded-font.pdf', 'jpeg2000.pdf', 'text.pdf', 'scanned.pdf', 'statement.pdf']) {
    try {
      const buf = fs.readFileSync(path.join(F, f));
      const png = await viewer.pdfPage(f, buf, 1, 1000);
      const prev = await doctext.pdfFirstPage(buf);
      console.log('ok  ', f, png.length, 'bytes; preview', prev.png.length, 'bytes');
    } catch (e) { bad++; console.log('FAIL', f, e.message); }
  }
  const t = await doctext.extractText('scanned.pdf', fs.readFileSync(path.join(F, 'scanned.pdf')));
  if (!/tariff/.test(t)) { bad++; console.log('FAIL scanned.pdf text not read'); } else console.log('ok   scanned.pdf text read');
  // 2.9.0+: Outlook .msg emails, letter details, bundle PDFs, two-PC sync (new libraries that must be packaged)
  try {
    const v = await viewer.view('outlook-inline.msg', fs.readFileSync(path.join(F, 'outlook-inline.msg')));
    const mt = await doctext.extractText('outlook-plain.msg', fs.readFileSync(path.join(F, 'outlook-plain.msg')));
    if (v.kind !== 'email' || !v.html || !/data:image\//.test(v.html) || !mt.trim()) throw new Error('nothing read');
    console.log('ok   msg read');
  } catch (e) { bad++; console.log('FAIL msg', e.message); }
  try {
    const li = require(path.join(R, 'app.asar', 'src', 'letterinfo.js'));
    const sg = li.suggest('Veterans UK\nDate: 14 August 2026\nOur ref: AFCS/2026/88123\nDear Mark');
    if (sg.ref !== 'AFCS/2026/88123' || sg.docDate !== '2026-08-14') throw new Error(JSON.stringify(sg));
    console.log('ok   letter details');
  } catch (e) { bad++; console.log('FAIL letter details', e.message); }
  try {
    const bundle = require(path.join(R, 'app.asar', 'src', 'bundle.js'));
    const files = { a: { name: 'text.pdf', buffer: fs.readFileSync(path.join(F, 'text.pdf')) }, b: { name: 'letter.png', buffer: fs.readFileSync(path.join(F, 'letter.png')) } };
    const r = await bundle.buildBundle({ entries: [{ id: 'e', title: 'T', docDate: '2026-01-01', files: [{ id: 'a', name: 'text.pdf' }, { id: 'b', name: 'letter.png' }] }],
      readFile: (_e, f) => files[f], renderHtml: null, viewer, contents: false, title: 'Check' });
    if (r.pages < 2 || r.skipped.length) throw new Error(r.pages + ' pages, ' + r.skipped.join('; '));
    const page = await viewer.pdfPage('bundle', Buffer.from(r.bytes), r.pages, 600);
    console.log('ok   bundle made', r.pages, 'pages; last page drawn', page.length, 'bytes');
  } catch (e) { bad++; console.log('FAIL bundle', e.message); }
  try {
    const letter = require(path.join(R, 'app.asar', 'src', 'letter.js'));
    const w = await letter.docx({ fromName: 'Me', toName: 'CMS', body: 'Hello' });
    if (w.slice(0, 2).toString() !== 'PK') throw new Error('not a Word file');
    const red = require(path.join(R, 'app.asar', 'src', 'redact.js'));
    const rr = await red.redactPdf(fs.readFileSync(path.join(F, 'scanned.pdf')), { kinds: [], words: ['tariff'] }, { ocrWords: require(path.join(R, 'app.asar', 'src', 'ocr.js')).readWords });
    if (!rr.found.words) throw new Error('word on the scan not found');
    console.log('ok   letter and redaction');
  } catch (e) { bad++; console.log('FAIL letter/redaction', e.message); }
  try { require(path.join(R, 'app.asar', 'src', 'sync.js')); console.log('ok   sync loads'); } catch (e) { bad++; console.log('FAIL sync', e.message); }
  viewer.clear(); await require(path.join(R, 'app.asar', 'src', 'ocr.js')).stop();
  process.exit(bad ? 1 : 0);
})();
