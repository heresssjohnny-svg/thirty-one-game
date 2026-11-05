// server/rematch.js - "Play again?" after a match, plus push notifications for rematches and missed turns.
//
// Nothing in lobbyManager.js / wsHandler.js is modified. Like stats.js and debtWatch.js, a small watcher looks
// at the shared `lobbies` object (every second).
//
// REMATCH
//   * when a table reaches 'tournamentEnd' the watcher remembers who played (real accounts) and who won;
//   * as soon as the table is back in the waiting room, each seated human with an open socket gets
//       { type:'REMATCH_PROMPT', code, winner, ready:[names], total }
//     and whenever the list of ready humans changes everyone at the table gets
//       { type:'REMATCH_STATUS', code, ready:[names], total }
//     (public/js/rematch.js shows the prompt; "Play again" is just the normal SET_READY);
//   * the first time somebody is ready, players of that match who are NOT at the table right now (left the
//     table, closed the app) get a web push "<name> is ready for a rematch at <table>" (see push.js);
//   * the memory is dropped when the next game starts or after 10 minutes.
//
// MISSED TURN
//   * when it is the turn of a human whose connection is gone (they have the offline grace period before the AI
//     plays for them), they get one push "It's your turn at <table>" per turn.
//
// Exports: startRematch({ lobbyManager }), tickLobby (for tests).

const WebSocket = require('ws');
const { sendToUser } = require('./push');
const { isGuestUserId } = require('./guest');

const MAX_AGE_MS = 10 * 60 * 1000;
const lower = (s) => String(s || '').trim().toLowerCase();

function userIdOf(lobbyManager, lobby, entry) {
    let uid = entry.userId || null;
    if (!uid && lobbyManager && typeof lobbyManager.resolveUserId === 'function') {
        try { uid = lobbyManager.resolveUserId(lobby, entry.accountUsername || entry.username) || null; } catch (e) {}
    }
    if (!uid || isGuestUserId(uid) || String(uid).startsWith('gst_')) return null;
    return String(uid);
}
const isOpen = (ws) => !!ws && ws.readyState === WebSocket.OPEN;
function send(ws, payload) { try { if (isOpen(ws)) ws.send(JSON.stringify(payload)); } catch (e) {} }

const humans = (lobby) => (lobby.players || []).filter(p => p && !p.isBot);
const readyNames = (lobby) => humans(lobby).filter(p => p.ready).map(p => p.username);

function tellTable(lobby, payload) {
    for (const p of lobby.players || []) if (p && !p.isBot) send(p.id, payload);
    for (const s of lobby.spectators || []) if (s) send(s.idSocket, payload);
}

function tickLobby(lobby, lobbyManager, now) {
    if (!lobby) return;
    const st = lobby.gameState;

    // ---- missed turn push
    if ((st === 'playing' || st === 'finalTurn') && lobby.turnDeadline && !(lobby.dealingUntil > now)) {
        const p = (lobby.players || [])[lobby.turnIndex];
        if (p && !p.isBot && !p.eliminated && !isOpen(p.id)) {
            const k = lobby.code + ':' + lobby.turnIndex + ':' + lobby.turnDeadline;
            if (lobby.__turnPushKey !== k) {
                lobby.__turnPushKey = k;
                const uid = userIdOf(lobbyManager, lobby, p);
                if (uid) {
                    const secs = Math.max(1, Math.round((lobby.turnDeadline - now) / 1000));
                    sendToUser(uid, {
                        title: "It's your turn",
                        body: `Your turn at ${lobby.name || 'your table'}. About ${secs}s before the AI plays for you.`,
                        url: '/', tag: 'turn-' + lobby.code
                    }, { kind: 'turn', ttl: 30 }).catch(() => {});
                }
            }
        }
    }

    // ---- rematch
    if (st === 'tournamentEnd') {
        if (!lobby.__rm) {
            const roster = [];
            for (const p of humans(lobby)) {
                const uid = userIdOf(lobbyManager, lobby, p);
                if (uid) roster.push({ userId: uid, name: p.username });
            }
            lobby.__rm = { roster, winner: lobby.tournamentWinner || null, at: now, prompted: false, pushed: false, key: '' };
        }
        return;
    }
    const rm = lobby.__rm;
    if (!rm) return;
    if (st !== 'lobby' || now - rm.at > MAX_AGE_MS) { lobby.__rm = null; return; }

    const ready = readyNames(lobby), total = humans(lobby).length;
    if (!rm.prompted) {
        rm.prompted = true;
        const payload = { type: 'REMATCH_PROMPT', code: lobby.code, winner: rm.winner, ready, total };
        for (const p of humans(lobby)) send(p.id, payload);
        rm.key = ready.join('|') + '/' + total;
        return;
    }
    const key = ready.join('|') + '/' + total;
    if (key !== rm.key) {
        rm.key = key;
        tellTable(lobby, { type: 'REMATCH_STATUS', code: lobby.code, ready, total });
    }
    if (ready.length && !rm.pushed) {
        rm.pushed = true;
        const here = new Set();
        for (const p of humans(lobby)) if (isOpen(p.id)) { const u = userIdOf(lobbyManager, lobby, p); if (u) here.add(u); }
        for (const r of rm.roster) {
            if (here.has(r.userId)) continue;
            sendToUser(r.userId, {
                title: 'Rematch?',
                body: `${ready[0]} is ready for a rematch at ${lobby.name || 'your table'}.`,
                url: '/?join=' + lobby.code, tag: 'rematch-' + lobby.code
            }, { kind: 'rematch', ttl: 600 }).catch(() => {});
        }
    }
}

function startRematch({ lobbyManager }) {
    const timer = setInterval(() => {
        const lobbies = lobbyManager.lobbies || {};
        const now = Date.now();
        for (const code of Object.keys(lobbies)) {
            try { tickLobby(lobbies[code], lobbyManager, now); }
            catch (err) { console.error('[Rematch] tick failed:', err.message); }
        }
    }, 1000);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { startRematch, tickLobby, MAX_AGE_MS };
