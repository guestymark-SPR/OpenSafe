'use strict';
/* OpenSafe Capture: add items on a phone or tablet, export them as one .opensafe file,
   import that file into OpenSafe on the PC. Everything is stored on this device
   (IndexedDB) until exported. No server, no account. */
(function () {
  const $ = (id) => document.getElementById(id);
  const FORMAT = 'opensafe-export';
  const FORMAT_VERSION = 1;          // items only
  const FORMAT_VERSION_CHANGES = 2;  // items plus changes from scanning labels (needs OpenSafe 1.6 or later)
  const FORMAT_VERSION_FILES = 3;    // changes that carry photos or receipts (needs OpenSafe 1.8 or later)
  const FORMAT_VERSION_DOCS = 4;     // scanned documents (needs OpenSafe 2.6 or later)
  const DEFAULT_CATS = ['Vehicles', 'Electronics', 'Computers & Phones', 'Tools', 'Camping & Outdoor', 'Motorbike Gear', 'Marine', 'Furniture', 'Appliances', 'Jewellery & Watches', 'Sports & Hobbies', 'Clothing', 'Other'];
  const DEFAULT_LOCS = ['Home', 'Garage', 'Car', 'Storage', 'Boat'];
  const FIELDS = ['name', 'category', 'location', 'brand', 'model', 'serial', 'barcode', 'webLink', 'condition', 'purchasePrice', 'currentValue', 'purchaseDate', 'warrantyExpiry', 'supplier', 'notes', 'tags'];

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('opensafe-capture', 3);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); // the encrypted inventory file from the PC
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' }); // scanned documents (pages as pictures)
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('items', mode);
      const store = t.objectStore('items');
      let out;
      Promise.resolve(fn(store)).then(v => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage error'));
    });
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const allItems = () => tx('readonly', s => req(s.getAll()));
  const putItem = (item) => tx('readwrite', s => req(s.put(item)));
  const delItem = (id) => tx('readwrite', s => req(s.delete(id)));

  async function kvGet(k) { const d = await db(); return new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function kvSet(k, v) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); if (v === undefined) t.objectStore('kv').delete(k); else t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ukDate = (s) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  const todayLocal = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const gbp = (v) => { const n = Number(String(v || '').replace(/[£,\s]/g, '')); return v !== '' && Number.isFinite(n) ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n) : ''; };

  // ---------- UI helpers ----------
  function toast(msg, ms = 2800) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function sheet(html) { $('sheetBody').innerHTML = html; $('sheet').classList.remove('hidden'); }
  function closeSheet() { $('sheet').classList.add('hidden'); $('sheetBody').innerHTML = ''; }
  const urls = [];
  function blobUrl(b) { const u = URL.createObjectURL(b); urls.push(u); return u; }
  function freeUrls() { while (urls.length) URL.revokeObjectURL(urls.pop()); }

  // ---------- images ----------
  // The date a photo was taken, from its EXIF data (JPEG). Read before shrinking, which removes it.
  // Same rules as the PC's src/exif.js. Returns 'YYYY-MM-DD' or ''.
  async function photoDate(file) {
    try {
      if (!/jpe?g/i.test(file.type || file.name || '')) return '';
      const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
      if (v.getUint16(0) !== 0xffd8) return '';
      let i = 2;
      while (i + 4 < v.byteLength && v.getUint8(i) === 0xff) {
        const marker = v.getUint8(i + 1), len = v.getUint16(i + 2);
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0xe1 && v.getUint32(i + 4) === 0x45786966 && v.getUint16(i + 8) === 0) {
          const start = i + 10, end = Math.min(v.byteLength, start + len - 8);
          const le = v.getUint16(start) === 0x4949;
          const u16 = (o) => start + o + 2 <= end ? v.getUint16(start + o, le) : 0;
          const u32 = (o) => start + o + 4 <= end ? v.getUint32(start + o, le) : 0;
          if (u16(2) !== 42) return '';
          const str = (o) => { let t = ''; for (let k = 0; k < 19 && start + o + k < end; k++) t += String.fromCharCode(v.getUint8(start + o + k)); return t; };
          const ifd = (off) => { const tags = {}; const n = u16(off); if (!n || n > 500) return tags; for (let k = 0; k < n; k++) { const e = off + 2 + k * 12; const tag = u16(e), type = u16(e + 2), count = u32(e + 4); if (type === 2 && count >= 19 && count <= 64) tags[tag] = str(u32(e + 8)); else if (type === 4) tags[tag] = u32(e + 8); } return tags; };
          const i0 = ifd(u32(4)); const ex = i0[0x8769] ? ifd(i0[0x8769]) : {};
          for (const val of [ex[0x9003], ex[0x9004], i0[0x0132]]) { const m = typeof val === 'string' && val.match(/^(\d{4}):(\d{2}):(\d{2})/); if (m && m[1] >= '1990' && m[2] >= '01' && m[2] <= '12' && m[3] >= '01' && m[3] <= '31') return `${m[1]}-${m[2]}-${m[3]}`; }
          return '';
        }
        i += 2 + len;
      }
    } catch (_) { /* unusual file */ }
    return '';
  }

  async function shrink(file, max = 2000) {
    const isImg = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
    if (!isImg) return { blob: file, name: file.name || 'file', type: file.type || 'application/octet-stream' };
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) throw new Error('encode');
      return { blob, name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg' };
    } catch (_) {
      return { blob: file, name: file.name || 'photo.jpg', type: file.type || 'image/jpeg' };
    }
  }

  // ---------- state ----------
  let items = [];
  let updates = []; // changes made by scanning a label, waiting to go to the PC
  async function loadUpdates() { updates = (await kvGet('updates')) || []; }
  let editing = null; // item being edited (copy)
  let deferredInstall = null;

  function learnedLists() {
    const cats = new Set(DEFAULT_CATS), locs = new Set(DEFAULT_LOCS);
    for (const it of [...items, ...((inv && inv.items) || [])]) { if (it.category) cats.add(it.category); if (it.location) locs.add(it.location); }
    for (const u of updates) if (u.changes && u.changes.location) locs.add(u.changes.location);
    const fill = (el, vals) => el.replaceChildren(...[...vals].map(v => { const o = document.createElement('option'); o.value = v; return o; }));
    fill($('cats'), cats); fill($('locs'), locs);
  }

  // ---------- views ----------
  function showHome() {
    editing = null;
    $('tabs').classList.remove('hidden');
    if (tab === 'inv') { showInv(); return; }
    $('form').classList.add('hidden'); $('home').classList.remove('hidden');
    $('fab').classList.remove('hidden'); $('backBtn').classList.add('hidden'); $('logo').classList.remove('hidden');
    $('title').textContent = 'OpenSafe Capture';
    $('subtitle').textContent = 'Items stay on this device until you export';
    renderList();
    window.scrollTo(0, 0);
  }

  async function renderList() {
    items = (await allItems()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    freeUrls();
    await loadUpdates();
    docs = (await allDocs().catch(() => [])).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pending = items.filter(i => !i.exportedAt);
    const pendU = updates.filter(u => !u.exportedAt);
    const pendD = docs.filter(d => !d.exportedAt);
    $('pendingCount').textContent = [`${pending.length} item${pending.length === 1 ? '' : 's'}`, pendU.length && `${pendU.length} change${pendU.length === 1 ? '' : 's'}`, pendD.length && `${pendD.length} document${pendD.length === 1 ? '' : 's'}`].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1');
    $('pendingText').textContent = (pending.length || pendU.length || pendD.length) ? 'ready to export' : ((items.length || updates.length || docs.length) ? 'everything has been exported' : 'ready to export');
    $('exportBtn').disabled = !pending.length && !pendU.length && !pendD.length;
    $('empty').classList.toggle('hidden', items.length > 0 || updates.length > 0 || docs.length > 0);
    $('docsBox').classList.toggle('hidden', !docs.length);
    $('docList').replaceChildren(...docs.map(d => {
      const el = document.createElement('div'); el.className = 'item'; el.dataset.doc = d.id;
      el.innerHTML = `${d.pages[0] ? `<img src="${blobUrl(d.pages[0].blob)}" alt="">` : '<div class="ph">📄</div>'}<div class="t"><div class="n">${esc(d.title)}</div><div class="m">${esc([d.docType, d.from].filter(Boolean).join(' · ')) || '&nbsp;'}</div><div class="m">${d.pages.length} page${d.pages.length === 1 ? '' : 's'}</div></div>${d.exportedAt ? '<span class="pill done">Exported</span>' : '<span class="pill">New</span>'}`;
      return el;
    }));
    $('changes').classList.toggle('hidden', !updates.length);
    $('itemsHead').classList.toggle('hidden', !items.length);
    $('changeList').replaceChildren(...updates.slice().sort((a, b) => b.at.localeCompare(a.at)).map(u => {
      const d = document.createElement('div'); d.className = 'change'; d.dataset.change = u.id;
      const when = new Date(u.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      d.innerHTML = `<div class="t"><div class="n">${esc(u.itemName || itemInfo(u.itemId).name)}</div><div class="m">${esc(u.summary)}${u.note && u.kind !== 'note' ? ' · ' + esc(u.note) : ''}</div><div class="m">${esc(when)}</div></div>${u.exportedAt ? '<span class="pill done">Exported</span>' : '<span class="pill">New</span>'}`;
      return d;
    }));
    $('list').replaceChildren(...items.map(it => {
      const d = document.createElement('div'); d.className = 'item'; d.dataset.id = it.id;
      const thumb = it.photos[0] ? `<img src="${blobUrl(it.photos[0].blob)}" alt="">` : '<div class="ph">▣</div>';
      const meta = [it.category, it.location, gbp(it.currentValue || it.purchasePrice)].filter(Boolean).join(' · ');
      d.innerHTML = `${thumb}<div class="t"><div class="n">${esc(it.name)}</div><div class="m">${esc(meta) || '&nbsp;'}</div>
        <div class="m">${it.photos.length} photo${it.photos.length === 1 ? '' : 's'}${it.receipts.length ? ' · ' + it.receipts.length + ' receipt' + (it.receipts.length > 1 ? 's' : '') : ''}</div></div>
        ${it.exportedAt ? '<span class="pill done">Exported</span>' : '<span class="pill">New</span>'}`;
      return d;
    }));
    learnedLists();
  }

  function showForm(item) {
    editing = item ? JSON.parse(JSON.stringify({ ...item, photos: [], receipts: [] })) : { id: uid(), createdAt: new Date().toISOString(), exportedAt: null };
    editing.photos = item ? item.photos.slice() : [];
    editing.receipts = item ? item.receipts.slice() : [];
    const f = $('form');
    f.reset();
    for (const k of FIELDS) if (f.elements[k]) f.elements[k].value = item ? (item[k] || '') : '';
    $('formErr').classList.add('hidden');
    $('deleteBtn').classList.toggle('hidden', !item);
    $('saveBtn').textContent = item ? 'Save changes' : 'Save item';
    $('home').classList.add('hidden'); $('inv').classList.add('hidden'); $('tabs').classList.add('hidden'); f.classList.remove('hidden');
    $('fab').classList.add('hidden'); $('backBtn').classList.remove('hidden'); $('logo').classList.add('hidden');
    $('title').textContent = item ? 'Edit item' : 'New item';
    $('subtitle').textContent = item && item.exportedAt ? 'Already exported: changes go in your next export' : 'Saved on this device';
    renderPhotos(); renderReceipts();
    window.scrollTo(0, 0);
    if (!item) setTimeout(() => f.elements.name.focus(), 50);
  }

  function renderPhotos() {
    $('thumbs').replaceChildren(...editing.photos.map((p, i) => {
      const d = document.createElement('div'); d.className = 'thumb';
      d.innerHTML = `<img src="${blobUrl(p.blob)}" alt="Photo ${i + 1}"><button type="button" class="x" aria-label="Remove photo">✕</button>`;
      d.querySelector('button').onclick = () => { editing.photos.splice(i, 1); renderPhotos(); };
      return d;
    }));
  }
  function renderReceipts() {
    $('receipts').replaceChildren(...editing.receipts.map((r, i) => {
      const d = document.createElement('div');
      d.innerHTML = `<span>🧾 ${esc(r.name)}</span><button type="button">Remove</button>`;
      d.querySelector('button').onclick = () => { editing.receipts.splice(i, 1); renderReceipts(); };
      return d;
    }));
  }

  async function addPhotos(files) {
    for (const f of files) { const t = await photoDate(f); const s = await shrink(f); editing.photos.push({ id: uid(), name: s.name, type: s.type, blob: s.blob, takenAt: t }); }
    renderPhotos();
  }
  $('cam').onchange = (e) => { addPhotos([...e.target.files]); e.target.value = ''; };
  $('gallery').onchange = (e) => { addPhotos([...e.target.files]); e.target.value = ''; };
  $('receipt').onchange = async (e) => {
    for (const f of [...e.target.files]) {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) editing.receipts.push({ id: uid(), name: f.name, type: 'application/pdf', blob: f });
      else { const s = await shrink(f, 2400); editing.receipts.push({ id: uid(), name: 'receipt-' + s.name, type: s.type, blob: s.blob }); }
    }
    e.target.value = '';
    renderReceipts();
  };

  $('form').onsubmit = async (e) => {
    e.preventDefault();
    const f = $('form');
    const name = f.elements.name.value.trim();
    const err = $('formErr');
    if (!name) { err.textContent = 'Give the item a name.'; err.classList.remove('hidden'); f.elements.name.focus(); return; }
    for (const k of ['purchasePrice', 'currentValue']) {
      const v = f.elements[k].value.trim();
      if (v && !Number.isFinite(Number(v.replace(/[£,\s]/g, '')))) { err.textContent = 'Money amounts must be numbers, e.g. 249.99'; err.classList.remove('hidden'); return; }
    }
    const item = { ...editing };
    for (const k of FIELDS) item[k] = (f.elements[k].value || '').trim();
    item.updatedAt = new Date().toISOString();
    item.exportedAt = null; // new or changed: include in the next export
    try {
      await putItem(item);
    } catch (ex) {
      err.textContent = 'Could not save on this device: ' + (ex && ex.message || ex) + '\nYour phone may be low on storage.'; err.classList.remove('hidden'); return;
    }
    toast(`✓ "${item.name}" saved`);
    showHome();
  };

  // ---------- export ----------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function buildExport(list, ups, dlist = []) {
    const hasFiles = ups.some(u => (u.photos && u.photos.length) || (u.documents && u.documents.length));
    const out = { format: FORMAT, version: dlist.length ? FORMAT_VERSION_DOCS : hasFiles ? FORMAT_VERSION_FILES : ups.length ? FORMAT_VERSION_CHANGES : FORMAT_VERSION, app: 'OpenSafe Capture', exportedAt: new Date().toISOString(), device: navigator.userAgent.slice(0, 200), items: [] };
    if (dlist.length) {
      out.documents = [];
      for (const d of dlist) {
        const x = { id: d.id, createdAt: d.createdAt, title: d.title, docType: d.docType, from: d.from, docDate: d.docDate, ref: d.ref, actBy: d.actBy, notes: d.notes, pages: [] };
        for (const p of d.pages) x.pages.push({ type: 'image/jpeg', data: await blobToBase64(p.blob) });
        out.documents.push(x);
      }
    }
    for (const it of list) {
      const x = { id: it.id, createdAt: it.createdAt, updatedAt: it.updatedAt };
      for (const k of FIELDS) x[k] = it[k] || '';
      x.photos = [];
      for (const p of it.photos) x.photos.push({ id: p.id, name: p.name, type: p.type, takenAt: p.takenAt || '', data: await blobToBase64(p.blob) });
      x.documents = [];
      for (const r of it.receipts) x.documents.push({ id: r.id, name: r.name, type: r.type, docType: 'Receipt', data: await blobToBase64(r.blob) });
      out.items.push(x);
    }
    for (const u of ups) {
      const x = { id: u.id, itemId: u.itemId, itemName: u.itemName, at: u.at, kind: u.kind, changes: u.changes, summary: u.summary, note: u.note };
      if (u.photos && u.photos.length) { x.photos = []; for (const p of u.photos) x.photos.push({ id: p.id, name: p.name, type: p.type, takenAt: p.takenAt || '', data: await blobToBase64(p.blob) }); }
      if (u.documents && u.documents.length) { x.documents = []; for (const d of u.documents) x.documents.push({ id: d.id, name: d.name, type: d.type, docType: 'Receipt', data: await blobToBase64(d.blob) }); }
      (out.updates = out.updates || []).push(x);
    }
    return out;
  }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function doExport(all) {
    await loadUpdates();
    const list = all ? items : items.filter(i => !i.exportedAt);
    const ups = all ? updates : updates.filter(u => !u.exportedAt);
    const dlist = all ? docs : docs.filter(d => !d.exportedAt);
    if (!list.length && !ups.length && !dlist.length) { toast('Nothing to export'); return; }
    const btn = $('exportBtn'); btn.disabled = true; btn.textContent = 'Preparing…';
    let data;
    try { data = JSON.stringify(await buildExport(list, ups, dlist)); }
    catch (ex) { toast('Export failed: ' + ex.message, 5000); btn.disabled = false; btn.textContent = 'Export to PC'; return; }
    btn.textContent = 'Export to PC'; btn.disabled = false;
    const base = `OpenSafe-${stamp()}`;
    const mb = data.length < 1048576 ? Math.max(1, Math.round(data.length / 1024)) + ' KB' : (data.length / 1048576).toFixed(1) + ' MB';
    pendingExport = { list, ups, dlist, data, base };
    const canShareFile = (name, type) => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], name, { type })] })); } catch (_) { return false; } };
    shareName = canShareFile(base + '.opensafe', 'application/octet-stream') ? [base + '.opensafe', 'application/octet-stream']
      : canShareFile(base + '.opensafe.txt', 'text/plain') ? [base + '.opensafe.txt', 'text/plain'] : null;
    const what = [list.length && `${list.length} item${list.length === 1 ? '' : 's'}`, ups.length && `${ups.length} change${ups.length === 1 ? '' : 's'}`, dlist.length && `${dlist.length} document${dlist.length === 1 ? '' : 's'}`].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1');
    sheet(`<h2>Export ${what}</h2>
      <p class="muted">One file with everything, photos included (${mb}).</p>${dlist.length ? '<p class="muted small">Scanned documents need OpenSafe 2.6 or later on the PC.</p>' : ''}${ups.length ? `<p class="muted small">Changes from scanning labels need OpenSafe ${ups.some(u => (u.photos && u.photos.length) || (u.documents && u.documents.length)) ? '1.8' : '1.6'} or later on the PC.</p>` : ''}
      ${shareName ? '<button class="btn primary" data-act="share">Send to PC…</button><p class="muted" style="margin-top:-4px">Pick Quick Share, Bluetooth, email, Google Drive or OneDrive.</p>' : ''}
      <button class="btn ${shareName ? '' : 'primary'}" data-act="download">Save to Downloads</button>
      <p class="muted">Then on your PC, double-click the file, or in OpenSafe choose <b>Phone app → Import from phone…</b>.</p>
      <button class="btn" data-act="closeSheet">Cancel</button>`);
  }
  let pendingExport = null, shareName = null;

  async function markExported(list, ups, dlist = []) {
    const now = new Date().toISOString();
    for (const it of list) { it.exportedAt = now; await putItem(it); }
    for (const d of dlist) { d.exportedAt = now; await putDoc(d); }
    if (ups.length) {
      await loadUpdates();
      const ids = new Set(ups.map(u => u.id));
      for (const u of updates) if (ids.has(u.id)) u.exportedAt = now;
      await kvSet('updates', updates);
    }
  }
  async function finishExport(how) {
    const { list, ups, dlist } = pendingExport;
    await markExported(list, ups, dlist);
    pendingExport = null;
    closeSheet();
    renderList();
    toast(how === 'share' ? '✓ Sent. Import the file in OpenSafe on your PC.' : '✓ Saved to Downloads. Copy it to your PC and import it in OpenSafe.', 4500);
  }

  async function shareExport() {
    const { data } = pendingExport;
    const file = new File([data], shareName[0], { type: shareName[1] });
    try {
      await navigator.share({ files: [file], title: 'OpenSafe export', text: 'OpenSafe items to import on the PC' });
      await finishExport('share');
    } catch (ex) {
      if (ex && ex.name === 'AbortError') return; // user closed the share menu
      toast('Sharing didn\'t work here. Use Save to Downloads instead.', 5000);
    }
  }
  async function downloadExport() {
    const { data, base } = pendingExport;
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = base + '.opensafe';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    await finishExport('download');
  }

  // ---------- inventory from the PC (read-only, encrypted with a passphrase) ----------
  let tab = 'home';
  let inv = null;          // decrypted inventory, in memory while the app is open
  // After the passphrase is entered once, the AES key for that file is kept in this app's
  // storage as a non-extractable CryptoKey (the passphrase itself is never stored), so the
  // inventory opens without asking again. Loading a new file or "Lock inventory" removes it.
  let pendingItem = null;  // item id from a scanned QR label link

  const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  function parseView(text) {
    const f = JSON.parse(text);
    if (f.format !== 'opensafe-view') throw new Error('This isn\'t an OpenSafe inventory file.');
    return f;
  }
  async function decryptWithKey(f, key) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(f.iv) }, key, b64(f.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function decryptInventory(text, pass) {
    const f = parseView(text);
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(f.salt), iterations: f.kdf.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let view;
    try { view = await decryptWithKey(f, key); }
    catch (_) { throw new Error('That passphrase isn\'t right.'); }
    try { await kvSet('inventoryKey', { key, salt: f.salt }); } catch (_) { /* can't remember it: it will ask again next time */ }
    return view;
  }
  // Open the inventory with the remembered key, if there is one for the file on this phone.
  async function autoOpen() {
    if (inv) return true;
    try {
      const file = await kvGet('inventory'), saved = await kvGet('inventoryKey');
      if (!file || !saved || !saved.key) return false;
      const f = parseView(file.text);
      if (saved.salt !== f.salt) { await kvSet('inventoryKey', undefined); return false; }
      inv = await decryptWithKey(f, saved.key);
      return true;
    } catch (_) { return false; }
  }

  function setTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
    if (t === 'inv') showInv(); else { $('inv').classList.add('hidden'); $('home').classList.remove('hidden'); $('fab').classList.remove('hidden'); $('title').textContent = 'OpenSafe Capture'; $('subtitle').textContent = 'Items stay on this device until you export'; renderList(); }
  }

  async function showInv() {
    $('home').classList.add('hidden'); $('form').classList.add('hidden'); $('fab').classList.add('hidden');
    $('inv').classList.remove('hidden');
    $('title').textContent = 'My inventory';
    await autoOpen();
    const file = await kvGet('inventory');
    $('invNone').classList.toggle('hidden', !!file);
    $('invUnlock').classList.toggle('hidden', !file || !!inv);
    $('invOpen').classList.toggle('hidden', !inv);
    $('subtitle').textContent = inv ? 'Read-only copy from your PC' : 'Copy of your PC inventory';
    if (file && !inv) {
      $('invInfo').textContent = `Loaded ${file.loadedAt ? new Date(file.loadedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}. Enter the passphrase you chose on the PC. You'll only need it once for this file.`;
      setTimeout(() => $('invUnlock').pass.focus(), 50);
    }
    if (inv) renderInv(); else $('invList').replaceChildren();
  }

  let grabOnly = false;
  function renderInv() {
    const q = $('invQ').value.trim().toLowerCase();
    $('grabChip').classList.toggle('on', grabOnly);
    $('grabChip').classList.toggle('hidden', !inv.items.some(a => a.grab));
    $('tripsChip').classList.toggle('hidden', !(inv.trips && inv.trips.length));
    $('docsChip').classList.toggle('hidden', !(inv.docs && inv.docs.length));
    $('docsChip').textContent = `📄 Documents${inv.docs && inv.docs.length ? ` (${inv.docs.length})` : ''}`;
    const list = inv.items.filter(a => (!grabOnly || a.grab) && (!q || [a.name, a.brand, a.model, a.serial, a.category, a.location, a.barcode, (a.details || {}).reg, (a.tags || []).join(' ')].join(' ').toLowerCase().includes(q)));
    if (grabOnly) list.sort((x, y) => (x.location || '~').localeCompare(y.location || '~') || x.name.localeCompare(y.name));
    $('invMeta').textContent = `${inv.count} items · copied from the PC on ${new Date(inv.exportedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    $('invList').replaceChildren(...list.map(a => {
      const d = document.createElement('div'); d.className = 'item'; d.dataset.inv = a.id;
      const meta = [a.category, a.location, gbp(a.currentValue ?? a.purchasePrice ?? '')].filter(Boolean).join(' · ');
      d.innerHTML = `${a.thumb ? `<img src="${a.thumb}" alt="">` : '<div class="ph">▣</div>'}<div class="t"><div class="n">${esc(a.name)}</div><div class="m">${esc(meta) || '&nbsp;'}</div><div class="m">${esc([a.brand, a.model].filter(Boolean).join(' '))}</div></div>${a.inVault ? '<span class="pill">🔒</span>' : ''}`;
      return d;
    }));
    if (!list.length) $('invList').innerHTML = '<div class="empty muted">No matches.</div>';
  }

  function showInvItem(id) {
    const a = inv && inv.items.find(x => x.id === id);
    if (!a) { toast('That item isn\'t in the inventory on this phone. Send a newer copy from the PC.', 4500); return; }
    const d = a.details || {};
    const ukd = (s) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
    const rows = [['Category', a.category], ['Location', a.location], ['Status', a.status !== 'Owned' ? a.status : ''], ['Brand', a.brand], ['Model', a.model], ['Serial number', a.serial], ['Barcode', a.barcode],
      ['Bought on', ukd(a.purchaseDate)], ['Bought from', a.supplier], ['Price paid', gbp(a.purchasePrice ?? '')], ['Value now', gbp(a.currentValue ?? '')], ['Warranty until', ukd(a.warrantyExpiry)],
      ['Owner', a.owner], ['Belongs to', a.status === 'Borrowed' ? a.borrowedFrom : ''], ['Give back by', a.status === 'Borrowed' ? ukd(a.returnBy) : ''], ['Insurer', a.insurer], ['Policy number', a.policyNumber], ['Lent to', a.lentTo], ['Their contact', a.lentContact], ['Due back', ukd(a.dueBack)],
      ['Registration', d.reg], ['VIN / frame no.', d.vin], ['Mileage', d.mileage], ['MOT due', ukd(d.motDue)], ['Road tax due', ukd(d.taxDue)], ['Hull ID', d.hin], ['Engine hours', d.engineHours], ['Mooring', d.mooring]]
      .filter(([, v]) => v);
    sheet(`<div class="detail">${a.thumb ? `<img class="big" src="${a.thumb}" alt="">` : ''}<h2 style="margin-top:12px">${esc(a.name)}</h2>
      <div class="kv">${rows.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
      ${a.grab ? '<div class="waiting" style="background:#fde8e6;color:var(--danger)">🚨 On the grab list</div>' : ''}
      ${/^https?:\/\//i.test(a.webLink || '') ? `<p><a class="weblink" href="${esc(a.webLink)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(a.webLink.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</a></p>` : ''}
      ${a.notes ? `<p style="white-space:pre-wrap">${esc(a.notes)}</p>` : ''}
      ${updates.filter(u => u.itemId === a.id && !u.exportedAt).map(u => `<div class="waiting">⏳ Waiting to export: ${esc(u.summary)}</div>`).join('')}
      ${(() => { const ld = (inv.docs || []).filter(x => (x.assetIds || []).includes(a.id)); return ld.length ? `<h3 class="stockh">📄 Linked documents</h3><ul class="stocklist">${ld.map(x => `<li data-act="doc" data-id="${x.id}">${esc(x.title)}<small>${esc([x.from, ukDate(x.docDate)].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul>` : ''; })()}
      <p class="muted small">${a.photos} photo${a.photos === 1 ? '' : 's'} and ${a.documents} document${a.documents === 1 ? '' : 's'} on the PC.</p>
      <button class="btn primary" data-act="itemActions" data-id="${a.id}">Move, lend or report a problem…</button>
      <button class="btn" data-act="closeSheet">Close</button></div>`);
  }

  $('invFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const text = await f.text();
    try { const j = JSON.parse(text); if (j.format !== 'opensafe-view') throw new Error(); }
    catch (_) { toast('That isn\'t an OpenSafe inventory file. Choose the .opensafe-view file from the PC.', 5000); return; }
    await kvSet('inventory', { text, loadedAt: new Date().toISOString() });
    await kvSet('inventoryKey', undefined);
    inv = null;
    showInv();
  };
  $('invUnlock').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('invErr'); err.classList.add('hidden');
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const file = await kvGet('inventory');
      inv = await decryptInventory(file.text, e.target.pass.value);
      e.target.reset();
      showInv();
      if (pendingItem) { const id = pendingItem; pendingItem = null; showActions(id); }
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    btn.disabled = false; btn.textContent = 'Open';
  };
  $('invQ').oninput = () => renderInv();

  function openFromHash() {
    const pm = location.hash.match(/place=([^&]+)/);
    if (pm) { history.replaceState(null, '', location.pathname); let p = ''; try { p = decodeURIComponent(pm[1]); } catch (_) {} if (p) showPlace(p); return; }
    const m = location.hash.match(/item=([0-9a-f-]{36})/i);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    showActions(m[1].toLowerCase());
  }

  // ---------- changes from scanning an item's QR label ----------
  const ACTIONS = [
    ['move', '📦 Move it', 'Change where it\'s kept'],
    ['lend', '🤝 Lend it', 'Who has it, and when it\'s due back'],
    ['returned', '↩️ It\'s back', 'Returned after lending'],
    ['needsRepair', '🔧 Needs repairing', 'Say what\'s wrong'],
    ['inRepair', '🛠️ Gone for repair', 'It\'s with a repairer'],
    ['repaired', '✅ Repaired', 'Working again'],
    ['sold', '💷 Sold', 'Date, price and buyer'],
    ['lost', '⚠️ Lost or stolen', 'Mark it missing'],
    ['disposed', '🗑️ Got rid of it', 'Thrown, recycled or given away'],
    ['note', '📝 Add a note', 'Anything else to remember'],
    ['photos', '📷 Add photos', 'Of the item, or of damage'],
    ['receipt', '🧾 Add a receipt', 'Photo or PDF']
  ];
  let attPending = []; // files picked in the Add photos / Add a receipt form
  const attUrls = [];
  function renderAttPending() {
    const el = $('attList'); if (!el) return;
    while (attUrls.length) URL.revokeObjectURL(attUrls.pop());
    const u = (b) => { const x = URL.createObjectURL(b); attUrls.push(x); return x; };
    el.innerHTML = attPending.length ? attPending.map((f, i) => `<div class="attrow">${/^image\//.test(f.type) ? `<img src="${u(f.blob)}" alt="">` : '<span class="ph">📄</span>'}<span>${esc(f.name)}</span><button type="button" class="iconbtn" data-act="attRemove" data-i="${i}" aria-label="Remove">✕</button></div>`).join('') : '<p class="muted small">Nothing added yet.</p>';
  }
  document.addEventListener('change', async (e) => {
    const inp = e.target.closest && e.target.closest('input[data-attach]');
    if (!inp) return;
    for (const f of [...inp.files]) {
      if (inp.dataset.attach === 'doc' && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) attPending.push({ id: uid(), kind: 'doc', name: f.name, type: 'application/pdf', blob: f });
      else { const t = inp.dataset.attach === 'photo' ? await photoDate(f) : ''; const r = await shrink(f, inp.dataset.attach === 'doc' ? 2400 : 2000); attPending.push({ id: uid(), kind: inp.dataset.attach, name: (inp.dataset.attach === 'doc' ? 'receipt-' : '') + r.name, type: r.type, blob: r.blob, takenAt: t }); }
    }
    inp.value = '';
    if ($('actErr')) $('actErr').classList.add('hidden');
    renderAttPending();
  });
  function itemInfo(id) {
    const a = inv && inv.items.find(x => x.id === id);
    if (a) return { name: a.name, location: a.location, status: a.status, lentTo: a.lentTo, known: true, inInv: true };
    const l = items.find(x => x.id === id);
    if (l) return { name: l.name, location: l.location, known: true };
    return { name: 'Item ' + id.slice(0, 8), known: false };
  }
  // The PC copy, with any changes waiting on this phone applied on top.
  function currentState(id) {
    const st = Object.assign({}, itemInfo(id));
    for (const u of updates.filter(x => x.itemId === id).sort((a, b) => a.at.localeCompare(b.at))) Object.assign(st, u.changes);
    return st;
  }
  async function showActions(id, skipUnlock) {
    await loadUpdates();
    await autoOpen();
    if (!inv && !skipUnlock && !items.some(x => x.id === id) && await kvGet('inventory')) {
      sheet(`<form id="quickUnlock" data-id="${id}" autocomplete="off"><h2>🔒 Which item is this?</h2>
        <p class="muted">Enter your inventory passphrase to see the item's name and details.</p>
        <label>Passphrase<input type="password" name="pass" autocomplete="current-password"></label>
        <div id="quErr" class="error hidden" role="alert"></div>
        <button class="btn primary" type="submit">Open</button>
        <button class="btn" type="button" data-act="skipUnlock" data-id="${id}">Skip, record a change without the name</button></form>`);
      setTimeout(() => { const i = document.querySelector('#quickUnlock input'); if (i) i.focus(); }, 50);
      return;
    }
    const st = currentState(id);
    const haveFile = !!(await kvGet('inventory'));
    const where = [st.location && `📍 ${st.location}`, st.status && st.status !== 'Owned' && (st.status === 'Lent out' && st.lentTo ? `Lent to ${st.lentTo}` : st.status)].filter(Boolean).join(' · ');
    const waiting = updates.filter(u => u.itemId === id && !u.exportedAt);
    learnedLists();
    sheet(`<h2>${esc(st.name)}</h2>
      ${where ? `<p class="muted" style="margin-top:-6px">${esc(where)}</p>` : ''}
      ${st.known ? '' : `<p class="muted small">${haveFile ? 'Unlock your inventory to see this item\'s name.' : 'Load your inventory from the PC (My inventory tab) to see item names here.'} You can still record a change: the PC knows which item this label belongs to.</p>${haveFile ? `<button class="btn" data-act="itemActions" data-id="${id}">🔓 Unlock inventory</button>` : ''}`}
      ${waiting.map(u => `<div class="waiting">⏳ Waiting to export: ${esc(u.summary)}</div>`).join('')}
      <div class="actions">${ACTIONS.map(([k, t, d]) => `<button class="action" data-act="itemAction" data-kind="${k}" data-id="${id}">${t}<span>${esc(d)}</span></button>`).join('')}</div>
      ${st.inInv ? `<button class="btn" data-act="itemDetails" data-id="${id}">See all details</button>` : ''}
      <button class="btn" data-act="closeSheet">Close</button>`);
  }
  function actionForm(kind, id) {
    const st = currentState(id);
    const f = (name, label, attrs = '') => `<label>${label}<input name="${name}" ${attrs}></label>`;
    const note = (label = 'Note (optional)') => `<label>${label}<textarea name="note" rows="2" maxlength="1000"></textarea></label>`;
    const today = todayLocal();
    const body = {
      move: f('location', 'Where is it now?', `list="locs" maxlength="60" value="${esc(st.location || '')}"`) + note(),
      lend: f('lentTo', 'Lent to', 'maxlength="200" autocapitalize="words"') + f('lentContact', 'Their phone number or email (optional)', 'maxlength="200"')
        + `<div class="row2">${f('lentDate', 'Lent on', `type="date" value="${today}"`)}${f('dueBack', 'Due back (optional)', 'type="date"')}</div>` + note(),
      returned: f('location', 'Where is it now? (optional)', 'list="locs" maxlength="60"') + note(),
      needsRepair: note('What\'s wrong with it?'),
      inRepair: f('repairer', 'Who is repairing it? (optional)', 'maxlength="200"') + note(),
      repaired: note(),
      sold: `<div class="row2">${f('soldDate', 'Sold on', `type="date" value="${today}"`)}${f('soldPrice', 'Price (£)', 'inputmode="decimal" placeholder="0.00"')}</div>` + f('soldTo', 'Sold to (optional)', 'maxlength="200"') + note(),
      lost: note('What happened? (optional)'),
      disposed: note(),
      note: note('Note'),
      photos: `<div class="row2"><label class="btn primary">📷 Take photo<input type="file" accept="image/*" capture="environment" data-attach="photo" hidden></label><label class="btn">🖼️ From gallery<input type="file" accept="image/*" multiple data-attach="photo" hidden></label></div><div id="attList"></div>` + note(),
      receipt: `<div class="row2"><label class="btn primary">📷 Take photo<input type="file" accept="image/*" capture="environment" data-attach="doc" hidden></label><label class="btn">📄 Choose file<input type="file" accept="image/*,application/pdf" multiple data-attach="doc" hidden></label></div><div id="attList"></div>` + note()
    }[kind];
    attPending = [];
    sheet(`<form id="actForm" data-kind="${kind}" data-id="${id}" novalidate autocomplete="off"><h2>${ACTIONS.find(a => a[0] === kind)[1]}</h2><p class="muted" style="margin-top:-6px">${esc(st.name)}</p>
      ${body}<div id="actErr" class="error hidden" role="alert"></div>
      <button class="btn primary" type="submit">Save change</button>
      <button class="btn" type="button" data-act="itemActions" data-id="${id}">Back</button></form>`);
    renderAttPending();
  }
  async function saveAction(form) {
    const kind = form.dataset.kind, id = form.dataset.id;
    const v = (n) => form.elements[n] ? form.elements[n].value.trim() : '';
    const fail = (m) => { const e = $('actErr'); e.textContent = m; e.classList.remove('hidden'); };
    const st = currentState(id);
    let note = v('note'); const c = {}; let summary;
    switch (kind) {
      case 'move':
        if (!v('location')) return fail('Enter where it is now.');
        c.location = v('location'); summary = `Moved to ${c.location}`; break;
      case 'lend':
        if (!v('lentTo')) return fail('Enter who you lent it to.');
        if (v('dueBack') && v('lentDate') && v('dueBack') < v('lentDate')) return fail('The due-back date is before the date you lent it.');
        Object.assign(c, { status: 'Lent out', lentTo: v('lentTo'), lentContact: v('lentContact'), lentDate: v('lentDate'), dueBack: v('dueBack') });
        summary = `Lent to ${c.lentTo}${c.lentContact ? ' (' + c.lentContact + ')' : ''}${c.dueBack ? ', due back ' + ukDate(c.dueBack) : ''}`; break;
      case 'returned':
        Object.assign(c, { status: 'Owned', lentTo: '', lentContact: '', lentDate: '', dueBack: '' });
        if (v('location')) c.location = v('location');
        summary = `Returned${st.status === 'Lent out' && st.lentTo ? ' by ' + st.lentTo : ''}${c.location ? ', now in ' + c.location : ''}`; break;
      case 'needsRepair':
        if (!note) return fail('Say what\'s wrong with it.');
        c.status = 'Needs repair'; summary = 'Needs repairing'; break;
      case 'inRepair': c.status = 'In repair'; summary = `Gone for repair${v('repairer') ? ' with ' + v('repairer') : ''}`; break;
      case 'repaired': c.status = 'Owned'; summary = 'Repaired'; break;
      case 'sold': {
        const p = v('soldPrice').replace(/[£,\s]/g, '');
        if (p && !Number.isFinite(Number(p))) return fail('Enter the price as a number, like 250 or 249.99.');
        Object.assign(c, { status: 'Sold', soldDate: v('soldDate'), soldTo: v('soldTo') });
        if (p) c.soldPrice = p;
        summary = `Sold${c.soldTo ? ' to ' + c.soldTo : ''}${p ? ' for ' + gbp(p) : ''}`; break;
      }
      case 'lost': c.status = 'Lost / Stolen'; summary = 'Lost or stolen'; break;
      case 'disposed': c.status = 'Disposed'; summary = 'Got rid of it'; break;
      case 'note':
        if (!note) return fail('Write the note.');
        summary = note.slice(0, 300); note = ''; break;
      case 'photos': case 'receipt': {
        if (!attPending.length) return fail(kind === 'photos' ? 'Take or choose at least one photo.' : 'Add the receipt first.');
        const n = attPending.length;
        summary = kind === 'photos' ? `Added ${n} photo${n === 1 ? '' : 's'}` : `Added ${n === 1 ? 'a receipt' : n + ' receipts'}`;
        break;
      }
      default: return;
    }
    await loadUpdates();
    const info = itemInfo(id);
    const rec = { id: uid(), itemId: id, itemName: info.known ? info.name : '', at: new Date().toISOString(), kind, changes: c, summary, note, exportedAt: null };
    if (kind === 'photos') rec.photos = attPending.map(({ id, name, type, blob, takenAt }) => ({ id, name, type, blob, takenAt }));
    if (kind === 'receipt') rec.documents = attPending.map(({ id, name, type, blob }) => ({ id, name, type, blob }));
    attPending = [];
    updates.push(rec);
    await kvSet('updates', updates);
    closeSheet();
    toast('✓ Saved. Tap Export to PC to send it.', 3500);
    if (tab === 'inv') showInv(); else renderList();
  }
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'actForm') { e.preventDefault(); saveAction(e.target); }
    if (e.target.id === 'stockForm') { e.preventDefault(); stock = { loc: e.target.loc.value, found: new Set(), unknown: new Set() }; runStockScan(); }
    if (e.target.id === 'quickUnlock') {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Opening…';
      try {
        inv = await decryptInventory((await kvGet('inventory')).text, f.pass.value);
        if (f.dataset.place) showPlace(f.dataset.place); else showActions(f.dataset.id);
        if (tab === 'inv') showInv(); else renderList();
      } catch (ex) { $('quErr').textContent = ex.message; $('quErr').classList.remove('hidden'); btn.disabled = false; btn.textContent = 'Open'; }
    }
  });
  async function scanItemLabel() {
    try {
      $('scanMsg').textContent = 'Point the camera at an OpenSafe label';
      const text = await scan(['qr_code']);
      if (!text) return;
      const place = placeFromLabel(text);
      if (place) { showPlace(place); return; }
      const m = String(text).match(/item=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) showActions(m[1].toLowerCase()); else toast('That QR code isn\'t an OpenSafe label.', 4000);
    } catch (ex) { stopScan(); toast(ex.message, 5000); }
  }
  window.addEventListener('hashchange', openFromHash);

  // ---------- camera scanning (barcodes and QR labels) ----------
  let scanStream = null, scanTimer = null;
  async function scan(formats) {
    if (!('BarcodeDetector' in window)) throw new Error('This browser can\'t scan codes. Use Chrome on Android, or type the number in.');
    const supported = await BarcodeDetector.getSupportedFormats();
    const want = formats.filter(f => supported.includes(f));
    if (!want.length) throw new Error('This phone can\'t scan that kind of code.');
    const detector = new BarcodeDetector({ formats: want });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const v = $('scanVideo'); v.srcObject = scanStream; await v.play();
    $('scanCount').textContent = ''; $('scanCloseBtn').textContent = 'Cancel';
    $('scanner').classList.remove('hidden');
    return new Promise((resolve) => {
      scan.cancel = () => { stopScan(); resolve(null); };
      const tick = async () => {
        try { const found = await detector.detect(v); if (found.length) { stopScan(); if (navigator.vibrate) navigator.vibrate(60); resolve(found[0].rawValue); return; } } catch (_) {}
        scanTimer = setTimeout(tick, 250);
      };
      tick();
    });
  }
  // Keeps the camera on and calls onCode for each code seen, until Finish is tapped.
  async function scanMany(formats, onCode) {
    if (!('BarcodeDetector' in window)) throw new Error('This browser can\'t scan codes. Use Chrome on Android.');
    const supported = await BarcodeDetector.getSupportedFormats();
    const want = formats.filter(f => supported.includes(f));
    if (!want.length) throw new Error('This phone can\'t scan that kind of code.');
    const detector = new BarcodeDetector({ formats: want });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const v = $('scanVideo'); v.srcObject = scanStream; await v.play();
    $('scanCloseBtn').textContent = 'Finish';
    $('scanner').classList.remove('hidden');
    return new Promise((resolve) => {
      let last = '', lastAt = 0;
      scan.cancel = () => { stopScan(); resolve(); };
      const tick = async () => {
        if (!scanStream) return;
        try {
          for (const f of await detector.detect(v)) {
            if (f.rawValue === last && Date.now() - lastAt < 3000) continue;
            last = f.rawValue; lastAt = Date.now();
            const msg = onCode(f.rawValue);
            if (msg) { $('scanMsg').textContent = msg.text; $('scanCount').textContent = msg.count || ''; if (navigator.vibrate) navigator.vibrate(msg.warn ? [60, 80, 60] : 50); }
          }
        } catch (_) { /* keep trying */ }
        scanTimer = setTimeout(tick, 250);
      };
      tick();
    });
  }

  // ---------- stock check: scan every label in a place, see what's missing or misplaced ----------
  const GONE = ['Sold', 'Disposed', 'Lost / Stolen', 'Given back'];
  let stock = null;
  const inLoc = (loc, place) => place === '' ? !loc : !!loc && (loc === place || loc.startsWith(place + ' / '));
  const idFromLabel = (text) => { const m = String(text).match(/item=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i); return m ? m[1].toLowerCase() : null; };
  const placeFromLabel = (text) => { const m = String(text).match(/[#&]place=([^&]+)/); if (!m) return ''; try { return decodeURIComponent(m[1]); } catch (_) { return ''; } };
  // A box, shelf or room label: what's there, put items there, or stock-check it.
  async function showPlace(place, skipUnlock) {
    await loadUpdates();
    await autoOpen();
    if (!inv && !skipUnlock && await kvGet('inventory')) {
      sheet(`<form id="quickUnlock" data-place="${esc(place)}" autocomplete="off"><h2>🔒 ${esc(place)}</h2>
        <p class="muted">Enter your inventory passphrase to see what's here.</p>
        <label>Passphrase<input type="password" name="pass" autocomplete="current-password"></label>
        <div id="quErr" class="error hidden" role="alert"></div>
        <button class="btn primary" type="submit">Open</button>
        <button class="btn" type="button" data-act="skipUnlock" data-place="${esc(place)}">Skip</button></form>`);
      return;
    }
    const here = inv ? inv.items.filter(a => { const st = currentState(a.id); return inLoc(st.location || '', place) && !GONE.includes(st.status); }) : [];
    const parts = place.split(' / ');
    sheet(`<h2>📦 ${esc(parts[parts.length - 1])}</h2>${parts.length > 1 ? `<p class="muted" style="margin-top:-6px">${esc(parts.slice(0, -1).join(' / '))}</p>` : ''}
      <button class="btn primary" style="flex-direction:column;gap:2px;width:100%" data-act="placePut" data-place="${esc(place)}">📥 Put items here<span style="display:block;font-weight:400;font-size:13px">Scan each item's label as you put it in</span></button>
      ${inv ? `<button class="btn" data-act="placeStock" data-place="${esc(place)}">📋 Stock check here</button>` : ''}
      ${inv ? `<h3 class="stockh">In here (${here.length})</h3>${here.length ? `<ul class="stocklist">${here.map(a => { const w = currentState(a.id).location || ''; return `<li data-act="itemActions" data-id="${a.id}">${esc(a.name)}${w !== place ? `<small>${esc(w.slice(place.length + 3))}</small>` : ''}</li>`; }).join('')}</ul>` : '<p class="muted">Nothing recorded here yet.</p>'}` : '<p class="muted small">Load your inventory from the PC (My inventory tab) to see what\'s here.</p>'}
      <button class="btn" data-act="closeSheet">Close</button>`);
  }
  async function putItemsHere(place) {
    closeSheet();
    await loadUpdates();
    let moved = 0;
    const at = () => new Date().toISOString();
    try {
      $('scanMsg').textContent = `Scan each item going into ${place}`;
      $('scanCount').textContent = '';
      await scanMany(['qr_code'], (text) => {
        const id = idFromLabel(text);
        if (!id) return { text: placeFromLabel(text) ? 'That\'s a place label. Scan the items.' : 'That isn\'t an OpenSafe label', warn: true };
        const info = itemInfo(id);
        if ((currentState(id).location || '') === place) return { text: `✓ ${info.name} is already here`, count: `${moved} moved` };
        updates.push({ id: uid(), itemId: id, itemName: info.known ? info.name : '', at: at(), kind: 'move', changes: { location: place }, summary: `Moved to ${place}`, note: '', exportedAt: null });
        kvSet('updates', updates);
        moved++;
        return { text: `📥 ${info.name} → ${place.split(' / ').pop()}`, count: `${moved} moved` };
      });
    } catch (ex) { stopScan(); toast(ex.message, 5000); }
    $('scanCloseBtn').textContent = 'Cancel';
    await kvSet('updates', updates);
    if (moved) toast(`✓ ${moved} move${moved === 1 ? '' : 's'} saved. Export to send them to your PC.`, 4000);
    showPlace(place);
  }

  // ---------- packing lists (made on the PC; ticks stay on this phone) ----------
  async function tripTicks() { return (await kvGet('tripTicks')) || {}; }
  async function tripRows(t) {
    const saved = (await tripTicks())[t.id] || {};
    const tick = (r) => Object.assign({ packed: r.packed, back: r.back }, saved[r.id] || {});
    return [...t.items.map(r => { const a = inv.items.find(x => x.id === r.id); return a ? Object.assign({ key: r.id, name: a.name, where: currentState(a.id).location || '' }, tick(r)) : null; }).filter(Boolean)
      .sort((x, y) => x.where.localeCompare(y.where) || x.name.localeCompare(y.name)),
      ...t.extras.map(r => Object.assign({ key: r.id, name: r.text, where: '', extra: true }, tick(r)))];
  }
  async function setTick(tripId, key, which, on) {
    const all = await tripTicks();
    const t = all[tripId] = all[tripId] || {};
    const cur = t[key] || {};
    cur[which] = on; if (which === 'back' && on) cur.packed = true;
    t[key] = cur;
    await kvSet('tripTicks', all);
  }
  // ---------- documents sent from the PC (page pictures, read-only) ----------
  let docQ = '';
  function showDocs(q) {
    if (q !== undefined) docQ = q;
    const docs = (inv && inv.docs) || [];
    const words = docQ.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (d) => [d.title, d.docType, d.from, d.ref, d.folder, d.notes, (d.tags || []).join(' '), d.files.join(' '), d.text].join(' ').toLowerCase();
    const list = docs.filter(d => words.every(w => hay(d).includes(w))).sort((a, b) => (b.docDate || '').localeCompare(a.docDate || ''));
    const snip = (d) => { const w = words.find(x => (d.text || '').toLowerCase().includes(x)); if (!w) return ''; const i = d.text.toLowerCase().indexOf(w); return '…' + d.text.slice(Math.max(0, i - 40), i + w.length + 50).replace(/\s+/g, ' ') + '…'; };
    sheet(`<h2>📄 Documents</h2>
      <input type="search" id="docQ" placeholder="Search titles, senders and the words in them" value="${esc(docQ)}" style="width:100%;margin:4px 0 8px">
      ${list.length ? `<ul class="stocklist">${list.map(d => `<li data-act="doc" data-id="${d.id}">${esc(d.title)}<small>${esc([d.kind === 'document' ? d.docType : (d.folder || 'Data'), d.from, ukDate(d.docDate), d.ref ? 'Ref ' + d.ref : ''].filter(Boolean).join(' · '))}</small>${words.length && snip(d) ? `<small>${esc(snip(d))}</small>` : ''}</li>`).join('')}</ul>` : `<p class="muted">${docs.length ? 'Nothing matches.' : 'No documents in this inventory file.'}</p>`}
      <p class="muted small">Copies chosen on the PC (right-click a document → Keep a copy on my phone), as they were when the file was saved.</p>
      <button class="btn" data-act="closeSheet">Close</button>`);
    const box = $('docQ');
    box.oninput = () => { const pos = box.selectionStart; showDocs(box.value); const b = $('docQ'); b.focus(); b.setSelectionRange(pos, pos); };
  }
  function showDoc(id) {
    const d = inv && (inv.docs || []).find(x => x.id === id);
    if (!d) return toast('That document isn\'t in the inventory on this phone.');
    const rows = [['Type', d.kind === 'document' ? d.docType : (d.folder || 'Data')], ['From', d.from], ['Date on it', ukDate(d.docDate)], ['Reference', d.ref], ['Reply or act by', ukDate(d.actBy)]].filter(([, v]) => v);
    const items = (d.assetIds || []).map(x => inv.items.find(a => a.id === x)).filter(Boolean);
    sheet(`<div class="detail"><h2>${esc(d.title)}</h2>
      <div class="kv">${rows.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
      ${d.notes ? `<p style="white-space:pre-wrap">${esc(d.notes)}</p>` : ''}
      ${items.length ? `<p class="small">Linked to: ${items.map(a => `<a href="#" data-act="invItemOpen" data-id="${a.id}">${esc(a.name)}</a>`).join(', ')}</p>` : ''}
      <div class="readpages">${d.pages.map((src, i) => `<img src="${src}" alt="Page ${i + 1}" loading="lazy">`).join('')}</div>
      ${d.pages.length ? `<p class="muted small">${d.pages.length} page${d.pages.length === 1 ? '' : 's'}. Pinch to zoom.</p>` : '<p class="muted">No pages to show for this one.</p>'}
      ${d.missing && d.missing.length ? `<p class="muted small">Not in the phone copy: ${d.missing.map(esc).join(', ')}</p>` : ''}
      <button class="btn" data-act="docs">← All documents</button><button class="btn" data-act="closeSheet">Close</button></div>`);
  }

  function showTrips() {
    const trips = (inv && inv.trips) || [];
    sheet(`<h2>⛺ Packing lists</h2>${trips.length ? `<ul class="stocklist">${trips.map(t => `<li data-act="trip" data-id="${t.id}">${esc(t.name)}<small>${t.items.length + t.extras.length} things${t.startDate ? ' · ' + ukDate(t.startDate) : ''}</small></li>`).join('')}</ul>` : '<p class="muted">No packing lists in this inventory file. Make one on the PC, then save a new inventory file.</p>'}
      <button class="btn" data-act="closeSheet">Close</button>`);
  }
  let tripMode = 'packed';
  async function showTrip(id, mode) {
    if (mode) tripMode = mode;
    const t = inv.trips.find(x => x.id === id); if (!t) return;
    const rows = await tripRows(t);
    const done = rows.filter(r => r[tripMode]).length;
    sheet(`<h2>⛺ ${esc(t.name)}</h2>
      <div class="chips"><button class="chip mode ${tripMode === 'packed' ? 'on' : ''}" data-act="tripMode" data-id="${id}" data-mode="packed">Packing</button><button class="chip mode ${tripMode === 'back' ? 'on' : ''}" data-act="tripMode" data-id="${id}" data-mode="back">Coming home</button></div>
      <p class="muted">${done} of ${rows.length} ${tripMode === 'packed' ? 'packed' : 'back home'}${done === rows.length && rows.length ? ' ✓ All done' : ''}</p>
      <button class="btn primary" data-act="tripScan" data-id="${id}">📷 Scan labels to tick them</button>
      <ul class="stocklist">${rows.map(r => `<li data-act="tripTick" data-id="${id}" data-key="${r.key}" class="${r[tripMode] ? 'ticked' : ''}"><span class="box">${r[tripMode] ? '☑' : '☐'}</span> ${esc(r.name)}${r.where ? `<small>${esc(r.where)}</small>` : r.extra ? '<small>not in OpenSafe</small>' : ''}</li>`).join('')}</ul>
      <button class="btn" data-act="tripReset" data-id="${id}">Untick all on this phone</button>
      <button class="btn" data-act="trips">Back</button>`);
  }
  async function tripScan(id) {
    const t = inv.trips.find(x => x.id === id); if (!t) return;
    closeSheet();
    const which = tripMode;
    try {
      $('scanMsg').textContent = which === 'packed' ? 'Scan each thing as you pack it' : 'Scan each thing as you unpack it';
      let rows = await tripRows(t);
      $('scanCount').textContent = `${rows.filter(r => r[which]).length} of ${rows.length}`;
      await scanMany(['qr_code'], (text) => {
        const key = idFromLabel(text);
        if (!key) return { text: 'That isn\'t an OpenSafe item label', warn: true };
        const r = rows.find(x => x.key === key);
        if (!r) { const a = inv.items.find(x => x.id === key); return { text: `⚠ ${a ? a.name : 'That item'} isn't on this list`, warn: true }; }
        r[which] = true; if (which === 'back') r.packed = true;
        setTick(id, key, which, true);
        return { text: `✓ ${r.name}`, count: `${rows.filter(x => x[which]).length} of ${rows.length}` };
      });
    } catch (ex) { stopScan(); toast(ex.message, 5000); }
    $('scanCloseBtn').textContent = 'Cancel';
    showTrip(id);
  }

  async function startStockCheck() {
    await loadUpdates();
    if (!(await autoOpen())) {
      const have = await kvGet('inventory');
      toast(have ? 'Open My inventory first: the stock check compares your labels with it.' : 'Load your inventory from the PC first (My inventory tab).', 5000);
      setTab('inv'); return;
    }
    const counts = {};
    for (const a of inv.items) {
      const st = currentState(a.id); if (GONE.includes(st.status)) continue;
      const parts = (st.location || '').split(' / ').filter(Boolean);
      const paths = parts.length ? parts.map((_, i) => parts.slice(0, i + 1).join(' / ')) : [''];
      for (const l of paths) counts[l] = (counts[l] || 0) + 1;
    }
    const label = (l) => { if (!l) return 'No location set'; const p = l.split(' / '); return '\u00a0\u00a0'.repeat(p.length - 1) + (p.length > 1 ? '└ ' : '') + p[p.length - 1]; };
    sheet(`<form id="stockForm"><h2>📋 Stock check</h2>
      <p class="muted">Choose the place you're checking, then scan every OpenSafe label you can find there. At the end you'll see what's missing and what's in the wrong place.</p>
      <label>Place<select name="loc">${Object.keys(counts).sort((x, y) => x.localeCompare(y)).map(l => `<option value="${esc(l)}">${esc(label(l))} (${counts[l]} item${counts[l] === 1 ? '' : 's'})</option>`).join('')}<option value="*">Everywhere: just list what I find</option></select></label>
      <button class="btn primary" type="submit">📷 Start scanning</button>
      <button class="btn" type="button" data-act="closeSheet">Cancel</button></form>`);
  }
  async function runStockScan() {
    closeSheet();
    const loc = stock.loc;
    try {
      $('scanMsg').textContent = loc === '*' ? 'Scan each label' : `Scan each label in ${loc || 'items with no location'}`;
      $('scanCount').textContent = stock.found.size ? `${stock.found.size} found` : '';
      await scanMany(['qr_code'], (text) => {
        const id = idFromLabel(text);
        if (!id && placeFromLabel(text)) return { text: 'That\'s a place label. Scan the items.', warn: true };
        if (!id) return { text: 'That isn\'t an OpenSafe label', warn: true };
        const a = inv.items.find(x => x.id === id);
        if (!a) { stock.unknown.add(id); return { text: `? This label isn't in your inventory copy (${id.slice(0, 8)})`, warn: true, count: `${stock.found.size} found` }; }
        stock.found.add(id);
        const where = currentState(id).location || '';
        const ok = loc === '*' || inLoc(where, loc);
        return { text: ok ? `✓ ${a.name}` : `⚠ ${a.name}: recorded in ${where || 'no location'}`, warn: !ok, count: `${stock.found.size} found` };
      });
    } catch (ex) { stopScan(); toast(ex.message, 5000); }
    $('scanCloseBtn').textContent = 'Cancel';
    showStockResults();
  }
  function showStockResults() {
    const loc = stock.loc;
    const row = (a, extra) => `<li data-act="itemActions" data-id="${a.id}">${esc(a.name)}${extra ? `<small>${esc(extra)}</small>` : ''}</li>`;
    const found = [...stock.found].map(id => inv.items.find(x => x.id === id)).filter(Boolean);
    const here = loc === '*' ? found : found.filter(a => inLoc(currentState(a.id).location || '', loc));
    const wrong = loc === '*' ? [] : found.filter(a => !inLoc(currentState(a.id).location || '', loc));
    const missing = loc === '*' ? [] : inv.items.filter(a => { const st = currentState(a.id); return inLoc(st.location || '', loc) && !GONE.includes(st.status) && st.status !== 'Lent out' && !stock.found.has(a.id); });
    const lent = loc === '*' ? [] : inv.items.filter(a => { const st = currentState(a.id); return inLoc(st.location || '', loc) && st.status === 'Lent out' && !stock.found.has(a.id); });
    const place = loc === '*' ? 'everywhere' : (loc || 'no location');
    sheet(`<h2>📋 Stock check: ${esc(place)}</h2>
      <p class="muted" style="margin-top:-6px">${found.length} label${found.length === 1 ? '' : 's'} scanned${loc === '*' ? '' : `, ${missing.length} not found`}.</p>
      ${wrong.length ? `<h3 class="stockh">⚠ In the wrong place (${wrong.length})</h3><ul class="stocklist">${wrong.map(a => row(a, 'Recorded in ' + (currentState(a.id).location || 'no location'))).join('')}</ul>
        <button class="btn primary" data-act="stockMove">Record ${wrong.length === 1 ? 'it' : 'all ' + wrong.length} as moved to ${esc(place)}</button>` : ''}
      ${missing.length ? `<h3 class="stockh">✗ Not found (${missing.length})</h3><ul class="stocklist">${missing.map(a => row(a)).join('')}</ul><p class="muted small">Tap an item to move it, mark it lost, or add a note.</p>` : ''}
      ${lent.length ? `<h3 class="stockh">🤝 Lent out, not expected here (${lent.length})</h3><ul class="stocklist">${lent.map(a => row(a, 'With ' + (currentState(a.id).lentTo || 'someone'))).join('')}</ul>` : ''}
      ${here.length ? `<h3 class="stockh">✓ ${loc === '*' ? 'Found' : 'Where they should be'} (${here.length})</h3><ul class="stocklist">${here.map(a => { const w = currentState(a.id).location || ''; return row(a, loc === '*' || w !== loc ? w : ''); }).join('')}</ul>` : ''}
      ${stock.unknown.size ? `<h3 class="stockh">? Labels not in your inventory copy (${stock.unknown.size})</h3><p class="muted small">They may be newer than the inventory file on this phone. Save a new one on the PC.</p>` : ''}
      <button class="btn" data-act="stockMore">📷 Scan more</button>
      <button class="btn" data-act="stockDone">Finish stock check</button>`);
  }
  async function stockMoveAll() {
    const loc = stock.loc;
    await loadUpdates();
    const wrong = [...stock.found].map(id => inv.items.find(x => x.id === id)).filter(a => a && !inLoc(currentState(a.id).location || '', loc));
    const at = new Date().toISOString();
    for (const a of wrong) updates.push({ id: uid(), itemId: a.id, itemName: a.name, at, kind: 'move', changes: { location: loc }, summary: `Moved to ${loc} (found in a stock check)`, note: '', exportedAt: null });
    await kvSet('updates', updates);
    toast(`✓ ${wrong.length} move${wrong.length === 1 ? '' : 's'} saved. Export to send them to your PC.`, 4000);
    showStockResults();
  }

  function stopScan() {
    clearTimeout(scanTimer);
    if (scanStream) scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
    $('scanner').classList.add('hidden');
  }

  // ---------- scan a room: the camera recognises everyday things, on the phone ----------
  // Uses MediaPipe's object detector (files in detector/, Apache-2.0) with Google's EfficientDet-Lite0
  // model. The model is downloaded once from Google, checked against this SHA-256, and kept here.
  // The camera picture is never sent anywhere. MediaPipe's own usage metrics are blocked by the CSP.
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
  const MODEL_SHA256 = '0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb';
  const ENGINE_FILES = ['detector/vision_wasm_internal.wasm', 'detector/vision_wasm_internal.js', 'detector/vision_bundle.mjs'];
  // The things worth recording, with a name and an OpenSafe category. People, pets, food, cups and so on are ignored.
  const ROOM_THINGS = {
    tv: ['TV', 'Electronics'], laptop: ['Laptop', 'Computers & Phones'], keyboard: ['Keyboard', 'Computers & Phones'], mouse: ['Computer mouse', 'Computers & Phones'],
    'cell phone': ['Phone', 'Computers & Phones'], microwave: ['Microwave', 'Appliances'], oven: ['Oven', 'Appliances'], toaster: ['Toaster', 'Appliances'],
    refrigerator: ['Fridge', 'Appliances'], 'hair drier': ['Hair dryer', 'Appliances'], couch: ['Sofa', 'Furniture'], chair: ['Chair', 'Furniture'], bed: ['Bed', 'Furniture'],
    'dining table': ['Table', 'Furniture'], bench: ['Bench', 'Furniture'], clock: ['Clock', 'Other'], vase: ['Vase', 'Other'], bicycle: ['Bicycle', 'Sports & Hobbies'],
    motorcycle: ['Motorbike', 'Vehicles'], car: ['Car', 'Vehicles'], truck: ['Van or truck', 'Vehicles'], boat: ['Boat', 'Marine'], backpack: ['Backpack', 'Camping & Outdoor'],
    suitcase: ['Suitcase', 'Other'], handbag: ['Handbag', 'Clothing'], umbrella: ['Umbrella', 'Other'], skis: ['Skis', 'Sports & Hobbies'], snowboard: ['Snowboard', 'Sports & Hobbies'],
    surfboard: ['Surfboard', 'Sports & Hobbies'], skateboard: ['Skateboard', 'Sports & Hobbies'], 'tennis racket': ['Tennis racket', 'Sports & Hobbies'], kite: ['Kite', 'Sports & Hobbies'],
    'baseball bat': ['Baseball bat', 'Sports & Hobbies'], 'baseball glove': ['Baseball glove', 'Sports & Hobbies']
  };
  let detector = null, room = null, roomTimer = null, roomStream = null;
  const mb = (n) => (n / 1048576).toFixed(1);

  async function sha256Hex(buf) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(x => x.toString(16).padStart(2, '0')).join(''); }
  async function fetchWithProgress(url, onBytes) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!r.body || !r.body.getReader) { const b = await r.arrayBuffer(); onBytes(b.byteLength); return b; }
    const rd = r.body.getReader(), parts = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; onBytes(value.length); }
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out.buffer;
  }
  // First time only: the engine (from this app's site) and the model (from Google), about 19 MB.
  async function downloadRecogniser(show) {
    const total = 14665716 + 336624 + 155990 + 4602795; let got = 0;
    const tick = (n) => { got += n; show(`Downloading the recognition files: ${mb(got)} of ${mb(total)} MB`); };
    for (const f of ENGINE_FILES) await fetchWithProgress(f, tick); // the service worker keeps these
    const model = await fetchWithProgress(MODEL_URL, tick);
    if (await sha256Hex(model) !== MODEL_SHA256) throw new Error('The downloaded model file isn\'t the expected one, so it wasn\'t used. Try again later.');
    await kvSet('detectorModel', model);
    return model;
  }
  async function getDetector(show) {
    if (detector) return detector;
    let model = await kvGet('detectorModel');
    if (!model) model = await downloadRecogniser(show);
    show('Starting the recogniser…');
    const { ObjectDetector } = await import('./detector/vision_bundle.mjs');
    const files = { wasmLoaderPath: new URL('detector/vision_wasm_internal.js', location.href).href, wasmBinaryPath: new URL('detector/vision_wasm_internal.wasm', location.href).href };
    // CPU: the int8 model isn't supported on MediaPipe's GPU path (Google lists no GPU timing for it).
    detector = await ObjectDetector.createFromOptions(files, { baseOptions: { modelAssetBuffer: new Uint8Array(model.slice(0)), delegate: 'CPU' }, runningMode: 'VIDEO', scoreThreshold: 0.45, maxResults: 20 });
    return detector;
  }

  function roomStart() {
    learnedLists();
    sheet(`<h2>🔍 Scan a room</h2>
      <p>Walk slowly round the room pointing the camera at your things. The phone recognises everyday items (TVs, laptops, sofas, chairs, fridges, bikes, motorbikes and more) and makes a draft item for each, with a photo.</p>
      <p class="muted small">It can't recognise tools, jewellery or most small things, and it doesn't know brands. Add those yourself. The camera picture stays on this phone.</p>
      <form id="roomForm"><label>Which room or place?<input name="place" list="locs" maxlength="200" placeholder="e.g. Home / Lounge" required></label>
      <div id="roomMsg" class="muted small"></div>
      <button class="btn primary" type="submit">Start scanning</button></form>
      <button class="btn" data-act="closeSheet">Cancel</button>`);
    const f = $('roomForm');
    f.elements.place.value = localStorage.getItem('roomPlace') || '';
    f.onsubmit = async (e) => {
      e.preventDefault();
      const place = f.elements.place.value.trim();
      if (!place) return;
      try { localStorage.setItem('roomPlace', place); } catch (_) {}
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      const show = (t) => { if ($('roomMsg')) $('roomMsg').textContent = t; };
      try { await getDetector(show); }
      catch (ex) {
        btn.disabled = false;
        show(navigator.onLine === false || /fetch|network|HTTP/i.test(String(ex && ex.message)) ? 'The first scan needs the internet once, to download the recognition files (about 19 MB). After that it works offline.' : String(ex && ex.message || ex));
        return;
      }
      closeSheet();
      roomScan(place).catch(ex => { roomStop(); toast(ex.message || String(ex), 5000); });
    };
  }

  async function roomScan(place) {
    room = { place, best: {}, lastShot: {}, errors: 0 };
    roomStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const v = $('roomVideo'); v.srcObject = roomStream; await v.play();
    $('roomFound').textContent = 'Point the camera at your things';
    $('roomScanner').classList.remove('hidden');
    const cv = $('roomBoxes'), g = cv.getContext('2d');
    const small = document.createElement('canvas'), sg = small.getContext('2d', { willReadFrequently: true });
    const loop = () => {
      if (!roomStream) return;
      try {
        if (v.readyState >= 2 && v.videoWidth) {
          // A small copy of the frame: quicker, and works on phones without WebGL. Boxes are scaled back up.
          const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
          const sw = Math.round(v.videoWidth * k), sh = Math.round(v.videoHeight * k);
          if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
          sg.drawImage(v, 0, 0, sw, sh);
          const res = detector.detectForVideo(sg.getImageData(0, 0, sw, sh), performance.now());
          const up = (b) => ({ originX: b.originX / k, originY: b.originY / k, width: b.width / k, height: b.height / k });
          const hits = (res.detections || []).map(d => ({ label: d.categories[0] && d.categories[0].categoryName, score: d.categories[0] ? d.categories[0].score : 0, box: up(d.boundingBox) })).filter(d => ROOM_THINGS[d.label]);
          drawBoxes(cv, g, v, hits);
          const byLabel = {};
          for (const h of hits) (byLabel[h.label] = byLabel[h.label] || []).push(h);
          for (const [label, list] of Object.entries(byLabel)) {
            const best = room.best[label], sum = list.reduce((s, h) => s + h.score, 0);
            const better = !best || list.length > best.count || (list.length === best.count && sum > best.sum + 0.05);
            if (better && Date.now() - (room.lastShot[label] || 0) > 700) { room.lastShot[label] = Date.now(); room.best[label] = { count: list.length, sum, shots: grab(v, list) }; }
          }
          $('roomFound').textContent = foundText() || 'Point the camera at your things';
          room.errors = 0;
        }
      } catch (ex) {
        // Keep going over the odd bad frame, but stop if it never works (for example no WebGL in this browser).
        if (++room.errors > 15) { roomStop(); room = null; sheet(`<h2>Scan a room can't run here</h2><p>This browser couldn't run the recogniser. It needs Chrome with graphics acceleration (WebGL) turned on. You can still add items with <b>+ Add item</b>.</p><p class="muted small">${esc(String(ex && ex.message || ex))}</p><button class="btn" data-act="closeSheet">OK</button>`); return; }
      }
      roomTimer = setTimeout(loop, 300);
    };
    loop();
  }
  // Boxes over the picture. The video fills the screen (object-fit: cover), so scale and offset to match.
  function drawBoxes(cv, g, v, hits) {
    const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const s = Math.max(W / v.videoWidth, H / v.videoHeight), ox = (W - v.videoWidth * s) / 2, oy = (H - v.videoHeight * s) / 2;
    g.lineWidth = 3; g.font = '600 15px system-ui, sans-serif';
    for (const h of hits) {
      const x = ox + h.box.originX * s, y = oy + h.box.originY * s, w = h.box.width * s, hh = h.box.height * s;
      g.strokeStyle = '#3ddbb8'; g.strokeRect(x, y, w, hh);
      const t = ROOM_THINGS[h.label][0], tw = g.measureText(t).width + 12;
      g.fillStyle = '#3ddbb8'; g.fillRect(x, Math.max(0, y - 24), tw, 24); g.fillStyle = '#062a24'; g.fillText(t, x + 6, Math.max(17, y - 7));
    }
  }
  // A copy of the frame and a close-up of each thing in it (the boxes are separate things, as they were seen together).
  function grab(v, list) {
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const shots = { frame: null, crops: list.map(() => null) };
    c.toBlob(b => { shots.frame = b; }, 'image/jpeg', 0.85);
    list.forEach((h, i) => {
      const pad = 0.12, bx = h.box;
      const x = Math.max(0, bx.originX - bx.width * pad), y = Math.max(0, bx.originY - bx.height * pad);
      const w = Math.min(c.width - x, bx.width * (1 + 2 * pad)), hh = Math.min(c.height - y, bx.height * (1 + 2 * pad));
      const k = Math.min(1, 1400 / Math.max(w, hh)), cc = document.createElement('canvas');
      cc.width = Math.max(1, Math.round(w * k)); cc.height = Math.max(1, Math.round(hh * k));
      cc.getContext('2d').drawImage(c, x, y, w, hh, 0, 0, cc.width, cc.height);
      cc.toBlob(b => { shots.crops[i] = b; }, 'image/jpeg', 0.88);
    });
    return shots;
  }
  function foundText() {
    const parts = Object.entries(room.best).map(([l, b]) => b.count > 1 ? `${b.count} × ${ROOM_THINGS[l][0]}` : ROOM_THINGS[l][0]);
    return parts.length ? 'Found: ' + parts.join(', ') : '';
  }
  function roomStop() {
    clearTimeout(roomTimer);
    if (roomStream) roomStream.getTracks().forEach(t => t.stop());
    roomStream = null;
    $('roomScanner').classList.add('hidden');
  }
  async function roomFinish() {
    roomStop();
    await new Promise(r => setTimeout(r, 250)); // let the last photos finish encoding
    const rows = [];
    for (const [label, b] of Object.entries(room.best)) b.shots.crops.forEach((crop, i) => { if (crop) rows.push({ label, crop, frame: b.shots.frame, n: b.count > 1 ? i + 1 : 0 }); });
    room.rows = rows;
    if (!rows.length) { sheet(`<h2>Nothing recognised</h2><p>The phone didn't recognise anything it can record in <b>${esc(room.place)}</b>. It knows everyday things such as TVs, laptops, sofas, chairs, fridges and bikes. Try again in better light, or add items yourself.</p><button class="btn primary" data-act="roomAgain">Scan again</button><button class="btn" data-act="closeSheet">Close</button>`); return; }
    sheet(`<h2>Found in ${esc(room.place)}</h2>
      <p class="muted small">Untick anything that's wrong or already in OpenSafe, and rename as you like. Each one is saved as a new item with its photo, ready to export. If there are more of something than shown, add them yourself or scan again.</p>
      <div class="roomrows">${rows.map((r, i) => `<label class="roomrow"><input type="checkbox" data-room-i="${i}" checked><img src="${blobUrl(r.crop)}" alt=""><span class="t"><input type="text" data-room-name="${i}" value="${esc(ROOM_THINGS[r.label][0])}" maxlength="200" aria-label="Name"><span class="m">${esc(ROOM_THINGS[r.label][1])}</span></span></label>`).join('')}</div>
      <button class="btn primary" data-act="roomSave">Save ${rows.length} item${rows.length === 1 ? '' : 's'}</button>
      <button class="btn" data-act="roomAgain">Scan again</button>
      <button class="btn" data-act="closeSheet">Discard</button>`);
    const upd = () => { const n = document.querySelectorAll('[data-room-i]:checked').length; const b = document.querySelector('[data-act=roomSave]'); b.textContent = `Save ${n} item${n === 1 ? '' : 's'}`; b.disabled = !n; };
    document.querySelectorAll('[data-room-i]').forEach(c => { c.onchange = upd; });
  }
  async function roomSave() {
    const now = new Date().toISOString(), day = todayLocal(), slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let saved = 0;
    for (const c of document.querySelectorAll('[data-room-i]:checked')) {
      const i = Number(c.dataset.roomI), r = room.rows[i];
      const name = (document.querySelector(`[data-room-name="${i}"]`).value || '').trim() || ROOM_THINGS[r.label][0];
      const item = { id: uid(), createdAt: now, updatedAt: now, exportedAt: null, receipts: [], photos: [] };
      for (const k of FIELDS) item[k] = '';
      Object.assign(item, { name, category: ROOM_THINGS[r.label][1], location: room.place, tags: 'room scan' });
      item.photos.push({ id: uid(), name: `${slug(name) || 'item'}.jpg`, type: 'image/jpeg', blob: r.crop, takenAt: day });
      if (r.frame) item.photos.push({ id: uid(), name: `${slug(name) || 'item'}-in-room.jpg`, type: 'image/jpeg', blob: r.frame, takenAt: day });
      await putItem(item); saved++;
    }
    closeSheet(); room = null;
    toast(`✓ ${saved} item${saved === 1 ? '' : 's'} saved. Add brands, prices and serial numbers when you can.`, 4500);
    showHome();
  }

  // ---------- scan a document: photograph each page; it's straightened and cleaned up on the phone ----------
  // The pages go to the PC in the next export, where they become one PDF in Documents and their words are read.
  const DOC_TYPES = ['Letter', 'Bill', 'Bank statement', 'Benefits & pension', 'Medical', 'Legal', 'Tax', 'Insurance', 'Vehicle', 'Home', 'Work', 'Identity', 'Certificate', 'Other'];
  const docTx = async (mode, fn) => { const d = await db(); return new Promise((resolve, reject) => { const t = d.transaction('docs', mode); let out; Promise.resolve(fn(t.objectStore('docs'))).then(v => { out = v; }); t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('Storage error')); }); };
  const allDocs = () => docTx('readonly', s => req(s.getAll()));
  const putDoc = (d) => docTx('readwrite', s => req(s.put(d)));
  const delDoc = (id) => docTx('readwrite', s => req(s.delete(id)));
  let docs = [];
  let dscan = null; // { doc, stream, timer }  scanning in progress
  let adj = null;   // { canvas (full picture), corners [{x,y}x4], mode, rotate }  adjusting one page

  // --- finding the page: the biggest bright area (paper) in a small copy of the picture ---
  function findPage(src) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const W = 240, k = W / Math.max(sw, sh);
    const w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, n = w * h, lum = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8; lum[i] = v; hist[v]++; }
    // Otsu threshold between paper and background
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = t; } }
    const lab = new Int32Array(n).fill(-1); let bestLab = -1, bestSize = 0; const stack = new Int32Array(n);
    for (let i = 0, l = 0; i < n; i++) {
      if (lab[i] !== -1 || lum[i] <= th) continue;
      let sp = 0, size = 0; stack[sp++] = i; lab[i] = l;
      while (sp) { const j = stack[--sp]; size++; const x = j % w, y = (j / w) | 0;
        if (x > 0 && lab[j - 1] === -1 && lum[j - 1] > th) { lab[j - 1] = l; stack[sp++] = j - 1; }
        if (x < w - 1 && lab[j + 1] === -1 && lum[j + 1] > th) { lab[j + 1] = l; stack[sp++] = j + 1; }
        if (y > 0 && lab[j - w] === -1 && lum[j - w] > th) { lab[j - w] = l; stack[sp++] = j - w; }
        if (y < h - 1 && lab[j + w] === -1 && lum[j + w] > th) { lab[j + w] = l; stack[sp++] = j + w; } }
      if (size > bestSize) { bestSize = size; bestLab = l; }
      l++;
    }
    if (bestLab < 0 || bestSize < n * 0.12) return null;
    let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
    for (let i = 0; i < n; i++) { if (lab[i] !== bestLab) continue; const x = i % w, y = (i / w) | 0;
      if (x + y < tl[2]) tl = [x, y, x + y]; if (x + y > br[2]) br = [x, y, x + y]; if (x - y > tr[2]) tr = [x, y, x - y]; if (x - y < bl[2]) bl = [x, y, x - y]; }
    const q = [tl, tr, br, bl].map(p => ({ x: (p[0] + 0.5) / k, y: (p[1] + 0.5) / k }));
    const area = Math.abs(q.reduce((s, p, i) => { const r = q[(i + 1) % 4]; return s + p.x * r.y - r.x * p.y; }, 0) / 2);
    if (area < sw * sh * 0.12) return null;
    if (bestSize / (area * k * k) < 0.75) return null; // not a clean four-sided shape
    // a page that fills the whole picture means the background was bright too: don't trust it
    if (area > sw * sh * 0.97) return null;
    return q;
  }
  const defaultCorners = (w, h) => { const m = 0.06; return [{ x: w * m, y: h * m }, { x: w * (1 - m), y: h * m }, { x: w * (1 - m), y: h * (1 - m) }, { x: w * m, y: h * (1 - m) }]; };

  // --- straighten: map the four corners to a flat rectangle (perspective correction) ---
  function homography(src, dst) { // 3x3 mapping dst -> src, from 4 point pairs
    const A = [], b = [];
    for (let i = 0; i < 4; i++) { const { x, y } = dst[i], u = src[i].x, v = src[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
    for (let c = 0; c < 8; c++) { // Gaussian elimination
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
    }
    return b.map((v, i) => v / A[i][i]);
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function straighten(srcCanvas, q, mode) {
    const wq = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, hq = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    const k = Math.min(1.25, 2200 / Math.max(wq, hq));
    const W = Math.max(50, Math.round(wq * k)), H = Math.max(50, Math.round(hq * k));
    const m = homography(q, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]);
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const sd = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const og = out.getContext('2d'), od = og.createImageData(W, H), o = od.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const z = m[6] * x + m[7] * y + 1, u = (m[0] * x + m[1] * y + m[2]) / z, v = (m[3] * x + m[4] * y + m[5]) / z;
      const x0 = Math.max(0, Math.min(sw - 2, u | 0)), y0 = Math.max(0, Math.min(sh - 2, v | 0)), fx = Math.min(1, Math.max(0, u - x0)), fy = Math.min(1, Math.max(0, v - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, oi = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) o[oi + ch] = (sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx) * (1 - fy) + (sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx) * fy;
      o[oi + 3] = 255;
    }
    cleanUp(o, W, H, mode);
    og.putImageData(od, 0, 0);
    return out;
  }
  // Even out the light (shadows, a dim corner) by dividing by the paper's brightness around each point.
  function cleanUp(o, W, H, mode) {
    const B = 32, gw = Math.ceil(W / B), gh = Math.ceil(H / B), bg = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const hist = new Uint32Array(64); let cnt = 0;
      for (let y = gy * B; y < Math.min(H, gy * B + B); y += 2) for (let x = gx * B; x < Math.min(W, gx * B + B); x += 2) { const i = (y * W + x) * 4; hist[((o[i] + o[i + 1] + o[i + 2]) / 3) >> 2]++; cnt++; }
      let acc = 0, t = 63; for (; t > 0; t--) { acc += hist[t]; if (acc >= cnt * 0.1) break; } // the brightest 10% is paper
      bg[gy * gw + gx] = Math.max(40, t * 4 + 2);
    }
    const bgAt = (x, y) => { const fx = Math.min(gw - 1, Math.max(0, x / B - 0.5)), fy = Math.min(gh - 1, Math.max(0, y / B - 0.5)); const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      return (bg[y0 * gw + x0] * (1 - ax) + bg[y0 * gw + x1] * ax) * (1 - ay) + (bg[y1 * gw + x0] * (1 - ax) + bg[y1 * gw + x1] * ax) * ay; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, b = bgAt(x, y);
      if (mode === 'colour') { for (let ch = 0; ch < 3; ch++) o[i + ch] = Math.min(255, o[i + ch] * 245 / b); }
      else { let v = ((o[i] * 77 + o[i + 1] * 150 + o[i + 2] * 29) >> 8) * 255 / b; v = v >= 235 ? 255 : Math.max(0, (v - 40) * 255 / 195); o[i] = o[i + 1] = o[i + 2] = v; }
    }
  }

  // --- screens ---
  async function docNew() {
    dscan = { doc: { id: uid(), createdAt: new Date().toISOString(), exportedAt: null, title: '', docType: 'Letter', from: '', docDate: '', ref: '', actBy: '', notes: '', pages: [] } };
    await docCamera();
  }
  async function docCamera() {
    try {
      dscan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    } catch (ex) { toast('The camera isn\'t available. You can choose photos instead.', 4500); docDetails(); return; }
    const v = $('docVideo'); v.srcObject = dscan.stream; await v.play();
    $('docScanner').classList.remove('hidden');
    docCount();
    const cv = $('docOutline'), g = cv.getContext('2d');
    const loop = () => {
      if (!dscan || !dscan.stream) return;
      try {
        if (v.videoWidth) {
          const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
          if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
          g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
          const q = findPage(v);
          if (q) { const s = Math.max(W / v.videoWidth, H / v.videoHeight), ox = (W - v.videoWidth * s) / 2, oy = (H - v.videoHeight * s) / 2;
            g.beginPath(); q.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, ox + p.x * s, oy + p.y * s)); g.closePath();
            g.fillStyle = 'rgba(61,219,184,.18)'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#3ddbb8'; g.stroke(); }
          $('docHint').textContent = q ? 'Page found. Hold still and tap the button.' : 'Fit the whole page in view, ideally on a darker surface.';
        }
      } catch (_) { /* keep going */ }
      dscan.timer = setTimeout(loop, 350);
    };
    loop();
  }
  function docCount() { const n = dscan ? dscan.doc.pages.length : 0; $('docDoneBtn').textContent = n ? `Done (${n} page${n === 1 ? '' : 's'})` : 'Done'; }
  function docStopCamera() { if (!dscan) return; clearTimeout(dscan.timer); if (dscan.stream) dscan.stream.getTracks().forEach(t => t.stop()); dscan.stream = null; $('docScanner').classList.add('hidden'); }
  function docShoot() {
    const v = $('docVideo'); if (!v.videoWidth) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
    docStopCamera();
    docAdjust(c, true);
  }
  // Pick the corners, colour or black and white, and rotation.
  function docAdjust(canvas, fromCamera) {
    const q = findPage(canvas);
    adj = { canvas, corners: q || defaultCorners(canvas.width, canvas.height), found: !!q, mode: adj ? adj.mode : 'clean', rotate: 0, fromCamera };
    $('docAdjust').classList.remove('hidden');
    $('docAdjMsg').textContent = q ? 'Drag the corners if they\'re not quite on the page.' : 'Couldn\'t find the page edges. Drag the corners to the page\'s corners.';
    docAdjMode();
    requestAnimationFrame(docDrawAdjust);
  }
  function docAdjMode() { for (const b of document.querySelectorAll('[data-act=docMode]')) b.classList.toggle('on', b.dataset.mode === adj.mode); }
  function adjGeom() {
    const box = $('docAdjBox'), cw = box.clientWidth, ch = box.clientHeight, c = adj.canvas;
    const s = Math.min(cw / c.width, ch / c.height); return { s, ox: (cw - c.width * s) / 2, oy: (ch - c.height * s) / 2, cw, ch };
  }
  function docDrawAdjust() {
    if (!adj) return;
    const cv = $('docAdjCanvas'), { s, ox, oy, cw, ch } = adjGeom(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
    g.drawImage(adj.canvas, ox, oy, adj.canvas.width * s, adj.canvas.height * s);
    const pts = adj.corners.map(p => ({ x: ox + p.x * s, y: oy + p.y * s }));
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, p.x, p.y)); g.closePath();
    g.fillStyle = 'rgba(61,219,184,.15)'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#3ddbb8'; g.stroke();
    pts.forEach((p, i) => { const h = $('docH' + i); h.style.left = p.x + 'px'; h.style.top = p.y + 'px'; });
  }
  function wireAdjustHandles() {
    for (let i = 0; i < 4; i++) {
      const h = $('docH' + i);
      h.onpointerdown = (e) => {
        e.preventDefault(); h.setPointerCapture(e.pointerId);
        const move = (ev) => { const { s, ox, oy } = adjGeom(), r = $('docAdjBox').getBoundingClientRect();
          adj.corners[i] = { x: Math.max(0, Math.min(adj.canvas.width, (ev.clientX - r.left - ox) / s)), y: Math.max(0, Math.min(adj.canvas.height, (ev.clientY - r.top - oy) / s)) }; docDrawAdjust(); };
        h.onpointermove = move;
        h.onpointerup = h.onpointercancel = () => { h.onpointermove = null; };
      };
    }
  }
  function rotateCanvas(c) { const r = document.createElement('canvas'); r.width = c.height; r.height = c.width; const g = r.getContext('2d'); g.translate(r.width, 0); g.rotate(Math.PI / 2); g.drawImage(c, 0, 0); return r; }
  async function docUsePage() {
    const btn = document.querySelector('[data-act=docUse]'); btn.disabled = true; btn.textContent = 'Working…';
    await new Promise(r => setTimeout(r, 30));
    try {
      let out = straighten(adj.canvas, adj.corners, adj.mode);
      for (let i = 0; i < adj.rotate; i++) out = rotateCanvas(out);
      const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', adj.mode === 'colour' ? 0.85 : 0.8));
      dscan.doc.pages.push({ id: uid(), blob, w: out.width, h: out.height });
    } catch (ex) { toast('Couldn\'t process that page: ' + (ex.message || ex), 5000); }
    btn.disabled = false; btn.textContent = 'Use this page';
    const fromCamera = adj.fromCamera;
    $('docAdjust').classList.add('hidden'); adj = { mode: adj.mode };
    if (fromCamera) await docCamera(); else docDetails();
  }
  // Pages so far, and the letter's details.
  function docDetails() {
    const d = dscan.doc;
    sheet(`<h2>📄 ${d.pages.length ? `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}` : 'Scan a document'}</h2>
      <div class="docpages">${d.pages.map((p, i) => `<div class="docpage"><img src="${blobUrl(p.blob)}" alt="Page ${i + 1}"><span class="pn">${i + 1}</span><button type="button" class="x" data-act="docDelPage" data-i="${i}" aria-label="Remove page ${i + 1}">✕</button></div>`).join('')}</div>
      <div class="row2"><button class="btn" data-act="docMore">📷 Add a page</button><label class="btn">🖼 Choose photos<input type="file" accept="image/*" multiple id="docPick" hidden></label></div>
      <form id="docForm">
        <label>Title<input name="title" maxlength="200" placeholder="e.g. Pension award letter" value="${esc(d.title)}"></label>
        <label>Type<select name="docType">${DOC_TYPES.map(t => `<option${t === d.docType ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label>From<input name="from" maxlength="200" placeholder="e.g. Veterans UK, HMRC, the council" value="${esc(d.from)}"></label>
        <div class="row2"><label>Date on it<input type="date" name="docDate" value="${esc(d.docDate)}"></label><label>Reply or act by<input type="date" name="actBy" value="${esc(d.actBy)}"></label></div>
        <label>Reference<input name="ref" maxlength="120" placeholder="Account, case or claim number" value="${esc(d.ref)}"></label>
        <label>Notes<textarea name="notes" rows="2" maxlength="5000">${esc(d.notes)}</textarea></label>
        <button class="btn primary" type="submit" ${d.pages.length ? '' : 'disabled'}>Save document</button></form>
      <p class="muted small">Saved on this phone until you export. On the PC it becomes one PDF in <b>Documents</b>, and its words are read so you can search them.</p>
      <button class="btn" data-act="docCancel">${d.pages.length ? 'Discard' : 'Cancel'}</button>`);
    const f = $('docForm');
    const keepFields = () => { for (const k of ['title', 'docType', 'from', 'docDate', 'actBy', 'ref', 'notes']) d[k] = f.elements[k].value.trim(); };
    f.oninput = keepFields;
    f.onsubmit = async (e) => {
      e.preventDefault(); keepFields();
      if (!d.pages.length) return;
      if (!d.title) d.title = `${d.docType}${d.from ? ' from ' + d.from : ''} (scanned ${ukDate(todayLocal())})`;
      d.updatedAt = new Date().toISOString();
      try { await putDoc(d); } catch (ex) { toast('Couldn\'t save: ' + (ex.message || ex), 6000); return; }
      dscan = null; closeSheet();
      toast(`✓ Saved: ${d.title}. It goes to the PC in your next export.`, 4500);
      renderList();
    };
    $('docPick').onchange = async (e) => {
      keepFields();
      const files = [...e.target.files].slice(0, 30); if (!files.length) return;
      dscan.queue = files;
      docNextPicked();
    };
  }
  async function docNextPicked() {
    const f = dscan.queue && dscan.queue.shift();
    if (!f) { docDetails(); return; }
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const k = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      closeSheet(); docAdjust(c, false);
    } catch (ex) { toast(`${f.name}: couldn't open that picture`, 4000); docNextPicked(); }
  }
  async function docOpen(id) {
    const d = docs.find(x => x.id === id); if (!d) return;
    dscan = { doc: Object.assign({}, d, { pages: d.pages.slice() }), editing: true };
    if (d.exportedAt) {
      sheet(`<h2>📄 ${esc(d.title)}</h2><div class="docpages">${d.pages.map((p, i) => `<div class="docpage"><img src="${blobUrl(p.blob)}" alt="Page ${i + 1}"><span class="pn">${i + 1}</span></div>`).join('')}</div>
        <p class="muted">${esc([d.docType, d.from, d.docDate && ukDate(d.docDate), d.ref && 'Ref ' + d.ref].filter(Boolean).join(' · '))}</p>
        <p class="muted small">Already exported to the PC on ${ukDate(d.exportedAt.slice(0, 10))}. Change its details in OpenSafe on the PC. You can delete the phone's copy to free up space.</p>
        <button class="btn danger" data-act="docDelete">Delete from this phone</button><button class="btn" data-act="closeSheet">Close</button>`);
      return;
    }
    docDetails();
    $('sheetBody').insertAdjacentHTML('beforeend', '<button class="btn danger" data-act="docDelete">Delete this document</button>');
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('#tabs button');
    if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
    const ch = e.target.closest('[data-change]');
    if (ch) {
      const u = updates.find(x => x.id === ch.dataset.change);
      if (u && !u.exportedAt && confirm(`Undo this change?\n\n${u.summary}`)) { updates = updates.filter(x => x.id !== u.id); await kvSet('updates', updates); renderList(); toast('Change removed'); }
      else if (u && u.exportedAt) toast('Already exported. Change it in OpenSafe on the PC if needed.', 4000);
      return;
    }
    const invCard = e.target.closest('[data-inv]');
    if (invCard) { showInvItem(invCard.dataset.inv); return; }
    const card = e.target.closest('.item[data-id]');
    if (card) { const it = items.find(i => i.id === card.dataset.id); if (it) showForm(it); return; }
    const dcard = e.target.closest('[data-doc]');
    if (dcard) { docOpen(dcard.dataset.doc); return; }
    if (e.target.id === 'sheet') { closeSheet(); return; }
    const menuOpen = !$('menu').classList.contains('hidden');
    if (menuOpen && !e.target.closest('#menu') && e.target.id !== 'menuBtn') $('menu').classList.add('hidden');
    const a = e.target.closest('[data-act]');
    if (!a) return;
    $('menu').classList.add('hidden');
    switch (a.dataset.act) {
      case 'new': showForm(null); break;
      case 'export': doExport(false); break;
      case 'exportAll': doExport(true); break;
      case 'share': shareExport(); break;
      case 'download': downloadExport(); break;
      case 'closeSheet': closeSheet(); break;
      case 'scanClose': if (scan.cancel) scan.cancel(); break;
      case 'scanBarcode':
        try {
          $('scanMsg').textContent = 'Point the camera at the barcode';
          const code = await scan(['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf']);
          if (code) { $('form').elements.barcode.value = code; toast('Barcode added. OpenSafe on the PC can look up the product.'); }
        } catch (ex) { stopScan(); toast(ex.message, 5000); }
        break;
      case 'scanLabel': case 'scanItem': scanItemLabel(); break;
      case 'itemActions': showActions(a.dataset.id); break;
      case 'itemAction': actionForm(a.dataset.kind, a.dataset.id); break;
      case 'itemDetails': showInvItem(a.dataset.id); break;
      case 'skipUnlock': if (a.dataset.place) showPlace(a.dataset.place, true); else showActions(a.dataset.id, true); break;
      case 'placePut': putItemsHere(a.dataset.place); break;
      case 'placeStock': stock = { loc: a.dataset.place, found: new Set(), unknown: new Set() }; runStockScan(); break;
      case 'placeShow': showPlace(a.dataset.place); break;
      case 'grabFilter': grabOnly = !grabOnly; renderInv(); break;
      case 'trips': showTrips(); break;
      case 'docs': showDocs(''); break;
      case 'doc': showDoc(a.dataset.id); break;
      case 'invItemOpen': e.preventDefault(); showInvItem(a.dataset.id); break;
      case 'trip': showTrip(a.dataset.id, 'packed'); break;
      case 'tripMode': showTrip(a.dataset.id, a.dataset.mode); break;
      case 'tripScan': tripScan(a.dataset.id); break;
      case 'tripTick': { const t = inv.trips.find(x => x.id === a.dataset.id); const r = (await tripRows(t)).find(x => x.key === a.dataset.key); if (r) await setTick(t.id, r.key, tripMode, !r[tripMode]); showTrip(t.id); break; }
      case 'tripReset': if (confirm('Untick everything on this list on this phone?')) { const all = await tripTicks(); const t = inv.trips.find(x => x.id === a.dataset.id); all[t.id] = {}; for (const r of [...t.items, ...t.extras]) all[t.id][r.id] = { packed: false, back: false }; await kvSet('tripTicks', all); showTrip(t.id); } break;
      case 'stockCheck': startStockCheck(); break;
      case 'roomScan': roomStart(); break;
      case 'docScan': docNew().catch(ex => toast(ex.message || String(ex), 5000)); break;
      case 'docShoot': docShoot(); break;
      case 'docDone': docStopCamera(); docDetails(); break;
      case 'docCamCancel': docStopCamera(); docDetails(); break;
      case 'docMore': closeSheet(); docCamera(); break;
      case 'docDelPage': dscan.doc.pages.splice(Number(a.dataset.i), 1); docDetails(); break;
      case 'docCancel': if (!dscan || !dscan.doc.pages.length || dscan.editing || confirm('Discard the pages you scanned?')) { dscan = null; closeSheet(); } break;
      case 'docMode': adj.mode = a.dataset.mode; docAdjMode(); break;
      case 'docRotate': adj.rotate = (adj.rotate + 1) % 4; $('docAdjMsg').textContent = `The finished page will be turned ${adj.rotate * 90}° clockwise.`; break;
      case 'docRetake': { const cam = adj.fromCamera; $('docAdjust').classList.add('hidden'); adj = { mode: adj.mode }; if (cam) docCamera(); else docNextPicked(); break; }
      case 'docUse': docUsePage(); break;
      case 'docDelete': if (dscan && confirm('Delete this scanned document from the phone?')) { await delDoc(dscan.doc.id); dscan = null; closeSheet(); renderList(); toast('Deleted'); } break;
      case 'roomAgain': closeSheet(); roomScan(room ? room.place : '').catch(ex => { roomStop(); toast(ex.message || String(ex), 5000); }); break;
      case 'roomDone': roomFinish(); break;
      case 'roomCancel': roomStop(); room = null; break;
      case 'roomSave': roomSave(); break;
      case 'stockMore': runStockScan(); break;
      case 'stockMove': stockMoveAll(); break;
      case 'stockDone': stock = null; closeSheet(); renderList(); break;
      case 'attRemove': attPending.splice(Number(a.dataset.i), 1); renderAttPending(); break;
      case 'lockInv': inv = null; await kvSet('inventoryKey', undefined); toast('Inventory locked. It will ask for the passphrase next time.', 4000); if (tab === 'inv') showInv(); break;
      case 'forgetInv':
        if (confirm('Remove the inventory copy from this phone? Your items on the PC aren\'t affected.')) { await kvSet('inventory', undefined); await kvSet('inventoryKey', undefined); inv = null; toast('Removed'); if (tab === 'inv') showInv(); }
        break;
      case 'delete':
        if (confirm('Delete this item from this device?')) { await delItem(editing.id); toast('Deleted'); showHome(); }
        break;
      case 'clearExported': {
        const done = items.filter(i => i.exportedAt);
        await loadUpdates();
        const doneU = updates.filter(u => u.exportedAt);
        if (!done.length && !doneU.length) { toast('Nothing exported to remove'); break; }
        const what = [done.length && `${done.length} exported item${done.length === 1 ? '' : 's'}`, doneU.length && `${doneU.length} exported change${doneU.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
        if (confirm(`Remove ${what} from this device? Only do this once they're safely imported on your PC.`)) {
          for (const it of done) await delItem(it.id);
          if (doneU.length) await kvSet('updates', updates.filter(u => !u.exportedAt));
          toast('Removed'); renderList();
        }
        break;
      }
      case 'install':
        if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $('installCard').classList.add('hidden'); $('installMenu').classList.add('hidden'); }
        else sheet(`<h2>Install OpenSafe Capture</h2><ol><li>In Chrome, tap <b>⋮</b> (top right).</li><li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li></ol><p class="muted">In Samsung Internet: tap <b>☰</b> → <b>Add page to</b> → <b>Home screen</b>.</p><button class="btn" data-act="closeSheet">OK</button>`);
        break;
      case 'about': {
        let est = '';
        try { const q = await navigator.storage.estimate(); est = `Using ${(q.usage / 1048576).toFixed(1)} MB on this device.`; } catch (_) {}
        sheet(`<h2>About OpenSafe Capture</h2><p>Add items here, then export them to OpenSafe on your PC. Nothing leaves this device until you export it.</p><p class="muted">Scan a room downloads its recognition files once (about 19 MB; the model comes from Google). The camera picture is never sent anywhere. Recognition uses MediaPipe by Google (Apache-2.0 licence).</p><p class="muted">${esc(est)} ${items.length} item${items.length === 1 ? '' : 's'} stored.</p><button class="btn" data-act="closeSheet">OK</button>`);
        break;
      }
    }
  });
  $('menuBtn').onclick = () => $('menu').classList.toggle('hidden');
  $('backBtn').onclick = () => { if (!$('form').classList.contains('hidden') && confirm('Leave without saving?')) showHome(); };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e;
    $('installCard').classList.remove('hidden'); $('installMenu').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => { $('installCard').classList.add('hidden'); $('installMenu').classList.add('hidden'); });

  // Ask the browser not to clear our storage when space is low.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // Stop the camera when the app goes into the background
  document.addEventListener('visibilitychange', () => { if (document.hidden && scan.cancel) scan.cancel(); if (document.hidden && roomStream) roomFinish(); if (document.hidden && dscan && dscan.stream) { docStopCamera(); docDetails(); } });
  wireAdjustHandles();
  window.addEventListener('resize', () => { if (adj && adj.canvas && !$('docAdjust').classList.contains('hidden')) docDrawAdjust(); });

  autoOpen().finally(() => { showHome(); openFromHash(); });
})();
