'use strict';
// Help and what's new: the update banner, the page, ticking checks with notes, copying the results.
// Run: xvfb-run -a npx electron --no-sandbox test/help-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, clipboard, shell } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/help-e2e';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshelp-'));
process.env.OPENSAFE_DATA_DIR = dir;
let opened = '';
shell.openExternal = async (u) => { opened = u; };
const s = new Store(dir); s.load(); s.saveAsset({ name: 'Drill' });
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
      R.firstRunBanner = await js(`!!document.querySelector('.newsbar')`); // first run: nothing to announce
      await js(`localStorage.setItem('seenVersion', JSON.stringify('2.8.0')); document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`document.querySelector('[data-nav=dashboard]').click()`); await wait(500);
      R.banner = await js(`(document.querySelector('.newsbar') || {}).innerText`);
      await shot('h1-banner');
      await js(`document.querySelector('[data-action=newsOpen]').click()`); await wait(600);
      R.page = await js(`document.querySelector('.head h1').innerText`);
      R.news = await js(`[...document.querySelectorAll('.news .nv')].map(n => n.innerText.replace(/\\s+/g, ' ').trim())`);
      R.checks = await js(`document.querySelectorAll('.checkrow').length`);
      await js(`document.querySelectorAll('.checkrow input[type=checkbox]')[0].click()`); await wait(300);
      await js(`document.querySelectorAll('.checkrow input[type=checkbox]')[1].click()`); await wait(300);
      await js(`{ const n = document.querySelectorAll('.checknote')[2]; n.value = 'Subject filled in but no date'; n.dispatchEvent(new Event('input', { bubbles: true })); }`); await wait(200);
      R.dbg = await js(`[localStorage.getItem('checks'), document.querySelectorAll('.checkrow input[type=checkbox]')[0].outerHTML]`);
      R.count = await js(`document.querySelector('.checkcount').innerText`);
      await js(`document.querySelector('[data-action=checksCopy]').click()`); await wait(600);
      R.copied = await clipboard.readText();
      await js(`document.querySelector('[data-action=helpGuide]').click()`); await wait(400);
      R.guide = opened;
      // ticks and notes survive leaving the page
      await js(`document.querySelector('[data-nav=items]').click()`); await wait(300);
      await js(`document.querySelector('[data-nav=help]').click()`); await wait(500);
      R.kept = await js(`[document.querySelector('.checkcount').innerText, document.querySelectorAll('.checknote')[2].value]`);
      R.bannerGone = await js(`document.querySelector('[data-nav=dashboard]').click(), new Promise(r => setTimeout(() => r(!document.querySelector('.newsbar')), 400))`);
      await js(`document.querySelector('[data-nav=help]').click()`); await wait(500);
      await shot('h2-help');
      await js(`document.querySelector('.checks').scrollIntoView()`); await shot('h3-checks');
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
