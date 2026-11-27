'use strict';
// "Send inventory to phone": a passphrase-encrypted, read-only copy of your items
// for OpenSafe Capture. Encryption: PBKDF2-SHA256 (310,000 rounds) -> AES-256-GCM,
// which the phone can decrypt with the browser's built-in Web Crypto.

const crypto = require('crypto');

const ITERATIONS = 310000;
const CAPTURE_URL = 'https://guestymark-spr.github.io/OpenSafe/';
const itemLink = (id) => `${CAPTURE_URL}#item=${id}`;
const placeLink = (place) => `${CAPTURE_URL}#place=${encodeURIComponent(place)}`;

function encryptView(obj, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 6) throw new Error('Use a passphrase of at least 6 characters.');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(passphrase.normalize('NFKC'), 'utf8'), salt, ITERATIONS, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final(), c.getAuthTag()]); // Web Crypto expects ciphertext || tag
  return JSON.stringify({ format: 'opensafe-view', version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS }, salt: salt.toString('base64'), iv: iv.toString('base64'), data: ct.toString('base64') });
}

function decryptView(text, passphrase) { // used by tests; the phone does the same with Web Crypto
  const f = JSON.parse(text);
  const key = crypto.pbkdf2Sync(Buffer.from(passphrase.normalize('NFKC'), 'utf8'), Buffer.from(f.salt, 'base64'), f.kdf.iterations, 32, 'sha256');
  const all = Buffer.from(f.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
  d.setAuthTag(all.subarray(all.length - 16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8'));
}

/**
 * Build the read-only inventory. makeThumb(buffer, ext) returns a small JPEG data URL (or null).
 */
function buildView(store, { includeVault = false, makeThumb, docs = null }) {
  const assets = store.allAssets().filter(a => includeVault || !store.isVaultAsset(a));
  const policies = store.data.policies || [];
  const items = assets.map(a => {
    const cover = a.photos.find(p => !p.vault);
    let thumb = null;
    if (cover && makeThumb) { try { thumb = makeThumb(store.readAttachment(a.id, cover.file), cover.file); } catch (_) { thumb = null; } }
    const pol = policies.find(p => p.id === a.policyId);
    return {
      id: a.id, name: a.name, category: a.category, location: a.location, status: a.status, brand: a.brand, model: a.model,
      serial: a.serial, barcode: a.barcode, webLink: a.webLink, condition: a.condition, purchaseDate: a.purchaseDate, purchasePrice: a.purchasePrice,
      supplier: a.supplier, currentValue: a.currentValue, warrantyExpiry: a.warrantyExpiry,
      insurer: pol ? pol.insurer : a.insurer, policyNumber: pol ? pol.policyNumber : a.policyNumber, insuredValue: a.insuredValue,
      lentTo: a.lentTo, lentContact: a.lentContact, dueBack: a.dueBack, details: a.details, tags: a.tags, notes: a.notes,
      grab: !!a.grab, owner: a.owner, borrowedFrom: a.borrowedFrom, returnBy: a.returnBy, photos: a.photos.length, documents: a.documents.length, inVault: store.isVaultAsset(a), thumb
    };
  });
  const ids = new Set(items.map(i => i.id));
  const trips = (store.data.trips || []).map(t => ({
    id: t.id, name: t.name, startDate: t.startDate, endDate: t.endDate,
    items: t.items.filter(i => ids.has(i.assetId)).map(i => ({ id: i.assetId, packed: !!i.packed, back: !!i.back })),
    extras: t.extras.map(x => ({ id: x.id, text: x.text, packed: !!x.packed, back: !!x.back }))
  }));
  const out = { exportedAt: new Date().toISOString(), count: items.length, items, trips };
  if (docs && docs.length) out.docs = docs.map(d => Object.assign({}, d, { assetIds: (d.assetIds || []).filter(id => ids.has(id)) }));
  return out;
}

const LIMITS = { pagesPerDoc: 40, pages: 300, width: 1100, text: 30000 };
const extOf = (f) => (String(f).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
/**
 * Documents and Data entries marked "on my phone", as page pictures the phone can show offline
 * (the phone has no PDF or Word reader of its own), plus their details and words for searching.
 * tools: { pdfPages(buffer, max) -> [jpeg Buffer], imageJpeg(buffer, name) -> jpeg Buffer | null,
 *          htmlToPdf(html) -> PDF bytes, fileHtml(name, buffer) -> html | null }
 */
async function buildDocs(store, entries, tools, limits = LIMITS) {
  const docs = [], skipped = [];
  let total = 0;
  const data = (b) => 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64');
  for (const e of entries) {
    const d = { id: e.id, kind: e.kind, title: e.title, docType: e.docType, from: e.from, docDate: e.docDate, ref: e.ref, folder: e.folder,
      actBy: e.actDone ? '' : e.actBy, notes: e.notes, tags: e.tags, assetIds: e.assetIds || [], files: [], pages: [], missing: [] };
    d.text = Object.values(e.text || {}).join('\n').replace(/[ \t]+/g, ' ').slice(0, limits.text);
    for (const f of e.files) {
      d.files.push(f.name);
      const room = Math.min(limits.pagesPerDoc - d.pages.length, limits.pages - total);
      if (room <= 0) { d.missing.push(`${f.name} (too many pages for the phone copy)`); continue; }
      try {
        const buf = store.readAttachment(e.id, f.file), ext = extOf(f.name);
        let pics = [];
        if (ext === '.pdf') pics = await tools.pdfPages(buf, room);
        else {
          const one = ['.jpg', '.jpeg', '.png'].includes(ext) ? tools.imageJpeg(buf, f.name) : null;
          if (one) pics = [one];
          else {
            const html = await tools.fileHtml(f.name, buf);
            if (!html) { d.missing.push(`${f.name} (can't be shown on the phone)`); continue; }
            pics = await tools.pdfPages(Buffer.from(await tools.htmlToPdf(html)), room);
          }
        }
        if (!pics.length) { d.missing.push(`${f.name} (nothing to show)`); continue; }
        d.pages.push(...pics.slice(0, room).map(data)); total += Math.min(pics.length, room);
      } catch (err) { d.missing.push(`${f.name} (${err.code === 'VAULT_LOCKED' ? 'in the locked vault' : 'couldn\'t be read'})`); }
    }
    for (const m of d.missing) skipped.push(`${e.title}: ${m}`);
    docs.push(d);
  }
  return { docs, skipped, pages: total };
}

module.exports = { buildDocs, LIMITS,  encryptView, decryptView, buildView, itemLink, placeLink, CAPTURE_URL, ITERATIONS };
