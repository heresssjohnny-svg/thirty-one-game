// server/privateTables.js - free play on public tables, wagers only on private friends-only tables.
//
// Nothing in lobbyManager.js / wsHandler.js / wagerModes.js is modified. Like guest.js, this module sits in
// server.js's message pipeline (privateGate before the dispatcher, afterPrivateDispatch after it) and runs a
// small watcher (startPrivateTables).
//
// PUBLIC TABLES  are free play only. lobby.wagerMode is forced to 'free' (the table type that already makes
//                every wager $0), and messages that would create stakes - non-free wagers, a non-free table
//                type, side bets, elimination bets - are refused with a friendly message.
// PRIVATE TABLES may use wagers, but:
//   * friends only: someone who is not the host's friend can only join through the invite link
//     (the client adds viaInvite:true); joining that way makes them the host's friend (friends.js).
//     Guests and tables hosted by a guest keep working as before (they are always Free).
//   * 18+ and terms: before creating or joining a private table that allows wagers, a real account must
//     have accepted the terms (self-declared 18+). Until then the join/create is held and the client gets
//     { type:'TERMS_REQUIRED', action, code } so it can show the terms and resend.
//
//   GET  /api/terms          -> { version, title, paragraphs, accepted }   (accepted only with a Bearer token)
//   POST /api/terms/accept   { over18:true, version }  (Bearer, real accounts only)
//
// Exports: router, privateGate, afterPrivateDispatch, startPrivateTables, hasAccepted, TERMS_VERSION.

const express = require('express');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const db = require('./db');
const config = require('./config');
const { clientIp, isGuestUserId, isGuestSocket } = require('./guest');
const { areFriends, befriend } = require('./friends');

const router = express.Router();
const sql = typeof db.prepare === 'function' ? db : db.db;

const TERMS_VERSION = 'v1';
const TERMS_TITLE = 'Private table terms';
const TERMS_PARAGRAPHS = [
    'You must be 18 or older to join a private table where wagers are allowed.',
    'Blitz 31 is a card game. We provide the software only. We do not take part in any wager, hold, move or pay out money, take a cut, or guarantee that anyone pays.',
    'Any wager is a private arrangement between you and the other players, who you know. Settle up with them directly, outside the app. Balances shown in the app are notes, not a debt that we collect or enforce.',
    'You are responsible for following the laws where you live, including any limits on wagering. Do not play for money if it is not allowed where you are.',
    'Private tables are for friends. The table host can remove players. Do not invite people you do not know.',
    'If gambling is causing you problems, call or text 1-800-GAMBLER.'
];

sql.exec(`
  CREATE TABLE IF NOT EXISTS terms_acceptance (
    user_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    accepted_at INTEGER NOT NULL
  );
`);

const isReal = (id) => !!id && !isGuestUserId(id) && !String(id).startsWith('gst_');
const lower = (s) => String(s || '').trim().toLowerCase();

function hasAccepted(userId) {
    if (!isReal(userId)) return false;
    const r = sql.prepare('SELECT version FROM terms_acceptance WHERE user_id = ?').get(String(userId));
    return !!r && r.version === TERMS_VERSION;
}
function recordAcceptance(userId, now = Date.now()) {
    sql.prepare(`INSERT INTO terms_acceptance (user_id, version, accepted_at) VALUES (?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, accepted_at = excluded.accepted_at`)
        .run(String(userId), TERMS_VERSION, now);
}

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
    return rec.n > 60;
}

router.get('/terms', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many requests.' });
    const uid = authId(req);
    res.set('Cache-Control', 'no-store');
    res.json({ version: TERMS_VERSION, title: TERMS_TITLE, paragraphs: TERMS_PARAGRAPHS, accepted: uid ? hasAccepted(uid) : false });
});

router.post('/terms/accept', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many requests.' });
    const uid = authId(req);
    if (!uid) return res.status(401).json({ error: 'Log in with an account to accept the terms.' });
    const body = req.body || {};
    if (body.over18 !== true) return res.status(400).json({ error: 'You must confirm that you are 18 or older.' });
    if (body.version !== TERMS_VERSION) return res.status(409).json({ error: 'The terms were updated. Please read them again.' });
    recordAcceptance(uid);
    res.json({ ok: true, accepted: true, version: TERMS_VERSION });
});

// ---- helpers for the pipeline -------------------------------------------------------------------
function sendTo(ws, payload) {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); } catch (e) {}
}
function sendError(ws, message) { sendTo(ws, { type: 'ERROR', message }); }

function realUserId(ws) {
    if (!ws || !ws.user || isGuestSocket(ws)) return null;
    const id = ws.userId || ws.user.userId || ws.user.id || null;
    return isReal(id) ? String(id) : null;
}

function lobbyFor(ws, msg, lobbies) {
    const code = String((msg && msg.code) || (ws && ws.currentLobbyCode) || '').trim().toUpperCase();
    return code && lobbies ? lobbies[code] || null : null;
}

function hostUserId(lobby, lobbyManager) {
    const h = lower(lobby && lobby.host);
    if (!h) return null;
    const hp = (lobby.players || []).find(p => lower(p.username) === h || lower(p.accountUsername) === h);
    let uid = hp && hp.userId ? hp.userId : null;
    if (!uid && lobbyManager && typeof lobbyManager.resolveUserId === 'function') {
        try { uid = lobbyManager.resolveUserId(lobby, (hp && (hp.accountUsername || hp.username)) || lobby.host) || null; } catch (e) {}
    }
    return isReal(uid) ? String(uid) : null;
}

function alreadyAtTable(lobby, uid) {
    return (lobby.players || []).some(p => !p.isBot && p.userId && String(p.userId) === uid) ||
        (lobby.spectators || []).some(s => s.userId && String(s.userId) === uid);
}

const BET_TYPES = new Set([
    'PROPOSE_ELIMINATION_BET', 'PROPOSE_GLOBAL_SIDE_BET', 'PROPOSE_GLOBAL_BET',
    'ACCEPT_GLOBAL_PROPOSAL', 'DECLINE_GLOBAL_PROPOSAL', 'CONFIRM_GLOBAL_BET',
    'RESPOND_GLOBAL_BET', 'RESPOND_BET'
]);
const PUBLIC_MSG = 'Public tables are free play. Wagers and side bets are only on private tables with friends.';

// Returns true when the message may continue to the game dispatcher.
function privateGate(ws, msg, lobbies, lobbyManager) {
    if (!msg || typeof msg.type !== 'string') return true;
    const type = msg.type;

    // ---- public tables: free play only
    if (BET_TYPES.has(type) || type === 'UPDATE_WAGER' || type === 'SET_WAGER_MODE') {
        const lobby = lobbyFor(ws, msg, lobbies);
        if (lobby && !lobby.isPrivate) {
            const harmless = (type === 'UPDATE_WAGER' && Number(msg.wager) === 0) ||
                (type === 'SET_WAGER_MODE' && lower(msg.mode) === 'free');
            if (!harmless) { sendError(ws, PUBLIC_MSG); return false; }
        }
        return true;
    }

    // ---- private tables: friends only, 18+ and terms
    const uid = realUserId(ws);
    if (!uid) return true;   // guests (see guest.js) and unauthenticated sockets (see antiCheat.js)

    if (type === 'CREATE_LOBBY') {
        if (msg.isPrivate && !hasAccepted(uid)) {
            sendTo(ws, { type: 'TERMS_REQUIRED', action: 'CREATE_LOBBY' });
            return false;
        }
        return true;
    }

    if (type === 'JOIN_LOBBY') {
        const code = String(msg.code || '').trim().toUpperCase();
        const lobby = code && lobbies ? lobbies[code] : null;
        if (!lobby || !lobby.isPrivate) return true;
        if (alreadyAtTable(lobby, uid)) return true;           // reconnecting

        const hostUid = hostUserId(lobby, lobbyManager);
        if (hostUid && hostUid !== uid && !areFriends(uid, hostUid) && msg.viaInvite !== true) {
            sendError(ws, 'This is a private table for friends. Ask the host for an invite link.');
            return false;
        }
        const wagering = ((lobby.wagerMode) || 'mixed') !== 'free';
        if (wagering && !hasAccepted(uid)) {
            sendTo(ws, { type: 'TERMS_REQUIRED', action: 'JOIN_LOBBY', code });
            return false;
        }
    }
    return true;
}

// Call straight after the dispatcher returns.
function afterPrivateDispatch(ws, msg, lobbies, broadcastLobbyUpdate, lobbyManager) {
    try {
        if (!msg) return;
        const lobby = lobbies && ws.currentLobbyCode ? lobbies[ws.currentLobbyCode] : null;
        if (!lobby) return;

        if (!lobby.isPrivate && lobby.wagerMode !== 'free') {
            lobby.wagerMode = 'free';
            if (typeof broadcastLobbyUpdate === 'function') broadcastLobbyUpdate(lobby.code);
        }

        // Tell the client whether this table is private (snapshots do not carry it), so it can hide wager controls
        if (msg.type === 'CREATE_LOBBY' || msg.type === 'JOIN_LOBBY') {
            sendTo(ws, { type: 'TABLE_INFO', code: lobby.code, isPrivate: !!lobby.isPrivate });
        }

        if (msg.type === 'JOIN_LOBBY' && msg.viaInvite === true && lobby.isPrivate) {
            const uid = realUserId(ws);
            const hostUid = hostUserId(lobby, lobbyManager);
            if (uid && hostUid && uid !== hostUid && alreadyAtTable(lobby, uid)) befriend(uid, hostUid, 'invite');
        }
    } catch (err) {
        console.error('[PrivateTables] afterDispatch error:', err.message);
    }
}

// Public tables (including ones restored from a saved snapshot) always stay on the free table type.
function enforcePublicFree(lobbyManager) {
    const all = lobbyManager.lobbies || {};
    for (const code of Object.keys(all)) {
        const lobby = all[code];
        if (lobby && !lobby.isPrivate && lobby.wagerMode !== 'free') {
            lobby.wagerMode = 'free';
            try { if (typeof lobbyManager.broadcastLobbyUpdate === 'function') lobbyManager.broadcastLobbyUpdate(code); } catch (e) {}
        }
    }
}

function startPrivateTables({ lobbyManager }) {
    const timer = setInterval(() => { try { enforcePublicFree(lobbyManager); } catch (e) {} }, 1000);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = {
    router, privateGate, afterPrivateDispatch, startPrivateTables, enforcePublicFree,
    hasAccepted, recordAcceptance, TERMS_VERSION, TERMS_PARAGRAPHS
};
