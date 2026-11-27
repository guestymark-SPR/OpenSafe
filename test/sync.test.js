'use strict';
// Keeping two PCs in step through a shared folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Sync, SUB } = require('../src/sync');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function pc(name) { const dir = tmp('ossync-' + name + '-'); const s = new Store(dir); s.load(); const y = new Sync(s, { deviceName: name }); s.onSave = () => y.noteSaved(); return { s, y, dir }; }
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const names = (s) => s.data.assets.map(a => a.name).sort();

test('one PC puts its copy in the folder; a new, empty PC takes it, photos included', () => {
  const shared = tmp('osshared-');
  const A = pc('LAPTOP'), B = pc('DESKTOP');
  const a = A.s.saveAsset({ name: 'Drill', location: 'Garage' });
  A.s.addPhoto(a.id, 'drill.jpg', JPG);
  const e = A.s.saveLibraryEntry({ kind: 'document', title: 'Award letter' });
  A.s.addLibraryFile(e.id, 'letter.pdf', Buffer.from('%PDF-1.4 x'));
  A.y.setFolder(shared); A.y.afterLoad();
  assert.deepStrictEqual(A.y.plan(), { action: 'push', first: true });
  const r = A.y.push();
  assert.strictEqual(r.files, 2);
  assert.ok(fs.existsSync(path.join(shared, SUB, 'state.json')));
  B.y.setFolder(shared); B.y.afterLoad();
  assert.strictEqual(B.y.plan().action, 'pull', 'nothing on the new PC to lose');
  const p = B.y.pull();
  assert.strictEqual(p.copied, 2);
  B.s.load(); B.y.afterLoad();
  assert.deepStrictEqual(names(B.s), ['Drill']);
  const photo = B.s.getAsset(a.id).photos[0];
  assert.ok(B.s.readAttachment(a.id, photo.file).equals(JPG));
  assert.strictEqual(B.s.readLibraryFile(e.id, B.s.getLibraryEntry(e.id).files[0].id).buffer.toString(), '%PDF-1.4 x');
  assert.strictEqual(B.y.plan().action, 'none');
  assert.strictEqual(A.y.plan().action, 'none');
});

test('changes go back and forth; saving without a real change sends nothing', () => {
  const shared = tmp('osshared-');
  const A = pc('A'), B = pc('B');
  A.s.saveAsset({ name: 'Drill' });
  A.y.setFolder(shared); A.y.afterLoad(); A.y.push();
  B.y.setFolder(shared); B.y.afterLoad(); B.y.pull(); B.s.load(); B.y.afterLoad();
  // B adds an item: B has the newer copy, A takes it
  const ladder = B.s.saveAsset({ name: 'Ladder' });
  assert.strictEqual(B.y.status().dirty, true);
  assert.strictEqual(B.y.plan().action, 'push'); B.y.push();
  assert.strictEqual(A.y.plan().action, 'pull'); A.y.pull(); A.s.load(); A.y.afterLoad();
  assert.deepStrictEqual(names(A.s), ['Drill', 'Ladder']);
  // a save that changes nothing
  A.s.save();
  assert.strictEqual(A.y.status().dirty, false);
  assert.strictEqual(A.y.plan().action, 'none');
  // deleting on one PC deletes on the other (it goes to the bin there too)
  A.s.deleteAsset(ladder.id); A.y.push();
  B.y.pull(); B.s.load(); B.y.afterLoad();
  assert.deepStrictEqual(names(B.s), ['Drill']);
  assert.strictEqual(B.s.binView().length, 1);
});

test('both PCs changed: nothing is overwritten until you choose, and the other copy can be kept as a backup', () => {
  const shared = tmp('osshared-');
  const A = pc('A'), B = pc('B');
  A.s.saveAsset({ name: 'Drill' }); A.y.setFolder(shared); A.y.afterLoad(); A.y.push();
  B.y.setFolder(shared); B.y.afterLoad(); B.y.pull(); B.s.load(); B.y.afterLoad();
  A.s.saveAsset({ name: 'From A' }); A.y.push();
  B.s.saveAsset({ name: 'From B' });
  const plan = B.y.plan();
  assert.strictEqual(plan.action, 'conflict');
  assert.strictEqual(plan.by.name, 'A');
  // keep B's: A's copy is saved as a normal backup folder first, which restores
  const bk = B.y.saveRemoteAsBackup(B.s.backupDir);
  B.y.push();
  const C = pc('C'); C.s.restoreFrom(bk);
  assert.deepStrictEqual(names(C.s), ['Drill', 'From A']);
  assert.deepStrictEqual(names(B.s), ['Drill', 'From B']);
  assert.strictEqual(A.y.plan().action, 'pull');
});

test('a PC that already has things is asked first, not overwritten', () => {
  const shared = tmp('osshared-');
  const A = pc('A'), B = pc('B');
  A.s.saveAsset({ name: 'Drill' }); A.y.setFolder(shared); A.y.afterLoad(); A.y.push();
  B.s.saveAsset({ name: 'Mine' });
  B.y.setFolder(shared); B.y.afterLoad();
  assert.strictEqual(B.y.plan().action, 'first');
});

test('a copy still arriving (missing or different file) is never taken', () => {
  const shared = tmp('osshared-');
  const A = pc('A'), B = pc('B');
  const a = A.s.saveAsset({ name: 'Drill' }); A.s.addPhoto(a.id, 'd.jpg', JPG);
  A.y.setFolder(shared); A.y.afterLoad(); A.y.push();
  const photoRel = A.s.getAsset(a.id).photos[0].file;
  const remoteFile = path.join(shared, SUB, 'attachments', a.id, photoRel);
  B.s.saveAsset({ name: 'Keep me' });
  B.y.setFolder(shared); B.y.cfg.lastRev = 'older'; B.y.cfg.dirty = false; // as if in step before
  fs.renameSync(remoteFile, remoteFile + '.away');
  assert.strictEqual(B.y.plan().action, 'wait');
  assert.throws(() => B.y.pull(), (e) => e.code === 'WAIT');
  fs.renameSync(remoteFile + '.away', remoteFile);
  // same size, different bytes (half-synced)
  const orig = fs.readFileSync(remoteFile); const junk = Buffer.from(orig); junk[0] ^= 0xff; fs.writeFileSync(remoteFile, junk);
  assert.throws(() => B.y.pull(), (e) => e.code === 'WAIT');
  B.s.load();
  assert.deepStrictEqual(names(B.s), ['Keep me'], 'nothing replaced');
  assert.ok(!fs.existsSync(path.join(B.dir, 'sync-incoming')));
  fs.writeFileSync(remoteFile, orig);
  B.y.pull(); B.s.load();
  assert.deepStrictEqual(names(B.s), ['Drill']);
});

test('with password protection: the shared folder stays encrypted, the other PC takes it while locked, the vault survives', async () => {
  const shared = tmp('osshared-');
  const A = pc('A'), B = pc('B');
  const a = A.s.saveAsset({ name: 'Passport', serial: 'SECRETSERIAL123' });
  A.s.addPhoto(a.id, 'p.jpg', Buffer.from('PHOTO-BYTES-SECRET'));
  await A.s.enableEncryption('correct horse battery');
  await A.s.setupVault('2468');
  A.s.moveItemToVault(a.id, true);
  A.y.setFolder(shared); A.y.afterLoad(); A.y.push();
  // nothing readable in the shared folder
  const all = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? all(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of all(path.join(shared, SUB))) { const b = fs.readFileSync(f); assert.ok(!b.includes('SECRETSERIAL123') && !b.includes('PHOTO-BYTES-SECRET'), f); }
  // the vault, unlocked and saved again with no change, doesn't count as a change
  A.s.save();
  assert.strictEqual(A.y.status().dirty, false, 'unchanged vault saves identically');
  // B takes it before anyone unlocks it, then opens it with A's password and PIN
  B.y.setFolder(shared); B.y.afterLoad();
  B.y.pull();
  assert.ok(B.s.isEncrypted());
  B.s.lock();
  await B.s.unlock('correct horse battery'); B.y.afterLoad();
  await B.s.unlockVault('2468');
  const v = B.s.allAssets().find(x => x.name === 'Passport');
  assert.ok(v && B.s.isVaultAsset(v));
  assert.strictEqual(B.s.readAttachment(v.id, v.photos[0].file).toString(), 'PHOTO-BYTES-SECRET');
  B.s.save();
  assert.strictEqual(B.y.status().dirty, false);
});

test('the shared folder can\'t be inside OpenSafe\'s own folder', () => {
  const A = pc('A');
  assert.throws(() => A.y.setFolder(path.join(A.dir, 'attachments')), /outside/);
  assert.throws(() => A.y.setFolder(path.join(os.tmpdir(), 'no-such-folder-' + Date.now())), /doesn't exist/);
  A.y.setFolder(''); assert.strictEqual(A.y.enabled(), false);
});
