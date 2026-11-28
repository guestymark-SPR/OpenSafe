'use strict';
// Reading a bank's CSV export into transactions for Bills & budget.
// You pick your bank from a list. Each bank's layout is matched by its column HEADINGS, never just by position,
// so if a bank changes its export the import stops and asks you to choose the columns rather than guessing.
// Account numbers are never kept: account-number columns are skipped and long digit runs in descriptions are masked.

const crypto = require('crypto');
const { parseCSV } = require('./csv');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// What each bank's export is reported to look like. None of these are published by the banks themselves:
// they come from accounting tools and real exports people have shared, so they're checked against the file every time.
// cols: field -> the headings accepted for it (compared ignoring case, spaces and punctuation).
const BANKS = [
  { id: 'starling', name: 'Starling', cols: { date: ['Date'], payee: ['Counter Party'], desc: ['Reference'], type: ['Type'], amount: ['Amount (GBP)', 'Amount'], balance: ['Balance (GBP)', 'Balance'], category: ['Spending Category'] },
    how: 'In the Starling app: your account → Statements → Export → CSV. Or in Starling online banking.' },
  { id: 'nationwide', name: 'Nationwide', cols: { date: ['Date'], type: ['Transaction type'], desc: ['Description'], out: ['Paid out'], in: ['Paid in'], balance: ['Balance'] },
    how: 'In Nationwide\'s internet bank (on a computer): your current account → Download transactions → CSV. Each download covers up to one tax year.' },
  { id: 'natwest', name: 'NatWest', cols: { date: ['Date'], type: ['Type'], desc: ['Description'], amount: ['Value'], balance: ['Balance'] },
    how: 'In NatWest online banking (on a computer): the account → Statements or Download transactions → choose Excel/CSV.' },
  { id: 'monzo', name: 'Monzo', cols: { date: ['Date'], payee: ['Name'], type: ['Type'], category: ['Category'], amount: ['Amount'], desc: ['Notes and #tags', 'Description'] },
    how: 'In the Monzo app: your account → the three dots → Export → CSV.' },
  { id: 'barclays', name: 'Barclays', cols: { date: ['Date'], amount: ['Amount'], type: ['Subcategory'], desc: ['Memo'] },
    how: 'In Barclays online banking (on a computer): View all transactions → Export All → CSV.' },
  { id: 'other', name: 'Other bank', cols: null, how: 'Download your transactions as CSV from your bank\'s website or app, then choose which column is which.' }
];
// Headings that can hold account or sort-code details: never read.
const NEVER = ['account', 'accountnumber', 'accountno', 'sortcode', 'iban', 'accountname', 'cardnumber'];

/** Turn the file's bytes into text: UTF-8 if it is, otherwise Windows-1252 (older bank exports). */
function decode(buf) {
  if (typeof buf === 'string') return buf;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) { return new TextDecoder('windows-1252').decode(buf); }
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** Day-first dates only, as UK banks write them: 01/08/2026 is 1 August. Returns YYYY-MM-DD or ''. */
function parseDate(s) {
  s = String(s || '').trim();
  let m, d, mo, y;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/))) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,4})[a-z]*[ -](\d{2}|\d{4})\b/)) && MONTHS[m[2].toLowerCase()]) [d, mo, y] = [+m[1], MONTHS[m[2].toLowerCase()], +m[3]];
  else return '';
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return dt.toISOString().slice(0, 10);
}
/** "£1,234.56", "-12.00", "(12.00)", "12.00 DR", "£-5" → pence (integer), or null when blank or not a number. */
function parsePence(s) {
  let t = String(s == null ? '' : s).trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\b(dr|db)$/i.test(t)) { neg = true; t = t.replace(/\s*(dr|db)$/i, ''); }
  t = t.replace(/\s*cr$/i, '');
  t = t.replace(/[£$€,\s]|gbp/gi, '');
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  if (t.startsWith('+')) t = t.slice(1);
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const p = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -p : p;
}
/** Hide account and card numbers in a description: any run of 6 or more digits (with spaces, dashes or slashes) keeps only its last 4. */
function maskNumbers(s) {
  return String(s || '').replace(/\d[\d \-/]{4,}\d/g, (m) => {
    const d = m.replace(/\D/g, '');
    if (d.length < 6) return m;
    // a date (12/11/2026, 12-11-26, 2026-11-12) is not an account number
    if (/^\d{1,2}[/-]\d{1,2}[/-](\d{2}|\d{4})$/.test(m.trim()) || /^\d{4}-\d{2}-\d{2}$/.test(m.trim())) return m;
    return '••••' + d.slice(-4);
  }).replace(/\s+/g, ' ').trim();
}

/** Find the heading row: the first row (in the first 20) with a date-like heading and an amount-like heading. */
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const h = rows[i].map(norm);
    if (h.some(x => x.includes('date')) && h.some(x => /amount|value|paidout|paidin|moneyout|moneyin|debit|credit/.test(x))) return i;
  }
  return -1;
}

/** Map a preset's headings onto this file's headings. Returns { map } or { missing: [...] }. */
function matchPreset(bank, headings) {
  const h = headings.map(norm), map = {}, missing = [];
  for (const [field, names] of Object.entries(bank.cols)) {
    const i = h.findIndex(x => names.map(norm).includes(x));
    if (i >= 0) map[field] = i;
    else if (['date', 'amount', 'out', 'in'].includes(field) || (field === 'desc' && !bank.cols.payee)) missing.push(names[0]);
  }
  return missing.length ? { missing } : { map };
}
/** Best guess at which column is which, for the "choose the columns" screen. */
function guessMap(headings) {
  const h = headings.map(norm), map = {};
  const pick = (field, tests) => { const i = h.findIndex((x, j) => !Object.values(map).flat().includes(j) && !NEVER.includes(x) && tests.some(t => t instanceof RegExp ? t.test(x) : x === t)); if (i >= 0) map[field] = i; };
  pick('date', ['date', 'transactiondate', 'postingdate', /date/]);
  pick('out', ['paidout', 'moneyout', 'debit', 'debitamount', 'out', 'payments', 'withdrawals']);
  pick('in', ['paidin', 'moneyin', 'credit', 'creditamount', 'in', 'receipts', 'deposits']);
  if (map.out == null || map.in == null) { delete map.out; delete map.in; pick('amount', [/^amount/, 'value', 'transactionamount']); }
  pick('payee', ['counterparty', 'name', 'payee', 'merchant']);
  pick('desc', ['description', 'reference', 'narrative', 'details', 'memo', 'transactiondescription']);
  pick('type', ['type', 'transactiontype', 'subcategory']);
  pick('balance', [/^balance/, 'runningbalance']);
  pick('category', ['category', 'spendingcategory']);
  return map;
}

function keyOf(bank, t, n) {
  return crypto.createHash('sha256').update([bank, t.date, t.amount, t.description, n].join('|')).digest('hex').slice(0, 20);
}

/**
 * Read a CSV.
 * @param input Buffer or text
 * @param bankId one of BANKS
 * @param saved a column map you chose before for this bank (used when the headings still match it)
 * @returns { ok, bank, headings, map, transactions, skipped, problems, needsMap, reason, sample }
 */
function read(input, bankId, saved) {
  const bank = BANKS.find(b => b.id === bankId) || BANKS[BANKS.length - 1];
  const rows = parseCSV(decode(input));
  const hi = findHeader(rows);
  const headings = hi >= 0 ? rows[hi].map(x => String(x).trim()) : (rows[0] || []).map(x => String(x).trim());
  const body = rows.slice(hi >= 0 ? hi + 1 : 1);
  const sample = body.slice(0, 5);
  const base = { bank: bank.id, headings: headings.map((x, i) => NEVER.includes(norm(x)) ? null : x), sample: sample.map(r => r.map((c, i) => NEVER.includes(norm(headings[i])) ? '' : parseDate(c) || parsePence(c) != null ? String(c).trim() : maskNumbers(c))) };
  if (!rows.length) return Object.assign(base, { ok: false, reason: 'The file is empty, or isn\'t a CSV file.' });
  let map = null;
  if (saved && saved.headings && saved.headings.join('|') === headings.join('|')) map = saved.map;
  else if (bank.cols) {
    const m = matchPreset(bank, headings);
    if (m.missing) return Object.assign(base, { ok: false, needsMap: true, map: guessMap(headings), reason: `This file doesn't have the columns a ${bank.name} export is expected to have (couldn't find: ${m.missing.map(x => '"' + x + '"').join(', ')}). ${bank.name} may have changed its layout, or this is a different kind of file. Choose which column is which below.` });
    map = m.map;
  } else return Object.assign(base, { ok: false, needsMap: true, map: guessMap(headings), reason: 'Choose which column is which.' });
  return Object.assign(base, convert(bank.id, headings, body, map));
}

/** Read with a column map you chose on the "which column is which" screen. */
function readWithMap(input, bankId, map) {
  const rows = parseCSV(decode(input));
  const hi = findHeader(rows);
  const headings = (hi >= 0 ? rows[hi] : rows[0] || []).map(x => String(x).trim());
  const clean = {};
  for (const [f, i] of Object.entries(map || {})) if (Number.isInteger(+i) && +i >= 0 && +i < headings.length) clean[f] = +i;
  return Object.assign({ bank: bankId, headings }, convert(bankId, headings, rows.slice(hi >= 0 ? hi + 1 : 1), clean));
}

/** Apply a column map to the rows. */
function convert(bankId, headings, body, map) {
  for (const f of ['date', 'amount', 'out', 'in', 'desc', 'payee', 'type', 'balance', 'category']) if (map[f] != null && NEVER.includes(norm(headings[map[f]]))) delete map[f];
  if (map.date == null) return { ok: false, needsMap: true, map, reason: 'Choose the column with the date.' };
  if (map.amount == null && (map.out == null || map.in == null)) return { ok: false, needsMap: true, map, reason: 'Choose the amount column, or both the money-out and money-in columns.' };
  if (map.desc == null && map.payee == null) return { ok: false, needsMap: true, map, reason: 'Choose the column with the description.' };
  const out = [], seen = {}, problems = [];
  let skipped = 0;
  body.forEach((r, i) => {
    const cell = (f) => map[f] == null ? '' : String(r[map[f]] == null ? '' : r[map[f]]).trim();
    const payee = cell('payee'), desc = cell('desc');
    const date = parseDate(cell('date'));
    let amount;
    if (map.amount != null) amount = parsePence(cell('amount'));
    else { const o = parsePence(cell('out')), n = parsePence(cell('in')); amount = o == null && n == null ? null : (n || 0) - Math.abs(o || 0); }
    if (/opening balance|closing balance|balance brought forward|balance carried forward/i.test(payee + ' ' + desc) && !date) { skipped++; return; }
    if (/^(opening|closing) balance$/i.test(payee.trim()) || /^(opening|closing) balance$/i.test(desc.trim())) { skipped++; return; }
    if (!date || amount == null) { if (r.some(c => String(c).trim())) problems.push(`Row ${i + 1}: ${!date ? 'date not understood (' + (cell('date') || 'blank') + ')' : 'amount not understood'}`); skipped++; return; }
    const description = maskNumbers([payee, desc && desc !== payee ? desc : ''].filter(Boolean).join(' — ')).slice(0, 300);
    const t = { date, amount, description, type: maskNumbers(cell('type')).slice(0, 60), bankCategory: cell('category').slice(0, 60) };
    const bal = parsePence(cell('balance')); if (bal != null) t.balance = bal;
    const k = [t.date, t.amount, t.description].join('|');
    seen[k] = (seen[k] || 0) + 1;
    t.key = keyOf(bankId, t, seen[k]);
    out.push(t);
  });
  return { ok: true, map, transactions: out, skipped, problems: problems.slice(0, 20), problemCount: problems.length };
}

module.exports = { BANKS, NEVER, read, readWithMap, convert, decode, parseDate, parsePence, maskNumbers, findHeader, guessMap, matchPreset };
