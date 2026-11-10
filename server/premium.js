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

const CONFETTI = ['cash', 'coins', 'suits', 'fireworks', 'hearts'];
const DANCES = ['disco', 'robot', 'none'];
const FREE_SOUNDS = ['horn', 'cash', 'rimshot', 'sad', 'crickets', 'siren'];
function cleanCelebration(userId, v) {
    v = String(v || 'default');
    if (v === 'default' || v === 'none') return v;
    if (FREE_SOUNDS.includes(v)) return v;
    if (PREMIUM_SOUNDS.includes(v) && statusFor(userId).premium) return v;
    return 'default';
}

function handlePremiumGate(ws, msg) {
    // The player's chosen celebration sounds (hit 31 / win the match). Stored on the socket and shown to
    // the whole table in the lobby snapshot (player.celebration), so everyone hears the winner's pick.
    if (msg && msg.type === 'SET_CELEBRATION') {
        if (ws) {
            const prem = statusFor(ws.userId).premium;
            const pick = (v, list) => (prem && list.includes(String(v))) ? String(v) : 'default';
            // 'rec' = the player's own recording (server/cues.js); only the random token goes out to the table
            let cueFor = null; try { cueFor = require('./cues').cueFor; } catch (e) {}
            const recWin = prem && cueFor ? cueFor(ws.userId, 'win') : null;
            const recKnock = prem && cueFor ? cueFor(ws.userId, 'knock') : null;
            const celeb = v => (String(v) === 'rec' ? (recWin ? 'rec' : 'default') : cleanCelebration(ws.userId, v));
            ws.__cel = {
                hit31: celeb(msg.hit31),
                win: celeb(msg.win),
                knock: String(msg.knock) === 'rec' ? (recKnock ? 'rec' : 'default')
                    : (msg.knock && msg.knock !== 'default' && prem && (FREE_SOUNDS.includes(String(msg.knock)) || PREMIUM_SOUNDS.includes(String(msg.knock)))) ? String(msg.knock) : 'default',
                confetti: pick(msg.confetti, CONFETTI),
                dance: pick(msg.dance, DANCES)
            };
            if (ws.__cel.knock === 'rec') ws.__cel.knockCue = recKnock.token;
            if (ws.__cel.win === 'rec' || ws.__cel.hit31 === 'rec') ws.__cel.winCue = recWin.token;
        }
        return true;
    }
    if (!msg || !['SEND_REACTION', 'SEAT_REACTION', 'QUICK_REACTION'].includes(msg.type)) return false;
    const raw = String(msg.emoji || msg.reaction || '').trim();
    if (!PREMIUM_REACTIONS.includes(raw)) return false;
    if (statusFor(ws && ws.userId).premium) return false; // allowed: let the normal handler broadcast it
    try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ERROR', message: '🔒 That sound is Premium.' }));
    } catch (e) {}
    return true;
}

module.exports = { router, statusFor, handlePremiumGate, cleanCelebration, PREMIUM_SOUNDS, PREMIUM_REACTIONS };
