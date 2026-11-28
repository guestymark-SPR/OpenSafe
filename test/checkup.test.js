'use strict';
// Ways to save: fees, small spending, rising categories, double charges, bills to review, money left over.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const B = require('../src/budget');
const { Store } = require('../src/store');

const today = '2026-11-28';
function data() {
  const cats = [{ id: 'g', name: 'Groceries', kind: 'spend' }, { id: 'e', name: 'Eating out', kind: 'spend', limit: 0 }, { id: 't', name: 'Transfers', kind: 'transfer' }, { id: 'i', name: 'Income', kind: 'income' }];
  const tx = []; let n = 0;
  const add = (date, description, amount, extra) => tx.push(Object.assign({ id: 't' + (++n), date, description, amount, categoryId: '' }, extra));
  // 12 coffees in the last 90 days at £3.40
  for (let i = 0; i < 12; i++) add(B.addDays(today, -5 - i * 7), 'Costa Coffee — COSTA', -340, { categoryId: 'e' });
  // eating out higher in the last 3 months than the 3 before
  for (const m of ['2026-05', '2026-06', '2026-07']) add(m + '-15', 'Pizza place', -4000, { categoryId: 'e' });
  for (const m of ['2026-08', '2026-09', '2026-10']) add(m + '-15', 'Pizza place', -9000, { categoryId: 'e' });
  add('2026-10-03', 'OVERDRAFT FEE', -600, { type: 'CHARGE' });
  add('2026-11-03', 'Debit interest', -412);
  add('2026-11-10', 'Currys — CURRYS', -24999); add('2026-11-11', 'Currys — CURRYS', -24999);
  add('2026-11-12', 'Tesco', -1200); add('2026-11-12', 'Tesco', -1200); // £12 twice on one day: flagged (the cut-off is £10)
  add('2026-11-01', 'Own savings', -50000, { categoryId: 't' });
  for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) add(m + '-01', 'Pay', 150000, { categoryId: 'i' });
  const b = { categories: cats, transactions: tx, regular: [
    { id: 'r1', kind: 'bill', name: 'Netflix', amount: 1299, every: 'month', subscription: true, history: [] },
    { id: 'r2', kind: 'bill', name: 'Octopus', amount: 11240, every: 'month', history: [{ date: '2026-10-12', from: 9821, to: 11240 }], renews: '2027-01-30' },
    { id: 'r3', kind: 'bill', name: 'Gym', amount: 2499, every: 'month', reviewed: '2026-10-01' },
    { id: 'r4', kind: 'bill', name: 'Old phone', amount: 2000, every: 'month', ends: '2026-06-01' }] };
  const ms = { day: 1 }, keys = [...new Set(tx.map(t => t.date.slice(0, 7)))].concat(['2026-11']);
  const periods = {}, months = {};
  for (const k of keys) { periods[k] = B.period(k, ms); months[k] = B.monthSummary(tx, cats, periods[k]); }
  return { b, periods, months };
}
test('finds fees, small spending, rising categories, double charges and bills to review', () => {
  const { b, periods, months } = data();
  const c = B.checkup(b, today, { periods, months, nowKey: '2026-11' });
  assert.strictEqual(c.days, 90);
  assert.deepStrictEqual(c.fees.list.map(f => f.description).sort(), ['Debit interest', 'OVERDRAFT FEE']);
  assert.strictEqual(c.fees.total, 1012); assert.strictEqual(c.fees.perYear, Math.round(1012 * 365 / 90));
  assert.strictEqual(c.small.length, 1); assert.strictEqual(c.small[0].name, 'Costa Coffee'); assert.strictEqual(c.small[0].count, 12); assert.strictEqual(c.small[0].average, 340);
  assert.strictEqual(c.rising.length, 1); assert.strictEqual(c.rising[0].name, 'Eating out');
  assert.strictEqual(c.rising[0].was, 4000); assert.ok(c.rising[0].now >= 9000, 'pizza plus the coffees in those months');
  assert.deepStrictEqual(c.doubles.map(d => d.description).sort(), ['Currys — CURRYS', 'Tesco']);
  assert.deepStrictEqual(c.bills.map(x => x.name), ['Octopus', 'Netflix'], 'rises first, then subscriptions; reviewed and ended ones left out');
  assert.deepStrictEqual(c.bills[0].risen, { from: 9821, to: 11240, pct: 14 });
  assert.ok(c.leftover && c.leftover.perMonth > 0);
  assert.strictEqual(c.potential, c.fees.perYear + Math.round(c.small[0].perYear / 2) + c.rising.reduce((t, r) => t + r.perYear, 0) + 24999 + 1200);
});
test('nothing to say without transactions', () => {
  assert.deepStrictEqual(B.checkup({ transactions: [] }, today, { periods: {}, months: {}, nowKey: '2026-11' }).potential, 0);
});
test('store: keep hides for six months, cancel ends it and counts the saving; savings made; dismissals', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oscu-')); const s = new Store(d); s.load();
  const soon = B.addDays(new Date().toISOString().slice(0, 10), 5);
  const a = s.saveRegular({ name: 'Disney+', amount: 899, every: 'month', next: soon, subscription: true });
  const k = s.saveRegular({ name: 'Broadband', amount: 3500, every: 'month', next: soon });
  s.reviewRegular(a.id, 'cancel'); s.reviewRegular(k.id, 'keep');
  const r = s.budget().regular;
  assert.ok(r.find(x => x.id === a.id).ends); assert.ok(r.find(x => x.id === k.id).reviewed);
  assert.deepStrictEqual(s.budget().savingsMade.map(x => [x.name, x.perYear, x.what]), [['Disney+', 899 * 12, 'Cancelled']]);
  s.addSavingMade({ name: 'Fixed energy deal', perYear: 15000 });
  assert.throws(() => s.addSavingMade({ name: 'x', perYear: -1 }), /a year/);
  assert.strictEqual(s.budget().savingsMade.length, 2);
  s.dismissFinding('dbl:t9'); s.dismissFinding('dbl:t9');
  assert.deepStrictEqual(s.budget().dismissed, ['dbl:t9']);
});
