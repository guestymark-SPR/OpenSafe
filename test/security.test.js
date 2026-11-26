'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const sec = require('../src/secure');

const PW = 'correct horse battery';
const PHOTO = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('SECRET-PHOTO-BYTES-123')]);

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ossec-'));
  const s = new Store(dir); s.load(); return s;
}
function allFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}
function diskContains(dir, needle) {
  return allFiles(dir).filter(f => fs.readFileSync(f).includes(Buffer.from(needle)));
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => { assert.strictEqual(e.code, code, e.message); return true; });
}

test('turning on protection encrypts everything on disk', async () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Rolex Submariner', serial: 'ZX-998877', purchasePrice: 9000 });
  s.addPhoto(a.id, 'watch.png', PHOTO);
  s.addDocument(a.id, 'receipt.pdf', Buffer.from('%PDF receipt-text-777'), 'Receipt');
  assert.ok(diskContains(s.dir, 'Rolex Submariner').length > 0);

  const rk = await s.enableEncryption(PW);
  assert.ok(sec.looksLikeRecoveryKey(rk));
  for (const needle of ['Rolex Submariner', 'ZX-998877', 'SECRET-PHOTO-BYTES-123', 'receipt-text-777']) {
    assert.deepStrictEqual(diskContains(s.dir, needle), [], `"${needle}" found unencrypted on disk`);
  }
  assert.ok(fs.existsSync(s.binFile) && !fs.existsSync(s.file));
  assert.ok(fs.readdirSync(s.backupDir).every(f => f.endsWith('.bin')));
  const sj = fs.readFileSync(s.securityFile, 'utf8');
  assert.ok(!sj.includes(PW) && !sj.includes(rk));
  // still usable in this session
  assert.ok(s.readAttachment(a.id, s.getAsset(a.id).photos[0].file).equals(PHOTO));
});

test('locked until the right password; recovery key and password changes', async () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Laptop' });
  s.addPhoto(a.id, 'l.png', PHOTO);
  const rk = await s.enableEncryption(PW);

  const s2 = new Store(s.dir);
  assert.ok(s2.isLocked());
  assert.throws(() => s2.load(), (e) => e.code === 'LOCKED');
  await rejectsCode(s2.unlock('wrong password!'), 'WRONG_PASSWORD');
  await s2.unlock(PW);
  assert.strictEqual(s2.getAsset(a.id).name, 'Laptop');
  assert.ok(s2.readAttachment(a.id, s2.getAsset(a.id).photos[0].file).equals(PHOTO));

  // forgotten password
  const s3 = new Store(s.dir);
  await rejectsCode(s3.recover('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', 'new password 1'), 'WRONG_RECOVERY');
  await rejectsCode(s3.recover('not a key', 'new password 1'), 'WRONG_RECOVERY');
  await s3.recover(rk.toLowerCase().replace(/-/g, ' '), 'new password 1');
  assert.strictEqual(s3.getAsset(a.id).name, 'Laptop');
  await rejectsCode(new Store(s.dir).unlock(PW), 'WRONG_PASSWORD');
  await new Store(s.dir).unlock('new password 1');

  // change password
  await rejectsCode(s3.changePassword('nope nope', 'another pass'), 'WRONG_PASSWORD');
  await assert.rejects(s3.changePassword('new password 1', 'short'), /at least 8/);
  await s3.changePassword('new password 1', 'another pass 2');
  await new Store(s.dir).unlock('another pass 2');

  // new recovery key replaces the old one
  const rk2 = await s3.newRecoveryKey('another pass 2');
  assert.notStrictEqual(rk, rk2);
  await rejectsCode(new Store(s.dir).recover(rk, 'whatever pass'), 'WRONG_RECOVERY');
  await new Store(s.dir).recover(rk2, 'final password 3');
});

test('an interrupted "turn on" is finished on next unlock', async () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Bike' });
  s.addPhoto(a.id, 'b.png', PHOTO);
  await s.enableEncryption(PW);
  // Simulate leftovers from a power cut: a plain data file and a plain photo
  const plainJson = JSON.stringify(Object.assign({}, s.data, { assets: s.data.assets.map(x => Object.assign({}, x, { name: 'Bike plain copy' })) }));
  fs.writeFileSync(s.file, plainJson);
  fs.unlinkSync(s.binFile);
  const photoPath = s.attachmentPath(a.id, s.getAsset(a.id).photos[0].file);
  fs.writeFileSync(photoPath, PHOTO);
  const s2 = new Store(s.dir);
  await s2.unlock(PW);
  assert.strictEqual(s2.getAsset(a.id).name, 'Bike plain copy');
  assert.deepStrictEqual(diskContains(s.dir, 'Bike plain copy'), []);
  assert.deepStrictEqual(diskContains(s.dir, 'SECRET-PHOTO-BYTES-123'), []);
  assert.ok(fs.existsSync(s.binFile) && !fs.existsSync(s.file));
});

test('turning protection off decrypts everything', async () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Camera' });
  s.addPhoto(a.id, 'c.png', PHOTO);
  await s.enableEncryption(PW);
  await rejectsCode(s.disableEncryption('bad password'), 'WRONG_PASSWORD');
  await s.disableEncryption(PW);
  assert.ok(!fs.existsSync(s.securityFile) && !fs.existsSync(s.binFile) && fs.existsSync(s.file));
  assert.ok(allFiles(s.dir).every(f => !sec.isSealed(fs.readFileSync(f))));
  const s2 = new Store(s.dir); s2.load();
  assert.strictEqual(s2.getAsset(a.id).name, 'Camera');
  assert.ok(s2.readAttachment(a.id, s2.getAsset(a.id).photos[0].file).equals(PHOTO));
});

test('vault: items and files, PIN, lockout, recovery, hiding', async () => {
  const s = tmpStore();
  await assert.rejects(s.setupVault('1234'), /password protection/);
  const passport = s.saveAsset({ name: 'Passport', purchasePrice: 0, currentValue: 100 });
  s.addPhoto(passport.id, 'passport.png', PHOTO);
  const car = s.saveAsset({ name: 'Car', currentValue: 5000 });
  const v5 = s.addDocument(car.id, 'V5C-logbook.pdf', Buffer.from('%PDF logbook-secret-555'), 'Other');
  const rk = await s.enableEncryption(PW);
  await assert.rejects(s.setupVault('12'), /4 to 8 digits/);
  await s.setupVault('2468');
  s.moveItemToVault(passport.id, true);
  s.moveFileToVault(car.id, v5.id, true);
  assert.strictEqual(s.summary().currentTotal, 5100);

  // keyId 1 on disk for vault material
  const pPhoto = s.attachmentPath(passport.id, s.getAsset(passport.id).photos[0].file);
  assert.strictEqual(sec.keyIdOf(fs.readFileSync(pPhoto)), 1);
  assert.strictEqual(sec.keyIdOf(fs.readFileSync(s.attachmentPath(car.id, v5.file))), 1);

  s.lockVault();
  assert.strictEqual(s.getAsset(passport.id), null);
  assert.strictEqual(s.summary().currentTotal, 5000);
  assert.ok(!s.toCSV().includes('Passport'));
  const carView = s.viewAssets().find(x => x.id === car.id);
  assert.deepStrictEqual([carView.documents[0].name, carView.documents[0].locked], ['Vault file', true]);
  assert.ok(!JSON.stringify(s.data).includes('V5C-logbook'));
  assert.throws(() => s.readAttachment(car.id, v5.file), (e) => e.code === 'VAULT_LOCKED');
  assert.throws(() => s.removeAttachment(car.id, v5.id), (e) => e.code === 'VAULT_LOCKED');

  // a fresh session: password opens OpenSafe but not the vault
  const s2 = new Store(s.dir);
  await s2.unlock(PW);
  assert.ok(s2.vaultExists() && !s2.vaultUnlocked());
  assert.strictEqual(s2.getAsset(passport.id), null);
  for (let i = 0; i < 5; i++) await rejectsCode(s2.unlockVault('0000'), 'WRONG_PIN');
  await rejectsCode(s2.unlockVault('2468'), 'PIN_WAIT'); // even the right PIN waits
  s2._pin.until = 0;
  await s2.unlockVault('2468');
  assert.strictEqual(s2.getAsset(passport.id).name, 'Passport');
  assert.strictEqual(s2.viewAssets().find(x => x.id === car.id).documents[0].name, 'V5C-logbook.pdf');
  assert.ok(s2.readAttachment(passport.id, s2.getAsset(passport.id).photos[0].file).equals(PHOTO));

  // change PIN, forgotten PIN via recovery key
  await rejectsCode(s2.changePin('1111', '13579'), 'WRONG_PIN');
  await s2.changePin('2468', '13579');
  const s3 = new Store(s.dir); await s3.unlock(PW);
  await rejectsCode(s3.recoverVaultPin('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', '8642'), 'WRONG_RECOVERY');
  await s3.recoverVaultPin(rk, '8642');
  assert.ok(s3.vaultUnlocked());
  const s4 = new Store(s.dir); await s4.unlock(PW); await s4.unlockVault('8642');

  // can't remove a non-empty vault or turn protection off with a vault
  assert.throws(() => s4.removeVault(), /Move everything out/);
  await assert.rejects(s4.disableEncryption(PW), /vault/);
  s4.moveItemToVault(passport.id, false);
  s4.moveFileToVault(car.id, v5.id, false);
  assert.strictEqual(sec.keyIdOf(fs.readFileSync(pPhoto)), 0);
  assert.strictEqual(s4.getAsset(car.id).documents[0].name, 'V5C-logbook.pdf');
  s4.removeVault();
  assert.ok(!s4.vaultExists());
  await s4.disableEncryption(PW);
  const s5 = new Store(s.dir); s5.load();
  assert.strictEqual(s5.getAsset(passport.id).name, 'Passport');
});

test('new recovery key also opens the vault', async () => {
  const s = tmpStore();
  await s.enableEncryption(PW);
  await s.setupVault('1234');
  const a = s.saveAsset({ name: 'Will' });
  s.moveItemToVault(a.id, true);
  s.lockVault();
  await rejectsCode(s.newRecoveryKey(PW), 'VAULT_LOCKED');
  await s.unlockVault('1234');
  const rk2 = await s.newRecoveryKey(PW);
  const s2 = new Store(s.dir); await s2.unlock(PW);
  await s2.recoverVaultPin(rk2, '9999');
  assert.strictEqual(s2.getAsset(a.id).name, 'Will');
});

test('backups: encrypted backups stay encrypted and restore with their password', async () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Guitar' });
  s.addPhoto(a.id, 'g.png', PHOTO);
  await s.enableEncryption(PW);
  await s.setupVault('1234');
  const b = s.saveAsset({ name: 'Bonds' });
  s.moveItemToVault(b.id, true);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'osbk-'));
  const bk = s.backupTo(out);
  assert.deepStrictEqual(diskContains(bk, 'Guitar'), []);
  assert.deepStrictEqual(diskContains(bk, 'SECRET-PHOTO-BYTES-123'), []);

  // restore into a brand-new, unprotected OpenSafe
  const fresh = tmpStore();
  fresh.saveAsset({ name: 'Old thing' });
  const r = fresh.restoreFrom(bk);
  assert.deepStrictEqual(r, { locked: true });
  assert.ok(fresh.isLocked());
  await rejectsCode(fresh.unlock('other password'), 'WRONG_PASSWORD');
  await fresh.unlock(PW);
  assert.strictEqual(fresh.getAsset(a.id).name, 'Guitar');
  assert.strictEqual(fresh.getAsset(b.id), null);
  await fresh.unlockVault('1234');
  assert.strictEqual(fresh.getAsset(b.id).name, 'Bonds');

  // a plain (old) backup restored into a protected OpenSafe gets encrypted
  const plain = tmpStore();
  const p = plain.saveAsset({ name: 'Plain item' });
  plain.addPhoto(p.id, 'p.png', PHOTO);
  const pbk = plain.backupTo(fs.mkdtempSync(path.join(os.tmpdir(), 'osbk2-')));
  const target = tmpStore();
  await target.enableEncryption(PW);
  target.restoreFrom(pbk);
  assert.strictEqual(target.getAsset(p.id).name, 'Plain item');
  assert.deepStrictEqual(diskContains(target.dir, 'Plain item').filter(f => !f.includes('OpenSafe-backup-')), []);
  assert.deepStrictEqual(diskContains(target.attachDir, 'SECRET-PHOTO-BYTES-123'), []);
  // ...but not while a vault exists
  await fresh.lockVault();
  await assert.rejects(async () => fresh.restoreFrom(pbk), /no vault/);
});

test('phone import into a protected OpenSafe is encrypted; tampering is detected', async () => {
  const s = tmpStore();
  await s.enableEncryption(PW);
  s.importCapture({ format: 'opensafe-export', version: 1, items: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Imported drill', photos: [{ id: 'p', name: 'x.png', type: 'image/png', data: PHOTO.toString('base64') }] }] });
  assert.deepStrictEqual(diskContains(s.dir, 'Imported drill'), []);
  assert.deepStrictEqual(diskContains(s.dir, 'SECRET-PHOTO-BYTES-123'), []);
  // flip a byte in the data file: GCM catches it; the newest daily backup is used instead
  const buf = fs.readFileSync(s.binFile); buf[buf.length - 3] ^= 0xff; fs.writeFileSync(s.binFile, buf);
  const s2 = new Store(s.dir); await s2.unlock(PW);
  assert.strictEqual(s2.data.assets[0].name, 'Imported drill');
  assert.ok(fs.readdirSync(s.dir).some(f => f.includes('.corrupt-')));
});

test('insurance report works with encryption and leaves out the locked vault', async () => {
  const { buildReportHtml } = require('../src/report');
  const s = tmpStore();
  const a = s.saveAsset({ name: 'TV', currentValue: 500 });
  s.addPhoto(a.id, 'tv.png', PHOTO);
  const b = s.saveAsset({ name: 'Gold ring', currentValue: 900 });
  await s.enableEncryption(PW);
  await s.setupVault('1234');
  s.moveItemToVault(b.id, true);
  let html = buildReportHtml(s, {});
  assert.ok(html.includes('Gold ring') && html.includes('data:image/png;base64,'));
  assert.ok(!html.includes('file://'));
  s.lockVault();
  html = buildReportHtml(s, {});
  assert.ok(!html.includes('Gold ring') && html.includes('TV'));
});
