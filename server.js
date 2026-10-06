const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

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

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
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
    delete lobbies[code];
    broadcastLobbyList();
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

                        let existingPlayer = lobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
                        if (existingPlayer) {
                            existingPlayer.id = ws;
                            let token = generateLiveKitToken(code, currentUsername);
                            ws.send(JSON.stringify({ 
                                type: 'LOBBY_JOINED', 
                                lobby: getSanitizedLobby(lobby, ws),
                                livekitHost: LIVEKIT_HOST,
                                livekitToken: token
                            }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        let existingSpec = lobby.spectators.find(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (existingSpec) {
                            existingSpec.idSocket = ws;
                            let token = generateLiveKitToken(code, currentUsername);
                            ws.send(JSON.stringify({ 
                                type: 'LOBBY_JOINED', 
                                lobby: getSanitizedLobby(lobby, ws),
                                livekitHost: LIVEKIT_HOST,
                                livekitToken: token
                            }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat: availableSeat, nextHandReady: false, eliminated: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} });
                        } else {
                            lobby.spectators.push({ username: currentUsername, idSocket: ws, inVC: true, isMuted: true });
                        }

                        let token = generateLiveKitToken(code, currentUsername);
                        ws.send(JSON.stringify({ 
                            type: 'LOBBY_JOINED', 
                            lobby: getSanitizedLobby(lobby, ws),
                            livekitHost: LIVEKIT_HOST,
                            livekitToken: token
                        }));
                        broadcastLobbyUpdate(code);
                        broadcastLobbyList();
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                    }
                    break;
                }

                case 'SET_READY': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'lobby' && !player.eliminated) {
                            player.ready = !!data.ready;
                            let activeParts = getActiveParticipants(lobby);
                            
                            // Check if all active players are ready and we have at least 2 players
                            if (activeParts.length >= 2 && activeParts.every(p => p.ready)) {
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
                }

                case 'NEXT_HAND': {
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
                }

                case 'CHOOSE_POOL_CARD': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
                            let p = lobby.players.find(pl => pl.id === ws);
                            handlePoolCardSelection(lobby, p ? p.username : currentUsername, data.cardIndex);
                        }
                    }
                    break;
                }

                case 'DRAW_DECK':
                case 'DRAW_DISCARD': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) handleTurnAction(lobbies[currentLobbyCode], ws, data.type);
                    break;
                }

                case 'DISCARD_CARD': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) handleDiscardAction(lobbies[currentLobbyCode], ws, data.cardIndex);
                    break;
                }

                case 'KNOCK': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) handleKnock(lobbies[currentLobbyCode], ws);
                    break;
                }

                case 'LEAVE_LOBBY': {
                    leaveLobby(ws, currentLobbyCode);
                    currentLobbyCode = null;
                    ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                    break;
                }
            }
        } catch (err) {
            console.error(err);
        }
    });
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
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        activeParticipantsCount: activeParts.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: lobby.drawPool.map((c, i) => ({ index: i, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults,
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        knockedBy: lobby.knockedBy || null,
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
        }
    }
}

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
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
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        let card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
    }
    broadcastLobbyUpdate(lobby.code);
}

function handleDiscardAction(lobby, ws, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.cards.length !== 4) return;

    let discarded = currentPlayer.cards.splice(cardIndex, 1)[0];
    lobby.discardPile.push(discarded);
    lobby.turnsTakenThisRound++;
    advanceTurnOrResolve(lobby);
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
    let loser = scores[0].p;
    loser.lives = Math.max(0, loser.lives - 1);

    if (loser.lives <= 0) { loser.eliminated = true; lobby.spectators.push({ idSocket: loser.id, username: loser.username }); }
    if (getActiveParticipants(lobby).length === 1) {
        awardTournamentWinner(lobby, getActiveParticipants(lobby)[0]);
    } else {
        triggerRoundOver(lobby, `Round Over! ${loser.username} had lowest score (${lowest}) and lost a life.`);
    }
}

function triggerRoundOver(lobby, msg) {
    let active = getActiveParticipants(lobby);
    if (active.length === 1) { awardTournamentWinner(lobby, active[0]); return; }
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    broadcastLobbyUpdate(lobby.code);
}

function awardTournamentWinner(lobby, winner) {
    lobby.lastGameWinner = winner.username;
    let winIdx = lobby.players.findIndex(p => p.username === winner.username);
    if (winIdx !== -1) lobby.dealerIndex = winIdx;

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} wins the match!`;
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
    lobby.knockedBy = null;
    lobby.players.forEach(p => {
        p.lives = 2;
        p.eliminated = false;
        p.cards = [];
        p.ready = false;
        p.nextHandReady = false;
    });
    lobby.spectators = [];
    broadcastLobbyUpdate(lobby.code);
    broadcastLobbyList();
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
