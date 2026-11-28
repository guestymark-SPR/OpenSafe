'use strict';
// Reminders as a calendar file (.ics) for Outlook, Google Calendar or the phone's calendar.
// Each reminder is an all-day event with a stable ID (the same reminder keeps the same ID in every
// file), with an alert at 9am the day before.

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const day = (iso) => iso.replace(/-/g, '');
function nextDay(iso) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
/** Lines over 75 bytes are folded (RFC 5545), without splitting a character. */
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const slug = (s) => String(s || 'reminder').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** @param reminders from store.reminders(): { kind, assetName, date, assetId|libraryId|policyId } */
function build(reminders, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenSafe//Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:OpenSafe reminders'];
  const seen = new Set();
  for (const r of reminders) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const who = r.assetId || r.libraryId || r.policyId || r.regularId || slug(r.assetName);
    const uid = `${slug(r.kind)}-${who}@opensafe`;
    if (seen.has(uid)) continue;
    seen.add(uid);
    const what = r.libraryId ? 'Documents' : r.policyId ? 'Insurance' : r.regularId ? 'Bills & budget' : 'Items';
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(r.date)}`, `DTEND;VALUE=DATE:${day(nextDay(r.date))}`,
      `SUMMARY:${esc(`${r.kind}: ${r.assetName}`)}`, `DESCRIPTION:${esc(`From OpenSafe (${what}). Open OpenSafe to see the details or mark it done.`)}`,
      'TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(r.kind)}`, 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { text: lines.map(fold).join('\r\n') + '\r\n', count: seen.size };
}

module.exports = { build, fold };
