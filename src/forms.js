'use strict';
// Signed forms per document (task + document no.). Every completed document must have at least one.
const fs = require('node:fs');
const path = require('node:path');
const { db, audit } = require('./db');
const cfg = require('./config');
const DEFS = require('./defs.json');
const ops = require('./ops');

const DIR = path.join(cfg.DATA_DIR, 'doc-forms');
fs.mkdirSync(DIR, { recursive: true });
const TASKS = new Set(DEFS.tasks.map(t => t.code));
const COLS = 'id, task, docno, file_name, size, signed_by, note, uploaded_by, uploaded_at, op_date, shift_code';

module.exports = function registerForms(route, { need, str, num }) {
  // Documents with their form status: completed without a form (any age) + every document of the last `days` days.
  route('GET', '/api/doc-forms/docs', 'viewer', (req) => {
    const days = Math.min(400, Math.max(1, num(req.query.days) || 60));
    const since = Math.floor(Date.now() / 864e5 + 25569) - days;
    const docs = db.prepare(`SELECT t.task, MIN(t.docno) docno, MIN(t.date) date, COUNT(*) lines,
        SUM(t.cdate IS NULL) open_lines, MAX(t.cdate + t.ctime) done_at,
        (SELECT COUNT(*) FROM doc_forms f WHERE f.task = t.task AND f.docno_key = UPPER(t.docno)) forms
      FROM transactions t GROUP BY t.task, UPPER(t.docno)
      HAVING MIN(t.date) >= ? OR (open_lines = 0 AND forms = 0)
      ORDER BY date DESC LIMIT 5000`).all(since);
    return { days, docs: docs.map(d => ({ ...d, done: d.open_lines === 0 })) };
  });

  route('GET', '/api/doc-forms', 'viewer', (req) => {
    const task = str(req.query.task, 20).toUpperCase(), docno = str(req.query.docno, 120);
    need(task && docno, 400, 'Give the task and document number.');
    return { forms: db.prepare(`SELECT ${COLS} FROM doc_forms WHERE task = ? AND docno_key = ? ORDER BY id`).all(task, docno.toUpperCase()) };
  });

  route('POST', '/api/doc-forms', 'cap:docs', (req, res, { body }) => {
    const task = str(body.task, 20).toUpperCase(), docno = str(body.docno, 120);
    need(TASKS.has(task), 400, 'Choose the task.');
    need(docno, 400, 'Enter the document number.');
    const fileName = path.basename(str(body.fileName, 200)), ext = path.extname(fileName).toLowerCase();
    need(fileName && ops.DOC_EXT[ext], 400, `This file type is not accepted. Use: ${Object.keys(ops.DOC_EXT).join(' ')}`);
    need(typeof body.fileB64 === 'string' && body.fileB64.length, 400, 'Choose a file.');
    const buf = Buffer.from(body.fileB64, 'base64');
    need(buf.length > 0, 400, 'The file is empty.');
    need(buf.length <= cfg.MAX_UPLOAD_MB * 1048576, 413, `File too large (max ${cfg.MAX_UPLOAD_MB} MB).`);
    const slot = ops.currentSlot();
    const r = db.prepare('INSERT INTO doc_forms(task, docno, docno_key, file_name, size, signed_by, note, uploaded_by, uploaded_at, op_date, shift_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(task, docno, docno.toUpperCase(), fileName, buf.length, str(body.signedBy, 200), str(body.note, 500), req.user.username, ops.nowText(), slot.opDate, slot.code);
    const id = Number(r.lastInsertRowid);
    const rel = `${id}_${fileName.replace(/[^\w.\-]+/g, '_')}`;
    fs.writeFileSync(path.join(DIR, rel), buf);
    db.prepare('UPDATE doc_forms SET file_path = ? WHERE id = ?').run(rel, id);
    const known = !!db.prepare('SELECT 1 FROM transactions WHERE task = ? AND UPPER(docno) = ? LIMIT 1').get(task, docno.toUpperCase());
    audit(req.user, 'doc_form_uploaded', `#${id} ${task} ${docno}: ${fileName}${known ? '' : ' (document not in the data yet)'}`, req.ip);
    return { ok: true, id, known };
  });

  route('GET', '/api/doc-forms/:id/file', 'viewer', (req, res, { params }) => {
    const d = db.prepare('SELECT * FROM doc_forms WHERE id = ?').get(+params.id); need(d && d.file_path, 404, 'Form not found.');
    const full = path.join(DIR, path.basename(d.file_path)); need(fs.existsSync(full), 404, 'File not found.');
    res.sendRaw(200, fs.readFileSync(full), ops.DOC_EXT[path.extname(d.file_name).toLowerCase()] || 'application/octet-stream',
      { 'Content-Disposition': `attachment; filename="${d.file_name.replace(/[^\w.\-]+/g, '_')}"` });
  });

  route('DELETE', '/api/doc-forms/:id', 'cap:docs', (req, res, { params }) => {
    const d = db.prepare('SELECT * FROM doc_forms WHERE id = ?').get(+params.id); need(d, 404, 'Form not found.');
    // the uploader may remove it while the shift it was uploaded in is still running; otherwise only an admin
    const cur = ops.currentSlot();
    const sameShift = d.op_date === cur.opDate && d.shift_code === cur.code &&
      !db.prepare("SELECT 1 FROM op_shifts WHERE op_date = ? AND code = ? AND status = 'closed'").get(d.op_date, d.shift_code);
    need(req.user.role === 'admin' || (d.uploaded_by === req.user.username && sameShift), 403,
      'Only the person who uploaded it can remove it, during the same shift (or an admin).');
    db.prepare('DELETE FROM doc_forms WHERE id = ?').run(d.id);
    if (d.file_path) { try { fs.unlinkSync(path.join(DIR, path.basename(d.file_path))); } catch { } }
    audit(req.user, 'doc_form_deleted', `#${d.id} ${d.task} ${d.docno}: ${d.file_name}`, req.ip);
    return { ok: true };
  });
};
