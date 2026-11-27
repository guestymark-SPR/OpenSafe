'use strict';
// Complaint ladder: time limits as the organisations publish them, and reminders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cm = require('../src/complaints');
const { Store } = require('../src/store');

test('dates: calendar months the ICO way, working days, weekends', () => {
  assert.strictEqual(cm.addMonths('2026-05-14', 1), '2026-06-14');
  assert.strictEqual(cm.addMonths('2026-01-31', 1), '2026-02-28', 'no 31 February: last day of the month');
  assert.strictEqual(cm.addMonths('2028-01-31', 1), '2028-02-29', 'leap year');
  assert.strictEqual(cm.addMonths('2026-08-31', 6), '2027-02-28');
  assert.strictEqual(cm.addWorkingDays('2026-11-27', 20), '2026-12-25', 'Friday + 20 working days (bank holidays not known)');
  assert.strictEqual(cm.nextWorkingDay('2026-11-28'), '2026-11-30', 'Saturday → Monday');
  assert.strictEqual(cm.nextWorkingDay('2026-11-27'), '2026-11-27');
});

test('subject access request: reply due a month on (moved off a weekend), then ICO within 3 months of last contact', () => {
  const st = cm.status({ type: 'sar', steps: [{ startedOn: '2026-10-28' }] }, '2026-12-01');
  assert.strictEqual(st.steps[0].dueReply, '2026-11-30', '28 November 2026 is a Saturday');
  assert.strictEqual(st.steps[0].overdue, true);
  assert.match(st.action, /^No reply: it was due 2026-11-30/);
  const st2 = cm.status({ type: 'sar', steps: [{ startedOn: '2026-10-28' }, { startedOn: '2026-12-02' }] }, '2026-12-05');
  assert.strictEqual(st2.next.key, 'ico');
  assert.strictEqual(st2.next.startBy, '2027-03-02', 'three months from the follow-up');
});

test('Veterans UK: 20 working days each stage; stage 2 within 28 days of the stage 1 reply; Ombudsman within a year', () => {
  const st = cm.status({ type: 'veterans', awareOn: '2026-06-01', steps: [{ startedOn: '2026-09-01', replyOn: '2026-09-25' }] }, '2026-10-01');
  assert.strictEqual(st.steps[0].dueReply, '2026-09-29');
  assert.strictEqual(st.next.key, 'stage2');
  assert.strictEqual(st.next.startBy, '2026-10-23');
  assert.match(st.action, /^Next: Stage 2 complaint, by 2026-10-23/);
  assert.strictEqual(st.steps[2].startBy, '2027-06-01');
});

test('DWP/CMS: ICE within 6 months of the final response; financial, energy and telecoms limits', () => {
  assert.strictEqual(cm.status({ type: 'dwp', steps: [{ startedOn: '2026-01-10', replyOn: '2026-04-30' }] }).next.startBy, '2026-10-30');
  const fin = cm.status({ type: 'financial', steps: [{ startedOn: '2026-01-05' }] }, '2026-01-06');
  assert.strictEqual(fin.steps[0].dueReply, '2026-03-02', '8 weeks');
  assert.strictEqual(cm.status({ type: 'telecoms', steps: [{ startedOn: '2026-05-01' }] }).steps[0].dueReply, '2026-06-12', '6 weeks');
  assert.strictEqual(cm.status({ type: 'energy', steps: [{ startedOn: '2026-05-01', replyOn: '2026-06-01' }] }).next.startBy, '2027-06-01');
  for (const t of Object.values(cm.TEMPLATES)) assert.ok(t.sources.length && t.sources.every(([, u]) => /^https:\/\//.test(u)), t.name + ' has sources');
});

test('kept with the data; due dates and last days show in Reminders; closed ones don\'t', () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'oscomp-'))); s.load();
  const c = s.saveComplaint({ type: 'veterans', title: 'AFCS delay', org: 'Veterans UK', caseName: 'AFCS claim', steps: [{ startedOn: '2026-11-02' }] });
  let r = s.reminders(new Date(2026, 10, 27), 60).filter(x => x.complaintId === c.id);
  assert.deepStrictEqual(r.map(x => [x.kind, x.date]), [['Complaint reply due', '2026-11-30']]);
  s.saveComplaint({ id: c.id, steps: [{ startedOn: '2026-11-02', replyOn: '2026-11-20' }] });
  r = s.reminders(new Date(2026, 10, 27), 60).filter(x => x.complaintId === c.id);
  assert.deepStrictEqual(r.map(x => [x.kind, x.date]), [['Last day for: Stage 2 complaint', '2026-12-18']]);
  s.saveComplaint({ id: c.id, closedOn: '2026-11-27', outcome: 'Sorted' });
  assert.strictEqual(s.reminders(new Date(2026, 10, 27), 60).filter(x => x.complaintId === c.id).length, 0);
  assert.strictEqual(s.saveComplaint({ type: 'nonsense', customSteps: [{ name: 'Ask nicely', days: 14 }] }).type, 'custom');
  s.deleteComplaint(c.id);
  assert.strictEqual(s.complaints().length, 1);
});
