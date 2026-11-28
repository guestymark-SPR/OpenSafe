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

test('savings count as saved, not spent', () => {
  const cats = [{ id: 'i', kind: 'income' }, { id: 's', kind: 'savings' }, { id: 'g', kind: 'spend' }];
  const r = B.monthSummary([{ date: '2026-11-01', amount: 100000, categoryId: 'i' }, { date: '2026-11-02', amount: -20000, categoryId: 's' }, { date: '2026-11-03', amount: -5000, categoryId: 'g' }], cats, '2026-11');
  assert.deepStrictEqual([r.income, r.spend, r.saved, r.left], [100000, 5000, 20000, 75000]);
});
test('goal status: monthly need counts this month and the target month; on track from the last 3 months', () => {
  const g = { id: 'g1', target: 600000, by: '2027-04-15', createdAt: '2026-06-01T10:00:00Z', money: [{ date: '2026-08-10', amount: 100000 }, { date: '2026-09-10', amount: 50000 }, { date: '2026-10-10', amount: 50000 }] };
  const tx = [{ goalId: 'g1', date: '2026-11-05', amount: -50000 }];
  const st = B.goalStatus(g, tx, '2026-11-28');
  assert.strictEqual(st.saved, 250000); assert.strictEqual(st.left, 350000);
  assert.strictEqual(st.monthsLeft, 6); // Nov, Dec, Jan, Feb, Mar, Apr
  assert.strictEqual(st.need, 58334); // £3,500 / 6, rounded up to the penny
  assert.strictEqual(st.avg3, 66667); // the last 3 full months, Aug–Oct: £1,000 + £500 + £500 = £2,000 / 3
  assert.strictEqual(st.state, 'ontrack'); // £666.67 a month against £583.34 needed
  assert.strictEqual(B.goalStatus(Object.assign({}, g, { target: 900000 }), tx, '2026-11-28').state, 'behind');
  assert.strictEqual(B.goalStatus(Object.assign({}, g, { target: 200000 }), tx, '2026-11-28').state, 'done');
  assert.strictEqual(B.goalStatus(Object.assign({}, g, { by: '2026-10-01' }), tx, '2026-11-28').state, 'late');
  assert.strictEqual(B.goalStatus(Object.assign({}, g, { by: '' }), tx, '2026-11-28').state, 'open');
});
test('plan: limit or bills in a category, whichever is more; loose bills; goals; what is left', () => {
  const b = { categories: [{ id: 'e', name: 'Energy', kind: 'spend', limit: 10000 }, { id: 'f', name: 'Food', kind: 'spend', limit: 30000 }, { id: 'i', name: 'Income', kind: 'income', limit: 0 }],
    regular: [{ kind: 'income', amount: 150000, every: 'month' }, { kind: 'bill', name: 'Octopus', amount: 12000, every: 'month', categoryId: 'e' }, { kind: 'bill', name: 'Gym', amount: 1200, every: 'year' }],
    goals: [{ id: 'g', name: 'Boat', target: 120000, by: '2027-10-31', money: [] }], transactions: [] };
  const p = B.plan(b, '2026-11-28');
  assert.strictEqual(p.income, 150000);
  assert.deepStrictEqual(p.lines.map(l => [l.name, l.amount]), [['Energy', 12000], ['Food', 30000], ['Gym', 100]]);
  assert.strictEqual(p.toGoals, 10000); // £1,200 over 12 months (Nov 2026 to Oct 2027)
  assert.strictEqual(p.left, 150000 - 42100 - 10000);
});
test('store: goals with starting amount, money by hand, transactions towards a goal, matching on import', () => {
  const { s } = fresh();
  const g = s.saveGoal({ name: 'Boat deposit', target: 500000, by: '2027-06-30', start: 100000, match: 'SAVINGS SPACE' });
  s.addGoalMoney(g.id, { amount: 25000, date: '2026-11-10', note: 'birthday' });
  s.addGoalMoney(g.id, { amount: -5000, date: '2026-11-12' });
  const csv = 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n20/11/2026,Boat,TO SAVINGS SPACE,INTERNAL TRANSFER,-200.00,100.00\n21/11/2026,Tesco,TESCO,CONTACTLESS,-10.00,90.00\n';
  const r = s.importTransactions(bank.read(csv, 'starling').transactions, { bank: 'starling' });
  assert.strictEqual(r.toGoals, 1);
  const t = s.budget().transactions.find(x => x.description.includes('SAVINGS'));
  assert.strictEqual(t.goalId, g.id);
  assert.strictEqual(s.budget().categories.find(c => c.id === t.categoryId).kind, 'savings');
  assert.strictEqual(B.goalStatus(s.budget().goals[0], s.budget().transactions, '2026-11-28').saved, 100000 + 25000 - 5000 + 20000);
  const tesco = s.budget().transactions.find(x => x.description.includes('TESCO'));
  s.setTransactionGoal([tesco.id], g.id);
  assert.strictEqual(B.goalStatus(s.budget().goals[0], s.budget().transactions, '2026-11-28').saved, 141000);
  s.deleteGoal(g.id);
  assert.ok(s.budget().transactions.every(x => !x.goalId));
  assert.throws(() => s.saveGoal({ name: 'x', target: 0 }), /how much/);
});
test('2.20 data: Savings changes from a transfer to savings once', () => {
  const { s } = fresh();
  s.data.budget = { categories: [{ id: 'c22', name: 'Savings', limit: 0, kind: 'transfer' }] };
  assert.strictEqual(s.budget().categories[0].kind, 'savings');
  s.budget().categories[0].kind = 'transfer';
  assert.strictEqual(s.budget().categories[0].kind, 'transfer', 'a choice made afterwards is kept');
});
test('a goal started this month is "just started", and "saved already" is not counted as a month\'s saving', () => {
  const g = { id: 'n', target: 100000, by: '2027-11-30', createdAt: '2026-11-20T09:00:00Z', money: [{ date: '2026-11-20', amount: 50000, start: true }] };
  const st = B.goalStatus(g, [], '2026-11-28');
  assert.strictEqual(st.state, 'new'); assert.strictEqual(st.saved, 50000);
  const later = B.goalStatus(Object.assign({}, g, { money: g.money.concat([{ date: '2026-12-05', amount: 5000 }]) }), [], '2027-01-10');
  assert.strictEqual(later.avgMonths, 1); assert.strictEqual(later.avg3, 5000); // only December counts, not the starting £500
});
