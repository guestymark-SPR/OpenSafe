'use strict';
// Printable QR labels: A4 sheet, 3 x 7 labels of 63.5 x 38.1 mm (fits Avery L7160 and
// compatible sheets). Scanning a label with the phone camera opens the item in
// OpenSafe Capture (once your inventory has been sent to the phone).

const QRCode = require('qrcode');
const { itemLink } = require('./phoneview');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function buildLabelsHtml(store, ids, { skip = 0 } = {}) {
  const items = ids.map(id => store.getAsset(id)).filter(Boolean);
  if (!items.length) throw new Error('Choose at least one item.');
  const cells = [];
  for (let i = 0; i < Math.max(0, Math.min(20, skip | 0)); i++) cells.push('<div class="lab"></div>'); // skip used labels on a part-used sheet
  for (const a of items) {
    const qr = await QRCode.toDataURL(itemLink(a.id), { margin: 0, width: 300, errorCorrectionLevel: 'M' });
    const sub = [a.location, a.serial ? 'S/N ' + a.serial : ''].filter(Boolean).join(' · ');
    cells.push(`<div class="lab"><img src="${qr}"><div class="t"><div class="n">${esc(a.name)}</div><div class="s">${esc(sub)}</div><div class="id">OpenSafe · ${esc(a.id.slice(0, 8))}</div></div></div>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0 }
  * { box-sizing: border-box }
  body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; }
  .sheet { width: 210mm; padding: 15.15mm 7.25mm 0; display: grid; grid-template-columns: repeat(3, 63.5mm); grid-auto-rows: 38.1mm; column-gap: 2.5mm; }
  .sheet:not(:last-child) { page-break-after: always; height: 297mm; }
  .lab { padding: 3mm 3.5mm; display: flex; gap: 3mm; align-items: center; overflow: hidden; }
  .lab img { width: 30mm; height: 30mm; flex: none; }
  .t { min-width: 0 }
  .n { font-weight: 700; font-size: 10pt; line-height: 1.2; max-height: 3.6em; overflow: hidden; }
  .s { font-size: 7.5pt; color: #444; margin-top: 1mm; max-height: 2.4em; overflow: hidden; }
  .id { font-size: 6.5pt; color: #888; margin-top: 1mm; font-family: Consolas, monospace }
  </style></head><body>${chunk(cells, 21).map(c => `<div class="sheet">${c.join('')}</div>`).join('')}</body></html>`;
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

module.exports = { buildLabelsHtml };
