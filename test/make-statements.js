'use strict';
// Makes test bank statement PDFs in three different layouts (and one scanned), with known transactions.
// Run: node test/make-statements.js  (writes to test/fixtures/statements)
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const OUT = path.join(__dirname, 'fixtures', 'statements');
fs.mkdirSync(OUT, { recursive: true });
const gbp = (p) => (Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// the same 14 transactions, so every layout should read back to the same list
const TX = [
  ['2026-10-01', 'AFCS PAYMENT', 'VETERANS UK', 145000], ['2026-10-01', 'RENT OCT', 'LANDLORD', -65000], ['2026-10-03', 'NETFLIX.COM', 'CARD PAYMENT', -1299],
  ['2026-10-03', 'COSTA COFFEE', 'BIRMINGHAM', -345], ['2026-10-12', 'OCTOPUS ENERGY', 'DIRECT DEBIT', -9821], ['2026-10-15', 'TESCO STORES 3021', 'SHELDON', -6240],
  ['2026-10-15', 'REFUND AMAZON', 'MARKETPLACE', 1999], ['2026-10-22', 'TESCO STORES 3021', 'SHELDON', -4510], ['2026-10-28', 'PUREGYM', 'DIRECT DEBIT', -2499],
  ['2026-10-30', 'TRANSFER TO 20-00-00 43218765', 'SAVINGS', -20000], ['2026-11-02', 'SHELL GARAGE', 'COVENTRY RD', -5500], ['2026-11-05', 'DWP PIP', 'BENEFIT', 43400],
  ['2026-11-12', 'OCTOPUS ENERGY', 'DIRECT DEBIT', -11240], ['2026-11-20', 'CURRYS', 'ONLINE', -24999]];
const OPEN = 20000;

async function make(name, { title, heads, row, pageRows = 9, dateOnce, fullDates, bf, cf, signed }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let bal = OPEN, page, y, lastDate = '';
  const newPage = (first) => {
    page = doc.addPage([595, 842]); y = 800;
    page.drawText(title, { x: 40, y, size: 14, font: bold }); y -= 18;
    page.drawText('Account number 12345678   Sort code 60-00-00', { x: 40, y, size: 9, font }); y -= 14;
    page.drawText('Statement period 1 October 2026 to 30 November 2026', { x: 40, y, size: 9, font }); y -= 28;
    for (const [t, x, right] of heads) page.drawText(t, { x: right ? x - bold.widthOfTextAtSize(t, 9) : x, y, size: 9, font: bold });
    y -= 16;
    if (first && bf) { page.drawText(bf, { x: 110, y, size: 9, font }); const s = gbp(OPEN); page.drawText(s, { x: 555 - font.widthOfTextAtSize(s, 9), y, size: 9, font }); y -= 14; }
  };
  newPage(true);
  TX.forEach(([d, desc, desc2, amt], i) => {
    if (i && i % pageRows === 0) { page.drawText('Continued on next page', { x: 40, y: 40, size: 8, font }); newPage(false); lastDate = ''; }
    bal += amt;
    const dt = new Date(d + 'T00:00:00Z');
    const ds = fullDates ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    const cells = row({ date: dateOnce && ds === lastDate ? '' : ds, desc, desc2, amt, bal, gbp, signed });
    lastDate = ds;
    for (const [t, x, right, line] of cells) if (t) page.drawText(t, { x: right ? x - font.widthOfTextAtSize(t, 9) : x, y: y - (line || 0) * 11, size: 9, font });
    y -= cells.some(c => c[3]) ? 26 : 15;
  });
  if (cf) { const s = gbp(bal); page.drawText(cf, { x: 110, y, size: 9, font }); page.drawText(s, { x: 555 - font.widthOfTextAtSize(s, 9), y, size: 9, font }); }
  fs.writeFileSync(path.join(OUT, name), await doc.save());
  return bal;
}

(async () => {
  // Nationwide-style: date once per day, description on two lines, Paid out / Paid in / Balance, no year
  await make('two-columns.pdf', { title: 'FlexAccount statement', dateOnce: true, bf: 'Balance from previous statement', cf: 'Balance carried forward',
    heads: [['Date', 40], ['Description', 110], ['£ Out', 420, true], ['£ In', 485, true], ['£ Balance', 555, true]],
    row: ({ date, desc, desc2, amt, bal, gbp }) => [[date, 40], [desc, 110], [desc2, 110, false, 1], [amt < 0 ? gbp(amt) : '', 420, true], [amt > 0 ? gbp(amt) : '', 485, true], [gbp(bal), 555, true]] });
  // NatWest-style: Date, Type, Description, Paid in, Withdrawn, Balance; brought forward line; year missing
  await make('type-column.pdf', { title: 'Statement', bf: 'BROUGHT FORWARD', heads: [['Date', 40], ['Type', 100], ['Description', 150], ['Paid In(£)', 410, true], ['Withdrawn(£)', 480, true], ['Balance(£)', 555, true]],
    row: ({ date, desc, desc2, amt, bal, gbp }) => [[date, 40], [amt > 0 ? 'BAC' : 'D/D', 100], [desc + ' ' + desc2, 150], [amt > 0 ? gbp(amt) : '', 410, true], [amt < 0 ? gbp(amt) : '', 480, true], [gbp(bal), 555, true]] });
  // Starling-style: full dates, one signed Amount column
  await make('signed-amount.pdf', { title: 'Account statement', fullDates: true, heads: [['Date', 40], ['Description', 120], ['Amount', 470, true], ['Balance', 555, true]],
    row: ({ date, desc, amt, bal, gbp }) => [[date, 40], [desc, 120], [(amt < 0 ? '-' : '') + gbp(amt), 470, true], [gbp(bal), 555, true]] });
  // amount on the description's last line (two-line entries, first line words only)
  await make('amount-last-line.pdf', { title: 'Current account', heads: [['Date', 40], ['Details', 110], ['Money out', 420, true], ['Money in', 485, true], ['Balance', 555, true]],
    row: ({ date, desc, desc2, amt, bal, gbp }) => [[date, 40], [desc, 110], [desc2, 110, false, 1], [amt < 0 ? gbp(amt) : '', 420, true, 1], [amt > 0 ? gbp(amt) : '', 485, true, 1], [gbp(bal), 555, true, 1]] });
  // a scanned copy: the Nationwide-style pages drawn as pictures, no text layer
  {
    const doctext = require('../src/doctext');
    const lib = await doctext.pdfjs();
    const src = await lib.getDocument(doctext.pdfOptions(fs.readFileSync(path.join(OUT, 'two-columns.pdf')))).promise;
    const out = await PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const { createCanvas } = doctext.canvasModule();
      const vp = page.getViewport({ scale: 200 / 72 });
      const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height)); const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
      const img = await out.embedPng(c.toBuffer('image/png'));
      const p = out.addPage([595, 842]); p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    }
    fs.writeFileSync(path.join(OUT, 'scanned.pdf'), await out.save());
  }
  fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify({ opening: OPEN, tx: TX.map(([date, , , amount]) => ({ date, amount })) }, null, 1));
  console.log('made', fs.readdirSync(OUT).join(', '));
})();
