'use strict';
// Passwords (scrypt), sessions (random token in an HttpOnly cookie, only its hash is stored) and login throttling.
const crypto = require('node:crypto');
const { db } = require('./db');
const cfg = require('./config');

const ROLES = ['admin', 'mis', 'viewer', 'shift_lead'];
const COOKIE = 'scm_sid';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const k = Buffer.from(key, 'base64');
    const test = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), k.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(k, test);
  } catch { return false; }
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId, remember, ip, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ms = remember ? cfg.REMEMBER_DAYS * 864e5 : cfg.SESSION_HOURS * 36e5;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,ip,ua) VALUES (?,?,?,?,?)')
    .run(sha(token), userId, Date.now() + ms, ip || null, (ua || '').slice(0, 200));
  return { token, maxAge: Math.floor(ms / 1000), remember };
}
function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.active, u.must_change, u.lang, s.expires_at
                          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.active) { destroySession(token); return null; }
  return row;
}
function destroySession(token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }
function destroyUserSessions(userId) { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); }
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 36e5).unref();

// --- login throttling: 5 failures per username+IP → 5 minute lock
const fails = new Map();
function throttled(key) {
  const f = fails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; }
  fails.set(key, f);
}
function clearFail(key) { fails.delete(key); }

// --- first run: make sure an admin exists
function ensureAdmin() {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (n > 0) return;
  let pw = cfg.ADMIN_PASSWORD;
  let generated = false;
  if (!pw || passwordProblem(pw)) { pw = 'Adm' + crypto.randomBytes(6).toString('base64url') + '7'; generated = true; }
  db.prepare("INSERT INTO users(username, display_name, role, pass_hash, must_change) VALUES (?, 'Administrator', 'admin', ?, 1)")
    .run(cfg.ADMIN_USERNAME, hashPassword(pw));
  const line = '='.repeat(64);
  console.log(`\n${line}\n  First start – administrator account created\n  Username: ${cfg.ADMIN_USERNAME}\n  Password: ${generated ? pw : '(from ADMIN_PASSWORD in .env)'}\n  You will be asked to change it at first login.\n${line}\n`);
}

module.exports = { ROLES, COOKIE, hashPassword, verifyPassword, passwordProblem, createSession, getSessionUser,
  destroySession, destroyUserSessions, throttled, noteFail, clearFail, ensureAdmin };
