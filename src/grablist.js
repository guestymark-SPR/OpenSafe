'use strict';
// One-page "grab list": the things to save first in a fire or flood, sorted by room.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function buildGrabListHtml(store) {
  const items = store.allAssets().filter(a => a.grab && !['Sold', 'Disposed', 'Lost / Stolen'].includes(a.status))
    .sort((a, b) => (a.location || '~').localeCompare(b.location || '~', 'en-GB') || a.name.localeCompare(b.name, 'en-GB'));
  const photo = (a) => {
    const p = a.photos.find(x => !x.vault);
    if (!p) return '<div class="np"></div>';
    try { const ext = (p.file.match(/\.[a-z]+$/i) || [''])[0].toLowerCase(); return `<img src="data:${mime[ext] || 'image/jpeg'};base64,${store.readAttachment(a.id, p.file).toString('base64')}">`; }
    catch (_) { return '<div class="np"></div>'; }
  };
  let body = '', room = null;
  for (const a of items) {
    const r = a.location || 'No location set';
    if (r !== room) { body += `<h2>${esc(r)}</h2>`; room = r; }
    body += `<div class="it">${photo(a)}<div><b>☐ ${esc(a.name)}</b><div class="s">${esc([a.brand, a.model].filter(Boolean).join(' '))}${a.serial ? ` · <span class="m">${esc(a.serial)}</span>` : ''}</div>${a.notes ? `<div class="s">${esc(a.notes.split('\n')[0].slice(0, 140))}</div>` : ''}</div></div>`;
  }
  const when = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Grab list</title><style>
  *{box-sizing:border-box} body{font:10.5pt/1.35 "Segoe UI",Arial,sans-serif;color:#1d1d1b;margin:0}
  h1{font-size:17pt;margin:0} .meta{color:#666;margin:2pt 0 10pt;font-size:9pt}
  .warn{border:2px solid #b3261e;border-radius:6px;padding:6pt 9pt;margin-bottom:10pt;font-weight:600}
  h2{font-size:11.5pt;margin:10pt 0 3pt;border-bottom:2px solid #1d4d4f;padding-bottom:2pt;page-break-after:avoid}
  .it{display:flex;gap:8pt;align-items:center;padding:3pt 0;border-bottom:1px solid #eee;page-break-inside:avoid}
  img,.np{width:44pt;height:33pt;object-fit:cover;border-radius:3pt;background:#eee;flex:none}
  .s{color:#555;font-size:9pt} .m{font-family:Consolas,monospace}
</style></head><body>
<h1>🚨 Grab list</h1><div class="meta">${items.length} item${items.length === 1 ? '' : 's'} · printed ${esc(when)} from OpenSafe</div>
<div class="warn">Get everyone out first and call 999. Only collect these if it is completely safe to do so.</div>
${body || '<p>Nothing is on the grab list.</p>'}
</body></html>`;
}
module.exports = { buildGrabListHtml };
