'use strict';
// Documents and Data (the library): store, search, bin, reminders, encryption and the vault.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

const PW = 'correct horse battery';
function tmpStore() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oslib-')); const s = new Store(dir); s.load(); return s; }
function allFiles(dir) { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p); } return out; }
const diskContains = (dir, needle) => allFiles(dir).filter(f => fs.readFileSync(f).includes(Buffer.from(needle)));
const iso = (d) => d.toISOString().slice(0, 10);

test('documents and data are kept apart, with cleaned fields', () => {
  const s = tmpStore();
  const d = s.saveLibraryEntry({ kind: 'document', title: '  Pension award letter ', docType: 'Benefits & pension', from: 'Veterans UK', docDate: '2026-05-01', ref: 'AFCS/123', tags: 'pension, afcs' });
  const x = s.saveLibraryEntry({ kind: 'data', title: 'Booking email', folder: 'Emails', docType: 'Letter' });
  const odd = s.saveLibraryEntry({ kind: 'nonsense', title: '', docType: 'Rubbish', docDate: '2026-02-31' });
  assert.strictEqual(d.title, 'Pension award letter');
  assert.deepStrictEqual(d.tags, ['pension', 'afcs']);
  assert.strictEqual(x.docType, '', 'data entries have no document type');
  assert.strictEqual(odd.kind, 'document');
  assert.strictEqual(odd.title, 'Untitled');
  assert.strictEqual(odd.docType, 'Letter');
  assert.strictEqual(odd.docDate, '');
  assert.deepStrictEqual(s.libraryView('document').map(e => e.title).sort(), ['Pension award letter', 'Untitled']);
  assert.deepStrictEqual(s.libraryView('data').map(e => e.title), ['Booking email']);
  // editing can't change which list it's in
  const e2 = s.saveLibraryEntry({ id: x.id, kind: 'document', title: 'Booking email (Eurotunnel)' });
  assert.strictEqual(e2.kind, 'data');
  // survives a reload
  const s2 = new Store(s.dir); s2.load();
  assert.strictEqual(s2.libraryView('data')[0].title, 'Booking email (Eurotunnel)');
  assert.strictEqual(s2.libraryView('document').find(e => e.ref === 'AFCS/123').from, 'Veterans UK');
});

test('files: add, read, remove; programs refused', () => {
  const s = tmpStore();
  const e = s.saveLibraryEntry({ kind: 'data', title: 'Stuff' });
  const f = s.addLibraryFile(e.id, 'notes.pdf', Buffer.from('%PDF hello'));
  assert.strictEqual(f.size, 10);
  assert.ok(s.readLibraryFile(e.id, f.id).buffer.equals(Buffer.from('%PDF hello')));
  assert.strictEqual(s.readLibraryFile(e.id, f.id).name, 'notes.pdf');
  for (const bad of ['setup.exe', 'run.BAT', 'x.ps1', 'a.js', 'link.lnk']) assert.throws(() => s.addLibraryFile(e.id, bad, Buffer.from('x')), /can't be stored/);
  assert.throws(() => s.addLibraryFile(e.id, 'empty.txt', Buffer.alloc(0)), /empty/);
  s.removeLibraryFile(e.id, f.id);
  assert.strictEqual(s.getLibraryEntry(e.id).files.length, 0);
  assert.strictEqual(fs.readdirSync(path.join(s.attachDir, e.id)).length, 0);
});

test('search finds words in the details and inside the files', () => {
  const s = tmpStore();
  const a = s.saveLibraryEntry({ kind: 'document', title: 'CMS letter', from: 'Child Maintenance Service' });
  const fa = s.addLibraryFile(a.id, 'scan.pdf', Buffer.from('%PDF'));
  const b = s.saveLibraryEntry({ kind: 'document', title: 'Council tax bill', ref: 'CT-55' });
  const c = s.saveLibraryEntry({ kind: 'data', title: 'Council email' });
  assert.deepStrictEqual(s.libraryTextQueue().map(q => q.fileId), [fa.id]);
  s.setLibraryText(a.id, fa.id, 'Dear Mr Smith, your case reference 1234-5678 has been reviewed. The new calculation starts on 1 June.');
  assert.deepStrictEqual(s.libraryTextQueue(), []);
  const r = s.librarySearch('document', '1234-5678');
  assert.deepStrictEqual(r.map(x => x.id), [a.id]);
  assert.match(r[0].snippet, /case reference 1234-5678 has been/);
  assert.deepStrictEqual(s.librarySearch('document', 'council').map(x => x.id), [b.id], 'data entries are not in document search');
  assert.deepStrictEqual(s.librarySearch('data', 'council').map(x => x.id), [c.id]);
  assert.deepStrictEqual(s.librarySearch('document', 'calculation cms').map(x => x.id), [a.id], 'all words must match, in text or details');
  assert.deepStrictEqual(s.librarySearch('document', 'calculation council'), []);
  assert.strictEqual(s.libraryView('document').find(e => e.id === a.id).hasText, true);
  assert.strictEqual(s.libraryView('document').find(e => e.id === a.id).text, undefined, 'full text is not sent to the window');
  assert.match(s.libraryText(a.id, fa.id), /^Dear Mr Smith/);
});

test('bin: delete, restore, delete for good, and clear-out after 30 days', () => {
  const s = tmpStore();
  const e = s.saveLibraryEntry({ kind: 'document', title: 'Old letter' });
  s.addLibraryFile(e.id, 'a.jpg', Buffer.from('JPEGDATA'));
  s.deleteLibraryEntry(e.id);
  assert.deepStrictEqual(s.libraryView('document'), []);
  assert.deepStrictEqual(s.libraryBinView('document').map(b => b.title), ['Old letter']);
  s.restoreLibraryEntry(e.id);
  assert.strictEqual(s.libraryView('document').length, 1);
  s.deleteLibraryEntry(e.id);
  s.data.libBin[0].deletedAt = new Date(Date.now() - 31 * 86400000).toISOString();
  assert.strictEqual(s.purgeOldBin(), 1);
  assert.deepStrictEqual(s.libraryBinView(), []);
  assert.ok(!fs.existsSync(path.join(s.attachDir, e.id)), 'files deleted for good');
});

test('reply-by dates show in reminders until marked done', () => {
  const s = tmpStore();
  const soon = new Date(Date.now() + 5 * 86400000);
  const e = s.saveLibraryEntry({ kind: 'document', title: 'Mandatory reconsideration', from: 'DWP', actBy: iso(soon) });
  s.saveLibraryEntry({ kind: 'document', title: 'Far away', actBy: iso(new Date(Date.now() + 200 * 86400000)) });
  const r = s.reminders(new Date(), 30).filter(x => x.libraryId);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].libraryId, e.id);
  assert.strictEqual(r[0].assetName, 'Mandatory reconsideration (DWP)');
  assert.strictEqual(r[0].kind, 'Reply or act by');
  s.saveLibraryEntry({ id: e.id, actDone: true });
  assert.deepStrictEqual(s.reminders(new Date(), 30).filter(x => x.libraryId), []);
});

test('encrypted on disk with protection on, and the vault hides whole entries', async () => {
  const s = tmpStore();
  const e = s.saveLibraryEntry({ kind: 'document', title: 'Medical report Dr Patel', ref: 'NHS-778899' });
  s.addLibraryFile(e.id, 'report.pdf', Buffer.from('%PDF SECRET-DIAGNOSIS-TEXT'));
  s.setLibraryText(e.id, s.getLibraryEntry(e.id).files[0].id, 'SECRET-DIAGNOSIS-TEXT read from the page');
  await s.enableEncryption(PW);
  for (const needle of ['Medical report Dr Patel', 'NHS-778899', 'SECRET-DIAGNOSIS-TEXT']) assert.deepStrictEqual(diskContains(s.dir, needle), [], needle);

  await s.setupVault('4826');
  s.moveLibraryToVault(e.id, true);
  assert.strictEqual(s.libraryView('document')[0].inVault, true);
  s.lockVault();
  assert.deepStrictEqual(s.libraryView('document'), [], 'hidden while the vault is locked');
  assert.deepStrictEqual(s.librarySearch('document', 'Patel'), []);
  assert.deepStrictEqual(s.libraryTextQueue(), []);
  assert.throws(() => s.readLibraryFile(e.id, 'x'), (err) => err.code === 'VAULT_LOCKED');
  assert.throws(() => s.removeVault(), /Unlock the vault/);
  // reopen everything from disk
  const s2 = new Store(s.dir);
  await s2.unlock(PW); s2.load();
  assert.deepStrictEqual(s2.libraryView('document'), []);
  await s2.unlockVault('4826');
  const v = s2.libraryView('document');
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].inVault, true);
  assert.ok(s2.readLibraryFile(e.id, v[0].files[0].id).buffer.equals(Buffer.from('%PDF SECRET-DIAGNOSIS-TEXT')));
  assert.deepStrictEqual(s2.librarySearch('document', 'diagnosis').map(x => x.id), [e.id]);
  assert.throws(() => s2.removeVault(), /documents and data/);
  // the vault key really protects the file: the main key alone can't open it
  const s3 = new Store(s.dir);
  await s3.unlock(PW); s3.load();
  const f = s2.getLibraryEntry(e.id).files[0];
  assert.throws(() => s3.readAttachment(e.id, f.file));
  // out of the vault again
  s2.moveLibraryToVault(e.id, false);
  s2.lockVault();
  assert.strictEqual(s2.libraryView('document')[0].inVault, false);
  assert.ok(s2.readLibraryFile(e.id, f.id).buffer.equals(Buffer.from('%PDF SECRET-DIAGNOSIS-TEXT')));
});

test('backup and restore include documents and data', () => {
  const s = tmpStore();
  const e = s.saveLibraryEntry({ kind: 'data', title: 'Tax return 2025' });
  const f = s.addLibraryFile(e.id, 'return.pdf', Buffer.from('%PDF TAX'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'oslibbk-'));
  const bk = s.backupTo(dest);
  s.deleteLibraryEntry(e.id); s.purgeLibraryEntry(e.id);
  assert.deepStrictEqual(s.libraryView('data'), []);
  s.restoreFrom(typeof bk === 'string' ? bk : bk.path || bk.dir);
  const back = s.libraryView('data');
  assert.strictEqual(back.length, 1);
  assert.ok(s.readLibraryFile(e.id, f.id).buffer.equals(Buffer.from('%PDF TAX')));
});

test('move between Documents and Data, into folders, and link to items', () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Boiler' });
  const d = s.saveLibraryEntry({ kind: 'document', title: 'Boiler service letter', docType: 'Home' });
  const x = s.saveLibraryEntry({ kind: 'data', title: 'Manual.pdf' });
  assert.strictEqual(s.moveLibrary([d.id], { kind: 'data', folder: 'House' }), 1);
  let e = s.getLibraryEntry(d.id);
  assert.strictEqual(e.kind, 'data'); assert.strictEqual(e.folder, 'House'); assert.strictEqual(e.docType, '');
  s.moveLibrary(d.id, { kind: 'document' });
  e = s.getLibraryEntry(d.id);
  assert.strictEqual(e.kind, 'document'); assert.strictEqual(e.docType, 'Home', 'type comes back');
  s.moveLibrary([x.id], { folder: 'Manuals' });
  assert.strictEqual(s.getLibraryEntry(x.id).folder, 'Manuals');
  assert.strictEqual(s.getLibraryEntry(x.id).kind, 'data');
  // links
  assert.strictEqual(s.linkLibrary([d.id, x.id], a.id, true), 2);
  assert.strictEqual(s.linkLibrary([d.id], a.id, true), 0, 'already linked');
  assert.deepStrictEqual(s.libraryView().filter(v => v.assetIds.includes(a.id)).map(v => v.title).sort(), ['Boiler service letter', 'Manual.pdf']);
  s.linkLibrary(x.id, a.id, false);
  assert.deepStrictEqual(s.libraryView().filter(v => v.assetIds.includes(a.id)).map(v => v.title), ['Boiler service letter']);
  assert.throws(() => s.linkLibrary(d.id, 'nope', true), /Item not found/);
  const s2 = new Store(s.dir); s2.load();
  assert.deepStrictEqual(s2.getLibraryEntry(d.id).assetIds, [a.id]);
});
