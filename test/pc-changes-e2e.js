'use strict';
// PC side of "changes from scanning labels": double-click import of a file with changes,
// the import summary, and the item page / form showing the new status and lending contact.
// Run: xvfb-run -a npx electron --no-sandbox test/pc-changes-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/pcchg';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ospcchg-'));
process.env.OPENSAFE_DATA_DIR = dir;
const boxes = [];
dialog.showMessageBox = async (_w, o) => { boxes.push(o || _w); return { response: 0 }; };

const s = new Store(dir); s.load();
const drill = s.saveAsset({ name: 'Makita drill', category: 'Tools', location: 'Garage' });
const ladder = s.saveAsset({ name: 'Ladder', category: 'Tools', location: 'Garage' });
const at = new Date(Date.now() + 60000).toISOString();
const file = path.join(OUT, 'changes.opensafe');
fs.writeFileSync(file, JSON.stringify({ format: 'opensafe-export', version: 2, items: [], updates: [
  { id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', itemId: drill.id, itemName: 'Makita drill', at, kind: 'lend', summary: 'Lent to Dave (07700 900123), due back 5 Dec 2026',
    changes: { status: 'Lent out', lentTo: 'Dave', lentContact: '07700 900123', lentDate: '2026-11-26', dueBack: '2026-12-05' } },
  { id: '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', itemId: ladder.id, itemName: 'Ladder', at, kind: 'needsRepair', summary: 'Needs repairing', note: 'Bent rung', changes: { status: 'Needs repair' } }
] }));
process.argv.push(file);
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const R = {};
    try {
      win.setSize(1320, 860);
      for (let i = 0; i < 40 && !boxes.length; i++) await wait(250);
      R.importBox = boxes[0] && { message: boxes[0].message, detail: boxes[0].detail };
      await wait(800);
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      R.listRows = await js(`[...document.querySelectorAll('[data-open]')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Makita')).click()`); await wait(400);
      await shot('p1-drill');
      R.drillPage = await js(`[...document.querySelectorAll('.kv > div')].map(d => d.innerText.replace(/\\n/g, ': ')).filter(t => /Status|Lent|Contact|Due|Location/.test(t))`);
      R.drillNotes = await js(`document.body.innerText.includes('(phone): Lent to Dave')`);
      await js(`document.querySelector('[data-action=edit]').click()`); await wait(400);
      R.formContact = await js(`document.querySelector('[name=lentContact]').value`);
      R.statusOptions = await js(`[...document.querySelectorAll('#fStatus option')].map(o => o.value)`);
      await shot('p2-drill-form');
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
