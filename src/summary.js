'use strict';
// The Monday summary's words, from the reminder schedule OpenSafe keeps (see writeSchedule in main.js):
// with password protection on, that schedule has dates and kinds only, so the summary gives counts.
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const ukShort = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function summaryText(sch, today) {
  if (!sch) return 'Open OpenSafe once so it can work out your week.';
  const week = (sch.entries || []).filter(e => dayDiff(today, e.date) >= 0 && dayDiff(today, e.date) <= 6);
  const overdue = (sch.entries || []).filter(e => dayDiff(today, e.date) < 0 && dayDiff(today, e.date) >= -60);
  const waiting = (sch.waiting || []).map(w => Object.assign({ days: dayDiff(w.sentOn, today) }, w)).sort((a, b) => b.days - a.days);
  const lines = [];
  if (sch.named) {
    for (const e of week.slice(0, 3)) lines.push(`${e.label} (${e.date === today ? 'today' : ukShort(e.date)})`);
    if (week.length > 3) lines.push(`…and ${week.length - 3} more this week`);
  } else if (week.length) lines.push(`${week.length} thing${week.length === 1 ? '' : 's'} due this week`);
  if (overdue.length) lines.push(`${overdue.length} overdue`);
  if (waiting.length) lines.push(sch.named
    ? `Waiting for replies: ${waiting.slice(0, 3).map(w => `${w.who} (${w.days} day${w.days === 1 ? '' : 's'})`).join(', ')}${waiting.length > 3 ? ` and ${waiting.length - 3} more` : ''}`
    : `${waiting.length} letter${waiting.length === 1 ? '' : 's'} waiting for a reply, the oldest for ${waiting[0].days} days`);
  // money (from Bills & budget)
  const b = sch.budget;
  if (b) {
    const gbp = (p) => '£' + (Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (sch.named) {
      if (b.short) lines.push(`Money: your balance could run short on ${ukShort(b.short.date)}`);
      const over = (b.limits || []).filter(x => x.over), near = (b.limits || []).filter(x => !x.over);
      if (over.length) lines.push(`Over the limit: ${over.map(x => x.name).join(', ')}`);
      if (near.length) lines.push(`Nearly at the limit: ${near.map(x => x.name).join(', ')}`);
      if ((b.rises || []).length) lines.push(`Price rises: ${b.rises.slice(0, 2).map(r => `${r.name} ${gbp(r.from)} → ${gbp(r.to)}`).join(', ')}${b.rises.length > 2 ? ` and ${b.rises.length - 2} more` : ''}`);
      if (b.unusual) lines.push(`${b.unusual} unusual payment${b.unusual === 1 ? '' : 's'} to check`);
    } else {
      const n = (b.short ? 1 : 0) + (b.limits || 0) + (b.unusual || 0) + (b.rises || 0);
      if (n) lines.push(`${n} money alert${n === 1 ? '' : 's'} in Bills & budget`);
    }
  }
  return lines.length ? lines.join('\n') : 'Nothing due this week, and no letters waiting for a reply.';
}

module.exports = { summaryText };
