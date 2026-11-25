'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'opensafe-token';

  // Pairing: the QR code carries the token after "#t=". Save it and remove it from the address bar.
  const m = location.hash.match(/t=([A-Za-z0-9_-]{20,})/);
  if (m) {
    try { localStorage.setItem(TOKEN_KEY, m[1]); } catch (_) {}
    history.replaceState(null, '', location.pathname);
  }
  let token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}

  const photos = [];   // {blob, name, url}
  const receipts = []; // {blob, name}

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 3000);
  }
  function setConn(ok, text) {
    const c = $('conn'); c.textContent = text; c.className = 'conn ' + (ok ? 'ok' : 'bad');
  }
  function showError(msg) {
    const e = $('error');
    if (!msg) { e.classList.add('hidden'); return; }
    e.textContent = msg; e.classList.remove('hidden');
    e.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, Object.assign({}, opts, { headers: Object.assign({ 'x-opensafe-token': token }, opts.headers || {}) }));
    } catch (_) {
      throw new Error("Can't reach your PC. Check OpenSafe is open on the PC and this phone is on the same Wi-Fi.");
    }
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (res.status === 401) { showUnpaired(); throw new Error((body && body.error) || 'Not paired'); }
    if (!res.ok) throw new Error((body && body.error) || ('Error ' + res.status));
    return body;
  }

  function showUnpaired() {
    $('unpaired').classList.remove('hidden');
    $('form').classList.add('hidden');
    $('recentCard').classList.add('hidden');
    setConn(false, 'Not paired');
  }

  function fill(list, values) {
    list.replaceChildren(...values.map(v => { const o = document.createElement('option'); o.value = v; return o; }));
  }

  async function loadMeta() {
    if (!token) return showUnpaired();
    try {
      const meta = await api('/api/meta');
      setConn(true, `Connected to PC · ${meta.count} item${meta.count === 1 ? '' : 's'}`);
      $('unpaired').classList.add('hidden');
      $('form').classList.remove('hidden');
      fill($('cats'), meta.categories);
      fill($('locs'), meta.locations);
      const cond = $('cond');
      if (cond.options.length === 1) meta.conditions.forEach(c => cond.add(new Option(c, c)));
      const ul = $('recent');
      ul.replaceChildren(...meta.recent.map(r => {
        const li = document.createElement('li');
        const left = document.createElement('span'); left.textContent = r.name;
        const right = document.createElement('small');
        right.textContent = [r.category, r.photos ? r.photos + ' 📷' : ''].filter(Boolean).join(' · ');
        li.append(left, right); return li;
      }));
      $('recentCard').classList.toggle('hidden', !meta.recent.length);
    } catch (e) {
      if (token) { setConn(false, 'PC not reachable'); $('form').classList.remove('hidden'); }
      showError(e.message);
    }
  }

  // Shrink camera photos before sending: faster over Wi-Fi and kinder to disk space.
  async function shrink(file, max = 2000) {
    if (!/^image\/(jpeg|png|webp|heic|heif)/.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return { blob: file, name: file.name };
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) throw new Error('encode failed');
      return { blob, name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg' };
    } catch (_) {
      return { blob: file, name: file.name || 'photo.jpg' };
    }
  }

  function renderPhotos() {
    const box = $('thumbs');
    box.replaceChildren(...photos.map((p, i) => {
      const d = document.createElement('div'); d.className = 'thumb';
      const img = document.createElement('img'); img.src = p.url; img.alt = 'Photo ' + (i + 1);
      const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '✕';
      x.setAttribute('aria-label', 'Remove photo');
      x.onclick = () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); renderPhotos(); };
      d.append(img, x); return d;
    }));
  }
  function renderReceipts() {
    const box = $('receipts');
    box.replaceChildren(...receipts.map((r, i) => {
      const d = document.createElement('div');
      const s = document.createElement('span'); s.textContent = '🧾 ' + r.name;
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Remove';
      b.onclick = () => { receipts.splice(i, 1); renderReceipts(); };
      d.append(s, b); return d;
    }));
  }

  async function addPhotos(files) {
    for (const f of files) {
      const s = await shrink(f);
      photos.push({ blob: s.blob, name: s.name, url: URL.createObjectURL(s.blob) });
    }
    renderPhotos();
  }
  $('cam').onchange = (e) => { addPhotos([...e.target.files]); e.target.value = ''; };
  $('gallery').onchange = (e) => { addPhotos([...e.target.files]); e.target.value = ''; };
  $('receipt').onchange = async (e) => {
    for (const f of [...e.target.files]) {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) receipts.push({ blob: f, name: f.name });
      else { const s = await shrink(f, 2400); receipts.push({ blob: s.blob, name: 'receipt-' + s.name }); }
    }
    e.target.value = '';
    renderReceipts();
  };

  let saving = false;
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    showError('');
    const fd = new FormData($('form'));
    const item = Object.fromEntries(fd.entries());
    if (!String(item.name || '').trim()) { showError('Give the item a name.'); return; }
    saving = true;
    const btn = $('save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const created = await api('/api/assets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) });
      let n = 0; const total = photos.length + receipts.length; const failed = [];
      for (const p of photos) {
        btn.textContent = `Uploading ${++n} of ${total}…`;
        try { await api(`/api/assets/${created.id}/photo?name=${encodeURIComponent(p.name)}`, { method: 'POST', headers: { 'content-type': p.blob.type || 'image/jpeg' }, body: p.blob }); }
        catch (err) { failed.push(p.name + ': ' + err.message); }
      }
      for (const r of receipts) {
        btn.textContent = `Uploading ${++n} of ${total}…`;
        try { await api(`/api/assets/${created.id}/document?type=Receipt&name=${encodeURIComponent(r.name)}`, { method: 'POST', headers: { 'content-type': r.blob.type || 'application/octet-stream' }, body: r.blob }); }
        catch (err) { failed.push(r.name + ': ' + err.message); }
      }
      photos.forEach(p => URL.revokeObjectURL(p.url));
      photos.length = 0; receipts.length = 0;
      renderPhotos(); renderReceipts();
      $('form').reset();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (failed.length) showError(`"${created.name}" was saved, but some files didn't upload. Add them from the PC instead.\n` + failed.join('\n'));
      else toast(`✓ "${created.name}" saved to your PC`);
      loadMeta();
    } catch (err) {
      showError(err.message + ' Your entry is still here, so you can try again.');
    } finally {
      saving = false; btn.disabled = false; btn.textContent = 'Save to PC';
    }
  };

  loadMeta();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadMeta(); });
})();
