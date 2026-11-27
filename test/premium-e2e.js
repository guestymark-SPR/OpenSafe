'use strict';
// The redesign: + New menu, filter chips, Move to, right-click menus, dragging onto places and folders,
// moving between Documents and Data, linking documents to items.
// Run: xvfb-run -a npx electron --no-sandbox test/premium-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/premium';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osprem-'));
process.env.OPENSAFE_DATA_DIR = dir;
dialog.showMessageBox = async () => ({ response: 0 });
let pick = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: pick });

const s = new Store(dir); s.load();
s.setLists(s.data.categories, ['Home', 'Home / Garage', 'Home / Garage / Shelf 2', 'Home / Office', 'Storage']);
const drill = s.saveAsset({ name: 'Makita drill', category: 'Tools', location: 'Home / Garage' });
const saw = s.saveAsset({ name: 'Circular saw', category: 'Tools', location: 'Home / Garage' });
const laptop = s.saveAsset({ name: 'Lenovo Legion 5', category: 'Computers & Phones', location: 'Home / Office' });
s.saveAsset({ name: 'TentBox Lite XL', category: 'Camping & Outdoor', location: 'Storage' });
const addLib = (kind, title, file, extra) => { const e = s.saveLibraryEntry(Object.assign({ kind, title }, extra || {})); s.addLibraryFile(e.id, file, fs.readFileSync(path.join(F, file))); return e; };
const manual = addLib('document', 'Drill manual', 'text.pdf', { docType: 'Home', from: 'Makita' });
const receipt = addLib('document', 'Saw receipt', 'statement.pdf', { docType: 'Bill', from: 'Screwfix' });
addLib('data', 'Booking email', 'booking.eml', { folder: 'Emails' });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const store = () => js(`window.keep.getData().then(d => d.data)`);
    const where = async (id) => (await store()).assets.find(a => a.id === id).location;
    // simulated drag: dragstart on the source, then drop on a target in the drop panel
    const dragTo = (srcSel, targetText) => js(`(async () => {
      const dt = new DataTransfer(); const src = document.querySelector(${JSON.stringify(srcSel)});
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 300));
      const panel = document.getElementById('dropPanel'); if (!panel) return 'no panel';
      const t = [...panel.querySelectorAll('.droptarget')].find(x => x.innerText.trim().startsWith(${JSON.stringify(targetText)}));
      if (!t) return 'no target: ' + panel.innerText.replace(/\\s+/g, ' ');
      t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 'dropped; panel had: ' + [...panel.querySelectorAll('.droptarget')].map(x => x.innerText.trim()).join(' | ');
    })()`);
    const rightClick = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 })); return [...document.querySelectorAll('.menu.ctx button')].map(b => b.innerText.trim()); })()`);
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // ---- + New
      await js(`document.getElementById('addBtn').click()`); await wait(400);
      R.newMenu = await js(`[...document.querySelectorAll('.newmenu button')].map(b => b.innerText.trim().replace(/\\s+/g, ' '))`);
      R.newMenuUp = await js(`document.querySelector('.newmenu').classList.contains('up') || document.querySelector('.newmenu').getBoundingClientRect().bottom < document.getElementById('addBtn').getBoundingClientRect().top + 2`);
      await shot('p1-new-menu');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(200);
      R.escClosesMenu = await js(`document.querySelector('.newmenu').classList.contains('hidden')`);
      // ---- Items: chips
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(500);
      R.chips = await js(`[...document.querySelectorAll('.chips .chip')].map(c => c.innerText.trim())`);
      await js(`document.querySelector('.chips .chip').click()`); await wait(300);
      await shot('p2-chip-menu');
      await js(`[...document.querySelectorAll('.chips .menu:not(.hidden) button')].find(b => b.innerText.trim() === 'Tools').click()`); await wait(500);
      R.afterChip = await js(`[...document.querySelectorAll('table.list tbody tr .name')].map(n => n.innerText.trim()) + ' | chip: ' + document.querySelector('.chips .chip.on').innerText.trim()`);
      await js(`document.querySelector('.chips .chip.on .x').click()`); await wait(400);
      R.afterClear = await js(`document.querySelectorAll('table.list tbody tr').length`);
      // ---- select two, Move to
      for (const id of [drill.id, saw.id]) { await js(`document.querySelector('tr[data-open="${id}"] .selbox').click()`); await wait(300); }
      await js(`document.querySelector('.selbar .ddbtn').click()`); await wait(300);
      await shot('p3-move-to');
      await js(`[...document.querySelectorAll('.selbar .menu button')].find(b => b.innerText.includes('Shelf 2')).click()`); await wait(800);
      R.movedBySelect = [await where(drill.id), await where(saw.id)];
      // ---- right-click an item
      R.itemMenu = await rightClick('tr[data-open="' + laptop.id + '"]');
      await shot('p4-right-click');
      await js(`[...document.querySelectorAll('.menu.ctx button')].find(b => b.innerText.includes('Move to a place')).click()`); await wait(400);
      await js(`{ const q = document.getElementById('pkQ'); q.value = 'storage'; q.dispatchEvent(new Event('input')); }`); await wait(200);
      R.pickerRows = await js(`[...document.querySelectorAll('#pkRows [data-pick]')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await js(`document.querySelector('#pkRows [data-pick]').click()`); await wait(800);
      R.movedByMenu = await where(laptop.id);
      // ---- drag an item onto a place
      R.drag = await dragTo('tr[data-open="' + laptop.id + '"]', 'Office');
      await wait(800);
      R.movedByDrag = await where(laptop.id);
      R.panelGone = await js(`!document.getElementById('dropPanel')`);
      // ---- Documents: select two, new Data folder, then back
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      for (const id of [manual.id, receipt.id]) { await js(`document.querySelector('[data-action=libSelBox][data-lib="${id}"]').click()`); await wait(300); }
      R.libTicks = await js(`[...document.querySelectorAll('[data-action=libSelBox]')].map(c => c.checked)`);
      R.libSelBar = await js(`document.querySelector('.selbar').innerText.replace(/\\s+/g, ' ')`);
      await js(`document.querySelector('.selbar .ddbtn').click()`); await wait(300);
      R.libMoveMenu = await js(`[...document.querySelectorAll('.selbar .menu button')].map(b => b.innerText.trim())`);
      await shot('p5-doc-move');
      await js(`[...document.querySelectorAll('.selbar .menu button')].find(b => b.innerText.includes('New Data folder')).click()`); await wait(300);
      await js(`{ const f = document.getElementById('nfForm'); f.folder.value = 'Garage paperwork'; f.requestSubmit(); }`); await wait(900);
      R.afterFolder = (await store()).library.map(e => `${e.title}: ${e.kind}${e.folder ? ' › ' + e.folder : ''}`).sort();
      // drag one back to Documents from the Data page
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(500);
      R.dragDoc = await dragTo('tr[data-lib="' + manual.id + '"]', 'Documents');
      await wait(900);
      const lib = (await store()).library;
      R.afterDragDoc = lib.filter(e => e.id === manual.id).map(e => `${e.kind} ${e.docType}`)[0];
      // ---- link the saw receipt to the saw (right-click > Link to an item)
      R.libMenu = await rightClick('tr[data-lib="' + receipt.id + '"]');
      await js(`[...document.querySelectorAll('.menu.ctx button')].find(b => b.innerText.includes('Link to an item')).click()`); await wait(400);
      await js(`[...document.querySelectorAll('#pkRows [data-pick]')].find(r => r.innerText.includes('Circular saw')).click()`); await wait(900);
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      await js(`document.querySelector('tr[data-open="${saw.id}"]').click()`); await wait(900);
      R.itemDocsCard = await js(`[...document.querySelectorAll('.sidecol .card')].find(c => /linked documents and files/i.test(c.innerText)).innerText.replace(/\\s+/g, ' ')`);
      await shot('p6-item-linked');
      await js(`[...document.querySelectorAll('.sidecol .rowi')].find(r => r.innerText.includes('Saw receipt')).click()`); await wait(900);
      R.linkOpensDoc = await js(`document.querySelector('.libhead h1').innerText`);
      await js(`history.length; document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`document.querySelector('tr[data-open="${saw.id}"]').click()`); await wait(800);
      await js(`document.querySelector('[data-action=libUnlink]').click()`); await wait(800);
      R.afterUnlink = (await store()).library.find(e => e.id === receipt.id).assetIds.length;
      // ---- Places page drag
      await js(`document.querySelector('[data-nav=places]').click()`); await wait(500);
      R.placesRowDraggable = await js(`!!document.querySelector('.places tr[data-open][draggable=true]')`);
      // ---- dark mode looks
      await js(`document.querySelector('[data-nav=settings]').click()`); await wait(300);
      await js(`document.querySelector('[data-theme=dark]').click()`); await wait(700);
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(500);
      await js(`document.querySelector('.head .ddbtn').click()`); await wait(300);
      await shot('p7-dark-more');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(200);
      await js(`(async () => { const dt = new DataTransfer(); document.querySelector('tr[data-open]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); })()`); await wait(500);
      await shot('p8-dark-drag');
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
