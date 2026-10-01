const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const lobbies = {};

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

wss.on('connection', (ws) => {
    let currentLobbyCode = null;
    let currentUsername = null;

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        switch (data.type) {
            case 'CREATE_LOBBY':
                currentLobbyCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                currentUsername = data.username;
                lobbies[currentLobbyCode] = {
                    code: currentLobbyCode,
                    name: data.lobbyName || `${currentUsername}'s Lobby`,
                    host: currentUsername,
                    players: [{ id: ws, username: currentUsername, lives: 2, cards: [], ready: false, seat: 0 }],
                    bots: [],
                    spectators: [],
                    deck: [],
                    discardPile: [],
                    gameState: 'lobby', // lobby, dealerDraw, playing, tieBreaker, roundOver
                    drawPool: [], // Used for dealer draw or tie breaker
                    drawResults: {},
                    phaseMessage: null,
                    turnIndex: 0,
                    wager: 5,
                    ledger: {}
                };
                ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobbies[currentLobbyCode]) }));
                broadcastLobbyList();
                break;

            case 'JOIN_LOBBY':
                let code = data.code.toUpperCase();
                if (lobbies[code]) {
                    currentLobbyCode = code;
                    currentUsername = data.username;
                    let lobby = lobbies[code];
                    if (lobby.players.length + lobby.bots.length < 6 && lobby.gameState === 'lobby') {
                        let availableSeat = findOpenSeat(lobby);
                        lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, cards: [], ready: false, seat: availableSeat });
                        ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby) }));
                        broadcastLobbyUpdate(code);
                        broadcastLobbyList();
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby full or game started!' }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                }
                break;

            case 'UPDATE_SETTINGS':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    if (lobby.host === currentUsername && lobby.gameState === 'lobby') {
                        if (data.wager) lobby.wager = parseInt(data.wager);
                        if (data.lives) {
                            let l = parseInt(data.lives);
                            lobby.players.forEach(p => p.lives = l);
                            lobby.bots.forEach(b => b.lives = l);
                        }
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                }
                break;

            case 'ADD_BOT':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    if (lobby.players.length + lobby.bots.length < 6 && lobby.gameState === 'lobby') {
                        let botName = 'Bot_' + Math.floor(Math.random() * 900 + 100);
                        lobby.bots.push({ username: botName, lives: lobby.players[0]?.lives || 2, cards: [], seat: findOpenSeat(lobby), ready: true });
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                }
                break;

            case 'REMOVE_BOT':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    if (lobby.bots.length > 0 && lobby.gameState === 'lobby') {
                        lobby.bots.pop();
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                }
                break;

            case 'SET_READY':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    let player = lobby.players.find(p => p.id === ws);
                    if (player) {
                        player.ready = data.ready;
                        broadcastLobbyUpdate(currentLobbyCode);

                        if (lobby.players.every(p => p.ready) && (lobby.players.length + lobby.bots.length >= 2)) {
                            startDealerDrawPhase(lobby);
                        }
                    }
                }
                break;

            case 'CHOOSE_POOL_CARD':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
                        handlePoolCardSelection(lobby, currentUsername, data.cardIndex);
                    }
                }
                break;

            case 'VOICE_DATA':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    lobby.players.forEach(p => {
                        if (p.id !== ws && p.id.readyState === WebSocket.OPEN) {
                            p.id.send(JSON.stringify({ type: 'VOICE_DATA', audioData: data.audioData }));
                        }
                    });
                }
                break;

            case 'DRAW_DECK':
            case 'DRAW_DISCARD':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    handleTurnAction(lobbies[currentLobbyCode], ws, data.type);
                }
                break;

            case 'DISCARD_CARD':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    handleDiscardAction(lobbies[currentLobbyCode], ws, data.cardIndex);
                }
                break;

            case 'KNOCK':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    handleKnock(lobbies[currentLobbyCode], ws);
                }
                break;

            case 'LEAVE_LOBBY':
                leaveLobby(ws, currentLobbyCode);
                currentLobbyCode = null;
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                break;
        }
    });

    ws.on('close', () => { if (currentLobbyCode) leaveLobby(ws, currentLobbyCode); });
});

function findOpenSeat(lobby) {
    let occupied = lobby.players.map(p => p.seat).concat(lobby.bots.map(b => b.seat));
    for (let i = 0; i < 6; i++) { if (!occupied.includes(i)) return i; }
    return 0;
}

function leaveLobby(ws, code) {
    if (!lobbies[code]) return;
    let lobby = lobbies[code];
    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.id !== ws);
    if (lobby.players.length === 0 && lobby.bots.length === 0) delete lobbies[code];
    else broadcastLobbyUpdate(code);
    broadcastLobbyList();
}

function broadcastLobbyList() {
    let publicLobbies = Object.values(lobbies).map(l => ({
        code: l.code, name: l.name, host: l.host, count: l.players.length + l.bots.length, state: l.gameState
    }));
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: publicLobbies })); });
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let sanitized = getSanitizedLobby(lobby);
    lobby.players.forEach(p => { if (p.id.readyState === WebSocket.OPEN) p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: sanitized })); });
    lobby.spectators.forEach(s => { if (s.id.readyState === WebSocket.OPEN) s.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: sanitized })); });
}

function getSanitizedLobby(lobby) {
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentTurnUser = allParticipants[lobby.turnIndex] ? allParticipants[lobby.turnIndex].username : '';
    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        deckCount: lobby.deck.length,
        turnIndex: lobby.turnIndex,
        currentTurnUser: currentTurnUser,
        phaseMessage: lobby.phaseMessage,
        drawPool: lobby.drawPool.map((c, idx) => ({ index: idx, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults,
        wager: lobby.wager,
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        players: lobby.players.map(p => ({ username: p.username, lives: p.lives, cardCount: p.cards.length, ready: p.ready, seat: p.seat, cards: p.cards })),
        bots: lobby.bots.map(b => ({ username: b.username, lives: b.lives, cardCount: b.cards.length, seat: b.seat })),
        spectators: lobby.spectators.map(s => ({ username: s.username }))
    };
}

function startDealerDrawPhase(lobby) {
    let deck = createDeck();
    lobby.drawPool = deck.map(card => ({ card: card, chosenBy: null }));
    lobby.drawResults = {};
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';

    autoPickForBots(lobby);
    broadcastLobbyUpdate(lobby.code);
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        let card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        
        broadcastLobbyUpdate(lobby.code);

        if (lobby.gameState === 'dealerDraw') {
            checkDealerDrawComplete(lobby);
        } else if (lobby.gameState === 'tieBreaker') {
            checkTieBreakerComplete(lobby);
        }
    }
}

function autoPickForBots(lobby) {
    let allParticipants = [...lobby.players, ...lobby.bots];
    allParticipants.forEach(p => {
        if (lobby.bots.some(b => b.username === p.username)) {
            let available = lobby.drawPool.map((slot, i) => slot.chosenBy === null ? i : null).filter(i => i !== null);
            if (available.length > 0) {
                let randIdx = available[Math.floor(Math.random() * available.length)];
                lobby.drawPool[randIdx].chosenBy = p.username;
                lobby.drawResults[p.username] = lobby.drawPool[randIdx].card;
            }
        }
    });
}

function checkDealerDrawComplete(lobby) {
    let allParticipants = [...lobby.players, ...lobby.bots];
    let allPicked = allParticipants.every(p => lobby.drawResults[p.username]);

    if (allPicked) {
        let entries = Object.entries(lobby.drawResults).map(([user, card]) => ({ username: user, card: card }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);
        let dealerWinner = entries[0];
        lobby.phaseMessage = `🎉 ${dealerWinner.username} drew the lowest card (${dealerWinner.card.val}${dealerWinner.card.suit}) and is the Dealer!`;

        broadcastLobbyUpdate(lobby.code);

        setTimeout(() => {
            if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'dealerDraw') {
                startRound(lobbies[lobby.code]);
            }
        }, 5000);
    }
}

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    let allParticipants = [...lobby.players, ...lobby.bots];
    allParticipants.forEach(p => { p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()]; });
    lobby.discardPile.push(lobby.deck.pop());
    lobby.gameState = 'playing';
    lobby.phaseMessage = null;
    lobby.turnIndex = Math.floor(Math.random() * allParticipants.length);
    broadcastLobbyUpdate(lobby.code);
}

function handleTurnAction(lobby, ws, actionType) {
    if (lobby.gameState !== 'playing') return;
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParticipants[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws) return;
    if (currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        broadcastLobbyUpdate(lobby.code);
    } else if (actionType === 'DRAW_DISCARD') {
        if (lobby.discardPile.length > 0) {
            currentPlayer.cards.push(lobby.discardPile.pop());
            broadcastLobbyUpdate(lobby.code);
        }
    }
}

function handleDiscardAction(lobby, ws, cardIndex) {
    if (lobby.gameState !== 'playing') return;
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParticipants[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws) return;
    if (currentPlayer.cards.length !== 4) return;

    if (currentPlayer.cards[cardIndex]) {
        lobby.discardPile.push(currentPlayer.cards.splice(cardIndex, 1)[0]);
        if (calculateScore(currentPlayer.cards) === 31) {
            allParticipants.forEach(p => { if (p !== currentPlayer) p.lives--; });
            checkRoundEndOrContinue(lobby);
        } else {
            lobby.turnIndex = (lobby.turnIndex + 1) % allParticipants.length;
            broadcastLobbyUpdate(lobby.code);
        }
    }
}

function handleKnock(lobby, ws) {
    if (lobby.gameState !== 'playing') return;
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParticipants[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws) return;

    let score = calculateScore(currentPlayer.cards);
    let threshold = allParticipants.length > 2 ? 21 : 25;
    if (score >= threshold) {
        resolveRoundEnd(lobby);
    }
}

function resolveRoundEnd(lobby) {
    let allParticipants = [...lobby.players, ...lobby.bots];
    let scores = allParticipants.map(p => ({ player: p, score: calculateScore(p.cards) }));
    scores.sort((a, b) => a.score - b.score);

    let lowestScore = scores[0].score;
    let tiedPlayers = scores.filter(s => s.score === lowestScore);

    if (tiedPlayers.length > 1 && allParticipants.length >= 3) {
        // Tie breaker for 3 or more players using remaining deck cards
        lobby.drawPool = lobby.deck.map(card => ({ card: card, chosenBy: null }));
        lobby.drawResults = {};
        lobby.phaseMessage = `⚠️ Tie breaker between ${tiedPlayers.map(t => t.player.username).join(', ')}! Draw from the remaining deck.`;
        lobby.gameState = 'tieBreaker';

        // Bots tied pick automatically
        autoPickForBots(lobby);
        broadcastLobbyUpdate(lobby.code);
    } else {
        scores[0].player.lives--;
        lobby.gameState = 'roundOver';
        lobby.phaseMessage = `Round Over! ${scores[0].player.username} had the lowest score and lost a life.`;
        broadcastLobbyUpdate(lobby.code);
    }
}

function checkTieBreakerComplete(lobby) {
    // Only tied players need to pick from pool
    let allParticipants = [...lobby.players, ...lobby.bots];
    let scores = allParticipants.map(p => ({ player: p, score: calculateScore(p.cards) })).sort((a, b) => a.score - b.score);
    let lowestScore = scores[0].score;
    let tiedParticipants = scores.filter(s => s.score === lowestScore).map(s => s.player.username);

    let allTiedPicked = tiedParticipants.every(username => lobby.drawResults[username]);

    if (allTiedPicked) {
        let entries = tiedParticipants.map(username => ({ username: username, card: lobby.drawResults[username] }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);
        let loser = entries[0];
        
        let targetParticipant = allParticipants.find(p => p.username === loser.username);
        if (targetParticipant) targetParticipant.lives--;

        lobby.gameState = 'roundOver';
        lobby.phaseMessage = `Tie-breaker resolved: ${loser.username} drew the lowest tie card (${loser.card.val}${loser.card.suit}) and lost a life!`;
        broadcastLobbyUpdate(lobby.code);
    }
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
server.listen(PORT, () => { console.log(`31! Server running on port ${PORT}`); });
