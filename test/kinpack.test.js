'use strict';
// "If something happens to me" pack: encrypted, opens with the right passphrase only, and the page gives nothing away.
const test = require('node:test');
const assert = require('node:assert');
const kin = require('../src/kinpack');

const content = { owner: 'Mark Example', made: '27 November 2026', letter: 'Dear family, the will is with Smith & Co.', where: 'Deeds in the safe',
  contacts: [{ name: 'Smith & Co', role: 'Solicitor', contact: '0121 000 0000' }], policies: [{ insurer: 'Aviva', type: 'Home', policyNumber: 'HP123' }],
  items: [{ name: 'Harley Low Rider S', location: 'Garage', value: '£18,000.00', details: 'Serial 1HD' }],
  documents: [{ title: 'Will', files: [{ name: 'will.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 secret will').toString('base64') }] }] };

test('round trip with the right passphrase', () => {
  const html = kin.build(content, 'correct horse battery staple');
  const pack = JSON.parse(html.match(/const PACK = (\{.*?\});/)[1]);
  assert.strictEqual(pack.iter, 600000);
  assert.deepStrictEqual(kin.decrypt(pack, 'correct horse battery staple'), content);
});
test('wrong passphrase fails', () => {
  const pack = kin.encrypt(content, 'correct horse battery staple');
  assert.throws(() => kin.decrypt(pack, 'correct horse battery stapler'));
});
test('the page shows nothing of what is inside', () => {
  const html = kin.build(content, 'correct horse battery staple');
  for (const secret of ['Smith', 'Aviva', 'HP123', 'Harley', 'Deeds', 'secret will', 'Garage']) assert.ok(!html.includes(secret), secret);
  assert.ok(html.includes('Mark Example')); // whose it is, so they know which file
  assert.ok(html.includes("default-src 'none'")); // the page can't load or send anything
});
test('salt and iv differ each time', () => {
  const a = kin.encrypt(content, 'p'.repeat(12) + 'x'), b = kin.encrypt(content, 'p'.repeat(12) + 'x');
  assert.notStrictEqual(a.salt, b.salt); assert.notStrictEqual(a.iv, b.iv);
});
test('weak passphrases are refused', () => {
  assert.ok(kin.weakness('short'));
  assert.ok(kin.weakness('aaaaaaaaaaaaaa'));
  assert.ok(kin.weakness('password123456'));
  assert.strictEqual(kin.weakness('tulip anchor rain velvet'), '');
});
test('an owner name cannot break the page', () => {
  const html = kin.build(Object.assign({}, content, { owner: '</title><script>alert(1)</script>' }), 'tulip anchor rain velvet');
  assert.ok(!html.includes('<script>alert(1)'));
});
