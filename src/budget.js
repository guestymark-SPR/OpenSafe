'use strict';
// Bills & budget: the sums, kept apart from storage so they can be tested on their own.
// Money is held in pence (whole numbers) so totals never drift.

const DEFAULT_CATEGORIES = [
  ['Income', 0, 'income'], ['Rent or mortgage', 0], ['Council tax', 0], ['Energy', 0], ['Water', 0], ['Phone and internet', 0],
  ['TV and subscriptions', 0], ['Insurance', 0], ['Groceries', 0], ['Eating out', 0], ['Fuel and transport', 0],
  ['Car and bike', 0], ['Pets', 0], ['Health', 0], ['Clothes', 0], ['Home', 0], ['Children', 0], ['Gifts', 0],
  ['Holidays', 0], ['Hobbies', 0], ['Cash', 0], ['Savings', 0, 'savings'], ['Transfers', 0, 'transfer'], ['Other', 0]
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

/** A transaction's parts: its splits if it has them, otherwise itself. */
const parts = (t) => Array.isArray(t.splits) && t.splits.length ? t.splits.map(x => ({ amount: x.amount, categoryId: x.categoryId || '' })) : [{ amount: t.amount, categoryId: t.categoryId || '' }];
/** Is a date in a period? A period is 'YYYY-MM' (a calendar month) or { from, to } (from inclusive, to exclusive). */
const inPeriod = (d, p) => typeof p === 'string' ? d.startsWith(p) : d >= p.from && d < p.to;

/** A period's totals. Transfers (between your own accounts) count in nothing; savings count as saved. */
function monthSummary(txs, categories, month) {
  const kind = Object.fromEntries(categories.map(c => [c.id, c.kind]));
  const by = {};
  let income = 0, spend = 0, saved = 0, uncategorised = 0;
  for (const tx of txs) {
    if (!inPeriod(tx.date, month)) continue;
    for (const t of parts(tx)) {
    const k = kind[t.categoryId];
    if (k === 'transfer') continue;
    if (k === 'savings') { saved -= t.amount; continue; }
    if (!t.categoryId) uncategorised++;
    if (t.amount > 0 && (k === 'income' || !k)) { income += t.amount; continue; }
    if (k === 'income') { income += t.amount; continue; }
    spend -= t.amount; // refunds in a spend category reduce that category
    by[t.categoryId || ''] = (by[t.categoryId || ''] || 0) - t.amount;
    }
  }
  return { income, spend, saved, left: income - spend - saved, by, uncategorised };
}

/** Price changes: when a regular payment's amount differs from the last time, note it. Returns the history entry or null. */
function priceChange(r, t) {
  const was = Math.abs(r.amount || 0), now = Math.abs(t.amount);
  if (!was || was === now) return null;
  return { date: t.date, from: was, to: now };
}

// ---------- savings goals ----------
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
/**
 * Where a goal stands. Saved = money you've added by hand (can be minus, for money taken out) plus
 * transactions put towards it (money leaving your account counts as saved).
 * Monthly need: what's still to save spread over the months left, counting this month, up to and including the target month.
 */
function goalStatus(g, txs, today) {
  const month = today.slice(0, 7);
  const added = (g.money || []).reduce((t, m) => t + m.amount, 0);
  const fromTx = (txs || []).filter(t => t.goalId === g.id).reduce((t, x) => t - x.amount, 0);
  const saved = added + fromTx;
  const left = Math.max(0, g.target - saved);
  const monthsLeft = g.by ? Math.max(1, monthsBetween(month, g.by.slice(0, 7)) + 1) : 0;
  const need = monthsLeft ? Math.ceil(left / monthsLeft) : 0;
  // average put in over the last 3 full months, from dated entries
  const from = (() => { const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 3); return d.toISOString().slice(0, 7); })();
  // a goal started recently is averaged over the full months it has existed, not 3; "saved already" isn't a month's saving
  // made part-way through a month: start from the next full month
  const made = (g.createdAt || '').slice(0, 10);
  const started = !made ? '' : made.slice(8, 10) === '01' ? made.slice(0, 7) : (() => { const d = new Date(made.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); })();
  const first = started && started > from ? started : from;
  const span = Math.min(3, monthsBetween(first, month));
  const inRange = (d) => d && d.slice(0, 7) >= first && d.slice(0, 7) < month;
  const recent = (g.money || []).filter(m => !m.start && inRange(m.date)).reduce((t, m) => t + m.amount, 0) + (txs || []).filter(t => t.goalId === g.id && inRange(t.date)).reduce((t, x) => t - x.amount, 0);
  const avg3 = span > 0 ? Math.round(recent / span) : 0;
  const pastDate = g.by && g.by < today;
  const state = saved >= g.target ? 'done' : pastDate ? 'late' : !g.by ? 'open' : span <= 0 ? 'new' : avg3 >= need ? 'ontrack' : 'behind';
  return { saved, left, monthsLeft, need, avg3, avgMonths: Math.max(0, span), pct: g.target ? Math.min(100, Math.floor(saved / g.target * 100)) : 0, state };
}

/**
 * The month's plan: regular income, then for each spending category the larger of its limit and the bills filed in it,
 * then bills with no category, then what your savings goals need. What's left is unplanned.
 */
function plan(b, today) {
  const cats = b.categories || [], reg = b.regular || [];
  const income = reg.filter(r => r.kind === 'income' && (!r.ends || r.ends >= today)).reduce((t, r) => t + monthly(r), 0);
  const bills = reg.filter(r => r.kind !== 'income' && (!r.ends || r.ends >= today));
  const lines = [];
  for (const c of cats.filter(c => c.kind === 'spend')) {
    const inCat = bills.filter(r => r.categoryId === c.id).reduce((t, r) => t + monthly(r), 0);
    const amt = Math.max(c.limit || 0, inCat);
    if (amt) lines.push({ categoryId: c.id, name: c.name, amount: amt, bills: inCat, limit: c.limit || 0 });
  }
  const loose = bills.filter(r => !r.categoryId || !cats.some(c => c.id === r.categoryId && c.kind === 'spend'));
  for (const r of loose) lines.push({ billId: r.id, name: r.name, amount: monthly(r), bills: monthly(r), limit: 0 });
  const spend = lines.reduce((t, l) => t + l.amount, 0);
  const goals = (b.goals || []).filter(g => !g.done).map(g => ({ id: g.id, name: g.name, amount: goalStatus(g, b.transactions, today).need })).filter(g => g.amount);
  const toGoals = goals.reduce((t, g) => t + g.amount, 0);
  return { income, lines, spend, goals, toGoals, left: income - spend - toGoals };
}


// ---------- budget periods: calendar months, or payday to payday ----------
const iso2 = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
/**
 * The period a budget "month" covers. settings.monthStart: { day: 1-28 or 'last', weekend: 'before' | 'after' | '' }.
 * key 'YYYY-MM' is the month the period starts in. With day 1 and no weekend rule it is the calendar month.
 */
function periodStart(key, ms) {
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = !ms || !ms.day ? 1 : ms.day === 'last' ? last : Math.min(Number(ms.day), last);
  const d = new Date(Date.UTC(y, m, day));
  const wd = d.getUTCDay();
  if (ms && ms.weekend === 'before' && (wd === 0 || wd === 6)) d.setUTCDate(d.getUTCDate() - (wd === 6 ? 1 : 2));
  if (ms && ms.weekend === 'after' && (wd === 0 || wd === 6)) d.setUTCDate(d.getUTCDate() + (wd === 6 ? 2 : 1));
  return d.toISOString().slice(0, 10);
}
const nextKey = (key, n = 1) => { const d = new Date(key + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
function period(key, ms) {
  const from = periodStart(key, ms), to = periodStart(nextKey(key), ms);
  const last = new Date(Date.parse(to + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  return { key, from, to, last, calendar: !ms || ((!ms.day || ms.day === 1) && !ms.weekend) };
}
/** Which period a date is in. */
function periodOf(date, ms) {
  let key = date.slice(0, 7);
  if (date < periodStart(key, ms)) key = nextKey(key, -1);
  else if (date >= periodStart(nextKey(key), ms)) key = nextKey(key);
  return key;
}

// ---------- carry-over (rollover) ----------
/**
 * For categories with carry-over on: what's left from earlier periods is added to this period's limit
 * (overspending takes it away). Counting starts at the period carry-over was turned on in.
 * spentBy(key) gives { categoryId: spent } for a period. Returns { categoryId: carried } for `key`.
 */
function carried(categories, key, spentBy) {
  const out = {};
  for (const c of categories) {
    if (c.kind !== 'spend' || !c.rollover || !c.rolloverFrom || key <= c.rolloverFrom) continue;
    let carry = 0, k = c.rolloverFrom, guard = 0;
    while (k < key && guard++ < 240) { carry += (c.limit || 0) - ((spentBy(k) || {})[c.id] || 0); k = nextKey(k); }
    out[c.id] = carry;
  }
  return out;
}

// ---------- accounts and balances ----------
/**
 * The latest balance of each account, from the balance column of its imported transactions.
 * On the last day there can be several transactions in any order: the closing one is the one no other transaction follows on from.
 */
function accountBalances(txs) {
  const by = {};
  for (const t of txs) { if (t.balance == null || !Number.isFinite(t.balance)) continue; const a = t.account || 'Account'; (by[a] = by[a] || []).push(t); }
  const out = {};
  for (const [a, list] of Object.entries(by)) {
    const lastDate = list.reduce((m, t) => t.date > m ? t.date : m, '');
    const day = list.filter(t => t.date === lastDate);
    // t is followed by u when u's balance before it (u.balance - u.amount) equals t's balance
    const closing = day.filter(t => !day.some(u => u !== t && u.balance - u.amount === t.balance));
    const pick = closing.length === 1 ? closing[0] : day[day.length - 1];
    out[a] = { balance: pick.balance, date: lastDate, sure: closing.length === 1 };
  }
  return out;
}

/**
 * Day by day from the latest statement: start balance, plus regular income, minus regular bills,
 * minus everyday spending if given (pence a day). Returns { start, from, days: [{ date, balance, items }], low, lowDate, short }.
 */
function forecast({ start, from, to, regular, daily = 0, buffer = 0, today = '' }) {
  const ev = {};
  for (const r of regular || []) for (const d of occurrences(r, addDays(from, 1), to)) (ev[d] = ev[d] || []).push({ name: r.name, amount: r.kind === 'income' ? r.amount : -r.amount });
  const days = [];
  // days between the statement and today still change the balance, but the low point and warning only look ahead
  let bal = start, low = Infinity, lowDate = '', firstShort = '';
  if (!today || today <= from) { low = start; lowDate = from; }
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const items = ev[d] || [];
    bal += items.reduce((t, x) => t + x.amount, 0) - daily;
    if (today && d < today) continue;
    if (bal < low) { low = bal; lowDate = d; }
    if (!firstShort && bal < buffer) firstShort = d;
    days.push({ date: d, balance: Math.round(bal), items });
  }
  return { start, from, to, days, low: Math.round(low), lowDate, short: firstShort };
}
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** Average everyday spending a day over the last `days` days: spending not matched to a regular bill, not transfers or savings. */
function dailySpend(txs, categories, today, days = 90) {
  const kind = Object.fromEntries(categories.map(c => [c.id, c.kind]));
  const from = addDays(today, -days);
  let tot = 0;
  for (const tx of txs) {
    if (tx.date < from || tx.date >= today || tx.billId) continue;
    for (const t of parts(tx)) { const k = kind[t.categoryId]; if (k === 'transfer' || k === 'savings' || k === 'income' || t.amount >= 0) continue; tot -= t.amount; }
  }
  return Math.round(tot / days);
}

// ---------- finding regular payments ----------
const PER_YEAR = { week: 52, '2weeks': 26, '4weeks': 13, month: 12, quarter: 4, half: 2, year: 1 };
const EVERY_DAYS = [['week', 7, 1], ['2weeks', 14, 2], ['4weeks', 28, 2], ['month', 30.4, 4], ['quarter', 91, 7], ['half', 182, 10], ['year', 365, 10]];
/**
 * Payments that repeat but aren't one of your regular bills or income yet. Groups by payee, then looks for a steady gap.
 * Needs 3 payments (2 for yearly ones, which are seen less often). Ignores transfers and savings.
 */
function findRegular(txs, categories, regular, today) {
  const kind = Object.fromEntries(categories.map(c => [c.id, c.kind]));
  const known = (regular || []).filter(r => r.match).map(r => r.match.toLowerCase());
  const groups = {};
  for (const t of txs) {
    if (t.billId || kind[t.categoryId] === 'transfer' || kind[t.categoryId] === 'savings' || t.goalId) continue;
    const key = ruleText(t.description).toLowerCase();
    if (key.length < 3 || known.some(k => key.includes(k) || k.includes(key))) continue;
    const g = groups[key + (t.amount > 0 ? '+' : '-')] = groups[key + (t.amount > 0 ? '+' : '-')] || { key, income: t.amount > 0, list: [] };
    g.list.push(t);
  }
  const out = [];
  for (const g of Object.values(groups)) {
    const list = g.list.slice().sort((a, b) => a.date.localeCompare(b.date));
    // one per day at most (two coffees on one day aren't two bills)
    const dates = [...new Set(list.map(t => t.date))];
    if (dates.length < 2) continue;
    const gaps = dates.slice(1).map((d, i) => Math.round((Date.parse(d) - Date.parse(dates[i])) / 864e5));
    const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const fit = EVERY_DAYS.find(([, n, tol]) => Math.abs(med - n) <= tol + (n === 30.4 ? 0 : 0));
    if (!fit) continue;
    const [every, n, tol] = fit;
    if (dates.length < (every === 'year' || every === 'half' ? 2 : 3)) continue;
    if (!gaps.every(x => Math.abs(x - n) <= tol + (every === 'month' ? 0 : 0))) continue;
    // monthly ones should land on about the same day of the month
    if (every === 'month') { const ds = dates.map(d => Number(d.slice(8, 10))); const spread = Math.max(...ds) - Math.min(...ds); if (spread > 6 && spread < 25) continue; }
    const last = list[list.length - 1];
    const amounts = list.map(t => Math.abs(t.amount));
    const same = amounts.every(a => a === amounts[0]);
    // still going? the next one shouldn't be long overdue
    let next = last.date; const day = Number(last.date.slice(8, 10)); let guard = 0;
    do { next = step(next, every, day); } while (next < today && guard++ < 400);
    const overdueBy = Math.round((Date.parse(today) - Date.parse(step(last.date, every, day))) / 864e5);
    if (overdueBy > Math.max(10, n * 0.5)) continue;
    const cats = {}; for (const t of list) if (t.categoryId) cats[t.categoryId] = (cats[t.categoryId] || 0) + 1;
    const categoryId = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const name = ruleText(last.description);
    out.push({ key: g.key, name, kind: g.income ? 'income' : 'bill', every, amount: Math.abs(last.amount), same, low: Math.min(...amounts), high: Math.max(...amounts),
      count: dates.length, first: dates[0], last: last.date, next, match: name.slice(0, 40), categoryId, yearly: Math.abs(last.amount) * PER_YEAR[every] });
  }
  return out.sort((a, b) => b.yearly - a.yearly);
}

// ---------- yearly and irregular costs ----------
/**
 * Bills that don't come every month (quarterly, six-monthly, yearly): what to put aside each month for them,
 * and how much should be put aside by now for the next one (the share of the gap since the last one that has passed).
 */
function sinking(regular, today) {
  const GAP = { quarter: 3, half: 6, year: 12 };
  return (regular || []).filter(r => r.kind !== 'income' && GAP[r.every] && r.next && (!r.ends || r.ends >= today)).map(r => {
    const months = GAP[r.every];
    const prev = (() => { const d = new Date(r.next + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); })();
    const span = Date.parse(r.next) - Date.parse(prev), gone = Math.min(span, Math.max(0, Date.parse(today) - Date.parse(prev)));
    return { id: r.id, name: r.name, amount: r.amount, every: r.every, next: r.next, perMonth: Math.ceil(r.amount / months), byNow: Math.round(r.amount * gone / span) };
  }).sort((a, b) => a.next.localeCompare(b.next));
}

const pounds = (p) => (p < 0 ? '-' : '') + '£' + (Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = { PER_YEAR, parts, inPeriod, period, periodOf, periodStart, nextKey, carried, accountBalances, forecast, dailySpend, findRegular, sinking, addDays, goalStatus, plan, DEFAULT_CATEGORIES, EVERY, step, occurrences, monthly, categorise, ruleText, matchesRegular, monthSummary, priceChange, pounds };
