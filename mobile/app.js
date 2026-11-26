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
  const DEFAULT_CATS = ['Vehicles', 'Electronics', 'Computers & Phones', 'Tools', 'Camping & Outdoor', 'Motorbike Gear', 'Marine', 'Furniture', 'Appliances', 'Jewellery & Watches', 'Sports & Hobbies', 'Clothing', 'Other'];
  const DEFAULT_LOCS = ['Home', 'Garage', 'Car', 'Storage', 'Boat'];
  const FIELDS = ['name', 'category', 'location', 'brand', 'model', 'serial', 'barcode', 'webLink', 'condition', 'purchasePrice', 'currentValue', 'purchaseDate', 'warrantyExpiry', 'supplier', 'notes', 'tags'];

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('opensafe-capture', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); // the encrypted inventory file from the PC
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
    const pending = items.filter(i => !i.exportedAt);
    const pendU = updates.filter(u => !u.exportedAt);
    $('pendingCount').textContent = `${pending.length} item${pending.length === 1 ? '' : 's'}` + (pendU.length ? ` and ${pendU.length} change${pendU.length === 1 ? '' : 's'}` : '');
    $('pendingText').textContent = (pending.length || pendU.length) ? 'ready to export' : ((items.length || updates.length) ? 'everything has been exported' : 'ready to export');
    $('exportBtn').disabled = !pending.length && !pendU.length;
    $('empty').classList.toggle('hidden', items.length > 0 || updates.length > 0);
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
    for (const f of files) { const s = await shrink(f); editing.photos.push({ id: uid(), name: s.name, type: s.type, blob: s.blob }); }
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

  async function buildExport(list, ups) {
    const hasFiles = ups.some(u => (u.photos && u.photos.length) || (u.documents && u.documents.length));
    const out = { format: FORMAT, version: hasFiles ? FORMAT_VERSION_FILES : ups.length ? FORMAT_VERSION_CHANGES : FORMAT_VERSION, app: 'OpenSafe Capture', exportedAt: new Date().toISOString(), device: navigator.userAgent.slice(0, 200), items: [] };
    for (const it of list) {
      const x = { id: it.id, createdAt: it.createdAt, updatedAt: it.updatedAt };
      for (const k of FIELDS) x[k] = it[k] || '';
      x.photos = [];
      for (const p of it.photos) x.photos.push({ id: p.id, name: p.name, type: p.type, data: await blobToBase64(p.blob) });
      x.documents = [];
      for (const r of it.receipts) x.documents.push({ id: r.id, name: r.name, type: r.type, docType: 'Receipt', data: await blobToBase64(r.blob) });
      out.items.push(x);
    }
    for (const u of ups) {
      const x = { id: u.id, itemId: u.itemId, itemName: u.itemName, at: u.at, kind: u.kind, changes: u.changes, summary: u.summary, note: u.note };
      if (u.photos && u.photos.length) { x.photos = []; for (const p of u.photos) x.photos.push({ id: p.id, name: p.name, type: p.type, data: await blobToBase64(p.blob) }); }
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
    if (!list.length && !ups.length) { toast('Nothing to export'); return; }
    const btn = $('exportBtn'); btn.disabled = true; btn.textContent = 'Preparing…';
    let data;
    try { data = JSON.stringify(await buildExport(list, ups)); }
    catch (ex) { toast('Export failed: ' + ex.message, 5000); btn.disabled = false; btn.textContent = 'Export to PC'; return; }
    btn.textContent = 'Export to PC'; btn.disabled = false;
    const base = `OpenSafe-${stamp()}`;
    const mb = data.length < 1048576 ? Math.max(1, Math.round(data.length / 1024)) + ' KB' : (data.length / 1048576).toFixed(1) + ' MB';
    pendingExport = { list, ups, data, base };
    const canShareFile = (name, type) => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], name, { type })] })); } catch (_) { return false; } };
    shareName = canShareFile(base + '.opensafe', 'application/octet-stream') ? [base + '.opensafe', 'application/octet-stream']
      : canShareFile(base + '.opensafe.txt', 'text/plain') ? [base + '.opensafe.txt', 'text/plain'] : null;
    const what = [list.length && `${list.length} item${list.length === 1 ? '' : 's'}`, ups.length && `${ups.length} change${ups.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    sheet(`<h2>Export ${what}</h2>
      <p class="muted">One file with everything, photos included (${mb}).</p>${ups.length ? `<p class="muted small">Changes from scanning labels need OpenSafe ${ups.some(u => (u.photos && u.photos.length) || (u.documents && u.documents.length)) ? '1.8' : '1.6'} or later on the PC.</p>` : ''}
      ${shareName ? '<button class="btn primary" data-act="share">Send to PC…</button><p class="muted" style="margin-top:-4px">Pick Quick Share, Bluetooth, email, Google Drive or OneDrive.</p>' : ''}
      <button class="btn ${shareName ? '' : 'primary'}" data-act="download">Save to Downloads</button>
      <p class="muted">Then on your PC, open OpenSafe and choose <b>Items → Import from phone</b>, or just double-click the file.</p>
      <button class="btn" data-act="closeSheet">Cancel</button>`);
  }
  let pendingExport = null, shareName = null;

  async function markExported(list, ups) {
    const now = new Date().toISOString();
    for (const it of list) { it.exportedAt = now; await putItem(it); }
    if (ups.length) {
      await loadUpdates();
      const ids = new Set(ups.map(u => u.id));
      for (const u of updates) if (ids.has(u.id)) u.exportedAt = now;
      await kvSet('updates', updates);
    }
  }
  async function finishExport(how) {
    const { list, ups } = pendingExport;
    await markExported(list, ups);
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
      else { const r = await shrink(f, inp.dataset.attach === 'doc' ? 2400 : 2000); attPending.push({ id: uid(), kind: inp.dataset.attach, name: (inp.dataset.attach === 'doc' ? 'receipt-' : '') + r.name, type: r.type, blob: r.blob }); }
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
    if (kind === 'photos') rec.photos = attPending.map(({ id, name, type, blob }) => ({ id, name, type, blob }));
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
    const card = e.target.closest('.item');
    if (card) { const it = items.find(i => i.id === card.dataset.id); if (it) showForm(it); return; }
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
      case 'stockCheck': startStockCheck(); break;
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
        sheet(`<h2>About OpenSafe Capture</h2><p>Add items here, then export them to OpenSafe on your PC. Nothing leaves this device until you export it.</p><p class="muted">${esc(est)} ${items.length} item${items.length === 1 ? '' : 's'} stored.</p><button class="btn" data-act="closeSheet">OK</button>`);
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
  document.addEventListener('visibilitychange', () => { if (document.hidden && scan.cancel) scan.cancel(); });

  autoOpen().finally(() => { showHome(); openFromHash(); });
})();
