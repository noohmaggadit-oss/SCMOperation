# SCM IN / OUT Operations – Web Application

A web app for the daily IN / OUT warehouse and production tasks:

- **Users and roles**: Admin, MIS, Shift In-Charge and Viewer, with optional read-only guest access.
- **Daily Excel uploads**: MIS users upload the IN / OUT Excel templates, and the newest file updates older rows.
- **Live reports**: KPI dashboard, daily report, general log, data checks and KPI guide, in English and Arabic (right-to-left).
- **Any device**: works on desktops, iPhones, iPads and Android phones/tablets, and can be added to the home screen like an app.

It has **no dependencies**: only Node.js is needed, with no `npm install` and nothing to compile. The database is SQLite, which is built into Node.js and stored in one file at `data/scm.db`.

---

## 1. Run it on your computer (VS Code)

1. Install **Node.js LTS** (version **22.13 or newer**) from https://nodejs.org. Restart VS Code afterwards.
2. Unzip this folder and open it in VS Code with **File → Open Folder…**.
3. Optional: copy `.env.example` to `.env` and set `ADMIN_PASSWORD` (at least 8 characters, with letters and numbers).
4. Start the app in one of these ways:
   - Press **F5** and choose **Run SCM app**.
   - Open **Terminal → New Terminal** and type `npm start`.
5. The terminal shows the addresses, for example:
   ```
   On this computer:      http://localhost:3000
   From phones / tablets:  http://192.168.1.25:3000
   ```
6. Open `http://localhost:3000` and sign in as **admin**:
   - The password is the one in `.env`.
   - If you left it empty, a random password was printed in the terminal on first start.
   - You are asked to set your own password straight away.

Developer tip: `npm run dev` restarts the server automatically when you save a file.

## 2. Roles

| Role | Can do |
|---|---|
| **Admin** | Everything: create, disable and delete users, reset passwords, change roles; change targets, SLA hours, transaction codes and numbering; delete an upload; clear all data; see the audit log; upload files; all reports. |
| **MIS** | Upload the daily IN / OUT Excel files, attach shift documents, see the upload history, download uploaded files, and use all reports and the CSV export. |
| **Shift In-Charge** | Runs the **Operations Room**: Start / End of Day, Start / End of Shift, handover items, shift log. Attaches the shift's **signed forms, WIF documents and SAP Business One layouts** in **Upload → Shift documents**. All reports. Cannot upload the IN / OUT Excel. |
| **Viewer** | All reports (Dashboard, Daily report, General log, Data checks, KPI guide) and the CSV export. Cannot change data. |
| **Guest** | Only if the Admin turns on **Settings → Guest access**: views reports without signing in. No export, no changes. |

Notes:
- New users get a temporary password and must change it at first sign-in.
- If an MIS file contains a Task Master sheet, it is ignored: only an Admin's upload can change SLA targets.

## 3. Daily routine

1. **MIS** opens **Upload** and downloads the English or Arabic template. The templates are also in the `templates/` folder.
2. Fill one row per document line in the **Transactions** sheet.
3. In **Upload**, drop or select the file. The app shows a check first: rows found, dates, sample rows ignored and unknown task codes.
4. Press **Upload to server**. Each row is matched on Task + Document No. + Item + Batch:
   - new rows are added;
   - changed rows are updated;
   - identical rows are counted as unchanged.

   This means you can re-upload the same running file every day.
5. Everyone sees the new figures straight away on the Dashboard and in the Daily report.

Rows whose **Remarks** contain "SAMPLE" or "عينة" are ignored.

## 3a. Operations Room – shift handover

The **Operations Room** page runs the 24-hour routine. It assumes two 12-hour shifts, each with 10 working hours and a 2-hour break; the admin can change the shifts in **Settings → Shifts**. The operational day starts when the first shift starts, so a night shift that ends at 07:00 belongs to the day it started.

| Step | Who | What the app enforces |
|---|---|---|
| **① Start of Day** | First Shift In-Charge | A checklist: previous day’s summary reviewed, systems working, wall screen on, staff present. The app warns if the previous day was never closed. |
| **② Start of Shift** | Incoming shift lead | Reads the **handover pack** from the previous shift (who handed over, notes, frozen figures). Must **accept every open handover item**, with an optional comment, then complete the checklist. A shift can’t start while another shift is still open. |
| During the shift | Shift team | **Handover items**: what the next shift must know or do, linked to a task and document number, with priority and status (open, in progress, blocked, done). Closing an item requires a note on how it was resolved. **Shift log**: notes, break start/end, incidents. |
| **③ End of Shift** | Outgoing shift lead | Checklist (file uploaded, not-posted documents followed up, items updated, breaks covered, room handed over), notes, and the **incoming lead’s name**. The shift’s figures per task are frozen: documents raised, completed, open, not posted in SAP, overdue. |
| **④ End of Day** | Last shift lead | Only possible once every shift of the day is closed. Checklist, notes and a frozen day summary. |

**Shift documents.** In **Upload → Shift documents**, attach each shift's files (PDF, photo, Excel or Word) with their type: *WIF document*, *SAP Business One layout*, *Signed handover / takeover form* (who signed is required) or *Other signed form*. After every Excel upload the app checks whether the current shift has its WIF document, SAP B1 layout and signed form, and lists what is missing. At End of Shift these three checklist items are ticked **automatically** from the attachments; if one is missing, End of Shift needs an explanation in the notes. Once a shift is closed only an admin can add or remove its documents. Files are kept in `data/shift-docs/`.

**Transaction forms.** Every completed document (task + document no.) needs its signed form. In **Upload → Transaction forms**, drop many files at once: a file whose name contains the document number (e.g. `MRN-WH1-0042.pdf` for `MRN/WH1/0042`) is matched automatically, the rest you pick from a list. The page lists every completed document still without a form, with an **Attach form** button. After each Excel upload the app reports which completed documents in the file have no form. **Data checks → Completed without signed form** and the **Form** column of the General log show the status; click ✔ to download a document's forms. At End of Shift the item *Signed forms uploaded for every document completed this shift* is ticked automatically; if any are missing, End of Shift needs an explanation in the notes. Files are kept in `data/doc-forms/`.

**Early takeover.** If a shift is handed over before its planned end (e.g. Shift A closes at 18:10), the next shift of the same day can start at once instead of waiting for 19:00; its figures count from the real start time. After the last shift of the day, do End of Day; the next day's first shift starts at its planned time.

**Checklists.** Start of Shift: summary reviewed, dashboard data viewed, shift staff present, takeover. End of Shift: IN / OUT file uploaded, WIF document uploaded, SAP B1 layout uploaded, forms signed between shifts, not-posted documents followed up, handover items updated, handover.

Rules that apply to every step:
- Every checklist item must be ticked. If one isn’t, a written explanation is required in the notes.
- Every step is recorded in the **audit log**.
- **History** lists each day and shift. Open any shift’s **report** to see its checklists, notes, figures per task, items accepted, raised and closed, and the shift log. The report is printable.
- Admins can **reopen** a shift that was closed by mistake.
- Only the Shift In-Charge and Admin can act; MIS users and viewers can see everything on the page.
- Everyone sees the current shift status in a strip at the top of the Dashboard.

> Testing only: setting the environment variable `OPS_TEST_NOW=2026-11-12T19:05` fixes the clock used by the shift module. Never set it in production.

## 4. Use it on iPhone, iPad and Android

Use **any** of the options below, on the same network as the computer running the app:

- Open the "From phones / tablets" address shown in the terminal, e.g. `http://192.168.1.25:3000`.
- **iPhone / iPad (Safari):** tap **Share → Add to Home Screen**. It opens full-screen like an app.
- **Android (Chrome):** tap the **⋮ menu → Add to Home screen / Install app**.

If a phone cannot connect:
- **Windows Firewall** must allow Node.js on private networks. Accept the prompt the first time, or add an inbound rule for TCP port 3000.
- The computer must stay on, with the app running (see section 5).

## 5. Keep it running and reach it from outside the office

The app must run on a machine that stays on. Choose one option:

| Option | When | How |
|---|---|---|
| **A. Office PC / server (LAN only)** | Users are on the company network or Wi-Fi | Run it as a Windows service with **NSSM** (https://nssm.cc): `nssm install SCMApp "C:\Program Files\nodejs\node.exe" "C:\scm-app\server.js"`, set the *Startup directory* to the app folder, then `nssm start SCMApp`. |
| **B. Office server + secure internet access** | Managers need it on mobile data | Put **HTTPS** in front: **Cloudflare Tunnel** (free, no router changes), **IIS** with URL Rewrite/ARR, or **Caddy** (`caddy reverse-proxy --from scm.yourcompany.com --to localhost:3000`). Set `TRUST_PROXY=true` in `.env`. |
| **C. Cloud VM / container** | No server in the office | Use the included `Dockerfile` (`docker build -t scm-app .` and `docker run -d -p 3000:3000 -v scm-data:/app/data scm-app`), or any Linux VM with Node.js 22+. Put HTTPS in front, as in option B. |

> Always use **HTTPS** when the app is reachable from the internet, so passwords are never sent in plain text. On HTTPS, cookies are automatically marked *Secure*.

## 6. Backups

- `npm run backup` writes a safe copy of the database to `data/backups/`.
  - Windows: schedule it daily with **Task Scheduler**, action `npm run backup`, *Start in* = the app folder.
- Also back up the `data/uploads/` folder (original Excel files) `data/shift-docs/` (shift documents) and `data/doc-forms/` (transaction forms).
- To move the app to another machine, copy the whole folder, including `data/`.

## 7. Forgotten admin password

Run this in the app folder:
```
npm run reset-admin -- admin NewPassw0rd
```
The account is re-enabled as an admin and must change its password at the next sign-in.

## 8. Security

- **Passwords:** hashed with **scrypt** and never stored in plain text.
- **Sessions:**
  - random tokens in **HttpOnly, SameSite** cookies; only a hash of the token is stored;
  - 12 hours by default, or 30 days with "Keep me signed in";
  - changing your own password signs out your other devices;
  - an admin's password reset or role change ends that user's sessions.
- **Login throttling:** 5 failed attempts lock that username + IP for 5 minutes.
- **Requests from other sites are blocked:** every change needs a header the app's own page adds, and requests from another site's origin are refused.
- **Security headers:** strict Content-Security-Policy, X-Frame-Options, nosniff and others.
- **Roles are enforced on the server for every request**, not just hidden in the menu.
- **Audit log:** sign-ins, failed sign-ins, uploads, deletions, user changes, settings changes and exports.

## 9. Project structure (data model)

```
server.js            HTTP server, routing, security headers, static files
src/config.js        settings from .env
src/db.js            SQLite schema (tables below)
src/auth.js          passwords, sessions, login throttling, first admin
src/api.js           REST API with role checks
src/ops.js           Operations Room: days, shifts, handover items, shift log, snapshots
src/defs.json        18 IN/OUT tasks, transaction codes, flow KPIs, KPI catalogue (EN/AR)
public/              the web app (index.html, app.js, app.css, i18n.js, xlsx.js, icons, manifest)
templates/           Excel templates (English + Arabic)
scripts/             reset-admin.js, backup.js
data/                database + uploaded files (created automatically – keep it backed up)
```

| Table | Holds |
|---|---|
| `users` | username, name, role (admin / mis / viewer), password hash, active, must-change flag, language |
| `sessions` | signed-in devices (token hash, expiry) |
| `uploads` | each uploaded file: who, when, rows new / updated / unchanged / rejected, date range |
| `transactions` | one row per document line, keyed by task + document no. + item + batch, linked to the upload that last wrote it |
| `items`, `warehouses` | masters (refreshed by uploads that contain the Item / Warehouse Master sheets) |
| `task_master` | per-task SLA, transaction code and numbering warehouse, from an admin upload or Settings |
| `settings` | targets, thresholds, guest access, flow KPI targets |
| `op_days`, `op_shifts` | Start / End of Day and Start / End of Shift, with checklists, notes, who, when and frozen snapshots |
| `handover_items`, `handover_acks`, `shift_events` | task handover items, which shift accepted each item, and the shift log |
| `doc_forms` | signed forms per document (task + document no.): file, who signed, who uploaded, when, in which shift |
| `shift_docs` | documents attached to a shift: type, file, who signed, who uploaded, when |
| `audit` | who did what, and when |

**API overview** (all JSON; `minRole` is checked on the server):
- **Public:** `POST /api/login`, `POST /api/logout`, `GET /api/me`.
- **Guest and up:** `GET /api/config`, `GET /api/rows?from=&to=`, `GET /api/masters`.
- **Viewer and up:** `GET /api/export.csv`, `POST /api/me/password`.
- **MIS and up:** `POST /api/uploads`, `GET /api/uploads`, `GET /api/uploads/:id/file`.
- **Operations Room:** `GET /api/ops/state`, `/api/ops/history` and `/api/ops/shift/:id` (viewer and up); `POST /api/ops/day/start|end`, `/api/ops/shift/start|end`, `/api/ops/items`, `/api/ops/events` (Shift In-Charge, admin); `GET /api/shift-docs`, `/api/shift-docs/:id/file` (viewer and up); `POST /api/shift-docs`, `DELETE /api/shift-docs/:id` (MIS, Shift In-Charge, admin); `GET /api/doc-forms`, `/api/doc-forms/docs`, `/api/doc-forms/:id/file` (viewer and up); `POST /api/doc-forms`, `DELETE /api/doc-forms/:id` (MIS, Shift In-Charge, admin); `POST /api/ops/shift/:id/reopen` (admin).
- **Admin:** `/api/users` (create, update, reset password, delete), `PUT /api/settings`, `PUT /api/task-master/:code`, `DELETE /api/uploads/:id`, `GET /api/audit`, `POST /api/admin/clear-transactions`.

When the data grows very large (hundreds of thousands of rows, many simultaneous users), the same API can be moved to PostgreSQL or SQL Server. The tables above map one-to-one.
