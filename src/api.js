'use strict';
// REST API. Every route declares the minimum role it needs.
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, audit, getSettings, saveSettings, DEFAULT_SETTINGS } = require('./db');
const auth = require('./auth');
const cfg = require('./config');
const DEFS = require('./defs.json');
const ops = require('./ops');

const TASK_CODES = new Set(DEFS.tasks.map(t => t.code));
const STATUSES = new Set(['', 'draft', 'pending', 'approved', 'posted', 'rejected', 'cancelled']);
// Linear levels for reports/admin. The shift in-charge sees what a viewer sees, plus the capabilities below.
const LEVEL = { guest: 0, viewer: 1, shift_lead: 1, mis: 2, admin: 3 };
// Capability routes (minRole 'cap:<name>'): exactly these roles, independent of the levels above.
const CAPS = {
  ops: ['admin', 'shift_lead'],                 // Start/End of Day, Start/End of Shift, handover items, shift log
  docs: ['admin', 'mis', 'shift_lead'],         // attach signed forms, WIF documents and SAP B1 layouts to a shift
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };
const str = (v, max = 300) => (v == null ? '' : String(v)).trim().slice(0, max);
const num = v => (typeof v === 'number' && isFinite(v) ? v : (v == null || v === '' ? null : (isFinite(+v) ? +v : NaN)));

const routes = [];
const route = (method, pattern, minRole, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, minRole, handler });
};

// ------------------------------------------------------------ public / session
route('GET', '/api/public', 'public', () => ({ appName: cfg.APP_NAME, guestEnabled: !!getSettings().guestEnabled }));

route('POST', '/api/login', 'public', (req, res, { body }) => {
  const username = str(body.username, 60), password = String(body.password || '');
  need(username && password, 400, 'Enter username and password.');
  const key = username.toLowerCase() + '|' + req.ip;
  const wait = auth.throttled(key);
  need(!wait, 429, `Too many attempts. Try again in ${wait} seconds.`);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !u.active || !auth.verifyPassword(password, u.pass_hash)) {
    auth.noteFail(key); audit(null, 'login_failed', username, req.ip);
    throw new HttpError(401, 'Wrong username or password, or the account is disabled.');
  }
  auth.clearFail(key);
  const s = auth.createSession(u.id, !!body.remember, req.ip, req.headers['user-agent']);
  res.setCookie(auth.COOKIE, s.token, s.remember ? s.maxAge : null);
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(u.id);
  audit(u, 'login', null, req.ip);
  return { ok: true, user: publicUser(u) };
});

route('POST', '/api/logout', 'public', (req, res) => {
  auth.destroySession(req.token); res.setCookie(auth.COOKIE, '', 0); return { ok: true };
});

route('GET', '/api/me', 'public', req => ({ user: req.user ? publicUser(req.user) : null, guest: !req.user && !!getSettings().guestEnabled }));

route('POST', '/api/me/password', 'viewer', (req, res, { body }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  need(auth.verifyPassword(String(body.current || ''), u.pass_hash), 400, 'Current password is not correct.');
  const p = auth.passwordProblem(body.next); need(!p, 400, p);
  need(body.next !== body.current, 400, 'The new password must be different.');
  db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(auth.hashPassword(body.next), u.id);
  // keep this session, end all others
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(u.id, require('node:crypto').createHash('sha256').update(req.token).digest('hex'));
  audit(req.user, 'password_changed', null, req.ip);
  return { ok: true };
});

route('POST', '/api/me/lang', 'viewer', (req, res, { body }) => {
  const lang = body.lang === 'ar' ? 'ar' : 'en';
  db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.user.id); return { ok: true };
});

// ------------------------------------------------------------ data (read)
route('GET', '/api/config', 'guest', () => {
  const tm = {}; for (const r of db.prepare('SELECT * FROM task_master').all()) tm[r.code] = { sla: r.sla, txn: r.txn, numWH: r.num_wh };
  const counts = {
    rows: db.prepare('SELECT COUNT(*) n FROM transactions').get().n,
    items: db.prepare('SELECT COUNT(*) n FROM items').get().n,
    whs: db.prepare('SELECT COUNT(*) n FROM warehouses').get().n,
    range: db.prepare('SELECT MIN(date) mn, MAX(date) mx FROM transactions').get(),
    lastUpload: db.prepare('SELECT created_at, username, file_name FROM uploads ORDER BY id DESC LIMIT 1').get() || null,
  };
  return { defs: DEFS, settings: getSettings(), taskMaster: tm, counts };
});

// number of signed forms attached to the row's document (task + document no.)
const FORMS_SQL = '(SELECT COUNT(*) FROM doc_forms f WHERE f.task = t.task AND f.docno_key = UPPER(t.docno)) forms';
const ROW_COLS = ['task', 'docno', 'date', 'time', 'ref', 'from_wh', 'to_wh', 'item', 'descr', 'uom', 'batch', 'qty', 'status', 'sys', 'sysdoc', 'cdate', 'ctime', 'remarks', 'upload_id'];
route('GET', '/api/rows', 'guest', (req) => {
  const from = num(req.query.from), to = num(req.query.to);
  let rows;
  if (from != null && to != null && !isNaN(from) && !isNaN(to)) {
    // rows in the period + every still-open document (needed for backlog figures)
    rows = db.prepare(`SELECT ${ROW_COLS.join(',')}, ${FORMS_SQL} FROM transactions t WHERE (date BETWEEN ? AND ?) OR cdate IS NULL`).all(from, to);
  } else rows = db.prepare(`SELECT ${ROW_COLS.join(',')}, ${FORMS_SQL} FROM transactions t`).all();
  const cols = ROW_COLS.concat('forms');
  return { cols, rows: rows.map(r => cols.map(c => r[c])) };
});

route('GET', '/api/masters', 'guest', () => ({
  items: db.prepare('SELECT code, descr, uom FROM items').all().map(r => [r.code, r.descr, r.uom]),
  whs: db.prepare('SELECT code, name, name_ar FROM warehouses').all().map(r => [r.code, r.name, r.name_ar]),
}));

route('GET', '/api/export.csv', 'viewer', (req, res) => {
  const from = num(req.query.from), to = num(req.query.to);
  const where = from != null && to != null && !isNaN(from) && !isNaN(to) ? 'WHERE date BETWEEN ? AND ?' : '';
  const rows = db.prepare(`SELECT * FROM transactions ${where} ORDER BY date, time`).all(...(where ? [from, to] : []));
  const ser = s => { if (s == null) return ''; const d = new Date(Math.round((Math.floor(s) - 25569) * 864e5)); return d.toISOString().slice(0, 10); };
  const tm = f => { if (!f) return ''; const m = Math.round((f % 1) * 1440); return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const head = ['Task Code', 'Document Number', 'Document Date', 'Document Time', 'Ref. Document No.', 'From Warehouse', 'To Warehouse', 'Item Code', 'Item Description', 'UoM', 'Batch', 'Quantity', 'Status', 'System Updated', 'System Document Number', 'Completion Date', 'Completion Time', 'Remarks'];
  const q = v => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [head.join(',')].concat(rows.map(r => [r.task, r.docno, ser(r.date), tm(r.time), r.ref, r.from_wh, r.to_wh, r.item, r.descr, r.uom, r.batch, r.qty, r.status, r.sys, r.sysdoc, ser(r.cdate), r.cdate != null ? tm(r.ctime) : '', r.remarks].map(q).join(',')));
  audit(req.user, 'export_csv', `${rows.length} rows`, req.ip);
  res.sendRaw(200, '﻿' + lines.join('\r\n'), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="scm_transactions_${new Date().toISOString().slice(0, 10)}.csv"` });
});

// ------------------------------------------------------------ uploads (MIS + admin)
function cleanRow(r) {
  const task = str(r.task, 20).toUpperCase(), docno = str(r.docno, 120);
  if (!TASK_CODES.has(task)) return [null, `unknown task code "${task}"`];
  if (!docno) return [null, 'missing document number'];
  const date = num(r.date); if (date == null || isNaN(date) || date < 30000 || date > 80000) return [null, `bad document date for ${docno}`];
  const qty = num(r.qty); if (qty == null || isNaN(qty)) return [null, `bad quantity for ${docno}`];
  const cdate = num(r.cdate); if (cdate != null && (isNaN(cdate) || cdate < 30000 || cdate > 80000)) return [null, `bad completion date for ${docno}`];
  let status = str(r.status, 60); if (!STATUSES.has(status) && !status.startsWith('other:')) status = 'other:' + status;
  const sys = ['Y', 'N', 'NA'].includes(r.sys) ? r.sys : '';
  const frac = v => { const n = num(v); return n == null || isNaN(n) ? 0 : Math.max(0, n % 1); };
  const o = { task, docno, date: Math.floor(date), time: frac(r.time), ref: str(r.ref), from_wh: str(r.from, 40), to_wh: str(r.to, 40),
    item: str(r.item, 60), descr: str(r.desc), uom: str(r.uom, 20), batch: str(r.batch, 60), qty, status, sys, sysdoc: str(r.sysdoc, 80),
    cdate: cdate == null ? null : Math.floor(cdate), ctime: cdate == null ? 0 : frac(r.ctime), remarks: str(r.remarks, 500) };
  o.key = [o.task, o.docno.toUpperCase(), o.item.toUpperCase(), o.batch.toUpperCase()].join('|');
  return [o, null];
}
const CMP = ['task', 'docno', 'date', 'time', 'ref', 'from_wh', 'to_wh', 'item', 'descr', 'uom', 'batch', 'qty', 'status', 'sys', 'sysdoc', 'cdate', 'ctime', 'remarks'];
const same = (a, b) => CMP.every(k => (k === 'time' || k === 'ctime') ? Math.abs((a[k] || 0) - (b[k] || 0)) < 1e-6 : (a[k] ?? null) === (b[k] ?? null));

route('POST', '/api/uploads', 'mis', (req, res, { body }) => {
  const fileName = str(body.fileName, 200) || 'upload.xlsx';
  need(Array.isArray(body.rows), 400, 'No rows in upload.');
  need(body.rows.length <= 100000, 413, 'Too many rows in one upload (max 100,000).');
  const rejected = []; const clean = new Map();
  body.rows.forEach((r, i) => { const [o, err] = cleanRow(r || {}); if (err) rejected.push(`row ${i + 1}: ${err}`); else clean.set(o.key, o); });
  const masters = body.masters || {};
  const slot = ops.currentSlot();
  const result = tx(() => {
    const up = db.prepare('INSERT INTO uploads(user_id, username, file_name, rows_in, sample, op_date, shift_code) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.id, req.user.username, fileName, body.rows.length, Number(body.sample) || 0, slot.opDate, slot.code);
    const id = Number(up.lastInsertRowid);
    const get = db.prepare('SELECT * FROM transactions WHERE key = ?');
    const ins = db.prepare(`INSERT INTO transactions(key,${CMP.join(',')},upload_id,updated_at) VALUES (?,${CMP.map(() => '?').join(',')},?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET ${CMP.map(k => `${k}=excluded.${k}`).join(',')}, upload_id=excluded.upload_id, updated_at=excluded.updated_at`);
    let inserted = 0, updated = 0, unchanged = 0, mn = null, mx = null;
    for (const o of clean.values()) {
      const old = get.get(o.key);
      if (old && same(old, o)) { unchanged++; continue; }
      ins.run(o.key, ...CMP.map(k => o[k]), id);
      old ? updated++ : inserted++;
      mn = mn == null ? o.date : Math.min(mn, o.date); mx = mx == null ? o.date : Math.max(mx, o.date);
    }
    // masters found in the same file
    const ms = {};
    if (Array.isArray(masters.items) && masters.items.length) {
      const st = db.prepare('INSERT INTO items(code,descr,uom) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET descr=excluded.descr, uom=excluded.uom');
      let n = 0; for (const it of masters.items.slice(0, 50000)) { const c = str(it[0], 60); if (c) { st.run(c, str(it[1]), str(it[2], 20)); n++; } } ms.items = n;
    }
    if (Array.isArray(masters.whs) && masters.whs.length) {
      const st = db.prepare('INSERT INTO warehouses(code,name,name_ar) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, name_ar=excluded.name_ar');
      let n = 0; for (const w of masters.whs.slice(0, 5000)) { const c = str(w[0], 40); if (c) { st.run(c, str(w[1]), str(w[2])); n++; } } ms.whs = n;
    }
    if (Array.isArray(masters.taskMaster) && masters.taskMaster.length) {
      if (req.user.role === 'admin') {
        const st = db.prepare('INSERT INTO task_master(code,sla,txn,num_wh) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET sla=excluded.sla, txn=excluded.txn, num_wh=excluded.num_wh');
        let n = 0; for (const t of masters.taskMaster) { const c = str(t.code, 20).toUpperCase(); if (!TASK_CODES.has(c)) continue;
          const sla = num(t.sla); st.run(c, sla && sla > 0 ? sla : null, t.txn == null ? null : str(t.txn, 30), t.numWH === 'to' || t.numWH === 'from' ? t.numWH : null); n++; }
        ms.taskMaster = n;
      } else ms.taskMasterIgnored = true;
    }
    let filePath = null;
    if (cfg.KEEP_UPLOAD_FILES && typeof body.fileB64 === 'string' && body.fileB64.length) {
      const buf = Buffer.from(body.fileB64, 'base64');
      need(buf.length <= cfg.MAX_UPLOAD_MB * 1048576, 413, 'File too large.');
      filePath = path.join('uploads', `${id}_${fileName.replace(/[^\w.\-]+/g, '_')}`);
      fs.writeFileSync(path.join(cfg.DATA_DIR, filePath), buf);
    }
    db.prepare('UPDATE uploads SET inserted=?, updated=?, unchanged=?, rejected=?, masters=?, min_date=?, max_date=?, file_path=? WHERE id=?')
      .run(inserted, updated, unchanged, rejected.length, JSON.stringify(ms), mn, mx, filePath, id);
    return { id, inserted, updated, unchanged, rejected: rejected.length, rejectedSample: rejected.slice(0, 15), masters: ms };
  })();
  // after the Excel: are the shift's WIF document, SAP B1 layout and signed form attached?
  result.docCheck = ops.docStatus(slot.opDate, slot.code);
  // ...and do the completed documents in this file have their signed forms?
  const inFile = new Set([...clean.values()].map(o => o.task + '|' + o.docno.toUpperCase()));
  const noForm = ops.docsMissingForms(0, 1e9, 100000).filter(d => inFile.has(d.task + '|' + d.docno.toUpperCase()));
  result.docCheck.formsMissing = noForm.length;
  result.docCheck.formsMissingSample = noForm.slice(0, 10).map(d => `${d.task} ${d.docno}`);
  audit(req.user, 'upload', `${fileName}: +${result.inserted} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.rejected} rejected` +
    (result.docCheck.missing.length ? ` · shift ${slot.code} missing: ${result.docCheck.missing.join(', ')}` : ''), req.ip);
  return result;
});

route('GET', '/api/uploads', 'mis', () => ({ uploads: db.prepare('SELECT id, username, file_name, op_date, shift_code, rows_in, inserted, updated, unchanged, rejected, sample, masters, min_date, max_date, created_at, (file_path IS NOT NULL) has_file, (SELECT COUNT(*) FROM transactions t WHERE t.upload_id = uploads.id) live_rows FROM uploads ORDER BY id DESC LIMIT 500').all() }));

route('GET', '/api/uploads/:id/file', 'mis', (req, res, { params }) => {
  const u = db.prepare('SELECT file_name, file_path FROM uploads WHERE id = ?').get(+params.id);
  need(u && u.file_path, 404, 'File not kept for this upload.');
  const full = path.join(cfg.DATA_DIR, u.file_path);
  need(full.startsWith(path.join(cfg.DATA_DIR, 'uploads')) && fs.existsSync(full), 404, 'File not found.');
  res.sendRaw(200, fs.readFileSync(full), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    { 'Content-Disposition': `attachment; filename="${u.file_name.replace(/[^\w.\-]+/g, '_')}"` });
});

route('DELETE', '/api/uploads/:id', 'admin', (req, res, { params }) => {
  const id = +params.id; const u = db.prepare('SELECT * FROM uploads WHERE id = ?').get(id); need(u, 404, 'Upload not found.');
  const n = tx(() => {
    const r = db.prepare('DELETE FROM transactions WHERE upload_id = ?').run(id);
    db.prepare('DELETE FROM uploads WHERE id = ?').run(id); return Number(r.changes);
  })();
  if (u.file_path) { try { fs.unlinkSync(path.join(cfg.DATA_DIR, u.file_path)); } catch { } }
  audit(req.user, 'upload_deleted', `#${id} ${u.file_name}: ${n} rows removed`, req.ip);
  return { ok: true, removed: n };
});

// ------------------------------------------------------------ admin: users
const publicUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: !!u.active, mustChange: !!u.must_change, lang: u.lang, lastLogin: u.last_login, createdAt: u.created_at });
const activeAdmins = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n;

route('GET', '/api/users', 'admin', () => ({ users: db.prepare('SELECT * FROM users ORDER BY role, username').all().map(publicUser) }));

route('POST', '/api/users', 'admin', (req, res, { body }) => {
  const username = str(body.username, 60);
  need(/^[A-Za-z0-9._\-@]{3,60}$/.test(username), 400, 'Username: 3–60 letters, numbers or . _ - @');
  need(auth.ROLES.includes(body.role), 400, 'Choose a role.');
  const p = auth.passwordProblem(body.password); need(!p, 400, p);
  need(!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username), 409, 'That username already exists.');
  const r = db.prepare('INSERT INTO users(username, display_name, role, pass_hash, must_change) VALUES (?,?,?,?,1)')
    .run(username, str(body.displayName, 100), body.role, auth.hashPassword(body.password));
  audit(req.user, 'user_created', `${username} (${body.role})`, req.ip);
  return { ok: true, id: Number(r.lastInsertRowid) };
});

route('PATCH', '/api/users/:id', 'admin', (req, res, { params, body }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(+params.id); need(u, 404, 'User not found.');
  const role = body.role != null ? body.role : u.role, active = body.active != null ? (body.active ? 1 : 0) : u.active;
  need(auth.ROLES.includes(role), 400, 'Bad role.');
  if (u.role === 'admin' && u.active && (role !== 'admin' || !active)) need(activeAdmins() > 1, 400, 'You cannot remove the last active administrator.');
  db.prepare('UPDATE users SET role=?, active=?, display_name=? WHERE id=?').run(role, active, body.displayName != null ? str(body.displayName, 100) : u.display_name, u.id);
  if (!active || role !== u.role) auth.destroyUserSessions(u.id);
  audit(req.user, 'user_updated', `${u.username}: role=${role}, active=${!!active}`, req.ip);
  return { ok: true };
});

route('POST', '/api/users/:id/password', 'admin', (req, res, { params, body }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(+params.id); need(u, 404, 'User not found.');
  const p = auth.passwordProblem(body.password); need(!p, 400, p);
  db.prepare('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?').run(auth.hashPassword(body.password), u.id);
  auth.destroyUserSessions(u.id);
  audit(req.user, 'password_reset', u.username, req.ip);
  return { ok: true };
});

route('DELETE', '/api/users/:id', 'admin', (req, res, { params }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(+params.id); need(u, 404, 'User not found.');
  need(u.id !== req.user.id, 400, 'You cannot delete your own account.');
  if (u.role === 'admin' && u.active) need(activeAdmins() > 1, 400, 'You cannot delete the last active administrator.');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit(req.user, 'user_deleted', u.username, req.ip);
  return { ok: true };
});

// ------------------------------------------------------------ admin: settings, task master, audit, data reset
route('PUT', '/api/settings', 'admin', (req, res, { body }) => {
  const s = getSettings();
  const pct = v => { const n = num(v); return n != null && !isNaN(n) && n >= 0 && n <= 1 ? n : null; };
  for (const k of ['compT', 'onT', 'watch']) if (body[k] != null) { const v = pct(body[k]); need(v != null, 400, `Bad value for ${k}`); s[k] = v; }
  if (body.sep != null) s.sep = str(body.sep, 2) || '/';
  if (body.guestEnabled != null) s.guestEnabled = !!body.guestEnabled;
  if (body.sla && typeof body.sla === 'object') { s.sla = {}; for (const [c, v] of Object.entries(body.sla)) { const n = num(v); if (TASK_CODES.has(c) && n > 0) s.sla[c] = n; } }
  if (body.flowT && typeof body.flowT === 'object') { s.flowT = {}; for (const [i, v] of Object.entries(body.flowT)) { const n = num(v); if (n != null && !isNaN(n) && n >= 0) s.flowT[i] = n; } }
  if (Array.isArray(body.shifts)) {
    const sh = body.shifts.map(x => ({ code: str(x.code, 10), start: str(x.start, 5) })).filter(x => x.code && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.start));
    need(sh.length >= 1 && sh.length <= 4 && new Set(sh.map(x => x.code)).size === sh.length, 400, 'Give 1–4 shifts with unique names and times as HH:MM.');
    s.shifts = sh;
  }
  if (body.shiftHours != null) { const n = num(body.shiftHours); need(n >= 1 && n <= 24, 400, 'Shift length must be 1–24 hours.'); s.shiftHours = n; }
  if (body.breakHours != null) { const n = num(body.breakHours); need(n >= 0 && n <= 6, 400, 'Break must be 0–6 hours.'); s.breakHours = n; }
  if (body.reset) Object.assign(s, DEFAULT_SETTINGS, { guestEnabled: s.guestEnabled, shifts: s.shifts, shiftHours: s.shiftHours, breakHours: s.breakHours, sla: {}, flowT: {} });
  saveSettings(s);
  audit(req.user, 'settings_saved', JSON.stringify({ compT: s.compT, onT: s.onT, watch: s.watch, guest: s.guestEnabled }), req.ip);
  return { ok: true, settings: s };
});

route('PUT', '/api/task-master/:code', 'admin', (req, res, { params, body }) => {
  const c = String(params.code).toUpperCase(); need(TASK_CODES.has(c), 404, 'Unknown task.');
  const sla = num(body.sla);
  db.prepare('INSERT INTO task_master(code,sla,txn,num_wh) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET sla=excluded.sla, txn=excluded.txn, num_wh=excluded.num_wh')
    .run(c, sla && sla > 0 ? sla : null, body.txn == null ? null : str(body.txn, 30), ['to', 'from'].includes(body.numWH) ? body.numWH : null);
  audit(req.user, 'task_master_saved', c, req.ip);
  return { ok: true };
});

route('GET', '/api/audit', 'admin', (req) => ({ audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(2000, +(req.query.limit || 300))) }));

route('POST', '/api/admin/clear-transactions', 'admin', (req, res, { body }) => {
  need(body.confirm === 'DELETE ALL', 400, 'Type DELETE ALL to confirm.');
  const n = Number(db.prepare('DELETE FROM transactions').run().changes);
  audit(req.user, 'transactions_cleared', `${n} rows`, req.ip);
  return { ok: true, removed: n };
});

ops(route, { need, str, num, HttpError });
require('./forms')(route, { need, str, num, HttpError });

module.exports = { routes, HttpError, LEVEL, CAPS };
