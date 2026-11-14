'use strict';
// SQLite database (built into Node.js 22.13+ – no install needed).
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(cfg.DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(cfg.DATA_DIR, 'scm.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// ---------------------------------------------------------------- schema (data model)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin','mis','viewer','shift_lead')),
  pass_hash     TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  must_change   INTEGER NOT NULL DEFAULT 1,
  lang          TEXT NOT NULL DEFAULT 'en',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  INTEGER NOT NULL,           -- epoch ms
  ip          TEXT, ua TEXT
);
CREATE TABLE IF NOT EXISTS uploads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  file_name   TEXT NOT NULL,
  file_path   TEXT,
  rows_in     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  rejected    INTEGER NOT NULL DEFAULT 0,
  sample      INTEGER NOT NULL DEFAULT 0,
  masters     TEXT,                        -- JSON summary of masters loaded from the file
  min_date    INTEGER, max_date INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row per document line. Key = task | document no. | item | batch (newest upload wins).
CREATE TABLE IF NOT EXISTS transactions (
  key        TEXT PRIMARY KEY,
  task       TEXT NOT NULL,
  docno      TEXT NOT NULL,
  date       INTEGER,                      -- Excel serial date (days since 1899-12-30)
  time       REAL NOT NULL DEFAULT 0,      -- fraction of a day
  ref        TEXT NOT NULL DEFAULT '',
  from_wh    TEXT NOT NULL DEFAULT '',
  to_wh      TEXT NOT NULL DEFAULT '',
  item       TEXT NOT NULL DEFAULT '',
  descr      TEXT NOT NULL DEFAULT '',
  uom        TEXT NOT NULL DEFAULT '',
  batch      TEXT NOT NULL DEFAULT '',
  qty        REAL NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT '',
  sys        TEXT NOT NULL DEFAULT '',     -- Y | N | NA
  sysdoc     TEXT NOT NULL DEFAULT '',
  cdate      INTEGER,
  ctime      REAL NOT NULL DEFAULT 0,
  remarks    TEXT NOT NULL DEFAULT '',
  upload_id  INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_tx_date  ON transactions(date);
CREATE INDEX IF NOT EXISTS ix_tx_open  ON transactions(cdate);
CREATE INDEX IF NOT EXISTS ix_tx_task  ON transactions(task);
CREATE INDEX IF NOT EXISTS ix_tx_upl   ON transactions(upload_id);
CREATE TABLE IF NOT EXISTS items      (code TEXT PRIMARY KEY COLLATE NOCASE, descr TEXT NOT NULL DEFAULT '', uom TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS warehouses (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL DEFAULT '', name_ar TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS task_master(code TEXT PRIMARY KEY, sla REAL, txn TEXT, num_wh TEXT);
CREATE TABLE IF NOT EXISTS settings   (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Signed forms per document (task + document no.). Required for every completed document. Files: data/doc-forms/
CREATE TABLE IF NOT EXISTS doc_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL, docno TEXT NOT NULL, docno_key TEXT NOT NULL,   -- docno_key = UPPER(docno)
  file_name TEXT NOT NULL, file_path TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  signed_by TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT, uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  op_date INTEGER, shift_code TEXT                                      -- shift the form was uploaded in
);
CREATE INDEX IF NOT EXISTS ix_forms_doc ON doc_forms(task, docno_key);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER, username TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT
);
`);

// ---------------------------------------------------------------- migrations for databases created by older versions
// 1) the users.role CHECK must allow the shift in-charge role (SQLite cannot alter a CHECK, so rebuild the table)
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql;
  if (!sql.includes("'shift_lead'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(sql.replace(/CREATE TABLE\s+"?users"?/i, 'CREATE TABLE users_new').replace(/\('admin','mis','viewer'\)/, "('admin','mis','viewer','shift_lead')"));
      db.exec('INSERT INTO users_new SELECT * FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users;');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
}
// 2) each Excel upload remembers the operational day and shift it was made in
{
  const cols = db.prepare('PRAGMA table_info(uploads)').all().map(c => c.name);
  if (!cols.includes('op_date')) db.exec('ALTER TABLE uploads ADD COLUMN op_date INTEGER');
  if (!cols.includes('shift_code')) db.exec('ALTER TABLE uploads ADD COLUMN shift_code TEXT');
}

const tx = fn => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

function audit(user, action, detail, ip) {
  db.prepare('INSERT INTO audit(user_id, username, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(user ? user.id : null, user ? user.username : null, action, detail ? String(detail).slice(0, 2000) : null, ip || null);
}

const DEFAULT_SETTINGS = { compT: 0.98, onT: 0.95, watch: 0.90, sep: '/', guestEnabled: false, sla: {}, flowT: {},
  shifts: [{ code: 'A', start: '07:00' }, { code: 'B', start: '19:00' }], shiftHours: 12, breakHours: 2 };
function getSettings() {
  const row = db.prepare("SELECT value FROM settings WHERE key='app'").get();
  let s = {};
  try { s = row ? JSON.parse(row.value) : {}; } catch { s = {}; }
  return Object.assign({}, DEFAULT_SETTINGS, s, { sla: s.sla || {}, flowT: s.flowT || {} });
}
function saveSettings(s) {
  db.prepare("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(s));
}

module.exports = { db, tx, audit, getSettings, saveSettings, DEFAULT_SETTINGS };
