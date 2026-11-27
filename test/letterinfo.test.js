'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { suggest } = require('../src/letterinfo');

test('suggests sender, date and reference from typical UK letters', () => {
  const cms = `Child Maintenance Service
PO Box 249
Mitcheldean GL14 9AJ
Mr M Smith
Date: 14 October 2026
Our reference: 12 3456 7890
Dear Mr Smith
Your next payment is due by 1 November 2026.`;
  assert.deepStrictEqual(suggest(cms), { from: 'Child Maintenance Service', docDate: '2026-10-14', ref: '12 3456 7890' });

  const vuk = `Veterans UK
Armed Forces Compensation Scheme
Your reference: AFCS/2026/88123
We have reviewed your claim and awarded tariff level 8.
3 June 2026`;
  const v = suggest(vuk);
  assert.strictEqual(v.from, 'Veterans UK');
  assert.strictEqual(v.ref, 'AFCS/2026/88123', 'falls back to "your reference" when there is no "our reference"');
  assert.strictEqual(v.docDate, '2026-06-03');

  const insurer = `Admiral Insurance Ltd
Policy number: P7712-33A    Page 1 of 2
02/03/2027
Your renewal starts from 15/03/2027`;
  assert.deepStrictEqual(suggest(insurer), { from: 'Admiral Insurance Ltd', docDate: '2027-03-02', ref: 'P7712-33A' });
});

test('ignores deadlines, impossible dates and number-less references', () => {
  const t = `Sandwell Council
Please pay by 31 February 2027 and before 5 March 2027.
Reference: none
Account number: 55-901-22`;
  const r = suggest(t);
  assert.strictEqual(r.docDate, '', 'deadline lines are skipped, impossible dates rejected');
  assert.strictEqual(r.ref, '55-901-22');
  assert.strictEqual(r.from, 'Sandwell Council');
  assert.deepStrictEqual(suggest('too short'), { from: '', docDate: '', ref: '' });
});
