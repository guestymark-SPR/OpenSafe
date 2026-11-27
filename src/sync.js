'use strict';
// Keep two PCs in step through a shared folder (OneDrive, Dropbox, a network drive).
//
// The whole inventory is handed over, not merged: whichever PC changed things last puts its copy
// in the folder, and the other PC takes it the next time it looks. The files copied are the ones
// OpenSafe keeps on disk (the data file, security.json and the attachments folder), so with
// password protection on, everything in the shared folder stays encrypted, and the sync works
// even while OpenSafe is locked. If both PCs changed things since they were last in step, nothing
// is overwritten: OpenSafe asks which copy to keep and saves the other as a backup.
//
// Shared folder:  <folder>/OpenSafe sync/state.json     (written last; says what a complete copy is)
//                                       /data/...        (opensafe-data.json or .bin, security.json)
//                                       /attachments/... (same layout as on the PC)
// This PC:        <data dir>/sync.json                   (never copied)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SUB = 'OpenSafe sync';
const FORMAT = 'opensafe-sync';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function hashFile(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile() && !e.name.endsWith('.tmp')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
function copyAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}
const inside = (child, parent) => { const r = path.relative(parent, child); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };

class Sync {
  /** @param store the Store (only its files and, when loaded, its data are used) */
  constructor(store, { deviceName = os.hostname() } = {}) {
    this.store = store;
    this.localFile = path.join(store.dir, 'sync.json');
    this.cfg = this._readLocal();
    if (!this.cfg.deviceId) { this.cfg.deviceId = crypto.randomUUID(); this.cfg.deviceName = deviceName; this._writeLocal(); }
    this.cfg.deviceName = this.cfg.deviceName || deviceName;
  }
  _readLocal() { try { return JSON.parse(fs.readFileSync(this.localFile, 'utf8')) || {}; } catch (_) { return {}; } }
  _writeLocal() { const t = this.localFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(this.cfg, null, 2)); fs.renameSync(t, this.localFile); }

  enabled() { return !!this.cfg.folder; }
  remoteDir() { return this.cfg.folder ? path.join(this.cfg.folder, SUB) : null; }
  readRemote() {
    const d = this.remoteDir();
    if (!d) return null;
    try { const s = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8')); return s && s.format === FORMAT ? s : null; } catch (_) { return null; }
  }
  /** What this PC has that matters (empty = nothing to lose). */
  localHasData() {
    const d = this.store.data;
    if (d) return d.assets.length + (d.library || []).length + (d.policies || []).length + (d.bin || []).length > 0 || !!d.vault;
    return this.store.isEncrypted() || walk(this.store.attachDir).length > 0; // locked: can't look inside, so assume yes
  }
  contentHash() { return this.store.data ? sha(JSON.stringify(this.store.data)) : null; }

  // ---- called by the app ----
  /** After the data is read (start-up, unlock, or after taking the other PC's copy). */
  afterLoad() {
    if (!this.enabled() || !this.store.data) return;
    const h = this.contentHash();
    if (!this.cfg.syncedHash) { this.cfg.syncedHash = h; this._writeLocal(); }
    else if (h !== this.cfg.syncedHash && !this.cfg.dirty) { this.cfg.dirty = true; this._writeLocal(); }
  }
  /** After every save: has anything really changed since the PCs were last in step? */
  noteSaved() {
    if (!this.enabled() || !this.store.data) return false;
    if (!this.cfg.syncedHash) return false; // not read yet since the last hand-over: afterLoad() decides
    const changed = this.contentHash() !== this.cfg.syncedHash;
    if (changed !== !!this.cfg.dirty) { this.cfg.dirty = changed; this._writeLocal(); }
    return changed;
  }

  /**
   * Work out what to do: 'none', 'push' (this PC has the newer copy), 'pull' (the other PC has),
   * 'conflict' (both changed), 'first' (the shared folder already has a copy and this PC hasn't
   * been in step with it before), or 'wait' (the shared folder is still being copied in).
   */
  plan() {
    if (!this.enabled()) return { action: 'none' };
    if (!fs.existsSync(this.cfg.folder)) return { action: 'wait', why: 'The shared folder can\'t be found. Is the drive or OneDrive available?' };
    const remote = this.readRemote();
    if (!remote) return { action: 'push', first: true };
    const remoteChanged = remote.rev !== this.cfg.lastRev, localChanged = !!this.cfg.dirty;
    const who = { by: remote.by, at: remote.at };
    if (remote.by && remote.by.id === this.cfg.deviceId && remoteChanged && !this.cfg.lastRev) return { action: 'push', ...who }; // our own copy, sync.json lost
    if (!this.cfg.lastRev) return { action: this.localHasData() ? 'first' : 'pull', ...who };
    if (remoteChanged && localChanged) return { action: 'conflict', ...who };
    if (remoteChanged) return this.remoteComplete(remote) ? { action: 'pull', ...who } : { action: 'wait', why: 'The other PC\'s copy is still arriving in the shared folder.', ...who };
    if (localChanged) return { action: 'push' };
    return { action: 'none', ...who };
  }

  /** Are all the files the other PC listed there yet, at the right size? */
  remoteComplete(remote) {
    const d = this.remoteDir();
    const ok = (rel, size) => { try { return fs.statSync(path.join(d, rel)).size === size; } catch (_) { return false; } };
    return ok('data/' + remote.data.name, remote.data.size) && (!remote.security || ok('data/security.json', remote.security.size)) &&
      remote.files.every(f => ok('attachments/' + f.p, f.size));
  }

  _localHash(rel) {
    const p = path.join(this.store.attachDir, rel);
    const st = fs.statSync(p);
    this.cfg.hashes = this.cfg.hashes || {};
    const c = this.cfg.hashes[rel];
    if (c && c[0] === st.size && c[1] === st.mtimeMs) return { size: st.size, h: c[2] };
    const h = hashFile(p);
    this.cfg.hashes[rel] = [st.size, st.mtimeMs, h];
    return { size: st.size, h };
  }
  _dataFile() {
    const s = this.store;
    if (s.isEncrypted() && fs.existsSync(s.binFile)) return s.binFile;
    if (fs.existsSync(s.file)) return s.file;
    return null;
  }

  /** Put this PC's copy in the shared folder. */
  push() {
    const d = this.remoteDir(), st = this.store;
    if (!d) throw new Error('Choose a shared folder first.');
    const dataFile = this._dataFile();
    if (!dataFile) throw new Error('There\'s nothing to copy yet.');
    fs.mkdirSync(path.join(d, 'attachments'), { recursive: true });
    fs.mkdirSync(path.join(d, 'data'), { recursive: true });
    const before = this.readRemote();
    const had = new Map(((before && before.files) || []).map(f => [f.p, f]));
    const files = [];
    let copied = 0;
    for (const rel of walk(st.attachDir)) {
      const { size, h } = this._localHash(rel);
      files.push({ p: rel, size, h });
      const prev = had.get(rel), dest = path.join(d, 'attachments', rel);
      let there = false;
      try { there = prev && prev.h === h && fs.statSync(dest).size === size; } catch (_) { there = false; }
      if (!there) { copyAtomic(path.join(st.attachDir, rel), dest); copied++; }
    }
    const dataBuf = fs.readFileSync(dataFile);
    const name = path.basename(dataFile);
    copyAtomic(dataFile, path.join(d, 'data', name));
    for (const other of ['opensafe-data.json', 'opensafe-data.bin']) if (other !== name) fs.rmSync(path.join(d, 'data', other), { force: true });
    let security = null;
    if (fs.existsSync(st.securityFile)) { const b = fs.readFileSync(st.securityFile); copyAtomic(st.securityFile, path.join(d, 'data', 'security.json')); security = { size: b.length, h: sha(b) }; }
    else fs.rmSync(path.join(d, 'data', 'security.json'), { force: true });
    const state = {
      format: FORMAT, version: 1, rev: crypto.randomUUID(), prev: before ? before.rev : null, at: new Date().toISOString(),
      by: { id: this.cfg.deviceId, name: this.cfg.deviceName }, encrypted: !!security,
      data: { name, size: dataBuf.length, h: sha(dataBuf) }, security, files
    };
    const sp = path.join(d, 'state.json');
    fs.writeFileSync(sp + '.tmp', JSON.stringify(state)); fs.renameSync(sp + '.tmp', sp);
    // files the other copy had that this one doesn't
    const keep = new Set(files.map(f => f.p));
    let removed = 0;
    for (const rel of walk(path.join(d, 'attachments'))) if (!keep.has(rel)) { fs.rmSync(path.join(d, 'attachments', rel), { force: true }); removed++; }
    Object.assign(this.cfg, { lastRev: state.rev, dirty: false, lastSyncAt: state.at, lastError: '', lastAction: 'push' });
    if (st.data) this.cfg.syncedHash = this.contentHash();
    this._writeLocal();
    return { pushed: true, copied, removed, files: files.length };
  }

  /**
   * Take the other PC's copy. Every file is copied in and checked before anything here is
   * replaced; the data file goes last. The caller reloads (or locks) OpenSafe afterwards.
   */
  pull() {
    const d = this.remoteDir(), st = this.store;
    const remote = this.readRemote();
    if (!remote) throw new Error('There\'s no copy in the shared folder yet.');
    if (!this.remoteComplete(remote)) { const e = new Error('The other PC\'s copy is still arriving in the shared folder. Try again in a minute.'); e.code = 'WAIT'; throw e; }
    const stage = path.join(st.dir, 'sync-incoming');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const bad = () => { fs.rmSync(stage, { recursive: true, force: true }); const e = new Error('The other PC\'s copy is still arriving in the shared folder (a file didn\'t match). Try again in a minute.'); e.code = 'WAIT'; return e; };
    try {
      // 1. attachments this PC doesn't have yet, checked against the list
      const want = [];
      for (const f of remote.files) {
        let same = false;
        try { same = this._localHash(f.p).h === f.h; } catch (_) { same = false; }
        if (same) continue;
        const tmp = path.join(stage, 'attachments', f.p);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.copyFileSync(path.join(d, 'attachments', f.p), tmp);
        if (hashFile(tmp) !== f.h) throw bad();
        want.push(f.p);
      }
      const dataTmp = path.join(stage, remote.data.name);
      fs.copyFileSync(path.join(d, 'data', remote.data.name), dataTmp);
      if (hashFile(dataTmp) !== remote.data.h) throw bad();
      let secTmp = null;
      if (remote.security) {
        secTmp = path.join(stage, 'security.json');
        fs.copyFileSync(path.join(d, 'data', 'security.json'), secTmp);
        if (hashFile(secTmp) !== remote.security.h) throw bad();
      }
      // 2. everything is here and correct: put it in place
      for (const rel of want) { const dest = path.join(st.attachDir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(path.join(stage, 'attachments', rel), dest); }
      const keep = new Set(remote.files.map(f => f.p));
      let removed = 0;
      for (const rel of walk(st.attachDir)) if (!keep.has(rel)) { fs.rmSync(path.join(st.attachDir, rel), { force: true }); removed++; }
      if (secTmp) fs.renameSync(secTmp, st.securityFile); else fs.rmSync(st.securityFile, { force: true });
      const target = remote.data.name === 'opensafe-data.bin' ? st.binFile : st.file;
      fs.renameSync(dataTmp, target);
      for (const other of [st.file, st.binFile]) if (other !== target) fs.rmSync(other, { force: true });
      fs.rmSync(stage, { recursive: true, force: true });
      this.cfg.hashes = {}; // rebuilt as needed
      Object.assign(this.cfg, { lastRev: remote.rev, dirty: false, syncedHash: null, lastSyncAt: new Date().toISOString(), lastError: '', lastAction: 'pull' });
      this._writeLocal();
      return { pulled: true, copied: want.length, removed, from: remote.by, encrypted: !!remote.security };
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw e;
    }
  }

  /** Save the shared folder's copy as a normal OpenSafe backup folder (before this PC's replaces it). */
  saveRemoteAsBackup(destParent) {
    const d = this.remoteDir(), remote = this.readRemote();
    if (!remote) return null;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const who = String((remote.by && remote.by.name) || 'other PC').replace(/[^\w .-]+/g, '').slice(0, 40) || 'other PC';
    const dest = path.join(destParent, `OpenSafe-backup-${stamp} from ${who}`);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(d, 'data', remote.data.name), path.join(dest, remote.data.name));
    if (remote.security) fs.copyFileSync(path.join(d, 'data', 'security.json'), path.join(dest, 'security.json'));
    if (fs.existsSync(path.join(d, 'attachments'))) fs.cpSync(path.join(d, 'attachments'), path.join(dest, 'attachments'), { recursive: true });
    return dest;
  }

  setFolder(folder) {
    if (!folder) { Object.assign(this.cfg, { folder: '', lastRev: null, syncedHash: null, dirty: false, hashes: {}, lastError: '' }); this._writeLocal(); return; }
    const f = path.resolve(folder);
    if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw new Error('That folder doesn\'t exist.');
    if (inside(f, this.store.dir) || inside(this.store.dir, f)) throw new Error('Choose a folder outside OpenSafe\'s own data folder, such as one in OneDrive.');
    Object.assign(this.cfg, { folder: f, lastRev: null, syncedHash: null, dirty: false, hashes: {}, lastError: '' });
    this._writeLocal();
  }
  setError(msg) { this.cfg.lastError = String(msg || ''); this._writeLocal(); }
  status() {
    const remote = this.readRemote();
    return {
      enabled: this.enabled(), folder: this.cfg.folder || '', device: this.cfg.deviceName, lastSyncAt: this.cfg.lastSyncAt || '', lastAction: this.cfg.lastAction || '',
      dirty: !!this.cfg.dirty, lastError: this.cfg.lastError || '', conflict: !!this.cfg.conflict,
      remote: remote ? { by: remote.by && remote.by.name, mine: !!(remote.by && remote.by.id === this.cfg.deviceId), at: remote.at, encrypted: remote.encrypted, inStep: remote.rev === this.cfg.lastRev } : null
    };
  }
}

module.exports = { Sync, SUB };
