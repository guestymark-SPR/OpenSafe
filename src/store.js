'use strict';
// OpenSafe data store: one JSON file plus an attachments folder.
// Plain Node (no Electron imports) so it can be unit-tested.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sec = require('./secure');

const DATA_VERSION = 1;

const DEFAULT_CATEGORIES = [
  'Vehicles', 'Electronics', 'Computers & Phones', 'Tools', 'Camping & Outdoor',
  'Motorbike Gear', 'Marine', 'Furniture', 'Appliances', 'Jewellery & Watches',
  'Sports & Hobbies', 'Clothing', 'Other'
];
const DEFAULT_LOCATIONS = ['Home', 'Garage', 'Car', 'Storage', 'Boat'];
const STATUSES = ['Owned', 'Lent out', 'Needs repair', 'In repair', 'Sold', 'Disposed', 'Lost / Stolen'];
const CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'Poor'];
const DOC_TYPES = ['Receipt', 'Warranty', 'Manual', 'Insurance', 'Other'];

const STRING_FIELDS = ['name', 'category', 'location', 'brand', 'model', 'serial', 'supplier',
  'condition', 'status', 'insurer', 'policyNumber', 'notes', 'purchaseDate', 'warrantyExpiry',
  'barcode', 'policyId', 'lentTo', 'lentContact', 'lentDate', 'dueBack', 'soldDate', 'soldTo'];
const DATE_FIELDS = new Set(['purchaseDate', 'warrantyExpiry', 'lentDate', 'dueBack', 'soldDate']);
const MONEY_FIELDS = ['purchasePrice', 'currentValue', 'insuredValue', 'soldPrice'];
// Extra details for vehicles (car, van, motorbike) and boats
const DETAIL_KINDS = ['', 'vehicle', 'boat'];
const DETAIL_FIELDS = {
  vehicle: { reg: 20, vin: 40, engineNo: 40, mileage: 20, fuel: 30, colour: 30, motDue: 'date', taxDue: 'date', serviceDue: 'date' },
  boat: { boatName: 80, hin: 40, sso: 40, mmsi: 20, callSign: 20, lengthM: 10, engine: 80, engineHours: 20, mooring: 120, serviceDue: 'date' }
};
const POLICY_TYPES = ['Home contents', 'Vehicle', 'Motorbike', 'Boat', 'Gadget', 'Travel', 'Other'];
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

function cleanDetails(d) {
  if (!d || typeof d !== 'object') return { kind: '' };
  const kind = DETAIL_KINDS.includes(d.kind) ? d.kind : '';
  const out = { kind };
  if (!kind) return out;
  for (const [k, spec] of Object.entries(DETAIL_FIELDS[kind])) {
    const v = spec === 'date' ? cleanDate(d[k]) : cleanString(d[k], spec);
    if (v) out[k] = v;
  }
  return out;
}

function emptyData() {
  return {
    version: DATA_VERSION,
    settings: {
      currency: 'GBP',
      reminderDays: 30,
      phoneLinkEnabled: false,
      phoneToken: '',
      phonePort: 47820,
      autoBackup: { enabled: false, folder: '', every: 'weekly', keep: 5, last: '', lastError: '' }
    },
    policies: [],
    categories: DEFAULT_CATEGORIES.slice(),
    locations: DEFAULT_LOCATIONS.slice(),
    assets: []
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'opensafe-data.json');     // used when not encrypted
    this.binFile = path.join(dir, 'opensafe-data.bin');   // used when encrypted
    this.securityFile = path.join(dir, 'security.json');  // salts + wrapped keys (no secrets)
    this.attachDir = path.join(dir, 'attachments');
    this.backupDir = path.join(dir, 'backups');
    this.data = null;
    this.keys = null;   // { 0: masterKey, 1: vaultKey } while unlocked
    this.vault = null;  // { assets: [], fileMeta: {} } while the vault is unlocked
  }

  // ---------- low-level file IO (encrypts when protection is on) ----------
  isEncrypted() { return fs.existsSync(this.securityFile); }
  isLocked() { return this.isEncrypted() && !(this.keys && this.keys[sec.KEY_MASTER]); }
  _security() { return JSON.parse(fs.readFileSync(this.securityFile, 'utf8')); }
  _writeSecurity(obj) { this._atomicWrite(this.securityFile, Buffer.from(JSON.stringify(obj, null, 2))); }

  _atomicWrite(p, buf) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);
  }
  _seal(buf, keyId = sec.KEY_MASTER) {
    if (!this.keys || !this.keys[sec.KEY_MASTER]) return buf;
    const key = this.keys[keyId];
    if (!key) { const e = new Error('The vault is locked.'); e.code = 'VAULT_LOCKED'; throw e; }
    return sec.seal(key, keyId, buf);
  }
  _open(buf) { return sec.open(this.keys, buf); }
  readFileData(p) { return this._open(fs.readFileSync(p)); }

  load() {
    if (this.isLocked()) { const e = new Error('OpenSafe is locked.'); e.code = 'LOCKED'; throw e; }
    fs.mkdirSync(this.attachDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    const enc = this.isEncrypted();
    const src = enc && fs.existsSync(this.binFile) ? this.binFile : (fs.existsSync(this.file) ? this.file : null);
    if (src) {
      let parsed;
      try {
        parsed = JSON.parse(this._open(fs.readFileSync(src)).toString('utf8'));
      } catch (e) {
        if (e.code === 'LOCKED') throw e;
        // Keep the damaged file so nothing is lost, then start from the newest backup.
        fs.copyFileSync(src, src + '.corrupt-' + Date.now());
        parsed = this._newestBackup() || emptyData();
      }
      this.data = this._migrate(parsed);
      if (enc && src === this.file) this.save(); // finish an interrupted "turn on protection"
    } else {
      this.data = emptyData();
      this.save();
    }
    this.vault = null;
    return this.data;
  }

  _newestBackup() {
    try {
      const files = fs.readdirSync(this.backupDir).filter(f => /^opensafe-\d{4}-\d{2}-\d{2}\.(json|bin)$/.test(f)).sort();
      for (let i = files.length - 1; i >= 0; i--) {
        try { return JSON.parse(this._open(fs.readFileSync(path.join(this.backupDir, files[i]))).toString('utf8')); } catch (_) { /* try older */ }
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
    out.assets = Array.isArray(out.assets) ? out.assets.map(a => this._normaliseAsset(a, a, true)) : [];
    if (out.vault && typeof out.vault !== 'object') delete out.vault;
    out.settings.autoBackup = Object.assign(emptyData().settings.autoBackup, (d && d.settings && d.settings.autoBackup) || {});
    out.policies = Array.isArray(out.policies) ? out.policies.map(p => this._normalisePolicy(p, p)) : [];
    out.version = DATA_VERSION;
    return out;
  }

  save() {
    if (!this.data) throw new Error('OpenSafe is locked.');
    if (this.vault && this.keys && this.keys[sec.KEY_VAULT] && this.data.vault) {
      const vjson = Buffer.from(JSON.stringify({ assets: this.vault.assets, fileMeta: this.vault.fileMeta }));
      this.data.vault.blob = sec.seal(this.keys[sec.KEY_VAULT], sec.KEY_VAULT, vjson).toString('base64');
    }
    const json = Buffer.from(JSON.stringify(this.data, null, 2));
    if (this.isEncrypted()) {
      this._atomicWrite(this.binFile, this._seal(json));
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } else {
      this._atomicWrite(this.file, json);
    }
    this._dailyBackup(json);
  }

  _dailyBackup(json) {
    const day = new Date().toISOString().slice(0, 10);
    const enc = this.isEncrypted();
    const target = path.join(this.backupDir, `opensafe-${day}.${enc ? 'bin' : 'json'}`);
    fs.writeFileSync(target, enc ? this._seal(json) : json);
    const other = path.join(this.backupDir, `opensafe-${day}.${enc ? 'json' : 'bin'}`);
    if (fs.existsSync(other)) fs.unlinkSync(other);
    const files = fs.readdirSync(this.backupDir).filter(f => /^opensafe-\d{4}-\d{2}-\d{2}\.(json|bin)$/.test(f)).sort();
    while (files.length > 30) fs.unlinkSync(path.join(this.backupDir, files.shift()));
  }

  // ---------- assets ----------
  _normaliseAsset(input, existing, keepUpdated) {
    const a = {
      id: (existing && existing.id) || uid(),
      createdAt: (existing && existing.createdAt) || nowIso(),
      updatedAt: (keepUpdated && existing && existing.updatedAt) || nowIso(),
      photos: (existing && Array.isArray(existing.photos)) ? existing.photos : [],
      documents: (existing && Array.isArray(existing.documents)) ? existing.documents : [],
      service: (existing && Array.isArray(existing.service)) ? existing.service : [],
      source: (existing && existing.source) || cleanString(input.source, 20) || 'pc'
    };
    for (const f of STRING_FIELDS) {
      const v = input[f] !== undefined ? input[f] : existing && existing[f];
      a[f] = DATE_FIELDS.has(f) ? cleanDate(v) : cleanString(v, f === 'notes' ? MAX_STRING : 200);
    }
    for (const f of MONEY_FIELDS) {
      const v = input[f] !== undefined ? input[f] : existing && existing[f];
      a[f] = cleanMoney(v);
    }
    a.tags = cleanTags(input.tags !== undefined ? input.tags : existing && existing.tags);
    a.details = cleanDetails(input.details !== undefined ? input.details : existing && existing.details);
    if (!a.name) a.name = 'Untitled item';
    if (!STATUSES.includes(a.status)) a.status = 'Owned';
    if (a.condition && !CONDITIONS.includes(a.condition)) a.condition = '';
    return a;
  }

  /** Items you can currently see: normal items, plus vault items while the vault is unlocked. */
  allAssets() { return this.vault ? this.data.assets.concat(this.vault.assets) : this.data.assets; }
  isVaultAsset(asset) { return !!(this.vault && this.vault.assets.includes(asset)); }
  getAsset(id) { return this.allAssets().find(a => a.id === id) || null; }

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

  /**
   * Change several items at once (from the selection bar). Only these fields can be set:
   * location, category, status (with lending or sale details), policyId. Saves once.
   */
  bulkUpdate(ids, changes) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Choose at least one item.');
    const c = changes && typeof changes === 'object' ? changes : {};
    const set = {};
    if (typeof c.location === 'string' && c.location.trim()) set.location = cleanString(c.location, 200);
    if (typeof c.category === 'string' && c.category.trim()) set.category = cleanString(c.category, 200);
    if (typeof c.status === 'string' && c.status) {
      if (!STATUSES.includes(c.status)) throw new Error('Unknown status.');
      set.status = c.status;
      if (c.status === 'Lent out') {
        set.lentTo = cleanString(c.lentTo, 200);
        if (!set.lentTo) throw new Error('Enter who the items are lent to.');
        set.lentContact = cleanString(c.lentContact, 200);
        set.lentDate = cleanDate(c.lentDate);
        set.dueBack = cleanDate(c.dueBack);
      } else if (c.status === 'Sold') {
        set.soldDate = cleanDate(c.soldDate);
        set.soldTo = cleanString(c.soldTo, 200);
      }
      if (c.status !== 'Lent out') Object.assign(set, { lentTo: '', lentContact: '', lentDate: '', dueBack: '' });
    }
    if (typeof c.policyId === 'string') {
      if (c.policyId && !(this.data.policies || []).some(p => p.id === c.policyId)) throw new Error('That policy no longer exists.');
      set.policyId = c.policyId;
    }
    if (!Object.keys(set).length) throw new Error('Choose what to change.');
    let n = 0;
    for (const id of ids.slice(0, 10000)) {
      const a = this.getAsset(String(id));
      if (!a) continue;
      Object.assign(a, set);
      a.updatedAt = nowIso();
      this._learnLists(a);
      n++;
    }
    this.save();
    return n;
  }

  _learnLists(a) {
    if (a.category && !this.data.categories.includes(a.category)) this.data.categories.push(a.category);
    if (a.location && !this.data.locations.includes(a.location)) this.data.locations.push(a.location);
  }

  deleteAsset(id) {
    const list = this.data.assets.some(a => a.id === id) ? this.data.assets : (this.vault ? this.vault.assets : []);
    const i = list.findIndex(a => a.id === id);
    if (i < 0) return false;
    const [gone] = list.splice(i, 1);
    if (this.vault) for (const r of [...gone.photos, ...gone.documents]) delete this.vault.fileMeta[r.id];
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
    (this.isVaultAsset(src) ? this.vault.assets : this.data.assets).push(created);
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

  /** Write an attachment file for an item, encrypted with the right key. */
  _storeFile(asset, file, buffer, vaultFile) {
    fs.mkdirSync(this._assetDir(asset.id), { recursive: true });
    const keyId = (vaultFile || this.isVaultAsset(asset)) ? sec.KEY_VAULT : sec.KEY_MASTER;
    this._atomicWrite(this.attachmentPath(asset.id, file), this._seal(buffer, keyId));
  }

  /** Read an attachment (decrypted). Throws with code VAULT_LOCKED for vault files while the vault is locked. */
  readAttachment(assetId, file) {
    return this.readFileData(this.attachmentPath(assetId, file));
  }

  addPhoto(assetId, originalName, buffer) {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error('Item not found');
    const ext = (path.extname(originalName || '').toLowerCase()) || '.jpg';
    if (!IMAGE_EXT.has(ext)) throw new Error('Photos must be JPG, PNG, WebP or GIF');
    const id = uid();
    const file = id + ext;
    this._storeFile(asset, file, buffer);
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
    this._storeFile(asset, file, buffer);
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
        if (rec.vault && !this.vault) { asset[key].splice(i, 0, rec); const e = new Error('Unlock the vault to delete this file.'); e.code = 'VAULT_LOCKED'; throw e; }
        try { fs.unlinkSync(this.attachmentPath(assetId, rec.file)); } catch (_) { /* already gone */ }
        if (this.vault) delete this.vault.fileMeta[rec.id];
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

  // ---------- import from OpenSafe Capture (phone/tablet app) ----------
  _writeAttachment(asset, kind, p) {
    const typeExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
    let name = safeFileName(p.name || 'file');
    let ext = path.extname(name).toLowerCase();
    const allowed = kind === 'photo' ? IMAGE_EXT : DOC_EXT;
    if (!allowed.has(ext)) { ext = typeExt[p.type] || ''; name = name.replace(/\.[^.]*$/, '') + ext; }
    if (!allowed.has(ext)) throw new Error(`${p.name || 'file'}: unsupported file type`);
    const buf = Buffer.from(String(p.data || ''), 'base64');
    if (!buf.length) throw new Error(`${p.name || 'file'}: empty`);
    const id = uid();
    const file = id + ext;
    this._storeFile(asset, file, buf);
    const rec = { id, file, name, addedAt: nowIso() };
    if (p.id) rec.captureId = cleanString(p.id, 60);
    if (kind === 'photo') asset.photos.push(rec);
    else { rec.type = DOC_TYPES.includes(p.docType) ? p.docType : 'Receipt'; asset.documents.push(rec); }
    return rec;
  }

  /**
   * Import an export file made by OpenSafe Capture.
   * - New items are added (keeping the phone's id, so re-importing never duplicates).
   * - Items already imported: details edited on the PC are kept; empty details are
   *   filled from the phone; photos/receipts not seen before are added.
   */
  importCapture(obj) {
    if (!obj || obj.format !== 'opensafe-export' || !Array.isArray(obj.items)) {
      throw new Error('This file isn\'t an OpenSafe export. Export it from OpenSafe Capture on your phone or tablet.');
    }
    if (Number(obj.version) > 2) throw new Error('This file was made by a newer version of OpenSafe Capture. Update OpenSafe on this PC and try again.');
    const res = { added: 0, updated: 0, unchanged: 0, photos: 0, documents: 0, errors: [], names: [], changes: 0, changeLines: [], skippedChanges: [] };
    const touched = new Map(); // item id -> when it was last edited before this import (null for new items)
    for (const it of obj.items.slice(0, 10000)) {
      try {
        if (!it || typeof it !== 'object') continue;
        const id = typeof it.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(it.id) ? it.id.toLowerCase() : null;
        let asset = id ? this.getAsset(id) : null;
        const incoming = this._normaliseAsset(Object.assign({}, it, { id: undefined, source: 'phone' }), null);
        let changed = false;
        const isNew = !asset;
        const before = asset ? asset.updatedAt : null;
        if (isNew) {
          asset = incoming;
          if (id) asset.id = id;
          if (typeof it.createdAt === 'string' && !Number.isNaN(Date.parse(it.createdAt))) asset.createdAt = new Date(it.createdAt).toISOString();
          asset.photos = []; asset.documents = []; asset.service = [];
          this.data.assets.push(asset);
          touched.set(asset.id, null);
          this._learnLists(asset);
          res.added++; res.names.push(asset.name);
        } else {
          for (const f of [...STRING_FIELDS, ...MONEY_FIELDS]) {
            const empty = asset[f] === '' || asset[f] === null || asset[f] === undefined;
            const has = incoming[f] !== '' && incoming[f] !== null && incoming[f] !== undefined;
            if (empty && has && !(f === 'name' && asset.name)) { asset[f] = incoming[f]; changed = true; }
          }
          if (!asset.tags.length && incoming.tags.length) { asset.tags = incoming.tags; changed = true; }
        }
        const seen = new Set([...asset.photos, ...asset.documents].map(x => x.captureId).filter(Boolean));
        for (const p of Array.isArray(it.photos) ? it.photos.slice(0, 100) : []) {
          if (p && p.id && seen.has(p.id)) continue;
          try { this._writeAttachment(asset, 'photo', p); res.photos++; changed = true; } catch (e) { res.errors.push(`${asset.name}: ${e.message}`); }
        }
        for (const d of Array.isArray(it.documents) ? it.documents.slice(0, 100) : []) {
          if (d && d.id && seen.has(d.id)) continue;
          try { this._writeAttachment(asset, 'document', d); res.documents++; changed = true; } catch (e) { res.errors.push(`${asset.name}: ${e.message}`); }
        }
        if (changed) { asset.updatedAt = nowIso(); if (!touched.has(asset.id)) touched.set(asset.id, before); }
        if (!isNew) { if (changed) res.updated++; else res.unchanged++; }
      } catch (e) {
        res.errors.push(String(e.message || e));
      }
    }
    if (Array.isArray(obj.updates)) this._applyPhoneUpdates(obj.updates, res, touched);
    this.save();
    return res;
  }

  /**
   * Changes made on the phone by scanning an item's QR label (moved, lent, needs repair...).
   * Each change has its own id and is applied once. A change made on the phone before the
   * item was last edited on the PC is skipped, so a newer PC edit is never overwritten.
   * Every applied change is added to the item's notes as a dated line.
   */
  _applyPhoneUpdates(updates, res, touched) {
    const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!Array.isArray(this.data.appliedUpdates)) this.data.appliedUpdates = [];
    const applied = new Set(this.data.appliedUpdates);
    const baseline = new Map();
    const list = updates.slice(0, 5000)
      .filter(u => u && typeof u === 'object' && RE.test(String(u.id)) && RE.test(String(u.itemId)) && !Number.isNaN(Date.parse(u.at)))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const ukd = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
    for (const u of list) {
      const uidL = String(u.id).toLowerCase();
      if (applied.has(uidL)) continue;
      const asset = this.getAsset(String(u.itemId).toLowerCase());
      const label = cleanString(u.itemName, 200) || 'Item ' + String(u.itemId).slice(0, 8);
      if (!asset) {
        res.skippedChanges.push(this.data.vault && !this.vaultUnlocked()
          ? `${label}: not found. If it's in the vault, unlock the vault and import the file again.`
          : `${label}: not found on this PC.`);
        continue;
      }
      if (!baseline.has(asset.id)) baseline.set(asset.id, touched.has(asset.id) ? touched.get(asset.id) : asset.updatedAt);
      const base = baseline.get(asset.id);
      if (base && Date.parse(base) > Date.parse(u.at)) {
        res.skippedChanges.push(`${asset.name}: "${cleanString(u.summary, 200) || 'change'}" was made on the phone before the item was last edited on this PC, so it wasn't applied.`);
        applied.add(uidL); this.data.appliedUpdates.push(uidL);
        continue;
      }
      const c = (u.changes && typeof u.changes === 'object') ? u.changes : {};
      for (const f of ['location', 'lentTo', 'lentContact', 'soldTo']) if (typeof c[f] === 'string') asset[f] = cleanString(c[f], 200);
      for (const f of ['lentDate', 'dueBack', 'soldDate']) if (typeof c[f] === 'string') asset[f] = cleanDate(c[f]);
      if (c.soldPrice !== undefined) asset.soldPrice = cleanMoney(c.soldPrice);
      if (typeof c.status === 'string' && STATUSES.includes(c.status)) asset.status = c.status;
      const summary = cleanString(u.summary, 300) || 'Updated';
      const note = cleanString(u.note, 1000);
      const line = `${ukd(u.at)} (phone): ${summary}${note ? ' (' + note + ')' : ''}`;
      const joined = (asset.notes ? asset.notes + '\n' : '') + line;
      asset.notes = joined.length > MAX_STRING ? joined.slice(joined.length - MAX_STRING) : joined; // keep the newest lines
      asset.updatedAt = nowIso();
      this._learnLists(asset);
      applied.add(uidL); this.data.appliedUpdates.push(uidL);
      res.changes++; res.changeLines.push(`${asset.name}: ${summary}`);
    }
    if (this.data.appliedUpdates.length > 20000) this.data.appliedUpdates = this.data.appliedUpdates.slice(-20000);
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
    for (const a of this.allAssets()) {
      if (['Sold', 'Disposed', 'Lost / Stolen'].includes(a.status)) continue;
      if (a.warrantyExpiry) {
        const n = diff(a.warrantyExpiry);
        if (n <= days && n >= -30) out.push({ assetId: a.id, assetName: a.name, kind: 'Warranty', date: a.warrantyExpiry, daysLeft: n, source: 'item' });
      }
      const det = a.details || {};
      const dueLabels = { motDue: 'MOT', taxDue: 'Road tax', serviceDue: 'Service' };
      for (const [k, label] of Object.entries(dueLabels)) {
        if (!det[k]) continue;
        const n = diff(det[k]);
        if (n <= days) out.push({ assetId: a.id, assetName: a.name, kind: label, date: det[k], daysLeft: n, source: 'item' });
      }
      if (a.status === 'Lent out' && a.dueBack) {
        const n = diff(a.dueBack);
        if (n <= days) out.push({ assetId: a.id, assetName: a.name, kind: 'Due back' + (a.lentTo ? ` from ${a.lentTo}` : ''), date: a.dueBack, daysLeft: n, source: 'item' });
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
    for (const p of this.data.policies || []) {
      if (!p.renewalDate) continue;
      const n = diff(p.renewalDate);
      if (n <= days && n >= -60) out.push({ policyId: p.id, assetName: `${p.insurer || 'Insurance'}${p.type ? ' (' + p.type + ')' : ''}`, kind: 'Insurance renewal', date: p.renewalDate, daysLeft: n });
    }
    return out.sort((x, y) => x.daysLeft - y.daysLeft);
  }

  // ---------- insurance policies ----------
  _normalisePolicy(input, existing) {
    const p = { id: (existing && existing.id) || uid(), createdAt: (existing && existing.createdAt) || nowIso() };
    const get = (k) => input[k] !== undefined ? input[k] : existing && existing[k];
    p.insurer = cleanString(get('insurer'), 120);
    p.type = POLICY_TYPES.includes(get('type')) ? get('type') : 'Other';
    p.policyNumber = cleanString(get('policyNumber'), 80);
    p.renewalDate = cleanDate(get('renewalDate'));
    p.premium = cleanMoney(get('premium'));
    p.excess = cleanMoney(get('excess'));
    p.coverLimit = cleanMoney(get('coverLimit'));
    p.claimsPhone = cleanString(get('claimsPhone'), 40);
    p.notes = cleanString(get('notes'), 2000);
    return p;
  }
  savePolicy(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid policy');
    const existing = input.id ? this.data.policies.find(p => p.id === input.id) : null;
    if (input.id && !existing) throw new Error('Policy not found');
    const p = this._normalisePolicy(input, existing);
    if (!p.insurer) throw new Error('Enter the insurer\'s name.');
    if (existing) Object.assign(existing, p); else this.data.policies.push(p);
    this.save();
    return existing || p;
  }
  deletePolicy(id) {
    const i = this.data.policies.findIndex(p => p.id === id);
    if (i < 0) return false;
    this.data.policies.splice(i, 1);
    for (const a of this.allAssets()) if (a.policyId === id) a.policyId = '';
    this.save();
    return true;
  }
  /** Link or unlink items to a policy. */
  setPolicyItems(policyId, assetIds) {
    const pol = this.data.policies.find(p => p.id === policyId);
    if (!pol) throw new Error('Policy not found');
    const want = new Set(assetIds || []);
    for (const a of this.allAssets()) {
      if (want.has(a.id)) a.policyId = policyId;
      else if (a.policyId === policyId) a.policyId = '';
    }
    this.save();
  }

  // ---------- automatic backups ----------
  setAutoBackup(patch) {
    const ab = this.data.settings.autoBackup;
    if (patch.enabled !== undefined) ab.enabled = !!patch.enabled;
    if (patch.folder !== undefined) ab.folder = cleanString(patch.folder, 500);
    if (patch.every !== undefined && ['daily', 'weekly', 'monthly'].includes(patch.every)) ab.every = patch.every;
    if (patch.keep !== undefined) { const n = parseInt(patch.keep, 10); if (n >= 1 && n <= 50) ab.keep = n; }
    if (ab.enabled && !ab.folder) throw new Error('Choose a folder for automatic backups.');
    this.save();
    return ab;
  }
  autoBackupDue(now = new Date()) {
    const ab = this.data.settings.autoBackup;
    if (!ab.enabled || !ab.folder) return false;
    if (!ab.last) return true;
    const gap = { daily: 1, weekly: 7, monthly: 30 }[ab.every] || 7;
    return (now - new Date(ab.last)) >= gap * 86400000 - 3600000; // an hour's slack
  }
  /** Make a full backup into the chosen folder and keep only the newest N. */
  runAutoBackup() {
    const ab = this.data.settings.autoBackup;
    try {
      if (!fs.existsSync(ab.folder)) throw new Error(`The backup folder isn't available: ${ab.folder}. If it's on a USB stick, plug it in.`);
      const dest = this.backupTo(ab.folder);
      const ours = fs.readdirSync(ab.folder).filter(f => /^OpenSafe-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}/.test(f) && fs.statSync(path.join(ab.folder, f)).isDirectory()).sort();
      while (ours.length > ab.keep) fs.rmSync(path.join(ab.folder, ours.shift()), { recursive: true, force: true });
      ab.last = nowIso(); ab.lastError = '';
      this.save();
      return { ok: true, dest };
    } catch (e) {
      ab.lastError = e.message; ab.lastErrorAt = nowIso();
      try { this.save(); } catch (_) { /* ignore */ }
      return { ok: false, error: e.message };
    }
  }

  summary() {
    const all = this.allAssets();
    const active = all.filter(a => !['Sold', 'Disposed', 'Lost / Stolen'].includes(a.status));
    const sum = (k) => active.reduce((t, a) => t + (a[k] || 0), 0);
    const byCategory = {};
    for (const a of active) {
      const c = a.category || 'Uncategorised';
      byCategory[c] = byCategory[c] || { count: 0, value: 0 };
      byCategory[c].count++;
      byCategory[c].value += (a.currentValue ?? a.purchasePrice ?? 0);
    }
    const uninsured = active.filter(a => !a.insurer && !a.policyId && (a.currentValue ?? a.purchasePrice ?? 0) > 0).length;
    const noSerial = active.filter(a => !a.serial).length;
    const noReceipt = active.filter(a => !a.documents.some(d => d.type === 'Receipt')).length;
    return {
      count: active.length,
      totalCount: all.length,
      purchaseTotal: sum('purchasePrice'),
      currentTotal: active.reduce((t, a) => t + (a.currentValue ?? a.purchasePrice ?? 0), 0),
      insuredTotal: sum('insuredValue'),
      byCategory, uninsured, noSerial, noReceipt
    };
  }

  toCSV() {
    const cols = ['name', 'category', 'location', 'brand', 'model', 'serial', 'status', 'condition',
      'purchaseDate', 'purchasePrice', 'supplier', 'currentValue', 'warrantyExpiry', 'insurer',
      'policyNumber', 'insuredValue', 'barcode', 'lentTo', 'lentContact', 'lentDate', 'dueBack', 'soldDate', 'soldPrice', 'soldTo',
      'reg', 'vin', 'engineNo', 'mileage', 'motDue', 'taxDue', 'hin', 'engineHours', 'tags', 'notes', 'photos', 'documents'];
    const esc = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [cols.join(',')];
    for (const a of this.allAssets()) {
      rows.push(cols.map(c => {
        if (c === 'tags') return esc(a.tags.join('; '));
        if (['reg', 'vin', 'engineNo', 'mileage', 'motDue', 'taxDue', 'hin', 'engineHours'].includes(c)) return esc((a.details || {})[c]);
        if (c === 'insurer' && !a.insurer && a.policyId) { const p = (this.data.policies || []).find(x => x.id === a.policyId); return esc(p ? p.insurer : ''); }
        if (c === 'policyNumber' && !a.policyNumber && a.policyId) { const p = (this.data.policies || []).find(x => x.id === a.policyId); return esc(p ? p.policyNumber : ''); }
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
    const dest = path.join(destParent, `OpenSafe-backup-${stamp}`);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of [this.file, this.binFile, this.securityFile]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, path.basename(f)));
    }
    if (fs.existsSync(this.attachDir)) fs.cpSync(this.attachDir, path.join(dest, 'attachments'), { recursive: true });
    return dest;
  }

  /**
   * Restore a backup folder.
   * - An encrypted backup replaces everything, including the password: OpenSafe locks
   *   and needs the password that was in use when the backup was made. Returns { locked: true }.
   * - A plain backup is restored into the current setup (and encrypted if protection is on).
   */
  restoreFrom(srcDir) {
    const sJson = path.join(srcDir, 'opensafe-data.json');
    const sBin = path.join(srcDir, 'opensafe-data.bin');
    const sSec = path.join(srcDir, 'security.json');
    const sAttach = path.join(srcDir, 'attachments');
    const encrypted = fs.existsSync(sSec);
    if (!fs.existsSync(sJson) && !fs.existsSync(sBin)) throw new Error('That folder is not an OpenSafe backup (no opensafe-data file).');
    if (encrypted && !fs.existsSync(sBin)) throw new Error('This backup is incomplete: its data file is missing.');
    if (!encrypted) {
      const raw = fs.readFileSync(sJson);
      if (sec.isSealed(raw)) throw new Error('This backup is encrypted but its security.json file is missing, so it can\'t be opened.');
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch (_) { throw new Error('Backup file is not valid OpenSafe data.'); }
      if (!parsed || !Array.isArray(parsed.assets)) throw new Error('Backup file is not valid OpenSafe data.');
      if (this.data && this.data.vault) throw new Error('This older backup has no vault. Move your vault items out and remove the vault before restoring it, so nothing in the vault is lost.');
      this.backupTo(this.backupDir); // safety copy of what we have now
      const keepSettings = this.data.settings;
      this.data = this._migrate(parsed);
      this.data.settings.phoneToken = keepSettings.phoneToken;
      fs.rmSync(this.attachDir, { recursive: true, force: true });
      if (fs.existsSync(sAttach)) fs.cpSync(sAttach, this.attachDir, { recursive: true });
      else fs.mkdirSync(this.attachDir, { recursive: true });
      this.save();
      this._sealPending();
      return { locked: false };
    }
    try { JSON.parse(fs.readFileSync(sSec, 'utf8')).password.wrap.ct.length; } catch (_) { throw new Error('This backup\'s security.json file is damaged.'); }
    this.backupTo(this.backupDir); // safety copy (stays encrypted if it was)
    fs.copyFileSync(sSec, this.securityFile + '.restoring');
    fs.copyFileSync(sBin, this.binFile + '.restoring');
    fs.rmSync(this.attachDir, { recursive: true, force: true });
    if (fs.existsSync(sAttach)) fs.cpSync(sAttach, this.attachDir, { recursive: true });
    else fs.mkdirSync(this.attachDir, { recursive: true });
    fs.renameSync(this.binFile + '.restoring', this.binFile);
    fs.renameSync(this.securityFile + '.restoring', this.securityFile);
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    this.lock();
    return { locked: true };
  }

  // ---------- password protection ----------
  static validPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw Object.assign(new Error('Use at least 8 characters for your password.'), { code: 'WEAK' });
    if (pw.length > 256) throw new Error('That password is too long.');
  }

  /** Walk a folder and encrypt every file that isn't encrypted yet (master key). */
  _sealTree(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { this._sealTree(p); continue; }
      if (ent.name.endsWith('.tmp')) { fs.unlinkSync(p); continue; }
      const buf = fs.readFileSync(p);
      if (sec.isSealed(buf)) continue;
      const daily = ent.name.match(/^(opensafe-\d{4}-\d{2}-\d{2})\.json$/);
      if (daily && dir === this.backupDir) {
        const bin = path.join(dir, daily[1] + '.bin');
        if (!fs.existsSync(bin)) this._atomicWrite(bin, this._seal(buf));
        fs.unlinkSync(p);
      } else {
        this._atomicWrite(p, this._seal(buf));
      }
    }
  }
  /** Decrypt every file under a folder (used when turning protection off). */
  _unsealTree(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { this._unsealTree(p); continue; }
      const buf = fs.readFileSync(p);
      if (!sec.isSealed(buf)) continue;
      const plain = this._open(buf);
      const daily = ent.name.match(/^(opensafe-\d{4}-\d{2}-\d{2})\.bin$/);
      if (daily && dir === this.backupDir) {
        this._atomicWrite(path.join(dir, daily[1] + '.json'), plain);
        fs.unlinkSync(p);
      } else {
        this._atomicWrite(p, plain);
      }
    }
  }
  /** Finish any half-done encryption (e.g. if the PC lost power while turning protection on). */
  _sealPending() {
    if (!this.isEncrypted() || this.isLocked()) return;
    this._sealTree(this.attachDir);
    this._sealTree(this.backupDir);
    for (const f of fs.readdirSync(this.dir)) {
      if (!/\.corrupt-\d+$/.test(f)) continue; // damaged copies of the data file
      const p = path.join(this.dir, f);
      const buf = fs.readFileSync(p);
      if (!sec.isSealed(buf)) this._atomicWrite(p, this._seal(buf));
    }
    if (fs.existsSync(this.binFile) && fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }

  /** Turn protection on. Returns the recovery key, which is shown to the user once. */
  async enableEncryption(password) {
    if (this.isEncrypted()) throw new Error('Password protection is already on.');
    if (!this.data) throw new Error('OpenSafe is locked.');
    Store.validPassword(password);
    const mk = sec.randomKey();
    const recoveryKey = sec.newRecoveryKey();
    const pwSalt = sec.randomSalt(), recSalt = sec.randomSalt();
    const params = { N: sec.SCRYPT.N, r: sec.SCRYPT.r, p: sec.SCRYPT.p };
    const pwKek = await sec.kdf(password, pwSalt, params);
    const rec = await sec.recoveryMaterial(recoveryKey, recSalt, params);
    // The security file goes first, so an interruption never leaves files encrypted with a lost key.
    this._writeSecurity({
      version: 1, kdf: params,
      password: { salt: pwSalt, wrap: sec.wrap(pwKek, mk) },
      recovery: { salt: recSalt, wrap: sec.wrap(rec.kek, mk), pub: rec.x.publicDer }
    });
    this.keys = { [sec.KEY_MASTER]: mk };
    this.save();
    this._sealPending();
    return recoveryKey;
  }

  async _checkPassword(password) {
    const s = this._security();
    const mk = sec.unwrap(await sec.kdf(password, s.password.salt, s.kdf), s.password.wrap);
    return mk;
  }

  async unlock(password) {
    if (!this.isEncrypted()) { if (!this.data) this.load(); return true; }
    const mk = await this._checkPassword(String(password || ''));
    if (!mk) throw Object.assign(new Error('That password isn\'t right.'), { code: 'WRONG_PASSWORD' });
    this.keys = { [sec.KEY_MASTER]: mk };
    this.load();
    this._sealPending();
    return true;
  }

  /** Forgotten password: open with the recovery key and set a new password. */
  async recover(recoveryKey, newPassword) {
    if (!this.isEncrypted()) throw new Error('Password protection isn\'t on.');
    if (!sec.looksLikeRecoveryKey(recoveryKey)) throw Object.assign(new Error('A recovery key has 24 letters and numbers, like ABCD-EFGH-JKMN-PQRS-TVWX-YZ12.'), { code: 'WRONG_RECOVERY' });
    Store.validPassword(newPassword);
    const s = this._security();
    const rec = await sec.recoveryMaterial(recoveryKey, s.recovery.salt, s.kdf);
    const mk = sec.unwrap(rec.kek, s.recovery.wrap);
    if (!mk) throw Object.assign(new Error('That recovery key isn\'t right.'), { code: 'WRONG_RECOVERY' });
    const salt = sec.randomSalt();
    s.password = { salt, wrap: sec.wrap(await sec.kdf(newPassword, salt, s.kdf), mk) };
    this._writeSecurity(s);
    this.keys = { [sec.KEY_MASTER]: mk };
    this.load();
    this._sealPending();
    return true;
  }

  async changePassword(current, next) {
    if (this.isLocked() || !this.isEncrypted()) throw new Error('Unlock OpenSafe first.');
    const mk = await this._checkPassword(String(current || ''));
    if (!mk || !mk.equals(this.keys[sec.KEY_MASTER])) throw Object.assign(new Error('Your current password isn\'t right.'), { code: 'WRONG_PASSWORD' });
    Store.validPassword(next);
    const s = this._security();
    const salt = sec.randomSalt();
    s.password = { salt, wrap: sec.wrap(await sec.kdf(next, salt, s.kdf), mk) };
    this._writeSecurity(s);
    return true;
  }

  /** Replace the recovery key (the old one stops working). Returns the new key. */
  async newRecoveryKey(password) {
    if (this.isLocked() || !this.isEncrypted()) throw new Error('Unlock OpenSafe first.');
    const mk = await this._checkPassword(String(password || ''));
    if (!mk || !mk.equals(this.keys[sec.KEY_MASTER])) throw Object.assign(new Error('That password isn\'t right.'), { code: 'WRONG_PASSWORD' });
    if (this.data.vault && !this.keys[sec.KEY_VAULT]) throw Object.assign(new Error('Unlock the vault first, so the new recovery key can open it too.'), { code: 'VAULT_LOCKED' });
    const s = this._security();
    const recoveryKey = sec.newRecoveryKey();
    const recSalt = sec.randomSalt();
    const rec = await sec.recoveryMaterial(recoveryKey, recSalt, s.kdf);
    s.recovery = { salt: recSalt, wrap: sec.wrap(rec.kek, mk), pub: rec.x.publicDer };
    this._writeSecurity(s);
    if (this.data.vault) { this.data.vault.recovery = sec.wrapForRecovery(rec.x.publicDer, this.keys[sec.KEY_VAULT]); this.save(); }
    return recoveryKey;
  }

  async disableEncryption(password) {
    if (this.isLocked() || !this.isEncrypted()) throw new Error('Unlock OpenSafe first.');
    const mk = await this._checkPassword(String(password || ''));
    if (!mk || !mk.equals(this.keys[sec.KEY_MASTER])) throw Object.assign(new Error('That password isn\'t right.'), { code: 'WRONG_PASSWORD' });
    if (this.data.vault) throw new Error('Move everything out of the vault and remove it first. The vault needs password protection.');
    this._unsealTree(this.attachDir);
    this._unsealTree(this.backupDir);
    for (const f of fs.readdirSync(this.dir)) if (/\.corrupt-\d+$/.test(f)) { const p = path.join(this.dir, f); const b = fs.readFileSync(p); if (sec.isSealed(b)) this._atomicWrite(p, this._open(b)); }
    this._atomicWrite(this.file, Buffer.from(JSON.stringify(this.data, null, 2)));
    fs.unlinkSync(this.securityFile); // from here on, plain files
    if (fs.existsSync(this.binFile)) fs.unlinkSync(this.binFile);
    this.keys = null;
    this.save();
    return true;
  }

  lock() {
    this.keys = null;
    this.data = null;
    this.vault = null;
  }

  // ---------- vault ----------
  static validPin(pin) {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw Object.assign(new Error('The PIN must be 4 to 8 digits.'), { code: 'WEAK' });
  }
  vaultExists() { return !!(this.data && this.data.vault); }
  vaultUnlocked() { return !!this.vault; }

  async setupVault(pin) {
    if (!this.isEncrypted() || this.isLocked()) throw new Error('Turn on password protection first. The vault is encrypted inside it.');
    if (this.data.vault) throw new Error('The vault is already set up.');
    Store.validPin(pin);
    const vk = sec.randomKey();
    const salt = sec.randomSalt();
    const s = this._security();
    this.data.vault = {
      pin: { salt, wrap: sec.wrap(await sec.kdf(pin, salt, s.kdf), vk) },
      recovery: sec.wrapForRecovery(s.recovery.pub, vk),
      blob: null
    };
    this.keys[sec.KEY_VAULT] = vk;
    this.vault = { assets: [], fileMeta: {} };
    this.save();
    return true;
  }

  _openVault(vk) {
    this.keys[sec.KEY_VAULT] = vk;
    let v = { assets: [], fileMeta: {} };
    if (this.data.vault.blob) v = JSON.parse(sec.open(this.keys, Buffer.from(this.data.vault.blob, 'base64')).toString('utf8'));
    v.assets = Array.isArray(v.assets) ? v.assets.map(a => this._normaliseAsset(a, a, true)) : [];
    v.fileMeta = v.fileMeta && typeof v.fileMeta === 'object' ? v.fileMeta : {};
    // forget names of vault files that no longer exist
    const live = new Set();
    for (const a of this.data.assets) for (const r of [...a.photos, ...a.documents]) if (r.vault) live.add(r.id);
    for (const id of Object.keys(v.fileMeta)) if (!live.has(id)) delete v.fileMeta[id];
    this.vault = v;
  }

  async unlockVault(pin) {
    if (this.isLocked()) throw new Error('Unlock OpenSafe first.');
    if (!this.data.vault) throw new Error('The vault isn\'t set up.');
    const now = Date.now();
    this._pin = this._pin || { fails: 0, until: 0 };
    if (this._pin.until > now) {
      const secs = Math.ceil((this._pin.until - now) / 1000);
      throw Object.assign(new Error(`Too many wrong PINs. Try again in ${secs} seconds.`), { code: 'PIN_WAIT', wait: secs });
    }
    const vk = sec.unwrap(await sec.kdf(String(pin || ''), this.data.vault.pin.salt, this._security().kdf), this.data.vault.pin.wrap);
    if (!vk) {
      this._pin.fails++;
      if (this._pin.fails >= 5) this._pin.until = Date.now() + 30000 * Math.pow(2, this._pin.fails - 5);
      const left = Math.max(0, 5 - this._pin.fails);
      throw Object.assign(new Error(left ? `Wrong PIN. ${left} more ${left === 1 ? 'try' : 'tries'} before a short wait.` : 'Wrong PIN. Please wait before trying again.'), { code: 'WRONG_PIN' });
    }
    this._pin = { fails: 0, until: 0 };
    this._openVault(vk);
    return true;
  }

  lockVault() {
    if (this.keys) delete this.keys[sec.KEY_VAULT];
    this.vault = null;
  }

  async changePin(current, next) {
    if (!this.vault) throw new Error('Unlock the vault first.');
    const vk = sec.unwrap(await sec.kdf(String(current || ''), this.data.vault.pin.salt, this._security().kdf), this.data.vault.pin.wrap);
    if (!vk || !vk.equals(this.keys[sec.KEY_VAULT])) throw Object.assign(new Error('Your current PIN isn\'t right.'), { code: 'WRONG_PIN' });
    Store.validPin(next);
    const salt = sec.randomSalt();
    this.data.vault.pin = { salt, wrap: sec.wrap(await sec.kdf(next, salt, this._security().kdf), vk) };
    this.save();
    return true;
  }

  /** Forgotten PIN: open the vault with the recovery key and set a new PIN. */
  async recoverVaultPin(recoveryKey, newPin) {
    if (this.isLocked()) throw new Error('Unlock OpenSafe first.');
    if (!this.data.vault) throw new Error('The vault isn\'t set up.');
    if (!sec.looksLikeRecoveryKey(recoveryKey)) throw Object.assign(new Error('A recovery key has 24 letters and numbers, like ABCD-EFGH-JKMN-PQRS-TVWX-YZ12.'), { code: 'WRONG_RECOVERY' });
    Store.validPin(newPin);
    const s = this._security();
    const rec = await sec.recoveryMaterial(recoveryKey, s.recovery.salt, s.kdf);
    const vk = sec.unwrapWithRecovery(rec.x.privateKey, this.data.vault.recovery);
    if (!vk) throw Object.assign(new Error('That recovery key isn\'t right.'), { code: 'WRONG_RECOVERY' });
    const salt = sec.randomSalt();
    this.data.vault.pin = { salt, wrap: sec.wrap(await sec.kdf(newPin, salt, s.kdf), vk) };
    this._pin = { fails: 0, until: 0 };
    this._openVault(vk);
    this.save();
    return true;
  }

  removeVault() {
    if (!this.vault) throw new Error('Unlock the vault first.');
    const files = this.data.assets.reduce((n, a) => n + [...a.photos, ...a.documents].filter(r => r.vault).length, 0);
    if (this.vault.assets.length || files) throw new Error(`Move everything out of the vault first (${this.vault.assets.length} item(s) and ${files} file(s) are still in it).`);
    delete this.data.vault;
    this.lockVault();
    this.save();
    return true;
  }

  _reseal(assetId, file, keyId) {
    const p = this.attachmentPath(assetId, file);
    if (!fs.existsSync(p)) return;
    const plain = this._open(fs.readFileSync(p));
    this._atomicWrite(p, sec.seal(this.keys[keyId], keyId, plain));
  }

  /** Move a whole item into the vault (toVault = true) or back out. */
  moveItemToVault(id, toVault) {
    if (!this.vault) throw Object.assign(new Error('Unlock the vault first.'), { code: 'VAULT_LOCKED' });
    const inVault = this.vault.assets.find(a => a.id === id);
    const normal = this.data.assets.find(a => a.id === id);
    if (toVault) {
      if (!normal) { if (inVault) return inVault; throw new Error('Item not found'); }
      for (const r of [...normal.photos, ...normal.documents]) {
        if (r.vault) { r.name = (this.vault.fileMeta[r.id] && this.vault.fileMeta[r.id].name) || r.name; delete r.vault; delete this.vault.fileMeta[r.id]; }
        this._reseal(id, r.file, sec.KEY_VAULT);
      }
      this.data.assets.splice(this.data.assets.indexOf(normal), 1);
      this.vault.assets.push(normal);
      this.save();
      return normal;
    }
    if (!inVault) { if (normal) return normal; throw new Error('Item not found'); }
    for (const r of [...inVault.photos, ...inVault.documents]) this._reseal(id, r.file, sec.KEY_MASTER);
    this.vault.assets.splice(this.vault.assets.indexOf(inVault), 1);
    this.data.assets.push(inVault);
    this.save();
    return inVault;
  }

  /** Put one photo or document of a normal item into the vault (or take it out). */
  moveFileToVault(assetId, attId, toVault) {
    if (!this.vault) throw Object.assign(new Error('Unlock the vault first.'), { code: 'VAULT_LOCKED' });
    const asset = this.data.assets.find(a => a.id === assetId);
    if (!asset) throw new Error(this.vault.assets.some(a => a.id === assetId) ? 'This whole item is already in the vault.' : 'Item not found');
    const r = [...asset.photos, ...asset.documents].find(x => x.id === attId);
    if (!r) throw new Error('File not found');
    if (toVault && !r.vault) {
      this._reseal(assetId, r.file, sec.KEY_VAULT);
      this.vault.fileMeta[r.id] = { name: r.name };
      r.name = 'Vault file'; r.vault = true;
    } else if (!toVault && r.vault) {
      this._reseal(assetId, r.file, sec.KEY_MASTER);
      r.name = (this.vault.fileMeta[r.id] && this.vault.fileMeta[r.id].name) || 'file';
      delete r.vault; delete this.vault.fileMeta[r.id];
    }
    asset.updatedAt = nowIso();
    this.save();
    return r;
  }

  /** Copy of the visible items for the window: vault flags and real names where allowed. */
  viewAssets() {
    const meta = this.vault ? this.vault.fileMeta : {};
    const mapRec = (r) => {
      if (!r.vault) return Object.assign({}, r);
      return this.vault ? Object.assign({}, r, { name: (meta[r.id] && meta[r.id].name) || r.name, vaultFile: true })
        : Object.assign({}, r, { vaultFile: true, locked: true });
    };
    const map = (a, inVault) => Object.assign({}, a, { inVault, photos: a.photos.map(mapRec), documents: a.documents.map(mapRec) });
    return this.data.assets.map(a => map(a, false)).concat(this.vault ? this.vault.assets.map(a => map(a, true)) : []);
  }

  securityState() {
    return {
      encrypted: this.isEncrypted(),
      locked: this.isLocked(),
      vault: { exists: !!(this.data && this.data.vault), unlocked: !!this.vault }
    };
  }
}

module.exports = { Store, STATUSES, CONDITIONS, DOC_TYPES, POLICY_TYPES, DETAIL_FIELDS, cleanMoney, cleanDate, emptyData };
