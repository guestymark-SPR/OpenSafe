'use strict';
// Bills & budget 2.23 through the window: alerts (limit, unusual payment, price rise), splitting a transaction,
// charts and their table view, one spending-money total, net worth with other savings and belongings, and debts.
// Run: xvfb-run -a npx electron --no-sandbox test/budget3-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/budget3-e2e';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osbudget3-'));
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
  add(12, 'Octopus Energy', 'OCTOPUS', 'DIRECT DEBIT', k === 0 ? -260.50 : -98.21);
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
const { Store } = require('../src/store');
{ const s = new Store(dir); s.load(); s.saveAsset({ name: 'Harley-Davidson Low Rider S', purchasePrice: 18000, category: 'Vehicles' }); s.save(); }
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
    const more = (a) => js(`document.querySelector('#view .head [data-action=moreMenu]').click()`).then(() => wait(200)).then(() => js(`document.querySelector('#view .head [data-action=${a}]').click()`)).then(() => wait(500));
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`window.confirm = () => true; 1`);
      await js(`document.querySelector('[data-nav=budget]').click()`); await wait(600);
      // Octopus is a bill from earlier at £98.21 before importing, so the import notes the rise
      await tab('regular');
      await js(`document.querySelector('[data-action=bRegNew][data-kind=bill]').click()`); await wait(400);
      await js(`(() => { const el = document.getElementById('regForm').elements; el.name.value = 'Octopus Energy'; el.amount.value = '98.21'; el.every.value = 'month'; el.next.value = '${iso(day(Y, M - 4, 12))}'; el.match.value = 'OCTOPUS'; })()`);
      await js(`document.querySelector('#regForm [type=submit]').click()`); await wait(700);
      await js(`document.querySelector('[data-action=bImport]').click()`); await wait(700);
      await js(`(() => { const s = document.getElementById('bkBank'); s.value = 'starling'; s.dispatchEvent(new Event('change')); })()`);
      await js(`document.getElementById('bkPick').click()`); await wait(1200);
      await js(`document.querySelector('#bkForm [type=submit]').click()`); await wait(1800);
      R.importModal = await txt('.modal .dialog');
      await shot('d1-import');
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      // groceries limit low enough to trip; add a bill so a limit + rise + unusual all show
      await more('bCats');
      await js(`(() => { const tr = [...document.querySelectorAll('#bcForm tbody tr')].find(r => r.querySelector('[data-k=name]').value === 'Groceries'); tr.querySelector('[data-k=limit]').value = '60'; })()`);
      await js(`document.querySelector('#bcForm [type=submit]').click()`); await wait(800);
      // put Tesco in Groceries (all of them, by rule)
      await tab('tx'); await js(`(() => { const b = document.getElementById('bAll'); b.checked = true; b.dispatchEvent(new Event('change')); })()`); await wait(500);
      await js(`(() => { const sel = [...document.querySelectorAll('[data-btxcat]')].find(s => s.closest('tr').innerText.includes('TESCO')); sel.value = [...sel.options].find(o => o.text === 'Groceries').value; sel.dispatchEvent(new Event('change')); })()`); await wait(900);
      await js(`document.querySelector('[data-action=bAskYes]').click()`); await wait(900);
      // split the newest Tesco: £20 groceries, rest household
      await js(`[...document.querySelectorAll('[data-action=bSplit]')].find(b => b.closest('tr').innerText.includes('TESCO')).click()`); await wait(500);
      R.splitTotal = await txt('#spForm .db p');
      await js(`(() => { const f = document.getElementById('spForm'); const amt = f.querySelector('[data-sp="0"][data-k=amt]'); const tot = Number(amt.value); amt.value = '20.00';
        const c1 = f.querySelector('[data-sp="1"][data-k=cat]'); c1.value = [...c1.options].find(o => o.text === 'Home').value; f.querySelector('[data-sp="1"][data-k=amt]').value = (tot - 20).toFixed(2); f.dispatchEvent(new Event('input')); })()`);
      R.splitLeft = await txt('#spLeft');
      await shot('d2-split');
      await js(`document.querySelector('#spForm [type=submit]').click()`); await wait(900);
      R.splitRow = await js(`[...document.querySelectorAll('.btx tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ')).find(t => /Split: 2 parts/.test(t)) || ''`);
      await tab('overview');
      R.alerts = await txt('#bAlerts');
      await shot('d3-alerts');
      // charts on the Plan, and the table view
      await tab('plan');
      R.charts = await js(`[...document.querySelectorAll('.viz .vtitle')].map(x => x.innerText)`);
      R.legend = await js(`[...document.querySelectorAll('.vlegend')].map(x => x.innerText.replace(/\\s+/g, ' '))`);
      // hover a column and read the tooltip
      await js(`(() => { const h = document.querySelector('.viz .vhit'); h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`); await wait(200);
      R.tooltip = await js(`(document.querySelector('.vtip') || {}).innerText || ''`);
      await shot('d4-charts');
      await js(`document.querySelector('[data-action=bCatTable]').click()`); await wait(500);
      R.catTable = await js(`!!document.querySelector('.card table.list.small')`);
      // one spending-money total
      await more('bSettings');
      await js(`(() => { const el = document.getElementById('bsForm').elements; el.style.value = 'flex'; el.flexLimit.value = '300'; })()`);
      await js(`document.querySelector('#bsForm [type=submit]').click()`); await wait(900);
      await tab('plan');
      R.flexPlan = await js(`[...document.querySelectorAll('#view table.list')[0].querySelectorAll('tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('d5-flexplan');
      await tab('overview');
      R.flexMeter = await js(`[...document.querySelectorAll('#view .card')].map(c => c.innerText.replace(/\\s+/g, ' ')).find(t => t.startsWith('Everyday spending')) || ''`);
      // net worth and debts
      await tab('worth');
      await js(`document.querySelector('[data-action=bOtherNew]').click()`); await wait(400);
      await js(`(() => { const el = document.getElementById('othForm').elements; el.name.value = 'Armed Forces Pension'; el.kind.value = 'pension'; el.value.value = '25000'; })()`);
      await js(`document.querySelector('#othForm [type=submit]').click()`); await wait(800);
      await js(`document.querySelector('[data-action=bDebtNew]').click()`); await wait(400);
      await js(`(() => { const el = document.getElementById('debtForm').elements; el.name.value = 'Barclaycard'; el.kind.value = 'card'; el.balance.value = '1000'; el.apr.value = '24'; el.minimum.value = '100'; })()`);
      await js(`document.querySelector('#debtForm [type=submit]').click()`); await wait(800);
      R.worthTiles = await txt('.bstats');
      R.debtRow = await js(`document.querySelector('[data-action=bDebtEdit]').innerText.replace(/\\s+/g, ' ')`);
      await js(`(() => { const el = document.getElementById('dpForm').elements; el.extra.value = '50'; })()`);
      await js(`document.querySelector('#dpForm [type=submit]').click()`); await wait(800);
      R.debtRowExtra = await js(`document.querySelector('[data-action=bDebtEdit]').innerText.replace(/\\s+/g, ' ')`);
      R.worthRows = await js(`[...document.querySelectorAll('#view table.list')[0].querySelectorAll('tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await shot('d6-worth');
      // forecast chart
      await tab('calendar');
      R.forecastChart = await js(`!!document.querySelector('.viz .vline')`);
      await shot('d7-forecast');
      const st = new Store(dir); st.load();
      R.netWorthHistory = st.data.budget.netWorth.length;
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
      console.log(JSON.stringify(R, null, 2));
    } catch (err) { console.error('E2E FAILED:', err); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(Object.assign(R, { error: String(err) }), null, 2)); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  });
});
