// server/friends.js - friends list, friend requests, and the helpers private tables use.
//
// Friends are real accounts only (guests have none). A friendship is mutual and is stored once per pair
// (user_a < user_b). Being someone's friend lets you join their private tables without an invite link, so
// adding a friend always needs their consent - a request they accept - except for the one automatic case:
// joining someone's private table through their invite link makes you their friend (see privateTables.js).
//
//   GET    /api/friends                  -> { friends:[{username,since}], incoming:[{username,at}], outgoing:[{username,at}] }
//   POST   /api/friends/request {username}   send a request (if they already asked you, it just accepts)
//   POST   /api/friends/respond {username, accept}   accept or decline a request sent to you
//   POST   /api/friends/cancel  {username}   withdraw a request you sent
//   DELETE /api/friends/:username            remove a friend
//
// Exports: router, areFriends, befriend, friendCount.

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { clientIp, isGuestUserId } = require('./guest');

const router = express.Router();
const sql = typeof db.prepare === 'function' ? db : db.db;

const MAX_FRIENDS = 200;
const MAX_PENDING_OUT = 20;
const MAX_PENDING_IN = 100;

sql.exec(`
  CREATE TABLE IF NOT EXISTS friendships (
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'request',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b)
  );
  CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships (user_b);
  CREATE TABLE IF NOT EXISTS friend_requests (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests (to_id);
`);

const pair = (x, y) => (String(x) < String(y) ? [String(x), String(y)] : [String(y), String(x)]);
const isReal = (id) => !!id && !isGuestUserId(id) && !String(id).startsWith('gst_');

function areFriends(x, y) {
    if (!isReal(x) || !isReal(y) || String(x) === String(y)) return false;
    const [a, b] = pair(x, y);
    return !!sql.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b);
}

function friendCount(id) {
    return sql.prepare('SELECT COUNT(*) AS n FROM friendships WHERE user_a = ? OR user_b = ?').get(String(id), String(id)).n;
}

// Make two real accounts friends (idempotent). Also clears any pending request between them.
function befriend(x, y, source = 'request', now = Date.now()) {
    if (!isReal(x) || !isReal(y) || String(x) === String(y)) return false;
    if (areFriends(x, y)) return true;
    if (friendCount(x) >= MAX_FRIENDS || friendCount(y) >= MAX_FRIENDS) return false;
    const [a, b] = pair(x, y);
    sql.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, source, created_at) VALUES (?, ?, ?, ?)').run(a, b, source, now);
    sql.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)')
        .run(String(x), String(y), String(y), String(x));
    return true;
}

// ---- auth + rate limit ------------------------------------------------------------------------
function authId(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    if (!/^Bearer\s+\S+/.test(h)) return null;
    try {
        const d = jwt.verify(h.split(/\s+/)[1], config.JWT_SECRET);
        const id = d && (d.userId || d.id);
        return isReal(id) && !d.guest ? String(id) : null;
    } catch (e) { return null; }
}

const hits = new Map();
function limited(req) {
    const ip = clientIp(req), now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now > rec.resetAt) { rec = { n: 0, resetAt: now + 60000 }; hits.set(ip, rec); }
    rec.n += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    return rec.n > 60;
}

function guard(req, res) {
    if (limited(req)) { res.status(429).json({ error: 'Too many requests. Try again in a minute.' }); return null; }
    const me = authId(req);
    if (!me) { res.status(401).json({ error: 'Log in with an account to use friends.' }); return null; }
    return me;
}

const nameOf = (id) => {
    const r = sql.prepare('SELECT username FROM users WHERE id = ?').get(String(id));
    return r ? r.username : null;
};
function findTarget(raw) {
    const name = String(raw || '').trim().slice(0, 40);
    if (!name) return null;
    const r = sql.prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) AND provider != ? LIMIT 1').get(name, 'guest');
    return r || null;
}

function listFor(me) {
    const friends = sql.prepare(`
      SELECT u.username AS username, f.created_at AS since
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
      WHERE f.user_a = ? OR f.user_b = ?
      ORDER BY LOWER(u.username)`).all(me, me, me);
    const incoming = sql.prepare(`
      SELECT u.username AS username, r.created_at AS at
      FROM friend_requests r JOIN users u ON u.id = r.from_id
      WHERE r.to_id = ? ORDER BY r.created_at DESC`).all(me);
    const outgoing = sql.prepare(`
      SELECT u.username AS username, r.created_at AS at
      FROM friend_requests r JOIN users u ON u.id = r.to_id
      WHERE r.from_id = ? ORDER BY r.created_at DESC`).all(me);
    return { friends, incoming, outgoing };
}

router.get('/friends', (req, res) => {
    const me = guard(req, res); if (!me) return;
    res.set('Cache-Control', 'no-store');
    res.json(listFor(me));
});

router.post('/friends/request', (req, res) => {
    const me = guard(req, res); if (!me) return;
    const target = findTarget(req.body && req.body.username);
    if (!target) return res.status(404).json({ error: 'No player with that username.' });
    if (String(target.id) === me) return res.status(400).json({ error: 'You cannot add yourself.' });
    if (areFriends(me, target.id)) return res.json({ ok: true, status: 'already_friends', ...listFor(me) });
    // a player who blocked me silently never receives my requests; I can't request someone I blocked
    try {
        const safety = require('./safety');
        if (safety.hasBlocked(me, target.username)) return res.status(400).json({ error: 'You blocked this player. Unblock them first (Settings → Blocked players).' });
        if (safety.hasBlocked(String(target.id), nameOf(me) || '')) return res.json({ ok: true, status: 'sent', ...listFor(me) });
    } catch (e) {}

    const reverse = sql.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(String(target.id), me);
    if (reverse) {
        if (!befriend(me, target.id, 'request')) return res.status(400).json({ error: 'Friend list is full.' });
        return res.json({ ok: true, status: 'accepted', ...listFor(me) });
    }
    const out = sql.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?').get(me).n;
    const inn = sql.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE to_id = ?').get(String(target.id)).n;
    const dup = sql.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(me, String(target.id));
    if (!dup) {
        if (out >= MAX_PENDING_OUT) return res.status(400).json({ error: 'You have too many pending requests. Cancel some first.' });
        if (inn >= MAX_PENDING_IN) return res.status(400).json({ error: 'That player has too many pending requests.' });
        sql.prepare('INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').run(me, String(target.id), Date.now());
    }
    res.json({ ok: true, status: 'sent', ...listFor(me) });
});

router.post('/friends/respond', (req, res) => {
    const me = guard(req, res); if (!me) return;
    const target = findTarget(req.body && req.body.username);
    if (!target) return res.status(404).json({ error: 'No player with that username.' });
    const reqRow = sql.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(String(target.id), me);
    if (!reqRow) return res.status(404).json({ error: 'No request from that player.' });
    if (req.body.accept) {
        if (!befriend(me, target.id, 'request')) return res.status(400).json({ error: 'Friend list is full.' });
    } else {
        sql.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(String(target.id), me);
    }
    res.json({ ok: true, ...listFor(me) });
});

router.post('/friends/cancel', (req, res) => {
    const me = guard(req, res); if (!me) return;
    const target = findTarget(req.body && req.body.username);
    if (target) sql.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(me, String(target.id));
    res.json({ ok: true, ...listFor(me) });
});

router.delete('/friends/:username', (req, res) => {
    const me = guard(req, res); if (!me) return;
    const target = findTarget(req.params.username);
    if (target) {
        const [a, b] = pair(me, target.id);
        sql.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(a, b);
    }
    res.json({ ok: true, ...listFor(me) });
});

module.exports = { router, areFriends, befriend, friendCount, listFor, nameOf, MAX_FRIENDS };
