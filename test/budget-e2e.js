'use strict';
// Bills & budget through the window: choose the bank from the list, import, categorise with a rule, add a bill,
// a price change on the next import, the "choose the columns" screen when the file doesn't match, and money on a case.
// Run: xvfb-run -a npx electron --no-sandbox test/budget-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/budget-e2e';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osbudget-'));
const dir = path.join(root, 'data'); fs.mkdirSync(dir);
process.env.OPENSAFE_DATA_DIR = dir;
const m = new Date().toISOString().slice(0, 7), [Y, M] = m.split('-').map(Number);
const prev = new Date(Date.UTC(Y, M - 2, 1)).toISOString().slice(0, 7);
const dmy = (ym, d) => `${String(d).padStart(2, '0')}/${ym.slice(5, 7)}/${ym.slice(0, 4)}`;
const starling = path.join(root, 'starling.csv');
fs.writeFileSync(starling, 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes\n' +
  `${dmy(prev, 1)},Opening Balance,,,,500.00,,\n` +
  `${dmy(prev, 3)},Octopus Energy,OCTOPUS 12345678,DIRECT DEBIT,-98.21,401.79,BILLS_AND_SERVICES,\n` +
  `${dmy(m, 1)},Veterans UK,AFCS PAYMENT,FASTER PAYMENT,1450.00,1851.79,INCOME,\n` +
  `${dmy(m, 2)},Tesco,TESCO STORES 3021,CONTACTLESS,-42.10,1809.69,GROCERIES,\n` +
  `${dmy(m, 3)},Octopus Energy,OCTOPUS 12345678,DIRECT DEBIT,-112.40,1697.29,BILLS_AND_SERVICES,\n` +
  `${dmy(m, 4)},Tesco,TESCO STORES 3021,CONTACTLESS,-18.65,1678.64,GROCERIES,\n` +
  `${dmy(m, 5)},Smith & Co Solicitors,CASE FEE,FASTER PAYMENT,-250.00,1428.64,GENERAL,\n`);
// a NatWest-style file, but imported with "Nationwide" chosen: it must stop and ask for the columns
const natwest = path.join(root, 'natwest.csv');
fs.writeFileSync(natwest, 'Date,Type,Description,Value,Balance,Account Name,Account Number\n' +
  `${dmy(m, 6)},POS,"COSTA COFFEE",-3.20,996.80,MR M EXAMPLE,'600000-12345678\n${dmy(m, 7)},D/D,"SKY DIGITAL",-45.00,951.80,MR M EXAMPLE,'600000-12345678\n`);
let nextFile = starling;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextFile] });
dialog.showMessageBox = async () => ({ response: 0 });
const s = new Store(dir); s.load();
const doc = s.saveLibraryEntry({ kind: 'document', title: 'Letter from Smith & Co', caseName: 'AFCS appeal', docDate: m + '-05' });
s.save();
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`window.confirm = () => true; 1`);
      await js(`document.querySelector('[data-nav=budget]').click()`); await wait(700);
      await shot('b1-empty');
      // add the energy bill first, at the old price, due before the statement
      await js(`document.querySelector('[data-action=bTab][data-t=regular]').click()`); await wait(400);
      await js(`document.querySelector('[data-action=bRegNew][data-kind=bill]').click()`); await wait(500);
      await js(`(() => { const el = document.getElementById('regForm').elements; el.name.value = 'Octopus Energy'; el.amount.value = '98.21'; el.every.value = 'month'; el.next.value = '${prev}-03';
        el.match.value = 'OCTOPUS'; el.categoryId.value = [...el.categoryId.options].find(o => o.text === 'Energy').value; })()`);
      await js(`document.querySelector('#regForm [type=submit]').click()`); await wait(800);
      // import: choose Starling from the list
      await js(`document.querySelector('[data-action=bImport]').click()`); await wait(800);
      R.banks = await js(`[...document.getElementById('bkBank').options].map(o => o.text)`);
      await js(`(() => { const s = document.getElementById('bkBank'); s.value = 'starling'; s.dispatchEvent(new Event('change')); })()`); await wait(200);
      R.how = await js(`document.getElementById('bkHow').textContent`);
      await js(`document.getElementById('bkPick').click()`); await wait(1200);
      R.preview = await js(`document.getElementById('bkOut').innerText.replace(/\\s+/g, ' ')`);
      await shot('b2-preview');
      await js(`document.querySelector('#bkForm [type=submit]').click()`); await wait(1500);
      R.imported = await js(`document.querySelector('.modal .dialog').innerText.replace(/\\s+/g, ' ')`);
      await shot('b3-imported');
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(400);
      // put the first Tesco in Groceries and say "Yes, always"
      const tescoId = await js(`(() => { const sel = [...document.querySelectorAll('[data-btxcat]')].find(s => s.closest('tr').innerText.includes('TESCO')); const o = [...sel.options].find(o => o.text === 'Groceries'); sel.value = o.value; sel.dispatchEvent(new Event('change')); return sel.dataset.btxcat; })()`);
      await wait(900);
      R.ask = await js(`(document.querySelector('[data-action=bAskYes]') || {}).closest ? document.querySelector('[data-action=bAskYes]').closest('.note').innerText.replace(/\\s+/g, ' ') : ''`);
      await shot('b4-ask');
      await js(`document.querySelector('[data-action=bAskYes]').click()`); await wait(900);
      R.tescoCats = await js(`[...document.querySelectorAll('[data-btxcat]')].filter(s => s.closest('tr').innerText.includes('TESCO')).map(s => s.options[s.selectedIndex].text)`);
      // the solicitor's fee onto the case
      await js(`(() => { const box = [...document.querySelectorAll('[data-bpick]')].find(b => b.closest('tr').innerText.includes('Smith')); box.click(); })()`); await wait(500);
      await js(`document.querySelector('[data-action=bSelCase]').click()`); await wait(500);
      await js(`(() => { const f = document.getElementById('ptForm'); f.elements.v.value = 'AFCS appeal'; f.requestSubmit(); })()`); await wait(1000);
      await shot('b5-tx');
      // overview
      await js(`document.querySelector('[data-action=bTab][data-t=overview]').click()`); await wait(600);
      R.overview = await js(`document.querySelector('.bstats').innerText.replace(/\\s+/g, ' ')`);
      R.groceriesRow = await js(`[...document.querySelectorAll('#view table.list tr')].map(r => r.innerText.replace(/\\s+/g, ' ')).filter(t => /Groceries|Energy/.test(t))`);
      await shot('b6-overview');
      // the bill: price change from the statement, next date moved on
      await js(`document.querySelector('[data-action=bTab][data-t=regular]').click()`); await wait(500);
      R.billRow = await js(`document.querySelector('[data-action=bRegEdit]').innerText.replace(/\\s+/g, ' ')`);
      await shot('b7-bills');
      await js(`document.querySelector('[data-action=bTab][data-t=calendar]').click()`); await wait(500);
      R.calendar = await js(`document.querySelector('#view table.list tbody').innerText.replace(/\\s+/g, ' ')`);
      // wrong bank: NatWest file with Nationwide chosen
      nextFile = natwest;
      await js(`document.querySelector('[data-action=bImport]').click()`); await wait(800);
      await js(`(() => { const s = document.getElementById('bkBank'); s.value = 'nationwide'; s.dispatchEvent(new Event('change')); })()`);
      await js(`document.getElementById('bkPick').click()`); await wait(1200);
      R.mismatch = await js(`document.querySelector('#bkOut .note').innerText`);
      R.importDisabled = await js(`document.getElementById('bkGo').disabled`);
      R.sampleHasAccount = await js(`document.getElementById('bkOut').innerText.includes('12345678') || document.getElementById('bkOut').innerText.includes('MR M EXAMPLE')`);
      R.guessed = await js(`Object.fromEntries([...document.querySelectorAll('[data-map]')].filter(s => s.offsetParent).map(s => [s.dataset.map, s.options[s.selectedIndex].text]))`);
      await shot('b8-columns');
      await js(`document.getElementById('bkApply').click()`); await wait(900);
      R.afterMap = await js(`document.getElementById('bkOut').innerText.replace(/\\s+/g, ' ').slice(0, 200)`);
      await js(`document.querySelector('#bkForm [type=submit]').click()`); await wait(1500);
      await js(`document.querySelector('.modal [data-action=close]').click()`); await wait(300);
      const st = new Store(dir); st.load();
      R.savedMap = st.data.budget.maps.nationwide;
      R.count = st.data.budget.transactions.length;
      R.rules = st.data.budget.rules;
      R.noAccountNumbers = !JSON.stringify(st.data).includes('12345678') && !JSON.stringify(st.data).includes('MR M EXAMPLE');
      // case page
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      await js(`(() => { const p = document.querySelector('[data-action=libCaseOpen][data-case="AFCS appeal"]'); p.click(); })()`); await wait(900);
      R.caseMoney = await js(`(document.getElementById('caseMoney') || {}).innerText`);
      await shot('b9-case');
      // ---- savings goal and plan
      await js(`document.querySelector('[data-nav=budget]').click()`); await wait(500);
      await js(`(() => { const b = [...document.querySelectorAll('[data-action=bTab]')].find(x => x.dataset.t === 'goals'); b.click(); })()`); await wait(400);
      await js(`document.querySelector('[data-action=bGoalNew]').click()`); await wait(400);
      const by = new Date(Date.UTC(Y, M - 1 + 11, 15)).toISOString().slice(0, 10); // 12 months counting this one
      await js(`(() => { const el = document.getElementById('goalForm').elements; el.name.value = 'Boat deposit'; el.target.value = '6000'; el.by.value = '${by}'; el.start.value = '1200'; })()`);
      await js(`document.querySelector('#goalForm [type=submit]').click()`); await wait(800);
      await js(`document.querySelector('[data-action=bGoalMoney]').click()`); await wait(400);
      await js(`(() => { const el = document.getElementById('gmForm').elements; el.amount.value = '400'; el.note.value = 'From the AFCS payment'; })()`);
      await js(`document.querySelector('#gmForm [type=submit]').click()`); await wait(800);
      R.goal = await js(`document.querySelector('.goal').innerText.replace(/\\s+/g, ' ')`);
      await shot('b10-goal');
      // add income so the plan has something to plan
      await js(`(() => { const b = [...document.querySelectorAll('[data-action=bTab]')].find(x => x.dataset.t === 'regular'); b.click(); })()`); await wait(400);
      await js(`document.querySelector('[data-action=bRegNew][data-kind=income]').click()`); await wait(400);
      await js(`(() => { const el = document.getElementById('regForm').elements; el.name.value = 'AFCS payment'; el.amount.value = '1450'; el.every.value = 'month'; el.next.value = '${dmy(m, 1).split('/').reverse().join('-')}'; el.match.value = 'AFCS'; })()`);
      await js(`document.querySelector('#regForm [type=submit]').click()`); await wait(800);
      // a groceries limit
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(200);
      await js(`document.querySelector('#view .head [data-action=bCats]').click()`); await wait(500);
      await js(`(() => { const tr = [...document.querySelectorAll('#bcForm tbody tr')].find(r => r.querySelector('[data-k=name]').value === 'Groceries'); tr.querySelector('[data-k=limit]').value = '250'; })()`);
      await js(`document.querySelector('#bcForm [type=submit]').click()`); await wait(800);
      await js(`(() => { const b = [...document.querySelectorAll('[data-action=bTab]')].find(x => x.dataset.t === 'plan'); b.click(); })()`); await wait(600);
      R.planTiles = await js(`document.querySelector('.bstats').innerText.replace(/\\s+/g, ' ')`);
      R.planRows = await js(`[...document.querySelectorAll('#view table.list')[0].querySelectorAll('tr')].map(r => r.innerText.replace(/\\s+/g, ' '))`);
      R.byMonth = await js(`document.querySelectorAll('#view table.list')[1] ? document.querySelectorAll('#view table.list')[1].innerText.replace(/\\s+/g, ' ') : ''`);
      await shot('b11-plan');
      // take back the last import
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(200);
      await js(`document.querySelector('#view .head [data-action=bImports]').click()`); await wait(500);
      await js(`document.querySelector('[data-action=bUndo]').click()`); await wait(900);
      const st2 = new Store(dir); st2.load();
      R.afterUndo = st2.data.budget.transactions.length;
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
      console.log(JSON.stringify(R, null, 2));
    } catch (err) { console.error('E2E FAILED:', err); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(Object.assign(R, { error: String(err) }), null, 2)); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  });
});
