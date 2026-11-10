// server/cues.js - Premium recorded cues: a player records their own knock call and winner cue (≤4 s).
//   POST   /api/cues/:kind   (kind = knock | win)  raw audio body (≤300 KB), Bearer JWT, Premium/admin
//   DELETE /api/cues/:kind
//   GET    /api/cues/mine    -> { knock: {token, mime}|null, win: ... }
//   GET    /api/cue/:token   -> the audio (any signed-in player; tokens are random and change on every upload)
// Stored in SQLite (survives deploys and is in the nightly backup). The snapshot only carries the token,
// never the owner's user id. Exports { router, cueFor }
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { statusFor } = require('./premium');

const sql = typeof db.prepare === 'function' ? db : db.db;
sql.exec(`CREATE TABLE IF NOT EXISTS user_cues (
  user_id TEXT NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_cues_token ON user_cues(token);`);

const KINDS = ['knock', 'win'];
const MAX_BYTES = 300 * 1024;
const MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav', 'audio/x-wav'];

function uidOf(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    if (!/^Bearer\s+\S+/.test(h)) return null;
    try {
        const d = jwt.verify(h.split(/\s+/)[1], config.JWT_SECRET);
        const id = d && (d.userId || d.id);
        if (!id || d.guest || String(id).startsWith('gst_') || String(id).startsWith('usr_guest_')) return null;
        return String(id);
    } catch (e) { return null; }
}
const hits = new Map();
function limited(key, max) {
    const now = Date.now(); let r = hits.get(key);
    if (!r || now > r.reset) { r = { n: 0, reset: now + 60000 }; hits.set(key, r); }
    r.n++; if (hits.size > 5000) hits.clear(); return r.n > max;
}
function cueFor(uid, kind) {
    if (!uid || !KINDS.includes(kind)) return null;
    try { const r = sql.prepare('SELECT token, mime FROM user_cues WHERE user_id = ? AND kind = ?').get(String(uid), kind); return r || null; } catch (e) { return null; }
}

const router = express.Router();
const raw = typeof express.raw === 'function' ? express.raw({ type: () => true, limit: MAX_BYTES }) : (req, res, next) => next();

router.get('/cues/mine', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in first.' });
    res.set('Cache-Control', 'no-store');
    res.json({ knock: cueFor(uid, 'knock'), win: cueFor(uid, 'win') });
});
router.post('/cues/:kind', raw, (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in first.' });
    if (limited('up:' + uid, 10)) return res.status(429).json({ error: 'Too many uploads, try again in a minute.' });
    if (!statusFor(uid).premium) return res.status(403).json({ error: 'Recorded cues are Premium.' });
    const kind = String(req.params.kind || '');
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown cue.' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!MIMES.includes(mime)) return res.status(415).json({ error: 'Unsupported audio format.' });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length < 200) return res.status(400).json({ error: 'Recording is empty.' });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'Recording is too long.' });
    const token = crypto.randomBytes(12).toString('hex');
    sql.prepare(`INSERT INTO user_cues (user_id, kind, token, mime, data, updated_at) VALUES (?,?,?,?,?,?)
                 ON CONFLICT(user_id, kind) DO UPDATE SET token = excluded.token, mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`)
        .run(uid, kind, token, mime, buf, Date.now());
    res.json({ ok: true, token, mime });
});
router.delete('/cues/:kind', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in first.' });
    const kind = String(req.params.kind || '');
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown cue.' });
    sql.prepare('DELETE FROM user_cues WHERE user_id = ? AND kind = ?').run(uid, kind);
    res.json({ ok: true });
});
router.get('/cue/:token', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).end();
    if (limited('get:' + uid, 120)) return res.status(429).end();
    const t = String(req.params.token || '');
    if (!/^[a-f0-9]{24}$/.test(t)) return res.status(404).end();
    const r = sql.prepare('SELECT mime, data FROM user_cues WHERE token = ?').get(t);
    if (!r) return res.status(404).end();
    res.set('Content-Type', r.mime);
    res.set('Cache-Control', 'private, max-age=86400');   // token changes on every re-record
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(r.data));
});

module.exports = { router, cueFor, KINDS };
