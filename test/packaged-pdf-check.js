'use strict';
// Checks PDF drawing and reading with the code as packaged in the installer (app.asar), which the other
// tests don't use. Two problems only showed up there: two copies of the drawing library being loaded
// (pages with embedded fonts failed), and pdf.js's image decoders being left out (JPEG 2000 logos blank).
// Build first:  npx electron-builder --linux dir -c.directories.output=/tmp/pkgtest
// Run:          ELECTRON_RUN_AS_NODE=1 /tmp/pkgtest/linux-unpacked/opensafe test/packaged-pdf-check.js /tmp/pkgtest/linux-unpacked/resources
const fs = require('fs');
const path = require('path');
const R = process.argv[2];
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
  viewer.clear(); await require(path.join(R, 'app.asar', 'src', 'ocr.js')).stop();
  process.exit(bad ? 1 : 0);
})();
