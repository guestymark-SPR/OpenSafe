'use strict';
// Visual smoke test: seeds sample data, opens every screen, drives the phone page end-to-end,
// and saves screenshots. Run: xvfb-run -a npx electron --no-sandbox test/shoot.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv[process.argv.length - 1].startsWith('/') ? process.argv[process.argv.length - 1] : '/tmp/okshots/out';
const PHOTOS = '/tmp/okshots/photos';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okdata-'));
process.env.OPENKEEP_DATA_DIR = dir;

const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const s = new Store(dir); s.load();
const items = [
  { name: 'Cordless combi drill', brand: 'Makita', model: 'DHP485', serial: 'MK485-22031', category: 'Tools', location: 'Garage', purchasePrice: 189, currentValue: 140, purchaseDate: '2024-04-12', supplier: 'Screwfix', warrantyExpiry: d(20), tags: 'diy' },
  { name: 'Gaming laptop', brand: 'Lenovo', model: 'Legion 5', serial: 'PF4XK2LM', category: 'Computers & Phones', location: 'Home', purchasePrice: 1299, currentValue: 1050, purchaseDate: '2025-08-02', supplier: 'Currys', warrantyExpiry: d(250), insurer: 'Home contents', insuredValue: 1300 },
  { name: 'Road bike helmet', brand: 'Shoei', model: 'GT-Air 3', category: 'Motorbike Gear', location: 'Garage', purchasePrice: 579, purchaseDate: '2025-05-20' },
  { name: '4-person tent', brand: 'Vango', model: 'Odyssey Air 400', category: 'Camping & Outdoor', location: 'Storage', purchasePrice: 420, currentValue: 300, purchaseDate: '2023-06-01' },
  { name: 'Smart TV 55"', brand: 'LG', model: 'OLED55C4', serial: '405RMXX1234', category: 'Electronics', location: 'Home', purchasePrice: 1199, currentValue: 900, purchaseDate: '2024-11-29', warrantyExpiry: d(4), insurer: 'Home contents', insuredValue: 1200 },
  { name: 'Watch', brand: 'Seiko', model: 'Prospex SPB143', category: 'Jewellery & Watches', location: 'Home', purchasePrice: 1050, currentValue: 950, purchaseDate: '2022-03-14', insurer: 'Home contents', insuredValue: 1100 },
  { name: 'Pressure washer', brand: 'Kärcher', model: 'K5', category: 'Tools', location: 'Garage', purchasePrice: 249, currentValue: 150 }
];
items.forEach((it, i) => {
  const a = s.saveAsset(it);
  if (i < 6) s.addPhoto(a.id, `p${i}.jpg`, fs.readFileSync(path.join(PHOTOS, `p${i}.jpg`)));
  if (i === 1) s.addDocument(a.id, 'Currys receipt.pdf', Buffer.from('%PDF-1.4\n'), 'Receipt');
  if (i === 0) {
    s.saveService(a.id, { date: d(-200), type: 'Battery', description: 'Replaced 5Ah battery', cost: 59.99, by: 'Me', nextDueDate: d(-3) });
    s.saveService(a.id, { date: d(-30), type: 'Clean', description: 'Chuck cleaned and oiled', cost: 0 });
  }
});
s.updateSettings({ phoneLinkEnabled: true });

// Pretend this machine has a home Wi-Fi address so the QR code screen can be checked.
const realIfs = os.networkInterfaces;
os.networkInterfaces = () => Object.assign({}, realIfs(), { 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.42' }] });

require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let done = false;
app.on('browser-window-created', (_e, win) => {
  if (done) return; done = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(700); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); };
    const errors = [];
    win.webContents.on('console-message', (ev) => { const m = ev.message || ev; if (String(ev.level).match(/error|3/)) errors.push(String(m)); });
    try {
      win.setSize(1320, 860);
      await wait(1200);
      await shot('1-dashboard');
      await js(`document.querySelector('[data-nav=items]').click()`); await shot('2-items');
      await js(`document.querySelector('[data-layout=grid]').click()`); await shot('3-items-grid');
      await js(`document.querySelector('[data-open]').click()`); await shot('4-item-detail');
      await js(`document.querySelector('[data-tab=service]').click()`); await shot('5-item-service');
      await js(`document.querySelector('[data-action=edit]').click()`); await shot('6-edit');
      await js(`document.querySelector('[data-action=close]').click(); document.querySelector('[data-nav=reminders]').click()`); await shot('7-reminders');
      await js(`document.querySelector('[data-nav=reports]').click()`); await shot('8-reports');
      await js(`document.querySelector('[data-nav=settings]').click()`); await shot('9-settings');
      await js(`document.querySelector('[data-nav=phone]').click()`); await wait(1000); await shot('10-phone');

      // Drive the phone page like a phone would
      const store = new Store(dir); store.load();
      const tok = store.data.settings.phoneToken;
      const port = await js(`window.keep.phoneStatus().then(s => s.port)`);
      const phone = new BrowserWindow({ width: 412, height: 900, show: true, webPreferences: { sandbox: true } });
      await phone.loadURL(`http://127.0.0.1:${port}/m#t=${tok}`);
      await wait(1200);
      fs.writeFileSync(path.join(OUT, '11-phone-page.png'), (await phone.webContents.capturePage()).toPNG());
      const res = await phone.webContents.executeJavaScript(`(async () => {
        const f = document.getElementById('form');
        f.name.value = 'Camping stove'; f.category.value = 'Camping & Outdoor'; f.brand.value = 'Jetboil'; f.purchasePrice.value = '129.99';
        const resp = await fetch('/m/icon.png'); const blob = await resp.blob();
        const dt = new DataTransfer(); dt.items.add(new File([blob], 'stove.png', { type: 'image/png' }));
        const inp = document.getElementById('gallery'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 800));
        document.getElementById('save').click();
        await new Promise(r => setTimeout(r, 2500));
        return { toast: document.getElementById('toast').textContent, err: document.getElementById('error').textContent, location: location.href };
      })()`);
      fs.writeFileSync(path.join(OUT, '12-phone-after-save.png'), (await phone.webContents.capturePage()).toPNG());
      await wait(800);
      const fromPhone = await js(`window.keep.getData().then(s => s.data.assets.filter(a => a.source === 'phone').map(a => ({ name: a.name, price: a.purchasePrice, photos: a.photos.length })))`);
      await js(`document.querySelector('[data-nav=dashboard]').click()`); await shot('13-dashboard-after-phone');
      // Insurance report PDF through the same builder main.js uses
      const { buildReportHtml } = require('../src/report');
      const st2 = new Store(dir); st2.load();
      const tmp = path.join(OUT, 'report.html'); fs.writeFileSync(tmp, buildReportHtml(st2, {}));
      const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
      await pw.loadFile(tmp);
      fs.writeFileSync(path.join(OUT, 'report.pdf'), await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ phoneResult: res, fromPhone, rendererErrors: errors }, null, 2));
    } catch (e) {
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ fatal: e.stack }, null, 2));
    }
    app.exit(0);
  });
});
