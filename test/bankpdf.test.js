'use strict';
// Bank statement PDFs: five layouts (one scanned) read back to the same transactions, every row checked against
// the printed balance; a wrong figure is reported; the same months from a CSV aren't added twice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const bp = require('../src/bankpdf');
const { Store } = require('../src/store');
const DIR = path.join(__dirname, 'fixtures', 'statements');
test.after(() => require('../src/ocr').stop());
const want = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

for (const f of ['two-columns', 'type-column', 'signed-amount', 'amount-last-line', 'scanned']) {
  test(`reads ${f}.pdf`, { timeout: 120000 }, async () => {
    const r = await bp.read(fs.readFileSync(path.join(DIR, f + '.pdf')), 'test');
    assert.ok(r.ok, r.reason);
    assert.deepStrictEqual(r.transactions.map(t => ({ date: t.date, amount: t.amount })), want.tx);
    assert.strictEqual(r.check.checked, 14); assert.strictEqual(r.check.matched, 14);
    assert.strictEqual(r.problemCount, 0, r.problems.join('; '));
    assert.strictEqual(r.scanned, f === 'scanned');
    assert.ok(r.transactions.every(t => !/43218765|12345678/.test(t.description)), 'account numbers masked, header not read');
    if (f !== 'signed-amount') assert.ok(r.transactions.some(t => t.description.includes('VETERANS UK')), 'second description line kept with its own row');
  });
}
test('descriptions stay with their own transaction when the second line is below the amount line', async () => {
  const r = await bp.read(fs.readFileSync(path.join(DIR, 'two-columns.pdf')), 'test');
  assert.strictEqual(r.transactions[0].description, 'AFCS PAYMENT VETERANS UK');
  assert.strictEqual(r.transactions[1].description, 'RENT OCT LANDLORD');
  assert.strictEqual(r.check.opening, 20000); assert.strictEqual(r.check.endsOk, true);
});
// a statement made of words, with one amount misread
const W = (text, x0, y) => ({ text, x0, x1: x0 + text.length * 0.008, y0: y, y1: y + 0.01 });
const page = (rows) => ({ words: [W('Statement', 0.05, 0.02), W('1', 0.05, 0.05), W('November', 0.08, 0.05), W('2026', 0.16, 0.05),
  W('Date', 0.05, 0.1), W('Description', 0.2, 0.1), W('Money', 0.6, 0.1), W('out', 0.65, 0.1), W('Money', 0.72, 0.1), W('in', 0.77, 0.1), W('Balance', 0.88, 0.1)].concat(rows.flat()) });
test('a row that does not add up is reported, with what was expected', () => {
  const r = bp.parse([page([
    [W('01', 0.05, 0.13), W('Nov', 0.08, 0.13), W('Opening', 0.2, 0.13), W('balance', 0.26, 0.13), W('100.00', 0.9, 0.13)],
    [W('02', 0.05, 0.16), W('Nov', 0.08, 0.16), W('TESCO', 0.2, 0.16), W('10.00', 0.63, 0.16), W('90.00', 0.9, 0.16)],
    [W('03', 0.05, 0.19), W('Nov', 0.08, 0.19), W('SHELL', 0.2, 0.19), W('20.00', 0.63, 0.19), W('60.00', 0.9, 0.19)]])], 'x');
  assert.strictEqual(r.check.checked, 2); assert.strictEqual(r.check.matched, 1);
  assert.match(r.problems[0], /SHELL: the balance printed is 60.00, but adding this amount gives 70.00/);
  assert.deepStrictEqual(r.transactions.map(t => [t.date, t.amount]), [['2026-11-02', -1000], ['2026-11-03', -2000]]);
});
test('no table found: says so', () => {
  const r = bp.parse([{ words: [W('Dear', 0.1, 0.1), W('Mark', 0.15, 0.1)] }], 'x');
  assert.strictEqual(r.ok, false); assert.match(r.reason, /Couldn't find a table/);
});
test('dates without a year and no statement date: refuses rather than guessing', () => {
  const r = bp.parse([{ words: [W('Date', 0.05, 0.1), W('Description', 0.2, 0.1), W('Amount', 0.7, 0.1), W('Balance', 0.88, 0.1), W('02', 0.05, 0.16), W('Nov', 0.08, 0.16), W('TESCO', 0.2, 0.16), W('-10.00', 0.72, 0.16), W('90.00', 0.9, 0.16)] }], 'x');
  assert.strictEqual(r.ok, false); assert.match(r.reason, /don't show a year/);
});
test('CSV then PDF of the same months: same date and amount counted once each', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osbp-')); const s = new Store(d); s.load();
  s.importTransactions([{ key: 'c1', date: '2026-10-03', amount: -345, description: 'Costa Coffee — COSTA' }, { key: 'c2', date: '2026-10-03', amount: -1299, description: 'Netflix' }], { bank: 'starling' });
  const r = await bp.read(fs.readFileSync(path.join(DIR, 'signed-amount.pdf')), 'starling');
  const already = s.alreadyImported(r.transactions, { loose: true });
  assert.deepStrictEqual(already.map(t => t.amount).sort(), [-1299, -345]);
  const res = s.importTransactions(r.transactions, { bank: 'starling', loose: true, file: 'signed-amount.pdf' });
  assert.strictEqual(res.added, 12); assert.strictEqual(res.duplicates, 2);
  assert.strictEqual(s.importTransactions(r.transactions, { bank: 'starling', loose: true }).added, 0, 'the same PDF again adds nothing');
  assert.strictEqual(s.budget().imports[0].file, '');
});
