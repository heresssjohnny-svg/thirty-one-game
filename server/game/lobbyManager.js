// server/game/lobbyManager.js - PART 1
const WebSocket = require('ws');
const { createDeck, calculateScore, calculateBestFourCardScore } = require('./deck');
const { recordDebt, resolveFirstToLoseBets, resolveWinSideBets } = require('./ledger');
const { executeBotTurn, syncBotReadiness } = require('./bot');
const config = require('../config');

// Safe Database loader for Lifetime Ledger sync
let db = null;
for (const p of ['../db', '../../db', './db', './server/db']) {
    try { db = require(p); break; } catch (e) {}
}

const lobbies = {};

function getLobbies() {
    return lobbies;
}

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    const occ = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) {
        if (!occ.includes(i)) return i;
    }
    return 0;
}

function touchLobbyActivity(lobby, broadcastLobbyList) {
    if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
    lobby.inactivityTimer = setTimeout(() => closeInactiveLobby(lobby.code, broadcastLobbyList), config.INACTIVITY_TIMEOUT_MS);
}

function closeInactiveLobby(code, broadcastLobbyList) {
    const lobby = lobbies[code];
    if (!lobby) return;

    const hasActiveHumanSocket = lobby.players.some(p => !p.isBot && p.id && p.id.readyState === WebSocket.OPEN);
    if (hasActiveHumanSocket) return;

    const closePayload = JSON.stringify({ type: 'ERROR', message: 'Lobby closed due to inactivity.' });
    lobby.players.forEach(p => {
        if (p.id?.readyState === WebSocket.OPEN) {
            p.id.send(closePayload);
            p.id.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket?.readyState === WebSocket.OPEN) {
            s.idSocket.send(closePayload);
            s.idSocket.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
        }
    });
    delete lobbies[code];
    if (broadcastLobbyList) broadcastLobbyList();
}

function getPublicLobbiesList() {
    return Object.values(lobbies).filter(l => !l.isPrivate).map(l => ({
        code: l.code,
        name: l.name,
        host: l.host,
        count: l.players.length,
        playerCount: l.players.length,
        maxPlayers: 6,
        state: l.gameState,
        gameState: l.gameState
    }));
}

function clearRoundOverTimer(lobby) {
    if (lobby && lobby.roundOverAutoTimer) {
        clearTimeout(lobby.roundOverAutoTimer);
        lobby.roundOverAutoTimer = null;
    }
}

function establishDealer(lobby) {
    if (lobby.lastGameWinner) {
        const winIdx = lobby.players.findIndex(p => p.username === lobby.lastGameWinner);
        if (winIdx !== -1) {
            lobby.dealerIndex = winIdx;
            return;
        }
    }
    if (lobby.dealerIndex >= lobby.players.length || lobby.dealerIndex < 0) {
        lobby.dealerIndex = 0;
    }
}

function getWinningSuitFor31(cards) {
    const suits = ['♠', '♥', '♦', '♣'];
    for (const s of suits) {
        const suitCards = cards.filter(c => c.suit === s);
        const suitScore = suitCards.reduce((sum, c) => sum + (c.points !== undefined ? c.points : 0), 0);
        if (suitScore >= 31) return s;
    }
    const suitCounts = {};
    cards.forEach(c => suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1);
    return Object.keys(suitCounts).reduce((a, b) => suitCounts[a] > suitCounts[b] ? a : b, cards[0]?.suit || '♠');
}

function getFeeder21OutOf31(lobby, winnerPlayer, winningSuit) {
    if (!lobby.fedCardsHistory || !lobby.fedCardsHistory[winnerPlayer.username]) {
        return null;
    }

    const recipientHistory = lobby.fedCardsHistory[winnerPlayer.username];

    for (const donorName in recipientHistory) {
        if (donorName.toLowerCase() === winnerPlayer.username.toLowerCase()) continue;

        const cardsFromDonor = recipientHistory[donorName] || [];
        const matchingCards = cardsFromDonor.filter(fedCard =>
            fedCard.suit === winningSuit &&
            winnerPlayer.cards.some(c => c.val === fedCard.val && c.suit === fedCard.suit)
        );

        const hasAce = matchingCards.some(c => c.val === 'A');
        const hasFaceOrTen = matchingCards.some(c => ['10', 'J', 'Q', 'K'].includes(c.val));

        if (hasAce && hasFaceOrTen) {
            return lobby.players.find(p => p.username === donorName && !p.eliminated) || null;
        }
    }

    return null;
}

// -------------------------------------------------------------
// USER ID RESOLUTION & INSTANT LIFETIME LEDGER SYNC
// -------------------------------------------------------------
function resolveUserId(lobby, username) {
    if (!username) return null;
    const p = lobby.players.find(pl => pl.username.toLowerCase() === username.toLowerCase());
    if (p && p.id && p.id.user && !p.id.user.isGuest) {
        return p.id.user.userId;
    }
    const s = lobby.spectators.find(sp => sp.username.toLowerCase() === username.toLowerCase());
    if (s && s.idSocket && s.idSocket.user && !s.idSocket.user.isGuest) {
        return s.idSocket.user.userId;
    }
    if (db && typeof db.findUserByUsername === 'function') {
        const row = db.findUserByUsername(username);
        if (row && row.id && !row.id.startsWith('gst_')) {
            return row.id;
        }
    }
    return null;
}

function recordSessionAndLifetimeDebt(lobby, ledger, debtorUsername, creditorUsername, amount) {
    recordDebt(ledger, debtorUsername, creditorUsername, amount);

    if (db && typeof db.recordLifetimeDebt === 'function') {
        const debtorId = resolveUserId(lobby, debtorUsername);
        const creditorId = resolveUserId(lobby, creditorUsername);

        if (debtorId && creditorId && debtorId !== creditorId) {
            db.recordLifetimeDebt(debtorId, creditorId, amount);

            const participants = [...lobby.players.map(pl => pl.id), ...lobby.spectators.map(sp => sp.idSocket)];
            participants.forEach(ws => {
                if (ws && ws.readyState === WebSocket.OPEN && ws.user && (ws.user.userId === debtorId || ws.user.userId === creditorId)) {
                    try {
                        const balances = db.getLifetimeBalances(ws.user.userId);
                        ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
                    } catch (e) {}
                }
            });
        }
    }
}

function getSanitizedLobby(lobby, wsId) {
    const activeParts = getActiveParticipants(lobby);
    const allParticipants = [...lobby.players];
    const requestingPlayer = lobby.players.find(p => p.id === wsId);
    const requestingSpectator = lobby.spectators.find(s => s.idSocket === wsId);
    const myUsername = requestingPlayer ? requestingPlayer.username : (requestingSpectator?.username || null);

    let sortedParticipants = [...allParticipants];
    if (myUsername) {
        const idx = sortedParticipants.findIndex(p => p.username === myUsername);
        if (idx !== -1) sortedParticipants = sortedParticipants.slice(idx).concat(sortedParticipants.slice(0, idx));
    }
    sortedParticipants.forEach((p, i) => { p.seat = i; });

    const myUnrespondedBets = (lobby.pendingBets || []).filter(b => b.target === myUsername && !b.delivered?.[myUsername]);
    myUnrespondedBets.forEach(b => {
        if (!b.delivered) b.delivered = {};
        b.delivered[myUsername] = true;
    });

    let myFedReminder = null;
    if (myUsername && lobby.fedCardReminders?.[myUsername] && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd') {
        const rem = lobby.fedCardReminders[myUsername];
        const targetPlayer = lobby.players.find(p => p.username === rem.target);
        if (targetPlayer?.cards?.some(c => c.val === rem.card.val && c.suit === rem.card.suit)) {
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

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        defaultLives: lobby.defaultLives || 2,
        deckCount: lobby.deck ? lobby.deck.length : 0,
        turnIndex: lobby.turnIndex,
        dealerIndex: lobby.dealerIndex,
        currentTurnUser: allParticipants[lobby.turnIndex]?.username || '',
        phaseMessage: lobby.phaseMessage,
        canKnock: lobby.turnsTakenThisRound >= activeParts.length,
        potTotal: allParticipants.reduce((sum, p) => sum + (p.wager || 5), 0),
        sidePotTotal: (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0),
        lastGameWinner: lobby.lastGameWinner || null,
        tournamentWinner: lobby.tournamentWinner || null,
        hit31Player: lobby.hit31Player || null,
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
        discardTop: lobby.discardPile ? (lobby.discardPile[lobby.discardPile.length - 1] || null) : null,
        knockedBy: lobby.knockedBy || null,
        chatHistory: lobby.chatHistory || [],
        playlist: lobby.playlist || [],
        currentSongIndex: lobby.currentSongIndex || 0,
        isPlaying: !!lobby.isPlaying,
        currentSongElapsedSeconds: elapsedSeconds,
        livekitHost: config.LIVEKIT_HOST,
        livesVote: lobby.livesVote || null,
        players: lobby.players.map(p => {
            const canSee = lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd' || p.username === myUsername;
            const specAllowed = requestingSpectator && p.peekAllowed && Object.keys(p.peekAllowed).some(
                k => k.toLowerCase() === requestingSpectator.username.toLowerCase()
            );
            const sortedRef = sortedParticipants.find(sp => sp.username === p.username);
            return {
                username: p.username,
                lives: Math.max(0, p.lives),
                wager: p.wager || 5,
                cardCount: p.cards ? p.cards.length : 0,
                ready: p.ready,
                seat: sortedRef ? sortedRef.seat : p.seat,
                nextHandReady: p.nextHandReady,
                eliminated: p.eliminated,
                isBot: !!p.isBot,
                inVC: !!p.inVC,
                isMuted: p.isMuted !== undefined ? p.isMuted : true,
                peekIncoming: wsId === p.id ? (p.peekRequests || {}) : {},
                peekAllowed: p.peekAllowed || {},
                cards: (canSee || specAllowed) ? (p.cards || []) : []
            };
        }),
        spectators: lobby.spectators.map(s => ({
            username: s.username,
            inVC: !!s.inVC,
            isMuted: s.isMuted !== undefined ? s.isMuted : true
        }))
    };
}

function broadcastLobbyUpdate(code) {
    const lobby = lobbies[code];
    if (!lobby) return;

    lobby.players.forEach(p => {
        if (p.id?.readyState === WebSocket.OPEN) {
            const data = getSanitizedLobby(lobby, p.id);
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            p.id.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket?.readyState === WebSocket.OPEN) {
            const data = getSanitizedLobby(lobby, s.idSocket);
            s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            s.idSocket.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    });
}

function startDealerDrawPhase(lobby) {
    clearRoundOverTimer(lobby);
    const deck = createDeck();
    lobby.drawPool = deck.map(c => ({ card: c, chosenBy: null }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.turnsTakenThisRound = 0;
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.players.forEach(p => {
        p.peekAllowed = {};
        p.peekRequests = {};
        if (!p.eliminated) p.nextHandReady = p.isBot;
    });
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function startRound(lobby) {
    clearRoundOverTimer(lobby);
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.gameState = 'playing';
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;

    const activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1) {
        awardTournamentWinner(lobby, activeParts[0]);
        return;
    }

    lobby.players.forEach(p => {
        p.peekAllowed = {};
        p.peekRequests = {};
    });

    establishDealer(lobby);

    const totalPlayers = lobby.players.length;
    const dealOrder = [];
    for (let i = 1; i <= totalPlayers; i++) {
        const idx = (lobby.dealerIndex + i) % totalPlayers;
        dealOrder.push(lobby.players[idx]);
    }

    const regularParticipants = dealOrder.filter(p => !p.eliminated && !p.isNewArrival);
    const newArrivals = dealOrder.filter(p => !p.eliminated && p.isNewArrival);
    const finalDealOrder = [...regularParticipants, ...newArrivals];

    finalDealOrder.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.nextHandReady = p.isBot;
        p.isNewArrival = false;
    });

    const firstDiscard = lobby.deck.pop();
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
    if (lobby.drawResults && lobby.drawResults[username]) return;

    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        const card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        if (!lobby.drawOrderSequence) lobby.drawOrderSequence = [];
        lobby.drawOrderSequence.push({ username, card });
        broadcastLobbyUpdate(lobby.code);

        const activeParts = getActiveParticipants(lobby);
        if (lobby.gameState === 'dealerDraw' && activeParts.every(p => lobby.drawResults[p.username])) {
            const entries = Object.entries(lobby.drawResults).map(([u, c]) => ({ username: u, card: c })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            lobby.dealerIndex = lobby.players.findIndex(p => p.username === entries[0].username);
            lobby.phaseMessage = `🎉 ${entries[0].username} drew lowest and is Dealer!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => {
                if (lobbies[lobby.code]) startRound(lobbies[lobby.code]);
            }, 3000);
        } else if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.every(u => lobby.drawResults[u])) {
            const entries = lobby.tiedParticipantsList.map(u => ({ username: u, card: lobby.drawResults[u] })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            const lowestDrawVal = entries[0].card.drawVal;
            const tiedLowest = entries.filter(e => e.card.drawVal === lowestDrawVal);

            if (tiedLowest.length > 1) {
                lobby.tiedParticipantsList = tiedLowest.map(t => t.username);
                lobby.pendingBotDraw = {};
                lobby.phaseMessage = `⚠️ Tie on lowest card (${entries[0].card.val})! Drawing again in 3 seconds...`;
                broadcastLobbyUpdate(lobby.code);

                setTimeout(() => {
                    if (!lobbies[lobby.code] || lobbies[lobby.code].gameState !== 'tieBreaker') return;
                    const cur = lobbies[lobby.code];
                    const tieDeck = (cur.deck && cur.deck.length >= cur.tiedParticipantsList.length) ? cur.deck : createDeck();
                    cur.drawPool = tieDeck.map(c => ({ card: c, chosenBy: null }));
                    cur.drawResults = {};
                    cur.drawOrderSequence = [];
                    cur.pendingBotDraw = {};
                    cur.phaseMessage = `Tie-Breaker Re-Draw: Pick a card!`;
                    broadcastLobbyUpdate(cur.code);
                    scheduleBotActions(cur);
                }, 3000);
                return;
            }

            const loser = lobby.players.find(p => p.username === entries[0].username);
            if (loser) {
                loser.lives = Math.max(0, loser.lives - 1);
                if (loser.lives <= 0 && !loser.eliminated) {
                    loser.eliminated = true;
                    resolveFirstToLoseBets(lobby, loser.username);
                    if (loser.id && typeof loser.id === 'object') {
                        lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
                    }
                }
            }
            lobby.phaseMessage = `${entries[0].username} drew lowest in tie-breaker!`;
            broadcastLobbyUpdate(lobby.code);

            setTimeout(() => {
                if (!lobbies[lobby.code]) return;
                const currentLobby = lobbies[lobby.code];
                if (getActiveParticipants(currentLobby).length <= 1) {
                    awardTournamentWinner(currentLobby, getActiveParticipants(currentLobby)[0]);
                } else {
                    advanceDealerToNextActive(currentLobby);
                    triggerRoundOver(currentLobby, `${entries[0].username} lost a life in tie-breaker!`);
                }
            }, 3000);
        } else {
            scheduleBotActions(lobby);
        }
    }
}
// server/game/lobbyManager.js - PART 2

function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the deck.`;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        const card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up ${card.val}${card.suit} from the discard pile!`;

        if (lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
            lobby.lastDiscardPickup = { username: currentPlayer.username, card: { val: card.val, suit: card.suit } };
        }

        if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== currentPlayer.username) {
            if (!lobby.fedCardsHistory) lobby.fedCardsHistory = {};
            if (!lobby.fedCardsHistory[currentPlayer.username]) lobby.fedCardsHistory[currentPlayer.username] = {};
            if (!lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor]) {
                lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor] = [];
            }
            lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor].push({
                val: card.val,
                suit: card.suit
            });

            if (!lobby.fedCardReminders) lobby.fedCardReminders = {};
            lobby.fedCardReminders[lobby.lastDiscardDonor] = {
                target: currentPlayer.username,
                card: { val: card.val, suit: card.suit }
            };
        }
    }

    if (calculateBestFourCardScore(currentPlayer.cards) === 31 || calculateScore(currentPlayer.cards) === 31) {
        lobby.hit31Player = currentPlayer.username;

        // Auto-trim 4th card to highest scoring 3-card combination to prevent hand-lock
        if (currentPlayer.cards.length === 4) {
            let bestCards = currentPlayer.cards.slice(0, 3);
            let maxSc = calculateScore(bestCards);
            for (let i = 0; i < 4; i++) {
                const testHand = currentPlayer.cards.filter((_, idx) => idx !== i);
                const sc = calculateScore(testHand);
                if (sc >= maxSc) {
                    maxSc = sc;
                    bestCards = testHand;
                }
            }
            currentPlayer.cards = bestCards;
        }

        const winningSuit = getWinningSuitFor31(currentPlayer.cards);
        const feeder = getFeeder21OutOf31(lobby, currentPlayer, winningSuit);

        if (feeder) {
            feeder.lives = 0;
            feeder.eliminated = true;
            resolveFirstToLoseBets(lobby, feeder.username);
            if (feeder.id && typeof feeder.id === 'object') {
                lobby.spectators.push({ idSocket: feeder.id, username: feeder.username, inVC: feeder.inVC, isMuted: feeder.isMuted });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        resolveFirstToLoseBets(lobby, p.username);
                        if (p.id && typeof p.id === 'object') {
                            lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                        }
                    }
                }
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        resolveWinSideBets(lobby, currentPlayer.username);

        const remaining = getActiveParticipants(lobby);
        if (remaining.length <= 1) {
            awardTournamentWinner(lobby, remaining[0] || currentPlayer);
            return;
        }

        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, lobby.phaseMessage);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleDiscardAction(lobby, wsId, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.cards.length !== 4) return;

    const discarded = currentPlayer.cards[cardIndex];
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
        for (const donor in lobby.fedCardReminders) {
            if (lobby.fedCardReminders[donor].target === currentPlayer.username) {
                const remCard = lobby.fedCardReminders[donor].card;
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
    const score = calculateScore(currentPlayer.cards);
    if (score === 31) {
        lobby.hit31Player = currentPlayer.username;
        const winningSuit = getWinningSuitFor31(currentPlayer.cards);
        const feeder = getFeeder21OutOf31(lobby, currentPlayer, winningSuit);

        if (feeder) {
            feeder.lives = 0;
            feeder.eliminated = true;
            resolveFirstToLoseBets(lobby, feeder.username);
            if (feeder.id && typeof feeder.id === 'object') {
                lobby.spectators.push({ idSocket: feeder.id, username: feeder.username, inVC: feeder.inVC, isMuted: feeder.isMuted });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        resolveFirstToLoseBets(lobby, p.username);
                        if (p.id && typeof p.id === 'object') {
                            lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                        }
                    }
                }
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        resolveWinSideBets(lobby, currentPlayer.username);

        const remaining = getActiveParticipants(lobby);
        if (remaining.length <= 1) {
            awardTournamentWinner(lobby, remaining[0] || currentPlayer);
            return;
        }

        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, lobby.phaseMessage);
    } else {
        advanceTurnOrResolve(lobby);
    }
}

function handleKnock(lobby, wsId) {
    if (lobby.gameState !== 'playing') return;
    const p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== wsId || lobby.knockedBy) return;

    if (p.cards.length !== 3) {
        return;
    }

    const active = getActiveParticipants(lobby);
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
    const active = getActiveParticipants(lobby);
    const scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    const lowest = scores[0].s;
    const tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1) {
        if (active.length === 2) {
            triggerRoundOver(lobby, `Round tied at ${lowest} pts. No one loses a life!`);
        } else {
            lobby.tiedParticipantsList = tied.map(t => t.p.username);
            const tieDeck = (lobby.deck && lobby.deck.length >= tied.length) ? lobby.deck : createDeck();
            lobby.drawPool = tieDeck.map(c => ({ card: c, chosenBy: null }));
            lobby.drawResults = {};
            lobby.drawOrderSequence = [];
            lobby.pendingBotDraw = {};
            lobby.gameState = 'tieBreaker';
            lobby.phaseMessage = `Tie for lowest score (${lowest} pts)! Draw to resolve.`;
            broadcastLobbyUpdate(lobby.code);
            scheduleBotActions(lobby);
        }
    } else {
        const loser = scores[0].p;
        const winner = scores[scores.length - 1].p;
        loser.lives = Math.max(0, loser.lives - 1);

        if (loser.lives <= 0 && !loser.eliminated) {
            loser.eliminated = true;
            resolveFirstToLoseBets(lobby, loser.username);
            if (loser.id && typeof loser.id === 'object') {
                lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
            }
        }

        resolveWinSideBets(lobby, winner.username);

        if (getActiveParticipants(lobby).length <= 1) {
            awardTournamentWinner(lobby, getActiveParticipants(lobby)[0]);
        } else {
            advanceDealerToNextActive(lobby);
            triggerRoundOver(lobby, `Round Over! ${loser.username} had lowest score (${lowest}) and lost a life.`);
        }
    }
}

function triggerRoundOver(lobby, msg) {
    clearRoundOverTimer(lobby);
    lobby.fedCardReminders = {};
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;

    const active = getActiveParticipants(lobby);

    lobby.players.forEach(p => { 
        p.peekAllowed = {};
        p.peekRequests = {};
        p.nextHandReady = p.isBot; 
    });

    broadcastLobbyUpdate(lobby.code);

    if (active.length > 1) {
        lobby.roundOverAutoTimer = setTimeout(() => {
            const cur = lobbies[lobby.code];
            if (!cur || cur.gameState !== 'roundOver') return;

            const remainingActive = getActiveParticipants(cur);
            if (remainingActive.length > 1) {
                cur.players.forEach(p => { p.nextHandReady = true; });
                cur.hit31Player = null;
                broadcastLobbyUpdate(cur.code);
                startRound(cur);
            } else if (remainingActive.length === 1) {
                awardTournamentWinner(cur, remainingActive[0]);
            }
        }, 6000);
    } else if (active.length === 1) {
        awardTournamentWinner(lobby, active[0]);
    }
}

function awardTournamentWinner(lobby, winner) {
    clearRoundOverTimer(lobby);
    if (!winner) return;
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    lobby.players.forEach(p => {
        if (p.username !== winner.username) {
            const amt = p.wager || 5;
            const isBotInvolved = p.isBot || winner.isBot;
            const targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.mainGameLedger;

            recordSessionAndLifetimeDebt(lobby, targetLedger, p.username, winner.username, amt);
        }
    });

    lobby.lastGameWinner = winner.username;
    lobby.tournamentWinner = winner.username;
    const winIdx = lobby.players.findIndex(p => p.username === winner.username);
    if (winIdx !== -1) lobby.dealerIndex = winIdx;

    lobby.gameState = 'tournamentEnd';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} wins the match! Ready up in 6s...`;
    broadcastLobbyUpdate(lobby.code);

    setTimeout(() => {
        if (!lobbies[lobby.code]) return;
        resetLobbyToReadyRoom(lobbies[lobby.code], `🏆 ${winner.username} won the match! Ready up for the next game.`);
    }, 6000);
}

function checkNextHandReady(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length <= 1) {
        clearRoundOverTimer(lobby);
        if (active.length === 1) {
            awardTournamentWinner(lobby, active[0]);
        } else {
            resetLobbyToReadyRoom(lobby, "All players eliminated. Returning to ready room.");
        }
        return;
    }

    if (active.every(p => p.nextHandReady)) {
        clearRoundOverTimer(lobby);
        lobby.hit31Player = null;
        startRound(lobby);
    }
}

function resetLobbyToReadyRoom(lobby, msg, broadcastLobbyList) {
    clearRoundOverTimer(lobby);
    lobby.gameState = 'lobby';
    lobby.phaseMessage = msg || "Returned to waiting room.";
    lobby.endGameVotes = {};
    lobby.activeBets = [];
    lobby.pendingBets = [];
    lobby.globalProposals = [];
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.initialDealCard = null;
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.livesVote = null;

    establishDealer(lobby);

    lobby.players.forEach((p, idx) => {
        p.lives = lobby.defaultLives || 2;
        p.eliminated = false;
        p.cards = [];
        p.ready = false;
        p.seat = idx;
        p.nextHandReady = false;
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    lobby.spectators = lobby.spectators.filter(s => {
        return s.idSocket && s.idSocket.readyState === WebSocket.OPEN;
    });

    syncBotReadiness(lobby);
    broadcastLobbyUpdate(lobby.code);
    if (broadcastLobbyList) broadcastLobbyList();
}

function scheduleBotActions(lobby) {
    if (!lobby) return;
    if (!lobby.pendingBotDraw) lobby.pendingBotDraw = {};

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        lobby.players.forEach(p => {
            if (p.isBot && !p.eliminated) {
                let needsPick = false;
                if (lobby.gameState === 'dealerDraw' && !lobby.drawResults[p.username]) needsPick = true;
                if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.includes(p.username) && !lobby.drawResults[p.username]) needsPick = true;

                if (needsPick && !lobby.pendingBotDraw[p.username]) {
                    lobby.pendingBotDraw[p.username] = true;
                    setTimeout(() => {
                        const cur = lobbies[lobby.code];
                        if (!cur) return;
                        delete cur.pendingBotDraw[p.username];

                        if (cur.gameState !== 'dealerDraw' && cur.gameState !== 'tieBreaker') return;
                        if (cur.drawResults && cur.drawResults[p.username]) return;
                        if (cur.gameState === 'tieBreaker' && !cur.tiedParticipantsList.includes(p.username)) return;

                        const unchosen = cur.drawPool.map((c, i) => ({ i, chosen: c.chosenBy })).filter(c => c.chosen === null);
                        if (unchosen.length > 0) {
                            const chosenIndex = unchosen[Math.floor(Math.random() * unchosen.length)].i;
                            handlePoolCardSelection(cur, p.username, chosenIndex);
                        }
                    }, 500 + Math.random() * 600);
                }
            }
        });
        return;
    }

    if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
        const cur = lobby.players[lobby.turnIndex];
        if (!cur || !cur.isBot || cur.eliminated) return;

        setTimeout(() => {
            const curLobby = lobbies[lobby.code];
            if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
            const bot = curLobby.players[curLobby.turnIndex];
            if (!bot || bot.id !== cur.id) return;

            executeBotTurn(curLobby, bot, {
                handleKnock,
                handleTurnAction,
                handleDiscardAction
            });
        }, 700 + Math.random() * 500);
    }
}

function leaveLobby(ws, code, broadcastLobbyList) {
    if (!lobbies[code]) return;
    const lobby = lobbies[code];

    const leavingPlayerIndex = lobby.players.findIndex(p => p.id === ws);
    const leavingUsername = leavingPlayerIndex !== -1 ? lobby.players[leavingPlayerIndex].username : null;

    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);

    const remainingHumans = lobby.players.filter(p => !p.isBot);
    if (remainingHumans.length === 0) {
        clearRoundOverTimer(lobby);
        if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
        delete lobbies[code];
        if (broadcastLobbyList) broadcastLobbyList();
        return;
    }

    lobby.players.forEach((p, idx) => { p.seat = idx; });

    if (lobby.gameState === 'roundOver') {
        lobby.phaseMessage = `${leavingUsername || 'A player'} left the game.`;
        checkNextHandReady(lobby);
        broadcastLobbyUpdate(code);
        if (broadcastLobbyList) broadcastLobbyList();
        return;
    }

    const activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1 && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn' || lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker')) {
        awardTournamentWinner(lobby, activeParts[0]);
    } else {
        if (lobby.turnIndex >= lobby.players.length) {
            lobby.turnIndex = 0;
        }
        establishDealer(lobby);
        syncBotReadiness(lobby);
        broadcastLobbyUpdate(code);
    }

    if (broadcastLobbyList) broadcastLobbyList();
}

module.exports = {
    lobbies,
    getLobbies,
    getActiveParticipants,
    findOpenSeat,
    touchLobbyActivity,
    closeInactiveLobby,
    getPublicLobbiesList,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    startDealerDrawPhase,
    startRound,
    advanceDealerToNextActive,
    handlePoolCardSelection,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    checkNextHandReady,
    resetLobbyToReadyRoom,
    scheduleBotActions,
    leaveLobby,
    resolveUserId,
    recordSessionAndLifetimeDebt
};
