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
            if (v === 'A') points = 11;
            else if (['J', 'Q', 'K'].includes(v)) points = 10;
            else points = parseInt(v);
            deck.push({ suit: s, val: v, points: points });
        }
    }
    // Shuffle deck
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
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        switch (data.type) {
            case 'CREATE_LOBBY':
                currentLobbyCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                currentUsername = data.username;
                lobbies[currentLobbyCode] = {
                    code: currentLobbyCode,
                    host: currentUsername,
                    players: [{ id: ws, username: currentUsername, lives: data.lives || 2, cards: [], ready: false, seat: 0 }],
                    bots: [],
                    spectators: [],
                    deck: [],
                    discardPile: [],
                    gameState: 'lobby', // lobby, dealing, playing, roundOver
                    turnIndex: 0,
                    wager: data.wager || 5,
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
                    
                    let totalOccupants = lobby.players.length + lobby.bots.length;
                    if (totalOccupants < 6 && lobby.gameState === 'lobby') {
                        let availableSeat = findOpenSeat(lobby);
                        lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, cards: [], ready: false, seat: availableSeat });
                    } else {
                        lobby.spectators.push({ id: ws, username: currentUsername });
                    }
                    ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby) }));
                    broadcastLobbyUpdate(code);
                    broadcastLobbyList();
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                }
                break;

            case 'ADD_BOT':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    if (lobby.players.length + lobby.bots.length < 6 && lobby.gameState === 'lobby') {
                        let botName = 'Bot_' + Math.floor(Math.random() * 900 + 100);
                        let seat = findOpenSeat(lobby);
                        lobby.bots.push({ username: botName, lives: lobby.players[0]?.lives || 2, cards: [], seat: seat, ready: true });
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

                        // Check if all ready to start game
                        let allReady = lobby.players.every(p => p.ready);
                        if (allReady && (lobby.players.length + lobby.bots.length >= 2)) {
                            startRound(lobby);
                        }
                    }
                }
                break;

            case 'DRAW_DECK':
            case 'DRAW_DISCARD':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    handleTurnAction(lobby, ws, data.type);
                }
                break;

            case 'DISCARD_CARD':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    handleDiscardAction(lobby, ws, data.cardIndex);
                }
                break;

            case 'KNOCK':
                if (currentLobbyCode && lobbies[currentLobbyCode]) {
                    let lobby = lobbies[currentLobbyCode];
                    handleKnock(lobby, ws);
                }
                break;

            case 'LEAVE_LOBBY':
                leaveLobby(ws, currentLobbyCode);
                currentLobbyCode = null;
                break;
        }
    });

    ws.on('close', () => {
        if (currentLobbyCode) {
            leaveLobby(ws, currentLobbyCode);
        }
    });
});

function findOpenSeat(lobby) {
    let occupiedSeats = lobby.players.map(p => p.seat).concat(lobby.bots.map(b => b.seat));
    for (let i = 0; i < 6; i++) {
        if (!occupiedSeats.includes(i)) return i;
    }
    return 0;
}

function leaveLobby(ws, code) {
    if (!lobbies[code]) return;
    let lobby = lobbies[code];
    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.id !== ws);

    if (lobby.players.length === 0 && lobby.bots.length === 0) {
        delete lobbies[code];
    } else {
        broadcastLobbyUpdate(code);
    }
    broadcastLobbyList();
}

function broadcastLobbyList() {
    let publicLobbies = Object.values(lobbies).map(l => ({
        code: l.code,
        host: l.host,
        count: l.players.length + l.bots.length,
        state: l.gameState
    }));
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: publicLobbies }));
        }
    });
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let sanitized = getSanitizedLobby(lobby);
    
    // Send to players
    lobby.players.forEach(p => {
        if (p.id.readyState === WebSocket.OPEN) {
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: sanitized }));
        }
    });
    // Send to specs
    lobby.spectators.forEach(s => {
        if (s.id.readyState === WebSocket.OPEN) {
            s.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: sanitized }));
        }
    });
}

function getSanitizedLobby(lobby) {
    return {
        code: lobby.code,
        host: lobby.host,
        gameState: lobby.gameState,
        turnIndex: lobby.turnIndex,
        wager: lobby.wager,
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        players: lobby.players.map(p => ({
            username: p.username,
            lives: p.lives,
            cardCount: p.cards.length,
            ready: p.ready,
            seat: p.seat,
            cards: p.cards // Sent to owner in client parsing or full view
        })),
        bots: lobby.bots.map(b => ({
            username: b.username,
            lives: b.lives,
            cardCount: b.cards.length,
            seat: b.seat
        })),
        spectators: lobby.spectators.map(s => ({ username: s.username }))
    };
}

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    let allParticipants = [...lobby.players, ...lobby.bots];
    
    allParticipants.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
    });
    lobby.discardPile.push(lobby.deck.pop());
    lobby.gameState = 'playing';
    lobby.turnIndex = Math.floor(Math.random() * allParticipants.length);
    broadcastLobbyUpdate(lobby.code);
}

function handleTurnAction(lobby, ws, actionType) {
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParticipants[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws) return; // Not their turn

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        let drawn = lobby.deck.pop();
        currentPlayer.cards.push(drawn);
        broadcastLobbyUpdate(lobby.code);
    } else if (actionType === 'DRAW_DISCARD') {
        if (lobby.discardPile.length > 0) {
            let drawn = lobby.discardPile.pop();
            currentPlayer.cards.push(drawn);
            broadcastLobbyUpdate(lobby.code);
        }
    }
}

function handleDiscardAction(lobby, ws, cardIndex) {
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParticipants[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws) return;

    if (currentPlayer.cards[cardIndex]) {
        let discarded = currentPlayer.cards.splice(cardIndex, 1)[0];
        lobby.discardPile.push(discarded);

        // Check score / 31 condition
        let score = calculateScore(currentPlayer.cards);
        if (score === 31) {
            // Instant win round stop
            allParticipants.forEach(p => {
                if (p !== currentPlayer) p.lives--;
            });
            lobby.gameState = 'roundOver';
        } else {
            // Next turn clockwise
            lobby.turnIndex = (lobby.turnIndex + 1) % allParticipants.length;
        }
        broadcastLobbyUpdate(lobby.code);
    }
}

function handleKnock(lobby, ws) {
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParticipants[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws) return;

    let score = calculateScore(currentPlayer.cards);
    let threshold = allParticipants.length > 2 ? 21 : 25;

    if (score >= threshold) {
        // Find lowest score among all
        let scores = allParticipants.map(p => ({ player: p, score: calculateScore(p.cards) }));
        scores.sort((a, b) => a.score - b.score);
        let lowest = scores[0];
        lowest.player.lives--;
        lobby.gameState = 'roundOver';
        broadcastLobbyUpdate(lobby.code);
    }
}

function calculateScore(cards) {
    let suitSums = {};
    cards.forEach(c => {
        suitSums[c.suit] = (suitSums[c.suit] || 0) + c.points;
    });
    let maxSuitSum = Math.max(...Object.values(suitSums), 0);
    
    // Check 3 of a kind
    if (cards.length === 3 && cards[0].val === cards[1].val && cards[1].val === cards[2].val) {
        return 30.5;
    }
    return maxSuitSum;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`31! Game Server running on port ${PORT}`);
});
