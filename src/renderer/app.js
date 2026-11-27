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
  const INACTIVE = ['Sold', 'Disposed', 'Lost / Stolen', 'Given back'];
  // Value now: the value entered, else an estimate from the category's yearly drop, else the price paid.
  function estimate(a) {
    const r = ((state.snap && state.snap.data.settings.depreciation) || {})[a.category];
    if (!r || a.purchasePrice === null || a.purchasePrice === undefined || !a.purchaseDate) return null;
    const years = (Date.now() - new Date(a.purchaseDate + 'T00:00:00Z')) / (365.25 * 86400000);
    if (!(years > 0)) return a.purchasePrice;
    return Math.round(a.purchasePrice * Math.pow(1 - r / 100, years) * 100) / 100;
  }
  // Currencies the exchange-rate service (Frankfurter, European Central Bank reference rates) provides.
  const FX_CURRENCIES = [['EUR', 'Euro'], ['USD', 'US dollar'], ['AUD', 'Australian dollar'], ['BRL', 'Brazilian real'], ['CAD', 'Canadian dollar'], ['CHF', 'Swiss franc'], ['CNY', 'Chinese yuan'], ['CZK', 'Czech koruna'], ['DKK', 'Danish krone'], ['HKD', 'Hong Kong dollar'], ['HUF', 'Hungarian forint'], ['IDR', 'Indonesian rupiah'], ['ILS', 'Israeli shekel'], ['INR', 'Indian rupee'], ['ISK', 'Icelandic króna'], ['JPY', 'Japanese yen'], ['KRW', 'South Korean won'], ['MXN', 'Mexican peso'], ['MYR', 'Malaysian ringgit'], ['NOK', 'Norwegian krone'], ['NZD', 'New Zealand dollar'], ['PHP', 'Philippine peso'], ['PLN', 'Polish złoty'], ['RON', 'Romanian leu'], ['SEK', 'Swedish krona'], ['SGD', 'Singapore dollar'], ['THB', 'Thai baht'], ['TRY', 'Turkish lira'], ['ZAR', 'South African rand']];
  const fxMoney = (cur, n) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(n); } catch (_) { return `${n} ${cur}`; } };
  const fxText = (a) => `${fxMoney(a.foreignCurrency, a.foreignPrice)} at £${Number(a.fxRate).toLocaleString('en-GB', { maximumFractionDigits: 6 })} per ${a.foreignCurrency}${a.fxDate ? ', rate of ' + ukDate(a.fxDate) : ''}`;
  const value = (a) => { if (a.currentValue !== null && a.currentValue !== undefined) return a.currentValue; const e = estimate(a); return e !== null ? e : (a.purchasePrice ?? 0); };
  // Locations can have levels: "Home / Garage / Shelf 2". A place includes everything inside it.
  const inLoc = (loc, place) => !!loc && (loc === place || loc.startsWith(place + ' / '));
  function locPaths() {
    const set = new Set();
    for (const l of [...state.snap.data.locations, ...state.snap.data.assets.map(a => a.location)]) {
      const parts = (l || '').split(' / ').filter(Boolean);
      parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join(' / ')));
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'en-GB'));
  }
  const locLabel = (p) => { const parts = p.split(' / '); return '\u00a0\u00a0\u00a0'.repeat(parts.length - 1) + (parts.length > 1 ? '└ ' : '') + parts[parts.length - 1]; };

  const state = {
    snap: null,
    sel: new Set(),
    upd: null,
    updHidden: false,
    view: 'dashboard',
    itemId: null,
    tab: 'overview',
    f: { q: '', category: '', location: '', owner: '', status: 'active', sort: 'added', layout: 'table', gap: '' }
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
    $('#vaultState').textContent = sec.vault.exists ? (sec.vault.unlocked ? 'open' : 'locked') : '';
    render();
  }

  // ---------- lock screen ----------
  function showLock(mode = 'unlock') {
    if (vstate.id) libViewClose();
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
          <button class="btn small primary" data-action="polRenew" data-pid="${p.id}">Renewed…</button><button class="btn small" data-action="polItems" data-pid="${p.id}">Items covered…</button><button class="btn small" data-action="polEdit" data-pid="${p.id}">Edit</button><button class="btn small danger" data-action="polDel" data-pid="${p.id}">Delete</button></div>
        <div class="kv">${row('Policy number', p.policyNumber ? `<span class="mono">${esc(p.policyNumber)}</span>` : '')}${row('Renews', p.renewalDate ? ukDate(p.renewalDate) + dueSoon(p.renewalDate) : '')}${row('Premium', p.premium !== null ? money(p.premium) : '')}
          ${row('Excess', p.excess !== null ? money(p.excess) : '')}${row('Cover limit', p.coverLimit !== null ? money(p.coverLimit) : '')}${row('Claims line', p.claimsPhone ? esc(p.claimsPhone) : '')}</div>
        ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
        ${premiumHistory(p)}
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line2)"><b>${covered.length} item${covered.length === 1 ? '' : 's'} covered</b> <span class="muted">worth ${money0(total)}</span>
          ${over ? ` <span class="pill bad">Over the cover limit by ${money0(total - p.coverLimit)}</span>` : ''}
          ${covered.length ? `<div class="meta" style="margin-top:4px">${covered.slice(0, 12).map(a => esc(a.name)).join(' · ')}${covered.length > 12 ? ' …' : ''}</div>` : ''}</div></div>`;
    };
    return `<div class="head"><h1>Insurance</h1><span class="sub">${pols.length} polic${pols.length === 1 ? 'y' : 'ies'}</span><span class="spacer"></span><button class="btn primary" data-action="polNew">+ Add policy</button></div>
      ${pols.length ? pols.slice().sort((x, y) => (x.renewalDate || '9').localeCompare(y.renewalDate || '9')).map(card).join('')
        : '<div class="card empty">No policies yet. Add your home contents, car, bike or boat insurance here. OpenSafe will remind you before each one renews, and you can link the items each policy covers.</div>'}
      ${unlinked.length ? `<div class="card"><h2>Not covered by a policy</h2><div class="meta">${unlinked.slice(0, 30).map(a => `<a href="#" data-open="${a.id}">${esc(a.name)}</a>`).join(' · ')}${unlinked.length > 30 ? ' …' : ''}</div></div>` : ''}`;
  }

  function premiumHistory(p) {
    const h = (p.history || []).slice().sort((x, y) => (y.endedOn || '').localeCompare(x.endedOn || ''));
    const rows = [{ current: true, endedOn: p.renewalDate, insurer: p.insurer, premium: p.premium, excess: p.excess }, ...h];
    if (!h.length) return `<div class="faint" style="margin-top:10px">Premium history: none yet. When the policy renews, use <b>Renewed…</b> to keep last year's price. <a href="#" data-action="polAddYear" data-pid="${p.id}">Add an earlier year</a></div>`;
    const pct = (a, b) => (a !== null && b) ? Math.round((a - b) / b * 100) : null;
    return `<div style="margin-top:12px"><h3 style="margin:0 0 4px;font-size:13px">Premium history <a href="#" class="meta" style="font-weight:400" data-action="polAddYear" data-pid="${p.id}">add an earlier year</a></h3>
      <table class="list"><thead><tr><th>Term ending</th><th>Insurer</th><th class="r">Premium</th><th class="r">Change</th><th class="r">Excess</th><th>Note</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => { const prev = rows[i + 1]; const c = prev ? pct(r.premium, prev.premium) : null; return `<tr${r.current ? ' style="font-weight:600"' : ''}><td class="nowrap">${r.endedOn ? ukDate(r.endedOn) : '—'}${r.current ? ' <span class="pill">now</span>' : ''}</td><td>${esc(r.insurer)}</td><td class="r">${r.premium !== null && r.premium !== undefined ? money(r.premium) : '—'}</td>
        <td class="r ${c > 0 ? 'neg' : ''}">${c === null ? '' : (c > 0 ? '+' : '') + c + '%'}</td><td class="r">${r.excess !== null && r.excess !== undefined ? money(r.excess) : ''}</td><td class="meta">${esc(r.note || '')}</td><td class="r">${r.current ? '' : `<button class="btn small danger" data-action="polHistRm" data-pid="${p.id}" data-hid="${r.id}">Delete</button>`}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function renewForm(p, earlier) {
    const next = p.renewalDate ? (() => { const d = new Date(p.renewalDate + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); })() : '';
    openModal(`<form class="dialog narrow" id="renewForm"><div class="dh"><h2>${earlier ? 'Add an earlier year' : 'Policy renewed'}</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">${earlier ? 'From old paperwork: what an earlier term cost.' : `This year's details (${esc(p.insurer)}${p.premium !== null ? ', ' + money(p.premium) : ''}) go into the premium history, and the policy gets the new ones.`}</p>
        ${earlier ? `<label class="f">Term ended on<input name="endedOn" type="date"></label>` : `<label class="f">Next renewal date<input name="renewalDate" type="date" value="${next}"></label>`}
        <label class="f">${earlier ? 'Premium' : 'New premium'} (£)<input name="premium" inputmode="decimal"></label>
        <label class="f">Insurer<input name="insurer" value="${earlier ? '' : esc(p.insurer)}" placeholder="${esc(p.insurer)}"></label>
        ${earlier ? '' : `<label class="f">Policy number<input name="policyNumber" value="${esc(p.policyNumber || '')}"></label>`}
        <label class="f">Excess (£)<input name="excess" inputmode="decimal" value="${earlier ? '' : esc(p.excess ?? '')}"></label>
        <label class="f s3">Note<input name="note" maxlength="300" placeholder="${earlier ? 'e.g. first year with them' : 'e.g. Quote was £412, haggled down'}"></label>
        <div class="err" id="renewErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    $('#renewForm').onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      busy(e.target, true, 'Saving…');
      try { await (earlier ? keep.addPolicyHistory(p.id, v) : keep.renewPolicy(p.id, v)); closeModal(); toast('✓ Saved'); await refresh(); }
      catch (ex) { $('#renewErr').textContent = ex.message; busy(e.target, false); }
    };
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
      <div class="db"><p class="s3 muted" style="margin:0">One PDF for your insurer with ${names.length === 1 ? `<b>${esc(names[0])}</b>` : `<b>${names.length} items</b>`}: every photo, serial numbers, purchase details, receipt photos, and receipt PDFs added at the end. Parts of any set are included too. All boxes below are optional.</p>
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

  /** Bundle PDF: the chosen letters in date order with a contents page and page numbers. */
  function bundleForm(ids, title = '') {
    const entries = ids.map(libEntry).filter(Boolean);
    if (!entries.length) return toast('Tick the documents to put in the bundle first.');
    const files = entries.reduce((n, e) => n + e.files.length, 0);
    const undated = entries.filter(e => !e.docDate).length;
    const dates = entries.map(e => e.docDate).filter(Boolean).sort();
    openModal(`<form class="dialog narrow" id="bundleForm"><div class="dh"><h2>Bundle PDF</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">One PDF of <b>${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</b> (${files} file${files === 1 ? '' : 's'})${dates.length ? `, dated ${ukDate(dates[0])}${dates.length > 1 && dates[0] !== dates[dates.length - 1] ? ` to ${ukDate(dates[dates.length - 1])}` : ''}` : ''}, for sending to an MP, a solicitor, a tribunal or an appeal. PDFs and photos go in as they are; emails, Word and Excel files are turned into pages.</p>
        <label class="f s3">Title<input name="title" maxlength="120" value="${esc(title || 'Bundle of documents')}" required></label>
        <label class="f s3">Order<select name="order"><option value="oldest">By the date on each one, oldest first</option><option value="newest">By the date on each one, newest first</option></select></label>
        <label class="switch s3" style="font-weight:500;display:flex;gap:10px"><input type="checkbox" name="contents" checked> Contents page at the front (date, who from, title, reference, page numbers)</label>
        <label class="switch s3" style="font-weight:500;display:flex;gap:10px"><input type="checkbox" name="numbers" checked> Page numbers on every page (“Page 3 of 40”)</label>
        <details class="s3 hidebox" ${lsGet('redactOn', false) ? 'open' : ''}><summary><b>Hide private details</b> <span class="faint">(optional)</span></summary>
          <p class="faint small" style="margin:6px 0">Blacks out what you choose on every page of this PDF. Your own copies aren't changed. Pages become pictures, so the PDF is bigger and its text can't be copied.</p>
          <div class="hidekinds">${[['ni', 'National Insurance numbers'], ['bank', 'Bank sort codes and account numbers'], ['card', 'Card numbers'], ['phone', 'Phone numbers'], ['email', 'Email addresses']].map(([k, l]) => `<label class="switch"><input type="checkbox" name="hide_${k}" ${(lsGet('redactKinds', ['ni', 'bank', 'card'])).includes(k) && lsGet('redactOn', false) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
          <label class="f" style="margin-top:6px">Also hide these words (one per line: names, an address line…)<textarea name="hideWords" rows="3" maxlength="3000" placeholder="e.g. your children's names"></textarea><span class="faint small">Not saved anywhere: type them each time.</span></label>
          <p class="faint small" style="margin:4px 0 0">Scanned pages are read on this PC to find the words, which takes a few seconds a page. Always check the PDF before sending it.</p></details>
        ${undated ? `<p class="s3 note" style="margin:0">${undated === 1 ? '1 entry has' : undated + ' entries have'} no date, so ${undated === 1 ? 'it goes' : 'they go'} at the end. Add the date on the letter with <b>Edit details</b> to put ${undated === 1 ? 'it' : 'them'} in order.</p>` : ''}
        <div class="err" id="bundleErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save bundle PDF…</button></div></form>`);
    $('#bundleForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target, el = f.elements, opts = { title: el.title.value, order: el.order.value, contents: el.contents.checked, numbers: el.numbers.checked };
      const kinds = ['ni', 'bank', 'card', 'phone', 'email'].filter(k => el['hide_' + k].checked);
      const words = el.hideWords.value.split(/\n+/).map(w => w.trim()).filter(Boolean);
      const on = f.querySelector('.hidebox').open && (kinds.length || words.length);
      lsSet('redactOn', !!on); if (on) lsSet('redactKinds', kinds);
      if (on) opts.redact = { kinds, words };
      busy(f, true, opts.redact ? 'Building PDF and hiding details…' : 'Building PDF…');
      try { const r = await keep.libBundle(entries.map(e => e.id), opts); if (r) { closeModal(); toast(`✓ Bundle saved: ${r.documents} ${r.documents === 1 ? 'entry' : 'entries'}, ${r.pages} pages`, 4500); } else busy(f, false); }
      catch (ex) { $('#bundleErr').textContent = ex.message; busy(f, false); }
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
        <label class="f">Owner<input name="owner" list="bkPeople" maxlength="200" placeholder="Keep as it is (type - to clear)"></label>
        <datalist id="bkPeople">${(d.people || []).map(p => `<option value="${esc(p)}">`).join('')}</datalist>
        <label class="f">Grab list<select name="grab">${opt('', 'Keep as it is', '')}${opt('add', 'Add to the grab list', '')}${opt('remove', 'Take off the grab list', '')}</select></label>
        <label class="f">Insurance policy<select name="policyId">${opt('__keep', 'Keep as it is', '__keep')}${opt('', 'Not linked to a policy', '__keep')}${pols.map(p => opt(p.id, `${p.insurer}${p.type ? ' · ' + p.type : ''}${p.policyNumber ? ' · ' + p.policyNumber : ''}`, '__keep')).join('')}</select></label>
        <div id="bkLend" class="s3 subgrid hidden"><h3>Lent out</h3>
          <label class="f">Lent to *<input name="lentTo" maxlength="200"></label><label class="f">Phone or email<input name="lentContact" maxlength="200"></label>
          <label class="f">Lent on<input name="lentDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label class="f">Due back (reminder)<input name="dueBack" type="date"></label></div>
        <div id="bkBorrow" class="s3 subgrid hidden"><h3>Borrowed</h3>
          <label class="f">Belongs to *<input name="borrowedFrom" maxlength="200"></label><label class="f">Their phone or email<input name="borrowedContact" maxlength="200"></label><label class="f">Give back by<input name="returnBy" type="date"></label></div>
        <div id="bkSold" class="s3 subgrid hidden"><h3>Sold</h3>
          <label class="f">Sold on<input name="soldDate" type="date"></label><label class="f">Sold to<input name="soldTo" maxlength="200"></label></div>
        <datalist id="bkLocs">${d.locations.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <datalist id="bkCats">${d.categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="err" id="bkErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Change ${ids.length} item${ids.length === 1 ? '' : 's'}</button></div></form>`);
    $('#bkStatus').onchange = (e) => { $('#bkLend').classList.toggle('hidden', e.target.value !== 'Lent out'); $('#bkSold').classList.toggle('hidden', e.target.value !== 'Sold'); $('#bkBorrow').classList.toggle('hidden', e.target.value !== 'Borrowed'); };
    $('#bulkForm').onsubmit = async (e) => {
      e.preventDefault();
      const raw = Object.fromEntries(new FormData(e.target).entries());
      if (raw.policyId === '__keep') delete raw.policyId;
      if (!raw.location.trim() && !raw.category.trim() && !raw.status && !raw.grab && !raw.owner.trim() && raw.policyId === undefined) { $('#bkErr').textContent = 'Choose at least one thing to change.'; return; }
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

  async function readLabel(a, file) {
    openModal(`<div class="dialog narrow"><div class="dh"><h2>Reading label…</h2></div><div class="db"><p class="s3 muted" style="margin:0">Reading the text on this PC (nothing is uploaded).</p></div></div>`);
    let r;
    try { r = await keep.readLabel(a.id, file); }
    catch (ex) { closeModal(); toast('⚠ ' + ex.message, 6000); return; }
    const serial = r.serial || r.imei;
    const row = (key, label, val, cur) => val ? `<label class="switch s3" style="font-weight:500;display:flex;gap:10px"><input type="checkbox" name="${key}" ${cur ? '' : 'checked'}> <span style="flex:1">${label}: <b class="mono">${esc(val)}</b>${cur ? ` <span class="muted">(currently ${esc(cur)})</span>` : ''}</span></label>` : '';
    openModal(`<form class="dialog narrow" id="lblForm"><div class="dh"><h2>Label details</h2></div>
      <div class="db">${serial || r.model ? '<p class="s3 muted" style="margin:0">Tick what to copy into this item, and check it against the label: reading isn\'t always perfect (0 and O, 1 and I are easily mixed up).</p>' : '<p class="s3" style="margin:0">Couldn\'t find a serial or model number. Try a sharper, straight-on photo of the label in good light, filling most of the picture.</p>'}
        ${row('serial', r.serial ? 'Serial number' : 'Serial number (IMEI)', serial, a.serial)}${row('model', 'Model', r.model, a.model)}
        <details class="s3"><summary class="muted" style="cursor:pointer">Text found on the label</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:200px;overflow:auto">${esc(r.text)}</pre></details></div>
      <div class="df"><button type="button" class="btn" data-action="close">Close</button>${serial || r.model ? '<button class="btn primary" type="submit">Copy to item</button>' : ''}</div></form>`);
    const f = $('#lblForm');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const patch = { id: a.id };
      if (f.serial && f.serial.checked) patch.serial = serial;
      if (f.model && f.model.checked) patch.model = r.model;
      if (Object.keys(patch).length === 1) { closeModal(); return; }
      await run(() => keep.saveAsset(patch), 'Label details copied'); closeModal(); await refresh();
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
    if (!sec.vault.exists) return `<div class="head"><h1>Vault</h1></div>
      <div class="card" style="max-width:640px"><h2>${icon('lock')}A second lock for sensitive things</h2>
        <p class="muted">The vault keeps chosen items and single files (ID scans, logbooks, valuables) behind a separate PIN, on top of OpenSafe's password. Vault items stay hidden from lists, reports and the phone until you open the vault.</p>
        ${sec.encrypted ? '<button class="btn primary" data-action="vaultSetup">Set up the vault…</button>' : '<p class="note">Turn on password protection first, in <a href="#" data-nav="settings">Settings</a>. The vault needs it.</p>'}</div>`;
    if (!sec.vault.unlocked) {
      return `<div class="head"><h1>Vault</h1></div>
      <div class="card pinbox"><h2>${icon('lock')}The vault is locked</h2>
        <p class="muted">Enter your vault PIN to see the items and files you keep in it.</p>
        <form id="vaultForm" style="display:grid;gap:12px"><input name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="PIN" aria-label="Vault PIN">
        <div class="err" id="vaultErr"></div>
        <button class="btn primary" type="submit">Unlock vault</button></form>
        <p style="margin-top:12px"><button class="linkbtn" data-action="vaultForgot">Forgotten your PIN?</button></p></div>`;
    }
    const items = state.snap.data.assets.filter(a => a.inVault);
    const files = [];
    for (const a of state.snap.data.assets) if (!a.inVault) for (const r of [...a.photos, ...a.documents]) if (r.vaultFile) files.push({ a, r });
    return `<div class="head"><h1>Vault</h1><span class="sub">open</span><span class="spacer"></span><button class="btn" data-action="vaultLock">${icon('lock')}Lock vault</button></div>
      <p class="muted" style="margin-top:-8px">Vault items and files have their own encryption key. They're hidden, and left out of totals and reports, whenever the vault is locked. It locks when you close or lock OpenSafe.</p>
      <div class="card" style="margin-bottom:16px"><h2>Items in the vault (${items.length})</h2>
        ${items.length ? `<div class="rows">${items.map(a => `<div class="rowi" data-open="${a.id}">${thumb(a)}<div style="flex:1"><div class="name">${esc(a.name)}</div><div class="meta">${esc([a.category, a.location].filter(Boolean).join(' · '))}</div></div><span class="meta">${value(a) ? money(value(a)) : ''}</span></div>`).join('')}</div>`
          : '<div class="muted">None yet. Open an item and choose <b>More → Move to the vault</b>.</div>'}</div>
      <div class="card"><h2>Single files in the vault (${files.length})</h2>
        ${files.length ? `<div class="rows">${files.map(({ a, r }) => `<div class="rowi" data-open="${a.id}" data-opentab="${a.photos.includes(r) ? 'photos' : 'docs'}"><span style="flex:1"><b>${esc(r.name)}</b> <span class="meta">in ${esc(a.name)}</span></span><span class="pill vault">🔒</span></div>`).join('')}</div>`
          : '<div class="muted">None yet. On an item\'s Photos or Documents tab, choose <b>To vault</b> on a file, such as an ID scan, a logbook or a receipt.</div>'}</div>`;
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

  function syncCard() {
    const y = state.snap.sync || {};
    const when = (t) => t ? new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    if (!y.enabled) {
      return `<div class="card tile" id="syncCard"><h2>${icon('copy')}Two PCs</h2>
        <p class="muted">Use OpenSafe on two PCs (say a laptop and a desktop) and keep them the same, through a folder both can see, such as OneDrive. Choose the same folder on each PC.</p>
        <p class="faint" style="margin-top:0">The whole inventory is handed over, not mixed: the PC with the newest changes wins. If both were changed, OpenSafe asks which to keep and saves the other as a backup. ${state.snap.security.encrypted ? 'With password protection on, the copy in the folder stays encrypted, and both PCs use the same password.' : '<b>Turn on password protection first</b>, so the copy in the folder is encrypted.'}</p>
        <div class="acts"><button class="btn primary" data-action="syncChoose">${icon('folder')}Choose shared folder…</button></div></div>`;
    }
    const r = y.remote;
    const line = y.conflict ? `<span style="color:var(--bad)">${icon('alert')}Both PCs were changed. Choose which copy to keep.</span>`
      : y.lastError ? `<span style="color:var(--bad)">${icon('alert')}${esc(y.lastError)}</span>`
      : y.dirty ? `${icon('upload')}Changes on this PC are being copied to the folder…`
      : r && r.inStep ? `${icon('check')}In step${r.mine ? '' : ` with <b>${esc(r.by || 'your other PC')}</b>`}` : 'Checking…';
    return `<div class="card tile" id="syncCard"><h2>${icon('copy')}Two PCs</h2>
      <p style="margin:0 0 6px">${line}</p>
      <p class="muted small" style="margin:0">Shared folder: <span class="mono">${esc(y.folder)}</span><br>This PC: <b>${esc(y.device || '')}</b>${y.lastSyncAt ? ` · last ${y.lastAction === 'pull' ? 'updated from the folder' : 'copied to the folder'} ${esc(when(y.lastSyncAt))}` : ''}${r && !r.mine ? `<br>Newest copy in the folder: from <b>${esc(r.by || '')}</b>, ${esc(when(r.at))}` : ''}</p>
      <p class="faint" style="margin:8px 0 0">OpenSafe checks every 90 seconds while it's open, and when it starts and closes. Settings are shared too, so pick an automatic-backup folder that exists on both PCs.</p>
      <div class="acts">${y.conflict ? `<button class="btn primary" data-action="syncResolve">Choose which copy…</button>` : `<button class="btn" data-action="syncNow">${icon('copy')}Check now</button>`}<button class="btn ghost" data-action="syncStop">Stop keeping in step</button></div></div>`;
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
      <div class="secrow"><span>Lock OpenSafe now</span><button class="btn small" data-action="lockApp">${icon('lock')}Lock</button></div>
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
    if (vstate.id) libViewClose();
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
  const vaultPill = (a) => a.inVault ? `<span class="pill vault">${icon('lock')}Vault</span>` : '';

  // ---------- Documents and Data ----------
  // Documents: scanned letters and papers. Data: saved emails, PDFs, Word files, photos and anything else.
  const LIB = {
    docs: { kind: 'document', title: 'Documents', one: 'document', many: 'documents', add: 'Add document…' },
    files: { kind: 'data', title: 'Data', one: 'entry', many: 'entries', add: 'Add files…' }
  };
  const libKindPage = (kind) => kind === 'data' ? 'files' : 'docs';
  const libEntries = (kind) => (state.snap.data.library || []).filter(e => e.kind === kind);
  const libEntry = (id) => (state.snap.data.library || []).find(e => e.id === id);
  const fileSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes';
  const fileKind = (name) => {
    const x = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    if (x === 'pdf') return ['PDF', 'file'];
    if (['eml', 'msg'].includes(x)) return ['Email', 'mail'];
    if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(x)) return ['Document', 'letter'];
    if (['xls', 'xlsx', 'ods', 'csv'].includes(x)) return ['Spreadsheet', 'sheet'];
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'bmp', 'tif', 'tiff'].includes(x)) return ['Photo', 'image'];
    if (['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', '3gp'].includes(x)) return ['Video', 'video'];
    if (['zip', '7z', 'rar'].includes(x)) return ['Archive', 'box'];
    return [x ? x.toUpperCase() : 'File', 'file'];
  };
  const previewable = (name) => /\.(pdf|jpe?g|png|webp|gif)$/i.test(name);
  state.libThumbs = state.libThumbs || {};
  function libThumb(e, cls = 'lthumb') {
    const f = e.files.find(x => previewable(x.name));
    if (!f) { const k = fileKind((e.files[0] || { name: '' }).name); return `<div class="${cls} ph">${icon(e.files.length ? k[1] : 'letter')}</div>`; }
    const t = state.libThumbs[f.id];
    if (t) return `<img class="${cls}" src="${t}" alt="">`;
    return `<div class="${cls} ph" data-libthumb="${esc(e.id)}" data-libfile="${esc(f.id)}">${icon(fileKind(f.name)[1])}</div>`;
  }
  // Load previews for whatever is on screen (a few at a time).
  async function loadLibThumbs() {
    const todo = $$('[data-libthumb]').slice(0, 40);
    for (const el of todo) {
      const id = el.dataset.libthumb, fid = el.dataset.libfile;
      if (state.libThumbs[fid] === undefined) {
        state.libThumbs[fid] = null;
        try { state.libThumbs[fid] = await keep.libPreview(id, fid); } catch (_) { state.libThumbs[fid] = null; }
      }
      const url = state.libThumbs[fid];
      for (const t of $$(`[data-libfile="${CSS.escape(fid)}"]`)) if (url) { const im = document.createElement('img'); im.className = t.className.replace(/\bph\b/, '').trim(); im.src = url; im.alt = ''; t.replaceWith(im); }
    }
  }
  function libFiltered(kind) {
    const f = state.lf || {};
    let list = libEntries(kind);
    if (f.q && state.libHits) list = list.filter(e => state.libHits.has(e.id));
    if (kind === 'document' && f.type) list = list.filter(e => e.docType === f.type);
    if (kind === 'data' && f.folder) list = list.filter(e => (f.folder === '(none)' ? !e.folder : e.folder === f.folder));
    if (f.vault === 'only') list = list.filter(e => e.inVault);
    if (f.from) list = list.filter(e => (e.from || '').toLowerCase() === f.from.toLowerCase());
    if (f.tag) list = list.filter(e => (e.tags || []).some(t => t.toLowerCase() === f.tag.toLowerCase()));
    if (f.caseName) list = list.filter(e => f.caseName === '(none)' ? !e.caseName : (e.caseName || '').toLowerCase() === f.caseName.toLowerCase());
    if (f.sent === 'sent') list = list.filter(e => e.sent); else if (f.sent === 'waiting') { const rs = state.snap.data.libReplies || {}; list = list.filter(e => e.sent && rs[e.id] && !rs[e.id].replied); }
    const by = f.sort || 'added';
    const key = (e) => by === 'title' ? e.title.toLowerCase() : by === 'date' ? (e.docDate || e.createdAt.slice(0, 10)) : e.createdAt;
    list.sort((a, b) => by === 'title' ? key(a).localeCompare(key(b), 'en-GB') : key(b).localeCompare(key(a)));
    return list;
  }
  function viewLibrary(page) {
    const L = LIB[page], kind = L.kind;
    const all = libEntries(kind);
    if (state.lfPage !== page) { state.lf = { sort: 'added' }; state.libHits = null; state.lfPage = page; }
    const f = state.lf;
    const binN = (state.snap.data.libBin || []).filter(b => b.kind === kind).length;
    const vaultLocked = state.snap.security.vault.exists && !state.snap.security.vault.unlocked;
    const head = `<div class="head"><h1>${L.title}</h1><span class="sub">${all.length} ${all.length === 1 ? L.one : L.many}</span><span class="spacer"></span>
      ${binN ? `<button class="btn" data-action="libBin" data-kind="${kind}">${icon('trash')}Deleted (${binN})</button>` : ''}
      <button class="btn primary" data-action="libAdd" data-kind="${kind}">${icon('plus')}${L.add}</button></div>`;
    const intro = kind === 'document'
      ? `<p class="lead">Keep an electronic copy of important letters and papers: bills, bank and pension letters, medical and legal letters, certificates. OpenSafe reads the words in them so you can search, and you can set a "reply by" date to get a reminder.</p>`
      : `<p class="lead">Keep files you want safe and in one place: saved emails (.eml or .msg), PDFs, Word and Excel files, photos and anything else. OpenSafe reads the words in most of them so you can search.</p>`;
    if (!all.length) return head + intro + `<div class="card empty droplib" id="libDrop" style="max-width:760px">
        <p style="margin-top:0"><b>Nothing here yet.</b> Drag files anywhere on this page, or use <b>${L.add}</b>.</p>
        ${kind === 'document' ? `<p class="muted" style="margin-bottom:0">${icon('phone')}To scan a paper letter, use OpenSafe Capture on your phone: tap <b>📄 Scan a document</b>, photograph each page, then <b>Export to PC</b> and import the file here (<b>Phone app → Import from phone…</b>). Each scan becomes one PDF, and its words are read on this PC.</p>` : `<p class="muted" style="margin-bottom:0">To keep an email, drag it from your email program onto this page, or save it as a file first (in Outlook: <b>File → Save As</b>, or drag the email to a folder) and add that file here. The text of .eml emails can be searched; .msg files are stored but not searched.</p>`}
        ${vaultLocked ? `<p class="note" style="margin-bottom:0">Some ${L.many} may be in the vault. <a href="#" data-nav="vault">Unlock the vault</a> to see them.</p>` : ''}</div>`;
    const types = state.snap.lists.libraryTypes || [];
    const folders = [...new Set(all.map(e => e.folder).filter(Boolean))].sort();
    const reading = all.reduce((n, e) => n + (e.textPending || 0), 0);
    return head + `<div class="libbar">
        <div class="sidesearch libsearch">${icon('search')}<input id="libQ" type="search" placeholder="Search titles, senders, references and the words inside" value="${esc(f.q || '')}" autocomplete="off"></div>
        <div class="chips">${kind === 'document'
          ? chip('Type', 'type', f.type || '', [['', 'All types'], ...types.filter(t => all.some(e => e.docType === t)).map(t => [t, t])], '', false, 'setLF')
          : chip('Folder', 'folder', f.folder || '', [['', 'All folders'], ...folders.map(x => [x, x]), ...(all.some(e => !e.folder) ? [['(none)', 'No folder']] : [])], '', false, 'setLF')}
        ${libExtraChips(all, f)}
        ${chip('Sort', 'sort', f.sort || 'added', [['added', 'Newest added'], ['date', kind === 'document' ? 'Date on the letter' : 'Date'], ['title', 'Title A–Z']], 'added', true, 'setLF')}</div>
        ${kind === 'document' && (state.snap.data.libCases || []).length ? `<div class="seg" role="tablist"><button class="${state.libMode !== 'cases' ? 'on' : ''}" data-action="libMode" data-v="list">${icon('file')}All</button><button class="${state.libMode === 'cases' ? 'on' : ''}" data-action="libMode" data-v="cases">${icon('folder')}Cases</button></div>` : ''}
      </div>
      ${reading ? `<p class="faint small" style="margin:-6px 0 10px">${icon('search')}Reading the words in ${reading} file${reading === 1 ? '' : 's'}… They can be searched once this finishes.</p>` : ''}
      ${vaultLocked ? `<p class="faint small" style="margin:-6px 0 10px">${icon('lock')}Anything in the vault is hidden. <a href="#" data-nav="vault">Unlock the vault</a> to see and search it.</p>` : ''}
      <div id="libList" class="droplib">${kind === 'document' && state.libMode === 'cases' && (state.snap.data.libCases || []).length ? casesHtml() : libListHtml(kind)}</div>`;
  }
  /** Filter chips that only appear when there's something to choose between. */
  function libExtraChips(all, f) {
    const uniq = (arr) => { const m = new Map(); arr.filter(Boolean).forEach(x => { const k = x.toLowerCase(); if (!m.has(k)) m.set(k, x); }); return [...m.values()].sort((a, b) => a.localeCompare(b, 'en-GB')); };
    const froms = uniq(all.map(e => e.from)), tags = uniq(all.flatMap(e => e.tags || [])), cases = uniq(all.map(e => e.caseName));
    let out = '';
    if (froms.length > 1 || f.from) out += chip('From / to', 'from', f.from || '', [['', 'Anyone'], ...froms.map(x => [x, x])], '', false, 'setLF');
    if (tags.length || f.tag) out += chip('Tag', 'tag', f.tag || '', [['', 'Any tag'], ...tags.map(x => [x, x])], '', false, 'setLF');
    if (cases.length || f.caseName) out += chip('Case', 'caseName', f.caseName || '', [['', 'Any case'], ...cases.map(x => [x, x]), ['(none)', 'Not in a case']], '', false, 'setLF');
    if (all.some(e => e.sent) || f.sent) out += chip('Sent', 'sent', f.sent || '', [['', 'Sent and received'], ['sent', 'Sent by me'], ['waiting', 'Waiting for a reply']], '', false, 'setLF');
    return out;
  }
  function replyPill(e) {
    if (!e.sent) return '';
    const st = (state.snap.data.libReplies || {})[e.id] || {};
    if (st.replied) return `<span class="pill good" title="${st.replyTitle ? esc('Reply: ' + st.replyTitle) : ''}">${icon('check')}Replied</span>`;
    if (e.expectBy) return `<span class="pill ${st.overdue ? 'bad' : 'warn'}">${icon('bell')}${st.overdue ? 'No reply since' : 'Reply due'} ${ukDate(e.expectBy)}</span>`;
    return '';
  }
  function casesHtml() {
    const cs = state.snap.data.libCases || [];
    return `<div class="casegrid">${cs.map(c => `<div class="card casecard" data-action="libCaseOpen" data-case="${esc(c.name)}" tabindex="0">
      <div class="ch"><b>${esc(c.name)}</b><span class="pill">${c.count} letter${c.count === 1 ? '' : 's'}</span></div>
      <div class="meta">${esc(c.froms.slice(0, 3).join(', '))}${c.froms.length > 3 ? '…' : ''}</div>
      ${c.refs.length ? `<div class="meta">Ref ${esc(c.refs.slice(0, 2).join(', '))}${c.refs.length > 2 ? '…' : ''}</div>` : ''}
      <div class="meta">${c.first ? ukDate(c.first) : ''}${c.last && c.last !== c.first ? ' – ' + ukDate(c.last) : ''}</div>
      ${c.overdue ? `<span class="pill bad">${icon('bell')}${c.overdue} waiting past the date</span>` : c.waiting ? `<span class="pill warn">${icon('bell')}${c.waiting} waiting for a reply</span>` : ''}</div>`).join('')}</div>`;
  }
  /** Write (or change) a letter: laid out on A4, saved as PDF and Word in Documents, marked as sent by you. */
  function letterForm(d, entryId) {
    const L = d.letter, me = !L.fromName;
    const cases = (state.snap.data.libCases || []).map(c => c.name);
    const tb = (name, label, v, extra = '') => `<label class="f">${label}<input name="${name}" value="${esc(v || '')}" ${extra}></label>`;
    openModal(`<form class="dialog wide" id="letterForm"><div class="dh"><h2>${entryId ? 'Change letter' : L.replyTo ? 'Write a reply' : 'Write a letter'}</h2></div><div class="db letterdb">
      <details class="s3 hidebox" ${me ? 'open' : ''}><summary><b>Your details</b> <span class="faint">${me ? '(filled in once, then remembered)' : esc(L.fromName)}</span></summary>
        <div class="grid g2" style="margin-top:8px">${tb('fromName', 'Your name', L.fromName, 'maxlength="120"')}${tb('fromPhone', 'Phone (optional)', L.fromPhone, 'maxlength="60"')}
          <label class="f">Your address<textarea name="fromAddress" rows="4" maxlength="600">${esc(L.fromAddress)}</textarea></label>${tb('fromEmail', 'Email (optional)', L.fromEmail, 'maxlength="120" type="email"')}</div></details>
      ${tb('toName', 'To', L.toName, 'maxlength="200" required list="ltTo" placeholder="e.g. Child Maintenance Service"')}<datalist id="ltTo">${Object.keys(d.addresses || {}).map(k => `<option value="${esc(k)}">`).join('')}</datalist>
      ${tb('date', 'Date', L.date, 'type="date"')}
      <label class="f">Their address<textarea name="toAddress" rows="4" maxlength="600" placeholder="As on their letter">${esc(L.toAddress)}</textarea></label>
      <div class="grid" style="gap:8px">${tb('yourRef', 'Their reference (Your ref)', L.yourRef, 'maxlength="120"')}${tb('theirDate', 'Their letter dated', L.theirDate, 'type="date"')}${tb('ourRef', 'My reference (optional)', L.ourRef, 'maxlength="120"')}</div>
      <label class="f">Greeting<input name="greeting" list="ltGreet" maxlength="120" value="${esc(L.greeting)}"><datalist id="ltGreet"><option value="Dear Sir or Madam,"><option value="Dear Mr ,"><option value="Dear Ms ,"></datalist><span class="faint small">Ends <b id="ltClose">${/sir|madam|to whom/i.test(L.greeting) ? 'Yours faithfully' : 'Yours sincerely'}</b></span></label>
      ${tb('subject', 'Subject (in bold)', L.subject, 'maxlength="200"')}
      <label class="f s3">Letter<textarea name="body" rows="12" maxlength="20000" required>${esc(L.body)}</textarea><span class="faint small">Leave a blank line between paragraphs. Your name and the ending are added for you.</span></label>
      <label class="f">Case<input name="caseName" list="ltCases" maxlength="120" value="${esc(d.caseName || '')}" placeholder="${L.replyTo ? 'Both letters go in it' : 'Optional'}"><datalist id="ltCases">${cases.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="f">Expect a reply within<select name="expect"><option value="">No reminder</option>${[14, 28, 56].map(n => `<option value="${n}" ${n === 28 && !entryId ? 'selected' : ''}>${n} days</option>`).join('')}</select></label>
      <div class="f"><span>Save as</span><span style="display:flex;gap:16px"><label class="switch"><input type="checkbox" name="fmtPdf" checked> PDF</label><label class="switch"><input type="checkbox" name="fmtDocx" checked> Word</label></span></div>
      <div class="err s3" id="ltErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">${icon('check')}${entryId ? 'Save changes' : 'Save letter'}</button></div></form>`);
    const f = $('#letterForm'), el = f.elements;
    el.greeting.oninput = () => { $('#ltClose').textContent = /sir|madam|to whom/i.test(el.greeting.value) ? 'Yours faithfully' : 'Yours sincerely'; };
    el.toName.onchange = () => { const a = (d.addresses || {})[el.toName.value.trim().toLowerCase()]; if (a && !el.toAddress.value.trim()) el.toAddress.value = a; };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const letter = { replyTo: L.replyTo || '' };
      for (const k of ['fromName', 'fromAddress', 'fromPhone', 'fromEmail', 'toName', 'toAddress', 'date', 'yourRef', 'theirDate', 'ourRef', 'greeting', 'subject', 'body']) letter[k] = el[k].value;
      const formats = [el.fmtPdf.checked && 'pdf', el.fmtDocx.checked && 'docx'].filter(Boolean);
      busy(f, true, 'Saving letter…');
      try {
        const r = await keep.letterSave({ letter, formats, caseName: el.caseName.value.trim(), expectDays: el.expect.value ? Number(el.expect.value) : 0, entryId: entryId || '' });
        closeModal(); await refresh(); go('libitem', { libId: r.id }); toast('✓ Letter saved in Documents, marked as sent by you', 4500);
      } catch (ex) { $('#ltErr').textContent = ex.message; busy(f, false); }
    };
  }
  /** A small "type a name" box (with suggestions). Resolves to the text, or null if cancelled. */
  function promptText(title, label, value = '', suggestions = []) {
    return new Promise((resolve) => {
      openModal(`<form class="dialog narrow" id="ptForm"><div class="dh"><h2>${esc(title)}</h2></div><div class="db">
        <label class="f s3">${esc(label)}<input name="v" maxlength="120" value="${esc(value)}" list="ptList" autofocus><datalist id="ptList">${suggestions.map(x => `<option value="${esc(x)}">`).join('')}</datalist></label></div>
        <div class="df"><button type="button" class="btn" id="ptCancel">Cancel</button><button class="btn primary" type="submit">OK</button></div></form>`);
      const f = $('#ptForm'); f.elements.v.focus(); f.elements.v.select();
      f.onsubmit = (ev) => { ev.preventDefault(); const v = f.elements.v.value; closeModal(); resolve(v); };
      $('#ptCancel').onclick = () => { closeModal(); resolve(null); };
    });
  }
  /** Tick documents to add to a case. */
  function casePicker(name) {
    const list = libEntries('document').concat(libEntries('data')).filter(e => (e.caseName || '').toLowerCase() !== name.toLowerCase())
      .sort((a, b) => (b.docDate || b.createdAt).localeCompare(a.docDate || a.createdAt));
    openModal(`<form class="dialog" id="cpForm"><div class="dh"><h2>Add to "${esc(name)}"</h2></div><div class="db"><div class="s3">
      <input type="search" id="cpQ" placeholder="Filter by title or sender" style="width:100%;margin-bottom:8px">
      <div class="rows" style="max-height:52vh;overflow:auto">${list.map(e => `<label class="rowi cprow" data-t="${esc((e.title + ' ' + (e.from || '') + ' ' + (e.ref || '')).toLowerCase())}"><input type="checkbox" value="${esc(e.id)}"> <span style="flex:1"><b>${esc(e.title)}</b> <span class="meta">${esc([e.sent ? 'to ' + (e.from || '') : e.from, e.docDate ? ukDate(e.docDate) : '', e.caseName ? 'in ' + e.caseName : ''].filter(Boolean).join(' · '))}</span></span></label>`).join('') || '<p class="muted">Nothing else to add.</p>'}</div></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Add ticked</button></div></form>`);
    $('#cpQ').oninput = (ev) => { const q = ev.target.value.toLowerCase(); $$('.cprow').forEach(r => r.style.display = r.dataset.t.includes(q) ? '' : 'none'); };
    $('#cpForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const ids = $$('#cpForm input[type=checkbox]:checked').map(x => x.value);
      if (!ids.length) return closeModal();
      const ok = await run(() => keep.libMove(ids, { caseName: name }), `✓ Added ${ids.length}`);
      if (ok !== undefined) { closeModal(); await refresh(); }
    };
  }
  /** One case: every letter, sent and received, oldest first. */
  function viewCase() {
    const name = state.caseName || '';
    const list = libEntries('document').concat(libEntries('data')).filter(e => (e.caseName || '').toLowerCase() === name.toLowerCase())
      .sort((a, b) => ((a.docDate || a.createdAt.slice(0, 10)) + a.createdAt).localeCompare((b.docDate || b.createdAt.slice(0, 10)) + b.createdAt));
    const c = (state.snap.data.libCases || []).find(x => x.name.toLowerCase() === name.toLowerCase());
    const ids = JSON.stringify(list.map(e => e.id));
    let lastYear = '';
    return `<div class="head"><a href="#" data-nav="docs" class="back">${icon('back')}Documents</a><h1>${esc(name)}</h1><span class="sub">${list.length} letter${list.length === 1 ? '' : 's'}${c && c.refs.length ? ' · Ref ' + esc(c.refs.join(', ')) : ''}</span><span class="spacer"></span>
        <button class="btn" data-action="libBundle" data-ids="${esc(ids)}">${icon('printer')}Bundle PDF of the case…</button>
        ${dd('More', [{ label: 'Write a letter in this case…', action: 'libLetterNew', icon: 'edit' }, { label: 'Add documents to this case…', action: 'libCaseAdd', icon: 'plus' }, '-', { label: 'Rename case…', action: 'libCaseRename', icon: 'edit' }])}</div>
      ${!list.length ? '<div class="card empty">Nothing in this case now.</div>' : `<div class="timeline">${list.map(e => {
        const d = e.docDate || e.createdAt.slice(0, 10), y = d.slice(0, 4);
        const yr = y !== lastYear ? `<div class="tyear">${esc(y)}</div>` : ''; lastYear = y;
        return `${yr}<div class="titem ${e.sent ? 'sent' : 'recv'}" data-action="libOpen" data-lib="${esc(e.id)}">
          <div class="tdot">${icon(e.sent ? 'upload' : 'download')}</div>
          <div class="tcard card"><div class="tmeta">${e.docDate ? ukDate(e.docDate) : `<span class="faint">Added ${ukDate(e.createdAt)}</span>`} · ${e.sent ? `<b>Sent</b>${e.from ? ' to ' + esc(e.from) : ''}` : `<b>Received</b>${e.from ? ' from ' + esc(e.from) : ''}`}</div>
            <div><b>${esc(e.title)}</b> ${replyPill(e)} ${e.actBy && !e.actDone ? `<span class="pill ${e.actBy < new Date().toISOString().slice(0, 10) ? 'bad' : 'warn'}">${icon('calendar')}Reply by ${ukDate(e.actBy)}</span>` : ''}</div>
            ${e.ref ? `<div class="meta">Ref ${esc(e.ref)}</div>` : ''}${e.notes ? `<div class="meta snippet">${esc(e.notes)}</div>` : ''}</div></div>`;
      }).join('')}</div>`}`;
  }
  function libListHtml(kind) {
    const list = libFiltered(kind);
    if (!list.length) return `<div class="card empty">${state.lf.q ? `Nothing matches "<b>${esc(state.lf.q)}</b>".` : 'Nothing matches.'}</div>`;
    state.libPick = state.libPick || new Set();
    for (const id of [...state.libPick]) if (!libEntry(id) || libEntry(id).kind !== kind) state.libPick.delete(id);
    const allOn = list.length && list.every(e => state.libPick.has(e.id));
    return libSelBar(kind) + `<div class="card" style="padding:0"><table class="list libtable"><thead><tr><th style="width:34px"><input type="checkbox" data-action="libSelAll" title="Select all shown" ${allOn ? 'checked' : ''}></th><th style="width:64px"></th><th>Title</th><th>${kind === 'document' ? 'Type' : 'Folder'}</th><th>From</th><th>Date</th><th class="r">Files</th></tr></thead><tbody>
      ${list.map(e => {
        const hit = state.libHits && state.libHits.get(e.id);
        const due = e.actBy && !e.actDone ? `<span class="pill ${e.actBy < new Date().toISOString().slice(0, 10) ? 'bad' : 'warn'}">${icon('calendar')}Reply by ${ukDate(e.actBy)}</span>` : '';
        return `<tr data-action="libOpen" data-lib="${esc(e.id)}" draggable="true" class="${state.libPick.has(e.id) ? 'sel' : ''}"><td><input type="checkbox" data-action="libSelBox" data-lib="${esc(e.id)}" ${state.libPick.has(e.id) ? 'checked' : ''} aria-label="Select"></td><td>${libThumb(e)}</td>
          <td><b>${esc(e.title)}</b> ${e.inVault ? `<span class="pill vault">${icon('lock')}Vault</span>` : ''} ${e.onPhone ? `<span class="pill" title="A copy goes in the inventory file for your phone">${icon('phone')}Phone</span>` : ''} ${due}
            ${replyPill(e)}${e.caseName ? ` <span class="pill case" data-action="libCaseOpen" data-case="${esc(e.caseName)}" title="Open the case">${icon('folder')}${esc(e.caseName)}</span>` : ''}
            ${e.ref ? `<div class="meta">Ref ${esc(e.ref)}</div>` : ''}${hit ? `<div class="meta snippet">…${esc(hit)}…</div>` : ''}</td>
          <td class="meta">${kind === 'document' ? esc(e.docType) : e.folder ? esc(e.folder) : `<span class="faint">${esc(fileKind((e.files[0] || { name: '' }).name)[0])}</span>`}</td>
          <td class="meta">${e.sent ? `<span class="faint">To</span> ` : ''}${esc(e.from || '')}</td>
          <td class="meta nowrap">${e.docDate ? ukDate(e.docDate) : `<span class="faint">Added ${ukDate(e.createdAt)}</span>`}</td>
          <td class="r meta">${e.files.length}${e.textPending ? ` <span class="faint" title="Reading the words">…</span>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  function refreshLibList() { const kind = LIB[state.view] && LIB[state.view].kind; if (kind && $('#libList')) { $('#libList').innerHTML = libListHtml(kind); loadLibThumbs(); } }
  let libSearchTimer = null;
  function wireLibrary() {
    const kind = LIB[state.view].kind;
    const q = $('#libQ');
    if (q) q.oninput = () => {
      clearTimeout(libSearchTimer);
      libSearchTimer = setTimeout(async () => {
        state.lf.q = q.value.trim();
        if (!state.lf.q) state.libHits = null;
        else { const r = await keep.libSearch(kind, state.lf.q).catch(() => []); state.libHits = new Map(r.map(x => [x.id, x.snippet])); }
        refreshLibList();
      }, 200);
    };
    wireLibDrop($('#libDrop') || $('#libList'), kind, '');
    loadLibThumbs();
  }
  function wireLibDrop(z) {
    if (!z) return; // the files themselves are added by the page-wide drop handler (see events)
    z.ondragover = (e) => { e.preventDefault(); z.classList.add('over'); };
    z.ondragleave = () => z.classList.remove('over');
    z.addEventListener('drop', () => z.classList.remove('over'));
  }
  async function libAfterAdd(r, kind, entryId) {
    if (!r) return;
    const sk = (r.skipped || []).length ? ` Skipped ${r.skipped.length} already in OpenSafe.` : '';
    if (r.errors.length) toast(`Added ${r.added}.${sk} Not added: ${r.errors.join('; ')}`, 8000);
    else if (r.added) toast(`✓ Added ${r.added} file${r.added === 1 ? '' : 's'}.${sk}`, sk ? 5000 : 3000);
    else if (sk) toast(sk.trim(), 4000);
    await refresh();
    // a new document: open it and ask for its details
    if (!entryId && kind === 'document' && r.ids.length === 1) { go('libitem', { libId: r.ids[0] }); libForm(libEntry(r.ids[0]), true); }
    else if (!entryId && r.ids.length && state.view !== libKindPage(kind)) go(libKindPage(kind));
  }

  function viewLibItem() {
    const e = libEntry(state.libId);
    if (!e) return `<div class="head"><button class="btn ghost" data-nav="docs">${icon('back')}Back</button></div><div class="card empty">This has been deleted, or it's in the vault and the vault is locked.</div>`;
    const L = LIB[libKindPage(e.kind)];
    // the file shown in the preview box: the one clicked last, or the first that can be previewed
    state.libSel = state.libSel || {};
    const sel = e.files.find(x => x.id === state.libSel[e.id]) || e.files.find(x => previewable(x.name)) || e.files[0];
    const first = sel;
    let big = '';
    if (sel && previewable(sel.name)) big = `<div class="libbigwrap" data-action="libFileView" data-file="${esc(sel.id)}" title="Click to read it">${state.libThumbs[sel.id] ? `<img class="libbig" src="${state.libThumbs[sel.id]}" alt="">` : `<div class="libbig ph" data-libthumb="${esc(e.id)}" data-libfile="${esc(sel.id)}">${icon('file')}</div>`}</div>`;
    else if (sel && /\.eml$/i.test(sel.name)) big = `<pre class="libtext libmsg libprevmsg" id="libMsg" data-action="libFileView" data-file="${esc(sel.id)}" title="Click to read it">Loading…</pre>`;
    else if (sel) big = `<div class="libbig ph libnoprev" data-action="libFileView" data-file="${esc(sel.id)}" title="Click to read it">${icon(fileKind(sel.name)[1])}<span>${esc(fileKind(sel.name)[0])}: no preview picture</span></div>`;
    const row = (label, v) => v ? `<div class="lkv"><span class="k">${label}</span><span class="v">${v}</span></div>` : '';
    const today = new Date().toISOString().slice(0, 10);
    return `<div class="head"><button class="btn ghost" data-nav="${libKindPage(e.kind)}">${icon('back')}${L.title}</button><span class="spacer"></span>
      <span class="menuwrap"><button class="btn" data-action="moreMenu">${icon('more')}More</button><div class="menu hidden">
        ${state.snap.security.vault.unlocked ? `<button data-action="libVault" data-to="${e.inVault ? '' : '1'}">${icon(e.inVault ? 'unlock' : 'lock')}${e.inVault ? 'Move out of the vault' : 'Move into the vault'}</button>` : state.snap.security.vault.exists ? '' : ''}
        ${e.reply ? `<button data-action="libLetterEdit">${icon('edit')}Change this letter…</button>` : !e.sent ? `<button data-action="libLetterReply">${icon('edit')}Write a reply…</button>` : ''}
        <button data-action="libOnPhone" data-ids="${esc(JSON.stringify([e.id]))}" data-on="${e.onPhone ? '' : '1'}">${icon('phone')}${e.onPhone ? 'Take off my phone' : 'Keep a copy on my phone'}</button>
        <button data-action="libBundle" data-ids="${esc(JSON.stringify([e.id]))}">${icon('printer')}Make a PDF with contents page…</button>
        <button data-action="libDel" class="danger">${icon('trash')}Delete</button></div></span>
      <button class="btn primary" data-action="libEdit">${icon('edit')}Edit details</button></div>
    <div class="dhead libhead"><div><div class="meta">${esc(e.kind === 'document' ? e.docType : (e.folder || 'Data'))}${e.from ? (e.sent ? ' · to ' : ' · ') + esc(e.from) : ''}</div><h1 style="margin:2px 0 6px">${esc(e.title)}</h1>
      <div>${e.inVault ? `<span class="pill vault">${icon('lock')}Vault</span> ` : ''}${e.onPhone ? `<span class="pill">${icon('phone')}On my phone</span> ` : ''}${e.sent ? `<span class="pill">${icon('upload')}Sent by me</span> ${replyPill(e)} ` : ''}${e.caseName ? `<span class="pill case" data-action="libCaseOpen" data-case="${esc(e.caseName)}">${icon('folder')}${esc(e.caseName)}</span> ` : ''}${e.actBy ? (e.actDone ? `<span class="pill good">${icon('check')}Done (was due ${ukDate(e.actBy)})</span>` : `<span class="pill ${e.actBy < today ? 'bad' : 'warn'}">${icon('calendar')}Reply or act by ${ukDate(e.actBy)}</span>`) : ''}</div></div></div>
    ${e.suggest && Object.keys(e.suggest).length ? `<div class="sugbar">${icon('search')}<span><b>OpenSafe read this letter.</b> Suggested: ${[e.suggest.from && `from <b>${esc(e.suggest.from)}</b>`, e.suggest.docDate && `dated <b>${ukDate(e.suggest.docDate)}</b>`, e.suggest.ref && `reference <b>${esc(e.suggest.ref)}</b>`].filter(Boolean).join(', ')}.</span><span class="spacer"></span><button class="btn small primary" data-action="libSugUse">${icon('check')}Use these</button><button class="btn small ghost" data-action="libSugNo">No thanks</button></div>` : ''}
    <div class="libgrid"><div class="libleft">
      <div class="card" id="libFiles"><h2>${icon('file')}Files <span class="faint">(${e.files.length})</span></h2>
        ${e.files.length ? `<div class="rows">${e.files.map(x => { const k = fileKind(x.name); return `<div class="rowi libfile ${x.id === sel.id ? 'on' : ''}" data-libsel="${esc(x.id)}" title="Click to preview, double-click to open">${icon(k[1])}<span style="flex:1;min-width:0"><b class="ell">${esc(x.name)}</b><div class="meta">${k[0]} · ${fileSize(x.size || 0)} · ${(e.textByFile || {})[x.id] !== undefined ? '' : ''}<span data-textstate="${esc(x.id)}">${libTextState(e, x)}</span></div></span>
          <button class="btn small primary" data-action="libFileView" data-file="${esc(x.id)}">${icon('file')}View</button>
          <span class="menuwrap"><button class="btn small" data-action="moreMenu">${icon('more')}</button><div class="menu hidden">
            <button data-action="libFileOpen" data-file="${esc(x.id)}">${icon('upload')}Open in another app</button>
            <button data-action="libFileCopy" data-file="${esc(x.id)}">${icon('download')}Save a copy…</button>
            <button data-action="libFileText" data-file="${esc(x.id)}">${icon('search')}Show the words found</button>
            <button data-action="libFileRemove" data-file="${esc(x.id)}" class="danger">${icon('trash')}Remove this file</button></div></span></div>`; }).join('')}</div>` : '<p class="muted">No files.</p>'}
        <div class="drop" id="libDrop2">Drag more files anywhere on this page, or <a href="#" data-action="libAddMore">choose files…</a>${e.kind === 'document' ? ' (for example the other pages of the letter)' : ''}</div></div>
      <div class="card"><h2>Details</h2>
        ${row(e.kind === 'document' ? 'Type' : 'Folder', esc(e.kind === 'document' ? e.docType : e.folder))}${row(e.sent ? 'To' : 'From', esc(e.from))}${row('Case', e.caseName ? `<a href="#" data-action="libCaseOpen" data-case="${esc(e.caseName)}">${esc(e.caseName)}</a>` : '')}${e.sent ? row('Reply expected by', e.expectBy ? ukDate(e.expectBy) : '') : ''}${row(e.kind === 'document' ? 'Date on it' : 'Date', e.docDate ? ukDate(e.docDate) : '')}${row('Reference', esc(e.ref))}
        ${row('Tags', e.tags.map(t => `<span class="pill">${esc(t)}</span>`).join(' '))}
        ${e.notes ? `<div class="lkv" style="display:block"><span class="k">Notes</span><div class="v" style="white-space:pre-wrap;margin-top:4px">${esc(e.notes)}</div></div>` : ''}
        ${row('Added', ukDate(e.createdAt) + (e.source === 'phone' ? ' · scanned on the phone' : ''))}
        ${e.actBy && !e.actDone ? `<p style="margin:12px 0 0"><button class="btn small" data-action="libDone">${icon('check')}Mark as done</button></p>` : ''}
        ${!e.from && !e.docDate && !e.ref && e.kind === 'document' ? `<p class="muted small" style="margin:10px 0 0">Add who it's from, its date and any reference with <b>Edit details</b>.</p>` : ''}</div>
    </div><div class="libright">
      ${big ? `<div class="card libpreview">${big}<p class="faint small" style="margin:8px 0 0"><b>${esc(first.name)}</b>${first.name.toLowerCase().endsWith('.pdf') ? ' · first page' : ''}. ${e.files.length > 1 ? 'Click a file to preview it here; double-click to open it.' : 'Click to read it, or double-click the file.'}</p></div>` : ''}
    </div></div>`;
  }
  function libTextState(e, x) {
    if (!(e.textByFile && x.id in e.textByFile)) return 'reading the words…';
    const n = e.textByFile[x.id];
    return n > 20 ? 'words can be searched' : /\.(msg|doc|xls|ppt|zip|mp4|mov)$/i.test(x.name) ? 'words can\'t be read from this kind of file' : 'no words found';
  }
  async function loadLibItem() {
    try {
      const full = await keep.libGet(state.libId);
      const i = (state.snap.data.library || []).findIndex(x => x.id === full.id);
      if (i >= 0) state.snap.data.library[i] = Object.assign({}, state.snap.data.library[i], { textByFile: full.textByFile });
      const e = libEntry(state.libId);
      for (const x of e.files) { const el = $(`[data-textstate="${CSS.escape(x.id)}"]`); if (el) el.textContent = libTextState(e, x); }
    } catch (_) { /* deleted or locked */ }
    wireLibDrop($('#libDrop2'), (libEntry(state.libId) || {}).kind, state.libId);
    const m = $('#libMsg'), em = libEntry(state.libId), ef = m && em && em.files.find(x => x.id === m.dataset.file);
    if (m && ef) keep.libText(em.id, ef.id).then(t => { m.textContent = t && t.trim() ? t : 'The message text will appear here once OpenSafe has read the file.'; }).catch(() => { m.textContent = ''; });
    loadLibThumbs();
  }
  function libForm(e, isNew) {
    const doc = e.kind === 'document';
    const types = state.snap.lists.libraryTypes || [];
    const folders = state.snap.lists.libraryFolders || [];
    openModal(`<form class="dialog" id="libForm"><div class="dh"><h2>${isNew ? (doc ? 'New document' : 'New entry') : 'Edit details'}</h2></div><div class="db">
      ${isNew ? `<p class="muted s3" style="margin-top:0">Fill in what you know; everything except the title is optional. You can change it later.</p>` : ''}
      <label class="f s2">Title<input name="title" maxlength="200" required value="${esc(e.title)}"></label>
      ${doc ? `<label class="f">Type<select name="docType">${types.map(t => opt(t, t, e.docType)).join('')}</select></label>` : `<label class="f">Folder<input name="folder" list="libFolders" maxlength="120" value="${esc(e.folder)}" placeholder="e.g. Emails, Tax, Holiday"><datalist id="libFolders">${folders.map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>`}
      <label class="f s3" style="flex-direction:row;align-items:center;gap:10px"><span class="switch"><input type="checkbox" name="sent" id="lfSent" ${e.sent ? 'checked' : ''}> I sent this</span><span class="faint small">a letter or email from you, so you can keep track of the reply</span></label>
      <label class="f"><span id="lfFromLbl">${e.sent ? 'To' : 'From'}</span><input name="from" maxlength="200" value="${esc(e.from)}" placeholder="${doc ? 'e.g. Veterans UK, HMRC, the council' : ''}"></label>
      <label class="f">Case<input name="caseName" list="libCases" maxlength="120" value="${esc(e.caseName || '')}" placeholder="e.g. CMS recalculation"><datalist id="libCases">${(state.snap.data.libCases || []).map(c => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
      <label class="f">${doc ? 'Date on it' : 'Date'}<input type="date" name="docDate" value="${esc(e.docDate)}"></label>
      <label class="f">Reference<input name="ref" maxlength="120" value="${esc(e.ref)}" placeholder="Account, case or claim number"></label>
      <label class="f lfRecv">Reply or act by<input type="date" name="actBy" value="${esc(e.actBy)}"><span class="faint small">Shows in Reminders until marked done</span></label>
      <label class="f lfRecv" style="align-self:center"><span class="switch"><input type="checkbox" name="actDone" ${e.actDone ? 'checked' : ''}> Done</span></label>
      <label class="f lfSent">Expect a reply by<input type="date" name="expectBy" value="${esc(e.expectBy || '')}"><span class="faint small">${[14, 28, 56].map(d => `<a href="#" data-days="${d}">${d} days</a>`).join(' · ')} after the date on it</span></label>
      <label class="f lfSent" style="align-self:center"><span class="switch"><input type="checkbox" name="replyDone" ${e.replyDone ? 'checked' : ''}> Reply received</span><span class="faint small">or add their reply to the same case</span></label>
      <label class="f s3">Tags<input name="tags" maxlength="400" value="${esc(e.tags.join(', '))}" placeholder="Separate with commas"></label>
      <label class="f s3">Notes<textarea name="notes" rows="4" maxlength="5000">${esc(e.notes)}</textarea></label></div>
      <div class="df"><button type="button" class="btn" data-action="close">${isNew ? 'Later' : 'Cancel'}</button><button class="btn primary" type="submit">Save</button></div></form>`);
    const lf = $('#libForm');
    const showSent = () => { const on = lf.elements.sent.checked; lf.querySelectorAll('.lfSent').forEach(x => x.style.display = on ? '' : 'none'); lf.querySelectorAll('.lfRecv').forEach(x => x.style.display = on ? 'none' : ''); $('#lfFromLbl').textContent = on ? 'To' : 'From'; };
    lf.elements.sent.onchange = showSent; showSent();
    lf.querySelectorAll('[data-days]').forEach(a => a.onclick = (ev) => {
      ev.preventDefault();
      const base = lf.elements.docDate.value || new Date().toISOString().slice(0, 10);
      const d = new Date(base + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(a.dataset.days));
      lf.elements.expectBy.value = d.toISOString().slice(0, 10);
    });
    $('#libForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target), v = Object.fromEntries(fd.entries());
      v.id = e.id; v.actDone = fd.get('actDone') === 'on'; v.tags = String(v.tags || '').split(',');
      v.sent = fd.get('sent') === 'on'; v.replyDone = fd.get('replyDone') === 'on';
      const ok = await run(() => keep.libSave(v), '✓ Saved');
      if (ok) { closeModal(); await refresh(); }
    };
  }
  function libBinForm(kind) {
    const list = (state.snap.data.libBin || []).filter(b => b.kind === kind);
    openModal(`<div class="dialog narrow"><div class="dh"><h2>Deleted ${kind === 'document' ? 'documents' : 'data'}</h2></div><div class="db"><div class="s3">
      <p class="muted" style="margin-top:0">Kept for 30 days, then deleted for good.</p>
      ${list.length ? `<div class="rows">${list.map(b => `<div class="rowi"><span style="flex:1"><b>${esc(b.title)}</b><div class="meta">${b.files} file${b.files === 1 ? '' : 's'} · deleted ${ukDate(b.deletedAt)}${b.inVault ? ' · vault' : ''}</div></span>
        <button class="btn small" data-action="libRestore" data-lib="${esc(b.id)}">Restore</button><button class="btn small danger" data-action="libPurge" data-lib="${esc(b.id)}">Delete for good</button></div>`).join('')}</div>` : '<p class="muted">Nothing here.</p>'}</div></div>
      <div class="df"><button class="btn" data-action="close">Close</button></div></div>`);
  }
  async function libTextModal(id, fileId) {
    const t = await run(() => keep.libText(id, fileId));
    if (t === undefined) return;
    openModal(`<div class="dialog"><div class="dh"><h2>Words found in this file</h2></div><div class="db"><div class="s3">
      ${t && t.trim() ? `<p class="faint small" style="margin-top:0">Read automatically, so there may be mistakes, especially in handwriting or poor photos. This is what search looks through.</p><pre class="libtext">${esc(t)}</pre>` : '<p class="muted">No words were found in this file. It may be a photo without writing, a handwritten page, or a kind of file OpenSafe can\'t read (such as Outlook .msg or old .doc files).</p>'}</div></div>
      <div class="df">${t && t.trim() ? '<button class="btn" data-action="libCopyText">Copy text</button>' : ''}<button class="btn" data-action="close">Close</button></div></div>`);
    state.libTextCopy = t;
  }
  async function libAction(act) {
    const e = state.libId && libEntry(state.libId);
    switch (act.dataset.action) {
      case 'libAdd': { const kind = act.dataset.kind; const r = await run(() => keep.libPick(kind, '')); await libAfterAdd(r, kind, ''); return true; }
      case 'libAddMore': { if (!e) return true; const r = await run(() => keep.libPick(e.kind, e.id)); await libAfterAdd(r, e.kind, e.id); return true; }
      case 'libOpen': go('libitem', { libId: act.dataset.lib }); return true;
      case 'libEdit': if (e) libForm(e, false); return true;
      case 'libDone': if (e) { await run(() => keep.libSave({ id: e.id, actDone: true }), '✓ Marked as done'); await refresh(); } return true;
      case 'libDel': if (e && confirm(`Delete "${e.title}"?\n\nIt goes to Deleted ${e.kind === 'document' ? 'documents' : 'data'} for 30 days, so you can restore it.`)) { const ok = await run(() => keep.libDelete(e.id)); if (ok) { toast('Deleted. You can restore it for 30 days.', 4000); await refresh(); go(libKindPage(e.kind)); } } return true;
      case 'libVault': if (e) { const to = !!act.dataset.to; const ok = await run(() => keep.libVault(e.id, to), to ? '✓ Moved into the vault' : '✓ Moved out of the vault'); if (ok) await refresh(); } return true;
      case 'libFileOpen': { const id = e ? e.id : vstate.id; if (id) await run(() => keep.libOpen(id, act.dataset.file)); return true; }
      case 'libFileView': if (e) await libViewOpen(e.id, act.dataset.file); return true;
      case 'libFileCopy': { const id = e ? e.id : vstate.id; if (id) { const p = await run(() => keep.libSaveCopy(id, act.dataset.file)); if (p) toast('✓ Copy saved'); } return true; }
      case 'libFileText': if (e) await libTextModal(e.id, act.dataset.file); return true;
      case 'libCopyText': await run(() => keep.copyPlain(state.libTextCopy || ''), '✓ Copied'); return true;
      case 'libFileRemove': if (e) { const f = e.files.find(x => x.id === act.dataset.file); if (f && confirm(`Remove "${f.name}" from this ${e.kind === 'document' ? 'document' : 'entry'}?\n\nThis deletes the file from OpenSafe and can't be undone. (Use Save a copy first if you want to keep it.)`)) { await run(() => keep.libRemoveFile(e.id, f.id), 'File removed'); await refresh(); } } return true;
      case 'libBin': libBinForm(act.dataset.kind); return true;
      case 'libSugUse': if (e) { await run(() => keep.libSuggestion(e.id, true), '✓ Details filled in. Change them any time with Edit details.'); await refresh(); } return true;
      case 'libSugNo': if (e) { await run(() => keep.libSuggestion(e.id, false)); await refresh(); } return true;
      case 'libSelClear': state.libPick.clear(); refreshLibList(); return true;
      case 'libOnPhone': { const ids = JSON.parse(act.dataset.ids), on = !!act.dataset.on; const ok = await run(() => keep.libOnPhone(ids, on), on ? `✓ ${ids.length === 1 ? 'It goes' : 'They go'} on your phone next time you use Phone app → Save inventory for phone` : 'Taken off the phone copy (next time you save it)'); if (ok !== undefined) await refresh(); return true; }
      case 'libMode': state.libMode = act.dataset.v; render(); return true;
      case 'libCaseOpen': go('case', { caseName: act.dataset.case }); return true;
      case 'libCaseRename': {
        const to = await promptText('Rename case', 'New name for this case', state.caseName);
        if (to && to.trim() && to.trim() !== state.caseName) { const ok = await run(() => keep.libRenameCase(state.caseName, to.trim()), '✓ Renamed'); if (ok !== undefined) { state.caseName = to.trim(); await refresh(); } }
        return true;
      }
      case 'libCaseAdd': casePicker(state.caseName); return true;
      case 'libLetterReply': { const d = await run(() => keep.letterDraft(e.id)); if (d) letterForm(d, null); return true; }
      case 'libLetterNew': { const d = await run(() => keep.letterDraft('')); if (d) { if (state.view === 'case') d.caseName = state.caseName; letterForm(d, null); } return true; }
      case 'libLetterEdit': { const d = await run(() => keep.letterDraft('')); if (d) letterForm({ letter: Object.assign({}, e.reply), caseName: e.caseName || '', addresses: d.addresses, expectBy: e.expectBy }, e.id); return true; }
      case 'libCaseSet': { const ids = JSON.parse(act.dataset.ids); const name = await promptText('Put in a case', 'Case name (a new one, or one you already have)', '', (state.snap.data.libCases || []).map(c => c.name)); if (name !== null && name !== undefined) { const ok = await run(() => keep.libMove(ids, { caseName: name.trim() }), name.trim() ? `✓ Put in "${name.trim()}"` : '✓ Taken out of the case'); if (ok !== undefined) { state.libPick && state.libPick.clear(); await refresh(); } } return true; }
      case 'libBundle': bundleForm(act.dataset.ids ? JSON.parse(act.dataset.ids) : [...(state.libPick || [])], state.view === 'case' ? state.caseName : ''); return true;
      case 'libMoveTo': { const ids = JSON.parse(act.dataset.ids), to = { kind: act.dataset.kind }; if (act.dataset.folder !== undefined) to.folder = act.dataset.folder; await libMoveIds(ids, to, to.kind === 'document' ? 'Documents' : to.folder ? 'Data › ' + to.folder : 'Data'); return true; }
      case 'libMoveNewFolder': newFolderForm(JSON.parse(act.dataset.ids)); return true;
      case 'libLinkPick': linkPick(act.dataset.ids ? JSON.parse(act.dataset.ids) : [state.libId]); return true;
      case 'libUnlink': { const ok = await run(() => keep.libLink([act.dataset.lib], act.dataset.asset, false), 'Unlinked'); if (ok !== undefined) await refresh(); return true; }
      case 'libVaultMany': { const ids = JSON.parse(act.dataset.ids), to = !!act.dataset.to; await run(() => Promise.all(ids.map(id => keep.libVault(id, to))), to ? '✓ Moved into the vault' : '✓ Moved out of the vault'); if (state.libPick) state.libPick.clear(); await refresh(); return true; }
      case 'libDelMany': { const ids = act.dataset.ids ? JSON.parse(act.dataset.ids) : [...(state.libPick || [])]; if (!ids.length || !confirm(`Delete ${ids.length === 1 ? 'this entry' : ids.length + ' entries'}?

They go to the bin for 30 days, so you can restore them.`)) return true; for (const id of ids) await run(() => keep.libDelete(id)); if (state.libPick) state.libPick.clear(); toast('Deleted. You can restore them for 30 days.', 4000); await refresh(); if (state.view === 'libitem' && !libEntry(state.libId)) go('docs'); return true; }
      case 'libRestore': { const ok = await run(() => keep.libRestore(act.dataset.lib), '✓ Restored'); if (ok) { await refresh(); const k = (state.snap.data.library.find(x => x.id === act.dataset.lib) || {}).kind; libBinForm(k || LIB[state.view] && LIB[state.view].kind || 'document'); } return true; }
      case 'libPurge': { const ok = await run(() => keep.libPurge(act.dataset.lib)); if (ok) { toast('Deleted for good'); await refresh(); libBinForm(LIB[state.view] ? LIB[state.view].kind : 'document'); } return true; }
    }
    return false;
  }

  // ---------- moving and linking (Documents, Data, items, places) ----------
  const libFolders = () => [...new Set((state.snap.data.library || []).filter(e => e.kind === 'data' && e.folder).map(e => e.folder))].sort((a, b) => a.localeCompare(b, 'en-GB'));
  /** "Move to" choices for library entries. */
  function libMoveItems(ids) {
    const kinds = new Set(ids.map(id => (libEntry(id) || {}).kind));
    const unlocked = state.snap.security.vault.unlocked, inV = ids.every(id => (libEntry(id) || {}).inVault);
    const data = JSON.stringify(ids);
    return [{ head: 'Move to' },
      !(kinds.size === 1 && kinds.has('document')) && { label: 'Documents', action: 'libMoveTo', icon: 'letter', data: { ids: data, kind: 'document' } },
      !(kinds.size === 1 && kinds.has('data')) && { label: 'Data', action: 'libMoveTo', icon: 'folder', data: { ids: data, kind: 'data', folder: '' } },
      ...libFolders().map(f => ({ label: 'Data › ' + f, action: 'libMoveTo', icon: 'folder', data: { ids: data, kind: 'data', folder: f } })),
      { label: 'New Data folder…', action: 'libMoveNewFolder', icon: 'plus', data: { ids: data } },
      '-', { label: 'Link to an item…', action: 'libLinkPick', icon: 'box', data: { ids: data } },
      { label: 'Put in a case…', action: 'libCaseSet', icon: 'folder', data: { ids: data } },
      ids.every(id => (libEntry(id) || {}).onPhone) ? { label: 'Take off my phone', action: 'libOnPhone', icon: 'phone', data: { ids: data, on: '' } } : { label: 'Keep a copy on my phone', action: 'libOnPhone', icon: 'phone', data: { ids: data, on: '1' } },
      unlocked && { label: inV ? 'Move out of the vault' : 'Move into the vault', action: 'libVaultMany', icon: inV ? 'unlock' : 'lock', data: { ids: data, to: inV ? '' : '1' } }];
  }
  function libSelBar(kind) {
    const n = state.libPick ? state.libPick.size : 0;
    if (!n) return '';
    const ids = [...state.libPick];
    return `<div class="selbar"><b>${n} selected</b>${dd('Move to', libMoveItems(ids), { cls: 'btn primary small', iconName: 'folder', align: 'left', scroll: true })}
      <button class="btn small" data-action="libLinkPick" data-ids="${esc(JSON.stringify(ids))}">${icon('box')}Link to an item…</button>
      <button class="btn small" data-action="libBundle" data-ids="${esc(JSON.stringify(ids))}">${icon('printer')}Bundle PDF…</button>
      <button class="btn small danger" data-action="libDelMany">${icon('trash')}Delete…</button><button class="btn small" data-action="libSelClear">Clear selection</button></div>`;
  }
  /** A searchable list to choose from: rows [{ id, title, sub, thumb }]. */
  function pickerModal(title, rows, onPick, { hint = '', empty = 'Nothing to choose from.' } = {}) {
    openModal(`<div class="dialog narrow picker"><div class="dh"><h2>${esc(title)}</h2></div><div class="db"><div class="s3">
      ${hint ? `<p class="muted small" style="margin:0 0 8px">${hint}</p>` : ''}
      <div class="sidesearch libsearch" style="margin:0 0 8px;max-width:none">${icon('search')}<input id="pkQ" type="search" placeholder="Search" autocomplete="off"></div>
      <div class="rows pkrows" id="pkRows"></div></div></div>
      <div class="df"><button class="btn" data-action="close">Cancel</button></div></div>`);
    const draw = () => {
      const q = ($('#pkQ').value || '').toLowerCase().trim();
      const list = rows.filter(r => !q || (r.title + ' ' + (r.sub || '')).toLowerCase().includes(q)).slice(0, 80);
      $('#pkRows').innerHTML = list.length ? list.map(r => `<div class="rowi pkrow" data-pick="${esc(r.id)}">${r.thumb || ''}<span style="flex:1;min-width:0"><b class="ell" style="display:block">${esc(r.title)}</b>${r.sub ? `<span class="meta">${esc(r.sub)}</span>` : ''}</span>${icon('chevron')}</div>`).join('') : `<p class="muted">${q ? 'Nothing matches.' : esc(empty)}</p>`;
      $$('#pkRows [data-pick]').forEach(el => { el.onclick = async () => { closeModal(); await onPick(el.dataset.pick); }; });
    };
    $('#pkQ').oninput = draw; draw(); setTimeout(() => $('#pkQ').focus(), 30);
  }
  function itemPicker(title, onPick, hint) {
    const rows = state.snap.data.assets.filter(a => !INACTIVE.includes(a.status)).sort((a, b) => a.name.localeCompare(b.name, 'en-GB')).map(a => ({ id: a.id, title: a.name, sub: [a.category, a.location].filter(Boolean).join(' · '), thumb: thumb(a) }));
    pickerModal(title, rows, onPick, { hint, empty: 'You have no items yet.' });
  }
  function placePicker(title, onPick, hint) {
    const rows = locPaths().map(p => ({ id: p, title: p.split(' / ').pop(), sub: p.includes(' / ') ? p : '' }));
    pickerModal(title, rows, onPick, { hint, empty: 'No places yet.' });
  }
  async function moveItemsTo(ids, loc) {
    const n = await run(() => keep.bulkUpdate(ids, { location: loc }));
    if (n === undefined) return;
    toast(`✓ ${ids.length === 1 ? (asset(ids[0]) || {}).name || '1 item' : ids.length + ' items'} moved to ${loc}`, 3500);
    state.sel.clear(); await refresh();
  }
  async function libMoveIds(ids, to, label) {
    const n = await run(() => keep.libMove(ids, to));
    if (n === undefined) return;
    toast(`✓ ${ids.length === 1 ? '1 entry' : ids.length + ' entries'} moved to ${label}`, 3500);
    if (state.libPick) state.libPick.clear();
    await refresh();
  }
  function newFolderForm(ids) {
    openModal(`<form class="dialog narrow" id="nfForm"><div class="dh"><h2>New Data folder</h2></div><div class="db">
      <label class="f s3">Folder name<input name="folder" maxlength="120" required placeholder="e.g. Tax, Car, Holiday"></label></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Move here</button></div></form>`);
    $('#nfForm').onsubmit = async (ev) => { ev.preventDefault(); const f = ev.target.folder.value.trim(); if (!f) return; closeModal(); await libMoveIds(ids, { kind: 'data', folder: f }, 'Data › ' + f); };
  }
  function linkPick(ids) {
    itemPicker(ids.length === 1 ? 'Link to an item' : `Link ${ids.length} entries to an item`, async (aid) => {
      const n = await run(() => keep.libLink(ids, aid, true));
      if (n !== undefined) { toast(`✓ Linked to ${(asset(aid) || {}).name || 'the item'}. It shows on the item's page.`, 4000); if (state.libPick) state.libPick.clear(); await refresh(); }
    }, 'The document stays where it is and also shows on the item’s page, under Documents and files.');
  }

  // ---------- right-click menus ----------
  function contextMenu(x, y, items) {
    closeMenus();
    const m = document.createElement('div');
    m.className = 'menu ctx';
    m.innerHTML = menuItems(items);
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    m.style.top = (y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y) + 'px';
    const first = m.querySelector('button'); if (first) first.focus({ preventScroll: true });
  }
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, .vframe')) return; // keep copy and paste
    const itemEl = e.target.closest('[data-open]');
    const libRow = e.target.closest('tr[data-lib]');
    const fileRow = e.target.closest('[data-libsel]');
    const placeRow = e.target.closest('.prow[data-place]');
    let items = null;
    if (fileRow && state.libId) {
      const f = fileRow.dataset.libsel;
      items = [{ label: 'View', action: 'libFileView', icon: 'file', data: { file: f } }, { label: 'Open in another app', action: 'libFileOpen', icon: 'upload', data: { file: f } }, { label: 'Save a copy…', action: 'libFileCopy', icon: 'download', data: { file: f } }, { label: 'Show the words found', action: 'libFileText', icon: 'search', data: { file: f } }, '-', { label: 'Remove this file', action: 'libFileRemove', icon: 'trash', danger: true, data: { file: f } }];
    } else if (libRow) {
      const id = libRow.dataset.lib, ids = state.libPick && state.libPick.has(id) && state.libPick.size > 1 ? [...state.libPick] : [id];
      items = [ids.length === 1 && { label: 'Open', action: 'libOpen', icon: 'file', data: { lib: id } }, ...libMoveItems(ids), '-', { label: ids.length > 1 ? `Bundle PDF of ${ids.length}…` : 'Make a PDF with contents page…', action: 'libBundle', icon: 'printer', data: { ids: JSON.stringify(ids) } }, '-', { label: ids.length > 1 ? `Delete ${ids.length}…` : 'Delete…', action: 'libDelMany', icon: 'trash', danger: true, data: { ids: JSON.stringify(ids) } }];
    } else if (itemEl && asset(itemEl.dataset.open)) {
      const a = asset(itemEl.dataset.open), ids = state.sel.has(a.id) && state.sel.size > 1 ? [...state.sel] : [a.id];
      items = ids.length > 1
        ? [{ head: `${ids.length} items` }, { label: 'Move to a place…', action: 'ctxMove', icon: 'pin', data: { ids: JSON.stringify(ids) } }, { label: 'Change…', action: 'bulkSel', icon: 'edit' }, { label: 'QR labels…', action: 'labelsSel', icon: 'qr' }, '-', { label: 'Delete…', action: 'deleteSel', icon: 'trash', danger: true }]
        : [{ label: 'Open', action: 'ctxOpen', icon: 'box', data: { id: a.id } }, { label: 'Edit…', action: 'ctxEdit', icon: 'edit', data: { id: a.id } }, { label: 'Move to a place…', action: 'ctxMove', icon: 'pin', data: { ids: JSON.stringify([a.id]) } }, { label: 'Link a document…', action: 'ctxLinkDoc', icon: 'letter', data: { id: a.id } }, '-',
          { label: 'Duplicate', action: 'ctxDup', icon: 'duplicate', data: { id: a.id } }, { label: 'Print QR label…', action: 'ctxLabel', icon: 'qr', data: { id: a.id } }, '-', { label: 'Delete', action: 'ctxDel', icon: 'trash', danger: true, data: { id: a.id } }];
    } else if (placeRow) {
      const p = placeRow.dataset.place;
      items = [{ head: p.split(' / ').pop() }, { label: 'Show in Items', action: 'filterLoc', icon: 'box', data: { loc: p } }, { label: 'Print label', action: 'placeLabelOne', icon: 'qr', data: { place: p } }];
    }
    if (!items) return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, items);
  });

  // ---------- dragging items and documents onto a panel of places and folders ----------
  let dragInfo = null;
  function dropPanel(title, targets) {
    const p = document.createElement('div');
    p.className = 'droppanel'; p.id = 'dropPanel';
    p.innerHTML = `<div class="dh"><b>${esc(title)}</b><span class="meta">Drop on a place below</span></div><div class="db">${targets.map(t => t.head ? `<div class="mh menu-h">${esc(t.head)}</div>` : `<div class="droptarget" data-drop="${esc(JSON.stringify(t.to))}" style="padding-left:${10 + (t.depth || 0) * 16}px">${icon(t.icon || 'pin')}<span class="ell">${esc(t.label)}</span>${t.count !== undefined ? `<span class="c">${t.count}</span>` : ''}</div>`).join('')}</div>`;
    document.body.appendChild(p);
    $$('.droptarget', p).forEach(el => {
      el.ondragover = (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; el.classList.add('over'); };
      el.ondragleave = () => el.classList.remove('over');
      el.ondrop = async (ev) => { ev.preventDefault(); ev.stopPropagation(); el.classList.remove('over'); const to = JSON.parse(el.dataset.drop), info = dragInfo; endDrag(); await dropOn(info, to); };
    });
  }
  function endDrag() { const p = $('#dropPanel'); if (p) p.remove(); $$('.dragging').forEach(x => x.classList.remove('dragging')); dragInfo = null; }
  async function dropOn(info, to) {
    if (!info) return;
    if (info.type === 'items') {
      if (to.newPlace) newPlaceForm((loc) => moveItemsTo(info.ids, loc));
      else await moveItemsTo(info.ids, to.loc);
    } else if (info.type === 'lib') {
      if (to.newFolder) newFolderForm(info.ids);
      else if (to.link) linkPick(info.ids);
      else if (to.vault !== undefined) { await run(() => Promise.all(info.ids.map(id => keep.libVault(id, to.vault)))); await refresh(); }
      else await libMoveIds(info.ids, to, to.kind === 'document' ? 'Documents' : to.folder ? 'Data › ' + to.folder : 'Data');
    }
  }
  document.addEventListener('dragstart', (e) => {
    const libRow = e.target.closest && e.target.closest('tr[data-lib][draggable]');
    const itemEl = e.target.closest && e.target.closest('[data-open][draggable]');
    if (!libRow && !itemEl) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-opensafe', '1');
    if (libRow) {
      const id = libRow.dataset.lib, ids = state.libPick && state.libPick.has(id) ? [...state.libPick] : [id];
      dragInfo = { type: 'lib', ids };
      const unlocked = state.snap.security.vault.unlocked;
      const t = [{ head: 'Move to' }, { label: 'Documents', icon: 'letter', to: { kind: 'document' } }, { label: 'Data', icon: 'folder', to: { kind: 'data', folder: '' } },
        ...libFolders().map(f => ({ label: f, icon: 'folder', depth: 1, to: { kind: 'data', folder: f } })), { label: 'New Data folder…', icon: 'plus', depth: 1, to: { newFolder: true } },
        { head: 'Also' }, { label: 'Link to an item…', icon: 'box', to: { link: true } }, unlocked && { label: 'Vault', icon: 'lock', to: { vault: true } }].filter(Boolean);
      dropPanel(ids.length === 1 ? 'Move 1 entry' : `Move ${ids.length} entries`, t);
      $$('tr[data-lib]').forEach(r => { if (ids.includes(r.dataset.lib)) r.classList.add('dragging'); });
    } else {
      const id = itemEl.dataset.open, ids = state.sel.has(id) ? [...state.sel] : [id];
      dragInfo = { type: 'items', ids };
      const by = state.snap.summary.byLocation || {};
      const t = locPaths().map(p => ({ label: p.split(' / ').pop(), depth: p.split(' / ').length - 1, icon: p.includes(' / ') ? 'box' : 'pin', count: (by[p] || {}).count || 0, to: { loc: p } }));
      t.push({ label: 'New place…', icon: 'plus', to: { newPlace: true } });
      dropPanel(ids.length === 1 ? `Move ${(asset(id) || {}).name || 'item'}` : `Move ${ids.length} items`, t);
      $$('[data-open]').forEach(r => { if (ids.includes(r.dataset.open)) r.classList.add('dragging'); });
    }
    const g = document.createElement('div'); g.className = 'dragghost'; g.textContent = dragInfo.ids.length === 1 ? (dragInfo.type === 'items' ? (asset(dragInfo.ids[0]) || {}).name : (libEntry(dragInfo.ids[0]) || {}).title) || '1' : `${dragInfo.ids.length} selected`;
    document.body.appendChild(g); e.dataTransfer.setDragImage(g, 10, 10); setTimeout(() => g.remove(), 0);
  });
  document.addEventListener('dragend', () => setTimeout(endDrag, 50));

  // ---------- one search for everything ----------
  // ---------- Help and What's new ----------
  const NEWS = [
    ['2.14.0', 'Write letters, hide details', ['<b>Write a reply…</b> on a letter (More menu), or <b>+ New → Letter…</b>: a properly laid-out letter with their reference and date filled in, saved as PDF and Word, marked as sent and put in the case.', '<b>Hide private details</b> in Bundle PDF: black out NI numbers, bank details, card and phone numbers, emails and any words you type, including on scanned pages.']],
    ['2.13.0', 'Cases and replies', ['<b>Cases</b>: put letters about one matter in a case and see them as a timeline, sent and received, with a Bundle PDF of the whole case.', '<b>I sent this</b>: track letters you sent; Reminders shows "No reply yet" after the date, until their reply is added to the case.', 'Filter Documents and Data by who it\'s from or to, by tag and by case; a warning when the same file is added twice.']],
    ['2.12.0', 'Help and checks', ['This page: what changed in recent versions, and a short checklist for trying the new features on your own PC and phone.']],
    ['2.11.0', 'Two PCs', ['Keep OpenSafe the same on two PCs through a shared folder such as OneDrive (Import & backup → Two PCs). If both were changed, it asks which copy to keep and saves the other as a backup.']],
    ['2.10.0', 'Bundles and documents on the phone', ['<b>Bundle PDF</b>: tick letters → one PDF in date order with a contents page and page numbers.', '<b>Keep a copy on my phone</b>: chosen documents go in the phone inventory file, to read offline in Capture.']],
    ['2.9.0', 'Search everything', ['One search box for items, Documents and Data, including the words inside letters and the receipts and manuals on items.', 'Who a letter is from, its date and reference are suggested after it\'s read.', 'Outlook .msg emails can be read inside OpenSafe.']],
    ['2.8.0', 'New look', ['Drop-down menus, filter chips, right-click menus and <b>+ New</b>.', 'Drag items onto places; move entries between Documents and Data; link documents to items.']],
    ['2.7.x', 'Reading files', ['PDFs, emails, Word and Excel files open inside OpenSafe. Click to preview, double-click to read. Drag and drop anywhere on Documents and Data.']],
    ['2.6.0', 'Documents and Data', ['Keep letters and files that aren\'t about one item, searchable by the words in them, with <b>📄 Scan a document</b> on the phone. Capture also gained <b>Scan a room</b> around this time.']]
  ];
  const CHECKS = [
    ['pdf', 2, 'Open one of your real PDF letters', 'Documents → click a letter, then double-click its PDF. Every page should show, and zoom should work.'],
    ['search', 1, 'Search for a word inside a letter', 'Type a word that\'s only in the body of a letter (not its title) in <b>Search everything</b>. The letter should be found, with the word highlighted.'],
    ['msg', 2, 'Add an Outlook email', 'In classic Outlook, drag an email to your desktop (it saves as a .msg file), then drag that file onto Data. Its subject and date should fill in, and it should open in the reader.'],
    ['bundle', 1, 'Make a bundle', 'Tick two or three letters and choose <b>Bundle PDF…</b>; the PDF should open with a contents page and "Page 1 of …" at the bottom of every page.'],
    ['drag', 1, 'Drag with the mouse', 'Items → drag an item by its row. A panel of places should appear; drop it on one and its place should change.'],
    ['label', 1, 'Scan a QR label with the phone', 'Print one label (an item → More → Print QR label…), scan it with Capture. The item should open.'],
    ['phonedoc', 2, 'Read a document on the phone', 'Right-click a letter → <b>Keep a copy on my phone</b>, then Phone app → Save inventory for phone, and load it in Capture. It should be under My inventory → 📄 Documents.'],
    ['scan', 2, 'Scan a paper letter', 'Capture → 📄 Scan a document, take one page, export, import on the PC. It should arrive in Documents as a PDF.'],
    ['room', 2, 'Scan a room (optional)', 'Capture → Scan a room, point at a TV or laptop. Draft items should appear. The first time downloads about 15 MB.'],
    ['reminder', 0, 'Reminders while closed (optional, takes a day)', 'Settings → Keep reminders running. With something due in the next 7 days, a Windows notification should appear once a day, even with OpenSafe closed.'],
    ['twopc', 3, 'Two PCs (only if you have a second PC)', 'Choose the same OneDrive folder on both under Import & backup → Two PCs. Add an item on one; once OneDrive has copied it (usually a few minutes), it should appear on the other.']
  ];
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* not kept */ } };
  function newsBanner() {
    const v = state.snap.version, seen = lsGet('seenVersion', null);
    if (seen === v) return '';
    if (seen === null) { lsSet('seenVersion', v); return ''; } // first run: nothing "new" yet
    const n = NEWS.find(x => v && v.startsWith(x[0].replace('.x', '')));
    return `<div class="card sugbar newsbar">${icon('bell')}<span><b>OpenSafe was updated to ${esc(v)}</b>${n ? `: ${esc(n[1])}` : ''}.</span><span class="spacer"></span><button class="btn small primary" data-action="newsOpen">What's new</button><button class="btn small ghost" data-action="newsHide">Hide</button></div>`;
  }
  function viewHelp() {
    const done = lsGet('checks', {});
    const n = CHECKS.filter(c => done[c[0]]).length;
    return `<div class="head"><h1>Help and what's new</h1><span class="sub">OpenSafe ${esc(state.snap.version || '')}</span><span class="spacer"></span><button class="btn" data-action="helpGuide">${icon('help')}Full guide (opens GitHub)</button></div>
    <div class="grid g2 helpgrid">
      <div class="card"><h2>${icon('bell')}What's new</h2>
        ${NEWS.map(([ver, title, lines]) => `<div class="news"><div class="nv"><span class="pill">${esc(ver)}</span> <b>${esc(title)}</b></div><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul></div>`).join('')}</div>
      <div class="card"><h2>${icon('help')}Finding your way</h2><ul class="helplist">
        <li><b>Search everything</b> (top left) finds items, letters and files, and the words inside them.</li>
        <li><b>Right-click</b> an item, document, file or place for what you can do with it.</li>
        <li><b>Drag</b> items onto places, or documents between Documents and Data; tick several first to move them together.</li>
        <li><b>+ New</b> (bottom left) adds an item, document, files, packing list or policy from any page.</li>
        <li><b>More ▾</b> on each page holds the less-used actions.</li>
        <li>Your data stays on this PC. Only barcode look-ups, recall checks, currency rates and updates use the internet.</li></ul>
        <h2 style="margin-top:14px">${icon('shield')}Keeping it safe</h2><ul class="helplist">
        <li>Turn on <b>password protection</b> (Settings) and keep the recovery key somewhere safe.</li>
        <li>Set up <b>Automatic backups</b> to OneDrive or a USB stick (Import & backup).</li></ul></div>
    </div>
    <div class="card" style="margin-top:16px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">${icon('check')}Check it on your own PC and phone</h2><span class="pill checkcount ${n === CHECKS.length ? 'good' : ''}">${n} of ${CHECKS.length} done</span><span class="spacer"></span>
        <button class="btn small" data-action="checksCopy">${icon('copy')}Copy results</button><button class="btn small ghost" data-action="checksReset">Clear ticks</button></div>
      <p class="muted">These were tested on test machines, not on your own devices. The first five take about 7 minutes on this PC; the phone ones need your phone. If something doesn't happen as described, untick it, write what you saw, and use <b>Copy results</b> to paste it to whoever is helping you.</p>
      <div class="checks">${CHECKS.map(([id, mins, title, how]) => `<div class="checkrow ${done[id] ? 'done' : ''}"><label class="switch"><input type="checkbox" data-action="checkTick" data-id="${id}" ${done[id] ? 'checked' : ''}><span><b>${esc(title)}</b>${mins ? ` <span class="faint">· about ${mins} min</span>` : ''}<br><span class="muted">${how}</span></span></label>
        <input class="checknote" data-check="${id}" placeholder="What happened? (optional)" value="${esc(lsGet('checkNotes', {})[id] || '')}"></div>`).join('')}</div></div>`;
  }

  function viewSearch() {
    const q = state.gq || '', r = state.gres || { items: [], library: [] };
    if (q.length < 2) return `<div class="head"><h1>Search</h1></div><div class="card empty">Type in the search box at the top of the menu to search your items, the words in their receipts and manuals, Documents and Data.</div>`;
    const items = r.items.map(x => Object.assign({ a: asset(x.id) }, x)).filter(x => x.a);
    const libs = r.library.map(x => Object.assign({ e: libEntry(x.id) }, x)).filter(x => x.e);
    const docs = libs.filter(x => x.e.kind === 'document'), data = libs.filter(x => x.e.kind === 'data');
    const total = items.length + libs.length;
    const mark = (t) => { let h = esc(t); for (const w of q.toLowerCase().split(/\s+/).filter(x => x.length > 1)) h = h.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`); return h; };
    const section = (title, ico, list, row, more) => list.length ? `<div class="card srch"><h2>${icon(ico)}${title} <span class="faint">(${list.length})</span><span class="spacer"></span>${more}</h2><div class="rows">${list.slice(0, 8).map(row).join('')}</div>${list.length > 8 ? `<p class="meta" style="margin:8px 0 0">${list.length - 8} more…</p>` : ''}</div>` : '';
    return `<div class="head"><h1>Search</h1><span class="sub">${total ? `${total} result${total === 1 ? '' : 's'} for "${esc(q)}"` : `Nothing found for "${esc(q)}"`}</span></div>
      ${!total ? `<div class="card empty">Nothing matches "<b>${esc(q)}</b>". Search looks through item details, the words in their receipts and manuals, and Documents and Data (including the words inside letters, PDFs and emails). Words still being read can't be found yet.</div>` : ''}
      <div class="srchgrid">
      ${section('Items', 'box', items, x => `<div class="rowi" data-open="${x.a.id}">${thumb(x.a)}<span style="flex:1;min-width:0"><b>${mark(x.a.name)}</b><div class="meta">${esc([x.a.category, x.a.location].filter(Boolean).join(' · '))}</div>${x.snippet ? `<div class="meta snippet">In ${esc(x.inDoc)}: …${mark(x.snippet)}…</div>` : ''}</span>${icon('chevron')}</div>`, `<button class="btn small" data-action="srchItems">Show in Items</button>`)}
      ${section('Documents', 'letter', docs, x => `<div class="rowi" data-action="libOpen" data-lib="${esc(x.e.id)}">${libThumb(x.e)}<span style="flex:1;min-width:0"><b>${mark(x.e.title)}</b><div class="meta">${esc([x.e.docType, x.e.from, x.e.docDate && ukDate(x.e.docDate)].filter(Boolean).join(' · '))}</div>${x.snippet ? `<div class="meta snippet">…${mark(x.snippet)}…</div>` : ''}</span>${icon('chevron')}</div>`, `<button class="btn small" data-action="srchLib" data-page="docs">Show in Documents</button>`)}
      ${section('Data', 'folder', data, x => `<div class="rowi" data-action="libOpen" data-lib="${esc(x.e.id)}">${libThumb(x.e)}<span style="flex:1;min-width:0"><b>${mark(x.e.title)}</b><div class="meta">${esc([x.e.folder, x.e.from].filter(Boolean).join(' · '))}</div>${x.snippet ? `<div class="meta snippet">…${mark(x.snippet)}…</div>` : ''}</span>${icon('chevron')}</div>`, `<button class="btn small" data-action="srchLib" data-page="files">Show in Data</button>`)}
      </div>`;
  }

  // ---------- reading a file inside OpenSafe ----------
  const vstate = { id: '', fileId: '', model: null, zoom: 1, sheet: 0, obs: null, pageImgs: {} };
  const VMAX = 920; // page width at 100%
  async function libViewOpen(id, fileId) {
    const e = libEntry(id); if (!e) return;
    Object.assign(vstate, { id, fileId, model: null, zoom: 1, sheet: 0, pageImgs: {} });
    const v = $('#viewer'); v.classList.remove('hidden'); document.body.classList.add('viewing');
    v.innerHTML = `<div class="vbody"><div class="vmsg">${icon('file')}Opening…</div></div>`;
    libViewBar();
    try { vstate.model = await keep.libView(id, fileId); }
    catch (err) { $('#viewer .vbody').innerHTML = `<div class="vmsg">${icon('alert')}${esc(err.message || 'Couldn\'t open this file.')}</div>`; return; }
    if (vstate.fileId !== fileId) return; // moved on meanwhile
    libViewBar(); libViewBody();
  }
  function libViewClose() { const v = $('#viewer'); if (vstate.obs) vstate.obs.disconnect(); v.classList.add('hidden'); v.innerHTML = ''; document.body.classList.remove('viewing'); vstate.model = null; vstate.id = ''; }
  function libViewBar() {
    const e = libEntry(vstate.id); if (!e) return;
    const f = e.files.find(x => x.id === vstate.fileId) || { name: '' }, i = e.files.indexOf(f), m = vstate.model;
    const zoomable = m && (m.kind === 'pdf' || m.kind === 'image');
    const bar = `<div class="vbar">
      <button class="btn ghost" data-action="libViewClose" title="Close (Esc)">${icon('back')}Back</button>
      <div class="vtitle"><b class="ell">${esc(f.name)}</b><span class="meta ell">${esc(e.title)}${m && m.kind === 'pdf' ? ` · ${m.pages.length} page${m.pages.length === 1 ? '' : 's'}` : ''}</span></div>
      ${e.files.length > 1 ? `<span class="vnav"><button class="btn small" data-action="libViewFile" data-step="-1" ${i <= 0 ? 'disabled' : ''} title="Previous file">‹</button><span class="meta">File ${i + 1} of ${e.files.length}</span><button class="btn small" data-action="libViewFile" data-step="1" ${i >= e.files.length - 1 ? 'disabled' : ''} title="Next file">›</button></span>` : ''}
      ${zoomable ? `<span class="vnav"><button class="btn small" data-action="libViewZoom" data-z="-1" title="Smaller">−</button><span class="meta vz">${Math.round(vstate.zoom * 100)}%</span><button class="btn small" data-action="libViewZoom" data-z="1" title="Bigger">+</button><button class="btn small" data-action="libViewZoom" data-z="0">Fit</button></span>` : ''}
      <span class="spacer"></span>
      <button class="btn small" data-action="libFileCopy" data-file="${esc(f.id)}">${icon('download')}Save a copy…</button>
      <button class="btn small" data-action="libFileOpen" data-file="${esc(f.id)}" title="Open it in Word, your PDF app, your email program…">${icon('upload')}Open in another app</button></div>`;
    const old = $('#viewer .vbar');
    if (old) old.outerHTML = bar; else $('#viewer').insertAdjacentHTML('afterbegin', bar);
  }
  // a document shown in a sandbox: no scripts, nothing from the internet (the window's security policy applies to it too)
  function sandboxFrame(html, page) {
    const css = `<style>html{background:${page ? '#e9ecea' : '#fff'}}body{font:15px/1.55 "Segoe UI",system-ui,sans-serif;color:#1d1d1b;margin:0;padding:${page ? '28px 0' : '18px 22px'};overflow-wrap:anywhere}
      ${page ? '.pg{background:#fff;max-width:760px;margin:0 auto;padding:56px 64px;box-shadow:0 2px 12px rgba(0,0,0,.12);min-height:600px}' : ''}
      img{max-width:100%;height:auto} table{border-collapse:collapse;max-width:100%} td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top} a{color:#1d6b62}</style>`;
    return `<iframe class="vframe" sandbox="allow-same-origin" referrerpolicy="no-referrer" srcdoc="${esc('<!doctype html><meta charset="utf-8">' + css + (page ? '<div class="pg">' + html + '</div>' : html))}"></iframe>`;
  }
  function fitFrame(fr) {
    const fit = () => { try { const d = fr.contentDocument; if (!d) return; fr.style.height = Math.max(200, d.documentElement.scrollHeight + 4) + 'px';
      // links: ask before opening them in your web browser
      d.addEventListener('click', (ev) => { const a = ev.target.closest && ev.target.closest('a[href]'); if (!a) return; ev.preventDefault(); const href = a.getAttribute('href') || ''; if (/^(https?|mailto):/i.test(href)) keep.openLink(href).catch(() => {}); }, true);
      for (const im of d.images) im.addEventListener('load', () => { fr.style.height = Math.max(200, d.documentElement.scrollHeight + 4) + 'px'; }); } catch (_) { /* not ready */ } };
    fr.addEventListener('load', fit); fit();
  }
  function libViewBody() {
    const m = vstate.model, body = document.createElement('div'); body.className = 'vbody';
    const old = $('#viewer .vbody'); if (old) old.replaceWith(body); else $('#viewer').appendChild(body);
    if (!m) return;
    const note = m.note ? `<p class="vnote">${icon('alert')}${esc(m.note)}</p>` : '';
    if (m.kind === 'pdf') {
      body.innerHTML = `<div class="vpages">${m.pages.map((p, i) => `<div class="vpage" data-n="${i + 1}" data-ar="${(p.h / p.w).toFixed(5)}"><span class="pn">${i + 1}</span></div>`).join('')}</div>`;
      libViewLayout();
      if (vstate.obs) vstate.obs.disconnect();
      vstate.obs = new IntersectionObserver((ents) => { for (const en of ents) if (en.isIntersecting) libViewPage(en.target); }, { root: body, rootMargin: '600px 0px' });
      $$('.vpage', body).forEach(el => vstate.obs.observe(el));
    } else if (m.kind === 'image') {
      body.innerHTML = `<div class="vpages"><img class="vimg" src="${esc(m.url)}" alt=""></div>`;
      libViewLayout();
    } else if (m.kind === 'email') {
      body.innerHTML = `<div class="vmail"><div class="card vmhead"><h2>${esc(m.subject || '(no subject)')}</h2>
        ${[['From', m.from], ['To', m.to], ['Cc', m.cc], ['Date', m.date]].filter(x => x[1]).map(([k, v]) => `<div class="lkv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
        ${m.attachments.length ? `<div class="vatts">${m.attachments.map(a => `<span class="vatt">${icon(fileKind(a.name)[1])}<span class="ell" title="${esc(a.name)}">${esc(a.name)}</span><span class="faint">${fileSize(a.size)}</span>
          <span class="menuwrap"><button class="btn small" data-action="moreMenu">${icon('more')}</button><div class="menu hidden">
            <button data-action="libAttOpen" data-i="${a.index}">${icon('upload')}Open</button><button data-action="libAttSave" data-i="${a.index}">${icon('download')}Save a copy…</button><button data-action="libAttKeep" data-i="${a.index}">${icon('folder')}Keep in Data</button></div></span></span>`).join('')}</div>` : ''}
        ${m.remoteImages ? `<p class="vnote">${icon('lock')}${m.remoteImages} picture${m.remoteImages === 1 ? '' : 's'} from the internet ${m.remoteImages === 1 ? 'isn\'t' : 'aren\'t'} shown. OpenSafe never loads them, because they can tell the sender you opened the email.</p>` : ''}</div>
        ${m.html ? sandboxFrame(m.html, false) : `<pre class="libtext libmsg vtext">${esc(m.text)}</pre>`}</div>`;
      const fr = $('.vframe', body); if (fr) fitFrame(fr);
    } else if (m.kind === 'html') {
      body.innerHTML = note + sandboxFrame(m.html, true);
      fitFrame($('.vframe', body));
    } else if (m.kind === 'sheet') {
      const s = m.sheets[vstate.sheet] || { rows: [] };
      const cols = Math.max(1, ...s.rows.map(r => r.length));
      const letter = (n) => { let t = ''; n++; while (n) { const r = (n - 1) % 26; t = String.fromCharCode(65 + r) + t; n = (n - r - 1) / 26; } return t; };
      body.innerHTML = `${m.sheets.length > 1 ? `<div class="vtabs">${m.sheets.map((x, i) => `<button class="${i === vstate.sheet ? 'on' : ''}" data-action="libViewSheet" data-i="${i}">${esc(x.name)}</button>`).join('')}</div>` : ''}
        <div class="vsheet"><table><thead><tr><th></th>${Array.from({ length: cols }, (_, i) => `<th>${letter(i)}</th>`).join('')}</tr></thead><tbody>
        ${s.rows.map((r, ri) => `<tr><th>${ri + 1}</th>${Array.from({ length: cols }, (_, ci) => `<td>${esc(r[ci] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
        ${s.truncated ? '<p class="vnote">Only the first 1,000 rows are shown. Open it in Excel to see the rest.</p>' : ''}${!s.rows.length ? '<p class="vnote">This sheet is empty.</p>' : ''}</div>`;
    } else if (m.kind === 'text') {
      body.innerHTML = note + `<pre class="libtext libmsg vtext">${esc(m.text && m.text.trim() ? m.text : 'No text could be read from this file.')}</pre>`;
    } else {
      body.innerHTML = `<div class="vmsg">${icon('file')}<div>${esc(m.why || 'OpenSafe can\'t show this kind of file.')}</div><button class="btn primary" data-action="libFileOpen" data-file="${esc(vstate.fileId)}">${icon('upload')}Open in another app</button></div>`;
    }
  }
  function libViewWidth() { const b = $('#viewer .vbody'); return Math.max(200, Math.min(VMAX, (b ? b.clientWidth : 900) - 48)) * vstate.zoom; }
  function libViewLayout() {
    const w = libViewWidth();
    for (const el of $$('#viewer .vpage')) { el.style.width = w + 'px'; el.style.height = w * Number(el.dataset.ar) + 'px'; const im = el.querySelector('img'); if (im && Number(im.dataset.w) < w * (window.devicePixelRatio || 1) * 0.9) { im.remove(); delete vstate.pageImgs[el.dataset.n]; libViewPage(el); } }
    const im = $('#viewer .vimg'); if (im) im.style.width = vstate.zoom === 1 ? '' : (im.naturalWidth * vstate.zoom) + 'px', im.classList.toggle('fit', vstate.zoom === 1);
    const z = $('#viewer .vz'); if (z) z.textContent = Math.round(vstate.zoom * 100) + '%';
  }
  async function libViewPage(el) {
    const n = Number(el.dataset.n), key = vstate.fileId;
    if (el.querySelector('img') || vstate.pageImgs[n] === 'loading') return;
    const want = Math.round(parseFloat(el.style.width) * (window.devicePixelRatio || 1));
    vstate.pageImgs[n] = 'loading';
    try {
      const url = await keep.libPdfPage(vstate.id, key, n, want);
      if (vstate.fileId !== key || !el.isConnected) return;
      const im = document.createElement('img'); im.src = url; im.alt = `Page ${n}`; im.dataset.w = want; el.appendChild(im);
      vstate.pageImgs[n] = true;
    } catch (err) { vstate.pageImgs[n] = false; el.classList.add('bad'); el.dataset.err = String((err && err.message) || '').slice(0, 200); }
  }
  async function viewerAction(act) {
    const e = libEntry(vstate.id);
    switch (act.dataset.action) {
      case 'libViewClose': libViewClose(); return true;
      case 'libViewFile': { if (!e) return true; const i = e.files.findIndex(x => x.id === vstate.fileId) + Number(act.dataset.step); if (e.files[i]) libViewOpen(e.id, e.files[i].id); return true; }
      case 'libViewZoom': { const z = Number(act.dataset.z); const steps = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]; let i = steps.indexOf(vstate.zoom); if (i < 0) i = 3; vstate.zoom = z === 0 ? 1 : steps[Math.max(0, Math.min(steps.length - 1, i + z))]; libViewLayout(); return true; }
      case 'libViewSheet': vstate.sheet = Number(act.dataset.i); libViewBody(); return true;
      case 'libAttOpen': await run(() => keep.libMailAttachment(vstate.id, vstate.fileId, Number(act.dataset.i), 'open')); return true;
      case 'libAttSave': { const p = await run(() => keep.libMailAttachment(vstate.id, vstate.fileId, Number(act.dataset.i), 'save')); if (p) toast('✓ Attachment saved'); return true; }
      case 'libAttKeep': { const r = await run(() => keep.libMailAttachment(vstate.id, vstate.fileId, Number(act.dataset.i), 'data')); if (r && r.added) { toast('✓ Kept in Data, in the folder "Email attachments"', 4000); await refresh(); } else if (r && r.errors.length) toast(r.errors.join('; '), 6000); return true; }
    }
    return false;
  }

  // ---------- drop-down menus ----------
  function closeMenus() { $$('.menu').forEach(x => x.classList.add('hidden')); $$('.menuwrap.open').forEach(w => w.classList.remove('open')); $$('.menu.ctx').forEach(m => m.remove()); }
  function toggleMenu(btn) {
    const wrap = btn.closest('.menuwrap'), m = wrap && wrap.querySelector(':scope > .menu');
    if (!m) return;
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (!opening) return;
    m.classList.remove('hidden', 'up'); wrap.classList.add('open');
    // open upwards if there's no room below
    const r = m.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8 && btn.getBoundingClientRect().top > r.height + 16) m.classList.add('up');
    const first = m.querySelector('button'); if (first) first.focus({ preventScroll: true });
  }
  const dataAttrs = (d) => Object.entries(d || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  function menuItems(items) {
    return items.filter(Boolean).map(x => x === '-' ? '<hr>' : x.head ? `<div class="mh">${esc(x.head)}</div>`
      : `<button type="button" data-action="${esc(x.action)}"${dataAttrs(x.data)}${x.danger ? ' class="danger"' : ''}${x.disabled ? ' disabled' : ''}>${x.icon ? icon(x.icon) : ''}<span>${esc(x.label)}</span>${x.kbd ? `<span class="kbd">${esc(x.kbd)}</span>` : ''}</button>`).join('');
  }
  /** A filter chip: shows the current choice; its menu sets state.f[key]. */
  function chip(label, key, cur, options, def = '', noClear = false, action = 'setF') {
    const curOpt = options.find(o => o[0] === (cur || '')) || options[0];
    const on = (cur || '') !== def;
    return `<span class="menuwrap dd"><button type="button" class="chip ${on ? 'on' : ''}" data-action="moreMenu"><span class="k">${esc(label)}:</span> ${esc(curOpt[1].replace(/^[\u00a0└ ]+/, ''))}${on && !noClear ? `<span class="x" data-action="${action}" data-f="${esc(key)}" data-v="${esc(def)}" title="Clear">${icon('plus', 'xrot')}</span>` : icon('down', 'caret')}</button>
      <div class="menu hidden left scroll">${options.map(([v, l]) => `<button type="button" data-action="${action}" data-f="${esc(key)}" data-v="${esc(v)}" class="${v === (cur || '') ? 'cur' : ''}">${v === (cur || '') ? icon('check') : '<span class="ic"></span>'}<span>${esc(l)}</span></button>`).join('')}</div></span>`;
  }
  /** A button with a drop-down menu. items: [{ label, action, icon, data, danger, kbd } | '-' | { head }] */
  function dd(label, items, { cls = 'btn', align = 'right', iconName = '', title = '', scroll = false } = {}) {
    return `<span class="menuwrap dd"><button type="button" class="${cls} ddbtn" data-action="moreMenu"${title ? ` title="${esc(title)}"` : ''}>${iconName ? icon(iconName) : ''}${label ? `<span>${esc(label)}</span>` : ''}${icon('down', 'caret')}</button><div class="menu hidden${align === 'left' ? ' left' : ''}${scroll ? ' scroll' : ''}">${menuItems(items)}</div></span>`;
  }
  // keyboard: arrows move through an open menu, Esc closes it
  document.addEventListener('keydown', (e) => {
    const m = $$('.menu').find(x => !x.classList.contains('hidden'));
    if (!m) return;
    const btns = $$('button:not(:disabled)', m), i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length]; if (n) n.focus(); }
  }, true);

  // ---------- render ----------
  function render() {
    if (!state.snap) return;
    const navView = state.view === 'item' || state.view === 'bin' ? 'items' : state.view === 'libitem' ? libKindPage((libEntry(state.libId) || {}).kind) : state.view === 'case' ? 'docs' : state.view;
    $$('.side [data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === navView));
    const v = $('#view');
    const pageKey = [state.view, state.itemId, state.libId].join('|');
    if (pageKey !== state.lastPageKey) { state.lastPageKey = pageKey; v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter'); }
    else v.classList.remove('enter');
    const views = { dashboard: viewDashboard, items: viewItems, item: viewItem, reminders: viewReminders, phone: viewPhone, reports: viewReports, settings: viewSettings, vault: viewVault, policies: viewPolicies, bin: viewBin, trips: viewTrips, places: viewPlaces, data: viewData, docs: () => viewLibrary('docs'), files: () => viewLibrary('files'), libitem: viewLibItem, search: viewSearch, help: viewHelp, case: viewCase };
    v.innerHTML = (views[state.view] || viewDashboard)();
    if (state.view === 'phone') { loadCapture(); loadPhone(); const d = $('#wifiDetails'); if (d) d.ontoggle = () => { state.wifiOpen = d.open; }; }
    if (state.view === 'item') wireDrop();
    if (state.view === 'docs' || state.view === 'files') wireLibrary();
    if (state.view === 'libitem') loadLibItem();
    if (state.view === 'search') loadLibThumbs();
    if (state.view === 'items' && state.f.q.trim().length > 1 && (!state.itemHits || state.itemHits.q !== state.f.q.trim())) {
      const q = state.f.q.trim();
      keep.searchAll(q).then(r => { state.itemHits = { q, ids: new Set(r.items.map(x => x.id)), why: new Map(r.items.filter(x => x.snippet).map(x => [x.id, x])) }; if (state.view === 'items' && state.f.q.trim() === q && r.items.some(x => x.snippet)) { const qi = $('#q'), pos = qi && qi.selectionStart, had = document.activeElement === qi; render(); if (had) { const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); } } }).catch(() => {});
    }
    if (state.view === 'vault') wireVaultForm();
    if (state.view === 'reports') spendingCard();
    if (state.view === 'trips' && $('#extraForm')) $('#extraForm').onsubmit = async (e) => { e.preventDefault(); const v = e.target.text.value; if (!v.trim()) return; await run(() => keep.addTripExtra(state.tripId, v)); await refresh(); };
    if (state.view === 'settings' && !state.bg) keep.bgGet().then(b => { state.bg = b; if (state.view === 'settings' && $('#bgOn')) $('#bgOn').checked = b.enabled; }).catch(() => {});
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
    const locs = Object.entries(s.byLocation || {}).filter(([p]) => p !== 'No location').sort((a, b) => a[0].localeCompare(b[0], 'en-GB'));
    const recent = assets.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
    const rem = state.snap.reminders.slice(0, 6);
    const gapsN = { serial: s.noSerial, receipt: s.noReceipt, insurer: s.uninsured, photo: assets.filter(a => !INACTIVE.includes(a.status) && a.status !== 'Borrowed' && !a.photos.length).length };
    const topLocs = locs.filter(([p]) => p.split(' / ').length <= 2).slice(0, 8);
    return `<div class="head"><h1>Home</h1><span class="sub">${s.count} item${s.count === 1 ? '' : 's'}</span></div>
    ${newsBanner()}
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card stat"><div class="lbl">Value now</div><div class="num">${money0(s.currentTotal)}</div><div class="foot">${s.estimatedCount ? `${s.estimatedCount} estimated; price paid where no value is set` : 'Price paid where no value is set'}</div></div>
      <div class="card stat"><div class="lbl">Total paid</div><div class="num">${money0(s.purchaseTotal)}</div><div class="foot">For the things you have now</div></div>
      <div class="card stat"><div class="lbl">Insured value</div><div class="num">${money0(s.insuredTotal)}</div><div class="foot">${s.uninsured ? `${s.uninsured} item${s.uninsured === 1 ? '' : 's'} with no insurer` : 'Everything has an insurer'}</div></div>
      <div class="card stat"><div class="lbl">Items</div><div class="num">${s.count}</div><div class="foot">${s.totalCount - s.count - (s.borrowedCount || 0)} sold, given away or lost${s.borrowedCount ? ` · ${s.borrowedCount} borrowed` : ''}</div></div>
    </div>
    <div class="dash">
      <div class="dash-main">
        <div class="card"><h2>${icon('bell')}Coming up<span class="spacer"></span><a href="#" class="meta" data-nav="reminders" style="font-weight:500">All reminders</a></h2>
          ${rem.length ? `<div class="rows">${rem.map(r => `<div class="rowi" ${r.libraryId ? `data-action="libOpen" data-lib="${esc(r.libraryId)}"` : r.policyId ? 'data-nav="policies"' : `data-open="${r.assetId}"`}>
              <span class="pill ${r.daysLeft < 0 ? 'bad' : 'warn'}">${esc(r.kind)}</span>
              <span style="flex:1">${esc(r.assetName)}</span><span class="meta nowrap">${dueText(r.daysLeft)}</span></div>`).join('')}</div>`
            : '<div class="muted">Nothing due in the next ' + state.snap.data.settings.reminderDays + ' days.</div>'}</div>
        <div class="card"><h2>${icon('chart')}Value by category</h2>
          <div class="bars">${cats.map(([c, d]) => `
            <div class="barrow" data-action="filterCat" data-cat="${esc(c)}" title="${esc(c)}: ${money(d.value)} across ${d.count} item${d.count === 1 ? '' : 's'}">
              <span class="lab">${esc(c)} <span class="faint">(${d.count})</span></span>
              <span class="track"><span class="fill" style="width:${(d.value / max * 100).toFixed(1)}%;display:block"></span></span>
              <span class="v">${money0(d.value)}</span></div>`).join('')}</div></div>
        <div class="card"><h2>${icon('box')}Recently added<span class="spacer"></span><a href="#" class="meta" data-nav="items" style="font-weight:500">All items</a></h2>
          <div class="rows">${recent.map(a => `<div class="rowi" data-open="${a.id}">${thumb(a)}
            <div style="flex:1;min-width:0"><div class="name">${esc(a.name)}</div><div class="meta">${esc([a.category, a.location].filter(Boolean).join(' · '))}</div></div>
            ${a.source === 'phone' ? '<span class="pill acc">from phone</span>' : ''}<span class="meta nowrap">${ukDate(a.createdAt.slice(0, 10))}</span></div>`).join('')}</div></div>
        ${recallsCard()}
      </div>
      <div class="dash-side">
        <div class="card"><h2>${icon('check')}Gaps to fill</h2>
          ${[['serial', 'No serial number'], ['receipt', 'No receipt'], ['insurer', 'No insurer'], ['photo', 'No photo']].map(([k, l]) => `<div class="gap" ${gapsN[k] ? `data-action="gap" data-gap="${k}" style="cursor:pointer"` : ''}><span>${l}</span><span class="pill ${gapsN[k] ? 'warn' : 'good'}">${gapsN[k] || icon('check')}</span></div>`).join('')}</div>
        ${topLocs.length ? `<div class="card"><h2>${icon('pin')}Places<span class="spacer"></span><a href="#" class="meta" data-nav="places" style="font-weight:500">All places</a></h2><div class="rows">${topLocs.map(([p, d]) => `<div class="rowi" data-action="goPlace" data-place="${esc(p)}"><span style="flex:1">${esc(locLabel(p))}</span><span class="meta nowrap">${d.count} · ${money0(d.value)}</span></div>`).join('')}</div></div>` : ''}
        ${Object.keys(s.byOwner || {}).length ? `<div class="card"><h2>${icon('users')}Who owns what</h2><div class="rows">${Object.entries(s.byOwner).sort((x, y) => y[1].value - x[1].value).map(([p, v]) => `<div class="rowi" data-action="filterOwner" data-owner="${esc(p)}"><span style="flex:1">${esc(p)}</span><span class="meta">${v.count} · ${money0(v.value)}</span></div>`).join('')}</div><div class="faint" style="margin-top:6px">Items with no owner count as yours.</div></div>` : ''}
      </div>
    </div>`;
  }

  function filtered() {
    const f = state.f;
    const q = f.q.trim().toLowerCase();
    let list = state.snap.data.assets.filter(a => {
      if (f.status === 'active' && INACTIVE.includes(a.status)) return false;
      if (f.status && f.status !== 'active' && f.status !== 'all' && a.status !== f.status) return false;
      if (f.category && a.category !== f.category) return false;
      if (f.location && !inLoc(a.location, f.location)) return false;
      if (f.owner && a.owner !== f.owner) return false;
      if (f.gap === 'serial' && a.serial) return false;
      if (f.gap === 'receipt' && a.documents.some(d => d.type === 'Receipt')) return false;
      if (f.gap === 'insurer' && (a.insurer || a.policyId || !value(a))) return false;
      if (f.gap === 'photo' && a.photos.length) return false;
      if (f.gap && f.gap !== 'grab' && a.status === 'Borrowed') return false; // gaps are about your own things
      if (f.gap === 'grab' && !a.grab) return false;
      if (f.gap === 'noloc' && a.location) return false;
      if (q) {
        const d = a.details || {};
        const hay = [a.name, a.brand, a.model, a.serial, a.barcode, a.category, a.location, a.notes, a.supplier, a.tags.join(' '), a.lentTo, a.lentContact, a.soldTo, a.insurer, a.policyNumber,
          d.reg, d.vin, d.engineNo, d.boatName, d.hin, d.sso, d.mmsi, d.callSign, d.mooring].filter(Boolean).join(' ').toLowerCase();
        if (!q.split(/\s+/).every(w => hay.includes(w)) && !(state.itemHits && state.itemHits.q === f.q.trim() && state.itemHits.ids.has(a.id))) return false;
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
    const total = list.reduce((t, a) => t + (a.status === 'Borrowed' ? 0 : value(a)), 0); // borrowed things aren't yours
    const gapNames = { serial: 'no serial number', receipt: 'no receipt', insurer: 'no insurer', photo: 'no photo', noloc: 'no location set' };
    const chipsHtml = [
      chip('Category', 'category', f.category, [['', 'All categories'], ...d.categories.map(c => [c, c])]),
      (state.snap.data.people || []).length ? chip('Owner', 'owner', f.owner || '', [['', 'Everyone'], ...state.snap.data.people.map(p => [p, p])]) : '',
      chip('Place', 'location', f.location, [['', 'All places'], ...locPaths().map(c => [c, locLabel(c)])]),
      chip('Status', 'status', f.status, [['active', 'Active items'], ['all', 'All statuses'], ...state.snap.lists.statuses.map(x => [x, x])], 'active'),
      chip('Sort', 'sort', f.sort, [['added', 'Newest first'], ['name', 'Name A–Z'], ['value', 'Highest value'], ['bought', 'Recently bought'], ['category', 'Category']], 'added', true)
    ].join('');
    const toolbar = `<div class="toolbar">
      <div class="sidesearch libsearch itemsearch">${icon('search')}<input type="search" id="q" placeholder="Search name, serial, barcode, reg, who has it, notes…" value="${esc(f.q)}"></div>
      <div class="chips">${chipsHtml}</div>
    </div>
    ${f.gap ? `<div style="margin:-4px 0 12px"><span class="pill warn">${f.gap === 'grab' ? 'Showing the grab list' : `Showing items with ${gapNames[f.gap]}`}</span> <button class="btn small" data-action="clearGap">Clear</button></div>` : ''}`;
    const binN = (state.snap.data.bin || []).length;
    const head = `<div class="head"><h1>Items</h1><span class="sub">${list.length} shown · ${money0(total)}</span><span class="spacer"></span>
      ${dd('More', [{ head: 'Tidy up' }, { label: 'Find duplicates…', action: 'findDupes', icon: 'duplicate' }, { label: binN ? `Deleted items (${binN})` : 'Deleted items', action: 'goBin', icon: 'trash' }, '-', { head: 'Import and export' },
        { label: 'Import from a spreadsheet…', action: 'csvPick', icon: 'sheet' }, { label: 'Import from phone…', action: 'importPick', icon: 'phone' }, { label: 'Export to a spreadsheet (CSV)…', action: 'csv', icon: 'download' }, '-',
        { head: 'Print' }, { label: 'Inventory report…', action: 'goReports', icon: 'printer' }, { label: 'QR labels for items shown…', action: 'labelsShown', icon: 'qr' }], { iconName: 'more' })}
      <span class="seg"><button data-layout="table" class="${f.layout === 'table' ? 'on' : ''}" title="List">${icon('sheet')}List</button><button data-layout="grid" class="${f.layout === 'grid' ? 'on' : ''}" title="Photos">${icon('image')}Photos</button></span>
      <button class="btn primary" data-action="new">${icon('plus')}Add item</button></div>`;
    if (!list.length) return head + toolbar + `<div class="card empty">${d.assets.length ? 'No items match these filters.' : 'No items yet. Add one here or from your phone.'}</div>`;
    if (f.layout === 'grid') {
      return head + toolbar + `<div class="cards">${list.map(a => `<div class="icard" data-open="${a.id}" draggable="true">
        <div class="img">${cover(a) ? `<img src="${img(a, cover(a))}" alt="" loading="lazy">` : '▣'}</div>
        <div class="body"><div class="name">${esc(a.name)}</div><div class="meta">${esc(a.category || '')}</div><div class="val">${value(a) ? money(value(a)) : '<span class="faint">No value</span>'}</div></div></div>`).join('')}</div>`;
    }
    const ids = list.map(a => a.id);
    for (const id of [...state.sel]) if (!state.snap.data.assets.some(a => a.id === id)) state.sel.delete(id);
    const allOn = ids.length && ids.every(id => state.sel.has(id));
    const selBar = state.sel.size ? `<div class="selbar"><b>${state.sel.size} selected</b>${dd('Move to', [{ head: 'Move to a place' }, ...locPaths().map(p => ({ label: locLabel(p), action: 'moveSel', icon: p.includes(' / ') ? '' : 'pin', data: { loc: p } })), '-', { label: 'New place…', action: 'moveSelNew', icon: 'plus' }], { cls: 'btn primary small', iconName: 'pin', scroll: true, align: 'left' })}<button class="btn small" data-action="bulkSel">Change…</button><button class="btn small" data-action="claimSel">Claim pack…</button><button class="btn small" data-action="labelsSel">QR labels…</button><button class="btn small danger" data-action="deleteSel">Delete…</button><button class="btn small" data-action="selClear">Clear selection</button></div>` : '';
    const placeLink = f.location ? `<div class="meta" style="margin:-6px 0 12px">Showing items in <b>${esc(f.location)}</b> and anything inside it · <a href="#" data-action="goPlace" data-place="${esc(f.location)}">Photos, videos and label for this place</a></div>` : '';
    return head + toolbar + placeLink + selBar + `<table class="list"><thead><tr><th style="width:34px"><input type="checkbox" class="selall" title="Select all shown" ${allOn ? 'checked' : ''}></th><th style="width:60px"></th><th>Item</th><th>Category</th><th>Location</th><th>Serial no.</th><th>Bought</th><th class="r">Value now</th><th></th></tr></thead><tbody>
      ${list.map(a => `<tr data-open="${a.id}" draggable="true" class="${state.sel.has(a.id) ? 'sel' : ''}" title="Drag onto a place to move it; right-click for more"><td><input type="checkbox" class="selbox" data-id="${a.id}" ${state.sel.has(a.id) ? 'checked' : ''} aria-label="Select ${esc(a.name)}"></td><td>${thumb(a)}</td>
        <td><div class="name">${esc(a.name)}${partsOf(a.id).length ? ` <span class="pill">Set of ${partsOf(a.id).length + 1}</span>` : ''}</div>${state.itemHits && state.itemHits.q === f.q.trim() && state.itemHits.why.has(a.id) ? `<div class="meta snippet">In ${esc(state.itemHits.why.get(a.id).inDoc)}: …${esc(state.itemHits.why.get(a.id).snippet)}…</div>` : ''}<div class="meta">${esc([a.brand, a.model].filter(Boolean).join(' '))}${a.partOf && asset(a.partOf) ? `${a.brand || a.model ? ' · ' : ''}Part of ${esc(asset(a.partOf).name)}` : ''}</div></td>
        <td>${esc(a.category)}</td><td>${esc(a.location)}</td><td class="mono">${esc(a.serial) || '<span class="faint">—</span>'}</td>
        <td class="nowrap">${ukDate(a.purchaseDate)}</td><td class="r nowrap">${value(a) ? money(value(a)) : '—'}</td>
        <td>${vaultPill(a)}${a.status !== 'Owned' ? `<span class="pill">${esc(a.status)}</span>` : ''}${a.source === 'phone' ? '<span class="pill acc">phone</span>' : ''}${warrantyPill(a).includes('warn') ? warrantyPill(a) : ''}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function itemVaultBtn(a) {
    const sec = state.snap.security;
    if (!sec.vault.exists) return '';
    if (a.inVault) return '<button class="btn" data-action="vaultOut">Move out of vault</button>';
    return `<button class="btn" data-action="vaultIn">${icon('lock')}Move to vault</button>`;
  }
  function fileVaultBtn(a, r, isDoc) {
    const sec = state.snap.security;
    if (!sec.vault.exists || a.inVault) return '';
    const cls = isDoc ? 'btn small' : '';
    return r.vaultFile ? `<button class="${cls}" data-action="fileVaultOut" data-att="${r.id}">Out of vault</button> ` : `<button class="${cls}" data-action="fileVaultIn" data-att="${r.id}">🔒 To vault</button> `;
  }

  const partsOf = (id) => state.snap.data.assets.filter(x => x.partOf === id);
  function setCard(a) {
    if (a.partOf) {
      const main = asset(a.partOf);
      return `<div class="card" style="margin-top:14px"><h2>Part of a set</h2>${main ? `<div class="rows"><div class="rowi" data-open="${main.id}">${thumb(main)}<span style="flex:1"><b>${esc(main.name)}</b></span><span class="meta">${partsOf(main.id).length + 1} items in the set</span></div></div>` : '<div class="muted">The main item is in the locked vault.</div>'}</div>`;
    }
    const parts = partsOf(a.id);
    if (!parts.length) return `<div class="card sidecard"><div class="dsec-h">Set</div><p class="muted">Group what goes with it, like batteries and a charger. Claim packs include them all.</p><button class="btn small" data-action="pickParts">${icon('plus')}Add parts…</button></div>`;
    const total = parts.reduce((t, x) => t + value(x), value(a));
    return `<div class="card" style="margin-top:14px"><h2 style="display:flex;align-items:center">Parts in this set (${parts.length})<span class="spacer"></span><span class="meta" style="font-weight:500;margin-right:10px">Whole set: ${money(total)}</span><button class="btn small" data-action="pickParts">Change parts…</button></h2>
      <div class="rows">${parts.map(x => `<div class="rowi" data-open="${x.id}">${thumb(x)}<span style="flex:1"><b>${esc(x.name)}</b> <span class="meta">${esc([x.brand, x.model].filter(Boolean).join(' '))}</span>${x.serial ? ` <span class="mono meta">${esc(x.serial)}</span>` : ''}</span><span class="meta">${value(x) ? money(value(x)) : ''}</span></div>`).join('')}</div></div>`;
  }
  function valueCard(a) {
    const h = (a.valueHistory || []).map((v, i) => Object.assign({ i }, v)).sort((x, y) => y.date.localeCompare(x.date) || y.i - x.i); // newest first; same day: latest added first
    const paid = a.purchasePrice !== null && a.purchasePrice !== undefined && a.purchaseDate ? { date: a.purchaseDate, value: a.purchasePrice } : null;
    if (!h.length) return `<div class="card sidecard"><div class="dsec-h">Value history</div><p class="muted">Each change of value is recorded here with the date. Add a valuation from a jeweller or dealer.</p><button class="btn small" data-action="addValuation">${icon('plus')}Add valuation…</button></div>`;
    return `<div class="card" style="margin-top:14px"><h2 style="display:flex;align-items:center">Value history<span class="spacer"></span><button class="btn small" data-action="addValuation">Add valuation…</button></h2>
      <table class="list"><thead><tr><th>Date</th><th class="r">Value</th><th class="r">Change</th><th>Note</th><th></th></tr></thead><tbody>
      ${h.map((v, i) => { const prev = h[i + 1] || paid; const ch = prev ? v.value - prev.value : null; return `<tr><td class="nowrap">${ukDate(v.date)}</td><td class="r nowrap">${money(v.value)}</td><td class="r nowrap ${ch < 0 ? 'neg' : ''}">${ch === null || ch === 0 ? '' : (ch > 0 ? '+' : '−') + money(Math.abs(ch))}</td><td>${esc(v.note)}</td><td class="r"><button class="btn small danger" data-action="rmValuation" data-vid="${v.id}">Delete</button></td></tr>`; }).join('')}
      ${paid ? `<tr class="faint"><td class="nowrap">${ukDate(paid.date)}</td><td class="r nowrap">${money(paid.value)}</td><td></td><td>Price paid</td><td></td></tr>` : ''}
      </tbody></table></div>`;
  }
  function valuationForm(a) {
    openModal(`<form class="dialog narrow" id="valForm"><div class="dh"><h2>Add valuation</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">${esc(a.name)}. If this is the newest valuation, it becomes the item's value now.</p>
        <label class="f">Date<input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label class="f">Value (£)<input name="value" inputmode="decimal" placeholder="0.00"></label>
        <label class="f s3">Note<input name="note" maxlength="300" placeholder="e.g. Valued by the jeweller for insurance"></label>
        <div class="err" id="valErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Add</button></div></form>`);
    $('#valForm').onsubmit = async (e) => {
      e.preventDefault();
      busy(e.target, true, 'Saving…');
      try { await keep.addValuation(a.id, Object.fromEntries(new FormData(e.target).entries())); closeModal(); toast('✓ Valuation added'); await refresh(); }
      catch (ex) { $('#valErr').textContent = ex.message; busy(e.target, false); }
    };
  }

  function csvForm(r) {
    const fields = Object.entries(r.labels);
    openModal(`<form class="dialog wide" id="csvForm"><div class="dh"><h2>Import ${esc(r.name)}</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">${r.total} row${r.total === 1 ? '' : 's'}${r.capped ? ' (only the first 20,000 are read)' : ''}. Check what each column holds. Columns set to "Don't import" are left out. Dates are read the UK way, day first (14/03/2025).</p>
        <div class="s3" style="overflow:auto;max-height:52vh"><table class="list csvmap"><thead><tr><th>Column</th><th>First rows</th><th>Import as</th></tr></thead><tbody>
        ${r.headers.map((h, i) => `<tr><td><b>${esc(h)}</b></td><td class="meta">${r.sample.map(row => esc(String(row[i] ?? '').slice(0, 40))).filter(Boolean).join('<br>') || '<span class="faint">(empty)</span>'}</td>
          <td><select data-col="${i}">${opt('', "Don't import", r.mapping[i])}${fields.map(([k, l]) => opt(k, l, r.mapping[i])).join('')}</select></td></tr>`).join('')}
        </tbody></table></div>
        <label class="switch s3" style="font-weight:500"><input type="checkbox" name="skipDup" checked> Skip rows that are already in OpenSafe (same name and serial number, or same name, location and date bought)</label>
        <div class="err" id="csvErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Import</button></div></form>`);
    $('#csvForm').onsubmit = async (e) => {
      e.preventDefault();
      const mapping = [...document.querySelectorAll('#csvForm [data-col]')].map(sel => sel.value);
      const dup = mapping.filter(Boolean).find((f, i, arr) => arr.indexOf(f) !== i);
      if (!mapping.includes('name')) { $('#csvErr').textContent = 'Choose which column holds the item names.'; return; }
      if (dup) { $('#csvErr').textContent = `Two columns are set to "${r.labels[dup]}". Choose one.`; return; }
      busy(e.target, true, 'Importing…');
      try {
        const x = await keep.csvRun(mapping, { skipDuplicates: e.target.skipDup.checked });
        closeModal(); await refresh();
        openModal(`<div class="dialog narrow"><div class="dh"><h2>Spreadsheet imported</h2></div><div class="db"><p class="s3" style="margin:0"><b>${x.added}</b> item${x.added === 1 ? '' : 's'} added${x.duplicates ? `, <b>${x.duplicates}</b> already in OpenSafe so skipped` : ''}.</p>
          ${x.problemCount ? `<div class="s3"><p class="muted" style="margin:6px 0">Worth checking (${x.problemCount}):</p><ul class="s3 meta" style="margin:0;padding-left:18px">${x.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}</div>
          <div class="df"><button class="btn primary" data-action="close">OK</button></div></div>`);
      } catch (ex) { $('#csvErr').textContent = ex.message; busy(e.target, false); }
    };
  }

  function partsForm(a) {
    const chosen = new Set(partsOf(a.id).map(x => x.id));
    const candidates = state.snap.data.assets.filter(x => x.id !== a.id && !partsOf(x.id).length).sort((x, y) => x.name.localeCompare(y.name, 'en-GB'));
    openModal(`<form class="dialog" id="partsForm"><div class="dh"><h2>Parts of ${esc(a.name)}</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">Tick the items that belong with it. Each part keeps its own details, photos and serial number. Items with parts of their own aren't listed.</p>
        <input type="search" id="partsQ" class="s3" placeholder="Search…">
        <div class="s3 partlist">${candidates.map(x => { const other = x.partOf && x.partOf !== a.id ? asset(x.partOf) : null; return `<label class="partrow" data-name="${esc((x.name + ' ' + x.brand + ' ' + x.model + ' ' + x.serial).toLowerCase())}"><input type="checkbox" name="part" value="${x.id}" ${chosen.has(x.id) ? 'checked' : ''}> <span style="flex:1"><b>${esc(x.name)}</b> <span class="meta">${esc([x.category, x.location].filter(Boolean).join(' · '))}</span>${other ? ` <span class="pill">now part of ${esc(other.name)}</span>` : ''}</span></label>`; }).join('') || '<div class="muted">No other items yet.</div>'}</div>
        <div class="err" id="partsErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save parts</button></div></form>`);
    $('#partsQ').oninput = (e) => { const q = e.target.value.trim().toLowerCase(); for (const r of document.querySelectorAll('.partrow')) r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; };
    $('#partsForm').onsubmit = async (e) => {
      e.preventDefault();
      const ids = [...e.target.querySelectorAll('input[name=part]:checked')].map(i => i.value);
      busy(e.target, true, 'Saving…');
      try { const n = await keep.setParts(a.id, ids); closeModal(); toast(n ? `✓ ${n} part${n === 1 ? '' : 's'} in this set` : 'This item no longer has parts'); await refresh(); }
      catch (ex) { $('#partsErr').textContent = ex.message; busy(e.target, false); }
    };
  }

  function viewItem() {
    const a = asset(state.itemId);
    if (!a) { state.view = 'items'; return viewItems(); }
    const t = state.tab;
    const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${v || '<span class="faint">—</span>'}</div></div>`;
    const tabs = [['overview', 'Details'], ['photos', `Photos (${a.photos.length})`], ['docs', `Documents (${a.documents.length})`], ['service', `Service log (${a.service.length})`]];
    let body = '';
    if (t === 'overview') {
      // Only filled-in details are shown, in sections; the important missing ones are listed once.
      const row = (k, v) => v ? `<div><div class="k">${k}</div><div class="v">${v}</div></div>` : '';
      const section = (title, html) => html.trim() ? `<div class="dsec"><div class="dsec-h">${title}</div><div class="kv">${html}</div></div>` : '';
      const pol = (state.snap.data.policies || []).find(p => p.id === a.policyId);
      const web = a.webLink ? `<a href="#" data-action="openLink" title="${esc(a.webLink)}">${esc((() => { try { const u = new URL(a.webLink); return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname.slice(0, 24) + (u.pathname.length > 24 ? '…' : '') : ''); } catch (_) { return a.webLink; } })())}</a>` : '';
      const item = row('Category', esc(a.category)) + row('Brand', esc(a.brand)) + row('Model', esc(a.model)) + row('Serial number', a.serial ? `<span class="mono">${esc(a.serial)}</span>` : '')
        + row('Barcode', a.barcode ? `<span class="mono">${esc(a.barcode)}</span> <button class="btn small ghost" data-action="bcLookup">Look up</button>` : '') + row('Condition', esc(a.condition)) + row('Owner', esc(a.owner)) + row('Web page', web)
        + row('Tags', a.tags.map(x => `<span class="pill">${esc(x)}</span>`).join(''));
      const paid = a.purchasePrice !== null ? money(a.purchasePrice) + (a.foreignCurrency && a.foreignPrice !== null ? ` <span class="faint">(${esc(a.fxRate ? fxText(a) : fxMoney(a.foreignCurrency, a.foreignPrice))})</span>` : '') : a.foreignCurrency && a.foreignPrice !== null ? esc(fxMoney(a.foreignCurrency, a.foreignPrice)) : '';
      const nowV = a.currentValue !== null ? money(a.currentValue) : estimate(a) !== null ? `≈ ${money(estimate(a))} <span class="faint">estimated, ${state.snap.data.settings.depreciation[a.category]}% a year</span>` : '';
      const purchase = row('Bought on', a.purchaseDate ? ukDate(a.purchaseDate) : '') + row('Bought from', esc(a.supplier)) + row('Price paid', paid) + row('Value now', nowV) + row('Warranty until', a.warrantyExpiry ? ukDate(a.warrantyExpiry) + ' ' + warrantyPill(a) : '');
      const insurance = pol ? row('Insured by', `<a href="#" data-nav="policies">${esc(pol.insurer)}</a>${pol.type ? ' · ' + esc(pol.type) : ''}`) + row('Policy number', esc(pol.policyNumber)) + row('Insured value', a.insuredValue !== null ? money(a.insuredValue) : '')
        : row('Insurer', esc(a.insurer)) + row('Policy number', esc(a.policyNumber)) + row('Insured value', a.insuredValue !== null ? money(a.insuredValue) : '');
      const statusRows = a.status === 'Borrowed' ? row('Belongs to', esc(a.borrowedFrom)) + row('Their contact', esc(a.borrowedContact)) + row('Give back by', a.returnBy ? ukDate(a.returnBy) + dueSoon(a.returnBy) : '')
        : a.status === 'Lent out' ? row('Lent to', esc(a.lentTo)) + row('Contact', esc(a.lentContact)) + row('Lent on', a.lentDate ? ukDate(a.lentDate) : '') + row('Due back', a.dueBack ? ukDate(a.dueBack) + dueSoon(a.dueBack) : '')
        : a.status === 'Sold' ? row('Sold on', a.soldDate ? ukDate(a.soldDate) : '') + row('Sold for', a.soldPrice !== null && a.soldPrice !== undefined ? money(a.soldPrice) : '') + row('Sold to', esc(a.soldTo)) : '';
      const veh = a.details && a.details.kind ? DETAIL_UI[a.details.kind].map(([k, label, type]) => row(label, a.details[k] ? (type === 'date' ? ukDate(a.details[k]) + dueSoon(a.details[k]) : `<span class="${/vin|hin|engineNo|reg|sso|mmsi/.test(k) ? 'mono' : ''}">${esc(a.details[k])}</span>`) : '')).join('') : '';
      const missing = [[!a.serial, 'serial number'], [!a.purchaseDate, 'date bought'], [a.purchasePrice === null, 'price paid'], [!a.photos.length, 'photo'], [!a.documents.some(d => d.type === 'Receipt'), 'receipt'], [!a.policyId && !a.insurer, 'insurer']].filter(x => x[0]).map(x => x[1]);
      const hint = (() => { if (a.purchaseDate || (state.snap.data.dismissedHints || []).includes(a.id)) return ''; const d = a.photos.map(p => p.takenAt).filter(Boolean).sort()[0]; return d ? `<div class="card hintcard">${icon('camera')}<span style="flex:1">The first photo was taken on <b>${ukDate(d)}</b>. Use that as the date bought? It's only a guess.</span><button class="btn small primary" data-action="useDateHint" data-date="${d}">Use ${ukDate(d)}</button><button class="btn small ghost" data-action="dismissDateHint">No thanks</button></div>` : ''; })();
      body = `${hint}<div class="itemgrid"><div>
        <div class="card dcard">${section(a.status === 'Owned' ? 'Item' : esc(a.status), statusRows) + section('Item', item) + section('Purchase and value', purchase) + section('Insurance', insurance) + section(a.details && a.details.kind === 'boat' ? 'Boat' : 'Vehicle', veh)}
          ${a.notes ? `<div class="dsec"><div class="dsec-h">Notes</div><div class="notes" style="margin:0;padding:0;border:0">${esc(a.notes)}</div></div>` : ''}
          ${missing.length ? `<div class="missing">Missing: ${missing.join(', ')} · <a href="#" data-action="${missing.includes('photo') && missing.length === 1 ? 'pick' : 'edit'}" ${missing.includes('photo') && missing.length === 1 ? 'data-kind="photo"' : ''}>Add details</a></div>` : ''}</div>
        ${[setCard(a), valueCard(a)].filter(x => !x.includes('sidecard')).join('')}</div>
        <div class="sidecol">
          <div class="card"><div class="dsec-h">Where it is</div><div class="big">${a.location ? `<a href="#" data-action="goPlace" data-place="${esc(a.location)}">${esc(a.location)}</a>` : '<span class="faint">No location set</span>'}</div>
            <div class="dsec-h" style="margin-top:14px">Status</div><div>${esc(a.status)}${a.status === 'Lent out' && a.lentTo ? ` to ${esc(a.lentTo)}` : ''}</div>
            <div class="faint" style="margin-top:14px;font-size:12px">Added ${ukDate(a.createdAt.slice(0, 10))}${a.source === 'phone' ? ' from the phone' : ''} · changed ${ukDate(a.updatedAt.slice(0, 10))}</div></div>
          ${linkedDocsCard(a)}
          ${[setCard(a), valueCard(a)].filter(x => x.includes('sidecard')).join('')}
        </div></div>`;
    } else if (t === 'photos') {
      body = `<div class="drop" id="drop">Drag photos here, or <button class="btn small" data-action="pick" data-kind="photo">Choose photos…</button></div>
      ${a.photos.length ? `<div class="gallery">${a.photos.map((p, i) => p.locked ? `<div class="ph-tile locked" data-nav="vault"><div>${icon('lock')}<br>Vault photo<br><small>Unlock the vault to see it</small></div></div>` : `<div class="ph-tile">
        <img src="${img(a, p)}" alt="${esc(p.name)}" data-zoom="${img(a, p)}">
        ${i === 0 ? '<span class="pill acc coverflag">Cover</span>' : ''}${p.vaultFile ? `<span class="pill vault coverflag" style="left:auto;right:6px">${icon('lock')}Vault</span>` : ''}
        <div class="acts">${i ? `<button data-action="cover" data-att="${p.id}">Make cover</button>` : ''}<button data-action="ocr" data-file="${esc(p.file)}" title="Read a photo of a receipt">Read receipt</button><button data-action="ocrLabel" data-file="${esc(p.file)}" title="Read the serial and model number from a photo of the label">Read label</button>${fileVaultBtn(a, p)}<button data-action="rmAtt" data-att="${p.id}">Delete</button></div></div>`).join('')}</div>`
        : '<div class="empty">No photos yet. Photos of the item, its serial plate and its box all help with insurance claims.</div>'}`;
    } else if (t === 'docs') {
      body = `<div class="drop" id="drop">Drag receipts, manuals, warranty cards or videos here as
        <select id="docType" style="width:auto;min-width:120px;margin:0 6px">${state.snap.lists.docTypes.map(x => opt(x, x, 'Receipt')).join('')}</select>
        or <button class="btn small" data-action="pick" data-kind="document">Choose files…</button></div>
      ${a.documents.length ? `<table class="list"><thead><tr><th>Name</th><th>Type</th><th>Added</th><th></th></tr></thead><tbody>
        ${a.documents.map(d => d.locked ? `<tr><td colspan="3">${icon('lock')} <b>Vault file</b> <span class="muted">(unlock the vault to see its name and open it)</span></td><td class="r"><button class="btn small" data-nav="vault">Unlock vault</button></td></tr>`
        : `<tr><td data-action="openDoc" data-file="${esc(d.file)}" data-name="${esc(d.name)}"><b>${esc(d.name)}</b> ${d.vaultFile ? `<span class="pill vault">${icon('lock')}Vault</span>` : ''}</td><td><span class="pill ${d.type === 'Receipt' ? 'good' : ''}">${esc(d.type)}</span></td>
        <td>${ukDate(d.addedAt.slice(0, 10))}</td><td class="r nowrap"><button class="btn small" data-action="openDoc" data-file="${esc(d.file)}" data-name="${esc(d.name)}">Open</button> ${/\.(jpe?g|png|webp|gif)$/i.test(d.file) ? `<button class="btn small" data-action="ocr" data-file="${esc(d.file)}">Read receipt</button> <button class="btn small" data-action="ocrLabel" data-file="${esc(d.file)}">Read label</button> ` : ''}${fileVaultBtn(a, d, true)}<button class="btn small danger" data-action="rmAtt" data-att="${d.id}">Delete</button></td></tr>`).join('')}
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
    const vaultItem = state.snap.security.vault.exists ? (a.inVault ? `<button data-action="vaultOut">${icon('unlock')}Move out of the vault</button>` : `<button data-action="vaultIn">${icon('lock')}Move to the vault</button>`) : '';
    return `<div class="head"><button class="btn ghost" data-action="back">${icon('back')}Items</button><span class="spacer"></span>
      <button class="btn" data-action="newService" data-tab-go="service" title="Add a service or repair entry">${icon('wrench')}Log service</button>
      <span class="menuwrap"><button class="btn" data-action="moreMenu">${icon('more')}More</button>
        <div class="menu hidden">
          <button data-action="dup">${icon('duplicate')}Duplicate</button>
          <button data-action="labelOne">${icon('qr')}Print QR label…</button>
          <button data-action="claimOne">${icon('clipboard')}Insurance claim pack…</button>
          ${INACTIVE.includes(a.status) || a.status === 'Borrowed' ? '' : `<button data-action="sell">${icon('sell')}Sell…</button>`}
          ${vaultItem}<hr><button class="danger" data-action="del">${icon('trash')}Delete</button></div></span>
      <button class="btn primary" data-action="edit">${icon('edit')}Edit</button></div>
    ${a.inVault ? `<div class="note" style="margin-bottom:14px">${icon('lock')} This item is in the vault. It's hidden, and left out of totals and reports, whenever the vault is locked.</div>` : ''}
    <div class="detail-head">
      ${cover(a) ? `<img class="cover" src="${img(a, cover(a))}" data-zoom="${img(a, cover(a))}" alt="">` : `<div class="cover" data-tab="photos" title="Add photos">${icon('camera')}</div>`}
      <div style="flex:1;min-width:0"><h1>${esc(a.name)}</h1><div class="muted">${esc([[a.brand, a.model].filter(Boolean).join(' '), a.category].filter(Boolean).join(' · '))}</div>
        <div style="margin-top:10px">${recallsFor(a.id).length ? `<span class="pill bad" data-action="showRecalls" style="cursor:pointer">${icon('alert')}Possible product recall</span>` : ''}${a.grab ? `<span class="pill bad">${icon('fire')}Grab list</span>` : ''}${a.status !== 'Owned' ? `<span class="pill warn">${esc(a.status)}</span>` : ''}${warrantyPill(a)}${a.policyId || a.insurer ? `<span class="pill good">${icon('shield')}Insured</span>` : ''}</div></div>
      <div class="valuebox">${value(a) ? `<div class="lbl">${a.currentValue !== null ? 'Value now' : estimate(a) !== null ? 'Estimated value' : 'Price paid'}</div><div class="num">${money(value(a))}</div>` : '<div class="lbl">No value yet</div>'}${a.purchasePrice !== null && a.currentValue !== null ? `<div class="faint">Paid ${money(a.purchasePrice)}</div>` : ''}</div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${t === k ? 'on' : ''}">${l}</button>`).join('')}</div>${body}`;
  }

  function placeCard(place) {
    if (!place) return '';
    const e = (state.snap.data.places || {})[place];
    const files = e ? e.files : [];
    return `<div class="card"><h2 style="display:flex;align-items:center">${icon('video')}Photos and videos<span class="spacer"></span><button class="btn small" data-action="placeAdd" data-place="${esc(place)}">${icon('plus')}Add photos or videos…</button></h2>
      ${files.length ? `<div class="rows">${files.map(x => `<div class="rowi">${icon(x.kind === 'video' ? 'video' : 'image')}<span style="flex:1"><b>${esc(x.name)}</b> <span class="meta">${ukDate(x.addedAt.slice(0, 10))}</span></span>
        <button class="btn small" data-action="placeOpen" data-place="${esc(place)}" data-file="${esc(x.file)}" data-name="${esc(x.name)}">${x.kind === 'video' ? 'Play' : 'Open'}</button><button class="btn small danger" data-action="placeRm" data-place="${esc(place)}" data-fid="${x.id}">Delete</button></div>`).join('')}</div>`
      : '<div class="muted">A slow video of each room, opening cupboards and drawers, is good evidence for an insurance claim. Videos up to 1 GB, stored like your other files (encrypted if password protection is on).</div>'}</div>`;
  }

  const recallsFor = (id) => ((state.snap.data.recalls || {}).matches || []).filter(m => m.assetId === id);
  function recallRows(list) {
    return `<div class="rows">${list.map(m => `<div class="rowi" style="align-items:flex-start"><span class="pill ${m.risk === 'serious' || m.risk === 'high' ? 'bad' : 'warn'}">${esc(m.type === 'product-recall' ? 'Recall' : m.type === 'product-safety-alert' ? 'Safety alert' : 'Safety report')}${m.risk && m.risk !== 'not-provided' ? ' · ' + esc(m.risk) + ' risk' : ''}</span>
      <span style="flex:1"><b data-open="${m.assetId}" style="cursor:pointer">${esc(m.assetName)}</b><div class="meta">${esc(m.title)}${m.date ? ' · ' + ukDate(m.date) : ''}</div></span>
      <button class="btn small" data-action="openRecall" data-link="${esc(m.link)}">Read on GOV.UK</button><button class="btn small" data-action="dismissRecall" data-aid="${m.assetId}" data-link="${esc(m.link)}" title="Not my product">Not mine</button></div>`).join('')}</div>`;
  }
  function recallsCard() {
    const r = state.snap.data.recalls;
    const busyNow = state.recallBusy;
    return `<div class="card"><h2 style="display:flex;align-items:center">${icon('recall')}Product recalls<span class="spacer"></span><button class="btn small" data-action="checkRecalls" ${busyNow ? 'disabled' : ''}>${busyNow ? `Checking… ${busyNow}` : 'Check for recalls'}</button></h2>
      ${r ? (r.matches.length ? `<p class="muted" style="margin-top:0">Possible matches from the UK's product safety alerts, reports and recalls. Check each one against your item's exact model and batch.</p>${recallRows(r.matches)}`
        : `<div class="muted">No matches found for the ${r.checked} item${r.checked === 1 ? '' : 's'} checked on ${ukDate(r.checkedAt.slice(0, 10))}.</div>`) + (r.skipped ? `<div class="faint" style="margin-top:6px">${r.skipped} item${r.skipped === 1 ? '' : 's'} weren't checked because they have no model number.</div>` : '')
        : '<div class="muted">Checks the items that have a model number against the UK government\'s product safety alerts, reports and recalls (GOV.UK). Only the model numbers and brands are sent.</div>'}</div>`;
  }
  // The item with the most information: ticked by default as the one to keep.
  const richest = (ids) => ids.map(asset).filter(Boolean).map(x => ({ id: x.id, score: x.photos.length * 3 + x.documents.length * 3 + ['brand', 'model', 'serial', 'barcode', 'category', 'location', 'supplier', 'purchaseDate', 'warrantyExpiry', 'notes'].filter(k => x[k]).length + (x.purchasePrice !== null ? 1 : 0) + (x.currentValue !== null ? 1 : 0) + x.name.length / 100 })).sort((p, q) => q.score - p.score)[0]?.id;
  async function duplicatesView() {
    const groups = await run(() => keep.findDuplicates());
    if (!groups.length) { toast('No possible duplicates found'); return; }
    openModal(`<div class="dialog" id="dupDlg"><div class="dh"><h2>Possible duplicates (${groups.length})</h2></div>
      <div class="db" style="display:block">${groups.map((g, gi) => `<div class="card" style="margin-bottom:12px" data-group="${gi}"><h3 style="margin:0 0 6px">${esc(g.reason)}</h3>
        ${g.ids.map((id) => { const x = asset(id); return x ? `<label class="partrow"><input type="radio" name="keep${gi}" value="${id}" ${id === richest(g.ids) ? 'checked' : ''}> <span style="flex:1"><b>${esc(x.name)}</b> <span class="meta">${esc([x.brand, x.model, x.serial && 'S/N ' + x.serial, x.location, x.purchasePrice !== null ? money(x.purchasePrice) : '', x.purchaseDate && ukDate(x.purchaseDate)].filter(Boolean).join(' · '))} · ${x.photos.length} photo${x.photos.length === 1 ? '' : 's'}, ${x.documents.length} document${x.documents.length === 1 ? '' : 's'}</span></span></label>` : ''; }).join('')}
        <p style="margin:8px 0 0"><button class="btn small primary" data-action="dupMerge" data-gi="${gi}" data-ids="${g.ids.join(',')}">Merge into the ticked one</button> <button class="btn small" data-action="dupIgnore" data-ids="${g.ids.join(',')}">Not duplicates</button></p></div>`).join('')}
        <p class="muted">Merging moves photos, documents, the service log and value history to the ticked item, fills in any details it's missing, joins the notes, and sends the others to Deleted items (you can restore them for 30 days).</p></div>
      <div class="df"><button class="btn" data-action="close">Close</button></div></div>`);
  }
  async function spendingCard() {
    const el = $('#spendCard'); if (!el) return;
    const rows = await keep.spending();
    if (!rows.length) { el.innerHTML = '<h2>Spending by year</h2><div class="muted">Add prices and dates bought to see what you spent each year.</div>'; return; }
    const max = Math.max(1, ...rows.map(r => r.total));
    el.innerHTML = `<h2>Spending by year</h2><p class="muted" style="margin-top:0">What you paid for the things in OpenSafe, by the year you bought them (borrowed items left out).</p>
      <div class="bars">${rows.map(r => `<div class="barrow" title="${esc(r.top.map(t => `${t.category}: ${money(t.total)}`).join(', '))}"><span class="lab">${esc(r.year === 'Unknown' ? 'Date not known' : r.year)} <span class="faint">(${r.count})</span></span><span class="track"><span class="fill" style="width:${(r.total / max * 100).toFixed(1)}%;display:block"></span></span><span class="v">${money0(r.total)}</span></div>
        <div class="meta" style="margin:-4px 0 8px 2px">${esc(r.top.map(t => `${t.category} ${money0(t.total)}`).join(' · '))}</div>`).join('')}</div>`;
  }

  // ---------- packing lists ----------
  function viewTrips() {
    const trips = (state.snap.data.trips || []).slice().sort((x, y) => (y.startDate || y.createdAt).localeCompare(x.startDate || x.createdAt));
    const cur = trips.find(t => t.id === state.tripId) || trips[0];
    if (!cur) return `<div class="head"><h1>Packing lists</h1><span class="spacer"></span><button class="btn primary" data-action="tripNew">+ New packing list</button></div>
      <div class="card empty">Make a list for a trip (a bike tour, a camping weekend, a sailing trip) from the things in OpenSafe, plus anything else to take. Tick things off as you pack and again when you get home, here or on your phone, so nothing gets left behind.</div>`;
    state.tripId = cur.id;
    const rows = [...cur.items.map(i => ({ key: i.assetId, a: asset(i.assetId), packed: i.packed, back: i.back })).filter(r => r.a).sort((x, y) => (x.a.location || '').localeCompare(y.a.location || '') || x.a.name.localeCompare(y.a.name)), ...cur.extras.map(x => ({ key: x.id, text: x.text, packed: x.packed, back: x.back, extra: true }))];
    const packed = rows.filter(r => r.packed).length, back = rows.filter(r => r.back).length;
    const value = cur.items.reduce((t, i) => { const a = asset(i.assetId); return t + (a ? valueOf(a) : 0); }, 0);
    return `<div class="head"><h1>Packing lists</h1><select id="tripSel" style="margin-left:12px;width:auto;max-width:360px">${trips.map(t => opt(t.id, t.name + (t.startDate ? ` · ${ukDate(t.startDate)}` : ''), cur.id)).join('')}</select><span class="spacer"></span><button class="btn" data-action="tripNew">+ New packing list</button></div>
      <div class="card"><h2 style="display:flex;align-items:center;gap:8px">${esc(cur.name)}<span class="meta" style="font-weight:400">${cur.startDate ? ukDate(cur.startDate) : ''}${cur.endDate ? ' – ' + ukDate(cur.endDate) : ''}</span><span class="spacer"></span>
        <button class="btn small" data-action="tripPick">Choose items…</button><button class="btn small" data-action="tripEdit">Rename / dates…</button><button class="btn small" data-action="tripReset">Untick all</button><button class="btn small danger" data-action="tripDel">Delete</button></h2>
        <p class="muted" style="margin-top:0">${rows.length} thing${rows.length === 1 ? '' : 's'} · <b>${packed}</b> packed · <b>${back}</b> back home${value ? ` · items worth ${money0(value)}` : ''}. On the phone, load a new inventory file to take this list with you; ticks made on the phone stay on the phone.</p>
        ${rows.length ? `<table class="list"><thead><tr><th>Thing</th><th>Where it's kept</th><th class="c">Packed</th><th class="c">Back home</th><th></th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${r.extra ? esc(r.text) : `<a href="#" data-open="${r.a.id}"><b>${esc(r.a.name)}</b></a>${r.a.status !== 'Owned' && r.a.status !== 'Borrowed' ? ` <span class="pill warn">${esc(r.a.status)}</span>` : ''}`}</td><td class="meta">${r.extra ? '<span class="faint">not in OpenSafe</span>' : esc(r.a.location)}</td>
          <td class="c"><input type="checkbox" class="tick" data-key="${r.key}" data-which="packed" ${r.packed ? 'checked' : ''}></td><td class="c"><input type="checkbox" class="tick" data-key="${r.key}" data-which="back" ${r.back ? 'checked' : ''}></td>
          <td class="r">${r.extra ? `<button class="btn small" data-action="tripExtraRm" data-xid="${r.key}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">Nothing on the list yet. Use <b>Choose items…</b>, or add other things below.</div>'}
        <form id="extraForm" style="display:flex;gap:8px;margin-top:12px"><input name="text" placeholder="Something else to take, e.g. sun cream, passport, chargers (one per line works too)" style="flex:1"><button class="btn">Add</button></form></div>`;
  }
  const valueOf = (a) => a.status === 'Borrowed' ? 0 : value(a);
  function tripForm(t) {
    const others = (state.snap.data.trips || []).filter(x => !t || x.id !== t.id);
    openModal(`<form class="dialog narrow" id="tripForm"><div class="dh"><h2>${t ? 'Packing list' : 'New packing list'}</h2></div>
      <div class="db"><label class="f s3">Name<input name="name" maxlength="120" value="${esc(t ? t.name : '')}" placeholder="e.g. Ardennes tour"></label>
        <label class="f">From<input name="startDate" type="date" value="${esc(t ? t.startDate : '')}"></label><label class="f">To<input name="endDate" type="date" value="${esc(t ? t.endDate : '')}"></label>
        ${!t && others.length ? `<label class="f s3">Start from<select name="copyFrom">${opt('', 'An empty list', '')}${others.map(x => opt(x.id, 'A copy of ' + x.name, '')).join('')}</select></label>` : ''}
        <div class="err" id="tripErr"></div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    $('#tripForm').onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      if (t) v.id = t.id;
      busy(e.target, true, 'Saving…');
      try { const r = await keep.saveTrip(v); state.tripId = r.id; closeModal(); await refresh(); go('trips'); }
      catch (ex) { $('#tripErr').textContent = ex.message; busy(e.target, false); }
    };
  }
  function tripPicker(t) {
    const chosen = new Set(t.items.map(i => i.assetId));
    const list = state.snap.data.assets.filter(a => !INACTIVE.includes(a.status) && !a.inVault).sort((x, y) => (x.category || '').localeCompare(y.category || '') || x.name.localeCompare(y.name, 'en-GB'));
    openModal(`<form class="dialog" id="tripPickForm"><div class="dh"><h2>Things to take: ${esc(t.name)}</h2></div>
      <div class="db"><input type="search" id="tpQ" class="s3" placeholder="Search…">
        <div class="s3 partlist">${list.map(a => `<label class="partrow" data-name="${esc((a.name + ' ' + a.category + ' ' + a.location + ' ' + a.brand).toLowerCase())}"><input type="checkbox" value="${a.id}" ${chosen.has(a.id) ? 'checked' : ''}> <span style="flex:1"><b>${esc(a.name)}</b> <span class="meta">${esc([a.category, a.location].filter(Boolean).join(' · '))}</span></span></label>`).join('')}</div></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    $('#tpQ').oninput = (e) => { const q = e.target.value.trim().toLowerCase(); for (const r of document.querySelectorAll('#tripPickForm .partrow')) r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; };
    $('#tripPickForm').onsubmit = async (e) => { e.preventDefault(); await run(() => keep.setTripItems(t.id, [...e.target.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value)), 'Saved'); closeModal(); await refresh(); };
  }
  // ---------- selling an item ----------
  async function sellForm(a) {
    const l = await run(() => keep.listing(a.id));
    if (!l) return;
    openModal(`<div class="dialog"><div class="dh"><h2>Sell ${esc(a.name)}</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">A starting point for an advert on eBay, Facebook Marketplace or Gumtree, made from what OpenSafe knows. Edit it before you use it. Your notes, serial number and price paid aren't included.</p>
        <label class="f s3">Title <span class="faint" id="ttlLen"></span><input id="lsTitle" maxlength="200" value="${esc(l.title)}"></label>
        <label class="f s3">Description<textarea id="lsText" rows="14">${esc(l.text)}</textarea></label>
        <div class="s3" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-action="lsCopyTitle">Copy title</button><button class="btn" data-action="lsCopyText">Copy description</button>${a.photos.some(p => !p.vault) ? `<button class="btn" data-action="lsPhotos">Save ${a.photos.filter(p => !p.vault).length} photo${a.photos.filter(p => !p.vault).length === 1 ? '' : 's'} to a folder…</button>` : ''}</div>
        <p class="s3 faint" style="margin:0">When it's sold, edit the item and set its status to <b>Sold</b> (with the date, price and buyer) to keep a record.</p></div>
      <div class="df"><button class="btn" data-action="close">Close</button></div></div>`);
    const len = () => { const n = $('#lsTitle').value.length; $('#ttlLen').textContent = `${n} characters${n > 80 ? ' (eBay allows 80)' : ''}`; };
    $('#lsTitle').oninput = len; len();
  }

  function viewBin() {
    const b = state.snap.data.bin || [];
    return `<div class="head"><button class="btn" data-nav="items">← Items</button><h1 style="margin-left:8px">Deleted items</h1><span class="sub">Kept for 30 days, then deleted for good</span><span class="spacer"></span>${b.length ? '<button class="btn danger" data-action="binEmpty">Empty Deleted items</button>' : ''}</div>
      ${b.length ? `<table class="list"><thead><tr><th>Item</th><th>Category</th><th>Location</th><th>Deleted</th><th>Deleted for good in</th><th></th></tr></thead><tbody>
      ${b.map(x => `<tr><td><b>${esc(x.name)}</b> ${x.inVault ? `<span class="pill vault">${icon('lock')}Vault</span>` : ''}<div class="meta">${x.photos} photo${x.photos === 1 ? '' : 's'}, ${x.documents} document${x.documents === 1 ? '' : 's'}</div></td><td>${esc(x.category)}</td><td>${esc(x.location)}</td>
        <td class="nowrap">${ukDate(x.deletedAt.slice(0, 10))}</td><td class="nowrap">${x.daysLeft ? `${x.daysLeft} day${x.daysLeft === 1 ? '' : 's'}` : 'Today'}</td>
        <td class="r nowrap"><button class="btn small primary" data-action="binRestore" data-id="${x.id}">Restore</button> <button class="btn small danger" data-action="binPurge" data-id="${x.id}">Delete for good</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nothing here. Deleted items stay here for 30 days so you can restore them.</div>'}
      ${state.snap.security.vault.exists && !state.snap.security.vault.unlocked ? '<p class="faint" style="margin-top:12px">Items deleted from the vault are only shown while the vault is unlocked.</p>' : ''}`;
  }

  function viewReminders() {
    const r = state.snap.reminders;
    const over = r.filter(x => x.daysLeft < 0), soon = r.filter(x => x.daysLeft >= 0);
    const block = (title, list, cls) => `<div class="card" style="margin-bottom:16px"><h2>${title}</h2>${list.length ? `<div class="rows">${list.map(x => `
      <div class="rowi" ${x.libraryId ? `data-action="libOpen" data-lib="${esc(x.libraryId)}"` : x.policyId ? 'data-nav="policies"' : `data-open="${x.assetId}" data-opentab="${x.source === 'item' ? 'overview' : 'service'}"`}><span class="pill ${cls}">${esc(x.kind)}</span><span style="flex:1"><b>${esc(x.assetName)}</b></span>
      <span class="meta">${ukDate(x.date)}</span><span class="nowrap" style="width:130px;text-align:right">${dueText(x.daysLeft)}</span></div>`).join('')}</div>` : '<div class="muted">None.</div>'}</div>`;
    return `<div class="head"><h1>Reminders</h1><span class="sub">Warranties, service and MOT dates, things lent or borrowed, insurance renewals and letters to reply to, looking ${state.snap.data.settings.reminderDays} days ahead</span></div>
      ${block('Overdue', over, 'bad')}${block('Coming up', soon, 'warn')}`;
  }

  function viewPhone() {
    return `<div class="head"><h1>Phone app</h1></div>
    <p class="lead">OpenSafe Capture runs on your phone or tablet, with no internet needed. Use it to add items with photos, update things by scanning their QR labels, and carry a copy of your inventory.</p>
    <div class="tiles">
      <div class="card tile"><h2>${icon('phone')}Install OpenSafe Capture</h2>
        <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
          <div class="qr qr-sm" id="capQr"><div class="muted">Loading…</div></div>
          <ol class="steps" style="flex:1;min-width:180px">
            <li>Scan the code with your phone's camera and open it in <b>Chrome</b>.</li>
            <li>Tap <b>Install</b> (or ⋮ → <b>Add to Home screen</b>).</li>
            <li>Do the same on each phone or tablet you use.</li>
          </ol>
        </div></div>
      <div class="card tile"><h2>${icon('download')}Bring in items from the phone</h2>
        <ol class="steps">
          <li>In Capture, tap <b>Export to PC</b>. It makes one <b>.opensafe</b> file, photos included.</li>
          <li>Send it to this PC: Quick Share, email, OneDrive or a USB cable.</li>
          <li>Click below, double-click the file, or drag it into this window.</li>
        </ol>
        <div class="acts"><button class="btn primary" data-action="importPick">${icon('download')}Import from phone…</button></div>
        <p class="faint" style="margin:10px 0 0">Importing the same file twice is safe: nothing is added twice.</p></div>
      <div class="card tile" style="grid-column:1/-1"><h2>${icon('upload')}Send your inventory to the phone</h2>
        <p class="muted">A read-only, encrypted copy of your items with small photos, packing lists and the grab list, to search on the phone or open by scanning a QR label. You'll enter the passphrase once on the phone.</p>
        ${(() => { const n = (state.snap.data.library || []).filter(e => e.onPhone).length; return `<p class="muted" style="margin-top:0">${icon('letter')}${n ? `<b>${n} document${n === 1 ? '' : 's'}</b> from Documents and Data go${n === 1 ? 'es' : ''} too, as page pictures you can read offline.` : 'No documents go with it yet.'} To add one, right-click it in Documents or Data → <b>Keep a copy on my phone</b>.</p>`; })()}
        <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
          <label class="f" style="min-width:260px">Passphrase (at least 6 characters)<input id="pvPass" type="password" autocomplete="new-password"></label>
          ${state.snap.security.vault.unlocked ? '<label class="switch" style="font-weight:500"><input type="checkbox" id="pvVault"> Include vault items</label>' : ''}
          <button class="btn primary" data-action="phoneView">${icon('upload')}Save inventory for phone…</button></div>
        <p class="faint" style="margin:10px 0 0">Send the file to your phone the same way as above, then open it in Capture under <b>My inventory → Load file</b>. Save a new one whenever you want the phone up to date.</p></div>
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
        <p class="note">This PC must be on, with OpenSafe open. Some routers and phone browsers block this kind of connection. If it won't connect, use OpenSafe Capture instead.</p></div>
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
    const grab = state.snap.data.assets.filter(x => x.grab && !INACTIVE.includes(x.status)).length;
    return `<div class="head"><h1>Reports &amp; printing</h1></div>
    <p class="lead">Everything OpenSafe can print or save as a PDF.${state.snap.security.vault.exists ? ` Vault items are only included while the vault is open (it's ${state.snap.security.vault.unlocked ? 'open' : 'locked'} now).` : ''} PDFs are saved unencrypted, so keep them somewhere safe.</p>
    <div class="tiles">
      <div class="card tile" style="grid-column:1/-1"><h2>${icon('file')}Inventory report</h2>
        <p class="muted">Everything you own, with photos, serial numbers, prices, values and whether you have a receipt. For your insurer, a claim or a removal company.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
          <label class="f" style="flex:1;min-width:150px">Group by<select id="rGroup">${opt('category', 'Category', 'category')}${opt('location', 'Room / location', 'category')}</select></label>
          ${(state.snap.data.people || []).length ? `<label class="f" style="flex:1;min-width:150px">Owner<select id="rOwner">${opt('', 'Everyone', '')}${state.snap.data.people.map(p => opt(p, p, '')).join('')}</select></label>` : ''}
          <label class="f" style="flex:2;min-width:200px">Only this place<select id="rPlace">${opt('', 'Everywhere', '')}${locPaths().map(c => opt(c, locLabel(c), '')).join('')}</select></label>
          <button class="btn primary" data-action="report">${icon('download')}Save PDF…</button></div>
        <div style="display:flex;gap:22px;margin-top:12px;flex-wrap:wrap"><label class="switch" style="font-weight:500"><input type="checkbox" id="rPhotos" checked> A photo of each item</label>
          <label class="switch" style="font-weight:500"><input type="checkbox" id="rInactive"> Include sold, given away and lost items</label></div></div>
      <div class="card tile"><h2>${icon('fire')}Grab list</h2>
        <p class="muted">One page of the things to save first in a fire or flood, by room, with photos. ${grab ? `<b>${grab}</b> item${grab === 1 ? ' is' : 's are'} on it.` : 'Nothing is on it yet: tick <b>On the grab list</b> when editing an item.'}</p>
        <div class="acts">${grab ? `<button class="btn primary" data-action="grabPdf">${icon('download')}Save PDF…</button><button class="btn" data-action="gap" data-gap="grab">Show the items</button>` : ''}</div></div>
      <div class="card tile"><h2>${icon('qr')}QR labels for items</h2>
        <p class="muted">A4 sheets of 21 labels (Avery L7160). Scanning one in OpenSafe Capture opens that item. Tick items in <b>Items</b> and choose <b>QR labels…</b>, or use the item's <b>More</b> menu.</p>
        <div class="acts"><button class="btn" data-nav="items">Go to Items</button></div></div>
      <div class="card tile"><h2>${icon('pin')}Labels for boxes, shelves and rooms</h2>
        <p class="muted">Scanning one on the phone shows what's in that place, and lets you put items in it or check it.</p>
        <div class="acts"><button class="btn" data-action="placeLabelsMany">${icon('printer')}Print place labels…</button></div></div>
      <div class="card tile"><h2>${icon('clipboard')}Insurance claim pack</h2>
        <p class="muted">A PDF for your insurer with photos, serial numbers, receipts and values. Open an item and choose <b>More → Claim pack</b>, or tick several items in <b>Items</b>.</p>
        <div class="acts"><button class="btn" data-nav="items">Go to Items</button></div></div>
      <div class="card" id="spendCard" style="grid-column:1/-1"><h2>${icon('chart')}Spending by year</h2><div class="muted">Working it out…</div></div>
    </div>`;
  }

  // ---------- Import & backup ----------
  function viewData() {
    return `<div class="head"><h1>Import &amp; backup</h1></div>
    <div class="section-title">Bring items in</div>
    <div class="tiles">
      <div class="card tile"><h2>${icon('sheet')}From a spreadsheet</h2>
        <p class="muted">A list you keep in Excel, Google Sheets or Numbers. Save it as CSV first (Excel: <b>File → Save As → CSV UTF-8</b>). You choose which column is which before anything is added.</p>
        <div class="acts"><button class="btn primary" data-action="csvPick">${icon('upload')}Choose CSV file…</button></div></div>
      <div class="card tile"><h2>${icon('phone')}From your phone</h2>
        <p class="muted">Items exported from OpenSafe Capture (an <b>.opensafe</b> file).</p>
        <div class="acts"><button class="btn primary" data-action="importPick">${icon('download')}Import from phone…</button><button class="btn" data-nav="phone">Phone app help</button></div></div>
    </div>
    <div class="section-title">Take a copy out</div>
    <div class="tiles">
      <div class="card tile"><h2>${icon('sheet')}Spreadsheet (CSV)</h2>
        <p class="muted">Every item and its details, for Excel or Google Sheets. It can be imported back into OpenSafe.</p>
        <div class="acts"><button class="btn" data-action="csv">${icon('download')}Export CSV…</button></div></div>
    </div>
    <div class="section-title">Backups</div>
    <div class="tiles">
      <div class="card tile"><h2>${icon('database')}Full backup</h2>
        <p class="muted">Everything, with photos and documents, copied to a folder: ideally a USB stick or your OneDrive. OpenSafe also keeps a copy of your list each day for 30 days in its data folder.</p>
        <div class="acts"><button class="btn primary" data-action="backup">Back up to a folder…</button><button class="btn" data-action="restore">Restore from a backup…</button></div>
        <p class="faint" style="margin:12px 0 0">Data folder: <span class="mono">${esc(state.snap.dataDir)}</span> <button class="btn small ghost" data-action="openData">Open</button></p></div>
      ${autoBackupCard()}
      ${syncCard()}
    </div>`;
  }

  // ---------- Places ----------
  function viewPlaces() {
    const paths = locPaths();
    const by = state.snap.summary.byLocation || {};
    const live = state.snap.data.assets.filter(a => !INACTIVE.includes(a.status));
    const noLoc = live.filter(a => !a.location).length;
    if (!paths.length) return `<div class="head"><h1>Places</h1></div>
      <div class="card empty" style="max-width:720px;margin:0 auto">Places are the rooms, cupboards, shelves and boxes where your things are kept. Give an item a location to start. Use <b>/</b> for places inside places, for example <i>Home / Garage / Shelf 2</i>.</div>`;
    const cur = paths.includes(state.place) ? state.place : (paths.filter(p => !p.includes(' / ')).sort((x, y) => ((by[y] || {}).count || 0) - ((by[x] || {}).count || 0))[0] || paths[0]);
    state.place = cur;
    const here = live.filter(a => inLoc(a.location, cur)).sort((x, y) => (x.location || '').localeCompare(y.location || '') || x.name.localeCompare(y.name, 'en-GB'));
    const d = by[cur] || { count: here.length, value: 0 };
    const parts = cur.split(' / ');
    return `<div class="head"><h1>Places</h1><span class="sub">${paths.length} place${paths.length === 1 ? '' : 's'}</span><span class="spacer"></span><button class="btn" data-action="placeLabelsMany">${icon('printer')}Print place labels…</button></div>
    <div class="places">
      <div class="card ptree">${paths.map(p => { const dp = by[p] || { count: 0 }; const n = p.split(' / ').length - 1; return `<div class="prow ${p === cur ? 'on' : ''} ${dp.count ? '' : 'empty'}" data-action="placeSel" data-place="${esc(p)}" style="padding-left:${10 + n * 18}px">${n ? '<span class="tree-l"></span>' : icon('pin')}<span class="n">${esc(p.split(' / ').pop())}</span>${((state.snap.data.places || {})[p] || { files: [] }).files.length ? icon('video') : ''}<span class="c">${dp.count}</span></div>`; }).join('')}
        ${noLoc ? `<div class="prow" data-action="gap" data-gap="noloc" style="margin-top:6px;border-top:1px solid var(--line2)"><span class="n faint">No location set</span><span class="c">${noLoc}</span></div>` : ''}</div>
      <div>
        <div class="card" style="margin-bottom:16px"><div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">${parts.length > 1 ? `<div class="meta">${esc(parts.slice(0, -1).join(' / '))}</div>` : ''}<h2 style="font-size:20px;margin:2px 0 4px">${esc(parts[parts.length - 1])}</h2>
            <div class="muted">${d.count} item${d.count === 1 ? '' : 's'}, including anything inside it · worth ${money0(d.value)}</div></div>
          <button class="btn" data-action="filterLoc" data-loc="${esc(cur)}">${icon('box')}Show in Items</button>
          <button class="btn" data-action="placeLabelOne" data-place="${esc(cur)}">${icon('qr')}Print label</button></div>
          ${here.length ? `<table class="list" style="margin-top:14px"><thead><tr><th>Item</th><th>Where</th><th class="r">Value</th></tr></thead><tbody>
            ${here.slice(0, 200).map(a => `<tr data-open="${a.id}" draggable="true" title="Drag onto another place to move it"><td><b>${esc(a.name)}</b>${a.status !== 'Owned' ? ` <span class="pill">${esc(a.status)}</span>` : ''}</td><td class="meta">${esc(a.location === cur ? '' : a.location.slice(cur.length + 3))}</td><td class="r nowrap">${value(a) ? money(value(a)) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin:12px 0 0">Nothing is recorded here.</p>'}</div>
        ${placeCard(cur)}
      </div>
    </div>`;
  }
  function linkedDocsCard(a) {
    const docs = (state.snap.data.library || []).filter(e => e.assetIds.includes(a.id));
    return `<div class="card"><div class="dsec-h" style="display:flex;align-items:center">Linked documents and files<span class="spacer"></span><button class="btn small ghost" data-action="ctxLinkDoc" data-id="${esc(a.id)}" title="Link a document or file">${icon('plus')}</button></div>
      ${docs.length ? `<div class="rows">${docs.map(e => `<div class="rowi" data-action="libOpen" data-lib="${esc(e.id)}">${icon(e.kind === 'document' ? 'letter' : 'folder')}<span style="flex:1;min-width:0"><b class="ell" style="display:block">${esc(e.title)}</b><span class="meta">${esc(e.kind === 'document' ? e.docType : 'Data' + (e.folder ? ' › ' + e.folder : ''))}</span></span><button class="btn small ghost" data-action="libUnlink" data-lib="${esc(e.id)}" data-asset="${esc(a.id)}" title="Unlink (the document isn't deleted)">${icon('plus', 'xrot')}</button></div>`).join('')}</div>`
        : `<p class="muted small" style="margin:6px 0 0">Link letters, manuals or emails from Documents and Data, so they show here.</p>`}</div>`;
  }
  function linkDocToItem(assetId) {
    const rows = (state.snap.data.library || []).filter(e => !e.assetIds.includes(assetId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(e => ({ id: e.id, title: e.title, sub: [e.kind === 'document' ? e.docType : 'Data' + (e.folder ? ' › ' + e.folder : ''), e.from].filter(Boolean).join(' · '), thumb: `<span class="pkic">${icon(e.kind === 'document' ? 'letter' : 'folder')}</span>` }));
    pickerModal('Link a document or file', rows, async (id) => { const n = await run(() => keep.libLink([id], assetId, true)); if (n !== undefined) { toast('✓ Linked', 2500); await refresh(); } }, { hint: 'Choose from Documents and Data. It stays where it is and also shows on this item’s page.', empty: 'Nothing in Documents or Data yet.' });
  }
  function newPlaceForm(onDone) {
    openModal(`<form class="dialog narrow" id="npForm"><div class="dh"><h2>New place</h2></div><div class="db">
      <label class="f s3">Place<input name="place" list="npLocs" maxlength="200" required placeholder="e.g. Home / Garage / Shelf 2"><datalist id="npLocs">${locPaths().map(p => `<option value="${esc(p)} / ">`).join('')}</datalist></label>
      <p class="s3 muted small" style="margin:0">Use <b>/</b> for places inside places. It's added to your list of locations.</p></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="submit">Move here</button></div></form>`);
    $('#npForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const loc = ev.target.place.value.split('/').map(x => x.trim()).filter(Boolean).join(' / ');
      if (!loc) return;
      const locs = state.snap.data.locations;
      if (!locs.includes(loc)) await run(() => keep.setLists(state.snap.data.categories, [...locs, loc]));
      closeModal(); await onDone(loc);
    };
  }
  function placeLabelsForm(pre) {
    openModal(`<form class="dialog narrow" id="plForm"><div class="dh"><h2>Labels for places</h2></div>
      <div class="db"><p class="s3 muted" style="margin:0">Tick the boxes, shelves and rooms to print a QR label for. Same A4 sheets as item labels (Avery L7160).</p>
        <div class="s3 partlist" style="max-height:300px">${locPaths().map(p => `<label class="partrow"><input type="checkbox" class="plab" value="${esc(p)}" ${pre && pre.includes(p) ? 'checked' : ''}> <span>${esc(locLabel(p))}</span></label>`).join('')}</div>
        <label class="f">Labels for each place<select id="plCopies">${[1, 2, 3, 4].map(n => opt(String(n), String(n), '1')).join('')}</select></label>
        <label class="f">Labels already used on the sheet<input id="plSkip" type="number" min="0" max="20" value="0"></label></div>
      <div class="df"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary" type="button" data-action="placeLabels">Save labels PDF…</button></div></form>`);
  }

  function viewSettings() {
    const d = state.snap.data;
    return `<div class="head"><h1>Settings</h1></div>
    <div class="section-title">Security</div>
    <div class="grid g2">${securityCard()}
      <div class="card"><h2>${icon('bell')}Reminders</h2>
        <label class="f" style="max-width:260px">Remind me this many days ahead<input type="number" id="remDays" min="1" max="365" value="${d.settings.reminderDays}"></label>
        <p><button class="btn" data-action="saveRem">Save</button></p>
        <div id="bgCard" style="border-top:1px solid var(--line2);padding-top:14px;margin-top:6px"><b>Reminders when OpenSafe is closed</b>
          <p class="muted" style="margin:6px 0 10px">OpenSafe starts quietly with Windows and waits by the clock. Once a day (8am to 9pm) it shows a notification if anything is due in the next 7 days. Closing the window still locks OpenSafe.</p>
          ${state.snap.security.encrypted ? '<p class="note" style="margin:0 0 10px">With password protection on, the notification only says how many things are due, and only the due dates (no item names) are kept in OpenSafe\'s settings file.</p>' : ''}
          <label class="switch" style="font-weight:500"><input type="checkbox" id="bgOn" ${state.bg && state.bg.enabled ? 'checked' : ''}> Keep reminders running</label></div></div>
    </div>
    <div class="section-title">Your lists</div>
    <div class="grid g2">
      <div class="card"><h2>Categories</h2><p class="muted">One per line. Existing items keep their category.</p>
        <textarea id="catsTa" rows="10">${esc(d.categories.join('\n'))}</textarea></div>
      <div class="card"><h2>Locations</h2><p class="muted">One per line. Use <b>/</b> for places inside places, e.g. <i>Home / Garage / Shelf 2</i>.</p>
        <textarea id="locsTa" rows="10">${esc(d.locations.join('\n'))}</textarea>
        <p style="margin-bottom:0"><button class="btn primary" data-action="saveLists">Save categories and locations</button></p></div>
      <div class="card" style="grid-column:1/-1"><h2>${icon('chart')}Value drop per year</h2><p class="muted">Optional. For items with no "value now", OpenSafe estimates it from the price paid and the date bought, losing this percentage each year. Used on the dashboard and item pages, not in claim packs or reports.</p>
        <div class="deplist" style="grid-template-columns:repeat(3,1fr)">${[...new Set([...d.categories, ...d.assets.map(x => x.category).filter(Boolean)])].map(c => `<label class="deprow"><span>${esc(c)}</span><input data-dep="${esc(c)}" inputmode="decimal" value="${esc((d.settings.depreciation || {})[c] ?? '')}" placeholder="—"><span class="faint">%</span></label>`).join('')}</div>
        <p style="margin-bottom:0"><button class="btn primary" data-action="saveDep">Save</button></p></div>
    </div>
    <div class="section-title">This app</div>
    <div class="grid g2">
      <div class="card"><h2>${icon('sun')}Appearance</h2>
        <p class="muted">Light or dark colours. "Match Windows" follows your Windows setting.</p>
        <span class="seg">${['system', 'light', 'dark'].map(t => `<button data-action="theme" data-theme="${t}" class="${(state.snap.theme || 'system') === t ? 'on' : ''}">${{ system: 'Match Windows', light: 'Light', dark: 'Dark' }[t]}</button>`).join('')}</span></div>
      <div class="card"><h2>${icon('download')}Updates</h2>
        <p style="margin-top:0">You're running version <b>${esc(state.snap.version)}</b>.</p>
        <p class="muted" id="updMsg">${esc(updText())}</p>
        <p>${state.upd && state.upd.canUpdate ? '<button class="btn" data-action="updCheck">Check now</button> ' : ''}${state.upd && state.upd.state === 'ready' ? '<button class="btn primary" data-action="updInstall">Restart and update</button>' : ''}</p>
        <p class="faint" style="margin-bottom:0">OpenSafe checks for new versions when it starts and every 4 hours. Your items, photos and settings are kept when it updates.</p></div>
    </div>`;
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
        <label class="f">Location<input name="location" list="dlLocs" value="${esc(a.location || '')}" placeholder="e.g. Home / Garage / Shelf 2"></label>
        <label class="f">Condition<select name="condition">${opt('', '—', a.condition || '')}${L.conditions.map(s => opt(s, s, a.condition)).join('')}</select></label>
        ${inp('brand', 'Brand')}${inp('model', 'Model')}${inp('serial', 'Serial number')}
        <label class="f">Owner (who it belongs to)<input name="owner" list="dlPeople" value="${esc(a.owner || '')}" placeholder="Leave blank if it's yours"></label>
        <datalist id="dlPeople">${(state.snap.data.people || []).map(p => `<option value="${esc(p)}">`).join('')}</datalist>
        <div id="borrowBox" class="s3 subgrid ${a.status === 'Borrowed' ? '' : 'hidden'}"><h3>Borrowed from someone else</h3>
          ${inp('borrowedFrom', 'Belongs to')}${inp('borrowedContact', 'Their phone or email')}${inp('returnBy', 'Give back by (reminder)', 'type="date"')}</div>
        <div id="lendBox" class="s3 subgrid ${a.status === 'Lent out' ? '' : 'hidden'}"><h3>Lent out</h3>
          ${inp('lentTo', 'Lent to')}${inp('lentContact', 'Phone or email')}${inp('lentDate', 'Lent on', 'type="date"')}${inp('dueBack', 'Due back (reminder)', 'type="date"')}</div>
        <div id="soldBox" class="s3 subgrid ${a.status === 'Sold' ? '' : 'hidden'}"><h3>Sold</h3>
          ${inp('soldDate', 'Sold on', 'type="date"')}${inp('soldPrice', 'Sold for (£)', 'inputmode="decimal"')}${inp('soldTo', 'Sold to / where')}</div>
        <h3>Purchase and value</h3>
        ${inp('purchaseDate', 'Bought on', 'type="date"')}${inp('purchasePrice', 'Price paid (£)', 'inputmode="decimal"')}${inp('supplier', 'Bought from')}
        <div class="s3 fxrow"><label class="f">Bought abroad? Paid in<select name="foreignCurrency" id="fxCur">${opt('', 'Pounds (£)', a.foreignCurrency || '')}${FX_CURRENCIES.map(([c, n]) => opt(c, `${c} · ${n}`, a.foreignCurrency || '')).join('')}</select></label>
          <label class="f">Price in that currency<input name="foreignPrice" id="fxAmt" inputmode="decimal" value="${esc(a.foreignPrice ?? '')}"></label>
          <button type="button" class="btn" id="fxBtn" style="align-self:end">Work out £</button>
          <input type="hidden" name="fxRate" id="fxRate" value="${esc(a.fxRate ?? '')}"><input type="hidden" name="fxDate" id="fxDate" value="${esc(a.fxDate || '')}">
          <div class="faint" id="fxInfo" style="grid-column:1/-1">${a.foreignCurrency && a.fxRate ? fxText(a) : 'Uses the reference rate on the date bought. Your card or bank may have charged a different rate: if you have the £ amount from your statement, type that in Price paid instead.'}</div></div>
        ${inp('currentValue', 'Value now (£)', 'inputmode="decimal"')}${inp('warrantyExpiry', 'Warranty until', 'type="date"')}${inp('barcode', 'Barcode', 'inputmode="numeric"')}${inp('webLink', 'Web page (link)', 'type="url" placeholder="https://… product page, manual or shop"', 's2')}
        <label class="switch s3" style="font-weight:500"><input type="checkbox" name="grab" ${a.grab ? 'checked' : ''}> On the grab list: one of the first things to save in a fire or flood</label>
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
    $('#fStatus').onchange = (e) => { $('#lendBox').classList.toggle('hidden', e.target.value !== 'Lent out'); $('#soldBox').classList.toggle('hidden', e.target.value !== 'Sold'); $('#borrowBox').classList.toggle('hidden', e.target.value !== 'Borrowed'); };
    const showKind = (k) => {
      const cur = {}; for (const el of $$('#detBox input')) cur[el.name.slice(4)] = el.value;
      $('#detBox').innerHTML = k ? DETAIL_UI[k].map(([key, label, type]) => detInp([key, label, type])).join('') : '';
      for (const el of $$('#detBox input')) if (cur[el.name.slice(4)]) el.value = cur[el.name.slice(4)];
      $('#kindHint').textContent = k ? '' : 'Choose this for cars, motorbikes and boats to record registration, VIN, MOT and more.';
    };
    $('#fKind').onchange = (e) => showKind(e.target.value);
    $('#fCat').onchange = (e) => { if (!$('#fKind').value) { const k = guessKind(e.target.value); if (k) { $('#fKind').value = k; showKind(k); } } };
    if ($('#fxBtn')) $('#fxBtn').onclick = async () => {
      const b = $('#fxBtn'); b.disabled = true; b.textContent = 'Looking up…';
      try {
        const r = await keep.fxConvert($('#fxCur').value, $('#fxAmt').value, f.purchaseDate.value);
        f.purchasePrice.value = r.gbp.toFixed(2); $('#fxRate').value = r.rate; $('#fxDate').value = r.date;
        $('#fxInfo').textContent = fxText({ foreignCurrency: r.currency, foreignPrice: r.amount, fxRate: r.rate, fxDate: r.date }) + (f.purchaseDate.value ? '' : ' (today\'s rate, as no date bought is entered)');
      } catch (ex) { $('#fxInfo').textContent = '⚠ ' + ex.message; }
      b.disabled = false; b.textContent = 'Work out £';
    };
    if ($('#fxCur')) $('#fxCur').onchange = () => { $('#fxRate').value = ''; $('#fxDate').value = ''; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const raw = Object.fromEntries(new FormData(e.target).entries());
      const data = {}; const details = {};
      for (const [k, v] of Object.entries(raw)) { if (k.startsWith('det_')) details[k.slice(4)] = v; else data[k] = v; }
      data.details = details;
      data.grab = !!e.target.grab.checked;
      if (!data.name.trim()) { $('#formErr').textContent = 'Give the item a name.'; return; }
      for (const k of ['purchasePrice', 'currentValue', 'insuredValue', 'soldPrice', 'foreignPrice']) {
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
  const libDropTarget = () => {
    if (state.view === 'docs' || state.view === 'files') return { kind: LIB[state.view].kind, entryId: '' };
    if (state.view === 'libitem') { const en = libEntry(state.libId); return en ? { kind: en.kind, entryId: en.id } : null; }
    return null;
  };
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (libDropTarget() && !vstate.id && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#view').classList.add('dropping'); } });
  document.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) $('#view').classList.remove('dropping'); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0; $('#view').classList.remove('dropping');
    if (e.target.closest && e.target.closest('#drop')) return; // item photo/document drop zone handles its own files
    if (e.dataTransfer && [...e.dataTransfer.types].includes('application/x-opensafe')) return; // moving things inside OpenSafe
    const lt = !vstate.id && libDropTarget();
    if (lt) { // Documents, Data or a document's page: drop anywhere on the page
      const list = e.dataTransfer ? e.dataTransfer.files : [];
      if (!list.length) { toast('Nothing was added: that didn\'t contain any files. Drag files from File Explorer, or save the email as a file first.', 6500); return; }
      const files = [...list], where = keep.filePaths(files), paths = [], blobs = [], skipped = [];
      for (let i = 0; i < files.length; i++) {
        if (where[i]) paths.push(where[i]);
        else if (files[i].size > 500 * 1024 * 1024) skipped.push(`${files[i].name}: over 500 MB`);
        else if (files[i].size) blobs.push({ name: files[i].name || 'file', data: new Uint8Array(await files[i].arrayBuffer()) });
      }
      const r = await run(() => keep.libAddDropped(lt.kind, paths, blobs, lt.entryId));
      if (r) r.errors.push(...skipped);
      if (r && !r.added && !r.errors.length) { toast('Nothing was added. Drag files from File Explorer, or use Add files…', 6000); return; }
      await libAfterAdd(r, lt.kind, lt.entryId);
      return;
    }
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter(f => /\.(opensafe|txt|json)$/i.test(f.name));
    if (!files.length) return;
    try { await keep.importFiles(files); } catch (err) { toast('⚠ ' + err.message, 5000); }
    await refresh();
  });

  document.addEventListener('dblclick', (e) => {
    const row = e.target.closest('[data-libsel]');
    if (!row || e.target.closest('[data-action], .menuwrap') || !state.libId) return;
    libViewOpen(state.libId, row.dataset.libsel);
  });
  document.addEventListener('click', async (e) => {
    if (e.target.closest('.menu') || !e.target.closest('.menuwrap')) closeMenus();
    const selRow = e.target.closest('[data-libsel]');
    if (selRow && !e.target.closest('[data-action], .menuwrap') && state.libId) {
      state.libSel = state.libSel || {};
      if (state.libSel[state.libId] !== selRow.dataset.libsel) { state.libSel[state.libId] = selRow.dataset.libsel; const sc = $('#view').scrollTop; render(); $('#view').scrollTop = sc; }
      return;
    }
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
    if (act && (act.dataset.action === 'libSelBox' || act.dataset.action === 'libSelAll')) { // checkboxes: read the tick now, before anything else
      state.libPick = state.libPick || new Set();
      if (act.dataset.action === 'libSelBox') { if (act.checked) state.libPick.add(act.dataset.lib); else state.libPick.delete(act.dataset.lib); }
      else { const list = libFiltered(LIB[state.view].kind); if (act.checked) list.forEach(x => state.libPick.add(x.id)); else state.libPick.clear(); }
      refreshLibList(); return;
    }
    if (act && act.dataset.action === 'checkTick') { // read the tick now too
      const d = lsGet('checks', {}); if (act.checked) d[act.dataset.id] = true; else delete d[act.dataset.id]; lsSet('checks', d);
      const sc = $('#view').scrollTop; render(); $('#view').scrollTop = sc; return;
    }
    if (act && act.dataset.action.startsWith('lib')) { e.preventDefault(); if (!(await viewerAction(act))) await libAction(act); return; }
    if (act) {
      const a = state.itemId && asset(state.itemId);
      switch (act.dataset.action) {
        case 'new': itemForm(); break;
        case 'close': closeModal(); break;
        case 'back': go('items'); break;
        case 'edit': itemForm(a); break;
        case 'dup': { const c = await run(() => keep.duplicateAsset(a.id), 'Copy made – photos and documents are not copied'); await refresh(); go('item', { itemId: c.id, tab: 'overview' }); break; }
        case 'del': { const ok = await run(() => keep.deleteAsset(a.id)); if (ok) { toast('Moved to Deleted items. You can restore it for 30 days.', 4500); await refresh(); go('items'); } break; }
        case 'pick': { const r = await run(() => keep.pickFiles(a.id, act.dataset.kind, $('#docType') ? $('#docType').value : 'Other')); reportAdd(r); await refresh(); break; }
        case 'rmAtt': if (confirm('Delete this file from OpenSafe?')) { await run(() => keep.removeAttachment(a.id, act.dataset.att), 'Deleted'); await refresh(); } break;
        case 'cover': await run(() => keep.setCover(a.id, act.dataset.att)); await refresh(); break;
        case 'openDoc': await run(() => keep.openAttachment(a.id, act.dataset.file, act.dataset.name)); break;
        case 'newService': serviceForm(a); break;
        case 'editService': if (!e.target.closest('button')) serviceForm(a, a.service.find(s => s.id === act.dataset.sid)); break;
        case 'rmService': e.stopPropagation(); if (confirm('Delete this service entry?')) { await run(() => keep.deleteService(a.id, act.dataset.sid), 'Deleted'); await refresh(); } break;
        case 'binRestore': { const r = await run(() => keep.restoreItem(act.dataset.id)); toast(`✓ ${r.name} restored`); await refresh(); break; }
        case 'binPurge': { const ok = await run(() => keep.purgeItem(act.dataset.id)); if (ok) { toast('Deleted for good'); await refresh(); } break; }
        case 'binEmpty': { const n = await run(() => keep.emptyBin()); if (n) { toast(`${n} item${n === 1 ? '' : 's'} deleted for good`); await refresh(); } break; }
        case 'filterLoc': state.f = Object.assign(state.f, { location: act.dataset.loc, category: '', status: 'active', gap: '', q: '' }); go('items'); break;
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
        case 'polRenew': renewForm(state.snap.data.policies.find(x => x.id === act.dataset.pid)); break;
        case 'polAddYear': e.preventDefault(); renewForm(state.snap.data.policies.find(x => x.id === act.dataset.pid), true); break;
        case 'polHistRm': if (confirm('Delete this year from the premium history?')) { await run(() => keep.removePolicyHistory(act.dataset.pid, act.dataset.hid), 'Deleted'); await refresh(); } break;
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
        case 'pickParts': partsForm(a); break;
        case 'addValuation': valuationForm(a); break;
        case 'rmValuation': if (confirm('Delete this valuation from the history? The item\'s value now isn\'t changed.')) { await run(() => keep.removeValuation(a.id, act.dataset.vid), 'Deleted'); await refresh(); } break;
        case 'bcLookup': barcodeLookup(a); break;
        case 'newsOpen': lsSet('seenVersion', state.snap.version); go('help'); break;
        case 'newsHide': lsSet('seenVersion', state.snap.version); render(); break;
        case 'helpGuide': await run(() => keep.openGuide()); break;
        case 'checksReset': if (confirm('Clear all the ticks and notes?')) { lsSet('checks', {}); lsSet('checkNotes', {}); render(); } break;
        case 'checksCopy': {
          const d = lsGet('checks', {}), notes = lsGet('checkNotes', {});
          const text = [`OpenSafe ${state.snap.version} — checks on my own devices`, ...CHECKS.map(([id, , title]) => `${d[id] ? '[x]' : '[ ]'} ${title}${notes[id] ? ' — ' + notes[id] : ''}`)].join('\n');
          await run(() => keep.copyPlain(text), '✓ Copied. Paste it into a message.'); break;
        }
        case 'syncChoose': { const st = await run(() => keep.syncChoose()); if (st) toast(st.lastError ? st.lastError : '✓ Keeping in step through that folder', 4500); await refresh(); break; }
        case 'syncNow': { act.disabled = true; const st = await run(() => keep.syncNow()); if (st && !st.lastError) toast('✓ ' + (st.dirty ? 'Copying…' : 'In step')); await refresh(); break; }
        case 'syncResolve': await run(() => keep.syncResolve()); await refresh(); break;
        case 'syncStop': if (confirm('Stop keeping this PC in step with the shared folder?\n\nNothing is deleted: this PC keeps its inventory, and the copy in the folder stays there.')) { await run(() => keep.syncStop(), 'Stopped. This PC no longer uses the shared folder.'); await refresh(); } break;
        case 'phoneView': {
          const pass = $('#pvPass').value;
          if (pass.length < 6) { toast('Use a passphrase of at least 6 characters'); break; }
          act.disabled = true; act.textContent = 'Preparing…';
          try { const r = await run(() => keep.phoneView(pass, $('#pvVault') && $('#pvVault').checked)); if (r) toast(`✓ Saved ${r.count} items${r.docs ? ` and ${r.docs} document${r.docs === 1 ? '' : 's'} (${r.pages} pages)` : ''} (${r.kb >= 2048 ? (r.kb / 1024).toFixed(1) + ' MB' : r.kb + ' KB'}). Send that file to your phone.`, 6000); } catch (_) {}
          act.disabled = false; act.textContent = 'Save inventory for phone…'; $('#pvPass').value = ''; break;
        }
        case 'claimOne': claimForm([a.id]); break;
        case 'selClear': state.sel.clear(); render(); break;
        case 'ocr': readReceipt(a, act.dataset.file); break;
        case 'moreMenu': toggleMenu(act); break;
        case 'sell': sellForm(a); break;
        case 'lsCopyTitle': await run(() => keep.copyPlain($('#lsTitle').value), 'Title copied'); break;
        case 'lsCopyText': await run(() => keep.copyPlain($('#lsText').value), 'Description copied'); break;
        case 'lsPhotos': { const n = await run(() => keep.listingPhotos(a.id)); if (n) toast(`✓ ${n} photo${n === 1 ? '' : 's'} saved`); break; }
        case 'tripNew': tripForm(null); break;
        case 'setLF': { e.stopPropagation(); closeMenus(); state.lf[act.dataset.f] = act.dataset.v; render(); break; }
        case 'setF': { e.stopPropagation(); closeMenus(); state.f[act.dataset.f] = act.dataset.v; render(); break; }
        case 'goBin': go('bin'); break;
        case 'srchItems': state.f.q = state.gq; state.f.status = 'all'; go('items'); break;
        case 'srchLib': { const pg = act.dataset.page; state.lfPage = pg; state.lf = { sort: 'added', q: state.gq }; state.libHits = new Map((state.gres ? state.gres.library : []).map(x => [x.id, x.snippet])); go(pg); break; }
        case 'ctxOpen': go('item', { itemId: act.dataset.id, tab: 'overview' }); break;
        case 'ctxEdit': itemForm(asset(act.dataset.id)); break;
        case 'ctxMove': { const ids = JSON.parse(act.dataset.ids); placePicker(ids.length === 1 ? `Move ${(asset(ids[0]) || {}).name}` : `Move ${ids.length} items`, (loc) => moveItemsTo(ids, loc)); break; }
        case 'ctxDup': { const c = await run(() => keep.duplicateAsset(act.dataset.id), 'Copy made – photos and documents are not copied'); if (c) { await refresh(); go('item', { itemId: c.id, tab: 'overview' }); } break; }
        case 'ctxLabel': { const p = await run(() => keep.labels([act.dataset.id], { copies: 1, skip: 0 })); if (p) toast('✓ Label saved. Print at 100% (no "fit to page").', 5000); break; }
        case 'ctxDel': { const x = asset(act.dataset.id); if (x && confirm(`Delete "${x.name}"?\n\nIt goes to Deleted items for 30 days.`)) { const ok = await run(() => keep.deleteAsset(x.id)); if (ok) { toast('Moved to Deleted items. You can restore it for 30 days.', 4500); await refresh(); if (state.itemId === x.id) go('items'); } } break; }
        case 'ctxLinkDoc': linkDocToItem(act.dataset.id); break;
        case 'goReports': go('reports'); break;
        case 'labelsShown': { const ids = filtered().map(x => x.id); if (!ids.length) { toast('No items shown'); break; } state.sel = new Set(ids); render(); setTimeout(() => { const b = $('[data-action=labelsSel]'); if (b) b.click(); }, 50); break; }
        case 'moveSel': { const ids = [...state.sel], loc = act.dataset.loc; const n = await run(() => keep.bulkUpdate(ids, { location: loc })); if (n !== undefined) { toast(`✓ ${ids.length} item${ids.length === 1 ? '' : 's'} moved to ${loc}`, 3500); state.sel.clear(); await refresh(); } break; }
        case 'moveSelNew': newPlaceForm((loc) => { const ids = [...state.sel]; return run(() => keep.bulkUpdate(ids, { location: loc })).then(async (n) => { if (n !== undefined) { toast(`✓ ${ids.length} item${ids.length === 1 ? '' : 's'} moved to ${loc}`, 3500); state.sel.clear(); await refresh(); } }); }); break;
        case 'tripNewGo': go('trips'); tripForm(null); break;
        case 'polNewGo': go('policies'); policyForm(null); break;
        case 'tripEdit': tripForm(state.snap.data.trips.find(t => t.id === state.tripId)); break;
        case 'tripPick': tripPicker(state.snap.data.trips.find(t => t.id === state.tripId)); break;
        case 'tripReset': if (confirm('Untick everything on this list?')) { await run(() => keep.resetTrip(state.tripId)); await refresh(); } break;
        case 'tripDel': if (confirm('Delete this packing list? The items themselves aren\'t changed.')) { await run(() => keep.deleteTrip(state.tripId), 'Deleted'); state.tripId = null; await refresh(); } break;
        case 'tripExtraRm': await run(() => keep.removeTripExtra(state.tripId, act.dataset.xid)); await refresh(); break;
        case 'useDateHint': await run(() => keep.saveAsset({ id: a.id, purchaseDate: act.dataset.date }), 'Date bought set'); await refresh(); break;
        case 'dismissDateHint': await run(() => keep.dismissDateHint(a.id)); await refresh(); break;
        case 'ocrLabel': readLabel(a, act.dataset.file); break;
        case 'csvPick': { try { const r = await keep.csvPick(); if (r) csvForm(r); } catch (ex) { toast('⚠ ' + ex.message, 8000); } break; }
        case 'importPick': { await run(() => keep.importPick()); await refresh(); break; }
        case 'phoneReset': await run(() => keep.phoneReset()); loadPhone(); break;
        case 'report': { const p = await run(() => keep.exportReport({ includePhotos: $('#rPhotos').checked, includeInactive: $('#rInactive').checked, groupBy: $('#rGroup').value, place: $('#rPlace').value, owner: $('#rOwner') ? $('#rOwner').value : '' })); if (p) toast('Report saved'); break; }
        case 'openLink': e.preventDefault(); await run(() => keep.openItemLink(a.id)); break;
        case 'placeAdd': { const r = await run(() => keep.placePick(act.dataset.place)); if (r && r.added) toast(`✓ ${r.added} file${r.added === 1 ? '' : 's'} added`); if (r && r.errors.length) toast('⚠ ' + r.errors.join(' · '), 7000); await refresh(); break; }
        case 'placeOpen': { const e = state.snap.data.places[act.dataset.place]; if (e) await run(() => keep.openAttachment(e.id, act.dataset.file, act.dataset.name)); break; }
        case 'placeRm': if (confirm('Delete this file from OpenSafe?')) { await run(() => keep.placeRemove(act.dataset.place, act.dataset.fid), 'Deleted'); await refresh(); } break;
        case 'placeLabels': { const places = [...document.querySelectorAll('.plab:checked')].map(i => i.value); if (!places.length) { toast('Tick at least one place'); break; } const p = await run(() => keep.placeLabels(places, { copies: Number($('#plCopies').value), skip: Number($('#plSkip').value) || 0 })); if (p) { closeModal(); toast('✓ Labels saved. Print at 100% (no "fit to page").', 5000); } break; }
        case 'goPlace': e.preventDefault(); state.place = act.dataset.place; go('places'); break;
        case 'placeSel': state.place = act.dataset.place; render(); break;
        case 'placeLabelOne': { const p = await run(() => keep.placeLabels([act.dataset.place], { copies: 1, skip: 0 })); if (p) toast('✓ Label saved. Print at 100% (no "fit to page").', 5000); break; }
        case 'placeLabelsMany': placeLabelsForm(state.view === 'places' && state.place ? [state.place] : []); break;
        case 'deleteSel': { const n = await run(() => keep.deleteMany([...state.sel])); if (n) { state.sel.clear(); toast(`${n} item${n === 1 ? '' : 's'} moved to Deleted items`, 4000); await refresh(); } break; }
        case 'findDupes': duplicatesView(); break;
        case 'dupIgnore': { await run(() => keep.ignoreDuplicates(act.dataset.ids.split(','))); act.closest('[data-group]').remove(); if (!document.querySelector('#dupDlg [data-group]')) closeModal(); break; }
        case 'dupMerge': { const gi = act.dataset.gi; const keepId = (document.querySelector(`#dupDlg input[name=keep${gi}]:checked`) || {}).value; const others = act.dataset.ids.split(',').filter(id => id !== keepId); if (!keepId || !confirm(`Merge ${others.length} item${others.length === 1 ? '' : 's'} into "${asset(keepId).name}"?`)) break; await run(() => keep.mergeItems(keepId, others), 'Merged'); act.closest('[data-group]').remove(); await refresh(); if (!document.querySelector('#dupDlg [data-group]')) closeModal(); break; }
        case 'checkRecalls': { state.recallBusy = '…'; render(); try { const r = await keep.checkRecalls(); toast(r.matches.length ? `⚠ ${r.matches.length} possible recall match${r.matches.length === 1 ? '' : 'es'}` : `✓ No recalls found for ${r.checked} item${r.checked === 1 ? '' : 's'}`, 5000); } catch (ex) { toast('⚠ ' + ex.message, 6000); } state.recallBusy = null; await refresh(); break; }
        case 'openRecall': await run(() => keep.openRecall(act.dataset.link)); break;
        case 'dismissRecall': await run(() => keep.dismissRecall(act.dataset.aid, act.dataset.link)); await refresh(); break;
        case 'showRecalls': openModal(`<div class="dialog"><div class="dh"><h2>Possible product recall</h2></div><div class="db" style="display:block"><p class="muted" style="margin-top:0">Check the exact model, batch or serial range on the GOV.UK page before acting.</p>${recallRows(recallsFor(a.id))}</div><div class="df"><button class="btn" data-action="close">Close</button></div></div>`); break;
        case 'filterOwner': state.f = Object.assign(state.f, { owner: act.dataset.owner, location: '', category: '', status: 'active', gap: '', q: '' }); go('items'); break;
        case 'grabPdf': { const p = await run(() => keep.exportGrab()); if (p) toast('Grab list saved'); break; }
        case 'csv': { const p = await run(() => keep.exportCsv()); if (p) toast('CSV saved'); break; }
        case 'saveDep': { const dep = {}; for (const i of document.querySelectorAll('[data-dep]')) if (i.value.trim()) dep[i.dataset.dep] = i.value.trim(); try { await run(() => keep.updateSettings({ depreciation: dep }), 'Saved'); await refresh(); } catch (_) {} break; }
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
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'tripSel') { state.tripId = e.target.value; render(); return; }
    if (e.target.classList && e.target.classList.contains('tick')) { try { await keep.tickTrip(state.tripId, e.target.dataset.key, e.target.dataset.which, e.target.checked); await refresh(); } catch (ex) { toast('⚠ ' + ex.message); } return; }
    if (e.target.id !== 'bgOn') return;
    try { const on = await keep.bgSet(e.target.checked); state.bg = Object.assign(state.bg || {}, { enabled: on }); toast(on ? '✓ Reminders will keep running when OpenSafe is closed' : 'Reminders now only show when OpenSafe is open'); }
    catch (ex) { e.target.checked = !e.target.checked; toast('⚠ ' + ex.message, 5000); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.check) { const n = lsGet('checkNotes', {}); n[e.target.dataset.check] = e.target.value.slice(0, 500); lsSet('checkNotes', n); return; }
    if (e.target.id === 'q') {
      state.f.q = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { const pos = e.target.selectionStart; render(); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); }, 150);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (vstate.id && e.key === 'Escape' && $('#modal').classList.contains('hidden')) { e.preventDefault(); libViewClose(); return; }
    if (e.key === 'Escape') { $('#lightbox').classList.add('hidden'); if (!state.rk) closeModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && $('#modal').classList.contains('hidden')) { e.preventDefault(); itemForm(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); if (state.view !== 'items') go('items'); setTimeout(() => $('#q') && $('#q').focus(), 0); }
  });

  window.addEventListener('resize', () => { if (vstate.model && (vstate.model.kind === 'pdf' || vstate.model.kind === 'image')) libViewLayout(); });
  // Documents and Data changed in the background (for example words read from a new file).
  let libTimer = null;
  keep.onLibrary(() => {
    clearTimeout(libTimer);
    libTimer = setTimeout(async () => {
      if (!state.snap || state.snap.locked || !['docs', 'files', 'libitem', 'reminders', 'dashboard'].includes(state.view)) return;
      const snap = await keep.getData().catch(() => null);
      if (!snap || snap.locked) return;
      state.snap = snap;
      if (!$('#modal').classList.contains('hidden')) return;
      if (document.activeElement && document.activeElement.id === 'libQ') refreshLibList();
      else { const sc = $('#view').scrollTop; render(); $('#view').scrollTop = sc; }
    }, 700);
  });
  if (keep.onToast) keep.onToast((m) => toast(m, 4000));
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
  keep.onRecallProgress((p) => { if (state.recallBusy) { state.recallBusy = `${p.n} of ${p.total}`; if (state.view === 'dashboard') render(); } });
  keep.onUpdate((u) => { const was = state.upd && state.upd.state; state.upd = u; renderUpdate(); if (state.view === 'settings' && was !== u.state) render(); });
  keep.updateStatus().then((u) => { state.upd = u; renderUpdate(); });

  // Icons in the menu, and the search box at the top of it (searches items as you type).
  $$('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon); });
  // The search box at the top of the menu searches everything: items (and the words in their receipts and
  // manuals), Documents and Data, as you type.
  const gs = $('#gSearch');
  let gsTimer = null;
  const runGlobal = () => {
    const q = gs.value.trim();
    state.gq = q;
    if (q.length < 2) { if (state.view === 'search') render(); return; }
    keep.searchAll(q).then(r => { if (state.gq !== q) return; state.gres = r; if (state.view !== 'search') go('search'); else render(); setTimeout(() => gs.focus(), 0); }).catch(() => {});
  };
  $('#gSearchForm').onsubmit = (e) => { e.preventDefault(); clearTimeout(gsTimer); runGlobal(); };
  gs.oninput = () => { clearTimeout(gsTimer); gsTimer = setTimeout(runGlobal, 180); };

  refresh();
})();
