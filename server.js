const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

// LiveKit Configuration
const LIVEKIT_API_KEY = 'thirtyone-chat';
const LIVEKIT_API_SECRET = '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e';
const LIVEKIT_HOST = 'ws://135.181.43.233:7880';

function generateLiveKitToken(roomName, participantName) {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: participantName,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    return at.toJwt();
}

const lobbies = {};

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

// WebSocket Keep-Alive to prevent mobile OS TCP teardowns
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

wss.on('close', () => clearInterval(heartbeatInterval));

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
            else points = parseInt(v, 10);
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

function broadcastVoiceRoster(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let roster = [];
    lobby.players.forEach(p => { if (p.inVC) roster.push({ username: p.username, isMuted: p.isMuted }); });
    lobby.spectators.forEach(s => { if (s.inVC) roster.push({ username: s.username, isMuted: s.isMuted }); });
    broadcastLobbyEvent(code, { type: 'SYNC_VOICE_ROSTER', roster });
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

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
                case 'CREATE_LOBBY': {
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
                        songStartedAt: null,
                        songPausedAtOffset: 0,
                        inactivityTimer: null
                    };
                    touchLobbyActivity(lobbies[currentLobbyCode]);
                    
                    let token = generateLiveKitToken(currentLobbyCode, currentUsername);
                    ws.send(JSON.stringify({ 
                        type: 'LOBBY_JOINED', 
                        lobby: getSanitizedLobby(lobbies[currentLobbyCode], ws),
                        livekitHost: LIVEKIT_HOST,
                        livekitToken: token
                    }));
                    broadcastLobbyList();
                    broadcastVoiceRoster(currentLobbyCode);
                    break;
                }

                case 'JOIN_LOBBY': {
                    let code = (data.code || '').toUpperCase();
                    if (lobbies[code]) {
                        if (currentLobbyCode && currentLobbyCode !== code) leaveLobby(ws, currentLobbyCode);
                        currentLobbyCode = code;
                        currentUsername = (data.username || 'Player').trim();
                        let lobby = lobbies[code];
                        touchLobbyActivity(lobby);

                        let token = generateLiveKitToken(code, currentUsername);

                        let existingPlayer = lobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
                        if (existingPlayer) {
                            existingPlayer.id = ws;
                            ws.send(JSON.stringify({ 
                                type: 'LOBBY_JOINED', 
                                lobby: getSanitizedLobby(lobby, ws),
                                livekitHost: LIVEKIT_HOST,
                                livekitToken: token
                            }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyEvent(code, { type: 'PLAY_SOUND', sound: 'join' });
                            broadcastVoiceRoster(code);
                            broadcastLobbyList();
                            return;
                        }

                        let existingSpec = lobby.spectators.find(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (existingSpec) {
                            existingSpec.idSocket = ws;
                            ws.send(JSON.stringify({ 
                                type: 'LOBBY_JOINED', 
                                lobby: getSanitizedLobby(lobby, ws),
                                livekitHost: LIVEKIT_HOST,
                                livekitToken: token
                            }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyEvent(code, { type: 'PLAY_SOUND', sound: 'join' });
                            broadcastVoiceRoster(code);
                            broadcastLobbyList();
                            return;
                        }

                        if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat: availableSeat, nextHandReady: false, eliminated: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} });
                        } else {
                            lobby.spectators.push({ username: currentUsername, idSocket: ws, inVC: true, isMuted: true });
                        }

                        ws.send(JSON.stringify({ 
                            type: 'LOBBY_JOINED', 
                            lobby: getSanitizedLobby(lobby, ws),
                            livekitHost: LIVEKIT_HOST,
                            livekitToken: token
                        }));
                        broadcastLobbyUpdate(code);
                        broadcastLobbyEvent(code, { type: 'PLAY_SOUND', sound: 'join' });
                        broadcastVoiceRoster(code);
                        broadcastLobbyList();
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                    }
                    break;
                }

                case 'REQUEST_LIVEKIT_TOKEN': {
                    if (currentLobbyCode && currentUsername) {
                        let token = generateLiveKitToken(currentLobbyCode, currentUsername);
                        ws.send(JSON.stringify({ 
                            type: 'LIVEKIT_TOKEN', 
                            livekitHost: LIVEKIT_HOST, 
                            livekitToken: token 
                        }));
                    }
                    break;
                }

                case 'UPDATE_VC_STATUS': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let p = lobby.players.find(pl => pl.id === ws) || lobby.spectators.find(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (p) {
                            p.inVC = !!data.inVC;
                            p.isMuted = !!data.isMuted;
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastVoiceRoster(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'ADD_PLAYLIST_SONG': {
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
                                lobby.songStartedAt = Date.now();
                                lobby.songPausedAtOffset = 0;
                            }
                            lobby.phaseMessage = `🎵 ${currentUsername} added "${title}" to queue!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'REMOVE_PLAYLIST_SONG': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let index = data.index;
                        if (lobby.playlist?.[index]) {
                            let removed = lobby.playlist.splice(index, 1)[0];
                            if (lobby.playlist.length === 0) {
                                lobby.isPlaying = false;
                                lobby.songStartedAt = null;
                                lobby.songPausedAtOffset = 0;
                            } else if (lobby.currentSongIndex >= lobby.playlist.length) {
                                lobby.currentSongIndex = 0;
                                lobby.songStartedAt = Date.now();
                                lobby.songPausedAtOffset = 0;
                            } else if (lobby.currentSongIndex === index) {
                                lobby.songStartedAt = Date.now();
                                lobby.songPausedAtOffset = 0;
                            }
                            lobby.phaseMessage = `🎵 ${currentUsername} removed "${removed.title}".`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'CONTROL_MUSIC': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        if (data.action === 'PLAY') {
                            if (!lobby.isPlaying) {
                                lobby.isPlaying = true;
                                lobby.songStartedAt = Date.now() - (lobby.songPausedAtOffset * 1000);
                            }
                        } else if (data.action === 'PAUSE') {
                            if (lobby.isPlaying) {
                                lobby.isPlaying = false;
                                let elapsed = lobby.songStartedAt ? Math.floor((Date.now() - lobby.songStartedAt) / 1000) : 0;
                                lobby.songPausedAtOffset = Math.max(0, elapsed);
                            }
                        } else if (data.action === 'SKIP' && lobby.playlist?.length > 0) {
                            lobby.currentSongIndex = (lobby.currentSongIndex + 1) % lobby.playlist.length;
                            lobby.isPlaying = true;
                            lobby.songStartedAt = Date.now();
                            lobby.songPausedAtOffset = 0;
                        } else if (data.action === 'SELECT' && typeof data.index === 'number' && lobby.playlist?.[data.index]) {
                            lobby.currentSongIndex = data.index;
                            lobby.isPlaying = true;
                            lobby.songStartedAt = Date.now();
                            lobby.songPausedAtOffset = 0;
                        }
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                    break;
                }

                case 'STAND_UP': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let playerIdx = lobby.players.findIndex(p => p.id === ws);
                        if (playerIdx !== -1) {
                            let leaving = lobby.players.splice(playerIdx, 1)[0];
                            lobby.spectators.push({ username: leaving.username, idSocket: ws, inVC: leaving.inVC, isMuted: leaving.isMuted });
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastVoiceRoster(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;
                }

                case 'SIT_DOWN': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let specIdx = lobby.spectators.findIndex(s => s.idSocket === ws || s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (specIdx !== -1 && lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let spec = lobby.spectators.splice(specIdx, 1)[0];
                            let seat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: spec.username, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat, nextHandReady: false, eliminated: false, inVC: spec.inVC, isMuted: spec.isMuted, peekRequests: {}, peekAllowed: {} });
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastVoiceRoster(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;
                }

                case 'REFRESH_LOBBIES': {
                    ws.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: getPublicLobbiesList() }));
                    break;
                }

                case 'UPDATE_WAGER': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let player = lobbies[currentLobbyCode].players.find(p => p.id === ws);
                        if (player && lobbies[currentLobbyCode].gameState === 'lobby') {
                            player.wager = parseInt(data.wager, 10) || 5;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'UPDATE_SETTINGS': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.host.toLowerCase() === currentUsername.toLowerCase() && lobby.gameState === 'lobby') {
                            if (data.lives) {
                                let l = parseInt(data.lives, 10);
                                lobby.players.forEach(p => p.lives = Math.max(0, l));
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'CLEAR_DEBT': {
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
                }

                case 'PROPOSE_ELIMINATION_BET': {
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
                }

                case 'PROPOSE_GLOBAL_SIDE_BET': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let activeParts = getActiveParticipants(lobby);
                        if (lobby.gameState !== 'lobby' && activeParts.length === 2) {
                            lobby.globalProposals.push({
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: current
