'use strict';
// Reply writer: the letter's layout and the Word file (read back with mammoth, as Word would show it).
const test = require('node:test');
const assert = require('node:assert');
const mammoth = require('mammoth');
const letter = require('../src/letter');

const d = {
  fromName: 'Mark Example', fromAddress: '1 High Street\nSheldon\nBirmingham B26 1AA', fromPhone: '07700 900123',
  toName: 'Child Maintenance Service', toAddress: 'PO Box 249\nMitcheldean\nGL14 9AJ', date: '2026-11-27',
  yourRef: '12345 678', theirDate: '2026-11-10', subject: 'Re: Annual review <decision>', greeting: 'Dear Sir or Madam,',
  body: 'Thank you for your letter dated 10 November 2026.\n\nMy income is now my pension & EDP.\nPlease recalculate.'
};

test('draft reply: their reference and date, "Re:" subject, the opening line', () => {
  const r = letter.draftReply({ title: 'Annual review', from: 'Child Maintenance Service', ref: '12345 678', docDate: '2026-11-10' }, { name: 'Mark', address: 'A' });
  assert.strictEqual(r.subject, 'Re: Annual review');
  assert.strictEqual(r.yourRef, '12345 678'); assert.strictEqual(r.theirDate, '2026-11-10');
  assert.match(r.body, /^Thank you for your letter dated 10 November 2026\./);
  assert.strictEqual(letter.draftReply({ title: 'RE: x' }).subject, 'Re: x');
});

test('sign-off follows the greeting', () => {
  assert.strictEqual(letter.signOff('Dear Sir or Madam,'), 'Yours faithfully');
  assert.strictEqual(letter.signOff('Dear Ms Jones,'), 'Yours sincerely');
});

test('the page: everything in the right order, and nothing from the letter can run as code', () => {
  const h = letter.html(d);
  const order = ['Mark Example', 'Sheldon', '27 November 2026', 'Child Maintenance Service', 'GL14 9AJ', 'Your ref: 12345 678', 'Your letter dated: 10 November 2026', 'Dear Sir or Madam,', 'Re: Annual review &lt;decision&gt;', 'My income is now my pension &amp; EDP.<br>Please recalculate.', 'Yours faithfully', '<div class="sig">Mark Example'];
  let at = 0;
  for (const s of order) { const i = h.indexOf(s, at); assert.ok(i >= 0, 'missing or out of order: ' + s); at = i; }
  assert.ok(h.includes("default-src 'none'"));
  assert.ok(!h.includes('<decision>'));
});

test('the Word file opens and says the same', async () => {
  const buf = await letter.docx(d);
  assert.strictEqual(buf.slice(0, 2).toString(), 'PK');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const order = ['Mark Example', '1 High Street', 'Birmingham B26 1AA', 'Tel: 07700 900123', '27 November 2026', 'Child Maintenance Service', 'PO Box 249', 'Your ref: 12345 678', 'Your letter dated: 10 November 2026', 'Dear Sir or Madam,', 'Re: Annual review <decision>', 'Thank you for your letter', 'My income is now my pension & EDP.', 'Please recalculate.', 'Yours faithfully', 'Mark Example'];
  let at = 0;
  for (const s of order) { const i = value.indexOf(s, at); assert.ok(i >= 0, 'missing or out of order in Word: ' + s); at = i; }
  const html = (await mammoth.convertToHtml({ buffer: buf })).value;
  assert.match(html, /<strong>Re: Annual review &lt;decision&gt;<\/strong>/, 'subject in bold');
});
