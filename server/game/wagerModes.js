// server/game/wagerModes.js - Table type (wager mode) and the Free wager option
//
// lobby.wagerMode decides what players may put on the table:
//   'mixed' (default) - each player picks Free ($0) or $5 / $10 / $20
//   'free'            - wager-free table: everyone plays for $0
//   'paid'            - wager-only table: Free is not available
//
// lobbyManager.wagerOf(entry, lobby) applies the mode when it computes the pot,
// the snapshot and the payouts, so the table type always wins over whatever is
// stored on a seat. This module handles the two messages that change things:
//
//   SET_WAGER_MODE { mode }  - room creator only, waiting room only
//   UPDATE_WAGER { wager }   - Free (0) is applied here, because wsHandler clamps
//                              wagers to at least $1; money amounts on a mixed or
//                              wager-only table go on to wsHandler as before.
//
// server.js calls handleWagerMessage() before handing a message to wsHandler;
// it returns true when the message has been dealt with here.

const WebSocket = require('ws');

const MODES = ['mixed', 'free', 'paid'];
const MODE_LABELS = {
    mixed: 'free or wager',
    free: 'wager-free',
    paid: 'wager-only'
};

function modeOf(lobby) {
    return (lobby && MODES.includes(lobby.wagerMode)) ? lobby.wagerMode : 'mixed';
}

function sendError(ws, message) {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ERROR', message }));
    } catch (e) {}
}

// The seat (non-bot player) this socket / account holds, in any lobby
function findSeat(lobbies, ws, userId) {
    const codes = Object.keys(lobbies || {});
    const scan = (match) => {
        for (const code of codes) {
            const seat = (lobbies[code].players || []).find(pl => !pl.isBot && match(pl));
            if (seat) return { code, lobby: lobbies[code], seat };
        }
        return null;
    };
    return scan(pl => pl.id && pl.id === ws) ||
        (userId ? scan(pl => pl.userId && String(pl.userId) === String(userId)) : null);
}

function handleWagerMessage(ws, msg, lobbyManager, broadcastLobbyList) {
    if (!msg || !lobbyManager) return false;
    const lobbies = lobbyManager.lobbies || {};

    if (msg.type === 'SET_WAGER_MODE') {
        let code = ws.currentLobbyCode && lobbies[ws.currentLobbyCode] ? ws.currentLobbyCode : null;
        if (!code) {
            const hit = findSeat(lobbies, ws, msg.userId);
            code = hit ? hit.code : null;
        }
        const lobby = code ? lobbies[code] : null;
        if (!lobby) return true;

        const mode = String(msg.mode || '').toLowerCase();
        if (!MODES.includes(mode)) return true;
        if (!lobbyManager.isLobbyHost(lobby, ws, ws.currentUsername)) {
            sendError(ws, 'Only the room creator can change the table type.');
            return true;
        }
        if (lobby.gameState !== 'lobby') {
            sendError(ws, 'The table type can only be changed in the waiting room.');
            return true;
        }
        if (modeOf(lobby) === mode) return true;

        lobby.wagerMode = mode;
        // Wager-only: anyone sitting on Free goes back to the $5 default
        if (mode === 'paid') {
            (lobby.players || []).forEach(p => { if (p.wager === 0 || p.wager === '0') p.wager = 5; });
        }
        lobby.phaseMessage = `💵 ${lobby.host} made this a ${MODE_LABELS[mode]} table.`;
        if (typeof lobbyManager.touchLobbyActivity === 'function') lobbyManager.touchLobbyActivity(lobby, broadcastLobbyList);
        lobbyManager.broadcastLobbyUpdate(code);
        return true;
    }

    if (msg.type === 'UPDATE_WAGER') {
        const wantFree = Number(msg.wager) === 0;
        const hit = findSeat(lobbies, ws, msg.userId);
        if (!hit) return wantFree;   // nothing to update; money amounts may still be handled by wsHandler

        const mode = modeOf(hit.lobby);
        if (mode === 'free') return true;   // wager-free table: everyone stays on Free
        if (!wantFree) return false;        // money amount on a mixed / wager-only table -> wsHandler

        if (mode === 'paid') {
            sendError(ws, 'This is a wager-only table. Free play is not available.');
            return true;
        }
        if (hit.lobby.gameState === 'lobby') {
            hit.seat.wager = 0;
            if (typeof lobbyManager.touchLobbyActivity === 'function') lobbyManager.touchLobbyActivity(hit.lobby, broadcastLobbyList);
            lobbyManager.broadcastLobbyUpdate(hit.code);
        }
        return true;
    }

    return false;
}

module.exports = { handleWagerMessage, modeOf, MODES };
