const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const lobbies = {};

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

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
            deck.push({ suit: s, val: v, points: points, drawVal: drawVal });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function touchLobbyActivity(lobby) {
    if (lobby.inactivityTimer) {
        clearTimeout(lobby.inactivityTimer);
    }
    lobby.inactivityTimer = setTimeout(() => {
        closeInactiveLobby(lobby.code);
    }, 20 * 60 * 1000);
}

function closeInactiveLobby(code) {
    let lobby = lobbies[code];
    if (!lobby) return;

    let closePayload = JSON.stringify({ type: 'ERROR', message: 'Lobby closed due to 20 minutes of inactivity.' });

    lobby.players.forEach(p => {
        if (p.id && p.id.readyState === WebSocket.OPEN) {
            p.id.send(closePayload);
            p.id.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
        }
    });

    lobby.spectators.forEach(s => {
        if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) {
            s.idSocket.send(closePayload);
            s.idSocket.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
        }
    });

    if (lobby.nextHandTimer) clearTimeout(lobby.nextHandTimer);
    delete lobbies[code];
    broadcastLobbyList();
}

wss.on('connection', (ws) => {
    let currentLobbyCode = null;
    let currentUsername = null;

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        try {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                touchLobbyActivity(lobbies[currentLobbyCode]);
            }

            switch (data.type) {
                case 'CREATE_LOBBY':
                    currentUsername = (data.username || 'Player').trim();
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        leaveLobby(ws, currentLobbyCode);
                    }

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
                        turnIndex: 0,
                        dealerIndex: 0,
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
                        if (currentLobbyCode && currentLobbyCode !== code) {
                            leaveLobby(ws, currentLobbyCode);
                        }

                        currentLobbyCode = code;
                        currentUsername = (data.username || 'Player').trim();
                        let lobby = lobbies[code];
                        touchLobbyActivity(lobby);
                        
                        let existingPlayer = lobby.players.find(p => p.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        if (existingPlayer) {
                            existingPlayer.id = ws;
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        let existingSpec = lobby.spectators.find(s => s.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        if (existingSpec) {
                            existingSpec.idSocket = ws;
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat: availableSeat, nextHandReady: false, eliminated: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} });
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                        } else {
                            lobby.spectators.push({ username: currentUsername, idSocket: ws, inVC: true, isMuted: true });
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                        }
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
                            lobby.phaseMessage = `🎵 ${currentUsername} added "${title}" to the queue!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'REMOVE_PLAYLIST_SONG':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let index = data.index;
                        if (lobby.playlist && lobby.playlist[index]) {
                            let removed = lobby.playlist.splice(index, 1)[0];
                            if (lobby.currentSongIndex >= lobby.playlist.length) {
                                lobby.currentSongIndex = Math.max(0, lobby.playlist.length - 1);
                            }
                            lobby.phaseMessage = `🎵 ${currentUsername} removed "${removed.title}" from the playlist.`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CONTROL_MUSIC':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        if (data.action === 'PLAY') {
                            lobby.isPlaying = true;
                        } else if (data.action === 'PAUSE') {
                            lobby.isPlaying = false;
                        } else if (data.action === 'SKIP') {
                            if (lobby.playlist && lobby.playlist.length > 0) {
                                lobby.currentSongIndex = (lobby.currentSongIndex + 1) % lobby.playlist.length;
                                lobby.isPlaying = true;
                            }
                        } else if (data.action === 'SELECT' && typeof data.index === 'number') {
                            if (lobby.playlist && lobby.playlist[data.index]) {
                                lobby.currentSongIndex = data.index;
                                lobby.isPlaying = true;
                            }
                        }
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                    break;

                case 'RECONNECT_VOICE':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        lobby.phaseMessage = `🎙️ ${currentUsername} triggered a voice chat reconnect for everyone!`;
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                    break;

                case 'STAND_UP':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let playerIdx = lobby.players.findIndex(p => p.id === ws);
                        if (playerIdx !== -1) {
                            let leavingPlayer = lobby.players.splice(playerIdx, 1)[0];
                            lobby.spectators.push({
                                username: leavingPlayer.username,
                                idSocket: ws,
                                inVC: leavingPlayer.inVC,
                                isMuted: leavingPlayer.isMuted
                            });
                            lobby.phaseMessage = `🪑 ${leavingPlayer.username} stood up and moved to spectator mode.`;
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;

                case 'SIT_DOWN':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let specIdx = lobby.spectators.findIndex(s => s.idSocket === ws || s.username.trim().toLowerCase() === currentUsername.toLowerCase());

                        if (specIdx !== -1 && lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let spec = lobby.spectators.splice(specIdx, 1)[0];
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({
                                id: ws,
                                username: spec.username,
                                lives: lobby.players[0]?.lives || 2,
                                wager: 5,
                                cards: [],
                                ready: false,
                                seat: availableSeat,
                                nextHandReady: false,
                                eliminated: false,
                                inVC: spec.inVC,
                                isMuted: spec.isMuted,
                                peekRequests: {},
                                peekAllowed: {}
                            });
                            lobby.phaseMessage = `🪑 ${spec.username} sat down at the table!`;
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
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'lobby') {
                            player.wager = parseInt(data.wager) || 5;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'UPDATE_SETTINGS':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        if (lobby.host.trim().toLowerCase() === currentUsername.toLowerCase() && lobby.gameState === 'lobby') {
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
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let p = lobby.players.find(pl => pl.id === ws) || lobby.spectators.find(s => s.username.trim().toLowerCase() === currentUsername.toLowerCase());
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
                        touchLobbyActivity(lobby);
                        let targetUser = data.targetUser;
                        let category = data.category; 
                        let targetLedger = category === 'main' ? lobby.mainGameLedger : lobby.sideBetLedger;

                        if (targetLedger && targetLedger[currentUsername]) {
                            targetLedger[currentUsername][targetUser] = 0;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'PROPOSE_ELIMINATION_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let activeParts = getActiveParticipants(lobby);
                        let isSpec = lobby.spectators.some(s => s.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        if (!isSpec && lobby.gameState !== 'lobby' && activeParts.length >= 3) {
                            let target = data.target;
                            let newBet = {
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                target: target,
                                pickUser: target,
                                targetSurvivor: currentUsername,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                type: 'eliminate',
                                delivered: {}
                            };
                            lobby.pendingBets.push(newBet);
                            lobby.phaseMessage = `🤝 First to Lose Bet proposed by ${currentUsername} to ${target}!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'PROPOSE_GLOBAL_SIDE_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let activeParts = getActiveParticipants(lobby);
                        if (lobby.gameState !== 'lobby' && activeParts.length === 2) {
                            let proposalId = Math.random().toString(36).substring(2, 8);
                            lobby.globalProposals.push({
                                id: proposalId,
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
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let prop = lobby.globalProposals.find(gp => gp.id === data.proposalId);
                        if (prop && !prop.acceptedBy.includes(currentUsername) && prop.proposer !== currentUsername) {
                            prop.acceptedBy.push(currentUsername);
                            lobby.phaseMessage = `✅ ${currentUsername} accepted global bet from ${prop.proposer} ("You got it!")`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CONFIRM_GLOBAL_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
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
                                lobby.phaseMessage = `🤝 Confirmed global side bet between ${prop.proposer} and ${data.acceptedUser}!`;
                            } else {
                                lobby.phaseMessage = `❌ ${prop.proposer} declined global bet acceptance from ${data.acceptedUser}.`;
                            }
                            prop.acceptedBy = prop.acceptedBy.filter(u => u !== data.acceptedUser);
                            if (prop.acceptedBy.length === 0) {
                                lobby.globalProposals = lobby.globalProposals.filter(gp => gp.id !== prop.id);
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'RESPOND_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let betIdx = lobby.pendingBets.findIndex(b => b.id === data.betId);
                        if (betIdx !== -1) {
                            let bet = lobby.pendingBets.splice(betIdx, 1)[0];
                            if (data.accept) {
                                lobby.activeBets.push(bet);
                                lobby.phaseMessage = `✅ ${currentUsername} accepted the bet from ${bet.proposer}!`;
                            } else {
                                lobby.phaseMessage = `❌ ${currentUsername} declined the bet from ${bet.proposer}.`;
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'SET_READY':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'lobby' && !player.eliminated) {
                            player.ready = !!data.ready;

                            let activeParticipants = getActiveParticipants(lobby);
                            let allReady = activeParticipants.every(p => p.ready);
                            
                            if (allReady && activeParticipants.length >= 2) {
                                startDealerDrawPhase(lobby);
                            } else {
                                broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                    }
                    break;

                case 'NEXT_HAND':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
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
                        touchLobbyActivity(lobby);
                        if (!lobby.endGameVotes) lobby.endGameVotes = {};
                        lobby.endGameVotes[currentUsername] = true;
                        
                        let activeParts = getActiveParticipants(lobby);
                        let allVotedYes = activeParts.every(p => lobby.endGameVotes[p.username]);
                        
                        if (allVotedYes) {
                            lobby.phaseMessage = "⚠️ Game ended! Returning to lobby.";
                            lobby.gameState = 'lobby';
                            lobby.endGameVotes = {};
                            lobby.activeBets = [];
                            lobby.pendingBets = [];
                            lobby.globalProposals = [];
                            lobby.knockedBy = null;
                            
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
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        } else {
                            lobby.phaseMessage = `⚠️ ${currentUsername} voted to end the game (${Object.keys(lobby.endGameVotes).length}/${activeParts.length} votes)`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'REQUEST_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let requesterName = currentUsername;
                        let rawTarget = (data.targetUsername || '').trim().toLowerCase();

                        lobby.players.forEach(pl => {
                            if (pl.peekRequests) {
                                Object.keys(pl.peekRequests).forEach(k => {
                                    if (k.trim().toLowerCase() === requesterName.toLowerCase()) {
                                        delete pl.peekRequests[k];
                                    }
                                });
                            }
                            if (pl.peekAllowed) {
                                Object.keys(pl.peekAllowed).forEach(k => {
                                    if (k.trim().toLowerCase() === requesterName.toLowerCase()) {
                                        delete pl.peekAllowed[k];
                                    }
                                });
                            }
                        });

                        let targetPlayer = lobby.players.find(p => p.username.trim().toLowerCase() === rawTarget);
                        if (targetPlayer && targetPlayer.id && targetPlayer.id.readyState === WebSocket.OPEN) {
                            if (!targetPlayer.peekRequests) targetPlayer.peekRequests = {};
                            targetPlayer.peekRequests[requesterName] = true;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'RESPOND_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let player = lobby.players.find(p => p.id === ws);
                        if (player) {
                            if (player.peekRequests) {
                                Object.keys(player.peekRequests).forEach(k => {
                                    if (k.trim().toLowerCase() === (data.spectatorUsername || '').trim().toLowerCase()) {
                                        delete player.peekRequests[k];
                                    }
                                });
                            }
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
                            if (pl.peekAllowed) {
                                Object.keys(pl.peekAllowed).forEach(k => {
                                    if (k.trim().toLowerCase() === currentUsername.trim().toLowerCase()) {
                                        delete pl.peekAllowed[k];
                                    }
                                });
                            }
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
                            Object.keys(player.peekAllowed).forEach(k => {
                                if (k.trim().toLowerCase() === (data.spectatorUsername || '').trim().toLowerCase()) {
                                    delete player.peekAllowed[k];
                                }
                            });
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CHOOSE_POOL_CARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
                            let activeSender = lobby.players.find(p => p.id === ws);
                            let verifiedUsername = activeSender ? activeSender.username : currentUsername;
                            handlePoolCardSelection(lobby, verifiedUsername, data.cardIndex);
                        }
                    }
                    break;

                case 'CHAT_MESSAGE':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let chatPayload = { type: 'CHAT_MESSAGE', username: currentUsername, message: data.message };
                        if (!lobby.chatHistory) lobby.chatHistory = [];
                        lobby.chatHistory.push(chatPayload);

                        lobby.players.forEach(p => { if (p.id && p.id.readyState === WebSocket.OPEN) p.id.send(JSON.stringify(chatPayload)); });
                        lobby.spectators.forEach(s => { if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) s.idSocket.send(JSON.stringify(chatPayload)); });
                    }
                    break;

                case 'WEBRTC_SIGNAL':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        let targetUser = data.target;
                        let allRecipients = [...lobby.players, ...lobby.spectators.map(s => ({ username: s.username, id: s.idSocket }))];
                        let targetRec = allRecipients.find(r => r.username === targetUser);
                        if (targetRec && targetRec.id && targetRec.id.readyState === WebSocket.OPEN) {
                            targetRec.id.send(JSON.stringify({
                                type: 'WEBRTC_SIGNAL',
                                lobbyCode: currentLobbyCode,
                                sender: currentUsername,
                                signal: data.signal
                            }));
                        }
                    }
                    break;

                case 'DRAW_DECK':
                case 'DRAW_DISCARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        handleTurnAction(lobby, ws, data.type);
                    }
                    break;

                case 'DISCARD_CARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        handleDiscardAction(lobby, ws, data.cardIndex);
                    }
                    break;

                case 'KNOCK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        handleKnock(lobby, ws);
                    }
                    break;

                case 'LEAVE_LOBBY':
                    leaveLobby(ws, currentLobbyCode);
                    currentLobbyCode = null;
                    ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                    break;
            }
        } catch (err) {
            console.error('Error handling message:', err);
        }
    });

    ws.on('close', () => {});
});

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    let occupied = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) { if (!occupied.includes(i)) return i; }
    return 0;
}

function leaveLobby(ws, code) {
    if (!lobbies[code]) return;
    let lobby = lobbies[code];
    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);
    if (lobby.players.length === 0) {
        if (lobby.nextHandTimer) clearTimeout(lobby.nextHandTimer);
        if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
        delete lobbies[code];
    } else {
        touchLobbyActivity(lobby);
        broadcastLobbyUpdate(code);
    }
    broadcastLobbyList();
}

function getPublicLobbiesList() {
    return Object.values(lobbies)
        .filter(l => !l.isPrivate)
        .map(l => ({
            code: l.code,
            name: l.name,
            host: l.host,
            count: l.players.length,
            state: l.gameState
        }));
}

function broadcastLobbyList() {
    let publicLobbies = getPublicLobbiesList();
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: publicLobbies }));
        }
    });
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    
    lobby.players.forEach(p => {
        if (p.id && p.id.readyState === WebSocket.OPEN) {
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, p.id) }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) {
            s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, s.idSocket) }));
        }
    });
}

function getSanitizedLobby(lobby, wsId) {
    let activeParts = getActiveParticipants(lobby);
    let allParticipants = [...lobby.players];
    let currentTurnUser = allParticipants[lobby.turnIndex] ? allParticipants[lobby.turnIndex].username : '';
    let isRoundOver = lobby.gameState === 'roundOver';
    let canKnock = lobby.turnsTakenThisRound >= activeParts.length;
    let potTotal = allParticipants.reduce((sum, p) => sum + (p.wager || 5), 0);
    let sidePotTotal = (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0);

    let requestingPlayer = lobby.players.find(p => p.id === wsId);
    let requestingSpectator = lobby.spectators.find(s => s.idSocket === wsId);
    let myUsername = requestingPlayer ? requestingPlayer.username : (requestingSpectator ? requestingSpectator.username : null);

    let sortedParticipants = [...allParticipants];
    if (myUsername) {
        let myIdx = sortedParticipants.findIndex(p => p.username === myUsername);
        if (myIdx !== -1) {
            sortedParticipants = sortedParticipants.slice(myIdx).concat(sortedParticipants.slice(0, myIdx));
        }
    }
    sortedParticipants.forEach((p, idx) => { p.seat = idx; });

    let myUnrespondedBets = (lobby.pendingBets || []).filter(b => b.target === myUsername && !b.delivered[myUsername]);
    if (myUnrespondedBets.length > 0) {
        myUnrespondedBets.forEach(b => { b.delivered[myUsername] = true; });
    }

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        deckCount: lobby.deck.length,
        turnIndex: lobby.turnIndex,
        currentTurnUser: currentTurnUser,
        phaseMessage: lobby.phaseMessage,
        canKnock: canKnock,
        potTotal: potTotal,
        sidePotTotal: sidePotTotal,
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        pendingBetsForMe: myUnrespondedBets,
        globalProposals: lobby.globalProposals || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: activeParts.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: lobby.drawPool.map((c, idx) => ({ index: idx, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults,
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        knockedBy: lobby.knockedBy || null,
        chatHistory: lobby.chatHistory || [],
        playlist: lobby.playlist || [],
        currentSongIndex: lobby.currentSongIndex || 0,
        isPlaying: !!lobby.isPlaying,
        players: lobby.players.map(p => {
            let canSeeCards = isRoundOver || p.username === myUsername;
            
            let specAllowed = false;
            if (requestingSpectator) {
                specAllowed = p.peekAllowed && Object.keys(p.peekAllowed).some(k => k.trim().toLowerCase() === requestingSpectator.username.trim().toLowerCase());
            } else if (requestingPlayer) {
                specAllowed = p.username === myUsername || (p.peekAllowed && Object.keys(p.peekAllowed).some(k => k.trim().toLowerCase() === requestingPlayer.username.trim().toLowerCase()));
            }

            let incomingPeekMap = {};
            if (wsId === p.id && p.peekRequests) {
                incomingPeekMap = p.peekRequests;
            }

            let allowedPeekMap = p.peekAllowed || {};

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
                peekIncoming: incomingPeekMap,
                peekAllowed: allowedPeekMap,
                cards: (canSeeCards || specAllowed) ? p.cards : []
            };
        }),
        spectators: lobby.spectators.map(s => ({
            username: s.username,
            inVC: !!s.inVC,
            isMuted: !!s.isMuted
        }))
    };
}

function startDealerDrawPhase(lobby) {
    let deck = createDeck();
    lobby.drawPool = deck.map(card => ({ card: card, chosenBy: null }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;
    lobby.lastDiscarder = null;
    lobby.initialDealCard = null;
    lobby.lastDiscardPickup = null;
    lobby.fedCardsTracker = {};

    lobby.players.forEach(p => { 
        if (!p.eliminated) p.nextHandReady = false; 
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    broadcastLobbyUpdate(lobby.code);
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.gameState === 'tieBreaker') {
        let isTied = lobby.tiedParticipantsList.some(t => t.trim().toLowerCase() === username.trim().toLowerCase());
        if (!isTied) return;
    }

    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        let card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        if (!lobby.drawOrderSequence) lobby.drawOrderSequence = [];
        lobby.drawOrderSequence.push({ username, card });
        
        broadcastLobbyUpdate(lobby.code);

        if (lobby.gameState === 'dealerDraw') {
            checkDealerDrawComplete(lobby);
        } else if (lobby.gameState === 'tieBreaker') {
            checkTieBreakerComplete(lobby);
        }
    }
}

function checkDealerDrawComplete(lobby) {
    let activeParts = getActiveParticipants(lobby);
    let allPicked = activeParts.every(p => lobby.drawResults[p.username]);

    if (allPicked) {
        let entries = Object.entries(lobby.drawResults).map(([user, card]) => ({ username: user, card: card }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);
        
        let lowestDrawVal = entries[0].card.drawVal;
        let tiedLowest = entries.filter(e => e.card.drawVal === lowestDrawVal);

        let dealerWinner;
        if (tiedLowest.length > 1) {
            if (lowestDrawVal === 2) {
                let firstTwoChooser = lobby.drawOrderSequence.find(item => item.card.drawVal === 2 && tiedLowest.some(t => t.username === item.username));
                dealerWinner = firstTwoChooser ? { username: firstTwoChooser.username, card: firstTwoChooser.card } : tiedLowest[0];
                lobby.phaseMessage = `🎉 ${dealerWinner.username} drew a 2 first and is the Dealer!`;
            } else {
                lobby.phaseMessage = `⚠️ Tie for lowest card (${entries[0].card.val}). Picking again!`;
                broadcastLobbyUpdate(lobby.code);
                setTimeout(() => {
                    if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'dealerDraw') {
                        startDealerDrawPhase(lobbies[lobby.code]);
                    }
                }, 3500);
                return;
            }
        } else {
            dealerWinner = entries[0];
            lobby.phaseMessage = `🎉 ${dealerWinner.username} drew the lowest card and is the Dealer!`;
        }

        let dealerIndex = lobby.players.findIndex(p => p.username === dealerWinner.username);
        lobby.dealerIndex = dealerIndex !== -1 ? dealerIndex : 0;

        broadcastLobbyUpdate(lobby.code);

        setTimeout(() => {
            if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'dealerDraw') {
                startRound(lobbies[lobby.code]);
            }
        }, 4000);
    }
}

function checkTieBreakerComplete(lobby) {
    let tiedNames = lobby.tiedParticipantsList;
    let allTiedPicked = tiedNames.every(username => lobby.drawResults[username]);

    if (allTiedPicked) {
        let entries = tiedNames.map(username => ({ username: username, card: lobby.drawResults[username] }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);
        
        let lowestDrawVal = entries[0].card.drawVal;
        let tiedLowest = entries.filter(e => e.card.drawVal === lowestDrawVal);

        if (tiedLowest.length > 1) {
            lobby.phaseMessage = `⚠️ Tie-breaker resulted in a tie! Tied players choose again.`;
            tiedNames.forEach(uname => { delete lobby.drawResults[uname]; });
            broadcastLobbyUpdate(lobby.code);
            return;
        }

        let loserEntry = entries[0];
        let activeParts = getActiveParticipants(lobby);
        let targetParticipant = activeParts.find(p => p.username === loserEntry.username);
        if (targetParticipant) {
            targetParticipant.lives = Math.max(0, targetParticipant.lives - 1);
            resolveFirstToLoseBets(lobby, targetParticipant.username);

            if (targetParticipant.lives <= 0 && !targetParticipant.eliminated) {
                targetParticipant.eliminated = true;
                lobby.spectators.push({ idSocket: targetParticipant.id, username: targetParticipant.username });
            }

            let activeScores = activeParts.map(p => ({ p: p, s: calculateScore(p.cards) }));
            activeScores.sort((a,b) => a.s - b.s);
            let roundWinner = activeScores[activeScores.length - 1].p.username;
            resolveWinSideBets(lobby, roundWinner);
            resolveMainGameLedger(lobby, roundWinner, targetParticipant.username);
        }

        let remainingActive = getActiveParticipants(lobby);
        if (remainingActive.length === 1) {
            awardTournamentWinner(lobby, remainingActive[0]);
            return;
        }

        lobby.phaseMessage = `Tie-breaker results:\n` + entries.map(e => `${e.username}: ${e.card.val}${e.card.suit}`).join('\n') + `\n\n${loserEntry.username} drew the lowest card and lost a life!`;
        broadcastLobbyUpdate(lobby.code);

        setTimeout(() => {
            if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'tieBreaker') {
                triggerRoundOver(lobbies[lobby.code], lobby.phaseMessage);
            }
        }, 4000);
    }
}

function startRound(lobby) {
    if (lobby.nextHandTimer) {
        clearTimeout(lobby.nextHandTimer);
        lobby.nextHandTimer = null;
    }
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.lastDiscarder = null;
    lobby.lastDiscardPickup = null;
    lobby.fedCardsTracker = {};
    lobby.tiedParticipantsList = [];
    lobby.knockedBy = null;
    
    lobby.players.forEach(p => {
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    let activeParts = getActiveParticipants(lobby);
    if (activeParts.length === 1) {
        let winner = activeParts[0];
        awardTournamentWinner(lobby, winner);
        return;
    }

    activeParts.forEach(p => { 
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()]; 
        p.nextHandReady = false;
        p.pickedUpDiscardCard = null;
    });

    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = firstDiscard;

    lobby.gameState = 'playing';
    lobby.phaseMessage = null;
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;
    
    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    let safetyCounter = 0;
    while (lobby.players[lobby.turnIndex].eliminated && safetyCounter < lobby.players.length) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
        safetyCounter++;
    }

    broadcastLobbyUpdate(lobby.code);
}

function handleTurnAction(lobby, ws, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated) return;
    if (currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the draw pile.`;
    } else if (actionType === 'DRAW_DISCARD') {
        if (lobby.discardPile.length > 0) {
            let card = lobby.discardPile.pop();
            currentPlayer.cards.push(card);
            currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };
            lobby.phaseMessage = `📢 ${currentPlayer.username} picked up ${card.val}${card.suit} from the discard pile!`;
        }
    }

    let fourCardScore = calculateBestFourCardScore(currentPlayer.cards);
    if (fourCardScore === 31) {
        lobby.players.forEach(p => { 
            if (p !== currentPlayer && !p.eliminated) {
                p.lives = Math.max(0, p.lives - 1);
                resolveFirstToLoseBets(lobby, p.username);
                resolveMainGameLedger(lobby, currentPlayer.username, p.username);
                if (p.lives <= 0) {
                    p.eliminated = true;
                    lobby.spectators.push({ idSocket: p.id, username: p.username });
                }
            }
        });
        triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points! All hands revealed.`);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
}

function handleDiscardAction(lobby, ws, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated) return;
    if (currentPlayer.cards.length !== 4) return;

    if (currentPlayer.cards[cardIndex]) {
        let cardToPutDown = currentPlayer.cards[cardIndex];

        if (currentPlayer.pickedUpDiscardCard && 
            cardToPutDown.val === currentPlayer.pickedUpDiscardCard.val && 
            cardToPutDown.suit === currentPlayer.pickedUpDiscardCard.suit) {
            
            let discarded = currentPlayer.cards.splice(cardIndex, 1)[0];
            lobby.discardPile.push(discarded);
            currentPlayer.pickedUpDiscardCard = null;
            lobby.phaseMessage = `📢 ${currentPlayer.username} put the card back down into the discard pile. They must take another card to end their turn.`;
            
            broadcastLobbyUpdate(lobby.code);
            return;
        }

        let discarded = currentPlayer.cards.splice(cardIndex, 1)[0];
        currentPlayer.pickedUpDiscardCard = null;
        
        if (lobby.lastDiscardPickup && 
            lobby.lastDiscardPickup.username === currentPlayer.username &&
            lobby.lastDiscardPickup.card.val === discarded.val &&
            lobby.lastDiscardPickup.card.suit === discarded.suit) {
            lobby.lastDiscardPickup = null;
        }

        lobby.discardPile.push(discarded);

        lobby.lastDiscarder = currentPlayer.username;
        if (!lobby.fedCardsTracker[currentPlayer.username]) lobby.fedCardsTracker[currentPlayer.username] = [];
        lobby.fedCardsTracker[currentPlayer.username].push(discarded);

        let currentScore = calculateScore(currentPlayer.cards);
        if (currentScore === 31 && lobby.lastDiscarder) {
            for (let feederName in lobby.fedCardsTracker) {
                if (feederName !== currentPlayer.username) {
                    let fedCards = lobby.fedCardsTracker[feederName];
                    let hasAce = fedCards.some(c => c.val === 'A');
                    let hasFaceOr10 = fedCards.some(c => ['10', 'J', 'Q', 'K'].includes(c.val));
                    if (hasAce && hasFaceOr10) {
                        let feeder = lobby.players.find(p => p.username === feederName);
                        if (feeder) {
                            feeder.lives = 0;
                            lobby.players.forEach(p => {
                                if (p.lives <= 0 && !p.eliminated) {
                                    p.eliminated = true;
                                    resolveFirstToLoseBets(lobby, p.username);
                                    resolveMainGameLedger(lobby, currentPlayer.username, p.username);
                                    lobby.spectators.push({ idSocket: p.id, username: p.username });
                                }
                            });
                            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} cards and ${currentPlayer.username} hit 31! ${feeder.username} loses ALL lives!`;
                        }
                    }
                }
            }
        }

        lobby.turnsTakenThisRound++;

        let remainingActiveAfterDiscard = getActiveParticipants(lobby);
        if (remainingActiveAfterDiscard.length === 1) {
            awardTournamentWinner(lobby, remainingActiveAfterDiscard[0]);
            return;
        }

        if (currentScore === 31) {
            lobby.players.forEach(p => { 
                if (p !== currentPlayer && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    resolveFirstToLoseBets(lobby, p.username);
                    resolveMainGameLedger(lobby, currentPlayer.username, p.username);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        lobby.spectators.push({ idSocket: p.id, username: p.username });
                    }
                }
            });

            let remainingActive = getActiveParticipants(lobby);
            if (remainingActive.length === 1) {
                awardTournamentWinner(lobby, remainingActive[0]);
                return;
            }

            triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points! All hands revealed.`);
        } else {
            advanceTurnOrResolve(lobby);
        }
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
    
    let nextIdx = (lobby.turnIndex + 1) % lobby.players.length;
    let safetyCounter = 0;
    while (lobby.players[nextIdx].eliminated && safetyCounter < lobby.players.length) {
        nextIdx = (nextIdx + 1) % lobby.players.length;
        safetyCounter++;
    }
    lobby.turnIndex = nextIdx;

    broadcastLobbyUpdate(lobby.code);
}

function handleKnock(lobby, ws) {
    if (lobby.gameState !== 'playing') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated) return;
    if (lobby.knockedBy) return;

    let activeParts = getActiveParticipants(lobby);
    if (lobby.turnsTakenThisRound < activeParts.length) return;

    let score = calculateScore(currentPlayer.cards);
    let threshold = activeParts.length > 2 ? 21 : 25;
    if (score < threshold) return;

    executeKnock(lobby, currentPlayer);
}

function executeKnock(lobby, player) {
    let activeParts = getActiveParticipants(lobby);
    lobby.gameState = 'finalTurn';
    lobby.knockedBy = player.username;
    lobby.finalTurnsRemaining = activeParts.length - 1;
    lobby.phaseMessage = `🔔 KNOCK! ${player.username} knocked! Every other player gets 1 final turn.`;
    
    let nextIdx = (lobby.turnIndex + 1) % lobby.players.length;
    let safetyCounter = 0;
    while (lobby.players[nextIdx].eliminated && safetyCounter < lobby.players.length) {
        nextIdx = (nextIdx + 1) % lobby.players.length;
        safetyCounter++;
    }
    lobby.turnIndex = nextIdx;

    broadcastLobbyUpdate(lobby.code);
}

function resolveRoundEnd(lobby) {
    let activeParts = getActiveParticipants(lobby);
    let scores = activeParts.map(p => ({ player: p, score: calculateScore(p.cards) }));
    scores.sort((a, b) => a.score - b.score);

    let lowestScore = scores[0].score;
    let tiedPlayers = scores.filter(s => s.score === lowestScore);

    if (tiedPlayers.length > 1) {
        if (activeParts.length === 2) {
            triggerRoundOver(lobby, `Round Over! Heads up match tied at ${lowestScore} pts. No one loses a life!`);
        } else {
            lobby.tiedParticipantsList = tiedPlayers.map(t => t.player.username);
            lobby.drawPool = lobby.deck.map(card => ({ card: card, chosenBy: null }));
            lobby.drawResults = {};
            lobby.phaseMessage = `Tie-Breaker Phase`;
            lobby.gameState = 'tieBreaker';
            broadcastLobbyUpdate(lobby.code);
        }
    } else {
        let loserPlayer = scores[0].player;
        loserPlayer.lives = Math.max(0, loserPlayer.lives - 1);
        let roundLoser = loserPlayer.username;
        let roundWinner = scores[scores.length - 1].player.username;
        
        resolveFirstToLoseBets(lobby, roundLoser);

        if (loserPlayer.lives <= 0 && !loserPlayer.eliminated) {
            loserPlayer.eliminated = true;
            lobby.spectators.push({ idSocket: loserPlayer.id, username: loserPlayer.username });
        }
        
        resolveWinSideBets(lobby, roundWinner);
        resolveMainGameLedger(lobby, roundWinner, roundLoser);

        let remainingActive = getActiveParticipants(lobby);
        if (remainingActive.length === 1) {
            awardTournamentWinner(lobby, remainingActive[0]);
            return;
        }
        
        let winnerPart = activeParts.find(p => p.username === roundWinner);
        if (winnerPart) {
            let winIdx = lobby.players.findIndex(p => p.username === winnerPart.username);
            if (winIdx !== -1) lobby.dealerIndex = winIdx;
        }

        triggerRoundOver(lobby, `Round Over! ${roundLoser} had the lowest score and lost a life. All hands revealed.`);
    }
}

function triggerRoundOver(lobby, msg) {
    let remainingActive = getActiveParticipants(lobby);
    if (remainingActive.length === 1) {
        awardTournamentWinner(lobby, remainingActive[0]);
        return;
    }

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    broadcastLobbyUpdate(lobby.code);
}

function resolveMainGameLedger(lobby, winnerUsername, loserUsername) {
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    let winnerObj = lobby.players.find(p => p.username === winnerUsername);
    let amount = winnerObj ? (winnerObj.wager || 5) : 5;

    if (!lobby.mainGameLedger[loserUsername]) lobby.mainGameLedger[loserUsername] = {};
    lobby.mainGameLedger[loserUsername][winnerUsername] = (lobby.mainGameLedger[loserUsername][winnerUsername] || 0) + amount;
}

function resolveFirstToLoseBets(lobby, loserUsername) {
    if (!lobby.activeBets) return;
    lobby.activeBets = lobby.activeBets.filter(bet => {
        if (bet.type === 'eliminate' && bet.pickUser === loserUsername) {
            lobby.phaseMessage = `💰 Side Bet Won! ${bet.proposer} won $${bet.wagerAmt} because ${loserUsername} lost first!`;
            return false;
        }
        return true;
    });
}

function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby.activeBets) return;
    lobby.activeBets = lobby.activeBets.filter(bet => {
        if (bet.type === 'win' && bet.pickUser === winnerUsername) {
            lobby.phaseMessage = `💰 Side Bet Won! ${bet.proposer} won $${bet.wagerAmt} because ${winnerUsername} won the round!`;
            return false;
        }
        return true;
    });
}

function awardTournamentWinner(lobby, winner) {
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} is the last player standing!`;
    broadcastLobbyUpdate(lobby.code);
}

function checkNextHandReady(lobby) {
    let activeParts = getActiveParticipants(lobby);
    let allReady = activeParts.every(p => p.nextHandReady);
    if (allReady) {
        startRound(lobby);
    } else {
        broadcastLobbyUpdate(lobby.code);
    }
}

function calculateBestFourCardScore(cards) {
    if (!cards || cards.length < 3) return 0;
    if (cards.length === 4) {
        let scores = [
            calculateScore([cards[0], cards[1], cards[2]]),
            calculateScore([cards[0], cards[1], cards[3]]),
            calculateScore([cards[0], cards[2], cards[3]]),
            calculateScore([cards[1], cards[2], cards[3]])
        ];
        return Math.max(...scores);
    }
    return calculateScore(cards);
}

function calculateScore(cards) {
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let suitSums = {};
    scoringCards.forEach(c => { suitSums[c.suit] = (suitSums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) return 30.5;
    return Math.max(...Object.values(suitSums), 0);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`31! Game Server running on port ${PORT}`);
});
