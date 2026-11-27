'use strict';
// OpenSafe data store: one JSON file plus an attachments folder.
// Plain Node (no Electron imports) so it can be unit-tested.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { takenAt } = require('./exif');
const sec = require('./secure');

const DATA_VERSION = 1;

const DEFAULT_CATEGORIES = [
  'Vehicles', 'Electronics', 'Computers & Phones', 'Tools', 'Camping & Outdoor',
  'Motorbike Gear', 'Marine', 'Furniture', 'Appliances', 'Jewellery & Watches',
  'Sports & Hobbies', 'Clothing', 'Other'
];
const DEFAULT_LOCATIONS = ['Home', 'Garage', 'Car', 'Storage', 'Boat'];
const STATUSES = ['Owned', 'Lent out', 'Needs repair', 'In repair', 'Borrowed', 'Sold', 'Disposed', 'Lost / Stolen', 'Given back'];
// No longer here (left out of lists, totals and reminders unless asked for).
const GONE = ['Sold', 'Disposed', 'Lost / Stolen', 'Given back'];
// Here, but not yours: left out of values and insurance totals.
const NOT_MINE = ['Borrowed'];
const CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'Poor'];
const DOC_TYPES = ['Receipt', 'Warranty', 'Manual', 'Insurance', 'Video', 'Other'];

const STRING_FIELDS = ['name', 'category', 'location', 'brand', 'model', 'serial', 'supplier',
  'condition', 'status', 'insurer', 'policyNumber', 'notes', 'purchaseDate', 'warrantyExpiry',
  'barcode', 'webLink', 'foreignCurrency', 'fxDate', 'policyId', 'partOf', 'owner', 'borrowedFrom', 'borrowedContact', 'returnBy', 'lentTo', 'lentContact', 'lentDate', 'dueBack', 'soldDate', 'soldTo'];
const DATE_FIELDS = new Set(['purchaseDate', 'warrantyExpiry', 'lentDate', 'dueBack', 'soldDate', 'fxDate', 'returnBy']);
const MONEY_FIELDS = ['purchasePrice', 'currentValue', 'insuredValue', 'soldPrice', 'foreignPrice'];
// Extra details for vehicles (car, van, motorbike) and boats
const DETAIL_KINDS = ['', 'vehicle', 'boat'];
const DETAIL_FIELDS = {
  vehicle: { reg: 20, vin: 40, engineNo: 40, mileage: 20, fuel: 30, colour: 30, motDue: 'date', taxDue: 'date', serviceDue: 'date' },
  boat: { boatName: 80, hin: 40, sso: 40, mmsi: 20, callSign: 20, lengthM: 10, engine: 80, engineHours: 20, mooring: 120, serviceDue: 'date' }
};
const POLICY_TYPES = ['Home contents', 'Vehicle', 'Motorbike', 'Boat', 'Gadget', 'Travel', 'Other'];
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.3gp']);
const DOC_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.csv', ...VIDEO_EXT]);

const MAX_STRING = 5000;
const LIBRARY_KINDS = ['document', 'data'];
const LIBRARY_DOC_TYPES = ['Letter', 'Bill', 'Bank statement', 'Benefits & pension', 'Medical', 'Legal', 'Tax', 'Insurance', 'Vehicle', 'Home', 'Work', 'Identity', 'Certificate', 'Other'];
// Never stored in Documents or Data: opening one of these could run a program.
const BLOCKED_EXT = new Set(['.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.scr', '.pif', '.cpl', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.lnk', '.reg', '.dll', '.sys', '.appx', '.msix', '.application', '.gadget', '.inf', '.url', '.scf']);
const BIN_DAYS = 30;

function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }

function cleanString(v, max = MAX_STRING) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\u0000/g, '').trim().slice(0, max);
}
// Locations can have levels, written as a path: "Home / Garage / Shelf 2".
function cleanLocation(v) {
  return cleanString(v, 400).split('/').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ').slice(0, 200);
}
// True if location `loc` is `place` or inside it.
function inLocation(loc, place) {
  return !!loc && (loc === place || loc.startsWith(place + ' / '));
}
const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
/**
 * Estimated value from the price paid, the purchase date and the category's yearly drop
 * (settings.depreciation, e.g. { Tools: 15 } = 15% a year, compounded). null if it can't be worked out.
 */
function estimateValue(a, rates, now = new Date()) {
  const r = rates && rates[a.category];
  if (!r || a.purchasePrice === null || a.purchasePrice === undefined || !a.purchaseDate) return null;
  const years = (now - new Date(a.purchaseDate + 'T00:00:00Z')) / (365.25 * 86400000);
  if (!(years > 0)) return a.purchasePrice;
  return Math.round(a.purchasePrice * Math.pow(1 - r / 100, years) * 100) / 100;
}
/** Value now: the value you entered, else the estimate, else the price paid. */
function valueNow(a, rates) {
  if (a.currentValue !== null && a.currentValue !== undefined) return a.currentValue;
  const e = estimateValue(a, rates);
  return e !== null ? e : (a.purchasePrice ?? 0);
}
// A web page for the item (product page, manual, shop). Only http(s) links; "www.x.com" gets https://.
function cleanUrl(v) {
  let s = cleanString(v, 1000).replace(/\s+/g, '');
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u.href : ''; } catch (_) { return ''; }
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
  // must be a real day: 2026-02-31 would otherwise roll over to 3 March
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? '' : s;
}
const MARK_COLORS = ['yellow', 'green', 'pink', 'blue'];
/** A highlight: which file and page, where (fractions of the page as shown), its colour, your note and the words under it. */
function cleanMark(m) {
  if (!m || typeof m !== 'object') return null;
  const f = (v) => Math.max(0, Math.min(1, Number(v)));
  const x0 = f(Math.min(m.x0, m.x1)), x1 = f(Math.max(m.x0, m.x1)), y0 = f(Math.min(m.y0, m.y1)), y1 = f(Math.max(m.y0, m.y1));
  if (![x0, x1, y0, y1].every(Number.isFinite) || x1 - x0 < 0.005 || y1 - y0 < 0.003) return null;
  const page = Math.max(1, Math.min(10000, Math.floor(Number(m.page) || 1)));
  return { id: String(m.id || '').slice(0, 80) || uid(), fileId: String(m.fileId || '').slice(0, 80), page, x0, y0, x1, y1,
    color: MARK_COLORS.includes(m.color) ? m.color : 'yellow', note: String(m.note || '').slice(0, 2000), text: String(m.text || '').slice(0, 2000), createdAt: String(m.createdAt || '').slice(0, 40) || nowIso() };
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
      autoBackup: { enabled: false, folder: '', every: 'weekly', keep: 5, last: '', lastError: '' },
      depreciation: {} // category -> percent lost per year
    },
    policies: [],
    trips: [], // packing lists: [{ id, name, startDate, endDate, items: [{ assetId, packed, back }], extras: [{ id, text, packed, back }] }]
    people: [], // household members items can belong to ("who owns it")
    places: {}, // photos and videos of a room or place: { 'Home / Lounge': { id, files: [{ id, file, name, kind, addedAt }] } }
    bin: [], // deleted items, kept for BIN_DAYS: [{ asset, deletedAt }]
    library: [], // Documents and Data entries (see _normaliseLibrary)
    libBin: [], // deleted Documents and Data entries, kept for BIN_DAYS: [{ entry, deletedAt }]
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
    out.trips = Array.isArray(out.trips) ? out.trips.filter(t => t && t.id) : [];
    out.people = Array.isArray(out.people) ? out.people.map(p => cleanString(p, 200)).filter(Boolean) : [];
    out.places = out.places && typeof out.places === 'object' && !Array.isArray(out.places) ? out.places : {};
    out.bin = Array.isArray(out.bin) ? out.bin.filter(b => b && b.asset && b.asset.id).map(b => ({ asset: this._normaliseAsset(b.asset, b.asset, true), deletedAt: b.deletedAt || nowIso() })) : [];
    out.policies = Array.isArray(out.policies) ? out.policies.map(p => this._normalisePolicy(p, p)) : [];
    out.library = Array.isArray(out.library) ? out.library.filter(e => e && e.id).map(e => Object.assign(this._normaliseLibrary(e, e), { updatedAt: e.updatedAt || nowIso() })) : [];
    out.libBin = Array.isArray(out.libBin) ? out.libBin.filter(b => b && b.entry && b.entry.id) : [];
    out.docText = out.docText && typeof out.docText === 'object' && !Array.isArray(out.docText) ? out.docText : {};
    out.version = DATA_VERSION;
    return out;
  }

  save() {
    if (!this.data) throw new Error('OpenSafe is locked.');
    if (this.vault && this.keys && this.keys[sec.KEY_VAULT] && this.data.vault) {
      const vstr = this._vaultJson(this.vault);
      // only re-encrypt when the vault really changed, so an unchanged vault saves identically
      // (keeps two PCs from sending each other copies that differ only in their encryption)
      if (vstr !== this._vaultPlain || !this.data.vault.blob) {
        this.data.vault.blob = sec.seal(this.keys[sec.KEY_VAULT], sec.KEY_VAULT, Buffer.from(vstr)).toString('base64');
        this._vaultPlain = vstr;
      }
    }
    const json = Buffer.from(JSON.stringify(this.data, null, 2));
    if (this.isEncrypted()) {
      this._atomicWrite(this.binFile, this._seal(json));
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } else {
      this._atomicWrite(this.file, json);
    }
    this._dailyBackup(json);
    if (typeof this.onSave === 'function') { try { this.onSave(); } catch (_) { /* never block saving */ } }
  }
  _vaultJson(v) { return JSON.stringify({ assets: v.assets, fileMeta: v.fileMeta, bin: v.bin || [], library: v.library || [], libBin: v.libBin || [], docText: v.docText || {} }); }

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
      valueHistory: (existing && Array.isArray(existing.valueHistory)) ? existing.valueHistory.filter(v => v && cleanDate(v.date) && Number.isFinite(v.value)).slice(-500) : [],
      source: (existing && existing.source) || cleanString(input.source, 20) || 'pc'
    };
    for (const f of STRING_FIELDS) {
      const v = input[f] !== undefined ? input[f] : existing && existing[f];
      a[f] = DATE_FIELDS.has(f) ? cleanDate(v) : f === 'location' ? cleanLocation(v) : f === 'webLink' ? cleanUrl(v) : cleanString(v, f === 'notes' ? MAX_STRING : 200);
    }
    for (const f of MONEY_FIELDS) {
      const v = input[f] !== undefined ? input[f] : existing && existing[f];
      a[f] = cleanMoney(v);
    }
    // Bought abroad: the price in the other currency, and the rate used for the £ price (pounds per unit, date of the rate).
    a.foreignCurrency = /^[A-Z]{3}$/.test(String(a.foreignCurrency).toUpperCase()) && String(a.foreignCurrency).toUpperCase() !== 'GBP' ? String(a.foreignCurrency).toUpperCase() : '';
    const rate = Number(input.fxRate !== undefined ? input.fxRate : existing && existing.fxRate);
    a.fxRate = a.foreignCurrency && Number.isFinite(rate) && rate > 0 && rate < 1e6 ? Math.round(rate * 1e6) / 1e6 : null;
    if (!a.foreignCurrency) { a.foreignPrice = null; a.fxRate = null; a.fxDate = ''; }
    a.tags = cleanTags(input.tags !== undefined ? input.tags : existing && existing.tags);
    a.grab = input.grab !== undefined ? input.grab === true || input.grab === 'on' || input.grab === 'true' : !!(existing && existing.grab); // on the grab list (save first in a fire or flood)
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
    this._checkPartOf(asset);
    if (asset.currentValue !== null && (!existing || existing.currentValue !== asset.currentValue)) {
      asset.valueHistory = asset.valueHistory.concat({ id: uid(), date: today(), value: asset.currentValue, note: existing ? 'Value changed' : 'First value' });
    }
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
    if (typeof c.location === 'string' && cleanLocation(c.location)) set.location = cleanLocation(c.location);
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
      if (c.status === 'Borrowed') {
        set.borrowedFrom = cleanString(c.borrowedFrom, 200);
        if (!set.borrowedFrom) throw new Error('Enter who the items belong to.');
        set.borrowedContact = cleanString(c.borrowedContact, 200);
        set.returnBy = cleanDate(c.returnBy);
      }
      if (c.status !== 'Lent out') Object.assign(set, { lentTo: '', lentContact: '', lentDate: '', dueBack: '' });
    }
    if (c.grab === 'add' || c.grab === 'remove') set.grab = c.grab === 'add';
    if (typeof c.owner === 'string' && c.owner.trim()) set.owner = c.owner.trim() === '-' ? '' : cleanString(c.owner, 200);
    if (typeof c.policyId === 'string') {
      if (c.policyId && !(this.data.policies || []).some(p => p.id === c.policyId)) throw new Error('That policy no longer exists.');
      set.policyId = c.policyId;
    }
    if (!Object.keys(set).length) throw new Error('Choose what to change.');
    if (set.owner) this._learnPerson(set.owner);
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

  _learnPerson(name) {
    if (!Array.isArray(this.data.people)) this.data.people = [];
    if (name && !this.data.people.some(p => p.toLowerCase() === name.toLowerCase())) this.data.people.push(name);
  }

  _learnLists(a) {
    if (a.owner) this._learnPerson(a.owner);
    if (a.category && !this.data.categories.includes(a.category)) this.data.categories.push(a.category);
    if (a.location && !this.data.locations.includes(a.location)) this.data.locations.push(a.location);
  }

  /** Move an item to the deleted items bin. Its photos and documents stay until it's deleted for good. */
  deleteAsset(id) {
    const inVault = !!(this.vault && this.vault.assets.some(a => a.id === id));
    const list = inVault ? this.vault.assets : this.data.assets;
    const i = list.findIndex(a => a.id === id);
    if (i < 0) return false;
    const [gone] = list.splice(i, 1);
    for (const a of this.allAssets()) if (a.partOf === id) a.partOf = '';
    for (const t of this.data.trips || []) t.items = t.items.filter(i => i.assetId !== id);
    const bin = inVault ? (this.vault.bin = this.vault.bin || []) : this.data.bin;
    bin.push({ asset: gone, deletedAt: nowIso() });
    this.save();
    return true;
  }
  _binEntries() { return [...this.data.bin.map(b => ({ b, list: this.data.bin, inVault: false })), ...(this.vault ? (this.vault.bin || []).map(b => ({ b, list: this.vault.bin, inVault: true })) : [])]; }
  inBin(id) { return this._binEntries().some(e => e.b.asset.id === id); }
  binView() {
    const day = 86400000;
    return this._binEntries().map(({ b, inVault }) => ({
      id: b.asset.id, name: b.asset.name, category: b.asset.category, location: b.asset.location, deletedAt: b.deletedAt, inVault,
      photos: b.asset.photos.length, documents: b.asset.documents.length,
      daysLeft: Math.max(0, BIN_DAYS - Math.floor((Date.now() - Date.parse(b.deletedAt)) / day))
    })).sort((x, y) => y.deletedAt.localeCompare(x.deletedAt));
  }
  restoreAsset(id) {
    const e = this._binEntries().find(x => x.b.asset.id === id);
    if (!e) throw new Error('That item isn\'t in the deleted items bin.');
    if (this.getAsset(id)) throw new Error('An item with the same id is already in OpenSafe.');
    e.list.splice(e.list.indexOf(e.b), 1);
    const a = e.b.asset;
    if (a.partOf && !this.getAsset(a.partOf)) a.partOf = '';
    a.updatedAt = nowIso();
    (e.inVault ? this.vault.assets : this.data.assets).push(a);
    this._learnLists(a);
    this.save();
    return a;
  }
  /** Delete for good: the item and all its photos and documents. */
  purgeAsset(id, { save = true } = {}) {
    const e = this._binEntries().find(x => x.b.asset.id === id);
    if (!e) return false;
    e.list.splice(e.list.indexOf(e.b), 1);
    if (this.vault) for (const r of [...e.b.asset.photos, ...e.b.asset.documents]) delete this.vault.fileMeta[r.id];
    const dir = this._assetDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (save) this.save();
    return true;
  }
  emptyBin() { const ids = this._binEntries().map(e => e.b.asset.id); for (const id of ids) this.purgeAsset(id, { save: false }); this.save(); return ids.length; }
  /** Delete for good anything that has been in the bin longer than BIN_DAYS. */
  purgeOldBin(now = Date.now()) {
    const old = this._binEntries().filter(e => now - Date.parse(e.b.deletedAt) > BIN_DAYS * 86400000).map(e => e.b.asset.id);
    for (const id of old) this.purgeAsset(id, { save: false });
    const oldLib = this._libBinEntries().filter(e => now - Date.parse(e.b.deletedAt) > BIN_DAYS * 86400000).map(e => e.b.entry.id);
    for (const id of oldLib) this.purgeLibraryEntry(id, { save: false });
    if (old.length || oldLib.length) this.save();
    return old.length + oldLib.length;
  }


  // ---------- photos and videos of a room or place (e.g. an insurance walk-through) ----------
  placeFiles(place) { const e = this.data.places[cleanLocation(place)]; return e ? e.files : []; }
  addPlaceFile(place, originalName, buffer) {
    const p = cleanLocation(place);
    if (!p) throw new Error('Choose a place first.');
    const ext = path.extname(originalName || '').toLowerCase();
    const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'photo' : null;
    if (!kind) throw new Error(`${originalName}: only photos (JPG, PNG, WebP, GIF) and videos (MP4, MOV, M4V, WebM, AVI, MKV, 3GP) can be added to a place.`);
    const entry = this.data.places[p] = this.data.places[p] || { id: uid(), files: [] };
    const id = uid(), file = id + ext;
    this._storeFile({ id: entry.id }, file, buffer);
    const rec = { id, file, name: safeFileName(originalName), kind, addedAt: nowIso() };
    entry.files.push(rec);
    this.save();
    return rec;
  }
  removePlaceFile(place, fileId) {
    const e = this.data.places[cleanLocation(place)];
    const i = e ? e.files.findIndex(f => f.id === fileId) : -1;
    if (i < 0) throw new Error('File not found');
    const [f] = e.files.splice(i, 1);
    try { fs.unlinkSync(this.attachmentPath(e.id, f.file)); } catch (_) { /* already gone */ }
    this.save();
    return true;
  }

  // ---------- Documents and Data: files kept for their own sake, not tied to an item ----------
  // Documents: scanned letters and papers. Data: saved emails, PDFs, Word files, photos and so on.
  // Files live in attachments/<entry id>/, encrypted like item files; whole entries can go in the vault.
  _normaliseLibrary(input, existing) {
    const get = (k) => input[k] !== undefined ? input[k] : existing && existing[k];
    const e = {
      id: (existing && existing.id) || uid(),
      kind: LIBRARY_KINDS.includes(get('kind')) ? get('kind') : 'document',
      createdAt: (existing && existing.createdAt) || nowIso(),
      updatedAt: nowIso(),
      files: (existing && Array.isArray(existing.files)) ? existing.files : [],
      text: (existing && typeof existing.text === 'object' && existing.text) || {}, // fileId -> searchable text read from that file
      source: (existing && existing.source) || cleanString(input.source, 20) || 'pc',
      phoneId: (existing && existing.phoneId) || cleanString(input.phoneId, 80)
    };
    e.title = cleanString(get('title'), 200) || 'Untitled';
    e.docType = e.kind === 'document' ? (LIBRARY_DOC_TYPES.includes(get('docType')) ? get('docType') : 'Letter') : '';
    e.from = cleanString(get('from'), 200);
    e.docDate = cleanDate(get('docDate'));
    e.ref = cleanString(get('ref'), 120);
    e.actBy = cleanDate(get('actBy'));       // reply or act by (shows in Reminders)
    e.actDone = get('actDone') === true || get('actDone') === 'on' || get('actDone') === 'true';
    e.folder = cleanString(get('folder'), 120);
    e.caseName = cleanString(get('caseName'), 120); // a case groups letters about one matter (shown as a timeline)
    const yes = (v) => v === true || v === 'on' || v === 'true';
    e.sent = yes(get('sent'));                         // sent by me (then "from" is who it went to)
    e.expectBy = e.sent ? cleanDate(get('expectBy')) : ''; // a reply is expected by
    e.replyDone = e.sent && yes(get('replyDone'));
    e.notes = cleanString(get('notes'), MAX_STRING);
    e.tags = cleanTags(get('tags'));
    e.assetIds = (Array.isArray(get('assetIds')) ? get('assetIds') : []).map(x => cleanString(x, 80)).filter(Boolean).slice(0, 200);
    if (existing && LIBRARY_DOC_TYPES.includes(existing.prevDocType)) e.prevDocType = existing.prevDocType;
    if (existing && existing.suggestDone) e.suggestDone = true;
    if (get('onPhone') === true) e.onPhone = true; // a copy goes in the inventory file for the phone
    e.marks = (Array.isArray(get('marks')) ? get('marks') : []).map(cleanMark).filter(Boolean).slice(0, 500); // highlights and notes on PDF pages
    const stm = get('statement'); // a statement written in OpenSafe: its text, to change it later
    if (stm && typeof stm === 'object' && typeof stm.text === 'string') e.statement = { text: stm.text.slice(0, 200000) };
    const rep = get('reply'); // a letter written in OpenSafe: what's needed to change it later
    if (rep && typeof rep === 'object') {
      e.reply = {};
      for (const [k, n] of [['fromName', 120], ['fromAddress', 600], ['fromPhone', 60], ['fromEmail', 120], ['toName', 200], ['toAddress', 600], ['yourRef', 120], ['ourRef', 120], ['subject', 200], ['greeting', 120], ['body', 20000], ['replyTo', 80]]) e.reply[k] = String(rep[k] || '').slice(0, n);
      for (const k of ['date', 'theirDate']) e.reply[k] = cleanDate(rep[k]);
    }
    if (existing && existing.suggest && typeof existing.suggest === 'object') { // drop suggestions for details now filled in
      const sg = {}; for (const k of ['from', 'docDate', 'ref']) if (existing.suggest[k] && !e[k]) sg[k] = String(existing.suggest[k]).slice(0, 200);
      if (Object.keys(sg).length) e.suggest = sg;
    }
    return e;
  }
  _libLists() { return { normal: this.data.library, vault: this.vault ? (this.vault.library = this.vault.library || []) : null }; }
  _libFind(id) {
    const { normal, vault } = this._libLists();
    let e = normal.find(x => x.id === id);
    if (e) return { e, list: normal, inVault: false };
    e = vault && vault.find(x => x.id === id);
    if (e) return { e, list: vault, inVault: true };
    const err = new Error(this.data.vault && !this.vault ? 'Not found. If it\'s in the vault, unlock the vault first.' : 'Not found');
    err.code = this.data.vault && !this.vault ? 'VAULT_LOCKED' : 'NOT_FOUND';
    throw err;
  }
  /** Entries for the window (no full text, which can be long): kind 'document' or 'data'. */
  libraryView(kind) {
    const { normal, vault } = this._libLists();
    const map = (e, inVault) => Object.assign({}, e, { text: undefined, hasText: Object.values(e.text || {}).some(t => t && t.length > 20), inVault,
      textPending: e.files.filter(f => !(f.id in (e.text || {}))).length });
    return [...normal.map(e => map(e, false)), ...(vault || []).map(e => map(e, true))].filter(e => !kind || e.kind === kind);
  }
  /** Search titles, senders, references, notes, tags, file names and the text inside the files. */
  librarySearch(kind, q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
    const out = [];
    for (const e of this.libraryView(kind)) {
      const full = this._libFind(e.id).e;
      const meta = [e.title, e.docType, e.from, e.ref, e.folder, e.caseName, e.notes, ...(e.marks || []).map(m => m.note + ' ' + m.text), e.tags.join(' '), ...e.files.map(f => f.name)].join(' ').toLowerCase();
      const body = Object.values(full.text || {}).join('\n');
      const low = body.toLowerCase();
      if (!words.every(w => meta.includes(w) || low.includes(w))) continue;
      let snippet = '';
      const w = words.find(x => !meta.includes(x) && low.includes(x)) || words.find(x => low.includes(x));
      if (w) { const i = low.indexOf(w); snippet = body.slice(Math.max(0, i - 60), i + w.length + 80).replace(/\s+/g, ' ').trim(); }
      out.push({ id: e.id, snippet });
    }
    return out;
  }
  getLibraryEntry(id) { const { e, inVault } = this._libFind(id); return Object.assign({}, e, { text: undefined, inVault, textByFile: Object.fromEntries(Object.entries(e.text || {}).map(([k, v]) => [k, (v || '').length])) }); }
  libraryText(id, fileId) { const { e } = this._libFind(id); return (e.text || {})[fileId] || ''; }
  saveLibraryEntry(input) {
    if (input.id) {
      const { e, list } = this._libFind(input.id);
      const next = this._normaliseLibrary(Object.assign({}, input, { kind: e.kind }), e);
      list[list.indexOf(e)] = next;
      this.save();
      return next;
    }
    const e = this._normaliseLibrary(input, null);
    this.data.library.push(e);
    this.save();
    return e;
  }
  addLibraryFile(id, originalName, buffer, { save = true } = {}) {
    const { e, inVault } = this._libFind(id);
    const ext = path.extname(originalName || '').toLowerCase();
    if (BLOCKED_EXT.has(ext)) throw new Error(`${originalName}: programs and scripts (${ext}) can't be stored, as opening one could run it.`);
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error(`${originalName}: the file is empty.`);
    const fid = uid(), file = fid + (ext && ext.length <= 10 ? ext : '');
    this._storeFile({ id: e.id }, file, buffer, inVault);
    const rec = { id: fid, file, name: safeFileName(originalName || file), size: buffer.length, addedAt: nowIso(), sha: crypto.createHash('sha256').update(buffer).digest('hex') };
    e.files.push(rec);
    e.updatedAt = nowIso();
    if (save) this.save();
    return rec;
  }
  readLibraryFile(id, fileId) {
    const { e } = this._libFind(id);
    const f = e.files.find(x => x.id === fileId);
    if (!f) throw new Error('File not found');
    return { name: f.name, buffer: this.readAttachment(e.id, f.file) };
  }
  removeLibraryFile(id, fileId) {
    const { e } = this._libFind(id);
    const i = e.files.findIndex(x => x.id === fileId);
    if (i < 0) throw new Error('File not found');
    const [f] = e.files.splice(i, 1);
    delete e.text[fileId];
    if (e.marks) e.marks = e.marks.filter(m => m.fileId !== fileId);
    try { fs.unlinkSync(this.attachmentPath(e.id, f.file)); } catch (_) { /* already gone */ }
    e.updatedAt = nowIso();
    this.save();
    return true;
  }
  /** Store the text read from one file (empty string = no text found). */
  setLibraryText(id, fileId, text) {
    let found;
    try { found = this._libFind(id); } catch (_) { return false; } // deleted or vault locked meanwhile
    if (!found.e.files.some(f => f.id === fileId)) return false;
    found.e.text[fileId] = String(text || '').replace(/\u0000/g, '').slice(0, 300000);
    this._suggestDetails(found.e);
    this.save();
    return true;
  }
  /** For a document missing its sender, date or reference, suggest them from its words (never overwrites). */
  _suggestDetails(e) {
    if (e.kind !== 'document' || e.suggestDone) return;
    const want = ['from', 'docDate', 'ref'].filter(k => !e[k]);
    if (!want.length) { delete e.suggest; return; }
    const sug = require('./letterinfo').suggest(Object.values(e.text || {}).join('\n\n'));
    const out = {};
    for (const k of want) if (sug[k]) out[k] = sug[k];
    if (Object.keys(out).length) e.suggest = out; else delete e.suggest;
  }
  /** Use the suggested details (use = true), or dismiss them. */
  useSuggestion(id, use) {
    const { e } = this._libFind(id);
    if (use && e.suggest) for (const [k, v] of Object.entries(e.suggest)) if (!e[k]) e[k] = k === 'docDate' ? cleanDate(v) : cleanString(v, 200);
    delete e.suggest; e.suggestDone = true; e.updatedAt = nowIso();
    this.save();
    return e;
  }
  /** Files whose text hasn't been read yet (for the background reader). Vault entries only while it's open. */
  libraryTextQueue() {
    const { normal, vault } = this._libLists();
    const out = [];
    for (const e of [...normal, ...(vault || [])]) for (const f of e.files) if (!(f.id in e.text)) out.push({ id: e.id, fileId: f.id, name: f.name });
    return out;
  }
  deleteLibraryEntry(id) {
    const { e, list, inVault } = this._libFind(id);
    list.splice(list.indexOf(e), 1);
    const bin = inVault ? (this.vault.libBin = this.vault.libBin || []) : this.data.libBin;
    bin.push({ entry: e, deletedAt: nowIso() });
    this.save();
    return true;
  }
  _libBinEntries() {
    return [...this.data.libBin.map(b => ({ b, list: this.data.libBin, inVault: false })),
      ...(this.vault ? (this.vault.libBin || []).map(b => ({ b, list: this.vault.libBin, inVault: true })) : [])];
  }
  libraryBinView(kind) { return this._libBinEntries().filter(x => !kind || x.b.entry.kind === kind).map(x => ({ id: x.b.entry.id, title: x.b.entry.title, kind: x.b.entry.kind, files: x.b.entry.files.length, deletedAt: x.b.deletedAt, inVault: x.inVault })); }
  restoreLibraryEntry(id) {
    const x = this._libBinEntries().find(y => y.b.entry.id === id);
    if (!x) throw new Error('Not found in the bin');
    x.list.splice(x.list.indexOf(x.b), 1);
    (x.inVault ? this.vault.library : this.data.library).push(x.b.entry);
    this.save();
    return true;
  }
  purgeLibraryEntry(id, { save = true } = {}) {
    const x = this._libBinEntries().find(y => y.b.entry.id === id);
    if (!x) return false;
    x.list.splice(x.list.indexOf(x.b), 1);
    const dir = this._assetDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (save) this.save();
    return true;
  }
  /** Move a whole document or data entry into the vault (or back out). */
  moveLibraryToVault(id, toVault) {
    if (!this.vault) throw Object.assign(new Error('Unlock the vault first.'), { code: 'VAULT_LOCKED' });
    const { e, list, inVault } = this._libFind(id);
    if (!!toVault === inVault) return e;
    for (const f of e.files) this._reseal(e.id, f.file, toVault ? sec.KEY_VAULT : sec.KEY_MASTER);
    list.splice(list.indexOf(e), 1);
    (toVault ? this.vault.library : this.data.library).push(e);
    this.save();
    return e;
  }
  /** Move entries between Documents and Data and/or into a folder. to: { kind?, folder? } (folder '' = no folder). */
  moveLibrary(ids, to) {
    const list = (Array.isArray(ids) ? ids : [ids]).map(String);
    const kind = to && LIBRARY_KINDS.includes(to.kind) ? to.kind : null;
    const folder = to && to.folder !== undefined ? cleanString(to.folder, 120) : undefined;
    let n = 0;
    for (const id of list) {
      const { e } = this._libFind(id);
      if (kind && e.kind !== kind) {
        if (kind === 'data') e.prevDocType = e.docType;
        e.kind = kind;
        e.docType = kind === 'document' ? (LIBRARY_DOC_TYPES.includes(e.prevDocType) ? e.prevDocType : 'Letter') : '';
      }
      if (folder !== undefined) e.folder = folder;
      if (to && to.caseName !== undefined) e.caseName = cleanString(to.caseName, 120);
      e.updatedAt = nowIso(); n++;
    }
    this.save();
    return n;
  }
  // ---------- highlights and notes on PDF pages ----------
  addMark(id, m) {
    const { e } = this._libFind(id);
    if (!e.files.some(f => f.id === m.fileId)) throw new Error('File not found');
    const mk = cleanMark(Object.assign({}, m, { id: uid(), createdAt: nowIso() }));
    if (!mk) throw new Error('That highlight is too small.');
    e.marks = e.marks || []; e.marks.push(mk); e.updatedAt = nowIso();
    this.save();
    return mk;
  }
  updateMark(id, markId, patch) {
    const { e } = this._libFind(id);
    const i = (e.marks || []).findIndex(x => x.id === markId);
    if (i < 0) throw new Error('Highlight not found');
    const next = cleanMark(Object.assign({}, e.marks[i], { note: patch.note !== undefined ? patch.note : e.marks[i].note, color: patch.color || e.marks[i].color }));
    e.marks[i] = next; e.updatedAt = nowIso();
    this.save();
    return next;
  }
  removeMark(id, markId) {
    const { e } = this._libFind(id);
    const n = (e.marks || []).length;
    e.marks = (e.marks || []).filter(x => x.id !== markId);
    if (e.marks.length === n) throw new Error('Highlight not found');
    e.updatedAt = nowIso();
    this.save();
    return true;
  }

  // ---------- letters you write ----------
  /** Your name and address for letters, and the addresses of people you've written to. */
  letterBook() {
    const st = this.data.settings;
    return { me: Object.assign({ name: '', address: '', phone: '', email: '' }, st.letterFrom || {}), addresses: Object.assign({}, this.data.addressBook || {}) };
  }
  rememberLetter(rep) {
    const st = this.data.settings;
    st.letterFrom = { name: cleanString(rep.fromName, 120), address: String(rep.fromAddress || '').slice(0, 600), phone: cleanString(rep.fromPhone, 60), email: cleanString(rep.fromEmail, 120) };
    if (rep.toName && rep.toAddress) {
      this.data.addressBook = this.data.addressBook || {};
      this.data.addressBook[cleanString(rep.toName, 200).toLowerCase()] = String(rep.toAddress).slice(0, 600);
    }
  }

  /** Answers typed into PDF forms, by box label, offered again for boxes with the same label. */
  formAnswers() { return Object.assign({}, this.data.formAnswers || {}); }
  rememberFormAnswers(byLabel) {
    const fa = this.data.formAnswers = this.data.formAnswers || {};
    for (const [k, v] of Object.entries(byLabel || {})) {
      const key = String(k).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
      if (!key) continue;
      const val = String(v ?? '').slice(0, 500);
      if (val) fa[key] = val; else delete fa[key];
    }
    const keys = Object.keys(fa); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete fa[k];
    this.save();
  }

  // ---------- cases and replies ----------
  _allLibrary() { const { normal, vault } = this._libLists(); return [...normal, ...(vault || [])]; }
  /** A later letter received in the same case counts as the reply to one you sent. */
  _replyTo(e, all) {
    if (!e.sent || !e.caseName) return null;
    const key = (x) => (x.docDate || (x.createdAt || '').slice(0, 10)) + '|' + (x.createdAt || '');
    return all.filter(x => x.id !== e.id && !x.sent && x.caseName === e.caseName && key(x) > key(e))
      .sort((a, b) => key(a).localeCompare(key(b)))[0] || null;
  }
  /** Reply status for sent letters: { id: { replyId, replyTitle } | waiting/overdue }. */
  replyStatus() {
    const all = this._allLibrary(), today = new Date().toISOString().slice(0, 10), out = {};
    for (const e of all) {
      if (!e.sent) continue;
      const rep = this._replyTo(e, all);
      out[e.id] = rep ? { replied: true, replyId: rep.id, replyTitle: rep.title, replyDate: rep.docDate }
        : e.replyDone ? { replied: true } : { replied: false, waiting: !!e.expectBy, overdue: !!(e.expectBy && e.expectBy < today) };
    }
    return out;
  }
  /** Cases with their letters, newest activity first. */
  libraryCases() {
    const all = this._allLibrary(), rs = this.replyStatus(), map = new Map();
    for (const e of all) {
      if (!e.caseName) continue;
      const k = e.caseName.toLowerCase();
      if (!map.has(k)) map.set(k, { name: e.caseName, ids: [], froms: new Set(), refs: new Set(), first: '', last: '', waiting: 0, overdue: 0, vault: 0 });
      const c = map.get(k);
      c.ids.push(e.id);
      if (e.from) c.froms.add(e.from);
      if (e.ref) c.refs.add(e.ref);
      const d = e.docDate || (e.createdAt || '').slice(0, 10);
      if (d && (!c.first || d < c.first)) c.first = d;
      if (d && d > c.last) c.last = d;
      const st = rs[e.id];
      if (st && !st.replied && st.waiting) { c.waiting++; if (st.overdue) c.overdue++; }
      if (this.vault && this.vault.library && this.vault.library.includes(e)) c.vault++;
    }
    return [...map.values()].map(c => Object.assign(c, { froms: [...c.froms], refs: [...c.refs], count: c.ids.length }))
      .sort((a, b) => b.last.localeCompare(a.last));
  }
  renameCase(from, to) {
    const f = cleanString(from, 120).toLowerCase(), t = cleanString(to, 120);
    if (!f) throw new Error('Which case?');
    let n = 0;
    for (const e of this._allLibrary()) if ((e.caseName || '').toLowerCase() === f) { e.caseName = t; e.updatedAt = nowIso(); n++; }
    this.save();
    return n;
  }

  // ---------- the same file twice ----------
  _fileSha(e, f) {
    if (!f.sha) { try { f.sha = crypto.createHash('sha256').update(this.readAttachment(e.id, f.file)).digest('hex'); this._shaChanged = true; } catch (_) { return ''; } }
    return f.sha;
  }
  /** Where a file with these exact bytes is already kept (documents and data; vault only while open). */
  findLibraryFiles(buffers) {
    const want = buffers.map(b => crypto.createHash('sha256').update(b).digest('hex'));
    const found = want.map(() => null);
    this._shaChanged = false;
    for (const e of this._allLibrary()) for (const f of e.files) {
      const h = this._fileSha(e, f);
      want.forEach((w, i) => { if (!found[i] && h && w === h) found[i] = { id: e.id, title: e.title, kind: e.kind, name: f.name }; });
    }
    if (this._shaChanged) this.save();
    return found;
  }

  /** Link (or unlink) documents/data to items, so they show on the items' pages. */
  linkLibrary(ids, assetId, on = true) {
    const aid = cleanString(assetId, 80);
    if (on && !this.getAsset(aid)) throw new Error('Item not found');
    let n = 0;
    for (const id of (Array.isArray(ids) ? ids : [ids]).map(String)) {
      const { e } = this._libFind(id);
      const has = e.assetIds.includes(aid);
      if (on && !has) { e.assetIds.push(aid); n++; }
      if (!on && has) { e.assetIds = e.assetIds.filter(x => x !== aid); n++; }
      e.updatedAt = nowIso();
    }
    this.save();
    return n;
  }
  /** Folders used in Data, for suggestions. */
  /** Mark entries to go (or stop going) in the inventory file for the phone. */
  setLibraryOnPhone(ids, on) {
    let n = 0;
    for (const id of ids) { const { e } = this._libFind(id); if (on) e.onPhone = true; else delete e.onPhone; n++; }
    this.save();
    return n;
  }
  /** Entries marked for the phone (vault ones only when asked and the vault is open). */
  phoneLibraryEntries(includeVault) {
    const { normal, vault } = this._libLists();
    return [...normal, ...(includeVault && vault ? vault : [])].filter(e => e.onPhone);
  }
  libraryFolders() { const s = new Set(); for (const e of this.libraryView('data')) if (e.folder) s.add(e.folder); return [...s].sort((a, b) => a.localeCompare(b)); }

  // ---------- words in item receipts, manuals and other documents (for search) ----------
  // Kept apart from the items: data.docText (normal) and the vault's docText (vault items and vault files).
  _docTextMap(asset, rec) {
    if (this.isVaultAsset(asset) || (rec && rec.vault)) { if (!this.vault) return null; return (this.vault.docText = this.vault.docText || {}); }
    return (this.data.docText = this.data.docText || {});
  }
  itemDocTextQueue() {
    const out = [];
    for (const a of this.allAssets()) for (const r of a.documents || []) {
      const map = this._docTextMap(a, r);
      if (map && !(r.id in map)) out.push({ assetId: a.id, fileId: r.id, file: r.file, name: (r.vault && this.vault && this.vault.fileMeta[r.id] && this.vault.fileMeta[r.id].name) || r.name });
    }
    return out;
  }
  setItemDocText(assetId, fileId, text) {
    const a = this.getAsset(assetId), r = a && a.documents.find(x => x.id === fileId);
    if (!r) return false;
    const map = this._docTextMap(a, r);
    if (!map) return false;
    map[fileId] = String(text || '').replace(/\u0000/g, '').slice(0, 300000);
    this.save();
    return true;
  }
  /** One search across items (details and the words in their documents), Documents and Data. */
  searchAll(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
    if (!words.length) return { items: [], library: [] };
    const snip = (body, w) => { const low = body.toLowerCase(), i = low.indexOf(w); return i < 0 ? '' : body.slice(Math.max(0, i - 60), i + w.length + 80).replace(/\s+/g, ' ').trim(); };
    const items = [];
    for (const a of this.allAssets()) {
      const d = a.details || {};
      const meta = [a.name, a.brand, a.model, a.serial, a.barcode, a.category, a.location, a.notes, a.supplier, (a.tags || []).join(' '), a.lentTo, a.soldTo, a.insurer, a.policyNumber, a.owner,
        d.reg, d.vin, d.engineNo, d.boatName, d.hin, d.mmsi, d.callSign, ...a.documents.map(r => r.vault ? '' : r.name)].filter(Boolean).join(' ').toLowerCase();
      const docs = a.documents.map(r => { const m = this._docTextMap(a, r); return { r, text: (m && m[r.id]) || '' }; }).filter(x => x.text);
      const body = docs.map(x => x.text).join('\n').toLowerCase();
      if (!words.every(w => meta.includes(w) || body.includes(w))) continue;
      const w = words.find(x => !meta.includes(x) && body.includes(x));
      let snippet = '', inDoc = '';
      if (w) { const hit = docs.find(x => x.text.toLowerCase().includes(w)); snippet = snip(hit.text, w); inDoc = hit.r.vault ? 'Vault file' : hit.r.name; }
      items.push({ id: a.id, snippet, inDoc });
    }
    const library = [...this.librarySearch('document', q), ...this.librarySearch('data', q)];
    return { items, library };
  }

  // ---------- date bought, suggested from when the photos were taken ----------
  /** Read the photo date of up to `limit` older photos that haven't been checked yet. Returns how many were checked. */
  backfillPhotoDates(limit = 25) {
    let n = 0;
    for (const a of this.allAssets()) {
      for (const p of a.photos) {
        if (p.takenAt !== undefined || p.vault) continue;
        try { p.takenAt = /\.jpe?g$/i.test(p.file) ? takenAt(this.readAttachment(a.id, p.file)) : ''; } catch (_) { p.takenAt = ''; }
        if (++n >= limit) { this.save(); return n; }
      }
    }
    if (n) this.save();
    return n;
  }
  /** The earliest photo date for an item with no date bought (null if none, or dismissed). */
  photoDateHint(a) {
    if (a.purchaseDate || (this.data.dismissedHints || []).includes(a.id)) return null;
    const d = a.photos.map(p => p.takenAt).filter(Boolean).sort()[0];
    return d || null;
  }
  dismissDateHint(id) {
    if (!Array.isArray(this.data.dismissedHints)) this.data.dismissedHints = [];
    if (!this.data.dismissedHints.includes(id)) this.data.dismissedHints.push(id);
    this.save();
  }

  // ---------- packing lists ----------
  _trip(id) { const t = this.data.trips.find(x => x.id === id); if (!t) throw new Error('Packing list not found'); return t; }
  saveTrip(input) {
    const existing = input.id ? this._trip(input.id) : null;
    const name = cleanString(input.name, 120);
    if (!name) throw new Error('Give the packing list a name, for example "Ardennes tour".');
    const t = existing || { id: uid(), items: [], extras: [], createdAt: nowIso() };
    t.name = name;
    t.startDate = cleanDate(input.startDate !== undefined ? input.startDate : t.startDate);
    t.endDate = cleanDate(input.endDate !== undefined ? input.endDate : t.endDate);
    if (t.startDate && t.endDate && t.endDate < t.startDate) throw new Error('The trip ends before it starts.');
    if (input.copyFrom) { const src = this._trip(input.copyFrom); t.items = src.items.map(i => ({ assetId: i.assetId, packed: false, back: false })); t.extras = src.extras.map(x => ({ id: uid(), text: x.text, packed: false, back: false })); }
    if (!existing) this.data.trips.push(t);
    this.save();
    return t;
  }
  deleteTrip(id) { this.data.trips = this.data.trips.filter(t => t.id !== id); this.save(); }
  setTripItems(id, ids) {
    const t = this._trip(id);
    const want = [...new Set((ids || []).map(String))].filter(x => this.getAsset(x) && !this.isVaultAsset(this.getAsset(x)));
    t.items = want.map(a => t.items.find(i => i.assetId === a) || { assetId: a, packed: false, back: false });
    this.save();
    return t;
  }
  addTripExtra(id, text) {
    const t = this._trip(id);
    const lines = String(text || '').split(/\r?\n/).map(x => cleanString(x, 120)).filter(Boolean).slice(0, 100);
    if (!lines.length) throw new Error('Type something to take.');
    for (const l of lines) t.extras.push({ id: uid(), text: l, packed: false, back: false });
    this.save();
    return t;
  }
  removeTripExtra(id, xid) { const t = this._trip(id); t.extras = t.extras.filter(x => x.id !== xid); this.save(); return t; }
  /** Tick or untick: which = 'packed' or 'back'; key = an item id or an extra's id. */
  tickTrip(id, key, which, on) {
    if (!['packed', 'back'].includes(which)) throw new Error('Unknown tick');
    const t = this._trip(id);
    const row = t.items.find(i => i.assetId === key) || t.extras.find(x => x.id === key);
    if (!row) throw new Error('Not on this list');
    row[which] = !!on;
    if (which === 'back' && on) row.packed = true;
    this.save();
    return t;
  }
  resetTrip(id, which) { const t = this._trip(id); for (const r of [...t.items, ...t.extras]) { if (!which || which === 'packed') r.packed = false; r.back = false; } this.save(); return t; }

  // ---------- spending by year ----------
  /** What you paid, by the year bought (items you own or owned; not borrowed ones). */
  spendingByYear() {
    const years = {};
    for (const a of this.allAssets()) {
      if (NOT_MINE.includes(a.status) || a.status === 'Given back' || a.purchasePrice === null || a.purchasePrice === undefined) continue;
      const y = a.purchaseDate ? a.purchaseDate.slice(0, 4) : 'Unknown';
      const e = years[y] = years[y] || { year: y, total: 0, count: 0, byCategory: {} };
      e.total += a.purchasePrice; e.count++;
      const c = a.category || 'Uncategorised';
      e.byCategory[c] = (e.byCategory[c] || 0) + a.purchasePrice;
    }
    return Object.values(years).sort((x, y) => (x.year === 'Unknown') - (y.year === 'Unknown') || y.year.localeCompare(x.year)) // newest year first, unknown last
      .map(e => Object.assign(e, { total: Math.round(e.total * 100) / 100, top: Object.entries(e.byCategory).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([c, v]) => ({ category: c, total: Math.round(v * 100) / 100 })) }));
  }

  // ---------- possible duplicates ----------
  /** Groups of items that look like the same thing entered twice. Pairs marked "not duplicates" are left out. */
  findDuplicates() {
    const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const items = this.allAssets().filter(a => !GONE.includes(a.status));
    const ignored = new Set(this.data.notDuplicates || []);
    const groups = [];
    const add = (reason, list) => {
      const ids = [...new Set(list.map(a => a.id))].sort();
      if (ids.length < 2) return;
      const key = ids.join('|');
      if (ignored.has(key) || groups.some(g => g.key === key)) return;
      groups.push({ key, reason, ids });
    };
    const by = (fn) => { const m = new Map(); for (const a of items) { const k = fn(a); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(a); } return [...m.values()].filter(l => l.length > 1); };
    for (const l of by(a => norm(a.serial).length >= 4 ? norm(a.serial) : '')) add('Same serial number', l);
    for (const l of by(a => norm(a.barcode).length >= 8 && (a.serial ? '' : norm(a.barcode)) )) add('Same barcode, no serial numbers', l);
    for (const l of by(a => norm(a.name) && a.purchasePrice !== null && a.purchasePrice !== undefined ? `${norm(a.name)}|${a.purchasePrice}` : '')) add('Same name and price paid', l);
    for (const l of by(a => norm(a.name) && a.purchaseDate ? `${norm(a.name)}|${a.purchaseDate}` : '')) add('Same name and date bought', l);
    return groups;
  }
  notDuplicates(ids) {
    const key = [...new Set((ids || []).map(String))].sort().join('|');
    if (!Array.isArray(this.data.notDuplicates)) this.data.notDuplicates = [];
    if (key && !this.data.notDuplicates.includes(key)) this.data.notDuplicates.push(key);
    this.save();
  }
  /** Merge items into `keepId`: photos, documents, service log and value history move across, empty
   *  details are filled in, notes are joined, and the others go to Deleted items. */
  mergeAssets(keepId, otherIds) {
    const keep = this.getAsset(keepId);
    if (!keep) throw new Error('Item not found');
    const others = (otherIds || []).map(String).filter(id => id !== keepId).map(id => this.getAsset(id)).filter(Boolean);
    if (!others.length) throw new Error('Choose the items to merge.');
    if ([keep, ...others].some(a => this.isVaultAsset(a))) throw new Error('Move the items out of the vault before merging them.');
    if ([keep, ...others].some(a => [...a.photos, ...a.documents].some(r => r.vault))) throw new Error('One of these items has files in the vault. Move them out of the vault first.');
    fs.mkdirSync(this._assetDir(keep.id), { recursive: true });
    for (const o of others) {
      for (const kind of ['photos', 'documents']) {
        for (const r of o[kind]) {
          const src = this.attachmentPath(o.id, r.file);
          if (!fs.existsSync(src)) continue;
          fs.copyFileSync(src, this.attachmentPath(keep.id, r.file)); // same key, so the sealed bytes copy as they are
          keep[kind].push(r);
        }
        o[kind] = [];
      }
      keep.service = keep.service.concat(o.service || []);
      keep.valueHistory = (keep.valueHistory || []).concat(o.valueHistory || []).sort((x, y) => x.date.localeCompare(y.date));
      for (const f of [...STRING_FIELDS, ...MONEY_FIELDS]) {
        if (f === 'notes' || f === 'name') continue;
        const empty = keep[f] === '' || keep[f] === null || keep[f] === undefined;
        if (empty && o[f] !== '' && o[f] !== null && o[f] !== undefined) keep[f] = o[f];
      }
      if (o.notes && !String(keep.notes || '').includes(o.notes)) keep.notes = cleanString([keep.notes, o.notes].filter(Boolean).join('\n'), MAX_STRING);
      keep.tags = [...new Set([...keep.tags, ...o.tags])];
      if (o.grab) keep.grab = true;
      for (const a of this.allAssets()) if (a.partOf === o.id) a.partOf = (keep.id === a.id || keep.partOf) ? '' : keep.id; // sets are one level deep
    }
    keep.updatedAt = nowIso();
    this.save();
    for (const o of others) this.deleteAsset(o.id);
    return keep;
  }
  /** Save the result of a recall check; matches already dismissed stay hidden. */
  saveRecallCheck(result) {
    const prev = this.data.recalls || {};
    const dismissed = Array.isArray(prev.dismissed) ? prev.dismissed : [];
    this.data.recalls = { checkedAt: nowIso(), checked: result.checked, skipped: result.skipped, errors: (result.errors || []).slice(0, 5), matches: result.matches.filter(m => !dismissed.includes(m.assetId + '|' + m.link)), dismissed };
    this.save();
    return this.data.recalls;
  }
  dismissRecall(assetId, link) {
    const r = this.data.recalls; if (!r) return;
    const key = assetId + '|' + link;
    if (!r.dismissed.includes(key)) r.dismissed.push(key);
    r.matches = r.matches.filter(m => m.assetId + '|' + m.link !== key);
    this.save();
  }
  deleteMany(ids) {
    let n = 0;
    for (const id of (ids || []).map(String)) if (this.deleteAsset(id)) n++;
    return n;
  }

  // ---------- spreadsheet import ----------
  /** Add items read from a spreadsheet. Duplicates: same name and serial number, or (with no
   *  serial) same name, location and purchase date. Saves once. */
  importItems(list, { skipDuplicates = true } = {}) {
    const key = (a) => {
      const n = String(a.name || '').trim().toLowerCase();
      return a.serial ? `${n}|s|${String(a.serial).trim().toLowerCase()}` : `${n}|${cleanLocation(a.location).toLowerCase()}|${cleanDate(a.purchaseDate)}`;
    };
    const have = new Set(this.allAssets().map(key));
    const res = { added: 0, duplicates: 0, names: [] };
    for (const it of (Array.isArray(list) ? list : []).slice(0, 20000)) {
      if (!it || !cleanString(it.name)) continue;
      const k = key(it);
      if (skipDuplicates && have.has(k)) { res.duplicates++; continue; }
      const st = STATUSES.find(x => x.toLowerCase() === String(it.status || '').trim().toLowerCase());
      const cond = CONDITIONS.find(x => x.toLowerCase() === String(it.condition || '').trim().toLowerCase());
      const a = this._normaliseAsset(Object.assign({}, it, { id: undefined, partOf: '', policyId: '', status: st || 'Owned', condition: cond || '', source: 'csv' }), null);
      if (a.currentValue !== null) a.valueHistory = [{ id: uid(), date: today(), value: a.currentValue, note: 'Imported from a spreadsheet' }];
      this.data.assets.push(a);
      this._learnLists(a);
      have.add(k);
      res.added++; if (res.names.length < 20) res.names.push(a.name);
    }
    this.save();
    return res;
  }

  // ---------- value over time ----------
  /** Add a dated valuation. If it's the newest one, it becomes the item's current value. */
  addValuation(id, v) {
    const a = this.getAsset(id);
    if (!a) throw new Error('Item not found');
    const date = cleanDate(v && v.date);
    const value = cleanMoney(v && v.value);
    if (!date) throw new Error('Enter the date of the valuation.');
    if (date > today()) throw new Error('The valuation date is in the future.');
    if (value === null) throw new Error('Enter the value in pounds, like 250 or 249.99.');
    const rec = { id: uid(), date, value, note: cleanString(v.note, 300) };
    a.valueHistory = (a.valueHistory || []).concat(rec).sort((x, y) => x.date.localeCompare(y.date));
    if (a.valueHistory[a.valueHistory.length - 1] === rec) a.currentValue = value;
    a.updatedAt = nowIso();
    this.save();
    return rec;
  }
  removeValuation(id, vid) {
    const a = this.getAsset(id);
    if (!a) throw new Error('Item not found');
    a.valueHistory = (a.valueHistory || []).filter(v => v.id !== vid);
    this.save();
  }

  // ---------- item sets: an item can be a part of one main item (one level only) ----------
  partsOf(id) { return this.allAssets().filter(a => a.partOf === id); }
  _checkPartOf(asset) {
    if (!asset.partOf) return;
    const main = this.getAsset(asset.partOf);
    if (!main || main.id === asset.id) { asset.partOf = ''; return; }
    if (main.partOf) throw new Error(`"${main.name}" is itself part of a set. Choose the main item of that set instead.`);
    if (this.partsOf(asset.id).length) throw new Error('This item has parts of its own, so it can\'t be part of another set.');
  }
  /** Make exactly these items the parts of `mainId` (items no longer listed stop being parts). */
  setParts(mainId, ids) {
    const main = this.getAsset(mainId);
    if (!main) throw new Error('Item not found');
    if (main.partOf) throw new Error(`"${main.name}" is part of another set, so it can't have parts.`);
    const want = new Set((Array.isArray(ids) ? ids : []).map(String).filter(id => id !== mainId));
    for (const id of want) {
      const a = this.getAsset(id);
      if (!a) continue;
      if (this.partsOf(id).length) throw new Error(`"${a.name}" has parts of its own, so it can't be part of this set.`);
    }
    for (const a of this.allAssets()) {
      if (want.has(a.id) && a.partOf !== mainId) { a.partOf = mainId; a.updatedAt = nowIso(); }
      else if (!want.has(a.id) && a.partOf === mainId) { a.partOf = ''; a.updatedAt = nowIso(); }
    }
    this.save();
    return this.partsOf(mainId).length;
  }
  /** ids plus the parts of any main item among them, without repeats. */
  withParts(ids) {
    const out = [];
    for (const id of ids) {
      if (!out.includes(id)) out.push(id);
      for (const p of this.partsOf(id)) if (!out.includes(p.id)) out.push(p.id);
    }
    return out;
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
    const rec = { id, file, name: safeFileName(originalName || file), addedAt: nowIso(), takenAt: takenAt(buffer) };
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
      type: VIDEO_EXT.has(ext) ? 'Video' : DOC_TYPES.includes(docType) ? docType : 'Other', addedAt: nowIso()
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
    if (kind === 'photo') rec.takenAt = cleanDate(p.takenAt) || takenAt(buf); // the phone sends the date, as shrinking a photo removes it
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
    if (Number(obj.version) > 5) throw new Error('This file was made by a newer version of OpenSafe Capture. Update OpenSafe on this PC and try again.');
    const res = { added: 0, updated: 0, unchanged: 0, photos: 0, documents: 0, errors: [], names: [], changes: 0, changeLines: [], skippedChanges: [] };
    const touched = new Map(); // item id -> when it was last edited before this import (null for new items)
    for (const it of obj.items.slice(0, 10000)) {
      try {
        if (!it || typeof it !== 'object') continue;
        const id = typeof it.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(it.id) ? it.id.toLowerCase() : null;
        if (id && this.inBin(id)) { res.errors.push(`${cleanString(it.name, 200) || 'An item'}: it's in the deleted items bin on this PC. Restore it first if you want to keep it, then import again.`); continue; }
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
      if (!asset && this.inBin(String(u.itemId).toLowerCase())) { res.skippedChanges.push(`${label}: it's in the deleted items bin. Restore it and import the file again to apply this change.`); continue; }
      if (!asset) {
        res.skippedChanges.push(this.data.vault && !this.vaultUnlocked()
          ? `${label}: not found. If it's in the vault, unlock the vault and import the file again.`
          : `${label}: not found on this PC.`);
        continue;
      }
      if (!baseline.has(asset.id)) baseline.set(asset.id, touched.has(asset.id) ? touched.get(asset.id) : asset.updatedAt);
      const base = baseline.get(asset.id);
      const c = (u.changes && typeof u.changes === 'object') ? u.changes : {};
      const files = [...(Array.isArray(u.photos) ? u.photos.slice(0, 100).map(p => ['photo', p]) : []), ...(Array.isArray(u.documents) ? u.documents.slice(0, 100).map(d => ['document', d]) : [])];
      const stale = !!(base && Date.parse(base) > Date.parse(u.at));
      if (stale && !files.length) {
        res.skippedChanges.push(`${asset.name}: "${cleanString(u.summary, 200) || 'change'}" was made on the phone before the item was last edited on this PC, so it wasn't applied.`);
        applied.add(uidL); this.data.appliedUpdates.push(uidL);
        continue;
      }
      if (stale && Object.keys(c).length) res.skippedChanges.push(`${asset.name}: details from "${cleanString(u.summary, 200) || 'change'}" are older than your last edit on this PC, so only its photos and receipts were added.`);
      if (!stale) {
        if (typeof c.location === 'string') asset.location = cleanLocation(c.location);
        for (const f of ['lentTo', 'lentContact', 'soldTo']) if (typeof c[f] === 'string') asset[f] = cleanString(c[f], 200);
        for (const f of ['lentDate', 'dueBack', 'soldDate']) if (typeof c[f] === 'string') asset[f] = cleanDate(c[f]);
        if (c.soldPrice !== undefined) asset.soldPrice = cleanMoney(c.soldPrice);
        if (typeof c.status === 'string' && STATUSES.includes(c.status)) asset.status = c.status;
      }
      const seen = new Set([...asset.photos, ...asset.documents].map(x => x.captureId).filter(Boolean));
      for (const [kind, f] of files) {
        if (!f || (f.id && seen.has(String(f.id)))) continue;
        try { this._writeAttachment(asset, kind, f); if (kind === 'photo') res.photos++; else res.documents++; } catch (e) { res.errors.push(`${asset.name}: ${e.message}`); }
      }
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
    if (patch.depreciation && typeof patch.depreciation === 'object') {
      const d = {};
      for (const [cat, v] of Object.entries(patch.depreciation)) {
        if (v === '' || v === null || v === undefined) continue;
        const n = Number(String(v).replace('%', '').trim());
        if (!Number.isFinite(n) || n <= 0 || n >= 100) throw new Error(`${cat}: enter a percentage between 0 and 100, or leave it blank.`);
        d[cleanString(cat, 200)] = Math.round(n * 10) / 10;
      }
      s.depreciation = d;
    }
    this.save();
    return s;
  }

  setLists(categories, locations) {
    const tidy = (arr) => [...new Set(arr.map(c => cleanString(c, 60)).filter(Boolean))];
    if (Array.isArray(categories) && tidy(categories).length) this.data.categories = tidy(categories);
    const tidyLoc = (arr) => [...new Set(arr.map(cleanLocation).filter(Boolean))];
    if (Array.isArray(locations) && tidyLoc(locations).length) this.data.locations = tidyLoc(locations);
    this.save();
  }

  // ---------- derived ----------
  reminders(today = new Date(), lookAheadDays) {
    const days = lookAheadDays || this.data.settings.reminderDays;
    const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const diff = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - t0) / 86400000);
    const out = [];
    for (const a of this.allAssets()) {
      if (GONE.includes(a.status)) continue;
      if (a.status === 'Borrowed' && a.returnBy) {
        const n = diff(a.returnBy);
        if (n <= days) out.push({ assetId: a.id, assetName: a.name, kind: 'Give back' + (a.borrowedFrom ? ` to ${a.borrowedFrom}` : ''), date: a.returnBy, daysLeft: n, source: 'item' });
      }
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
    const libAll = [...(this.data.library || []), ...((this.vault && this.vault.library) || [])];
    for (const e of libAll) {
      if (!e.sent || !e.expectBy || e.replyDone || this._replyTo(e, libAll)) continue;
      const n = diff(e.expectBy);
      if (n <= days) out.push({ libraryId: e.id, libraryKind: e.kind, assetName: e.title + (e.from ? ` (to ${e.from})` : ''), kind: n < 0 ? 'No reply yet' : 'Reply expected', date: e.expectBy, daysLeft: n });
    }
    for (const e of libAll) {
      if (!e.actBy || e.actDone) continue;
      const n = diff(e.actBy);
      if (n <= days) out.push({ libraryId: e.id, libraryKind: e.kind, assetName: e.title + (e.from ? ` (${e.from})` : ''), kind: 'Reply or act by', date: e.actBy, daysLeft: n });
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
    // Past terms: what each year cost and who with, to compare at renewal time.
    p.history = (existing && Array.isArray(existing.history) ? existing.history : []).filter(h => h && h.id);
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
  /** Record a renewal: the term that's ending goes into the premium history, and the policy gets the new details. */
  renewPolicy(id, input) {
    const p = this.data.policies.find(x => x.id === id);
    if (!p) throw new Error('Policy not found');
    const premium = cleanMoney(input.premium);
    const renewalDate = cleanDate(input.renewalDate);
    if (premium === null) throw new Error('Enter the new premium in pounds.');
    if (!renewalDate) throw new Error('Enter the date the new term ends (the next renewal date).');
    if (p.renewalDate && renewalDate <= p.renewalDate) throw new Error('The next renewal date should be after the current one.');
    p.history.push({ id: uid(), endedOn: p.renewalDate, insurer: p.insurer, policyNumber: p.policyNumber, premium: p.premium, excess: p.excess, coverLimit: p.coverLimit, note: cleanString(input.note, 300), recordedAt: nowIso() });
    const insurer = cleanString(input.insurer, 120);
    if (insurer) p.insurer = insurer;
    if (input.policyNumber !== undefined && cleanString(input.policyNumber, 80)) p.policyNumber = cleanString(input.policyNumber, 80);
    if (input.excess !== undefined && input.excess !== '') p.excess = cleanMoney(input.excess);
    p.premium = premium;
    p.renewalDate = renewalDate;
    this.save();
    return p;
  }
  /** Add an earlier year by hand (e.g. from old paperwork). */
  addPolicyHistory(id, input) {
    const p = this.data.policies.find(x => x.id === id);
    if (!p) throw new Error('Policy not found');
    const premium = cleanMoney(input.premium), endedOn = cleanDate(input.endedOn);
    if (premium === null || !endedOn) throw new Error('Enter the premium and the date that term ended.');
    p.history.push({ id: uid(), endedOn, insurer: cleanString(input.insurer, 120) || p.insurer, policyNumber: '', premium, excess: cleanMoney(input.excess), coverLimit: null, note: cleanString(input.note, 300), recordedAt: nowIso() });
    p.history.sort((x, y) => (x.endedOn || '').localeCompare(y.endedOn || ''));
    this.save();
    return p;
  }
  removePolicyHistory(id, hid) {
    const p = this.data.policies.find(x => x.id === id);
    if (!p) throw new Error('Policy not found');
    p.history = p.history.filter(h => h.id !== hid);
    this.save();
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
    const rates = this.data.settings.depreciation || {};
    const vn = (a) => valueNow(a, rates);
    const all = this.allAssets();
    const here = all.filter(a => !GONE.includes(a.status));
    const active = here.filter(a => !NOT_MINE.includes(a.status)); // what you own: used for values and insurance
    const sum = (k) => active.reduce((t, a) => t + (a[k] || 0), 0);
    const byOwner = {};
    for (const a of active) { if (!a.owner) continue; byOwner[a.owner] = byOwner[a.owner] || { count: 0, value: 0 }; byOwner[a.owner].count++; byOwner[a.owner].value += vn(a); }
    const byCategory = {};
    for (const a of active) {
      const c = a.category || 'Uncategorised';
      byCategory[c] = byCategory[c] || { count: 0, value: 0 };
      byCategory[c].count++;
      byCategory[c].value += vn(a);
    }
    // Value and count for every place, including the places that contain it ("Home" includes "Home / Garage").
    const byLocation = {};
    for (const a of active) {
      const parts = (a.location || '').split(' / ').filter(Boolean);
      const paths = parts.length ? parts.map((_, i) => parts.slice(0, i + 1).join(' / ')) : ['No location'];
      for (const p of paths) {
        byLocation[p] = byLocation[p] || { count: 0, value: 0 };
        byLocation[p].count++;
        byLocation[p].value += vn(a);
      }
    }
    const uninsured = active.filter(a => !a.insurer && !a.policyId && (a.currentValue ?? a.purchasePrice ?? 0) > 0).length;
    const noSerial = active.filter(a => !a.serial).length;
    const noReceipt = active.filter(a => !a.documents.some(d => d.type === 'Receipt')).length;
    return {
      count: active.length,
      borrowedCount: here.length - active.length,
      totalCount: all.length,
      purchaseTotal: sum('purchasePrice'),
      currentTotal: active.reduce((t, a) => t + vn(a), 0),
      estimatedCount: active.filter(a => (a.currentValue === null || a.currentValue === undefined) && estimateValue(a, rates) !== null).length,
      insuredTotal: sum('insuredValue'),
      byCategory, byLocation, byOwner, uninsured, noSerial, noReceipt
    };
  }

  toCSV() {
    const cols = ['name', 'category', 'location', 'brand', 'model', 'serial', 'status', 'condition',
      'purchaseDate', 'purchasePrice', 'supplier', 'currentValue', 'warrantyExpiry', 'insurer',
      'policyNumber', 'insuredValue', 'barcode', 'webLink', 'foreignCurrency', 'foreignPrice', 'owner', 'borrowedFrom', 'returnBy', 'lentTo', 'lentContact', 'lentDate', 'dueBack', 'soldDate', 'soldPrice', 'soldTo',
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
    this._vaultPlain = null;
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
    this.vault = { assets: [], fileMeta: {}, bin: [] };
    this.save();
    return true;
  }

  _openVault(vk) {
    this.keys[sec.KEY_VAULT] = vk;
    let v = { assets: [], fileMeta: {} };
    if (this.data.vault.blob) v = JSON.parse(sec.open(this.keys, Buffer.from(this.data.vault.blob, 'base64')).toString('utf8'));
    v.assets = Array.isArray(v.assets) ? v.assets.map(a => this._normaliseAsset(a, a, true)) : [];
    v.fileMeta = v.fileMeta && typeof v.fileMeta === 'object' ? v.fileMeta : {};
    v.bin = Array.isArray(v.bin) ? v.bin.filter(b => b && b.asset && b.asset.id).map(b => ({ asset: this._normaliseAsset(b.asset, b.asset, true), deletedAt: b.deletedAt || nowIso() })) : [];
    v.library = Array.isArray(v.library) ? v.library.filter(e => e && e.id).map(e => Object.assign(this._normaliseLibrary(e, e), { updatedAt: e.updatedAt || nowIso() })) : [];
    v.libBin = Array.isArray(v.libBin) ? v.libBin.filter(b => b && b.entry && b.entry.id) : [];
    v.docText = v.docText && typeof v.docText === 'object' ? v.docText : {};
    // forget names of vault files that no longer exist (items in the bin still count)
    const live = new Set();
    for (const a of [...this.data.assets, ...(this.data.bin || []).map(b => b.asset)]) for (const r of [...a.photos, ...a.documents]) if (r.vault) live.add(r.id);
    for (const id of Object.keys(v.fileMeta)) if (!live.has(id)) delete v.fileMeta[id];
    this.vault = v;
    this._vaultPlain = this.data.vault.blob ? this._vaultJson(v) : null;
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
    try { this.purgeOldBin(); } catch (_) { /* keep the vault opening */ }
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
    if ((this.vault.bin || []).length) throw new Error(`The vault's deleted items (${this.vault.bin.length}) are still in its bin. Restore them or delete them for good first.`);
    if ((this.vault.library || []).length) throw new Error(`Move the vault's documents and data (${this.vault.library.length}) out of the vault first.`);
    if ((this.vault.libBin || []).length) throw new Error(`The vault's deleted documents and data (${this.vault.libBin.length}) are still in its bin. Restore them or delete them for good first.`);
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

  _moveDocText(ids, toVault) {
    if (!this.vault) return;
    const from = toVault ? (this.data.docText = this.data.docText || {}) : (this.vault.docText = this.vault.docText || {});
    const to = toVault ? (this.vault.docText = this.vault.docText || {}) : (this.data.docText = this.data.docText || {});
    for (const id of ids) if (id in from) { to[id] = from[id]; delete from[id]; }
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
      this._moveDocText(normal.documents.map(r => r.id), true);
      this.data.assets.splice(this.data.assets.indexOf(normal), 1);
      this.vault.assets.push(normal);
      this.save();
      return normal;
    }
    if (!inVault) { if (normal) return normal; throw new Error('Item not found'); }
    for (const r of [...inVault.photos, ...inVault.documents]) this._reseal(id, r.file, sec.KEY_MASTER);
    this._moveDocText(inVault.documents.map(r => r.id), false);
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
      this._moveDocText([r.id], true);
    } else if (!toVault && r.vault) {
      this._reseal(assetId, r.file, sec.KEY_MASTER);
      r.name = (this.vault.fileMeta[r.id] && this.vault.fileMeta[r.id].name) || 'file';
      delete r.vault; delete this.vault.fileMeta[r.id];
      this._moveDocText([r.id], false);
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

module.exports = { LIBRARY_DOC_TYPES, VIDEO_EXT, GONE, NOT_MINE, Store, STATUSES, CONDITIONS, DOC_TYPES, POLICY_TYPES, DETAIL_FIELDS, cleanMoney, cleanDate, cleanLocation, inLocation, cleanUrl, estimateValue, valueNow, emptyData };
