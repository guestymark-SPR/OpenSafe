'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(ch, ...args) {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld('keep', {
  getData: () => call('data:get'),
  saveAsset: (a) => call('asset:save', a),
  deleteAsset: (id) => call('asset:delete', id),
  duplicateAsset: (id) => call('asset:duplicate', id),
  pickFiles: (assetId, kind, docType) => call('attach:pick', assetId, kind, docType),
  addFiles: (assetId, kind, docType, files) =>
    call('attach:addPaths', assetId, kind, docType, Array.from(files).map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  removeAttachment: (assetId, attId) => call('attach:remove', assetId, attId),
  setCover: (assetId, attId) => call('attach:cover', assetId, attId),
  openAttachment: (assetId, file) => call('attach:open', assetId, file),
  saveService: (assetId, entry) => call('service:save', assetId, entry),
  deleteService: (assetId, id) => call('service:delete', assetId, id),
  updateSettings: (patch) => call('settings:update', patch),
  setLists: (cats, locs) => call('lists:set', cats, locs),
  exportCsv: () => call('export:csv'),
  exportReport: (opts) => call('export:report', opts),
  backup: () => call('backup:create'),
  restore: () => call('backup:restore'),
  openDataFolder: () => call('data:openFolder'),
  phoneStatus: () => call('phone:status'),
  phoneEnable: (on) => call('phone:enable', on),
  phoneReset: () => call('phone:reset'),
  updateStatus: () => call('update:status'),
  checkForUpdates: () => call('update:check'),
  installUpdate: () => call('update:install'),
  onUpdate: (fn) => ipcRenderer.on('update:status', (_e, st) => fn(st)),
  onChanged: (fn) => ipcRenderer.on('data:changed', () => fn()),
  onNav: (fn) => ipcRenderer.on('nav', (_e, where) => fn(where))
});
