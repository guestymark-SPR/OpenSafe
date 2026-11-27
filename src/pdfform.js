'use strict';
// Fill in official PDF forms: read the boxes a fillable PDF has, suggest answers from your details and
// from what you typed into similar boxes before, and save a filled-in copy. Scanned or printed forms
// have no boxes to fill; forms made only for Adobe's XFA can't be filled here.

const { PDFDocument, PDFName, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = require('pdf-lib');

/** A box's label: its tooltip if the form has one, otherwise the readable end of its name. */
function labelOf(field) {
  try { const tu = field.acroField.dict.lookup(PDFName.of('TU')); if (tu && tu.decodeText) { const t = tu.decodeText().trim(); if (t) return t.slice(0, 200); } } catch (_) { /* no tooltip */ }
  const last = field.getName().split('.').pop().replace(/\[\d+\]$/, '');
  return last.replace(/[_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().slice(0, 200) || field.getName();
}
const keyOf = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const typeOf = (f) => f instanceof PDFTextField ? 'text' : f instanceof PDFCheckBox ? 'check' : f instanceof PDFDropdown ? 'choice' : f instanceof PDFRadioGroup ? 'radio' : f instanceof PDFOptionList ? 'choice' : 'other';

function ukPostcode(s) { const m = String(s || '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})\b/); return m ? m[1].replace(/^(.+?)\s?(\d[A-Z]{2})$/, '$1 $2') : ''; }
function ukDate(d = new Date()) { return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }

/** A suggested answer for a box from your details (letters' "Your details"), or '' if there's no good guess. */
function guess(label, me = {}, now = new Date()) {
  const k = keyOf(label);
  const name = String(me.name || '').trim(), parts = name.split(/\s+/).filter(Boolean);
  const lines = String(me.address || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pc = ukPostcode(me.address);
  const addrLines = lines.filter(l => !pc || l.toUpperCase().replace(/\s/g, '') !== pc.replace(/\s/g, ''));
  const has = (re) => re.test(k);
  if (has(/\b(e ?mail)\b/)) return me.email || '';
  if (has(/\b(phone|telephone|tel|mobile|contact number)\b/)) return me.phone || '';
  if (has(/\bpost ?code\b/)) return pc;
  if (has(/\b(first|fore|given) ?names?\b|\bforename/)) return parts.slice(0, -1).join(' ') || parts[0] || '';
  if (has(/\b(sur ?name|last name|family name)\b/)) return parts.length > 1 ? parts[parts.length - 1] : '';
  if (has(/\b(full name|your name|name of applicant|applicant name|^name$|^name of person)\b/) || k === 'name') return name;
  const ln = k.match(/\baddress (?:line )?(\d)\b|\baddress(\d)\b/);
  if (ln) return addrLines[Number(ln[1] || ln[2]) - 1] || '';
  if (has(/\b(town|city)\b/)) return addrLines.length > 1 ? addrLines[addrLines.length - 1] : '';
  if (k === 'address' || has(/\b(your address|home address|full address)\b/)) return lines.join(', ');
  if (has(/\b(date signed|today s date|todays date|date of signing|^date$)\b/) || k === 'date') return ukDate(now);
  return '';
}

/** The boxes in a PDF, in page order, top to bottom. */
async function read(bytes, { me = {}, remembered = {}, now = new Date() } = {}) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const pages = doc.getPages().map(p => p.ref);
  const xfa = form.hasXFA();
  const out = [];
  for (const f of form.getFields()) {
    const type = typeOf(f);
    if (type === 'other') continue;
    const w = f.acroField.getWidgets()[0];
    let page = 0, y = 0, x = 0;
    if (w) { const pi = pages.findIndex(r => r === w.P()); page = pi >= 0 ? pi + 1 : 0; const rc = w.getRectangle(); y = rc.y; x = rc.x; }
    const label = labelOf(f);
    let value = '', options = [];
    try {
      if (type === 'text') value = f.getText() || '';
      else if (type === 'check') value = f.isChecked();
      else if (type === 'radio') { options = f.getOptions(); value = f.getSelected() || ''; }
      else { options = f.getOptions(); value = (f.getSelected() || [])[0] || ''; }
    } catch (_) { /* unreadable value */ }
    const rem = remembered[keyOf(label)];
    const suggest = type === 'text' && !value ? (rem !== undefined ? String(rem) : guess(label, me, now)) : '';
    out.push({ name: f.getName(), label, type, page, value, options, suggest, readOnly: f.isReadOnly(), maxLength: type === 'text' ? (f.getMaxLength() || 0) : 0, _y: y, _x: x });
  }
  out.sort((a, b) => (a.page || 1e9) - (b.page || 1e9) || b._y - a._y || a._x - b._x);
  return { fields: out.map(({ _y, _x, ...f }) => f), xfa, pages: pages.length };
}

/** A filled-in copy. values: { fieldName: string | boolean }. flatten: answers become part of the page. */
async function fill(bytes, values, { flatten = false } = {}) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  if (form.hasXFA()) form.deleteXFA(); // otherwise PDF readers that use XFA would show the empty form
  let n = 0;
  for (const f of form.getFields()) {
    if (!(f.getName() in values) || f.isReadOnly()) continue;
    const v = values[f.getName()], type = typeOf(f);
    try {
      if (type === 'text') { let s = String(v ?? ''); const max = f.getMaxLength(); if (max) s = s.slice(0, max); f.setText(s); if (s) n++; }
      else if (type === 'check') { if (v === true || v === 'true') { f.check(); n++; } else f.uncheck(); }
      else if (type === 'radio') { if (v) { f.select(String(v)); n++; } }
      else if (type === 'choice') { if (v) { f.select(String(v)); n++; } }
    } catch (_) { /* a value the box won't take is left out */ }
  }
  form.updateFieldAppearances();
  if (flatten) form.flatten();
  return { bytes: await doc.save(), filled: n };
}

module.exports = { read, fill, guess, labelOf, keyOf, ukPostcode };
