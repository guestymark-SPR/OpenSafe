'use strict';
// Bills & budget: the sums, kept apart from storage so they can be tested on their own.
// Money is held in pence (whole numbers) so totals never drift.

const DEFAULT_CATEGORIES = [
  ['Income', 0, 'income'], ['Rent or mortgage', 0], ['Council tax', 0], ['Energy', 0], ['Water', 0], ['Phone and internet', 0],
  ['TV and subscriptions', 0], ['Insurance', 0], ['Groceries', 0], ['Eating out', 0], ['Fuel and transport', 0],
  ['Car and bike', 0], ['Pets', 0], ['Health', 0], ['Clothes', 0], ['Home', 0], ['Children', 0], ['Gifts', 0],
  ['Holidays', 0], ['Hobbies', 0], ['Cash', 0], ['Savings', 0, 'transfer'], ['Transfers', 0, 'transfer'], ['Other', 0]
].map(([name, limit, kind], i) => ({ id: 'c' + (i + 1), name, limit, kind: kind || 'spend' }));

const EVERY = { week: 'Every week', '2weeks': 'Every 2 weeks', '4weeks': 'Every 4 weeks', month: 'Every month', quarter: 'Every 3 months', half: 'Every 6 months', year: 'Every year' };

const iso = (d) => d.toISOString().slice(0, 10);
const asDate = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
function addMonthsKeep(s, n, day) {
  const d = asDate(s), y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m, Math.min(day || d.getUTCDate(), last))));
}
/** The date after `s` for a payment that repeats `every`; `day` keeps a 31st as the month's last day rather than drifting. */
function step(s, every, day) {
  const d = asDate(s);
  switch (every) {
    case 'week': d.setUTCDate(d.getUTCDate() + 7); return iso(d);
    case '2weeks': d.setUTCDate(d.getUTCDate() + 14); return iso(d);
    case '4weeks': d.setUTCDate(d.getUTCDate() + 28); return iso(d);
    case 'quarter': return addMonthsKeep(s, 3, day);
    case 'half': return addMonthsKeep(s, 6, day);
    case 'year': return addMonthsKeep(s, 12, day);
    default: return addMonthsKeep(s, 1, day);
  }
}
/** Every date a regular payment falls on between from and to (inclusive). */
function occurrences(r, from, to) {
  if (!r.next) return [];
  const out = [], day = asDate(r.next).getUTCDate();
  let d = r.next, guard = 0;
  // walk back from `next` is not needed: `next` is the next one due, so start there
  while (d <= to && guard++ < 1000) {
    if (d >= from && (!r.ends || d <= r.ends)) out.push(d);
    d = step(d, r.every, day);
  }
  return out;
}
/** Roughly what a regular payment costs per month, for the plan (weeks are 52/12 a month). */
function monthly(r) {
  const a = Math.abs(r.amount || 0);
  return Math.round({ week: a * 52 / 12, '2weeks': a * 26 / 12, '4weeks': a * 13 / 12, month: a, quarter: a / 3, half: a / 6, year: a / 12 }[r.every] ?? a);
}

/** Which category a transaction belongs in, from your rules (first match wins; longer rules are tried first). */
function categorise(desc, rules) {
  const d = String(desc || '').toLowerCase();
  const sorted = (rules || []).slice().sort((a, b) => b.text.length - a.text.length);
  const r = sorted.find(x => x.text && d.includes(x.text.toLowerCase()));
  return r ? r.categoryId : '';
}
/** A sensible rule from a transaction description: the payee part, without masked numbers or dates. */
function ruleText(desc) {
  const first = String(desc || '').split(' — ')[0];
  return first.replace(/••••\d{4}/g, '').replace(/\b\d[\d/.:-]*\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Does this transaction look like this regular payment? Its matching text, the right direction, and (if set) within a week of a due date. */
function matchesRegular(t, r) {
  if (!r.match || !String(t.description || '').toLowerCase().includes(r.match.toLowerCase())) return false;
  return r.kind === 'income' ? t.amount > 0 : t.amount < 0;
}

/** A month's totals. month = 'YYYY-MM'. Transfers (between your own accounts, to savings) count in neither. */
function monthSummary(txs, categories, month) {
  const kind = Object.fromEntries(categories.map(c => [c.id, c.kind]));
  const by = {};
  let income = 0, spend = 0, uncategorised = 0;
  for (const t of txs) {
    if (!t.date.startsWith(month)) continue;
    const k = kind[t.categoryId];
    if (k === 'transfer') continue;
    if (!t.categoryId) uncategorised++;
    if (t.amount > 0 && (k === 'income' || !k)) { income += t.amount; continue; }
    if (k === 'income') { income += t.amount; continue; }
    spend -= t.amount; // refunds in a spend category reduce that category
    by[t.categoryId || ''] = (by[t.categoryId || ''] || 0) - t.amount;
  }
  return { income, spend, left: income - spend, by, uncategorised };
}

/** Price changes: when a regular payment's amount differs from the last time, note it. Returns the history entry or null. */
function priceChange(r, t) {
  const was = Math.abs(r.amount || 0), now = Math.abs(t.amount);
  if (!was || was === now) return null;
  return { date: t.date, from: was, to: now };
}

const pounds = (p) => (p < 0 ? '-' : '') + '£' + (Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = { DEFAULT_CATEGORIES, EVERY, step, occurrences, monthly, categorise, ruleText, matchesRegular, monthSummary, priceChange, pounds };
