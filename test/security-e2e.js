'use strict';
// Drives the real app through password protection and the vault, with screenshots.
// Run: xvfb-run -a npx electron --no-sandbox test/security-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv[process.argv.length - 1].startsWith('/') ? process.argv[process.argv.length - 1] : '/tmp/okshots/sec';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ossece2e-'));
process.env.OPENSAFE_DATA_DIR = dir;

const PHOTO_DIR = '/tmp/okshots/photos';
const s = new Store(dir); s.load();
const passport = s.saveAsset({ name: 'Passport scan holder', category: 'Other', currentValue: 85 });
s.addPhoto(passport.id, 'p0.jpg', fs.readFileSync(path.join(PHOTO_DIR, 'p0.jpg')));
const car = s.saveAsset({ name: 'Mercedes estate', category: 'Vehicles', currentValue: 14500 });
s.addPhoto(car.id, 'p1.jpg', fs.readFileSync(path.join(PHOTO_DIR, 'p1.jpg')));
s.addDocument(car.id, 'V5C logbook.pdf', Buffer.from('%PDF-1.4 logbook'), 'Other');
s.addDocument(car.id, 'Insurance schedule.pdf', Buffer.from('%PDF-1.4 schedule'), 'Insurance');
s.saveAsset({ name: 'Garden bench', category: 'Furniture', currentValue: 120 });

require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function filesContaining(needle) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.readFileSync(p).includes(Buffer.from(needle))) out.push(path.relative(dir, p)); } };
  walk(dir); return out;
}

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ${sel.replace(/'/g, '')}'); el.click(); return true; })()`);
    const fill = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; return true; })()`);
    const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
    const R = { steps: [] };
    const step = (n, v) => R.steps.push([n, v]);
    try {
      win.setSize(1320, 860);
      await wait(1500);
      // 1. Turn on protection
      await click('[data-nav=settings]'); await wait(300);
      await shot('s1-settings-off');
      await click('[data-action=secEnable]'); await wait(200);
      await fill('#secForm [name=pw]', 'short'); await fill('#secForm [name=pw2]', 'short');
      await click('#secForm button[type=submit]'); await wait(400);
      step('weak password error', await text('#secErr'));
      await fill('#secForm [name=pw]', 'my test password'); await fill('#secForm [name=pw2]', 'my test password');
      await click('#secForm button[type=submit]');
      for (let i = 0; i < 40 && !(await js(`!!document.querySelector('.rk')`)); i++) await wait(250);
      const rk = (await text('.rk')).trim();
      step('recovery key shown', rk);
      step('Done disabled until ticked', await js(`document.getElementById('rkDone').disabled`));
      await shot('s2-recovery-key');
      await js(`document.getElementById('modal').click()`); await wait(200);
      step('backdrop click keeps key dialog', await js(`!!document.querySelector('.rk')`));
      await js(`const c = document.getElementById('rkOk'); c.checked = true; c.dispatchEvent(new Event('change'))`);
      await click('#rkDone'); await wait(600);
      await shot('s3-settings-on');
      step('names on disk after encrypt', filesContaining('Mercedes estate'));
      step('pdf text on disk after encrypt', filesContaining('logbook'));
      step('photos still visible', await js(`(async () => { document.querySelector('[data-nav=items]').click(); await new Promise(r => setTimeout(r, 300)); document.querySelector('[data-layout=grid]').click(); await new Promise(r => setTimeout(r, 1200)); return [...document.querySelectorAll('.icard img')].map(i => i.naturalWidth > 0); })()`));
      await shot('s4-items-encrypted');

      // 2. Vault set up
      await click('[data-nav=settings]'); await wait(300);
      await click('[data-action=vaultSetup]'); await wait(200);
      await fill('#secForm [name=pin]', '2468'); await fill('#secForm [name=pin2]', '2468');
      await click('#secForm button[type=submit]');
      await wait(2500);
      step('vault view after setup', (await text('#view')).slice(0, 120));
      // move passport item into vault
      await js(`(() => { document.querySelector('[data-nav=items]').click(); })()`); await wait(300);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Passport')).click()`); await wait(400);
      await click('[data-action=vaultIn]'); await wait(800);
      await shot('s5-item-in-vault');
      // move the V5C document into the vault
      await click('[data-action=back]'); await wait(300);
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Mercedes')).click()`); await wait(300);
      await click('[data-tab=docs]'); await wait(300);
      await js(`[...document.querySelectorAll('[data-action=fileVaultIn]')][0].click()`); await wait(900);
      await shot('s6-doc-in-vault');
      await click('[data-nav=vault]'); await wait(400);
      await shot('s7-vault-open');
      step('vault lists', await text('#view'));
      step('vault key on disk for pdf', filesContaining('V5C logbook'));
      // lock vault
      await click('[data-action=vaultLock]'); await wait(600);
      await shot('s8-vault-locked');
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(400);
      step('items while vault locked', await js(`[...document.querySelectorAll('.icard .name, tr[data-open] .name')].map(e => e.innerText)`));
      await js(`[...document.querySelectorAll('[data-open]')].find(e => e.innerText.includes('Mercedes')).click()`); await wait(300);
      await click('[data-tab=docs]'); await wait(300);
      step('docs while vault locked', await text('table.list'));
      await shot('s9-doc-locked');
      // wrong PIN then right PIN
      await click('[data-nav=vault]'); await wait(300);
      await fill('#vaultForm [name=pin]', '1111'); await click('#vaultForm button[type=submit]'); await wait(1500);
      step('wrong pin message', await text('#vaultErr'));
      await fill('#vaultForm [name=pin]', '2468'); await click('#vaultForm button[type=submit]'); await wait(1500);
      step('vault after right pin', (await text('#view')).includes('Passport scan holder'));

      // 3. Lock the app
      await click('#lockBtn'); await wait(800);
      await shot('s10-locked');
      step('lock screen shown', await js(`!document.getElementById('lockscreen').classList.contains('hidden')`));
      await fill('#unlockForm [name=pw]', 'wrong password'); await click('#unlockForm button[type=submit]'); await wait(1800);
      step('wrong password message', await text('#lockErr'));
      // forgotten password with the recovery key
      await click('[data-action=lockForgot]'); await wait(200);
      await shot('s11-recover');
      await fill('#recoverForm [name=rk]', rk.toLowerCase()); await fill('#recoverForm [name=pw]', 'brand new password'); await fill('#recoverForm [name=pw2]', 'brand new password');
      await click('#recoverForm button[type=submit]'); await wait(3000);
      step('unlocked via recovery', await js(`document.getElementById('lockscreen').classList.contains('hidden')`));
      step('vault locked after app lock', await text('#vaultState'));
      await click('[data-nav=dashboard]'); await wait(500);
      await shot('s12-dashboard-after-recover');
      step('dashboard total (vault locked)', (await text('#view')).match(/£[\d,]+/)?.[0]);
      // new password works from cold
      const s2 = new Store(dir);
      await s2.unlock('brand new password');
      step('cold unlock item count', s2.data.assets.length);
    } catch (e) {
      R.fatal = e.stack;
    }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
