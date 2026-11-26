'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, Notification, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Store, STATUSES, CONDITIONS, DOC_TYPES } = require('./store');
const { PhoneServer } = require('./phoneServer');
const { buildReportHtml } = require('./report');
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

function cleanOpenDir() { try { fs.rmSync(OPEN_DIR, { recursive: true, force: true }); } catch (_) { /* a file may still be open in another app */ } }

function sendSecurity() {
  if (win && !win.isDestroyed()) win.webContents.send('security:changed', store.securityState());
}

/** Everything that should happen once the data is readable (at start-up, or after unlocking). */
function afterUnlock() {
  if (store.data.settings.phoneLinkEnabled && !phone.running) startPhone().catch(() => {});
  setTimeout(remindOnStartup, 1500);
  if (pendingImport) { const f = pendingImport; pendingImport = null; setTimeout(() => importFromPath(f).catch(() => {}), 500); }
}

async function lockAll() {
  store.lock();
  if (phone) await phone.stop();
  cleanOpenDir();
  sendSecurity();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
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
  createWindow();
  registerIpc();

  // Opened by double-clicking a .opensafe file
  const startFile = exportFileFromArgs(process.argv);
  if (startFile) pendingImport = startFile;
  if (!store.isLocked()) win.webContents.once('did-finish-load', () => setTimeout(afterUnlock, 1500));

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
  } catch (e) {
    if (win) dialog.showMessageBox(win, { type: 'error', title: 'Import', message: 'Couldn\'t import that file', detail: e.message });
    throw e;
  }
  notifyChanged();
  const lines = [];
  if (res.added) lines.push(`${res.added} new item${res.added === 1 ? '' : 's'} added.`);
  if (res.updated) lines.push(`${res.updated} item${res.updated === 1 ? '' : 's'} already here got new photos or details.`);
  if (res.unchanged) lines.push(`${res.unchanged} item${res.unchanged === 1 ? ' was' : 's were'} already imported, so ${res.unchanged === 1 ? 'it was' : 'they were'} skipped.`);
  lines.push(`${res.photos} photo${res.photos === 1 ? '' : 's'} and ${res.documents} receipt${res.documents === 1 ? '' : 's'} saved.`);
  if (res.errors.length) lines.push('', 'Not imported:', ...res.errors.slice(0, 10));
  if (win) dialog.showMessageBox(win, { type: res.errors.length ? 'warning' : 'info', title: 'Import', message: res.added ? 'Items imported from your phone' : 'Import finished', detail: lines.join('\n') });
  return res;
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
  if (!Notification.isSupported() || store.isLocked()) return;
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
}

function snapshot() {
  if (store.isLocked()) return { locked: true, security: store.securityState(), version: require('../package.json').version };
  const data = JSON.parse(JSON.stringify(Object.assign({}, store.data, { vault: undefined, assets: [] })));
  delete data.settings.phoneToken;
  data.assets = store.viewAssets();
  return {
    data,
    security: store.securityState(),
    summary: store.summary(),
    reminders: store.reminders(),
    lists: { statuses: STATUSES, conditions: CONDITIONS, docTypes: DOC_TYPES },
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
      if (st.size > 100 * 1024 * 1024) throw new Error('File is over 100 MB');
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
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
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
  h('vault:unlock', async (pin) => { await store.unlockVault(pin); sendSecurity(); return true; });
  h('vault:lock', () => { store.lockVault(); cleanOpenDir(); sendSecurity(); return true; });
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
      detail: `This removes the item and its ${a.photos.length} photo(s) and ${a.documents.length} document(s) from OpenSafe. Your daily backups in the data folder still hold the record.`
    });
    if (r.response !== 0) return false;
    return store.deleteAsset(id);
  });
  h('asset:duplicate', (id) => store.duplicateAsset(id));

  h('attach:pick', async (assetId, kind, docType) => {
    const filters = kind === 'photo'
      ? [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
      : [{ name: 'Documents', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'csv'] }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    if (r.canceled) return { added: 0, errors: [] };
    return addFilesFromPaths(assetId, kind, docType, r.filePaths);
  });
  h('attach:addPaths', (assetId, kind, docType, paths) => {
    if (!Array.isArray(paths)) throw new Error('No files');
    return addFilesFromPaths(assetId, kind, docType, paths.slice(0, 50).map(String));
  });
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
    const safe = { reminderDays: patch.reminderDays };
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

app.on('window-all-closed', async () => {
  if (phone) await phone.stop();
  if (store) store.lock();
  cleanOpenDir();
  app.quit();
});
