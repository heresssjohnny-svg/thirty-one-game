const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// LiveKit Server Credentials
const LIVEKIT_API_KEY = 'thirtyone-chat';
const LIVEKIT_API_SECRET = '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e';
const LIVEKIT_HOST = 'wss://31game.duckdns.org';

app.use(express.json({ limit: '10mb' }));

// Dynamically serve static folders (root, www, public)
const wwwPath = path.join(__dirname, 'www');
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(wwwPath)) {
    app.use(express.static(wwwPath));
} else if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
} else {
    app.use(express.static(__dirname));
}

// LiveKit Token HTTP endpoint for test bench queries
app.get('/token', async (req, res) => {
    const username = (req.query.username || 'Player').trim();
    const room = (req.query.room || 'Lobby').trim();
    const token = await generateLiveKitToken(username, room);
    res.json({ token, host: LIVEKIT_HOST });
});

app.get('*', (req, res) => {
    if (fs.existsSync(path.join(wwwPath, 'index.html'))) {
        res.sendFile(path.join(wwwPath, 'index.html'));
    } else if (fs.existsSync(path.join(publicPath, 'index.html'))) {
        res.sendFile(path.join(publicPath, 'index.html'));
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// Card Definitions
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function getCardPoints(val) {
    if (val === 'A') return 11;
    if (['K', 'Q', 'J', '10'].includes(val)) return 10;
    return parseInt(val, 10);
}

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let val of VALUES) {
            deck.push({ suit, val, points: getCardPoints(val) });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function calculateScore(cards) {
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let sums = {};
    scoringCards.forEach(c => { sums[c.suit] = (sums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) return 30.5;
    return Math.max(...Object.values(sums), 0);
}

const lobbies = {};

async function generateLiveKitToken(username, roomName) {
    try {
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: username,
            name: username
        });
        at.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        });
        return await at.toJwt();
    } catch (e) {
        console.error("LiveKit JWT generation error:", e);
        return null;
    }
}

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    let occupied = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) {
        if (!occupied.includes(i)) return i;
    }
    return 0;
}

function broadcastLobbyList() {
    const list = Object.values(lobbies)
        .filter(l => !l.isPrivate)
        .map(l => ({
            code: l.code,
            name: l.name,
            host: l.host,
            count: l.players.length,
            state: l.gameState
        }));

    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: list }));
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

    let elapsedSeconds = 0;
    if (lobby.isPlaying && lobby.songStartedAt) {
        elapsedSeconds = Math.max(0, Math.floor((Date.now() - lobby.songStartedAt) / 1000));
    } else {
        elapsedSeconds = lobby.songPausedAtOffset || 0;
    }

    let potTotal = allParticipants.reduce((sum, p) => sum + (p.wager || 5), 0);
    let currentTurnUser = allParticipants[lobby.turnIndex] ? allParticipants[lobby.turnIndex].username : '';

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        players: sortedParticipants.map(p => {
            const isPeekingThisPlayer = requestingSpectator && requestingSpectator.peekingAt === p.username;
            const showCards = (p.id === wsId || lobby.gameState === 'roundOver' || p.revealed || isPeekingThisPlayer);
            return {
                username: p.username,
                seat: p.seat,
                lives: p.lives,
                wager: p.wager || 5,
                cards: showCards ? p.cards : p.cards.map(() => ({ val: '?', suit: '?' })),
                score: showCards ? calculateScore(p.cards) : null,
                eliminated: p.eliminated,
                ready: p.ready,
                isBot: p.isBot,
                inVC: p.inVC,
                isMuted: p.isMuted,
                nextHandReady: p.nextHandReady,
                peekIncoming: p.peekIncoming || {}
            };
        }),
        spectatorsCount: lobby.spectators.length,
        spectators: lobby.spectators.map(s => ({ username: s.username, inVC: s.inVC, isMuted: s.isMuted })),
        deckCount: lobby.deck.length,
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        discardCount: lobby.discardPile.length,
        initialDealCard: lobby.initialDealCard,
        lastDiscardPickup: lobby.lastDiscardPickup,
        myFedCardReminder: myFedReminder,
        potTotal,
        sidePotTotal: lobby.sidePotTotal || 0,
        currentTurnUser,
        dealerIndex: lobby.dealerIndex,
        dealerName: lobby.players[lobby.dealerIndex]?.username || '',
        canKnock: lobby.turnsTakenThisRound >= getActiveParticipants(lobby).length,
        knockedBy: lobby.knockedBy,
        phaseMessage: lobby.phaseMessage,
        activeParticipantsCount: getActiveParticipants(lobby).length,
        drawPool: lobby.drawPool || [],
        drawResults: lobby.drawResults || {},
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        globalProposals: lobby.globalProposals || [],
        pendingBetsForMe: myUsername ? (lobby.pendingBets || []).filter(b => b.target === myUsername) : [],
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        botBetLedger: lobby.botBetLedger || {},
        playlist: lobby.playlist || [],
        currentSongIndex: lobby.currentSongIndex || 0,
        isPlaying: lobby.isPlaying || false,
        songElapsedSeconds: elapsedSeconds,
        livekitHost: LIVEKIT_HOST,
        livekitToken: lobby.tokenCache?.[myUsername] || null
    };
}

function handleKnock(lobby, username) {
    if (lobby.knockedBy || lobby.gameState !== 'playing') return;
    lobby.knockedBy = username;
    lobby.gameState = 'finalTurn';
    lobby.phaseMessage = `🔔 ${username} knocked! Everyone gets one last turn.`;
    advanceTurn(lobby);
}

function advanceTurn(lobby) {
    let active = getActiveParticipants(lobby);
    if (active.length <= 1) {
        resolveRoundEnd(lobby);
        return;
    }

    lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }

    lobby.turnsTakenThisRound++;

    if (lobby.gameState === 'finalTurn' && lobby.players[lobby.turnIndex].username === lobby.knockedBy) {
        resolveRoundEnd(lobby);
        return;
    }

    let currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
        setTimeout(() => runBotTurn(lobby, currentPlayer), 1100);
    }
}

function runBotTurn(lobby, bot) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    if (lobby.players[lobby.turnIndex]?.username !== bot.username) return;

    let discardTop = lobby.discardPile[lobby.discardPile.length - 1];
    let shouldPickDiscard = false;

    if (discardTop) {
        let testCards = [...bot.cards, discardTop];
        if (calculateScore(testCards) > calculateScore(bot.cards)) shouldPickDiscard = true;
    }

    if (shouldPickDiscard && lobby.discardPile.length > 0) {
        bot.cards.push(lobby.discardPile.pop());
        lobby.lastDiscardPickup = { username: bot.username, card: discardTop };
    } else if (lobby.deck.length > 0) {
        bot.cards.push(lobby.deck.pop());
    }

    // 7.5 IQ Bot: Discard the lowest scoring card
    let bestScore = -1;
    let discardIdx = 0;
    for (let i = 0; i < bot.cards.length; i++) {
        let remaining = bot.cards.filter((_, idx) => idx !== i);
        let score = calculateScore(remaining);
        if (score > bestScore) {
            bestScore = score;
            discardIdx = i;
        }
    }

    let discarded = bot.cards.splice(discardIdx, 1)[0];
    lobby.discardPile.push(discarded);

    // Track fed card to next player
    let nextIdx = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[nextIdx].eliminated) {
        nextIdx = (nextIdx + 1) % lobby.players.length;
    }
    lobby.fedCardReminders[bot.username] = {
        target: lobby.players[nextIdx].username,
        card: discarded
    };

    if (lobby.gameState === 'playing' && !lobby.knockedBy && calculateScore(bot.cards) >= 28) {
        handleKnock(lobby, bot.username);
    } else {
        advanceTurn(lobby);
    }
    broadcastLobbyUpdate(lobby.code);
}

function resolveRoundEnd(lobby) {
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ player: p, score: calculateScore(p.cards) }));
    scores.sort((a, b) => a.score - b.score);

    let lowestScore = scores[0].score;
    let losers = scores.filter(s => s.score === lowestScore);

    // Tie-breaker phase if multiple tied for lowest score
    if (losers.length > 1 && active.length > 2) {
        lobby.gameState = 'tieBreaker';
        lobby.tiedParticipantsList = losers.map(l => l.player.username);
        lobby.phaseMessage = `Tie for lowest score (${lowestScore})! Tied players must draw a tie-breaker card.`;
        lobby.drawPool = [];
        for (let i = 0; i < 12; i++) lobby.drawPool.push({ index: i, chosenBy: null });
        lobby.drawResults = {};
        broadcastLobbyUpdate(lobby.code);

        // Auto-pick for bots in tie-breaker
        losers.filter(l => l.player.isBot).forEach((l, i) => {
            setTimeout(() => {
                let openSlot = lobby.drawPool.find(s => !s.chosenBy);
                if (openSlot) {
                    openSlot.chosenBy = l.player.username;
                    lobby.drawResults[l.player.username] = lobby.deck.pop() || { suit: '♠', val: 'A', points: 11 };
                    checkTieBreakerDone(lobby);
                }
            }, 800 * (i + 1));
        });
        return;
    }

    losers.forEach(l => {
        l.player.lives -= 1;
        if (l.player.lives <= 0) l.player.eliminated = true;
    });

    let loserNames = losers.map(l => l.player.username).join(', ');
    lobby.phaseMessage = `Round concluded! ${loserNames} had the lowest hand (${lowestScore}) and lost a life.`;
    concludeRound(lobby);
}

function checkTieBreakerDone(lobby) {
    let tied = lobby.tiedParticipantsList;
    if (tied.every(u => lobby.drawResults[u])) {
        broadcastLobbyUpdate(lobby.code);
        setTimeout(() => {
            let entries = tied.map(u => ({ username: u, card: lobby.drawResults[u], points: lobby.drawResults[u].points }));
            entries.sort((a, b) => a.points - b.points);
            let absoluteLoserName = entries[0].username;
            let loserPlayer = lobby.players.find(p => p.username === absoluteLoserName);
            if (loserPlayer) {
                loserPlayer.lives -= 1;
                if (loserPlayer.lives <= 0) loserPlayer.eliminated = true;
            }
            lobby.phaseMessage = `Tie-breaker resolved! ${absoluteLoserName} drew lowest (${entries[0].card.val}${entries[0].card.suit}) and lost a life.`;
            concludeRound(lobby);
        }, 3000);
    }
}

function concludeRound(lobby) {
    lobby.gameState = 'roundOver';
    lobby.players.forEach(p => { p.nextHandReady = false; });

    let nonElim = lobby.players.filter(p => !p.eliminated);
    if (nonElim.length > 1) {
        let nextDealerIdx = (lobby.dealerIndex + 1) % lobby.players.length;
        while (lobby.players[nextDealerIdx].eliminated) {
            nextDealerIdx = (nextDealerIdx + 1) % lobby.players.length;
        }
        lobby.dealerIndex = nextDealerIdx;
    } else if (nonElim.length === 1) {
        let winner = nonElim[0];
        lobby.phaseMessage = `🏆 Match over! ${winner.username} wins the game!`;
        let wager = 5;
        lobby.players.forEach(p => {
            if (p.username !== winner.username) {
                let targetLedger = p.isBot ? lobby.botBetLedger : lobby.mainGameLedger;
                if (!targetLedger[p.username]) targetLedger[p.username] = {};
                targetLedger[p.username][winner.username] = (targetLedger[p.username][winner.username] || 0) + wager;
            }
        });
    }
    broadcastLobbyUpdate(lobby.code);
}

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.turnsTakenThisRound = 0;
    lobby.knockedBy = null;
    lobby.gameState = 'playing';
    lobby.phaseMessage = "New hand dealt! Draw and discard.";
    lobby.tiedParticipantsList = [];

    lobby.players.forEach(p => {
        p.cards = [];
        p.ready = false;
        p.nextHandReady = false;
        if (!p.eliminated) {
            p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        }
    });

    let initialCard = lobby.deck.pop();
    lobby.discardPile.push(initialCard);
    lobby.initialDealCard = initialCard;

    lobby.fedCardReminders = {};
    let dealerName = lobby.players[lobby.dealerIndex]?.username;
    if (dealerName) {
        let targetIdx = (lobby.dealerIndex + 1) % lobby.players.length;
        while (lobby.players[targetIdx].eliminated) {
            targetIdx = (targetIdx + 1) % lobby.players.length;
        }
        lobby.fedCardReminders[dealerName] = {
            target: lobby.players[targetIdx]?.username,
            card: initialCard
        };
    }

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }

    let currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
        setTimeout(() => runBotTurn(lobby, currentPlayer), 1100);
    }
}

wss.on('connection', (ws) => {
    let currentCode = null;
    let currentUser = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        if (data.type === 'REFRESH_LOBBIES') {
            broadcastLobbyList();
        } else if (data.type === 'CREATE_LOBBY') {
            const code = Math.random().toString(36).substring(2, 7).toUpperCase();
            currentUser = (data.username || 'Player1').trim();
            currentCode = code;

            lobbies[code] = {
                code,
                name: (data.lobbyName || 'Table').trim(),
                host: currentUser,
                isPrivate: !!data.isPrivate,
                gameState: 'lobby',
                players: [{
                    id: ws,
                    username: currentUser,
                    seat: 0,
                    lives: 3,
                    wager: 5,
                    cards: [],
                    eliminated: false,
                    ready: false,
                    nextHandReady: false,
                    isBot: false,
                    inVC: true,
                    isMuted: true,
                    peekIncoming: {}
                }],
                spectators: [],
                deck: [],
                discardPile: [],
                initialDealCard: null,
                lastDiscardPickup: null,
                turnIndex: 0,
                dealerIndex: 0,
                turnsTakenThisRound: 0,
                knockedBy: null,
                phaseMessage: "Waiting for players to ready up.",
                drawPool: [],
                drawResults: {},
                tiedParticipantsList: [],
                activeBets: [],
                pendingBets: [],
                globalProposals: [],
                sideBetLedger: {},
                mainGameLedger: {},
                botBetLedger: {},
                fedCardReminders: {},
                tokenCache: {},
                playlist: [],
                currentSongIndex: 0,
                isPlaying: false
            };

            const token = await generateLiveKitToken(currentUser, code);
            lobbies[code].tokenCache[currentUser] = token;

            ws.send(JSON.stringify({
                type: 'LOBBY_JOINED',
                lobby: getSanitizedLobby(lobbies[code], ws),
                livekitHost: LIVEKIT_HOST,
                livekitToken: token
            }));
            broadcastLobbyList();
        } else if (data.type === 'JOIN_LOBBY') {
            const code = (data.code || '').toUpperCase();
            currentUser = (data.username || 'Player').trim();
            currentCode = code;

            let lobby = lobbies[code];
            if (!lobby) {
                ws.send(JSON.stringify({ type: 'ERROR', message: "Lobby not found." }));
                return;
            }

            let existingPlayer = lobby.players.find(p => p.username.toLowerCase() === currentUser.toLowerCase());
            if (existingPlayer) {
                existingPlayer.id = ws;
            } else if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                lobby.players.push({
                    id: ws,
                    username: currentUser,
                    seat: findOpenSeat(lobby),
                    lives: 3,
                    wager: 5,
                    cards: [],
                    eliminated: false,
                    ready: false,
                    nextHandReady: false,
                    isBot: false,
                    inVC: true,
                    isMuted: true,
                    peekIncoming: {}
                });
            } else {
                lobby.spectators.push({ idSocket: ws, username: currentUser, peekingAt: null, inVC: true, isMuted: true });
            }

            let token = lobby.tokenCache[currentUser] || await generateLiveKitToken(currentUser, code);
            lobby.tokenCache[currentUser] = token;

            ws.send(JSON.stringify({
                type: 'LOBBY_JOINED',
                lobby: getSanitizedLobby(lobby, ws),
                livekitHost: LIVEKIT_HOST,
                livekitToken: token
            }));
            broadcastLobbyUpdate(code);
            broadcastLobbyList();
        } else if (data.type === 'SET_READY') {
            let lobby = lobbies[currentCode];
            if (!lobby) return;
            let player = lobby.players.find(p => p.username === currentUser);
            if (player) {
                player.ready = !!data.ready;
                let active = lobby.players.filter(p => !p.eliminated);
                if (active.length >= 2 && active.every(p => p.ready)) {
                    startRound(lobby);
                }
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'NEXT_HAND_READY') {
            let lobby = lobbies[currentCode];
            if (!lobby) return;
            let player = lobby.players.find(p => p.username === currentUser);
            if (player) {
                player.nextHandReady = true;
                let active = lobby.players.filter(p => !p.eliminated);
                if (active.every(p => p.nextHandReady)) {
                    startRound(lobby);
                }
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'DRAW_DECK') {
            let lobby = lobbies[currentCode];
            if (!lobby || lobby.gameState === 'lobby') return;
            let player = lobby.players[lobby.turnIndex];
            if (player && player.username === currentUser && player.cards.length === 3 && lobby.deck.length > 0) {
                player.cards.push(lobby.deck.pop());
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'DRAW_DISCARD') {
            let lobby = lobbies[currentCode];
            if (!lobby || lobby.gameState === 'lobby') return;
            let player = lobby.players[lobby.turnIndex];
            if (player && player.username === currentUser && player.cards.length === 3 && lobby.discardPile.length > 0) {
                let card = lobby.discardPile.pop();
                player.cards.push(card);
                lobby.lastDiscardPickup = { username: currentUser, card };
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'DISCARD_CARD') {
            let lobby = lobbies[currentCode];
            if (!lobby || lobby.gameState === 'lobby') return;
            let player = lobby.players[lobby.turnIndex];
            if (player && player.username === currentUser && player.cards.length === 4) {
                let cardIdx = data.cardIndex;
                if (cardIdx >= 0 && cardIdx < player.cards.length) {
                    let discarded = player.cards.splice(cardIdx, 1)[0];
                    lobby.discardPile.push(discarded);

                    let nextIdx = (lobby.turnIndex + 1) % lobby.players.length;
                    while (lobby.players[nextIdx].eliminated) {
                        nextIdx = (nextIdx + 1) % lobby.players.length;
                    }
                    lobby.fedCardReminders[currentUser] = {
                        target: lobby.players[nextIdx].username,
                        card: discarded
                    };

                    advanceTurn(lobby);
                    broadcastLobbyUpdate(currentCode);
                }
            }
        } else if (data.type === 'KNOCK') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.players[lobby.turnIndex]?.username === currentUser) {
                handleKnock(lobby, currentUser);
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'CHOOSE_POOL_CARD') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.gameState === 'tieBreaker') {
                let slot = lobby.drawPool.find(s => s.index === data.cardIndex);
                if (slot && !slot.chosenBy) {
                    slot.chosenBy = currentUser;
                    lobby.drawResults[currentUser] = lobby.deck.pop() || { suit: '♠', val: 'A', points: 11 };
                    checkTieBreakerDone(lobby);
                    broadcastLobbyUpdate(currentCode);
                }
            }
        } else if (data.type === 'ADD_BOT') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.players.length < 6 && lobby.gameState === 'lobby') {
                let botNum = lobby.players.filter(p => p.isBot).length + 1;
                lobby.players.push({
                    id: null,
                    username: `Bot ${botNum}`,
                    seat: findOpenSeat(lobby),
                    lives: 3,
                    wager: 5,
                    cards: [],
                    eliminated: false,
                    ready: true,
                    nextHandReady: false,
                    isBot: true,
                    inVC: false,
                    isMuted: true,
                    peekIncoming: {}
                });
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'REMOVE_BOT') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.gameState === 'lobby') {
                let botIdx = lobby.players.map(p => p.isBot).lastIndexOf(true);
                if (botIdx !== -1) {
                    lobby.players.splice(botIdx, 1);
                    broadcastLobbyUpdate(currentCode);
                }
            }
        } else if (data.type === 'UPDATE_WAGER') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.gameState === 'lobby') {
                lobby.players.forEach(p => p.wager = Number(data.wager) || 5);
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'UPDATE_SETTINGS') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.gameState === 'lobby') {
                lobby.players.forEach(p => p.lives = Number(data.lives) || 3);
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'PROPOSE_ELIMINATION_BET') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let targetPlayer = lobby.players.find(p => p.username === data.target);
                if (targetPlayer?.isBot) {
                    // Bot auto-accepts side bets
                    if (!lobby.botBetLedger[currentUser]) lobby.botBetLedger[currentUser] = {};
                    lobby.botBetLedger[currentUser][data.target] = (lobby.botBetLedger[currentUser][data.target] || 0) + (Number(data.wagerAmt) || 5);
                } else {
                    lobby.pendingBets.push({
                        id: Math.random().toString(36).substring(2, 9),
                        proposer: currentUser,
                        target: data.target,
                        wagerAmt: Number(data.wagerAmt) || 5,
                        type: 'eliminate',
                        pickUser: data.target
                    });
                }
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'RESPOND_BET') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let betIdx = lobby.pendingBets.findIndex(b => b.id === data.betId);
                if (betIdx !== -1) {
                    let bet = lobby.pendingBets.splice(betIdx, 1)[0];
                    if (data.accept) {
                        lobby.activeBets.push(bet);
                        if (!lobby.sideBetLedger[bet.proposer]) lobby.sideBetLedger[bet.proposer] = {};
                        lobby.sideBetLedger[bet.proposer][bet.target] = (lobby.sideBetLedger[bet.proposer][bet.target] || 0) + bet.wagerAmt;
                    }
                    broadcastLobbyUpdate(currentCode);
                }
            }
        } else if (data.type === 'CLEAR_DEBT') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let target = data.targetUser;
                let category = data.category;
                let targetLedger = category === 'side' ? lobby.sideBetLedger : (category === 'main' ? lobby.mainGameLedger : lobby.botBetLedger);
                if (targetLedger[target] && targetLedger[target][currentUser] !== undefined) delete targetLedger[target][currentUser];
                if (targetLedger[currentUser] && targetLedger[currentUser][target] !== undefined) delete targetLedger[currentUser][target];
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'REQUEST_PEEK') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let targetPlayer = lobby.players.find(p => p.username === data.targetUsername);
                if (targetPlayer) {
                    if (!targetPlayer.peekIncoming) targetPlayer.peekIncoming = {};
                    targetPlayer.peekIncoming[currentUser] = true;
                    broadcastLobbyUpdate(currentCode);
                }
            }
        } else if (data.type === 'RESPOND_PEEK') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let player = lobby.players.find(p => p.username === currentUser);
                if (player && player.peekIncoming) delete player.peekIncoming[data.spectatorUsername];
                let spec = lobby.spectators.find(s => s.username === data.spectatorUsername);
                if (spec) spec.peekingAt = data.allow ? currentUser : null;
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'STOP_PEEK') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let spec = lobby.spectators.find(s => s.username === currentUser);
                if (spec) spec.peekingAt = null;
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'ADD_PLAYLIST_SONG') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                lobby.playlist.push({ title: data.title, url: data.url });
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'CONTROL_MUSIC') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                if (data.action === 'PLAY') lobby.isPlaying = true;
                else if (data.action === 'PAUSE') lobby.isPlaying = false;
                else if (data.action === 'SKIP') lobby.currentSongIndex = (lobby.currentSongIndex + 1) % (lobby.playlist.length || 1);
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'UPDATE_VC_STATUS') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let p = lobby.players.find(x => x.username === currentUser);
                if (p) { p.inVC = data.inVC; p.isMuted = data.isMuted; }
                let s = lobby.spectators.find(x => x.username === currentUser);
                if (s) { s.inVC = data.inVC; s.isMuted = data.isMuted; }
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'CHAT_MESSAGE') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                let chatMsg = JSON.stringify({ type: 'CHAT_MESSAGE', username: currentUser, message: data.message });
                lobby.players.forEach(p => p.id?.send(chatMsg));
                lobby.spectators.forEach(s => s.idSocket?.send(chatMsg));
            }
        } else if (data.type === 'LEAVE_LOBBY') {
            let lobby = lobbies[currentCode];
            if (lobby) {
                lobby.players = lobby.players.filter(p => p.username !== currentUser);
                lobby.spectators = lobby.spectators.filter(s => s.username !== currentUser);
                if (lobby.players.length === 0) {
                    delete lobbies[currentCode];
                } else {
                    broadcastLobbyUpdate(currentCode);
                }
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                broadcastLobbyList();
            }
        }
    });

    ws.on('close', () => {
        if (currentCode && lobbies[currentCode]) {
            let lobby = lobbies[currentCode];
            let player = lobby.players.find(p => p.id === ws);
            if (player) player.id = null; // Preserve seat so mobile tab changes don't kick player
            lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);
        }
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`31! Multiplayer Server online on port ${PORT}`);
});