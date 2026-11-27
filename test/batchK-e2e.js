'use strict';
// Batch K through the window: items from an order email (70), the Monday summary (71) and the
// "If something happens to me" pack (66), which is then opened in a fresh browser window with the passphrase.
// Run: xvfb-run -a npx electron --no-sandbox test/batchK-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog, shell, BrowserWindow, Notification } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/batchK-e2e';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osbatchk-'));
const dir = path.join(root, 'data'); fs.mkdirSync(dir);
process.env.OPENSAFE_DATA_DIR = dir;
const PACK = path.join(OUT, 'For my family.html');
try { fs.unlinkSync(PACK); } catch (_) {}
dialog.showSaveDialog = async () => ({ canceled: false, filePath: PACK });
dialog.showMessageBox = async () => ({ response: 0 });
shell.openPath = async () => '';
const notes = [];
Notification.isSupported = () => true;
Notification.prototype.show = function () { notes.push({ title: this.title, body: this.body }); };

const eml = `From: Amazon.co.uk <auto-confirm@amazon.co.uk>\r\nTo: mark@example.com\r\nSubject: Your Amazon.co.uk order #204-1234567-8901234\r\nDate: Thu, 12 Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello Mark,\r\nThanks for your order.\r\nOrder #204-1234567-8901234\r\nBosch PSB 1800 LI-2 Cordless Combi Drill\r\nQty: 1\r\n£79.99\r\nAnker USB-C Charger 65W\r\nQty: 2\r\n£25.98\r\nItem subtotal: £105.97\r\nOrder Total: £105.97\r\n`;
const s = new Store(dir); s.load();
s.saveAsset({ name: 'Harley-Davidson Low Rider S', category: 'Vehicles', location: 'Garage', purchasePrice: 18000, serial: '1HD1YZK' });
s.saveAsset({ name: 'Kettle', purchasePrice: 30 });
s.savePolicy({ insurer: 'Aviva', type: 'Buildings', policyNumber: 'HP-555', claimsPhone: '0800 000 000' });
const order = s.saveLibraryEntry({ kind: 'data', title: 'Your Amazon.co.uk order' });
s.addLibraryFile(order.id, 'order.eml', Buffer.from(eml, 'utf8'));
const will = s.saveLibraryEntry({ kind: 'document', title: 'My will', from: 'Smith & Co Solicitors', docDate: '2025-06-01' });
s.addLibraryFile(will.id, 'will.pdf', fs.readFileSync(path.join(F, 'text.pdf')));
s.saveLibraryEntry({ kind: 'document', title: 'Council tax bill', docDate: '2026-04-01' });
s.data.settings.letterFrom = { name: 'Mark Example' }; s.save();
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name, w = win) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await w.webContents.capturePage()).toPNG()); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      // ---- 70: order email → items
      await js(`document.querySelector('[data-nav=files]').click()`); await wait(600);
      await js(`document.querySelector('[data-action=libOpen][data-lib="${order.id}"]').click()`); await wait(800);
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(300);
      await js(`document.querySelector('#view .head .menu [data-action=libOrderItems]').click()`); await wait(1500);
      R.orderForm = await js(`(() => { const el = document.getElementById('ordForm').elements; return { shop: el.shop.value, orderNo: el.orderNo.value, date: el.date.value, n0: el.name0.value, p0: el.price0.value, n1: el.name1.value, q1: el.qty1.value }; })()`);
      await shot('k1-order-form');
      await js(`document.querySelector('#ordForm [type=submit]').click()`); await wait(4000);
      const st = new Store(dir); st.load();
      const made = st.allAssets().filter(a => /Bosch|Anker/.test(a.name));
      R.items = made.map(a => ({ name: a.name, price: a.purchasePrice, date: a.purchaseDate, supplier: a.supplier, notes: a.notes, docs: (a.documents || []).map(d => d.name + ' ' + d.type) }));
      const oe = st.data.library.find(e => e.id === order.id);
      R.linked = made.every(a => (oe.links || oe.assetIds || []).includes(a.id) || JSON.stringify(oe).includes(a.id));
      const doc = made[0] && (made[0].documents || [])[0];
      if (doc) { const p = path.join(dir, 'attachments', made[0].id, doc.file); R.receiptIsPdf = fs.existsSync(p) && fs.readFileSync(p).slice(0, 5).toString() === '%PDF-'; }
      await shot('k2-after-order');
      // ---- 71: Monday summary
      await js(`document.querySelector('[data-nav=settings]').click()`); await wait(900);
      R.weeklyChecked = await js(`document.getElementById('weeklyOn').checked`);
      await js(`document.querySelector('[data-action=summaryShow]').click()`); await wait(1500);
      R.notes = notes.slice();
      R.toast = await js(`(document.querySelector('.toast') || {}).innerText || ''`);
      await shot('k3-summary');
      await js(`(() => { const c = document.getElementById('weeklyOn'); c.checked = false; c.dispatchEvent(new Event('change')); })()`); await wait(800);
      R.prefsWeekly = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).weekly;
      // ---- 66: the pack
      await js(`document.querySelector('[data-nav=data]').click()`); await wait(600);
      R.kinCard = await js(`document.getElementById('kinCard').innerText.replace(/\\s+/g, ' ')`);
      await js(`document.querySelector('[data-action=kinOpen]').click()`); await wait(900);
      await js(`(() => { const f = document.getElementById('kinForm'), el = f.elements;
        el.letter.value = 'Dear family, everything you need is in here.'; el.where.value = 'Spare keys: kitchen drawer.';
        el.cn0.value = 'Smith & Co'; el.cr0.value = 'Solicitor'; el.cc0.value = '0121 496 0000';
        el.minValue.value = '1000';
        f.querySelector('input[name=doc][value="${will.id}"]').click();
        el.pass.value = 'tulip anchor rain velvet'; el.pass2.value = 'tulip anchor rain'; })()`);
      await shot('k4-kin-form');
      await js(`document.querySelector('#kinForm [type=submit]').click()`); await wait(800);
      R.mismatch = await js(`document.getElementById('kinErr').textContent`);
      await js(`(() => { const el = document.getElementById('kinForm').elements; el.pass.value = el.pass2.value = 'short'; })()`);
      await js(`document.querySelector('#kinForm [type=submit]').click()`); await wait(800);
      R.weak = await js(`document.getElementById('kinErr').textContent`);
      await js(`(() => { const el = document.getElementById('kinForm').elements; el.pass.value = el.pass2.value = 'tulip anchor rain velvet'; })()`);
      await js(`document.querySelector('#kinForm [type=submit]').click()`); await wait(4000);
      R.done = await js(`document.querySelector('.modal .dialog').innerText.replace(/\\s+/g, ' ')`);
      await shot('k5-kin-done');
      const html = fs.readFileSync(PACK, 'utf8');
      R.size = html.length;
      { const kin = require('../src/kinpack'); const c = kin.decrypt(JSON.parse(html.match(/const PACK = (\{.*?\});/)[1]), 'tulip anchor rain velvet');
        R.embeddedSame = Buffer.from(c.documents[0].files[0].data, 'base64').equals(fs.readFileSync(path.join(F, 'text.pdf'))); R.docDate = c.documents[0].date; }
      R.leaks = ['Smith', 'Aviva', 'HP-555', 'Harley', 'kitchen drawer', 'tulip'].filter(w => html.includes(w));
      const st2 = new Store(dir); st2.load();
      R.saved = st2.data.kinPack; R.savedHasPass = JSON.stringify(st2.data).includes('tulip anchor');
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      // open the saved file in a plain browser window, as their family would
      const b = new BrowserWindow({ width: 1000, height: 900, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
      await b.loadFile(PACK);
      const bj = (c) => b.webContents.executeJavaScript(c);
      R.lockedText = (await bj(`document.body.innerText`)).replace(/\s+/g, ' ').slice(0, 300);
      await bj(`document.getElementById('p').value = 'wrong passphrase here'; document.getElementById('go').click()`);
      for (let i = 0; i < 40 && !(await bj(`document.getElementById('e').textContent`)); i++) await wait(250);
      R.wrong = await bj(`document.getElementById('e').textContent`);
      await bj(`document.getElementById('p').value = 'tulip anchor rain velvet'; document.getElementById('go').click()`);
      for (let i = 0; i < 60 && !(await bj(`!!window.__opened`)); i++) await wait(250);
      R.opened = (await bj(`document.getElementById('out').innerText`)).replace(/\s+/g, ' ');
      R.fileLinks = await bj(`document.querySelectorAll('a[data-how=open]').length`);
      await shot('k6-pack-open', b);
      b.destroy();
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
      console.log(JSON.stringify(R, null, 2));
    } catch (err) { console.error('E2E FAILED:', err); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(Object.assign(R, { error: String(err) }), null, 2)); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  });
});
