'use strict';
// Watch a folder: files saved into it (by a scanner, a browser's downloads, Outlook "Save as") are
// added to Documents or Data, then moved into an "Added to OpenSafe" folder inside it, so nothing is
// added twice and you can see what was taken. A file is only taken once it has stopped growing.
// The setting belongs to this PC (it's a path on this PC), so it's kept in watch.json, not in the data.

const fs = require('fs');
const path = require('path');

const DONE = 'Added to OpenSafe';
// files still being written, or that aren't documents
const SKIP = /^(~\$|\.~|\._)|\.(tmp|temp|crdownload|part|partial|download|opdownload|lnk|ini|db)$|^(desktop\.ini|thumbs\.db|\.ds_store)$/i;

class FolderWatch {
  /**
   * @param localFile  where this PC's setting is kept
   * @param onFile     async (name, buffer, kind) -> 'added' | 'duplicate'  (throws to leave the file where it is)
   * @param canTake    () -> boolean   (false while OpenSafe is locked: files wait)
   */
  constructor(localFile, { onFile, canTake = () => true, onChange = () => {}, settleMs = 2500, everyMs = 15000 } = {}) {
    this.localFile = localFile; this.onFile = onFile; this.canTake = canTake; this.onChange = onChange;
    this.settleMs = settleMs; this.everyMs = everyMs;
    this.cfg = this._read();
    this.seen = new Map();   // name -> { size, mtimeMs, since }
    this.failed = new Map(); // name -> mtimeMs it failed at (not retried until the file changes)
    this.timer = null; this.fsw = null; this.busy = false; this.soon = null;
  }
  _read() { try { return JSON.parse(fs.readFileSync(this.localFile, 'utf8')) || {}; } catch (_) { return {}; } }
  _write() { fs.writeFileSync(this.localFile + '.tmp', JSON.stringify(this.cfg, null, 2)); fs.renameSync(this.localFile + '.tmp', this.localFile); }
  status() { return { folder: this.cfg.folder || '', kind: this.cfg.kind || 'document', added: this.cfg.added || 0, lastAt: this.cfg.lastAt || '', lastName: this.cfg.lastName || '', lastError: this.cfg.lastError || '', running: !!this.timer }; }

  set(folder, kind) {
    if (!folder) { this.stop(); this.cfg = {}; this._write(); return this.status(); }
    const f = path.resolve(folder);
    if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw new Error('That folder doesn\'t exist.');
    this.cfg = { folder: f, kind: kind === 'data' ? 'data' : 'document', added: 0 };
    this._write();
    this.start();
    return this.status();
  }
  start() {
    this.stop();
    if (!this.cfg.folder) return;
    this.timer = setInterval(() => this.scan().catch(() => {}), this.everyMs);
    try { this.fsw = fs.watch(this.cfg.folder, () => { clearTimeout(this.soon); this.soon = setTimeout(() => this.scan().catch(() => {}), this.settleMs + 200); }); } catch (_) { this.fsw = null; } // the timer still works
    this.scan().catch(() => {});
  }
  stop() { clearInterval(this.timer); this.timer = null; clearTimeout(this.soon); if (this.fsw) { try { this.fsw.close(); } catch (_) {} this.fsw = null; } }

  /** Look once: take files that have stopped changing. */
  async scan(now = Date.now()) {
    if (this.busy || !this.cfg.folder) return [];
    this.busy = true;
    const taken = [];
    try {
      if (!fs.existsSync(this.cfg.folder)) { this._err('The watched folder can\'t be found. Is the drive connected?'); return taken; }
      for (const d of fs.readdirSync(this.cfg.folder, { withFileTypes: true })) {
        if (!d.isFile() || SKIP.test(d.name)) continue;
        const p = path.join(this.cfg.folder, d.name);
        let st; try { st = fs.statSync(p); } catch (_) { continue; }
        if (!st.size) continue;
        if (this.failed.get(d.name) === st.mtimeMs) continue;
        const prev = this.seen.get(d.name);
        if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) { this.seen.set(d.name, { size: st.size, mtimeMs: st.mtimeMs, since: now }); continue; }
        if (now - prev.since < this.settleMs) continue;
        if (!this.canTake()) continue; // locked: try again later
        try {
          const how = await this.onFile(d.name, fs.readFileSync(p), this.cfg.kind);
          this._moveAside(p, d.name);
          this.seen.delete(d.name);
          if (how === 'added') { this.cfg.added = (this.cfg.added || 0) + 1; this.cfg.lastAt = new Date(now).toISOString(); this.cfg.lastName = d.name; }
          this.cfg.lastError = '';
          this._write();
          taken.push({ name: d.name, how });
        } catch (e) {
          this.failed.set(d.name, st.mtimeMs);
          this._err(`${d.name}: ${e.message}`);
        }
      }
    } finally { this.busy = false; }
    if (taken.length) this.onChange(taken);
    return taken;
  }
  _moveAside(p, name) {
    const dir = path.join(this.cfg.folder, DONE);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
    let dest = path.join(dir, name);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${base} (${i})${ext}`);
    fs.renameSync(p, dest);
  }
  _err(msg) { if (this.cfg.lastError !== msg) { this.cfg.lastError = msg; try { this._write(); } catch (_) {} this.onChange([]); } }
}

module.exports = { FolderWatch, DONE };
