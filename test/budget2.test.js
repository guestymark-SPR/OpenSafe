'use strict';
// Bills & budget 2.22: payday periods, carry-over, balances, forecast, finding regular payments, yearly costs.
const test = require('node:test');
const assert = require('node:assert');
const B = require('../src/budget');

test('periods: calendar months by default; payday to payday; weekend moves', () => {
  assert.deepStrictEqual(B.period('2026-11'), { key: '2026-11', from: '2026-11-01', to: '2026-12-01', last: '2026-11-30', calendar: true });
  const p = B.period('2026-11', { day: 28, weekend: 'before' }); // 28 Nov 2026 is a Saturday
  assert.strictEqual(p.from, '2026-11-27'); assert.strictEqual(p.to, '2026-12-28');
  assert.strictEqual(B.period('2026-02', { day: 'last' }).from, '2026-02-28');
  assert.strictEqual(B.period('2026-11', { day: 28, weekend: 'after' }).from, '2026-11-30');
  assert.strictEqual(B.periodOf('2026-11-26', { day: 28, weekend: 'before' }), '2026-10');
  assert.strictEqual(B.periodOf('2026-11-27', { day: 28, weekend: 'before' }), '2026-11');
  assert.strictEqual(B.periodOf('2026-12-27', { day: 28, weekend: 'before' }), '2026-11');
  const cats = [{ id: 'g', kind: 'spend' }];
  const s = B.monthSummary([{ date: '2026-11-27', amount: -100, categoryId: 'g' }, { date: '2026-11-26', amount: -50, categoryId: 'g' }], cats, p);
  assert.strictEqual(s.spend, 100);
});
test('splits count in their own categories', () => {
  const cats = [{ id: 'f', kind: 'spend' }, { id: 'p', kind: 'spend' }];
  const s = B.monthSummary([{ date: '2026-11-02', amount: -6000, categoryId: 'f', splits: [{ categoryId: 'f', amount: -4000 }, { categoryId: 'p', amount: -2000 }] }], cats, '2026-11');
  assert.deepStrictEqual(s.by, { f: 4000, p: 2000 });
});
test('carry-over: underspend adds, overspend takes away, from the month it was turned on', () => {
  const cats = [{ id: 'g', kind: 'spend', limit: 30000, rollover: true, rolloverFrom: '2026-09' }, { id: 'x', kind: 'spend', limit: 1000 }];
  const spent = { '2026-08': { g: 99999 }, '2026-09': { g: 25000 }, '2026-10': { g: 32000 } };
  assert.deepStrictEqual(B.carried(cats, '2026-11', k => spent[k]), { g: 5000 - 2000 });
  assert.deepStrictEqual(B.carried(cats, '2026-09', k => spent[k]), {});
});
test('latest balance per account, whatever order the last day is in', () => {
  const tx = [
    { account: 'Starling', date: '2026-11-20', amount: -500, balance: 10000 },
    { account: 'Starling', date: '2026-11-21', amount: -300, balance: 9200 }, // newest-first in the file
    { account: 'Starling', date: '2026-11-21', amount: -500, balance: 9500 },
    { account: 'Nationwide', date: '2026-11-19', amount: 2000, balance: 50000 }];
  const b = B.accountBalances(tx);
  assert.deepStrictEqual(b.Starling, { balance: 9200, date: '2026-11-21', sure: true });
  assert.strictEqual(b.Nationwide.balance, 50000);
});
test('forecast finds the lowest point and the first day under the buffer', () => {
  const regular = [{ kind: 'bill', name: 'Rent', amount: 60000, every: 'month', next: '2026-12-01' }, { kind: 'income', name: 'Pension', amount: 150000, every: 'month', next: '2026-12-05' }];
  const f = B.forecast({ start: 50000, from: '2026-11-28', to: '2026-12-10', regular, daily: 1000 });
  assert.strictEqual(f.days[0].date, '2026-11-29');
  assert.strictEqual(f.lowDate, '2026-12-04');
  assert.strictEqual(f.low, 50000 - 60000 - 6 * 1000); // 29 Nov to 4 Dec is 6 days of everyday spending
  assert.strictEqual(f.short, '2026-12-01');
  assert.strictEqual(B.forecast({ start: 200000, from: '2026-11-28', to: '2026-12-10', regular }).short, '');
  // statement ended earlier: those days count, but the low point is from today on
  const g = B.forecast({ start: 5000, from: '2026-11-20', to: '2026-12-10', regular: [], daily: 1000, today: '2026-11-28' });
  assert.strictEqual(g.lowDate, '2026-12-10'); assert.strictEqual(g.short, '2026-11-28');
});
test('everyday spending leaves out bills, transfers, savings and income', () => {
  const cats = [{ id: 'g', kind: 'spend' }, { id: 't', kind: 'transfer' }, { id: 's', kind: 'savings' }];
  const tx = [{ date: '2026-11-01', amount: -9000, categoryId: 'g' }, { date: '2026-11-02', amount: -60000, categoryId: 'g', billId: 'r' },
    { date: '2026-11-03', amount: -50000, categoryId: 't' }, { date: '2026-11-04', amount: -50000, categoryId: 's' }, { date: '2026-11-05', amount: 9000 }];
  assert.strictEqual(B.dailySpend(tx, cats, '2026-11-28', 90), 100);
});
const mk = (d, desc, amount, extra) => Object.assign({ date: d, description: desc, amount }, extra);
test('finds monthly, weekly and yearly payments; ignores one-offs, irregular ones, ended ones and known bills', () => {
  const tx = [
    mk('2026-08-03', 'Netflix — NETFLIX.COM', -1099), mk('2026-09-03', 'Netflix — NETFLIX.COM', -1099), mk('2026-10-04', 'Netflix — NETFLIX.COM', -1299), mk('2026-11-03', 'Netflix — NETFLIX.COM', -1299),
    mk('2026-10-31', 'Gym', -500), mk('2026-11-07', 'Gym', -500), mk('2026-11-14', 'Gym', -500), mk('2026-11-21', 'Gym', -500),
    mk('2025-12-01', 'TV Licensing', -17450), mk('2026-12-01', 'TV Licensing', -17450),
    mk('2026-09-02', 'Tesco', -1200), mk('2026-09-20', 'Tesco', -3400), mk('2026-10-01', 'Tesco', -800), mk('2026-11-15', 'Tesco', -2000),
    mk('2026-05-10', 'Old phone', -2000), mk('2026-06-10', 'Old phone', -2000), mk('2026-07-10', 'Old phone', -2000),
    mk('2026-09-12', 'Octopus Energy — OCTOPUS', -9821), mk('2026-10-12', 'Octopus Energy — OCTOPUS', -9821), mk('2026-11-12', 'Octopus Energy — OCTOPUS', -9821),
    mk('2026-09-01', 'Veterans UK — AFCS', 145000), mk('2026-10-01', 'Veterans UK — AFCS', 145000), mk('2026-11-02', 'Veterans UK — AFCS', 145000)];
  const found = B.findRegular(tx, [], [{ match: 'Octopus' }], '2026-11-28');
  const by = Object.fromEntries(found.map(f => [f.name, f]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['Gym', 'Netflix', 'TV Licensing', 'Veterans UK']);
  assert.strictEqual(by.Netflix.every, 'month'); assert.strictEqual(by.Netflix.amount, 1299); assert.strictEqual(by.Netflix.same, false); assert.strictEqual(by.Netflix.next, '2026-12-03');
  assert.strictEqual(by.Gym.every, 'week'); assert.strictEqual(by.Gym.next, '2026-11-28');
  assert.strictEqual(by['TV Licensing'].every, 'year'); assert.strictEqual(by['TV Licensing'].yearly, 17450);
  assert.strictEqual(by['Veterans UK'].kind, 'income');
});
test('yearly costs: monthly set-aside and how much should be put aside by now', () => {
  const s = B.sinking([{ id: 'm', kind: 'bill', name: 'MOT', amount: 5485, every: 'year', next: '2027-05-28' }, { id: 'r', kind: 'bill', name: 'Rent', amount: 60000, every: 'month', next: '2026-12-01' }], '2026-11-28');
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].perMonth, 458);
  assert.ok(Math.abs(s[0].byNow - 5485 / 2) < 30, 'about half way through the year');
});

const fs = require('fs'), os = require('os'), path = require('path');
const { Store } = require('../src/store');
test('store: settings, carry-over start, subscriptions, accounts, ignoring a find, the 4-week reminder', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osb2-')); const s = new Store(d); s.load();
  { const r = s.saveBudgetSettings({ monthStart: { day: 28, weekend: 'before' }, buffer: 5000, everyday: false }); assert.deepStrictEqual([r.monthStart, r.buffer, r.everyday], [{ day: 28, weekend: 'before' }, 5000, false]); assert.strictEqual(s.saveBudgetSettings({ style: 'flex' }).buffer, 5000, 'a partial save keeps the rest'); }
  assert.strictEqual(s.saveBudgetSettings({ monthStart: { day: 40 } }).monthStart.day, 28);
  const cats = s.budget().categories.map(c => Object.assign({}, c));
  cats.find(c => c.name === 'Groceries').rollover = true;
  cats.find(c => c.name === 'Income').rollover = true; // only spending categories carry over
  s.saveBudgetCategories(cats);
  const g = s.budget().categories.find(c => c.name === 'Groceries');
  assert.strictEqual(g.rollover, true); assert.match(g.rolloverFrom, /^\d{4}-\d{2}$/);
  assert.ok(!s.budget().categories.find(c => c.name === 'Income').rollover);
  // saving again keeps the original start
  const from = g.rolloverFrom; g.rolloverFrom = '2020-01'; s.saveBudgetCategories(s.budget().categories.map(c => Object.assign({}, c, c.name === 'Groceries' ? { rolloverFrom: undefined } : {})));
  assert.strictEqual(s.budget().categories.find(c => c.name === 'Groceries').rolloverFrom, '2020-01');
  assert.ok(from);
  const soon = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  s.saveRegular({ name: 'Netflix', amount: 1299, every: 'month', next: soon, subscription: true, renews: soon });
  assert.strictEqual(s.budget().regular[0].subscription, true);
  assert.strictEqual(s.saveRegular({ kind: 'income', name: 'Pay', amount: 1, every: 'month', next: soon, subscription: true }).subscription, false);
  const rem = s.reminders(new Date(), 30).filter(r => r.regularId);
  assert.ok(rem.some(r => /^Look for a better deal/.test(r.kind)), 'four weeks before');
  assert.ok(rem.some(r => /^Contract ends/.test(r.kind)));
  assert.deepStrictEqual(s.saveBudgetAccount('Nationwide saver', { kind: 'savings', forecast: true }), { kind: 'savings', forecast: false });
  s.ignoreFound('Gym'); s.ignoreFound('gym');
  assert.deepStrictEqual(s.budget().ignored, ['gym']);
});
