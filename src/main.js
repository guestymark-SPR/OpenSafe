'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');
const { Store, STATUSES, CONDITIONS, DOC_TYPES } = require('./store');
const { PhoneServer } = require('./phoneServer');
const { buildReportHtml } = require('./report');
const updater = require('./updater');

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
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
  store.load();
  phone = new PhoneServer({ store, onChange: notifyChanged });

  protocol.handle('keep', (req) => {
    // keep://file/<assetId>/<file>
    try {
      const u = new URL(req.url);
      const [, assetId, file] = u.pathname.split('/');
      const p = store.attachmentPath(decodeURIComponent(assetId), decodeURIComponent(file));
      return net.fetch(pathToFileURL(p).toString());
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });

  Menu.setApplicationMenu(null);
  createWindow();
  registerIpc();

  if (store.data.settings.phoneLinkEnabled) {
    startPhone().catch(() => { /* shown as stopped in the Phone screen */ });
  }

  setTimeout(remindOnStartup, 4000);
  updater.init((st) => { if (win && !win.isDestroyed()) win.webContents.send('update:status', st); });
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
  if (!Notification.isSupported()) return;
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
  const data = JSON.parse(JSON.stringify(store.data));
  delete data.settings.phoneToken;
  return {
    data,
    summary: store.summary(),
    reminders: store.reminders(),
    lists: { statuses: STATUSES, conditions: CONDITIONS, docTypes: DOC_TYPES },
    dataDir: DATA_DIR,
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
    lastSeen: phone.lastSeen ? phone.lastSeen.toISOString() : null
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
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });

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
  h('attach:open', async (assetId, file) => {
    const err = await shell.openPath(store.attachmentPath(assetId, file));
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
    const tmp = path.join(os.tmpdir(), `opensafe-report-${Date.now()}.html`);
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
    store.restoreFrom(r.filePaths[0]);
    return r.filePaths[0];
  });
  h('data:openFolder', () => shell.openPath(DATA_DIR));

  h('update:status', () => updater.getStatus());
  h('update:check', () => updater.checkNow());
  h('update:install', () => updater.installNow());

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
  app.quit();
});
