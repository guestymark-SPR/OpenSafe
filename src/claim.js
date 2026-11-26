'use strict';
// Insurance claim pack: a cover page, then one section per item with every photo, all details
// and receipt images. PDF documents (receipts, warranties) are appended after (see main.js).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => (n === null || n === undefined || n === '') ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
const ukDate = (s) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const extOf = (f) => (String(f).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();

const DETAIL_LABELS = {
  reg: 'Registration', vin: 'VIN / frame number', engineNo: 'Engine number', mileage: 'Mileage', fuel: 'Fuel', colour: 'Colour',
  motDue: 'MOT due', taxDue: 'Road tax due', serviceDue: 'Next service due', boatName: 'Boat name', hin: 'Hull ID (HIN/CIN)',
  sso: 'Registration (SSR/Part 1)', mmsi: 'MMSI', callSign: 'Call sign', lengthM: 'Length (m)', engine: 'Engine', engineHours: 'Engine hours', mooring: 'Mooring'
};

/**
 * @returns {{ html: string, pdfs: {item: string, name: string, buf: Buffer}[], skipped: string[] }}
 */
function buildClaimPack(store, ids, info = {}) {
  const items = ids.map(id => store.getAsset(id)).filter(Boolean);
  if (!items.length) throw new Error('Choose at least one item for the claim pack.');
  const policies = store.data.policies || [];
  const meta = store.vault ? store.vault.fileMeta : {};
  const nameOf = (r) => (r.vault && meta[r.id] && meta[r.id].name) || r.name;
  const skipped = [];
  const pdfs = [];
  const val = (a) => a.currentValue ?? a.purchasePrice ?? 0;
  const total = items.reduce((t, a) => t + val(a), 0);

  const readImage = (a, r) => {
    const ext = extOf(r.file);
    if (!MIME[ext]) return null;
    try { return `data:${MIME[ext]};base64,${store.readAttachment(a.id, r.file).toString('base64')}`; }
    catch (e) { skipped.push(`${a.name}: ${nameOf(r)} (${e.code === 'VAULT_LOCKED' ? 'in the locked vault' : 'couldn\'t be read'})`); return null; }
  };

  const usedPolicies = [...new Set(items.map(a => a.policyId).filter(Boolean))].map(id => policies.find(p => p.id === id)).filter(Boolean);
  const policyBlock = usedPolicies.length
    ? usedPolicies.map(p => `<tr><td><b>${esc(p.insurer)}</b> · ${esc(p.type)}</td><td class="mono">${esc(p.policyNumber || '—')}</td><td>${p.excess !== null && p.excess !== undefined ? 'Excess ' + gbp(p.excess) : ''}</td><td>${esc(p.claimsPhone || '')}</td></tr>`).join('')
    : '';

  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Insurance claim pack</title><style>
  *{box-sizing:border-box} body{font:10.5pt/1.45 "Segoe UI",Arial,sans-serif;color:#1d1d1b;margin:0}
  h1{font-size:20pt;margin:0 0 4pt} h2{font-size:14pt;margin:0 0 4pt;color:#1d4d4f} h3{font-size:11pt;margin:14pt 0 6pt;color:#1d4d4f;border-bottom:1px solid #ccc;padding-bottom:2pt}
  .muted{color:#666} .mono{font-family:Consolas,monospace}
  table{width:100%;border-collapse:collapse} th{text-align:left;font-size:9pt;color:#666;font-weight:600;padding:4pt;border-bottom:1px solid #bbb}
  td{padding:4pt;border-bottom:1px solid #eee;vertical-align:top} .r{text-align:right;white-space:nowrap}
  .box{border:1px solid #ddd;border-radius:6px;padding:8pt 10pt;margin:10pt 0}
  .kv{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6pt 14pt} .kv .k{font-size:8.5pt;color:#666} .kv .v{font-weight:500;word-break:break-word}
  .item{page-break-before:always}
  .photos{display:grid;grid-template-columns:1fr 1fr;gap:8pt} .photos img{width:100%;max-height:230pt;object-fit:contain;border:1px solid #ddd;border-radius:4pt;background:#f6f6f6}
  .receipt img{max-width:100%;max-height:520pt;border:1px solid #ddd;display:block;margin:4pt 0 10pt}
  .total{font-size:13pt;font-weight:700} .foot{margin-top:16pt;color:#888;font-size:8pt}
  </style></head><body>
  <h1>Insurance claim</h1>
  <div class="muted">Prepared ${esc(new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }))} with OpenSafe · ${items.length} item${items.length === 1 ? '' : 's'}</div>
  <div class="box"><div class="kv">
    <div><div class="k">Date of incident</div><div class="v">${esc(info.incidentDate ? ukDate(info.incidentDate) : '—')}</div></div>
    <div><div class="k">Claim number</div><div class="v mono">${esc(info.claimNumber || '—')}</div></div>
    <div><div class="k">Police / crime reference</div><div class="v mono">${esc(info.crimeRef || '—')}</div></div>
  </div>${info.whatHappened ? `<div style="margin-top:8pt"><div class="muted" style="font-size:8.5pt">What happened</div><div style="white-space:pre-wrap">${esc(info.whatHappened)}</div></div>` : ''}</div>
  ${policyBlock ? `<h3>Policy</h3><table><tbody>${policyBlock}</tbody></table>` : ''}
  <h3>Items claimed</h3>
  <table><thead><tr><th>Item</th><th>Serial / ID</th><th>Bought</th><th class="r">Paid</th><th class="r">Value now</th><th>Evidence</th></tr></thead><tbody>
  ${items.map(a => {
    const det = a.details || {};
    const id = a.serial || det.vin || det.reg || det.hin || '';
    const receipts = a.documents.filter(d => d.type === 'Receipt').length;
    return `<tr><td><b>${esc(a.name)}</b><div class="muted">${esc([a.brand, a.model].filter(Boolean).join(' '))}</div></td><td class="mono">${esc(id || '—')}</td>
      <td>${a.purchaseDate ? ukDate(a.purchaseDate) : '—'}<div class="muted">${esc(a.supplier || '')}</div></td><td class="r">${gbp(a.purchasePrice)}</td><td class="r">${gbp(a.currentValue)}</td>
      <td class="muted">${a.photos.length} photo${a.photos.length === 1 ? '' : 's'}, ${receipts} receipt${receipts === 1 ? '' : 's'}</td></tr>`;
  }).join('')}
  </tbody></table>
  <p class="total">Total value claimed: ${gbp(total)}</p>
  <p class="muted" style="font-size:8.5pt">"Value now" uses the current value recorded, or the price paid where none was recorded. Figures are as recorded by the policyholder in OpenSafe and are not a professional valuation.</p>`;

  for (const a of items) {
    const det = a.details || {};
    const kv = (k, v) => v ? `<div><div class="k">${k}</div><div class="v">${v}</div></div>` : '';
    const pol = policies.find(p => p.id === a.policyId);
    const photos = a.photos.map(p => readImage(a, p)).filter(Boolean);
    const docImgs = [];
    const docList = [];
    for (const d of a.documents) {
      const ext = extOf(d.file);
      if (MIME[ext]) { const src = readImage(a, d); if (src) docImgs.push({ d, src }); }
      else if (ext === '.pdf') {
        try { pdfs.push({ item: a.name, name: nameOf(d), buf: store.readAttachment(a.id, d.file) }); docList.push(`${esc(nameOf(d))} <span class="muted">(${esc(d.type)}, attached at the end of this pack)</span>`); }
        catch (e) { skipped.push(`${a.name}: ${nameOf(d)} (${e.code === 'VAULT_LOCKED' ? 'in the locked vault' : 'couldn\'t be read'})`); }
      } else docList.push(`${esc(nameOf(d))} <span class="muted">(${esc(d.type)}; ${esc(ext.slice(1).toUpperCase())} files can't be included, send it separately)</span>`);
    }
    html += `<section class="item"><h2>${esc(a.name)}</h2><div class="muted">${esc([a.brand, a.model, a.category].filter(Boolean).join(' · '))}</div>
      <div class="box"><div class="kv">
        ${kv('Serial number', a.serial ? `<span class="mono">${esc(a.serial)}</span>` : '')}${kv('Barcode', a.barcode ? `<span class="mono">${esc(a.barcode)}</span>` : '')}
        ${kv('Bought on', a.purchaseDate ? ukDate(a.purchaseDate) : '')}${kv('Bought from', esc(a.supplier))}${kv('Price paid', a.purchasePrice !== null ? gbp(a.purchasePrice) : '')}
        ${kv('Value now', a.currentValue !== null ? gbp(a.currentValue) : '')}${kv('Condition', esc(a.condition))}${kv('Warranty until', a.warrantyExpiry ? ukDate(a.warrantyExpiry) : '')}
        ${kv('Location', esc(a.location))}${kv('Insurer', esc(pol ? pol.insurer : a.insurer))}${kv('Policy number', esc(pol ? pol.policyNumber : a.policyNumber))}
        ${kv('Insured value', a.insuredValue !== null ? gbp(a.insuredValue) : '')}
        ${Object.entries(DETAIL_LABELS).map(([k, l]) => kv(l, det[k] ? (/Due$/.test(k) ? ukDate(det[k]) : `<span class="${/vin|hin|reg|engineNo|sso|mmsi/.test(k) ? 'mono' : ''}">${esc(det[k])}</span>`) : '')).join('')}
      </div>${a.notes ? `<div style="margin-top:6pt;white-space:pre-wrap">${esc(a.notes)}</div>` : ''}</div>
      ${photos.length ? `<h3>Photos (${photos.length})</h3><div class="photos">${photos.map(src => `<img src="${src}">`).join('')}</div>` : '<p class="muted">No photos recorded.</p>'}
      ${docImgs.length ? `<h3>Receipts and documents</h3>${docImgs.map(({ d, src }) => `<div class="receipt"><b>${esc(nameOf(d))}</b> <span class="muted">(${esc(d.type)})</span><img src="${src}"></div>`).join('')}` : ''}
      ${docList.length ? `<h3>${docImgs.length ? 'More documents' : 'Documents'}</h3><ul>${docList.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
      </section>`;
  }
  html += `<div class="foot">Generated by OpenSafe. Photos and documents are as stored by the policyholder.</div></body></html>`;
  return { html, pdfs, skipped };
}

module.exports = { buildClaimPack };
