'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, Notification, Menu, Tray, clipboard, nativeTheme, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Store, STATUSES, CONDITIONS, DOC_TYPES, POLICY_TYPES, LIBRARY_DOC_TYPES } = require('./store');
const { PhoneServer } = require('./phoneServer');
const { buildReportHtml } = require('./report');
const { buildClaimPack } = require('./claim');
const ocr = require('./ocr');
const phoneview = require('./phoneview');
const { buildLabelsHtml, buildPlaceLabelsHtml } = require('./labels');
const csv = require('./csv');
const recalls = require('./recalls');
const { buildListing } = require('./listing');
const { buildGrabListHtml } = require('./grablist');
const updater = require('./updater');
const firewall = require('./firewall');

app.setName('OpenSafe');
// UK date and number formats everywhere (date pickers, spellcheck)
app.commandLine.appendSwitch('lang', 'en-GB');
if (process.platform === 'win32') app.setAppUserModelId('com.guestymark.opensafe');

// Optional override for testing: OPENSAFE_DATA_DIR
const DATA_DIR = process.env.OPENSAFE_DATA_DIR || path.join(app.getPath('userData'), 'data');

protocol.registerSchemesAsPrivileged([
  { scheme: 'keep', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

let win = null;
let store = null;
let phone = null;
let pendingImport = null; // a .opensafe file opened while OpenSafe was locked
const OPEN_DIR = path.join(os.tmpdir(), 'OpenSafe-open'); // decrypted copies of documents you open
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

// Small, unencrypted preferences that are needed before unlocking (the colour theme).
const PREFS = path.join(DATA_DIR, 'prefs.json');
function readPrefs() { try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')); } catch (_) { return {}; } }
function writePrefs(p) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(p, null, 2)); }
function applyTheme() { const t = readPrefs().theme; nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system'; }

// Automatic backups: checked after unlocking and every hour while OpenSafe is open.
let backupTimer = null;
// ---------- reminders while OpenSafe is closed ----------
// With "Keep reminders running" on, OpenSafe starts with Windows (hidden, with --background), waits
// by the clock, and closing the window locks it instead of quitting. While locked it can't read
// encrypted items, so it keeps only the due dates (no names) in prefs.json; without password
// protection the names are kept too, as the data file itself isn't encrypted.
const STARTED_IN_BACKGROUND = process.argv.includes('--background');
let tray = null, quitting = false, bgTimer = null, scheduleTimer = null;
const bgEnabled = () => !!readPrefs().background;
const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
function writeSchedule() {
  if (!store || store.isLocked()) return;
  const enc = store.isEncrypted();
  const entries = store.reminders(new Date(), 400).map(r => enc ? { date: r.date } : { date: r.date, label: `${r.kind}: ${r.assetName}` });
  const p = readPrefs();
  p.schedule = { updatedAt: new Date().toISOString(), named: !enc, entries };
  writePrefs(p);
}
function scheduleSoon() { clearTimeout(scheduleTimer); scheduleTimer = setTimeout(() => { try { writeSchedule(); } catch (_) {} }, 1500); }
function dueFromSchedule(today = localISO()) {
  const sch = readPrefs().schedule;
  return sch && Array.isArray(sch.entries) ? { named: !!sch.named, due: sch.entries.filter(e => dayDiff(today, e.date) <= 7 && dayDiff(today, e.date) >= -60) } : { named: false, due: [] };
}
function backgroundRemind(force) {
  if (!Notification.isSupported()) return;
  const today = localISO(), hour = new Date().getHours();
  const p = readPrefs();
  if (!force && (p.lastNotified === today || hour < 8 || hour >= 21)) return;
  if (store && !store.isLocked()) writeSchedule();
  const { named, due } = dueFromSchedule(today);
  if (!due.length) { if (force) new Notification({ title: 'OpenSafe', body: 'Nothing is due in the next 7 days.' }).show(); return; }
  const overdue = due.filter(e => e.date < today).length;
  const body = named
    ? due.slice(0, 3).map(e => `${e.label} (${e.date < today ? 'overdue' : e.date === today ? 'today' : ukShort(e.date)})`).join('\n') + (due.length > 3 ? `\n…and ${due.length - 3} more` : '')
    : `${due.length} thing${due.length === 1 ? ' is' : 's are'} due in the next 7 days${overdue ? ` (${overdue} overdue)` : ''}. Open OpenSafe to see ${due.length === 1 ? 'it' : 'them'}.`;
  const n = new Notification({ title: 'OpenSafe reminders', body });
  n.on('click', () => { showWindow(); if (win) win.webContents.once('did-finish-load', () => win.webContents.send('nav', 'reminders')); if (win && !win.webContents.isLoading()) win.webContents.send('nav', 'reminders'); });
  n.show();
  const q = readPrefs(); q.lastNotified = today; writePrefs(q);
}
const ukShort = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function showWindow() { if (win && !win.isDestroyed()) { win.show(); win.focus(); } else createWindow(); }
function ensureTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('OpenSafe');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open OpenSafe', click: showWindow },
    { label: 'Check reminders now', click: () => backgroundRemind(true) },
    { type: 'separator' },
    { label: 'Quit OpenSafe', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}
function startBackground() {
  ensureTray();
  if (!bgTimer) bgTimer = setInterval(() => backgroundRemind(false), 30 * 60 * 1000);
  setTimeout(() => backgroundRemind(false), 60 * 1000);
}
function setBackground(on) {
  const p = readPrefs(); p.background = !!on; writePrefs(p);
  if (process.platform === 'win32' || process.platform === 'darwin') app.setLoginItemSettings({ openAtLogin: !!on, args: ['--background'] });
  if (on) { writeSchedule(); startBackground(); }
  else { if (tray) { tray.destroy(); tray = null; } clearInterval(bgTimer); bgTimer = null; }
  return !!on;
}

function checkAutoBackup() {
  if (!store || store.isLocked() || !store.autoBackupDue()) return;
  const r = store.runAutoBackup();
  if (!r.ok && Notification.isSupported()) new Notification({ title: 'OpenSafe backup didn\'t run', body: r.error }).show();
  notifyChanged();
}

function cleanOpenDir() { try { fs.rmSync(OPEN_DIR, { recursive: true, force: true }); } catch (_) { /* a file may still be open in another app */ } }

function sendSecurity() {
  if (win && !win.isDestroyed()) win.webContents.send('security:changed', store.securityState());
}

/** Everything that should happen once the data is readable (at start-up, or after unlocking). */
let backfillTimer = null;
function afterUnlock() {
  // Read the dates older photos were taken (a few at a time, so the app stays responsive).
  clearInterval(backfillTimer);
  backfillTimer = setInterval(() => {
    try { if (!store || store.isLocked()) return clearInterval(backfillTimer); if (store.backfillPhotoDates(20) === 0) { clearInterval(backfillTimer); notifyChanged(); } }
    catch (_) { clearInterval(backfillTimer); }
  }, 1500);
  if (bgEnabled()) scheduleSoon();
  try { store.purgeOldBin(); } catch (_) { /* never block opening */ }
  readSoon();
  if (store.data.settings.phoneLinkEnabled && !phone.running) startPhone().catch(() => {});
  setTimeout(checkAutoBackup, 20000);
  if (!backupTimer) backupTimer = setInterval(checkAutoBackup, 60 * 60 * 1000);
  setTimeout(remindOnStartup, 1500);
  if (pendingImport) { const f = pendingImport; pendingImport = null; setTimeout(() => importFromPath(f).catch(() => {}), 500); }
}

async function lockAll() {
  store.lock();
  viewer.clear();
  if (phone) await phone.stop();
  cleanOpenDir();
  sendSecurity();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else if (app.isReady()) createWindow();
    const f = exportFileFromArgs(argv);
    if (f && store) { if (store.isLocked()) { pendingImport = f; } else importFromPath(f).catch(() => {}); }
  });
  app.whenReady().then(init);
}

function notifyChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('data:changed');
}

async function startPhone() {
  const base = store.data.settings.phonePort || 47820;
  let lastErr;
  for (let p = base; p < base + 10; p++) {
    try { await phone.start(p); return p; } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function init() {
  // Developer check that receipt reading works inside the packaged app (used by the build tests).
  if (process.env.OPENSAFE_OCR_SELFTEST) {
    let line;
    try { const t = await ocr.readText(fs.readFileSync(process.env.OPENSAFE_OCR_SELFTEST)); line = 'OCR_SELFTEST ' + JSON.stringify(ocr.parseReceipt(t)); }
    catch (e) { line = 'OCR_SELFTEST_ERROR ' + e.message; }
    console.log(line);
    if (process.env.OPENSAFE_OCR_SELFTEST_OUT) fs.writeFileSync(process.env.OPENSAFE_OCR_SELFTEST_OUT, line);
    await ocr.stop(); app.exit(0); return;
  }
  applyTheme();
  store = new Store(DATA_DIR);
  if (!store.isEncrypted()) store.load(); // with protection on, data is read after the password
  phone = new PhoneServer({ store, onChange: notifyChanged });
  cleanOpenDir();

  protocol.handle('keep', (req) => {
    // keep://file/<assetId>/<file>  (photos are decrypted in memory, never written out)
    try {
      if (store.isLocked()) return new Response('Locked', { status: 403 });
      const u = new URL(req.url);
      const [, assetId, file] = u.pathname.split('/');
      const name = decodeURIComponent(file);
      const buf = store.readAttachment(decodeURIComponent(assetId), name);
      return new Response(buf, { headers: { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
    } catch (e) {
      return new Response('Not found', { status: e.code === 'VAULT_LOCKED' ? 403 : 404 });
    }
  });

  Menu.setApplicationMenu(null);
  if (!(STARTED_IN_BACKGROUND && bgEnabled())) createWindow();
  registerIpc();
  if (bgEnabled()) startBackground();

  // Opened by double-clicking a .opensafe file
  const startFile = exportFileFromArgs(process.argv);
  if (startFile) pendingImport = startFile;
  if (!store.isLocked()) { if (win) win.webContents.once('did-finish-load', () => setTimeout(afterUnlock, 1500)); else setTimeout(afterUnlock, 1500); }

  updater.init((st) => { if (win && !win.isDestroyed()) win.webContents.send('update:status', st); });
}

const CAPTURE_URL = 'https://guestymark-spr.github.io/OpenSafe/';

function exportFileFromArgs(argv) {
  return (argv || []).slice(1).find(a => /\.opensafe(\.txt)?$/i.test(a) && fs.existsSync(a)) || null;
}

async function importFromPath(file) {
  if (store.isLocked()) { pendingImport = file; throw new Error('Unlock OpenSafe to import this file.'); }
  let res;
  try {
    const st = fs.statSync(file);
    if (st.size > 1024 * 1024 * 1024) throw new Error('The file is over 1 GB.');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { throw new Error('This file isn\'t an OpenSafe export, or it was damaged while being copied.'); }
    res = store.importCapture(parsed);
    res.docs = await importPhoneDocuments(parsed);
    readSoon();
  } catch (e) {
    if (win) dialog.showMessageBox(win, { type: 'error', title: 'Import', message: 'Couldn\'t import that file', detail: e.message });
    throw e;
  }
  notifyChanged();
  const lines = [];
  if (res.added) lines.push(`${res.added} new item${res.added === 1 ? '' : 's'} added.`);
  if (res.updated) lines.push(`${res.updated} item${res.updated === 1 ? '' : 's'} already here got new photos or details.`);
  if (res.unchanged) lines.push(`${res.unchanged} item${res.unchanged === 1 ? ' was' : 's were'} already imported, so ${res.unchanged === 1 ? 'it was' : 'they were'} skipped.`);
  if (res.added || res.updated || res.photos || res.documents) lines.push(`${res.photos} photo${res.photos === 1 ? '' : 's'} and ${res.documents} receipt${res.documents === 1 ? '' : 's'} saved.`);
  if (res.changes) lines.push('', `${res.changes} change${res.changes === 1 ? '' : 's'} from scanning labels:`, ...res.changeLines.slice(0, 15), ...(res.changeLines.length > 15 ? [`…and ${res.changeLines.length - 15} more.`] : []));
  if (res.skippedChanges.length) lines.push('', 'Changes not applied:', ...res.skippedChanges.slice(0, 10));
  if (res.docs.added) lines.push(`${res.docs.added} scanned document${res.docs.added === 1 ? '' : 's'} added to Documents.`);
  if (!lines.length) lines.push('Nothing new in this file. It was already imported.');
  res.errors.push(...res.docs.errors);
  if (res.errors.length) lines.push('', 'Not imported:', ...res.errors.slice(0, 10));
  if (win) dialog.showMessageBox(win, { type: res.errors.length ? 'warning' : 'info', title: 'Import', message: res.added ? 'Items imported from your phone' : res.docs.added ? 'Documents imported from your phone' : res.changes ? 'Changes imported from your phone' : 'Import finished', detail: lines.join('\n').replace(/^\n+/, '') });
  return res;
}

// ---------- Documents and Data ----------
const doctext = require('./doctext');
const phonedocs = require('./phonedocs');
const viewer = require('./viewer');
const LIB_MAX = 500 * 1024 * 1024; // per file
const libNote = (e) => { libChanged(); return e; };
async function libPdfPreview(buffer) {
  try { const r = await doctext.pdfFirstPage(buffer, 1000); return 'data:image/png;base64,' + r.png.toString('base64'); } catch (_) { return null; }
}
function libChanged() { if (win && !win.isDestroyed()) win.webContents.send('lib:changed'); }

// Read the text inside new files, one at a time in the background, so they can be searched.
let libReading = false;
const itemTextFailed = new Set(); // item documents that couldn't be stored (e.g. deleted while reading)
async function readLibraryText() {
  if (libReading) return;
  libReading = true;
  try {
    for (let guard = 0; guard < 5000; guard++) {
      if (!store || store.isLocked()) break;
      let next = store.libraryTextQueue()[0];
      const item = !next && store.itemDocTextQueue().find(q => !itemTextFailed.has(q.fileId));
      if (!next && !item) break;
      if (item) { // a receipt, manual or other document on an item
        let text = '';
        if (doctext.canRead(item.name)) {
          try { text = await Promise.race([doctext.extractText(item.name, store.readAttachment(item.assetId, item.file)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10 * 60 * 1000))]); }
          catch (_) { text = ''; }
        }
        if (!store || store.isLocked()) break;
        if (!store.setItemDocText(item.assetId, item.fileId, text)) itemTextFailed.add(item.fileId);
        continue;
      }
      let text = '';
      if (doctext.canRead(next.name)) {
        try {
          const { buffer } = store.readLibraryFile(next.id, next.fileId);
          text = await Promise.race([doctext.extractText(next.name, buffer), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10 * 60 * 1000))]);
        } catch (_) { text = ''; }
      }
      if (!store || store.isLocked()) break;
      store.setLibraryText(next.id, next.fileId, text);
      libChanged();
    }
  } finally { libReading = false; }
}
const readSoon = () => setTimeout(() => readLibraryText().catch(() => {}), 300);

/** Add files from disk. Documents: all the files become one document. Data: one entry per file. */
async function addLibraryPaths(kind, paths, entryId, fields) {
  const files = [], errors = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > LIB_MAX) throw new Error('over 500 MB');
      files.push({ name: path.basename(p), buf: fs.readFileSync(p) });
    } catch (e) { errors.push(`${path.basename(p)}: ${e.message}`); }
  }
  const res = await addLibraryBuffers(kind, files, entryId, fields);
  res.errors.unshift(...errors);
  return res;
}
async function addLibraryBuffers(kind, files, entryId, fields) {
  const res = { added: 0, ids: [], errors: [] };
  const detailsFor = (f) => {
    const base = { title: f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').slice(0, 200) };
    if (/\.eml$/i.test(f.name)) { try { const i = doctext.emailInfo(f.buf); return { title: i.subject || base.title, from: i.from, docDate: i.date, folder: 'Emails' }; } catch (_) { /* use the name */ } }
    if (/\.msg$/i.test(f.name)) { try { const i = doctext.msgInfo(f.buf); return { title: i.subject || base.title, from: i.from, docDate: i.date, folder: 'Emails' }; } catch (_) { /* use the name */ } }
    return base;
  };
  if (entryId) {
    for (const f of files) { try { store.addLibraryFile(entryId, f.name, f.buf); res.added++; } catch (e) { res.errors.push(e.message); } }
    if (res.added) res.ids.push(entryId);
  } else if (kind === 'document') {
    if (files.length) {
      const e = store.saveLibraryEntry(Object.assign({ kind: 'document' }, detailsFor(files[0]), { folder: '' }, fields || {}));
      for (const f of files) { try { store.addLibraryFile(e.id, f.name, f.buf); res.added++; } catch (err) { res.errors.push(err.message); } }
      if (!e.files.length) { store.deleteLibraryEntry(e.id); store.purgeLibraryEntry(e.id); } else res.ids.push(e.id);
    }
  } else {
    for (const f of files) {
      let e;
      try {
        e = store.saveLibraryEntry(Object.assign({ kind: 'data' }, detailsFor(f), fields || {}));
        store.addLibraryFile(e.id, f.name, f.buf); res.added++; res.ids.push(e.id);
      } catch (err) {
        res.errors.push(err.message);
        if (e) { try { store.deleteLibraryEntry(e.id); store.purgeLibraryEntry(e.id); } catch (_) { /* gone */ } }
      }
    }
  }
  libChanged(); readSoon();
  return res;
}

/** Scanned documents from the phone (see src/phonedocs.js). */
async function importPhoneDocuments(obj) {
  const out = await phonedocs.importPhoneDocuments(store, obj);
  if (out.added) { libChanged(); readSoon(); }
  return out;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: '#f6f5f2',
    title: 'OpenSafe',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function remindOnStartup() {
  if (!Notification.isSupported() || store.isLocked() || readPrefs().lastNotified === localISO()) return; // at most one reminder notification a day
  const due = store.reminders().filter(r => r.daysLeft <= 7);
  if (!due.length) return;
  const overdue = due.filter(r => r.daysLeft < 0).length;
  const n = new Notification({
    title: 'OpenSafe reminders',
    body: overdue
      ? `${overdue} overdue and ${due.length - overdue} due this week. Open Reminders to see them.`
      : `${due.length} warranty or service date${due.length > 1 ? 's' : ''} due this week.`
  });
  n.on('click', () => { if (win) { win.show(); win.webContents.send('nav', 'reminders'); } });
  n.show();
  const q = readPrefs(); q.lastNotified = localISO(); writePrefs(q);
}

function snapshot() {
  if (store.isLocked()) return { locked: true, security: store.securityState(), version: require('../package.json').version };
  const data = JSON.parse(JSON.stringify(Object.assign({}, store.data, { vault: undefined, assets: [], bin: [] })));
  data.bin = store.binView();
  delete data.settings.phoneToken;
  data.assets = store.viewAssets();
  delete data.docText;
  data.library = store.libraryView();
  data.libBin = store.libraryBinView();
  return {
    data,
    security: store.securityState(),
    theme: readPrefs().theme || 'system',
    summary: store.summary(),
    reminders: store.reminders(),
    lists: { statuses: STATUSES, conditions: CONDITIONS, docTypes: DOC_TYPES, policyTypes: POLICY_TYPES, libraryTypes: LIBRARY_DOC_TYPES, libraryFolders: store.libraryFolders() },
    dataDir: DATA_DIR,
    platform: process.platform,
    version: require('../package.json').version
  };
}

async function phoneStatus() {
  const s = store.data.settings;
  const urls = phone.running ? phone.urls() : [];
  const withQr = await Promise.all(urls.map(async (u) => ({
    ...u, qr: await QRCode.toDataURL(u.url, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
  })));
  return {
    enabled: s.phoneLinkEnabled,
    running: phone.running,
    port: phone.port,
    urls: withQr,
    lastSeen: phone.lastSeen ? phone.lastSeen.toISOString() : null,
    attempts: phone.attempts.slice(0, 8)
  };
}

function addFilesFromPaths(assetId, kind, docType, paths) {
  const added = [];
  const errors = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      const isVideo = /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(p);
      if (st.size > (isVideo ? 1024 : 100) * 1024 * 1024) throw new Error(isVideo ? 'Video is over 1 GB. Trim it or record it in a lower quality (1080p is plenty).' : 'File is over 100 MB');
      const buf = fs.readFileSync(p);
      const name = path.basename(p);
      const isImage = /\.(jpe?g|png|webp|gif)$/i.test(name);
      if (kind === 'photo' || (kind === 'auto' && isImage && docType !== 'Receipt')) added.push(store.addPhoto(assetId, name, buf));
      else added.push(store.addDocument(assetId, name, buf, docType || 'Other'));
    } catch (e) {
      errors.push(`${path.basename(p)}: ${e.message}`);
    }
  }
  return { added: added.length, errors };
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { const value = await fn(...args); if (bgEnabled() && !/^(data:get|update:|phone:status|spending:)/.test(ch)) scheduleSoon(); return { ok: true, value }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
  h('policy:renew', (id, v) => store.renewPolicy(String(id), v || {}));
  h('policy:history', (id, v) => store.addPolicyHistory(String(id), v || {}));
  h('policy:historyRemove', (id, hid) => store.removePolicyHistory(String(id), String(hid)));
  h('hint:dismiss', (id) => store.dismissDateHint(String(id)));
  h('trip:save', (v) => store.saveTrip(v || {}));
  h('trip:delete', (id) => store.deleteTrip(String(id)));
  h('trip:items', (id, ids) => store.setTripItems(String(id), Array.isArray(ids) ? ids : []));
  h('trip:extra', (id, text) => store.addTripExtra(String(id), String(text || '')));
  h('trip:extraRemove', (id, xid) => store.removeTripExtra(String(id), String(xid)));
  h('trip:tick', (id, key, which, on) => store.tickTrip(String(id), String(key), String(which), !!on));
  h('trip:reset', (id, which) => store.resetTrip(String(id), which ? String(which) : ''));
  h('listing:get', (id) => { const a = store.getAsset(String(id)); if (!a) throw new Error('Item not found'); return buildListing(store, a); });
  h('listing:photos', async (id) => {
    const a = store.getAsset(String(id)); if (!a) throw new Error('Item not found');
    const photos = a.photos.filter(p => !p.vault);
    if (!photos.length) throw new Error('This item has no photos to save.');
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the photos', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const base = (a.name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'item').slice(0, 60);
    let n = 0;
    for (const p of photos) { n++; fs.writeFileSync(path.join(r.filePaths[0], `${base} ${n}${path.extname(p.file).toLowerCase()}`), store.readAttachment(a.id, p.file)); }
    shell.openPath(r.filePaths[0]);
    return n;
  });
  h('clip:plain', (text) => { clipboard.writeText(String(text || '').slice(0, 20000)); return true; });
  h('bg:get', () => ({ enabled: bgEnabled(), platform: process.platform }));
  h('bg:set', (on) => setBackground(!!on));
  // Password attempts: after 5 wrong in a row, wait 30 s (doubling).
  const pw = { fails: 0, until: 0 };
  const pwGuard = () => {
    if (pw.until > Date.now()) throw Object.assign(new Error(`Too many wrong attempts. Try again in ${Math.ceil((pw.until - Date.now()) / 1000)} seconds.`), { code: 'PW_WAIT' });
  };
  const pwResult = async (fn) => {
    pwGuard();
    try { const v = await fn(); pw.fails = 0; return v; }
    catch (e) {
      if (e.code === 'WRONG_PASSWORD' || e.code === 'WRONG_RECOVERY') { pw.fails++; if (pw.fails >= 5) pw.until = Date.now() + 30000 * Math.pow(2, pw.fails - 5); }
      throw e;
    }
  };

  // ---- insurance policies ----
  // Documents and Data
  const libFilters = [{ name: 'All files', extensions: ['*'] }, { name: 'Documents', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'eml', 'msg', 'htm', 'html'] }];
  h('lib:pick', async (kind, entryId) => {
    const r = await dialog.showOpenDialog(win, { title: entryId ? 'Add files' : kind === 'document' ? 'Add a document (choose all its pages or files)' : 'Add files to Data', properties: ['openFile', 'multiSelections'], filters: libFilters });
    if (r.canceled) return { added: 0, ids: [], errors: [] };
    return addLibraryPaths(kind === 'data' ? 'data' : 'document', r.filePaths.slice(0, 200), entryId ? String(entryId) : '');
  });
  h('lib:addPaths', (kind, paths, entryId) => {
    if (!Array.isArray(paths)) throw new Error('No files');
    return addLibraryPaths(kind === 'data' ? 'data' : 'document', paths.slice(0, 200).map(String), entryId ? String(entryId) : '');
  });
  h('lib:addDropped', async (kind, paths, blobs, entryId) => {
    const k = kind === 'data' ? 'data' : 'document', id = entryId ? String(entryId) : '';
    const files = [], errors = [];
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 200).map(String)) {
      try { const st = fs.statSync(p); if (!st.isFile()) { errors.push(`${path.basename(p)}: folders can't be added, only files`); continue; } if (st.size > LIB_MAX) throw new Error('over 500 MB'); files.push({ name: path.basename(p), buf: fs.readFileSync(p) }); }
      catch (e) { errors.push(`${path.basename(p)}: ${e.message}`); }
    }
    for (const b of (Array.isArray(blobs) ? blobs : []).slice(0, 200)) {
      const name = path.basename(String((b && b.name) || 'file')).slice(0, 200) || 'file';
      const buf = b && b.data ? Buffer.from(b.data) : Buffer.alloc(0);
      if (!buf.length) { errors.push(`${name}: empty`); continue; }
      files.push({ name, buf });
    }
    const res = await addLibraryBuffers(k, files, id);
    res.errors.unshift(...errors);
    return res;
  });
  h('lib:move', (ids, to) => libNote(store.moveLibrary(Array.isArray(ids) ? ids.map(String) : [String(ids)], to || {})));
  h('lib:link', (ids, assetId, on) => libNote(store.linkLibrary(Array.isArray(ids) ? ids.map(String) : [String(ids)], String(assetId), on !== false)));
  h('search:all', (q) => store.searchAll(String(q || '').slice(0, 200)));
  h('lib:save', (e) => libNote(store.saveLibraryEntry(e || {})));
  h('lib:suggestion', (id, use) => libNote(store.useSuggestion(String(id), !!use)));
  h('lib:get', (id) => store.getLibraryEntry(String(id)));
  h('lib:text', (id, fileId) => store.libraryText(String(id), String(fileId)));
  h('lib:search', (kind, q) => store.librarySearch(kind === 'data' ? 'data' : 'document', String(q || '').slice(0, 200)));
  h('lib:removeFile', (id, fileId) => libNote(store.removeLibraryFile(String(id), String(fileId))));
  h('lib:delete', (id) => libNote(store.deleteLibraryEntry(String(id))));
  h('lib:restore', (id) => libNote(store.restoreLibraryEntry(String(id))));
  h('lib:purge', async (id) => {
    const e = store.libraryBinView().find(x => x.id === String(id));
    if (!e) return false;
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete for good', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Delete for good', message: `Delete "${e.title}" for good?`, detail: `Its ${e.files} file${e.files === 1 ? '' : 's'} will be removed from this PC. This can't be undone (backups you made earlier still have it).` });
    if (r.response !== 0) return false;
    return libNote(store.purgeLibraryEntry(e.id));
  });
  h('lib:vault', (id, to) => libNote(store.moveLibraryToVault(String(id), !!to)));
  h('lib:open', async (id, fileId) => {
    const { name, buffer } = store.readLibraryFile(String(id), String(fileId));
    const dir = path.join(OPEN_DIR, crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file');
    fs.writeFileSync(p, buffer);
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });
  h('lib:saveCopy', async (id, fileId) => {
    const { name, buffer } = store.readLibraryFile(String(id), String(fileId));
    const r = await dialog.showSaveDialog(win, { title: 'Save a copy', defaultPath: path.join(app.getPath('documents'), name) });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, buffer);
    return r.filePath;
  });
  h('lib:preview', async (id, fileId) => {
    // A small picture of an image or the first page of a PDF, for the list and the document page.
    const { name, buffer } = store.readLibraryFile(String(id), String(fileId));
    const ext = path.extname(name).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      const img = nativeImage.createFromBuffer(buffer);
      if (img.isEmpty()) return null;
      const sz = img.getSize(), k = Math.min(1, 900 / Math.max(sz.width, sz.height));
      return img.resize({ width: Math.round(sz.width * k), height: Math.round(sz.height * k) }).toDataURL();
    }
    if (ext === '.pdf') return libPdfPreview(buffer);
    return null;
  });
  // Reading files inside OpenSafe
  h('lib:openLink', async (url) => {
    const u = String(url || '').slice(0, 2000);
    if (!/^(https?:\/\/|mailto:)/i.test(u)) throw new Error('Only web and email links can be opened.');
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Open in my browser', 'Copy link', 'Cancel'], defaultId: 2, cancelId: 2, title: 'Open link', message: 'Open this link from the email?', detail: u + '\n\nOnly open links you trust. Links in unexpected emails can lead to fake websites.' });
    if (r.response === 0) await shell.openExternal(u);
    else if (r.response === 1) clipboard.writeText(u);
    return r.response;
  });
  h('lib:view', async (id, fileId) => {
    const e = store.getLibraryEntry(String(id));
    const f = e.files.find(x => x.id === String(fileId));
    if (!f) throw new Error('File not found');
    const { buffer } = store.readLibraryFile(e.id, f.id);
    const v = await viewer.view(f.name, buffer);
    if (v.kind === 'image') v.url = `keep://file/${encodeURIComponent(e.id)}/${encodeURIComponent(f.file)}`;
    return Object.assign(v, { name: f.name, size: f.size });
  });
  h('lib:pdfPage', async (id, fileId, n, width) => {
    const { buffer } = store.readLibraryFile(String(id), String(fileId));
    const png = await viewer.pdfPage(String(fileId), buffer, Number(n), Number(width));
    return 'data:image/png;base64,' + png.toString('base64');
  });
  h('lib:mailAttachment', async (id, fileId, index, how) => {
    const { name, buffer } = store.readLibraryFile(String(id), String(fileId));
    const a = viewer.emailAttachment(buffer, index, name);
    if (how === 'open') {
      const dir = path.join(OPEN_DIR, crypto.randomBytes(6).toString('hex'));
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, a.name);
      fs.writeFileSync(p, a.bytes);
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
      return true;
    }
    if (how === 'data') { // keep it in Data as its own entry
      const res = await addLibraryBuffers('data', [{ name: a.name, buf: a.bytes }], '', { folder: 'Email attachments' });
      return res;
    }
    const r = await dialog.showSaveDialog(win, { title: 'Save attachment', defaultPath: path.join(app.getPath('documents'), a.name) });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, a.bytes);
    return r.filePath;
  });
  h('lib:readNow', () => { readSoon(); return true; });
  h('policy:save', (p) => store.savePolicy(p));
  h('policy:delete', async (id) => {
    const p = store.data.policies.find(x => x.id === id);
    if (!p) return false;
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Delete policy', message: `Delete the ${p.insurer} policy?`, detail: 'Items covered by it are kept; they just won\'t be linked to a policy any more.' });
    if (r.response !== 0) return false;
    return store.deletePolicy(id);
  });
  h('policy:setItems', (id, ids) => store.setPolicyItems(id, Array.isArray(ids) ? ids.map(String) : []));

  // ---- automatic backups & appearance ----
  h('autobackup:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for automatic backups (e.g. OneDrive or a USB stick)', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
  h('autobackup:set', (patch) => store.setAutoBackup(patch || {}));
  h('autobackup:runNow', () => { const r = store.runAutoBackup(); if (!r.ok) throw new Error(r.error); return r.dest; });
  h('theme:set', (t) => { const p = readPrefs(); p.theme = ['light', 'dark', 'system'].includes(t) ? t : 'system'; writePrefs(p); applyTheme(); return p.theme; });

  // ---- security ----
  h('sec:state', () => store.securityState());
  h('sec:enable', async (password) => { const rk = await store.enableEncryption(password); sendSecurity(); return rk; });
  h('sec:unlock', async (password) => { await pwResult(() => store.unlock(password)); sendSecurity(); afterUnlock(); return true; });
  h('sec:recover', async (rk, password) => { await pwResult(() => store.recover(rk, password)); sendSecurity(); afterUnlock(); return true; });
  h('sec:changePassword', (cur, next) => pwResult(() => store.changePassword(cur, next)));
  h('sec:newRecovery', (password) => pwResult(() => store.newRecoveryKey(password)));
  h('sec:disable', async (password) => { await pwResult(() => store.disableEncryption(password)); sendSecurity(); return true; });
  h('sec:lock', async () => { await lockAll(); return true; });
  h('sec:saveRecovery', async (rk) => {
    if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(String(rk))) throw new Error('Not a recovery key');
    const r = await dialog.showSaveDialog(win, { title: 'Save your recovery key', defaultPath: path.join(app.getPath('documents'), 'OpenSafe recovery key.txt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, `OpenSafe recovery key\r\n\r\n${rk}\r\n\r\nCreated ${new Date().toLocaleString('en-GB')}.\r\nUse it if you forget your OpenSafe password or vault PIN.\r\nKeep it somewhere safe and private: a USB stick in a drawer, or printed out. Not on this PC.\r\n`, 'utf8');
    return r.filePath;
  });
  h('clip:copy', (text) => { clipboard.writeText(String(text).slice(0, 200)); setTimeout(() => { if (clipboard.readText() === String(text)) clipboard.clear(); }, 60000); return true; });

  // ---- vault ----
  h('vault:setup', async (pin) => { await store.setupVault(pin); sendSecurity(); return true; });
  h('vault:unlock', async (pin) => { await store.unlockVault(pin); sendSecurity(); readSoon(); return true; });
  h('vault:lock', () => { store.lockVault(); viewer.clear(); cleanOpenDir(); sendSecurity(); return true; });
  h('vault:changePin', (cur, next) => store.changePin(cur, next));
  h('vault:recoverPin', async (rk, pin) => { await pwResult(() => store.recoverVaultPin(rk, pin)); sendSecurity(); return true; });
  h('vault:remove', () => { store.removeVault(); sendSecurity(); return true; });
  h('vault:moveItem', (id, to) => store.moveItemToVault(id, !!to));
  h('vault:moveFile', (assetId, attId, to) => store.moveFileToVault(assetId, attId, !!to));

  h('data:get', () => snapshot());
  h('asset:save', (a) => store.saveAsset(a));
  h('asset:delete', async (id) => {
    const a = store.getAsset(id);
    if (!a) return false;
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'Delete item', message: `Delete "${a.name}"?`,
      detail: `It goes to Deleted items with its ${a.photos.length} photo(s) and ${a.documents.length} document(s). You can restore it from there for 30 days, after which it's deleted for good.`
    });
    if (r.response !== 0) return false;
    return store.deleteAsset(id);
  });
  h('asset:duplicate', (id) => store.duplicateAsset(id));
  // Spreadsheet import: pick a CSV, show its columns with a suggested mapping, then import.
  let pendingCsv = null;
  h('import:csvPick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a spreadsheet saved as CSV', properties: ['openFile'], filters: [{ name: 'CSV spreadsheet', extensions: ['csv', 'txt', 'tsv'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    if (/\.(xlsx|xlsm|xls|ods|numbers)$/i.test(file)) throw new Error('That is a spreadsheet file, not CSV. In Excel choose File → Save As (or Save a Copy) and pick "CSV UTF-8 (Comma delimited)", then import that file.');
    if (fs.statSync(file).size > 50 * 1024 * 1024) throw new Error('That file is over 50 MB.');
    const buf = fs.readFileSync(file);
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) { try { text = new TextDecoder('windows-1252').decode(buf); } catch (_) { /* keep UTF-8 */ } } // Excel's older "CSV (Comma delimited)"
    const rows = csv.parseCSV(text);
    if (rows.length < 2) throw new Error('That file has no rows under its headings.');
    const headers = rows[0].map((h, i) => String(h).trim() || `Column ${i + 1}`);
    pendingCsv = { rows: rows.slice(1), headers };
    return { name: path.basename(file), headers, mapping: csv.guessMapping(headers), sample: rows.slice(1, 4), total: rows.length - 1, labels: csv.FIELD_LABELS, capped: rows.length > csv.MAX_ROWS };
  });
  h('import:csvRun', async (mapping, opts) => {
    if (!pendingCsv) throw new Error('Choose the file again.');
    if (!Array.isArray(mapping) || !mapping.includes('name')) throw new Error('Choose which column holds the item names.');
    const allowed = new Set(Object.keys(csv.FIELD_LABELS));
    const map = pendingCsv.headers.map((_, i) => allowed.has(mapping[i]) ? mapping[i] : '');
    const { items, problems } = csv.rowsToItems(pendingCsv.rows, map);
    const res = store.importItems(items, { skipDuplicates: !(opts && opts.skipDuplicates === false) });
    pendingCsv = null;
    return Object.assign(res, { problems: problems.slice(0, 30), problemCount: problems.length });
  });

  h('bin:restore', (id) => store.restoreAsset(String(id)));
  h('bin:purge', async (id) => {
    const b = store.binView().find(x => x.id === String(id));
    if (!b) return false;
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete for good', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Delete for good', message: `Delete "${b.name}" for good?`, detail: `Its ${b.photos} photo(s) and ${b.documents} document(s) are deleted too. This can't be undone.` });
    return r.response === 0 ? store.purgeAsset(String(id)) : false;
  });
  h('bin:empty', async () => {
    const n = store.binView().length;
    if (!n) return 0;
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Empty Deleted items', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Empty Deleted items', message: `Delete ${n} item${n === 1 ? '' : 's'} for good?`, detail: 'Their photos and documents are deleted too. This can\'t be undone.' });
    return r.response === 0 ? store.emptyBin() : 0;
  });
  h('asset:deleteMany', async (ids) => {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(id => store.getAsset(id));
    if (!list.length) return 0;
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: [`Delete ${list.length}`, 'Cancel'], defaultId: 1, cancelId: 1, title: 'Delete items', message: `Delete ${list.length} item${list.length === 1 ? '' : 's'}?`, detail: 'They go to Deleted items with their photos and documents. You can restore them from there for 30 days.' });
    return r.response === 0 ? store.deleteMany(list) : 0;
  });
  h('dupes:find', () => store.findDuplicates());
  h('dupes:ignore', (ids) => store.notDuplicates(ids));
  h('dupes:merge', (keepId, otherIds) => store.mergeAssets(String(keepId), otherIds));
  h('spending:get', () => store.spendingByYear());
  h('recalls:check', async () => {
    const items = store.allAssets().filter(a => !['Sold', 'Disposed', 'Lost / Stolen', 'Given back'].includes(a.status));
    const fetchJson = async (url) => {
      const res = await net.fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`GOV.UK answered ${res.status}`);
      return res.json();
    };
    const result = await recalls.checkRecalls(items, fetchJson, { onProgress: (n, total) => { if (win && !win.isDestroyed()) win.webContents.send('recalls:progress', { n, total }); } });
    if (result.checked && result.errors.length === result.checked) throw new Error('Couldn\'t reach GOV.UK. Check your internet connection and try again.');
    return store.saveRecallCheck(result);
  });
  h('recalls:dismiss', (assetId, link) => store.dismissRecall(String(assetId), String(link)));
  h('recalls:open', (link) => {
    if (!/^https:\/\/www\.gov\.uk\/product-safety-alerts-reports-recalls\/[a-z0-9-]+$/.test(String(link))) throw new Error('Not a GOV.UK recall page.');
    shell.openExternal(String(link));
    return true;
  });
  h('value:add', (id, v) => store.addValuation(String(id), v || {}));
  h('value:remove', (id, vid) => store.removeValuation(String(id), String(vid)));
  h('asset:setParts', (id, ids) => store.setParts(String(id), Array.isArray(ids) ? ids.map(String) : []));
  h('asset:bulk', (ids, changes) => store.bulkUpdate(Array.isArray(ids) ? ids.map(String) : [], changes));

  h('attach:pick', async (assetId, kind, docType) => {
    const filters = kind === 'photo'
      ? [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
      : [{ name: 'Documents and videos', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', '3gp'] }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    if (r.canceled) return { added: 0, errors: [] };
    const res = addFilesFromPaths(assetId, kind, docType, r.filePaths); readSoon(); return res;
  });
  h('attach:addPaths', (assetId, kind, docType, paths) => {
    if (!Array.isArray(paths)) throw new Error('No files');
    const res = addFilesFromPaths(assetId, kind, docType, paths.slice(0, 50).map(String)); readSoon(); return res;
  });
  h('place:pick', async (place) => {
    const r = await dialog.showOpenDialog(win, { title: `Photos and videos of ${place}`, properties: ['openFile', 'multiSelections'], filters: [{ name: 'Photos and videos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', '3gp'] }] });
    if (r.canceled) return { added: 0, errors: [] };
    const res = { added: 0, errors: [] };
    for (const f of r.filePaths.slice(0, 50)) {
      try {
        const st = fs.statSync(f);
        const isVideo = /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(f);
        if (st.size > (isVideo ? 1024 : 100) * 1024 * 1024) throw new Error(isVideo ? 'over 1 GB' : 'over 100 MB');
        store.addPlaceFile(String(place), path.basename(f), fs.readFileSync(f)); res.added++;
      } catch (e) { res.errors.push(`${path.basename(f)}: ${e.message}`); }
    }
    return res;
  });
  h('place:remove', (place, fileId) => store.removePlaceFile(String(place), String(fileId)));
  h('attach:remove', (assetId, attId) => store.removeAttachment(assetId, attId));
  h('attach:cover', (assetId, attId) => store.setCoverPhoto(assetId, attId));
  h('attach:open', async (assetId, file, name) => {
    let p = store.attachmentPath(assetId, file);
    if (store.isEncrypted()) {
      // Open a decrypted copy in a private temp folder; it's deleted when OpenSafe locks or closes.
      const buf = store.readAttachment(assetId, file);
      const dir = path.join(OPEN_DIR, crypto.randomBytes(6).toString('hex'));
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || file).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || file;
      p = path.join(dir, path.extname(safe) ? safe : safe + path.extname(file));
      fs.writeFileSync(p, buf);
    }
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });

  h('service:save', (assetId, entry) => store.saveService(assetId, entry));
  h('service:delete', (assetId, id) => store.deleteService(assetId, id));
  h('settings:update', (patch) => {
    const safe = { reminderDays: patch.reminderDays, depreciation: patch.depreciation };
    return store.updateSettings(safe);
  });
  h('lists:set', (cats, locs) => store.setLists(cats, locs));

  h('export:csv', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Export items to CSV',
      defaultPath: path.join(app.getPath('documents'), `OpenSafe-items-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, store.toCSV(), 'utf8');
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });

  h('export:placeLabels', async (places, opts) => {
    const html = await buildPlaceLabelsHtml(Array.isArray(places) ? places.map(String) : [], opts || {});
    const r = await dialog.showSaveDialog(win, { title: 'Save labels for places', defaultPath: path.join(app.getPath('documents'), `OpenSafe-place-labels-${new Date().toISOString().slice(0, 10)}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.mkdirSync(OPEN_DIR, { recursive: true });
    const tmp = path.join(OPEN_DIR, `plabels-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try { await pw.loadFile(tmp); fs.writeFileSync(r.filePath, await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true })); }
    finally { pw.destroy(); fs.rm(tmp, () => {}); }
    shell.openPath(r.filePath);
    return r.filePath;
  });
  h('export:grab', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Save grab list', defaultPath: path.join(app.getPath('documents'), 'OpenSafe-grab-list.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.mkdirSync(OPEN_DIR, { recursive: true });
    const tmp = path.join(OPEN_DIR, `grab-${Date.now()}.html`);
    fs.writeFileSync(tmp, buildGrabListHtml(store), 'utf8');
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try { await pw.loadFile(tmp); fs.writeFileSync(r.filePath, await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } })); }
    finally { pw.destroy(); fs.rm(tmp, () => {}); }
    shell.openPath(r.filePath);
    return r.filePath;
  });
  h('export:report', async (opts) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save insurance report',
      defaultPath: path.join(app.getPath('documents'), `OpenSafe-insurance-report-${new Date().toISOString().slice(0, 10)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return null;
    const html = buildReportHtml(store, opts || {});
    fs.mkdirSync(OPEN_DIR, { recursive: true });
    const tmp = path.join(OPEN_DIR, `report-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try {
      await pw.loadFile(tmp);
      const pdf = await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
      fs.writeFileSync(r.filePath, pdf);
    } finally {
      pw.destroy();
      fs.rm(tmp, () => {});
    }
    shell.openPath(r.filePath);
    return r.filePath;
  });

  h('export:claim', async (ids, info) => {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Choose at least one item.');
    const pack = buildClaimPack(store, store.withParts(ids.map(String)), info || {});
    const r = await dialog.showSaveDialog(win, {
      title: 'Save claim pack',
      defaultPath: path.join(app.getPath('documents'), `OpenSafe-claim-pack-${new Date().toISOString().slice(0, 10)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return null;
    fs.mkdirSync(OPEN_DIR, { recursive: true });
    const tmp = path.join(OPEN_DIR, `claim-${Date.now()}.html`);
    fs.writeFileSync(tmp, pack.html, 'utf8');
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    let pdf;
    try {
      await pw.loadFile(tmp);
      pdf = await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    } finally { pw.destroy(); fs.rm(tmp, () => {}); }
    // Append receipt/warranty PDFs after the generated pages
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.load(pdf);
    const failed = [];
    for (const d of pack.pdfs) {
      try {
        const src = await PDFDocument.load(d.buf, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
      } catch (_) { failed.push(`${d.item}: ${d.name} (the PDF couldn't be read)`); }
    }
    out.setTitle('Insurance claim pack'); out.setProducer('OpenSafe');
    fs.writeFileSync(r.filePath, await out.save());
    const notIncluded = pack.skipped.concat(failed);
    if (notIncluded.length) dialog.showMessageBox(win, { type: 'warning', title: 'Claim pack', message: 'Claim pack saved, but some files weren\'t included', detail: notIncluded.join('\n') + '\n\nUnlock the vault first to include vault files.' });
    shell.openPath(r.filePath);
    return { path: r.filePath, appended: pack.pdfs.length - failed.length, notIncluded };
  });

  // ---- phone: read-only inventory, QR labels, barcode lookup ----
  h('export:phoneView', async (passphrase, includeVault) => {
    const makeThumb = (buf) => {
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      const small = width > height ? img.resize({ width: Math.min(360, width), quality: 'good' }) : img.resize({ height: Math.min(360, height), quality: 'good' });
      return 'data:image/jpeg;base64,' + small.toJPEG(72).toString('base64');
    };
    const view = phoneview.buildView(store, { includeVault: !!includeVault && store.vaultUnlocked(), makeThumb });
    const text = phoneview.encryptView(view, String(passphrase || ''));
    const r = await dialog.showSaveDialog(win, {
      title: 'Save inventory for your phone',
      defaultPath: path.join(app.getPath('documents'), `OpenSafe-inventory-${new Date().toISOString().slice(0, 10)}.opensafe-view`),
      filters: [{ name: 'OpenSafe inventory', extensions: ['opensafe-view'] }]
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, text, 'utf8');
    shell.showItemInFolder(r.filePath);
    return { path: r.filePath, count: view.count, kb: Math.round(text.length / 1024) };
  });

  h('export:labels', async (ids, opts) => {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Choose at least one item.');
    const html = await buildLabelsHtml(store, ids.map(String), opts || {});
    const r = await dialog.showSaveDialog(win, {
      title: 'Save QR labels',
      defaultPath: path.join(app.getPath('documents'), `OpenSafe-labels-${new Date().toISOString().slice(0, 10)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return null;
    fs.mkdirSync(OPEN_DIR, { recursive: true });
    const tmp = path.join(OPEN_DIR, `labels-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try {
      await pw.loadFile(tmp);
      fs.writeFileSync(r.filePath, await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true }));
    } finally { pw.destroy(); fs.rm(tmp, () => {}); }
    shell.openPath(r.filePath);
    return r.filePath;
  });

  // Exchange rate for something bought abroad: Frankfurter (free, no key; European Central Bank
  // reference rates). A weekend or holiday date gives the rate of the working day before.
  h('fx:convert', async (currency, amount, date) => {
    const cur = String(currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur) || cur === 'GBP') throw new Error('Choose the currency you paid in.');
    const amt = Number(String(amount || '').replace(/[,\s]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter the price you paid, as a number.');
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : '';
    if (d && d > new Date().toISOString().slice(0, 10)) throw new Error('The date bought is in the future.');
    if (d && d < '1999-01-04') throw new Error('Rates are only available from 4 January 1999.');
    let res;
    try { res = await net.fetch(`https://api.frankfurter.dev/v1/${d || 'latest'}?base=${cur}&symbols=GBP`, { headers: { Accept: 'application/json' } }); }
    catch (_) { throw new Error('Couldn\'t reach the exchange rate service. Check your internet connection, or type the £ amount from your bank statement.'); }
    let j = null; try { j = await res.json(); } catch (_) {}
    const rate = j && j.rates && Number(j.rates.GBP);
    if (!res.ok || !Number.isFinite(rate) || rate <= 0) throw new Error(res.status === 404 || res.status === 422 ? `No exchange rate is available for ${cur}${d ? ' on that date' : ''}.` : 'The exchange rate service didn\'t answer properly. Try again later, or type the £ amount.');
    return { gbp: Math.round(amt * rate * 100) / 100, rate, date: String(j.date || d), currency: cur, amount: amt };
  });

  h('barcode:lookup', async (code) => {
    const upc = String(code || '').replace(/\D/g, '');
    if (upc.length < 8 || upc.length > 14) throw new Error('That doesn\'t look like a product barcode (8 to 14 digits).');
    let res;
    try { res = await net.fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`, { headers: { Accept: 'application/json' } }); }
    catch (_) { throw new Error('Couldn\'t reach the product database. Check your internet connection.'); }
    let body = null; try { body = await res.json(); } catch (_) {}
    const errCode = body && body.code;
    if (res.status === 429) {
      if (errCode === 'EXCEED_LIMIT') throw new Error('The free product database allows 100 lookups a day, and that limit has been reached. Try again tomorrow.');
      throw new Error('Too many lookups in a short time (the free database allows about 6 a minute). Wait a minute and try again.');
    }
    if (errCode === 'INVALID_UPC') throw new Error('The product database says that isn\'t a valid barcode number.');
    if (res.status >= 500) throw new Error('The product database isn\'t working right now. Try again later.');
    const it = body && Array.isArray(body.items) && body.items[0];
    if (!res.ok || !it) return null;
    const clip = (v, n) => String(v || '').trim().slice(0, n);
    return { title: clip(it.title, 200), brand: clip(it.brand, 64), model: clip(it.model, 64), category: clip(it.category, 200), source: 'UPCitemdb' };
  });

  h('ocr:receipt', async (assetId, file) => {
    if (!/\.(jpe?g|png|webp|gif)$/i.test(String(file))) throw new Error('Receipt reading works on photos of receipts (JPG, PNG or WebP). For a PDF, type the details in.');
    const buf = store.readAttachment(String(assetId), String(file));
    const text = await ocr.readText(buf);
    return ocr.parseReceipt(text);
  });

  h('ocr:label', async (assetId, file) => {
    if (!/\.(jpe?g|png|webp|gif)$/i.test(String(file))) throw new Error('Label reading works on photos (JPG, PNG or WebP).');
    return ocr.parseLabel(await ocr.readText(store.readAttachment(String(assetId), String(file))));
  });

  h('backup:create', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose where to save the backup folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dest = store.backupTo(r.filePaths[0]);
    shell.showItemInFolder(dest);
    return dest;
  });
  h('backup:restore', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose an OpenSafe-backup folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const c = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'Restore backup', message: 'Replace everything in OpenSafe with this backup?',
      detail: 'A safety copy of your current data is saved to the backups folder first.'
    });
    if (c.response !== 0) return null;
    const res = store.restoreFrom(r.filePaths[0]);
    if (res.locked) {
      await lockAll();
      dialog.showMessageBox(win, { type: 'info', title: 'Restore backup', message: 'Backup restored', detail: 'This backup is password protected. Unlock OpenSafe with the password that was in use when the backup was made.' });
    }
    return r.filePaths[0];
  });
  h('data:openFolder', () => shell.openPath(DATA_DIR));
  h('import:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import items from OpenSafe Capture',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'OpenSafe export', extensions: ['opensafe', 'txt', 'json'] }]
    });
    if (r.canceled) return null;
    const totals = { added: 0, updated: 0, unchanged: 0 };
    for (const f of r.filePaths) {
      try { const x = await importFromPath(f); totals.added += x.added; totals.updated += x.updated; totals.unchanged += x.unchanged; } catch (_) { /* dialog already shown */ }
    }
    return totals;
  });
  h('import:paths', async (paths) => {
    const totals = { added: 0, updated: 0, unchanged: 0 };
    for (const f of (Array.isArray(paths) ? paths : []).slice(0, 20).map(String)) {
      if (!/\.(opensafe|txt|json)$/i.test(f)) continue;
      try { const x = await importFromPath(f); totals.added += x.added; totals.updated += x.updated; totals.unchanged += x.unchanged; } catch (_) {}
    }
    return totals;
  });
  h('capture:info', async () => ({ url: CAPTURE_URL, qr: await QRCode.toDataURL(CAPTURE_URL, { margin: 1, width: 360, errorCorrectionLevel: 'M' }) }));
  h('open:external', (which) => { if (which === 'capture') shell.openExternal(CAPTURE_URL); return true; });
  // Opens an item's saved web page. The link comes from the store, not from the window, and must be http(s).
  h('open:itemLink', (id) => {
    const a = store.getAsset(String(id));
    if (!a || !/^https?:\/\//i.test(a.webLink || '')) throw new Error('This item has no web page saved.');
    shell.openExternal(a.webLink);
    return true;
  });

  h('update:status', () => updater.getStatus());
  h('update:check', () => updater.checkNow());
  h('update:install', () => updater.installNow());

  h('phone:fixFirewall', async () => {
    const r = await firewall.fix(process.execPath, store.data.settings.phonePort || 47820);
    return r;
  });
  h('phone:firewallRule', () => process.platform === 'win32' ? firewall.ruleExists() : true);
  h('phone:status', () => phoneStatus());
  h('phone:enable', async (on) => {
    store.updateSettings({ phoneLinkEnabled: !!on });
    if (on) await startPhone(); else await phone.stop();
    return phoneStatus();
  });
  h('phone:reset', async () => {
    const c = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Make new code', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'New pairing code', message: 'Make a new pairing code?',
      detail: 'Any phone already paired will stop working until you scan the new QR code.'
    });
    if (c.response !== 0) return phoneStatus();
    phone.resetToken();
    return phoneStatus();
  });
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', async () => {
  if (bgEnabled() && !quitting) {
    // Keep running by the clock for reminders, but lock as if OpenSafe had closed.
    try { writeSchedule(); } catch (_) {}
    if (phone) await phone.stop();
    await ocr.stop();
    if (store && store.isEncrypted()) store.lock();
    cleanOpenDir();
    ensureTray();
    return;
  }
  if (phone) await phone.stop();
  await ocr.stop();
  if (store) store.lock();
  cleanOpenDir();
  app.quit();
});
