// server/friendStats.js - compare your stats with a friend.
//   GET /api/friends/compare?username=<friend>
//   -> { me:{name, basic, deep?}, them:{name, basic, deep?}, h2h?, premium }
// Friends only (both ways). Everyone gets the basic match stats (wins, win rate, streaks);
// a Premium/admin viewer also gets the deep round stats for both players and the head-to-head record.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { areFriends } = require('./friends');
const { basicStats } = require('./stats');
const { deepStats, h2hBetween } = require('./roundLog');
const { statusFor } = require('./premium');

const sql = typeof db.prepare === 'function' ? db : db.db;
const router = express.Router();

function authId(req) {
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
function limited(key) {
    const now = Date.now(); let r = hits.get(key);
    if (!r || now > r.reset) { r = { n: 0, reset: now + 60000 }; hits.set(key, r); }
    r.n++; if (hits.size > 5000) hits.clear(); return r.n > 30;
}
function deepPublic(d) {
    // what a friend may see: no head-to-head list with third parties
    return { rounds: d.rounds, avgScore: d.avgScore, best: d.best, hit31: d.hit31, knocks: d.knocks, knockRate: d.knockRate, survived: d.survived, livesLost: d.livesLost, matches: d.matches, wins: d.wins, winRate: d.winRate };
}

router.get('/friends/compare', (req, res) => {
    const me = authId(req);
    if (!me) return res.status(401).json({ error: 'Sign in first.' });
    if (limited(me)) return res.status(429).json({ error: 'Too many requests.' });
    const name = String(req.query.username || '').trim().slice(0, 40);
    const them = name && sql.prepare("SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) AND provider != 'guest' LIMIT 1").get(name);
    if (!them) return res.status(404).json({ error: 'Player not found.' });
    if (them.id !== me && !areFriends(me, them.id)) return res.status(403).json({ error: 'You can only compare with friends.' });
    const meRow = sql.prepare('SELECT username FROM users WHERE id = ?').get(me) || {};
    const premium = !!statusFor(me).premium;
    const out = {
        premium,
        me: { name: meRow.username || 'You', basic: basicStats(me) },
        them: { name: them.username, basic: basicStats(them.id) }
    };
    if (premium) {
        out.me.deep = deepPublic(deepStats(me));
        out.them.deep = deepPublic(deepStats(them.id));
        out.h2h = h2hBetween(me, them.id);
    }
    res.set('Cache-Control', 'no-store');
    res.json(out);
});

module.exports = { router };
