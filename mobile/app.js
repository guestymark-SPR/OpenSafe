'use strict';
/* OpenSafe Capture: add items on a phone or tablet, export them as one .opensafe file,
   import that file into OpenSafe on the PC. Everything is stored on this device
   (IndexedDB) until exported. No server, no account. */
(function () {
  const $ = (id) => document.getElementById(id);
  const FORMAT = 'opensafe-export';
  const FORMAT_VERSION = 1;
  const DEFAULT_CATS = ['Vehicles', 'Electronics', 'Computers & Phones', 'Tools', 'Camping & Outdoor', 'Motorbike Gear', 'Marine', 'Furniture', 'Appliances', 'Jewellery & Watches', 'Sports & Hobbies', 'Clothing', 'Other'];
  const DEFAULT_LOCS = ['Home', 'Garage', 'Car', 'Storage', 'Boat'];
  const FIELDS = ['name', 'category', 'location', 'brand', 'model', 'serial', 'barcode', 'condition', 'purchasePrice', 'currentValue', 'purchaseDate', 'warrantyExpiry', 'supplier', 'notes', 'tags'];

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
  let editing = null; // item being edited (copy)
  let deferredInstall = null;

  function learnedLists() {
    const cats = new Set(DEFAULT_CATS), locs = new Set(DEFAULT_LOCS);
    for (const it of items) { if (it.category) cats.add(it.category); if (it.location) locs.add(it.location); }
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
    const pending = items.filter(i => !i.exportedAt);
    $('pendingCount').textContent = `${pending.length} item${pending.length === 1 ? '' : 's'}`;
    $('pendingText').textContent = pending.length ? 'ready to export' : (items.length ? 'everything has been exported' : 'ready to export');
    $('exportBtn').disabled = !pending.length;
    $('empty').classList.toggle('hidden', items.length > 0);
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

  async function buildExport(list) {
    const out = { format: FORMAT, version: FORMAT_VERSION, app: 'OpenSafe Capture', exportedAt: new Date().toISOString(), device: navigator.userAgent.slice(0, 200), items: [] };
    for (const it of list) {
      const x = { id: it.id, createdAt: it.createdAt, updatedAt: it.updatedAt };
      for (const k of FIELDS) x[k] = it[k] || '';
      x.photos = [];
      for (const p of it.photos) x.photos.push({ id: p.id, name: p.name, type: p.type, data: await blobToBase64(p.blob) });
      x.documents = [];
      for (const r of it.receipts) x.documents.push({ id: r.id, name: r.name, type: r.type, docType: 'Receipt', data: await blobToBase64(r.blob) });
      out.items.push(x);
    }
    return out;
  }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function doExport(all) {
    const list = all ? items : items.filter(i => !i.exportedAt);
    if (!list.length) { toast('Nothing to export'); return; }
    const btn = $('exportBtn'); btn.disabled = true; btn.textContent = 'Preparing…';
    let data;
    try { data = JSON.stringify(await buildExport(list)); }
    catch (ex) { toast('Export failed: ' + ex.message, 5000); btn.disabled = false; btn.textContent = 'Export to PC'; return; }
    btn.textContent = 'Export to PC'; btn.disabled = false;
    const base = `OpenSafe-${stamp()}`;
    const mb = data.length < 1048576 ? Math.max(1, Math.round(data.length / 1024)) + ' KB' : (data.length / 1048576).toFixed(1) + ' MB';
    pendingExport = { list, data, base };
    const canShareFile = (name, type) => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], name, { type })] })); } catch (_) { return false; } };
    shareName = canShareFile(base + '.opensafe', 'application/octet-stream') ? [base + '.opensafe', 'application/octet-stream']
      : canShareFile(base + '.opensafe.txt', 'text/plain') ? [base + '.opensafe.txt', 'text/plain'] : null;
    sheet(`<h2>Export ${list.length} item${list.length === 1 ? '' : 's'}</h2>
      <p class="muted">One file with everything, photos included (${mb}).</p>
      ${shareName ? '<button class="btn primary" data-act="share">Send to PC…</button><p class="muted" style="margin-top:-4px">Pick Quick Share, Bluetooth, email, Google Drive or OneDrive.</p>' : ''}
      <button class="btn ${shareName ? '' : 'primary'}" data-act="download">Save to Downloads</button>
      <p class="muted">Then on your PC, open OpenSafe and choose <b>Items → Import from phone</b>, or just double-click the file.</p>
      <button class="btn" data-act="closeSheet">Cancel</button>`);
  }
  let pendingExport = null, shareName = null;

  async function markExported(list) {
    const now = new Date().toISOString();
    for (const it of list) { it.exportedAt = now; await putItem(it); }
  }
  async function finishExport(how) {
    const { list } = pendingExport;
    await markExported(list);
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
  let inv = null;          // decrypted inventory, kept only in memory
  let pendingItem = null;  // item id from a scanned QR label link

  async function decryptInventory(text, pass) {
    const f = JSON.parse(text);
    if (f.format !== 'opensafe-view') throw new Error('This isn\'t an OpenSafe inventory file.');
    const b = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b(f.salt), iterations: f.kdf.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let plain;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(f.iv) }, key, b(f.data)); }
    catch (_) { throw new Error('That passphrase isn\'t right.'); }
    return JSON.parse(new TextDecoder().decode(plain));
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
    const file = await kvGet('inventory');
    $('invNone').classList.toggle('hidden', !!file);
    $('invUnlock').classList.toggle('hidden', !file || !!inv);
    $('invOpen').classList.toggle('hidden', !inv);
    $('subtitle').textContent = inv ? 'Read-only copy from your PC' : 'Copy of your PC inventory';
    if (file && !inv) {
      $('invInfo').textContent = `Loaded ${file.loadedAt ? new Date(file.loadedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}. Enter the passphrase you chose on the PC.`;
      setTimeout(() => $('invUnlock').pass.focus(), 50);
    }
    if (inv) renderInv();
  }

  function renderInv() {
    const q = $('invQ').value.trim().toLowerCase();
    const list = inv.items.filter(a => !q || [a.name, a.brand, a.model, a.serial, a.category, a.location, a.barcode, (a.details || {}).reg, (a.tags || []).join(' ')].join(' ').toLowerCase().includes(q));
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
      ['Insurer', a.insurer], ['Policy number', a.policyNumber], ['Lent to', a.lentTo], ['Due back', ukd(a.dueBack)],
      ['Registration', d.reg], ['VIN / frame no.', d.vin], ['Mileage', d.mileage], ['MOT due', ukd(d.motDue)], ['Road tax due', ukd(d.taxDue)], ['Hull ID', d.hin], ['Engine hours', d.engineHours], ['Mooring', d.mooring]]
      .filter(([, v]) => v);
    sheet(`<div class="detail">${a.thumb ? `<img class="big" src="${a.thumb}" alt="">` : ''}<h2 style="margin-top:12px">${esc(a.name)}</h2>
      <div class="kv">${rows.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
      ${a.notes ? `<p style="white-space:pre-wrap">${esc(a.notes)}</p>` : ''}
      <p class="muted small">${a.photos} photo${a.photos === 1 ? '' : 's'} and ${a.documents} document${a.documents === 1 ? '' : 's'} on the PC. To change anything, edit it in OpenSafe on the PC.</p>
      <button class="btn" data-act="closeSheet">Close</button></div>`);
  }

  $('invFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const text = await f.text();
    try { const j = JSON.parse(text); if (j.format !== 'opensafe-view') throw new Error(); }
    catch (_) { toast('That isn\'t an OpenSafe inventory file. Choose the .opensafe-view file from the PC.', 5000); return; }
    await kvSet('inventory', { text, loadedAt: new Date().toISOString() });
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
      if (pendingItem) { const id = pendingItem; pendingItem = null; showInvItem(id); }
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    btn.disabled = false; btn.textContent = 'Open';
  };
  $('invQ').oninput = () => renderInv();

  function openFromHash() {
    const m = location.hash.match(/item=([0-9a-f-]{36})/i);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    const id = m[1].toLowerCase();
    setTab('inv');
    if (inv) showInvItem(id); else { pendingItem = id; toast('Open your inventory to see this item'); }
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
      case 'scanLabel':
        try {
          $('scanMsg').textContent = 'Point the camera at an OpenSafe label';
          const text = await scan(['qr_code']);
          if (!text) break;
          const m = String(text).match(/item=([0-9a-f-]{36})/i);
          if (m) showInvItem(m[1].toLowerCase()); else toast('That QR code isn\'t an OpenSafe label.');
        } catch (ex) { stopScan(); toast(ex.message, 5000); }
        break;
      case 'lockInv': inv = null; toast('Inventory locked'); if (tab === 'inv') showInv(); break;
      case 'forgetInv':
        if (confirm('Remove the inventory copy from this phone? Your items on the PC aren\'t affected.')) { await kvSet('inventory', undefined); inv = null; toast('Removed'); if (tab === 'inv') showInv(); }
        break;
      case 'delete':
        if (confirm('Delete this item from this device?')) { await delItem(editing.id); toast('Deleted'); showHome(); }
        break;
      case 'clearExported': {
        const done = items.filter(i => i.exportedAt);
        if (!done.length) { toast('No exported items to remove'); break; }
        if (confirm(`Remove ${done.length} exported item${done.length === 1 ? '' : 's'} from this device? Only do this once they're safely imported on your PC.`)) {
          for (const it of done) await delItem(it.id);
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

  // Lock the inventory again when the app has been in the background for 5 minutes
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); if (scan.cancel) scan.cancel(); }
    else if (inv && Date.now() - hiddenAt > 5 * 60 * 1000) { inv = null; if (tab === 'inv') showInv(); }
  });

  showHome();
  openFromHash();
})();
