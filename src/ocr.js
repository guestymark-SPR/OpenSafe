'use strict';
// Receipt reading, fully offline: Tesseract OCR (English) runs on this PC; nothing is uploaded.
const path = require('path');

let workerP = null;

// In the installed app these packages are unpacked from app.asar (see "asarUnpack" in package.json).
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function paths() {
  const tessDir = path.dirname(require.resolve('tesseract.js/package.json'));
  const coreDir = path.dirname(require.resolve('tesseract.js-core/package.json'));
  const dataDir = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  return {
    workerPath: unpacked(path.join(tessDir, 'src', 'worker-script', 'node', 'index.js')),
    corePath: unpacked(coreDir),
    langPath: unpacked(dataDir)
  };
}

function getWorker() {
  if (!workerP) {
    const { createWorker } = require('tesseract.js');
    const p = paths();
    workerP = createWorker('eng', 1, { workerPath: p.workerPath, corePath: p.corePath, langPath: p.langPath, gzip: true, cacheMethod: 'none' })
      .catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}

async function readText(imageBuffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);
  return data.text || '';
}

async function stop() {
  if (!workerP) return;
  try { const w = await workerP; await w.terminate(); } catch (_) { /* ignore */ }
  workerP = null;
}

// ---------- understanding the text ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const AMOUNT = /(?:£|GBP\s?)?\s?(\d{1,3}(?:,\d{3})+|\d{1,6})[.,](\d{2})(?!\d)/g;

function amountsIn(line) {
  const out = [];
  let m;
  AMOUNT.lastIndex = 0;
  while ((m = AMOUNT.exec(line))) out.push(Number(m[1].replace(/,/g, '') + '.' + m[2]));
  return out;
}

function isoDate(y, m, d) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return '';
  return dt.toISOString().slice(0, 10);
}

function findDate(text) {
  const t = text.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
  let m = t.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) { const v = isoDate(+m[1], +m[2], +m[3]); if (v) return v; }
  const re = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/g; // UK order: day/month/year
  while ((m = re.exec(t))) { const v = isoDate(+m[3], +m[2], +m[1]); if (v) return v; }
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[\s,-]+(\d{2,4})\b/i);
  if (m) { const v = isoDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]); if (v) return v; }
  return '';
}

function findTotal(lines) {
  const totalLines = lines.filter(l => /\b(grand\s*)?total\b|amount\s+due|balance\s+due|to\s+pay/i.test(l) && !/sub\s*-?\s*total|saving|discount|vat|tax|items?\b/i.test(l));
  for (const l of totalLines) { const a = amountsIn(l); if (a.length) return a[a.length - 1]; }
  // Fall back to the biggest amount on the receipt
  const all = lines.flatMap(amountsIn).filter(n => n > 0 && n < 1e6);
  return all.length ? Math.max(...all) : null;
}

function findShop(lines) {
  for (const l of lines.slice(0, 6)) {
    const letters = (l.match(/[A-Za-z]/g) || []).length;
    if (letters < 3 || /receipt|invoice|vat\s*(no|reg)|tel|www\.|https?:|^\d/i.test(l)) continue;
    const clean = l.replace(/[^\w&'.\- ]/g, '').trim();
    if (!clean) continue;
    // TESCO -> Tesco, but keep mixed case as written
    return clean === clean.toUpperCase() ? clean.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : clean;
  }
  return '';
}

function parseReceipt(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return { shop: findShop(lines), date: findDate(text), total: findTotal(lines), text: String(text || '').slice(0, 5000) };
}

module.exports = { readText, parseReceipt, stop, _paths: paths };
