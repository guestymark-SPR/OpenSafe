'use strict';
// Draft text for selling an item (eBay, Facebook Marketplace, Gumtree...), from what OpenSafe knows.
// It never includes private notes, the serial number or the price paid; the person edits it before use.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthYear = (iso) => iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '';

function buildListing(store, a, today = new Date().toISOString().slice(0, 10)) {
  const nameHasBrand = a.brand && a.name.toLowerCase().includes(a.brand.toLowerCase());
  const nameHasModel = a.model && a.name.toLowerCase().includes(a.model.toLowerCase());
  let title = [nameHasBrand ? '' : a.brand, a.name, nameHasModel ? '' : a.model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const parts = store.partsOf(a.id).filter(p => !['Sold', 'Disposed', 'Lost / Stolen', 'Given back'].includes(p.status));
  if (parts.length && title.length < 60) title += ` with ${parts.length === 1 ? parts[0].name : parts.length + ' extras'}`;
  if (title.length > 80) title = title.slice(0, 79).replace(/\s+\S*$/, '') + '…'; // eBay titles are limited to 80 characters

  const lines = [];
  lines.push(title.replace(/…$/, ''));
  lines.push('');
  const facts = [];
  if (a.brand) facts.push(`Brand: ${a.brand}`);
  if (a.model) facts.push(`Model: ${a.model}`);
  if (a.condition) facts.push(`Condition: ${a.condition}`);
  if (a.purchaseDate) facts.push(`Bought: ${monthYear(a.purchaseDate)}${a.supplier ? ` from ${a.supplier}` : ''}`);
  if (a.warrantyExpiry && a.warrantyExpiry > today) facts.push(`Warranty until: ${monthYear(a.warrantyExpiry)} (check whether it transfers to a new owner)`);
  const d = a.details || {};
  if (d.kind === 'vehicle') {
    if (d.mileage) facts.push(`Mileage: ${d.mileage}`);
    if (d.fuel) facts.push(`Fuel: ${d.fuel}`);
    if (d.colour) facts.push(`Colour: ${d.colour}`);
    if (d.motDue && d.motDue > today) facts.push(`MOT until: ${monthYear(d.motDue)}`);
  }
  if (d.kind === 'boat') {
    if (d.lengthM) facts.push(`Length: ${d.lengthM} m`);
    if (d.engine) facts.push(`Engine: ${d.engine}`);
    if (d.engineHours) facts.push(`Engine hours: ${d.engineHours}`);
  }
  lines.push(...facts);
  if (parts.length) { lines.push('', 'Comes with:'); for (const p of parts) lines.push(`- ${[p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? p.brand : '', p.name].filter(Boolean).join(' ')}`); }
  const extras = [];
  if (a.documents.some(x => x.type === 'Receipt' && !x.vault)) extras.push('Original receipt available.');
  if (a.documents.some(x => x.type === 'Manual' && !x.vault)) extras.push('Manual included.');
  if ((a.service || []).length) extras.push(`Service history: ${a.service.length} record${a.service.length === 1 ? '' : 's'}.`);
  if (extras.length) lines.push('', ...extras);
  lines.push('', '[Add: why you\'re selling, any marks or faults, collection or postage]');
  return { title, text: lines.join('\n') };
}

module.exports = { buildListing };
