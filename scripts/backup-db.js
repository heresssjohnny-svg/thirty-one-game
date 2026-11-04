#!/usr/bin/env node
// scripts/backup-db.js - Backup of data.sqlite (accounts + lifetime ledger)
//
// Makes a consistent copy of the live database (SQLite "VACUUM INTO", safe
// while the game server is running and writing), checks the copy with
// PRAGMA integrity_check, gzips it into the backup folder and prunes old ones.
//
//   node scripts/backup-db.js              nightly run (cron, installed by deploy.sh)
//   node scripts/backup-db.js --tag deploy  run by deploy.sh before every restart
//   node scripts/backup-db.js --email-now   also email this backup right away
//   node scripts/backup-db.js --list        show the backups on disk
//
// Backups go to ~/blitz31-backups (outside the repo, so deploys never touch
// them) as data-YYYY-MM-DD_HHMM-<tag>.sqlite.gz. Kept: the newest 14 nightly
// and the newest 5 deploy backups.
//
// Off-server copy: once a week (Sunday) the nightly backup is emailed as an
// attachment to SMTP_EMAIL, using the same Gmail account that sends password
// reset codes. Settings (in .env, all optional):
//   BACKUP_DIR=/root/blitz31-backups
//   BACKUP_KEEP=14                 nightly backups to keep
//   BACKUP_EMAIL_TO=you@example.com   default: SMTP_EMAIL
//   BACKUP_EMAIL_DAYS=0            days to email (0=Sun..6=Sat, comma list), 'daily' or 'off'
//
// RESTORE (on the server):
//   pm2 stop blitz31
//   cd ~/thirty-one-game && mv data.sqlite data.sqlite.broken && rm -f data.sqlite-wal data.sqlite-shm
//   gunzip -c ~/blitz31-backups/<file>.sqlite.gz > data.sqlite
//   pm2 start blitz31

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.BACKUP_DB_PATH || path.join(ROOT, 'data.sqlite');

// .env + SMTP settings (server/config.js loads dotenv); never fatal for the backup itself
let config = {};
try { config = require(path.join(ROOT, 'server', 'config')); } catch (e) {
    try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (e2) {}
}

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const TAG = (argVal('--tag') || 'nightly').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'nightly';
const BACKUP_DIR = argVal('--dir') || process.env.BACKUP_DIR || path.join(os.homedir(), 'blitz31-backups');
const KEEP = { nightly: Number(process.env.BACKUP_KEEP) > 0 ? Number(process.env.BACKUP_KEEP) : 14, deploy: 5 };
const EMAIL_TO = process.env.BACKUP_EMAIL_TO || config.SMTP_EMAIL || process.env.SMTP_EMAIL || '';
const EMAIL_DAYS = String(process.env.BACKUP_EMAIL_DAYS || '0').trim().toLowerCase();

const log = (msg) => console.log(`[backup ${new Date().toISOString()}] ${msg}`);
const pad = (n) => String(n).padStart(2, '0');

function stamp(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter(f => /^data-\d{4}-\d{2}-\d{2}_\d{4}-[a-z0-9]+\.sqlite\.gz$/.test(f))
        .map(f => ({ file: f, tag: f.replace(/^.*-([a-z0-9]+)\.sqlite\.gz$/, '$1'), full: path.join(BACKUP_DIR, f), size: fs.statSync(path.join(BACKUP_DIR, f)).size }))
        .sort((a, b) => a.file.localeCompare(b.file));
}

function prune() {
    const removed = [];
    const byTag = {};
    listBackups().forEach(b => { (byTag[b.tag] = byTag[b.tag] || []).push(b); });
    Object.keys(byTag).forEach(tag => {
        const keep = KEEP[tag] || KEEP.nightly;
        const list = byTag[tag];
        list.slice(0, Math.max(0, list.length - keep)).forEach(b => { fs.unlinkSync(b.full); removed.push(b.file); });
    });
    return removed;
}

function shouldEmail(now) {
    if (args.includes('--email-now')) return true;
    if (args.includes('--no-email') || TAG !== 'nightly') return false;
    if (EMAIL_DAYS === 'off' || EMAIL_DAYS === 'none' || EMAIL_DAYS === '') return false;
    if (EMAIL_DAYS === 'daily') return true;
    return EMAIL_DAYS.split(',').map(s => Number(s.trim())).includes(now.getDay());
}

async function emailBackup(file, info) {
    if (!EMAIL_TO) throw new Error('no BACKUP_EMAIL_TO / SMTP_EMAIL set');
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: config.SMTP_EMAIL || process.env.SMTP_EMAIL, pass: String(config.SMTP_PASSWORD || process.env.SMTP_PASSWORD || '') }
    });
    await transporter.sendMail({
        from: `"Blitz 31 Backups" <${config.SMTP_EMAIL || process.env.SMTP_EMAIL}>`,
        to: EMAIL_TO,
        subject: `Blitz 31 database backup ${path.basename(file)}`,
        text: `Weekly off-server copy of the Blitz 31 database.\n\n` +
            `File: ${path.basename(file)} (${(info.size / 1024).toFixed(1)} KB gzipped)\n` +
            `Accounts: ${info.users}   Ledger rows: ${info.ledger}\n\n` +
            `Keep this email: it is the copy you need if the server is ever lost.\n` +
            `Restore steps are at the top of scripts/backup-db.js.\n`,
        attachments: [{ filename: path.basename(file), path: file }]
    });
}

async function main() {
    if (args.includes('--list')) {
        const all = listBackups();
        all.forEach(b => console.log(`${b.file}  ${(b.size / 1024).toFixed(1)} KB`));
        console.log(`${all.length} backup(s) in ${BACKUP_DIR}`);
        return;
    }

    if (!fs.existsSync(DB_PATH)) throw new Error(`database not found: ${DB_PATH}`);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const now = new Date();
    const base = path.join(BACKUP_DIR, `data-${stamp(now)}-${TAG}`);
    const tmp = `${base}.sqlite.tmp`;
    const out = `${base}.sqlite.gz`;
    try { fs.unlinkSync(tmp); } catch (e) {}

    // 1. Consistent snapshot of the live database (works while the server is writing)
    const src = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
        src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
        src.close();
    }

    // 2. Check the copy before trusting it
    let info;
    const chk = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
        const integrity = chk.prepare('PRAGMA integrity_check').get();
        const result = integrity && (integrity.integrity_check || Object.values(integrity)[0]);
        if (result !== 'ok') throw new Error(`integrity_check failed: ${result}`);
        const count = (table) => { try { return chk.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch (e) { return '?'; } };
        info = { users: count('users'), ledger: count('lifetime_ledger') };
    } finally {
        chk.close();
    }

    // 3. Compress, then drop the uncompressed copy
    fs.writeFileSync(out, zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }));
    fs.unlinkSync(tmp);
    info.size = fs.statSync(out).size;
    log(`OK ${path.basename(out)} (${(info.size / 1024).toFixed(1)} KB, ${info.users} accounts, ${info.ledger} ledger rows)`);

    const removed = prune();
    if (removed.length) log(`pruned ${removed.length}: ${removed.join(', ')}`);

    // 4. Weekly off-server copy by email
    if (shouldEmail(now)) {
        try {
            await emailBackup(out, info);
            log(`emailed to ${EMAIL_TO}`);
        } catch (e) {
            log(`WARN email failed: ${e.message}`);   // the local backup is still good
        }
    }
}

main().catch(err => {
    log(`FAILED ${err && err.message ? err.message : err}`);
    process.exit(1);
});
