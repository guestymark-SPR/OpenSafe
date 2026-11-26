'use strict';
/* OpenSafe renderer – plain JS, no framework. All data comes from window.keep (preload). */
(function () {
  const keep = window.keep;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gbpFmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  const gbp0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  const money = (n) => (n === null || n === undefined) ? '—' : gbpFmt.format(n);
  const money0 = (n) => gbp0.format(n || 0);
  const ukDate = (s) => s ? new Date(s + (s.length === 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: s.length === 10 ? 'UTC' : undefined }) : '—';
  const img = (a, p) => `keep://file/${encodeURIComponent(a.id)}/${encodeURIComponent(p.file)}`;
  const INACTIVE = ['Sold', 'Disposed', 'Lost / Stolen'];
  const value = (a) => a.currentValue ?? a.purchasePrice ?? 0;

  const state = {
    snap: null,
    sel: new Set(),
    upd: null,
    updHidden: false,
    view: 'dashboard',
    itemId: null,
    tab: 'overview',
    f: { q: '', category: '', location: '', status: 'active', sort: 'added', layout: 'table', gap: '' }
  };

  // ---------- helpers ----------
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
  }
  async function run(fn, okMsg) {
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { toast('⚠ ' + e.message, 5000); throw e; }
  }
  async function refresh() {
    state.snap = await keep.getData();
    if (state.snap.locked) { showLock(); return; }
    $('#lockscreen').classList.add('hidden'); $('#lockscreen').innerHTML = '';
    const rem = state.snap.reminders.filter(r => r.daysLeft <= 7).length;
    const b = $('#remBadge'); b.textContent = rem; b.classList.toggle('hidden', !rem);
    const sec = state.snap.security;
    $('#lockBtn').classList.toggle('hidden', !sec.encrypted);
    $('#vaultNav').classList.toggle('hidden', !sec.vault.exists);
    $('#vaultState').textContent = sec.vault.exists ? (sec.vault.unlocked ? 'open' : 'locked') : '';
    if (state.view === 'vault' && !sec.vault.exists) state.view = 'settings';
    render();
  }

  // ---------- lock screen ----------
  function showLock(mode = 'unlock') {
    closeModal();
    const ls = $('#lockscreen');
    ls.classList.remove('hidden');
    const logo = '<div class="logo"><img src="icon.png" alt="">OpenSafe</div>';
    if (mode === 'recover') {
      ls.innerHTML = `<div class="lockbox">${logo}<h2>Forgotten your password?</h2>
        <p class="muted">Enter the recovery key you saved when you turned on password protection, then choose a new password.</p>
        <form id="recoverForm"><label class="f">Recovery key<input name="rk" class="mono" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"></label>
        <label class="f">New password<input name="pw" type="password" autocomplete="new-password"></label>
        <label class="f">New password again<input name="pw2" type="password" autocomplete="new-password"></label>
        <div class="err" id="lockErr"></div>
        <button class="btn primary" type="submit">Unlock and set new password</button>
        <button class="linkbtn" type="button" data-action="lockBack">Back</button></form></div>`;
      $('#recoverForm').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target, err = $('#lockErr');
        if (f.pw.value !== f.pw2.value) { err.textContent = 'The two passwords don\'t match.'; return; }
        busy(f, true, 'Checking…');
        try { await keep.recover(f.rk.value, f.pw.value); toast('Unlocked. Your new password is set.'); await refresh(); }
        catch (ex) { err.textContent = ex.message; busy(f, false); }
      };
      return;
    }
    ls.innerHTML = `<div class="lockbox">${logo}<h2>OpenSafe is locked</h2>
      <p class="muted">Enter your password to open your inventory.</p>
      <form id="unlockForm"><input name="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password">
      <div class="err" id="lockErr"></div>
      <button class="btn primary" type="submit">Unlock</button>
      <button class="linkbtn" type="button" data-action="lockForgot">Forgotten your password?</button></form></div>`;
    const f = $('#unlockForm');
    f.pw.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      busy(f, true, 'Unlocking…');
      try { await keep.unlock(f.pw.value); await refresh(); }
      catch (ex) { $('#lockErr').textContent = ex.message; busy(f, false); f.pw.select(); }
    };
  }
  function busy(form, on, text) {
    const b = form.querySelector('button[type=submit]');
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.disabled = on; b.textContent = on ? text : b.dataset.label;
  }

  // ---------- insurance policies ----------
  function viewPolicies() {
    const pols = state.snap.data.policies || [];
    const items = state.snap.data.assets;
    const unlinked = items.filter(a => !a.policyId && !a.insurer && !INACTIVE.includes(a.status) && value(a) > 0);
    const card = (p) => {
      const covered = items.filter(a => a.policyId === p.id);
      const total = covered.reduce((t, a) => t + value(a), 0);
      // A cover limit adds up across items for contents/gadget policies; vehicle and boat limits are per item.
      const over = p.coverLimit && ['Home contents', 'Gadget', 'Travel', 'Other'].includes(p.type) && total > p.coverLimit;
      const row = (k, v) => v ? `<div><div class="k">${k}</div><div class="v">${v}</div></div>` : '';
      return `<div class="card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><h2 style="margin:0;flex:1">${esc(p.insurer)} <span class="muted" style="font-weight:500">· ${esc(p.type)}</span></h2>
          <button class="btn small" data-action="polItems" data-pid="${p.id}">Items covered…</button><button class="btn small" data-action="polEdit" data-pid="${p.id}">Edit</button><button class="btn small danger" data-action="polDel" data-pid="${p.id}">Delete</button></div>
        <div class="kv">${row('Policy number', p.policyNumber ? `<span class="mono">${esc(p.policyNumber)}</span>` : '')}${row('Renews', p.renewalDate ? ukDate(p.renewalDate) + dueSoon(p.renewalDate) : '')}${row('Premium', p.premium !== null ? money(p.premium) : '')}
          ${row('Excess', p.excess !== null ? money(p.excess) : '')}${row('Cover limit', p.coverLimit !== null ? money(p.coverLimit) : '')}${row('Claims line', p.claimsPhone ? esc(p.claimsPhone) : '')}</div>
        ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line2)"><b>${covered.length} item${covered.length === 1 ? '' : 's'} covered</b> <span class="muted">worth ${money0(total)}</span>
          ${over ? ` <span class="pill bad">Over the cover limit by ${money0(total - p.coverLimit)}</span>` : ''}
          ${covered.length ? `<div class="meta" style="margin-top:4px">${covered.slice(0, 12).map(a => esc(a.name)).join(' · ')}${covered.length > 12 ? ' …' : ''}</div>` : ''}</div></div>`;
    };
    return `<div class="head"><h1>Insurance</h1><span class="sub">${pols.length} polic${pols.length === 1 ? 'y' : 'ies'}</span><span class="spacer"></span><button class="btn primary" data-action="polNew">+ Add policy</button></div>
      ${pols.length ? pols.slice().sort((x, y) => (x.renewalDate || '9').localeCompare(y.renewalDate || '9')).map(card).join('')
        : '<div class="card empty">No policies yet. Add your home contents, car, bike or boat insurance here. OpenSafe will remind you before each one renews, and you can link the items each policy covers.</div>'}
      ${unlinked.length ? `<div class="card"><h2>Not covered by a policy</h2><div class="meta">${unlinked.slice(0, 30).map(a => `<a href="#" data-open="${a.id}">${esc(a.name)}</a>`).join(' · ')}${unlinked.length > 30 ? ' …' : ''}</div></div>` : ''}`;
  }

  function policyForm(p) {
    const L = state.snap.lists;
    p = p || { type: 'Home contents' };
    const inp = (name, label, extra = '', cls = '') => `<label class="f ${cls}">${label}<input name="${name}" value="${esc(p[name] ?? '')}" ${extra}></label>`;
    openModal(`<form class="dialog narrow" id="polForm" novalidate><div class="dh"><h2>${p.id ? 'Edit policy' : 'Add policy'}</h2></div>
      <div class="db">${inp('insurer', 'Insurer *', 'maxlength="120"')}<label class="f">Type<select name="type">${L.policyTypes.map(t => opt(t, t, p.type)).join('')}</select></label>
        ${inp('policyNumber', 'Policy number')}${inp('renewalDate', 'Renewal date', 'type="date"')}
        ${inp('premium', 'Premium (£ a year)', 'inputmode="decimal"')}${inp('excess', 'Excess (£)', 'inputmode="decimal"')}
        ${inp('coverLimit', 'Cover limit (£)', 'inputmode="decimal"')}${inp('claimsPhone', 'Claims phone number', 'inputmode="tel"')}
        <label class="f s3">Notes<textarea name="notes" rows="3">${esc(p.notes || '')}</textarea></label><div class="err" id="polErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    $('#polForm').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (p.id) data.id = p.id;
      try { await keep.savePolicy(data); closeModal(); toast('Policy saved'); await refresh(); }
      catch (ex) { $('#polErr').textContent = ex.message; }
    };
  }

  function policyItemsForm(p) {
    const items = state.snap.data.assets.slice().sort((a, b) => a.name.localeCompare(b.name));
    openModal(`<form class="dialog narrow" id="polItems"><div class="dh"><h2>Items covered by ${esc(p.insurer)}</h2></div>
      <div class="db" style="display:block;max-height:60vh;overflow:auto">
        ${items.length ? items.map(a => `<label class="switch" style="font-weight:500;display:flex;margin:6px 0"><input type="checkbox" name="i" value="${a.id}" ${a.policyId === p.id ? 'checked' : ''}> ${esc(a.name)} <span class="meta">${esc(a.category || '')}${a.policyId && a.policyId !== p.id ? ' · currently on another policy' : ''}</span></label>`).join('') : '<div class="muted">No items yet.</div>'}
      </div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    $('#polItems').onsubmit = async (e) => {
      e.preventDefault();
      const ids = $$('#polItems input[name=i]:checked').map(x => x.value);
      await run(() => keep.setPolicyItems(p.id, ids), 'Saved'); closeModal(); await refresh();
    };
  }

  // ---------- claim pack & receipts ----------
  function claimForm(ids) {
    const names = ids.map(id => (asset(id) || {}).name).filter(Boolean);
    const vaultNote = state.snap.security.vault.exists && !state.snap.security.vault.unlocked ? '<p class="s3 note" style="margin:0">The vault is locked, so files in it won\'t be included. Unlock it first if you need them.</p>' : '';
    openModal(`<form class="dialog narrow" id="claimForm"><div class="dh"><h2>Claim pack</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">One PDF for your insurer with ${names.length === 1 ? `<b>${esc(names[0])}</b>` : `<b>${names.length} items</b>`}: every photo, serial numbers, purchase details, receipt photos, and receipt PDFs added at the end. All boxes below are optional.</p>
        <label class="f">Date of incident<input name="incidentDate" type="date"></label>
        <label class="f">Claim number<input name="claimNumber" maxlength="60"></label>
        <label class="f s3">Police / crime reference<input name="crimeRef" maxlength="60" placeholder="e.g. a crime reference number for theft"></label>
        <label class="f s3">What happened<textarea name="whatHappened" rows="4" maxlength="3000"></textarea></label>${vaultNote}
        <div class="err" id="claimErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save claim pack…</button></div></form>`);
    $('#claimForm').onsubmit = async (e) => {
      e.preventDefault();
      const info = Object.fromEntries(new FormData(e.target).entries());
      busy(e.target, true, 'Building PDF…');
      try { const r = await keep.claimPack(ids, info); if (r) { closeModal(); toast(`✓ Claim pack saved${r.appended ? ` with ${r.appended} PDF document${r.appended === 1 ? '' : 's'} attached` : ''}`, 4500); } else busy(e.target, false); }
      catch (ex) { $('#claimErr').textContent = ex.message; busy(e.target, false); }
    };
  }

  function bulkForm(ids) {
    const d = state.snap.data, L = state.snap.lists;
    const pols = d.policies || [];
    openModal(`<form class="dialog narrow" id="bulkForm" autocomplete="off"><div class="dh"><h2>Change ${ids.length} item${ids.length === 1 ? '' : 's'}</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">Fill in only what you want to change. Anything left blank stays as it is on each item.</p>
        <label class="f">Location<input name="location" list="bkLocs" maxlength="200" placeholder="Keep as it is"></label>
        <label class="f">Category<input name="category" list="bkCats" maxlength="200" placeholder="Keep as it is"></label>
        <label class="f">Status<select name="status" id="bkStatus">${opt('', 'Keep as it is', '')}${L.statuses.map(x => opt(x, x, '')).join('')}</select></label>
        <label class="f">Insurance policy<select name="policyId">${opt('__keep', 'Keep as it is', '__keep')}${opt('', 'Not linked to a policy', '__keep')}${pols.map(p => opt(p.id, `${p.insurer}${p.type ? ' · ' + p.type : ''}${p.policyNumber ? ' · ' + p.policyNumber : ''}`, '__keep')).join('')}</select></label>
        <div id="bkLend" class="s3 subgrid hidden"><h3>Lent out</h3>
          <label class="f">Lent to *<input name="lentTo" maxlength="200"></label><label class="f">Phone or email<input name="lentContact" maxlength="200"></label>
          <label class="f">Lent on<input name="lentDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label class="f">Due back (reminder)<input name="dueBack" type="date"></label></div>
        <div id="bkSold" class="s3 subgrid hidden"><h3>Sold</h3>
          <label class="f">Sold on<input name="soldDate" type="date"></label><label class="f">Sold to<input name="soldTo" maxlength="200"></label></div>
        <datalist id="bkLocs">${d.locations.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <datalist id="bkCats">${d.categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="err" id="bkErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Change ${ids.length} item${ids.length === 1 ? '' : 's'}</button></div></form>`);
    $('#bkStatus').onchange = (e) => { $('#bkLend').classList.toggle('hidden', e.target.value !== 'Lent out'); $('#bkSold').classList.toggle('hidden', e.target.value !== 'Sold'); };
    $('#bulkForm').onsubmit = async (e) => {
      e.preventDefault();
      const raw = Object.fromEntries(new FormData(e.target).entries());
      if (raw.policyId === '__keep') delete raw.policyId;
      if (!raw.location.trim() && !raw.category.trim() && !raw.status && raw.policyId === undefined) { $('#bkErr').textContent = 'Choose at least one thing to change.'; return; }
      busy(e.target, true, 'Saving…');
      try { const n = await keep.bulkUpdate(ids, raw); closeModal(); state.sel.clear(); toast(`✓ ${n} item${n === 1 ? '' : 's'} changed`); await refresh(); }
      catch (ex) { $('#bkErr').textContent = ex.message; busy(e.target, false); }
    };
  }

  function labelsForm(ids) {
    openModal(`<form class="dialog narrow" id="labForm"><div class="dh"><h2>QR labels</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">A4 sheet of 21 labels (63.5 × 38.1 mm, the same as Avery L7160 and similar sheets) for <b>${ids.length} item${ids.length === 1 ? '' : 's'}</b>. Scanning a label with your phone opens that item in OpenSafe Capture.</p>
        <label class="f">Labels already used on the sheet<input name="skip" type="number" min="0" max="20" value="0"></label>
        <div class="err" id="labErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save labels PDF…</button></div></form>`);
    $('#labForm').onsubmit = async (e) => {
      e.preventDefault();
      busy(e.target, true, 'Making labels…');
      try { const p = await keep.labels(ids, { skip: Number(e.target.skip.value) || 0 }); if (p) { closeModal(); toast('✓ Labels saved. Print at 100% (no "fit to page").', 5000); } else busy(e.target, false); }
      catch (ex) { $('#labErr').textContent = ex.message; busy(e.target, false); }
    };
  }

  async function barcodeLookup(a) {
    toast('Looking up the barcode…');
    let r;
    try { r = await keep.barcodeLookup(a.barcode); } catch (ex) { toast('⚠ ' + ex.message, 6000); return; }
    if (!r) { toast('That barcode isn\'t in the free product database.', 5000); return; }
    const row = (key, label, val, cur) => val ? `<label class="switch s3" style="font-weight:500;display:flex;gap:10px"><input type="checkbox" name="${key}" ${cur ? '' : 'checked'}> <span style="flex:1">${label}: <b>${esc(val)}</b>${cur ? ` <span class="muted">(currently ${esc(cur)})</span>` : ''}</span></label>` : '';
    openModal(`<form class="dialog narrow" id="bcForm"><div class="dh"><h2>Product found</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">From ${esc(r.source)}, a free product database. Tick what to copy into this item.</p>
        ${row('name', 'Name', r.title, a.name)}${row('brand', 'Brand', r.brand, a.brand)}${row('model', 'Model', r.model, a.model)}
        ${r.category ? `<p class="s3 faint" style="margin:0">Their category: ${esc(r.category)}</p>` : ''}</div>
      <div class="df"><button type="button" class="btn" data-action="close">Close</button><button class="btn primary" type="submit">Copy to item</button></div></form>`);
    $('#bcForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, patch = { id: a.id };
      if (f.name && f.name.checked) patch.name = r.title;
      if (f.brand && f.brand.checked) patch.brand = r.brand;
      if (f.model && f.model.checked) patch.model = r.model;
      if (Object.keys(patch).length > 1) await run(() => keep.saveAsset(patch), 'Copied');
      closeModal(); await refresh();
    };
  }

  async function readReceipt(a, file) {
    openModal(`<div class="dialog narrow"><div class="dh"><h2>Reading receipt…</h2></div><div class="db"><p class="s3 muted" style="margin:0">Reading the text on this PC (nothing is uploaded). This takes a few seconds the first time.</p></div></div>`);
    let r;
    try { r = await keep.readReceipt(a.id, file); }
    catch (ex) { closeModal(); toast('⚠ ' + ex.message, 6000); return; }
    const row = (key, label, val, shown, cur) => val ? `<label class="switch s3" style="font-weight:500;display:flex;gap:10px"><input type="checkbox" name="${key}" ${cur ? '' : 'checked'}> <span style="flex:1">${label}: <b>${esc(shown)}</b>${cur ? ` <span class="muted">(currently ${esc(cur)})</span>` : ''}</span></label>` : '';
    const found = r.shop || r.date || r.total !== null;
    openModal(`<form class="dialog narrow" id="ocrForm"><div class="dh"><h2>Receipt details</h2></div>
      <div class="db">${found ? '<p class="s3 muted" style="margin:0">Tick what to copy into this item. Check them against the receipt: reading isn\'t always perfect.</p>' : '<p class="s3" style="margin:0">Couldn\'t find a shop, date or total. A sharper, straight-on photo in good light usually helps.</p>'}
        ${row('supplier', 'Bought from', r.shop, r.shop, a.supplier)}
        ${row('purchaseDate', 'Bought on', r.date, r.date ? ukDate(r.date) : '', a.purchaseDate ? ukDate(a.purchaseDate) : '')}
        ${row('purchasePrice', 'Price paid', r.total !== null, r.total !== null ? money(r.total) : '', a.purchasePrice !== null && a.purchasePrice !== undefined ? money(a.purchasePrice) : '')}
        <details class="s3"><summary class="muted" style="cursor:pointer">Text found on the receipt</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:200px;overflow:auto">${esc(r.text)}</pre></details></div>
      <div class="df"><button type="button" class="btn" data-action="close">Close</button>${found ? '<button class="btn primary" type="submit">Copy to item</button>' : ''}</div></form>`);
    const f = $('#ocrForm');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const patch = { id: a.id };
      if (f.supplier && f.supplier.checked) patch.supplier = r.shop;
      if (f.purchaseDate && f.purchaseDate.checked) patch.purchaseDate = r.date;
      if (f.purchasePrice && f.purchasePrice.checked) patch.purchasePrice = r.total;
      if (Object.keys(patch).length === 1) { closeModal(); return; }
      await run(() => keep.saveAsset(patch), 'Receipt details copied'); closeModal(); await refresh();
    };
  }

  // ---------- vault screen ----------
  function viewVault() {
    const sec = state.snap.security;
    if (!sec.vault.unlocked) {
      return `<div class="head"><h1>Vault</h1></div>
      <div class="card pinbox"><h2>🔒 The vault is locked</h2>
        <p class="muted">Enter your vault PIN to see the items and files you keep in it.</p>
        <form id="vaultForm" style="display:grid;gap:12px"><input name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="PIN" aria-label="Vault PIN">
        <div class="err" id="vaultErr"></div>
        <button class="btn primary" type="submit">Unlock vault</button></form>
        <p style="margin-top:12px"><button class="linkbtn" data-action="vaultForgot">Forgotten your PIN?</button></p></div>`;
    }
    const items = state.snap.data.assets.filter(a => a.inVault);
    const files = [];
    for (const a of state.snap.data.assets) if (!a.inVault) for (const r of [...a.photos, ...a.documents]) if (r.vaultFile) files.push({ a, r });
    return `<div class="head"><h1>Vault</h1><span class="sub">open</span><span class="spacer"></span><button class="btn" data-action="vaultLock">🔒 Lock vault</button></div>
      <p class="muted" style="margin-top:-8px">Vault items and files have their own encryption key. They're hidden, and left out of totals and reports, whenever the vault is locked. It locks when you close or lock OpenSafe.</p>
      <div class="card" style="margin-bottom:16px"><h2>Items in the vault (${items.length})</h2>
        ${items.length ? `<div class="rows">${items.map(a => `<div class="rowi" data-open="${a.id}">${thumb(a)}<div style="flex:1"><div class="name">${esc(a.name)}</div><div class="meta">${esc([a.category, a.location].filter(Boolean).join(' · '))}</div></div><span class="meta">${value(a) ? money(value(a)) : ''}</span></div>`).join('')}</div>`
          : '<div class="muted">None yet. Open an item and choose <b>🔒 Move to vault</b>.</div>'}</div>
      <div class="card"><h2>Single files in the vault (${files.length})</h2>
        ${files.length ? `<div class="rows">${files.map(({ a, r }) => `<div class="rowi" data-open="${a.id}" data-opentab="${a.photos.includes(r) ? 'photos' : 'docs'}"><span style="flex:1"><b>${esc(r.name)}</b> <span class="meta">in ${esc(a.name)}</span></span><span class="pill vault">🔒</span></div>`).join('')}</div>`
          : '<div class="muted">None yet. On an item\'s Photos or Documents tab, choose <b>🔒 To vault</b> on a file, such as an ID scan, a logbook or a receipt.</div>'}</div>`;
  }

  // ---------- security modals ----------
  function secModal(title, bodyHtml, submitLabel, onSubmit) {
    openModal(`<form class="dialog narrow" id="secForm" novalidate><div class="dh"><h2>${title}</h2></div>
      <div class="db">${bodyHtml}<div class="err" id="secErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary">${submitLabel}</button></div></form>`);
    $('#secForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      busy(f, true, 'Working…');
      try { await onSubmit(f); } catch (ex) { $('#secErr').textContent = ex.message; busy(f, false); }
    };
  }
  const pwField = (name, label, auto = 'new-password') => `<label class="f s3">${label}<input name="${name}" type="password" autocomplete="${auto}"></label>`;
  const pinField = (name, label) => `<label class="f">${label}<input name="${name}" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>`;

  function showRecoveryKey(rk, intro) {
    openModal(`<div class="dialog narrow"><div class="dh"><h2>Your recovery key</h2></div>
      <div class="db"><p class="s3" style="margin:0">${intro} <b>Write it down or save it now. It won't be shown again.</b></p>
      <div class="rk">${esc(rk)}</div>
      <p class="s3 muted" style="margin:0">Keep it somewhere safe and away from this PC: printed in a drawer, or on a USB stick. If you forget your password <i>and</i> lose this key, nobody can open your data, not even with OpenSafe's help.</p>
      <div class="s3" style="display:flex;gap:8px"><button class="btn" data-action="rkCopy">Copy</button><button class="btn" data-action="rkSave">Save to a file…</button></div>
      <label class="switch s3" style="font-weight:500"><input type="checkbox" id="rkOk"> I've saved my recovery key somewhere safe</label></div>
      <div class="df"><button class="btn primary" id="rkDone" disabled data-action="rkDone">Done</button></div></div>`);
    state.rk = rk;
    $('#rkOk').onchange = (e) => { $('#rkDone').disabled = !e.target.checked; };
  }

  function autoBackupCard() {
    const ab = state.snap.data.settings.autoBackup || {};
    const when = ab.last ? new Date(ab.last).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
    return `<div class="card"><h2>Automatic backups</h2>
      <p class="muted">A full backup, with photos and documents, made by itself to a folder you choose: ideally OneDrive or a USB stick, so it's safe if this laptop fails. ${state.snap.security.encrypted ? 'Backups stay encrypted.' : ''}</p>
      <label class="switch" style="font-weight:500"><input type="checkbox" id="abOn" ${ab.enabled ? 'checked' : ''}> Back up automatically</label>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin:10px 0">
        <input id="abFolder" readonly value="${esc(ab.folder || '')}" placeholder="No folder chosen"><button class="btn" data-action="abFolder">Choose folder…</button></div>
      <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <label class="f">How often<select id="abEvery">${[['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']].map(([v, l]) => opt(v, l, ab.every || 'weekly')).join('')}</select></label>
        <label class="f">Keep the newest<select id="abKeep">${[3, 5, 10, 20].map(n => opt(String(n), n + ' backups', String(ab.keep || 5))).join('')}</select></label>
        <button class="btn" data-action="abSave">Save</button><button class="btn" data-action="abNow" ${ab.folder ? '' : 'disabled'}>Back up now</button></div>
      <p class="muted" style="margin-bottom:0">Last automatic backup: <b>${esc(when)}</b>${ab.lastError ? `<br><span style="color:var(--bad)">Last attempt failed: ${esc(ab.lastError)}</span>` : ''}</p>
      <p class="faint" style="margin:4px 0 0">Backups run while OpenSafe is open (and unlocked). Older ones in the folder are removed automatically.</p></div>`;
  }

  function securityCard() {
    const sec = state.snap.security;
    if (!sec.encrypted) {
      return `<div class="card"><h2>Password protection</h2>
        <p class="muted">Off. Anyone who can use this Windows account can open OpenSafe and read its files.</p>
        <p>Turning it on encrypts your items, photos, receipts and daily backups with AES-256. OpenSafe will ask for your password each time it opens. You'll also get a recovery key for if you forget the password.</p>
        <button class="btn primary" data-action="secEnable">Turn on password protection…</button></div>`;
    }
    const v = sec.vault;
    return `<div class="card"><h2>Password protection</h2>
      <p><span class="pill good">On</span> Your items, photos, receipts and daily backups are encrypted.</p>
      <div class="secrow"><span>Lock OpenSafe now</span><button class="btn small" data-action="lockApp">🔒 Lock</button></div>
      <div class="secrow"><span>Change password</span><button class="btn small" data-action="secChangePw">Change…</button></div>
      <div class="secrow"><span>Make a new recovery key <span class="faint">(the old one stops working)</span></span><button class="btn small" data-action="secNewRk">New key…</button></div>
      <div class="secrow"><span>Turn off password protection</span><button class="btn small danger" data-action="secDisable">Turn off…</button></div>
      <h2 style="margin-top:18px">Vault</h2>
      ${!v.exists ? `<p class="muted">Keep sensitive items or single files (ID scans, logbooks, valuables) behind a separate PIN.</p><button class="btn" data-action="vaultSetup">Set up the vault…</button>`
      : `<div class="secrow"><span>Vault is <b>${v.unlocked ? 'open' : 'locked'}</b></span><button class="btn small" data-nav="vault">Go to vault</button></div>
         <div class="secrow"><span>Change vault PIN</span><button class="btn small" data-action="vaultChangePin">Change…</button></div>
         <div class="secrow"><span>Remove the vault <span class="faint">(it must be empty)</span></span><button class="btn small danger" data-action="vaultRemove">Remove…</button></div>`}
      </div>`;
  }
  function go(view, extra = {}) {
    Object.assign(state, { view }, extra);
    if (view !== 'item') state.itemId = null;
    render();
    $('#view').scrollTop = 0;
  }
  function asset(id) { return state.snap.data.assets.find(a => a.id === id); }
  function dueText(n) {
    if (n < 0) return `${-n} day${n === -1 ? '' : 's'} overdue`;
    if (n === 0) return 'due today';
    return `in ${n} day${n === 1 ? '' : 's'}`;
  }
  function dueSoon(d) {
    const n = Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 864e5);
    if (n < 0) return ` <span class="pill bad">${dueText(n)}</span>`;
    if (n <= state.snap.data.settings.reminderDays) return ` <span class="pill warn">${dueText(n)}</span>`;
    return '';
  }
  function warrantyPill(a) {
    if (!a.warrantyExpiry) return '';
    const n = Math.round((Date.parse(a.warrantyExpiry + 'T00:00:00Z') - Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 864e5);
    if (n < 0) return '<span class="pill">Warranty ended</span>';
    if (n <= state.snap.data.settings.reminderDays) return `<span class="pill warn">Warranty ${dueText(n)}</span>`;
    return '<span class="pill good">Under warranty</span>';
  }
  const cover = (a) => a.photos.find(p => !p.locked) || null;
  function thumb(a, cls = 'thumb') {
    const p = cover(a);
    return p ? `<img class="${cls}" src="${img(a, p)}" alt="" loading="lazy">` : `<div class="${cls} ph">▣</div>`;
  }
  const vaultPill = (a) => a.inVault ? '<span class="pill vault">🔒 Vault</span>' : '';

  // ---------- render ----------
  function render() {
    if (!state.snap) return;
    $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === (state.view === 'item' ? 'items' : state.view)));
    const v = $('#view');
    const views = { dashboard: viewDashboard, items: viewItems, item: viewItem, reminders: viewReminders, phone: viewPhone, reports: viewReports, settings: viewSettings, vault: viewVault, policies: viewPolicies };
    v.innerHTML = (views[state.view] || viewDashboard)();
    if (state.view === 'phone') { loadCapture(); loadPhone(); const d = $('#wifiDetails'); if (d) d.ontoggle = () => { state.wifiOpen = d.open; }; }
    if (state.view === 'item') wireDrop();
    if (state.view === 'vault') wireVaultForm();
  }

  function viewDashboard() {
    const s = state.snap.summary;
    const assets = state.snap.data.assets;
    if (!assets.length) {
      return `<div class="head"><h1>Welcome to OpenSafe</h1></div>
      <div class="card" style="max-width:640px">
        <h2>Start your inventory</h2>
        <p class="muted">Record what you own, with photos, receipts, serial numbers, warranties and service history. It all stays on this PC.</p>
        <p><button class="btn primary" data-action="new">+ Add your first item</button>
        <button class="btn" data-nav="phone">Add items from your phone</button></p>
      </div>`;
    }
    const cats = Object.entries(s.byCategory).sort((a, b) => b[1].value - a[1].value);
    const max = Math.max(1, ...cats.map(c => c[1].value));
    const recent = assets.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
    const rem = state.snap.reminders.slice(0, 6);
    return `<div class="head"><h1>Dashboard</h1><span class="sub">${s.count} active item${s.count === 1 ? '' : 's'}</span></div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card stat"><div class="lbl">Value now</div><div class="num">${money0(s.currentTotal)}</div><div class="foot">Uses price paid where no current value is set</div></div>
      <div class="card stat"><div class="lbl">Total paid</div><div class="num">${money0(s.purchaseTotal)}</div><div class="foot">Active items only</div></div>
      <div class="card stat"><div class="lbl">Insured value recorded</div><div class="num">${money0(s.insuredTotal)}</div><div class="foot">${s.uninsured} item${s.uninsured === 1 ? '' : 's'} with no insurer</div></div>
      <div class="card stat"><div class="lbl">Items</div><div class="num">${s.count}</div><div class="foot">${s.totalCount - s.count} sold, disposed or lost</div></div>
    </div>
    <div class="grid g3">
      <div class="card"><h2>Value by category</h2>
        <div class="bars">${cats.map(([c, d]) => `
          <div class="barrow" data-action="filterCat" data-cat="${esc(c)}" title="${esc(c)}: ${money(d.value)} across ${d.count} item${d.count === 1 ? '' : 's'}">
            <span class="lab">${esc(c)} <span class="faint">(${d.count})</span></span>
            <span class="track"><span class="fill" style="width:${(d.value / max * 100).toFixed(1)}%;display:block"></span></span>
            <span class="v">${money0(d.value)}</span></div>`).join('')}
        </div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Coming up</h2>
          ${rem.length ? `<div class="rows">${rem.map(r => `<div class="rowi" ${r.policyId ? 'data-nav="policies"' : `data-open="${r.assetId}"`}>
              <span class="pill ${r.daysLeft < 0 ? 'bad' : 'warn'}">${esc(r.kind)}</span>
              <span style="flex:1">${esc(r.assetName)}</span><span class="meta nowrap">${dueText(r.daysLeft)}</span></div>`).join('')}</div>`
            : '<div class="muted">Nothing due in the next ' + state.snap.data.settings.reminderDays + ' days.</div>'}
        </div>
        <div class="card"><h2>Gaps to fill</h2>
          <div class="gap"><span>No serial number</span><button class="btn small" data-action="gap" data-gap="serial">${s.noSerial}</button></div>
          <div class="gap"><span>No receipt attached</span><button class="btn small" data-action="gap" data-gap="receipt">${s.noReceipt}</button></div>
          <div class="gap"><span>No insurer recorded</span><button class="btn small" data-action="gap" data-gap="insurer">${s.uninsured}</button></div>
          <div class="gap"><span>No photo</span><button class="btn small" data-action="gap" data-gap="photo">${assets.filter(a => !INACTIVE.includes(a.status) && !a.photos.length).length}</button></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Recently added</h2>
      <div class="rows">${recent.map(a => `<div class="rowi" data-open="${a.id}">${thumb(a)}
        <div style="flex:1"><div class="name">${esc(a.name)}</div><div class="meta">${esc([a.category, a.location].filter(Boolean).join(' · '))}</div></div>
        ${a.source === 'phone' ? '<span class="pill acc">from phone</span>' : ''}
        <span class="meta nowrap">${ukDate(a.createdAt.slice(0, 10))}</span></div>`).join('')}</div>
    </div>`;
  }

  function filtered() {
    const f = state.f;
    const q = f.q.trim().toLowerCase();
    let list = state.snap.data.assets.filter(a => {
      if (f.status === 'active' && INACTIVE.includes(a.status)) return false;
      if (f.status && f.status !== 'active' && f.status !== 'all' && a.status !== f.status) return false;
      if (f.category && a.category !== f.category) return false;
      if (f.location && a.location !== f.location) return false;
      if (f.gap === 'serial' && a.serial) return false;
      if (f.gap === 'receipt' && a.documents.some(d => d.type === 'Receipt')) return false;
      if (f.gap === 'insurer' && (a.insurer || a.policyId || !value(a))) return false;
      if (f.gap === 'photo' && a.photos.length) return false;
      if (q) {
        const d = a.details || {};
        const hay = [a.name, a.brand, a.model, a.serial, a.barcode, a.category, a.location, a.notes, a.supplier, a.tags.join(' '), a.lentTo, a.lentContact, a.soldTo, a.insurer, a.policyNumber,
          d.reg, d.vin, d.engineNo, d.boatName, d.hin, d.sso, d.mmsi, d.callSign, d.mooring].filter(Boolean).join(' ').toLowerCase();
        if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
      }
      return true;
    });
    const sorts = {
      added: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) => a.name.localeCompare(b.name),
      value: (a, b) => value(b) - value(a),
      bought: (a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''),
      category: (a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name)
    };
    return list.sort(sorts[f.sort] || sorts.added);
  }

  function opt(v, label, cur) { return `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`; }

  function viewItems() {
    const f = state.f, d = state.snap.data;
    const list = filtered();
    const total = list.reduce((t, a) => t + value(a), 0);
    const gapNames = { serial: 'no serial number', receipt: 'no receipt', insurer: 'no insurer', photo: 'no photo' };
    const toolbar = `<div class="toolbar">
      <input type="search" id="q" placeholder="Search name, serial, barcode, reg, who has it, notes…" value="${esc(f.q)}">
      <select data-f="category">${opt('', 'All categories', f.category)}${d.categories.map(c => opt(c, c, f.category)).join('')}</select>
      <select data-f="location">${opt('', 'All locations', f.location)}${d.locations.map(c => opt(c, c, f.location)).join('')}</select>
      <select data-f="status">${opt('active', 'Active items', f.status)}${opt('all', 'All statuses', f.status)}${state.snap.lists.statuses.map(s => opt(s, s, f.status)).join('')}</select>
      <select data-f="sort">${opt('added', 'Newest first', f.sort)}${opt('name', 'Name A–Z', f.sort)}${opt('value', 'Highest value', f.sort)}${opt('bought', 'Recently bought', f.sort)}${opt('category', 'Category', f.sort)}</select>
      <span class="spacer"></span>
      <span class="seg"><button data-layout="table" class="${f.layout === 'table' ? 'on' : ''}">List</button><button data-layout="grid" class="${f.layout === 'grid' ? 'on' : ''}">Photos</button></span>
    </div>
    ${f.gap ? `<div style="margin:-4px 0 12px"><span class="pill warn">Showing items with ${gapNames[f.gap]}</span> <button class="btn small" data-action="clearGap">Clear</button></div>` : ''}`;
    const head = `<div class="head"><h1>Items</h1><span class="sub">${list.length} shown · ${money0(total)}</span><span class="spacer"></span><button class="btn" data-action="importPick">Import from phone…</button><button class="btn primary" data-action="new">+ Add item</button></div>`;
    if (!list.length) return head + toolbar + `<div class="card empty">${d.assets.length ? 'No items match these filters.' : 'No items yet. Add one here or from your phone.'}</div>`;
    if (f.layout === 'grid') {
      return head + toolbar + `<div class="cards">${list.map(a => `<div class="icard" data-open="${a.id}">
        <div class="img">${cover(a) ? `<img src="${img(a, cover(a))}" alt="" loading="lazy">` : '▣'}</div>
        <div class="body"><div class="name">${esc(a.name)}</div><div class="meta">${esc(a.category || '')}</div><div class="val">${value(a) ? money(value(a)) : '<span class="faint">No value</span>'}</div></div></div>`).join('')}</div>`;
    }
    const ids = list.map(a => a.id);
    for (const id of [...state.sel]) if (!state.snap.data.assets.some(a => a.id === id)) state.sel.delete(id);
    const allOn = ids.length && ids.every(id => state.sel.has(id));
    const selBar = state.sel.size ? `<div class="selbar"><b>${state.sel.size} selected</b><button class="btn primary small" data-action="bulkSel">Change…</button><button class="btn small" data-action="claimSel">Claim pack…</button><button class="btn small" data-action="labelsSel">QR labels…</button><button class="btn small" data-action="selClear">Clear selection</button></div>` : '';
    return head + toolbar + selBar + `<table class="list"><thead><tr><th style="width:34px"><input type="checkbox" class="selall" title="Select all shown" ${allOn ? 'checked' : ''}></th><th style="width:60px"></th><th>Item</th><th>Category</th><th>Location</th><th>Serial no.</th><th>Bought</th><th class="r">Value now</th><th></th></tr></thead><tbody>
      ${list.map(a => `<tr data-open="${a.id}"><td><input type="checkbox" class="selbox" data-id="${a.id}" ${state.sel.has(a.id) ? 'checked' : ''} aria-label="Select ${esc(a.name)}"></td><td>${thumb(a)}</td>
        <td><div class="name">${esc(a.name)}</div><div class="meta">${esc([a.brand, a.model].filter(Boolean).join(' '))}</div></td>
        <td>${esc(a.category)}</td><td>${esc(a.location)}</td><td class="mono">${esc(a.serial) || '<span class="faint">—</span>'}</td>
        <td class="nowrap">${ukDate(a.purchaseDate)}</td><td class="r nowrap">${value(a) ? money(value(a)) : '—'}</td>
        <td>${vaultPill(a)}${a.status !== 'Owned' ? `<span class="pill">${esc(a.status)}</span>` : ''}${a.source === 'phone' ? '<span class="pill acc">phone</span>' : ''}${warrantyPill(a).includes('warn') ? warrantyPill(a) : ''}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function itemVaultBtn(a) {
    const sec = state.snap.security;
    if (!sec.vault.exists) return '';
    if (a.inVault) return '<button class="btn" data-action="vaultOut">Move out of vault</button>';
    return `<button class="btn" data-action="vaultIn">🔒 Move to vault</button>`;
  }
  function fileVaultBtn(a, r, isDoc) {
    const sec = state.snap.security;
    if (!sec.vault.exists || a.inVault) return '';
    const cls = isDoc ? 'btn small' : '';
    return r.vaultFile ? `<button class="${cls}" data-action="fileVaultOut" data-att="${r.id}">Out of vault</button> ` : `<button class="${cls}" data-action="fileVaultIn" data-att="${r.id}">🔒 To vault</button> `;
  }

  function viewItem() {
    const a = asset(state.itemId);
    if (!a) { state.view = 'items'; return viewItems(); }
    const t = state.tab;
    const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${v || '<span class="faint">—</span>'}</div></div>`;
    const tabs = [['overview', 'Details'], ['photos', `Photos (${a.photos.length})`], ['docs', `Documents (${a.documents.length})`], ['service', `Service log (${a.service.length})`]];
    let body = '';
    if (t === 'overview') {
      body = `<div class="card"><div class="kv">
        ${kv('Category', esc(a.category))}${kv('Location', esc(a.location))}${kv('Status', esc(a.status))}
        ${kv('Brand', esc(a.brand))}${kv('Model', esc(a.model))}${kv('Serial number', a.serial ? `<span class="mono">${esc(a.serial)}</span>` : '')}
        ${kv('Bought on', a.purchaseDate ? ukDate(a.purchaseDate) : '')}${kv('Bought from', esc(a.supplier))}${kv('Condition', esc(a.condition))}
        ${kv('Price paid', a.purchasePrice !== null ? money(a.purchasePrice) : '')}${kv('Value now', a.currentValue !== null ? money(a.currentValue) : '')}${kv('Warranty until', a.warrantyExpiry ? ukDate(a.warrantyExpiry) + ' ' + warrantyPill(a) : '')}
        ${(() => { const pol = (state.snap.data.policies || []).find(p => p.id === a.policyId); return pol
          ? kv('Insured by', `<a href="#" data-nav="policies">${esc(pol.insurer)}</a>${pol.type ? ' · ' + esc(pol.type) : ''}`) + kv('Policy number', esc(pol.policyNumber)) + kv('Insured value', a.insuredValue !== null ? money(a.insuredValue) : '')
          : kv('Insurer', esc(a.insurer)) + kv('Policy number', esc(a.policyNumber)) + kv('Insured value', a.insuredValue !== null ? money(a.insuredValue) : ''); })()}
        ${kv('Tags', a.tags.map(x => `<span class="pill">${esc(x)}</span>`).join(''))}${kv('Added', ukDate(a.createdAt.slice(0, 10)) + (a.source === 'phone' ? ' from phone' : ''))}${kv('Last changed', ukDate(a.updatedAt.slice(0, 10)))}
      ${a.barcode ? kv('Barcode', `<span class="mono">${esc(a.barcode)}</span> <button class="btn small" data-action="bcLookup">Look up</button>`) : ''}
      ${a.status === 'Lent out' ? kv('Lent to', esc(a.lentTo)) + kv('Contact', esc(a.lentContact)) + kv('Lent on', a.lentDate ? ukDate(a.lentDate) : '') + kv('Due back', a.dueBack ? ukDate(a.dueBack) : '') : ''}
      ${a.status === 'Sold' ? kv('Sold on', a.soldDate ? ukDate(a.soldDate) : '') + kv('Sold for', a.soldPrice !== null && a.soldPrice !== undefined ? money(a.soldPrice) : '') + kv('Sold to', esc(a.soldTo)) : ''}
      </div>${a.notes ? `<div class="notes">${esc(a.notes)}</div>` : ''}</div>
      ${a.details && a.details.kind ? `<div class="card" style="margin-top:14px"><h2>${a.details.kind === 'boat' ? 'Boat details' : 'Vehicle details'}</h2><div class="kv">
        ${DETAIL_UI[a.details.kind].map(([k, label, type]) => kv(label, a.details[k] ? (type === 'date' ? ukDate(a.details[k]) + dueSoon(a.details[k]) : `<span class="${/vin|hin|engineNo|reg|sso|mmsi/.test(k) ? 'mono' : ''}">${esc(a.details[k])}</span>`) : '')).join('')}
      </div></div>` : ''}`;
    } else if (t === 'photos') {
      body = `<div class="drop" id="drop">Drag photos here, or <button class="btn small" data-action="pick" data-kind="photo">Choose photos…</button></div>
      ${a.photos.length ? `<div class="gallery">${a.photos.map((p, i) => p.locked ? `<div class="ph-tile locked" data-nav="vault"><div>🔒<br>Vault photo<br><small>Unlock the vault to see it</small></div></div>` : `<div class="ph-tile">
        <img src="${img(a, p)}" alt="${esc(p.name)}" data-zoom="${img(a, p)}">
        ${i === 0 ? '<span class="pill acc coverflag">Cover</span>' : ''}${p.vaultFile ? '<span class="pill vault coverflag" style="left:auto;right:6px">🔒 Vault</span>' : ''}
        <div class="acts">${i ? `<button data-action="cover" data-att="${p.id}">Make cover</button>` : ''}<button data-action="ocr" data-file="${esc(p.file)}" title="Read a photo of a receipt">Read receipt</button>${fileVaultBtn(a, p)}<button data-action="rmAtt" data-att="${p.id}">Delete</button></div></div>`).join('')}</div>`
        : '<div class="empty">No photos yet. Photos of the item, its serial plate and its box all help with insurance claims.</div>'}`;
    } else if (t === 'docs') {
      body = `<div class="drop" id="drop">Drag receipts, manuals or warranty cards here as
        <select id="docType" style="width:auto;min-width:120px;margin:0 6px">${state.snap.lists.docTypes.map(x => opt(x, x, 'Receipt')).join('')}</select>
        or <button class="btn small" data-action="pick" data-kind="document">Choose files…</button></div>
      ${a.documents.length ? `<table class="list"><thead><tr><th>Name</th><th>Type</th><th>Added</th><th></th></tr></thead><tbody>
        ${a.documents.map(d => d.locked ? `<tr><td colspan="3">🔒 <b>Vault file</b> <span class="muted">(unlock the vault to see its name and open it)</span></td><td class="r"><button class="btn small" data-nav="vault">Unlock vault</button></td></tr>`
        : `<tr><td data-action="openDoc" data-file="${esc(d.file)}" data-name="${esc(d.name)}"><b>${esc(d.name)}</b> ${d.vaultFile ? '<span class="pill vault">🔒 Vault</span>' : ''}</td><td><span class="pill ${d.type === 'Receipt' ? 'good' : ''}">${esc(d.type)}</span></td>
        <td>${ukDate(d.addedAt.slice(0, 10))}</td><td class="r nowrap"><button class="btn small" data-action="openDoc" data-file="${esc(d.file)}" data-name="${esc(d.name)}">Open</button> ${/\.(jpe?g|png|webp|gif)$/i.test(d.file) ? `<button class="btn small" data-action="ocr" data-file="${esc(d.file)}">Read receipt</button> ` : ''}${fileVaultBtn(a, d, true)}<button class="btn small danger" data-action="rmAtt" data-att="${d.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No documents yet.</div>'}`;
    } else if (t === 'service') {
      const cost = a.service.reduce((x, s) => x + (s.cost || 0), 0);
      body = `<div class="toolbar"><button class="btn primary" data-action="newService">+ Add entry</button><span class="muted">${a.service.length ? `Total spent: ${money(cost)}` : ''}</span></div>
      ${a.service.length ? `<table class="list"><thead><tr><th>Date</th><th>Type</th><th>Details</th><th>By</th><th>Mileage</th><th class="r">Cost</th><th>Next due</th><th></th></tr></thead><tbody>
        ${a.service.map(s => `<tr data-action="editService" data-sid="${s.id}"><td class="nowrap">${ukDate(s.date)}</td><td>${esc(s.type)}</td><td>${esc(s.description)}</td><td>${esc(s.by)}</td><td>${esc(s.mileage)}</td>
        <td class="r nowrap">${s.cost !== null ? money(s.cost) : '—'}</td><td class="nowrap">${s.nextDueDate ? ukDate(s.nextDueDate) : '—'}</td>
        <td class="r"><button class="btn small danger" data-action="rmService" data-sid="${s.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No service history. Log MOTs, services, repairs, battery changes and inspections here. Set a "next due" date to get a reminder.</div>'}`;
    }
    return `<div class="head"><button class="btn" data-action="back">← Items</button><span class="spacer"></span>
      ${itemVaultBtn(a)}<button class="btn" data-action="labelOne">QR label…</button><button class="btn" data-action="claimOne">Claim pack…</button><button class="btn" data-action="dup">Duplicate</button><button class="btn danger" data-action="del">Delete</button><button class="btn primary" data-action="edit">Edit</button></div>
    ${a.inVault ? '<div class="note" style="margin-bottom:14px">🔒 This item is in the vault. It\'s hidden, and left out of totals and reports, whenever the vault is locked.</div>' : ''}
    <div class="detail-head">
      ${cover(a) ? `<img class="cover" src="${img(a, cover(a))}" data-zoom="${img(a, cover(a))}" alt="">` : '<div class="cover" data-tab="photos">▣</div>'}
      <div><h1>${esc(a.name)}</h1><div class="muted">${esc([a.brand, a.model].filter(Boolean).join(' '))}</div>
      <div style="margin-top:10px;font-size:22px;font-weight:650">${value(a) ? money(value(a)) : ''}</div>
      <div style="margin-top:6px">${a.status !== 'Owned' ? `<span class="pill">${esc(a.status)}</span>` : ''}${warrantyPill(a)}${a.insurer ? '<span class="pill good">Insured</span>' : ''}</div></div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${t === k ? 'on' : ''}">${l}</button>`).join('')}</div>${body}`;
  }

  function viewReminders() {
    const r = state.snap.reminders;
    const over = r.filter(x => x.daysLeft < 0), soon = r.filter(x => x.daysLeft >= 0);
    const block = (title, list, cls) => `<div class="card" style="margin-bottom:16px"><h2>${title}</h2>${list.length ? `<div class="rows">${list.map(x => `
      <div class="rowi" ${x.policyId ? 'data-nav="policies"' : `data-open="${x.assetId}" data-opentab="${x.source === 'item' ? 'overview' : 'service'}"`}><span class="pill ${cls}">${esc(x.kind)}</span><span style="flex:1"><b>${esc(x.assetName)}</b></span>
      <span class="meta">${ukDate(x.date)}</span><span class="nowrap" style="width:130px;text-align:right">${dueText(x.daysLeft)}</span></div>`).join('')}</div>` : '<div class="muted">None.</div>'}</div>`;
    return `<div class="head"><h1>Reminders</h1><span class="sub">Warranty end dates and "next due" dates from service logs, looking ${state.snap.data.settings.reminderDays} days ahead</span></div>
      ${block('Overdue', over, 'bad')}${block('Coming up', soon, 'warn')}`;
  }

  function viewPhone() {
    return `<div class="head"><h1>Add items from your phone or tablet</h1></div>
    <div class="grid g2">
      <div class="card"><h2>1. Put OpenSafe Capture on your phone</h2>
        <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
          <div class="qr" id="capQr" style="width:220px"><div class="muted">Loading…</div></div>
          <ol class="steps" style="flex:1;min-width:220px">
            <li>Scan this code with your phone's camera and open the link in <b>Chrome</b>.</li>
            <li>Tap <b>Install</b> (or ⋮ → <b>Add to Home screen</b>). It gets its own icon and works without internet or Wi-Fi.</li>
            <li>Add items: photos, details and receipts. They're kept on the phone.</li>
          </ol>
        </div>
        <p class="muted" style="margin-bottom:0">Works on phones and tablets. Do the same on each device you use.</p>
      </div>
      <div class="card"><h2>2. Bring the items into this PC</h2>
        <ol class="steps">
          <li>In OpenSafe Capture, tap <b>Export to PC</b>. It makes one <b>.opensafe</b> file with everything, photos included.</li>
          <li>Send the file to this PC however suits you: <b>Quick Share</b>, Bluetooth, email, Google Drive, OneDrive, or a USB cable.</li>
          <li>Then either click <b>Import from phone</b> below, double-click the file, or drag it into this window.</li>
        </ol>
        <button class="btn primary" data-action="importPick">Import from phone…</button>
        <p class="muted">Importing the same file twice is safe: items already here are skipped, and only new photos are added.</p>
      </div>
      <div class="card" style="grid-column:1/-1"><h2>3. See your inventory on your phone</h2>
        <p class="muted">Save a read-only copy of your items (with small photos) for OpenSafe Capture. Open it there with <b>My inventory → Load file</b>, then search your things, or scan an item's QR label to see its details. The file is encrypted with a passphrase you choose here, which you'll type on the phone.</p>
        <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
          <label class="f" style="min-width:260px">Passphrase (at least 6 characters)<input id="pvPass" type="password" autocomplete="new-password"></label>
          ${state.snap.security.vault.unlocked ? '<label class="switch" style="font-weight:500"><input type="checkbox" id="pvVault"> Include vault items</label>' : ''}
          <button class="btn primary" data-action="phoneView">Save inventory for phone…</button></div>
        <p class="faint" style="margin-bottom:0">Send the file to your phone the same way as before (Quick Share, email, OneDrive, USB). Make a new one whenever you want the phone up to date. For QR labels, select items in <b>Items</b> and choose <b>QR labels…</b>.</p></div>
    </div>
    <details class="card" id="wifiDetails" style="margin-top:16px"${state.wifiOpen ? ' open' : ''}>
      <summary style="cursor:pointer"><b>Wi-Fi link (advanced)</b> <span class="muted">: add items straight to this PC over your home Wi-Fi</span></summary>
      <div class="grid g2" style="margin-top:14px">
        <div><label class="switch"><input type="checkbox" id="phoneOn"> Allow my phone to add items over Wi-Fi</label>
          <div id="phoneBody" style="margin-top:16px" class="muted">Loading…</div></div>
        <div><ol class="steps">
          <li>Switch the link on and make sure your phone is on the <b>same Wi-Fi</b> as this PC.</li>
          <li>Scan the QR code on the left and open the link.</li>
          <li>Take photos, fill in the details and tap <b>Save to PC</b>.</li>
        </ol>
        <p class="note">This PC must be on, with OpenSafe open. Some routers and phone browsers block this kind of connection. If it won't connect, use OpenSafe Capture above instead.</p></div>
      </div>
    </details>`;
  }

  function loadCapture() {
    keep.captureInfo().then(c => {
      const el = $('#capQr'); if (!el) return;
      el.innerHTML = `<img src="${c.qr}" alt="QR code for OpenSafe Capture"><div class="u">${esc(c.url)}</div>`;
    }).catch(() => {});
  }

  let phoneTimer = null;
  async function loadPhone() {
    clearTimeout(phoneTimer);
    phoneTimer = setTimeout(() => { if (state.view === 'phone' && $('#modal').classList.contains('hidden')) loadPhone(); }, 3000);
    let s;
    try { s = await keep.phoneStatus(); } catch (e) { $('#phoneBody').textContent = e.message; return; }
    if (state.view !== 'phone') return;
    $('#phoneOn').checked = s.enabled;
    const body = $('#phoneBody');
    if (!s.enabled) { body.innerHTML = '<p>The link is off. Nothing on your network can reach OpenSafe.</p>'; return; }
    if (!s.running) { body.innerHTML = '<p style="color:var(--bad)">The link could not start. Another program may be using the port. Switch it off and on to try again.</p>'; return; }
    if (!s.urls.length) { body.innerHTML = '<p style="color:var(--bad)">This PC doesn\'t seem to be connected to a home network (no local network address found). Connect to Wi-Fi or Ethernet, then switch the link off and on.</p>'; return; }
    const main = s.urls.filter(u => !u.virtual);
    const shown = main.length ? main : s.urls;
    body.innerHTML = `<p>Scan with your phone's camera:</p>
      <div class="qrs">${shown.map(u => `<div class="qr"><img src="${u.qr}" alt="QR code to pair your phone"><div><b>${esc(u.name)}</b></div><div class="u">${esc(u.url.replace(/#.*/, ''))}</div></div>`).join('')}</div>
      ${shown.length > 1 ? '<p class="muted">More than one network was found. Use the code for the network your phone is on (usually Wi-Fi).</p>' : ''}
      <p class="muted">Running on port ${s.port}. ${s.lastSeen ? 'Phone last connected ' + new Date(s.lastSeen).toLocaleString('en-GB') + '.' : 'No phone has connected since OpenSafe started.'}</p>
      <div style="margin:4px 0 14px"><b>Connection log</b> <span class="faint">(updates by itself)</span>
        ${s.attempts && s.attempts.length ? `<div class="rows">${s.attempts.map(a => `<div class="gap"><span><span class="pill ${a.kind === 'https' ? 'bad' : 'good'}">${esc(a.ip)}</span> ${esc(a.text)}</span><span class="meta nowrap">${new Date(a.time).toLocaleTimeString('en-GB')}</span></div>`).join('')}</div>`
          : '<div class="muted">Nothing has tried to connect yet. If your phone shows an error but nothing appears here, the phone\'s request never reached this PC: check the phone is on the same Wi-Fi, and that the router isn\'t keeping devices apart.</div>'}</div>
      <button class="btn" data-action="phoneReset">New pairing code</button>
      ${state.snap.platform === 'win32' ? `<div class="card" style="margin-top:16px;box-shadow:none;background:var(--surface2)">
        <h2>Phone can't connect?</h2>
        <p class="muted">Windows Firewall can block your phone, even when OpenSafe looks allowed. This button removes any firewall rules blocking OpenSafe and adds one rule that lets your phone in on your home Wi-Fi (private networks only). Windows will ask for permission: click <b>Yes</b>.</p>
        <p id="fwState" class="muted"></p>
        <button class="btn primary" data-action="fixFirewall">Fix Windows Firewall</button></div>` : ''}`;
    const fwText = (ok) => ok ? '✓ OpenSafe\'s firewall rule is in place.' : 'OpenSafe\'s own firewall rule isn\'t set up yet.';
    if (state.snap.platform === 'win32') {
      if (state.fw && Date.now() - state.fw.at < 60000) { const el = $('#fwState'); if (el) el.innerHTML = fwText(state.fw.ok); }
      else keep.firewallRule().then(ok => { state.fw = { ok, at: Date.now() }; const el = $('#fwState'); if (el) el.innerHTML = fwText(ok); }).catch(() => {});
    }
  }

  function viewReports() {
    return `<div class="head"><h1>Reports</h1></div>
    <div class="grid g2">
      <div class="card"><h2>Insurance / inventory report (PDF)</h2>
        <p class="muted">A printable list of everything you own, grouped by category, with photos, serial numbers, prices, values and whether you have a receipt. Useful for your insurer, a claim, or a moving company.</p>
        <p><label class="switch" style="font-weight:500"><input type="checkbox" id="rPhotos" checked> Include a photo of each item</label></p>
        <p><label class="switch" style="font-weight:500"><input type="checkbox" id="rInactive"> Include sold, disposed and lost items</label></p>
        <button class="btn primary" data-action="report">Save PDF…</button></div>
      ${state.snap.security.vault.exists ? `<div class="note" style="grid-column:1/-1">🔒 Vault items are only included while the vault is open. It's ${state.snap.security.vault.unlocked ? '<b>open</b> now, so they will be included' : '<b>locked</b> now, so they will be left out'}. Reports and spreadsheets are saved unencrypted, so keep them somewhere safe.</div>` : ''}
      <div class="card"><h2>Spreadsheet (CSV)</h2>
        <p class="muted">Every item and all its fields, for Excel or Google Sheets.</p>
        <button class="btn primary" data-action="csv">Export CSV…</button></div>
    </div>`;
  }

  function viewSettings() {
    const d = state.snap.data;
    return `<div class="head"><h1>Settings</h1></div>
    <div class="grid g2">
      ${securityCard()}
      <div class="card"><h2>Reminders</h2>
        <label class="f" style="max-width:260px">Remind me this many days ahead<input type="number" id="remDays" min="1" max="365" value="${d.settings.reminderDays}"></label>
        <p class="muted">OpenSafe also shows a Windows notification when you open it if anything is due within 7 days.</p>
        <button class="btn" data-action="saveRem">Save</button></div>
      <div class="card"><h2>Backup</h2>
        <p class="muted">OpenSafe keeps a copy of your list each day for 30 days in its data folder. For a full backup with photos and documents, save one to a USB stick or OneDrive folder.</p>
        <p><button class="btn primary" data-action="backup">Back up to a folder…</button> <button class="btn" data-action="restore">Restore from backup…</button></p>
        <p class="muted" style="margin-bottom:6px">Data folder: <span class="mono">${esc(state.snap.dataDir)}</span></p>
        <button class="btn small" data-action="openData">Open data folder</button></div>
      ${autoBackupCard()}
      <div class="card"><h2>Appearance</h2>
        <p class="muted">Light or dark colours. "Match Windows" follows your Windows setting.</p>
        <span class="seg">${['system', 'light', 'dark'].map(t => `<button data-action="theme" data-theme="${t}" class="${(state.snap.theme || 'system') === t ? 'on' : ''}">${{ system: 'Match Windows', light: 'Light', dark: 'Dark' }[t]}</button>`).join('')}</span></div>
      <div class="card"><h2>Updates</h2>
        <p>You're running version <b>${esc(state.snap.version)}</b>.</p>
        <p class="muted" id="updMsg">${esc(updText())}</p>
        <p>${state.upd && state.upd.canUpdate ? '<button class="btn" data-action="updCheck">Check now</button> ' : ''}${state.upd && state.upd.state === 'ready' ? '<button class="btn primary" data-action="updInstall">Restart and update</button>' : ''}</p>
        <p class="faint">OpenSafe checks for new versions when it starts and every 4 hours, and downloads them quietly. Your items, photos and settings are kept when it updates.</p></div>
      <div class="card"><h2>Categories</h2><p class="muted">One per line. Existing items keep their category.</p>
        <textarea id="catsTa" rows="12">${esc(d.categories.join('\n'))}</textarea></div>
      <div class="card"><h2>Locations</h2><p class="muted">One per line.</p>
        <textarea id="locsTa" rows="12">${esc(d.locations.join('\n'))}</textarea>
        <p><button class="btn primary" data-action="saveLists">Save categories and locations</button></p></div>
    </div>
    <p class="faint" style="margin-top:18px">OpenSafe ${esc(state.snap.version)}</p>`;
  }

  function updText() {
    const u = state.upd;
    if (!u) return 'Checking update status…';
    if (u.state === 'idle') return 'Will check for updates shortly.';
    return u.message;
  }
  function renderUpdate() {
    const u = state.upd, bar = $('#updBar');
    const show = u && u.state === 'ready' && !state.updHidden;
    bar.classList.toggle('hidden', !show);
    if (show) bar.innerHTML = `<span style="flex:1">⬆ OpenSafe ${esc(u.version)} is ready to install.</span><button class="btn small" data-action="updInstall">Restart now</button><button class="btn small ghost" data-action="updLater">Later</button>`;
    const m = $('#updMsg'); if (m) m.textContent = updText();
  }

  // ---------- modals ----------
  function wireVaultForm() {
    const f = $('#vaultForm');
    if (!f) return;
    f.pin.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      busy(f, true, 'Unlocking…');
      try { await keep.vaultUnlock(f.pin.value); await refresh(); }
      catch (ex) { $('#vaultErr').textContent = ex.message; busy(f, false); f.pin.select(); }
    };
  }

  function openModal(html) { const m = $('#modal'); m.innerHTML = html; m.classList.remove('hidden'); const first = $('input,select,textarea', m); first && first.focus(); }
  function closeModal() { const m = $('#modal'); m.classList.add('hidden'); m.innerHTML = ''; }

  const DETAIL_UI = {
    vehicle: [['reg', 'Registration'], ['vin', 'VIN / frame number'], ['engineNo', 'Engine number'], ['mileage', 'Mileage'], ['fuel', 'Fuel'], ['colour', 'Colour'], ['motDue', 'MOT due', 'date'], ['taxDue', 'Road tax due', 'date'], ['serviceDue', 'Next service due', 'date']],
    boat: [['boatName', 'Boat name'], ['hin', 'Hull ID (HIN / CIN)'], ['sso', 'Registration (SSR / Part 1)'], ['mmsi', 'MMSI'], ['callSign', 'Call sign'], ['lengthM', 'Length (m)'], ['engine', 'Engine'], ['engineHours', 'Engine hours'], ['mooring', 'Mooring / marina'], ['serviceDue', 'Next service due', 'date']]
  };
  const guessKind = (cat) => /vehicle|car|van|motorbike|motorcycle|bike/i.test(cat || '') && !/gear|clothing/i.test(cat || '') ? 'vehicle' : (/marine|boat|yacht/i.test(cat || '') ? 'boat' : '');

  function itemForm(a) {
    const d = state.snap.data, L = state.snap.lists;
    a = a || { status: 'Owned', tags: [], details: { kind: '' } };
    const det = a.details || { kind: '' };
    const inp = (name, label, extra = '', cls = '') => `<label class="f ${cls}">${label}<input name="${name}" value="${esc(a[name] ?? '')}" ${extra}></label>`;
    const detInp = ([k, label, type]) => `<label class="f">${label}<input name="det_${k}" value="${esc(det[k] || '')}" ${type === 'date' ? 'type="date"' : ''}></label>`;
    const policies = d.policies || [];
    openModal(`<form class="dialog" id="itemForm" novalidate>
      <div class="dh"><h2>${a.id ? 'Edit item' : 'Add item'}</h2></div>
      <div class="db">
        ${inp('name', 'Name *', 'required maxlength="200" placeholder="e.g. Makita cordless drill"', 's2')}
        <label class="f">Status<select name="status" id="fStatus">${L.statuses.map(s => opt(s, s, a.status)).join('')}</select></label>
        <label class="f">Category<input name="category" id="fCat" list="dlCats" value="${esc(a.category || '')}"></label>
        <label class="f">Location<input name="location" list="dlLocs" value="${esc(a.location || '')}"></label>
        <label class="f">Condition<select name="condition">${opt('', '—', a.condition || '')}${L.conditions.map(s => opt(s, s, a.condition)).join('')}</select></label>
        ${inp('brand', 'Brand')}${inp('model', 'Model')}${inp('serial', 'Serial number')}
        <div id="lendBox" class="s3 subgrid ${a.status === 'Lent out' ? '' : 'hidden'}"><h3>Lent out</h3>
          ${inp('lentTo', 'Lent to')}${inp('lentContact', 'Phone or email')}${inp('lentDate', 'Lent on', 'type="date"')}${inp('dueBack', 'Due back (reminder)', 'type="date"')}</div>
        <div id="soldBox" class="s3 subgrid ${a.status === 'Sold' ? '' : 'hidden'}"><h3>Sold</h3>
          ${inp('soldDate', 'Sold on', 'type="date"')}${inp('soldPrice', 'Sold for (£)', 'inputmode="decimal"')}${inp('soldTo', 'Sold to / where')}</div>
        <h3>Purchase and value</h3>
        ${inp('purchaseDate', 'Bought on', 'type="date"')}${inp('purchasePrice', 'Price paid (£)', 'inputmode="decimal"')}${inp('supplier', 'Bought from')}
        ${inp('currentValue', 'Value now (£)', 'inputmode="decimal"')}${inp('warrantyExpiry', 'Warranty until', 'type="date"')}${inp('barcode', 'Barcode', 'inputmode="numeric"')}
        <h3>Vehicle or boat</h3>
        <label class="f">Extra details for<select name="det_kind" id="fKind">${opt('', 'Nothing (general item)', det.kind)}${opt('vehicle', 'A vehicle (car, van, motorbike)', det.kind)}${opt('boat', 'A boat', det.kind)}</select></label>
        <div class="s2 muted" style="align-self:end;font-size:12.5px" id="kindHint">${det.kind ? '' : 'Choose this for cars, motorbikes and boats to record registration, VIN, MOT and more.'}</div>
        <div id="detBox" class="s3 subgrid">${det.kind ? DETAIL_UI[det.kind].map(detInp).join('') : ''}</div>
        <h3>Insurance</h3>
        <label class="f s2">Policy<select name="policyId">${opt('', policies.length ? '— Not linked to a policy —' : '— No policies yet (add them under Insurance) —', a.policyId || '')}${policies.map(p => opt(p.id, `${p.insurer}${p.type ? ' · ' + p.type : ''}${p.policyNumber ? ' · ' + p.policyNumber : ''}`, a.policyId || '')).join('')}</select></label>
        ${inp('insuredValue', 'Insured value (£)', 'inputmode="decimal"')}
        ${inp('insurer', 'Insurer (if no policy above)')}${inp('policyNumber', 'Policy number (if no policy above)')}<div></div>
        <h3>Other</h3>
        <label class="f s3">Tags (comma separated)<input name="tags" value="${esc((a.tags || []).join(', '))}"></label>
        <label class="f s3">Notes<textarea name="notes" rows="4">${esc(a.notes || '')}</textarea></label>
        <div class="err" id="formErr"></div>
      </div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary">${a.id ? 'Save changes' : 'Add item'}</button></div>
      <datalist id="dlCats">${d.categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="dlLocs">${d.locations.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    </form>`);
    const f = $('#itemForm');
    $('#fStatus').onchange = (e) => { $('#lendBox').classList.toggle('hidden', e.target.value !== 'Lent out'); $('#soldBox').classList.toggle('hidden', e.target.value !== 'Sold'); };
    const showKind = (k) => {
      const cur = {}; for (const el of $$('#detBox input')) cur[el.name.slice(4)] = el.value;
      $('#detBox').innerHTML = k ? DETAIL_UI[k].map(([key, label, type]) => detInp([key, label, type])).join('') : '';
      for (const el of $$('#detBox input')) if (cur[el.name.slice(4)]) el.value = cur[el.name.slice(4)];
      $('#kindHint').textContent = k ? '' : 'Choose this for cars, motorbikes and boats to record registration, VIN, MOT and more.';
    };
    $('#fKind').onchange = (e) => showKind(e.target.value);
    $('#fCat').onchange = (e) => { if (!$('#fKind').value) { const k = guessKind(e.target.value); if (k) { $('#fKind').value = k; showKind(k); } } };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const raw = Object.fromEntries(new FormData(e.target).entries());
      const data = {}; const details = {};
      for (const [k, v] of Object.entries(raw)) { if (k.startsWith('det_')) details[k.slice(4)] = v; else data[k] = v; }
      data.details = details;
      if (!data.name.trim()) { $('#formErr').textContent = 'Give the item a name.'; return; }
      for (const k of ['purchasePrice', 'currentValue', 'insuredValue', 'soldPrice']) {
        if (data[k] && !Number.isFinite(Number(String(data[k]).replace(/[£,\s]/g, '')))) { $('#formErr').textContent = 'Money amounts must be numbers, e.g. 249.99'; return; }
      }
      if (a.id) data.id = a.id;
      const saved = await run(() => keep.saveAsset(data), a.id ? 'Saved' : 'Item added');
      closeModal();
      await refresh();
      go('item', { itemId: saved.id, tab: a.id ? state.tab : 'overview' });
    };
  }

  function serviceForm(a, s) {
    s = s || { date: new Date().toISOString().slice(0, 10) };
    const inp = (name, label, extra = '', cls = '') => `<label class="f ${cls}">${label}<input name="${name}" value="${esc(s[name] ?? '')}" ${extra}></label>`;
    openModal(`<form class="dialog narrow" id="svcForm">
      <div class="dh"><h2>${s.id ? 'Edit' : 'Add'} service entry · ${esc(a.name)}</h2></div>
      <div class="db">
        ${inp('date', 'Date', 'type="date" required')}
        <label class="f">Type<input name="type" list="svcTypes" value="${esc(s.type || '')}" placeholder="Service, MOT, Repair…"></label>
        <label class="f s3">Details<textarea name="description" rows="3">${esc(s.description || '')}</textarea></label>
        ${inp('by', 'Done by')}${inp('cost', 'Cost (£)', 'inputmode="decimal"')}
        ${inp('mileage', 'Mileage / hours')}${inp('nextDueDate', 'Next due', 'type="date"')}
      </div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save</button></div>
      <datalist id="svcTypes">${['Service', 'MOT', 'Repair', 'Inspection', 'Tyres', 'Battery', 'Clean', 'Upgrade', 'Calibration', 'Insurance renewal'].map(x => `<option value="${x}">`).join('')}</datalist>
    </form>`);
    $('#svcForm').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (s.id) data.id = s.id;
      await run(() => keep.saveService(a.id, data), 'Saved');
      closeModal();
      await refresh();
    };
  }

  // ---------- drag & drop ----------
  function wireDrop() {
    const z = $('#drop');
    if (!z) return;
    const kind = state.tab === 'photos' ? 'photo' : 'document';
    z.ondragover = (e) => { e.preventDefault(); z.classList.add('over'); };
    z.ondragleave = () => z.classList.remove('over');
    z.ondrop = async (e) => {
      e.preventDefault(); z.classList.remove('over');
      const docType = $('#docType') ? $('#docType').value : 'Other';
      const r = await run(() => keep.addFiles(state.itemId, kind, docType, e.dataTransfer.files));
      reportAdd(r);
      await refresh();
    };
  }
  function reportAdd(r) {
    if (!r) return;
    if (r.errors.length) toast(`Added ${r.added}. Not added: ${r.errors.join('; ')}`, 7000);
    else if (r.added) toast(`Added ${r.added} file${r.added === 1 ? '' : 's'}`);
  }

  // ---------- events ----------
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.target.closest && e.target.closest('#drop')) return; // item photo/document drop zone handles its own files
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter(f => /\.(opensafe|txt|json)$/i.test(f.name));
    if (!files.length) return;
    try { await keep.importFiles(files); } catch (err) { toast('⚠ ' + err.message, 5000); }
    await refresh();
  });

  document.addEventListener('click', async (e) => {
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) { const lb = $('#lightbox'); lb.innerHTML = `<img src="${esc(zoom.dataset.zoom)}" alt="">`; lb.classList.remove('hidden'); return; }
    if (e.target.closest('#lightbox')) { $('#lightbox').classList.add('hidden'); return; }
    if (e.target.id === 'modal') { if (!state.rk) closeModal(); return; } // never lose an unsaved recovery key

    if (e.target.classList && e.target.classList.contains('selbox')) { const id = e.target.dataset.id; if (e.target.checked) state.sel.add(id); else state.sel.delete(id); render(); return; }
    if (e.target.classList && e.target.classList.contains('selall')) { const on = e.target.checked; for (const a of filtered()) { if (on) state.sel.add(a.id); else state.sel.delete(a.id); } render(); return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) { if (nav.dataset.nav === 'items') state.f.gap = ''; go(nav.dataset.nav); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; render(); return; }
    const lay = e.target.closest('[data-layout]');
    if (lay) { state.f.layout = lay.dataset.layout; render(); return; }

    const act = e.target.closest('[data-action]');
    if (act) {
      const a = state.itemId && asset(state.itemId);
      switch (act.dataset.action) {
        case 'new': itemForm(); break;
        case 'close': closeModal(); break;
        case 'back': go('items'); break;
        case 'edit': itemForm(a); break;
        case 'dup': { const c = await run(() => keep.duplicateAsset(a.id), 'Copy made – photos and documents are not copied'); await refresh(); go('item', { itemId: c.id, tab: 'overview' }); break; }
        case 'del': { const ok = await run(() => keep.deleteAsset(a.id)); if (ok) { toast('Deleted'); await refresh(); go('items'); } break; }
        case 'pick': { const r = await run(() => keep.pickFiles(a.id, act.dataset.kind, $('#docType') ? $('#docType').value : 'Other')); reportAdd(r); await refresh(); break; }
        case 'rmAtt': if (confirm('Delete this file from OpenSafe?')) { await run(() => keep.removeAttachment(a.id, act.dataset.att), 'Deleted'); await refresh(); } break;
        case 'cover': await run(() => keep.setCover(a.id, act.dataset.att)); await refresh(); break;
        case 'openDoc': await run(() => keep.openAttachment(a.id, act.dataset.file, act.dataset.name)); break;
        case 'newService': serviceForm(a); break;
        case 'editService': if (!e.target.closest('button')) serviceForm(a, a.service.find(s => s.id === act.dataset.sid)); break;
        case 'rmService': e.stopPropagation(); if (confirm('Delete this service entry?')) { await run(() => keep.deleteService(a.id, act.dataset.sid), 'Deleted'); await refresh(); } break;
        case 'filterCat': state.f = Object.assign(state.f, { category: act.dataset.cat === 'Uncategorised' ? '' : act.dataset.cat, status: 'active', gap: '', q: '' }); go('items'); break;
        case 'gap': state.f = Object.assign(state.f, { gap: act.dataset.gap, status: 'active', category: '', location: '', q: '' }); go('items'); break;
        case 'clearGap': state.f.gap = ''; render(); break;
        case 'fixFirewall': {
          act.disabled = true; act.textContent = 'Waiting for Windows…';
          state.fw = null;
          try { await run(() => keep.fixFirewall(), '✓ Firewall fixed. Try your phone again.'); } catch (_) {}
          loadPhone(); break;
        }
        case 'lockApp': await keep.lock(); break;
        case 'lockForgot': showLock('recover'); break;
        case 'lockBack': showLock('unlock'); break;
        case 'vaultLock': await keep.vaultLock(); toast('Vault locked'); break;
        case 'vaultIn':
          if (!state.snap.security.vault.unlocked) { toast('Unlock the vault first'); go('vault'); break; }
          await run(() => keep.vaultMoveItem(a.id, true), '🔒 Moved to the vault'); await refresh(); break;
        case 'vaultOut': await run(() => keep.vaultMoveItem(a.id, false), 'Moved out of the vault'); await refresh(); break;
        case 'fileVaultIn':
          if (!state.snap.security.vault.unlocked) { toast('Unlock the vault first'); go('vault'); break; }
          await run(() => keep.vaultMoveFile(a.id, act.dataset.att, true), '🔒 File moved to the vault'); await refresh(); break;
        case 'fileVaultOut': await run(() => keep.vaultMoveFile(a.id, act.dataset.att, false), 'File moved out of the vault'); await refresh(); break;
        case 'secEnable':
          secModal('Turn on password protection', `<p class="s3 muted" style="margin:0">Choose a password you'll remember: at least 8 characters. A short sentence works well.</p>${pwField('pw', 'Password')}${pwField('pw2', 'Password again')}
            <p class="s3 muted" style="margin:0">OpenSafe will encrypt everything now. With lots of photos this can take a minute.</p>`, 'Turn on', async (f) => {
            if (f.pw.value !== f.pw2.value) throw new Error('The two passwords don\'t match.');
            const rk = await keep.enableProtection(f.pw.value);
            showRecoveryKey(rk, 'Password protection is on.');
          });
          break;
        case 'rkCopy': await keep.copyText(state.rk); toast('Copied. It\'s cleared from the clipboard after a minute.'); break;
        case 'rkSave': { const p = await run(() => keep.saveRecoveryKey(state.rk)); if (p) toast('Saved. Move that file off this PC, e.g. to a USB stick.', 5000); break; }
        case 'rkDone': state.rk = null; closeModal(); await refresh(); break;
        case 'secChangePw':
          secModal('Change password', pwField('cur', 'Current password', 'current-password') + pwField('pw', 'New password') + pwField('pw2', 'New password again'), 'Change password', async (f) => {
            if (f.pw.value !== f.pw2.value) throw new Error('The two new passwords don\'t match.');
            await keep.changePassword(f.cur.value, f.pw.value); closeModal(); toast('Password changed');
          });
          break;
        case 'secNewRk':
          secModal('Make a new recovery key', '<p class="s3 muted" style="margin:0">Your old recovery key will stop working.</p>' + pwField('cur', 'Your password', 'current-password'), 'Make new key', async (f) => {
            const rk = await keep.newRecoveryKey(f.cur.value); showRecoveryKey(rk, 'This is your new recovery key. The old one no longer works.');
          });
          break;
        case 'secDisable':
          secModal('Turn off password protection', '<p class="s3" style="margin:0">Your files will be decrypted and stored unprotected on this PC.</p>' + pwField('cur', 'Your password', 'current-password'), 'Turn off', async (f) => {
            await keep.disableProtection(f.cur.value); closeModal(); toast('Password protection is off'); await refresh();
          });
          break;
        case 'vaultSetup':
          secModal('Set up the vault', '<p class="s3 muted" style="margin:0">Choose a PIN of 4 to 8 digits. It\'s separate from your password. Your recovery key can reset it if you forget it.</p>' + pinField('pin', 'PIN') + pinField('pin2', 'PIN again'), 'Set up vault', async (f) => {
            if (f.pin.value !== f.pin2.value) throw new Error('The two PINs don\'t match.');
            await keep.vaultSetup(f.pin.value); closeModal(); toast('🔒 Vault ready. It\'s open now.'); await refresh(); go('vault');
          });
          break;
        case 'vaultChangePin':
          if (!state.snap.security.vault.unlocked) { toast('Unlock the vault first'); go('vault'); break; }
          secModal('Change vault PIN', pinField('cur', 'Current PIN') + '<div></div>' + pinField('pin', 'New PIN') + pinField('pin2', 'New PIN again'), 'Change PIN', async (f) => {
            if (f.pin.value !== f.pin2.value) throw new Error('The two new PINs don\'t match.');
            await keep.vaultChangePin(f.cur.value, f.pin.value); closeModal(); toast('PIN changed');
          });
          break;
        case 'vaultForgot':
          secModal('Forgotten your vault PIN?', '<p class="s3 muted" style="margin:0">Enter your recovery key and choose a new PIN.</p><label class="f s3">Recovery key<input name="rk" class="mono" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"></label>' + pinField('pin', 'New PIN') + pinField('pin2', 'New PIN again'), 'Reset PIN', async (f) => {
            if (f.pin.value !== f.pin2.value) throw new Error('The two PINs don\'t match.');
            await keep.vaultRecoverPin(f.rk.value, f.pin.value); closeModal(); toast('New PIN set. The vault is open.'); await refresh();
          });
          break;
        case 'vaultRemove':
          if (!state.snap.security.vault.unlocked) { toast('Unlock the vault first'); go('vault'); break; }
          if (confirm('Remove the vault? It must be empty. You can set it up again later.')) { await run(() => keep.vaultRemove(), 'Vault removed'); await refresh(); }
          break;
        case 'polNew': policyForm(null); break;
        case 'polEdit': policyForm((state.snap.data.policies || []).find(p => p.id === act.dataset.pid)); break;
        case 'polItems': policyItemsForm((state.snap.data.policies || []).find(p => p.id === act.dataset.pid)); break;
        case 'polDel': { const ok = await run(() => keep.deletePolicy(act.dataset.pid)); if (ok) { toast('Policy deleted'); await refresh(); } break; }
        case 'abFolder': { const f = await run(() => keep.chooseBackupFolder()); if (f) { $('#abFolder').value = f; } break; }
        case 'abSave':
          await run(() => keep.setAutoBackup({ enabled: $('#abOn').checked, folder: $('#abFolder').value, every: $('#abEvery').value, keep: $('#abKeep').value }), 'Backup settings saved');
          await refresh(); break;
        case 'abNow': {
          if ($('#abFolder').value !== (state.snap.data.settings.autoBackup.folder || '')) await run(() => keep.setAutoBackup({ folder: $('#abFolder').value }));
          act.disabled = true; act.textContent = 'Backing up…';
          try { await run(() => keep.backupNow(), '✓ Backup made'); } catch (_) {}
          await refresh(); break;
        }
        case 'theme': await keep.setTheme(act.dataset.theme); await refresh(); break;
        case 'claimSel': claimForm([...state.sel]); break;
        case 'labelsSel': labelsForm([...state.sel]); break;
        case 'bulkSel': bulkForm([...state.sel]); break;
        case 'labelOne': labelsForm([a.id]); break;
        case 'bcLookup': barcodeLookup(a); break;
        case 'phoneView': {
          const pass = $('#pvPass').value;
          if (pass.length < 6) { toast('Use a passphrase of at least 6 characters'); break; }
          act.disabled = true; act.textContent = 'Preparing…';
          try { const r = await run(() => keep.phoneView(pass, $('#pvVault') && $('#pvVault').checked)); if (r) toast(`✓ Saved ${r.count} items (${r.kb} KB). Send that file to your phone.`, 5000); } catch (_) {}
          act.disabled = false; act.textContent = 'Save inventory for phone…'; $('#pvPass').value = ''; break;
        }
        case 'claimOne': claimForm([a.id]); break;
        case 'selClear': state.sel.clear(); render(); break;
        case 'ocr': readReceipt(a, act.dataset.file); break;
        case 'importPick': { await run(() => keep.importPick()); await refresh(); break; }
        case 'phoneReset': await run(() => keep.phoneReset()); loadPhone(); break;
        case 'report': { const p = await run(() => keep.exportReport({ includePhotos: $('#rPhotos').checked, includeInactive: $('#rInactive').checked })); if (p) toast('Report saved'); break; }
        case 'csv': { const p = await run(() => keep.exportCsv()); if (p) toast('CSV saved'); break; }
        case 'saveRem': await run(() => keep.updateSettings({ reminderDays: $('#remDays').value }), 'Saved'); await refresh(); break;
        case 'saveLists': await run(() => keep.setLists($('#catsTa').value.split('\n'), $('#locsTa').value.split('\n')), 'Saved'); await refresh(); break;
        case 'backup': { const p = await run(() => keep.backup()); if (p) toast('Backup saved'); break; }
        case 'restore': { const p = await run(() => keep.restore()); if (p) { toast('Backup restored'); await refresh(); } break; }
        case 'openData': keep.openDataFolder(); break;
        case 'updCheck': state.upd = await keep.checkForUpdates(); renderUpdate(); break;
        case 'updInstall': if ($('#modal').classList.contains('hidden') || confirm('Close your open form and restart now?')) await keep.installUpdate(); break;
        case 'updLater': state.updHidden = true; renderUpdate(); toast('It will install when you close OpenSafe'); break;
      }
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) { go('item', { itemId: open.dataset.open, tab: open.dataset.opentab || 'overview' }); }
  });

  document.addEventListener('change', async (e) => {
    if (e.target.dataset.f) { state.f[e.target.dataset.f] = e.target.value; render(); }
    if (e.target.id === 'phoneOn') {
      $('#phoneBody').textContent = e.target.checked ? 'Starting…' : 'Stopping…';
      try { await keep.phoneEnable(e.target.checked); } catch (err) { toast('⚠ ' + err.message, 6000); }
      loadPhone();
    }
  });

  let qTimer;
  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') {
      state.f.q = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { const pos = e.target.selectionStart; render(); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); }, 150);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#lightbox').classList.add('hidden'); if (!state.rk) closeModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && $('#modal').classList.contains('hidden')) { e.preventDefault(); itemForm(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); if (state.view !== 'items') go('items'); setTimeout(() => $('#q') && $('#q').focus(), 0); }
  });

  keep.onChanged(async () => {
    if (!state.snap || state.snap.locked) return;
    const before = state.snap.data.assets.length;
    // don't re-render under an open form
    const modalOpen = !$('#modal').classList.contains('hidden');
    state.snap = await keep.getData();
    if (state.snap.locked) { showLock(); return; }
    const rem = state.snap.reminders.filter(r => r.daysLeft <= 7).length;
    $('#remBadge').textContent = rem; $('#remBadge').classList.toggle('hidden', !rem);
    if (!modalOpen) render();
    const after = state.snap.data.assets.length;
    if (after > before) toast(`📱 New item from your phone: ${state.snap.data.assets[after - 1].name}`, 4000);
  });
  keep.onNav((w) => go(w));
  keep.onSecurity(() => refresh());
  keep.onUpdate((u) => { const was = state.upd && state.upd.state; state.upd = u; renderUpdate(); if (state.view === 'settings' && was !== u.state) render(); });
  keep.updateStatus().then((u) => { state.upd = u; renderUpdate(); });

  refresh();
})();
