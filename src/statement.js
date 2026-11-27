'use strict';
// Statement builder: a first draft of a numbered, dated written statement about a case, built from its
// letters (sent and received), what you highlighted in them and your notes. It's a starting point to
// edit, not legal advice: courts and tribunals may want particular wording, so check with them.
//
// The draft is plain text: one paragraph per block, numbered "1." "2." … so it can be edited freely;
// html() and docx() lay it out (heading, numbered paragraphs, a signature and date at the end).

const { wp, packDocx, longDate } = require('./letter');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateOf = (e) => e.docDate || (e.createdAt || '').slice(0, 10);

/** Entries in the order a bundle of the case puts them (oldest first; undated last), so "document 3" matches. */
function order(entries) {
  return entries.slice().sort((a, b) => {
    const ka = a.docDate || '', kb = b.docDate || '';
    if (ka && kb && ka !== kb) return ka.localeCompare(kb);
    if (!ka !== !kb) return ka ? -1 : 1;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

/**
 * @param caseName   the case
 * @param entries    its library entries (with marks, sent, from, ref, expectBy …)
 * @param replies    store.replyStatus()
 * @param me         { name, address }
 * @param opts       { bundleRefs: true, today: 'YYYY-MM-DD' }
 */
function draft(caseName, entries, replies = {}, me = {}, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const list = order(entries);
  const paras = [];
  const addr = String(me.address || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(', ');
  paras.push(`I am ${me.name || '[your name]'}${addr ? ` of ${addr}` : ''}. This statement sets out what has happened about ${caseName}, in date order. The documents I refer to are in the bundle of documents for this case${opts.bundleRefs === false ? '' : ', numbered as in its contents page'}.`);
  list.forEach((e, i) => {
    const doc = opts.bundleRefs === false ? '' : ` (document ${i + 1})`;
    const when = dateOf(e) ? `On ${longDate(dateOf(e))}` : 'On a date I have not recorded';
    const what = e.docType && e.docType !== 'Letter' && e.docType !== 'Other' ? e.docType.toLowerCase() : (e.kind === 'data' ? 'message' : 'letter');
    let p = e.sent
      ? `${when}, I wrote to ${e.from || '[who]'}${e.title ? ` ("${e.title}")` : ''}${doc}.`
      : `${when}, I received a ${what} from ${e.from || '[who]'}${e.title ? ` ("${e.title}")` : ''}${e.ref ? `, reference ${e.ref}` : ''}${doc}.`;
    const marks = (e.marks || []).slice().sort((a, b) => a.page - b.page || a.y0 - b.y0);
    for (const k of marks) {
      if (k.text) p += ` On page ${k.page} it says: "${k.text.trim()}"${/[.!?]$/.test(k.text.trim()) ? '' : '.'}`;
      if (k.note) p += ` ${k.note.trim().replace(/([^.!?])$/, '$1.')}`;
    }
    if (e.notes && e.notes.trim()) p += ` ${e.notes.trim().replace(/\s+/g, ' ').replace(/([^.!?])$/, '$1.')}`;
    const st = replies[e.id];
    if (e.sent && st) {
      if (st.replied && st.replyDate) p += ` They replied on ${longDate(st.replyDate)}.`;
      else if (!st.replied && e.expectBy && e.expectBy < today) p += ` I expected a reply by ${longDate(e.expectBy)}. As of ${longDate(today)}, I have not had one.`;
      else if (!st.replied) p += ` As of ${longDate(today)}, I have not had a reply.`;
    }
    paras.push(p);
  });
  paras.push('[Add anything else that happened, such as phone calls, and what you are asking for.]');
  return paras.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
}

/** The edited text back into numbered paragraphs (numbers are redone, so they stay in order after editing). */
function paragraphs(text) {
  return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => p.replace(/^\d+[.)]\s*/, ''));
}

function html(title, text, me = {}, date) {
  const ps = paragraphs(text);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title><style>
@page{size:A4;margin:25mm 22mm 22mm}
body{font:11.5pt/1.55 Arial,"Segoe UI",sans-serif;color:#111;margin:0}
h1{font-size:14pt;text-align:center;margin:0 0 2mm}.sub{text-align:center;color:#444;margin:0 0 9mm}
ol{margin:0;padding-left:9mm}li{margin:0 0 4mm;padding-left:2mm;white-space:pre-wrap}
.sign{margin-top:14mm}.sign div{margin:0 0 9mm}
</style></head><body>
<h1>${esc(title)}</h1><p class="sub">${esc(me.name || '')}</p>
<ol>${ps.map(p => `<li>${esc(p)}</li>`).join('')}</ol>
<div class="sign"><div>Signed: ______________________________</div><div>Name: ${esc(me.name || '')}</div><div>Date: ${esc(date ? longDate(date) : '')}</div></div>
</body></html>`;
}

async function docx(title, text, me = {}, date) {
  const body = [wp(title, { bold: true, center: true, size: 14, after: 80 }), wp(me.name || '', { center: true, after: 360 })];
  paragraphs(text).forEach((p, i) => body.push(wp(`${i + 1}.\t${p}`, { after: 200, indent: 567, hanging: 567 })));
  body.push(wp('Signed: ______________________________', { before: 480, after: 360 }));
  body.push(wp(`Name: ${me.name || ''}`, { after: 360 }));
  body.push(wp(`Date: ${date ? longDate(date) : ''}`));
  return packDocx(body, { title, creator: me.name || '' });
}

module.exports = { draft, paragraphs, html, docx, order };
