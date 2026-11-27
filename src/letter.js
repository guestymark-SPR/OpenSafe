'use strict';
// Reply writer: a UK-style letter laid out on A4, as a page for PDF and as a Word (.docx) file.
//   your name and address top right, the date, their name and address on the left,
//   "Your ref" / "Your letter dated", the subject in bold, the letter, "Yours faithfully/sincerely" and your name.
const JSZip = require('jszip');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDate = (iso) => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
const lines = (s) => String(s || '').split(/\r?\n/).map(l => l.trimEnd());

/** "Yours faithfully" when you don't know their name ("Dear Sir or Madam"), otherwise "Yours sincerely". */
function signOff(greeting) { return /sir|madam|to whom/i.test(greeting || '') ? 'Yours faithfully' : 'Yours sincerely'; }

/** Clean and complete the details, so the PDF and the Word file say the same. */
function normalise(d) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  const out = {
    fromName: s(d.fromName, 120).trim(), fromAddress: s(d.fromAddress, 600).trim(), fromPhone: s(d.fromPhone, 60).trim(), fromEmail: s(d.fromEmail, 120).trim(),
    toName: s(d.toName, 200).trim(), toAddress: s(d.toAddress, 600).trim(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : new Date().toISOString().slice(0, 10),
    yourRef: s(d.yourRef, 120).trim(), ourRef: s(d.ourRef, 120).trim(), theirDate: /^\d{4}-\d{2}-\d{2}$/.test(d.theirDate || '') ? d.theirDate : '',
    subject: s(d.subject, 200).trim(), greeting: s(d.greeting, 120).trim() || 'Dear Sir or Madam,', body: s(d.body, 20000).replace(/\r/g, '').trim()
  };
  out.closing = signOff(out.greeting);
  return out;
}
function refLines(d) {
  const r = [];
  if (d.yourRef) r.push(['Your ref', d.yourRef]);
  if (d.theirDate) r.push(['Your letter dated', longDate(d.theirDate)]);
  if (d.ourRef) r.push(['My ref', d.ourRef]);
  return r;
}
const paras = (body) => body.split(/\n{2,}/).map(p => p.split('\n'));

function html(d0) {
  const d = normalise(d0);
  const me = [d.fromName, ...lines(d.fromAddress), d.fromPhone && 'Tel: ' + d.fromPhone, d.fromEmail].filter(Boolean);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(d.subject || 'Letter')}</title><style>
@page{size:A4;margin:22mm 22mm 20mm}
body{font:11pt/1.45 Arial,"Segoe UI",sans-serif;color:#111;margin:0}
.me{text-align:right;margin-bottom:10mm}.me div{white-space:pre-wrap}
.date{text-align:right;margin-bottom:8mm}
.to{margin-bottom:8mm}.to div{white-space:pre-wrap}
.refs{margin-bottom:6mm}.refs div{margin:0}
.subj{font-weight:bold;margin:0 0 5mm}
p{margin:0 0 4mm;white-space:pre-wrap}
.close{margin-top:6mm}.sig{margin-top:14mm}
</style></head><body>
<div class="me">${me.map(l => `<div>${esc(l)}</div>`).join('')}</div>
<div class="date">${esc(longDate(d.date))}</div>
<div class="to">${[d.toName, ...lines(d.toAddress)].filter(Boolean).map(l => `<div>${esc(l)}</div>`).join('')}</div>
${refLines(d).length ? `<div class="refs">${refLines(d).map(([k, v]) => `<div>${esc(k)}: ${esc(v)}</div>`).join('')}</div>` : ''}
<p>${esc(d.greeting)}</p>
${d.subject ? `<div class="subj">${esc(d.subject)}</div>` : ''}
${paras(d.body).map(p => `<p>${p.map(esc).join('<br>')}</p>`).join('')}
<div class="close">${esc(d.closing)}</div>
<div class="sig">${esc(d.fromName)}</div>
</body></html>`;
}

// ---- Word ----
const x = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function wp(text, { right = false, center = false, bold = false, italic = false, size = 0, after = 0, before = 0, breaks = null, indent = 0, hanging = 0 } = {}) {
  const ppr = `<w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${indent || hanging ? `<w:ind w:left="${indent}" w:hanging="${hanging}"/>` : ''}${right ? '<w:jc w:val="right"/>' : center ? '<w:jc w:val="center"/>' : ''}</w:pPr>`;
  const rpr = bold || italic || size ? `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${size ? `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>` : ''}</w:rPr>` : '';
  const parts = breaks || [text];
  const runs = parts.map((t, i) => `<w:r>${rpr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`).join('');
  return `<w:p>${ppr}${runs}</w:p>`;
}
async function docx(d0) {
  const d = normalise(d0);
  const body = [];
  const me = [d.fromName, ...lines(d.fromAddress), d.fromPhone && 'Tel: ' + d.fromPhone, d.fromEmail].filter(Boolean);
  me.forEach((l, i) => body.push(wp(l, { right: true, after: i === me.length - 1 ? 360 : 0 })));
  body.push(wp(longDate(d.date), { right: true, after: 360 }));
  const to = [d.toName, ...lines(d.toAddress)].filter(Boolean);
  to.forEach((l, i) => body.push(wp(l, { after: i === to.length - 1 ? 360 : 0 })));
  const refs = refLines(d);
  refs.forEach(([k, v], i) => body.push(wp(`${k}: ${v}`, { after: i === refs.length - 1 ? 240 : 0 })));
  body.push(wp(d.greeting, { after: 200 }));
  if (d.subject) body.push(wp(d.subject, { bold: true, after: 200 }));
  for (const p of paras(d.body)) body.push(wp('', { after: 200, breaks: p }));
  body.push(wp(d.closing, { before: 120, after: 800 }));
  body.push(wp(d.fromName));
  return packDocx(body, { title: d.subject, creator: d.fromName });
}
/** A Word file from paragraphs made with wp(). */
async function packDocx(body, { title = '', creator = '' } = {}) {
  const d = { subject: title, fromName: creator };
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${x(d.subject)}</dc:title><dc:creator>${x(d.fromName)}</dc:creator></cp:coreProperties>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1247" w:bottom="1134" w:left="1247" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A starting letter that replies to one you received. */
function draftReply(e, me = {}) {
  const sub = (e.title || '').replace(/^(re|fw|fwd):\s*/i, '');
  return {
    fromName: me.name || '', fromAddress: me.address || '', fromPhone: me.phone || '', fromEmail: me.email || '',
    toName: e.from || '', toAddress: '', date: new Date().toISOString().slice(0, 10),
    yourRef: e.ref || '', theirDate: e.docDate || '', ourRef: '',
    subject: sub ? 'Re: ' + sub : '', greeting: 'Dear Sir or Madam,',
    body: `Thank you for your letter${e.docDate ? ' dated ' + longDate(e.docDate) : ''}.\n\n`
  };
}

module.exports = { html, docx, normalise, draftReply, signOff, longDate, wp, packDocx };
