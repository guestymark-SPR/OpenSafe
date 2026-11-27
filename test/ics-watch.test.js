'use strict';
// Calendar file and the watched folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ics = require('../src/ics');
const { FolderWatch, DONE } = require('../src/watcher');

test('calendar file: all-day events, alert the day before, stable IDs, escaped and folded', () => {
  const r = ics.build([
    { kind: 'MOT', assetName: 'Mercedes C220d, estate', date: '2026-12-05', assetId: 'a1' },
    { kind: 'No reply yet', assetName: 'Appeal; (to Child Maintenance Service) — a very long title that goes on and on past seventy-five bytes', date: '2026-12-31', libraryId: 'l1' },
    { kind: 'MOT', assetName: 'dup', date: '2026-12-05', assetId: 'a1' },
    { kind: 'Bad', assetName: 'x', date: 'soon' }
  ], { now: new Date('2026-11-27T10:00:00Z') });
  assert.strictEqual(r.count, 2);
  const t = r.text;
  assert.ok(t.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.match(t, /UID:mot-a1@opensafe\r\n/);
  assert.match(t, /DTSTART;VALUE=DATE:20261205\r\nDTEND;VALUE=DATE:20261206/);
  assert.match(t, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/);
  assert.match(t, /SUMMARY:MOT: Mercedes C220d\\, estate/);
  assert.match(t, /TRIGGER:-PT15H/);
  for (const line of t.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'line too long: ' + line);
  const unfolded = t.replace(/\r\n /g, '');
  assert.match(unfolded, /SUMMARY:No reply yet: Appeal\\; \(to Child Maintenance Service\) — a very long title that goes on and on past seventy-five bytes/);
  assert.ok(t.endsWith('END:VCALENDAR\r\n'));
});

test('watched folder: waits for a file to finish, skips temporary files, waits while locked, moves files aside', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oswatch-')), folder = path.join(dir, 'Scans');
  fs.mkdirSync(folder);
  const got = [];
  let locked = false, dupOf = new Set(['dup.pdf']), failNext = false;
  const w = new FolderWatch(path.join(dir, 'watch.json'), {
    canTake: () => !locked, settleMs: 1000, everyMs: 1e9,
    onFile: async (name, buf, kind) => { if (failNext) { failNext = false; throw new Error('damaged'); } got.push([name, buf.toString(), kind]); return dupOf.has(name) ? 'duplicate' : 'added'; }
  });
  w.set(folder, 'document'); w.stop(); // drive it by hand below
  fs.writeFileSync(path.join(folder, 'letter.pdf'), 'part');
  fs.writeFileSync(path.join(folder, 'download.pdf.crdownload'), 'x');
  fs.writeFileSync(path.join(folder, '~$draft.docx'), 'x');
  let t = 0;
  assert.deepStrictEqual(await w.scan(t += 10), []);            // first sight
  fs.appendFileSync(path.join(folder, 'letter.pdf'), 'more');    // still being written
  fs.utimesSync(path.join(folder, 'letter.pdf'), new Date(), new Date(Date.now() + 5000));
  assert.deepStrictEqual(await w.scan(t += 2000), []);
  assert.deepStrictEqual(await w.scan(t += 500), [], 'not settled yet');
  locked = true;
  assert.deepStrictEqual(await w.scan(t += 2000), [], 'locked: waits');
  locked = false;
  const taken = await w.scan(t += 10);
  assert.deepStrictEqual(taken, [{ name: 'letter.pdf', how: 'added' }]);
  assert.deepStrictEqual(got, [['letter.pdf', 'partmore', 'document']]);
  assert.ok(fs.existsSync(path.join(folder, DONE, 'letter.pdf')));
  assert.ok(!fs.existsSync(path.join(folder, 'letter.pdf')));
  assert.ok(fs.existsSync(path.join(folder, 'download.pdf.crdownload')) && fs.existsSync(path.join(folder, '~$draft.docx')), 'temporary files left alone');
  assert.strictEqual(w.status().added, 1);
  // the same name again goes in as "letter (2).pdf"; a duplicate is moved but not counted
  fs.writeFileSync(path.join(folder, 'letter.pdf'), 'again'); fs.writeFileSync(path.join(folder, 'dup.pdf'), 'd');
  await w.scan(t += 10); await w.scan(t += 2000);
  assert.ok(fs.existsSync(path.join(folder, DONE, 'letter (2).pdf')) && fs.existsSync(path.join(folder, DONE, 'dup.pdf')));
  assert.strictEqual(w.status().added, 2);
  // a file that fails stays, isn't retried until it changes, and the error is shown
  failNext = true;
  fs.writeFileSync(path.join(folder, 'bad.pdf'), 'b');
  await w.scan(t += 10); await w.scan(t += 2000);
  assert.ok(fs.existsSync(path.join(folder, 'bad.pdf')));
  assert.match(w.status().lastError, /bad\.pdf: damaged/);
  await w.scan(t += 2000);
  assert.strictEqual(got.filter(g => g[0] === 'bad.pdf').length, 0);
  // the setting is this PC's, kept outside the data
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'watch.json'), 'utf8')).folder, folder);
  w.set('');
  assert.strictEqual(w.status().folder, '');
});
