'use strict';
// Bills & budget 2.22 through the window: regular payments found in a statement and added, subscriptions,
// payday-to-payday months, carry-over, the balance forecast and run-short warning, and yearly bills in the plan.
// Run: xvfb-run -a npx electron --no-sandbox test/budget2-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/budget2-e2e';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osbudget2-'));
const dir = path.join(root, 'data'); fs.mkdirSync(dir);
process.env.OPENSAFE_DATA_DIR = dir;
const iso = (d) => d.toISOString().slice(0, 10);
const now = new Date(); const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
const day = (y, m, d) => new Date(Date.UTC(y, m, d));
// four months of statement, oldest first, ending yesterday
const rows = [];
const Y = today.getUTCFullYear(), M = today.getUTCMonth();
for (let k = 4; k >= 0; k--) {
  const y = day(Y, M - k, 1).getUTCFullYear(), m = day(Y, M - k, 1).getUTCMonth();
  const add = (d, who, ref, type, amount) => { const dt = day(y, m, d); if (dt < today && dt >= day(Y, M - 4, 1)) rows.push({ dt, who, ref, type, amount }); };
  add(1, 'Landlord', 'RENT', 'STANDING ORDER', -650);
  add(3, 'Netflix', 'NETFLIX.COM', 'CARD', -12.99);
  add(12, 'Octopus Energy', 'OCTOPUS', 'DIRECT DEBIT', -98.21);
  add(15, 'Tesco', 'TESCO STORES', 'CONTACTLESS', -60 - k);
  add(22, 'Tesco', 'TESCO STORES', 'CONTACTLESS', -45);
  add(28, 'Veterans UK', 'AFCS PAYMENT', 'FASTER PAYMENT', 1450);
}
for (let w = 0; w < 18; w++) { const dt = new Date(today.getTime() - (7 * w + 3) * 864e5); if (dt >= day(Y, M - 4, 1)) rows.push({ dt, who: 'PureGym', ref: 'PUREGYM', type: 'DIRECT DEBIT', amount: -24.99 }); }
rows.sort((a, b) => a.dt - b.dt);
let bal = 40;
const lines = ['Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes'];
for (const r of rows) { bal = Math.round((bal + r.amount) * 100) / 100; const d = r.dt; lines.push(`${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()},${r.who},${r.ref},${r.type},${r.amount.toFixed(2)},${bal.toFixed(2)},,`); }
const csv = path.join(root, 'starling.csv'); fs.writeFileSync(csv, lines.join('\n') + '\n');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [csv] });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const txt = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`).then(t => t.replace(/\s+/g, ' ').trim());
    const tab = (t) => js(`[...document.querySelectorAll('[data-action=bTab]')].find(x => x.dataset.t === '${t}').click()`).then(() => wait(600));
    const R = { finalBalance: bal };
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`window.confirm = () => true; 1`);
      await js(`document.querySelector('[data-nav=budget]').click()`); await wait(600);
      await js(`document.querySelector('[data-action=bImport]').click()`); await wait(700);
      await js(`(() => { const s = document.getElementById('bkBank'); s.value = 'starling'; s.dispatchEvent(new Event('change')); })()`);
      await js(`document.getElementById('bkPick').click()`); await wait(1200);
      await js(`document.querySelector('#bkForm [type=submit]').click()`); await wait(1500);
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      // found regular payments
      await tab('regular');
      R.found = await js(`[...document.querySelectorAll('#bFound tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('c1-found');
      // "Tesco" isn't regular enough to be found; tell it the gym isn't regular, add the rest
      await js(`document.querySelector('#bFound [data-action=bFoundIgnore][data-key="puregym"]').click()`); await wait(900);
      R.afterIgnore = await js(`[...document.querySelectorAll('#bFound tbody tr b')].map(b => b.textContent)`);
      await js(`document.querySelector('[data-action=bFoundAdd]').click()`); await wait(1200);
      R.regular = await js(`[...document.querySelectorAll('[data-action=bRegEdit]')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      R.foundLeft = await js(`!!document.getElementById('bFound')`);
      // Netflix is a subscription; give Octopus a contract end; add a yearly MOT
      await js(`[...document.querySelectorAll('[data-action=bRegEdit]')].find(r => r.innerText.includes('Netflix')).click()`); await wait(500);
      await js(`document.querySelector('#regForm [name=subscription]').click()`);
      await js(`document.querySelector('#regForm [type=submit]').click()`); await wait(800);
      R.subs = await txt('.card h2');
      await js(`document.querySelector('[data-action=bRegNew][data-kind=bill]').click()`); await wait(400);
      const mot = new Date(today.getTime() + 150 * 864e5).toISOString().slice(0, 10);
      await js(`(() => { const el = document.getElementById('regForm').elements; el.name.value = 'MOT and service'; el.amount.value = '240'; el.every.value = 'year'; el.next.value = '${mot}'; })()`);
      await js(`document.querySelector('#regForm [type=submit]').click()`); await wait(800);
      await shot('c2-bills');
      // payday months, from the 28th, Friday before a weekend
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(200);
      await js(`document.querySelector('#view .head [data-action=bSettings]').click()`); await wait(500);
      R.accounts = await js(`[...document.querySelectorAll('#bsForm tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await js(`(() => { const el = document.getElementById('bsForm').elements; el.day.value = '28'; el.weekend.value = 'before'; el.buffer.value = '2000'; })()`);
      await shot('c3-settings');
      await js(`document.querySelector('#bsForm [type=submit]').click()`); await wait(900);
      // carry-over on groceries with a £100 limit
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(200);
      await js(`document.querySelector('#view .head [data-action=bCats]').click()`); await wait(500);
      await js(`(() => { const tr = [...document.querySelectorAll('#bcForm tbody tr')].find(r => r.querySelector('[data-k=name]').value === 'Groceries'); tr.querySelector('[data-k=limit]').value = '100'; tr.querySelector('[data-k=rollover]').checked = true; })()`);
      await js(`document.querySelector('#bcForm [type=submit]').click()`); await wait(900);
      await tab('overview');
      R.period = await js(`document.querySelector('#view .head .seg button[disabled]').innerText`);
      R.forecastNote = await txt('#view .note');
      await shot('c4-overview');
      await tab('calendar');
      R.forecastIntro = await txt('#view p.muted');
      R.forecastRows = await js(`[...document.querySelectorAll('#view table.list tbody tr')].slice(0, 8).map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('c5-forecast');
      await tab('plan');
      R.sinking = await js(`[...document.querySelectorAll('.section-title')].map(x => x.innerText)`);
      R.sinkRows = await js(`(() => { const t = [...document.querySelectorAll('.section-title')].find(x => /Yearly/.test(x.innerText)); return t ? t.nextElementSibling.innerText.replace(/\\s+/g, ' ') : ''; })()`);
      await shot('c6-plan');
      // reminders: Octopus contract four weeks out
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
      console.log(JSON.stringify(R, null, 2));
    } catch (err) { console.error('E2E FAILED:', err); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(Object.assign(R, { error: String(err) }), null, 2)); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  });
});
