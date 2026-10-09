// server/game/wsHandler.js - Resilient Background Reconnection & Anti-Kick Grace Period
const WebSocket = require('ws');
const {
    lobbies,
    getLobbies,
    createLobby,
    joinLobby,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    handleSetReady,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    handlePoolCardSelection,
    checkNextHandReady,
    leaveLobby,
    getPublicLobbiesList,
    syncLifetimeLedgerBalances
} = require('./lobbyManager');
const { addBotToLobby, removeBotFromLobby } = require('./bot');

function initWebSocketHandler(wss) {
    function broadcastLobbyList() {
        const payload = JSON.stringify({
            type: 'LOBBY_LIST',
            lobbies: getPublicLobbiesList()
        });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }

    wss.on('connection', (ws) => {
        let currentLobbyCode = null;
        let currentUsername = null;

        ws.on('message', (message) => {
            let data;
            try {
                data = JSON.parse(message);
            } catch (err) {
                return;
            }

            switch (data.type) {
                case 'GET_LOBBIES':
                case 'REFRESH_LOBBIES': {
                    ws.send(JSON.stringify({
                        type: 'LOBBY_LIST',
                        lobbies: getPublicLobbiesList()
                    }));
                    break;
                }

                case 'CREATE_LOBBY': {
                    const username = (data.username || 'Player1').trim();
                    const lobbyName = (data.lobbyName || `${username}'s Table`).trim();
                    const isPrivate = Boolean(data.isPrivate);

                    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
                    currentLobbyCode = code;
                    currentUsername = username;

                    const lobby = createLobby(code, lobbyName, username, isPrivate);
                    joinLobby(ws, code, username);

                    ws.send(JSON.stringify({
                        type: 'LOBBY_CREATED',
                        code,
                        lobby: getSanitizedLobby(lobby, ws)
                    }));

                    broadcastLobbyUpdate(code);
                    broadcastLobbyList();
                    break;
                }

                case 'JOIN_LOBBY': {
                    const code = (data.code || '').trim().toUpperCase();
                    const username = (data.username || 'Player1').trim();

                    const lobby = lobbies[code];
                    if (!lobby) {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Table does not exist.' }));
                        return;
                    }

                    currentLobbyCode = code;
                    currentUsername = username;

                    // Re-associate existing player if returning from background/reconnecting
                    const existingPlayer = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
                    if (existingPlayer) {
                        existingPlayer.id = ws;
                        existingPlayer.disconnectedAt = null;

                        ws.send(JSON.stringify({
                            type: 'LOBBY_JOINED',
                            code,
                            isSpectator: false,
                            lobby: getSanitizedLobby(lobby, ws)
                        }));
                        broadcastLobbyUpdate(code);
                        return;
                    }

                    const existingSpectator = lobby.spectators.find(s => s.username.toLowerCase() === username.toLowerCase());
                    if (existingSpectator) {
                        existingSpectator.idSocket = ws;

                        ws.send(JSON.stringify({
                            type: 'LOBBY_JOINED',
                            code,
                            isSpectator: true,
                            lobby: getSanitizedLobby(lobby, ws)
                        }));
                        broadcastLobbyUpdate(code);
                        return;
                    }

                    const result = joinLobby(ws, code, username);
                    if (!result.success) {
                        ws.send(JSON.stringify({ type: 'ERROR', message: result.message }));
                        return;
                    }

                    ws.send(JSON.stringify({
                        type: 'LOBBY_JOINED',
                        code,
                        isSpectator: result.isSpectator,
                        lobby: getSanitizedLobby(lobby, ws)
                    }));

                    broadcastLobbyUpdate(code);
                    broadcastLobbyList();
                    break;
                }

                case 'SET_READY': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    handleSetReady(lobbies[currentLobbyCode], currentUsername, data.ready);
                    break;
                }

                case 'CHOOSE_POOL_CARD': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    const cardIdx = data.cardIndex !== undefined ? data.cardIndex : (data.index !== undefined ? data.index : data.slotIndex);
                    if (typeof cardIdx === 'number') {
                        handlePoolCardSelection(lobbies[currentLobbyCode], currentUsername, cardIdx);
                    }
                    break;
                }

                case 'DRAW_DECK':
                case 'DRAW_DISCARD': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    handleTurnAction(lobbies[currentLobbyCode], ws, data.type);
                    break;
                }

                case 'DISCARD_CARD': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    const cIdx = data.cardIndex !== undefined ? data.cardIndex : data.index;
                    if (typeof cIdx === 'number') {
                        handleDiscardAction(lobbies[currentLobbyCode], ws, cIdx);
                    }
                    break;
                }

                case 'KNOCK': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    handleKnock(lobbies[currentLobbyCode], ws);
                    break;
                }

                case 'NEXT_HAND_READY':
                case 'NEXT_HAND': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    const lobby = lobbies[currentLobbyCode];
                    const player = lobby.players.find(p => p.username.toLowerCase() === currentUsername?.toLowerCase());
                    if (player) {
                        player.nextHandReady = true;
                        broadcastLobbyUpdate(currentLobbyCode);
                        checkNextHandReady(lobby);
                    }
                    break;
                }

                case 'SIT_DOWN': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    const lobby = lobbies[currentLobbyCode];
                    if (lobby.gameState !== 'lobby' || lobby.players.length >= 6) return;

                    const specIdx = lobby.spectators.findIndex(s => s.username.toLowerCase() === currentUsername?.toLowerCase());
                    if (specIdx !== -1) {
                        lobby.spectators.splice(specIdx, 1);
                        joinLobby(ws, currentLobbyCode, currentUsername);
                        broadcastLobbyUpdate(currentLobbyCode);
                        broadcastLobbyList();
                    }
                    break;
                }

                case 'STAND_UP': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    const lobby = lobbies[currentLobbyCode];
                    if (lobby.gameState !== 'lobby') return;

                    const pIdx = lobby.players.findIndex(p => p.username.toLowerCase() === currentUsername?.toLowerCase());
                    if (pIdx !== -1) {
                        lobby.players.splice(pIdx, 1);
                        lobby.spectators.push({ idSocket: ws, username: currentUsername, inVC: false, isMuted: true });
                        broadcastLobbyUpdate(currentLobbyCode);
                        broadcastLobbyList();
                    }
                    break;
                }

                case 'ADD_BOT': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    addBotToLobby(lobbies[currentLobbyCode]);
                    broadcastLobbyUpdate(currentLobbyCode);
                    broadcastLobbyList();
                    break;
                }

                case 'REMOVE_BOT': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    removeBotFromLobby(lobbies[currentLobbyCode]);
                    broadcastLobbyUpdate(currentLobbyCode);
                    broadcastLobbyList();
                    break;
                }

                case 'LEAVE_LOBBY': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        leaveLobby(ws, currentLobbyCode, broadcastLobbyList);
                        currentLobbyCode = null;
                        currentUsername = null;
                        ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                    }
                    break;
                }

                case 'CHAT_MESSAGE': {
                    if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
                    const lobby = lobbies[currentLobbyCode];
                    const text = (data.message || '').trim();
                    if (!text) return;

                    if (!lobby.chatHistory) lobby.chatHistory = [];
                    lobby.chatHistory.push({
                        username: currentUsername || 'Player',
                        message: text,
                        timestamp: Date.now()
                    });
                    if (lobby.chatHistory.length > 50) lobby.chatHistory.shift();

                    broadcastLobbyUpdate(currentLobbyCode);
                    break;
                }
            }
        });

        // Background / Disconnect Grace Period
        ws.on('close', () => {
            if (!currentLobbyCode || !lobbies[currentLobbyCode]) return;
            const lobby = lobbies[currentLobbyCode];

            // Mark player disconnected rather than kicking them
            const player = lobby.players.find(p => p.id === ws);
            if (player) {
                player.id = null;
                player.disconnectedAt = Date.now();
                broadcastLobbyUpdate(currentLobbyCode);
            }

            const spectator = lobby.spectators.find(s => s.idSocket === ws);
            if (spectator) {
                spectator.idSocket = null;
            }
        });
    });
}

module.exports = { initWebSocketHandler };
