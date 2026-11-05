// server/guest.js - "Try it vs bots" guest accounts.
//
// A guest is a throwaway row in `users` (provider 'guest', id prefix usr_guest_) so every
// existing code path that expects a real account keeps working. What makes it safe:
//   * Guests can only create / join tables whose type is Free, so no wager is ever owed
//     to or by a guest (nothing is written to the lifetime ledger for them).
//   * All betting / balance / debt messages from guests are refused.
//   * Nobody can switch a table that has a guest at it away from Free.
//   * Guest rows are hidden from the admin panel and purged after a few days.
//
// Exports: router (POST /auth/guest), guestGate (call before dispatch),
//          afterGuestDispatch (call right after dispatch), clientIp, isGuestUserId.

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('./db');
const config = require('./config');

const router = express.Router();
const sqlDb = typeof db.prepare === 'function' ? db : db.db;

const GUEST_PREFIX = 'usr_guest_';
const GUEST_TOKEN_TTL = '3d';
const GUEST_PURGE_AFTER = '-4 days';
const GUESTS_PER_IP_PER_HOUR = 20;

// Behind Caddy every request arrives from 127.0.0.1, so req.ip is useless for rate limits.
// Caddy replaces X-Forwarded-For with the real client address; use its first entry.
function clientIp(req) {
    const fwd = req && req.headers && req.headers['x-forwarded-for'];
    if (fwd) {
        const first = String(fwd).split(',')[0].trim();
        if (first) return first;
    }
    return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
}

function isGuestUserId(id) {
    return String(id || '').startsWith(GUEST_PREFIX);
}

function isGuestSocket(ws) {
    return !!(ws && ws.user && isGuestUserId(ws.user.userId || ws.user.id));
}

// -------------------------------------------------------------
// 1. CREATE A GUEST SESSION
// -------------------------------------------------------------
const created = new Map(); // ip -> { count, resetAt }

router.post('/guest', async (req, res) => {
    const ip = clientIp(req);
    const now = Date.now();
    let rec = created.get(ip);
    if (!rec || now > rec.resetAt) {
        rec = { count: 0, resetAt: now + 60 * 60 * 1000 };
        created.set(ip, rec);
    }
    if (rec.count >= GUESTS_PER_IP_PER_HOUR) {
        return res.status(429).json({ error: 'Too many guest sessions from this network. Please try again later.' });
    }

    try {
        let username = null;
        for (let i = 0; i < 12 && !username; i++) {
            const candidate = 'Guest-' + (1000 + crypto.randomInt(9000));
            if (!db.findUserByUsername(candidate)) username = candidate;
        }
        if (!username) username = 'Guest-' + Date.now().toString().slice(-7);

        const userId = GUEST_PREFIX + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
        // Random password nobody knows: a guest row can never be logged into through /auth/login
        const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8);

        sqlDb.prepare(`
            INSERT INTO users (id, provider, provider_id, username, email, password_hash, created_at)
            VALUES (?, 'guest', ?, ?, ?, ?, datetime('now'))
        `).run(userId, 'guest_' + userId, username, userId + '@guest.invalid', passwordHash);

        rec.count += 1;

        const token = jwt.sign(
            { userId, username, isGuest: false, guest: true },
            config.JWT_SECRET,
            { expiresIn: GUEST_TOKEN_TTL }
        );
        return res.json({
            token,
            user: { id: userId, username, email: null, isGuest: false, guest: true }
        });
    } catch (err) {
        console.error('[Guest] Create error:', err);
        return res.status(500).json({ error: 'Could not start a guest session.' });
    }
});

// -------------------------------------------------------------
// 2. HOUSEKEEPING: purge old guest rows (never ones with ledger entries)
// -------------------------------------------------------------
function purgeStaleGuests() {
    try {
        const info = sqlDb.prepare(`
            DELETE FROM users
            WHERE provider = 'guest'
              AND created_at < datetime('now', ?)
              AND id NOT IN (SELECT debtor_id FROM lifetime_ledger)
              AND id NOT IN (SELECT creditor_id FROM lifetime_ledger)
        `).run(GUEST_PURGE_AFTER);
        if (info && info.changes) console.log(`[Guest] Purged ${info.changes} stale guest account(s).`);
    } catch (err) {
        console.error('[Guest] Purge error:', err.message);
    }
}
purgeStaleGuests();
setInterval(purgeStaleGuests, 6 * 60 * 60 * 1000).unref();

// -------------------------------------------------------------
// 3. WEBSOCKET RULES FOR GUESTS
// -------------------------------------------------------------
// Everything that can create money owed between accounts
const MONEY_TYPES = new Set([
    'TRANSFER_DEBT', 'TRANSFER_LIFETIME_DEBT', 'APPLY_CREDIT', 'MARK_DEBT_PAID',
    'RESPOND_MARK_PAID', 'APPLY_SESSION_CREDIT', 'CLEAR_DEBT',
    'PROPOSE_ELIMINATION_BET', 'PROPOSE_GLOBAL_SIDE_BET', 'PROPOSE_GLOBAL_BET',
    'ACCEPT_GLOBAL_PROPOSAL', 'DECLINE_GLOBAL_PROPOSAL', 'CONFIRM_GLOBAL_BET',
    'RESPOND_GLOBAL_BET', 'RESPOND_BET', 'SET_WAGER_MODE'
]);

function sendError(ws, message) {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ERROR', message }));
    } catch (e) {}
}

function modeOf(lobby) {
    return (lobby && lobby.wagerMode) || 'mixed';
}

function lobbyHasGuest(lobby) {
    if (!lobby) return false;
    const seated = (lobby.players || []).some(p => !p.isBot && isGuestUserId(p.userId));
    const watching = (lobby.spectators || []).some(s => isGuestUserId(s.userId));
    return seated || watching;
}

// Returns true when the message may continue to the game dispatcher.
function guestGate(ws, msg, lobbies) {
    if (!msg || typeof msg.type !== 'string') return true;
    const type = msg.type;

    // Nobody may take a table with a guest at it away from Free
    if (type === 'SET_WAGER_MODE' && !isGuestSocket(ws)) {
        const lobby = lobbies && ws.currentLobbyCode ? lobbies[ws.currentLobbyCode] : null;
        if (lobbyHasGuest(lobby) && String(msg.mode || '').toLowerCase() !== 'free') {
            sendError(ws, 'A guest is playing at this table, so it has to stay Free.');
            return false;
        }
        return true;
    }

    if (!isGuestSocket(ws)) return true;

    if (MONEY_TYPES.has(type)) {
        sendError(ws, 'Guests can play for fun but not for stakes. Create a free account to place bets and track balances.');
        return false;
    }

    if (type === 'UPDATE_WAGER') {
        // Only Free is meaningful for a guest; swallow everything else
        return false;
    }

    if (type === 'JOIN_LOBBY' || type === 'SIT_DOWN') {
        const code = String(msg.code || ws.currentLobbyCode || '').trim().toUpperCase();
        const lobby = code && lobbies ? lobbies[code] : null;
        if (lobby && modeOf(lobby) !== 'free') {
            sendError(ws, 'This table uses wagers. Guests can only join Free tables. Create a free account to join it.');
            return false;
        }
    }
    return true;
}

// A table created by a guest is always Free. Call straight after the dispatcher returns.
function afterGuestDispatch(ws, msg, lobbies, broadcastLobbyUpdate) {
    try {
        if (msg && msg.type === 'CREATE_LOBBY' && isGuestSocket(ws)) {
            const lobby = ws.currentLobbyCode && lobbies ? lobbies[ws.currentLobbyCode] : null;
            if (lobby) {
                lobby.wagerMode = 'free';
                if (typeof broadcastLobbyUpdate === 'function') broadcastLobbyUpdate(lobby.code);
            }
        }
    } catch (err) {
        console.error('[Guest] afterDispatch error:', err.message);
    }
}

module.exports = { router, guestGate, afterGuestDispatch, clientIp, isGuestUserId, isGuestSocket };
