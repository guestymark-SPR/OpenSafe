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

test('suggested details from a letter: never overwrite, can be used or dismissed', () => {
  const s = tmpStore();
  const e = s.saveLibraryEntry({ kind: 'document', title: 'Letter', from: 'Me already' });
  const f = s.addLibraryFile(e.id, 'scan.pdf', Buffer.from('%PDF'));
  s.setLibraryText(e.id, f.id, 'Child Maintenance Service\nDate: 14 October 2026\nOur reference: 12 3456 7890\nDear Mr Smith');
  let v = s.getLibraryEntry(e.id);
  assert.deepStrictEqual(v.suggest, { docDate: '2026-10-14', ref: '12 3456 7890' }, 'no suggestion for a field already filled');
  s.useSuggestion(e.id, true);
  v = s.getLibraryEntry(e.id);
  assert.strictEqual(v.from, 'Me already'); assert.strictEqual(v.docDate, '2026-10-14'); assert.strictEqual(v.ref, '12 3456 7890');
  assert.strictEqual(v.suggest, undefined);
  // dismissed stays dismissed when more files are read
  const e2 = s.saveLibraryEntry({ kind: 'document', title: 'Other' });
  const f2 = s.addLibraryFile(e2.id, 'a.pdf', Buffer.from('%PDF'));
  s.setLibraryText(e2.id, f2.id, 'Veterans UK\nYour reference: AFCS/2026/1\n3 June 2026 letter text here');
  assert.ok(s.getLibraryEntry(e2.id).suggest);
  s.useSuggestion(e2.id, false);
  const f3 = s.addLibraryFile(e2.id, 'b.pdf', Buffer.from('%PDF'));
  s.setLibraryText(e2.id, f3.id, 'Veterans UK more text 4 June 2026 and so on');
  assert.strictEqual(s.getLibraryEntry(e2.id).suggest, undefined);
  assert.strictEqual(s.getLibraryEntry(e2.id).from, '');
  // Data entries get no suggestions
  const d = s.saveLibraryEntry({ kind: 'data', title: 'x' });
  const fd = s.addLibraryFile(d.id, 'x.txt', Buffer.from('x'));
  s.setLibraryText(d.id, fd.id, 'Veterans UK\nDate: 1 May 2026\nOur ref: AB12345');
  assert.strictEqual(s.getLibraryEntry(d.id).suggest, undefined);
});

test('words in item receipts are searched, kept out of the item data, and move with the vault', async () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Boiler', serial: 'WB-1' });
  const r = s.addDocument(a.id, 'service.pdf', Buffer.from('%PDF'), 'Receipt');
  s.saveLibraryEntry({ kind: 'document', title: 'Gas safety certificate', from: 'British Gas' });
  assert.deepStrictEqual(s.itemDocTextQueue().map(q => q.fileId), [r.id]);
  s.setItemDocText(a.id, r.id, 'Annual service. Gas Safe engineer 556677. Flue checked.');
  assert.deepStrictEqual(s.itemDocTextQueue(), []);
  let res = s.searchAll('556677');
  assert.deepStrictEqual(res.items.map(x => x.id), [a.id]);
  assert.strictEqual(res.items[0].inDoc, 'service.pdf');
  assert.match(res.items[0].snippet, /engineer 556677/);
  res = s.searchAll('gas');
  assert.deepStrictEqual(res.items.map(x => x.id), [a.id]);
  assert.deepStrictEqual(res.library.map(x => x.id).length, 1, 'documents found too');
  assert.deepStrictEqual(s.searchAll('boiler flue').items.map(x => x.id), [a.id], 'words can be split between details and the receipt');
  assert.ok(!JSON.stringify(s.viewAssets()).includes('556677'), 'words are not part of the item data');
  // vault: the words move with the item, and are hidden while it's locked
  await s.enableEncryption('correct horse battery');
  await s.setupVault('4826');
  s.moveItemToVault(a.id, true);
  assert.ok(!('docText' in s.data && s.data.docText[r.id]), 'moved out of the normal store');
  assert.strictEqual(s.searchAll('556677').items.length, 1);
  s.lockVault();
  assert.strictEqual(s.searchAll('556677').items.length, 0);
  assert.deepStrictEqual(s.itemDocTextQueue(), []);
  await s.unlockVault('4826');
  s.moveItemToVault(a.id, false);
  assert.strictEqual(s.data.docText[r.id].includes('556677'), true);
});

test('documents marked for the phone: kept on edit, vault only when asked, page limits', async () => {
  const pv = require('../src/phoneview');
  const s = tmpStore();
  const a = s.saveLibraryEntry({ kind: 'document', title: 'Award', from: 'Veterans UK', docDate: '2026-08-14' });
  s.addLibraryFile(a.id, 'one.pdf', Buffer.from('%PDF-1.4 fake'));
  s.addLibraryFile(a.id, 'two.png', Buffer.from('png'));
  s.addLibraryFile(a.id, 'clip.mp4', Buffer.from('video'));
  const b = s.saveLibraryEntry({ kind: 'data', title: 'Not marked' });
  assert.strictEqual(s.setLibraryOnPhone([a.id], true), 1);
  s.saveLibraryEntry({ id: a.id, title: 'Award letter' }); // editing details keeps the mark
  assert.deepStrictEqual(s.phoneLibraryEntries(false).map(e => e.title), ['Award letter']);
  s.setLibraryText(a.id, s.getLibraryEntry(a.id).files[0].id, 'tariff level 8');
  const tools = { pdfPages: async (buf, max) => Array.from({ length: Math.min(max, 5) }, () => Buffer.from('jpg')), imageJpeg: () => Buffer.from('jpg'), fileHtml: async () => null, htmlToPdf: async () => Buffer.alloc(0) };
  const r = await pv.buildDocs(s, s.phoneLibraryEntries(false), tools, Object.assign({}, pv.LIMITS, { pagesPerDoc: 4 }));
  assert.strictEqual(r.docs.length, 1);
  assert.strictEqual(r.docs[0].pages.length, 4, 'no more than the per-document limit');
  assert.ok(r.docs[0].pages[0].startsWith('data:image/jpeg;base64,'));
  assert.match(r.docs[0].text, /tariff level 8/);
  assert.deepStrictEqual(r.docs[0].missing, ['two.png (too many pages for the phone copy)', 'clip.mp4 (too many pages for the phone copy)']);
  const r2 = await pv.buildDocs(s, s.phoneLibraryEntries(false), tools);
  assert.strictEqual(r2.pages, 6); assert.deepStrictEqual(r2.skipped, ['Award letter: clip.mp4 (can\'t be shown on the phone)']);
  // the view carries them, with links only to items that are in it
  const view = pv.buildView(s, { docs: [Object.assign({}, r2.docs[0], { assetIds: ['gone'] })] });
  assert.deepStrictEqual(view.docs[0].assetIds, []);
  assert.strictEqual(pv.buildView(s, {}).docs, undefined, 'no docs field when none are marked');
  s.setLibraryOnPhone([a.id], false);
  assert.strictEqual(s.phoneLibraryEntries(false).length, 0);
  // vault entries only go when asked
  await s.enableEncryption(PW); await s.setupVault('2468');
  s.setLibraryOnPhone([b.id], true); s.moveLibraryToVault(b.id, true);
  assert.strictEqual(s.phoneLibraryEntries(false).length, 0);
  assert.strictEqual(s.phoneLibraryEntries(true).length, 1);
});

test('cases, sent letters and replies', () => {
  const s = tmpStore();
  const sent = s.saveLibraryEntry({ kind: 'document', title: 'My appeal', from: 'Child Maintenance Service', sent: true, docDate: '2026-03-01', expectBy: '2026-03-29', caseName: 'CMS recalculation' });
  s.saveLibraryEntry({ kind: 'document', title: 'Decision', from: 'Child Maintenance Service', docDate: '2026-02-01', caseName: 'cms recalculation', ref: '12345' });
  const other = s.saveLibraryEntry({ kind: 'document', title: 'Award', from: 'Veterans UK', docDate: '2026-08-14', caseName: 'AFCS claim' });
  assert.strictEqual(s.getLibraryEntry(sent.id).sent, true);
  // expectBy only for sent letters
  assert.strictEqual(s.saveLibraryEntry({ kind: 'document', title: 'x', expectBy: '2026-01-01' }).expectBy, '');
  let rs = s.replyStatus();
  assert.deepStrictEqual(rs[sent.id], { replied: false, waiting: true, overdue: true });
  const rem = s.reminders(new Date('2026-04-01'), 30).find(r => r.libraryId === sent.id);
  assert.strictEqual(rem.kind, 'No reply yet'); assert.strictEqual(rem.daysLeft, -3);
  assert.match(rem.assetName, /\(to Child Maintenance Service\)/);
  // cases group case-insensitively, newest activity first
  let cases = s.libraryCases();
  assert.deepStrictEqual(cases.map(c => [c.name, c.count, c.overdue]), [['AFCS claim', 1, 0], ['CMS recalculation', 2, 1]]);
  assert.deepStrictEqual(cases[1].refs, ['12345']);
  assert.strictEqual(cases[1].first, '2026-02-01');
  // their reply, added to the same case, counts as the reply
  const reply = s.saveLibraryEntry({ kind: 'document', title: 'Reply to appeal', from: 'Child Maintenance Service', docDate: '2026-04-10', caseName: 'CMS recalculation' });
  rs = s.replyStatus();
  assert.strictEqual(rs[sent.id].replied, true); assert.strictEqual(rs[sent.id].replyId, reply.id);
  assert.ok(!s.reminders(new Date('2026-04-11'), 30).some(r => r.libraryId === sent.id));
  // manual "reply received" works without a case
  const lone = s.saveLibraryEntry({ kind: 'data', title: 'Email to MP', sent: true, docDate: '2026-05-01', expectBy: '2026-05-15' });
  assert.strictEqual(s.replyStatus()[lone.id].replied, false);
  s.saveLibraryEntry({ id: lone.id, replyDone: true });
  assert.strictEqual(s.replyStatus()[lone.id].replied, true);
  // put in a case, rename it
  s.moveLibrary([other.id, lone.id], { caseName: 'AFCS claim' });
  assert.strictEqual(s.renameCase('afcs CLAIM', 'AFCS award'), 2);
  assert.deepStrictEqual(s.libraryCases().map(c => c.name).sort(), ['AFCS award', 'CMS recalculation']);
  s.moveLibrary([lone.id], { caseName: '' });
  assert.strictEqual(s.getLibraryEntry(lone.id).caseName, '');
  // search finds the case name
  assert.ok(s.librarySearch('document', 'recalculation').some(x => x.id === sent.id));
});

test('the same file added twice is found, including files kept before the check existed', async () => {
  const s = tmpStore();
  const a = s.saveLibraryEntry({ kind: 'document', title: 'Letter A' });
  s.addLibraryFile(a.id, 'a.pdf', Buffer.from('%PDF same bytes'));
  const old = s.saveLibraryEntry({ kind: 'data', title: 'Old email' });
  s.addLibraryFile(old.id, 'm.eml', Buffer.from('Subject: hi'));
  delete s.getLibraryEntry && s._libFind(old.id).e.files[0].sha; // as stored by 2.12 and earlier
  const found = s.findLibraryFiles([Buffer.from('%PDF same bytes'), Buffer.from('new'), Buffer.from('Subject: hi')]);
  assert.deepStrictEqual(found.map(f => f && f.title), ['Letter A', null, 'Old email']);
  assert.ok(s._libFind(old.id).e.files[0].sha, 'worked out and kept');
  // vault files count only while the vault is open
  await s.enableEncryption(PW); await s.setupVault('2468');
  const v = s.saveLibraryEntry({ kind: 'document', title: 'Secret' });
  s.addLibraryFile(v.id, 's.pdf', Buffer.from('vault bytes')); s.moveLibraryToVault(v.id, true);
  assert.strictEqual(s.findLibraryFiles([Buffer.from('vault bytes')])[0].title, 'Secret');
  s.lockVault();
  assert.strictEqual(s.findLibraryFiles([Buffer.from('vault bytes')])[0], null);
});
