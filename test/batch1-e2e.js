'use strict';
// Screens for vehicle/boat details, lending, policies, automatic backups and dark mode.
// Run: xvfb-run -a npx electron --no-sandbox test/batch1-e2e.js <outDir> [dark]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { Store } = require('../src/store');

const args = process.argv.slice(2);
const OUT = args.find(a => a.startsWith('/')) || '/tmp/okshots/b1';
const DARK = args.includes('dark');
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osb1-'));
process.env.OPENSAFE_DATA_DIR = dir;
if (DARK) fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ theme: 'dark' }));

const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const s = new Store(dir); s.load();
const pol = s.savePolicy({ insurer: 'Admiral', type: 'Vehicle', policyNumber: 'ADM-55-901', renewalDate: d(18), premium: 612.4, excess: 250, coverLimit: 15000, claimsPhone: '0333 220 2000' });
s.savePolicy({ insurer: 'Aviva', type: 'Home contents', policyNumber: 'HC-1234', renewalDate: d(160), premium: 210, coverLimit: 5000 });
const car = s.saveAsset({ name: 'Mercedes C220d estate', category: 'Vehicles', location: 'Driveway', currentValue: 14500, policyId: pol.id,
  details: { kind: 'vehicle', reg: 'AB21 CDE', vin: 'WDD2052141F123456', mileage: '48,200', fuel: 'Diesel', motDue: d(9), taxDue: d(75), serviceDue: d(40) } });
s.addPhoto(car.id, 'p1.jpg', fs.readFileSync('/tmp/okshots/photos/p1.jpg'));
const bike = s.saveAsset({ name: 'Harley-Davidson Low Rider S', category: 'Vehicles', location: 'Garage', currentValue: 17000, policyId: pol.id, details: { kind: 'vehicle', reg: 'HD25 LRS', motDue: d(300) } });
s.addPhoto(bike.id, 'p0.jpg', fs.readFileSync('/tmp/okshots/photos/p0.jpg'));
s.saveAsset({ name: 'Cordless drill', category: 'Tools', currentValue: 140, status: 'Lent out', lentTo: 'Dave', lentDate: d(-20), dueBack: d(-3) });
s.saveAsset({ name: 'Old TV', category: 'Electronics', status: 'Sold', soldDate: d(-12), soldPrice: 150, soldTo: 'Facebook Marketplace' });
s.saveAsset({ name: 'Moody 37', category: 'Marine', currentValue: 48000, details: { kind: 'boat', boatName: 'Sea Breeze', hin: 'GB-MOD37123B494', engine: 'Volvo Penta MD22', engineHours: '2,310', mooring: 'Cardiff Bay Yacht Club' } });

require('../src/main.js');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(700); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const R = {};
    try {
      win.setSize(1320, 860); await wait(1500);
      await shot('b1-dashboard');
      R.dashboardComingUp = await js(`[...document.querySelectorAll('.rowi')].slice(0,6).map(e => e.innerText.replace(/\\n/g,' '))`);
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Mercedes')).click()`); await wait(500);
      await shot('b2-car-overview');
      R.carText = await js(`document.getElementById('view').innerText`);
      await js(`document.querySelector('[data-action=edit]').click()`); await wait(500);
      await js(`document.querySelector('.modal').scrollTop = 420`); await shot('b3-car-form');
      // change status to Lent out to show the section, then cancel
      R.lendHiddenBefore = await js(`document.getElementById('lendBox').classList.contains('hidden')`);
      await js(`const st = document.getElementById('fStatus'); st.value = 'Lent out'; st.dispatchEvent(new Event('change'))`);
      R.lendShownAfter = !(await js(`document.getElementById('lendBox').classList.contains('hidden')`));
      // switching kind keeps typed values
      await js(`const k = document.getElementById('fKind'); k.value = 'boat'; k.dispatchEvent(new Event('change'))`);
      R.boatFields = await js(`[...document.querySelectorAll('#detBox label')].map(l => l.firstChild.textContent)`);
      await js(`document.querySelector('[data-action=close]').click()`); await wait(300);
      // new item: category guess
      await js(`document.querySelector('[data-action=new]').click()`); await wait(300);
      await js(`const c = document.getElementById('fCat'); c.value = 'Marine'; c.dispatchEvent(new Event('change'))`);
      R.kindGuessMarine = await js(`document.getElementById('fKind').value`);
      await js(`const f = document.getElementById('itemForm'); f.name.value = 'Dinghy'; f.det_hin.value = 'HIN-777'; f.requestSubmit()`); await wait(900);
      R.savedDinghy = await js(`document.getElementById('view').innerText.includes('HIN-777')`);
      await shot('b4-dinghy');
      await js(`[...document.querySelectorAll('[data-nav=policies]')][0].click()`); await wait(500);
      await shot('b5-insurance');
      R.insurance = await js(`document.getElementById('view').innerText.slice(0, 600)`);
      await js(`document.querySelector('[data-nav=reminders]').click()`); await wait(400);
      await shot('b6-reminders');
      R.reminders = await js(`[...document.querySelectorAll('.rowi')].map(e => e.innerText.replace(/\\n/g,' '))`);
      await js(`document.querySelector('[data-nav=settings]').click()`); await wait(400);
      await js(`document.getElementById('view').scrollTop = 500`); await shot('b7-settings');
      await js(`document.getElementById('view').scrollTop = 0`);
      await js(`[...document.querySelectorAll('[data-nav=items]')][0].click()`); await wait(400);
      await shot('b8-items');
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
