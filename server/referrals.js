// server/referrals.js - invite tracking + Premium rewards.
// Every real account gets a short code (users.ref_code). Links look like /?ref=CODE (table invite links carry it too).
// A new account registered from such a link is stored with users.referred_by = inviter id.
// When the new player finishes their first match (user_stats.games >= 1) the inviter gets REWARD_DAYS of Premium
// (users.premium_until, stacks), at most MAX_PER_30D rewards per 30 days. The inviter is told live or by push.
//   GET /api/referrals/me -> { code, invited:[{name, at, status}], joined, rewarded, daysEarned, premiumUntil, rewardDays, maxPer30d }
// Exports { router, attach, startReferrals, ensureCode, REWARD_DAYS }
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

const sql = typeof db.prepare === 'function' ? db : db.db;
['ref_code TEXT', 'referred_by TEXT', 'ref_rewarded INTEGER DEFAULT 0', 'ref_rewarded_at INTEGER', 'premium_until INTEGER', 'signup_at_ms INTEGER']
    .forEach(c => { try { sql.prepare('ALTER TABLE users ADD COLUMN ' + c).run(); } catch (e) {} });
try { sql.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code)').run(); } catch (e) {}
try { sql.prepare('CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)').run(); } catch (e) {}

const REWARD_DAYS = Number(process.env.REFERRAL_REWARD_DAYS || 7);
const MAX_PER_30D = Number(process.env.REFERRAL_MAX_PER_30D || 10);
const DAY = 24 * 3600 * 1000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function isGuestId(id) { return !id || String(id).startsWith('gst_') || String(id).startsWith('usr_guest_'); }
function ensureCode(userId) {
    if (isGuestId(userId)) return null;
    const row = sql.prepare('SELECT ref_code FROM users WHERE id = ?').get(userId);
    if (!row) return null;
    if (row.ref_code) return row.ref_code;
    for (let i = 0; i < 8; i++) {
        let c = ''; const b = crypto.randomBytes(6);
        for (let k = 0; k < 6; k++) c += ALPHA[b[k] % ALPHA.length];
        try { if (sql.prepare('UPDATE users SET ref_code = ? WHERE id = ? AND ref_code IS NULL').run(c, userId).changes) return c; } catch (e) {}
        const again = sql.prepare('SELECT ref_code FROM users WHERE id = ?').get(userId);
        if (again && again.ref_code) return again.ref_code;
    }
    return null;
}
// called right after a new account is created
function attach(newUserId, code) {
    try {
        sql.prepare('UPDATE users SET signup_at_ms = ? WHERE id = ?').run(Date.now(), newUserId);
        const c = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
        if (!c) return false;
        const inviter = sql.prepare("SELECT id FROM users WHERE ref_code = ? AND COALESCE(provider,'local') != 'guest'").get(c);
        if (!inviter || inviter.id === newUserId) return false;
        sql.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL').run(inviter.id, newUserId);
        return true;
    } catch (e) { console.error('[Referrals] attach failed:', e.message); return false; }
}

function socketsOf(userId) {
    const out = [], wss = global.blitz31Wss;
    if (wss && wss.clients) wss.clients.forEach(ws => { if (ws && ws.readyState === 1 && String(ws.userId || '') === String(userId)) out.push(ws); });
    return out;
}
function tell(userId, text) {
    const socks = socketsOf(userId);
    const msg = JSON.stringify({ type: 'REFERRAL_REWARD', message: text });
    socks.forEach(ws => { try { ws.send(msg); } catch (e) {} });
    if (!socks.length) {
        try { const push = require('./push'); if (push && push.sendToUser) push.sendToUser(userId, { title: 'Blitz 31 🎁', body: text, url: '/', tag: 'referral' }, { kind: 'referral' }); } catch (e) {}
        try { require('./paymentClaims').notify(userId, { type: 'REFERRAL_REWARD', message: text }, null); } catch (e) {}
    }
}

function tick() {
    let rows = [];
    try {
        rows = sql.prepare(`SELECT u.id, u.username, u.referred_by FROM users u JOIN user_stats s ON s.user_id = u.id
                            WHERE u.referred_by IS NOT NULL AND COALESCE(u.ref_rewarded, 0) = 0 AND s.games >= 1 LIMIT 100`).all();
    } catch (e) { return; }
    const now = Date.now();
    rows.forEach(r => {
        const recent = sql.prepare('SELECT COUNT(*) n FROM users WHERE referred_by = ? AND ref_rewarded = 1 AND ref_rewarded_at > ?').get(r.referred_by, now - 30 * DAY).n;
        if (recent >= MAX_PER_30D) {
            sql.prepare('UPDATE users SET ref_rewarded = 2, ref_rewarded_at = ? WHERE id = ?').run(now, r.id);   // counted, no reward (cap)
            return;
        }
        const inv = sql.prepare('SELECT premium_until FROM users WHERE id = ?').get(r.referred_by);
        if (!inv) return;
        const base = Math.max(now, Number(inv.premium_until) || 0);
        const tx = typeof sql.transaction === 'function' ? sql.transaction(fn => fn()) : (fn => fn());
        tx(() => {
            sql.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(base + REWARD_DAYS * DAY, r.referred_by);
            sql.prepare('UPDATE users SET ref_rewarded = 1, ref_rewarded_at = ? WHERE id = ?').run(now, r.id);
        });
        tell(r.referred_by, `🎁 ${r.username} joined from your invite and played their first match — you got +${REWARD_DAYS} days of Premium!`);
    });
}
function startReferrals() {
    const t = setInterval(tick, 30000); if (t.unref) t.unref();
    const t0 = setTimeout(tick, 5000); if (t0.unref) t0.unref();
    console.log('[Referrals] running');
}

function uidOf(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    if (!/^Bearer\s+\S+/.test(h)) return null;
    try { const d = jwt.verify(h.split(/\s+/)[1], config.JWT_SECRET); const id = d && (d.userId || d.id); return id && !isGuestId(id) && !d.guest ? String(id) : null; } catch (e) { return null; }
}
const router = express.Router();
router.get('/referrals/me', (req, res) => {
    const uid = uidOf(req); if (!uid) return res.status(401).json({ error: 'Sign in first.' });
    const code = ensureCode(uid);
    const list = sql.prepare(`SELECT u.username, u.signup_at_ms, u.created_at, COALESCE(u.ref_rewarded,0) rr, COALESCE(s.games,0) games
                              FROM users u LEFT JOIN user_stats s ON s.user_id = u.id WHERE u.referred_by = ? ORDER BY COALESCE(u.signup_at_ms, 0) DESC LIMIT 100`).all(uid);
    const me = sql.prepare('SELECT premium_until FROM users WHERE id = ?').get(uid) || {};
    const rewarded = list.filter(x => x.rr === 1).length;
    res.set('Cache-Control', 'no-store');
    res.json({
        code, rewardDays: REWARD_DAYS, maxPer30d: MAX_PER_30D,
        joined: list.length, rewarded, daysEarned: rewarded * REWARD_DAYS,
        premiumUntil: Number(me.premium_until) > Date.now() ? Number(me.premium_until) : null,
        invited: list.map(x => ({ name: x.username, at: x.signup_at_ms || null, status: x.rr === 1 ? 'rewarded' : (x.rr === 2 ? 'capped' : (x.games > 0 ? 'played' : 'waiting')) }))
    });
});

module.exports = { router, attach, startReferrals, ensureCode, tick, REWARD_DAYS };
