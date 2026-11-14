'use strict';
// Operations Room: Start / End of Day, Start / End of Shift, shift log and task handover between shifts.
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, audit, getSettings } = require('./db');
const cfg = require('./config');
const DEFS = require('./defs.json');

// ------------------------------------------------------------ schema
db.exec(`
CREATE TABLE IF NOT EXISTS op_days (
  op_date INTEGER PRIMARY KEY,                -- Excel serial date of the operational day
  status TEXT NOT NULL DEFAULT 'open',       -- open | closed
  sod_at TEXT, sod_by TEXT, sod_checklist TEXT, sod_notes TEXT,
  eod_at TEXT, eod_by TEXT, eod_checklist TEXT, eod_notes TEXT, eod_snapshot TEXT
);
CREATE TABLE IF NOT EXISTS op_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_date INTEGER NOT NULL, code TEXT NOT NULL,
  win_start REAL NOT NULL, win_end REAL NOT NULL,   -- planned window (Excel serial date-times)
  status TEXT NOT NULL DEFAULT 'open',              -- open | closed
  start_at TEXT, start_by TEXT, start_checklist TEXT, start_notes TEXT, prev_shift_id INTEGER,
  end_at TEXT, end_by TEXT, end_checklist TEXT, end_notes TEXT, handover_to TEXT, snapshot TEXT,
  UNIQUE(op_date, code)
);
CREATE TABLE IF NOT EXISTS handover_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT, docno TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',          -- high | normal | low
  status TEXT NOT NULL DEFAULT 'open',              -- open | in_progress | blocked | done
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), created_by TEXT, created_shift_id INTEGER,
  updated_at TEXT, updated_by TEXT, closed_at TEXT, closed_by TEXT, closed_shift_id INTEGER, close_note TEXT
);
CREATE TABLE IF NOT EXISTS handover_acks (
  item_id INTEGER NOT NULL REFERENCES handover_items(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES op_shifts(id) ON DELETE CASCADE,
  ack_by TEXT, ack_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), ack_note TEXT,
  PRIMARY KEY (item_id, shift_id)
);
CREATE TABLE IF NOT EXISTS shift_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES op_shifts(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')), username TEXT,
  type TEXT NOT NULL,                               -- note | break_start | break_end | incident
  text TEXT NOT NULL DEFAULT ''
);
-- Attachments per shift: signed forms, WIF documents, SAP Business One layouts (files live in data/shift-docs/)
CREATE TABLE IF NOT EXISTS shift_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_date INTEGER NOT NULL, shift_code TEXT NOT NULL,
  doc_type TEXT NOT NULL,                           -- see DOC_TYPES
  file_name TEXT NOT NULL, file_path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
  signed_by TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT, uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_status ON handover_items(status);
CREATE INDEX IF NOT EXISTS ix_events_shift ON shift_events(shift_id);
CREATE INDEX IF NOT EXISTS ix_docs_shift ON shift_docs(op_date, shift_code);
`);
const DOCS_DIR = path.join(cfg.DATA_DIR, 'shift-docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

// ------------------------------------------------------------ checklists (keys are stored; labels live in the app)
const CHECKLISTS = {
  sod: ['prevEodReviewed', 'systemsOk', 'wallScreen', 'staffPresent'],
  sos: ['summaryReviewed', 'dashboardViewed', 'staffPresent', 'takeover'],
  eos: ['fileUploaded', 'docsUploaded', 'sapLayoutUploaded', 'formsSigned', 'txnFormsUploaded', 'sapFollowedUp', 'itemsUpdated', 'handover'],
  eod: ['dayFileComplete', 'backlogReviewed', 'issuesEscalated'],
};
// End-of-Shift items the server ticks itself from the shift's attachments (the user cannot tick them by hand)
const AUTO_CHECKS = { docsUploaded: 'wif', sapLayoutUploaded: 'sap_layout', formsSigned: 'handover_form' };
const DOC_TYPES = ['wif', 'sap_layout', 'handover_form', 'other_form'];
const REQUIRED_DOCS = ['wif', 'sap_layout', 'handover_form'];
const DOC_LABEL = { wif: 'WIF document', sap_layout: 'SAP Business One layout', handover_form: 'Signed handover/takeover form', other_form: 'Other signed form' };
const DOC_EXT = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.csv': 'text/csv' };
const EVENT_TYPES = ['note', 'break_start', 'break_end', 'incident'];
const ITEM_STATUS = ['open', 'in_progress', 'blocked', 'done'];
const PRIORITY = ['high', 'normal', 'low'];

// ------------------------------------------------------------ clock & shift calendar
// Test hook only: OPS_TEST_NOW="2026-11-14T07:30" pins the clock (never set it in production).
function nowSerial() {
  if (process.env.OPS_TEST_NOW) { const d = new Date(process.env.OPS_TEST_NOW + 'Z'); return d.getTime() / 864e5 + 25569; }
  return (Date.now() - new Date().getTimezoneOffset() * 60000) / 864e5 + 25569;
}
const nowText = () => { const s = nowSerial(); const d = new Date(Math.round((s - 25569) * 864e5)); return d.toISOString().slice(0, 19).replace('T', ' '); };
const hm = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? (+m[1] * 60 + +m[2]) / 1440 : null; };

function shiftConfig() {
  const s = getSettings();
  const shifts = (Array.isArray(s.shifts) && s.shifts.length ? s.shifts : [{ code: 'A', start: '07:00' }, { code: 'B', start: '19:00' }])
    .map(x => ({ code: String(x.code), start: x.start, f: hm(x.start) })).filter(x => x.f != null).sort((a, b) => a.f - b.f);
  return { shifts, shiftHours: Number(s.shiftHours) || 12, breakHours: Number(s.breakHours) || 2 };
}
// Which operational day and shift a moment belongs to. The day starts at the first shift's start time.
function locate(serial) {
  const { shifts, shiftHours } = shiftConfig();
  const day0 = shifts[0].f;
  const opDate = Math.floor(serial - day0);              // before the first start → still yesterday's op day
  const tod = serial - opDate;                           // time since op-day midnight (0..1+day0)
  let cur = shifts[shifts.length - 1];
  for (const s of shifts) if (tod >= s.f) cur = s;
  const winStart = opDate + cur.f;
  return { opDate, code: cur.code, winStart, winEnd: winStart + shiftHours / 24 };
}
function windowFor(opDate, code) {
  const { shifts, shiftHours } = shiftConfig();
  const s = shifts.find(x => x.code === code); if (!s) return null;
  return { winStart: opDate + s.f, winEnd: opDate + s.f + shiftHours / 24 };
}
// The shift that may be started now, or null.
// Normally that is the shift the clock is in. If that shift has already been handed over (closed), the next shift
// of the same operational day may take over early – e.g. Shift A closes at 18:10, Shift B can start at once
// instead of waiting for 19:00. Returns null while a shift is open or when every shift of the day is done.
function nextSlot(now) {
  const here = locate(now);
  const { shifts } = shiftConfig();
  const rec = code => db.prepare('SELECT status FROM op_shifts WHERE op_date = ? AND code = ?').get(here.opDate, code);
  const cur = rec(here.code);
  if (!cur) return { ...here, early: false };
  if (cur.status !== 'closed') return null;
  for (let i = shifts.findIndex(s => s.code === here.code) + 1; i < shifts.length; i++) {
    if (rec(shifts[i].code)) continue;
    const w = windowFor(here.opDate, shifts[i].code);
    return { opDate: here.opDate, code: shifts[i].code, winStart: w.winStart, winEnd: w.winEnd, early: true };
  }
  return null;
}
// The shift that work done right now belongs to: the open shift, otherwise the shift the clock is in.
function currentSlot() {
  const o = db.prepare("SELECT op_date, code FROM op_shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
  if (o) return { opDate: o.op_date, code: o.code };
  const h = locate(nowSerial()); return { opDate: h.opDate, code: h.code };
}
// Which document types are attached to a shift, and which required ones are missing.
function docStatus(opDate, code) {
  const counts = {}; for (const t of DOC_TYPES) counts[t] = 0;
  for (const r of db.prepare('SELECT doc_type, COUNT(*) n FROM shift_docs WHERE op_date = ? AND shift_code = ? GROUP BY doc_type').all(opDate, code)) counts[r.doc_type] = r.n;
  return { opDate, code, counts, missing: REQUIRED_DOCS.filter(t => !counts[t]) };
}
// Documents (task + document no.) whose every line is completed, last completion in [from, to), with no signed form attached.
function docsMissingForms(from, to, limit = 5000) {
  return db.prepare(`SELECT t.task, t.docno, MIN(t.date) date, MAX(t.cdate + t.ctime) done_at, COUNT(*) lines
      FROM transactions t
      WHERE NOT EXISTS (SELECT 1 FROM doc_forms f WHERE f.task = t.task AND f.docno_key = UPPER(t.docno))
      GROUP BY t.task, UPPER(t.docno)
      HAVING SUM(t.cdate IS NULL) = 0 AND MAX(t.cdate + t.ctime) >= ? AND MAX(t.cdate + t.ctime) < ?
      ORDER BY done_at LIMIT ?`).all(from, to, limit);
}
const listDocs = (opDate, code) => db.prepare('SELECT id, op_date, shift_code, doc_type, file_name, size, signed_by, note, uploaded_by, uploaded_at FROM shift_docs WHERE op_date = ? AND shift_code = ? ORDER BY id').all(opDate, code);

// ------------------------------------------------------------ snapshot of the figures for a window
function slaMap() {
  const s = getSettings(), tm = {};
  for (const r of db.prepare('SELECT code, sla FROM task_master').all()) tm[r.code] = r.sla;
  const out = {}; for (const t of DEFS.tasks) out[t.code] = s.sla[t.code] ?? tm[t.code] ?? t.sla; return out;
}
function snapshot(from, to) {
  const now = nowSerial(), sla = slaMap();
  const rows = db.prepare("SELECT task, date, time, cdate, sys FROM transactions WHERE cdate IS NULL OR sys = 'N'").all();
  const per = {}; const z = () => ({ created: 0, completed: 0, open: 0, notPosted: 0, overdue: 0 });
  for (const t of DEFS.tasks) per[t.code] = z();
  const tot = z();
  const createdIn = db.prepare('SELECT task, COUNT(*) n FROM transactions WHERE date + time >= ? AND date + time < ? GROUP BY task').all(from, to);
  const doneIn = db.prepare('SELECT task, COUNT(*) n FROM transactions WHERE cdate IS NOT NULL AND cdate + ctime >= ? AND cdate + ctime < ? GROUP BY task').all(from, to);
  for (const r of createdIn) if (per[r.task]) { per[r.task].created = r.n; tot.created += r.n; }
  for (const r of doneIn) if (per[r.task]) { per[r.task].completed = r.n; tot.completed += r.n; }
  for (const r of rows) {
    const p = per[r.task]; if (!p) continue;
    if (r.cdate == null && r.date != null) {
      p.open++; tot.open++;
      if ((now - (r.date + (r.time || 0))) * 24 > (sla[r.task] || 24)) { p.overdue++; tot.overdue++; }
    }
    if (r.sys === 'N') { p.notPosted++; tot.notPosted++; }
  }
  const items = db.prepare("SELECT COUNT(*) n FROM handover_items WHERE status <> 'done'").get().n;
  return { at: nowText(), from, to, total: tot, perTask: per, openItems: items };
}

// ------------------------------------------------------------ helpers
const J = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const shiftRow = r => !r ? null : ({ id: r.id, opDate: r.op_date, code: r.code, winStart: r.win_start, winEnd: r.win_end, status: r.status,
  startAt: r.start_at, startBy: r.start_by, startChecklist: J(r.start_checklist), startNotes: r.start_notes, prevShiftId: r.prev_shift_id,
  endAt: r.end_at, endBy: r.end_by, endChecklist: J(r.end_checklist), endNotes: r.end_notes, handoverTo: r.handover_to, snapshot: J(r.snapshot) });
const dayRow = r => !r ? null : ({ opDate: r.op_date, status: r.status, sodAt: r.sod_at, sodBy: r.sod_by, sodChecklist: J(r.sod_checklist), sodNotes: r.sod_notes,
  eodAt: r.eod_at, eodBy: r.eod_by, eodChecklist: J(r.eod_checklist), eodNotes: r.eod_notes, eodSnapshot: J(r.eod_snapshot) });
const openShift = () => db.prepare("SELECT * FROM op_shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
const lastClosedShift = () => db.prepare("SELECT * FROM op_shifts WHERE status='closed' ORDER BY win_start DESC, id DESC LIMIT 1").get();
const openItems = () => db.prepare("SELECT * FROM handover_items WHERE status <> 'done' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id").all();

module.exports = function registerOps(route, h) {
  const { need, str, num } = h;

  function checklist(kind, body) {
    const keys = CHECKLISTS[kind], given = body.checklist || {}, out = {};
    for (const k of keys) out[k] = !!given[k];
    const missing = keys.filter(k => !out[k]);
    need(!missing.length || str(body.notes, 2000).length >= 5, 400, 'Tick every checklist item, or explain the exception in the notes.');
    return out;
  }

  // ---- current state for the Operations Room page
  route('GET', '/api/ops/state', 'viewer', () => {
    const now = nowSerial(), here = locate(now), cfg = shiftConfig();
    const day = dayRow(db.prepare('SELECT * FROM op_days WHERE op_date = ?').get(here.opDate));
    const prevDay = dayRow(db.prepare('SELECT * FROM op_days WHERE op_date < ? ORDER BY op_date DESC LIMIT 1').get(here.opDate));
    const open = openShift(), last = lastClosedShift();
    const dayShifts = db.prepare('SELECT * FROM op_shifts WHERE op_date = ? ORDER BY win_start').all(here.opDate).map(shiftRow);
    const items = openItems().map(i => ({ ...i, acks: db.prepare('SELECT shift_id, ack_by, ack_at, ack_note FROM handover_acks WHERE item_id = ?').all(i.id) }));
    const events = open ? db.prepare('SELECT * FROM shift_events WHERE shift_id = ? ORDER BY id DESC').all(open.id) : [];
    const thisShift = db.prepare('SELECT * FROM op_shifts WHERE op_date = ? AND code = ?').get(here.opDate, here.code);
    const next = open ? null : nextSlot(now);
    return { now, nowText: nowText(), here, next, config: cfg, checklists: CHECKLISTS, autoChecks: AUTO_CHECKS, docTypes: DOC_TYPES, requiredDocs: REQUIRED_DOCS, day, prevDay, dayShifts,
      openShift: shiftRow(open), lastClosed: shiftRow(last), currentShiftRecord: shiftRow(thisShift), items, events,
      docs: open ? docStatus(open.op_date, open.code) : null,
      formsMissing: open ? docsMissingForms(open.win_start, now + 1e-6, 200) : [],
      lastClosedDocs: last ? listDocs(last.op_date, last.code) : [],
      live: snapshot(open ? open.win_start : here.winStart, now) };
  });

  // ---- Start of Day
  route('POST', '/api/ops/day/start', 'cap:ops', (req, res, { body }) => {
    const here = locate(nowSerial());
    need(!db.prepare('SELECT 1 FROM op_days WHERE op_date = ?').get(here.opDate), 409, 'Start of Day was already done for this operational day.');
    const prev = db.prepare('SELECT * FROM op_days WHERE op_date < ? ORDER BY op_date DESC LIMIT 1').get(here.opDate);
    need(!prev || prev.status === 'closed' || body.force, 409, 'PREV_DAY_OPEN');
    const cl = checklist('sod', body);
    db.prepare("INSERT INTO op_days(op_date, status, sod_at, sod_by, sod_checklist, sod_notes) VALUES (?, 'open', ?, ?, ?, ?)")
      .run(here.opDate, nowText(), req.user.username, JSON.stringify(cl), str(body.notes, 2000));
    audit(req.user, 'start_of_day', `op day ${here.opDate}${prev && prev.status !== 'closed' ? ' (previous day still open)' : ''}`, req.ip);
    return { ok: true };
  });

  // ---- Start of Shift (accept handover)
  route('POST', '/api/ops/shift/start', 'cap:ops', (req, res, { body }) => {
    const now = nowSerial();
    const open = openShift();
    need(!open, 409, `Shift ${open && open.code} is still open – the outgoing lead must do End of Shift first.`);
    const here = nextSlot(now);
    need(here, 409, 'Every shift of this operational day has been handed over – do the End of Day.');
    const day = db.prepare('SELECT * FROM op_days WHERE op_date = ?').get(here.opDate);
    need(day, 409, 'Do the Start of Day first.');
    need(day.status === 'open', 409, 'This operational day is already closed.');
    if (here.early) here.winStart = Math.min(here.winStart, now);   // early takeover: the shift's figures count from the real start
    const items = openItems();
    const acks = new Map((Array.isArray(body.acks) ? body.acks : []).map(a => [Number(a.id), str(a.note, 500)]));
    const missing = items.filter(i => !acks.has(i.id));
    need(!missing.length, 400, `Acknowledge every open handover item first (${missing.length} left).`);
    const cl = checklist('sos', body);
    const prev = lastClosedShift();
    const id = tx(() => {
      const r = db.prepare("INSERT INTO op_shifts(op_date, code, win_start, win_end, status, start_at, start_by, start_checklist, start_notes, prev_shift_id) VALUES (?,?,?,?, 'open', ?,?,?,?,?)")
        .run(here.opDate, here.code, here.winStart, here.winEnd, nowText(), req.user.username, JSON.stringify(cl), str(body.notes, 2000), prev ? prev.id : null);
      const sid = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT OR REPLACE INTO handover_acks(item_id, shift_id, ack_by, ack_note, ack_at) VALUES (?,?,?,?,?)');
      for (const i of items) ins.run(i.id, sid, req.user.username, acks.get(i.id) || '', nowText());
      db.prepare("INSERT INTO shift_events(shift_id, username, type, text, ts) VALUES (?,?, 'note', ?, ?)").run(sid, req.user.username, `Shift ${here.code} started · ${items.length} handover item(s) accepted`, nowText());
      return sid;
    })();
    audit(req.user, 'start_of_shift', `shift ${here.code} of op day ${here.opDate}${here.early ? ' (early takeover)' : ''}, ${items.length} item(s) accepted`, req.ip);
    return { ok: true, id };
  });

  // ---- End of Shift (hand over)
  route('POST', '/api/ops/shift/end', 'cap:ops', (req, res, { body }) => {
    const open = openShift(); need(open, 409, 'There is no open shift.');
    // document items are ticked from the attachments, never from the form
    const ds = docStatus(open.op_date, open.code);
    body.checklist = Object.assign({}, body.checklist);
    for (const [k, type] of Object.entries(AUTO_CHECKS)) body.checklist[k] = ds.counts[type] > 0;
    need(!ds.missing.length || str(body.notes, 2000).length >= 5, 400,
      `Missing attachments for this shift: ${ds.missing.map(t => DOC_LABEL[t]).join(', ')}. Attach them in Upload → Shift documents, or explain why in the notes.`);
    // every document completed during this shift needs its signed form
    const noForm = docsMissingForms(open.win_start, nowSerial() + 1e-6);
    body.checklist.txnFormsUploaded = noForm.length === 0;
    need(!noForm.length || str(body.notes, 2000).length >= 5, 400,
      `${noForm.length} document(s) completed in this shift have no signed form (e.g. ${noForm.slice(0, 3).map(d => d.task + ' ' + d.docno).join(', ')}). Upload them in Upload → Transaction forms, or explain why in the notes.`);
    const cl = checklist('eos', body);
    need(str(body.handoverTo, 100), 400, 'Enter the name of the incoming shift lead.');
    const snap = snapshot(open.win_start, nowSerial());
    tx(() => {
      db.prepare("UPDATE op_shifts SET status='closed', end_at=?, end_by=?, end_checklist=?, end_notes=?, handover_to=?, snapshot=? WHERE id=?")
        .run(nowText(), req.user.username, JSON.stringify(cl), str(body.notes, 4000), str(body.handoverTo, 100), JSON.stringify(snap), open.id);
      db.prepare("INSERT INTO shift_events(shift_id, username, type, text, ts) VALUES (?,?, 'note', ?, ?)").run(open.id, req.user.username, `Shift ${open.code} ended · handed over to ${str(body.handoverTo, 100)}`, nowText());
    })();
    audit(req.user, 'end_of_shift', `shift ${open.code} of op day ${open.op_date} → ${str(body.handoverTo, 100)}`, req.ip);
    return { ok: true, snapshot: snap };
  });

  // ---- End of Day
  route('POST', '/api/ops/day/end', 'cap:ops', (req, res, { body }) => {
    const day = db.prepare("SELECT * FROM op_days WHERE status='open' ORDER BY op_date DESC LIMIT 1").get();
    need(day, 409, 'There is no open operational day.');
    need(!db.prepare("SELECT 1 FROM op_shifts WHERE op_date = ? AND status='open'").get(day.op_date), 409, 'End the open shift first.');
    const cl = checklist('eod', body);
    const { shifts } = shiftConfig();
    const start = day.op_date + shifts[0].f;
    const snap = snapshot(start, Math.max(nowSerial(), start));
    snap.shifts = db.prepare('SELECT code, start_by, end_by, handover_to, start_at, end_at FROM op_shifts WHERE op_date = ? ORDER BY win_start').all(day.op_date);
    db.prepare("UPDATE op_days SET status='closed', eod_at=?, eod_by=?, eod_checklist=?, eod_notes=?, eod_snapshot=? WHERE op_date=?")
      .run(nowText(), req.user.username, JSON.stringify(cl), str(body.notes, 4000), JSON.stringify(snap), day.op_date);
    audit(req.user, 'end_of_day', `op day ${day.op_date}`, req.ip);
    return { ok: true, snapshot: snap };
  });

  // ---- shift log
  route('POST', '/api/ops/events', 'cap:ops', (req, res, { body }) => {
    const open = openShift(); need(open, 409, 'Start the shift first.');
    need(EVENT_TYPES.includes(body.type), 400, 'Bad entry type.');
    need(body.type.startsWith('break') || str(body.text, 1000), 400, 'Write the note.');
    db.prepare('INSERT INTO shift_events(shift_id, username, type, text, ts) VALUES (?,?,?,?,?)').run(open.id, req.user.username, body.type, str(body.text, 1000), nowText());
    return { ok: true };
  });

  // ---- handover items
  route('POST', '/api/ops/items', 'cap:ops', (req, res, { body }) => {
    const title = str(body.title, 300); need(title, 400, 'Describe what has to be handed over.');
    const task = str(body.task, 20).toUpperCase(); need(!task || DEFS.tasks.some(t => t.code === task), 400, 'Unknown task code.');
    const open = openShift();
    const r = db.prepare('INSERT INTO handover_items(task, docno, title, priority, note, created_by, created_shift_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(task || null, str(body.docno, 120), title, PRIORITY.includes(body.priority) ? body.priority : 'normal', str(body.note, 2000), req.user.username, open ? open.id : null, nowText());
    // the shift that creates an item has seen it
    if (open) db.prepare('INSERT OR IGNORE INTO handover_acks(item_id, shift_id, ack_by, ack_at) VALUES (?,?,?,?)').run(Number(r.lastInsertRowid), open.id, req.user.username, nowText());
    audit(req.user, 'handover_item_added', `#${r.lastInsertRowid} ${task} ${title}`.slice(0, 300), req.ip);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });
  route('PATCH', '/api/ops/items/:id', 'cap:ops', (req, res, { params, body }) => {
    const it = db.prepare('SELECT * FROM handover_items WHERE id = ?').get(+params.id); need(it, 404, 'Item not found.');
    const status = body.status != null ? body.status : it.status; need(ITEM_STATUS.includes(status), 400, 'Bad status.');
    const priority = body.priority != null ? body.priority : it.priority; need(PRIORITY.includes(priority), 400, 'Bad priority.');
    const note = body.note != null ? str(body.note, 2000) : it.note;
    if (status === 'done' && it.status !== 'done') need(str(body.closeNote, 1000), 400, 'Write how it was resolved.');
    const open = openShift();
    const nt = nowText();
    db.prepare(`UPDATE handover_items SET status=?, priority=?, note=?, updated_at=?, updated_by=?,
      closed_at=CASE WHEN ?='done' THEN ? ELSE NULL END, closed_by=CASE WHEN ?='done' THEN ? ELSE NULL END,
      closed_shift_id=CASE WHEN ?='done' THEN ? ELSE NULL END, close_note=CASE WHEN ?='done' THEN ? ELSE close_note END WHERE id=?`)
      .run(status, priority, note, nt, req.user.username, status, nt, status, req.user.username, status, open ? open.id : null, status, str(body.closeNote, 1000), it.id);
    audit(req.user, 'handover_item_updated', `#${it.id} → ${status}`, req.ip);
    return { ok: true };
  });

  // ---- history & detail
  route('GET', '/api/ops/history', 'viewer', (req) => {
    const days = db.prepare('SELECT * FROM op_days ORDER BY op_date DESC LIMIT ?').all(Math.min(400, +(req.query.limit || 60))).map(dayRow);
    const shifts = db.prepare('SELECT * FROM op_shifts WHERE op_date >= ? ORDER BY win_start DESC').all(days.length ? days[days.length - 1].opDate : 0).map(shiftRow);
    return { days, shifts };
  });
  route('GET', '/api/ops/shift/:id', 'viewer', (req, res, { params }) => {
    const s = db.prepare('SELECT * FROM op_shifts WHERE id = ?').get(+params.id); need(s, 404, 'Shift not found.');
    return {
      shift: shiftRow(s), day: dayRow(db.prepare('SELECT * FROM op_days WHERE op_date = ?').get(s.op_date)),
      events: db.prepare('SELECT * FROM shift_events WHERE shift_id = ? ORDER BY id').all(s.id),
      accepted: db.prepare('SELECT i.*, a.ack_by, a.ack_at, a.ack_note FROM handover_acks a JOIN handover_items i ON i.id = a.item_id WHERE a.shift_id = ? AND (i.created_shift_id IS NULL OR i.created_shift_id <> a.shift_id) ORDER BY i.id').all(s.id),
      created: db.prepare('SELECT * FROM handover_items WHERE created_shift_id = ? ORDER BY id').all(s.id),
      closed: db.prepare('SELECT * FROM handover_items WHERE closed_shift_id = ? ORDER BY id').all(s.id),
      docs: listDocs(s.op_date, s.code),
    };
  });

  // ---- shift documents: signed forms, WIF documents, SAP Business One layouts
  const slotFrom = q => {
    if (q.opDate == null || q.opDate === '' || !q.code) return currentSlot();
    const opDate = Math.floor(Number(q.opDate)), code = str(q.code, 10);
    need(isFinite(opDate) && opDate > 40000 && opDate < 80000, 400, 'Bad operational day.');
    need(shiftConfig().shifts.some(s => s.code === code), 400, 'Unknown shift.');
    need(opDate <= Math.floor(nowSerial()) + 1, 400, 'That operational day is in the future.');
    return { opDate, code };
  };
  route('GET', '/api/shift-docs', 'viewer', (req) => {
    const slot = slotFrom(req.query);
    const rec = db.prepare('SELECT status FROM op_shifts WHERE op_date = ? AND code = ?').get(slot.opDate, slot.code);
    return { slot, current: currentSlot(), shiftStatus: rec ? rec.status : null, docTypes: DOC_TYPES, required: REQUIRED_DOCS,
      status: docStatus(slot.opDate, slot.code), docs: listDocs(slot.opDate, slot.code), shifts: shiftConfig().shifts.map(s => ({ code: s.code, start: s.start })) };
  });
  route('POST', '/api/shift-docs', 'cap:docs', (req, res, { body }) => {
    const slot = slotFrom(body);
    const type = str(body.docType, 30); need(DOC_TYPES.includes(type), 400, 'Choose the type of document.');
    const fileName = path.basename(str(body.fileName, 200)); const ext = path.extname(fileName).toLowerCase();
    need(fileName && DOC_EXT[ext], 400, `This file type is not accepted. Use: ${Object.keys(DOC_EXT).join(' ')}`);
    need(typeof body.fileB64 === 'string' && body.fileB64.length, 400, 'Choose a file.');
    const signedBy = str(body.signedBy, 200);
    need(type !== 'handover_form' || signedBy, 400, 'Enter who signed the handover/takeover form.');
    const rec = db.prepare('SELECT status FROM op_shifts WHERE op_date = ? AND code = ?').get(slot.opDate, slot.code);
    need(!rec || rec.status === 'open' || req.user.role === 'admin', 409, 'This shift is closed – only an admin can add documents to it.');
    const buf = Buffer.from(body.fileB64, 'base64');
    need(buf.length > 0, 400, 'The file is empty.');
    need(buf.length <= cfg.MAX_UPLOAD_MB * 1048576, 413, `File too large (max ${cfg.MAX_UPLOAD_MB} MB).`);
    const r = db.prepare('INSERT INTO shift_docs(op_date, shift_code, doc_type, file_name, file_path, size, signed_by, note, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(slot.opDate, slot.code, type, fileName, '', buf.length, signedBy, str(body.note, 500), req.user.username, nowText());
    const id = Number(r.lastInsertRowid);
    const rel = `${id}_${fileName.replace(/[^\w.\-]+/g, '_')}`;
    fs.writeFileSync(path.join(DOCS_DIR, rel), buf);
    db.prepare('UPDATE shift_docs SET file_path = ? WHERE id = ?').run(rel, id);
    audit(req.user, 'shift_doc_uploaded', `#${id} ${DOC_LABEL[type]} for shift ${slot.code} of op day ${slot.opDate}: ${fileName}`, req.ip);
    return { ok: true, id, status: docStatus(slot.opDate, slot.code) };
  });
  route('GET', '/api/shift-docs/:id/file', 'viewer', (req, res, { params }) => {
    const d = db.prepare('SELECT * FROM shift_docs WHERE id = ?').get(+params.id); need(d && d.file_path, 404, 'Document not found.');
    const full = path.join(DOCS_DIR, path.basename(d.file_path));
    need(fs.existsSync(full), 404, 'File not found.');
    const ext = path.extname(d.file_name).toLowerCase();
    res.sendRaw(200, fs.readFileSync(full), DOC_EXT[ext] || 'application/octet-stream',
      { 'Content-Disposition': `attachment; filename="${d.file_name.replace(/[^\w.\-]+/g, '_')}"` });
  });
  route('DELETE', '/api/shift-docs/:id', 'cap:docs', (req, res, { params }) => {
    const d = db.prepare('SELECT * FROM shift_docs WHERE id = ?').get(+params.id); need(d, 404, 'Document not found.');
    const rec = db.prepare('SELECT status FROM op_shifts WHERE op_date = ? AND code = ?').get(d.op_date, d.shift_code);
    need(req.user.role === 'admin' || (d.uploaded_by === req.user.username && (!rec || rec.status === 'open')), 403,
      'Only the person who uploaded it can remove it, while the shift is open (or an admin).');
    db.prepare('DELETE FROM shift_docs WHERE id = ?').run(d.id);
    if (d.file_path) { try { fs.unlinkSync(path.join(DOCS_DIR, path.basename(d.file_path))); } catch { } }
    audit(req.user, 'shift_doc_deleted', `#${d.id} ${d.file_name} (shift ${d.shift_code} of op day ${d.op_date})`, req.ip);
    return { ok: true };
  });
  route('POST', '/api/ops/shift/:id/reopen', 'admin', (req, res, { params }) => {
    const s = db.prepare('SELECT * FROM op_shifts WHERE id = ?').get(+params.id); need(s, 404, 'Shift not found.');
    need(!openShift(), 409, 'Another shift is open.');
    db.prepare("UPDATE op_shifts SET status='open' WHERE id=?").run(s.id);
    db.prepare("UPDATE op_days SET status='open' WHERE op_date=?").run(s.op_date);
    audit(req.user, 'shift_reopened', `shift ${s.code} of op day ${s.op_date}`, req.ip);
    return { ok: true };
  });
};
module.exports.locate = locate;
module.exports.windowFor = windowFor;
module.exports.currentSlot = currentSlot;
module.exports.docStatus = docStatus;
module.exports.docsMissingForms = docsMissingForms;
module.exports.DOC_EXT = DOC_EXT;
module.exports.nowText = nowText;
