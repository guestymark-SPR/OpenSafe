'use strict';
// Bills & budget 2.23: debts, unusual payments, net worth, one spending-money total.
const test = require('node:test');
const assert = require('node:assert');
const B = require('../src/budget');

test('debt payoff: one card at 24% APR, £100 a month', () => {
  // £1,000 at 2% a month, £100 a month: n = -ln(1 - 0.02 × 1000/100) / ln(1.02) = 11.27, so 12 payments, about £127 interest
  const p = B.debtPlan([{ id: 'a', name: 'Card', balance: 100000, apr: 24, minimum: 10000 }], { start: '2026-12' });
  assert.strictEqual(p.months, 12); assert.strictEqual(p.clearBy, '2027-11');
  assert.ok(p.interest > 12300 && p.interest < 13100, 'about £127 interest: ' + p.interest);
});
test('avalanche pays the dearest first, snowball the smallest; extra shortens it; never when minimum is below interest', () => {
  const debts = [{ id: 'big', name: 'Loan', balance: 300000, apr: 10, minimum: 10000 }, { id: 'small', name: 'Card', balance: 50000, apr: 30, minimum: 2500 }];
  const av = B.debtPlan(debts, { extra: 10000, order: 'avalanche' }), sn = B.debtPlan(debts, { extra: 10000, order: 'snowball' });
  assert.ok(av.interest <= sn.interest, 'avalanche costs no more interest');
  const base = B.debtPlan(debts, { extra: 0 });
  assert.ok(av.months < base.months, 'extra clears it sooner');
  const never = B.debtPlan([{ id: 'x', name: 'Card', balance: 500000, apr: 30, minimum: 5000 }]);
  assert.strictEqual(never.never, true); assert.strictEqual(never.months, null);
  assert.deepStrictEqual(B.debtPlan([]), { debts: [], months: 0, interest: 0, never: false });
});
test('unusual: well above the usual for that payee, with at least 3 earlier payments', () => {
  const mk = (d, a, id) => ({ id, date: d, description: 'Octopus Energy — OCTOPUS', amount: a });
  const tx = [mk('2026-08-12', -9800, 1), mk('2026-09-12', -9800, 2), mk('2026-10-12', -9900, 3), mk('2026-11-12', -31000, 4), { id: 5, date: '2026-11-13', description: 'New shop', amount: -90000 }];
  const u = B.unusual(tx, '2026-11-01');
  assert.deepStrictEqual(u.map(x => x.id), [4]); assert.strictEqual(u[0].usual, 9800);
});
test('net worth', () => {
  const n = B.netWorth({ accounts: [{ kind: 'current', balance: 100000 }, { kind: 'credit', balance: 20000 }, { kind: 'savings', balance: 500000 }], other: [{ kind: 'pension', value: 1000000 }], belongings: 300000, debts: [{ balance: 150000 }] });
  assert.deepStrictEqual(n, { accounts: 580000, other: 1000000, belongings: 300000, debts: 150000, total: 1730000 });
});
test('one spending-money total: fixed, occasional, goals, flexible; flexible spending leaves out bills', () => {
  const b = { regular: [{ kind: 'income', amount: 150000, every: 'month' }, { kind: 'bill', amount: 65000, every: 'month' }, { kind: 'bill', amount: 24000, every: 'year' }], goals: [], transactions: [] };
  assert.deepStrictEqual(B.flexPlan(b, '2026-11-28', 40000), { income: 150000, fixed: 65000, nonMonthly: 2000, goals: 0, flexible: 40000, left: 43000 });
  const cats = [{ id: 'g', kind: 'spend' }, { id: 's', kind: 'savings' }];
  const tx = [{ date: '2026-11-02', amount: -65000, categoryId: 'g', billId: 'r' }, { date: '2026-11-03', amount: -4000, categoryId: 'g' }, { date: '2026-11-04', amount: -2000 }, { date: '2026-11-05', amount: -9000, categoryId: 's' }, { date: '2026-11-06', amount: 500, categoryId: 'g' }];
  assert.strictEqual(B.flexSpent(tx, cats, '2026-11'), 5500);
});

const fs = require('fs'), os = require('os'), path = require('path');
const { Store } = require('../src/store');
test('store: splits must add up and match direction; debts; other assets; net worth kept once a month', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osb3-')); const s = new Store(d); s.load();
  const cats = s.budget().categories, food = cats.find(c => c.name === 'Groceries').id, fuel = cats.find(c => c.name === 'Fuel and transport').id;
  s.importTransactions([{ key: 'k1', date: '2026-11-02', amount: -6000, description: 'Tesco' }], { bank: 'starling' });
  const t = s.budget().transactions[0];
  assert.throws(() => s.setTransactionSplits(t.id, [{ categoryId: food, amount: -4000 }, { categoryId: fuel, amount: -1000 }]), /add up to £50.00, but the transaction is £60.00/);
  assert.throws(() => s.setTransactionSplits(t.id, [{ categoryId: food, amount: -7000 }, { categoryId: fuel, amount: 1000 }]), /money out/);
  assert.throws(() => s.setTransactionSplits(t.id, [{ categoryId: food, amount: -6000 }]), /two parts/);
  s.setTransactionSplits(t.id, [{ categoryId: food, amount: -2000 }, { categoryId: fuel, amount: -4000 }]);
  assert.strictEqual(s.budget().transactions[0].categoryId, fuel, 'named by its largest part');
  assert.deepStrictEqual(B.monthSummary(s.budget().transactions, s.budget().categories, '2026-11').by, { [food]: 2000, [fuel]: 4000 });
  s.setTransactionCategory([t.id], food, ''); assert.ok(!s.budget().transactions[0].splits, 'choosing one category removes the split');
  const debt = s.saveDebt({ name: 'Barclaycard', kind: 'card', balance: 120000, apr: '24.9', minimum: 3600 });
  assert.strictEqual(debt.apr, 24.9);
  assert.throws(() => s.saveDebt({ name: '' }), /name/);
  s.saveOther({ name: 'AFPS pension', kind: 'pension', value: 2500000 });
  assert.strictEqual(s.recordNetWorth('2026-11', { total: 1, accounts: 0, other: 1, belongings: 0, debts: 0 }), true);
  assert.strictEqual(s.recordNetWorth('2026-11', { total: 1, accounts: 0, other: 1, belongings: 0, debts: 0 }), false, 'no change, no save');
  s.recordNetWorth('2026-11', { total: 5, accounts: 0, other: 5, belongings: 0, debts: 0 });
  s.recordNetWorth('2026-10', { total: 3, accounts: 0, other: 3, belongings: 0, debts: 0 });
  assert.deepStrictEqual(s.budget().netWorth.map(x => [x.month, x.total]), [['2026-10', 3], ['2026-11', 5]]);
  s.deleteDebt(debt.id); assert.strictEqual(s.budget().debts.length, 0);
});
