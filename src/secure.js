'use strict';
// OpenSafe encryption primitives.
//
// - Files are sealed with AES-256-GCM:  "OSE1" | keyId(1) | iv(12) | tag(16) | ciphertext
//   keyId 0 = master key (everything), keyId 1 = vault key (vault items and vault files).
// - Keys are random 32-byte values. They are stored only "wrapped" (encrypted) by a key
//   derived from the password, PIN or recovery key with scrypt.
// - The recovery key also derives an X25519 key pair. Its public half lets OpenSafe
//   wrap the vault key for recovery without needing the recovery key at that moment.

const crypto = require('crypto');

const MAGIC = Buffer.from('OSE1');
const KEY_MASTER = 0;
const KEY_VAULT = 1;
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');

function randomKey() { return crypto.randomBytes(32); }
function randomSalt() { return b64(crypto.randomBytes(16)); }

function kdf(secret, saltB64, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(secret).normalize('NFKC'), 'utf8'), unb64(saltB64), 32,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem || SCRYPT.maxmem },
      (err, key) => err ? reject(err) : resolve(key));
  });
}

function hkdf(key, info) {
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(info), 32));
}

// ---- wrapping a key with another key (small JSON-friendly object) ----
function wrap(kek, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(key), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}
function unwrap(kek, w) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kek, unb64(w.iv));
    d.setAuthTag(unb64(w.tag));
    return Buffer.concat([d.update(unb64(w.ct)), d.final()]);
  } catch (_) {
    return null; // wrong password / PIN / key
  }
}

// ---- sealed files ----
function seal(key, keyId, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.concat([MAGIC, Buffer.from([keyId])]));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([keyId]), iv, c.getAuthTag(), ct]);
}
function isSealed(buf) { return Buffer.isBuffer(buf) && buf.length >= 33 && buf.subarray(0, 4).equals(MAGIC); }
function keyIdOf(buf) { return isSealed(buf) ? buf[4] : null; }
function open(keys, buf) {
  if (!isSealed(buf)) return buf;
  const keyId = buf[4];
  const key = keys && keys[keyId];
  if (!key) {
    const e = new Error(keyId === KEY_VAULT ? 'The vault is locked.' : 'OpenSafe is locked.');
    e.code = keyId === KEY_VAULT ? 'VAULT_LOCKED' : 'LOCKED';
    throw e;
  }
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(5, 17));
  d.setAAD(buf.subarray(0, 5));
  d.setAuthTag(buf.subarray(17, 33));
  try {
    return Buffer.concat([d.update(buf.subarray(33)), d.final()]);
  } catch (_) {
    const e = new Error('This file is damaged or was encrypted with a different key.');
    e.code = 'BAD_DATA';
    throw e;
  }
}

// ---- recovery key ----
function newRecoveryKey() {
  const bytes = crypto.randomBytes(15); // 120 bits
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{4}/g).join('-'); // 24 chars, 6 groups
}
function normaliseRecoveryKey(s) {
  return String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}
function looksLikeRecoveryKey(s) {
  const n = normaliseRecoveryKey(s);
  return n.length === 24 && [...n].every(ch => B32.includes(ch));
}

// X25519 from a 32-byte seed
function x25519FromSeed(seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, publicDer: b64(publicKey.export({ type: 'spki', format: 'der' })) };
}
function publicFromDer(derB64) { return crypto.createPublicKey({ key: unb64(derB64), format: 'der', type: 'spki' }); }

// Wrap a key so that only the recovery key can open it (no recovery key needed now).
function wrapForRecovery(recoveryPublicDer, key) {
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromDer(recoveryPublicDer) });
  const kek = hkdf(shared, 'opensafe-recovery-wrap');
  return { eph: b64(eph.publicKey.export({ type: 'spki', format: 'der' })), ...wrap(kek, key) };
}
function unwrapWithRecovery(recoveryPrivateKey, w) {
  const shared = crypto.diffieHellman({ privateKey: recoveryPrivateKey, publicKey: publicFromDer(w.eph) });
  return unwrap(hkdf(shared, 'opensafe-recovery-wrap'), w);
}

// From the recovery key text: a key-wrapping key for the master key, plus the X25519 pair.
async function recoveryMaterial(recoveryKey, saltB64, params) {
  const seed = await kdf(normaliseRecoveryKey(recoveryKey), saltB64, params);
  return { kek: hkdf(seed, 'opensafe-recovery-mk'), x: x25519FromSeed(hkdf(seed, 'opensafe-recovery-x25519')) };
}

module.exports = {
  MAGIC, KEY_MASTER, KEY_VAULT, SCRYPT,
  randomKey, randomSalt, kdf, wrap, unwrap, seal, open, isSealed, keyIdOf,
  newRecoveryKey, normaliseRecoveryKey, looksLikeRecoveryKey, recoveryMaterial, wrapForRecovery, unwrapWithRecovery,
  b64, unb64
};
