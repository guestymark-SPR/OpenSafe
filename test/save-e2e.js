'use strict';
// Ways to save through the window: findings from a statement (small spending, a fee, a double charge, bills to
// review), cancelling a subscription counts the saving, noting a saving, a goal from what you'd save.
// Run: xvfb-run -a npx electron --no-sandbox test/save-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/save-e2e';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ossave-'));
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
  for (const dd of [2, 6, 9, 13, 16, 20, 23, 27]) add(dd, 'Costa Coffee', 'COSTA', 'CONTACTLESS', -3.45);
  if (k === 1) { add(18, 'Starling', 'OVERDRAFT FEE', 'CHARGE', -5); add(19, 'Currys', 'CURRYS', 'CARD', -249.99); add(20, 'Currys', 'CURRYS', 'CARD', -249.99); }
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
    const tab = (t) => js(`[...document.querySelectorAll('[data-action=bTab]')].find(x => x.dataset.t === '${t}').click()`).then(() => wait(600));
    const sect = (title) => js(`(() => { const t = [...document.querySelectorAll('.section-title')].find(x => x.textContent.includes(${JSON.stringify(title)})); if (!t) return ''; let n = t.nextElementSibling; while (n && !n.classList.contains('card')) n = n.nextElementSibling; return n ? n.innerText.replace(/\\s+/g, ' ') : ''; })()`);
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`window.confirm = () => true; 1`);
      await js(`document.querySelector('[data-nav=budget]').click()`); await wait(600);
      await tab('save'); R.empty = await js(`document.querySelector('#view .card h2').innerText`);
      await js(`document.querySelector('[data-action=bImport]').click()`); await wait(700);
      await js(`(() => { const s = document.getElementById('bkBank'); s.value = 'starling'; s.dispatchEvent(new Event('change')); })()`);
      await js(`document.getElementById('bkPick').click()`); await wait(1200);
      await js(`document.querySelector('#bkForm [type=submit]').click()`); await wait(1800);
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      // add the found regular payments so there are bills to review, and make Netflix a subscription
      await tab('regular');
      await js(`document.querySelector('[data-action=bFoundAdd]').click()`); await wait(1200);
      await js(`[...document.querySelectorAll('[data-action=bRegEdit]')].find(r => r.innerText.includes('Netflix')).click()`); await wait(500);
      await js(`document.querySelector('#regForm [name=subscription]').click()`);
      await js(`document.querySelector('#regForm [type=submit]').click()`); await wait(800);
      await tab('save');
      R.tiles = await js(`document.querySelector('.bstats').innerText.replace(/\\s+/g, ' ')`);
      R.leftover = await js(`(document.querySelector('#view .note') || {}).innerText || ''`);
      R.doubles = await sect('Possible double charges');
      R.fees = await sect('Bank charges');
      R.small = await sect('Small spending');
      R.bills = await sect('Bills and subscriptions');
      await shot('e1-save');
      // cancel Netflix: counted as a saving and out of the plan
      await js(`[...document.querySelectorAll('[data-action=bReview][data-a=cancel]')].find(b => b.closest('tr').innerText.includes('Netflix')).click()`); await wait(900);
      R.madeTile = await js(`document.querySelectorAll('.bstats .tile')[1].innerText.replace(/\\s+/g, ' ')`);
      R.madeList = await sect("Savings you've made");
      // the double charge was fine
      await js(`document.querySelector('[data-action=bDismiss][data-key^="dbl:"]').click()`); await wait(800);
      R.doublesAfter = await sect('Possible double charges');
      // keep the landlord for six months
      await js(`[...document.querySelectorAll('[data-action=bReview][data-a=keep]')].find(b => b.closest('tr').innerText.includes('Landlord')).click()`); await wait(800);
      R.billsAfter = await sect('Bills and subscriptions');
      R.netflixGone = !R.billsAfter.includes('Netflix');
      // a goal from cutting back on coffee
      await js(`document.querySelector('[data-action=bCutGoal]').click()`); await wait(500);
      R.goalPrefill = await js(`(() => { const el = document.getElementById('goalForm').elements; return [el.name.value, el.target.value, el.by.value ? 'dated' : '']; })()`);
      await js(`document.querySelector('#goalForm [type=submit]').click()`); await wait(800);
      // note a saving
      await js(`document.querySelector('[data-action=bMadeNew]').click()`); await wait(400);
      await js(`(() => { const el = document.getElementById('mdForm').elements; el.name.value = 'Fixed energy deal'; el.perYear.value = '150'; })()`);
      await js(`document.querySelector('#mdForm [type=submit]').click()`); await wait(800);
      R.madeTile2 = await js(`document.querySelectorAll('.bstats .tile')[1].innerText.replace(/\\s+/g, ' ')`);
      await shot('e2-after');
      const st = new Store(dir); st.load();
      R.netflixEnds = !!st.data.budget.regular.find(r => r.name.includes('Netflix')).ends;
      R.goals = st.data.budget.goals.map(g => [g.name, g.target]);
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
      console.log(JSON.stringify(R, null, 2));
    } catch (err) { console.error('E2E FAILED:', err); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(Object.assign(R, { error: String(err) }), null, 2)); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  });
});
