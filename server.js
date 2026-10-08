// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Auto-resolve config
let config;
if (fs.existsSync(path.join(__dirname, 'server', 'config.js'))) {
    config = require('./server/config');
} else if (fs.existsSync(path.join(__dirname, 'config.js'))) {
    config = require('./config');
} else {
    config = {
        PORT: process.env.PORT || 10000,
        LIVEKIT_HOST: process.env.LIVEKIT_HOST || '',
        LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || '',
        LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '',
        INACTIVITY_TIMEOUT_MS: 30 * 60 * 1000
    };
}

// Auto-resolve lobbyManager
let lobbyManager;
if (fs.existsSync(path.join(__dirname, 'server', 'game', 'lobbyManager.js'))) {
    lobbyManager = require('./server/game/lobbyManager');
} else if (fs.existsSync(path.join(__dirname, 'game', 'lobbyManager.js'))) {
    lobbyManager = require('./game/lobbyManager');
} else {
    lobbyManager = require('./lobbyManager');
}

const {
    lobbies,
    getLobbies,
    findOpenSeat,
    touchLobbyActivity,
    getPublicLobbiesList,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    startDealerDrawPhase,
    startRound,
    handlePoolCardSelection,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    checkNextHandReady,
    resetLobbyToReadyRoom,
    leaveLobby
} = lobbyManager;

// Auto-resolve livekit module
let generateLiveKitToken;
if (fs.existsSync(path.join(__dirname, 'server', 'livekit.js'))) {
    generateLiveKitToken = require('./server/livekit').generateLiveKitToken;
} else if (fs.existsSync(path.join(__dirname, 'livekit.js'))) {
    generateLiveKitToken = require('./livekit').generateLiveKitToken;
} else {
    generateLiveKitToken = async () => null;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

if (fs.existsSync(path.join(__dirname, 'public'))) {
    app.use(express.static(path.join(__dirname, 'public')));
}
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function broadcastLobbyList() {
    const list = getPublicLobbiesList();
    const payload = JSON.stringify({ type: 'LOBBY_LIST', lobbies: list });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

wss.on('connection', (ws) => {
    let currentLobbyCode = null;

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        if (data.type === 'GET_LOBBIES') {
            ws.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: getPublicLobbiesList() }));
            return;
        }

        if (data.type === 'CREATE_LOBBY') {
            const code = Math.random().toString(36).substring(2, 8).toUpperCase();
            const username = (data.username || 'Player1').trim();
            const lobbyName = (data.lobbyName || `${username}'s Table`).trim();
            const isPrivate = !!data.isPrivate;

            const newLobby = {
                code,
                name: lobbyName,
                host: username,
                isPrivate,
                gameState: 'lobby',
                defaultLives: 2,
                dealerIndex: 0,
                turnIndex: 0,
                deck: [],
                discardPile: [],
                drawPool: [],
                drawResults: {},
                drawOrderSequence: [],
                tiedParticipantsList: [],
                pendingBotDraw: {},
                phaseMessage: 'Waiting for players to ready up...',
                turnsTakenThisRound: 0,
                chatHistory: [],
                players: [{
                    id: ws,
                    username,
                    lives: 2,
                    wager: 5,
                    ready: false,
                    seat: 0,
                    cards: [],
                    eliminated: false,
                    nextHandReady: false,
                    isBot: false,
                    isNewArrival: false,
                    inVC: false,
                    isMuted: true
                }],
                spectators: [],
                activeBets: [],
                pendingBets: [],
                globalProposals: [],
                endGameVotes: {}
            };

            lobbies[code] = newLobby;
            currentLobbyCode = code;
            touchLobbyActivity(newLobby, broadcastLobbyList);

            const token = await generateLiveKitToken(code, username);
            const livekitHost = process.env.LIVEKIT_HOST || config.LIVEKIT_HOST || '';
            const initialLobbyData = getSanitizedLobby(newLobby, username);

            ws.send(JSON.stringify({
                type: 'LOBBY_CREATED',
                code,
                livekitToken: token,
                livekitHost,
                lobby: initialLobbyData
            }));

            broadcastLobbyUpdate(code);
            broadcastLobbyList();
            return;
        }

        if (data.type === 'JOIN_LOBBY') {
            const code = (data.code || '').trim().toUpperCase();
            const username = (data.username || 'Player').trim();
            const lobby = lobbies[code];

            if (!lobby) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Table not found.' }));
                return;
            }

            currentLobbyCode = code;
            touchLobbyActivity(lobby, broadcastLobbyList);

            let existingPlayer = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
            let existingSpectator = lobby.spectators.find(s => s.username.toLowerCase() === username.toLowerCase());

            if (existingPlayer) {
                existingPlayer.id = ws;
            } else if (existingSpectator) {
                existingSpectator.idSocket = ws;
            } else {
                if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const seatNum = findOpenSeat(lobby);
                    lobby.players.push({
                        id: ws,
                        username,
                        lives: lobby.defaultLives || 2,
                        wager: 5,
                        ready: false,
                        seat: seatNum,
                        cards: [],
                        eliminated: false,
                        nextHandReady: false,
                        isBot: false,
                        isNewArrival: true,
                        inVC: false,
                        isMuted: true
                    });
                } else {
                    lobby.spectators.push({
                        idSocket: ws,
                        username,
                        inVC: false,
                        isMuted: true
                    });
                }
            }

            const token = await generateLiveKitToken(code, username);
            const livekitHost = process.env.LIVEKIT_HOST || config.LIVEKIT_HOST || '';
            const initialLobbyData = getSanitizedLobby(lobby, username);

            ws.send(JSON.stringify({
                type: 'LOBBY_JOINED',
                code,
                livekitToken: token,
                livekitHost,
                lobby: initialLobbyData
            }));

            broadcastLobbyUpdate(code);
            broadcastLobbyList();
            return;
        }

        const lobby = lobbies[currentLobbyCode];
        if (!lobby) return;
        touchLobbyActivity(lobby, broadcastLobbyList);

        if (data.type === 'SIT_DOWN') {
            if (lobby.gameState !== 'lobby' || lobby.players.length >= 6) return;
            const specIdx = lobby.spectators.findIndex(s => s.idSocket === ws);
            if (specIdx !== -1) {
                const spec = lobby.spectators.splice(specIdx, 1)[0];
                const seatNum = findOpenSeat(lobby);
                lobby.players.push({
                    id: ws,
                    username: spec.username,
                    lives: lobby.defaultLives || 2,
                    wager: 5,
                    ready: false,
                    seat: seatNum,
                    cards: [],
                    eliminated: false,
                    nextHandReady: false,
                    isBot: false,
                    isNewArrival: true,
                    inVC: spec.inVC,
                    isMuted: spec.isMuted
                });
                broadcastLobbyUpdate(lobby.code);
                broadcastLobbyList();
            }
            return;
        }

        if (data.type === 'STAND_UP') {
            if (lobby.gameState !== 'lobby') return;
            const pIdx = lobby.players.findIndex(p => p.id === ws);
            if (pIdx !== -1) {
                const p = lobby.players.splice(pIdx, 1)[0];
                lobby.spectators.push({
                    idSocket: ws,
                    username: p.username,
                    inVC: p.inVC,
                    isMuted: p.isMuted
                });
                lobby.players.forEach((pl, idx) => { pl.seat = idx; });
                broadcastLobbyUpdate(lobby.code);
                broadcastLobbyList();
            }
            return;
        }

        if (data.type === 'SET_READY') {
            const player = lobby.players.find(p => p.id === ws);
            if (player) {
                player.ready = !!data.ready;
                broadcastLobbyUpdate(lobby.code);

                const seatedHumans = lobby.players.filter(p => !p.isBot);
                if (seatedHumans.length >= 1 && lobby.players.every(p => p.ready)) {
                    if (lobby.players.length >= 2) {
                        startDealerDrawPhase(lobby);
                    }
                }
            }
            return;
        }

        if (data.type === 'NEXT_HAND') {
            const player = lobby.players.find(p => p.id === ws);
            if (player && !player.eliminated) {
                player.nextHandReady = true;
                broadcastLobbyUpdate(lobby.code);
                checkNextHandReady(lobby);
            }
            return;
        }

        if (data.type === 'CHOOSE_POOL_CARD') {
            const player = lobby.players.find(p => p.id === ws);
            if (player) {
                handlePoolCardSelection(lobby, player.username, data.cardIndex);
            }
            return;
        }

        if (data.type === 'DRAW_DECK') {
            handleTurnAction(lobby, ws, 'DRAW_DECK');
            return;
        }

        if (data.type === 'DRAW_DISCARD') {
            handleTurnAction(lobby, ws, 'DRAW_DISCARD');
            return;
        }

        if (data.type === 'DISCARD_CARD') {
            const cardIndex = data.cardIndex !== undefined ? data.cardIndex : data.index;
            handleDiscardAction(lobby, ws, cardIndex);
            return;
        }

        if (data.type === 'KNOCK') {
            handleKnock(lobby, ws);
            return;
        }

        if (data.type === 'PROPOSE_ELIMINATION_BET') {
            const proposer = lobby.players.find(p => p.id === ws);
            if (proposer) {
                const betId = `bet_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                if (!lobby.pendingBets) lobby.pendingBets = [];
                lobby.pendingBets.push({
                    id: betId,
                    type: 'eliminate',
                    proposer: proposer.username,
                    target: data.target,
                    pickUser: data.target,
                    targetSurvivor: proposer.username,
                    wagerAmt: parseInt(data.wagerAmt, 10) || 5,
                    delivered: {}
                });
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'PROPOSE_GLOBAL_SIDE_BET') {
            const proposer = lobby.players.find(p => p.id === ws) || lobby.spectators.find(s => s.idSocket === ws);
            if (proposer) {
                const propId = `gprop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                if (!lobby.globalProposals) lobby.globalProposals = [];
                lobby.globalProposals.push({
                    id: propId,
                    proposer: proposer.username,
                    pickUser: data.pickUser,
                    wagerAmt: parseInt(data.wagerAmt, 10) || 5,
                    acceptedBy: []
                });
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'ACCEPT_GLOBAL_PROPOSAL') {
            const acceptor = lobby.players.find(p => p.id === ws) || lobby.spectators.find(s => s.idSocket === ws);
            if (acceptor && lobby.globalProposals) {
                const prop = lobby.globalProposals.find(g => g.id === data.proposalId);
                if (prop && prop.proposer !== acceptor.username && !prop.acceptedBy.includes(acceptor.username)) {
                    prop.acceptedBy.push(acceptor.username);
                    broadcastLobbyUpdate(lobby.code);
                }
            }
            return;
        }

        if (data.type === 'CONFIRM_GLOBAL_BET') {
            const proposer = lobby.players.find(p => p.id === ws) || lobby.spectators.find(s => s.idSocket === ws);
            if (proposer && lobby.globalProposals) {
                const propIdx = lobby.globalProposals.findIndex(g => g.id === data.proposalId);
                if (propIdx !== -1) {
                    const prop = lobby.globalProposals[propIdx];
                    if (data.confirm) {
                        if (!lobby.activeBets) lobby.activeBets = [];
                        lobby.activeBets.push({
                            id: `gbet_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                            type: 'win',
                            proposer: prop.proposer,
                            target: data.acceptedUser,
                            pickUser: prop.pickUser,
                            wagerAmt: prop.wagerAmt
                        });
                    }
                    prop.acceptedBy = prop.acceptedBy.filter(u => u !== data.acceptedUser);
                    if (prop.acceptedBy.length === 0) {
                        lobby.globalProposals.splice(propIdx, 1);
                    }
                    broadcastLobbyUpdate(lobby.code);
                }
            }
            return;
        }

        if (data.type === 'RESPOND_BET') {
            const responder = lobby.players.find(p => p.id === ws);
            if (responder && lobby.pendingBets) {
                const bIdx = lobby.pendingBets.findIndex(b => b.id === data.betId);
                if (bIdx !== -1) {
                    const bet = lobby.pendingBets.splice(bIdx, 1)[0];
                    if (data.accept) {
                        if (!lobby.activeBets) lobby.activeBets = [];
                        lobby.activeBets.push(bet);
                    }
                    broadcastLobbyUpdate(lobby.code);
                }
            }
            return;
        }

        if (data.type === 'REQUEST_PEEK') {
            const spec = lobby.spectators.find(s => s.idSocket === ws);
            const targetPlayer = lobby.players.find(p => p.username.toLowerCase() === (data.targetUsername || '').toLowerCase());
            if (spec && targetPlayer) {
                if (!targetPlayer.peekRequests) targetPlayer.peekRequests = {};
                targetPlayer.peekRequests[spec.username] = true;
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'RESPOND_PEEK') {
            const player = lobby.players.find(p => p.id === ws);
            if (player && player.peekRequests) {
                delete player.peekRequests[data.spectatorUsername];
                if (data.allow) {
                    if (!player.peekAllowed) player.peekAllowed = {};
                    player.peekAllowed[data.spectatorUsername] = true;
                }
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'STOP_PEEK') {
            const spec = lobby.spectators.find(s => s.idSocket === ws);
            if (spec) {
                lobby.players.forEach(p => {
                    if (p.peekAllowed) delete p.peekAllowed[spec.username];
                });
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'KICK_PEEKER') {
            const player = lobby.players.find(p => p.id === ws);
            if (player && player.peekAllowed && data.spectatorUsername) {
                delete player.peekAllowed[data.spectatorUsername];
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'END_GAME_PROPOSAL') {
            const player = lobby.players.find(p => p.id === ws);
            if (player) {
                if (!lobby.endGameVotes) lobby.endGameVotes = {};
                lobby.endGameVotes[player.username] = true;
                const activeHumanPlayers = lobby.players.filter(p => !p.isBot && !p.eliminated);
                const votesCount = Object.keys(lobby.endGameVotes).length;
                if (votesCount >= Math.ceil(activeHumanPlayers.length / 2)) {
                    resetLobbyToReadyRoom(lobby, "Game ended by majority vote.");
                } else {
                    lobby.phaseMessage = `End game proposal: ${votesCount}/${activeHumanPlayers.length} voted.`;
                    broadcastLobbyUpdate(lobby.code);
                }
            }
            return;
        }

        if (data.type === 'VOTE_LIVES') {
            const player = lobby.players.find(p => p.id === ws);
            if (player && lobby.livesVote) {
                lobby.livesVote.votes[player.username] = !!data.agree;
                const humanSeated = lobby.players.filter(p => !p.isBot);
                const voteVals = Object.values(lobby.livesVote.votes);
                if (voteVals.length >= humanSeated.length) {
                    const agrees = voteVals.filter(v => v === true).length;
                    if (agrees > humanSeated.length / 2) {
                        lobby.defaultLives = lobby.livesVote.proposedLives;
                        lobby.players.forEach(p => { p.lives = lobby.defaultLives; });
                        lobby.phaseMessage = `Starting lives updated to ${lobby.defaultLives}.`;
                    } else {
                        lobby.phaseMessage = `Starting lives proposal declined.`;
                    }
                    lobby.livesVote = null;
                }
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'VC_STATUS_UPDATE') {
            const player = lobby.players.find(p => p.id === ws);
            const spec = lobby.spectators.find(s => s.idSocket === ws);
            if (player) {
                player.inVC = !!data.inVC;
                player.isMuted = !!data.isMuted;
            } else if (spec) {
                spec.inVC = !!data.inVC;
                spec.isMuted = !!data.isMuted;
            }
            broadcastLobbyUpdate(lobby.code);
            return;
        }

        if (data.type === 'CHAT_MESSAGE') {
            const player = lobby.players.find(p => p.id === ws);
            const spec = lobby.spectators.find(s => s.idSocket === ws);
            const sender = player ? player.username : (spec ? spec.username : 'Guest');
            const cleanText = (data.message || '').trim().substring(0, 200);

            if (cleanText) {
                if (!lobby.chatHistory) lobby.chatHistory = [];
                lobby.chatHistory.push({ user: sender, text: cleanText });
                if (lobby.chatHistory.length > 50) lobby.chatHistory.shift();

                const chatPayload = JSON.stringify({ type: 'CHAT_MESSAGE', user: sender, text: cleanText });
                lobby.players.forEach(p => { if (p.id?.readyState === WebSocket.OPEN) p.id.send(chatPayload); });
                lobby.spectators.forEach(s => { if (s.idSocket?.readyState === WebSocket.OPEN) s.idSocket.send(chatPayload); });
            }
            return;
        }

        if (data.type === 'UPDATE_SETTINGS') {
            if (lobby.gameState === 'lobby') {
                const targetLives = data.lives ? parseInt(data.lives, 10) : 2;
                const humanSeated = lobby.players.filter(p => !p.isBot);
                const proposer = lobby.players.find(p => p.id === ws);

                if (humanSeated.length > 1 && proposer) {
                    lobby.livesVote = {
                        proposer: proposer.username,
                        proposedLives: targetLives,
                        votes: { [proposer.username]: true }
                    };
                } else {
                    lobby.defaultLives = targetLives;
                    lobby.players.forEach(p => { p.lives = lobby.defaultLives; });
                }
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'UPDATE_WAGER') {
            const player = lobby.players.find(p => p.id === ws);
            if (player && lobby.gameState === 'lobby') {
                player.wager = parseInt(data.wager, 10) || 5;
                broadcastLobbyUpdate(lobby.code);
            }
            return;
        }

        if (data.type === 'ADD_BOT') {
            if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                const botNames = ['Bot Ace', 'Bot Jack', 'Bot Queen', 'Bot King', 'Bot Joker'];
                const existingBotCount = lobby.players.filter(p => p.isBot).length;
                const name = botNames[existingBotCount % botNames.length] + ` ${existingBotCount + 1}`;
                const seatNum = findOpenSeat(lobby);

                lobby.players.push({
                    id: `bot_${Date.now()}_${Math.random()}`,
                    username: name,
                    lives: lobby.defaultLives || 2,
                    wager: 5,
                    ready: true,
                    seat: seatNum,
                    cards: [],
                    eliminated: false,
                    nextHandReady: true,
                    isBot: true,
                    isNewArrival: false,
                    inVC: false,
                    isMuted: true
                });
                broadcastLobbyUpdate(lobby.code);
                broadcastLobbyList();
            }
            return;
        }

        if (data.type === 'REMOVE_BOT') {
            if (lobby.gameState === 'lobby') {
                const bIdx = lobby.players.map(p => p.isBot).lastIndexOf(true);
                if (bIdx !== -1) {
                    lobby.players.splice(bIdx, 1);
                    lobby.players.forEach((p, idx) => { p.seat = idx; });
                    broadcastLobbyUpdate(lobby.code);
                    broadcastLobbyList();
                }
            }
            return;
        }

        if (data.type === 'LEAVE_LOBBY') {
            leaveLobby(ws, lobby.code, broadcastLobbyList);
            ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
            currentLobbyCode = null;
            return;
        }
    });

    ws.on('close', () => {
        if (currentLobbyCode) {
            leaveLobby(ws, currentLobbyCode, broadcastLobbyList);
        }
    });
});

const PORT = process.env.PORT || config.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
