'use strict';
// Suggests a letter's sender, date and reference from its words (read offline). These are only suggestions:
// OpenSafe shows them for you to accept or ignore, and never changes details you've typed.
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
function iso(y, m, d) {
  y = Number(y); if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== Number(d) || y < 1950 || y > 2100) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}
const DATE_WORDS = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(\d{4})\b/i;
const DATE_NUM = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/;
function dateIn(line) {
  let m = line.match(DATE_WORDS);
  if (m) return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  m = line.match(DATE_NUM);
  if (m) return iso(m[3], Number(m[2]), Number(m[1])); // UK order: day/month/year
  return '';
}
// The letter's own date: a line labelled "Date", else the first date near the top that isn't a deadline.
function findDate(lines) {
  for (const l of lines.slice(0, 60)) if (/^\s*(date|letter date|date of (this )?letter|issued|dated)\b\s*[:.]?/i.test(l)) { const d = dateIn(l); if (d) return d; }
  for (const l of lines.slice(0, 30)) {
    if (/\b(by|before|until|due|deadline|from|starting|start|effective|between|until|within|payment date|last payment|next payment|date of birth|dob|born)\b/i.test(l)) continue;
    const d = dateIn(l); if (d) return d;
  }
  return '';
}
// A reference: "Our ref", "Reference", "Case number", "Account number", "Policy number"…
const REF = /\b(our\s+ref(?:erence)?|reference(?:\s+number)?|ref(?:\.|erence)?(?:\s*no\.?)?|case\s+(?:number|ref(?:erence)?|no\.?)|claim\s+(?:number|ref(?:erence)?|no\.?)|account\s+(?:number|no\.?)|customer\s+(?:number|ref(?:erence)?|no\.?)|policy\s+(?:number|no\.?)|membership\s+(?:number|no\.?)|application\s+(?:number|ref(?:erence)?)|scheme\s+ref(?:erence)?|service\s+number|your\s+ref(?:erence)?)\s*(?:is)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9/\-. ]{2,28}[A-Z0-9])/i;
function findRef(lines) {
  let yours = '';
  for (const l of lines.slice(0, 80)) {
    const m = l.match(REF);
    if (!m) continue;
    let v = m[2].replace(/\s{2,}.*$/, '').replace(/\s+(date|page|tel|telephone|phone|email|dear)\b.*$/i, '').trim();
    if (!/\d/.test(v) || v.length < 4) continue; // references have numbers in them
    if (/^your/i.test(m[1])) { if (!yours) yours = v; continue; } // prefer their reference to yours
    return v;
  }
  return yours;
}
// Who it's from: a well-known sender named in the letter, else an organisation-looking line at the top.
const KNOWN = [
  [/child maintenance service/i, 'Child Maintenance Service'], [/veterans uk/i, 'Veterans UK'], [/armed forces compensation scheme|\bafcs\b/i, 'Veterans UK'],
  [/hm revenue (?:&|and) customs|\bhmrc\b/i, 'HMRC'], [/department for work (?:&|and) pensions|\bdwp\b/i, 'DWP'], [/\bdvla\b|driver and vehicle licensing/i, 'DVLA'],
  [/\bdvsa\b/i, 'DVSA'], [/ministry of defence|\bmod\b/i, 'Ministry of Defence'], [/\bnhs\b|national health service/i, 'NHS'], [/hm courts (?:&|and) tribunals|\bhmcts\b/i, 'HM Courts & Tribunals'],
  [/house of commons/i, 'House of Commons'], [/tv licensing/i, 'TV Licensing'], [/universal credit/i, 'Universal Credit (DWP)'], [/personal independence payment/i, 'DWP'],
  [/student loans company/i, 'Student Loans Company'], [/hm land registry/i, 'HM Land Registry'], [/\bhm passport office\b/i, 'HM Passport Office']
];
const ORGISH = /\b(ltd|limited|plc|llp|council|service|services|bank|building society|insurance|insurers|agency|department|office|trust|group|society|surgery|hospital|clinic|solicitors|university|college|school|association|authority|company|energy|water|telecom|mobile|garage|motors|dental|pharmacy)\b/i;
function findFrom(lines, text) {
  const top = lines.slice(0, 15).join('\n');
  for (const [re, name] of KNOWN) if (re.test(top)) return name;
  for (const l of lines.slice(0, 10)) {
    const t = l.trim();
    if (t.length < 3 || t.length > 70 || /\d{3,}|@|www\.|https?:/i.test(t) || /^(dear|re:|date|page)\b/i.test(t)) continue;
    if (ORGISH.test(t)) return t.replace(/\s{2,}/g, ' ');
  }
  for (const [re, name] of KNOWN) if (re.test(text)) return name;
  return '';
}
/** { from, docDate, ref } — any of them may be ''. */
function suggest(text) {
  const t = String(text || '').replace(/\r/g, '');
  if (t.replace(/\s/g, '').length < 20) return { from: '', docDate: '', ref: '' };
  const lines = t.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { from: findFrom(lines, t), docDate: findDate(lines), ref: findRef(lines) };
}
module.exports = { suggest };
