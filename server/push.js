// server/push.js - web push notifications (the phone buzzes even when the app is closed).
//
// Needs two things on the server, otherwise everything here quietly does nothing:
//   * the `web-push` package (npm install runs on deploy because package.json changes)
//   * VAPID keys in .env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//     (run `node scripts/gen-vapid.js` once on the server; it writes them to .env and prints only the public key)
//
//   GET  /api/push/key          -> { enabled, publicKey }          (no login needed)
//   POST /api/push/subscribe    { endpoint, keys:{p256dh,auth} }   (Bearer, real accounts only)
//   POST /api/push/unsubscribe  { endpoint }                       (Bearer)
//
// sendToUser(userId, { title, body, url, tag }, { kind }) is used by rematch.js. A person gets at most one
// push of the same kind every 30 s. Subscriptions the push service reports as gone (404/410) are deleted.
//
// Exports: router, sendToUser, configured, subscriptionCount.

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');
const { clientIp, isGuestUserId } = require('./guest');

const router = express.Router();
const sql = typeof db.prepare === 'function' ? db : db.db;

sql.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

const MAX_PER_USER = 8;
const COOLDOWN_MS = 30 * 1000;

const isReal = (id) => !!id && !isGuestUserId(id) && !String(id).startsWith('gst_');
const vapid = () => ({
    pub: String(process.env.VAPID_PUBLIC_KEY || '').trim(),
    priv: String(process.env.VAPID_PRIVATE_KEY || '').trim(),
    subject: String(process.env.VAPID_SUBJECT || '').trim() || ('mailto:' + (config.SMTP_EMAIL || 'admin@localhost'))
});

let lib = null, libTried = false, libReady = false;
function webpush() {
    if (!libTried) {
        libTried = true;
        try { lib = require('web-push'); } catch (e) { lib = null; }
    }
    if (lib && !libReady) {
        const v = vapid();
        if (v.pub && v.priv) {
            try { lib.setVapidDetails(v.subject, v.pub, v.priv); libReady = true; }
            catch (e) { console.error('[Push] bad VAPID settings:', e.message); lib = null; }
        }
    }
    return libReady ? lib : null;
}
function configured() { return !!webpush(); }

// ---- HTTP ---------------------------------------------------------------------------------------
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
    return rec.n > 40;
}

router.get('/push/key', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: configured(), publicKey: configured() ? vapid().pub : null });
});

router.post('/push/subscribe', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many requests.' });
    const uid = authId(req);
    if (!uid) return res.status(401).json({ error: 'Log in with an account to get notifications.' });
    const b = req.body || {};
    const endpoint = String(b.endpoint || '');
    const p256dh = String(b.keys && b.keys.p256dh || '');
    const auth = String(b.keys && b.keys.auth || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
        return res.status(400).json({ error: 'Bad subscription.' });
    }
    sql.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
        .run(endpoint, uid, p256dh, auth, Date.now());
    // keep only the newest few per person
    sql.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN
                 (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`)
        .run(uid, uid, MAX_PER_USER);
    res.json({ ok: true });
});

router.post('/push/unsubscribe', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many requests.' });
    const uid = authId(req);
    if (!uid) return res.status(401).json({ error: 'Log in first.' });
    const endpoint = String((req.body && req.body.endpoint) || '');
    if (endpoint) sql.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, uid);
    res.json({ ok: true });
});

// ---- sending ------------------------------------------------------------------------------------
function subscriptionCount(userId) {
    const r = sql.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(String(userId));
    return r ? r.n : 0;
}

const lastSent = new Map();   // "user|kind" -> time
async function sendToUser(userId, payload, opts) {
    const wp = webpush();
    if (!wp || !isReal(userId)) return 0;
    const kind = (opts && opts.kind) || 'general';
    const key = String(userId) + '|' + kind, now = Date.now();
    if (now - (lastSent.get(key) || 0) < COOLDOWN_MS) return 0;
    const subs = sql.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(String(userId));
    if (!subs.length) return 0;
    lastSent.set(key, now);
    if (lastSent.size > 5000) for (const [k, t] of lastSent) if (now - t > COOLDOWN_MS) lastSent.delete(k);

    const body = JSON.stringify({
        title: String(payload.title || 'Blitz 31').slice(0, 80),
        body: String(payload.body || '').slice(0, 160),
        url: String(payload.url || '/'),
        tag: String(payload.tag || kind)
    });
    let sent = 0;
    for (const s of subs) {
        try {
            await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: (opts && opts.ttl) || 120 });
            sent += 1;
        } catch (err) {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                sql.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
            } else {
                console.error('[Push] send failed:', (err && (err.statusCode || err.message)) || err);
            }
        }
    }
    return sent;
}

module.exports = { router, sendToUser, configured, subscriptionCount };
