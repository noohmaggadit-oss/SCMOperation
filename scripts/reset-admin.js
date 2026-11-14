'use strict';
// Emergency recovery: reset (or create) an administrator account.
// Usage:  npm run reset-admin -- <username> <new-password>
const { db, audit } = require('../src/db');
const auth = require('../src/auth');
const [username = 'admin', password] = process.argv.slice(2);
if (!password) { console.log('Usage: npm run reset-admin -- <username> <new-password>'); process.exit(1); }
const p = auth.passwordProblem(password); if (p) { console.log(p); process.exit(1); }
const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (u) db.prepare("UPDATE users SET pass_hash=?, role='admin', active=1, must_change=1 WHERE id=?").run(auth.hashPassword(password), u.id);
else db.prepare("INSERT INTO users(username, display_name, role, pass_hash, must_change) VALUES (?, 'Administrator', 'admin', ?, 1)").run(username, auth.hashPassword(password));
db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(username);
audit(null, 'admin_reset_cli', username);
console.log(`Administrator "${username}" is ready. Sign in and you will be asked to change the password.`);
