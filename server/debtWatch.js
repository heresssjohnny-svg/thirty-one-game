// server/debtWatch.js - tells the table host when someone with a big unpaid balance joins.
//
// Nothing in lobbyManager.js / wsHandler.js is modified. Like stats.js, a small watcher looks at the shared
// `lobbies` object (every 2 s). When a real account joins a table (seated or watching) and their LIFETIME NET
// balance is below -DEBT_LIMIT dollars (they owe more than they are owed, across every table and player),
// the host's socket gets one message:
//
//   { type: 'DEBT_WARNING', username, owed }      owed = positive dollars, e.g. 63.5
//
// public/js/debtWatch.js shows "<user> has joined the table but has a non-payment balance of $X" with
// Allow / Kick. Kick sends the existing ADMIN_KICK_PLAYER message; Allow just closes the prompt.
//
// Each person is checked once per visit to a table (the lobby remembers who it already looked at and
// forgets them when they leave). Guests, bots and the host are never checked. If the host is offline when
// someone joins, the check is retried on the next tick.
//
// Exports: startDebtWatch({ lobbyManager }), netLifetimeBalance(userId), DEBT_LIMIT.

const WebSocket = require('ws');
const db = require('./db');
const { isGuestUserId } = require('./guest');

const DEBT_LIMIT = 50;          // warn when net lifetime balance is below -$50
const TICK_MS = 2000;
const FORGET_AFTER_MS = 30 * 1000;   // how long someone must be gone before they count as a new arrival

const lower = (s) => String(s || '').trim().toLowerCase();

// Sum of what others owe this user minus what this user owes others (positive = owed to them).
function netLifetimeBalance(userId) {
    if (!userId || typeof db.getLifetimeBalances !== 'function') return 0;
    let net = 0;
    for (const row of db.getLifetimeBalances(userId) || []) net += Number(row.net) || 0;
    return Math.round(net * 100) / 100;
}

function userIdOf(lobbyManager, lobby, entry) {
    let uid = entry.userId || null;
    if (!uid && typeof lobbyManager.resolveUserId === 'function') {
        try { uid = lobbyManager.resolveUserId(lobby, entry.accountUsername || entry.username) || null; } catch (e) {}
    }
    if (!uid || isGuestUserId(uid) || String(uid).startsWith('gst_')) return null;
    return String(uid);
}

function hostSocket(lobby) {
    const h = lower(lobby.host);
    if (!h) return null;
    const hp = (lobby.players || []).find(p => lower(p.username) === h || lower(p.accountUsername) === h);
    const ws = hp && hp.id;
    return ws && ws.readyState === WebSocket.OPEN ? { ws, hp } : null;
}

function checkLobby(lobby, lobbyManager, now) {
    if (!lobby || !lobby.host) return;
    if (!lobby.__debtSeen) lobby.__debtSeen = new Map();   // userId -> last time we saw them at this table
    const seen = lobby.__debtSeen;

    const here = [];
    for (const p of lobby.players || []) if (p && !p.isBot) here.push(p);
    for (const s of lobby.spectators || []) if (s) here.push(s);

    const present = new Set();
    const fresh = [];
    for (const entry of here) {
        const uid = userIdOf(lobbyManager, lobby, entry);
        if (!uid) continue;
        present.add(uid);
        if (!seen.has(uid)) fresh.push({ uid, entry });
        else seen.set(uid, now);
    }

    // forget people who have been gone a while, so a later return is checked again
    for (const [uid, last] of seen) {
        if (!present.has(uid) && now - last > FORGET_AFTER_MS) seen.delete(uid);
    }

    if (!fresh.length) return;
    const host = hostSocket(lobby);
    if (!host) return;                                      // host offline: try again next tick
    const hostUid = userIdOf(lobbyManager, lobby, host.hp);

    for (const { uid, entry } of fresh) {
        if (uid === hostUid || lower(entry.username) === lower(lobby.host)) { seen.set(uid, now); continue; }
        seen.set(uid, now);
        const net = netLifetimeBalance(uid);
        if (net < -DEBT_LIMIT) {
            try {
                host.ws.send(JSON.stringify({
                    type: 'DEBT_WARNING',
                    username: entry.username,
                    owed: Math.round(-net * 100) / 100
                }));
            } catch (e) {}
        }
    }
}

function startDebtWatch({ lobbyManager }) {
    const timer = setInterval(() => {
        const now = Date.now();
        const all = lobbyManager.lobbies || {};
        for (const code of Object.keys(all)) {
            try { checkLobby(all[code], lobbyManager, now); } catch (e) { /* never let a bad lobby stop the watcher */ }
        }
    }, TICK_MS);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { startDebtWatch, netLifetimeBalance, checkLobby, DEBT_LIMIT };
