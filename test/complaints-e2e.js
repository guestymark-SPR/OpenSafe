'use strict';
// Complaint ladder and subject access request, through the window.
// Run: xvfb-run -a npx electron --no-sandbox test/complaints-e2e.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { Store } = require('../src/store');

const OUT = process.argv.slice(2).find(a => a.startsWith('/')) || '/tmp/okshots/complaints-e2e';
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscompe2e-'));
process.env.OPENSAFE_DATA_DIR = dir;
dialog.showMessageBox = async () => ({ response: 0 });

const s = new Store(dir); s.load();
s.saveLibraryEntry({ kind: 'document', title: 'Calculation decision', from: 'Child Maintenance Service', docDate: '2026-02-01', caseName: 'CMS recalculation' });
require('../src/main.js');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch(e => { throw new Error('Step failed: ' + code.slice(0, 160) + ' :: ' + e.message); });
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const ladder = () => js(`[...document.querySelectorAll('.complaint')].map(c => ({ head: c.querySelector('.ch').innerText.replace(/\\s+/g, ' '), steps: [...c.querySelectorAll('.ladder li')].map(l => l.className.trim() + ' | ' + l.innerText.replace(/\\s+/g, ' ').slice(0, 220)) }))`);
    const R = {};
    try {
      win.setSize(1320, 900); await wait(1500);
      await js(`document.querySelector('[data-nav=docs]').click()`); await wait(500);
      await js(`document.querySelector('[data-action=libMode][data-v=cases]').click()`); await wait(400);
      await js(`document.querySelector('.casecard').click()`); await wait(600);
      // ---- 64: start a complaint about the CMS
      await js(`document.querySelector('#view .head [data-action=moreMenu]').click()`); await wait(300);
      await js(`document.querySelector('#view .head .menu [data-action=libComplaintNew]').click()`); await wait(800);
      R.types = await js(`[...document.querySelectorAll('#cpfForm select[name=type] option')].map(o => o.textContent)`);
      await js(`(() => { const el = document.getElementById('cpfForm').elements; el.type.value = 'dwp'; el.type.dispatchEvent(new Event('change')); el.title.value = 'Wrong income used'; el.org.value = 'Child Maintenance Service'; el.awareOn.value = '2026-02-01'; el.startedOn.value = '2026-06-01'; document.getElementById('cpfForm').requestSubmit(); })()`);
      await wait(1000);
      R.l1 = await ladder();
      // their final response arrives
      await js(`document.querySelector('[data-action=libComplaintReply]').click()`); await wait(400);
      await js(`(() => { const f = document.getElementById('csForm'); f.elements.d.value = '2026-09-10'; f.elements.note.value = 'Final response: they say the income figure is right'; f.requestSubmit(); })()`); await wait(1000);
      R.l2 = await ladder();
      await js(`document.querySelector('.complaint').scrollIntoView()`); await shot('c1-ladder');
      R.reminders = await js(`window.keep.getData().then(d => d.reminders.filter(r => r.complaintId).map(r => r.kind + ' ' + r.date))`);
      // ---- 63: subject access request from + New
      await js(`document.querySelector('#addBtn').click()`); await wait(300);
      await js(`document.querySelector('.newmenu [data-action=libSarNew]').click()`); await wait(800);
      await js(`(() => { const f = document.getElementById('ptForm'); f.elements.v.value = 'Child Maintenance Service'; f.requestSubmit(); })()`); await wait(1200);
      R.sarForm = await js(`(() => { const el = document.getElementById('letterForm').elements; return { title: document.querySelector('#letterForm h2').innerText, subject: el.subject.value, body: el.body.value.slice(0, 160), expectHidden: el.expect.closest('label').style.display === 'none' }; })()`);
      await js(`(() => { const el = document.getElementById('letterForm').elements; el.fromName.value = 'Mark Example'; el.fromAddress.value = '1 High Street\\nSheldon'; el.toAddress.value = 'PO Box 249\\nMitcheldean\\nGL14 9AJ'; document.getElementById('letterForm').requestSubmit(); })()`);
      await wait(4000);
      R.sarEntry = await js(`window.keep.getData().then(d => d.data.library.filter(e => e.title === 'Subject access request').map(e => ({ sent: e.sent, expectBy: e.expectBy, caseName: e.caseName, files: e.files.map(f => f.name) })))`);
      R.sarComplaint = await js(`window.keep.getData().then(d => d.data.complaints.filter(c => c.type === 'sar').map(c => ({ caseName: c.caseName, steps: c.steps, action: d.data.complaintInfo[c.id].action })))`);
      await js(`document.querySelector('.libhead [data-action=libCaseOpen]').click()`); await wait(800);
      R.sarLadder = await ladder();
      await shot('c2-sar-case');
      R.today = today;
    } catch (e) { R.fatal = e.stack; }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    app.exit(0);
  });
});
