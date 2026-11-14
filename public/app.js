"use strict";
/* SCM IN / OUT Operations – single-page app (no framework, no build step). */
(() => {
/* =========================================================== helpers */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nfq = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const pct = (x, d = 1) => (x == null || isNaN(x)) ? "–" : (x * 100).toFixed(d) + "%";
const nowSerial = () => (Date.now() - new Date().getTimezoneOffset() * 60000) / 864e5 + 25569;
const todaySerial = () => Math.floor(nowSerial());
const serToDate = s => new Date(Math.round((s - 25569) * 864e5));
const fmtDate = s => { if (s == null || s === "") return ""; const d = serToDate(Math.floor(s)); return String(d.getUTCDate()).padStart(2, "0") + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + d.getUTCFullYear(); };
const fmtDM = s => { const d = serToDate(Math.floor(s)); return String(d.getUTCDate()).padStart(2, "0") + "/" + String(d.getUTCMonth() + 1).padStart(2, "0"); };
const fmtTime = f => { if (f == null || f === "") return ""; const m = Math.round((f % 1) * 1440); return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
const isoToSer = iso => { if (!iso) return null; const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5 + 25569; };
const serToIso = s => serToDate(Math.floor(s)).toISOString().slice(0, 10);
const fmtTs = s => s ? s.replace("T", " ").slice(0, 16) : "";
let LANG = (() => { try { return localStorage.getItem("scm.lang") || "en"; } catch { return "en"; } })();
const t = (k, v) => { let s = (I18N[LANG][k] ?? I18N.en[k] ?? k); if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
const isAr = () => LANG === "ar";
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 3500); }

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-SCM": "1" }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error(t("errNet")); }
  let data = {}; try { data = await res.json(); } catch { }
  if (res.status === 401 && !url.startsWith("/api/login")) { S.user = null; if (!S.guest) { showLogin(); } }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function modal(title, html, buttons) {
  return new Promise(resolve => {
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<div class="box" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><div class="mbody">${html}</div><div class="btns">${buttons.map((b, i) => `<button class="btn ${b.cls || "light"}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
    document.body.appendChild(m);
    const close = v => { m.remove(); resolve(v); };
    m.querySelectorAll("[data-i]").forEach(b => b.onclick = () => { const bt = buttons[+b.dataset.i]; close(bt.value !== undefined ? (typeof bt.value === "function" ? bt.value(m) : bt.value) : null); });
    m.addEventListener("click", e => { if (e.target === m) close(null); });
    const first = m.querySelector("input"); (first || m.querySelector(".btn")).focus();
  });
}
const tempPassword = () => { const c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz"; let s = ""; const a = new Uint32Array(8); crypto.getRandomValues(a); a.forEach(x => s += c[x % c.length]); return s + (10 + a[0] % 90); };

/* =========================================================== state */
const S = {
  user: null, guest: false, pub: {}, cfg: null, items: {}, whs: {},
  rows: [], dayRows: [], from: null, to: null, flow: "ALL", task: "ALL", wh: "ALL", daily: null,
  log: { q: "", sort: "date", dir: -1, page: 0 }, check: "notPosted", view: "dash", pending: [], uploads: null,
};
const TASK = {}; let TASK_ORDER = [];
// Same rules as the server: linear levels, plus "cap:" capabilities that only named roles have.
const CAPS = { ops: ["admin", "shift_lead"], docs: ["admin", "mis", "shift_lead"], upload: ["admin", "mis", "shift_lead"] };
const can = role => {
  if (role.startsWith("cap:")) return !!S.user && (CAPS[role.slice(4)] || []).includes(S.user.role);
  const L = { guest: 0, viewer: 1, shift_lead: 1, mis: 2, admin: 3 }; const mine = S.user ? (L[S.user.role] ?? -1) : (S.guest ? 0 : -1); return mine >= L[role];
};
const ROLE_LIST = ["admin", "mis", "shift_lead", "viewer"];

/* =========================================================== definitions & derived rows */
function def(code) {
  const b = TASK[code]; if (!b) return null;
  const set = S.cfg.settings, tm = S.cfg.taskMaster[code] || {};
  const sla = set.sla[code] != null ? set.sla[code] : (tm.sla != null ? tm.sla : b.sla);
  return { ...b, sla, txn: tm.txn != null ? tm.txn : b.txn, numWH: tm.numWH || b.numWH,
    slaSrc: set.sla[code] != null ? "edit" : (tm.sla != null ? "file" : "default") };
}
const tName = d => d ? (isAr() ? d.ar : d.en) : "";
function derive(list) {
  const now = nowSerial(), sep = S.cfg.settings.sep || "/";
  return list.map(r => {
    const d = def(r.task), x = r;
    x.def = d; x.flow = d ? d.flow : "?";
    const it = S.items[(r.item || "").toUpperCase()];
    if (!x.desc && it) x.desc = it[0]; if (!x.uom && it) x.uom = it[1];
    const start = x.date != null ? x.date + (x.time || 0) : null, end = x.cdate != null ? x.cdate + (x.ctime || 0) : null;
    x.done = x.cdate != null;
    x.el = start == null ? null : Math.round(((end != null ? end : now) - start) * 240) / 10;
    const sla = d ? d.sla : null;
    x.res = (x.el == null || sla == null) ? "" : (x.done ? (x.el <= sla ? "ontime" : "late") : (x.el > sla ? "overdue" : "open"));
    x.txn = d ? d.txn : ""; x.nwh = d ? (d.numWH === "to" ? x.to : x.from) : "";
    x.prefix = x.txn && x.nwh ? x.txn + sep + x.nwh + sep : "";
    x.numOK = x.prefix ? x.docno.toUpperCase().startsWith(x.prefix.toUpperCase()) : null;
    return x;
  });
}
const fromApi = data => data.rows.map(a => ({ task: a[0], docno: a[1], date: a[2], time: a[3], ref: a[4], from: a[5], to: a[6], item: a[7], desc: a[8], uom: a[9], batch: a[10], qty: a[11], status: a[12], sys: a[13], sysdoc: a[14], cdate: a[15], ctime: a[16], remarks: a[17], upload: a[18], forms: a[19] || 0 }));

async function loadConfig() {
  S.cfg = await api("GET", "/api/config");
  S.cfg.defs.tasks.forEach(x => TASK[x.code] = x); TASK_ORDER = S.cfg.defs.tasks.map(x => x.code);
  const r = S.cfg.counts.range;
  if (S.from == null || S.to == null) {
    const mx = r && r.mx != null ? r.mx : todaySerial(); const d = serToDate(mx);
    S.to = mx; S.from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 864e5 + 25569;
  }
  if (S.daily == null) S.daily = r && r.mx != null ? r.mx : todaySerial();
}
async function loadMasters() { const m = await api("GET", "/api/masters"); S.items = {}; S.whs = {}; m.items.forEach(i => S.items[String(i[0]).toUpperCase()] = [i[1], i[2]]); m.whs.forEach(w => S.whs[String(w[0]).toUpperCase()] = [w[1], w[2]]); }
async function loadRows() { S.rows = derive(fromApi(await api("GET", `/api/rows?from=${S.from}&to=${S.to}`))); }
async function loadDay() { S.dayRows = derive(fromApi(await api("GET", `/api/rows?from=${S.daily}&to=${S.daily}`))); }

/* =========================================================== metrics */
const inPeriod = r => r.date != null && r.date >= S.from && r.date <= S.to;
const passFilters = r => (S.flow === "ALL" || r.flow === S.flow) && (S.task === "ALL" || r.task === S.task) && (S.wh === "ALL" || r.from === S.wh || r.to === S.wh);
const filtered = () => S.rows.filter(r => inPeriod(r) && passFilters(r));
function metrics(rows) {
  const m = { total: 0, y: 0, n: 0, done: 0, ontime: 0, elSum: 0, open: 0, overdue: 0, late: 0, rc: 0, numY: 0, numN: 0, qty: 0 };
  for (const r of rows) {
    m.total++; if (r.sys === "Y") m.y++; else if (r.sys === "N") m.n++;
    if (r.done) { m.done++; if (r.el != null) m.elSum += r.el; } else m.open++;
    if (r.res === "ontime") m.ontime++; if (r.res === "overdue") m.overdue++; if (r.res === "late" || r.res === "overdue") m.late++;
    if (r.status === "rejected" || r.status === "cancelled") m.rc++;
    if (r.numOK === true) m.numY++; else if (r.numOK === false) m.numN++;
    m.qty += r.qty || 0;
  }
  m.comp = m.y + m.n ? m.y / (m.y + m.n) : null; m.on = m.done ? m.ontime / m.done : null; m.avg = m.done ? m.elSum / m.done : null;
  m.num = m.numY + m.numN ? m.numY / (m.numY + m.numN) : null;
  return m;
}
function health(m, d) {
  const st = S.cfg.settings; if (!m.total) return "none";
  const comp = d && d.sap === "N/A" ? null : m.comp;
  if (m.overdue > 0 || (m.on != null && m.on < st.watch) || (comp != null && comp < st.watch)) return "act";
  if ((m.on != null && m.on < st.onT) || (comp != null && comp < st.compT) || m.open > 0) return "watch";
  return "good";
}
const HP = { good: ["p-good", "hGood"], watch: ["p-warn", "hWatch"], act: ["p-crit", "hAct"], none: ["p-none", "hNone"] };
const hPill = h => `<span class="pill ${HP[h][0]}">${t(HP[h][1])}</span>`;
const statusPill = text => { const c = text[0]; const cls = c === "✔" ? "p-good" : c === "▲" ? "p-warn" : c === "✖" ? "p-crit" : "p-none"; return `<span class="pill ${cls}">${esc(text)}</span>`; };

/* =========================================================== charts (SVG, mouse + touch) */
const tip = $("#tip");
function showTip(x0, y0, html) { tip.innerHTML = html; tip.style.display = "block"; const w = tip.offsetWidth, h = tip.offsetHeight; let x = x0 + 14, y = y0 + 14; if (x + w > innerWidth - 8) x = x0 - w - 14; if (x < 8) x = 8; if (y + h > innerHeight - 8) y = y0 - h - 14; tip.style.left = x + "px"; tip.style.top = y + "px"; }
const hideTip = () => { tip.style.display = "none"; };
addEventListener("scroll", hideTip, { passive: true });
function drawChart(el, cfg) {
  if (!el) return;
  const W = Math.max(el.clientWidth, 260), H = el.clientHeight || 260, rtl = isAr();
  const cats = rtl ? cfg.cats.slice().reverse() : cfg.cats;
  const series = cfg.series.map(s => ({ ...s, values: rtl ? s.values.slice().reverse() : s.values, colorsPer: s.colorsPer ? (rtl ? s.colorsPer.slice().reverse() : s.colorsPer) : null }));
  if (!cats.length || !series.some(s => s.values.some(v => v != null && v !== 0))) { el.innerHTML = `<div class="none">${t("noChart")}</div>`; return; }
  const padT = 10, padB = cfg.rot ? 54 : 30, axisW = 40, padS = 8;
  const L = rtl ? padS : axisW, R = rtl ? W - axisW : W - padS, T = padT, B = H - padB;
  let mx = 0;
  if (cfg.stacked) cats.forEach((_, i) => { mx = Math.max(mx, series.reduce((a, s) => a + (s.values[i] || 0), 0)); });
  else series.forEach(s => s.values.forEach(v => { if (v != null) mx = Math.max(mx, v); }));
  let stepV, top;
  if (cfg.pct) { stepV = .25; top = 1; }
  else { const raw = Math.max(mx, 1) / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; stepV = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p); top = Math.ceil(mx / stepV) * stepV || stepV; }
  const nT = Math.round(top / stepV), y = v => B - (v / top) * (B - T), bw = (R - L) / cats.length;
  const fmt = cfg.pct ? (v => Math.round(v * 100) + "%") : (v => nf0.format(v));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.title || "")}">`;
  for (let k = 0; k <= nT; k++) { const v = stepV * k, yy = y(v);
    s += `<line x1="${L}" x2="${R}" y1="${yy}" y2="${yy}" stroke="${k ? "#ECEBE6" : "#C3C2B7"}"/>`;
    s += `<text x="${rtl ? R + 6 : L - 6}" y="${yy + 4}" font-size="11" fill="#898781" text-anchor="${rtl ? "start" : "end"}">${cfg.pct ? Math.round(v * 100) + "%" : nf0.format(v)}</text>`; }
  const step = Math.ceil(cats.length / Math.max(1, Math.floor((R - L) / (cfg.rot ? 22 : 46))));
  cats.forEach((c, i) => { if (i % step) return; const cx = L + bw * (i + .5);
    s += cfg.rot ? `<text transform="translate(${cx},${B + 10}) rotate(-40)" font-size="10.5" fill="#52514E" text-anchor="end">${esc(c.label)}</text>` : `<text x="${cx}" y="${B + 18}" font-size="10.5" fill="#52514E" text-anchor="middle">${esc(c.label)}</text>`; });
  if (cfg.type === "bar") {
    const groups = cfg.stacked ? 1 : series.length, inner = bw * .72, gw = inner / groups;
    cats.forEach((c, i) => { let acc = 0;
      series.forEach((se, j) => { const v = se.values[i]; if (v == null || v === 0) return; const col = se.colorsPer ? se.colorsPer[i] : se.color;
        let x0, y0, y1;
        if (cfg.stacked) { x0 = L + bw * i + (bw - inner) / 2; y0 = y(acc + v); y1 = y(acc); acc += v; }
        else { const jj = rtl ? groups - 1 - j : j; x0 = L + bw * i + (bw - inner) / 2 + gw * jj; y0 = y(v); y1 = B; }
        const w = Math.max(2, (cfg.stacked ? inner : gw) - 2), h = Math.max(1, y1 - y0 - (cfg.stacked ? 2 : 0)), rr = Math.min(4, w / 2, h);
        s += `<path d="M${x0},${y0 + h} V${y0 + rr} Q${x0},${y0} ${x0 + rr},${y0} H${x0 + w - rr} Q${x0 + w},${y0} ${x0 + w},${y0 + rr} V${y0 + h} Z" fill="${col}"/>`; }); });
  } else {
    series.forEach(se => { let d = ""; se.values.forEach((v, i) => { if (v == null) return; d += (d ? "L" : "M") + (L + bw * (i + .5)) + "," + y(v); });
      s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round"/>`;
      se.values.forEach((v, i) => { if (v != null) s += `<circle cx="${L + bw * (i + .5)}" cy="${y(v)}" r="4" fill="${se.color}" stroke="#fff" stroke-width="2"/>`; }); });
  }
  cats.forEach((c, i) => s += `<rect class="hit" data-i="${i}" x="${L + bw * i}" y="${T}" width="${bw}" height="${B - T}" fill="transparent"/>`);
  s += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${B}" stroke="#898781" stroke-dasharray="3 3" visibility="hidden"/></svg>`;
  el.innerHTML = s;
  const cross = el.querySelector(".cross"); let last = null;
  const show = (h, e) => {
    if (last && last !== h) last.setAttribute("fill", "transparent"); last = h;
    const i = +h.dataset.i, c = cats[i];
    if (cfg.type === "line") { const cx = L + bw * (i + .5); cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible"); }
    else h.setAttribute("fill", "rgba(91,63,140,.07)");
    let html = `<b>${esc(c.full || c.label)}</b>`;
    series.forEach(se => { const v = se.values[i]; html += `<div class="r"><span><i style="background:${se.colorsPer ? se.colorsPer[i] : se.color}"></i>${esc(se.name)}</span><span>${v == null ? "–" : (se.fmt ? se.fmt(v) : fmt(v))}</span></div>`; });
    if (cfg.extra) html += cfg.extra(rtl ? cats.length - 1 - i : i);
    showTip(e.clientX, e.clientY, html);
  };
  el.querySelectorAll(".hit").forEach(h => {
    h.addEventListener("pointermove", e => show(h, e));
    h.addEventListener("pointerdown", e => show(h, e));
    h.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") { hideTip(); h.setAttribute("fill", "transparent"); cross.setAttribute("visibility", "hidden"); } });
  });
}
const legend = items => `<div class="legend">${items.map(([c, n]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join("")}</div>`;
document.addEventListener("pointerdown", e => { if (!e.target.closest || !e.target.closest(".chart")) hideTip(); });

/* =========================================================== shell: login + navigation */
const NAV = [
  ["dash", "navDash", "guest"], ["ops", "navOps", "viewer"], ["daily", "navDaily", "guest"], ["log", "navLog", "guest"], ["checks", "navChecks", "guest"], ["guide", "navGuide", "guest"],
  ["upload", "navUpload", "cap:upload"], ["users", "navUsers", "admin"], ["uploads", "navUploads", "mis"], ["settings", "navSettings", "admin"], ["audit", "navAudit", "admin"],
];
function applyLang() { document.documentElement.lang = LANG; document.documentElement.dir = isAr() ? "rtl" : "ltr"; document.title = t("appTitle"); }
function setLang(l) { LANG = l; try { localStorage.setItem("scm.lang", l); } catch { } if (S.user) api("POST", "/api/me/lang", { lang: l }).catch(() => { }); applyLang(); S.user || S.guest ? renderShell() : showLogin(); }

function showLogin(err) {
  applyLang(); S.view = "login";
  $("#root").innerHTML = `<div class="login">
    <button class="chipbtn langsw" id="lgBtn">${t("lang")}</button>
    <form class="card" id="loginForm" autocomplete="on">
      <div class="logo"><img src="/icons/icon-192.png" alt=""><div><h1>${esc(t("appTitle"))}</h1><div class="sub">${esc(t("appSub"))}</div></div></div>
      <h2 style="font-size:16px;margin:0 0 12px">${t("loginTitle")}</h2>
      <div class="field"><label for="u">${t("username")}</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      <div class="field"><label for="p">${t("password")}</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <label class="check"><input type="checkbox" id="rem"> ${t("remember")}</label>
      <div class="err" id="lerr">${esc(err || "")}</div>
      <button class="btn primary" style="width:100%" id="lbtn">${t("signIn")}</button>
      ${S.pub.guestEnabled ? `<button type="button" class="btn light" style="width:100%;margin-top:8px" id="guestBtn">${t("guestBtn")}</button>` : ""}
      <p class="note" style="text-align:center">${t("loginHint")}</p>
    </form></div>`;
  $("#lgBtn").onclick = () => setLang(isAr() ? "en" : "ar");
  $("#loginForm").onsubmit = async e => {
    e.preventDefault(); const b = $("#lbtn"); b.disabled = true; b.textContent = t("signingIn"); $("#lerr").textContent = "";
    try { const r = await api("POST", "/api/login", { username: $("#u").value.trim(), password: $("#p").value, remember: $("#rem").checked }); S.user = r.user; S.guest = false; await start(); }
    catch (er) { $("#lerr").textContent = er.message; b.disabled = false; b.textContent = t("signIn"); }
  };
  const g = $("#guestBtn"); if (g) g.onclick = async () => { S.guest = true; await start(); };
  $("#u").focus();
}

function navLinks(cls) { return NAV.filter(n => can(n[2])).map(([k, l]) => `<a href="#${k}" class="${cls || ""} ${S.view === k ? "on" : ""}" data-v="${k}">${t(l)}</a>`).join(""); }
function renderShell() {
  applyLang();
  const u = S.user;
  const who = u ? `${esc(u.displayName || u.username)}<span class="rolebadge">${t("role_" + u.role)}</span>` : `${t("role_guest")}`;
  $("#root").innerHTML = `
  <header class="top">
    <div class="brand"><img src="/icons/icon-192.png" alt=""><div><b>${esc(t("appTitle"))}</b><small id="asof"></small></div></div>
    <nav class="nav" aria-label="Main">${navLinks()}</nav>
    <div class="userbox">
      <button class="chipbtn desk" id="lgBtn">${t("lang")}</button>
      ${u ? `<button class="chipbtn desk" id="acctBtn">${who}</button><button class="chipbtn desk" id="outBtn">${t("signOut")}</button>` : `<button class="chipbtn desk" id="inBtn">${t("signInLink")}</button>`}
      <button class="burger" id="burger" aria-label="${t("menu")}">☰</button>
    </div>
  </header>
  <div class="drawer" id="drawer"><div class="panel">
    <div class="who"><b>${who}</b><div class="muted" style="font-size:12px">${u ? esc(u.username) : ""}</div></div>
    ${navLinks()}
    <div class="grp">${t("navAccount")}</div>
    ${u ? `<a href="#account" data-v="account">${t("navAccount")}</a>` : ""}
    <button class="item" id="lgBtn2">🌐 ${t("lang")}</button>
    ${u ? `<button class="item" id="outBtn2">⎋ ${t("signOut")}</button>` : `<button class="item" id="inBtn2">${t("signInLink")}</button>`}
  </div></div>
  <div class="wrap"><div id="view"></div><div class="foot">${esc(t("appTitle"))}</div></div>`;
  const dr = $("#drawer");
  $("#burger").onclick = () => dr.classList.add("open");
  dr.onclick = e => { if (e.target === dr || e.target.closest("a")) dr.classList.remove("open"); };
  [$("#lgBtn"), $("#lgBtn2")].forEach(b => b && (b.onclick = () => setLang(isAr() ? "en" : "ar")));
  [$("#outBtn"), $("#outBtn2")].forEach(b => b && (b.onclick = signOut));
  [$("#inBtn"), $("#inBtn2")].forEach(b => b && (b.onclick = () => { S.guest = false; showLogin(); }));
  const ab = $("#acctBtn"); if (ab) ab.onclick = () => go("account");
  updateAsOf();
  renderView();
}
function updateAsOf() {
  const el = $("#asof"); if (!el || !S.cfg) return; const c = S.cfg.counts;
  el.textContent = c.rows ? t("asof", { d: fmtDate(c.range.mx), n: nf0.format(c.rows) }) : t("noData");
}
async function signOut() { try { await api("POST", "/api/logout", {}); } catch { } S.user = null; S.guest = false; S.cfg = null; S.from = S.to = S.daily = null; location.hash = ""; showLogin(); }
function go(v) { if (location.hash !== "#" + v) location.hash = v; else route(); }
function route() {
  if (!S.user && !S.guest) return;
  let v = location.hash.slice(1) || "dash";
  const n = NAV.find(x => x[0] === v);
  if (v === "account" ? !S.user : (!n || !can(n[2]))) v = "dash";
  if (S.user && S.user.mustChange) v = "account";
  if (v !== S.view) S.opsView = null;
  S.view = v;
  $$(".nav a, .drawer a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
  renderView();
}
addEventListener("hashchange", route);
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.view === "dash") renderView(); }, 180); });

async function renderView() {
  const v = $("#view"); if (!v) return; hideTip();
  try {
    if (["dash", "log", "checks"].includes(S.view)) return renderPeriodView();
    if (S.view === "ops") return await renderOps();
    if (S.view === "daily") return await renderDaily();
    if (S.view === "guide") return renderGuide();
    if (S.view === "upload") return renderUpload();
    if (S.view === "uploads") return await renderUploads();
    if (S.view === "users") return await renderUsers();
    if (S.view === "settings") return renderSettings();
    if (S.view === "audit") return await renderAudit();
    if (S.view === "account") return renderAccount();
  } catch (e) { v.innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}

/* =========================================================== filters */
function whOptions(rows) {
  const set = new Set(); rows.forEach(r => { if (r.from) set.add(r.from); if (r.to) set.add(r.to); });
  const lab = c => { const w = S.whs[c.toUpperCase()]; return w ? `${c} · ${isAr() && w[1] ? w[1] : w[0]}` : c; };
  return `<option value="ALL">${t("all")}</option>` + [...set].sort().map(c => `<option value="${esc(c)}" ${S.wh === c ? "selected" : ""}>${esc(lab(c))}</option>`).join("");
}
function filtersHtml(daily) {
  const flowSel = `<label>${t("flow")}<select id="fFlow">${["ALL", "IN", "OUT"].map(x => `<option value="${x}" ${S.flow === x ? "selected" : ""}>${x === "ALL" ? t("all") : x}</option>`).join("")}</select></label>`;
  if (daily) return `<button class="btn light small ftoggle" id="ftog">⚙ ${t("filters")}</button><div class="filters" id="filters">
    <label>${t("dailyDate")}<input type="date" id="fDaily" value="${serToIso(S.daily)}"></label>${flowSel}<label>${t("wh")}<select id="fWh">${whOptions(S.dayRows)}</select></label></div>`;
  return `<button class="btn light small ftoggle" id="ftog">⚙ ${t("filters")} · ${fmtDate(S.from)} → ${fmtDate(S.to)}</button><div class="filters" id="filters">
    <label>${t("from")}<input type="date" id="fFrom" value="${serToIso(S.from)}"></label>
    <label>${t("to")}<input type="date" id="fTo" value="${serToIso(S.to)}"></label>
    <div class="quick">${[["today", "today"], ["d7", "d7"], ["d30", "d30"], ["month", "month"], ["all", "allTime"]].map(([k, l]) => `<button data-q="${k}">${t(l)}</button>`).join("")}</div>
    ${flowSel}
    <label>${t("task")}<select id="fTask"><option value="ALL">${t("all")}</option>${TASK_ORDER.map(c => `<option value="${c}" ${S.task === c ? "selected" : ""}>${c} · ${esc(tName(TASK[c]))}</option>`).join("")}</select></label>
    <label>${t("wh")}<select id="fWh">${whOptions(S.rows)}</select></label></div>`;
}
function wireFilters(daily) {
  const tg = $("#ftog"); if (tg) tg.onclick = () => $("#filters").classList.toggle("open");
  const reload = async () => { await loadRows(); renderView(); };
  $("#fFlow").onchange = e => { S.flow = e.target.value; renderView(); };
  $("#fWh").onchange = e => { S.wh = e.target.value; renderView(); };
  if (daily) { $("#fDaily").onchange = async e => { if (!e.target.value) return; S.daily = isoToSer(e.target.value); renderView(); }; return; }
  $("#fFrom").onchange = e => { if (e.target.value) { S.from = isoToSer(e.target.value); if (S.from > S.to) S.to = S.from; reload(); } };
  $("#fTo").onchange = e => { if (e.target.value) { S.to = isoToSer(e.target.value); if (S.to < S.from) S.from = S.to; reload(); } };
  $("#fTask").onchange = e => { S.task = e.target.value; renderView(); };
  $$("[data-q]").forEach(b => b.onclick = () => {
    const r = S.cfg.counts.range; const mx = r.mx != null ? r.mx : todaySerial(), mn = r.mn != null ? r.mn : mx; const k = b.dataset.q;
    if (k === "today") { S.from = S.to = mx; } if (k === "d7") { S.to = mx; S.from = mx - 6; } if (k === "d30") { S.to = mx; S.from = mx - 29; }
    if (k === "month") { const d = serToDate(mx); S.to = mx; S.from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 864e5 + 25569; }
    if (k === "all") { S.from = mn; S.to = mx; } reload();
  });
}

/* =========================================================== tiles & sections */
const ACC = { vio: "#6250D6", aqua: "#1BAF7A", blue: "#2A78D6", mag: "#D55181", yel: "#EDA100", red: "#E34948", orange: "#EB6834", teal: "#0E8A8A", grey: "#52514E" };
const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = v => Math.round(v + (255 - v) * k); return `rgb(${f(n >> 16)},${f(n >> 8 & 255)},${f(n & 255)})`; };
const dark = hex => { const n = parseInt(hex.slice(1), 16); const f = v => Math.round(v * .72); return `rgb(${f(n >> 16)},${f(n >> 8 & 255)},${f(n & 255)})`; };
const tile = (label, val, st, color) => `<div class="tile" style="background:${shade(color, .88)}"><div class="lab" style="background:${color};${color === ACC.yel ? "color:#1d1b20" : ""}">${esc(label)}</div><div class="val" style="color:${dark(color)}">${val}</div><div class="st">${st && /^[✔▲✖–]/.test(st) ? statusPill(st) : esc(st || "")}</div></div>`;
function rateStatus(v, target, noneKey) { if (v == null) return t(noneKey); const tt = Math.round(target * 100) + "%"; return v >= target ? t("onTarget", { t: tt }) : v >= S.cfg.settings.watch ? t("below", { t: tt }) : t("action", { t: tt }); }
const sec = (title, color, sub) => `<div class="sec" style="background:${color}">${esc(title)}${sub ? ` <small>· ${esc(sub)}</small>` : ""}</div>`;
function guestBanner() { return S.guest && !S.user ? `<div class="banner info">${t("guestBanner")} <a href="#" id="gSign">${t("signInLink")}</a></div>` : ""; }
function noDataBlock() { return `<div class="empty"><h2>${t("noData")}</h2><p>${t("noDataHint")}</p>${can("mis") ? `<a class="btn primary" href="#upload">${t("navUpload")}</a>` : ""}</div>`; }

/* =========================================================== dashboard / log / checks (period views) */
function renderPeriodView() {
  const v = $("#view");
  if (!S.cfg.counts.rows) { v.innerHTML = guestBanner() + noDataBlock(); wireGuest(); return; }
  const head = guestBanner() + filtersHtml(false);
  if (S.view === "dash") renderDash(v, head);
  if (S.view === "log") renderLog(v, head);
  if (S.view === "checks") renderChecks(v, head);
  wireFilters(false); wireGuest();
}
function wireGuest() { const g = $("#gSign"); if (g) g.onclick = e => { e.preventDefault(); S.guest = false; showLogin(); }; }

function renderDash(v, head) {
  const st = S.cfg.settings, rows = filtered(), m = metrics(rows);
  const mi = metrics(rows.filter(r => r.flow === "IN")), mo = metrics(rows.filter(r => r.flow === "OUT"));
  let h = head + opsBannerHtml() + sec(t("headline"), ACC.vio, t("period") + ": " + fmtDate(S.from) + " → " + fmtDate(S.to));
  h += `<div class="tiles">${tile(t("tTotal"), nf0.format(m.total), `IN ${nf0.format(mi.total)} · OUT ${nf0.format(mo.total)}`, ACC.vio)}
    ${tile(t("tComp"), pct(m.comp), rateStatus(m.comp, st.compT, "noSap"), ACC.aqua)}${tile(t("tOn"), pct(m.on), rateStatus(m.on, st.onT, "noneComp"), ACC.blue)}
    ${tile(t("tAvg"), m.avg == null ? "–" : nf1.format(m.avg), t("across", { n: nf0.format(m.done) }), ACC.mag)}
    ${tile(t("tOpen"), nf0.format(m.open), m.open ? t("inProg") : t("nothingOpen"), ACC.yel)}${tile(t("tOver"), nf0.format(m.overdue), m.overdue ? t("actNeeded") : t("noneOver"), ACC.red)}</div>`;
  h += `<div class="note"><b>${t("byFlow")}</b></div><div class="tiles">${tile(t("tInDocs"), nf0.format(mi.total), t("inLbl"), ACC.blue)}
    ${tile(t("tInComp"), pct(mi.comp), rateStatus(mi.comp, st.compT, "noSap"), ACC.blue)}${tile(t("tInOn"), pct(mi.on), rateStatus(mi.on, st.onT, "noneComp"), ACC.blue)}
    ${tile(t("tOutDocs"), nf0.format(mo.total), t("outLbl"), ACC.orange)}${tile(t("tOutComp"), pct(mo.comp), rateStatus(mo.comp, st.compT, "noSap"), ACC.orange)}
    ${tile(t("tOutOn"), pct(mo.on), rateStatus(mo.on, st.onT, "noneComp"), ACC.orange)}</div>`;
  h += sec(t("activity"), ACC.blue) + `<div class="grid2">
    <div class="card"><h3>${t("chDocs")}</h3>${legend([[ACC.aqua, t("completed")], [ACC.yel, t("open")]])}<div class="chart" id="ch1"></div></div>
    <div class="card"><h3>${t("chTrend")}</h3>${legend([[ACC.blue, "IN"], [ACC.orange, "OUT"]])}<div class="chart" id="ch2"></div></div>
    <div class="card"><h3>${t("chOn")}</h3>${legend([[ACC.blue, "IN"], [ACC.orange, "OUT"]])}<div class="chart" id="ch3"></div></div>
    <div class="card"><h3>${t("chCyc")}</h3>${legend([[ACC.vio, t("avgHrs")], ["#B4B2A9", t("slaHrs")]])}<div class="chart" id="ch4"></div></div></div>`;
  const per = TASK_ORDER.map(c => { const d = def(c), mm = metrics(rows.filter(r => r.task === c)); return { c, d, m: mm, h: health(mm, d) }; });
  h += sec(t("scorecard"), ACC.teal, t("period")) + `<div class="tblwrap"><table><thead><tr><th>${t("task")}</th><th>${t("txnCode")}</th><th>${t("taskName")}</th><th class="num">${t("docs")}</th><th class="num">${t("sapComp")}</th><th class="num">${t("onTime")}</th><th class="num">${t("avgH")}</th><th class="num">${t("slaH")}</th><th class="num">${t("openC")}</th><th class="num">${t("overC")}</th><th class="num">${t("numComp")}</th><th class="c">${t("health")}</th></tr></thead><tbody>`;
  per.forEach(({ c, d, m: mm, h: hh }) => {
    const z = x => x ? nf0.format(x) : `<span class="zero">0</span>`, na = d.sap === "N/A";
    h += `<tr class="${d.flow.toLowerCase()}"><td><span class="flow ${d.flow}">${c}</span></td><td><b style="color:${ACC.teal}">${esc(d.txn || "–")}</b></td><td>${esc(tName(d))}</td>
      <td class="num">${z(mm.total)}</td><td class="num ${!na && mm.comp != null && mm.comp < st.watch ? "bad" : ""}">${na ? t("sys_NA") : pct(mm.comp, 0)}</td>
      <td class="num ${mm.on != null && mm.on < st.watch ? "bad" : ""}">${pct(mm.on, 0)}</td><td class="num ${mm.avg != null && mm.avg > d.sla ? "bad" : ""}">${mm.avg == null ? "–" : nf1.format(mm.avg)}</td>
      <td class="num">${nf0.format(d.sla)}</td><td class="num ${mm.open ? "amb" : ""}">${z(mm.open)}</td><td class="num ${mm.overdue ? "bad" : ""}">${z(mm.overdue)}</td>
      <td class="num ${mm.num != null && mm.num < 1 ? "amb" : ""}">${pct(mm.num, 0)}</td><td class="c">${hPill(hh)}</td></tr>`;
  });
  h += `</tbody></table></div>` + sec(t("flowKpis"), ACC.mag, t("flowSub"));
  const q = code => rows.filter(r => r.task === code).reduce((a, r) => a + (r.qty || 0), 0);
  h += `<div class="tblwrap"><table><thead><tr><th>#</th><th>${t("flow")}</th><th>${t("kpi")}</th><th class="num">${t("actual")}</th><th class="num">${t("target")}</th><th class="c">${t("rule")}</th><th class="c">${t("status")}</th><th>${t("meaning")}</th></tr></thead><tbody>`;
  S.cfg.defs.flowKpis.forEach((f, i) => {
    const den = q(f.den), num = q(f.num), act = den ? num / den : null, tg = st.flowT[i] != null ? st.flowT[i] : f.target;
    const s = act == null ? t("fNo") : f.dir === "≥" ? (act >= tg ? t("fOk") : t("fBelow")) : f.dir === "≤" ? (act <= tg ? t("fOk") : t("fAbove")) : (Math.abs(act - tg) <= .005 ? t("fOk") : t("fMis"));
    h += `<tr class="${f.flow.toLowerCase()}"><td>${i + 1}</td><td><span class="flow ${f.flow}">${f.flow}</span></td><td>${esc(isAr() ? f.ar : f.en)} <span class="muted ltr">(${f.num} ÷ ${f.den})</span></td>
      <td class="num">${pct(act)}</td><td class="num">${pct(tg)}</td><td class="c">${f.dir}</td><td class="c">${statusPill(s)}</td><td class="muted">${esc(isAr() ? f.meanAr : f.meanEn)}</td></tr>`;
  });
  h += `</tbody></table></div><div class="note">${t("howRead")}</div>`;
  v.innerHTML = h;
  const cats = TASK_ORDER.map(c => ({ label: c, full: c + " · " + tName(TASK[c]) }));
  drawChart($("#ch1"), { type: "bar", stacked: true, cats, rot: true, series: [{ name: t("completed"), color: ACC.aqua, values: per.map(p => p.m.done) }, { name: t("open"), color: ACC.yel, values: per.map(p => p.m.open) }] });
  const days = Math.round(S.to - S.from) + 1, weekly = days > 62, buckets = [];
  if (weekly) { for (let d = S.from; d <= S.to; d += 7) buckets.push([d, Math.min(d + 6, S.to)]); } else for (let d = S.from; d <= S.to; d++) buckets.push([d, d]);
  const tc = buckets.map(([a, b]) => ({ label: fmtDM(a), full: a === b ? fmtDate(a) : fmtDate(a) + " → " + fmtDate(b) }));
  const cnt = fl => buckets.map(([a, b]) => rows.filter(r => r.flow === fl && r.date >= a && r.date <= b).length);
  drawChart($("#ch2"), { type: "line", cats: tc, rot: tc.length > 14, series: [{ name: "IN", color: ACC.blue, values: cnt("IN") }, { name: "OUT", color: ACC.orange, values: cnt("OUT") }] });
  drawChart($("#ch3"), { type: "bar", pct: true, cats, rot: true, series: [{ name: t("onPct"), values: per.map(p => p.m.on), colorsPer: per.map(p => p.d.flow === "IN" ? ACC.blue : ACC.orange), fmt: x => pct(x) }],
    extra: i => `<div class="r"><span>${t("completed")}</span><span>${per[i].m.done}</span></div>` });
  drawChart($("#ch4"), { type: "bar", cats, rot: true, series: [{ name: t("avgHrs"), color: ACC.vio, values: per.map(p => p.m.avg), fmt: x => nf1.format(x) }, { name: t("slaHrs"), color: "#B4B2A9", values: per.map(p => p.m.done ? p.d.sla : null) }] });
}

/* ---------- document table */
const stLabel = s => !s ? "" : s.startsWith("other:") ? s.slice(6) : t("st_" + s);
const COLS = [
  ["task", "cTaskCode", r => `<span class="flow ${r.flow}">${esc(r.task)}</span>`, r => r.task],
  ["txn", "cTxn", r => `<b style="color:${ACC.teal}">${esc(r.txn)}</b>`, r => r.txn],
  ["docno", "cDocNo", r => `<span class="ltr">${esc(r.docno)}</span>`, r => r.docno],
  ["num", "cNum", r => r.numOK == null ? "" : `<span class="pill ${r.numOK ? "p-good" : "p-crit"}">${r.numOK ? t("yes") : t("no")}</span>`, r => r.numOK == null ? "" : (r.numOK ? t("yes") : t("no"))],
  ["date", "cDate", r => fmtDate(r.date), r => fmtDate(r.date), r => (r.date ?? 0) + (r.time ?? 0)],
  ["time", "cTime", r => fmtTime(r.time), r => fmtTime(r.time)],
  ["ref", "cRef", r => esc(r.ref), r => r.ref], ["from", "cFrom", r => esc(r.from), r => r.from], ["to", "cTo", r => esc(r.to), r => r.to],
  ["item", "cItem", r => esc(r.item), r => r.item], ["desc", "cDesc", r => esc(r.desc), r => r.desc, null, false, "wrapc"],
  ["uom", "cUom", r => esc(r.uom), r => r.uom], ["batch", "cBatch", r => esc(r.batch), r => r.batch],
  ["qty", "cQty", r => nfq.format(r.qty), r => r.qty, r => r.qty, true],
  ["status", "cStatus", r => esc(stLabel(r.status)), r => stLabel(r.status)],
  ["sys", "cSys", r => r.sys ? `<span class="${r.sys === "N" ? "pill p-crit" : ""}">${t("sys_" + r.sys)}</span>` : "", r => r.sys ? t("sys_" + r.sys) : ""],
  ["sysdoc", "cSysDoc", r => esc(r.sysdoc), r => r.sysdoc],
  ["cdate", "cCDate", r => fmtDate(r.cdate), r => fmtDate(r.cdate), r => (r.cdate ?? 0) + (r.ctime ?? 0)],
  ["ctime", "cCTime", r => r.cdate != null ? fmtTime(r.ctime) : "", r => r.cdate != null ? fmtTime(r.ctime) : ""],
  ["el", "cEl", r => r.el == null ? "" : nf1.format(r.el), r => r.el ?? "", r => r.el ?? -1, true],
  ["res", "cSla", r => r.res ? `<span class="pill ${{ ontime: "p-good", late: "p-crit", overdue: "p-crit", open: "p-warn" }[r.res]}">${t("r_" + r.res)}</span>` : "", r => r.res ? t("r_" + r.res) : ""],
  ["form", "cForm", r => r.forms ? `<button class="pill p-good formbtn" data-ft="${esc(r.task)}" data-fd="${esc(r.docno)}">✔ ${r.forms}</button>` : r.done ? `<span class="pill p-crit">✖ ${t("no")}</span>` : "", r => r.forms ? r.forms : (r.done ? t("no") : "")],
  ["remarks", "cRem", r => esc(r.remarks), r => r.remarks]
];
// click on a ✔ in the Form column → list that document's signed forms
document.addEventListener("click", async e => {
  const b = e.target.closest && e.target.closest(".formbtn"); if (!b) return;
  try { const { forms } = await api("GET", `/api/doc-forms?task=${encodeURIComponent(b.dataset.ft)}&docno=${encodeURIComponent(b.dataset.fd)}`);
    await modal(`${t("tfTitle")} · ${b.dataset.ft} ${b.dataset.fd}`, forms.map(x => `<p><a class="btn light small" href="/api/doc-forms/${x.id}/file">⬇ ${esc(x.file_name)}</a> <span class="muted">${x.signed_by ? "✍ " + esc(x.signed_by) + " · " : ""}${esc(x.uploaded_by || "")} · ${esc(tsDate(x.uploaded_at))}</span></p>`).join("") || `<p>${t("sdNone")}</p>`, [{ label: t("close"), cls: "primary", value: true }]);
  } catch (er) { toast(er.message); }
});
function docTable(rows, id, o = {}) {
  const page = o.page || 0, size = o.size || 0, shown = size ? rows.slice(page * size, page * size + size) : rows;
  const exp = o.exportCsv && can("viewer") && S.user ? `<a class="btn light small" href="/api/export.csv?from=${S.from}&to=${S.to}">⬇ ${t("exportCsv")}</a>` : "";
  let h = `<div class="toolbar">${o.tools || ""}<span class="muted">${t("rows", { n: nf0.format(rows.length) })}</span><button class="btn light small" id="copy-${id}">⧉ ${t("copy")}</button>${exp}</div>`;
  h += `<div class="tblwrap docs"><table id="tbl-${id}"><thead><tr>${COLS.map(c => `<th class="${o.sortable ? "sort" : ""} ${c[5] ? "num" : ""}" data-k="${c[0]}">${t(c[1])}${o.sortable && S.log.sort === c[0] ? (S.log.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>`;
  h += shown.map(r => `<tr class="${r.flow === "IN" ? "in" : r.flow === "OUT" ? "out" : ""}">${COLS.map(c => `<td class="${c[5] ? "num" : ""} ${c[6] || ""}">${c[2](r)}</td>`).join("")}</tr>`).join("") + `</tbody></table></div>`;
  if (size && rows.length > size) { const n = Math.ceil(rows.length / size); h += `<div class="pager"><button class="btn light small" id="pg-prev" ${page ? "" : "disabled"}>${t("prev")}</button><span>${t("page", { p: page + 1, n })}</span><button class="btn light small" id="pg-next" ${page + 1 < n ? "" : "disabled"}>${t("next")}</button></div>`; }
  return h;
}
function wireCopy(id, rows) {
  const b = $("#copy-" + id); if (!b) return;
  b.onclick = async () => {
    const tsv = [COLS.map(c => t(c[1])).join("\t")].concat(rows.map(r => COLS.map(c => String(c[3](r) ?? "").replace(/\t|\n/g, " ")).join("\t"))).join("\n");
    try { await navigator.clipboard.writeText(tsv); toast(t("copied")); }
    catch { try { const ta = document.createElement("textarea"); ta.value = tsv; document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); toast(ok ? t("copied") : t("copyFail")); } catch { toast(t("copyFail")); } }
  };
}
function renderLog(v, head) {
  const q = XLSXR.norm(S.log.q); let rows = filtered();
  if (q) rows = rows.filter(r => [r.task, r.txn, r.docno, r.ref, r.from, r.to, r.item, r.desc, r.batch, r.sysdoc, r.remarks, stLabel(r.status)].some(x => XLSXR.norm(x).includes(q)));
  const col = COLS.find(c => c[0] === S.log.sort) || COLS[4], key = col[4] || col[3];
  rows.sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * S.log.dir; });
  const size = 100, n = Math.ceil(rows.length / size); if (S.log.page >= n) S.log.page = Math.max(0, n - 1);
  v.innerHTML = head + sec(t("navLog"), ACC.vio, t("period") + ": " + fmtDate(S.from) + " → " + fmtDate(S.to)) +
    docTable(rows, "log", { sortable: true, page: S.log.page, size, exportCsv: true, tools: `<input type="search" id="q" placeholder="${t("search")}" value="${esc(S.log.q)}">` });
  wireCopy("log", rows);
  $("#q").oninput = e => { S.log.q = e.target.value; S.log.page = 0; const pos = e.target.selectionStart; renderView(); const n2 = $("#q"); n2.focus(); n2.setSelectionRange(pos, pos); };
  $$("#tbl-log th.sort").forEach(th => th.onclick = () => { const k = th.dataset.k; if (S.log.sort === k) S.log.dir *= -1; else { S.log.sort = k; S.log.dir = 1; } renderView(); });
  const p = $("#pg-prev"), nx = $("#pg-next"); if (p) p.onclick = () => { S.log.page--; renderView(); }; if (nx) nx.onclick = () => { S.log.page++; renderView(); };
}
function renderChecks(v, head) {
  const rows = filtered(), hasIM = Object.keys(S.items).length > 0, hasWH = Object.keys(S.whs).length > 0;
  const C = [["notPosted", "chkNotPosted", r => r.sys === "N"], ["overdue", "chkOverdue", r => r.res === "overdue"], ["num", "chkNum", r => r.numOK === false],
    ["batch", "chkBatch", r => !r.batch && r.def && r.def.sap !== "N/A"], ["item", "chkItem", r => hasIM && r.item && !S.items[r.item.toUpperCase()], !hasIM],
    ["wh", "chkWh", r => hasWH && ((r.from && !S.whs[r.from.toUpperCase()]) || (r.to && !S.whs[r.to.toUpperCase()])), !hasWH],
    ["task", "chkTask", r => !r.def], ["dates", "chkDates", r => r.cdate != null && r.date != null && r.cdate + r.ctime < r.date + r.time], ["form", "chkForm", r => r.done && !r.forms]];
  const res = C.map(c => ({ c, list: rows.filter(c[2]) }));
  let h = head + sec(t("navChecks"), ACC.red, t("period") + ": " + fmtDate(S.from) + " → " + fmtDate(S.to)) + `<div class="note">${t("chkHint")}</div><div class="checks">` +
    res.map(({ c, list }) => `<div class="chk ${c[3] ? "" : list.length ? "bad" : "okk"} ${S.check === c[0] ? "on" : ""}" data-c="${c[0]}" tabindex="0" role="button"><div class="n">${c[3] ? "–" : nf0.format(list.length)}</div><div>${t(c[1])}</div>${c[3] ? `<div class="muted" style="font-size:11px">${t("chkNoMaster")}</div>` : ""}</div>`).join("") + `</div>`;
  const cur = res.find(x => x.c[0] === S.check) || res[0];
  h += sec(t(cur.c[1]), ACC.grey) + docTable(cur.list, "chk");
  v.innerHTML = h; wireCopy("chk", cur.list);
  $$(".chk").forEach(b => { const fn = () => { S.check = b.dataset.c; renderView(); }; b.onclick = fn; b.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } }; });
}

/* =========================================================== daily report */
async function renderDaily() {
  const v = $("#view");
  if (!S.cfg.counts.rows) { v.innerHTML = guestBanner() + noDataBlock(); wireGuest(); return; }
  await loadDay();
  const day = S.daily, base = S.dayRows.filter(r => (S.flow === "ALL" || r.flow === S.flow) && (S.wh === "ALL" || r.from === S.wh || r.to === S.wh));
  const rows = base.filter(r => r.date === day), m = metrics(rows), bl = base.filter(r => !r.done && r.date != null && r.date <= day);
  let h = guestBanner() + filtersHtml(true) + sec(t("dayGlance"), ACC.vio, fmtDate(day));
  h += `<div class="tiles">${tile(t("dDocs"), nf0.format(m.total), "", ACC.vio)}
    ${tile(t("dPosted"), nf0.format(m.y), m.y + m.n === 0 ? t("noSap") : (m.n === 0 ? t("allPosted") : t("notPostedN", { n: m.n })), ACC.aqua)}
    ${tile(t("dNotPosted"), nf0.format(m.n), m.n ? t("follow") : t("noneNP"), ACC.red)}
    ${tile(t("dComp"), nf0.format(m.done), m.total ? t("ofToday", { p: pct(m.done / m.total, 0) }) : t("noAct"), ACC.blue)}
    ${tile(t("dLate"), nf0.format(m.late), m.late ? t("actNeeded") : t("allSla"), ACC.mag)}
    ${tile(t("dBacklog"), nf0.format(bl.length), bl.length ? t("pending") : t("clearB"), ACC.yel)}</div>`;
  h += sec(t("sumByTask"), ACC.vio) + `<div class="tblwrap"><table><thead><tr><th>${t("task")}</th><th>${t("flow")}</th><th>${t("taskName")}</th><th>${t("txnCode")}</th><th class="num">${t("docsToday")}</th><th class="num">${t("postedY")}</th><th class="num">${t("notPostedN2")}</th><th class="num">${t("totalQty")}</th><th class="num">${t("completed")}</th><th class="num">${t("onTimeC")}</th><th class="num">${t("lateC")}</th><th class="num">${t("avgEl")}</th><th class="num">${t("backlog")}</th></tr></thead><tbody>`;
  const tot = { d: 0, y: 0, n: 0, c: 0, o: 0, l: 0, b: 0 };
  TASK_ORDER.forEach(c => {
    const d = def(c), rr = rows.filter(r => r.task === c), mm = metrics(rr), b = bl.filter(r => r.task === c).length;
    const el = rr.filter(r => r.el != null), avg = el.length ? el.reduce((a, r) => a + r.el, 0) / el.length : null;
    tot.d += mm.total; tot.y += mm.y; tot.n += mm.n; tot.c += mm.done; tot.o += mm.ontime; tot.l += mm.late; tot.b += b;
    const z = x => x ? nf0.format(x) : `<span class="zero">0</span>`;
    h += `<tr class="${d.flow.toLowerCase()}"><td><b>${c}</b></td><td><span class="flow ${d.flow}">${d.flow}</span></td><td>${esc(tName(d))}</td><td><b style="color:${ACC.teal}">${esc(d.txn || "–")}</b></td>
      <td class="num">${z(mm.total)}</td><td class="num">${z(mm.y)}</td><td class="num ${mm.n ? "bad" : ""}">${z(mm.n)}</td><td class="num">${mm.qty ? nfq.format(mm.qty) : '<span class="zero">0</span>'}</td>
      <td class="num">${z(mm.done)}</td><td class="num">${z(mm.ontime)}</td><td class="num ${mm.late ? "bad" : ""}">${z(mm.late)}</td><td class="num">${avg == null ? "–" : nf1.format(avg)}</td><td class="num ${b ? "amb" : ""}">${z(b)}</td></tr>`;
  });
  h += `<tr><td colspan="4"><b>${t("total")}</b></td><td class="num"><b>${tot.d}</b></td><td class="num"><b>${tot.y}</b></td><td class="num"><b>${tot.n}</b></td><td class="num muted">${t("mixed")}</td><td class="num"><b>${tot.c}</b></td><td class="num"><b>${tot.o}</b></td><td class="num"><b>${tot.l}</b></td><td></td><td class="num"><b>${tot.b}</b></td></tr></tbody></table></div>`;
  rows.sort((a, b) => TASK_ORDER.indexOf(a.task) - TASK_ORDER.indexOf(b.task) || a.time - b.time);
  h += sec(t("detail"), ACC.vio, fmtDate(day) + " · " + t("rows", { n: rows.length })) + docTable(rows, "daily");
  v.innerHTML = h; wireCopy("daily", rows); wireFilters(true); wireGuest();
}

/* =========================================================== KPI guide */
function renderGuide() {
  const A = isAr(), D = S.cfg.defs, sep = S.cfg.settings.sep;
  let h = guestBanner() + sec(t("guideTx"), ACC.teal, t("guideTxSub")) + `<div class="tblwrap"><table><thead><tr><th>${t("flow")}</th><th>#</th><th>${t("txnCode")}</th><th>${t("arName")}</th><th>${t("enName")}</th><th>${t("gLinked")}</th><th>${t("example")}</th></tr></thead><tbody>`;
  D.txn.forEach(x => { const d = x.task ? def(x.task) : null; h += `<tr class="${x.flow.toLowerCase()}"><td><span class="flow ${x.flow}">${x.flow}</span></td><td>${x.no}</td><td><b style="color:${ACC.teal}">${esc(x.code)}</b></td><td dir="rtl">${esc(x.ar)}</td><td dir="ltr">${esc(x.en)}</td><td>${x.task ? `<b>${x.task}</b> · ${esc(tName(d))}` : `<span class="muted">${t("gNotFlow")}</span>`}</td><td><span class="ltr muted">${esc(x.code + sep + (d && d.numWH === "to" ? "<To WH>" : "<From WH>") + sep + "00001")}</span></td></tr>`; });
  h += `</tbody></table></div>`;
  const cat = rows => `<div class="tblwrap"><table><thead><tr><th>${t("task")}</th><th>${t("kpi")}</th><th>${t("gDef")}</th><th>${t("gTarget")}</th><th>${t("gFreq")}</th><th>${t("gOwner")}</th></tr></thead><tbody>` +
    rows.map(r => `<tr class="${TASK[r.code] ? TASK[r.code].flow.toLowerCase() : ""}"><td><b>${esc(r.code === "ALL" ? t("all") : r.code)}</b><div class="muted">${esc(A ? r.taskAr : r.taskEn)}</div></td><td><b>${esc(A ? r.kpiAr : r.kpiEn)}</b></td><td>${esc(A ? r.defAr : r.defEn)}</td><td>${esc(A ? r.targetAr : r.targetEn)}</td><td>${esc(A ? r.freqAr : r.freqEn)}</td><td>${esc(A ? r.ownerAr : r.ownerEn)}</td></tr>`).join("") + `</tbody></table></div>`;
  h += sec(t("guideGen"), ACC.vio) + cat(D.catalog.generic) + sec(t("guideSpec"), ACC.blue) + cat(D.catalog.specific);
  $("#view").innerHTML = h; wireGuest();
}

/* =========================================================== upload (MIS + admin) */
function renderUpload() {
  const v = $("#view");
  const excel = can("mis");
  let h = `<div class="pagehead"><h1>${t(excel ? "upTitle" : "sdTitle")}</h1></div>`;
  if (excel) h += `<p class="note">${t("upSub")}</p>
    <div class="card" style="margin-bottom:12px"><b>${t("upTemplates")}:</b>
      <a class="btn light small" href="/templates/SCM_IN-OUT_Template_English.xlsx">⬇ ${t("tplEn")}</a>
      <a class="btn light small" href="/templates/SCM_IN-OUT_Template_Arabic.xlsx">⬇ ${t("tplAr")}</a></div>
    <label class="dropzone" id="dz" for="upf"><b>⬆ ${t("upDrop")}</b><span class="ltr">.xlsx · .csv</span></label>
    <input type="file" id="upf" multiple accept=".xlsx,.xlsm,.csv" class="hide">
    <div id="pend"></div>`;
  if (can("cap:docs")) h += `<div id="tforms" style="margin-top:18px"></div><div id="sdocs" style="margin-top:18px"></div>`;
  v.innerHTML = h;
  if (can("cap:docs")) { renderShiftDocs(); renderTxnForms(); }
  if (!excel) return;
  const dz = $("#dz");
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", e => addFiles([...(e.dataTransfer?.files || [])]));
  $("#upf").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
  renderPending();
}
async function addFiles(files) {
  const codes = new Set(TASK_ORDER);
  for (const f of files) {
    const p = { file: f, state: "reading" }; S.pending.unshift(p); renderPending();
    try { p.x = await XLSXR.extractFile(f, codes); p.state = p.x.error ? "error" : (p.x.rows.length || p.x.masters.items.length || p.x.masters.whs.length || p.x.masters.taskMaster.length ? "ready" : "empty"); }
    catch (e) { p.state = "error"; p.err = e.message; }
    renderPending();
  }
}
function renderPending() {
  const box = $("#pend"); if (!box) return;
  box.innerHTML = S.pending.map((p, i) => {
    const x = p.x || {}; const ms = x.masters || { items: [], whs: [], taskMaster: [] };
    const dates = (x.rows || []).map(r => r.date).filter(d => d != null);
    const mastersTxt = [ms.items.length ? nf0.format(ms.items.length) + " " + t("items") : "", ms.whs.length ? ms.whs.length + " " + t("whs") : "", ms.taskMaster.length ? t("tmNote") : ""].filter(Boolean).join(", ") || "–";
    let body = "";
    if (p.state === "reading") body = `<p class="muted">${t("loading")}</p>`;
    else if (p.state === "error") body = `<p class="err">${esc(x.error === "xls" ? t("upXls") : (p.err || x.error))}</p>`;
    else {
      body = `<div class="kv"><div>${t("upRowsFound")}<b>${nf0.format(x.rows.length)}</b></div><div>${t("upRange")}<b>${dates.length ? fmtDate(Math.min(...dates)) + " → " + fmtDate(Math.max(...dates)) : "–"}</b></div>
        <div>${t("upSample")}<b>${x.sample}</b></div><div>${t("upSkipped")}<b>${x.skipped}</b></div><div>${t("upUnknown")}<b class="${x.unknownTask ? "err" : ""}">${x.unknownTask}</b></div><div>${t("upMasters")}<b style="font-size:13px">${esc(mastersTxt)}</b></div></div>`;
      if (p.state === "empty") body += `<p class="err">${t("upNoTx")}</p>`;
      if (p.result) { const r = p.result;
        body += `<div class="banner info"><b>${t("upDoneT")}:</b> ${t("upDone", { i: r.inserted, u: r.updated, n: r.unchanged, r: r.rejected })}${r.masters && r.masters.taskMasterIgnored ? `<br>${t("upTmIgnored")}` : ""}
        ${r.rejectedSample && r.rejectedSample.length ? `<div class="note">${t("upRejected")}<br>${r.rejectedSample.map(esc).join("<br>")}</div>` : ""}</div>`;
        if (r.docCheck) body += docCheckHtml(r.docCheck); }
      if (p.err) body += `<p class="err">${esc(p.err)}</p>`;
    }
    const btn = p.state === "ready" && !p.result ? `<button class="btn primary" data-up="${i}">${p.busy ? t("upSending") : "⬆ " + t("upSend")}</button>` : "";
    return `<div class="filecard ${p.result ? "ok" : (p.state === "error" ? "bad" : "")}"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center"><b>📄 ${esc(p.file.name)}</b><span style="display:flex;gap:6px">${btn}<button class="btn light small" data-rm="${i}">${t("upRemove")}</button></span></div>${body}</div>`;
  }).join("");
  $$("[data-rm]").forEach(b => b.onclick = () => { S.pending.splice(+b.dataset.rm, 1); renderPending(); });
  $$("[data-up]").forEach(b => b.onclick = () => sendUpload(S.pending[+b.dataset.up], b));
  $$("#toSd").forEach(a => a.onclick = e => { e.preventDefault(); const s = $("#tforms") || $("#sdocs"); if (s) s.scrollIntoView({ behavior: "smooth" }); });
}
async function sendUpload(p, btn) {
  if (p.busy) return; p.busy = true; btn.disabled = true; btn.textContent = t("upSending");
  try {
    const ab = await p.file.arrayBuffer();
    p.result = await api("POST", "/api/uploads", { fileName: p.file.name, fileB64: XLSXR.toBase64(ab), rows: p.x.rows, sample: p.x.sample, masters: p.x.masters });
    p.err = null; toast(t("upDoneT"));
    await loadConfig(); await loadMasters(); await loadRows(); updateAsOf();
  } catch (e) { p.err = e.message; }
  p.busy = false; renderPending();
  if (p.result && $("#sdocs")) { renderShiftDocs(); renderTxnForms(); }
}

/* ---- shift documents: signed forms, WIF documents, SAP Business One layouts */
const DOC_TYPES = ["wif", "sap_layout", "handover_form", "other_form"];
const REQ_DOCS = ["wif", "sap_layout", "handover_form"];
const fmtSize = n => n >= 1048576 ? nf1.format(n / 1048576) + " MB" : nf0.format(Math.max(1, Math.round(n / 1024))) + " KB";
function docCheckHtml(dc) {
  const ok = !dc.missing.length && !dc.formsMissing;
  return `<div class="banner ${ok ? "info" : ""}" style="margin-top:8px"><b>${esc(t("sdCheckT", { c: dc.code, d: fmtDate(dc.opDate) }))}</b><br>
    ${REQ_DOCS.map(k => `${dc.counts[k] ? "✔" : "✖"} ${t("dt_" + k)}${dc.counts[k] ? ` (${dc.counts[k]})` : ""}`).join(" · ")}
    ${dc.formsMissing ? `<br>✖ ${esc(t("tfMissingInFile", { n: dc.formsMissing }))}: <span class="ltr">${dc.formsMissingSample.map(esc).join(", ")}${dc.formsMissing > dc.formsMissingSample.length ? " …" : ""}</span>` : (dc.formsMissing === 0 ? `<br>✔ ${t("tfAllInFile")}` : "")}
    ${ok ? "" : `<br>${dc.missing.length ? t("sdMissingHint") : ""}${can("cap:docs") ? ` <a href="#" id="toSd">${t("sdAttachNow")} ↓</a>` : ""}`}</div>`;
}

/* ---- transaction forms: one or more signed forms per document (task + document no.) */
const normDoc = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function renderTxnForms() {
  const box = $("#tforms"); if (!box) return;
  let d; try { d = await api("GET", "/api/doc-forms/docs?days=60"); } catch (e) { box.innerHTML = `<div class="banner">${esc(e.message)}</div>`; return; }
  S.tfDocs = d.docs;
  const missing = d.docs.filter(x => x.done && !x.forms);
  const opts = sel => `<option value="">– ${t("tfPickDoc")} –</option>` +
    `<optgroup label="${esc(t("tfMissingGrp"))}">${missing.map(x => `<option value="${esc(x.task + "|" + x.docno)}" ${sel === x.task + "|" + x.docno ? "selected" : ""}>${esc(x.task)} · ${esc(x.docno)} · ${fmtDate(x.date)}</option>`).join("")}</optgroup>` +
    `<optgroup label="${esc(t("tfOtherGrp"))}">${d.docs.filter(x => !(x.done && !x.forms)).map(x => `<option value="${esc(x.task + "|" + x.docno)}" ${sel === x.task + "|" + x.docno ? "selected" : ""}>${esc(x.task)} · ${esc(x.docno)} · ${fmtDate(x.date)}${x.forms ? " · ✔" + x.forms : (x.done ? "" : " · " + t("r_open"))}</option>`).join("")}</optgroup>`;
  S.tfPend = S.tfPend || [];
  let h = sec(t("tfTitle"), ACC.vio) + `<p class="note">${t("tfSub")}</p>
    <div class="card" style="margin-bottom:12px;display:flex;gap:12px 24px;flex-wrap:wrap;align-items:center">
      <div><div class="muted" style="font-size:12px">${t("tfMissingGrp")}</div><b style="font-size:22px;color:${missing.length ? ACC.red : ACC.aqua}">${nf0.format(missing.length)}</b></div>
      <div class="muted">${missing.length ? t("tfMissingHint") : "✔ " + t("tfAllDone")}</div></div>
    <label class="dropzone" id="tfDz" for="tfIn"><b>⬆ ${t("tfDrop")}</b><span>${t("tfDropHint")}</span></label>
    <input type="file" id="tfIn" multiple class="hide" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xlsm,.xls,.docx,.doc,.csv,image/*">`;
  if (S.tfPend.length) h += `<div class="tblwrap" style="margin:10px 0"><table><thead><tr><th>${t("upFile")}</th><th>${t("tfDoc")}</th><th>${t("sdSignedBy")}</th><th></th></tr></thead><tbody>` +
    S.tfPend.map((p, i) => `<tr><td>${esc(p.file.name)} <span class="muted">${fmtSize(p.file.size)}</span></td>
      <td>${p.done ? `<b>${esc(p.doc.replace("|", " · "))}</b>` : `<select class="inp sm" data-tfdoc="${i}" style="max-width:340px">${opts(p.doc)}</select>${p.auto ? ` <span class="pill p-good">${t("tfAuto")}</span>` : ""}`}</td>
      <td>${p.done ? esc(p.signedBy) : `<input class="inp sm" data-tfsig="${i}" value="${esc(p.signedBy || "")}" placeholder="${t("sdSignedPh")}">`}</td>
      <td>${p.done ? `<span class="pill p-good">✔ ${t("saved")}</span>` : p.err ? `<span class="err">${esc(p.err)}</span> ` : ""}${p.done ? "" : `<button class="btn light small" data-tfrm="${i}">${t("upRemove")}</button>`}</td></tr>`).join("") +
    `</tbody></table></div><div class="toolbar"><button class="btn primary" id="tfGo">⬆ ${t("tfUploadAll")}</button><button class="btn light small" id="tfClear">${t("tfClear")}</button><span class="err" id="tfErr"></span></div>`;
  h += sec(t("tfMissingGrp"), ACC.red) + (missing.length ? `<div class="tblwrap docs"><table><thead><tr><th>${t("task")}</th><th>${t("docNo")}</th><th>${t("cDate")}</th><th>${t("tfDoneAt")}</th><th class="num">${t("tfLines")}</th><th></th></tr></thead><tbody>` +
    missing.slice(0, 300).map(x => `<tr><td><span class="flow ${TASK[x.task] ? TASK[x.task].flow : ""}">${esc(x.task)}</span></td><td><span class="ltr">${esc(x.docno)}</span></td><td>${fmtDate(x.date)}</td><td>${fmtDate(x.done_at)} ${fmtTime(x.done_at)}</td><td class="num">${x.lines}</td>
      <td><button class="btn light small" data-tfone="${esc(x.task + "|" + x.docno)}">📎 ${t("tfAttach")}</button></td></tr>`).join("") + `</tbody></table></div>` : `<p class="note">✔ ${t("tfAllDone")}</p>`);
  h += `<input type="file" id="tfOne" class="hide" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xlsm,.xls,.docx,.doc,.csv,image/*">`;
  box.innerHTML = h;

  // match a file name to a document number: the longest document number contained in the name, if only one has that length
  const match = name => {
    const n = normDoc(name.replace(/\.[^.]+$/, "")); let best = [], len = 0;
    for (const x of S.tfDocs) { const k = normDoc(x.docno); if (k.length < 3 || !n.includes(k)) continue;
      if (k.length > len) { best = [x]; len = k.length; } else if (k.length === len) best.push(x); }
    if (best.length > 1) { const m = best.filter(x => x.done && !x.forms); if (m.length === 1) best = m; }
    return best.length === 1 ? best[0].task + "|" + best[0].docno : "";
  };
  const add = files => { for (const f of files) { const doc = match(f.name); S.tfPend.push({ file: f, doc, auto: !!doc, signedBy: "" }); } renderTxnForms(); };
  const dz = $("#tfDz");
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", e => add([...(e.dataTransfer?.files || [])]));
  $("#tfIn").onchange = e => { add([...e.target.files]); e.target.value = ""; };
  $$("[data-tfdoc]").forEach(s => s.onchange = () => { const p = S.tfPend[+s.dataset.tfdoc]; p.doc = s.value; p.auto = false; });
  $$("[data-tfsig]").forEach(s => s.oninput = () => { S.tfPend[+s.dataset.tfsig].signedBy = s.value; });
  $$("[data-tfrm]").forEach(b => b.onclick = () => { S.tfPend.splice(+b.dataset.tfrm, 1); renderTxnForms(); });
  const send = async p => {
    const [task, ...rest] = p.doc.split("|"); const ab = await p.file.arrayBuffer();
    await api("POST", "/api/doc-forms", { task, docno: rest.join("|"), signedBy: p.signedBy, fileName: p.file.name, fileB64: XLSXR.toBase64(ab) });
  };
  const clr = $("#tfClear"); if (clr) clr.onclick = () => { S.tfPend = []; renderTxnForms(); };
  const go = $("#tfGo"); if (go) go.onclick = async () => {
    const todo = S.tfPend.filter(p => !p.done);
    if (todo.some(p => !p.doc)) { $("#tfErr").textContent = t("tfNeedDoc"); return; }
    go.disabled = true; go.textContent = t("upSending");
    for (const p of todo) { try { await send(p); p.done = true; p.err = null; } catch (e) { p.err = e.message; } }
    toast(t("saved")); await loadRows(); renderTxnForms();
  };
  let one = null;
  $$("[data-tfone]").forEach(b => b.onclick = () => { one = b.dataset.tfone; $("#tfOne").click(); });
  $("#tfOne").onchange = async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f || !one) return;
    const signedBy = await modal(t("tfAttach") + " · " + one.replace("|", " · "), `<p>${esc(f.name)}</p><div class="field"><label>${t("sdSignedBy")}</label><input class="inp" id="tfs" placeholder="${t("sdSignedPh")}"></div>`,
      [{ label: t("cancel"), value: null }, { label: "⬆ " + t("sdUpload"), cls: "primary", value: m => m.querySelector("#tfs").value || "" }]);
    if (signedBy == null) return;
    try { await send({ file: f, doc: one, signedBy }); toast(t("saved")); await loadRows(); renderTxnForms(); } catch (er) { toast(er.message); }
  };
}
async function renderShiftDocs(sel) {
  const box = $("#sdocs"); if (!box) return;
  S.sdSel = sel || S.sdSel || null;
  const q = S.sdSel ? `?opDate=${S.sdSel.opDate}&code=${encodeURIComponent(S.sdSel.code)}` : "";
  let d; try { d = await api("GET", "/api/shift-docs" + q); } catch (e) { box.innerHTML = `<div class="banner">${esc(e.message)}</div>`; return; }
  const slot = d.slot, closed = d.shiftStatus === "closed", locked = closed && !can("admin");
  const stat = REQ_DOCS.map(k => `<span class="pill ${d.status.counts[k] ? "p-good" : "p-crit"}">${d.status.counts[k] ? "✔" : "✖"} ${t("dt_" + k)}</span>`).join(" ");
  let h = sec(t("sdTitle"), ACC.teal) + `<p class="note">${t("sdSub")}</p>
    <div class="card" style="margin-bottom:12px">
      <div class="formgrid">
        <div class="field"><label>${t("opDay")}</label><input class="inp" type="date" id="sdDay" value="${serToIso(slot.opDate)}"></div>
        <div class="field"><label>${t("shift")}</label><select class="inp" id="sdShift">${d.shifts.map(s => `<option value="${esc(s.code)}" ${s.code === slot.code ? "selected" : ""}>${t("shift")} ${esc(s.code)} · ${esc(s.start)}</option>`).join("")}</select></div>
        <div class="field"><label>&nbsp;</label><span>${slot.opDate === d.current.opDate && slot.code === d.current.code ? `<span class="pill p-good">${t("sdCurrent")}</span>` : `<button class="btn light small" id="sdCur">${t("sdBackCurrent")}</button>`}
          ${d.shiftStatus ? `<span class="pill ${closed ? "p-none" : "p-good"}">${t(closed ? "sdClosed" : "sdOpen")}</span>` : `<span class="pill p-warn">${t("sdNotStarted")}</span>`}</span></div>
      </div>
      <div style="margin:6px 0 2px">${stat}</div>
    </div>`;
  if (locked) h += `<div class="banner info">${t("sdLocked")}</div>`;
  else h += `<form class="card" id="sdForm" style="margin-bottom:12px"><h3>${t("sdAdd")}</h3><div class="formgrid">
      <div class="field"><label>${t("sdType")}</label><select class="inp" id="sdType" required><option value="">–</option>${DOC_TYPES.map(k => `<option value="${k}">${t("dt_" + k)}</option>`).join("")}</select></div>
      <div class="field"><label>${t("sdSignedBy")}</label><input class="inp" id="sdSigned" placeholder="${t("sdSignedPh")}"></div>
      <div class="field" style="grid-column:span 2"><label>${t("sdFile")}</label><input class="inp" type="file" id="sdFile" required accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xlsm,.xls,.docx,.doc,.csv,image/*"></div>
      <div class="field" style="grid-column:span 2"><label>${t("notes")}</label><input class="inp" id="sdNote"></div>
    </div><div class="err" id="sdErr"></div><button class="btn primary" id="sdGo">⬆ ${t("sdUpload")}</button></form>`;
  h += d.docs.length ? `<div class="tblwrap docs"><table><thead><tr><th>${t("sdType")}</th><th>${t("upFile")}</th><th>${t("sdSignedBy")}</th><th>${t("notes")}</th><th>${t("upBy")}</th><th>${t("upWhen")}</th><th>${t("actions")}</th></tr></thead><tbody>` +
    d.docs.map(x => `<tr><td><b>${t("dt_" + x.doc_type)}</b></td><td>${esc(x.file_name)} <span class="muted">${fmtSize(x.size)}</span></td><td>${esc(x.signed_by)}</td><td class="wrapc">${esc(x.note)}</td><td>${esc(x.uploaded_by || "")}</td><td class="muted">${esc(tsDate(x.uploaded_at))}</td>
      <td><a class="btn light small" href="/api/shift-docs/${x.id}/file">⬇ ${t("upDl")}</a> ${can("admin") || (!closed && S.user && x.uploaded_by === S.user.username) ? `<button class="btn danger small" data-sdel="${x.id}" data-f="${esc(x.file_name)}">${t("del")}</button>` : ""}</td></tr>`).join("") + `</tbody></table></div>`
    : `<p class="note">${t("sdNone")}</p>`;
  box.innerHTML = h;
  const pick = () => { const iso = $("#sdDay").value; if (!iso) return; renderShiftDocs({ opDate: isoToSer(iso), code: $("#sdShift").value }); };
  $("#sdDay").onchange = pick; $("#sdShift").onchange = pick;
  const cur = $("#sdCur"); if (cur) cur.onclick = () => { S.sdSel = null; renderShiftDocs(); };
  const f = $("#sdForm"); if (f) f.onsubmit = async e => {
    e.preventDefault(); $("#sdErr").textContent = "";
    const file = $("#sdFile").files[0]; if (!file) { $("#sdErr").textContent = t("sdChooseFile"); return; }
    const b = $("#sdGo"); b.disabled = true; b.textContent = t("upSending");
    try {
      const ab = await file.arrayBuffer();
      await api("POST", "/api/shift-docs", { opDate: slot.opDate, code: slot.code, docType: $("#sdType").value, signedBy: $("#sdSigned").value, note: $("#sdNote").value, fileName: file.name, fileB64: XLSXR.toBase64(ab) });
      toast(t("saved")); S.sdSel = slot; renderShiftDocs();
    } catch (er) { $("#sdErr").textContent = er.message; b.disabled = false; b.textContent = "⬆ " + t("sdUpload"); }
  };
  $$("[data-sdel]").forEach(b => b.onclick = async () => {
    const ok = await modal(t("del"), `<p>${esc(t("sdDelConfirm", { f: b.dataset.f }))}</p>`, [{ label: t("cancel"), value: false }, { label: t("del"), cls: "danger", value: true }]);
    if (!ok) return; try { await api("DELETE", `/api/shift-docs/${b.dataset.sdel}`); toast(t("saved")); renderShiftDocs(); } catch (e) { toast(e.message); }
  });
}
async function renderUploads() {
  const v = $("#view"); v.innerHTML = `<p class="muted">${t("loading")}</p>`;
  const { uploads } = await api("GET", "/api/uploads");
  let h = `<div class="pagehead"><h1>${t("upHistory")}</h1>${can("mis") ? `<a class="btn primary small" href="#upload">⬆ ${t("navUpload")}</a>` : ""}</div>
    <div class="tblwrap docs"><table><thead><tr><th>#</th><th>${t("upWhen")}</th><th>${t("upBy")}</th><th>${t("upFile")}</th><th>${t("upRange")}</th><th class="num">${t("upRowsIn")}</th><th class="num">${t("upNew")}</th><th class="num">${t("upUpd")}</th><th class="num">${t("upSame")}</th><th class="num">${t("upRej")}</th><th class="num">${t("upLive")}</th><th>${t("actions")}</th></tr></thead><tbody>`;
  h += uploads.map(u => `<tr><td>${u.id}</td><td>${esc(fmtTs(u.created_at))}</td><td>${esc(u.username)}</td><td>${esc(u.file_name)}${u.shift_code ? `<div class="muted">${t("shift")} ${esc(u.shift_code)} · ${fmtDate(u.op_date)}</div>` : ""}</td><td>${u.min_date != null ? fmtDate(u.min_date) + " → " + fmtDate(u.max_date) : "–"}</td>
    <td class="num">${u.rows_in}</td><td class="num">${u.inserted}</td><td class="num">${u.updated}</td><td class="num">${u.unchanged}</td><td class="num ${u.rejected ? "bad" : ""}">${u.rejected}</td><td class="num">${u.live_rows}</td>
    <td>${u.has_file ? `<a class="btn light small" href="/api/uploads/${u.id}/file">⬇ ${t("upDl")}</a>` : ""} ${can("admin") ? `<button class="btn danger small" data-del="${u.id}" data-f="${esc(u.file_name)}" data-n="${u.live_rows}">${t("upDel")}</button>` : ""}</td></tr>`).join("");
  h += `</tbody></table></div>`;
  v.innerHTML = h;
  $$("[data-del]").forEach(b => b.onclick = async () => {
    const ok = await modal(t("upDel"), `<p>${esc(t("upDelConfirm", { id: b.dataset.del, f: b.dataset.f, n: b.dataset.n }))}</p>`, [{ label: t("cancel"), value: false }, { label: t("upDel"), cls: "danger", value: true }]);
    if (!ok) return;
    try { const r = await api("DELETE", `/api/uploads/${b.dataset.del}`); toast(t("upRemoved", { n: r.removed })); await loadConfig(); await loadRows(); updateAsOf(); renderView(); } catch (e) { toast(e.message); }
  });
}

/* =========================================================== admin: users */
async function renderUsers() {
  const v = $("#view"); v.innerHTML = `<p class="muted">${t("loading")}</p>`;
  const { users } = await api("GET", "/api/users");
  const roleSel = (cur, id) => `<select class="inp sm" data-role="${id}">${ROLE_LIST.map(r => `<option value="${r}" ${cur === r ? "selected" : ""}>${t("role_" + r)}</option>`).join("")}</select>`;
  let h = `<div class="pagehead"><h1>${t("usersTitle")}</h1></div>
   <div class="card" style="margin-bottom:14px"><h3>${t("newUser")}</h3>
    <form id="nu" class="formgrid" autocomplete="off">
      <div class="field"><label>${t("username")}</label><input class="inp" id="nuU" required autocapitalize="none" spellcheck="false"></div>
      <div class="field"><label>${t("displayName")}</label><input class="inp" id="nuN"></div>
      <div class="field"><label>${t("role")}</label><select class="inp" id="nuR">${["mis", "shift_lead", "viewer", "admin"].map(r => `<option value="${r}">${t("role_" + r)}</option>`).join("")}</select></div>
      <div class="field"><label>${t("tempPw")}</label><input class="inp" id="nuP" value="${tempPassword()}"></div>
      <div class="field"><button class="btn primary">${t("create")}</button></div>
    </form><div class="err" id="nuErr"></div>
    <div class="note">${ROLE_LIST.map(r => `<b>${t("role_" + r)}</b>: ${t("roleDesc_" + r)}`).join(" · ")}</div></div>
   <div class="tblwrap"><table><thead><tr><th>${t("username")}</th><th>${t("displayName")}</th><th>${t("role")}</th><th class="c">${t("active")}</th><th>${t("lastLogin")}</th><th>${t("actions")}</th></tr></thead><tbody>`;
  h += users.map(u => { const me = S.user && u.id === S.user.id; return `<tr><td><b>${esc(u.username)}</b>${me ? ` <span class="muted">(${t("you")})</span>` : ""}</td><td>${esc(u.displayName)}</td><td>${roleSel(u.role, u.id)}</td>
    <td class="c"><label class="switch"><input type="checkbox" data-act="${u.id}" ${u.active ? "checked" : ""} ${me ? "disabled" : ""}><span></span></label></td><td>${u.lastLogin ? esc(fmtTs(u.lastLogin)) : `<span class="muted">${t("never")}</span>`}</td>
    <td><button class="btn light small" data-pw="${u.id}" data-u="${esc(u.username)}">${t("resetPw")}</button> ${me ? "" : `<button class="btn danger small" data-del="${u.id}" data-u="${esc(u.username)}">${t("del")}</button>`}</td></tr>`; }).join("");
  h += `</tbody></table></div>`;
  v.innerHTML = h;
  $("#nu").onsubmit = async e => {
    e.preventDefault(); $("#nuErr").textContent = "";
    const body = { username: $("#nuU").value.trim(), displayName: $("#nuN").value.trim(), role: $("#nuR").value, password: $("#nuP").value };
    try { await api("POST", "/api/users", body); await modal(t("userCreated"), `<p><b>${t("username")}:</b> ${esc(body.username)}<br><b>${t("tempPw")}:</b> <span class="ltr">${esc(body.password)}</span></p>`, [{ label: t("close"), cls: "primary", value: true }]); renderView(); }
    catch (er) { $("#nuErr").textContent = er.message; }
  };
  $$("[data-role]").forEach(s => s.onchange = async () => { try { await api("PATCH", `/api/users/${s.dataset.role}`, { role: s.value }); toast(t("saved")); } catch (e) { toast(e.message); renderView(); } });
  $$("[data-act]").forEach(c => c.onchange = async () => { try { await api("PATCH", `/api/users/${c.dataset.act}`, { active: c.checked }); toast(t("saved")); } catch (e) { toast(e.message); renderView(); } });
  $$("[data-pw]").forEach(b => b.onclick = async () => {
    const pw = tempPassword();
    const val = await modal(t("resetPw"), `<div class="field"><label>${esc(t("newPwFor", { u: b.dataset.u }))}</label><input class="inp" id="rpw" value="${pw}"></div><div class="note">${t("pwRule")}</div>`,
      [{ label: t("cancel"), value: null }, { label: t("save"), cls: "primary", value: m => m.querySelector("#rpw").value }]);
    if (!val) return;
    try { await api("POST", `/api/users/${b.dataset.pw}/password`, { password: val }); toast(t("saved")); } catch (e) { toast(e.message); }
  });
  $$("[data-del]").forEach(b => b.onclick = async () => {
    const ok = await modal(t("del"), `<p>${esc(t("confirmDelUser", { u: b.dataset.u }))}</p>`, [{ label: t("cancel"), value: false }, { label: t("del"), cls: "danger", value: true }]);
    if (!ok) return; try { await api("DELETE", `/api/users/${b.dataset.del}`); renderView(); } catch (e) { toast(e.message); }
  });
}

/* =========================================================== admin: settings */
function renderSettings() {
  const st = S.cfg.settings, v = $("#view");
  const pctIn = (k, val) => `<input class="inp sm num" type="number" min="0" max="100" step="1" data-s="${k}" value="${Math.round(val * 100)}"> %`;
  let h = `<div class="pagehead"><h1>${t("navSettings")}</h1></div><div class="set">
    <div class="card"><h3>${t("setThr")}</h3>
      <div class="row"><span>${t("setComp")}</span><span>${pctIn("compT", st.compT)}</span></div>
      <div class="row"><span>${t("setOn")}</span><span>${pctIn("onT", st.onT)}</span></div>
      <div class="row"><span>${t("setWatch")}</span><span>${pctIn("watch", st.watch)}</span></div>
      <div class="row"><span>${t("setSep")}</span><input class="inp sm" style="width:60px" maxlength="2" id="sep" value="${esc(st.sep)}"></div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="saveThr">${t("save")}</button><button class="btn light" id="resetThr">${t("setReset")}</button></div></div>
    <div class="card"><h3>${t("setShifts")}</h3><div id="shRows">${(st.shifts || []).map((x, i) => `<div class="row"><input class="inp sm" style="width:80px" data-shc="${i}" value="${esc(x.code)}"><input class="inp sm" type="time" data-shs="${i}" value="${esc(x.start)}"><button class="btn light small" data-shx="${i}">${t("remove")}</button></div>`).join("")}</div>
      <button class="btn light small" id="shAdd" style="margin:8px 0">${t("addShift")}</button>
      <div class="row"><span>${t("setShiftHours")}</span><input class="inp sm num" type="number" min="1" max="24" id="shH" value="${st.shiftHours ?? 12}"></div>
      <div class="row"><span>${t("setBreakHours")}</span><input class="inp sm num" type="number" min="0" max="6" step="0.5" id="shB" value="${st.breakHours ?? 2}"></div>
      <button class="btn primary" id="shSave" style="margin-top:10px">${t("save")}</button></div>
    <div class="card"><h3>${t("setGuest")}</h3><div class="row"><span class="note" style="margin:0">${t("setGuestDesc")}</span><label class="switch"><input type="checkbox" id="guest" ${st.guestEnabled ? "checked" : ""}><span></span></label></div></div>
    <div class="card"><h3>${t("setFlow")}</h3>${S.cfg.defs.flowKpis.map((f, i) => `<div class="row"><span>${i + 1}. ${esc(isAr() ? f.ar : f.en)} ${f.dir}</span><span><input class="inp sm num" type="number" step="0.1" data-f="${i}" value="${+((st.flowT[i] != null ? st.flowT[i] : f.target) * 100).toFixed(2)}"> %</span></div>`).join("")}
      <button class="btn primary" id="saveFlow" style="margin-top:10px">${t("save")}</button></div></div>`;
  h += sec(t("setSla"), ACC.teal) + `<div class="tblwrap"><table><thead><tr><th>${t("task")}</th><th>${t("taskName")}</th><th class="num">${t("slaH")}</th><th>${t("src")}</th><th>${t("txnCode")}</th><th>${t("numWH")}</th></tr></thead><tbody>` +
    TASK_ORDER.map(c => { const d = def(c); return `<tr class="${d.flow.toLowerCase()}"><td><span class="flow ${d.flow}">${c}</span></td><td>${esc(tName(d))}</td>
      <td class="num"><input class="inp sm num" type="number" min="1" step="1" data-sla="${c}" value="${d.sla}"></td><td class="muted">${t({ default: "srcDefault", file: "srcFile", edit: "srcEdit" }[d.slaSrc])}</td>
      <td><input class="inp sm" style="width:110px" data-txn="${c}" value="${esc(d.txn || "")}"></td>
      <td><select class="inp sm" data-nwh="${c}"><option value="from" ${d.numWH === "from" ? "selected" : ""}>${t("fromWH")}</option><option value="to" ${d.numWH === "to" ? "selected" : ""}>${t("toWH")}</option></select></td></tr>`; }).join("") + `</tbody></table></div>`;
  h += sec(t("danger"), ACC.red) + `<div class="card"><p class="note">${t("clearAllDesc")}</p><div style="display:flex;gap:8px;flex-wrap:wrap"><input class="inp sm" id="clr" placeholder="DELETE ALL"><button class="btn danger" id="clrBtn">${t("clearAll")}</button></div></div>`;
  v.innerHTML = h;
  const save = async body => { try { const r = await api("PUT", "/api/settings", body); S.cfg.settings = r.settings; toast(t("saved")); S.rows = derive(S.rows); renderView(); } catch (e) { toast(e.message); } };
  $("#saveThr").onclick = () => { const b = { sep: $("#sep").value || "/" }; $$("[data-s]").forEach(i => b[i.dataset.s] = Number(i.value) / 100); save(b); };
  $("#resetThr").onclick = () => save({ reset: true });
  $("#guest").onchange = e => save({ guestEnabled: e.target.checked });
  const readShifts = () => $$("[data-shc]").map(i => ({ code: i.value.trim(), start: $(`[data-shs="${i.dataset.shc}"]`).value }));
  $("#shAdd").onclick = () => { st.shifts = readShifts().concat([{ code: String.fromCharCode(65 + readShifts().length), start: "00:00" }]); renderView(); };
  $$("[data-shx]").forEach(b => b.onclick = () => { const a = readShifts(); a.splice(+b.dataset.shx, 1); st.shifts = a; renderView(); });
  $("#shSave").onclick = async () => { await save({ shifts: readShifts(), shiftHours: Number($("#shH").value), breakHours: Number($("#shB").value) }); await loadOps(); };
  $("#saveFlow").onclick = () => { const f = {}; $$("[data-f]").forEach(i => f[i.dataset.f] = Number(i.value) / 100); save({ flowT: f }); };
  $$("[data-sla]").forEach(i => i.onchange = () => { const sla = Object.assign({}, st.sla); const n = Number(i.value); if (n > 0) sla[i.dataset.sla] = n; save({ sla }); });
  const saveTm = async c => { const d = def(c); try { await api("PUT", `/api/task-master/${c}`, { sla: (S.cfg.taskMaster[c] || {}).sla ?? null, txn: $(`[data-txn="${c}"]`).value.trim(), numWH: $(`[data-nwh="${c}"]`).value }); await loadConfig(); S.rows = derive(S.rows); toast(t("saved")); } catch (e) { toast(e.message); } };
  $$("[data-txn]").forEach(i => i.onchange = () => saveTm(i.dataset.txn));
  $$("[data-nwh]").forEach(i => i.onchange = () => saveTm(i.dataset.nwh));
  $("#clrBtn").onclick = async () => { try { const r = await api("POST", "/api/admin/clear-transactions", { confirm: $("#clr").value }); toast(t("upRemoved", { n: r.removed })); await loadConfig(); await loadRows(); updateAsOf(); } catch (e) { toast(e.message); } };
}

/* =========================================================== admin: audit */
async function renderAudit() {
  const v = $("#view"); v.innerHTML = `<p class="muted">${t("loading")}</p>`;
  const { audit } = await api("GET", "/api/audit?limit=500");
  v.innerHTML = `<div class="pagehead"><h1>${t("auditTitle")}</h1></div><div class="tblwrap docs"><table><thead><tr><th>${t("when")}</th><th>${t("who")}</th><th>${t("act")}</th><th>${t("det")}</th><th>${t("ip")}</th></tr></thead><tbody>` +
    audit.map(a => `<tr><td>${esc(fmtTs(a.ts))}</td><td>${esc(a.username || "–")}</td><td><b>${esc(a.action)}</b></td><td class="wrapc">${esc(a.detail || "")}</td><td class="muted">${esc(a.ip || "")}</td></tr>`).join("") + `</tbody></table></div>`;
}

/* =========================================================== account */
function renderAccount() {
  const u = S.user, v = $("#view");
  v.innerHTML = `<div class="pagehead"><h1>${t("navAccount")}</h1></div>
    ${u.mustChange ? `<div class="banner">${t("mustChange")}</div>` : ""}
    <div class="set"><div class="card"><h3>${esc(u.displayName || u.username)}</h3><p>${t("username")}: <b>${esc(u.username)}</b><br>${t("role")}: <b>${t("role_" + u.role)}</b></p><p class="note">${t("roleDesc_" + u.role)}</p></div>
    <form class="card" id="pwf" autocomplete="on"><h3>${t("changePw")}</h3>
      <input type="text" name="username" value="${esc(u.username)}" autocomplete="username" class="hide">
      <div class="field"><label>${t("currentPw")}</label><input class="inp" type="password" id="pc" autocomplete="current-password" required></div>
      <div class="field"><label>${t("newPw")}</label><input class="inp" type="password" id="pn" autocomplete="new-password" required></div>
      <div class="field"><label>${t("confirmPw")}</label><input class="inp" type="password" id="pn2" autocomplete="new-password" required></div>
      <div class="note">${t("pwRule")}</div><div class="err" id="pwErr"></div><button class="btn primary">${t("save")}</button></form></div>`;
  $("#pwf").onsubmit = async e => {
    e.preventDefault(); $("#pwErr").textContent = "";
    if ($("#pn").value !== $("#pn2").value) { $("#pwErr").textContent = t("pwMismatch"); return; }
    try { await api("POST", "/api/me/password", { current: $("#pc").value, next: $("#pn").value }); toast(t("pwChanged")); const was = u.mustChange; u.mustChange = false; if (was) { await start(); } else renderView(); }
    catch (er) { $("#pwErr").textContent = er.message; }
  };
}

/* =========================================================== Operations Room: day / shift handover */
async function loadOps() { try { S.ops = can("viewer") && S.user ? await api("GET", "/api/ops/state") : null; } catch { S.ops = null; } return S.ops; }
const serTime = s => fmtTime(s % 1);
const tsTime = s => s ? s.slice(11, 16) : "";
const tsDate = s => s ? s.slice(8, 10) + "/" + s.slice(5, 7) + " " + s.slice(11, 16) : "";
const shiftLabel = (code, cfg) => { const sh = (cfg || S.ops.config).shifts.find(x => x.code === code); const hrs = (cfg || S.ops.config).shiftHours; if (!sh) return code; const end = (sh.f + hrs / 24) % 1; return `${t("shift")} ${code} · ${sh.start}–${fmtTime(end)}`; };
const prioPill = p => `<span class="pill ${p === "high" ? "p-crit" : p === "low" ? "p-none" : "p-warn"}">${t("p_" + p)}</span>`;
// Document items of End of Shift are ticked by the server from the shift's attachments – shown read-only here.
const clHtml = (kind, prefix) => S.ops.checklists[kind].map(k => {
  if (kind === "eos" && k === "txnFormsUploaded") { const n = (S.ops.formsMissing || []).length;
    return `<label class="check" title="${esc(t("autoTick"))}"><input type="checkbox" disabled ${n ? "" : "checked"}> ${t("cl_" + k)} <span class="pill ${n ? "p-crit" : "p-good"}">${n ? esc(t("tfShiftMissing", { n })) : "✔"}</span></label>`; }
  const auto = kind === "eos" && S.ops.autoChecks[k];
  if (auto) { const n = S.ops.docs ? S.ops.docs.counts[auto] : 0;
    return `<label class="check" title="${esc(t("autoTick"))}"><input type="checkbox" disabled ${n ? "checked" : ""}> ${t("cl_" + k)} <span class="pill ${n ? "p-good" : "p-crit"}">${n ? esc(t("sdAttached", { n })) : t("sdNotAttached")}</span></label>`; }
  return `<label class="check"><input type="checkbox" data-cl="${prefix}" value="${k}"> ${t("cl_" + k)}</label>`;
}).join("");
const docLinks = docs => docs.length ? docs.map(x => `<a class="btn light small" href="/api/shift-docs/${x.id}/file">📎 ${t("dt_" + x.doc_type)} · ${esc(x.file_name)}${x.signed_by ? ` · ✍ ${esc(x.signed_by)}` : ""}</a>`).join(" ") : `<span class="muted">${t("sdNone")}</span>`;
const clRead = prefix => { const o = {}; $$(`[data-cl="${prefix}"]`).forEach(c => o[c.value] = c.checked); return o; };
function opsBannerHtml() {
  const o = S.ops; if (!o) return "";
  const st = o.openShift ? t("shiftOpen", { c: o.openShift.code }) + " · " + t("since", { t: tsTime(o.openShift.startAt), u: o.openShift.startBy }) : (o.day ? t("noShiftOpen") : t("dayNotStarted"));
  return `<a class="banner info" href="#ops" style="display:block;text-decoration:none;color:inherit">🛰 ${esc(t("opsBanner", { s: st }))} · ${o.items.length} ${esc(t("sItems").toLowerCase())}</a>`;
}

async function renderOps() {
  const v = $("#view"); v.innerHTML = `<p class="muted">${t("loading")}</p>`;
  if (S.opsView && S.opsView.startsWith("shift:")) return renderShiftReport(+S.opsView.slice(6));
  if (S.opsView === "history") return renderOpsHistory();
  const o = await loadOps(); if (!o) { v.innerHTML = `<div class="banner">${t("errNet")}</div>`; return; }
  const act = can("cap:ops"), here = o.here;
  const tabs = `<div class="toolbar"><button class="btn primary small">${t("opsNow")}</button><button class="btn light small" id="toHist">${t("opsHistory")}</button><button class="btn light small" id="opsRef">↻ ${t("refresh")}</button></div>`;
  const dayPill = !o.day ? `<span class="pill p-none">${t("dayNotStarted")}</span>` : o.day.status === "open" ? `<span class="pill p-good">${t("dayOpen")}</span>` : `<span class="pill p-none">${t("dayClosed")}</span>`;
  const shPill = o.openShift ? `<span class="pill p-good">${esc(t("shiftOpen", { c: o.openShift.code }))}</span> <span class="muted">${esc(t("since", { t: tsTime(o.openShift.startAt), u: o.openShift.startBy }))}</span>` : `<span class="pill p-warn">${t("noShiftOpen")}</span>`;
  const lh = o.lastClosed ? `<div class="note">${esc(t("lastHandover", { c: o.lastClosed.code, to: o.lastClosed.handoverTo || "–", t: tsDate(o.lastClosed.endAt) }))}</div>` : "";
  let h = `<div class="pagehead"><h1>${t("opsTitle")}</h1></div>${tabs}
   <div class="card" style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center">
     <div><div class="muted" style="font-size:12px">${t("opDay")}</div><b style="font-size:18px">${fmtDate(here.opDate)}</b> ${dayPill}</div>
     <div><div class="muted" style="font-size:12px">${t("shift")}</div><b style="font-size:18px">${esc(shiftLabel(here.code))}</b> <span class="muted">· ${esc(t("nowAt", { t: o.nowText.slice(11, 16) }))}</span></div>
     <div>${shPill}</div></div>${lh}`;
  if (!act) h += `<div class="banner info">${t("viewOnly")}</div>`;

  // ---- action card
  let actionHtml = "", actionKind = "";
  if (act) {
    if (!o.day) { actionKind = "sod"; }
    else if (o.openShift) { actionKind = "eos"; }
    // the server says which shift may start now (o.next) – including an early takeover once the previous shift is closed
    else if (o.day.status === "open" && o.next) { actionKind = "sos"; }
    else if (o.day.status === "open") { actionKind = "eod"; }
    if (actionKind === "sod") actionHtml = `<h3>① ${t("sod")}</h3><p class="note">${t("sodDesc")}</p>${clHtml("sod", "sod")}`;
    if (actionKind === "sos") {
      const p = o.lastClosed, nx = o.next;
      const early = nx.early ? `<div class="banner info">${esc(t("earlyTakeover", { p: here.code, c: nx.code, t: serTime(nx.winStart) }))}</div>` : "";
      const pack = p ? `<div class="banner info"><b>${esc(t("handoverPack", { c: p.code }))}</b><br>${esc(t("handedBy", { u: p.endBy, t: tsDate(p.endAt), to: p.handoverTo || "–" }))}${p.endNotes ? `<br><i>“${esc(p.endNotes)}”</i>` : ""}
          ${p.snapshot ? `<div class="note">${t("sOpen")}: <b>${p.snapshot.total.open}</b> · ${t("sNotPosted")}: <b>${p.snapshot.total.notPosted}</b> · ${t("sOverdue")}: <b>${p.snapshot.total.overdue}</b> · ${t("sCompleted")}: <b>${p.snapshot.total.completed}</b></div>` : ""}
          <div style="margin-top:6px"><b>${t("sdTitle")}:</b> ${docLinks(o.lastClosedDocs)}</div></div>` : `<p class="note">${t("noPrevShift")}</p>`;
      const its = o.items.length ? `<div class="tblwrap" style="margin:8px 0"><table><thead><tr><th>${t("acceptItem")}</th><th>${t("priority")}</th><th>${t("task")}</th><th>${t("docNo")}</th><th>${t("itemTitle")}</th><th>${t("ackNote")}</th></tr></thead><tbody>` +
        o.items.map(i => `<tr><td class="c"><input type="checkbox" class="ack" value="${i.id}" style="width:20px;height:20px"></td><td>${prioPill(i.priority)}</td><td>${esc(i.task || "")}</td><td><span class="ltr">${esc(i.docno)}</span></td><td class="wrapc"><b>${esc(i.title)}</b>${i.note ? `<div class="muted">${esc(i.note)}</div>` : ""}</td><td><input class="inp sm acknote" data-id="${i.id}" style="width:200px"></td></tr>`).join("") +
        `</tbody></table></div><button class="btn light small" id="ackAll">✔ ${t("acceptAll")}</button> <span class="note">${t("mustAck")}</span>` : "";
      actionHtml = `<h3>② ${t("sos")} · ${esc(shiftLabel(nx.code))}</h3><p class="note">${t("sosDesc")}</p>${early}${pack}${its}<div style="margin-top:10px">${clHtml("sos", "sos")}</div>`;
    }
    if (actionKind === "eos") actionHtml = `<h3>③ ${t("eos")} · ${t("shift")} ${esc(o.openShift.code)}</h3><p class="note">${t("eosDesc")}</p>${clHtml("eos", "eos")}
      ${o.formsMissing && o.formsMissing.length ? `<div class="note">✖ <span class="ltr">${o.formsMissing.slice(0, 8).map(d => esc(d.task + " " + d.docno)).join(", ")}${o.formsMissing.length > 8 ? " …" : ""}</span></div>` : ""}
      ${(o.docs && o.docs.missing.length) || (o.formsMissing && o.formsMissing.length) ? `<div class="note">${t("sdMissingHint")} <a href="#upload">${t("sdAttachNow")} →</a></div>` : ""}
      <div class="field" style="max-width:420px"><label>${t("handoverTo")}</label><input class="inp" id="hTo" autocomplete="off"></div>`;
    if (actionKind === "eod") actionHtml = `<h3>④ ${t("eod")} · ${fmtDate(o.day.opDate)}</h3><p class="note">${t("eodDesc")}</p>${clHtml("eod", "eod")}`;
    if (actionHtml) {
      const btnLabel = { sod: "confirmSod", sos: "confirmSos", eos: "confirmEos", eod: "confirmEod" }[actionKind];
      h += `<div class="card" style="margin-bottom:12px;border-inline-start:6px solid var(--yel)">${actionHtml}
        <div class="field"><label>${t("notes")}</label><textarea class="inp" id="opNotes" rows="2" style="min-height:60px"></textarea><span class="note">${t("notesHint")}</span></div>
        <div class="err" id="opErr"></div><button class="btn ${actionKind === "eos" || actionKind === "eod" ? "danger" : "primary"}" id="opGo">${t(btnLabel)}</button>
        ${actionKind === "eos" && o.day ? "" : ""}</div>`;
    }
    // End of Day is also available while no shift is open and the day has had at least one shift
    if (actionKind === "sos" && o.dayShifts.length) h += `<div class="note"><a href="#" id="toEod">${t("eod")} →</a></div>`;
  }

  // ---- live figures
  const L = o.live.total;
  h += sec(t("liveShift"), ACC.vio, o.openShift ? shiftLabel(o.openShift.code) : "") + `<div class="tiles">
    ${tile(t("sCreated"), nf0.format(L.created), "", ACC.vio)}${tile(t("sCompleted"), nf0.format(L.completed), "", ACC.aqua)}${tile(t("sOpen"), nf0.format(L.open), "", ACC.yel)}
    ${tile(t("sNotPosted"), nf0.format(L.notPosted), L.notPosted ? "✖ " + t("follow").replace(/^✖ /, "") : "✔", ACC.red)}${tile(t("sOverdue"), nf0.format(L.overdue), "", ACC.mag)}${tile(t("sItems"), nf0.format(o.items.length), "", ACC.teal)}</div>`;

  // ---- handover items
  h += sec(t("items"), ACC.teal) + (o.items.length ? `<div class="tblwrap docs"><table><thead><tr><th>#</th><th>${t("priority")}</th><th>${t("task")}</th><th>${t("docNo")}</th><th>${t("itemTitle")}</th><th>${t("status")}</th><th>${t("raised")}</th><th>${t("accepted")}</th>${act ? `<th></th>` : ""}</tr></thead><tbody>` +
    o.items.map(i => `<tr><td>${i.id}</td><td>${prioPill(i.priority)}</td><td>${i.task ? `<span class="flow ${TASK[i.task] ? TASK[i.task].flow : ""}">${esc(i.task)}</span>` : ""}</td><td><span class="ltr">${esc(i.docno)}</span></td>
      <td class="wrapc"><b>${esc(i.title)}</b>${i.note ? `<div class="muted">${esc(i.note)}</div>` : ""}</td>
      <td>${act ? `<select class="inp sm" data-ist="${i.id}">${["open", "in_progress", "blocked", "done"].map(s => `<option value="${s}" ${i.status === s ? "selected" : ""}>${t("i_" + s)}</option>`).join("")}</select>` : t("i_" + i.status)}</td>
      <td class="muted">${esc(tsDate(i.created_at))} · ${esc(i.created_by || "")}</td><td class="c">${i.acks.length}</td>${act ? `<td></td>` : ""}</tr>`).join("") + `</tbody></table></div>` : `<p class="note">${t("noItems")}</p>`);
  if (act) h += `<form class="card" id="itemForm" style="margin-top:10px"><h3>${t("addItem")}</h3><div class="formgrid">
     <div class="field"><label>${t("task")}</label><select class="inp" id="iTask"><option value="">–</option>${TASK_ORDER.map(c => `<option value="${c}">${c} · ${esc(tName(TASK[c]))}</option>`).join("")}</select></div>
     <div class="field"><label>${t("docNo")}</label><input class="inp" id="iDoc" autocapitalize="characters"></div>
     <div class="field" style="grid-column:span 2"><label>${t("itemTitle")}</label><input class="inp" id="iTitle" required></div>
     <div class="field"><label>${t("priority")}</label><select class="inp" id="iPrio"><option value="high">${t("p_high")}</option><option value="normal" selected>${t("p_normal")}</option><option value="low">${t("p_low")}</option></select></div>
   </div><div class="field"><label>${t("notes")}</label><input class="inp" id="iNote"></div><div class="err" id="iErr"></div><button class="btn primary">${t("addItem")}</button></form>`;

  // ---- shift log
  h += sec(t("shiftLog"), ACC.grey);
  if (o.openShift) {
    if (act) h += `<div class="toolbar"><button class="btn light small" data-ev="break_start">${t("breakStart")}</button><button class="btn light small" data-ev="break_end">${t("breakEnd")}</button>
      <input class="inp sm" id="evText" placeholder="${t("logText")}" style="flex:1 1 260px;min-height:36px"><select class="inp sm" id="evType"><option value="note">${t("e_note")}</option><option value="incident">${t("e_incident")}</option></select><button class="btn primary small" id="evAdd">${t("addEntry")}</button></div>`;
    h += o.events.length ? `<div class="tblwrap docs"><table><tbody>${o.events.map(e => `<tr><td class="muted" style="width:70px">${esc(tsTime(e.ts))}</td><td style="width:150px"><span class="pill ${e.type === "incident" ? "p-crit" : e.type.startsWith("break") ? "p-warn" : "p-none"}">${t("e_" + e.type)}</span></td><td class="wrapc">${esc(e.text)}</td><td class="muted">${esc(e.username || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">${t("noEvents")}</p>`;
  } else h += `<p class="note">${t("startShiftFirst")}</p>`;
  v.innerHTML = h;

  // ---- wiring
  $("#toHist").onclick = () => { S.opsView = "history"; renderView(); };
  $("#opsRef").onclick = () => renderView();
  const eodLink = $("#toEod"); if (eodLink) eodLink.onclick = async e => { e.preventDefault(); S.forceEod = true; await doOps("eod"); };
  const ackAll = $("#ackAll"); if (ackAll) ackAll.onclick = () => $$(".ack").forEach(c => c.checked = true);
  const go = $("#opGo"); if (go) go.onclick = () => doOps(actionKind);
  const f = $("#itemForm"); if (f) f.onsubmit = async e => {
    e.preventDefault(); $("#iErr").textContent = "";
    try { await api("POST", "/api/ops/items", { task: $("#iTask").value, docno: $("#iDoc").value, title: $("#iTitle").value, priority: $("#iPrio").value, note: $("#iNote").value }); toast(t("saved")); renderView(); }
    catch (er) { $("#iErr").textContent = er.message; }
  };
  $$("[data-ist]").forEach(sel => sel.onchange = async () => {
    const body = { status: sel.value };
    if (sel.value === "done") { const r = await modal(t("i_done"), `<div class="field"><label>${t("resolve")}</label><input class="inp" id="rsl"></div>`, [{ label: t("cancel"), value: null }, { label: t("save"), cls: "primary", value: m => m.querySelector("#rsl").value }]); if (!r) { renderView(); return; } body.closeNote = r; }
    try { await api("PATCH", `/api/ops/items/${sel.dataset.ist}`, body); toast(t("saved")); renderView(); } catch (er) { toast(er.message); renderView(); }
  });
  $$("[data-ev]").forEach(b => b.onclick = async () => { try { await api("POST", "/api/ops/events", { type: b.dataset.ev, text: $("#evText").value }); renderView(); } catch (er) { toast(er.message); } });
  const ea = $("#evAdd"); if (ea) ea.onclick = async () => { try { await api("POST", "/api/ops/events", { type: $("#evType").value, text: $("#evText").value }); renderView(); } catch (er) { toast(er.message); } };
}

async function doOps(kind, force) {
  const err = $("#opErr"); if (err) err.textContent = "";
  const notes = ($("#opNotes") || {}).value || "";
  const url = { sod: "/api/ops/day/start", sos: "/api/ops/shift/start", eos: "/api/ops/shift/end", eod: "/api/ops/day/end" }[kind];
  const body = { checklist: clRead(kind), notes };
  if (kind === "eod" && S.forceEod && !$$('[data-cl="eod"]').length) {   // End of Day from the link: ask in a dialog
    S.forceEod = false;
    const res = await modal(t("eod"), `<p class="note">${t("eodDesc")}</p>${S.ops.checklists.eod.map(k => `<label class="check"><input type="checkbox" class="mcl" value="${k}"> ${t("cl_" + k)}</label>`).join("")}<div class="field"><label>${t("notes")}</label><input class="inp" id="mn"></div>`,
      [{ label: t("cancel"), value: null }, { label: t("confirmEod"), cls: "danger", value: m => { const o = {}; m.querySelectorAll(".mcl").forEach(c => o[c.value] = c.checked); return { checklist: o, notes: m.querySelector("#mn").value }; } }]);
    if (!res) return; Object.assign(body, res);
  }
  if (kind === "sos") body.acks = $$(".ack").filter(c => c.checked).map(c => ({ id: +c.value, note: ($(`.acknote[data-id="${c.value}"]`) || {}).value || "" }));
  if (kind === "eos") body.handoverTo = $("#hTo").value;
  if (force) body.force = true;
  try {
    await api("POST", url, body); toast(t("saved"));
    if (kind === "eos" || kind === "eod") { await loadConfig(); await loadRows(); }
    renderView();
  } catch (e) {
    if (e.message === "PREV_DAY_OPEN") { const ok = await modal(t("sod"), `<p>${t("prevDayOpen")}</p>`, [{ label: t("cancel"), value: false }, { label: t("startAnyway"), cls: "primary", value: true }]); if (ok) return doOps(kind, true); return; }
    if (err) err.textContent = e.message; else toast(e.message);
  }
}

async function renderOpsHistory() {
  const v = $("#view"); const { days, shifts } = await api("GET", "/api/ops/history?limit=60");
  let h = `<div class="pagehead"><h1>${t("opsTitle")}</h1></div><div class="toolbar"><button class="btn light small" id="toNow">${t("opsNow")}</button><button class="btn primary small">${t("opsHistory")}</button></div>`;
  h += sec(t("histDays"), ACC.vio) + `<div class="tblwrap docs"><table><thead><tr><th>${t("opDay")}</th><th>${t("status")}</th><th>${t("sod")}</th><th>${t("histShifts")}</th><th>${t("eod")}</th><th class="num">${t("sCompleted")}</th><th class="num">${t("sOpen")}</th><th class="num">${t("sNotPosted")}</th></tr></thead><tbody>` +
    days.map(d => { const sh = shifts.filter(s => s.opDate === d.opDate).sort((a, b) => a.winStart - b.winStart); const sn = d.eodSnapshot;
      return `<tr><td><b>${fmtDate(d.opDate)}</b></td><td>${d.status === "open" ? `<span class="pill p-good">${t("dayOpen")}</span>` : `<span class="pill p-none">${t("dayClosed")}</span>`}</td>
      <td class="muted">${esc(tsTime(d.sodAt))} · ${esc(d.sodBy || "")}</td>
      <td>${sh.map(s => `<button class="btn light small" data-sh="${s.id}">${esc(s.code)} · ${esc(s.startBy || "")} → ${esc(s.handoverTo || (s.status === "open" ? "…" : "–"))}</button>`).join(" ")}</td>
      <td class="muted">${d.eodAt ? esc(tsTime(d.eodAt)) + " · " + esc(d.eodBy) : "–"}</td><td class="num">${sn ? sn.total.completed : "–"}</td><td class="num">${sn ? sn.total.open : "–"}</td><td class="num">${sn ? sn.total.notPosted : "–"}</td></tr>`; }).join("") + `</tbody></table></div>`;
  v.innerHTML = h;
  $("#toNow").onclick = () => { S.opsView = null; renderView(); };
  $$("[data-sh]").forEach(b => b.onclick = () => { S.opsView = "shift:" + b.dataset.sh; renderView(); });
}

async function renderShiftReport(id) {
  const v = $("#view"); const d = await api("GET", `/api/ops/shift/${id}`); const s = d.shift, sn = s.snapshot, cfg = (S.ops || await loadOps()).config;
  const cl = (kind, obj) => obj ? Object.keys(obj).map(k => `<div>${obj[k] ? "✔" : "✖"} ${t("cl_" + k)}</div>`).join("") : "–";   // stored keys, so older reports still read right
  const itemsTbl = (rows, extra) => rows.length ? `<div class="tblwrap"><table><thead><tr><th>#</th><th>${t("priority")}</th><th>${t("task")}</th><th>${t("docNo")}</th><th>${t("itemTitle")}</th><th>${t("status")}</th>${extra ? `<th>${extra[0]}</th>` : ""}</tr></thead><tbody>` +
    rows.map(i => `<tr><td>${i.id}</td><td>${prioPill(i.priority)}</td><td>${esc(i.task || "")}</td><td><span class="ltr">${esc(i.docno)}</span></td><td class="wrapc"><b>${esc(i.title)}</b>${i.close_note ? `<div class="muted">✔ ${esc(i.close_note)}</div>` : ""}</td><td>${t("i_" + i.status)}</td>${extra ? `<td class="wrapc">${esc(extra[1](i))}</td>` : ""}</tr>`).join("") + `</tbody></table></div>` : `<p class="note">${t("none")}</p>`;
  let h = `<div class="toolbar"><button class="btn light small" id="bk">${t("back")}</button><button class="btn light small" id="pr">🖨 ${t("printBtn")}</button>${can("admin") && s.status === "closed" ? `<button class="btn light small" id="ro">${t("reopen")}</button>` : ""}</div>
   <div class="pagehead"><h1>${t("shiftReport")} · ${esc(shiftLabel(s.code, cfg))} · ${fmtDate(s.opDate)}</h1></div>
   <div class="set"><div class="card"><h3>${t("sos")}</h3><p>${t("startedBy")}: <b>${esc(s.startBy || "")}</b> · ${esc(tsDate(s.startAt))}</p>${cl("sos", s.startChecklist)}${s.startNotes ? `<p class="note">“${esc(s.startNotes)}”</p>` : ""}</div>
   <div class="card"><h3>${t("eos")}</h3><p>${t("endedBy")}: <b>${esc(s.endBy || "–")}</b> · ${esc(tsDate(s.endAt))}<br>${t("handoverTo")}: <b>${esc(s.handoverTo || "–")}</b></p>${cl("eos", s.endChecklist)}${s.endNotes ? `<p class="note">“${esc(s.endNotes)}”</p>` : ""}</div>
   <div class="card"><h3>${t("window")}</h3><p>${fmtDate(s.winStart)} ${serTime(s.winStart)} → ${fmtDate(s.winEnd)} ${serTime(s.winEnd)}</p>${sn ? `<p>${t("sCreated")}: <b>${sn.total.created}</b> · ${t("sCompleted")}: <b>${sn.total.completed}</b><br>${t("sOpen")}: <b>${sn.total.open}</b> · ${t("sNotPosted")}: <b>${sn.total.notPosted}</b> · ${t("sOverdue")}: <b>${sn.total.overdue}</b><br>${t("sItems")}: <b>${sn.openItems}</b></p>` : ""}</div></div>`;
  if (sn) h += sec(t("snapPerTask"), ACC.vio) + `<div class="tblwrap"><table><thead><tr><th>${t("task")}</th><th>${t("taskName")}</th><th class="num">${t("sCreated")}</th><th class="num">${t("sCompleted")}</th><th class="num">${t("sOpen")}</th><th class="num">${t("sNotPosted")}</th><th class="num">${t("sOverdue")}</th></tr></thead><tbody>` +
    TASK_ORDER.map(c => { const p = sn.perTask[c] || {}; const z = x => x ? nf0.format(x) : `<span class="zero">0</span>`; return `<tr class="${TASK[c].flow.toLowerCase()}"><td><span class="flow ${TASK[c].flow}">${c}</span></td><td>${esc(tName(TASK[c]))}</td><td class="num">${z(p.created)}</td><td class="num">${z(p.completed)}</td><td class="num ${p.open ? "amb" : ""}">${z(p.open)}</td><td class="num ${p.notPosted ? "bad" : ""}">${z(p.notPosted)}</td><td class="num ${p.overdue ? "bad" : ""}">${z(p.overdue)}</td></tr>`; }).join("") + `</tbody></table></div>`;
  h += sec(t("sdTitle"), ACC.teal) + (d.docs.length ? `<div class="tblwrap"><table><thead><tr><th>${t("sdType")}</th><th>${t("upFile")}</th><th>${t("sdSignedBy")}</th><th>${t("upBy")}</th><th>${t("upWhen")}</th></tr></thead><tbody>` +
    d.docs.map(x => `<tr><td><b>${t("dt_" + x.doc_type)}</b></td><td><a href="/api/shift-docs/${x.id}/file">${esc(x.file_name)}</a></td><td>${esc(x.signed_by)}</td><td>${esc(x.uploaded_by || "")}</td><td class="muted">${esc(tsDate(x.uploaded_at))}</td></tr>`).join("") + `</tbody></table></div>` : `<p class="note">${t("sdNone")}</p>`);
  h += sec(t("itemsAccepted"), ACC.teal) + itemsTbl(d.accepted, [t("ackNote"), i => i.ack_note || ""]);
  h += sec(t("itemsRaised"), ACC.teal) + itemsTbl(d.created);
  h += sec(t("itemsClosed"), ACC.teal) + itemsTbl(d.closed);
  h += sec(t("shiftLog"), ACC.grey) + (d.events.length ? `<div class="tblwrap"><table><tbody>${d.events.map(e => `<tr><td class="muted">${esc(tsTime(e.ts))}</td><td><span class="pill ${e.type === "incident" ? "p-crit" : e.type.startsWith("break") ? "p-warn" : "p-none"}">${t("e_" + e.type)}</span></td><td class="wrapc">${esc(e.text)}</td><td class="muted">${esc(e.username || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">${t("noEvents")}</p>`);
  v.innerHTML = h;
  $("#bk").onclick = () => { S.opsView = "history"; renderView(); };
  $("#pr").onclick = () => window.print();
  const ro = $("#ro"); if (ro) ro.onclick = async () => { try { await api("POST", `/api/ops/shift/${id}/reopen`, {}); S.opsView = null; renderView(); } catch (e) { toast(e.message); } };
}

/* =========================================================== start */
async function start() {
  try {
    if (S.user && S.user.lang && !localStorage.getItem("scm.lang")) LANG = S.user.lang;
  } catch { }
  if (S.user && S.user.mustChange) { S.cfg = S.cfg || { settings: {}, counts: {}, defs: { tasks: [] } }; S.view = "account"; renderShell(); return; }
  await loadConfig(); await loadMasters(); await loadRows(); await loadOps();
  renderShell(); route();
}
(async function boot() {
  applyLang();
  try { S.pub = await api("GET", "/api/public"); } catch { S.pub = {}; }
  try { const me = await api("GET", "/api/me"); S.user = me.user; } catch { S.user = null; }
  if (S.user) await start(); else showLogin();
})();
})();
