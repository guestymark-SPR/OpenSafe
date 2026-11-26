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
  s.deleteAsset(a.id);
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
  assert.throws(() => s.importCapture({ format: 'opensafe-export', version: 2, items: [] }), /newer version/);
  const r4 = s.importCapture({ format: 'opensafe-export', version: 1, items: [{ name: 'Bad file', photos: [{ name: 'x.exe', type: 'application/x-msdownload', data: png }] }] });
  assert.strictEqual(r4.added, 1); assert.strictEqual(r4.errors.length, 1);
});
