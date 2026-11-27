'use strict';
// Statement builder: the draft from a case, renumbering after edits, and the Word file.
const test = require('node:test');
const assert = require('node:assert');
const mammoth = require('mammoth');
const statement = require('../src/statement');

const entries = [
  { id: 'c', title: 'My appeal', from: 'Child Maintenance Service', sent: true, docDate: '2026-03-01', expectBy: '2026-03-29', createdAt: '2026-03-01T10:00:00Z', marks: [] },
  { id: 'a', title: 'Calculation decision', docType: 'Letter', from: 'Child Maintenance Service', ref: '12345 678', docDate: '2026-02-01', createdAt: '2026-02-02T10:00:00Z',
    marks: [{ page: 2, y0: 0.5, text: 'your income is 52,000 a year', note: 'This is my old Army salary, not my pension' }, { page: 1, y0: 0.2, text: 'Dear Mr Example', note: '' }], notes: 'Arrived late' },
  { id: 'u', title: 'Undated note', from: 'Me', createdAt: '2026-01-01T10:00:00Z' }
];
const replies = { c: { replied: false, waiting: true, overdue: true } };

test('draft: oldest first, undated last, document numbers, highlights, notes and no-reply', () => {
  const t = statement.draft('CMS recalculation', entries, replies, { name: 'Mark Example', address: '1 High Street\nSheldon' }, { today: '2026-11-27' });
  const ps = statement.paragraphs(t);
  assert.match(ps[0], /^I am Mark Example of 1 High Street, Sheldon\. This statement sets out what has happened about CMS recalculation/);
  assert.match(ps[1], /^On 1 February 2026, I received a letter from Child Maintenance Service \("Calculation decision"\), reference 12345 678 \(document 1\)\./);
  assert.ok(ps[1].indexOf('Dear Mr Example') < ps[1].indexOf('52,000'), 'highlights in page order');
  assert.match(ps[1], /On page 2 it says: "your income is 52,000 a year"\. This is my old Army salary, not my pension\. Arrived late\./);
  assert.match(ps[2], /^On 1 March 2026, I wrote to Child Maintenance Service \("My appeal"\) \(document 2\)\. I expected a reply by 29 March 2026\. As of 27 November 2026, I have not had one\./);
  assert.match(ps[3], /^On 1 January 2026, I received a letter from Me \("Undated note"\) \(document 3\)\./);
  assert.match(ps[4], /^\[Add anything else/);
  assert.ok(t.startsWith('1. I am') && t.includes('\n\n2. On 1 February'));
});

test('editing: paragraphs renumbered; Word and page say the same', async () => {
  const edited = '1. First.\n\n5. Moved up.\n\n\n2) Last one.';
  assert.deepStrictEqual(statement.paragraphs(edited), ['First.', 'Moved up.', 'Last one.']);
  const buf = await statement.docx('Statement about CMS', edited, { name: 'Mark Example' }, '2026-11-27');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const order = ['Statement about CMS', 'Mark Example', '1.', 'First.', '2.', 'Moved up.', '3.', 'Last one.', 'Signed:', 'Name: Mark Example', 'Date: 27 November 2026'];
  let at = 0; for (const s of order) { const i = value.indexOf(s, at); assert.ok(i >= 0, 'missing or out of order: ' + s); at = i; }
  const h = statement.html('Statement <x>', edited, { name: 'Mark' }, '2026-11-27');
  assert.ok(h.includes('<li>Moved up.</li>') && h.includes('Statement &lt;x&gt;') && !h.includes('<x>'));
});
