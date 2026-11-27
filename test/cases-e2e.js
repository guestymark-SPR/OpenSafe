'use strict';
// Cases, sent letters and chasers, sender/tag filters and the duplicate warning, through the window.
// Run: xvfb-run -a npx electron --no-sandbox test/cases-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/cases-e2e';
fs.mkdirSync(OUT, { recursive: true });
const F = path.join(__dirname, 'fixtures', 'library');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscases-'));
process.env.OPENSAFE_DATA_DIR = dir;
const asked = [];
let dupAnswer = 0;
dialog.showMessageBox = async (_w, o) => { asked.push(o.message + ' | ' + (o.detail || '')); return { response: /already in OpenSafe/.test(o.message) ? dupAnswer : 0 }; };
const pick = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: pick.splice(0) });

const s = new Store(dir); s.load();
const add = (o, file) => { const e = s.saveLibraryEntry(Object.assign({ kind: 'document' }, o)); if (file) s.addLibraryFile(e.id, path.basename(file), fs.readFileSync(path.join(F, file))); return e; };
add({ title: 'CMS decision', from: 'Child Maintenance Service', docDate: '2026-02-01', ref: '12345 678', tags: ['cms'] }, 'text.pdf');
add({ title: 'Award letter', from: 'Veterans UK', docDate: '2026-08-14', ref: 'AFCS/2026/88123', tags: ['afcs'] }, 'statement.pdf');
add({ title: 'Mandatory reconsideration', from: 'Child Maintenance Service', docDate: '2026-03-01', tags: ['cms'] });
add({ title: 'Council tax', from: 'Sandwell Council', docDate: '2026-04-01' });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const rows = () => js(`[...document.querySelectorAll('#libList tbody tr')].map(r => r.querySelector('td:nth-child(3) b').innerText)`);
    const R = {};
    const openRow = async (t) => { await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes(${JSON.stringify(t)})).click()`); await wait(700); };
    const editDetails = async (fn) => { await js(`document.querySelector('[data-action=libEdit]').click()`); await wait(400); await js(`{ const f = document.getElementById('libForm'); (${fn})(f); f.requestSubmit(); }`); await wait(900); };
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(600);
      // 45: filter by sender and by tag
      R.chips = await js(`[...document.querySelectorAll('.libbar .chip')].map(c => c.innerText.trim())`);
      await js(`[...document.querySelectorAll('.libbar .chip')].find(c => c.innerText.startsWith('From')).click()`); await wait(200);
      await js(`[...document.querySelectorAll('.libbar .menu [data-f=from]')].find(b => b.innerText.includes('Child Maintenance')).click()`); await wait(400);
      R.fromCMS = await rows();
      await js(`document.querySelector('.libbar .chip.on .x').click()`); await wait(400);
      await js(`[...document.querySelectorAll('.libbar .chip')].find(c => c.innerText.startsWith('Tag')).click()`); await wait(200);
      await js(`[...document.querySelectorAll('.libbar .menu [data-f=tag]')].find(b => b.innerText === 'afcs').click()`); await wait(400);
      R.tagAfcs = await rows();
      await js(`document.querySelector('.libbar .chip.on .x').click()`); await wait(400);
      // 41: tick two CMS letters → Put in a case…
      for (const t of ['CMS decision', 'Mandatory reconsideration']) { await js(`[...document.querySelectorAll('#libList tbody tr')].find(r => r.innerText.includes(${JSON.stringify(t)})).querySelector('input[type=checkbox]').click()`); await wait(250); }
      await js(`[...document.querySelectorAll('.selbar .menuwrap > button')][0].click()`); await wait(300);
      await js(`document.querySelector('.selbar .menu [data-action=libCaseSet]').click()`); await wait(400);
      await js(`{ const f = document.getElementById('ptForm'); f.elements.v.value = 'CMS recalculation'; f.requestSubmit(); }`); await wait(900);
      // 42: mark the reconsideration as sent by me, expecting a reply 28 days after its date
      await openRow('Mandatory reconsideration');
      await editDetails(`(f) => { f.elements.sent.click(); f.querySelector('[data-days="28"]').click(); }`);
      R.expectBy = await js(`window.keep.libGet([...document.querySelectorAll('.libhead')].length ? (document.querySelector('[data-action=libEdit]') && '${''}') : '').catch(() => null)`).catch(() => null);
      R.docHead = await js(`document.querySelector('.libhead').innerText.replace(/\\s+/g, ' ')`);
      await shot('c1-sent-letter');
      // the case page: timeline with sent and received
      await js(`document.querySelector('.libhead [data-action=libCaseOpen]').click()`); await wait(700);
      R.casePage = await js(`({ h1: document.querySelector('.head h1').innerText, items: [...document.querySelectorAll('.titem')].map(t => (t.classList.contains('sent') ? 'SENT ' : 'RECV ') + t.querySelector('b + b, .tcard > div:nth-child(2) b').innerText), pills: [...document.querySelectorAll('.titem .pill')].map(p => p.innerText) })`);
      await shot('c2-case-timeline');
      // add another letter to the case from the case page (their reply)
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(300);
      await js(`document.querySelector('#view .head .menu [data-action=libCaseAdd]').click()`); await wait(400);
      await js(`[...document.querySelectorAll('.cprow')].find(r => r.innerText.includes('Council tax')).querySelector('input').click(); document.getElementById('cpForm').requestSubmit()`); await wait(900);
      R.caseAfterAdd = await js(`[...document.querySelectorAll('.titem')].length`);
      // the council letter is dated after the reconsideration, so it counts as the reply
      R.replied = await js(`[...document.querySelectorAll('.titem.sent .pill')].map(p => p.innerText)`);
      // Documents: the Cases view
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      await js(`document.querySelector('[data-action=libMode][data-v=cases]').click()`); await wait(500);
      R.cases = await js(`[...document.querySelectorAll('.casecard')].map(c => c.innerText.replace(/\\s+/g, ' '))`);
      await shot('c3-cases');
      await js(`document.querySelector('[data-action=libMode][data-v=list]').click()`); await wait(400);
      await shot('c4-list');
      // reminders: a sent letter with no reply after the date
      await openRow('Award letter');
      await editDetails(`(f) => { f.elements.sent.click(); f.elements.expectBy.value = '2026-09-01'; f.elements.caseName.value = 'AFCS claim'; }`);
      await js(`document.querySelector('[data-nav=reminders]').click()`); await wait(600);
      R.reminders = await js(`document.getElementById('view').innerText.match(/No reply yet[^\\n]*|Award letter[^\\n]*/g)`);
      await shot('c5-reminders');
      // 46: adding the same file again
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      pick.push(path.join(F, 'text.pdf'));
      await js(`document.querySelector('[data-action=libAdd]').click()`); await wait(1500);
      R.dupAsked = asked.filter(a => /already in OpenSafe/.test(a));
      R.toast = await js(`(document.querySelector('.toast') || {}).innerText`);
      R.countAfterSkip = await js(`document.querySelectorAll('#libList tbody tr').length`);
      dupAnswer = 1; pick.push(path.join(F, 'text.pdf'));
      await js(`document.querySelector('[data-action=libAdd]').click()`); await wait(1500);
      await js(`document.querySelector('[data-action=close]') && document.querySelector('[data-action=close]').click()`); await wait(300);
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      R.countAfterAnyway = await js(`document.querySelectorAll('#libList tbody tr').length`);
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
