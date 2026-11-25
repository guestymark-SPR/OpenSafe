'use strict';
// Automatic updates from GitHub Releases (guestymark-SPR/OpenKeep).
// Works in the installed version only (OpenKeep-Setup-x.y.z.exe). The portable exe
// and the zip can't replace themselves, so they just say so in Settings.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000; // every 4 hours while the app is open

let autoUpdater = null;
let status = { state: 'idle', message: '', version: null, percent: 0, canUpdate: false };
let send = () => {};

function set(patch) {
  status = Object.assign({}, status, patch);
  send(status);
}

function whyNotSupported() {
  if (!app.isPackaged) return 'Updates are switched off while running from source code.';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'This is the portable version, which can\'t update itself. Install OpenKeep with OpenKeep-Setup.exe to get automatic updates.';
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return 'This copy was unzipped rather than installed, so it can\'t update itself. Install OpenKeep with OpenKeep-Setup.exe to get automatic updates.';
  return null;
}

function init(onStatus) {
  send = onStatus || send;
  const why = whyNotSupported();
  if (why) { set({ state: 'unsupported', message: why, canUpdate: false }); return; }

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;          // download quietly in the background
  autoUpdater.autoInstallOnAppQuit = true;  // install next time you close OpenKeep
  autoUpdater.allowPrerelease = false;
  status.canUpdate = true;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', message: 'Checking for updates…' }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest', message: `You have the latest version (${app.getVersion()}).`, lastChecked: new Date().toISOString() }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0, message: `Downloading version ${info.version}…` }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent || 0), message: `Downloading version ${status.version}… ${Math.round(p.percent || 0)}%` }));
  autoUpdater.on('update-downloaded', (info) => set({
    state: 'ready', version: info.version,
    message: `Version ${info.version} is ready. Restart OpenKeep to use it, or it will install the next time you close OpenKeep.`
  }));
  autoUpdater.on('error', (e) => set({
    state: 'error',
    message: 'Couldn\'t check for updates. ' + (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::/i.test(String(e && e.message)) ? 'Check your internet connection.' : String((e && e.message) || e).split('\n')[0])
  }));

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* reported through 'error' */ });
  setTimeout(check, 15 * 1000);
  setInterval(check, CHECK_EVERY_MS);
}

function checkNow() {
  if (!autoUpdater) return status;
  autoUpdater.checkForUpdates().catch(() => {});
  return status;
}

function installNow() {
  if (!autoUpdater || status.state !== 'ready') return false;
  // isSilent=true: no installer wizard; isForceRunAfter=true: reopen OpenKeep afterwards
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

function getStatus() { return status; }

module.exports = { init, checkNow, installNow, getStatus };
