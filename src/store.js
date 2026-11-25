'use strict';
// OpenKeep data store: one JSON file plus an attachments folder.
// Plain Node (no Electron imports) so it can be unit-tested.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_VERSION = 1;

const DEFAULT_CATEGORIES = [
  'Vehicles', 'Electronics', 'Computers & Phones', 'Tools', 'Camping & Outdoor',
  'Motorbike Gear', 'Marine', 'Furniture', 'Appliances', 'Jewellery & Watches',
  'Sports & Hobbies', 'Clothing', 'Other'
];
const DEFAULT_LOCATIONS = ['Home', 'Garage', 'Car', 'Storage', 'Boat'];
const STATUSES = ['Owned', 'Lent out', 'In repair', 'Sold', 'Disposed', 'Lost / Stolen'];
const CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'Poor'];
const DOC_TYPES = ['Receipt', 'Warranty', 'Manual', 'Insurance', 'Other'];

const STRING_FIELDS = ['name', 'category', 'location', 'brand', 'model', 'serial', 'supplier',
  'condition', 'status', 'insurer', 'policyNumber', 'notes', 'purchaseDate', 'warrantyExpiry'];
const MONEY_FIELDS = ['purchasePrice', 'currentValue', 'insuredValue'];
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const DOC_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.csv']);

const MAX_STRING = 5000;

function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }

function cleanString(v, max = MAX_STRING) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\u0000/g, '').trim().slice(0, max);
}
function cleanMoney(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[£,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
function cleanDate(v) {
  const s = cleanString(v, 10);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? '' : s;
}
function cleanTags(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const c = cleanString(t, 40);
    if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); }
  }
  return out.slice(0, 30);
}
function safeFileName(name) {
  const base = path.basename(cleanString(name, 120) || 'file');
  return base.replace(/[^\w.\- ()]/g, '_') || 'file';
}

function emptyData() {
  return {
    version: DATA_VERSION,
    settings: {
      currency: 'GBP',
      reminderDays: 30,
      phoneLinkEnabled: false,
      phoneToken: '',
      phonePort: 47820
    },
    categories: DEFAULT_CATEGORIES.slice(),
    locations: DEFAULT_LOCATIONS.slice(),
    assets: []
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'openkeep-data.json');
    this.attachDir = path.join(dir, 'attachments');
    this.backupDir = path.join(dir, 'backups');
    this.data = null;
  }

  load() {
    fs.mkdirSync(this.attachDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // Keep the damaged file so nothing is lost, then start from the newest backup.
        const bad = this.file + '.corrupt-' + Date.now();
        fs.copyFileSync(this.file, bad);
        parsed = this._newestBackup() || emptyData();
      }
      this.data = this._migrate(parsed);
    } else {
      this.data = emptyData();
      this.save();
    }
    return this.data;
  }

  _newestBackup() {
    try {
      const files = fs.readdirSync(this.backupDir).filter(f => f.endsWith('.json')).sort();
      for (let i = files.length - 1; i >= 0; i--) {
        try { return JSON.parse(fs.readFileSync(path.join(this.backupDir, files[i]), 'utf8')); } catch (_) { /* try older */ }
      }
    } catch (_) { /* none */ }
    return null;
  }

  _migrate(d) {
    const base = emptyData();
    const out = Object.assign(base, d || {});
    out.settings = Object.assign(emptyData().settings, (d && d.settings) || {});
    if (!Array.isArray(out.categories) || !out.categories.length) out.categories = DEFAULT_CATEGORIES.slice();
    if (!Array.isArray(out.locations) || !out.locations.length) out.locations = DEFAULT_LOCATIONS.slice();
    out.assets = Array.isArray(out.assets) ? out.assets.map(a => this._normaliseAsset(a, a)) : [];
    out.version = DATA_VERSION;
    return out;
  }

  save() {
    const json = JSON.stringify(this.data, null, 2);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, this.file);
    this._dailyBackup(json);
  }

  _dailyBackup(json) {
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `openkeep-${day}.json`);
    fs.writeFileSync(target, json, 'utf8');
    const files = fs.readdirSync(this.backupDir).filter(f => /^openkeep-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 30) fs.unlinkSync(path.join(this.backupDir, files.shift()));
  }

  // ---------- assets ----------
  _normaliseAsset(input, existing) {
    const a = {
      id: (existing && existing.id) || uid(),
      createdAt: (existing && existing.createdAt) || nowIso(),
      updatedAt: nowIso(),
      photos: (existing && Array.isArray(existing.photos)) ? existing.photos : [],
      documents: (existing && Array.isArray(existing.documents)) ? existing.documents : [],
      service: (existing && Array.isArray(existing.service)) ? existing.service : [],
      source: (existing && existing.source) || cleanString(input.source, 20) || 'pc'
    };
    for (const f of STRING_FIELDS) {
      const v = input[f] !== undefined ? input[f] : existing && existing[f];
      a[f] = (f === 'purchaseDate' || f === 'warrantyExpiry') ? cleanDate(v) : cleanString(v, f === 'notes' ? MAX_STRING : 200);
    }
    for (const f of MONEY_FIELDS) {
      const v = input[f] !== undefined ? input[f] : existing && existing[f];
      a[f] = cleanMoney(v);
    }
    a.tags = cleanTags(input.tags !== undefined ? input.tags : existing && existing.tags);
    if (!a.name) a.name = 'Untitled item';
    if (!STATUSES.includes(a.status)) a.status = 'Owned';
    if (a.condition && !CONDITIONS.includes(a.condition)) a.condition = '';
    return a;
  }

  getAsset(id) { return this.data.assets.find(a => a.id === id) || null; }

  saveAsset(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid item');
    const existing = input.id ? this.getAsset(input.id) : null;
    if (input.id && !existing) throw new Error('Item not found');
    const asset = this._normaliseAsset(input, existing);
    if (existing) Object.assign(existing, asset);
    else this.data.assets.push(asset);
    this._learnLists(asset);
    this.save();
    return existing || asset;
  }

  _learnLists(a) {
    if (a.category && !this.data.categories.includes(a.category)) this.data.categories.push(a.category);
    if (a.location && !this.data.locations.includes(a.location)) this.data.locations.push(a.location);
  }

  deleteAsset(id) {
    const i = this.data.assets.findIndex(a => a.id === id);
    if (i < 0) return false;
    this.data.assets.splice(i, 1);
    const dir = this._assetDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.save();
    return true;
  }

  duplicateAsset(id) {
    const src = this.getAsset(id);
    if (!src) throw new Error('Item not found');
    const copy = Object.assign({}, src, { id: undefined, serial: '', name: src.name + ' (copy)' });
    delete copy.id;
    const created = this._normaliseAsset(copy, null);
    created.photos = []; created.documents = []; created.service = [];
    this.data.assets.push(created);
    this.save();
    return created;
  }

  // ---------- attachments ----------
  _assetDir(assetId) {
    if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new Error('Bad id');
    return path.join(this.attachDir, assetId);
  }

  attachmentPath(assetId, file) {
    const dir = this._assetDir(assetId);
    const p = path.resolve(dir, path.basename(file));
    if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error('Bad path');
    return p;
  }

  addPhoto(assetId, originalName, buffer) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('Item not found');
    const ext = (path.extname(originalName || '').toLowerCase()) || '.jpg';
    if (!IMAGE_EXT.has(ext)) throw new Error('Photos must be JPG, PNG, WebP or GIF');
    const id = uid();
    const file = id + ext;
    fs.mkdirSync(this._assetDir(assetId), { recursive: true });
    fs.writeFileSync(this.attachmentPath(assetId, file), buffer);
    const rec = { id, file, name: safeFileName(originalName || file), addedAt: nowIso() };
    asset.photos.push(rec);
    asset.updatedAt = nowIso();
    this.save();
    return rec;
  }

  addDocument(assetId, originalName, buffer, docType) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('Item not found');
    const ext = path.extname(originalName || '').toLowerCase();
    if (!DOC_EXT.has(ext)) throw new Error('Unsupported document type: ' + (ext || 'none'));
    const id = uid();
    const file = id + ext;
    fs.mkdirSync(this._assetDir(assetId), { recursive: true });
    fs.writeFileSync(this.attachmentPath(assetId, file), buffer);
    const rec = {
      id, file, name: safeFileName(originalName),
      type: DOC_TYPES.includes(docType) ? docType : 'Other', addedAt: nowIso()
    };
    asset.documents.push(rec);
    asset.updatedAt = nowIso();
    this.save();
    return rec;
  }

  removeAttachment(assetId, attId) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('Item not found');
    for (const key of ['photos', 'documents']) {
      const i = asset[key].findIndex(x => x.id === attId);
      if (i >= 0) {
        const [rec] = asset[key].splice(i, 1);
        try { fs.unlinkSync(this.attachmentPath(assetId, rec.file)); } catch (_) { /* already gone */ }
        asset.updatedAt = nowIso();
        this.save();
        return true;
      }
    }
    return false;
  }

  setCoverPhoto(assetId, attId) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('Item not found');
    const i = asset.photos.findIndex(p => p.id === attId);
    if (i > 0) { const [p] = asset.photos.splice(i, 1); asset.photos.unshift(p); this.save(); }
    return asset;
  }

  // ---------- service log ----------
  saveService(assetId, entry) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('Item not found');
    const rec = {
      id: entry.id || uid(),
      date: cleanDate(entry.date) || new Date().toISOString().slice(0, 10),
      type: cleanString(entry.type, 60) || 'Service',
      description: cleanString(entry.description, 2000),
      cost: cleanMoney(entry.cost),
      by: cleanString(entry.by, 120),
      mileage: cleanString(entry.mileage, 30),
      nextDueDate: cleanDate(entry.nextDueDate)
    };
    const i = asset.service.findIndex(s => s.id === rec.id);
    if (i >= 0) asset.service[i] = rec; else asset.service.push(rec);
    asset.service.sort((a, b) => b.date.localeCompare(a.date));
    asset.updatedAt = nowIso();
    this.save();
    return rec;
  }

  deleteService(assetId, serviceId) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('Item not found');
    asset.service = asset.service.filter(s => s.id !== serviceId);
    this.save();
  }

  // ---------- settings & lists ----------
  updateSettings(patch) {
    const s = this.data.settings;
    if (patch.reminderDays !== undefined) {
      const n = parseInt(patch.reminderDays, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 365) s.reminderDays = n;
    }
    if (patch.phoneLinkEnabled !== undefined) s.phoneLinkEnabled = !!patch.phoneLinkEnabled;
    if (patch.phonePort !== undefined) {
      const p = parseInt(patch.phonePort, 10);
      if (p >= 1024 && p <= 65535) s.phonePort = p;
    }
    if (patch.phoneToken !== undefined) s.phoneToken = cleanString(patch.phoneToken, 100);
    this.save();
    return s;
  }

  setLists(categories, locations) {
    const tidy = (arr) => [...new Set(arr.map(c => cleanString(c, 60)).filter(Boolean))];
    if (Array.isArray(categories) && tidy(categories).length) this.data.categories = tidy(categories);
    if (Array.isArray(locations) && tidy(locations).length) this.data.locations = tidy(locations);
    this.save();
  }

  // ---------- derived ----------
  reminders(today = new Date()) {
    const days = this.data.settings.reminderDays;
    const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const diff = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - t0) / 86400000);
    const out = [];
    for (const a of this.data.assets) {
      if (['Sold', 'Disposed', 'Lost / Stolen'].includes(a.status)) continue;
      if (a.warrantyExpiry) {
        const n = diff(a.warrantyExpiry);
        if (n <= days && n >= -30) out.push({ assetId: a.id, assetName: a.name, kind: 'Warranty', date: a.warrantyExpiry, daysLeft: n });
      }
      // only the latest entry's next-due counts per service type
      const latestByType = new Map();
      for (const s of a.service) {
        const k = (s.type || '').toLowerCase();
        if (!latestByType.has(k) || s.date > latestByType.get(k).date) latestByType.set(k, s);
      }
      for (const s of latestByType.values()) {
        if (!s.nextDueDate) continue;
        const n = diff(s.nextDueDate);
        if (n <= days) out.push({ assetId: a.id, assetName: a.name, kind: s.type || 'Service', date: s.nextDueDate, daysLeft: n });
      }
    }
    return out.sort((x, y) => x.daysLeft - y.daysLeft);
  }

  summary() {
    const active = this.data.assets.filter(a => !['Sold', 'Disposed', 'Lost / Stolen'].includes(a.status));
    const sum = (k) => active.reduce((t, a) => t + (a[k] || 0), 0);
    const byCategory = {};
    for (const a of active) {
      const c = a.category || 'Uncategorised';
      byCategory[c] = byCategory[c] || { count: 0, value: 0 };
      byCategory[c].count++;
      byCategory[c].value += (a.currentValue ?? a.purchasePrice ?? 0);
    }
    const uninsured = active.filter(a => !a.insurer && (a.currentValue ?? a.purchasePrice ?? 0) > 0).length;
    const noSerial = active.filter(a => !a.serial).length;
    const noReceipt = active.filter(a => !a.documents.some(d => d.type === 'Receipt')).length;
    return {
      count: active.length,
      totalCount: this.data.assets.length,
      purchaseTotal: sum('purchasePrice'),
      currentTotal: active.reduce((t, a) => t + (a.currentValue ?? a.purchasePrice ?? 0), 0),
      insuredTotal: sum('insuredValue'),
      byCategory, uninsured, noSerial, noReceipt
    };
  }

  toCSV() {
    const cols = ['name', 'category', 'location', 'brand', 'model', 'serial', 'status', 'condition',
      'purchaseDate', 'purchasePrice', 'supplier', 'currentValue', 'warrantyExpiry', 'insurer',
      'policyNumber', 'insuredValue', 'tags', 'notes', 'photos', 'documents'];
    const esc = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [cols.join(',')];
    for (const a of this.data.assets) {
      rows.push(cols.map(c => {
        if (c === 'tags') return esc(a.tags.join('; '));
        if (c === 'photos') return esc(a.photos.length);
        if (c === 'documents') return esc(a.documents.length);
        return esc(a[c]);
      }).join(','));
    }
    return '﻿' + rows.join('\r\n');
  }

  // ---------- full backup / restore (folder copy) ----------
  backupTo(destParent) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const dest = path.join(destParent, `OpenKeep-backup-${stamp}`);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(this.file, path.join(dest, 'openkeep-data.json'));
    fs.cpSync(this.attachDir, path.join(dest, 'attachments'), { recursive: true });
    return dest;
  }

  restoreFrom(srcDir) {
    const dataFile = path.join(srcDir, 'openkeep-data.json');
    if (!fs.existsSync(dataFile)) throw new Error('That folder is not an OpenKeep backup (no openkeep-data.json).');
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!parsed || !Array.isArray(parsed.assets)) throw new Error('Backup file is not valid OpenKeep data.');
    // safety copy of what we have now
    this.backupTo(this.backupDir);
    const keepSettings = this.data.settings;
    this.data = this._migrate(parsed);
    this.data.settings.phoneToken = keepSettings.phoneToken;
    const srcAttach = path.join(srcDir, 'attachments');
    fs.rmSync(this.attachDir, { recursive: true, force: true });
    if (fs.existsSync(srcAttach)) fs.cpSync(srcAttach, this.attachDir, { recursive: true });
    else fs.mkdirSync(this.attachDir, { recursive: true });
    this.save();
  }
}

module.exports = { Store, STATUSES, CONDITIONS, DOC_TYPES, cleanMoney, cleanDate, emptyData };
