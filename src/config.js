'use strict';
// Configuration – read from environment variables (or a .env file in the project root).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (KEY=VALUE lines, # comments) – no dependency needed.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

module.exports = {
  ROOT,
  PORT: Number(env('PORT', 3000)),
  HOST: env('HOST', '0.0.0.0'),                       // 0.0.0.0 = reachable from phones/tablets on the same network
  DATA_DIR: path.resolve(ROOT, env('DATA_DIR', 'data')),
  APP_NAME: env('APP_NAME', 'SCM IN / OUT Operations'),
  ADMIN_USERNAME: env('ADMIN_USERNAME', 'admin'),
  ADMIN_PASSWORD: env('ADMIN_PASSWORD', ''),          // used only when the database has no users yet
  SESSION_HOURS: Number(env('SESSION_HOURS', 12)),
  REMEMBER_DAYS: Number(env('REMEMBER_DAYS', 30)),
  COOKIE_SECURE: env('COOKIE_SECURE', 'auto'),        // auto | true | false
  TRUST_PROXY: env('TRUST_PROXY', 'false') === 'true',// true when running behind Nginx / Caddy / IIS / Cloudflare
  HTTPS_KEY: env('HTTPS_KEY', ''),                    // optional: path to key.pem to serve HTTPS directly
  HTTPS_CERT: env('HTTPS_CERT', ''),                  // optional: path to cert.pem
  MAX_UPLOAD_MB: Number(env('MAX_UPLOAD_MB', 25)),
  KEEP_UPLOAD_FILES: env('KEEP_UPLOAD_FILES', 'true') === 'true',
};
