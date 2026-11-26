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
function buildView(store, { includeVault = false, makeThumb }) {
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
  return { exportedAt: new Date().toISOString(), count: items.length, items };
}

module.exports = { encryptView, decryptView, buildView, itemLink, placeLink, CAPTURE_URL, ITERATIONS };
