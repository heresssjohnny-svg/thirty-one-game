// server/safety.js - block and report players.
//   GET  /api/safety/blocks              -> { blocked: [{ name, at }] }
//   POST /api/safety/block   {username}  -> blocks (by username, case-insensitive). Also ends any friendship / pending requests.
//   POST /api/safety/unblock {username}
//   POST /api/safety/report  {username, reason, details, block}  -> files a report for the admins (with that player's
//        recent chat lines from the reporter's table) and pushes a notification to admins.
//   GET  /api/admin/reports?status=open|resolved|dismissed|all   (admin token)
//   POST /api/admin/reports/:id {status, note}                   (admin token)
// Blocking is mostly applied on the blocker's device (chat, reactions, soundboard, recorded cues, voice are hidden/muted
// there - see public/js/safety.js). The server also drops emotes thrown by/at a blocker and friend requests from a
// blocked player. Exports { router, hasBlocked, blockedNames }
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

const sql = typeof db.prepare === 'function' ? db : db.db;
sql.exec(`CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT NOT NULL, blocked_name TEXT NOT NULL, blocked_id TEXT, display TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_name));
  CREATE INDEX IF NOT EXISTS idx_user_blocks_name ON user_blocks(blocked_name);
  CREATE TABLE IF NOT EXISTS user_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id TEXT NOT NULL, reporter_name TEXT, reported_name TEXT NOT NULL,
  reported_id TEXT, reason TEXT NOT NULL, details TEXT, lobby_code TEXT, chat TEXT, status TEXT NOT NULL DEFAULT 'open',
  admin_note TEXT, created_at INTEGER NOT NULL, handled_at INTEGER, handled_by TEXT);
  CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status, created_at);`);

const REASONS = { abuse: 'Abusive or hateful chat/voice', cheating: 'Cheating or teaming up', debt: 'Not paying what they owe',
    name: 'Offensive username', spam: 'Spam or flooding', other: 'Something else' };
const MAX_BLOCKS = 300;

function isGuestId(id) { return !id || String(id).startsWith('gst_') || String(id).startsWith('usr_guest_'); }
function decode(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    if (!/^Bearer\s+\S+/.test(h)) return null;
    try { return jwt.verify(h.split(/\s+/)[1], config.JWT_SECRET); } catch (e) { return null; }
}
function uidOf(req) {
    const d = decode(req); const id = d && (d.userId || d.id);
    if (!id || d.isAdmin || d.guest || isGuestId(id)) return null;
    return String(id);
}
function adminOf(req) {
    const d = decode(req);
    if (!d || !d.isAdmin) return null;
    if (d.userId) {
        const r = sql.prepare('SELECT is_admin FROM users WHERE id = ?').get(String(d.userId));
        if (!r || Number(r.is_admin) !== 1) return null;
    }
    return d.username || 'admin';
}
const hits = new Map();
function limited(key, max, windowMs) {
    const now = Date.now(); let r = hits.get(key);
    if (!r || now > r.reset) { r = { n: 0, reset: now + windowMs }; hits.set(key, r); }
    r.n++; if (hits.size > 5000) hits.clear(); return r.n > max;
}
const cleanName = (s) => String(s || '').trim().slice(0, 40);
const nameOfId = (id) => { const r = sql.prepare('SELECT username FROM users WHERE id = ?').get(String(id)); return r ? r.username : null; };
const idOfName = (n) => { const r = sql.prepare("SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) AND (provider IS NULL OR provider != 'guest') LIMIT 1").get(n); return r || null; };

function blockedNames(userId) {
    if (!userId || isGuestId(userId)) return new Set();
    try { return new Set(sql.prepare('SELECT blocked_name FROM user_blocks WHERE blocker_id = ?').all(String(userId)).map(r => r.blocked_name)); }
    catch (e) { return new Set(); }
}
function hasBlocked(blockerId, name) {
    if (!blockerId || !name || isGuestId(blockerId)) return false;
    try { return !!sql.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_name = ?').get(String(blockerId), String(name).toLowerCase()); }
    catch (e) { return false; }
}
function listBlocks(uid) {
    return sql.prepare('SELECT COALESCE(display, blocked_name) AS name, created_at AS at FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC').all(uid);
}

function lobbiesMap() { try { return require('./game/lobbyManager').lobbies || {}; } catch (e) { return {}; } }
// Tell the blocker's open sockets so other tabs/devices update at once.
function pingSockets(uid, msg) {
    const body = JSON.stringify(msg);
    Object.values(lobbiesMap()).forEach(l => {
        [...(l.players || []).map(p => p && p.id), ...(l.spectators || []).map(s => s && s.idSocket)].forEach(ws => {
            if (ws && ws.readyState === 1 && String(ws.userId) === uid) { try { ws.send(body); } catch (e) {} }
        });
    });
}

function doBlock(uid, rawName) {
    const name = cleanName(rawName);
    if (!name) return { error: 'Pick a player.' };
    const me = nameOfId(uid);
    if (me && me.toLowerCase() === name.toLowerCase()) return { error: 'You cannot block yourself.' };
    const n = sql.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = ?').get(uid).n;
    const target = idOfName(name);
    const exists = sql.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_name = ?').get(uid, name.toLowerCase());
    if (!exists && n >= MAX_BLOCKS) return { error: 'Your block list is full. Unblock someone first.' };
    sql.prepare('INSERT OR REPLACE INTO user_blocks (blocker_id, blocked_name, blocked_id, display, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(uid, name.toLowerCase(), target ? String(target.id) : null, target ? target.username : name, Date.now());
    if (target) {
        const t = String(target.id);
        try {
            sql.prepare('DELETE FROM friendships WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)').run(uid, t, t, uid);
            sql.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(uid, t, t, uid);
        } catch (e) {}
    }
    return { ok: true };
}

// Recent chat lines by that player at the reporter's table (evidence for the admins).
function evidence(uid, reportedName) {
    const want = reportedName.toLowerCase();
    for (const l of Object.values(lobbiesMap())) {
        if (!l) continue;
        const here = (l.players || []).some(p => p && p.id && String(p.id.userId) === uid) ||
                     (l.spectators || []).some(s => s && s.idSocket && String(s.idSocket.userId) === uid);
        if (!here) continue;
        const lines = (l.chatHistory || []).filter(m => String(m.user || m.username || '').toLowerCase() === want)
            .slice(-15).map(m => String(m.text || m.message || '').slice(0, 200));
        return { code: l.code || null, lines };
    }
    return { code: null, lines: [] };
}

function notifyAdmins(text) {
    try {
        const push = require('./push');
        if (!push || !push.sendToUser) return;
        sql.prepare('SELECT id FROM users WHERE is_admin = 1').all().forEach(r =>
            push.sendToUser(r.id, { title: 'Blitz 31 🚩 New report', body: text, url: '/admin.html', tag: 'report' }, { kind: 'report' }));
    } catch (e) {}
}

const router = express.Router();

router.get('/safety/blocks', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in first.' });
    res.set('Cache-Control', 'no-store');
    res.json({ blocked: listBlocks(uid) });
});
router.post('/safety/block', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in to block players.' });
    if (limited('b:' + uid, 30, 60000)) return res.status(429).json({ error: 'Slow down a little.' });
    const r = doBlock(uid, req.body && req.body.username);
    if (r.error) return res.status(400).json(r);
    const blocked = listBlocks(uid);
    pingSockets(uid, { type: 'BLOCKS_CHANGED', blocked: blocked.map(b => b.name) });
    res.json({ ok: true, blocked });
});
router.post('/safety/unblock', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in first.' });
    const name = cleanName(req.body && req.body.username).toLowerCase();
    sql.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_name = ?').run(uid, name);
    const blocked = listBlocks(uid);
    pingSockets(uid, { type: 'BLOCKS_CHANGED', blocked: blocked.map(b => b.name) });
    res.json({ ok: true, blocked });
});
router.post('/safety/report', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in to report players.' });
    if (limited('r:' + uid, 6, 3600000)) return res.status(429).json({ error: 'You have sent a lot of reports. Try again later.' });
    const b = req.body || {};
    const name = cleanName(b.username);
    const reason = REASONS[b.reason] ? String(b.reason) : null;
    if (!name) return res.status(400).json({ error: 'Pick a player.' });
    if (!reason) return res.status(400).json({ error: 'Pick a reason.' });
    const me = nameOfId(uid) || '';
    if (me.toLowerCase() === name.toLowerCase()) return res.status(400).json({ error: 'You cannot report yourself.' });
    const recent = sql.prepare("SELECT 1 FROM user_reports WHERE reporter_id = ? AND LOWER(reported_name) = LOWER(?) AND status = 'open' AND created_at > ?")
        .get(uid, name, Date.now() - 10 * 60000);
    const target = idOfName(name);
    if (!recent) {
        const ev = evidence(uid, name);
        sql.prepare('INSERT INTO user_reports (reporter_id, reporter_name, reported_name, reported_id, reason, details, lobby_code, chat, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(uid, me, target ? target.username : name, target ? String(target.id) : null, reason, String(b.details || '').trim().slice(0, 500) || null,
                ev.code, ev.lines.length ? JSON.stringify(ev.lines) : null, Date.now());
        notifyAdmins(`${me || 'A player'} reported ${target ? target.username : name}: ${REASONS[reason]}`);
    }
    let blocked = null;
    if (b.block) { const r = doBlock(uid, name); if (r.ok) { blocked = listBlocks(uid); pingSockets(uid, { type: 'BLOCKS_CHANGED', blocked: blocked.map(x => x.name) }); } }
    res.json({ ok: true, blocked });
});

router.get('/admin/reports', (req, res) => {
    if (!adminOf(req)) return res.status(403).json({ error: 'Admin only.' });
    const st = String(req.query.status || 'open');
    const rows = st === 'all'
        ? sql.prepare('SELECT * FROM user_reports ORDER BY created_at DESC LIMIT 200').all()
        : sql.prepare('SELECT * FROM user_reports WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(st);
    const counts = {}; sql.prepare('SELECT status, COUNT(*) AS n FROM user_reports GROUP BY status').all().forEach(r => { counts[r.status] = r.n; });
    const totals = {};
    sql.prepare('SELECT LOWER(reported_name) AS k, COUNT(DISTINCT reporter_id) AS n FROM user_reports GROUP BY LOWER(reported_name)').all().forEach(r => { totals[r.k] = r.n; });
    const blocks = {};
    sql.prepare('SELECT blocked_name AS k, COUNT(*) AS n FROM user_blocks GROUP BY blocked_name').all().forEach(r => { blocks[r.k] = r.n; });
    res.set('Cache-Control', 'no-store');
    res.json({ counts, reasons: REASONS, reports: rows.map(r => ({
        id: r.id, reporter: r.reporter_name, reported: r.reported_name, reportedId: r.reported_id, reason: r.reason, reasonText: REASONS[r.reason] || r.reason,
        details: r.details, table: r.lobby_code, chat: r.chat ? (() => { try { return JSON.parse(r.chat); } catch (e) { return []; } })() : [],
        status: r.status, note: r.admin_note, at: r.created_at, handledAt: r.handled_at, handledBy: r.handled_by,
        reportersTotal: totals[String(r.reported_name).toLowerCase()] || 1, blockedBy: blocks[String(r.reported_name).toLowerCase()] || 0
    })) });
});
router.post('/admin/reports/:id', (req, res) => {
    const who = adminOf(req); if (!who) return res.status(403).json({ error: 'Admin only.' });
    const st = String((req.body && req.body.status) || '');
    if (!['open', 'resolved', 'dismissed'].includes(st)) return res.status(400).json({ error: 'Bad status.' });
    const note = String((req.body && req.body.note) || '').slice(0, 500) || null;
    const r = sql.prepare('UPDATE user_reports SET status = ?, admin_note = COALESCE(?, admin_note), handled_at = ?, handled_by = ? WHERE id = ?')
        .run(st, note, st === 'open' ? null : Date.now(), st === 'open' ? null : who, Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: 'Report not found.' });
    res.json({ ok: true });
});

function openReportCount() { try { return sql.prepare("SELECT COUNT(*) AS n FROM user_reports WHERE status = 'open'").get().n; } catch (e) { return 0; } }

module.exports = { router, hasBlocked, blockedNames, openReportCount, REASONS };
