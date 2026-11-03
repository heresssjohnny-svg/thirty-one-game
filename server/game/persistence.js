// server/game/persistence.js - Keeps lobbies alive across server restarts
//
// Every deploy restarts the pm2 process, which used to wipe every table (and
// any mid-game session ledger that had not yet been synced to SQLite). This
// module snapshots the in-memory `lobbies` object to a JSON file every few
// seconds and on shutdown, and restores it on boot:
//
//   - sockets and timers are stripped from the snapshot (they cannot be saved)
//   - on restore every human is marked disconnected (their client auto-rejoins
//     the room within a few seconds, which re-attaches the socket)
//   - the timers a running round depends on are re-armed from the saved state
//     (shuffle & deal window, round-over auto-advance, tournament-end reset,
//     inactivity cleanup), and the turn clock is held for RESTORE_GRACE_MS so
//     the AI does not play for people who are still reconnecting
//
// Nothing in lobbyManager.js is modified; everything here works through its
// exported functions and the shared `lobbies` object.

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', '..', 'lobbies-state.json');
const SAVE_INTERVAL_MS = Number(process.env.LOBBY_SAVE_INTERVAL_MS) || 2000;
const RESTORE_GRACE_MS = Number(process.env.RESTORE_GRACE_MS) || 15000;   // how long after boot before turn timers / bots resume
const MAX_SNAPSHOT_AGE_MS = 60 * 60 * 1000; // ignore snapshots older than an hour

let lm = null;              // lobbyManager module (lazy: see getLm)
let broadcastLobbyList = () => {};
let saveTimer = null;
let lastSerialized = null;

// -------------------------------------------------------------
// Serialising
// -------------------------------------------------------------

function isSocket(v) {
    return v && typeof v === 'object' && typeof v.send === 'function' && 'readyState' in v;
}

function isTimer(v) {
    return v && typeof v === 'object' && v.constructor && v.constructor.name === 'Timeout';
}

// Deep copy that drops sockets, timers and functions, and guards against cycles
function clean(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        return typeof value === 'function' ? undefined : value;
    }
    if (isSocket(value) || isTimer(value)) return null;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(v => {
            const c = clean(v, seen);
            return c === undefined ? null : c;
        });
    }
    const out = {};
    for (const k of Object.keys(value)) {
        const c = clean(value[k], seen);
        if (c !== undefined) out[k] = c;
    }
    return out;
}

function serialize(lobbies) {
    const snapshot = {};
    for (const code of Object.keys(lobbies)) {
        const lobby = lobbies[code];
        if (!lobby) continue;
        // A table with no humans at all is not worth keeping
        const hasHuman = (lobby.players || []).some(p => !p.isBot) || (lobby.spectators || []).length > 0;
        if (!hasHuman) continue;
        snapshot[code] = clean(lobby);
    }
    return JSON.stringify({ savedAt: Date.now(), version: 1, lobbies: snapshot });
}

function getLm() {
    if (!lm) lm = require('./lobbyManager');
    return lm;
}

function saveNow(reason) {
    getLm();
    try {
        const data = serialize(lm.lobbies);
        if (data === lastSerialized && reason !== 'shutdown') return true;
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, STATE_FILE);
        lastSerialized = data;
        return true;
    } catch (e) {
        console.warn('[Persistence] save failed:', e.message);
        return false;
    }
}

// -------------------------------------------------------------
// Restoring
// -------------------------------------------------------------

function markEveryoneDisconnected(lobby, now) {
    (lobby.players || []).forEach(p => {
        p.id = null;
        p.readyTimeout = null;
        p.readyDeadline = null;
        if (!p.isBot) p.disconnectedAt = now;
    });
    (lobby.spectators || []).forEach(s => {
        s.idSocket = null;
        s.disconnectedAt = now;
    });
    lobby.inactivityTimer = null;
    lobby.roundOverAutoTimer = null;
    lobby.turnTimeoutTimer = null;
    lobby.dealingTimer = null;
    lobby.turnDeadline = null;
    lobby.pendingBotDraw = {};
}

// Re-create the timers that the saved game state depends on
function rearmTimers(lobby, now) {
    const code = lobby.code;
    const cur = () => lm.lobbies[code];
    const state = lobby.gameState;

    // Inactivity cleanup (5 min) — humans count as active while recently disconnected
    lm.touchLobbyActivity(lobby, broadcastLobbyList);

    if (state === 'dealerDraw' || state === 'tieBreaker') {
        setTimeout(() => { const l = cur(); if (l) lm.scheduleBotActions(l); }, 1500);
        return;
    }

    if (state === 'playing' || state === 'finalTurn') {
        if (lobby.dealingUntil && lobby.dealingUntil > now) {
            // Shuffle & deal window still open: close it when it was due
            const remaining = lobby.dealingUntil - now;
            lobby.dealingTimer = setTimeout(() => {
                const l = cur();
                if (!l || !l.dealingUntil) return;
                l.dealingTimer = null;
                l.dealingUntil = null;
                if (l.gameState !== 'playing') return;
                const turnPlayer = l.players[l.turnIndex];
                l.phaseMessage = `Round started! Turn: ${turnPlayer ? turnPlayer.username : ''}`;
                lm.resetTurnTimer(l);
                lm.broadcastLobbyUpdate(l.code);
                lm.scheduleBotActions(l);
            }, Math.max(remaining, RESTORE_GRACE_MS));
            return;
        }
        if (lobby.dealingUntil) lobby.dealingUntil = null; // window expired while we were down

        // Hold the turn clock and bots while players reconnect. If the current
        // player reconnects earlier, wsHandler arms the clock itself.
        lobby.phaseMessage = '🔄 Server restarted — waiting for players to reconnect…';
        setTimeout(() => {
            const l = cur();
            if (!l || (l.gameState !== 'playing' && l.gameState !== 'finalTurn')) return;
            if (!l.turnTimeoutTimer) lm.resetTurnTimer(l);
            const turnPlayer = l.players[l.turnIndex];
            if (turnPlayer && !l.phaseMessage.startsWith('📢')) {
                l.phaseMessage = `Turn: ${turnPlayer.username}`;
            }
            lm.broadcastLobbyUpdate(l.code);
            lm.scheduleBotActions(l);
        }, RESTORE_GRACE_MS);
        return;
    }

    if (state === 'roundOver') {
        lobby.roundOverAutoTimer = setTimeout(() => {
            const l = cur();
            if (!l || l.gameState !== 'roundOver') return;
            const active = l.players.filter(p => !p.eliminated);
            if (active.length > 1) {
                l.players.forEach(p => { p.nextHandReady = true; });
                l.hit31Player = null;
                lm.broadcastLobbyUpdate(l.code);
                lm.startRound(l);
            } else {
                lm.checkNextHandReady(l);
            }
        }, Math.max(8000, RESTORE_GRACE_MS));
        return;
    }

    if (state === 'tournamentEnd') {
        setTimeout(() => {
            const l = cur();
            if (!l || l.gameState !== 'tournamentEnd') return;
            lm.resetLobbyToReadyRoom(l, `🏆 ${l.tournamentWinner || 'The winner'} won the match! Ready up for the next game.`, broadcastLobbyList);
        }, 6000);
        return;
    }

    // 'lobby' (waiting room): ready countdowns restart when each player rejoins
    (lobby.players || []).forEach(p => { if (!p.isBot) p.ready = false; });
}

function restore() {
    getLm();
    if (!fs.existsSync(STATE_FILE)) return 0;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
        console.warn('[Persistence] could not read saved state:', e.message);
        return 0;
    }
    const now = Date.now();
    if (!parsed || !parsed.lobbies || typeof parsed.lobbies !== 'object') return 0;
    if (now - (parsed.savedAt || 0) > MAX_SNAPSHOT_AGE_MS) {
        console.log('[Persistence] saved state is older than an hour; starting empty');
        return 0;
    }

    let restored = 0;
    for (const code of Object.keys(parsed.lobbies)) {
        const lobby = parsed.lobbies[code];
        if (!lobby || !lobby.code || !Array.isArray(lobby.players)) continue;
        if (lm.lobbies[code]) continue; // never overwrite a live lobby
        try {
            markEveryoneDisconnected(lobby, now);
            lm.lobbies[code] = lobby;
            rearmTimers(lobby, now);
            restored++;
        } catch (e) {
            console.warn(`[Persistence] could not restore lobby ${code}:`, e.message);
            delete lm.lobbies[code];
        }
    }
    const age = Math.round((now - parsed.savedAt) / 1000);
    console.log(`[Persistence] restored ${restored} lobby(ies) from a snapshot ${age}s old`);
    return restored;
}

// -------------------------------------------------------------
// Public API
// -------------------------------------------------------------

function startLobbyPersistence(opts) {
    lm = opts.lobbyManager || getLm();
    broadcastLobbyList = typeof opts.broadcastLobbyList === 'function' ? opts.broadcastLobbyList : () => {};

    const restored = restore();
    if (restored > 0 && broadcastLobbyList) broadcastLobbyList();

    saveTimer = setInterval(() => saveNow('interval'), SAVE_INTERVAL_MS);
    if (saveTimer.unref) saveTimer.unref();

    // pm2 restart/stop sends SIGINT: flush the latest state before exiting
    const onSignal = (sig) => {
        saveNow('shutdown');
        console.log(`[Persistence] state saved on ${sig}; exiting`);
        process.exit(0);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    return { restored, saveNow, stateFile: STATE_FILE };
}

module.exports = { startLobbyPersistence, saveNow, restore, serialize, clean, STATE_FILE, RESTORE_GRACE_MS };
