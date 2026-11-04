// server/game/antiCheat.js - Incoming WebSocket Guard: identity pinning, seat-takeover
// prevention, ledger authorization and per-socket rate limiting.
//
// Called by server.js for every parsed message BEFORE it reaches the game dispatcher.
// Returns { ok: true, data } with a sanitized payload, or { ok: false, reason } when the
// message must be dropped. Never throws.
//
// Design goals:
//   * The game engine already hides other players' cards and validates turns/knocks
//     server-side. What it trusted from the client was WHO is talking. This module
//     makes the authenticated JWT (ws.user) the single source of truth for identity.
//   * No gameplay or ledger action from an unauthenticated socket.
//   * A player can never attach to a seat/spectator slot that belongs to a different
//     account by reusing that person's display handle.
//   * Ledger writes always act as the authenticated user, never as an arbitrary
//     debtorId/creditorId supplied in the payload.

const WebSocket = require('ws');

// Messages anyone may send before logging in (menu / keepalive / auth)
const PUBLIC_TYPES = new Set([
    'PING',
    'GET_LOBBIES',
    'REFRESH_LOBBIES',
    'AUTH_TOKEN'
]);

// Messages that attach a socket to a seat or spectator slot under a display handle
const JOIN_TYPES = new Set(['JOIN_LOBBY', 'SIT_DOWN', 'CREATE_LOBBY']);

// Token-bucket rate limit per socket
const RATE_CAPACITY = 30;      // burst
const RATE_REFILL_PER_SEC = 12; // sustained messages / second
const RATE_WARN_COOLDOWN_MS = 5000;

function sendError(ws, message) {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ERROR', message }));
        }
    } catch (e) {}
}

function isGuestId(id) {
    return !id || String(id).startsWith('gst_');
}

function authenticatedUserId(ws) {
    if (!ws || !ws.user || ws.user.isGuest) return null;
    const uid = ws.user.id || ws.user.userId || null;
    return isGuestId(uid) ? null : uid;
}

// -------------------------------------------------------------
// 1. RATE LIMITING
// -------------------------------------------------------------
function checkRateLimit(ws) {
    const now = Date.now();
    if (!ws._acBucket) {
        ws._acBucket = { tokens: RATE_CAPACITY, last: now, warnedAt: 0 };
    }
    const b = ws._acBucket;
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + elapsed * RATE_REFILL_PER_SEC);
    b.last = now;

    if (b.tokens < 1) {
        if (now - b.warnedAt > RATE_WARN_COOLDOWN_MS) {
            b.warnedAt = now;
            sendError(ws, 'You are sending actions too quickly. Slow down.');
        }
        return false;
    }
    b.tokens -= 1;
    return true;
}

// -------------------------------------------------------------
// 2. SEAT / HANDLE TAKEOVER PREVENTION
// -------------------------------------------------------------
function findHandleOwner(lobby, handle) {
    if (!lobby || !handle) return null;
    const lower = String(handle).trim().toLowerCase();
    if (!lower) return null;

    const player = (lobby.players || []).find(p =>
        !p.isBot && p.username && p.username.trim().toLowerCase() === lower
    );
    if (player) return player;

    const spec = (lobby.spectators || []).find(s =>
        s.username && s.username.trim().toLowerCase() === lower
    );
    return spec || null;
}

function handleBelongsToSomeoneElse(lobby, handle, myUid, ws) {
    const owner = findHandleOwner(lobby, handle);
    if (!owner) return false;

    // Same socket reconnecting / same account on a second device: allowed
    const ownerSocket = owner.id || owner.idSocket;
    if (ownerSocket && ownerSocket === ws) return false;
    if (owner.userId && String(owner.userId) === String(myUid)) return false;

    // Owner's account is unknown but their socket is live and isn't ours: block
    if (!owner.userId) {
        const live = ownerSocket && typeof ownerSocket === 'object' && ownerSocket.readyState === WebSocket.OPEN;
        return Boolean(live);
    }
    return true;
}

// -------------------------------------------------------------
// 3. MAIN GUARD
// -------------------------------------------------------------
function guardIncoming(ws, data, lobbies) {
    try {
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
            return { ok: false, reason: 'malformed' };
        }

        if (!checkRateLimit(ws)) {
            return { ok: false, reason: 'rate_limited' };
        }

        const type = data.type;
        if (PUBLIC_TYPES.has(type)) {
            return { ok: true, data };
        }

        // --- Identity pinning: the JWT decides who you are -------------------
        const uid = authenticatedUserId(ws);
        if (!uid) {
            sendError(ws, 'Please log in before playing.');
            return { ok: false, reason: 'unauthenticated' };
        }

        const clean = { ...data };
        clean.userId = uid;
        clean.accountUsername = ws.user.username || ws.accountUsername || clean.accountUsername;
        delete clean.isGuest;
        delete clean.isAdmin;
        delete clean.token; // never let a stale/foreign token ride along on gameplay messages

        // Keep the socket's own bookkeeping consistent with the verified identity
        ws.userId = uid;
        if (ws.user.username) ws.accountUsername = ws.user.username;

        // --- Ledger operations act only as the authenticated user ------------
        switch (type) {
            case 'APPLY_CREDIT':
                // "I (debtor) am crediting creditorId" -> debtor must be me
                clean.debtorId = uid;
                if (!clean.creditorId || String(clean.creditorId) === String(uid)) {
                    return { ok: false, reason: 'invalid_credit_target' };
                }
                break;

            case 'TRANSFER_LIFETIME_DEBT':
                clean.myId = uid;
                if (!clean.fromDebtorId || !clean.toCreditorId ||
                    String(clean.fromDebtorId) === String(uid) ||
                    String(clean.toCreditorId) === String(uid)) {
                    return { ok: false, reason: 'invalid_transfer' };
                }
                break;

            case 'MARK_DEBT_PAID':
                // Debtor marking their own payment; never on behalf of someone else
                clean.debtorId = uid;
                delete clean.debtorUsername;
                break;

            case 'GET_LIFETIME_LEDGER':
                // Only your own balances
                delete clean.username;
                delete clean.accountUsername;
                clean.accountUsername = ws.user.username || ws.accountUsername;
                break;

            case 'APPLY_SESSION_CREDIT':
            case 'CLEAR_DEBT':
            case 'TRANSFER_DEBT':
                // Creditor / transferring party is resolved from the socket by wsHandler;
                // strip any client attempt to name a different creditor.
                delete clean.creditor;
                delete clean.creditorAccount;
                break;

            default:
                break;
        }

        // --- Seat takeover prevention ------------------------------------------
        if (JOIN_TYPES.has(type) && type !== 'CREATE_LOBBY') {
            const code = (clean.code || ws.currentLobbyCode || '').trim().toUpperCase();
            const lobby = code && lobbies ? lobbies[code] : null;
            const requested = (clean.username || '').trim();

            if (lobby && requested && handleBelongsToSomeoneElse(lobby, requested, uid, ws)) {
                sendError(ws, `The name "${requested}" is already in use at this table. Choose a different handle.`);
                return { ok: false, reason: 'handle_taken' };
            }
        }

        if (type === 'CREATE_LOBBY') {
            // Host handle is whatever they typed, but it is bound to this account
            clean.hostUserId = uid;
        }

        // Numeric sanity for money fields: positive, finite, 2dp, sane cap
        for (const key of ['amount', 'wagerAmt', 'wager']) {
            if (clean[key] !== undefined) {
                const n = Number(clean[key]);
                // A table wager of 0 is the "Free" option; every other amount must be positive
                const freeTable = (key === 'wager' && type === 'UPDATE_WAGER' && n === 0);
                if (!Number.isFinite(n) || (n <= 0 && !freeTable) || n > 100000) {
                    return { ok: false, reason: `bad_${key}` };
                }
                clean[key] = Math.round(n * 100) / 100;
            }
        }

        // Cap free-text sizes so nobody can balloon lobby state
        if (typeof clean.message === 'string') clean.message = clean.message.slice(0, 200);
        if (typeof clean.text === 'string') clean.text = clean.text.slice(0, 200);
        if (typeof clean.username === 'string') clean.username = clean.username.slice(0, 24);
        if (typeof clean.lobbyName === 'string') clean.lobbyName = clean.lobbyName.slice(0, 40);

        return { ok: true, data: clean };
    } catch (err) {
        console.error('[AntiCheat] Guard error:', err);
        return { ok: false, reason: 'guard_error' };
    }
}

module.exports = {
    guardIncoming,
    // exported for tests
    _internal: { checkRateLimit, handleBelongsToSomeoneElse, RATE_CAPACITY, RATE_REFILL_PER_SEC }
};
