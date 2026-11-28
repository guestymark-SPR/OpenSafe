'use strict';
// Bank CSV import: the layouts reported for Starling, Nationwide and NatWest, plus the safety rules.
const test = require('node:test');
const assert = require('node:assert');
const b = require('../src/bankcsv');

const starling = 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes\n' +
  '01/11/2026,Opening Balance,,,,1000.00,,\n' +
  '02/11/2026,Tesco,TESCO STORES 3021,CONTACTLESS,-15.50,984.50,GROCERIES,\n' +
  '03/11/2026,Veterans UK,AFCS PAYMENT,FASTER PAYMENT,1200.00,2184.50,INCOME,\n' +
  '04/11/2026,Octopus Energy,OCTOPUS 12345678,DIRECT DEBIT,-98.21,2086.29,BILLS_AND_SERVICES,\n';
// Nationwide's older layout: balance lines first, day-month-name dates, £ signs, separate paid out / paid in, Windows-1252 encoding.
const nationwideText = '"Account Name:","FlexAccount ****12345"\n"Account Balance:","£3720.00"\n"Available Balance: ","£3720.00"\n\n' +
  '"Date","Transaction type","Description","Paid out","Paid in","Balance"\n' +
  '"21 Nov 2026","Transfer from","0275/636 848 557","","£120.00","£3840.00"\n' +
  '"22 Nov 2026","Direct debit","COUNCIL TAX","£145.00","","£3695.00"\n' +
  '"23 Nov 2026","Visa purchase","AMAZON.CO.UK","£1,019.99","","£2675.01"\n';
const nationwide = Buffer.from(nationwideText, 'latin1'); // £ as 0xA3, not UTF-8
const natwest = 'Date,Type,Description,Value,Balance,Account Name,Account Number\n' +
  '05/11/2026,D/D,"SKY DIGITAL , 12345678",-45.00,955.00,MR M EXAMPLE,\'600000-12345678\n' +
  '06/11/2026,BAC,"DWP PIP",434.00,1389.00,MR M EXAMPLE,\'600000-12345678\n' +
  '06/11/2026,POS,"COSTA COFFEE",-3.20,1385.80,MR M EXAMPLE,\'600000-12345678\n' +
  '06/11/2026,POS,"COSTA COFFEE",-3.20,1382.60,MR M EXAMPLE,\'600000-12345678\n';

test('Starling: signed amounts, payee + reference, opening balance row skipped', () => {
  const r = b.read(starling, 'starling');
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.transactions.length, 3);
  assert.strictEqual(r.skipped, 1);
  assert.deepStrictEqual(r.transactions.map(t => [t.date, t.amount]), [['2026-11-02', -1550], ['2026-11-03', 120000], ['2026-11-04', -9821]]);
  assert.strictEqual(r.transactions[0].description, 'Tesco — TESCO STORES 3021');
  assert.strictEqual(r.transactions[2].description, 'Octopus Energy — OCTOPUS ••••5678');
  assert.strictEqual(r.transactions[0].bankCategory, 'GROCERIES');
});
test('Nationwide: finds the heading row after the balance lines, reads Windows-1252 £ and paid out / in', () => {
  const r = b.read(nationwide, 'nationwide');
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual(r.transactions.map(t => [t.date, t.amount]), [['2026-11-21', 12000], ['2026-11-22', -14500], ['2026-11-23', -101999]]);
  assert.strictEqual(r.transactions[0].description, '••••8557'); // a Nationwide account number in the description, masked
  assert.strictEqual(r.transactions[2].balance, 267501);
});
test('NatWest: single Value column; account name and number never read', () => {
  const r = b.read(natwest, 'natwest');
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.transactions.length, 4);
  assert.strictEqual(r.transactions[1].amount, 43400);
  const all = JSON.stringify(r);
  assert.ok(!all.includes('12345678') && !all.includes('600000') && !all.includes('MR M EXAMPLE'), 'no account details anywhere in the result');
  assert.strictEqual(r.headings[5], null); assert.strictEqual(r.headings[6], null);
});
test('two identical coffees on one day are both kept, and re-reading the file gives the same keys', () => {
  const a = b.read(natwest, 'natwest').transactions, c = b.read(natwest, 'natwest').transactions;
  assert.notStrictEqual(a[2].key, a[3].key);
  assert.deepStrictEqual(a.map(t => t.key), c.map(t => t.key));
});
test('wrong bank chosen: stops and asks for the columns instead of guessing', () => {
  const r = b.read(starling, 'nationwide');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.needsMap, true);
  assert.match(r.reason, /Nationwide may have changed its layout/);
  assert.strictEqual(r.map.date, 0); assert.strictEqual(r.map.amount, 4);
  const m = b.readWithMap(starling, 'nationwide', r.map);
  assert.ok(m.ok); assert.strictEqual(m.transactions.length, 3);
});
test('Other bank: guesses money out / money in columns', () => {
  const csv = 'Transaction Date,Details,Money Out,Money In,Balance\n01/12/2026,RENT,650.00,,100.00\n02/12/2026,WAGES,,1500.00,1600.00\n';
  const r = b.read(csv, 'other');
  assert.strictEqual(r.needsMap, true);
  const m = b.readWithMap(csv, 'other', r.map);
  assert.deepStrictEqual(m.transactions.map(t => t.amount), [-65000, 150000]);
});
test('a saved map is reused only while the headings are the same', () => {
  const csv = 'When,What,How much\n01/12/2026,RENT,-650\n';
  const saved = { headings: ['When', 'What', 'How much'], map: { date: 0, desc: 1, amount: 2 } };
  assert.strictEqual(b.read(csv, 'other', saved).transactions[0].amount, -65000);
  assert.strictEqual(b.read(csv.replace('How much', 'Amount'), 'other', saved).ok, false);
});
test('dates are day first and impossible dates are refused', () => {
  assert.strictEqual(b.parseDate('01/08/2026'), '2026-08-01');
  assert.strictEqual(b.parseDate('1-Aug-26'), '2026-08-01');
  assert.strictEqual(b.parseDate('2026-08-01T10:00:00Z'), '2026-08-01');
  assert.strictEqual(b.parseDate('31/02/2026'), '');
  assert.strictEqual(b.parseDate('13/13/2026'), '');
});
test('amounts', () => {
  assert.strictEqual(b.parsePence('£1,234.56'), 123456);
  assert.strictEqual(b.parsePence('(12.00)'), -1200);
  assert.strictEqual(b.parsePence('12.00 DR'), -1200);
  assert.strictEqual(b.parsePence('£-5'), -500);
  assert.strictEqual(b.parsePence('-£5.5'), -550);
  assert.strictEqual(b.parsePence(''), null);
  assert.strictEqual(b.parsePence('abc'), null);
});
test('unreadable rows are reported, not silently dropped', () => {
  const r = b.read('Date,Description,Amount\n01/12/2026,A,-1\nsoon,B,-2\n', 'other');
  const m = b.readWithMap('Date,Description,Amount\n01/12/2026,A,-1\nsoon,B,-2\n', 'other', r.map);
  assert.strictEqual(m.transactions.length, 1); assert.strictEqual(m.problemCount, 1); assert.match(m.problems[0], /date not understood \(soon\)/);
});
test('masking leaves dates and amounts alone, hides account-like numbers', () => {
  assert.strictEqual(b.maskNumbers('REF 12/11/2026 PAYMENT'), 'REF 12/11/2026 PAYMENT');
  assert.strictEqual(b.maskNumbers('TO 20-00-00 43218765'), 'TO ••••8765');
  const r = b.read('Date,Type,Description,Value,Balance\n06/11/2026,POS,COSTA,-1234567.00,996.80\n', 'other');
  assert.deepStrictEqual(r.sample[0], ['06/11/2026', 'POS', 'COSTA', '-1234567.00', '996.80']);
});
