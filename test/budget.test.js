'use strict';
// Bills & budget: the sums and the storage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../src/budget');
const bank = require('../src/bankcsv');
const { Store } = require('../src/store');

const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osbud-')); const s = new Store(d); s.load(); return { s, d }; };

test('repeats: month ends stay at month end, weeks are 7 days, years keep the day', () => {
  assert.strictEqual(B.step('2026-01-31', 'month', 31), '2026-02-28');
  assert.strictEqual(B.step('2026-02-28', 'month', 31), '2026-03-31');
  assert.strictEqual(B.step('2026-12-29', 'week'), '2027-01-05');
  assert.strictEqual(B.step('2026-11-28', '4weeks'), '2026-12-26');
  assert.strictEqual(B.step('2024-02-29', 'year', 29), '2025-02-28');
  assert.deepStrictEqual(B.occurrences({ next: '2026-12-01', every: 'month' }, '2026-11-28', '2027-02-15'), ['2026-12-01', '2027-01-01', '2027-02-01']);
  assert.deepStrictEqual(B.occurrences({ next: '2026-12-01', every: 'month', ends: '2027-01-15' }, '2026-11-28', '2027-03-01'), ['2026-12-01', '2027-01-01']);
});
test('monthly cost of weekly and yearly payments', () => {
  assert.strictEqual(B.monthly({ amount: 1200, every: 'week' }), 5200);
  assert.strictEqual(B.monthly({ amount: 12000, every: 'year' }), 1000);
});
test('month totals: transfers left out, refunds reduce spending, uncategorised money in counts as income', () => {
  const cats = [{ id: 'i', kind: 'income' }, { id: 'g', kind: 'spend' }, { id: 't', kind: 'transfer' }];
  const tx = [{ date: '2026-11-01', amount: 150000, categoryId: 'i' }, { date: '2026-11-02', amount: -5000, categoryId: 'g' }, { date: '2026-11-03', amount: 1000, categoryId: 'g' },
    { date: '2026-11-04', amount: -20000, categoryId: 't' }, { date: '2026-11-05', amount: 2500, categoryId: '' }, { date: '2026-10-30', amount: -999, categoryId: 'g' }];
  const s = B.monthSummary(tx, cats, '2026-11');
  assert.strictEqual(s.income, 152500); assert.strictEqual(s.spend, 4000); assert.strictEqual(s.by.g, 4000); assert.strictEqual(s.uncategorised, 1);
});
test('rule text drops masked numbers and dates', () => {
  assert.strictEqual(B.ruleText('Octopus Energy — OCTOPUS ••••5678'), 'Octopus Energy');
  assert.strictEqual(B.ruleText('TESCO STORES 3021 12/11'), 'TESCO STORES');
});

const csv1 = 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n' +
  '02/11/2026,Tesco,TESCO STORES 3021,CONTACTLESS,-15.50,984.50\n' +
  '04/11/2026,Octopus Energy,OCTOPUS 12345678,DIRECT DEBIT,-98.21,886.29\n' +
  '05/11/2026,Veterans UK,AFCS,FASTER PAYMENT,1200.00,2086.29\n';
const csv2 = csv1 + '04/12/2026,Octopus Energy,OCTOPUS 12345678,DIRECT DEBIT,-112.40,1973.89\n02/12/2026,Tesco,TESCO STORES 3021,CONTACTLESS,-20.00,1953.89\n';

test('import, no duplicates, rules, bill matching with price change, undo', () => {
  const { s, d } = fresh();
  const b = s.budget();
  assert.ok(b.categories.length > 10);
  const energy = b.categories.find(c => c.name === 'Energy').id, groc = b.categories.find(c => c.name === 'Groceries').id;
  s.saveRegular({ name: 'Octopus Energy', amount: 9821, every: 'month', next: '2026-11-04', match: 'OCTOPUS', categoryId: energy });
  const r1 = s.importTransactions(bank.read(csv1, 'starling').transactions, { bank: 'starling', account: 'Starling' });
  assert.strictEqual(r1.added, 3); assert.strictEqual(r1.matched, 1); assert.strictEqual(r1.priceChanges.length, 0);
  let reg = s.budget().regular[0];
  assert.strictEqual(reg.next, '2026-12-04'); assert.strictEqual(reg.lastSeen, '2026-11-04');
  // categorise Tesco and make a rule
  const tesco = s.budget().transactions.find(t => t.description.startsWith('Tesco'));
  s.setTransactionCategory([tesco.id], groc, 'Tesco');
  // overlapping second file: only the 2 new rows come in; the Tesco one is filed by the rule; Octopus went up
  const r2 = s.importTransactions(bank.read(csv2, 'starling').transactions, { bank: 'starling' });
  assert.strictEqual(r2.added, 2); assert.strictEqual(r2.duplicates, 3);
  assert.strictEqual(r2.priceChanges.length, 1);
  assert.deepStrictEqual([r2.priceChanges[0].from, r2.priceChanges[0].to], [9821, 11240]);
  reg = s.budget().regular[0];
  assert.strictEqual(reg.amount, 11240); assert.strictEqual(reg.next, '2027-01-04');
  const dec = s.budget().transactions.filter(t => t.date.startsWith('2026-12'));
  assert.ok(dec.every(t => t.categoryId), 'both December rows got a category (rule and bill)');
  // saved to disk and read back
  const s2 = new Store(d); s2.load();
  assert.strictEqual(s2.budget().transactions.length, 5);
  assert.ok(!JSON.stringify(s2.data.budget).includes('12345678'), 'account-like numbers are not stored');
  // undo the second import
  assert.strictEqual(s2.undoImport(r2.importId), 2);
  assert.strictEqual(s2.budget().transactions.length, 3);
});
test('cases, deleting categories, renewal reminders', () => {
  const { s } = fresh();
  s.importTransactions(bank.read(csv1, 'starling').transactions, { bank: 'starling' });
  const ids = s.budget().transactions.filter(t => t.amount > 0).map(t => t.id);
  assert.strictEqual(s.setTransactionCase(ids, 'AFCS claim'), 1);
  const cats = s.budget().categories;
  s.setTransactionCategory([s.budget().transactions[0].id], cats[8].id, '');
  s.saveBudgetCategories(cats.filter((_, i) => i !== 8));
  assert.strictEqual(s.budget().transactions[0].categoryId, '');
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  s.saveRegular({ name: 'Sky broadband', amount: 3500, every: 'month', next: soon, renews: soon });
  assert.ok(s.reminders().some(r => r.kind.startsWith('Contract ends') && r.assetName === 'Sky broadband'));
  assert.throws(() => s.saveRegular({ name: 'x', amount: 0, next: soon }), /amount/);
});
