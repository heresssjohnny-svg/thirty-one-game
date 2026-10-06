const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const LIVEKIT_API_KEY = 'thirtyone-chat';
const LIVEKIT_API_SECRET = '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e';
const LIVEKIT_HOST = 'ws://135.181.43.233:7880';

async function generateLiveKitToken(roomName, participantName) {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: participantName });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    return await at.toJwt();
}

app.use(express.static(path.join(__dirname)));
if (fs.existsSync(path.join(__dirname, 'www'))) {
    app.use(express.static(path.join(__dirname, 'www')));
}

app.get('*', (req, res) => {
    const candidates = [
        path.join(__dirname, 'index.html'),
        path.join(__dirname, 'www', 'index.html')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return res.sendFile(p);
    }
    res.status(404).send('index.html not found.');
});

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

const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const BOT_NAMES = ['Liam', 'Emma', 'Noah', 'Olivia', 'Ethan', 'Sophia', 'Marcus', 'Ava', 'Lucas', 'Chloe', 'Jackson', 'Mia', 'Leo', 'Harper', 'Aiden', 'Ella'];

function createDeck() {
    let deck = [];
    for (let s of SUITS) {
        for (let v of VALUES) {
            let points = 10;
            let drawVal = parseInt(v, 10) || (v === 'A' ? 14 : (v === 'K' ? 13 : (v === 'Q' ? 12 : 11)));
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
    return 0;
}

function touchLobbyActivity(lobby) {
    if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
    lobby.inactivityTimer = setTimeout(() => closeInactiveLobby(lobby.code), 20 * 60 * 1000);
}

function closeInactiveLobby(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let closePayload = JSON.stringify({ type: 'ERROR', message: 'Lobby closed due to inactivity.' });
    lobby.players.forEach(p => {
        if (p.id && typeof p.id === 'object' && p.id.readyState === WebSocket.OPEN) {
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
    delete lobbies[code];
    broadcastLobbyList();
}

function getPublicLobbiesList() {
    return Object.values(lobbies).filter(l => !l.isPrivate).map(l => ({
        code: l.code,
        name: l.name,
        host: l.host,
        count: l.players.length,
        state: l.gameState
    }));
}

function broadcastLobbyList() {
    let list = getPublicLobbiesList();
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: list }));
    });
}

async function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;

    for (let p of lobby.players) {
        if (p.id && typeof p.id === 'object' && p.id.readyState === WebSocket.OPEN) {
            let data = await getSanitizedLobby(lobby, p.id);
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            p.id.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    }
    for (let s of lobby.spectators) {
        if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) {
            let data = await getSanitizedLobby(lobby, s.idSocket);
            s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            s.idSocket.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    }
}

async function getSanitizedLobby(lobby, wsId) {
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
    sortedParticipants.forEach((p, i) => { p.seat = i; });

    let myUnrespondedBets = (lobby.pendingBets || []).filter(b => b.target === myUsername && !b.delivered?.[myUsername]);
    myUnrespondedBets.forEach(b => {
        if (!b.delivered) b.delivered = {};
        b.delivered[myUsername] = true;
    });

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

    let token = null;
    if (myUsername) {
        try {
            token = await generateLiveKitToken(lobby.code, myUsername);
        } catch (e) {
            console.error('LiveKit Token error:', e);
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
        botBetLedger: lobby.botBetLedger || {},
        pendingBetsForMe: myUnrespondedBets,
        globalProposals: lobby.globalProposals || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: activeParts.length,
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
        currentSongElapsedSeconds: elapsedSeconds,
        livekitToken: token,
        livekitHost: LIVEKIT_HOST,
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
                isBot: !!p.isBot,
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
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.players.forEach(p => {
        if (!p.eliminated) p.nextHandReady = p.isBot;
    });
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
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

    let activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1) {
        awardTournamentWinner(lobby, activeParts[0]);
        return;
    }

    activeParts.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.nextHandReady = p.isBot;
    });

    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = { val: firstDiscard.val, suit: firstDiscard.suit };
    lobby.lastDiscardDonor = lobby.players[lobby.dealerIndex]?.username || null;

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }

    lobby.phaseMessage = `Round started! Turn: ${lobby.players[lobby.turnIndex].username}`;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function advanceDealerToNextActive(lobby) {
    let nextDealer = (lobby.dealerIndex + 1) % lobby.players.length;
    let safety = 0;
    while (lobby.players[nextDealer].eliminated && safety < lobby.players.length) {
        nextDealer = (nextDealer + 1) % lobby.players.length;
        safety++;
    }
    lobby.dealerIndex = nextDealer;
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
            setTimeout(() => {
                if (lobbies[lobby.code]) startRound(lobbies[lobby.code]);
            }, 3000);
        } else if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.every(u => lobby.drawResults[u])) {
            let entries = lobby.tiedParticipantsList.map(u => ({ username: u, card: lobby.drawResults[u] })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            let loser = lobby.players.find(p => p.username === entries[0].username);
            if (loser) {
                loser.lives = Math.max(0, loser.lives - 1);
                if (loser.lives <= 0 && !loser.eliminated) {
                    loser.eliminated = true;
                    resolveFirstToLoseBets(lobby, loser.username);
                    if (typeof loser.id === 'object') {
                        lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
                    }
                }
            }
            lobby.phaseMessage = `${entries[0].username} drew lowest in tie-breaker!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => {
                if (!lobbies[lobby.code]) return;
                let cur = lobbies[lobby.code];
                if (getActiveParticipants(cur).length === 1) {
                    awardTournamentWinner(cur, getActiveParticipants(cur)[0]);
                } else {
                    advanceDealerToNextActive(cur);
                    triggerRoundOver(cur, `${entries[0].username} lost a life in tie-breaker!`);
                }
            }, 3000);
        } else {
            scheduleBotActions(lobby);
        }
    }
}

function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the deck.`;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        let card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up ${card.val}${card.suit} from the discard pile!`;

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
                if (p.lives <= 0) {
                    p.eliminated = true;
                    resolveFirstToLoseBets(lobby, p.username);
                    if (typeof p.id === 'object') {
                        lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                    }
                }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points!`);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleDiscardAction(lobby, wsId, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.cards.length !== 4) return;

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
        scheduleBotActions(lobby);
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
                if (p.lives <= 0) {
                    p.eliminated = true;
                    resolveFirstToLoseBets(lobby, p.username);
                    if (typeof p.id === 'object') {
                        lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                    }
                }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points!`);
    } else {
        advanceTurnOrResolve(lobby);
    }
}

function handleKnock(lobby, wsId) {
    if (lobby.gameState !== 'playing') return;
    let p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== wsId || lobby.knockedBy) return;
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
    scheduleBotActions(lobby);
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
    scheduleBotActions(lobby);
}

function resolveRoundEnd(lobby) {
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    let lowest = scores[0].s;
    let tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1) {
        if (active.length === 2) {
            triggerRoundOver(lobby, `Round tied at ${lowest} pts. No one loses a life!`);
        } else {
            lobby.tiedParticipantsList = tied.map(t => t.p.username);
            let deck = createDeck();
            lobby.drawPool = deck.map(c => ({ card: c, chosenBy: null }));
            lobby.drawResults = {};
            lobby.drawOrderSequence = [];
            lobby.gameState = 'tieBreaker';
            lobby.phaseMessage = `Tie for lowest score (${lowest} pts)! Draw to resolve.`;
            broadcastLobbyUpdate(lobby.code);
            scheduleBotActions(lobby);
        }
    } else {
        let loser = scores[0].p;
        let winner = scores[scores.length - 1].p;
        loser.lives = Math.max(0, loser.lives - 1);

        if (loser.lives <= 0 && !loser.eliminated) {
            loser.eliminated = true;
            resolveFirstToLoseBets(lobby, loser.username);
            if (typeof loser.id === 'object') {
                lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
            }
        }

        resolveWinSideBets(lobby, winner.username);

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
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    lobby.players.forEach(p => {
        p.nextHandReady = p.isBot;
    });
    broadcastLobbyUpdate(lobby.code);
}

function recordDebt(ledger, debtor, creditor, amount) {
    if (!ledger[debtor]) ledger[debtor] = {};
    ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + amount;
}

function resolveFirstToLoseBets(lobby, loserUsername) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    lobby.activeBets = lobby.activeBets.filter(b => {
        if (b.type === 'eliminate' && b.pickUser === loserUsername) {
            let isBotInvolved = b.isBotBet || lobby.players.some(p => p.isBot && (p.username === b.target || p.username === b.proposer));
            let targetLedger = isBotInvolved ? (lobby.botBetLedger = lobby.botBetLedger || {}) : (lobby.sideBetLedger = lobby.sideBetLedger || {});
            recordDebt(targetLedger, b.target, b.proposer, b.wagerAmt);
            lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${b.proposer} won $${b.wagerAmt} from ${b.target}!`;
            return false;
        }
        return true;
    });
}

function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    lobby.activeBets = lobby.activeBets.filter(b => {
        if (b.type === 'win') {
            let isBotInvolved = b.isBotBet || lobby.players.some(p => p.isBot && (p.username === b.target || p.username === b.proposer));
            let targetLedger = isBotInvolved ? (lobby.botBetLedger = lobby.botBetLedger || {}) : (lobby.sideBetLedger = lobby.sideBetLedger || {});
            if (b.pickUser === winnerUsername) {
                recordDebt(targetLedger, b.target, b.proposer, b.wagerAmt);
                lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${b.proposer} won $${b.wagerAmt} from ${b.target}!`;
                return false;
            } else {
                recordDebt(targetLedger, b.proposer, b.target, b.wagerAmt);
                lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${b.target} won $${b.wagerAmt} from ${b.proposer}!`;
                return false;
            }
        }
        return true;
    });
}

function awardTournamentWinner(lobby, winner) {
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    lobby.players.forEach(p => {
        if (p.username !== winner.username) {
            let amt = p.wager || 5;
            let isBotInvolved = p.isBot || winner.isBot;
            let targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.mainGameLedger;
            recordDebt(targetLedger, p.username, winner.username, amt);
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

    lobby.players.forEach((p, idx) => {
        p.lives = lobby.defaultLives || 2;
        p.eliminated = false;
        p.cards = [];
        p.ready = p.isBot;
        p.seat = idx;
        p.nextHandReady = p.isBot;
        p.peekRequests = {};
        p.peekAllowed = {};
    });
    lobby.spectators = [];
    broadcastLobbyUpdate(lobby.code);
    broadcastLobbyList();
}

function scheduleBotActions(lobby) {
    if (!lobby) return;

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        lobby.players.forEach(p => {
            if (p.isBot && !p.eliminated) {
                let needsPick = false;
                if (lobby.gameState === 'dealerDraw' && !lobby.drawResults[p.username]) needsPick = true;
                if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.includes(p.username) && !lobby.drawResults[p.username]) needsPick = true;

                if (needsPick) {
                    setTimeout(() => {
                        let cur = lobbies[lobby.code];
                        if (!cur || (cur.gameState !== 'dealerDraw' && cur.gameState !== 'tieBreaker')) return;
                        let unchosen = cur.drawPool.map((c, i) => ({ i, chosen: c.chosenBy })).filter(c => c.chosen === null);
                        if (unchosen.length > 0) {
                            let chosenIndex = unchosen[Math.floor(Math.random() * unchosen.length)].i;
                            handlePoolCardSelection(cur, p.username, chosenIndex);
                        }
                    }, 500 + Math.random() * 600);
                }
            }
        });
        return;
    }

    if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
        let cur = lobby.players[lobby.turnIndex];
        if (!cur || !cur.isBot || cur.eliminated) return;

        setTimeout(() => {
            let curLobby = lobbies[lobby.code];
            if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
            let bot = curLobby.players[curLobby.turnIndex];
            if (!bot || bot.id !== cur.id) return;

            executeBotTurn(curLobby, bot);
        }, 700 + Math.random() * 500);
    }
}

function executeBotTurn(lobby, bot) {
    let active = getActiveParticipants(lobby);
    let curScore = calculateScore(bot.cards);
    let minKnockReq = active.length > 2 ? 21 : 25;
    let canKnock = lobby.gameState === 'playing' && !lobby.knockedBy && (lobby.turnsTakenThisRound >= active.length) && (curScore >= minKnockReq);

    if (canKnock) {
        let knockThreshold = curScore >= 28 ? 0.95 : (curScore >= 26 ? 0.80 : 0.35);
        if (Math.random() < knockThreshold) {
            handleKnock(lobby, bot.id);
            return;
        }
    }

    let topDiscard = lobby.discardPile[lobby.discardPile.length - 1];
    let shouldDrawDiscard = false;

    if (topDiscard) {
        let scoreWithDiscard = calculateBestFourCardScore([...bot.cards, topDiscard]);
        if (scoreWithDiscard > curScore) {
            shouldDrawDiscard = true;
        } else if (scoreWithDiscard === curScore && topDiscard.points >= 10) {
            let primarySuit = getPrimarySuit(bot.cards);
            if (topDiscard.suit === primarySuit) {
                shouldDrawDiscard = Math.random() < 0.65;
            }
        }
    }

    handleTurnAction(lobby, bot.id, shouldDrawDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK');

    if (lobby.gameState === 'roundOver') return;

    setTimeout(() => {
        let curLobby = lobbies[lobby.code];
        if (!curLobby) return;
        let activeBot = curLobby.players[curLobby.turnIndex];
        if (!activeBot || activeBot.id !== bot.id || activeBot.cards.length !== 4) return;

        let bestDiscardIdx = -1;
        let maxRetainedScore = -1;
        let lowestPointVal = 999;

        for (let i = 0; i < 4; i++) {
            let testHand = activeBot.cards.filter((_, idx) => idx !== i);
            let score = calculateScore(testHand);
            let cardPoint = activeBot.cards[i].points;

            if (score > maxRetainedScore || (score === maxRetainedScore && cardPoint < lowestPointVal)) {
                maxRetainedScore = score;
                lowestPointVal = cardPoint;
                bestDiscardIdx = i;
            }
        }

        handleDiscardAction(curLobby, activeBot.id, bestDiscardIdx !== -1 ? bestDiscardIdx : 0);
    }, 600 + Math.random() * 400);
}

function getPrimarySuit(cards) {
    let suitCounts = {};
    cards.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1; });
    let best = cards[0]?.suit || '♠';
    let max = 0;
    for (let s in suitCounts) {
        if (suitCounts[s] > max) {
            max = suitCounts[s];
            best = s;
        }
    }
    return best;
}

function leaveLobby(ws, code) {
    if (!lobbies[code]) return;
    let lobby = lobbies[code];
    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);
    if (lobby.players.length === 0) {
        delete lobbies[code];
    } else {
        broadcastLobbyUpdate(code);
    }
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
                        name: data.lobbyName || `${currentUsername}'s Table`,
                        host: currentUsername,
                        isPrivate: !!data.isPrivate,
                        players: [{ id: ws, username: currentUsername, lives: 2, wager: 5, cards: [], ready: false, seat: 0, nextHandReady: false, eliminated: false, isBot: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} }],
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
                        botBetLedger: {},
                        pendingBets: [],
                        activeBets: [],
                        globalProposals: [],
                        knockedBy: null,
                        finalTurnsRemaining: 0,
                        turnsTakenThisRound: 0,
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
                    broadcastLobbyUpdate(currentLobbyCode);
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
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        let existingSpec = lobby.spectators.find(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                        if (existingSpec) {
                            existingSpec.idSocket = ws;
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat: availableSeat, nextHandReady: false, eliminated: false, isBot: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} });
                        } else {
                            lobby.spectators.push({ username: currentUsername, idSocket: ws, inVC: true, isMuted: true });
                        }

                        broadcastLobbyUpdate(code);
                        broadcastLobbyList();
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                    }
                    break;
                }

                case 'ADD_BOT': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.players.length < 6) {
                            let availableNames = BOT_NAMES.filter(n => !lobby.players.some(p => p.username.startsWith(n)));
                            let chosen = (availableNames[Math.floor(Math.random() * availableNames.length)] || ('Bot' + (lobby.players.length + 1))) + ' (B)';
                            let botPlayer = {
                                id: 'bot_' + Math.random().toString(36).substring(2, 9),
                                username: chosen,
                                isBot: true,
                                lives: lobby.defaultLives || 2,
                                wager: lobby.defaultWager || 5,
                                cards: [],
                                ready: true,
                                seat: findOpenSeat(lobby),
                                nextHandReady: true,
                                eliminated: false,
                                inVC: false,
                                isMuted: true,
                                peekRequests: {},
                                peekAllowed: {}
                            };
                            lobby.players.push(botPlayer);
                            lobby.phaseMessage = `🤖 ${chosen} joined the table.`;
                            broadcastLobbyUpdate(currentLobbyCode);

                            if (lobby.players.length >= 2 && lobby.players.every(p => p.ready)) {
                                startDealerDrawPhase(lobby);
                            }
                        }
                    }
                    break;
                }

                case 'REMOVE_BOT': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let botIdx = -1;
                        for (let i = lobby.players.length - 1; i >= 0; i--) {
                            if (lobby.players[i].isBot) {
                                botIdx = i;
                                break;
                            }
                        }
                        if (botIdx !== -1) {
                            let removed = lobby.players.splice(botIdx, 1)[0];
                            lobby.phaseMessage = `🤖 ${removed.username} was removed.`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
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
                            lobby.players.push({ id: ws, username: spec.username, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat, nextHandReady: false, eliminated: false, isBot: false, inVC: spec.inVC, isMuted: spec.isMuted, peekRequests: {}, peekAllowed: {} });
                            broadcastLobbyUpdate(currentLobbyCode);
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
                                lobby.defaultLives = l;
                                lobby.players.forEach(p => { p.lives = Math.max(0, l); });
                            }
                            if (data.wager) {
                                lobby.defaultWager = parseInt(data.wager, 10);
                                lobby.players.forEach(p => { p.wager = lobby.defaultWager; });
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
                        let targetLedger = category === 'main' ? lobby.mainGameLedger : (category === 'bot' ? lobby.botBetLedger : lobby.sideBetLedger);

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

                case 'PROPOSE_BET': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let targetPlayer = lobby.players.find(p => p.username === data.target);
                        if (targetPlayer && targetPlayer.isBot) {
                            let betObj = {
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                target: targetPlayer.username,
                                type: data.betType,
                                pickUser: data.pickUser,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                isBotBet: true
                            };
                            lobby.activeBets.push(betObj);
                            lobby.phaseMessage = `🤝 Bot Bet Accepted! ${targetPlayer.username} accepted ${currentUsername}'s $${betObj.wagerAmt} bet!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        } else if (targetPlayer) {
                            lobby.pendingBets.push({
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                target: targetPlayer.username,
                                type: data.betType,
                                pickUser: data.pickUser,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                delivered: {}
                            });
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'PROPOSE_ELIMINATION_BET': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let targetPlayer = lobby.players.find(p => p.username === data.target);
                        if (targetPlayer && targetPlayer.isBot) {
                            lobby.activeBets.push({
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                target: targetPlayer.username,
                                pickUser: data.target,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                type: 'eliminate',
                                isBotBet: true
                            });
                            lobby.phaseMessage = `🤝 Bot Bet Accepted! ${targetPlayer.username} accepted elimination bet!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        } else {
                            lobby.pendingBets.push({
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                target: data.target,
                                pickUser: data.target,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                type: 'eliminate',
                                delivered: {}
                            });
                            lobby.phaseMessage = `🤝 Elimination Bet proposed by ${currentUsername} to ${data.target}!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'PROPOSE_GLOBAL_SIDE_BET': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        lobby.globalProposals.push({
                            id: Math.random().toString(36).substring(2, 8),
                            proposer: currentUsername,
                            pickUser: data.pickUser,
                            wagerAmt: parseFloat(data.wagerAmt) || 5,
                            acceptedBy: []
                        });
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                    break;
                }

                case 'ACCEPT_GLOBAL_PROPOSAL': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let prop = lobbies[currentLobbyCode].globalProposals.find(gp => gp.id === data.proposalId);
                        if (prop && !prop.acceptedBy.includes(currentUsername) && prop.proposer !== currentUsername) {
                            prop.acceptedBy.push(currentUsername);
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'CONFIRM_GLOBAL_BET': {
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
                }

                case 'RESPOND_BET': {
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
                }

                case 'SET_READY': {
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
                }

                case 'NEXT_HAND':
                case 'NEXT_HAND_READY': {
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

                case 'END_GAME_PROPOSAL': {
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
                }

                case 'REQUEST_PEEK': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let target = lobbies[currentLobbyCode].players.find(p => p.username.toLowerCase() === (data.targetUsername || '').toLowerCase());
                        if (target) {
                            if (!target.peekRequests) target.peekRequests = {};
                            target.peekRequests[currentUsername] = true;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;
                }

                case 'RESPOND_PEEK': {
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
                }

                case 'STOP_PEEK': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        touchLobbyActivity(lobby);
                        lobby.players.forEach(pl => {
                            if (pl.peekAllowed) delete pl.peekAllowed[currentUsername];
                        });
                        broadcastLobbyUpdate(currentLobbyCode);
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

                case 'CHAT_MESSAGE': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let chatPayload = { type: 'CHAT_MESSAGE', username: currentUsername, message: data.message };
                        lobbies[currentLobbyCode].players.forEach(p => {
                            if (p.id && typeof p.id === 'object' && p.id.readyState === WebSocket.OPEN) p.id.send(JSON.stringify(chatPayload));
                        });
                        lobbies[currentLobbyCode].spectators.forEach(s => {
                            if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) s.idSocket.send(JSON.stringify(chatPayload));
                        });
                    }
                    break;
                }

                case 'DRAW_DECK':
                case 'DRAW_DISCARD': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        handleTurnAction(lobbies[currentLobbyCode], ws, data.type);
                    }
                    break;
                }

                case 'DISCARD_CARD': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        handleDiscardAction(lobbies[currentLobbyCode], ws, data.cardIndex);
                    }
                    break;
                }

                case 'KNOCK': {
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        handleKnock(lobbies[currentLobbyCode], ws);
                    }
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
            console.error('Action error:', err);
        }
    });

    ws.on('close', () => {
        if (currentLobbyCode && lobbies[currentLobbyCode]) {
            leaveLobby(ws, currentLobbyCode);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`31! Card Game server running on port ${PORT}`);
});