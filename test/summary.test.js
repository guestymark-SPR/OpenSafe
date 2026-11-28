'use strict';
// Monday summary wording: names when the data isn't encrypted, counts only when it is.
const test = require('node:test');
const assert = require('node:assert');
const { summaryText } = require('../src/summary');

const sch = (named) => ({ named, entries: [
  { date: '2026-11-30', kind: 'MOT', label: 'MOT: Mercedes' },
  { date: '2026-12-02', kind: 'No reply yet', label: 'No reply yet: Appeal (to CMS)' },
  { date: '2026-12-07', kind: 'Warranty', label: 'Warranty: Drill' },
  { date: '2026-11-20', kind: 'Reply or act by', label: 'Reply or act by: Council tax' }],
  waiting: [{ sentOn: '2026-11-20', who: 'Veterans UK' }, { sentOn: '2026-10-20', who: 'Child Maintenance Service' }] });

test('with names: this week (not next), overdue, oldest waiting first', () => {
  assert.strictEqual(summaryText(sch(true), '2026-11-30'),
    'MOT: Mercedes (today)\nNo reply yet: Appeal (to CMS) (Wed 2 Dec)\n1 overdue\nWaiting for replies: Child Maintenance Service (41 days), Veterans UK (10 days)');
});
test('encrypted: counts only, no names', () => {
  const t = summaryText(Object.assign(sch(false), { waiting: [{ sentOn: '2026-11-20' }, { sentOn: '2026-10-20' }] }), '2026-11-30');
  assert.strictEqual(t, '2 things due this week\n1 overdue\n2 letters waiting for a reply, the oldest for 41 days');
});
test('nothing to say', () => {
  assert.strictEqual(summaryText({ named: true, entries: [], waiting: [] }, '2026-11-30'), 'Nothing due this week, and no letters waiting for a reply.');
  assert.match(summaryText(null, '2026-11-30'), /Open OpenSafe once/);
});
test('money alerts: named, and counts only with password protection', () => {
  const b = { short: { date: '2026-12-01', low: -5000 }, limits: [{ name: 'Groceries', over: true }, { name: 'Fuel', over: false }], unusual: 1, rises: [{ name: 'Octopus', from: 9821, to: 11240 }] };
  const t = summaryText({ named: true, entries: [], waiting: [], budget: b }, '2026-11-30');
  assert.match(t, /run short on Tue 1 Dec/); assert.match(t, /Over the limit: Groceries/); assert.match(t, /Nearly at the limit: Fuel/); assert.match(t, /Octopus £98.21 → £112.40/); assert.match(t, /1 unusual payment to check/);
  const c = summaryText({ named: false, entries: [], waiting: [], budget: { short: true, limits: 2, unusual: 0, rises: 1 } }, '2026-11-30');
  assert.match(c, /4 money alerts in Bills & budget/); assert.ok(!/Groceries|Octopus/.test(c));
});
