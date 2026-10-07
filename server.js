const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', promise, reason));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
if (fs.existsSync(path.join(__dirname, 'www'))) {
    app.use(express.static(path.join(__dirname, 'www')));
}

const LIVEKIT_CONFIG = {
    apiKey: process.env.LIVEKIT_API_KEY || 'thirtyone-chat',
    apiSecret: process.env.LIVEKIT_API_SECRET || '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e',
    host: process.env.LIVEKIT_HOST || 'wss://31game.duckdns.org'
};

async function getLiveKitToken(room, username) {
    try {
        const { AccessToken } = require('livekit-server-sdk');
        const at = new AccessToken(LIVEKIT_CONFIG.apiKey, LIVEKIT_CONFIG.apiSecret, { identity: username });
        at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
        return await at.toJwt();
    } catch (e) {
        return null;
    }
}

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
    let scoring = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoring || scoring.length === 0) return 0;
    let sums = {};
    scoring.forEach(c => sums[c.suit] = (sums[c.suit] || 0) + c.points);
    if (scoring.length === 3 && scoring[0].val === scoring[1].val && scoring[0].val === scoring[2].val) return 30.5;
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
    return 0;
}

function getSanitizedLobby(lobby, wsId) {
    let active = getActiveParticipants(lobby);
    let requestingPlayer = lobby.players.find(p => p.id === wsId);
    let requestingSpec = lobby.spectators.find(s => s.idSocket === wsId);
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
        canKnock: lobby.turnsTakenThisRound >= active.length,
        potTotal: lobby.players.reduce((sum, p) => sum + (p.wager || 5), 0),
        sidePotTotal: (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0),
        myFedCardReminder: myFedReminder,
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        pendingBetsForMe: (lobby.pendingBets || []).filter(b => b.target === myUser),
        globalProposals: lobby.globalProposals || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: active.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: (lobby.drawPool || []).map((c, i) => ({ index: i, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults || {},
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        knockedBy: lobby.knockedBy || null,
        chatHistory: lobby.chatHistory || [],
        playlist: lobby.playlist || [],
        currentSongIndex: lobby.currentSongIndex || 0,
        isPlaying: !!lobby.isPlaying,
        currentSongElapsedSeconds: lobby.songPausedAtOffset || 0,
        players: lobby.players.map(p => ({
            username: p.username,
            lives: Math.max(0, p.lives),
            wager: p.wager || 5,
            cardCount: p.cards.length,
            ready: p.ready,
            seat: p.seat,
            nextHandReady: p.nextHandReady,
            eliminated: p.eliminated,
            inVC: !!p.inVC,
            isMuted: !!p.isMuted,
            peekIncoming: wsId === p.id ? (p.peekRequests || {}) : {},
            peekAllowed: p.peekAllowed || {},
            cards: (lobby.gameState === 'roundOver' || p.username === myUser || (requestingSpec && p.peekAllowed?.[requestingSpec.username])) ? p.cards : []
        })),
        spectators: lobby.spectators.map(s => ({ username: s.username, inVC: !!s.inVC, isMuted: !!s.isMuted }))
    };
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    lobby.players.forEach(p => {
        if (p.id?.readyState === WebSocket.OPEN) {
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, p.id) }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket?.readyState === WebSocket.OPEN) {
            s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, s.idSocket) }));
        }
    });
}

function broadcastLobbyList() {
    let list = Object.values(lobbies).filter(l => !l.isPrivate).map(l => ({
        code: l.code, name: l.name, host: l.host, count: l.players.length, state: l.gameState
    }));
    let payload = JSON.stringify({ type: 'LOBBY_LIST', lobbies: list });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
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
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    active.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.nextHandReady = false;
    });

    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.lastDiscardDonor = lobby.players[lobby.dealerIndex]?.username || null;

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }
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
    broadcastLobbyUpdate(lobby.code);
}

function resolveRoundEnd(lobby) {
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    let lowest = scores[0].s;
    let tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1 && active.length > 2) {
        lobby.tiedParticipantsList = tied.map(t => t.p.username);
        lobby.drawPool = lobby.deck.map(c => ({ card: c, chosenBy: null }));
        lobby.drawResults = {};
        lobby.gameState = 'tieBreaker';
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    let loser = scores[0].p;
    loser.lives = Math.max(0, loser.lives - 1);
    if (loser.lives <= 0) loser.eliminated = true;

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `Round Over! ${loser.username} lost a life (${lowest} pts).`;
    let nextDealer = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[nextDealer].eliminated) nextDealer = (nextDealer + 1) % lobby.players.length;
    lobby.dealerIndex = nextDealer;
    broadcastLobbyUpdate(lobby.code);
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let currentCode = null;
    let currentUser = null;

    ws.on('message', async (msgStr) => {
        let data;
        try { data = JSON.parse(msgStr); } catch (e) { return; }
        let lobby = lobbies[currentCode];

        switch (data.type) {
            case 'CREATE_LOBBY': {
                currentUser = (data.username || 'Player').trim();
                currentCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                lobbies[currentCode] = {
                    code: currentCode,
                    name: data.lobbyName || `${currentUser}'s Lobby`,
                    host: currentUser,
                    isPrivate: !!data.isPrivate,
                    players: [{ id: ws, username: currentUser, lives: 2, wager: 5, cards: [], ready: false, seat: 0, nextHandReady: false, eliminated: false, inVC: true, isMuted: true }],
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
                    globalProposals: [],
                    knockedBy: null,
                    finalTurnsRemaining: 0,
                    turnsTakenThisRound: 0,
                    fedCardReminders: {},
                    chatHistory: [],
                    playlist: [],
                    currentSongIndex: 0,
                    isPlaying: false
                };

                const token = await getLiveKitToken(currentCode, currentUser);
                ws.send(JSON.stringify({
                    type: 'LOBBY_JOINED',
                    lobby: getSanitizedLobby(lobbies[currentCode], ws),
                    livekitToken: token,
                    livekitHost: LIVEKIT_CONFIG.host
                }));
                broadcastLobbyList();
                break;
            }

            case 'JOIN_LOBBY': {
                let code = (data.code || '').toUpperCase();
                currentUser = (data.username || 'Player').trim();
                let targetLobby = lobbies[code];
                if (targetLobby) {
                    currentCode = code;
                    let existing = targetLobby.players.find(p => p.username.toLowerCase() === currentUser.toLowerCase());
                    if (existing) {
                        existing.id = ws;
                    } else if (targetLobby.players.length < 6 && targetLobby.gameState === 'lobby') {
                        targetLobby.players.push({ id: ws, username: currentUser, lives: 2, wager: 5, cards: [], ready: false, seat: findOpenSeat(targetLobby), nextHandReady: false, eliminated: false, inVC: true, isMuted: true });
                    } else {
                        targetLobby.spectators.push({ username: currentUser, idSocket: ws, inVC: true, isMuted: true });
                    }

                    const token = await getLiveKitToken(currentCode, currentUser);
                    ws.send(JSON.stringify({
                        type: 'LOBBY_JOINED',
                        lobby: getSanitizedLobby(targetLobby, ws),
                        livekitToken: token,
                        livekitHost: LIVEKIT_CONFIG.host
                    }));
                    broadcastLobbyUpdate(code);
                    broadcastLobbyList();
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found.' }));
                }
                break;
            }

            case 'REFRESH_LOBBIES': {
                broadcastLobbyList();
                break;
            }

            case 'SET_READY': {
                if (lobby && lobby.gameState === 'lobby') {
                    let p = lobby.players.find(pl => pl.id === ws);
                    if (p) p.ready = !!data.ready;
                    let active = getActiveParticipants(lobby);
                    if (active.length >= 2 && active.every(pl => pl.ready)) {
                        startRound(lobby);
                    } else {
                        broadcastLobbyUpdate(currentCode);
                    }
                }
                break;
            }

            case 'DRAW_DECK':
            case 'DRAW_DISCARD': {
                if (!lobby || (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn')) return;
                let curP = lobby.players[lobby.turnIndex];
                if (!curP || curP.id !== ws || curP.cards.length >= 4) return;

                if (data.type === 'DRAW_DECK') {
                    if (lobby.deck.length === 0) lobby.deck = createDeck();
                    curP.cards.push(lobby.deck.pop());
                } else if (lobby.discardPile.length > 0) {
                    let card = lobby.discardPile.pop();
                    curP.cards.push(card);
                    if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== curP.username) {
                        lobby.fedCardReminders[lobby.lastDiscardDonor] = { target: curP.username, card: { val: card.val, suit: card.suit } };
                    }
                }
                if (calculateBestFourCardScore(curP.cards) === 31) {
                    lobby.players.forEach(p => { if (p !== curP && !p.eliminated) p.lives = Math.max(0, p.lives - 1); });
                    lobby.gameState = 'roundOver';
                    lobby.phaseMessage = `Round Over! ${curP.username} hit 31!`;
                    broadcastLobbyUpdate(currentCode);
                } else {
                    broadcastLobbyUpdate(currentCode);
                }
                break;
            }

            case 'DISCARD_CARD': {
                if (!lobby || (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn')) return;
                let curP = lobby.players[lobby.turnIndex];
                if (!curP || curP.id !== ws || curP.cards.length !== 4) return;

                let discarded = curP.cards.splice(data.cardIndex, 1)[0];
                lobby.discardPile.push(discarded);
                lobby.lastDiscardDonor = curP.username;
                lobby.turnsTakenThisRound++;

                if (calculateScore(curP.cards) === 31) {
                    lobby.players.forEach(p => { if (p !== curP && !p.eliminated) p.lives = Math.max(0, p.lives - 1); });
                    lobby.gameState = 'roundOver';
                    lobby.phaseMessage = `Round Over! ${curP.username} hit 31!`;
                    broadcastLobbyUpdate(currentCode);
                } else {
                    advanceTurn(lobby);
                }
                break;
            }

            case 'KNOCK': {
                if (!lobby || lobby.gameState !== 'playing') return;
                let curP = lobby.players[lobby.turnIndex];
                if (!curP || curP.id !== ws || lobby.knockedBy || curP.cards.length !== 3) return;

                let active = getActiveParticipants(lobby);
                let threshold = active.length > 2 ? 21 : 25;
                if (calculateScore(curP.cards) < threshold || lobby.turnsTakenThisRound < active.length) return;

                lobby.gameState = 'finalTurn';
                lobby.knockedBy = curP.username;
                lobby.finalTurnsRemaining = active.length - 1;
                lobby.phaseMessage = `🔔 KNOCK! ${curP.username} knocked! 1 final turn each.`;
                advanceTurn(lobby);
                break;
            }

            case 'NEXT_HAND': {
                if (lobby && lobby.gameState === 'roundOver') {
                    let p = lobby.players.find(pl => pl.id === ws);
                    if (p) p.nextHandReady = true;
                    let active = getActiveParticipants(lobby);
                    if (active.every(pl => pl.nextHandReady) && active.length > 1) {
                        startRound(lobby);
                    } else {
                        broadcastLobbyUpdate(currentCode);
                    }
                }
                break;
            }

            case 'CHAT_MESSAGE': {
                if (lobby) {
                    let payload = JSON.stringify({ type: 'CHAT_MESSAGE', username: currentUser, message: data.message });
                    lobby.players.forEach(p => p.id?.send(payload));
                    lobby.spectators.forEach(s => s.idSocket?.send(payload));
                }
                break;
            }

            case 'LEAVE_LOBBY': {
                if (lobby) {
                    lobby.players = lobby.players.filter(p => p.id !== ws);
                    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);
                    if (lobby.players.length === 0) delete lobbies[currentCode];
                    else broadcastLobbyUpdate(currentCode);
                    broadcastLobbyList();
                }
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                break;
            }
        }
    });
});

app.get('*', (req, res) => {
    const candidate = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(candidate)) return res.sendFile(candidate);
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
