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

// Serve Static Assets Dynamically
const wwwPath = path.join(__dirname, 'www');
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(wwwPath)) {
    app.use(express.static(wwwPath));
} else if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
} else {
    app.use(express.static(__dirname));
}

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
const BOT_NAMES = ['Liam (B)', 'Sophia (B)', 'Noah (B)', 'Emma (B)', 'Lucas (B)', 'Maya (B)', 'Ethan (B)', 'Olivia (B)'];

function getCardPoints(val) {
    if (val === 'A') return 11;
    if (['K', 'Q', 'J', '10'].includes(val)) return 10;
    return parseInt(val, 10);
}

function getCardDrawVal(val) {
    if (val === 'A') return 14;
    if (val === 'K') return 13;
    if (val === 'Q') return 12;
    if (val === 'J') return 11;
    return parseInt(val, 10);
}

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let val of VALUES) {
            deck.push({ suit, val, points: getCardPoints(val), drawVal: getCardDrawVal(val) });
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

const lobbies = {};

async function generateLiveKitToken(username, roomName) {
    try {
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: username, name: username, ttl: '8h' });
        at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
        return await at.toJwt();
    } catch (e) {
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
    const list = Object.values(lobbies).filter(l => !l.isPrivate).map(l => ({
        code: l.code, name: l.name, host: l.host, count: l.players.length, state: l.gameState
    }));
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: list }));
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
        deckCount: lobby.deck ? lobby.deck.length : 0,
        discardTop: lobby.discardPile ? lobby.discardPile[lobby.discardPile.length - 1] || null : null,
        discardCount: lobby.discardPile ? lobby.discardPile.length : 0,
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

function startDealerDrawPhase(lobby) {
    let deck = createDeck();
    lobby.drawPool = deck.map((c, idx) => ({ card: c, chosenBy: null, index: idx }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;
    lobby.initialDealCard = null;
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};

    lobby.players.forEach(p => {
        if (!p.eliminated) p.nextHandReady = false;
        p.peekIncoming = {};
    });

    broadcastLobbyUpdate(lobby.code);

    let activeBots = lobby.players.filter(p => !p.eliminated && p.isBot);
    activeBots.forEach((bot, idx) => {
        setTimeout(() => {
            if (!lobbies[lobby.code] || lobbies[lobby.code].gameState !== 'dealerDraw') return;
            let cur = lobbies[lobby.code];
            let openSlot = cur.drawPool.find(s => !s.chosenBy);
            if (openSlot) handlePoolCardSelection(cur, bot.username, openSlot.index);
        }, 1000 * (idx + 1));
    });
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
        let entries = Object.entries(lobby.drawResults).map(([u, c]) => ({ username: u, card: c }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);

        let lowestDrawVal = entries[0].card.drawVal;
        let tiedLowest = entries.filter(e => e.card.drawVal === lowestDrawVal);

        if (tiedLowest.length > 1) {
            lobby.phaseMessage = `⚠️ Tie for lowest card (${entries[0].card.val}). Picking again!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => {
                if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'dealerDraw') {
                    startDealerDrawPhase(lobbies[lobby.code]);
                }
            }, 3500);
            return;
        }

        let dealerWinner = entries[0];
        lobby.dealerIndex = lobby.players.findIndex(p => p.username === dealerWinner.username);
        lobby.phaseMessage = `🎉 ${dealerWinner.username} drew lowest (${dealerWinner.card.val}${dealerWinner.card.suit}) and is Dealer!`;
        broadcastLobbyUpdate(lobby.code);

        setTimeout(() => {
            if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'dealerDraw') {
                startRound(lobbies[lobby.code]);
            }
        }, 3500);
    }
}

function checkTieBreakerComplete(lobby) {
    let tiedNames = lobby.tiedParticipantsList;
    let allTiedPicked = tiedNames.every(u => lobby.drawResults[u]);

    if (allTiedPicked) {
        let entries = tiedNames.map(u => ({ username: u, card: lobby.drawResults[u] }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);

        let lowestDrawVal = entries[0].card.drawVal;
        let tiedLowest = entries.filter(e => e.card.drawVal === lowestDrawVal);

        if (tiedLowest.length > 1) {
            lobby.phaseMessage = `⚠️ Tie on lowest card (${entries[0].card.val})! Drawing again in 3 seconds...`;
            broadcastLobbyUpdate(lobby.code);

            setTimeout(() => {
                if (!lobbies[lobby.code] || lobbies[lobby.code].gameState !== 'tieBreaker') return;
                let cur = lobbies[lobby.code];
                cur.tiedParticipantsList = tiedLowest.map(t => t.username);
                let freshDeck = createDeck();
                cur.drawPool = freshDeck.map((c, idx) => ({ card: c, chosenBy: null, index: idx }));
                cur.drawResults = {};
                cur.drawOrderSequence = [];
                cur.phaseMessage = `Tie-Breaker Re-Draw: Pick a card!`;
                broadcastLobbyUpdate(cur.code);

                cur.players.filter(p => cur.tiedParticipantsList.includes(p.username) && p.isBot).forEach((bot, bIdx) => {
                    setTimeout(() => {
                        let openSlot = cur.drawPool.find(s => !s.chosenBy);
                        if (openSlot) handlePoolCardSelection(cur, bot.username, openSlot.index);
                    }, 800 * (bIdx + 1));
                });
            }, 3000);
            return;
        }

        let loser = lobby.players.find(p => p.username === entries[0].username);
        if (loser) {
            loser.lives = Math.max(0, loser.lives - 1);
            if (loser.lives <= 0 && !loser.eliminated) {
                loser.eliminated = true;
                resolveFirstToLoseBets(lobby, loser.username);
                lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
            }
        }

        lobby.phaseMessage = `${entries[0].username} drew lowest in tie-breaker (${entries[0].card.val}${entries[0].card.suit}) and lost a life!`;
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
    }
}

function advanceDealerToNextActive(lobby) {
    let nextDealer = (lobby.dealerIndex + 1) % lobby.players.length;
    let safetyCounter = 0;
    while (lobby.players[nextDealer].eliminated && safetyCounter < lobby.players.length) {
        nextDealer = (nextDealer + 1) % lobby.players.length;
        safetyCounter++;
    }
    lobby.dealerIndex = nextDealer;
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
        p.nextHandReady = false;
        p.pickedUpDiscardCard = null;
    });

    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = { val: firstDiscard.val, suit: firstDiscard.suit };
    lobby.lastDiscardDonor = lobby.players[lobby.dealerIndex]?.username || null;

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }

    lobby.phaseMessage = "New hand dealt! Draw and discard.";
    broadcastLobbyUpdate(lobby.code);

    let currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
        setTimeout(() => runBotTurn(lobby, currentPlayer), 1100);
    }
}

function handleTurnAction(lobby, ws, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        let card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };

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
                    lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `⚡ BLITZ 31! ${currentPlayer.username} hit 31 points! All other players lost a life!`);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
}

function handleDiscardAction(lobby, ws, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.cards.length !== 4) return;

    let discarded = currentPlayer.cards[cardIndex];

    // Put-Back Discard Rule: Changed mind, returns exact card back to pile
    if (currentPlayer.pickedUpDiscardCard && discarded.val === currentPlayer.pickedUpDiscardCard.val && discarded.suit === currentPlayer.pickedUpDiscardCard.suit) {
        currentPlayer.cards.splice(cardIndex, 1);
        lobby.discardPile.push(discarded);
        currentPlayer.pickedUpDiscardCard = null;

        if (lobby.lastDiscardPickup?.username === currentPlayer.username && lobby.lastDiscardPickup.card.val === discarded.val && lobby.lastDiscardPickup.card.suit === discarded.suit) {
            lobby.lastDiscardPickup = null;
        }

        lobby.phaseMessage = `📢 ${currentPlayer.username} put the discard back. Must draw from deck!`;
        broadcastLobbyUpdate(lobby.code);
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
                    lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `⚡ BLITZ 31! ${currentPlayer.username} hit 31 points! All other players lost a life!`);
    } else {
        advanceTurnOrResolve(lobby);
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

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) next = (next + 1) % lobby.players.length;
    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);

    let currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
        setTimeout(() => runBotTurn(lobby, currentPlayer), 1100);
    }
}

function handleKnock(lobby, ws) {
    if (lobby.gameState !== 'playing') return;
    let p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== ws || lobby.knockedBy) return;
    let active = getActiveParticipants(lobby);
    if (lobby.turnsTakenThisRound < active.length) return;
    let threshold = active.length > 2 ? 21 : 25;
    if (calculateScore(p.cards) < threshold) return;

    lobby.gameState = 'finalTurn';
    lobby.knockedBy = p.username;
    lobby.finalTurnsRemaining = active.length - 1;
    lobby.phaseMessage = `🔔 KNOCK! ${p.username} knocked! 1 final turn each.`;

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) next = (next + 1) % lobby.players.length;
    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);

    let currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
        setTimeout(() => runBotTurn(lobby, currentPlayer), 1100);
    }
}

function runBotTurn(lobby, bot) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    if (lobby.players[lobby.turnIndex]?.username !== bot.username) return;

    let active = getActiveParticipants(lobby);
    let threshold = active.length > 2 ? 21 : 25;
    let currentScore = calculateScore(bot.cards);

    if (lobby.gameState === 'playing' && !lobby.knockedBy && lobby.turnsTakenThisRound >= active.length && currentScore >= 28) {
        handleKnock(lobby, bot.id);
        return;
    }

    let discardTop = lobby.discardPile[lobby.discardPile.length - 1];
    let shouldPickDiscard = false;
    if (discardTop) {
        let testCards = [...bot.cards, discardTop];
        if (calculateBestFourCardScore(testCards) > currentScore) shouldPickDiscard = true;
    }

    if (shouldPickDiscard && lobby.discardPile.length > 0) {
        let card = lobby.discardPile.pop();
        bot.cards.push(card);
        bot.pickedUpDiscardCard = { val: card.val, suit: card.suit };
        if (lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
            lobby.lastDiscardPickup = { username: bot.username, card: { val: card.val, suit: card.suit } };
        }
        if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== bot.username) {
            if (!lobby.fedCardReminders) lobby.fedCardReminders = {};
            lobby.fedCardReminders[lobby.lastDiscardDonor] = { target: bot.username, card: { val: card.val, suit: card.suit } };
        }
    } else if (lobby.deck.length > 0) {
        bot.cards.push(lobby.deck.pop());
        bot.pickedUpDiscardCard = null;
    }

    if (calculateBestFourCardScore(bot.cards) === 31) {
        lobby.players.forEach(p => {
            if (p !== bot && !p.eliminated) {
                p.lives = Math.max(0, p.lives - 1);
                if (p.lives <= 0) {
                    p.eliminated = true;
                    resolveFirstToLoseBets(lobby, p.username);
                    lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                }
            }
        });
        resolveWinSideBets(lobby, bot.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `⚡ BLITZ 31! ${bot.username} hit 31 points! All other players lost a life!`);
        return;
    }

    setTimeout(() => {
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
        bot.pickedUpDiscardCard = null;
        lobby.discardPile.push(discarded);

        if (lobby.fedCardReminders) {
            for (let donor in lobby.fedCardReminders) {
                if (lobby.fedCardReminders[donor].target === bot.username) {
                    let remCard = lobby.fedCardReminders[donor].card;
                    if (remCard.val === discarded.val && remCard.suit === discarded.suit) delete lobby.fedCardReminders[donor];
                }
            }
        }

        lobby.lastDiscardDonor = bot.username;
        if (lobby.lastDiscardPickup?.username === bot.username && lobby.lastDiscardPickup.card.val === discarded.val && lobby.lastDiscardPickup.card.suit === discarded.suit) {
            lobby.lastDiscardPickup = null;
        }

        lobby.turnsTakenThisRound++;
        if (calculateScore(bot.cards) === 31) {
            lobby.players.forEach(p => {
                if (p !== bot && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        resolveFirstToLoseBets(lobby, p.username);
                        lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                    }
                }
            });
            resolveWinSideBets(lobby, bot.username);
            advanceDealerToNextActive(lobby);
            triggerRoundOver(lobby, `⚡ BLITZ 31! ${bot.username} hit 31 points! All other players lost a life!`);
        } else {
            advanceTurnOrResolve(lobby);
        }
    }, 800);
}

function resolveRoundEnd(lobby) {
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    let lowest = scores[0].s;
    let tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1) {
        if (active.length === 2) {
            triggerRoundOver(lobby, `Round tied at ${lowest} pts. Heads-up tie — no one loses a life!`);
        } else {
            lobby.tiedParticipantsList = tied.map(t => t.p.username);
            let freshDeck = createDeck();
            lobby.drawPool = freshDeck.map((c, idx) => ({ card: c, chosenBy: null, index: idx }));
            lobby.drawResults = {};
            lobby.drawOrderSequence = [];
            lobby.gameState = 'tieBreaker';
            lobby.phaseMessage = `Tie for lowest score (${lowest})! Tied participants must draw a card.`;
            broadcastLobbyUpdate(lobby.code);

            lobby.players.filter(p => lobby.tiedParticipantsList.includes(p.username) && p.isBot).forEach((bot, bIdx) => {
                setTimeout(() => {
                    let openSlot = lobby.drawPool.find(s => !s.chosenBy);
                    if (openSlot) handlePoolCardSelection(lobby, bot.username, openSlot.index);
                }, 900 * (bIdx + 1));
            });
        }
    } else {
        let loser = scores[0].p;
        let winner = scores[scores.length - 1].p;
        loser.lives = Math.max(0, loser.lives - 1);

        if (loser.lives <= 0 && !loser.eliminated) {
            loser.eliminated = true;
            resolveFirstToLoseBets(lobby, loser.username);
            lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
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
    let active = getActiveParticipants(lobby);
    if (active.length === 1) {
        awardTournamentWinner(lobby, active[0]);
        return;
    }
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
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
            let targetLedger = (lobby.players.find(p => p.username === b.target)?.isBot || lobby.players.find(p => p.username === b.proposer)?.isBot)
                ? lobby.botBetLedger : lobby.sideBetLedger;
            recordDebt(targetLedger, b.target, b.proposer, b.wagerAmt);
            lobby.phaseMessage = `💰 ${b.proposer} won $${b.wagerAmt} side bet against ${b.target}!`;
            return false;
        }
        return true;
    });
}

function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    lobby.activeBets = lobby.activeBets.filter(b => {
        if (b.type === 'win') {
            let targetLedger = (lobby.players.find(p => p.username === b.target)?.isBot || lobby.players.find(p => p.username === b.proposer)?.isBot)
                ? lobby.botBetLedger : lobby.sideBetLedger;
            if (b.pickUser === winnerUsername) {
                recordDebt(targetLedger, b.target, b.proposer, b.wagerAmt);
                lobby.phaseMessage = `💰 ${b.proposer} won $${b.wagerAmt} side bet from ${b.target}!`;
            } else {
                recordDebt(targetLedger, b.proposer, b.target, b.wagerAmt);
                lobby.phaseMessage = `💰 ${b.target} won $${b.wagerAmt} side bet from ${b.proposer}!`;
            }
            return false;
        }
        return true;
    });
}

function awardTournamentWinner(lobby, winner) {
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    lobby.players.forEach(p => {
        if (p.username !== winner.username) {
            let amt = p.wager || 5;
            let targetLedger = p.isBot ? lobby.botBetLedger : lobby.mainGameLedger;
            recordDebt(targetLedger, p.username, winner.username, amt);
        }
    });

    lobby.lastGameWinner = winner.username;
    let winIdx = lobby.players.findIndex(p => p.username === winner.username);
    if (winIdx !== -1) lobby.dealerIndex = winIdx;

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} wins the match and deals next!`;
    broadcastLobbyUpdate(lobby.code);
}

function resetLobbyToReadyRoom(lobby, msg) {
    lobby.gameState = 'lobby';
    lobby.phaseMessage = msg || "Returned to waiting room.";
    lobby.activeBets = [];
    lobby.pendingBets = [];
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
        p.lives = 3;
        p.eliminated = false;
        p.cards = [];
        p.ready = p.isBot;
        p.seat = idx;
        p.nextHandReady = false;
        p.peekIncoming = {};
    });
    lobby.spectators = [];
    broadcastLobbyUpdate(lobby.code);
    broadcastLobbyList();
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
                    id: ws, username: currentUser, seat: 0, lives: 3, wager: 5, cards: [],
                    eliminated: false, ready: false, nextHandReady: false, isBot: false,
                    inVC: true, isMuted: true, peekIncoming: {}
                }],
                spectators: [], deck: [], discardPile: [], initialDealCard: null, lastDiscardPickup: null,
                lastDiscardDonor: null, turnIndex: 0, dealerIndex: 0, turnsTakenThisRound: 0, knockedBy: null,
                phaseMessage: "Waiting for all players to ready up.", drawPool: [], drawResults: {},
                tiedParticipantsList: [], activeBets: [], pendingBets: [], sideBetLedger: {},
                mainGameLedger: {}, botBetLedger: {}, fedCardReminders: {}, tokenCache: {},
                playlist: [], currentSongIndex: 0, isPlaying: false
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
                    id: ws, username: currentUser, seat: findOpenSeat(lobby), lives: 3, wager: 5,
                    cards: [], eliminated: false, ready: false, nextHandReady: false, isBot: false,
                    inVC: true, isMuted: true, peekIncoming: {}
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
                    startDealerDrawPhase(lobby);
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
                    if (active.length > 1) startRound(lobby);
                    else resetLobbyToReadyRoom(lobby, "Match completed! Returning to waiting room.");
                }
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'CHOOSE_POOL_CARD') {
            let lobby = lobbies[currentCode];
            if (lobby && (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker')) {
                handlePoolCardSelection(lobby, currentUser, data.cardIndex);
            }
        } else if (data.type === 'DRAW_DECK' || data.type === 'DRAW_DISCARD') {
            let lobby = lobbies[currentCode];
            if (lobby) handleTurnAction(lobby, ws, data.type);
        } else if (data.type === 'DISCARD_CARD') {
            let lobby = lobbies[currentCode];
            if (lobby) handleDiscardAction(lobby, ws, data.cardIndex);
        } else if (data.type === 'KNOCK') {
            let lobby = lobbies[currentCode];
            if (lobby) handleKnock(lobby, ws);
        } else if (data.type === 'ADD_BOT') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.players.length < 6 && lobby.gameState === 'lobby') {
                let botIdx = lobby.players.filter(p => p.isBot).length;
                let botName = BOT_NAMES[botIdx % BOT_NAMES.length];
                lobby.players.push({
                    id: null, username: botName, seat: findOpenSeat(lobby), lives: 3, wager: 5,
                    cards: [], eliminated: false, ready: true, nextHandReady: false, isBot: true,
                    inVC: false, isMuted: true, peekIncoming: {}
                });
                broadcastLobbyUpdate(currentCode);
            }
        } else if (data.type === 'REMOVE_BOT') {
            let lobby = lobbies[currentCode];
            if (lobby && lobby.gameState === 'lobby') {
                let bIdx = lobby.players.map(p => p.isBot).lastIndexOf(true);
                if (bIdx !== -1) {
                    lobby.players.splice(bIdx, 1);
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
                    if (!lobby.botBetLedger[currentUser]) lobby.botBetLedger[currentUser] = {};
                    lobby.botBetLedger[currentUser][data.target] = (lobby.botBetLedger[currentUser][data.target] || 0) + (Number(data.wagerAmt) || 5);
                } else {
                    lobby.pendingBets.push({
                        id: Math.random().toString(36).substring(2, 9),
                        proposer: currentUser, target: data.target, wagerAmt: Number(data.wagerAmt) || 5,
                        type: 'eliminate', pickUser: data.target
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
                        recordDebt(lobby.sideBetLedger, bet.proposer, bet.target, bet.wagerAmt);
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
                if (lobby.players.length === 0) delete lobbies[currentCode];
                else broadcastLobbyUpdate(currentCode);
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                broadcastLobbyList();
            }
        }
    });

    ws.on('close', () => {
        if (currentCode && lobbies[currentCode]) {
            let lobby = lobbies[currentCode];
            let player = lobby.players.find(p => p.id === ws);
            if (player) player.id = null; // Unbind socket without removing from seat
            lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);
        }
    });
});

// Periodic Heartbeat Watchdog
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