const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const lobbies = {};

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            let points = 10;
            let drawVal = parseInt(v) || (v === 'A' ? 14 : (v === 'K' ? 13 : (v === 'Q' ? 12 : 11)));
            if (v === 'A') points = 11;
            else if (['J', 'Q', 'K'].includes(v)) points = 10;
            else points = parseInt(v);
            deck.push({ suit: s, val: v, points, drawVal });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function touchLobbyActivity(lobby) {
    if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
    lobby.inactivityTimer = setTimeout(() => closeInactiveLobby(lobby.code), 20 * 60 * 1000);
}

function closeInactiveLobby(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let closePayload = JSON.stringify({ type: 'ERROR', message: 'Lobby closed due to inactivity.' });
    lobby.players.forEach(p => { if (p.id?.readyState === WebSocket.OPEN) { p.id.send(closePayload); p.id.send(JSON.stringify({ type: 'LEFT_LOBBY' })); } });
    lobby.spectators.forEach(s => { if (s.idSocket?.readyState === WebSocket.OPEN) { s.idSocket.send(closePayload); s.idSocket.send(JSON.stringify({ type: 'LEFT_LOBBY' })); } });
    if (lobby.nextHandTimer) clearTimeout(lobby.nextHandTimer);
    delete lobbies[code];
    broadcastLobbyList();
}

function broadcastLobbyEvent(code, payload) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let msg = JSON.stringify(payload);
    lobby.players.forEach(p => { if (p.id?.readyState === WebSocket.OPEN) p.id.send(msg); });
    lobby.spectators.forEach(s => { if (s.idSocket?.readyState === WebSocket.OPEN) s.idSocket.send(msg); });
}

wss.on('connection', (ws) => {
    let currentLobbyCode = null;
    let currentUsername = null;

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        try {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                touchLobbyActivity(lobbies[currentLobbyCode]);
            }

            switch (data.type) {
                case 'CREATE_LOBBY':
                    currentUsername = (data.username || 'Player').trim();
                    if (currentLobbyCode && lobbies[currentLobbyCode]) leaveLobby(ws, currentLobbyCode);

                    currentLobbyCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                    lobbies[currentLobbyCode] = {
                        code: currentLobbyCode,
                        name: data.lobbyName || `${currentUsername}'s Lobby`,
                        host: currentUsername,
                        isPrivate: !!data.isPrivate,
                        players: [{ id: ws, username: currentUsername, lives: 2, wager: 5, cards: [], ready: false, seat: 0, nextHandReady: false, eliminated: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} }],
                        spectators: [],
                        deck: [],
                        discardPile: [],
                        gameState: 'lobby',
                        drawPool: [],
                        drawResults: {},
                        drawOrderSequence: [],
                        tiedParticipantsList: [],
                        phaseMessage: null,
                        initialDealCard: null,
                        lastDiscardPickup: null,
                        lastDiscardDonor: null,
                        fedCardReminders: {},
                        turnIndex: 0,
                        dealerIndex: 0,
                        lastGameWinner: null,
                        sideBetLedger: {},
                        mainGameLedger: {},
                        pendingBets: [],
                        activeBets: [],
                        globalProposals: [],
                        knockedBy: null,
                        finalTurnsRemaining: 0,
                        turnsTakenThisRound: 0,
                        nextHandTimer: null,
                        lastDiscarder: null,
                        fedCardsTracker: {},
                        endGameVotes: {},
                        chatHistory: [],
                        playlist: [],
                        currentSongIndex: 0,
                        isPlaying: false,
                        inactivityTimer: null
                    };
                    touchLobbyActivity(lobbies[currentLobbyCode]);
                    ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobbies[currentLobbyCode], ws) }));
                    broadcastLobbyList();
                    break;

                case 'JOIN_LOBBY':
                    let code = (data.code || '').toUpperCase();
                    if (lobbies[code]) {
                        if (currentLobbyCode && currentLobbyCode !== code) leaveLobby(ws, currentLobbyCode);
                        currentLobbyCode = code;
                        currentUsername = (data.username || 'Player').trim();
                        let lobby = lobbies[code];
                        touchLobbyActivity(lobby);

                        let existingPlayer = lobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
                        if (existingPlayer) {
                            existingPlayer.id = ws;
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyEvent(code, { type: 'PLAY_SOUND', sound: 'join' });
                            broadcastLobbyList();
                            return;
                        }

                        let existingSpec = lobby.spectators.find(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (existingSpec) {
                            existingSpec.idSocket = ws;
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyEvent(code, { type: 'PLAY_SOUND', sound: 'join' });
                            broadcastLobbyList();
                            return;
                        }

                        if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat: availableSeat, nextHandReady: false, eliminated: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} });
                        } else {
                            lobby.spectators.push({ username: currentUsername, idSocket: ws, inVC: true, isMuted: true });
                        }

                        ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                        broadcastLobbyUpdate(code);
                        broadcastLobbyEvent(code, { type: 'PLAY_SOUND', sound: 'join' });
                        broadcastLobbyList();
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                    }
                    break;

                case 'ADD_PLAYLIST_SONG':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let title = (data.title || '').trim();
                        let url = (data.url || '').trim();
                        if (title && url) {
                            if (!lobby.playlist) lobby.playlist = [];
                            lobby.playlist.push({ title, url });
                            if (lobby.playlist.length === 1) {
                                lobby.currentSongIndex = 0;
                                lobby.isPlaying = true;
                            }
                            lobby.phaseMessage = `🎵 ${currentUsername} added "${title}" to queue!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'REMOVE_PLAYLIST_SONG':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let index = data.index;
                        if (lobby.playlist?.[index]) {
                            let removed = lobby.playlist.splice(index, 1)[0];
                            if (lobby.currentSongIndex >= lobby.playlist.length) {
                                lobby.currentSongIndex = Math.max(0, lobby.playlist.length - 1);
                            }
                            lobby.phaseMessage = `🎵 ${currentUsername} removed "${removed.title}".`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CONTROL_MUSIC':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        if (data.action === 'PLAY') lobby.isPlaying = true;
                        else if (data.action === 'PAUSE') lobby.isPlaying = false;
                        else if (data.action === 'SKIP' && lobby.playlist?.length > 0) {
                            lobby.currentSongIndex = (lobby.currentSongIndex + 1) % lobby.playlist.length;
                            lobby.isPlaying = true;
                        } else if (data.action === 'SELECT' && typeof data.index === 'number' && lobby.playlist?.[data.index]) {
                            lobby.currentSongIndex = data.index;
                            lobby.isPlaying = true;
                        }
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                    break;

                case 'RECONNECT_VOICE':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        lobbies[currentLobbyCode].phaseMessage = `🎙️ ${currentUsername} triggered a voice chat reconnect for everyone!`;
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                    break;

                case 'STAND_UP':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let playerIdx = lobby.players.findIndex(p => p.id === ws);
                        if (playerIdx !== -1) {
                            let leaving = lobby.players.splice(playerIdx, 1)[0];
                            lobby.spectators.push({ username: leaving.username, idSocket: ws, inVC: leaving.inVC, isMuted: leaving.isMuted });
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;

                case 'SIT_DOWN':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let specIdx = lobby.spectators.findIndex(s => s.idSocket === ws || s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (specIdx !== -1 && lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let spec = lobby.spectators.splice(specIdx, 1)[0];
                            let seat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: spec.username, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat, nextHandReady: false, eliminated: false, inVC: spec.inVC, isMuted: spec.isMuted, peekRequests: {}, peekAllowed: {} });
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;

                case 'REFRESH_LOBBIES':
                    ws.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: getPublicLobbiesList() }));
                    break;

                case 'UPDATE_WAGER':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let player = lobbies[currentLobbyCode].players.find(p => p.id === ws);
                        if (player && lobbies[currentLobbyCode].gameState === 'lobby') {
                            player.wager = parseInt(data.wager) || 5;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'UPDATE_SETTINGS':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.host.toLowerCase() === currentUsername.toLowerCase() && lobby.gameState === 'lobby') {
                            if (data.lives) {
                                let l = parseInt(data.lives);
                                lobby.players.forEach(p => p.lives = Math.max(0, l));
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'UPDATE_VC_STATUS':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let p = lobbies[currentLobbyCode].players.find(pl => pl.id === ws) || lobbies[currentLobbyCode].spectators.find(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (p) {
                            p.inVC = !!data.inVC;
                            p.isMuted = !!data.isMuted;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CLEAR_DEBT':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let targetUser = data.targetUser;
                        let category = data.category;
                        let targetLedger = category === 'main' ? lobby.mainGameLedger : lobby.sideBetLedger;

                        if (targetLedger) {
                            if (targetLedger[targetUser] && targetLedger[targetUser][currentUsername] !== undefined) {
                                targetLedger[targetUser][currentUsername] = 0;
                            }
                            if (targetLedger[currentUsername] && targetLedger[currentUsername][targetUser] !== undefined) {
                                targetLedger[currentUsername][targetUser] = 0;
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'PROPOSE_ELIMINATION_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let activeParts = getActiveParticipants(lobby);
                        let isSpec = lobby.spectators.some(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (!isSpec && lobby.gameState !== 'lobby' && activeParts.length >= 3) {
                            lobby.pendingBets.push({
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                target: data.target,
                                pickUser: data.target,
                                targetSurvivor: currentUsername,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                type: 'eliminate',
                                delivered: {}
                            });
                            lobby.phaseMessage = `🤝 First to Lose Bet proposed by ${currentUsername} to ${data.target}!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'PROPOSE_GLOBAL_SIDE_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let activeParts = getActiveParticipants(lobby);
                        if (lobby.gameState !== 'lobby' && activeParts.length === 2) {
                            lobby.globalProposals.push({
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                pickUser: data.pickUser,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                acceptedBy: []
                            });
                            lobby.phaseMessage = `📢 Global Side Bet offered by ${currentUsername}: I like ${data.pickUser} for $${data.wagerAmt}!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'ACCEPT_GLOBAL_PROPOSAL':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let prop = lobbies[currentLobbyCode].globalProposals.find(gp => gp.id === data.proposalId);
                        if (prop && !prop.acceptedBy.includes(currentUsername) && prop.proposer !== currentUsername) {
                            prop.acceptedBy.push(currentUsername);
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CONFIRM_GLOBAL_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let prop = lobby.globalProposals.find(gp => gp.id === data.proposalId && gp.proposer === currentUsername);
                        if (prop && prop.acceptedBy.includes(data.acceptedUser)) {
                            if (data.confirm) {
                                lobby.activeBets.push({
                                    id: Math.random().toString(36).substring(2, 8),
                                    proposer: prop.proposer,
                                    target: data.acceptedUser,
                                    pickUser: prop.pickUser,
                                    wagerAmt: prop.wagerAmt,
                                    type: 'win'
                                });
                            }
                            prop.acceptedBy = prop.acceptedBy.filter(u => u !== data.acceptedUser);
                            if (prop.acceptedBy.length === 0) lobby.globalProposals = lobby.globalProposals.filter(gp => gp.id !== prop.id);
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'RESPOND_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let betIdx = lobby.pendingBets.findIndex(b => b.id === data.betId);
                        if (betIdx !== -1) {
                            let bet = lobby.pendingBets.splice(betIdx, 1)[0];
                            if (data.accept) lobby.activeBets.push(bet);
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'SET_READY':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'lobby' && !player.eliminated) {
                            player.ready = !!data.ready;
                            let activeParts = getActiveParticipants(lobby);
                            if (activeParts.every(p => p.ready) && activeParts.length >= 2) {
                                if (lobby.lastGameWinner && lobby.players.some(p => p.username === lobby.lastGameWinner)) {
                                    let winIdx = lobby.players.findIndex(p => p.username === lobby.lastGameWinner);
                                    lobby.dealerIndex = winIdx !== -1 ? winIdx : 0;
                                    startRound(lobby);
                                } else {
                                    startDealerDrawPhase(lobby);
                                }
                            } else {
                                broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                    }
                    break;

                case 'NEXT_HAND':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'roundOver' && !player.eliminated) {
                            player.nextHandReady = true;
                            broadcastLobbyUpdate(currentLobbyCode);
                            checkNextHandReady(lobby);
                        }
                    }
                    break;

                case 'END_GAME_PROPOSAL':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (!lobby.endGameVotes) lobby.endGameVotes = {};
                        lobby.endGameVotes[currentUsername] = true;
                        let activeParts = getActiveParticipants(lobby);
                        if (activeParts.every(p => lobby.endGameVotes[p.username])) {
                            resetLobbyToReadyRoom(lobby, "⚠️ Game ended! Returning to waiting room.");
                        } else {
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'REQUEST_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let target = lobbies[currentLobbyCode].players.find(p => p.username.toLowerCase() === (data.targetUsername || '').toLowerCase());
                        if (target) {
                            if (!target.peekRequests) target.peekRequests = {};
                            target.peekRequests[currentUsername] = true;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'RESPOND_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let player = lobbies[currentLobbyCode].players.find(p => p.id === ws);
                        if (player) {
                            delete player.peekRequests?.[data.spectatorUsername];
                            if (data.allow) {
                                if (!player.peekAllowed) player.peekAllowed = {};
                                player.peekAllowed[data.spectatorUsername] = true;
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'STOP_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        lobby.players.forEach(pl => {
                            if (pl.peekAllowed) delete pl.peekAllowed[currentUsername];
                        });
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                    break;

                case 'KICK_PEEKER':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && player.peekAllowed) {
                            delete player.peekAllowed[data.spectatorUsername];
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CHOOSE_POOL_CARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
                            let p = lobby.players.find(pl => pl.id === ws);
                            handlePoolCardSelection(lobby, p ? p.username : currentUsername, data.cardIndex);
                        }
                    }
                    break;

                case 'CHAT_MESSAGE':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let chatPayload = { type: 'CHAT_MESSAGE', username: currentUsername, message: data.message };
                        lobbies[currentLobbyCode].players.forEach(p => p.id?.send(JSON.stringify(chatPayload)));
                        lobbies[currentLobbyCode].spectators.forEach(s => s.idSocket?.send(JSON.stringify(chatPayload)));
                    }
                    break;

                case 'WEBRTC_SIGNAL':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let targetRec = [...lobbies[currentLobbyCode].players, ...lobbies[currentLobbyCode].spectators.map(s => ({ username: s.username, id: s.idSocket }))].find(r => r.username === data.target);
                        if (targetRec?.id?.readyState === WebSocket.OPEN) {
                            targetRec.id.send(JSON.stringify({ type: 'WEBRTC_SIGNAL', lobbyCode: currentLobbyCode, sender: currentUsername, signal: data.signal }));
                        }
                    }
                    break;

                case 'DRAW_DECK':
                case 'DRAW_DISCARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) handleTurnAction(lobbies[currentLobbyCode], ws, data.type);
                    break;

                case 'DISCARD_CARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) handleDiscardAction(lobbies[currentLobbyCode], ws, data.cardIndex);
                    break;

                case 'KNOCK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) handleKnock(lobbies[currentLobbyCode], ws);
                    break;

                case 'LEAVE_LOBBY':
                    leaveLobby(ws, currentLobbyCode);
                    currentLobbyCode = null;
                    ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                    break;
            }
        } catch (err) {
            console.error(err);
        }
    });

    ws.on('close', () => {});
});

function getActiveParticipants(lobby) { return lobby.players.filter(p => !p.eliminated); }
function findOpenSeat(lobby) { let occ = lobby.players.map(p => p.seat); for (let i = 0; i < 6; i++) { if (!occ.includes(i)) return i; } return 0; }

function leaveLobby(ws, code) {
    if (!lobbies[code]) return;
    let lobby = lobbies[code];
    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);
    if (lobby.players.length === 0) delete lobbies[code];
    else broadcastLobbyUpdate(code);
    broadcastLobbyList();
}

function getPublicLobbiesList() {
    return Object.values(lobbies).filter(l => !l.isPrivate).map(l => ({ code: l.code, name: l.name, host: l.host, count: l.players.length, state: l.gameState }));
}

function broadcastLobbyList() {
    let list = getPublicLobbiesList();
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: list })); });
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    lobby.players.forEach(p => { if (p.id?.readyState === WebSocket.OPEN) p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, p.id) })); });
    lobby.spectators.forEach(s => { if (s.idSocket?.readyState === WebSocket.OPEN) s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, s.idSocket) })); });
}

function getSanitizedLobby(lobby, wsId) {
    let activeParts = getActiveParticipants(lobby);
    let allParticipants = [...lobby.players];
    let requestingPlayer = lobby.players.find(p => p.id === wsId);
    let requestingSpectator = lobby.spectators.find(s => s.idSocket === wsId);
    let myUsername = requestingPlayer ? requestingPlayer.username : (requestingSpectator?.username || null);

    let sortedParticipants = [...allParticipants];
    if (myUsername) {
        let idx = sortedParticipants.findIndex(p => p.username === myUsername);
        if (idx !== -1) sortedParticipants = sortedParticipants.slice(idx).concat(sortedParticipants.slice(0, idx));
    }
    sortedParticipants.forEach((p, i) => p.seat = i);

    let myUnrespondedBets = (lobby.pendingBets || []).filter(b => b.target === myUsername && !b.delivered[myUsername]);
    myUnrespondedBets.forEach(b => b.delivered[myUsername] = true);

    let myFedReminder = null;
    if (myUsername && lobby.fedCardReminders?.[myUsername] && lobby.gameState !== 'roundOver') {
        let rem = lobby.fedCardReminders[myUsername];
        let targetPlayer = lobby.players.find(p => p.username === rem.target);
        if (targetPlayer && targetPlayer.cards && targetPlayer.cards.some(c => c.val === rem.card.val && c.suit === rem.card.suit)) {
            myFedReminder = rem;
        } else {
            delete lobby.fedCardReminders[myUsername];
        }
    }

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        deckCount: lobby.deck.length,
        turnIndex: lobby.turnIndex,
        dealerIndex: lobby.dealerIndex,
        currentTurnUser: allParticipants[lobby.turnIndex]?.username || '',
        phaseMessage: lobby.phaseMessage,
        canKnock: lobby.turnsTakenThisRound >= activeParts.length,
        potTotal: allParticipants.reduce((sum, p) => sum + (p.wager || 5), 0),
        sidePotTotal: (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0),
        lastGameWinner: lobby.lastGameWinner || null,
        myFedCardReminder: myFedReminder,
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        pendingBetsForMe: myUnrespondedBets,
        globalProposals: lobby.globalProposals || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: activeParts.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: lobby.drawPool.map((c, i) => ({ index: i, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults,
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        knockedBy: lobby.knockedBy || null,
        chatHistory: lobby.chatHistory || [],
        playlist: lobby.playlist || [],
        currentSongIndex: lobby.currentSongIndex || 0,
        isPlaying: !!lobby.isPlaying,
        players: lobby.players.map(p => {
            let canSee = lobby.gameState === 'roundOver' || p.username === myUsername;
            let specAllowed = requestingSpectator && p.peekAllowed?.[requestingSpectator.username];
            let sortedRef = sortedParticipants.find(sp => sp.username === p.username);
            return {
                username: p.username,
                lives: Math.max(0, p.lives),
                wager: p.wager || 5,
                cardCount: p.cards.length,
                ready: p.ready,
                seat: sortedRef ? sortedRef.seat : p.seat,
                nextHandReady: p.nextHandReady,
                eliminated: p.eliminated,
                inVC: !!p.inVC,
                isMuted: !!p.isMuted,
                peekIncoming: wsId === p.id ? (p.peekRequests || {}) : {},
                peekAllowed: p.peekAllowed || {},
                cards: (canSee || specAllowed) ? p.cards : []
            };
        }),
        spectators: lobby.spectators.map(s => ({ username: s.username, inVC: !!s.inVC, isMuted: !!s.isMuted }))
    };
}

function startDealerDrawPhase(lobby) {
    let deck = createDeck();
    lobby.drawPool = deck.map(c => ({ card: c, chosenBy: null }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.turnsTakenThisRound = 0;
    lobby.players.forEach(p => { if (!p.eliminated) p.nextHandReady = false; });
    broadcastLobbyUpdate(lobby.code);
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.gameState === 'tieBreaker' && !lobby.tiedParticipantsList.includes(username)) return;
    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        let card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        if (!lobby.drawOrderSequence) lobby.drawOrderSequence = [];
        lobby.drawOrderSequence.push({ username, card });
        broadcastLobbyUpdate(lobby.code);

        let activeParts = getActiveParticipants(lobby);
        if (lobby.gameState === 'dealerDraw' && activeParts.every(p => lobby.drawResults[p.username])) {
            let entries = Object.entries(lobby.drawResults).map(([u, c]) => ({ username: u, card: c })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            lobby.dealerIndex = lobby.players.findIndex(p => p.username === entries[0].username);
            lobby.phaseMessage = `🎉 ${entries[0].username} drew lowest and is Dealer!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => { if (lobbies[lobby.code]) startRound(lobbies[lobby.code]); }, 3500);
        } else if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.every(u => lobby.drawResults[u])) {
            let entries = lobby.tiedParticipantsList.map(u => ({ username: u, card: lobby.drawResults[u] })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            let loser = lobby.players.find(p => p.username === entries[0].username);
            if (loser) {
                loser.lives = Math.max(0, loser.lives - 1);
                resolveFirstToLoseBets(lobby, loser.username);
                if (loser.lives <= 0) { loser.eliminated = true; lobby.spectators.push({ idSocket: loser.id, username: loser.username }); }
            }
            if (getActiveParticipants(lobby).length === 1) awardTournamentWinner(lobby, getActiveParticipants(lobby)[0]);
            else {
                advanceDealerToNextActive(lobby);
                triggerRoundOver(lobby, `${entries[0].username} drew lowest in tie-breaker and lost a life!`);
            }
        }
    }
}

function advanceDealerToNextActive(lobby) {
    let nextDealer = (lobby.dealerIndex + 1) % lobby.players.length;
    let safetyCounter = 0;
    while (lobby.players[nextDealer].eliminated && safetyCounter < lobby.players.length) {
        nextDealer = (nextDealer + 1) % lobby.players.length;
        safetyCounter++;
    }
    lobby.dealerIndex = nextDealer;
}

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsTracker = {};
    lobby.knockedBy = null;
    lobby.gameState = 'playing';
    lobby.phaseMessage = null;
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;

    let activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1) { awardTournamentWinner(lobby, activeParts[0]); return; }

    activeParts.forEach(p => { p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()]; p.nextHandReady = false; });
    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = { val: firstDiscard.val, suit: firstDiscard.suit };
    lobby.lastDiscardDonor = null;

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    broadcastLobbyUpdate(lobby.code);
}

function handleTurnAction(lobby, ws, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        let card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };

        if (lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
            lobby.lastDiscardPickup = { username: currentPlayer.username, card: { val: card.val, suit: card.suit } };
        }

        if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== currentPlayer.username) {
            if (!lobby.fedCardReminders) lobby.fedCardReminders = {};
            lobby.fedCardReminders[lobby.lastDiscardDonor] = {
                target: currentPlayer.username,
                card: { val: card.val, suit: card.suit }
            };
        }
    }

    if (calculateBestFourCardScore(currentPlayer.cards) === 31) {
        lobby.players.forEach(p => {
            if (p !== currentPlayer && !p.eliminated) {
                p.lives = Math.max(0, p.lives - 1);
                resolveFirstToLoseBets(lobby, p.username);
                if (p.lives <= 0) { p.eliminated = true; lobby.spectators.push({ idSocket: p.id, username: p.username }); }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points!`);
        return;
    }
    broadcastLobbyUpdate(lobby.code);
}

function handleDiscardAction(lobby, ws, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.cards.length !== 4) return;

    let discarded = currentPlayer.cards[cardIndex];
    if (currentPlayer.pickedUpDiscardCard && discarded.val === currentPlayer.pickedUpDiscardCard.val && discarded.suit === currentPlayer.pickedUpDiscardCard.suit) {
        currentPlayer.cards.splice(cardIndex, 1);
        lobby.discardPile.push(discarded);
        currentPlayer.pickedUpDiscardCard = null;
        if (lobby.lastDiscardPickup?.username === currentPlayer.username && lobby.lastDiscardPickup.card.val === discarded.val && lobby.lastDiscardPickup.card.suit === discarded.suit) {
            lobby.lastDiscardPickup = null;
        }
        lobby.phaseMessage = `📢 ${currentPlayer.username} put the discard back. Must draw from deck!`;
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    currentPlayer.cards.splice(cardIndex, 1);
    currentPlayer.pickedUpDiscardCard = null;
    lobby.discardPile.push(discarded);

    if (lobby.fedCardReminders) {
        for (let donor in lobby.fedCardReminders) {
            if (lobby.fedCardReminders[donor].target === currentPlayer.username) {
                let remCard = lobby.fedCardReminders[donor].card;
                if (remCard.val === discarded.val && remCard.suit === discarded.suit) {
                    delete lobby.fedCardReminders[donor];
                }
            }
        }
    }

    lobby.lastDiscardDonor = currentPlayer.username;

    if (lobby.lastDiscardPickup?.username === currentPlayer.username && lobby.lastDiscardPickup.card.val === discarded.val && lobby.lastDiscardPickup.card.suit === discarded.suit) {
        lobby.lastDiscardPickup = null;
    }

    lobby.turnsTakenThisRound++;
    let score = calculateScore(currentPlayer.cards);
    if (score === 31) {
        lobby.players.forEach(p => {
            if (p !== currentPlayer && !p.eliminated) {
                p.lives = Math.max(0, p.lives - 1);
                resolveFirstToLoseBets(lobby, p.username);
                if (p.lives <= 0) { p.eliminated = true; lobby.spectators.push({ idSocket: p.id, username: p.username }); }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points!`);
    } else {
        advanceTurnOrResolve(lobby);
    }
}

function advanceTurnOrResolve(lobby) {
    if (lobby.gameState === 'finalTurn') {
        lobby.finalTurnsRemaining--;
        if (lobby.finalTurnsRemaining <= 0) {
            resolveRoundEnd(lobby);
            return;
        }
    }
    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) next = (next + 1) % lobby.players.length;
    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);
}

function handleKnock(lobby, ws) {
    if (lobby.gameState !== 'playing') return;
    let p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== ws || lobby.knockedBy) return;
    let active = getActiveParticipants(lobby);
    if (lobby.turnsTakenThisRound < active.length) return;
    if (calculateScore(p.cards) < (active.length > 2 ? 21 : 25)) return;

    lobby.gameState = 'finalTurn';
    lobby.knockedBy = p.username;
    lobby.finalTurnsRemaining = active.length - 1;
    lobby.phaseMessage = `🔔 KNOCK! ${p.username} knocked! 1 final turn each.`;

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) next = (next + 1) % lobby.players.length;
    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);
}

function resolveRoundEnd(lobby) {
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    let lowest = scores[0].s;
    let tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1) {
        if (active.length === 2) triggerRoundOver(lobby, `Round tied at ${lowest} pts. No one loses a life!`);
        else {
            lobby.tiedParticipantsList = tied.map(t => t.p.username);
            lobby.drawPool = lobby.deck.map(c => ({ card: c, chosenBy: null }));
            lobby.drawResults = {};
            lobby.gameState = 'tieBreaker';
            broadcastLobbyUpdate(lobby.code);
        }
    } else {
        let loser = scores[0].p;
        let winner = scores[scores.length - 1].p;
        loser.lives = Math.max(0, loser.lives - 1);
        resolveFirstToLoseBets(lobby, loser.username);
        resolveWinSideBets(lobby, winner.username);

        if (loser.lives <= 0) { loser.eliminated = true; lobby.spectators.push({ idSocket: loser.id, username: loser.username }); }
        if (getActiveParticipants(lobby).length === 1) {
            awardTournamentWinner(lobby, getActiveParticipants(lobby)[0]);
        } else {
            advanceDealerToNextActive(lobby);
            triggerRoundOver(lobby, `Round Over! ${loser.username} had lowest score (${lowest}) and lost a life.`);
        }
    }
}

function triggerRoundOver(lobby, msg) {
    lobby.fedCardReminders = {};
    let active = getActiveParticipants(lobby);
    if (active.length === 1) { awardTournamentWinner(lobby, active[0]); return; }
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    broadcastLobbyUpdate(lobby.code);
}

function recordDebt(ledger, debtor, creditor, amount) {
    if (!ledger[debtor]) ledger[debtor] = {};
    ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + amount;
}

function resolveFirstToLoseBets(lobby, loserUsername) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};

    lobby.activeBets = lobby.activeBets.filter(b => {
        if (b.type === 'eliminate' && b.pickUser === loserUsername) {
            recordDebt(lobby.sideBetLedger, b.target, b.proposer, b.wagerAmt);
            lobby.phaseMessage = `💰 ${b.proposer} won $${b.wagerAmt} side bet against ${b.target}!`;
            return false;
        }
        return true;
    });
}

function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};

    lobby.activeBets = lobby.activeBets.filter(b => {
        if (b.type === 'win') {
            if (b.pickUser === winnerUsername) {
                recordDebt(lobby.sideBetLedger, b.target, b.proposer, b.wagerAmt);
                lobby.phaseMessage = `💰 ${b.proposer} won $${b.wagerAmt} side bet from ${b.target}!`;
                return false;
            } else {
                recordDebt(lobby.sideBetLedger, b.proposer, b.target, b.wagerAmt);
                lobby.phaseMessage = `💰 ${b.target} won $${b.wagerAmt} side bet from ${b.proposer}!`;
                return false;
            }
        }
        return true;
    });
}

function awardTournamentWinner(lobby, winner) {
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    lobby.players.forEach(p => {
        if (p.username !== winner.username) {
            let amt = p.wager || 5;
            recordDebt(lobby.mainGameLedger, p.username, winner.username, amt);
        }
    });

    lobby.lastGameWinner = winner.username;
    let winIdx = lobby.players.findIndex(p => p.username === winner.username);
    if (winIdx !== -1) lobby.dealerIndex = winIdx;

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} wins the match and will deal next game!`;
    broadcastLobbyUpdate(lobby.code);
}

function checkNextHandReady(lobby) {
    let active = getActiveParticipants(lobby);
    if (active.every(p => p.nextHandReady) && active.length > 1) {
        startRound(lobby);
    } else if (active.length <= 1) {
        resetLobbyToReadyRoom(lobby, "Match completed! Returning to waiting room.");
    }
}

function resetLobbyToReadyRoom(lobby, msg) {
    lobby.gameState = 'lobby';
    lobby.phaseMessage = msg || "Returned to waiting room.";
    lobby.endGameVotes = {};
    lobby.activeBets = [];
    lobby.pendingBets = [];
    lobby.globalProposals = [];
    lobby.knockedBy = null;
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
    lobby.fedCardReminders = {};
    lobby.initialDealCard = null;

    if (lobby.lastGameWinner) {
        let winIdx = lobby.players.findIndex(p => p.username === lobby.lastGameWinner);
        if (winIdx !== -1) lobby.dealerIndex = winIdx;
    }

    lobby.players.forEach(p => {
        p.lives = 2;
        p.eliminated = false;
        p.cards = [];
        p.ready = false;
        p.nextHandReady = false;
        p.peekRequests = {};
        p.peekAllowed = {};
    });
    lobby.spectators = [];
    broadcastLobbyUpdate(lobby.code);
    broadcastLobbyList();
}

function calculateBestFourCardScore(cards) {
    if (!cards || cards.length < 3) return 0;
    if (cards.length === 4) {
        return Math.max(
            calculateScore([cards[0], cards[1], cards[2]]),
            calculateScore([cards[0], cards[1], cards[3]]),
            calculateScore([cards[0], cards[2], cards[3]]),
            calculateScore([cards[1], cards[2], cards[3]])
        );
    }
    return calculateScore(cards);
}

function calculateScore(cards) {
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let sums = {};
    scoringCards.forEach(c => sums[c.suit] = (sums[c.suit] || 0) + c.points);
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) return 30.5;
    return Math.max(...Object.values(sums), 0);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`31! Server running on port ${PORT}`));
