'use strict';
// Reading transactions from a bank statement PDF.
// Banks lay statements out differently, so nothing here assumes one layout: it finds the table's heading row
// (Date, Description, Paid out / Paid in or Amount, Balance), uses where each heading sits on the page to decide
// which column every word belongs to, and then checks each row against the running balance. Rows that don't add
// up are reported, never quietly kept or dropped. Scanned statements are read with text recognition first.

const crypto = require('crypto');
const { maskNumbers } = require('./bankcsv');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const MONEY = /^[-(]?£?-?\d{1,3}(,\d{3})*(\.\d{2})[)]?(cr|dr|CR|DR)?$|^[-(]?£?-?\d+\.\d{2}[)]?(cr|dr|CR|DR)?$/;

// heading words for each column (compared without spaces or punctuation)
const HEAD = {
  date: ['date', 'transactiondate', 'postingdate', 'datetransaction'],
  desc: ['description', 'details', 'transactiondetails', 'particulars', 'transaction', 'narrative', 'paymenttype', 'paymenttypeanddetails', 'whereandwhat'],
  type: ['type'],
  out: ['paidout', 'moneyout', 'out', 'withdrawn', 'withdrawals', 'payments', 'debit', 'debits', 'paymentsout', 'moneyoutgbp', 'paidoutgbp', 'outgbp'],
  in: ['paidin', 'moneyin', 'in', 'receipts', 'deposits', 'credit', 'credits', 'paymentsin', 'moneyingbp', 'paidingbp', 'ingbp'],
  amount: ['amount', 'amountgbp', 'value'],
  balance: ['balance', 'balancegbp', 'runningbalance']
};

function lines(words) {
  const ws = words.filter(w => w.text && w.text.trim()).map(w => Object.assign({}, w, { cy: (w.y0 + w.y1) / 2, h: Math.max(0.002, w.y1 - w.y0) })).sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const out = [];
  for (const w of ws) {
    const l = out[out.length - 1];
    if (l && Math.abs(w.cy - l.cy) <= Math.max(l.h, w.h) * 0.55) { l.words.push(w); l.cy = (l.cy * (l.words.length - 1) + w.cy) / l.words.length; }
    else out.push({ cy: w.cy, h: w.h, words: [w] });
  }
  for (const l of out) { l.words.sort((a, b) => a.x0 - b.x0); l.text = l.words.map(w => w.text).join(' '); }
  return out;
}

/** The heading row: words (single, or two side by side such as "Paid out") naming a date column, an amount column and at least one more. */
function findHeading(line) {
  const ws = line.words, cols = [];
  for (let i = 0; i < ws.length; i++) {
    const two = i + 1 < ws.length && ws[i + 1].x0 - ws[i].x1 < 0.03 ? norm(ws[i].text + ws[i + 1].text) : null;
    const three = two && i + 2 < ws.length && ws[i + 2].x0 - ws[i + 1].x1 < 0.03 ? norm(ws[i].text + ws[i + 1].text + ws[i + 2].text) : null;
    const pick = (n) => Object.keys(HEAD).find(k => HEAD[k].includes(n));
    let k, used = 1;
    if (three && pick(three)) { k = pick(three); used = 3; } else if (two && pick(two)) { k = pick(two); used = 2; } else k = pick(norm(ws[i].text));
    if (k && !cols.some(c => c.key === k)) { const last = ws[i + used - 1]; cols.push({ key: k, x0: ws[i].x0, x1: last.x1, cx: (ws[i].x0 + last.x1) / 2 }); }
    i += used - 1;
  }
  const has = (k) => cols.some(c => c.key === k);
  if (!has('date') || !(has('amount') || has('out') || has('in')) || cols.length < 3) return null;
  if (!has('desc')) { // the description is often unlabelled: the gap after the date
    const d = cols.find(c => c.key === 'date');
    const next = cols.filter(c => c.x0 > d.x1).sort((a, b) => a.x0 - b.x0)[0];
    if (next) cols.push({ key: 'desc', x0: d.x1 + 0.005, x1: next.x0 - 0.005, cx: (d.x1 + next.x0) / 2, guessed: true });
  }
  return cols.sort((a, b) => a.x0 - b.x0);
}

/** Dates: 01/11/2026, 01-11-26, 1 Nov 2026, 01 Nov, 1st November. Returns { d, m, y? } and how many words it took. */
function dateAt(ws, i) {
  const t = ws[i] && ws[i].text;
  if (!t) return null;
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return { d: +m[1], m: +m[2], y: +m[3] < 100 ? 2000 + +m[3] : +m[3], used: 1 };
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { d: +m[3], m: +m[2], y: +m[1], used: 1 };
  m = t.match(/^(\d{1,2})(st|nd|rd|th)?[-]?([A-Za-z]{3,9})[-]?(\d{2}|\d{4})?$/);
  if (m && MONTHS[m[3].toLowerCase()]) return { d: +m[1], m: MONTHS[m[3].toLowerCase()], y: m[4] ? (+m[4] < 100 ? 2000 + +m[4] : +m[4]) : null, used: 1 };
  m = t.match(/^(\d{1,2})(st|nd|rd|th)?$/);
  const mon = ws[i + 1] && MONTHS[ws[i + 1].text.toLowerCase().replace(/[.,]/g, '')];
  if (m && mon && +m[1] >= 1 && +m[1] <= 31) {
    const yr = ws[i + 2] && ws[i + 2].text.match(/^(\d{4}|\d{2})$/);
    return { d: +m[1], m: mon, y: yr ? (+yr[1] < 100 ? 2000 + +yr[1] : +yr[1]) : null, used: yr ? 3 : 2 };
  }
  return null;
}
function money(t) {
  const s = String(t || '').trim();
  if (!MONEY.test(s)) return null;
  let neg = /^-|^\(|-\d|dr$/i.test(s) && !/cr$/i.test(s);
  const n = s.replace(/[£,()]|cr$|dr$/gi, '').replace('-', '');
  const [w, f] = n.split('.');
  const p = Number(w) * 100 + Number(f);
  return { pence: neg ? -p : p, credit: /cr$/i.test(s), debit: /dr$/i.test(s) };
}
const FULLDATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b|\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gi;
const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : ''; };

/**
 * pages: [{ words: [{ text, x0, x1, y0, y1 }] }] with positions as fractions of the page (0 to 1).
 * Returns the same shape as a CSV read: { ok, transactions, skipped, problems, problemCount, check, reason }.
 */
function parse(pages, bankId) {
  const allText = pages.map(p => p.words.map(w => w.text).join(' ')).join(' ');
  // years from full dates anywhere (the statement period), for dates printed without a year
  const years = []; let fm; FULLDATE.lastIndex = 0;
  while ((fm = FULLDATE.exec(allText))) years.push(+(fm[3] || fm[6]));
  const rows = [];
  let opening = null, closing = null, found = false, cols = null;
  for (const pg of pages) {
    let inTable = false;
    for (const l of lines(pg.words)) {
      const h = findHeading(l);
      if (h) { cols = h; inTable = true; found = true; continue; }
      if (!inTable || !cols) continue;
      const low = l.text.toLowerCase();
      // balance lines
      const isBF = /(brought forward|balance from (your )?(last|previous) statement|opening balance|start balance|balance b\/?f)/.test(low);
      const isCF = /(carried forward|closing balance|end balance|balance c\/?f)/.test(low);
      const amounts = l.words.map((w, i) => ({ w, i, m: money(w.text) })).filter(a => a.m);
      if (isBF || isCF) { const last = amounts[amounts.length - 1]; if (last) { const v = last.m.credit ? Math.abs(last.m.pence) : last.m.debit ? -Math.abs(last.m.pence) : last.m.pence; if (isBF && opening == null) opening = v; if (isCF) closing = v; } continue; }
      if (/^(total|totals)\b|page \d+ of \d+|continued on|\bfscs\b/.test(low) && !amounts.length) continue;
      // which column each word sits in: amounts by their right edge (numbers are right-aligned), text by overlap
      const near = (w, keys) => cols.filter(c => keys.includes(c.key)).map(c => ({ c, d: Math.min(Math.abs(w.x1 - c.x1), Math.abs((w.x0 + w.x1) / 2 - c.cx)) })).sort((a, b) => a.d - b.d)[0];
      const row = { date: null, desc: [], type: [], out: null, in: null, amount: null, balance: null, money: [] };
      let i = 0;
      const dcol = cols.find(c => c.key === 'date');
      if (dcol && l.words[0] && l.words[0].x0 < dcol.x1 + 0.04) { const d = dateAt(l.words, 0); if (d) { row.date = d; i = d.used; } }
      for (; i < l.words.length; i++) {
        const w = l.words[i], m = money(w.text);
        const n = m ? near(w, ['out', 'in', 'amount', 'balance']) : null;
        if (m && n && n.d < 0.08) { row.money.push({ key: n.c.key, m, x1: w.x1 }); continue; }
        const tcol = cols.find(c => c.key === 'type');
        if (tcol && w.x0 >= tcol.x0 - 0.01 && w.x1 <= tcol.x1 + 0.06 && !(cols.find(c => c.key === 'desc' && w.x0 >= c.x0 - 0.01))) row.type.push(w.text); else row.desc.push(w.text);
      }
      for (const mm of row.money) {
        if (mm.key === 'balance') row.balance = mm.m.credit ? Math.abs(mm.m.pence) : mm.m.debit ? -Math.abs(mm.m.pence) : mm.m.pence;
        else if (row[mm.key] == null) row[mm.key] = mm.m;
      }
      rows.push({ row, page: pages.indexOf(pg) + 1, text: l.text, cy: l.cy });
    }
  }
  if (!found) return { ok: false, reason: 'Couldn\'t find a table of transactions with a Date column and amount columns in this PDF. If it\'s a statement, try your bank\'s CSV download instead, or tell me which bank so the reader can be taught its layout.' };

  // join rows: a line without amounts carries on the description; amounts may come on a description's last line
  const tx = [], problems = [];
  let lastDate = null, pending = null, skipped = 0;
  const flush = () => { if (pending && !pending.done) { if (pending.desc.length) { problems.push(`"${pending.desc.join(' ').slice(0, 60)}": no amount found`); skipped++; } } pending = null; };
  for (const [ri, { row, text, cy, page }] of rows.entries()) {
    if (row.date) lastDate = row.date;
    const hasMoney = row.out || row.in || row.amount;
    if (!hasMoney) {
      // a balance on its own line belongs to the transaction just above it
      if (row.balance != null && !row.desc.length && pending && pending.done && pending.tx && pending.tx.balance == null) { pending.tx.balance = row.balance; continue; }
      // a line of words with no date after a finished transaction: the rest of that transaction's description,
      // unless it sits clearly closer to the line below (a description whose amount is on its last line)
      if (!row.date && pending && pending.done && pending.last) {
        const prev = rows[ri - 1], next = rows[ri + 1];
        const above = prev && prev.page === page ? cy - prev.cy : Infinity, below = next && next.page === page ? next.cy - cy : Infinity;
        const nextStarts = next && !(next.row.out || next.row.in || next.row.amount) ? false : true;
        if (above <= below * 1.1 || !nextStarts) { pending.last.description = maskNumbers(pending.last.description + ' ' + row.desc.join(' ')).slice(0, 300); continue; }
      }
      if (row.date || !pending || pending.done) { flush(); pending = { date: lastDate, desc: row.desc.slice(), type: row.type.slice(), done: false, balance: row.balance }; }
      else pending.desc.push(...row.desc);
      continue;
    }
    let base;
    if (pending && !pending.done && !row.date) { base = pending; base.desc.push(...row.desc); base.type.push(...row.type); }
    else { flush(); base = { date: lastDate, desc: row.desc.slice(), type: row.type.slice() }; }
    let amount;
    if (row.amount) amount = row.amount.credit ? Math.abs(row.amount.pence) : row.amount.debit ? -Math.abs(row.amount.pence) : row.amount.pence;
    else amount = (row.in ? Math.abs(row.in.pence) : 0) - (row.out ? Math.abs(row.out.pence) : 0);
    const t = { d: base.date, amount, description: maskNumbers(base.desc.join(' ')).slice(0, 300), type: maskNumbers(base.type.join(' ')).slice(0, 60), balance: row.balance, signKnown: !row.amount || row.amount.credit || row.amount.debit || row.amount.pence < 0, text };
    tx.push(t);
    pending = Object.assign(base, { done: true, balance: row.balance, last: t });
    if (row.balance == null) pending.tx = t; else delete pending.tx;
  }
  flush();

  // years: dates without one take the statement's year, moving on when the month goes backwards (Dec → Jan)
  let year = years.length ? Math.min(...years) : null;
  const needYear = tx.some(t => t.d && !t.d.y);
  if (needYear && !year) return { ok: false, reason: 'The dates in this statement don\'t show a year, and no statement date was found to take it from.' };
  let prevM = null;
  for (const t of tx) {
    if (!t.d) { t.date = ''; continue; }
    if (t.d.y) { year = t.d.y; } else { if (prevM && t.d.m < prevM - 6) year++; }
    prevM = t.d.m;
    t.date = iso(t.d.y || year, t.d.m, t.d.d);
  }

  // the balance check: opening (or the first row's balance before it) + each amount should give each printed balance
  let run = opening, checked = 0, matched = 0, flipped = 0;
  const bad = [];
  for (const [i, t] of tx.entries()) {
    if (run == null && t.balance != null) { run = t.balance - t.amount; }
    if (run == null) continue;
    let next = run + t.amount;
    if (t.balance != null) {
      checked++;
      if (Math.abs(next - t.balance) <= 1) matched++;
      else if (!t.signKnown && Math.abs(run - t.amount - t.balance) <= 1) { t.amount = -t.amount; next = t.balance; matched++; flipped++; }
      else { bad.push({ i, t, expected: next }); next = t.balance; }
    }
    run = next;
  }
  const total = tx.reduce((s, t) => s + t.amount, 0);
  const endsOk = opening != null && closing != null ? Math.abs(opening + total - closing) <= 1 : null;
  for (const b of bad) problems.push(`${b.t.date || '?'} ${b.t.description.slice(0, 40)}: the balance printed is ${(b.t.balance / 100).toFixed(2)}, but adding this amount gives ${(b.expected / 100).toFixed(2)}`);
  if (endsOk === false) problems.push(`Opening balance ${(opening / 100).toFixed(2)} plus all the transactions doesn't come to the closing balance ${(closing / 100).toFixed(2)}`);
  const good = tx.filter(t => t.date);
  for (const t of tx) if (!t.date) { problems.push(`"${t.description.slice(0, 50)}": no date`); skipped++; }
  // the same keys as a CSV import would use, so importing the same PDF twice adds nothing
  const seen = {};
  const out = good.map(t => {
    const k = [t.date, t.amount, t.description].join('|'); seen[k] = (seen[k] || 0) + 1;
    const o = { date: t.date, amount: t.amount, description: t.description, type: t.type, bankCategory: '' };
    if (t.balance != null) o.balance = t.balance;
    o.key = crypto.createHash('sha256').update(['pdf:' + bankId, t.date, t.amount, t.description, seen[k]].join('|')).digest('hex').slice(0, 20);
    return o;
  });
  return { ok: out.length > 0, reason: out.length ? '' : 'No transactions were found in the table.', fromPdf: true, transactions: out, skipped, problems: problems.slice(0, 30), problemCount: problems.length,
    check: { rows: tx.length, checked, matched, flipped, opening, closing, endsOk }, headings: [], sample: [] };
}

/** The words on each page of a PDF, with positions as fractions of the page. Scanned pages are read with text recognition. */
async function pdfWords(buf, { password, maxPages = 40 } = {}) {
  const doctext = require('./doctext');
  const lib = await doctext.pdfjs();
  const opts = doctext.pdfOptions(buf); if (password) opts.password = password;
  const task = lib.getDocument(opts);
  let doc;
  try { doc = await task.promise; }
  catch (e) { await task.destroy().catch(() => {}); if (e && e.name === 'PasswordException') { const err = new Error(password ? 'That password isn\'t right.' : 'This PDF has a password.'); err.needPassword = true; throw err; } throw e; }
  const pages = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const words = [];
      for (const it of tc.items) {
        const s = it.str || ''; if (!s.trim()) continue;
        const x = it.transform[4], y = it.transform[5], hgt = Math.abs(it.transform[3]) || it.height || 10, w = it.width || s.length * hgt * 0.5;
        // split a run of text into words, sharing its width out by characters
        const per = w / Math.max(1, s.length);
        let pos = 0;
        for (const part of s.split(/(\s+)/)) {
          if (part.trim()) words.push({ text: part, x0: (x + pos * per) / vp.width, x1: (x + (pos + part.length) * per) / vp.width, y0: (vp.height - y - hgt) / vp.height, y1: (vp.height - y) / vp.height });
          pos += part.length;
        }
      }
      if (words.length < 15) { // a scanned page: draw it and read it
        const ocr = require('./ocr');
        const png = await renderPng(page, doctext);
        const { loadImage } = doctext.canvasModule();
        const img = await loadImage(png);
        const ow = await ocr.readWords(png);
        pages.push({ scanned: true, words: ow.map(o => ({ text: o.text, x0: o.x0 / img.width, x1: o.x1 / img.width, y0: o.y0 / img.height, y1: o.y1 / img.height })) });
      } else pages.push({ words });
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return pages;
}
async function renderPng(page, doctext) {
  const { createCanvas } = doctext.canvasModule();
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(3, 2400 / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  return canvas.toBuffer('image/png');
}

async function read(buf, bankId, opts) {
  const pages = await pdfWords(buf, opts);
  const r = parse(pages, bankId);
  r.scanned = pages.some(p => p.scanned);
  return r;
}

module.exports = { read, parse, pdfWords, lines, findHeading, dateAt, money };
