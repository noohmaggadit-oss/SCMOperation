'use strict';
// SCM IN / OUT Operations – web application server.
// Zero dependencies: Node.js 22.13+ (built-in http, crypto and sqlite).  Start with:  npm start
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cfg = require('./src/config');
const { getSettings } = require('./src/db');
const auth = require('./src/auth');
const { routes, HttpError, LEVEL, CAPS } = require('./src/api');

const PUBLIC = path.join(cfg.ROOT, 'public');
const TEMPLATES = path.join(cfg.ROOT, 'templates');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function parseCookies(h) {
  const out = {}; if (!h) return out;
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Upload too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  req.query = Object.fromEntries(url.searchParams);
  req.ip = (cfg.TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '';
  const secure = cfg.COOKIE_SECURE === 'true' || (cfg.COOKIE_SECURE === 'auto' && (req.socket.encrypted || (cfg.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https')));
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');

  const cookies = [];
  res.setCookie = (name, value, maxAge) => cookies.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`);
  const send = (status, body, type, extra = {}) => {
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra));
    res.end(body);
  };
  res.sendRaw = send;
  const json = (status, obj) => send(status, JSON.stringify(obj), 'application/json; charset=utf-8');

  req.token = parseCookies(req.headers.cookie)[auth.COOKIE];
  req.user = auth.getSessionUser(req.token);

  // ---------------- API
  if (url.pathname.startsWith('/api/')) {
    try {
      const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'Not found.');
      // CSRF protection: state-changing requests must come from our own page (custom header + same origin)
      if (req.method !== 'GET') {
        if (req.headers['x-scm'] !== '1') throw new HttpError(403, 'Request blocked.');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked.');
      }
      // authorisation
      if (r.minRole !== 'public') {
        if (r.minRole.startsWith('cap:')) {
          // capability routes: only the listed roles (e.g. Operations Room actions → shift in-charge + admin)
          if (!req.user) throw new HttpError(401, 'Please sign in.');
          if (!(CAPS[r.minRole.slice(4)] || []).includes(req.user.role)) throw new HttpError(403, 'Your role does not allow this.');
        } else if (r.minRole === 'guest') {
          if (!req.user && !getSettings().guestEnabled) throw new HttpError(401, 'Please sign in.');
        } else {
          if (!req.user) throw new HttpError(401, 'Please sign in.');
          if (!(LEVEL[req.user.role] >= LEVEL[r.minRole])) throw new HttpError(403, 'Your role does not allow this.');
        }
        if (req.user && req.user.must_change && !['/api/me/password'].includes(url.pathname) && req.method !== 'GET')
          throw new HttpError(403, 'Please change your password first.');
      }
      const params = {}; const m = url.pathname.match(r.re); r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      let body = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const raw = await readBody(req, cfg.MAX_UPLOAD_MB * 1048576 * 1.5 + 4e6);
        if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON.'); } }
      }
      const out = await r.handler(req, res, { params, body });
      if (!res.writableEnded) json(200, out ?? { ok: true });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      json(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error.' });
    }
    return;
  }

  // ---------------- Excel templates (signed-in users)
  if (url.pathname.startsWith('/templates/')) {
    if (!req.user) return send(401, 'Please sign in.', 'text/plain');
    const f = path.join(TEMPLATES, path.basename(decodeURIComponent(url.pathname)));
    if (!f.startsWith(TEMPLATES) || !fs.existsSync(f)) return send(404, 'Not found', 'text/plain');
    return send(200, fs.readFileSync(f), MIME['.xlsx'], { 'Content-Disposition': `attachment; filename="${path.basename(f)}"` });
  }

  // ---------------- static files (single-page app)
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'Not found', 'text/plain');
  const ext = path.extname(file);
  const mtime = new Date(Math.floor(fs.statSync(file).mtimeMs / 1000) * 1000).toUTCString();
  if (req.headers['if-modified-since'] === mtime) { res.writeHead(304, { 'Last-Modified': mtime }); return res.end(); }
  res.setHeader('Last-Modified', mtime);
  send(200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream', // app code (html/js/css) is revalidated on every load so an update reaches every device at once; icons may be cached
    { 'Cache-Control': ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=3600' });
}

auth.ensureAdmin();
const useHttps = cfg.HTTPS_KEY && cfg.HTTPS_CERT;
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(cfg.HTTPS_KEY), cert: fs.readFileSync(cfg.HTTPS_CERT) }, (q, s) => handle(q, s).catch(e => { console.error(e); s.end(); }))
  : http.createServer((q, s) => handle(q, s).catch(e => { console.error(e); s.end(); }));
server.listen(cfg.PORT, cfg.HOST, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`${cfg.APP_NAME} is running:`);
  console.log(`  On this computer:      ${proto}://localhost:${cfg.PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) for (const n of nets || [])
    if (n.family === 'IPv4' && !n.internal) console.log(`  From phones / tablets:  ${proto}://${n.address}:${cfg.PORT}   (same Wi-Fi / network)`);
  console.log('Press Ctrl+C to stop.');
});
