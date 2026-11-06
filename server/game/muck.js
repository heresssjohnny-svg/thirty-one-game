// server/game/muck.js - "Muck" button: after a knock, throw in your hand and take the loss.
// MUCK { } from a seated human who has not taken their final turn yet ends the round
// immediately; they lose one life (see lobbyManager.handleMuck). server.js calls
// handleMuckMessage() before handing a message to wsHandler.

function handleMuckMessage(ws, msg, lobbyManager) {
    if (!msg || msg.type !== 'MUCK' || !lobbyManager) return false;
    const lobbies = lobbyManager.lobbies || {};
    const find = (match) => {
        for (const code of Object.keys(lobbies)) {
            const seat = (lobbies[code].players || []).find(pl => !pl.isBot && match(pl));
            if (seat) return { lobby: lobbies[code], seat };
        }
        return null;
    };
    let hit = null;
    const byCode = ws && ws.currentLobbyCode && lobbies[ws.currentLobbyCode];
    if (byCode) {
        const seat = (byCode.players || []).find(pl => !pl.isBot && pl.id === ws);
        if (seat) hit = { lobby: byCode, seat };
    }
    if (!hit) hit = find(pl => pl.id && pl.id === ws) ||
        (msg.userId ? find(pl => pl.userId && String(pl.userId) === String(msg.userId)) : null);
    if (!hit) return true;
    lobbyManager.handleMuck(hit.lobby, hit.seat);
    return true;
}

module.exports = { handleMuckMessage };
