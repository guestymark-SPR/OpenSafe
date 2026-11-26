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
    const rem = state.snap.reminders.filter(r => r.daysLeft <= 7).length;
    const b = $('#remBadge'); b.textContent = rem; b.classList.toggle('hidden', !rem);
    render();
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
  function warrantyPill(a) {
    if (!a.warrantyExpiry) return '';
    const n = Math.round((Date.parse(a.warrantyExpiry + 'T00:00:00Z') - Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 864e5);
    if (n < 0) return '<span class="pill">Warranty ended</span>';
    if (n <= state.snap.data.settings.reminderDays) return `<span class="pill warn">Warranty ${dueText(n)}</span>`;
    return '<span class="pill good">Under warranty</span>';
  }
  function thumb(a, cls = 'thumb') {
    return a.photos.length ? `<img class="${cls}" src="${img(a, a.photos[0])}" alt="" loading="lazy">` : `<div class="${cls} ph">▣</div>`;
  }

  // ---------- render ----------
  function render() {
    if (!state.snap) return;
    $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === (state.view === 'item' ? 'items' : state.view)));
    const v = $('#view');
    const views = { dashboard: viewDashboard, items: viewItems, item: viewItem, reminders: viewReminders, phone: viewPhone, reports: viewReports, settings: viewSettings };
    v.innerHTML = (views[state.view] || viewDashboard)();
    if (state.view === 'phone') loadPhone();
    if (state.view === 'item') wireDrop();
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
          ${rem.length ? `<div class="rows">${rem.map(r => `<div class="rowi" data-open="${r.assetId}">
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
      if (f.gap === 'insurer' && (a.insurer || !value(a))) return false;
      if (f.gap === 'photo' && a.photos.length) return false;
      if (q) {
        const hay = [a.name, a.brand, a.model, a.serial, a.category, a.location, a.notes, a.supplier, a.tags.join(' ')].join(' ').toLowerCase();
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
      <input type="search" id="q" placeholder="Search name, brand, serial, notes…" value="${esc(f.q)}">
      <select data-f="category">${opt('', 'All categories', f.category)}${d.categories.map(c => opt(c, c, f.category)).join('')}</select>
      <select data-f="location">${opt('', 'All locations', f.location)}${d.locations.map(c => opt(c, c, f.location)).join('')}</select>
      <select data-f="status">${opt('active', 'Active items', f.status)}${opt('all', 'All statuses', f.status)}${state.snap.lists.statuses.map(s => opt(s, s, f.status)).join('')}</select>
      <select data-f="sort">${opt('added', 'Newest first', f.sort)}${opt('name', 'Name A–Z', f.sort)}${opt('value', 'Highest value', f.sort)}${opt('bought', 'Recently bought', f.sort)}${opt('category', 'Category', f.sort)}</select>
      <span class="spacer"></span>
      <span class="seg"><button data-layout="table" class="${f.layout === 'table' ? 'on' : ''}">List</button><button data-layout="grid" class="${f.layout === 'grid' ? 'on' : ''}">Photos</button></span>
    </div>
    ${f.gap ? `<div style="margin:-4px 0 12px"><span class="pill warn">Showing items with ${gapNames[f.gap]}</span> <button class="btn small" data-action="clearGap">Clear</button></div>` : ''}`;
    const head = `<div class="head"><h1>Items</h1><span class="sub">${list.length} shown · ${money0(total)}</span><span class="spacer"></span><button class="btn primary" data-action="new">+ Add item</button></div>`;
    if (!list.length) return head + toolbar + `<div class="card empty">${d.assets.length ? 'No items match these filters.' : 'No items yet. Add one here or from your phone.'}</div>`;
    if (f.layout === 'grid') {
      return head + toolbar + `<div class="cards">${list.map(a => `<div class="icard" data-open="${a.id}">
        <div class="img">${a.photos.length ? `<img src="${img(a, a.photos[0])}" alt="" loading="lazy">` : '▣'}</div>
        <div class="body"><div class="name">${esc(a.name)}</div><div class="meta">${esc(a.category || '')}</div><div class="val">${value(a) ? money(value(a)) : '<span class="faint">No value</span>'}</div></div></div>`).join('')}</div>`;
    }
    return head + toolbar + `<table class="list"><thead><tr><th style="width:60px"></th><th>Item</th><th>Category</th><th>Location</th><th>Serial no.</th><th>Bought</th><th class="r">Value now</th><th></th></tr></thead><tbody>
      ${list.map(a => `<tr data-open="${a.id}"><td>${thumb(a)}</td>
        <td><div class="name">${esc(a.name)}</div><div class="meta">${esc([a.brand, a.model].filter(Boolean).join(' '))}</div></td>
        <td>${esc(a.category)}</td><td>${esc(a.location)}</td><td class="mono">${esc(a.serial) || '<span class="faint">—</span>'}</td>
        <td class="nowrap">${ukDate(a.purchaseDate)}</td><td class="r nowrap">${value(a) ? money(value(a)) : '—'}</td>
        <td>${a.status !== 'Owned' ? `<span class="pill">${esc(a.status)}</span>` : ''}${a.source === 'phone' ? '<span class="pill acc">phone</span>' : ''}${warrantyPill(a).includes('warn') ? warrantyPill(a) : ''}</td></tr>`).join('')}
    </tbody></table>`;
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
        ${kv('Insurer', esc(a.insurer))}${kv('Policy number', esc(a.policyNumber))}${kv('Insured value', a.insuredValue !== null ? money(a.insuredValue) : '')}
        ${kv('Tags', a.tags.map(x => `<span class="pill">${esc(x)}</span>`).join(''))}${kv('Added', ukDate(a.createdAt.slice(0, 10)) + (a.source === 'phone' ? ' from phone' : ''))}${kv('Last changed', ukDate(a.updatedAt.slice(0, 10)))}
      </div>${a.notes ? `<div class="notes">${esc(a.notes)}</div>` : ''}</div>`;
    } else if (t === 'photos') {
      body = `<div class="drop" id="drop">Drag photos here, or <button class="btn small" data-action="pick" data-kind="photo">Choose photos…</button></div>
      ${a.photos.length ? `<div class="gallery">${a.photos.map((p, i) => `<div class="ph-tile">
        <img src="${img(a, p)}" alt="${esc(p.name)}" data-zoom="${img(a, p)}">
        ${i === 0 ? '<span class="pill acc coverflag">Cover</span>' : ''}
        <div class="acts">${i ? `<button data-action="cover" data-att="${p.id}">Make cover</button>` : ''}<button data-action="rmAtt" data-att="${p.id}">Delete</button></div></div>`).join('')}</div>`
        : '<div class="empty">No photos yet. Photos of the item, its serial plate and its box all help with insurance claims.</div>'}`;
    } else if (t === 'docs') {
      body = `<div class="drop" id="drop">Drag receipts, manuals or warranty cards here as
        <select id="docType" style="width:auto;min-width:120px;margin:0 6px">${state.snap.lists.docTypes.map(x => opt(x, x, 'Receipt')).join('')}</select>
        or <button class="btn small" data-action="pick" data-kind="document">Choose files…</button></div>
      ${a.documents.length ? `<table class="list"><thead><tr><th>Name</th><th>Type</th><th>Added</th><th></th></tr></thead><tbody>
        ${a.documents.map(d => `<tr><td data-action="openDoc" data-file="${esc(d.file)}"><b>${esc(d.name)}</b></td><td><span class="pill ${d.type === 'Receipt' ? 'good' : ''}">${esc(d.type)}</span></td>
        <td>${ukDate(d.addedAt.slice(0, 10))}</td><td class="r"><button class="btn small" data-action="openDoc" data-file="${esc(d.file)}">Open</button> <button class="btn small danger" data-action="rmAtt" data-att="${d.id}">Delete</button></td></tr>`).join('')}
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
      <button class="btn" data-action="dup">Duplicate</button><button class="btn danger" data-action="del">Delete</button><button class="btn primary" data-action="edit">Edit</button></div>
    <div class="detail-head">
      ${a.photos.length ? `<img class="cover" src="${img(a, a.photos[0])}" data-zoom="${img(a, a.photos[0])}" alt="">` : '<div class="cover" data-tab="photos">▣</div>'}
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
      <div class="rowi" data-open="${x.assetId}" data-opentab="${x.kind === 'Warranty' ? 'overview' : 'service'}"><span class="pill ${cls}">${esc(x.kind)}</span><span style="flex:1"><b>${esc(x.assetName)}</b></span>
      <span class="meta">${ukDate(x.date)}</span><span class="nowrap" style="width:130px;text-align:right">${dueText(x.daysLeft)}</span></div>`).join('')}</div>` : '<div class="muted">None.</div>'}</div>`;
    return `<div class="head"><h1>Reminders</h1><span class="sub">Warranty end dates and "next due" dates from service logs, looking ${state.snap.data.settings.reminderDays} days ahead</span></div>
      ${block('Overdue', over, 'bad')}${block('Coming up', soon, 'warn')}`;
  }

  function viewPhone() {
    return `<div class="head"><h1>Add items from your phone</h1></div>
    <div class="grid g2">
      <div class="card"><h2>Phone link</h2>
        <label class="switch"><input type="checkbox" id="phoneOn"> Allow my phone to add items over Wi-Fi</label>
        <div id="phoneBody" style="margin-top:16px" class="muted">Loading…</div>
      </div>
      <div class="card"><h2>How it works</h2>
        <ol class="steps">
          <li>Switch the phone link on. The first time, Windows may ask whether OpenSafe can use the network: tick <b>Private networks</b> and choose <b>Allow</b>.</li>
          <li>Make sure your phone is on the <b>same Wi-Fi</b> as this PC.</li>
          <li>Point your phone's camera at the QR code and open the link. The phone is now paired.</li>
          <li>In Chrome on the phone, use the ⋮ menu and choose <b>Add to Home screen</b> to get an OpenSafe icon.</li>
          <li>Take photos, fill in the details and tap <b>Save to PC</b>. The item appears here straight away.</li>
        </ol>
        <p class="note">This PC must be on, with OpenSafe open, while you add items. If your router gives the PC a new address, scan the QR code again. Only phones that have scanned the code can add items. Use <b>New pairing code</b> to unpair every phone.</p>
      </div>
    </div>`;
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
      ${state.snap.platform === 'win32' ? `<div class="card" style="margin-top:16px;box-shadow:none;background:#fbfaf7">
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
      <div class="card"><h2>Spreadsheet (CSV)</h2>
        <p class="muted">Every item and all its fields, for Excel or Google Sheets.</p>
        <button class="btn primary" data-action="csv">Export CSV…</button></div>
    </div>`;
  }

  function viewSettings() {
    const d = state.snap.data;
    return `<div class="head"><h1>Settings</h1></div>
    <div class="grid g2">
      <div class="card"><h2>Reminders</h2>
        <label class="f" style="max-width:260px">Remind me this many days ahead<input type="number" id="remDays" min="1" max="365" value="${d.settings.reminderDays}"></label>
        <p class="muted">OpenSafe also shows a Windows notification when you open it if anything is due within 7 days.</p>
        <button class="btn" data-action="saveRem">Save</button></div>
      <div class="card"><h2>Backup</h2>
        <p class="muted">OpenSafe keeps a copy of your list each day for 30 days in its data folder. For a full backup with photos and documents, save one to a USB stick or OneDrive folder.</p>
        <p><button class="btn primary" data-action="backup">Back up to a folder…</button> <button class="btn" data-action="restore">Restore from backup…</button></p>
        <p class="muted" style="margin-bottom:6px">Data folder: <span class="mono">${esc(state.snap.dataDir)}</span></p>
        <button class="btn small" data-action="openData">Open data folder</button></div>
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
  function openModal(html) { const m = $('#modal'); m.innerHTML = html; m.classList.remove('hidden'); const first = $('input,select,textarea', m); first && first.focus(); }
  function closeModal() { const m = $('#modal'); m.classList.add('hidden'); m.innerHTML = ''; }

  function itemForm(a) {
    const d = state.snap.data, L = state.snap.lists;
    a = a || { status: 'Owned', tags: [] };
    const inp = (name, label, extra = '', cls = '') => `<label class="f ${cls}">${label}<input name="${name}" value="${esc(a[name] ?? '')}" ${extra}></label>`;
    openModal(`<form class="dialog" id="itemForm" novalidate>
      <div class="dh"><h2>${a.id ? 'Edit item' : 'Add item'}</h2></div>
      <div class="db">
        ${inp('name', 'Name *', 'required maxlength="200" placeholder="e.g. Makita cordless drill"', 's2')}
        <label class="f">Status<select name="status">${L.statuses.map(s => opt(s, s, a.status)).join('')}</select></label>
        <label class="f">Category<input name="category" list="dlCats" value="${esc(a.category || '')}"></label>
        <label class="f">Location<input name="location" list="dlLocs" value="${esc(a.location || '')}"></label>
        <label class="f">Condition<select name="condition">${opt('', '—', a.condition || '')}${L.conditions.map(s => opt(s, s, a.condition)).join('')}</select></label>
        ${inp('brand', 'Brand')}${inp('model', 'Model')}${inp('serial', 'Serial number')}
        <h3>Purchase and value</h3>
        ${inp('purchaseDate', 'Bought on', 'type="date"')}${inp('purchasePrice', 'Price paid (£)', 'inputmode="decimal"')}${inp('supplier', 'Bought from')}
        ${inp('currentValue', 'Value now (£)', 'inputmode="decimal"')}${inp('warrantyExpiry', 'Warranty until', 'type="date"')}<div></div>
        <h3>Insurance</h3>
        ${inp('insurer', 'Insurer')}${inp('policyNumber', 'Policy number')}${inp('insuredValue', 'Insured value (£)', 'inputmode="decimal"')}
        <h3>Other</h3>
        <label class="f s3">Tags (comma separated)<input name="tags" value="${esc((a.tags || []).join(', '))}"></label>
        <label class="f s3">Notes<textarea name="notes" rows="4">${esc(a.notes || '')}</textarea></label>
        <div class="err" id="formErr"></div>
      </div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary">${a.id ? 'Save changes' : 'Add item'}</button></div>
      <datalist id="dlCats">${d.categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="dlLocs">${d.locations.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    </form>`);
    $('#itemForm').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (!data.name.trim()) { $('#formErr').textContent = 'Give the item a name.'; return; }
      for (const k of ['purchasePrice', 'currentValue', 'insuredValue']) {
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
  document.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('click', async (e) => {
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) { const lb = $('#lightbox'); lb.innerHTML = `<img src="${esc(zoom.dataset.zoom)}" alt="">`; lb.classList.remove('hidden'); return; }
    if (e.target.closest('#lightbox')) { $('#lightbox').classList.add('hidden'); return; }
    if (e.target.id === 'modal') { closeModal(); return; }

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
        case 'openDoc': await run(() => keep.openAttachment(a.id, act.dataset.file)); break;
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
    if (e.key === 'Escape') { $('#lightbox').classList.add('hidden'); closeModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && $('#modal').classList.contains('hidden')) { e.preventDefault(); itemForm(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); if (state.view !== 'items') go('items'); setTimeout(() => $('#q') && $('#q').focus(), 0); }
  });

  keep.onChanged(async () => {
    const before = state.snap ? state.snap.data.assets.length : 0;
    // don't re-render under an open form
    const modalOpen = !$('#modal').classList.contains('hidden');
    state.snap = await keep.getData();
    const rem = state.snap.reminders.filter(r => r.daysLeft <= 7).length;
    $('#remBadge').textContent = rem; $('#remBadge').classList.toggle('hidden', !rem);
    if (!modalOpen) render();
    const after = state.snap.data.assets.length;
    if (after > before) toast(`📱 New item from your phone: ${state.snap.data.assets[after - 1].name}`, 4000);
  });
  keep.onNav((w) => go(w));
  keep.onUpdate((u) => { const was = state.upd && state.upd.state; state.upd = u; renderUpdate(); if (state.view === 'settings' && was !== u.state) render(); });
  keep.updateStatus().then((u) => { state.upd = u; renderUpdate(); });

  refresh();
})();
