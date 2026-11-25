'use strict';
// Wi-Fi link: a small HTTP server on the local network that serves the phone page
// and a token-protected API for adding items and photos.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PHONE_DIR = path.join(__dirname, 'phone');
const STATIC = {
  '/m': ['index.html', 'text/html; charset=utf-8'],
  '/m/': ['index.html', 'text/html; charset=utf-8'],
  '/m/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/m/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/m/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/m/icon.png': ['icon.png', 'image/png']
};
const MAX_JSON = 64 * 1024;
const MAX_FILE = 25 * 1024 * 1024;

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

function getLanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifs)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const a = i.address;
      const priv = /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
      if (!priv) continue;
      // virtual adapters (WSL, Hyper-V, VirtualBox, VMware, Docker) are unlikely to be the Wi-Fi
      const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|br-|veth/i.test(name);
      out.push({ name, address: a, virtual });
    }
  }
  return out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
}

function tokenOk(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  }, extra));
  res.end(buf);
}

class PhoneServer {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {() => void} opts.onChange   called after the phone adds something
   */
  constructor({ store, onChange }) {
    this.store = store;
    this.onChange = onChange || (() => {});
    this.server = null;
    this.port = null;
    this.lastSeen = null;
  }

  get running() { return !!this.server; }

  start(port) {
    if (this.server) return Promise.resolve(this.port);
    if (!this.store.data.settings.phoneToken) this.store.updateSettings({ phoneToken: newToken() });
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this._handle(req, res).catch((e) => {
          if (!res.headersSent) send(res, e.status || 400, { error: e.message || 'Server error' });
        });
      });
      srv.on('error', reject);
      srv.listen(port, '0.0.0.0', () => {
        srv.removeListener('error', reject);
        this.server = srv;
        this.port = port;
        resolve(port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
      this.port = null;
    });
  }

  resetToken() {
    this.store.updateSettings({ phoneToken: newToken() });
    return this.store.data.settings.phoneToken;
  }

  urls() {
    const t = this.store.data.settings.phoneToken;
    return getLanAddresses().map(a => ({
      name: a.name, virtual: a.virtual,
      url: `http://${a.address}:${this.port}/m#t=${t}`
    }));
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') return send(res, 302, '', 'text/plain', { Location: '/m' });

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      const body = fs.readFileSync(path.join(PHONE_DIR, file));
      const extra = file === 'index.html' ? {
        'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      } : {};
      return send(res, 200, body, type, extra);
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    if (!tokenOk(req.headers['x-opensafe-token'], this.store.data.settings.phoneToken)) {
      return send(res, 401, { error: 'This phone is not paired. Scan the QR code in OpenSafe on your PC.' });
    }
    this.lastSeen = new Date();

    if (req.method === 'GET' && p === '/api/meta') {
      const d = this.store.data;
      const recent = d.assets.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15)
        .map(a => ({ id: a.id, name: a.name, category: a.category, location: a.location, photos: a.photos.length, documents: a.documents.length, createdAt: a.createdAt }));
      return send(res, 200, {
        categories: d.categories, locations: d.locations,
        conditions: require('./store').CONDITIONS,
        count: d.assets.length, recent
      });
    }

    if (req.method === 'POST' && p === '/api/assets') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected JSON' });
      const raw = await readBody(req, MAX_JSON);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return send(res, 400, { error: 'Bad JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Bad item' });
      delete body.id; // the phone can only create new items
      if (!String(body.name || '').trim()) return send(res, 400, { error: 'Give the item a name' });
      body.source = 'phone';
      const asset = this.store.saveAsset(body);
      this.onChange();
      return send(res, 201, { id: asset.id, name: asset.name });
    }

    const m = p.match(/^\/api\/assets\/([0-9a-f-]{36})\/(photo|document)$/i);
    if (req.method === 'POST' && m) {
      const [, id, kind] = m;
      const name = (url.searchParams.get('name') || (kind === 'photo' ? 'photo.jpg' : 'document')).slice(0, 120);
      const buf = await readBody(req, MAX_FILE);
      if (!buf.length) return send(res, 400, { error: 'Empty upload' });
      const rec = kind === 'photo'
        ? this.store.addPhoto(id, name, buf)
        : this.store.addDocument(id, name, buf, url.searchParams.get('type') || 'Receipt');
      this.onChange();
      return send(res, 201, { id: rec.id });
    }

    return send(res, 404, { error: 'Not found' });
  }
}

module.exports = { PhoneServer, getLanAddresses, newToken };
