'use strict';
// Reading a spreadsheet saved as CSV (from Excel, Google Sheets, Numbers or OpenSafe's own export)
// and turning its rows into items. Dates are read the UK way (day first).

const MAX_ROWS = 20000;

/** Parse CSV text into an array of rows (arrays of strings). Handles quotes, "" escapes,
 *  newlines inside quotes, a UTF-8 BOM, and comma, semicolon or tab separators. */
function parseCSV(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const firstLine = s.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => firstLine.split(ch).length - 1;
  const sep = [[',', count(',')], [';', count(';')], ['\t', count('\t')]].sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some(x => x.trim() !== '')) rows.push(row); }
  return rows;
}

// Column headings people use, for each OpenSafe field (compared lower-case, letters and digits only).
const SYNONYMS = {
  name: ['name', 'item', 'itemname', 'description', 'title', 'product', 'what'],
  category: ['category', 'type', 'group', 'kind'],
  location: ['location', 'room', 'place', 'where', 'kept', 'storedin'],
  brand: ['brand', 'make', 'manufacturer', 'maker'],
  model: ['model', 'modelno', 'modelnumber'],
  serial: ['serial', 'serialno', 'serialnumber', 'sn', 'imei'],
  barcode: ['barcode', 'ean', 'upc', 'gtin'],
  condition: ['condition'],
  status: ['status'],
  purchaseDate: ['purchasedate', 'bought', 'boughton', 'datebought', 'dateofpurchase', 'purchased', 'date'],
  purchasePrice: ['purchaseprice', 'price', 'pricepaid', 'cost', 'paid', 'amount'],
  currentValue: ['currentvalue', 'value', 'valuenow', 'worth', 'estimatedvalue'],
  supplier: ['supplier', 'shop', 'store', 'boughtfrom', 'retailer', 'vendor', 'seller'],
  warrantyExpiry: ['warrantyexpiry', 'warranty', 'warrantyuntil', 'warrantyend', 'warrantyends'],
  insurer: ['insurer', 'insurance', 'insuredwith'],
  policyNumber: ['policynumber', 'policy', 'policyno'],
  insuredValue: ['insuredvalue', 'insuredfor', 'coveredfor'],
  tags: ['tags', 'labels', 'keywords'],
  notes: ['notes', 'note', 'comments', 'comment', 'details', 'info']
};
const FIELD_LABELS = {
  name: 'Name', category: 'Category', location: 'Location', brand: 'Brand', model: 'Model', serial: 'Serial number',
  barcode: 'Barcode', condition: 'Condition', status: 'Status', purchaseDate: 'Bought on', purchasePrice: 'Price paid',
  currentValue: 'Value now', supplier: 'Bought from', warrantyExpiry: 'Warranty until', insurer: 'Insurer',
  policyNumber: 'Policy number', insuredValue: 'Insured value', tags: 'Tags', notes: 'Notes'
};
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** For each column, the OpenSafe field it most likely holds ('' = don't import). */
function guessMapping(headers) {
  const used = new Set();
  return headers.map(h => {
    const n = norm(h);
    for (const [field, list] of Object.entries(SYNONYMS)) {
      if (!used.has(field) && list.includes(n)) { used.add(field); return field; }
    }
    return '';
  });
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const mon = (w) => MONTHS[w.toLowerCase().slice(0, 4)] || MONTHS[w.toLowerCase().slice(0, 3)];
/** Read a date the UK way: 2025-03-14, 14/03/2025, 14-3-25, 14.03.2025, 14 Mar 2025, March 14 2025. '' if unclear. */
function parseDateLoose(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let y, m, d, x;
  if ((x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/))) [d, m, y] = [+x[1], +x[2], +x[3]];
  else if ((x = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?[\s-]+(\d{2}|\d{4})$/i)) && mon(x[2])) [d, m, y] = [+x[1], mon(x[2]), +x[3]];
  else if ((x = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i)) && mon(x[1])) [m, d, y] = [mon(x[1]), +x[2], +x[3]];
  else return '';
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(dt.getTime()) && dt.getUTCDate() === d && dt.getUTCMonth() + 1 === m ? iso : '';
}

/** Undo the apostrophe OpenSafe's own CSV export puts before cells starting with = + - @. */
const unguard = (v) => /^'[=+\-@]/.test(v) ? v.slice(1) : v;

/** Turn data rows into item objects using the chosen mapping. Returns { items, problems }. */
function rowsToItems(rows, mapping) {
  const items = [], problems = [];
  rows.forEach((r, i) => {
    const it = {};
    const bad = [];
    mapping.forEach((field, col) => {
      if (!field) return;
      const raw = unguard(String(r[col] ?? '').trim());
      if (!raw) return;
      if (field === 'purchaseDate' || field === 'warrantyExpiry') {
        const d = parseDateLoose(raw);
        if (d) it[field] = d; else bad.push(`couldn't read the date "${raw}", so it was left blank`);
      } else if (field === 'tags') it.tags = raw.split(/[;,]/).map(t => t.trim()).filter(Boolean);
      else if (field === 'notes' && it.notes) it.notes += '\n' + raw;
      else it[field] = raw;
    });
    if (it.name) { items.push(it); for (const b of bad) problems.push(`${it.name}: ${b}`); }
    else if (Object.keys(it).length) problems.push(`A row with no name was skipped (${Object.values(it).filter(v => typeof v === 'string').slice(0, 3).join(', ')})`);
  });
  return { items, problems };
}

module.exports = { parseCSV, guessMapping, parseDateLoose, rowsToItems, FIELD_LABELS, MAX_ROWS };
