// server/premium.js - Premium cosmetics entitlement.
//
// Premium = users.is_premium = 1 OR users.is_admin = 1 (admin accounts get all paid content).
// Premium covers: extra soundboard sounds, felt colours and card backs. Felt/back are drawn
// locally on each player's own screen; the extra sounds are broadcast, so the server enforces them here.
//
//   GET /api/premium/me  (Bearer token of a real account) -> { premium, admin }
//   handlePremiumGate(ws, msg) - call before the message dispatcher; swallows a premium soundboard
//                                reaction from a sender without Premium.
//
// There is no payment processor yet: Premium is granted from the admin panel (Users tab).
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

const sql = typeof db.prepare === 'function' ? db : db.db;
try { sql.prepare('ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0').run(); } catch (e) {}

const PREMIUM_SOUNDS = ['tada', 'drumroll', 'boom', 'whoosh', 'doorbell', 'charge', 'laser', 'powerup', 'machinegun', 'shotgun', 'applause', 'gong', 'dundundun', 'buzzer'];
const PREMIUM_REACTIONS = PREMIUM_SOUNDS.map(s => 'sb:' + s);

function statusFor(userId) {
    if (!userId || String(userId).startsWith('gst_') || String(userId).startsWith('usr_guest_')) {
        return { premium: false, admin: false };
    }
    try {
        const row = sql.prepare('SELECT is_premium, is_admin FROM users WHERE id = ?').get(userId);
        if (!row) return { premium: false, admin: false };
        const admin = Number(row.is_admin) === 1;
        return { premium: admin || Number(row.is_premium) === 1, admin };
    } catch (e) {
        return { premium: false, admin: false };
    }
}

const router = express.Router();
router.get('/premium/me', (req, res) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in first.' });
    try {
        const d = jwt.verify(h.slice(7), config.JWT_SECRET);
        const uid = d && (d.userId || d.id);
        return res.json(statusFor(uid));
    } catch (e) {
        return res.status(401).json({ error: 'Invalid session.' });
    }
});

function handlePremiumGate(ws, msg) {
    if (!msg || !['SEND_REACTION', 'SEAT_REACTION', 'QUICK_REACTION'].includes(msg.type)) return false;
    const raw = String(msg.emoji || msg.reaction || '').trim();
    if (!PREMIUM_REACTIONS.includes(raw)) return false;
    if (statusFor(ws && ws.userId).premium) return false; // allowed: let the normal handler broadcast it
    try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ERROR', message: '🔒 That sound is Premium.' }));
    } catch (e) {}
    return true;
}

module.exports = { router, statusFor, handlePremiumGate, PREMIUM_SOUNDS, PREMIUM_REACTIONS };
