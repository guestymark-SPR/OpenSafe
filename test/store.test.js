'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { PhoneServer } = require('../src/phoneServer');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensafe-'));
  const s = new Store(dir); s.load(); return s;
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

test('creates, cleans and updates an item', () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: '  Harley Low Rider S ', purchasePrice: '£18,499.50', category: 'Vehicles', tags: 'bike, Bike, road', purchaseDate: '2025-03-01', warrantyExpiry: 'nonsense' });
  assert.strictEqual(a.name, 'Harley Low Rider S');
  assert.strictEqual(a.purchasePrice, 18499.5);
  assert.deepStrictEqual(a.tags, ['bike', 'road']);
  assert.strictEqual(a.warrantyExpiry, '');
  assert.strictEqual(a.status, 'Owned');
  s.saveAsset({ id: a.id, currentValue: 15000 });
  const again = new Store(s.dir); again.load();
  assert.strictEqual(again.getAsset(a.id).currentValue, 15000);
  assert.strictEqual(again.getAsset(a.id).purchasePrice, 18499.5);
});

test('new category and location are learnt', () => {
  const s = tmpStore();
  s.saveAsset({ name: 'Tent', category: 'Overlanding', location: 'Loft' });
  assert.ok(s.data.categories.includes('Overlanding'));
  assert.ok(s.data.locations.includes('Loft'));
});

test('photos, documents and path safety', () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Laptop' });
  const p = s.addPhoto(a.id, 'front.JPG', Buffer.from('img'));
  const d = s.addDocument(a.id, 'receipt.pdf', Buffer.from('%PDF'), 'Receipt');
  assert.ok(fs.existsSync(s.attachmentPath(a.id, p.file)));
  assert.strictEqual(d.type, 'Receipt');
  assert.throws(() => s.addPhoto(a.id, 'evil.exe', Buffer.from('x')));
  assert.throws(() => s.attachmentPath('../../etc', 'passwd'));
  assert.ok(!s.attachmentPath(a.id, '../../x').includes('..'));
  s.removeAttachment(a.id, p.id);
  assert.strictEqual(s.getAsset(a.id).photos.length, 0);
  s.addPhoto(a.id, 'b.png', Buffer.from('png'));
  s.deleteAsset(a.id);                                    // to the bin: files kept
  assert.ok(fs.existsSync(path.join(s.attachDir, a.id)));
  s.purgeAsset(a.id);                                     // deleted for good: files gone
  assert.ok(!fs.existsSync(path.join(s.attachDir, a.id)));
});

test('reminders: warranty and latest service due only', () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Car', warrantyExpiry: addDays(10) });
  s.saveService(a.id, { date: addDays(-400), type: 'MOT', nextDueDate: addDays(-35) });
  s.saveService(a.id, { date: addDays(-30), type: 'MOT', nextDueDate: addDays(5) });
  s.saveAsset({ name: 'Old TV', status: 'Sold', warrantyExpiry: addDays(3) });
  const r = s.reminders();
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map(x => x.kind), ['MOT', 'Warranty']);
});

test('summary excludes sold items and CSV is safe', () => {
  const s = tmpStore();
  s.saveAsset({ name: '=HYPERLINK("x")', purchasePrice: 100, category: 'A' });
  s.saveAsset({ name: 'Gone', purchasePrice: 50, status: 'Sold' });
  const sum = s.summary();
  assert.strictEqual(sum.count, 1);
  assert.strictEqual(sum.currentTotal, 100);
  const csv = s.toCSV();
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});

test('backup and restore round trip', () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Drill' });
  s.addPhoto(a.id, 'd.png', Buffer.from('png'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'okb-'));
  const b = s.backupTo(out);
  s.deleteAsset(a.id);
  s.restoreFrom(b);
  assert.strictEqual(s.getAsset(a.id).photos.length, 1);
  assert.ok(fs.existsSync(s.attachmentPath(a.id, s.getAsset(a.id).photos[0].file)));
});

test('corrupt data file falls back to backup', () => {
  const s = tmpStore();
  s.saveAsset({ name: 'Kept' });
  fs.writeFileSync(s.file, '{broken');
  const s2 = new Store(s.dir); s2.load();
  assert.strictEqual(s2.data.assets[0].name, 'Kept');
  assert.ok(fs.readdirSync(s.dir).some(f => f.includes('.corrupt-')));
});

test('phone API: auth, create item, upload photo', async () => {
  const s = tmpStore();
  let changed = 0;
  const ps = new PhoneServer({ store: s, onChange: () => changed++ });
  const port = await ps.start(0 || 47999);
  const base = `http://127.0.0.1:${port}`;
  const tok = s.data.settings.phoneToken;
  try {
    const page = await fetch(base + '/m');
    assert.strictEqual(page.status, 200);
    assert.ok(page.headers.get('content-security-policy'));
    assert.strictEqual((await fetch(base + '/api/meta')).status, 401);
    assert.strictEqual((await fetch(base + '/api/meta', { headers: { 'x-opensafe-token': 'wrong' } })).status, 401);
    const meta = await (await fetch(base + '/api/meta', { headers: { 'x-opensafe-token': tok } })).json();
    assert.ok(meta.categories.length > 3);
    const cr = await fetch(base + '/api/assets', { method: 'POST', headers: { 'x-opensafe-token': tok, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Phone item', purchasePrice: '12.5', id: 'hijack' }) });
    assert.strictEqual(cr.status, 201);
    const { id } = await cr.json();
    assert.notStrictEqual(id, 'hijack');
    assert.strictEqual(s.getAsset(id).source, 'phone');
    const up = await fetch(`${base}/api/assets/${id}/photo?name=cam.jpg`, { method: 'POST', headers: { 'x-opensafe-token': tok, 'content-type': 'image/jpeg' }, body: Buffer.from('jpeg') });
    assert.strictEqual(up.status, 201);
    const bad = await fetch(`${base}/api/assets/${id}/photo?name=x.exe`, { method: 'POST', headers: { 'x-opensafe-token': tok }, body: Buffer.from('x') });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(s.getAsset(id).photos.length, 1);
    assert.strictEqual(changed, 2);
  } finally { await ps.stop(); }
});

test('firewall commands remove old rules and allow private TCP only', () => {
  const { buildCommands } = require('../src/firewall');
  const [del, add] = buildCommands('D:\\OpenSafe\\OpenSafe.exe', 47820);
  assert.ok(del.includes('delete rule name=all program="D:\\OpenSafe\\OpenSafe.exe"'));
  assert.ok(add.includes('action=allow') && add.includes('protocol=TCP') && add.includes('localport=47820-47829') && add.includes('profile=private'));
});

test('phone server logs plain and https connection attempts', async () => {
  const s = tmpStore();
  const ps = new PhoneServer({ store: s });
  const port = await ps.start(47998);
  ps._note('192.168.1.50', 'request', 'x'); // simulate a LAN entry (localhost is ignored)
  const net = require('net');
  await new Promise((resolve) => { const c = net.connect(port, '127.0.0.1', () => { c.write(Buffer.from([0x16, 0x03, 0x01, 0, 5])); setTimeout(() => { c.destroy(); resolve(); }, 200); }); });
  await ps.stop();
  assert.strictEqual(ps.attempts[0].ip, '192.168.1.50');
});

test('import from OpenSafe Capture: add, re-import, edits and bad files', () => {
  const s = tmpStore();
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const id = '11111111-2222-4333-8444-555555555555';
  const file = { format: 'opensafe-export', version: 1, items: [{
    id, createdAt: '2026-11-20T10:00:00.000Z', name: 'Tent', category: 'Camping & Outdoor', location: 'Loft', purchasePrice: '£420.50', tags: 'camping, summer',
    photos: [{ id: 'p1', name: 'tent.jpg', type: 'image/jpeg', data: png }],
    documents: [{ id: 'd1', name: 'receipt', type: 'application/pdf', docType: 'Receipt', data: Buffer.from('%PDF').toString('base64') }]
  }] };
  const r1 = s.importCapture(file);
  assert.deepStrictEqual([r1.added, r1.updated, r1.unchanged, r1.photos, r1.documents, r1.errors.length], [1, 0, 0, 1, 1, 0]);
  const a = s.getAsset(id);
  assert.ok(a && a.source === 'phone' && a.purchasePrice === 420.5 && a.location === 'Loft');
  assert.strictEqual(a.documents[0].name, 'receipt.pdf');
  assert.ok(s.data.locations.includes('Loft'));
  // same file again: nothing duplicated
  const r2 = s.importCapture(file);
  assert.deepStrictEqual([r2.added, r2.unchanged, r2.photos], [0, 1, 0]);
  assert.strictEqual(s.data.assets.length, 1);
  // PC edit is kept; empty field filled; new photo added
  s.saveAsset({ id, name: 'Family tent', location: 'Garage' });
  file.items[0].name = 'Tent (phone edit)'; file.items[0].serial = 'SN-9'; file.items[0].location = 'Loft';
  file.items[0].photos.push({ id: 'p2', name: 'tent2.jpg', type: 'image/jpeg', data: png });
  const r3 = s.importCapture(file);
  assert.deepStrictEqual([r3.updated, r3.photos], [1, 1]);
  const b = s.getAsset(id);
  assert.deepStrictEqual([b.name, b.location, b.serial, b.photos.length], ['Family tent', 'Garage', 'SN-9', 2]);
  // bad input
  assert.throws(() => s.importCapture({ hello: 1 }), /isn't an OpenSafe export/);
  assert.throws(() => s.importCapture({ format: 'opensafe-export', version: 5, items: [] }), /newer version/);
  const r4 = s.importCapture({ format: 'opensafe-export', version: 1, items: [{ name: 'Bad file', photos: [{ name: 'x.exe', type: 'application/x-msdownload', data: png }] }] });
  assert.strictEqual(r4.added, 1); assert.strictEqual(r4.errors.length, 1);
});

test('vehicle/boat details, lending and selling, and their reminders', () => {
  const s = tmpStore();
  const car = s.saveAsset({ name: 'Mercedes', category: 'Vehicles', details: { kind: 'vehicle', reg: ' AB12 CDE ', vin: 'WDD123', motDue: addDays(12), taxDue: addDays(200), bogus: 'x' } });
  assert.deepStrictEqual(car.details, { kind: 'vehicle', reg: 'AB12 CDE', vin: 'WDD123', motDue: addDays(12), taxDue: addDays(200) });
  const boat = s.saveAsset({ name: 'Yacht', details: { kind: 'boat', hin: 'GB-MOD123', engineHours: '1450', motDue: addDays(1) } });
  assert.deepStrictEqual(boat.details, { kind: 'boat', hin: 'GB-MOD123', engineHours: '1450' }); // MOT is not a boat field
  const drill = s.saveAsset({ name: 'Drill', status: 'Lent out', lentTo: 'Dave', lentDate: addDays(-10), dueBack: addDays(-2) });
  s.saveAsset({ name: 'Old phone', status: 'Sold', soldDate: addDays(-5), soldPrice: '£120', soldTo: 'eBay' });
  const r = s.reminders();
  assert.ok(r.some(x => x.kind === 'MOT' && x.assetId === car.id && x.daysLeft === 12));
  assert.ok(!r.some(x => x.kind === 'Road tax')); // 200 days away
  assert.ok(r.some(x => x.kind === 'Due back from Dave' && x.assetId === drill.id && x.daysLeft === -2));
  const sold = s.data.assets.find(a => a.name === 'Old phone');
  assert.strictEqual(sold.soldPrice, 120);
  // clearing the kind removes the details
  assert.deepStrictEqual(s.saveAsset({ id: car.id, details: { kind: '' } }).details, { kind: '' });
});

test('insurance policies: link items, renewal reminder, delete unlinks', () => {
  const s = tmpStore();
  assert.throws(() => s.savePolicy({ type: 'Vehicle' }), /insurer/);
  const pol = s.savePolicy({ insurer: 'Admiral', type: 'Vehicle', policyNumber: 'P-1', renewalDate: addDays(20), premium: '£612.40' });
  assert.strictEqual(pol.premium, 612.4);
  const a = s.saveAsset({ name: 'Car', currentValue: 9000 });
  const b = s.saveAsset({ name: 'Van', currentValue: 4000 });
  assert.strictEqual(s.summary().uninsured, 2);
  s.setPolicyItems(pol.id, [a.id, b.id]);
  assert.strictEqual(s.summary().uninsured, 0);
  assert.ok(s.reminders().some(x => x.kind === 'Insurance renewal' && x.policyId === pol.id));
  s.setPolicyItems(pol.id, [a.id]);
  assert.strictEqual(s.getAsset(b.id).policyId, '');
  const again = new Store(s.dir); again.load();
  assert.strictEqual(again.data.policies[0].insurer, 'Admiral');
  again.deletePolicy(pol.id);
  assert.strictEqual(again.getAsset(a.id).policyId, '');
});

test('automatic backups: due logic, rotation, missing folder', () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Item' });
  s.addPhoto(a.id, 'a.png', Buffer.from('png'));
  assert.throws(() => s.setAutoBackup({ enabled: true }), /Choose a folder/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'osab-'));
  s.setAutoBackup({ enabled: true, folder: out, every: 'weekly', keep: 2 });
  assert.ok(s.autoBackupDue());
  for (let i = 0; i < 3; i++) {
    const r = s.runAutoBackup();
    assert.ok(r.ok, r.error);
    // make the next backup's folder name different (names are per minute)
    fs.renameSync(r.dest, path.join(out, `OpenSafe-backup-2026-01-0${i + 1}-10-00`));
  }
  const kept = fs.readdirSync(out).sort();
  assert.strictEqual(kept.length, 2);
  assert.deepStrictEqual(kept, ['OpenSafe-backup-2026-01-02-10-00', 'OpenSafe-backup-2026-01-03-10-00']);
  assert.ok(!s.autoBackupDue());
  assert.ok(s.autoBackupDue(new Date(Date.now() + 8 * 86400000)));
  s.setAutoBackup({ folder: path.join(out, 'missing-usb') });
  const bad = s.runAutoBackup();
  assert.ok(!bad.ok && /isn't available/.test(bad.error));
  assert.ok(s.data.settings.autoBackup.lastError);
});

test('receipt parsing: shop, UK dates and totals', () => {
  const { parseReceipt } = require('../src/ocr');
  const a = parseReceipt('TESCO\nExtra\nwww.tesco.com\nMilk 1.45\nSUB-TOTAL 23.45\nSAVINGS 2.00\nTOTAL TO PAY £21.45\n03/11/24 18:22');
  assert.deepStrictEqual([a.shop, a.date, a.total], ['Tesco', '2024-11-03', 21.45]);
  const b = parseReceipt('Currys PC World\nTax invoice\n14 Mar 2025\nLenovo Legion 5 1,299.00\nAmount due £1,299.00');
  assert.deepStrictEqual([b.shop, b.date, b.total], ['Currys PC World', '2025-03-14', 1299]);
  const c = parseReceipt('Halfords\n2025-06-01\nTyres 2 x 89.99\nOil 24.50');
  assert.deepStrictEqual([c.shop, c.date, c.total], ['Halfords', '2025-06-01', 89.99]);
  const d = parseReceipt('31/02/2025 nonsense date\n12/05/2025 ok');
  assert.strictEqual(d.date, '2025-05-12');
  assert.deepStrictEqual(parseReceipt('').total, null);
});

test('phone inventory file: encrypted, vault excluded unless asked; labels sheet', async () => {
  const pv = require('../src/phoneview');
  const { buildLabelsHtml } = require('../src/labels');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ospv-'));
  const s = new Store(dir); s.load();
  const a = s.saveAsset({ name: 'Telescope', serial: 'T-1', details: { kind: 'vehicle', reg: 'X1' } });
  s.addPhoto(a.id, 't.png', Buffer.from('png'));
  await s.enableEncryption('password123');
  await s.setupVault('1234');
  const v = s.saveAsset({ name: 'Diamond ring' });
  s.moveItemToVault(v.id, true);
  const view = pv.buildView(s, { makeThumb: () => 'data:image/jpeg;base64,AAA' });
  assert.deepStrictEqual(view.items.map(i => i.name), ['Telescope']);
  assert.strictEqual(view.items[0].thumb, 'data:image/jpeg;base64,AAA');
  assert.strictEqual(pv.buildView(s, { includeVault: true }).items.length, 2);
  assert.throws(() => pv.encryptView(view, '123'), /6 characters/);
  const text = pv.encryptView(view, 'phone pass');
  assert.ok(!text.includes('Telescope'));
  assert.strictEqual(pv.decryptView(text, 'phone pass').items[0].serial, 'T-1');
  assert.throws(() => pv.decryptView(text, 'wrong pass'));
  const html = await buildLabelsHtml(s, [a.id, a.id, a.id], { skip: 19 });
  assert.strictEqual((html.match(/class="sheet"/g) || []).length, 2); // 19 skipped + 3 labels = 22 > 21
  assert.strictEqual((html.match(/<img src="data:image\/png/g) || []).length, 3);
});

test('changes from scanning labels: applied once, PC edits win, history in notes', async () => {
  const s = tmpStore();
  const drill = s.saveAsset({ name: 'Makita drill', location: 'Garage', notes: 'Bought for the shed' });
  const ladder = s.saveAsset({ name: 'Ladder', location: 'Garage' });
  const later = (min) => new Date(Date.now() + min * 60000).toISOString();
  const U = (n) => `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const file = { format: 'opensafe-export', version: 2, items: [], updates: [
    { id: U(2), itemId: drill.id, at: later(2), kind: 'lend', summary: 'Lent to Dave (07700 900123), due back 5 Dec 2026', note: 'With the spare battery',
      changes: { status: 'Lent out', lentTo: 'Dave', lentContact: '07700 900123', lentDate: '2026-11-26', dueBack: '2026-12-05' } },
    { id: U(1), itemId: drill.id, at: later(1), kind: 'move', summary: 'Moved to Shed', changes: { location: 'Shed' } },
    { id: U(3), itemId: ladder.id, at: later(1), kind: 'needsRepair', summary: 'Needs repairing', note: 'Bent rung', changes: { status: 'Needs repair' } },
    { id: U(4), itemId: ladder.id, at: later(1), kind: 'x', summary: 'bad', changes: { status: 'Exploded', location: 'x'.repeat(500) } },
    { id: U(5), itemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', at: later(1), summary: 'Moved', itemName: 'Kayak', changes: { location: 'Loft' } }
  ] };
  const r = s.importCapture(file);
  assert.strictEqual(r.changes, 4);
  assert.strictEqual(r.skippedChanges.length, 1);
  assert.match(r.skippedChanges[0], /Kayak: not found/);
  const d = s.getAsset(drill.id);
  assert.strictEqual(d.location, 'Shed');
  assert.strictEqual(d.status, 'Lent out');
  assert.strictEqual(d.lentContact, '07700 900123');
  assert.strictEqual(d.dueBack, '2026-12-05');
  const lines = d.notes.split('\n');
  assert.strictEqual(lines[0], 'Bought for the shed');
  assert.match(lines[1], /\(phone\): Moved to Shed$/);   // applied in time order
  assert.match(lines[2], /\(phone\): Lent to Dave .*\(With the spare battery\)$/);
  const l = s.getAsset(ladder.id);
  assert.strictEqual(l.status, 'Needs repair');          // the invalid status was ignored
  assert.strictEqual(l.location.length, 200);
  assert.ok(s.reminders().some(x => x.assetId === drill.id && /Due back from Dave/.test(x.kind)));
  // importing the same file again changes nothing
  const r2 = s.importCapture(JSON.parse(JSON.stringify(file)));
  assert.strictEqual(r2.changes, 0);
  assert.strictEqual(s.getAsset(drill.id).notes.split('\n').length, 3);
  // a phone change older than the last PC edit is skipped, not applied
  await new Promise(res => setTimeout(res, 5));
  const old = new Date(Date.now() - 60000).toISOString();
  s.saveAsset({ id: ladder.id, name: 'Ladder', location: 'Loft' });
  const r3 = s.importCapture({ format: 'opensafe-export', version: 2, items: [], updates: [{ id: U(6), itemId: ladder.id, at: old, summary: 'Moved to Garage', changes: { location: 'Garage' } }] });
  assert.strictEqual(r3.changes, 0);
  assert.match(r3.skippedChanges[0], /last edited on this PC/);
  assert.strictEqual(s.getAsset(ladder.id).location, 'Loft');
  // a new item and a change to it in the same file both apply
  const NEW = 'abcdef01-2345-4678-89ab-cdef01234567';
  const r4 = s.importCapture({ format: 'opensafe-export', version: 2, items: [{ id: NEW, name: 'Tent', createdAt: old }],
    updates: [{ id: U(7), itemId: NEW, at: old, summary: 'Lent to Sam', changes: { status: 'Lent out', lentTo: 'Sam' } }] });
  assert.strictEqual(r4.added, 1); assert.strictEqual(r4.changes, 1);
  assert.strictEqual(s.getAsset(NEW).lentTo, 'Sam');
  // a newer file version is refused clearly
  assert.throws(() => s.importCapture({ format: 'opensafe-export', version: 5, items: [] }), /newer version/);
});

test('bulk change: location, category, status with details, policy; validation', () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Drill', location: 'Garage', status: 'Lent out', lentTo: 'Dave' });
  const b = s.saveAsset({ name: 'Saw', location: 'Garage' });
  const c = s.saveAsset({ name: 'Bench', location: 'Garden' });
  assert.throws(() => s.bulkUpdate([a.id], {}), /Choose what to change/);
  assert.throws(() => s.bulkUpdate([a.id], { status: 'Lent out' }), /who the items are lent to/);
  assert.throws(() => s.bulkUpdate([a.id], { status: 'Melted' }), /Unknown status/);
  assert.strictEqual(s.bulkUpdate([a.id, b.id, 'nope'], { location: 'Shed', category: 'Tools', status: 'Owned' }), 2);
  assert.strictEqual(s.getAsset(a.id).location, 'Shed');
  assert.strictEqual(s.getAsset(a.id).lentTo, '');          // no longer lent out
  assert.strictEqual(s.getAsset(c.id).location, 'Garden');  // not selected, untouched
  assert.ok(s.data.locations.includes('Shed'));
  s.bulkUpdate([b.id, c.id], { status: 'Lent out', lentTo: 'Sam', lentContact: 'sam@example.com', dueBack: '2026-12-24' });
  assert.strictEqual(s.getAsset(c.id).lentContact, 'sam@example.com');
  assert.strictEqual(s.getAsset(c.id).location, 'Garden'); // blank location kept
  const pol = s.savePolicy({ insurer: 'Aviva', type: 'Home contents', renewalDate: '2027-03-01' });
  s.bulkUpdate([a.id, b.id], { policyId: pol.id });
  assert.strictEqual(s.getAsset(b.id).policyId, pol.id);
  s.bulkUpdate([a.id], { policyId: '' });
  assert.strictEqual(s.getAsset(a.id).policyId, '');
  assert.throws(() => s.bulkUpdate([a.id], { policyId: 'missing' }), /no longer exists/);
});

test('locations with levels: tidy paths, totals include places inside places', () => {
  const { cleanLocation, inLocation } = require('../src/store');
  assert.strictEqual(cleanLocation('  Home/Garage //  Shelf   2 '), 'Home / Garage / Shelf 2');
  assert.strictEqual(cleanLocation('/'), '');
  assert.ok(inLocation('Home / Garage / Shelf 2', 'Home / Garage'));
  assert.ok(!inLocation('Home / Garages', 'Home / Garage'));
  const s = tmpStore();
  s.saveAsset({ name: 'Drill', location: 'home/garage/shelf 2', currentValue: 100 });
  s.saveAsset({ name: 'Saw', location: 'home / garage', currentValue: 50 });
  s.saveAsset({ name: 'Sofa', location: 'home/lounge', currentValue: 400 });
  s.saveAsset({ name: 'Old TV', location: 'home/lounge', currentValue: 999, status: 'Sold' });
  const b = s.summary().byLocation;
  assert.deepStrictEqual(b.home, { count: 3, value: 550 });
  assert.deepStrictEqual(b['home / garage'], { count: 2, value: 150 });
  assert.deepStrictEqual(b['home / garage / shelf 2'], { count: 1, value: 100 });
  assert.strictEqual(s.data.assets[0].location, 'home / garage / shelf 2');
  s.setLists(['Tools'], ['Home/Loft ', 'Home / Loft', 'Boat']);
  assert.deepStrictEqual(s.data.locations, ['Home / Loft', 'Boat']);
});

test('item sets: parts, one level only, claim pack expansion, delete clears', () => {
  const s = tmpStore();
  const drill = s.saveAsset({ name: 'Drill' });
  const bat = s.saveAsset({ name: 'Battery' });
  const chg = s.saveAsset({ name: 'Charger' });
  const boat = s.saveAsset({ name: 'Boat' });
  assert.strictEqual(s.setParts(drill.id, [bat.id, chg.id, drill.id]), 2);
  assert.deepStrictEqual(s.withParts([drill.id, bat.id]), [drill.id, bat.id, chg.id]);
  assert.throws(() => s.setParts(bat.id, [boat.id]), /part of another set/);
  assert.throws(() => s.setParts(boat.id, [drill.id]), /has parts of its own/);
  assert.throws(() => s.saveAsset({ id: boat.id, partOf: bat.id }), /itself part of a set/);
  assert.throws(() => s.saveAsset({ id: drill.id, partOf: boat.id }), /has parts of its own/);
  s.saveAsset({ id: bat.id, partOf: 'no-such-item' });
  assert.strictEqual(s.getAsset(bat.id).partOf, '');
  s.setParts(drill.id, [chg.id]);
  assert.deepStrictEqual(s.partsOf(drill.id).map(a => a.name), ['Charger']);
  s.deleteAsset(drill.id);
  assert.strictEqual(s.getAsset(chg.id).partOf, '');
});

test('value over time: history on change, valuations, yearly drop estimate', () => {
  const { estimateValue, valueNow } = require('../src/store');
  const s = tmpStore();
  const ring = s.saveAsset({ name: 'Ring', category: 'Jewellery & Watches', currentValue: 1000 });
  s.saveAsset({ id: ring.id, name: 'Ring', currentValue: 1000 });           // unchanged: no new entry
  s.saveAsset({ id: ring.id, name: 'Ring', currentValue: 1200 });
  assert.deepStrictEqual(s.getAsset(ring.id).valueHistory.map(v => v.value), [1000, 1200]);
  assert.throws(() => s.addValuation(ring.id, { date: '2099-01-01', value: 5 }), /future/);
  assert.throws(() => s.addValuation(ring.id, { date: '2026-01-01', value: 'lots' }), /in pounds/);
  s.addValuation(ring.id, { date: '2020-01-01', value: '£800', note: 'Old valuation' });
  assert.strictEqual(s.getAsset(ring.id).currentValue, 1200);              // older entry doesn't replace value now
  const v = s.addValuation(ring.id, { date: '2099-01-01'.replace('2099', String(new Date().getFullYear())).slice(0, 4) + '-01-01', value: 1500 });
  assert.ok(v.id);
  // yearly drop: 20% a year for 2 years from £1000 = £640
  const twoYearsAgo = new Date(Date.now() - 2 * 365.25 * 86400000).toISOString().slice(0, 10);
  const est = estimateValue({ category: 'Tools', purchasePrice: 1000, purchaseDate: twoYearsAgo }, { Tools: 20 });
  assert.ok(Math.abs(est - 640) < 1, String(est));
  assert.strictEqual(estimateValue({ category: 'Tools', purchasePrice: 1000, purchaseDate: twoYearsAgo }, {}), null);
  assert.strictEqual(valueNow({ category: 'Tools', currentValue: 50, purchasePrice: 1000, purchaseDate: twoYearsAgo }, { Tools: 20 }), 50);
  assert.throws(() => s.updateSettings({ depreciation: { Tools: '150' } }), /between 0 and 100/);
  s.updateSettings({ depreciation: { Tools: '20%', Furniture: '' } });
  assert.deepStrictEqual(s.data.settings.depreciation, { Tools: 20 });
  s.saveAsset({ name: 'Saw', category: 'Tools', purchasePrice: 1000, purchaseDate: twoYearsAgo });
  const sum = s.summary();
  assert.strictEqual(sum.estimatedCount, 1);
  assert.ok(Math.abs(sum.byCategory.Tools.value - 640) < 1);
});

test('spreadsheet import: mapping, UK dates, money, duplicates, round trip of own CSV', () => {
  const csv = require('../src/csv');
  const s = tmpStore();
  const text = 'Item,Make,Serial No,Price Paid,Bought,Room,Status,Condition,Tags\n' +
    '"Drill, cordless",Makita,MK1,"£1,299.50",14/03/2025,Home/Garage,lent out,good,"diy; tools"\n' +
    'Ladder,,,40,1 Jun 2024,Garage,,,\n' +
    ',,,,,,,,\n' +
    'Kettle,,,abc,31/02/2025,Kitchen,Exploded,Shiny,\n';
  const rows = csv.parseCSV(text);
  const map = csv.guessMapping(rows[0]);
  assert.deepStrictEqual(map, ['name', 'brand', 'serial', 'purchasePrice', 'purchaseDate', 'location', 'status', 'condition', 'tags']);
  const { items, problems } = csv.rowsToItems(rows.slice(1), map);
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(problems, ['Kettle: couldn\'t read the date "31/02/2025", so it was left blank']);
  const r = s.importItems(items);
  assert.strictEqual(r.added, 3);
  const drill = s.data.assets.find(a => a.name === 'Drill, cordless');
  assert.strictEqual(drill.purchasePrice, 1299.5);
  assert.strictEqual(drill.purchaseDate, '2025-03-14');
  assert.strictEqual(drill.location, 'Home / Garage');
  assert.strictEqual(drill.status, 'Lent out');
  assert.strictEqual(drill.condition, 'Good');
  assert.deepStrictEqual(drill.tags, ['diy', 'tools']);
  const kettle = s.data.assets.find(a => a.name === 'Kettle');
  assert.strictEqual(kettle.status, 'Owned');
  assert.strictEqual(kettle.purchasePrice, null);
  // importing again: all three are duplicates
  assert.deepStrictEqual([s.importItems(items).added, s.importItems(items).duplicates], [0, 3]);
  assert.strictEqual(s.importItems(items, { skipDuplicates: false }).added, 3);
  // OpenSafe's own export imports back into a new store
  const s2 = tmpStore();
  const own = csv.parseCSV(s.toCSV());
  const back = csv.rowsToItems(own.slice(1), csv.guessMapping(own[0]));
  assert.strictEqual(s2.importItems(back.items).added, 3); // the export holds each item twice; duplicates skipped
  const d2 = s2.data.assets.find(a => a.name === 'Drill, cordless');
  assert.deepStrictEqual([d2.serial, d2.purchasePrice, d2.purchaseDate, d2.location, d2.status], ['MK1', 1299.5, '2025-03-14', 'Home / Garage', 'Lent out']);
});

test('deleted items bin: restore, delete for good, 30-day clear-out, phone imports', () => {
  const s = tmpStore();
  const drill = s.saveAsset({ name: 'Drill', location: 'Garage' });
  const bat = s.saveAsset({ name: 'Battery', partOf: drill.id });
  s.addPhoto(drill.id, 'd.png', Buffer.from('png'));
  s.deleteAsset(drill.id);
  assert.strictEqual(s.getAsset(drill.id), null);
  assert.strictEqual(s.getAsset(bat.id).partOf, '');
  assert.deepStrictEqual(s.binView().map(b => [b.name, b.daysLeft, b.photos]), [['Drill', 30, 1]]);
  assert.strictEqual(s.summary().count, 1);
  // a phone export that still mentions it
  const r = s.importCapture({ format: 'opensafe-export', version: 2, items: [{ id: drill.id, name: 'Drill' }],
    updates: [{ id: '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa', itemId: drill.id, at: new Date().toISOString(), summary: 'Moved to Shed', changes: { location: 'Shed' } }] });
  assert.strictEqual(r.added, 0);
  assert.match(r.errors[0], /deleted items bin/);
  assert.match(r.skippedChanges[0], /deleted items bin/);
  // restore keeps photos
  s.restoreAsset(drill.id);
  assert.strictEqual(s.getAsset(drill.id).photos.length, 1);
  assert.ok(s.readAttachment(drill.id, s.getAsset(drill.id).photos[0].file).length);
  assert.throws(() => s.restoreAsset(drill.id), /isn't in the deleted items bin/);
  // survives a reload
  s.deleteAsset(bat.id);
  const s2 = new Store(s.dir); s2.load();
  assert.deepStrictEqual(s2.binView().map(b => b.name), ['Battery']);
  // clear-out after 30 days
  s.data.bin[0].deletedAt = new Date(Date.now() - 31 * 86400000).toISOString();
  s.deleteAsset(drill.id);
  assert.strictEqual(s.purgeOldBin(), 1);
  assert.deepStrictEqual(s.binView().map(b => b.name), ['Drill']);
  assert.strictEqual(s.emptyBin(), 1);
  assert.ok(!fs.existsSync(path.join(s.attachDir, drill.id)));
});

test('web link, grab list flag, report grouped by room for one place', () => {
  const { cleanUrl } = require('../src/store');
  assert.strictEqual(cleanUrl('www.makitauk.com/products/dhp485'), 'https://www.makitauk.com/products/dhp485');
  assert.strictEqual(cleanUrl('javascript:alert(1)'), '');
  assert.strictEqual(cleanUrl('file:///C:/x'), '');
  assert.strictEqual(cleanUrl('not a link'), '');
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Passport', location: 'Home / Bedroom', grab: true, webLink: 'gov.uk/renew-adult-passport' });
  assert.strictEqual(a.grab, true);
  assert.strictEqual(a.webLink, 'https://gov.uk/renew-adult-passport');
  s.saveAsset({ id: a.id, name: 'Passport' });                 // grab not sent: kept
  assert.strictEqual(s.getAsset(a.id).grab, true);
  s.saveAsset({ id: a.id, name: 'Passport', grab: false });
  assert.strictEqual(s.getAsset(a.id).grab, false);
  const b = s.saveAsset({ name: 'Laptop', location: 'Home / Office', currentValue: 900 });
  s.saveAsset({ name: 'Drill', location: 'Garage', currentValue: 100 });
  s.bulkUpdate([a.id, b.id], { grab: 'add' });
  assert.deepStrictEqual(s.allAssets().filter(x => x.grab).map(x => x.name).sort(), ['Laptop', 'Passport']);
  const { buildGrabListHtml } = require('../src/grablist');
  const g = buildGrabListHtml(s);
  assert.ok(g.indexOf('Home / Bedroom') < g.indexOf('Home / Office') && !g.includes('Drill'));
  const { buildReportHtml } = require('../src/report');
  const r = buildReportHtml(s, { groupBy: 'location', place: 'Home', includePhotos: false });
  assert.ok(r.includes('<h2>Home / Bedroom') && r.includes('<h2>Home / Office') && !r.includes('Drill'));
  assert.ok(r.includes('Household inventory report: Home'));
});

test('batch E: videos, photos and videos of a place, place labels, bought abroad', async () => {
  const s = tmpStore();
  const a = s.saveAsset({ name: 'Lounge TV' });
  const v = s.addDocument(a.id, 'walkround.MP4', Buffer.from('fake video'), 'Other');
  assert.strictEqual(v.type, 'Video');
  assert.throws(() => s.addPlaceFile('', 'x.mp4', Buffer.from('x')), /Choose a place/);
  assert.throws(() => s.addPlaceFile('Home / Lounge', 'notes.pdf', Buffer.from('x')), /only photos/);
  const f = s.addPlaceFile('home/lounge', 'Lounge walk-through.mov', Buffer.from('movie bytes'));
  assert.strictEqual(f.kind, 'video');
  const e = s.data.places['home / lounge'];
  assert.strictEqual(s.readAttachment(e.id, f.file).toString(), 'movie bytes');
  assert.strictEqual(s.placeFiles('home / lounge').length, 1);
  s.removePlaceFile('home / lounge', f.id);
  assert.ok(!fs.existsSync(s.attachmentPath(e.id, f.file)));
  const { buildPlaceLabelsHtml } = require('../src/labels');
  const html = await buildPlaceLabelsHtml(['Home / Garage / Box 3'], { copies: 2 });
  assert.strictEqual((html.match(/class="lab"/g) || []).length, 2);
  assert.ok(html.includes('>Box 3<') && html.includes('Home / Garage'));
  const { placeLink } = require('../src/phoneview');
  assert.strictEqual(placeLink('Home / Garage / Box 3'), 'https://guestymark-spr.github.io/OpenSafe/#place=Home%20%2F%20Garage%20%2F%20Box%203');
  const t = s.saveAsset({ name: 'Tent', purchasePrice: '252.55', foreignCurrency: 'eur', foreignPrice: '300', fxRate: 0.84183, fxDate: '2025-03-14' });
  assert.deepStrictEqual([t.foreignCurrency, t.foreignPrice, t.fxRate, t.fxDate], ['EUR', 300, 0.84183, '2025-03-14']);
  const g = s.saveAsset({ id: t.id, name: 'Tent', foreignCurrency: '' });
  assert.deepStrictEqual([g.foreignCurrency, g.foreignPrice, g.fxRate, g.fxDate, g.purchasePrice], ['', null, null, '', 252.55]);
  assert.strictEqual(s.saveAsset({ name: 'X', foreignCurrency: 'GBP', foreignPrice: 5 }).foreignCurrency, '');
});

test('batch F: borrowed, owner, spending by year, duplicates and merge, delete many, recall matching', () => {
  const s = tmpStore();
  const trailer = s.saveAsset({ name: "Dave's trailer", status: 'Borrowed', borrowedFrom: 'Dave', returnBy: addDays(5), currentValue: 800 });
  s.saveAsset({ name: 'Old drill', status: 'Given back', currentValue: 50 });
  const tv = s.saveAsset({ name: 'TV', owner: 'Mark', currentValue: 500, purchasePrice: 600, purchaseDate: '2024-11-29', category: 'Electronics' });
  s.saveAsset({ name: 'Kettle', owner: 'mark', purchasePrice: 40, purchaseDate: '2024-02-01', category: 'Appliances' });
  s.saveAsset({ name: 'Sofa', purchasePrice: 900, category: 'Furniture' });
  const sum = s.summary();
  assert.strictEqual(sum.count, 3);                         // TV, Kettle, Sofa
  assert.strictEqual(sum.borrowedCount, 1);
  assert.strictEqual(sum.currentTotal, 500 + 40 + 900);     // trailer not counted
  assert.deepStrictEqual(sum.byOwner, { Mark: { count: 1, value: 500 }, mark: { count: 1, value: 40 } });
  assert.deepStrictEqual(s.data.people, ['Mark']);          // case-insensitive list of people
  assert.ok(s.reminders().some(r => r.assetId === trailer.id && r.kind === 'Give back to Dave'));
  const sp = s.spendingByYear();
  assert.deepStrictEqual(sp.map(r => [r.year, r.total, r.count]), [['2024', 640, 2], ['Unknown', 900, 1]]);
  assert.strictEqual(sp[0].top[0].category, 'Electronics');
  assert.throws(() => s.bulkUpdate([tv.id], { status: 'Borrowed' }), /who the items belong to/);
  // duplicates
  const a1 = s.saveAsset({ name: 'Makita Drill', serial: 'MK-1234', location: 'Garage', tags: ['diy'] });
  s.addPhoto(a1.id, 'a.png', Buffer.from('png-a'));
  const a2 = s.saveAsset({ name: 'Drill', serial: 'mk 1234', brand: 'Makita', notes: 'From the shed list', tags: ['tools'] });
  s.addPhoto(a2.id, 'b.png', Buffer.from('png-b'));
  s.addDocument(a2.id, 'receipt.pdf', Buffer.from('%PDF'), 'Receipt');
  s.saveService(a2.id, { date: '2025-01-01', type: 'Service' });
  const groups = s.findDuplicates();
  assert.ok(groups.some(g => g.reason === 'Same serial number' && g.ids.includes(a1.id) && g.ids.includes(a2.id)));
  const merged = s.mergeAssets(a1.id, [a2.id]);
  assert.deepStrictEqual([merged.photos.length, merged.documents.length, merged.service.length, merged.brand, merged.notes], [2, 1, 1, 'Makita', 'From the shed list']);
  assert.deepStrictEqual(merged.tags.sort(), ['diy', 'tools']);
  assert.strictEqual(s.readAttachment(a1.id, merged.photos[1].file).toString(), 'png-b');
  assert.strictEqual(s.getAsset(a2.id), null);
  assert.ok(s.binView().some(b => b.id === a2.id));
  const b1 = s.saveAsset({ name: 'Chair', purchasePrice: 30 }), b2 = s.saveAsset({ name: 'chair', purchasePrice: 30 });
  assert.ok(s.findDuplicates().some(g => g.ids.includes(b1.id)));
  s.notDuplicates([b2.id, b1.id]);
  assert.ok(!s.findDuplicates().some(g => g.ids.includes(b1.id)));
  assert.strictEqual(s.deleteMany([b1.id, b2.id, 'nope']), 2);
  // recall matching
  const r = require('../src/recalls');
  const res = [{ title: 'Product Recall: LG ESS Battery Division - RESU ESS Home Batteries (2103-0025)', link: '/product-safety-alerts-reports-recalls/product-recall-resu-ess-home-batteries-lg-ess-battery-division-2103-0025', public_timestamp: '2022-03-25T22:11:24Z', product_alert_type: 'product-recall', product_risk_level: 'low' },
    { title: 'Product Recall: Ridgeback Comet, Speed and Motion Bicycles (2609-0070)', link: '/product-safety-alerts-reports-recalls/x' }];
  assert.strictEqual(r.matchesFor({ id: 'i', name: 'Battery', brand: 'LG', model: 'RESU 10H' }, res).length, 0);  // model must appear in full
  assert.strictEqual(r.matchesFor({ id: 'i', name: 'Battery', brand: 'LG', model: 'RESU' }, res).length, 1);
  assert.strictEqual(r.matchesFor({ id: 'i', name: 'Battery', brand: 'Tesla', model: 'RESU' }, res).length, 0); // brand must appear too
  assert.strictEqual(r.queryFor({ model: '37' }), null);
  const saved = s.saveRecallCheck({ checked: 1, skipped: 0, matches: r.matchesFor({ id: tv.id, name: 'TV', brand: 'LG', model: 'RESU' }, res), errors: [] });
  assert.strictEqual(saved.matches.length, 1);
  s.dismissRecall(tv.id, saved.matches[0].link);
  assert.strictEqual(s.saveRecallCheck({ checked: 1, skipped: 0, matches: r.matchesFor({ id: tv.id, name: 'TV', brand: 'LG', model: 'RESU' }, res), errors: [] }).matches.length, 0);
});

test('batch G: premium history, label reading, photo dates, long reminder look-ahead', () => {
  const s = tmpStore();
  const p = s.savePolicy({ insurer: 'Aviva', type: 'Home contents', renewalDate: '2026-03-01', premium: 240, excess: 100 });
  assert.throws(() => s.renewPolicy(p.id, { premium: 260, renewalDate: '2026-02-01' }), /after the current one/);
  s.renewPolicy(p.id, { premium: '£281.50', renewalDate: '2027-03-01', insurer: 'Direct Line', note: 'Aviva wanted £320' });
  const p2 = s.data.policies[0];
  assert.deepStrictEqual([p2.insurer, p2.premium, p2.renewalDate, p2.excess], ['Direct Line', 281.5, '2027-03-01', 100]);
  assert.deepStrictEqual(p2.history.map(h => [h.endedOn, h.insurer, h.premium, h.note]), [['2026-03-01', 'Aviva', 240, 'Aviva wanted £320']]);
  s.addPolicyHistory(p.id, { endedOn: '2025-03-01', premium: 199, insurer: 'Aviva' });
  assert.deepStrictEqual(s.data.policies[0].history.map(h => h.endedOn), ['2025-03-01', '2026-03-01']);
  s.savePolicy({ id: p.id, insurer: 'Direct Line', notes: 'edited' });                 // editing keeps the history
  assert.strictEqual(s.data.policies[0].history.length, 2);
  s.removePolicyHistory(p.id, s.data.policies[0].history[0].id);
  assert.strictEqual(s.data.policies[0].history.length, 1);
  // label reading
  const { parseLabel } = require('../src/ocr');
  assert.deepStrictEqual((({ serial, model }) => ({ serial, model }))(parseLabel('MAKITA\nModel: DHP485\nSerial No. 0012345Y')), { serial: '0012345Y', model: 'DHP485' });
  assert.strictEqual(parseLabel('SERIAL NUMBER\nMODEL NUMBER').serial, '');
  // photo dates
  const { takenAt } = require('../src/exif');
  const le = fs.readFileSync(path.join(__dirname, 'fixtures', 'exif-2023-07-15.jpg'));
  assert.strictEqual(takenAt(le), '2023-07-15');
  assert.strictEqual(takenAt(fs.readFileSync(path.join(__dirname, 'fixtures', 'exif-be-2021-12-24.jpg'))), '2021-12-24');
  assert.strictEqual(takenAt(Buffer.from('not a jpeg at all')), '');
  const a = s.saveAsset({ name: 'Tent' });
  s.addPhoto(a.id, 'tent.jpg', le);
  assert.strictEqual(s.getAsset(a.id).photos[0].takenAt, '2023-07-15');
  assert.strictEqual(s.photoDateHint(s.getAsset(a.id)), '2023-07-15');
  s.dismissDateHint(a.id);
  assert.strictEqual(s.photoDateHint(s.getAsset(a.id)), null);
  const b = s.saveAsset({ name: 'Bike' });
  s.addPhoto(b.id, 'bike.jpg', le);
  delete s.getAsset(b.id).photos[0].takenAt;                                          // an older photo, not checked yet
  assert.strictEqual(s.backfillPhotoDates(10), 1);
  assert.strictEqual(s.getAsset(b.id).photos[0].takenAt, '2023-07-15');
  assert.strictEqual(s.backfillPhotoDates(10), 0);
  // the phone sends the photo date (shrinking removes it from the file)
  const r = s.importCapture({ format: 'opensafe-export', version: 1, items: [{ id: 'abcdef01-2345-4678-89ab-cdef01234568', name: 'Kayak', photos: [{ id: 'p1', name: 'k.jpg', type: 'image/jpeg', takenAt: '2024-08-02', data: Buffer.from('jpegish').toString('base64') }] }] });
  assert.strictEqual(r.added, 1);
  assert.strictEqual(s.getAsset('abcdef01-2345-4678-89ab-cdef01234568').photos[0].takenAt, '2024-08-02');
  // reminders far ahead (used for reminders while closed)
  s.saveAsset({ name: 'Car', details: { kind: 'vehicle', motDue: addDays(200) } });
  assert.ok(!s.reminders().some(x => x.assetName === 'Car'));
  assert.ok(s.reminders(new Date(), 400).some(x => x.assetName === 'Car'));
});

test('batch H: packing lists and sale listing', () => {
  const s = tmpStore();
  const tent = s.saveAsset({ name: 'Tent', location: 'Home / Loft' });
  const stove = s.saveAsset({ name: 'Stove', location: 'Garage' });
  assert.throws(() => s.saveTrip({ name: '' }), /Give the packing list a name/);
  assert.throws(() => s.saveTrip({ name: 'X', startDate: '2027-07-04', endDate: '2027-06-29' }), /ends before it starts/);
  const t = s.saveTrip({ name: 'Ardennes tour', startDate: '2027-06-29', endDate: '2027-07-04' });
  s.setTripItems(t.id, [tent.id, stove.id, 'nope']);
  s.addTripExtra(t.id, 'Sun cream\nPassport\n\n');
  assert.deepStrictEqual([s._trip(t.id).items.length, s._trip(t.id).extras.map(x => x.text)], [2, ['Sun cream', 'Passport']]);
  s.tickTrip(t.id, tent.id, 'packed', true);
  s.tickTrip(t.id, s._trip(t.id).extras[0].id, 'back', true);       // back implies packed
  assert.deepStrictEqual(s._trip(t.id).extras[0], Object.assign({}, s._trip(t.id).extras[0], { packed: true, back: true }));
  s.setTripItems(t.id, [tent.id]);                                     // keeps the tent's tick
  assert.strictEqual(s._trip(t.id).items[0].packed, true);
  const t2 = s.saveTrip({ name: 'Next year', copyFrom: t.id });
  assert.deepStrictEqual(s._trip(t2.id).items.map(i => [i.assetId, i.packed]), [[tent.id, false]]);
  assert.strictEqual(s._trip(t2.id).extras.length, 2);
  s.resetTrip(t.id);
  assert.ok([...s._trip(t.id).items, ...s._trip(t.id).extras].every(r => !r.packed && !r.back));
  s.deleteAsset(tent.id);                                              // a deleted item leaves the lists
  assert.strictEqual(s._trip(t.id).items.length, 0);
  const pv = require('../src/phoneview');
  s.restoreAsset(tent.id); s.setTripItems(t.id, [tent.id, stove.id]);
  const view = pv.buildView(s, {});
  assert.deepStrictEqual(view.trips.find(x => x.id === t.id).items.map(i => i.id).sort(), [tent.id, stove.id].sort());
  s.deleteTrip(t2.id);
  assert.strictEqual(s.data.trips.length, 1);
  // sale listing
  const { buildListing } = require('../src/listing');
  const drill = s.saveAsset({ name: 'Cordless drill', brand: 'Makita', model: 'DHP485', condition: 'Good', purchaseDate: '2025-03-14', supplier: 'Screwfix', serial: 'SECRET-SERIAL', purchasePrice: 129, notes: 'private note', warrantyExpiry: '2099-03-14' });
  const bat = s.saveAsset({ name: '5Ah battery', brand: 'Makita' });
  s.setParts(drill.id, [bat.id]);
  s.addDocument(drill.id, 'r.pdf', Buffer.from('%PDF'), 'Receipt');
  const l = buildListing(s, s.getAsset(drill.id));
  assert.strictEqual(l.title, 'Makita Cordless drill DHP485 with 5Ah battery');
  assert.ok(l.text.includes('Bought: March 2025 from Screwfix') && l.text.includes('- Makita 5Ah battery') && l.text.includes('Original receipt available.'));
  assert.ok(!/SECRET-SERIAL|private note|129/.test(l.text));
  const long = buildListing(s, s.saveAsset({ name: 'A'.repeat(120) }));
  assert.ok(long.title.length <= 80);
});
