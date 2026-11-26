'use strict';
// Builds the printable insurance / inventory report (rendered to PDF by main.js).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => (n === null || n === undefined) ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
const ukDate = (s) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';

function buildReportHtml(store, opts) {
  const includeInactive = !!opts.includeInactive;
  const includePhotos = opts.includePhotos !== false;
  const assets = store.allAssets()
    .filter(a => includeInactive || !['Sold', 'Disposed', 'Lost / Stolen'].includes(a.status))
    .slice()
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));

  const groups = new Map();
  for (const a of assets) {
    const c = a.category || 'Uncategorised';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(a);
  }
  const val = (a) => a.currentValue ?? a.purchasePrice ?? 0;
  const total = assets.reduce((t, a) => t + val(a), 0);
  const insured = assets.reduce((t, a) => t + (a.insuredValue || 0), 0);
  const generated = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });

  // Photos are embedded as data URLs (decrypted in memory), so nothing unencrypted is written to disk.
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  const photo = (a) => {
    const p = includePhotos && a.photos.find(x => !x.vault);
    if (!p) return '<div class="nophoto"></div>';
    try {
      const buf = store.readAttachment(a.id, p.file);
      const ext = (p.file.match(/\.[a-z]+$/i) || [''])[0].toLowerCase();
      return `<img src="data:${mime[ext] || 'image/jpeg'};base64,${buf.toString('base64')}">`;
    } catch (_) { return '<div class="nophoto"></div>'; }
  };

  let body = '';
  for (const [cat, list] of groups) {
    const sub = list.reduce((t, a) => t + val(a), 0);
    body += `<h2>${esc(cat)} <span>${list.length} item${list.length > 1 ? 's' : ''} · ${gbp(sub)}</span></h2>
    <table><thead><tr>${includePhotos ? '<th class="ph"></th>' : ''}<th>Item</th><th class="sn">Serial no.</th><th class="pd">Purchased</th><th class="r m">Paid</th><th class="r m">Value now</th><th class="pf">Proof</th></tr></thead><tbody>`;
    for (const a of list) {
      const receipts = a.documents.filter(d => d.type === 'Receipt').length;
      body += `<tr>${includePhotos ? `<td class="ph">${photo(a)}</td>` : ''}
        <td><b>${esc(a.name)}</b><div class="sub">${esc([a.brand, a.model].filter(Boolean).join(' '))}${a.location ? ' · ' + esc(a.location) : ''}${a.status !== 'Owned' ? ' · ' + esc(a.status) : ''}</div></td>
        <td class="mono">${esc(a.serial) || '—'}</td>
        <td>${ukDate(a.purchaseDate)}<div class="sub">${esc(a.supplier)}</div></td>
        <td class="r">${gbp(a.purchasePrice)}</td>
        <td class="r">${gbp(a.currentValue)}</td>
        <td class="sub">${a.photos.length} photo${a.photos.length === 1 ? '' : 's'}<br>${receipts ? receipts + ' receipt' + (receipts > 1 ? 's' : '') : 'no receipt'}</td></tr>`;
    }
    body += '</tbody></table>';
  }
  if (!assets.length) body = '<p>No items to report.</p>';

  return `<!doctype html><html><head><meta charset="utf-8"><title>OpenSafe inventory report</title>
<style>
  *{box-sizing:border-box} body{font:10pt/1.4 "Segoe UI",Arial,sans-serif;color:#1d1d1b;margin:0}
  h1{font-size:18pt;margin:0 0 2pt} .meta{color:#666;margin-bottom:12pt}
  .totals{display:flex;gap:10pt;margin:0 0 14pt}.totals div{border:1px solid #ddd;border-radius:6px;padding:6pt 10pt;flex:1}
  .totals b{display:block;font-size:13pt}
  h2{font-size:12pt;margin:16pt 0 4pt;border-bottom:2px solid #1d4d4f;padding-bottom:2pt;page-break-after:avoid}
  h2 span{font-weight:400;color:#666;font-size:9.5pt;margin-left:6pt}
  table{width:100%;border-collapse:collapse;table-layout:fixed} th.ph{width:62pt} th.sn{width:16%} th.pd{width:15%} th.m{width:12%} th.pf{width:13%} th{text-align:left;font-size:8.5pt;color:#666;font-weight:600;padding:3pt 4pt;border-bottom:1px solid #ccc}
  td{padding:4pt;border-bottom:1px solid #eee;vertical-align:top} tr{page-break-inside:avoid}
  .r{text-align:right;white-space:nowrap} .mono{font-family:Consolas,monospace;font-size:9pt}
  .sub{color:#666;font-size:8.5pt} .ph{width:58pt} img,.nophoto{width:54pt;height:40pt;object-fit:cover;border-radius:3pt;background:#eee;display:block}
  .foot{margin-top:18pt;color:#888;font-size:8pt}
</style></head><body>
<h1>Household inventory report</h1>
<div class="meta">Generated ${esc(generated)} by OpenSafe · ${assets.length} item${assets.length === 1 ? '' : 's'}${includeInactive ? ' (including sold, disposed and lost items)' : ''}</div>
<div class="totals"><div>Total value now<b>${gbp(total)}</b></div><div>Insured value recorded<b>${gbp(insured)}</b></div><div>Items with receipts<b>${assets.filter(a => a.documents.some(d => d.type === 'Receipt')).length} of ${assets.length}</b></div></div>
${body}
<div class="foot">"Value now" uses the current value you entered, or the purchase price where none was entered (in the totals only). Figures are as recorded in OpenSafe and are not a professional valuation.</div>
</body></html>`;
}

module.exports = { buildReportHtml };
