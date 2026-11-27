'use strict';
// Order confirmation emails: suggests the shop, order number, date, total and the things bought
// (with prices), from the email's text. Emails are laid out very differently by each shop, so these
// are only suggestions for you to check; nothing is created without you.

const MONEY = /£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+(?:\.\d{2}))/;
const MONEY_ALL = /£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+(?:\.\d{2}))/g;
const NOT_A_THING = /\b(sub-?total|total|vat|tax|delivery|postage|shipping|p&p|discount|promotion|voucher|savings?|you saved|gift card|balance|refund|paid|payment|charged|amount|order summary|estimated|was|rrp|each|per month|credit|points)\b/i;
const pounds = (s) => Number(String(s).replace(/,/g, ''));

/** "Amazon.co.uk <auto-confirm@amazon.co.uk>" → "Amazon"; also the shop named in the text. */
function shopFrom(from, subject, text) {
  const name = String(from || '').replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  const domain = (String(from || '').match(/@([a-z0-9.-]+)/i) || [])[1] || '';
  let shop = name && !/^(orders?|no-?reply|noreply|sales|shop|customer ?services?|info|support|auto-confirm)\b/i.test(name) ? name : '';
  if (!shop && domain) { const parts = domain.toLowerCase().split('.').filter(p => !['mail', 'email', 'e', 'orders', 'order', 'news', 'www', 'em', 'info', 'uk', 'co', 'com', 'org', 'net', 'shop', 'store'].includes(p)); shop = parts[parts.length - 1] || ''; }
  shop = shop.replace(/\.(co\.uk|com|uk)$/i, '').replace(/\b(orders?|customer services?|team)\b/ig, '').replace(/\s+/g, ' ').trim();
  if (shop && shop === shop.toLowerCase()) shop = shop.charAt(0).toUpperCase() + shop.slice(1);
  if (!shop) { const m = String(subject || '').match(/(?:your|thanks for your)\s+(.+?)\s+order/i); if (m) shop = m[1].trim(); }
  return shop.slice(0, 80);
}

/**
 * @param text     the email's words (one line per line)
 * @param meta     { from, subject, date: 'YYYY-MM-DD' }
 * @returns { isOrder, shop, orderNo, date, total, lines: [{ name, price, qty }] }
 */
function parse(text, meta = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 2000);
  const all = lines.join('\n');
  const isOrder = /\b(order|purchase|receipt|invoice)\b/i.test(String(meta.subject || '') + ' ' + all.slice(0, 3000)) && MONEY.test(all);
  // an order number has at least one digit (so "Order confirmation" isn't taken for one)
  const orderNo = (([...all.matchAll(/\border\s*(?:number|no\.?|#|reference|ref\.?|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/gi)].map(m => m[1]).find(x => /\d/.test(x))) || '').replace(/-$/, '');
  let total = null;
  for (const l of lines) {
    if (/\b(order total|grand total|total paid|total charged|amount paid|total \(inc|total:|^total\b)/i.test(l) && !/sub-?total/i.test(l)) {
      const m = l.match(MONEY) ; if (m) { total = pounds(m[1]); }
    }
  }
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prices = [...l.matchAll(MONEY_ALL)];
    if (!prices.length || NOT_A_THING.test(l)) continue;
    // the thing's name: the words on this line before the price, or the line above if this line is only a price
    let name = l.slice(0, prices[0].index).replace(/\b(qty|quantity)\s*:?\s*\d+\b/i, '').replace(/[:\-–|]+\s*$/, '').trim();
    if (name.length < 3) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const up = lines[j];
        if (MONEY.test(up) || NOT_A_THING.test(up) || /^(qty|quantity|price|item|description|sold by|dispatched|condition)\b/i.test(up)) continue;
        if (up.length >= 3) { name = up; break; }
      }
    }
    name = name.replace(/^\d+\s*x\s+/i, '').replace(/\s+/g, ' ').trim();
    if (name.length < 3 || name.length > 200 || /^(item|price|description|qty)$/i.test(name)) continue;
    const qty = Number(((l + ' ' + (lines[i - 1] || '')).match(/\b(?:qty|quantity)\s*:?\s*(\d+)\b|\b(\d+)\s*x\s/i) || [])[1] || 1) || 1;
    items.push({ name: name.slice(0, 200), price: pounds(prices[prices.length - 1][1]), qty });
  }
  // the same thing listed twice (summary and detail)
  const seen = new Set();
  const uniq = items.filter(x => { const k = x.name.toLowerCase() + '|' + x.price; if (seen.has(k)) return false; seen.add(k); return true; });
  return { isOrder, shop: shopFrom(meta.from, meta.subject, all), orderNo: orderNo.slice(0, 60), date: meta.date || '', total, lines: uniq.slice(0, 30) };
}

module.exports = { parse, shopFrom };
