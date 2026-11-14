'use strict';
// Makes a consistent copy of the database into data/backups/scm-YYYY-MM-DD_HHMM.db
// Usage: npm run backup      (schedule it daily with Windows Task Scheduler or cron)
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../src/config');
const { db } = require('../src/db');
const dir = path.join(cfg.DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const file = path.join(dir, `scm-${stamp}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log('Backup written:', file);
