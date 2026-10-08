// server/game/wsHandler.js - WebSocket Connection Lifecycle & Action Router
const WebSocket = require('ws');
const config = require('../config');
const { generateLiveKitToken } = require('../services/livekit');
const lobbyManager = require('./lobbyManager');
const ledger = require('./ledger');

function setupWebSocket(wss) {
    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        let currentCode = null;
        let currentUser = null;

        ws.on('message', async (message) => {
            let data;
            try {
                data = JSON.parse(message);
            } catch (err) {
                return;
            }

            if (!data || typeof data !== 'object') return;
            const lobbies = lobbyManager.getLobbies();
            let lobby = currentCode ? lobbies[currentCode] : null;

            if (lobby) {
                lobbyManager.touchLobbyActivity(lobby, () => broadcastLobbyList(wss));
            }

            switch (data.type) {
                case 'CREATE_LOBBY': {
                    currentUser = (data.username || 'Player1').trim();
                    const lobbyName = (data.lobbyName || `${currentUser}'s Table`).trim();
                    const isPrivate = !!data.isPrivate;

                    currentCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                    lobbies[currentCode] = {
                        code: currentCode,
                        name: lobbyName,
                        host: currentUser,
                        isPrivate: isPrivate,
                        gameState: 'lobby',
                        deck: [],
                        discardPile: [],
                        drawPool: [],
                        drawResults: {},
                        turnIndex: 0,
                        dealerIndex: 0,
                        lastGameWinner: null,
                        hit31Player: null,
                        knockedBy: null,
                        finalTurnsRemaining: 0,
                        turnsTakenThisRound: 0,
                        lastDiscardPickup: null,
                        lastDiscardDonor: null,
                        initialDealCard: null,
                        fedCardReminders: {},
                        fedCardsHistory: [],
                        chatHistory: [],
                        playlist: [],
                        currentSongIndex: 0,
                        isPlaying: false,
                        activeBets: [],
                        pendingBets: [],
                        globalProposals: [],
                        sideBetLedger: {},
                        mainGameLedger: {},
                        botBetLedger: {},
                        spectators: [],
                        players: [{
                            id: ws,
                            username: currentUser,
                            lives: 2,
                            wager: 5,
                            cards: [],
                            ready: false,
                            seat: 0,
                            nextHandReady: false,
                            eliminated: false,
                            inVC: true,
                            isMuted: true,
                            isBot: false,
                            isNewArrival: false,
                            peekAllowed: {},
                            peekRequests: {}
                        }]
                    };

                    const token = await generateLiveKitToken(currentCode, currentUser);
                    ws.send(JSON.stringify({
                        type: 'LOBBY_CREATED',
                        code: currentCode,
                        lobby: lobbyManager.getSanitizedLobby(lobbies[currentCode], ws),
                        livekitToken: token,
                        livekitHost: config.LIVEKIT_HOST
                    }));

                    broadcastLobbyList(wss);
                    break;
                }

                case 'JOIN_LOBBY': {
                    const code = (data.code || '').trim().toUpperCase();
                    currentUser = (data.username || 'Player').trim();
                    const targetLobby = lobbies[code];

                    if (!targetLobby) {
                        return ws.send(JSON.stringify({ type: 'ERROR', message: 'Table not found.' }));
                    }

                    currentCode = code;

                    // Reconnection & Seating Logic
                    const existingPlayer = targetLobby.players.find(p => p.username.toLowerCase() === currentUser.toLowerCase());
                    const existingSpec = targetLobby.spectators.find(s => s.username.toLowerCase() === currentUser.toLowerCase());

                    if (existingPlayer) {
                        existingPlayer.id = ws;
                        // Purge from spectators if they reconnect
                        targetLobby.spectators = targetLobby.spectators.filter(s => s.username.toLowerCase() !== currentUser.toLowerCase());
                    } else if (existingSpec) {
                        existingSpec.idSocket = ws;
                    } else if (targetLobby.players.length < 6 && targetLobby.gameState === 'lobby') {
                        targetLobby.players.push({
                            id: ws,
                            username: currentUser,
                            lives: 2,
                            wager: 5,
                            cards: [],
                            ready: false,
                            seat: lobbyManager.findOpenSeat(targetLobby),
                            nextHandReady: false,
                            eliminated: false,
                            inVC: true,
                            isMuted: true,
                            isBot: false,
                            isNewArrival: true,
                            peekAllowed: {},
                            peekRequests: {}
                        });
                    } else {
                        targetLobby.spectators.push({
                            idSocket: ws,
                            username: currentUser,
                            inVC: true,
                            isMuted: true
                        });
                    }

                    const token = await generateLiveKitToken(currentCode, currentUser);
                    ws.send(JSON.stringify({
                        type: 'LOBBY_JOINED',
                        code: currentCode,
                        lobby: lobbyManager.getSanitizedLobby(targetLobby, ws),
                        livekitToken: token,
                        livekitHost: config.LIVEKIT_HOST
                    }));

                    lobbyManager.broadcastLobbyUpdate(currentCode);
                    broadcastLobbyList(wss);
                    break;
                }

                case 'REFRESH_LOBBIES': {
                    ws.send(JSON.stringify({
                        type: 'LOBBY_LIST',
                        lobbies: lobbyManager.getPublicLobbiesList()
                    }));
                    break;
                }

                case 'SET_READY': {
                    if (lobby && lobby.gameState === 'lobby') {
                        const player = lobby.players.find(p => p.id === ws);
                        if (player) {
                            player.ready = !!data.ready;
                        }
                        const active = lobbyManager.getActiveParticipants(lobby);
                        if (active.length >= 2 && active.every(p => p.ready)) {
                            lobbyManager.startRound(lobby);
                        } else {
                            lobbyManager.broadcastLobbyUpdate(currentCode);
                        }
                    }
                    break;
                }

                case 'SIT_DOWN': {
                    if (lobby && lobby.gameState === 'lobby') {
                        const specIdx = lobby.spectators.findIndex(s => s.idSocket === ws);
                        if (specIdx !== -1 && lobby.players.length < 6) {
                            const spec = lobby.spectators.splice(specIdx, 1)[0];
                            lobby.players.push({
                                id: ws,
                                username: spec.username,
                                lives: 2,
                                wager: 5,
                                cards: [],
                                ready: false,
                                seat: lobbyManager.findOpenSeat(lobby),
                                nextHandReady: false,
                                eliminated: false,
                                inVC: spec.inVC,
                                isMuted: spec.isMuted,
                                isBot: false,
                                isNewArrival: true,
                                peekAllowed: {},
                                peekRequests: {}
                            });
                            lobbyManager.broadcastLobbyUpdate(currentCode);
                            broadcastLobbyList(wss);
                        }
                    }
                    break;
                }

                case 'STAND_UP': {
                    if (lobby && lobby.gameState === 'lobby') {
                        const pIdx = lobby.players.findIndex(p => p.id === ws);
                        if (pIdx !== -1) {
                            const p = lobby.players.splice(pIdx, 1)[0];
                            lobby.spectators.push({
                                idSocket: ws,
                                username: p.username,
                                inVC: p.inVC,
                                isMuted: p.isMuted
                            });
                            lobbyManager.broadcastLobbyUpdate(currentCode);
                            broadcastLobbyList(wss);
                        }
                    }
                    break;
                }

                case 'DRAW_DECK': {
                    if (lobby) lobbyManager.handleTurnAction(lobby, ws, 'DRAW_DECK');
                    break;
                }

                case 'DRAW_DISCARD': {
                    if (lobby) lobbyManager.handleTurnAction(lobby, ws, 'DRAW_DISCARD');
                    break;
                }

                case 'DISCARD_CARD': {
                    if (lobby) {
                        const index = (data.cardIndex !== undefined) ? data.cardIndex : data.index;
                        lobbyManager.handleDiscardAction(lobby, ws, Number(index));
                    }
                    break;
                }

                case 'KNOCK': {
                    if (lobby) lobbyManager.handleKnock(lobby, ws, () => lobbyManager.broadcastLobbyUpdate(currentCode));
                    break;
                }

                case 'NEXT_HAND': {
                    if (lobby && lobby.gameState === 'roundOver') {
                        const p = lobby.players.find(pl => pl.id === ws);
                        if (p) p.nextHandReady = true;
                        lobbyManager.checkNextHandReady(lobby);
                    }
                    break;
                }

                case 'CHOOSE_POOL_CARD': {
                    if (lobby && lobby.gameState === 'tieBreaker') {
                        lobbyManager.handlePoolCardSelection(lobby, currentUser, Number(data.cardIndex));
                    }
                    break;
                }

                case 'REQUEST_PEEK': {
                    if (lobby) {
                        const targetUser = (data.targetUser || '').toLowerCase();
                        const targetPlayer = lobby.players.find(p => p.username.toLowerCase() === targetUser);
                        if (targetPlayer) {
                            if (!targetPlayer.peekRequests) targetPlayer.peekRequests = {};
                            targetPlayer.peekRequests[currentUser] = true;
                            lobbyManager.broadcastLobbyUpdate(currentCode);
                        }
                    }
                    break;
                }

                case 'ACCEPT_PEEK': {
                    if (lobby) {
                        const myPlayer = lobby.players.find(p => p.id === ws);
                        const specName = data.spectatorUsername;
                        if (myPlayer && specName) {
                            if (!myPlayer.peekAllowed) myPlayer.peekAllowed = {};
                            myPlayer.peekAllowed[specName] = true;
                            if (myPlayer.peekRequests) delete myPlayer.peekRequests[specName];
                            lobbyManager.broadcastLobbyUpdate(currentCode);
                        }
                    }
                    break;
                }

                case 'DENY_PEEK': {
                    if (lobby) {
                        const myPlayer = lobby.players.find(p => p.id === ws);
                        const specName = data.spectatorUsername;
                        if (myPlayer && specName && myPlayer.peekRequests) {
                            delete myPlayer.peekRequests[specName];
                            lobbyManager.broadcastLobbyUpdate(currentCode);
                        }
                    }
                    break;
                }

                case 'STOP_PEEK': {
                    if (lobby) {
                        lobby.players.forEach(p => {
                            if (p.peekAllowed && p.peekAllowed[currentUser]) {
                                delete p.peekAllowed[currentUser];
                            }
                        });
                        lobbyManager.broadcastLobbyUpdate(currentCode);
                    }
                    break;
                }

                case 'KICK_PEEKER': {
                    if (lobby) {
                        const myPlayer = lobby.players.find(p => p.id === ws);
                        const specName = data.spectatorUsername;
                        if (myPlayer && specName && myPlayer.peekAllowed) {
                            delete myPlayer.peekAllowed[specName];
                            lobbyManager.broadcastLobbyUpdate(currentCode);
                        }
                    }
                    break;
                }

                case 'CLEAR_DEBT': {
                    if (lobby) {
                        ledger.clearDebt(lobby, currentUser, data.targetUser, data.category);
                        lobbyManager.broadcastLobbyUpdate(currentCode);
                    }
                    break;
                }

                case 'CHAT_MESSAGE': {
                    if (lobby && data.message) {
                        const payload = JSON.stringify({
                            type: 'CHAT_MESSAGE',
                            username: currentUser,
                            message: String(data.message).substring(0, 200)
                        });
                        [...lobby.players, ...lobby.spectators].forEach(participant => {
                            const socket = participant.id || participant.idSocket;
                            if (socket && socket.readyState === WebSocket.OPEN) {
                                socket.send(payload);
                            }
                        });
                    }
                    break;
                }

                case 'LEAVE_LOBBY': {
                    if (lobby) {
                        lobbyManager.leaveLobby(ws, currentCode, () => broadcastLobbyList(wss));
                    }
                    ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                    currentCode = null;
                    break;
                }
            }
        });

        ws.on('close', () => {
            if (currentCode && lobbies[currentCode]) {
                const lobby = lobbies[currentCode];
                // Detach socket reference without dropping the seated player's lives/cards
                const p = lobby.players.find(pl => pl.id === ws);
                if (p) p.id = null;
                const s = lobby.spectators.find(sp => sp.idSocket === ws);
                if (s) s.idSocket = null;
            }
        });
    });
}

function broadcastLobbyList(wss) {
    const list = lobbyManager.getPublicLobbiesList();
    const payload = JSON.stringify({ type: 'LOBBY_LIST', lobbies: list });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

module.exports = {
    setupWebSocket,
    broadcastLobbyList
};
