const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

let AccessToken;
try {
    AccessToken = require('livekit-server-sdk').AccessToken;
} catch (e) {
    AccessToken = null;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'thirtyone-chat';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e';
const LIVEKIT_HOST = process.env.LIVEKIT_HOST || 'wss://31game.duckdns.org';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
if (fs.existsSync(path.join(__dirname, 'www'))) {
    app.use(express.static(path.join(__dirname, 'www')));
}

app.get('/token', async (req, res) => {
    const { room, username } = req.query;
    if (!room || !username || !AccessToken) {
        return res.status(400).json({ error: 'Missing parameters or LiveKit SDK unavailable' });
    }
    try {
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: username });
        at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
        const token = await at.toJwt();
        res.json({ token, host: LIVEKIT_HOST });
    } catch (err) {
        res.status(500).json({ error: 'Token generation failed' });
    }
});

app.get('*', (req, res) => {
    const candidates = [
        path.join(__dirname, 'public', 'index.html'),
        path.join(__dirname, 'index.html'),
        path.join(__dirname, 'www', 'index.html')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return res.sendFile(c);
    }
    res.status(404).send('index.html not found.');
});

const lobbies = {};

const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);
wss.on('close', () => clearInterval(heartbeat));

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            let points = (v === 'A') ? 11 : (['J', 'Q', 'K'].includes(v) ? 10 : parseInt(v, 10));
            let drawVal = parseInt(v, 10) || (v === 'A' ? 14 : (v === 'K' ? 13 : (v === 'Q' ? 12 : 11)));
            deck.push({ suit: s, val: v, points, drawVal });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function calculateScore(cards) {
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let sums = {};
    scoringCards.forEach(c => { sums[c.suit] = (sums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
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

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    let occ = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) {
        if (!occ.includes(i)) return i;
    }
    return lobby.players.length;
}

function advanceDealerToNextActive(lobby) {
    let next = (lobby.dealerIndex + 1) % lobby.players.length;
    let guard = 0;
    while (lobby.players[next].eliminated && guard < lobby.players.length) {
        next = (next + 1) % lobby.players.length;
        guard++;
    }
    lobby.dealerIndex = next;
}

function getSanitizedLobby(lobby, socketId) {
    let active = getActiveParticipants(lobby);
    let requestingPlayer = lobby.players.find(p => p.id === socketId);
    let requestingSpec = lobby.spectators.find(s => s.id === socketId);
    let myUser = requestingPlayer ? requestingPlayer.username : (requestingSpec?.username || null);

    let myFedReminder = null;
    if (myUser && lobby.fedCardReminders?.[myUser] && lobby.gameState !== 'roundOver') {
        let rem = lobby.fedCardReminders[myUser];
        let targetP = lobby.players.find(p => p.username === rem.target);
        if (targetP?.cards?.some(c => c.val === rem.card.val && c.suit === rem.card.suit)) {
            myFedReminder = rem;
        } else {
            delete lobby.fedCardReminders[myUser];
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
        currentTurnUser: lobby.players[lobby.turnIndex]?.username || '',
        phaseMessage: lobby.phaseMessage,
        canKnock: lobby.gameState === 'playing' && lobby.turnsTakenThisRound >= active.length && !lobby.knockedBy,
        potTotal: lobby.players.reduce((sum, p) => sum + (p.wager || 5), 0),
        sidePotTotal: (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0),
        myFedCardReminder: myFedReminder,
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: active.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: (lobby.drawPool || []).map((c, i) => ({ index: i, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults || {},
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        knockedBy: lobby.knockedBy || null,
        players: lobby.players.map(p => ({
            username: p.username,
            lives: Math.max(0, p.lives),
            wager: p.wager || 5,
            cardCount: p.cards.length,
            ready: p.ready,
            seat: p.seat,
            nextHandReady: p.nextHandReady,
            eliminated: p.eliminated,
            cards: (lobby.gameState === 'roundOver' || p.username === myUser) ? p.cards : []
        })),
        spectators: lobby.spectators.map(s => ({ username: s.username }))
    };
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.lobbyCode === code) {
            let payload = JSON.stringify({
                type: 'GAME_STATE_UPDATE',
                lobby: getSanitizedLobby(lobby, client.id)
            });
            client.send(payload);
        }
    });
}

function broadcastLobbyList() {
    let list = Object.values(lobbies).filter(l => !l.isPrivate).map(l => ({
        code: l.code, name: l.name, host: l.host, count: l.players.length, state: l.gameState
    }));
    let payload = JSON.stringify({ type: 'LOBBY_LIST', lobbies: list });
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(payload);
    });
}

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.knockedBy = null;
    lobby.gameState = 'playing';
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;

    let active = getActiveParticipants(lobby);
    if (active.length <= 1) {
        lobby.gameState = 'lobby';
        lobby.phaseMessage = "Need 2 or more active players.";
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    active.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.nextHandReady = false;
    });

    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = { val: firstDiscard.val, suit: firstDiscard.suit };
    lobby.lastDiscardDonor = lobby.players[lobby.dealerIndex]?.username || null;

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }
    lobby.phaseMessage = `Round started. Turn: ${lobby.players[lobby.turnIndex].username}`;
    broadcastLobbyUpdate(lobby.code);
}

function advanceTurn(lobby) {
    if (lobby.gameState === 'finalTurn') {
        lobby.finalTurnsRemaining--;
        if (lobby.finalTurnsRemaining <= 0) {
            resolveRoundEnd(lobby);
            return;
        }
    }
    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) {
        next = (next + 1) % lobby.players.length;
    }
    lobby.turnIndex = next;
    lobby.phaseMessage = `Turn: ${lobby.players[lobby.turnIndex].username}`;
    broadcastLobbyUpdate(lobby.code);
}

function resolveRoundEnd(lobby) {
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    let lowest = scores[0].s;
    let tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1 && active.length > 2) {
        lobby.tiedParticipantsList = tied.map(t => t.p.username);
        let deck = createDeck();
        lobby.drawPool = deck.map(c => ({ card: c, chosenBy: null }));
        lobby.drawResults = {};
        lobby.gameState = 'tieBreaker';
        lobby.phaseMessage = `Tie for lowest score (${lowest} pts)! Draw to resolve.`;
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    let loser = scores[0].p;
    loser.lives = Math.max(0, loser.lives - 1);
    if (loser.lives <= 0) loser.eliminated = true;

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `Round Over! ${loser.username} lost a life (${lowest} pts).`;
    advanceDealerToNextActive(lobby);
    broadcastLobbyUpdate(lobby.code);
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.gameState !== 'tieBreaker' || !lobby.tiedParticipantsList.includes(username)) return;
    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        let card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        broadcastLobbyUpdate(lobby.code);

        if (lobby.tiedParticipantsList.every(u => lobby.drawResults[u])) {
            let entries = lobby.tiedParticipantsList.map(u => ({ username: u, card: lobby.drawResults[u] })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            let loser = lobby.players.find(p => p.username === entries[0].username);
            if (loser) {
                loser.lives = Math.max(0, loser.lives - 1);
                if (loser.lives <= 0) loser.eliminated = true;
            }
            lobby.phaseMessage = `${entries[0].username} drew lowest in tie-breaker and lost a life!`;
            broadcastLobbyUpdate(lobby.code);

            setTimeout(() => {
                if (!lobbies[lobby.code]) return;
                let cur = lobbies[lobby.code];
                advanceDealerToNextActive(cur);
                cur.gameState = 'roundOver';
                broadcastLobbyUpdate(cur.code);
            }, 3000);
        }
    }
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.id = 'ws_' + Math.random().toString(36).substring(2, 9);
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (msgStr) => {
        let data;
        try { data = JSON.parse(msgStr); } catch (e) { return; }
        let lobby = lobbies[ws.lobbyCode];

        switch (data.type) {
            case 'CREATE_LOBBY': {
                let username = (data.username || 'Host').trim();
                let code = Math.random().toString(36).substring(2, 8).toUpperCase();
                ws.lobbyCode = code;
                ws.username = username;

                lobbies[code] = {
                    code,
                    name: data.lobbyName || `${username}'s Room`,
                    host: username,
                    isPrivate: !!data.isPrivate,
                    players: [{
                        id: ws.id,
                        username,
                        lives: 2,
                        wager: 5,
                        cards: [],
                        ready: false,
                        seat: 0,
                        nextHandReady: false,
                        eliminated: false
                    }],
                    spectators: [],
                    deck: [],
                    discardPile: [],
                    gameState: 'lobby',
                    drawPool: [],
                    drawResults: {},
                    turnIndex: 0,
                    dealerIndex: 0,
                    sideBetLedger: {},
                    mainGameLedger: {},
                    activeBets: [],
                    pendingBets: [],
                    knockedBy: null,
                    finalTurnsRemaining: 0,
                    turnsTakenThisRound: 0,
                    fedCardReminders: {},
                    phaseMessage: 'Lobby ready. Click Ready Up to start.'
                };
                ws.send(JSON.stringify({
                    type: 'LOBBY_JOINED',
                    code,
                    lobby: getSanitizedLobby(lobbies[code], ws.id)
                }));
                broadcastLobbyList();
                break;
            }
            case 'JOIN_LOBBY': {
                let code = (data.code || '').trim().toUpperCase();
                let username = (data.username || 'Player').trim();
                let target = lobbies[code];
                if (!target) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found.' }));
                    return;
                }
                ws.lobbyCode = code;
                ws.username = username;

                let existing = target.players.find(p => p.username.toLowerCase() === username.toLowerCase());
                if (existing) {
                    existing.id = ws.id;
                } else if (target.players.length < 6 && target.gameState === 'lobby') {
                    target.players.push({
                        id: ws.id,
                        username,
                        lives: 2,
                        wager: 5,
                        cards: [],
                        ready: false,
                        seat: findOpenSeat(target),
                        nextHandReady: false,
                        eliminated: false
                    });
                } else {
                    target.spectators.push({ id: ws.id, username });
                }
                ws.send(JSON.stringify({
                    type: 'LOBBY_JOINED',
                    code,
                    lobby: getSanitizedLobby(target, ws.id)
                }));
                broadcastLobbyUpdate(code);
                broadcastLobbyList();
                break;
            }
            case 'REFRESH_LOBBIES': {
                broadcastLobbyList();
                break;
            }
            case 'SET_READY': {
                if (!lobby || lobby.gameState !== 'lobby') return;
                let p = lobby.players.find(pl => pl.id === ws.id);
                if (p) p.ready = !p.ready;
                let active = getActiveParticipants(lobby);
                if (active.length >= 2 && active.every(pl => pl.ready)) {
                    startRound(lobby);
                } else {
                    broadcastLobbyUpdate(lobby.code);
                }
                break;
            }
            case 'DRAW_DECK':
            case 'DRAW_DISCARD': {
                if (!lobby || (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn')) return;
                let cur = lobby.players[lobby.turnIndex];
                if (!cur || cur.id !== ws.id || cur.cards.length >= 4) return;

                if (data.type === 'DRAW_DECK') {
                    if (lobby.deck.length === 0) lobby.deck = createDeck();
                    cur.cards.push(lobby.deck.pop());
                } else if (lobby.discardPile.length > 0) {
                    let card = lobby.discardPile.pop();
                    cur.cards.push(card);
                    if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== cur.username) {
                        lobby.fedCardReminders[lobby.lastDiscardDonor] = {
                            target: cur.username,
                            card: { val: card.val, suit: card.suit }
                        };
                    }
                    if (lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
                        lobby.lastDiscardPickup = { username: cur.username, card: { val: card.val, suit: card.suit } };
                    }
                }

                if (calculateBestFourCardScore(cur.cards) === 31) {
                    lobby.players.forEach(p => { if (p !== cur && !p.eliminated) p.lives = Math.max(0, p.lives - 1); });
                    lobby.gameState = 'roundOver';
                    lobby.phaseMessage = `Round Over! ${cur.username} hit 31 points!`;
                    advanceDealerToNextActive(lobby);
                }
                broadcastLobbyUpdate(lobby.code);
                break;
            }
            case 'DISCARD_CARD': {
                if (!lobby || (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn')) return;
                let cur = lobby.players[lobby.turnIndex];
                let idx = data.cardIndex !== undefined ? data.cardIndex : data.index;
                if (!cur || cur.id !== ws.id || cur.cards.length !== 4 || idx === undefined || idx < 0 || idx >= 4) return;

                let discarded = cur.cards.splice(idx, 1)[0];
                lobby.discardPile.push(discarded);
                lobby.lastDiscardDonor = cur.username;
                lobby.turnsTakenThisRound++;

                if (calculateScore(cur.cards) === 31) {
                    lobby.players.forEach(p => { if (p !== cur && !p.eliminated) p.lives = Math.max(0, p.lives - 1); });
                    lobby.gameState = 'roundOver';
                    lobby.phaseMessage = `Round Over! ${cur.username} hit 31 points!`;
                    advanceDealerToNextActive(lobby);
                    broadcastLobbyUpdate(lobby.code);
                } else {
                    advanceTurn(lobby);
                }
                break;
            }
            case 'KNOCK': {
                if (!lobby || lobby.gameState !== 'playing') return;
                let cur = lobby.players[lobby.turnIndex];
                if (!cur || cur.id !== ws.id || lobby.knockedBy || cur.cards.length !== 3) return;

                let active = getActiveParticipants(lobby);
                let threshold = active.length > 2 ? 21 : 25;
                if (calculateScore(cur.cards) < threshold || lobby.turnsTakenThisRound < active.length) return;

                lobby.gameState = 'finalTurn';
                lobby.knockedBy = cur.username;
                lobby.finalTurnsRemaining = active.length - 1;
                lobby.phaseMessage = `🔔 KNOCK! ${cur.username} knocked! 1 final turn each.`;
                advanceTurn(lobby);
                break;
            }
            case 'CHOOSE_POOL_CARD': {
                if (!lobby) return;
                handlePoolCardSelection(lobby, ws.username, data.cardIndex);
                break;
            }
            case 'NEXT_HAND':
            case 'NEXT_HAND_READY': {
                if (!lobby || lobby.gameState !== 'roundOver') return;
                let p = lobby.players.find(pl => pl.id === ws.id);
                if (p) p.nextHandReady = true;
                let active = getActiveParticipants(lobby);
                if (active.length > 1 && active.every(pl => pl.nextHandReady)) {
                    startRound(lobby);
                } else if (active.length <= 1) {
                    lobby.gameState = 'lobby';
                    lobby.phaseMessage = "Match finished! Returning to lobby.";
                    lobby.players.forEach(pl => { pl.lives = 2; pl.eliminated = false; pl.cards = []; pl.ready = false; });
                    broadcastLobbyUpdate(lobby.code);
                } else {
                    broadcastLobbyUpdate(lobby.code);
                }
                break;
            }
            case 'LEAVE_LOBBY': {
                if (lobby) {
                    lobby.players = lobby.players.filter(p => p.id !== ws.id);
                    lobby.spectators = lobby.spectators.filter(s => s.id !== ws.id);
                    if (lobby.players.length === 0) delete lobbies[lobby.code];
                    else broadcastLobbyUpdate(lobby.code);
                    broadcastLobbyList();
                }
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                break;
            }
        }
    });

    ws.on('close', () => {
        let lobby = lobbies[ws.lobbyCode];
        if (lobby) {
            lobby.players = lobby.players.filter(p => p.id !== ws.id);
            lobby.spectators = lobby.spectators.filter(s => s.id !== ws.id);
            if (lobby.players.length === 0) delete lobbies[lobby.code];
            else broadcastLobbyUpdate(lobby.code);
            broadcastLobbyList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`31 Card Game running on port ${PORT}`));