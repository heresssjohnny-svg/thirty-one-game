// server/game/dealSkip.js - "Skip" for the shuffle & deal window
//
// Every hand opens with a shuffle & deal window (lobbyManager.startRound sets
// lobby.dealingUntil, DEAL_ANIMATION_MS ~11.5 s) during which no one can act.
// Seated players can vote to skip it: SKIP_DEAL { }. When every active human
// player who is connected has voted (bots never hold it up), the window is
// closed early and the first turn starts right away, exactly as the window's
// own timer would have done.
//
// Votes are kept on lobby.dealSkipVotes = { until, names: { lowerName: Name } }
// and only count for the window they were cast in (until === dealingUntil).
// After each vote every socket at the table gets
//   DEAL_SKIP_STATUS { code, until, votes: [names], needed }
// so the skip button can show "1/3".
//
// server.js calls handleDealSkipMessage() before handing a message to
// wsHandler; it returns true when the message has been dealt with here.

const WebSocket = require('ws');

function isOpen(sock) {
    return !!(sock && typeof sock === 'object' && sock.readyState === WebSocket.OPEN);
}

function send(sock, payload) {
    try { if (isOpen(sock)) sock.send(JSON.stringify(payload)); } catch (e) {}
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

// Players whose vote is needed: active, human and connected
function votersOf(lobby) {
    return (lobby.players || []).filter(p => !p.isBot && !p.eliminated && isOpen(p.id));
}

function votesFor(lobby) {
    const v = lobby.dealSkipVotes;
    if (!v || v.until !== lobby.dealingUntil) {
        lobby.dealSkipVotes = { until: lobby.dealingUntil, names: {} };
    }
    return lobby.dealSkipVotes;
}

function statusOf(lobby, code) {
    const voters = votersOf(lobby);
    const votes = votesFor(lobby);
    const counted = voters.filter(p => votes.names[String(p.username).toLowerCase()]).map(p => p.username);
    return { type: 'DEAL_SKIP_STATUS', code, until: lobby.dealingUntil || null, votes: counted, needed: voters.length };
}

function broadcastStatus(lobby, code, status) {
    const sent = new Set();
    const all = [...(lobby.players || []).map(p => p.id), ...(lobby.spectators || []).map(s => s.idSocket)];
    all.forEach(sock => {
        if (!isOpen(sock) || sent.has(sock)) return;
        sent.add(sock);
        send(sock, status);
    });
}

// Close the window now and start the first turn (mirrors startRound's dealing timer)
function endDealNow(lobby, lobbyManager) {
    lobbyManager.clearDealingWindow(lobby);
    lobby.dealSkipVotes = null;
    if (lobby.gameState !== 'playing') return;
    const turnPlayer = lobby.players[lobby.turnIndex];
    lobby.phaseMessage = `⏭️ Deal skipped! Turn: ${turnPlayer ? turnPlayer.username : ''}`;
    lobbyManager.resetTurnTimer(lobby);
    lobbyManager.broadcastLobbyUpdate(lobby.code);
    lobbyManager.scheduleBotActions(lobby);
}

function handleDealSkipMessage(ws, msg, lobbyManager) {
    if (!msg || msg.type !== 'SKIP_DEAL' || !lobbyManager) return false;
    const lobbies = lobbyManager.lobbies || {};

    let hit = null;
    const byCode = ws && ws.currentLobbyCode && lobbies[ws.currentLobbyCode];
    if (byCode) {
        const seat = (byCode.players || []).find(pl => !pl.isBot && pl.id === ws);
        if (seat) hit = { code: ws.currentLobbyCode, lobby: byCode, seat };
    }
    if (!hit) hit = findSeat(lobbies, ws, msg.userId);
    if (!hit) return true;                       // spectators / unseated: nothing to do

    const { code, lobby, seat } = hit;
    if (lobby.gameState !== 'playing' || !lobbyManager.isDealing(lobby) || seat.eliminated) {
        return true;                             // nothing to skip (window already over)
    }

    const votes = votesFor(lobby);
    votes.names[String(seat.username).toLowerCase()] = seat.username;

    const status = statusOf(lobby, code);
    if (status.needed > 0 && status.votes.length >= status.needed) {
        endDealNow(lobby, lobbyManager);
        broadcastStatus(lobby, code, { type: 'DEAL_SKIP_STATUS', code, until: null, votes: status.votes, needed: status.needed, skipped: true });
    } else {
        broadcastStatus(lobby, code, status);
    }
    return true;
}

module.exports = { handleDealSkipMessage, votersOf, statusOf };
