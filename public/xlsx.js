"use strict";
/* In-browser Excel (.xlsx) and CSV reader – no library needed (uses the browser's built-in DecompressionStream).
   extractWorkbook() turns a template / report workbook into { rows, masters, sample, skipped, notes }. */
(function (global) {
  async function inflate(u8) {
    const ds = new DecompressionStream("deflate-raw");
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
  }
  async function unzip(ab) {
    const dv = new DataView(ab), u8 = new Uint8Array(ab), files = {}, td = new TextDecoder();
    let e = -1;
    for (let i = ab.byteLength - 22; i >= Math.max(0, ab.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("not an .xlsx file");
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      files[name] = { method, data: u8.subarray(start, start + csize) };
      p += 46 + nl + xl + cl;
    }
    return { async text(nm) { const f = files[nm]; if (!f) return null; return td.decode(f.method === 0 ? f.data : await inflate(f.data)); } };
  }
  const xml = s => new DOMParser().parseFromString(s, "application/xml");
  const tags = (node, name) => node.getElementsByTagNameNS("*", name);
  const colIdx = ref => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };

  async function readXlsx(ab) {
    const z = await unzip(ab);
    const wbx = xml(await z.text("xl/workbook.xml"));
    const relsTxt = await z.text("xl/_rels/workbook.xml.rels"); const rels = {};
    if (relsTxt) for (const r of tags(xml(relsTxt), "Relationship")) rels[r.getAttribute("Id")] = r.getAttribute("Target");
    const ss = []; const sst = await z.text("xl/sharedStrings.xml");
    if (sst) for (const si of tags(xml(sst), "si")) { let s = ""; for (const tt of tags(si, "t")) { if (tt.parentNode.localName === "rPh") continue; s += tt.textContent; } ss.push(s); }
    const out = [];
    for (const sh of tags(wbx, "sheet")) {
      const rid = sh.getAttribute("r:id") || sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      let target = (rels[rid] || "").replace(/^\//, ""); if (!target.startsWith("xl/")) target = "xl/" + target;
      const txt = await z.text(target); if (!txt) continue;
      const rows = [];
      for (const row of tags(xml(txt), "row")) {
        const ri = +row.getAttribute("r") - 1, arr = []; let ci = 0;
        for (const c of tags(row, "c")) {
          const r = c.getAttribute("r"); if (r) ci = colIdx(r);
          const ty = c.getAttribute("t"), vEl = tags(c, "v")[0]; let v = vEl ? vEl.textContent : null;
          if (ty === "s") v = v == null ? null : ss[+v];
          else if (ty === "inlineStr") { v = ""; for (const tt of tags(c, "t")) v += tt.textContent; }
          else if (ty === "b") v = v === "1";
          else if (ty !== "str" && ty !== "e" && v != null && v !== "") v = Number(v);
          arr[ci] = v; ci++;
        }
        rows[ri] = arr;
      }
      out.push({ name: sh.getAttribute("name"), rows });
    }
    return out;
  }
  function readCsv(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === "," || ch === ";" || ch === "\t") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (ch !== "\r") cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return [{ name: "CSV", rows: rows.map(r => r.map(v => { const n = Number(v); return v !== "" && isFinite(n) ? n : v; })) }];
  }

  // ---------- value normalisation
  const norm = v => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  function parseDate(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v > 1000 ? Math.floor(v) : null;
    const s = String(v).trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 + 25569;
    if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) { let y = +m[3]; if (y < 100) y += 2000; return Date.UTC(y, +m[2] - 1, +m[1]) / 864e5 + 25569; }
    const n = Number(s); return isFinite(n) && n > 1000 ? Math.floor(n) : null;
  }
  function parseTime(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return v % 1;
    const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|ص|م)?/i);
    if (!m) return 0; let h = +m[1]; const ap = (m[4] || "").toLowerCase();
    if ((ap === "pm" || ap === "م") && h < 12) h += 12; if ((ap === "am" || ap === "ص") && h === 12) h = 0;
    return (h * 60 + +m[2]) / 1440;
  }
  function normSys(v) {
    const s = norm(v); if (!s) return "";
    if (["yes", "y", "نعم", "true", "1"].includes(s)) return "Y";
    if (["no", "n", "لا", "false", "0"].includes(s)) return "N";
    if (["n/a", "na", "لا ينطبق", "-", "–"].includes(s)) return "NA";
    return "";
  }
  const STATUS_MAP = { draft: "draft", "مسودة": "draft", "pending approval": "pending", pending: "pending", "بانتظار الاعتماد": "pending", approved: "approved", "معتمد": "approved",
    "posted in sap": "posted", posted: "posted", "مرحّل على sap": "posted", "مرحل على sap": "posted", rejected: "rejected", "مرفوض": "rejected", cancelled: "cancelled", canceled: "cancelled", "ملغى": "cancelled", "ملغي": "cancelled" };
  const normStatus = v => STATUS_MAP[norm(v)] || (norm(v) ? "other:" + String(v).trim() : "");

  // ---------- header recognition (English + Arabic templates, full report workbook, SAP master export)
  const FIELDS = {
    task: ["task code", "رمز المهمة"], docno: ["document number", "رقم الإذن"], date: ["document date", "تاريخ الإذن"], time: ["document time", "وقت الإذن"],
    ref: ["ref. document no.", "رقم المستند المرجعي"], from: ["from warehouse", "من مخزن"], to: ["to warehouse", "إلى مخزن"], item: ["item code", "كود الصنف"],
    desc: ["item description", "وصف الصنف"], uom: ["uom", "الوحدة"], batch: ["batch", "التشغيلة"], qty: ["quantity", "الكمية"], status: ["status", "الحالة"],
    sys: ["system updated", "تم التحديث على النظام"], sysdoc: ["system document number", "رقم مستند النظام"], cdate: ["completion date", "تاريخ الإنجاز"],
    ctime: ["completion time", "وقت الإنجاز"], remarks: ["remarks", "ملاحظات"]
  };
  const TMF = { task: ["task code", "رمز المهمة"], sla: ["sla target (hrs)", "الزمن المستهدف (ساعة)"], txn: ["transaction code", "رمز الحركة"], numwh: ["numbering wh", "مخزن الترقيم"] };
  const IMF = { item: ["item no.", "رقم الصنف"], desc: ["item description", "وصف الصنف"], uom: ["inventory uom", "وحدة المخزون"] };
  const WHF = { code: ["warehouse code", "كود المخزن"], name: ["warehouse name", "اسم المخزن"], ar: ["warehouse arabic name", "اسم المخزن بالعربي"] };
  function findHeader(rows, spec, need) {
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const row = rows[r]; if (!row) continue; const map = {};
      row.forEach((h, i) => { const n = norm(h); for (const k in spec) if (map[k] == null && spec[k].includes(n)) map[k] = i; });
      if (need.every(k => map[k] != null)) return { r, map };
    }
    return null;
  }
  const PREF_TX = ["transactions", "general report", "الحركات", "التقرير العام"];
  const SAMPLE_RE = /sample|عينة/i;

  async function extractFile(file, taskCodes) {
    const res = { name: file.name, rows: [], sample: 0, skipped: 0, unknownTask: 0, masters: { items: [], whs: [], taskMaster: [] }, notes: [], error: null };
    if (/\.xls$/i.test(file.name)) { res.error = "xls"; return res; }
    const sheets = /\.csv$/i.test(file.name) ? readCsv(await file.text()) : await readXlsx(await file.arrayBuffer());
    for (const sh of sheets) {
      const im = findHeader(sh.rows, IMF, ["item", "desc"]);
      if (im) { for (let r = im.r + 1; r < sh.rows.length; r++) { const row = sh.rows[r]; if (!row) continue; const c = String(row[im.map.item] ?? "").trim(); if (c) res.masters.items.push([c, String(row[im.map.desc] ?? ""), im.map.uom != null ? String(row[im.map.uom] ?? "") : ""]); } continue; }
      const wh = findHeader(sh.rows, WHF, ["code", "name"]);
      if (wh) { for (let r = wh.r + 1; r < sh.rows.length; r++) { const row = sh.rows[r]; if (!row) continue; const c = String(row[wh.map.code] ?? "").trim(); if (c) res.masters.whs.push([c, String(row[wh.map.name] ?? ""), wh.map.ar != null ? String(row[wh.map.ar] ?? "") : ""]); } continue; }
      const tm = findHeader(sh.rows, TMF, ["task", "sla"]);
      if (tm && !findHeader(sh.rows, FIELDS, ["task", "docno", "date"]) && !["kpi summary", "ملخص المؤشرات"].includes(norm(sh.name))) {
        for (let r = tm.r + 1; r < sh.rows.length; r++) {
          const row = sh.rows[r]; if (!row) continue; const code = String(row[tm.map.task] ?? "").trim().toUpperCase();
          if (!taskCodes.has(code)) continue;
          const o = { code }; const sla = Number(row[tm.map.sla]); if (isFinite(sla) && sla > 0) o.sla = sla;
          if (tm.map.txn != null) { const x = String(row[tm.map.txn] ?? "").trim(); o.txn = (!x || /^[-–—]$/.test(x) || /no code|لا يوجد/i.test(x)) ? "" : x; }
          if (tm.map.numwh != null) { const x = norm(row[tm.map.numwh]); if (x) o.numWH = /to|إلى/.test(x) ? "to" : "from"; }
          res.masters.taskMaster.push(o);
        }
        continue;
      }
    }
    let cands = sheets.map(sh => ({ sh, h: findHeader(sh.rows, FIELDS, ["task", "docno", "date"]) })).filter(x => x.h);
    const pref = cands.filter(x => PREF_TX.includes(norm(x.sh.name))); if (pref.length) cands = pref;
    for (const { sh, h } of cands) {
      for (let r = h.r + 1; r < sh.rows.length; r++) {
        const row = sh.rows[r]; if (!row) continue;
        const g = k => h.map[k] != null ? row[h.map[k]] : null;
        const task = String(g("task") ?? "").trim().toUpperCase(), docno = String(g("docno") ?? "").trim();
        if (!task && !docno) continue;
        if (!task || !docno) { res.skipped++; continue; }
        if (SAMPLE_RE.test(String(g("remarks") ?? ""))) { res.sample++; continue; }
        if (!taskCodes.has(task)) res.unknownTask++;
        let desc = String(g("desc") ?? "").trim(); if (/^(\?|⚠|#n\/a)/i.test(desc)) desc = "";
        res.rows.push({ task, docno, date: parseDate(g("date")), time: parseTime(g("time")), ref: String(g("ref") ?? "").trim(),
          from: String(g("from") ?? "").trim(), to: String(g("to") ?? "").trim(), item: String(g("item") ?? "").trim(), desc,
          uom: String(g("uom") ?? "").trim(), batch: String(g("batch") ?? "").trim(), qty: Number(g("qty")) || 0,
          status: normStatus(g("status")), sys: normSys(g("sys")), sysdoc: String(g("sysdoc") ?? "").trim(),
          cdate: parseDate(g("cdate")), ctime: parseTime(g("ctime")), remarks: String(g("remarks") ?? "").trim() });
      }
    }
    if (!cands.length) res.notes.push("noTx");
    return res;
  }
  function toBase64(ab) {
    const u8 = new Uint8Array(ab); let s = ""; const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  global.XLSXR = { readXlsx, readCsv, extractFile, toBase64, norm };
})(window);
