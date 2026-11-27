'use strict';
// Filling in PDF forms: boxes found in page order with labels, suggestions, filling and locking.
const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument, PDFName, PDFHexString } = require('pdf-lib');
const pdfform = require('../src/pdfform');

async function makeForm() {
  const d = await PDFDocument.create(), f = d.getForm();
  const p1 = d.addPage([595, 842]), p2 = d.addPage([595, 842]);
  const text = (name, page, y, tip, opts = {}) => { const t = f.createTextField(name); if (tip) t.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tip)); if (opts.max) t.setMaxLength(opts.max); t.addToPage(page, { x: 200, y, width: 250, height: 18 }); if (opts.ro) t.enableReadOnly(); return t; };
  text('topmostSubform[0].Page1[0].Surname[0]', p1, 720, 'Surname');
  text('topmostSubform[0].Page1[0].Name[0]', p1, 760, 'Your full name');
  text('topmostSubform[0].Page1[0].AddrLine1[0]', p1, 680, 'Address line 1');
  text('topmostSubform[0].Page1[0].Postcode[0]', p1, 640, 'Postcode', { max: 8 });
  text('NINO', p1, 600, 'National Insurance number');
  text('OfficeUse', p1, 560, 'For office use', { ro: true });
  text('DateSigned', p2, 300, 'Date');
  const c = f.createCheckBox('Agree'); c.addToPage(p2, { x: 200, y: 400, width: 12, height: 12 });
  const dd = f.createDropdown('Title'); dd.addOptions(['Mr', 'Mrs', 'Ms']); dd.addToPage(p1, { x: 200, y: 790, width: 60, height: 18 });
  return Buffer.from(await d.save());
}
const me = { name: 'Mark Andrew Example', address: '1 High Street\nSheldon\nBirmingham\nB26 1AA', phone: '07700 900123', email: 'mark@example.com' };

test('guesses from your details', () => {
  const g = (l) => pdfform.guess(l, me, new Date('2026-11-27T12:00:00'));
  assert.strictEqual(g('Your full name'), 'Mark Andrew Example');
  assert.strictEqual(g('Forename(s)'), 'Mark Andrew');
  assert.strictEqual(g('Surname'), 'Example');
  assert.strictEqual(g('Address line 2'), 'Sheldon');
  assert.strictEqual(g('Town or city'), 'Birmingham');
  assert.strictEqual(g('Postcode'), 'B26 1AA');
  assert.strictEqual(g('Email address'), 'mark@example.com');
  assert.strictEqual(g('Daytime telephone number'), '07700 900123');
  assert.strictEqual(g('Date'), '27/11/2026');
  assert.strictEqual(g('Date of birth'), '', 'never guessed');
  assert.strictEqual(g('National Insurance number'), '');
  assert.strictEqual(pdfform.ukPostcode('blah b261aa'), 'B26 1AA');
});

test('reads the boxes in page order with labels, suggestions and remembered answers', async () => {
  const r = await pdfform.read(await makeForm(), { me, remembered: { 'national insurance number': 'AB123456C' }, now: new Date('2026-11-27T12:00:00') });
  assert.strictEqual(r.pages, 2); assert.strictEqual(r.xfa, false);
  assert.deepStrictEqual(r.fields.map(f => [f.page, f.label]), [[1, 'Title'], [1, 'Your full name'], [1, 'Surname'], [1, 'Address line 1'], [1, 'Postcode'], [1, 'National Insurance number'], [1, 'For office use'], [2, 'Agree'], [2, 'Date']]);
  const by = Object.fromEntries(r.fields.map(f => [f.label, f]));
  assert.strictEqual(by['Your full name'].suggest, 'Mark Andrew Example');
  assert.strictEqual(by['National Insurance number'].suggest, 'AB123456C', 'remembered from an earlier form');
  assert.strictEqual(by['For office use'].readOnly, true);
  assert.deepStrictEqual(by.Title.options, ['Mr', 'Mrs', 'Ms']);
  assert.strictEqual(by.Postcode.maxLength, 8);
});

test('fills, keeps boxes editable or locks them', async () => {
  const bytes = await makeForm();
  const v = { 'topmostSubform[0].Page1[0].Name[0]': 'Mark Example', 'topmostSubform[0].Page1[0].Postcode[0]': 'B26 1AA EXTRA', Agree: true, Title: 'Mr', OfficeUse: 'hacked' };
  const r = await pdfform.fill(bytes, v);
  assert.strictEqual(r.filled, 4);
  const back = await pdfform.read(Buffer.from(r.bytes));
  const by = Object.fromEntries(back.fields.map(f => [f.name, f.value]));
  assert.strictEqual(by['topmostSubform[0].Page1[0].Name[0]'], 'Mark Example');
  assert.strictEqual(by['topmostSubform[0].Page1[0].Postcode[0]'], 'B26 1AA ', 'cut to the box\'s limit');
  assert.strictEqual(by.Agree, true); assert.strictEqual(by.Title, 'Mr');
  assert.strictEqual(by.OfficeUse, '', 'read-only boxes left alone');
  const locked = await pdfform.fill(bytes, v, { flatten: true });
  assert.strictEqual((await pdfform.read(Buffer.from(locked.bytes))).fields.length, 0, 'locked: no boxes left');
});
