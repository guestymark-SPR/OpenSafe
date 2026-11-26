'use strict';
// Checks items against the UK Office for Product Safety and Standards (OPSS) product safety
// alerts, reports and recalls, using GOV.UK's public search (no account or key needed).
// To avoid false alarms, a result only counts when its title or description contains the
// item's model number (and its brand, when there is one). Matches are for the person to check.

const BASE = 'https://www.gov.uk/api/search.json';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function queryFor(a) {
  const model = norm(a.model);
  if (model.length < 3) return null; // a model number is needed to match reliably
  return `${BASE}?filter_format=product_safety_alert_report_recall&q=${encodeURIComponent([a.brand, a.model].filter(Boolean).join(' '))}&count=20&fields=title,link,public_timestamp,description,product_alert_type,product_risk_level`;
}

function matchesFor(a, results) {
  const model = norm(a.model), brand = norm(a.brand);
  return (Array.isArray(results) ? results : []).filter(r => {
    const text = norm(`${r.title} ${r.description}`);
    return text.includes(model) && (!brand || text.includes(brand));
  }).map(r => ({
    assetId: a.id, assetName: a.name,
    title: String(r.title || '').slice(0, 300),
    link: /^\/product-safety-alerts-reports-recalls\//.test(String(r.link || '')) ? 'https://www.gov.uk' + r.link : '',
    date: String(r.public_timestamp || '').slice(0, 10),
    type: String(r.product_alert_type || ''), risk: String(r.product_risk_level || ''),
    description: String(r.description || '').slice(0, 400)
  })).filter(m => m.link);
}

/** fetchJson(url) -> parsed JSON. Checks items one at a time with a short pause between them. */
async function checkRecalls(items, fetchJson, { pauseMs = 300, onProgress } = {}) {
  const list = items.filter(a => queryFor(a)).slice(0, 500);
  const matches = [], errors = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    try { const j = await fetchJson(queryFor(a)); matches.push(...matchesFor(a, j && j.results)); }
    catch (e) { errors.push(`${a.name}: ${e.message}`); if (errors.length >= 3 && errors.length === i + 1) break; } // stop early if it isn't reachable at all
    if (onProgress) onProgress(i + 1, list.length);
    if (pauseMs && i < list.length - 1) await new Promise(r => setTimeout(r, pauseMs));
  }
  return { checked: list.length, skipped: items.length - list.length, matches, errors };
}

module.exports = { checkRecalls, matchesFor, queryFor };
