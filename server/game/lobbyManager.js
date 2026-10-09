// server/game/lobbyManager.js - Table Lifecycle, Dealer Draw Cut & Ledger Sync (PART 1 OF 2)

const db = require('../db');
const { createDeck, evaluateHand, calculateScore } = require('./deck');
const { scheduleBotActions } = require('./bot');
const { recordDebt } = require('./ledger');
const WebSocket = require('ws');

const lobbies = {};

// Inactivity threshold (20 minutes)
const INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;

// -------------------------------------------------------------
// 1. REAL-TIME LIFETIME LEDGER SYNC (USER ID RESOLUTION)
// -------------------------------------------------------------
function syncLifetimeLedgerBalances(lobby) {
    if (!db || typeof db.recordLifetimeDebt !== 'function') return;

    if (!lobby.persistedLifetimeLedger) {
        lobby.persistedLifetimeLedger = { main: {}, side: {} };
    }

    const findUserId = (username) => {
        const pl = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
        if (pl && pl.id && pl.id.user && !pl.id.user.isGuest) return pl.id.user.userId || pl.id.user.id;

        const sp = lobby.spectators.find(s => s.username.toLowerCase() === username.toLowerCase());
        if (sp && sp.idSocket && sp.idSocket.user && !sp.idSocket.user.isGuest) return sp.idSocket.user.userId || sp.idSocket.user.id;

        if (typeof db.findUserByUsername === 'function') {
            const userRow = db.findUserByUsername(username);
            if (userRow && userRow.id && !userRow.id.startsWith('gst_')) {
                return userRow.id;
            }
        }
        return null;
    };

    const processCategory = (currentLedger, categoryKey) => {
        if (!currentLedger) return;
        const persisted = lobby.persistedLifetimeLedger[categoryKey];

        for (const debtorName in currentLedger) {
            for (const creditorName in currentLedger[debtorName]) {
                const totalDebt = Number(currentLedger[debtorName][creditorName]) || 0;
                if (!persisted[debtorName]) persisted[debtorName] = {};
                const alreadyPersisted = Number(persisted[debtorName][creditorName]) || 0;

                const delta = totalDebt - alreadyPersisted;
                if (delta > 0) {
                    const debtorId = findUserId(debtorName);
                    const creditorId = findUserId(creditorName);

                    if (debtorId && creditorId && debtorId !== creditorId) {
                        db.recordLifetimeDebt(debtorId, creditorId, delta);
                        persisted[debtorName][creditorName] = totalDebt;
                    }
                }
            }
        }
    };

    processCategory(lobby.mainGameLedger, 'main');
    processCategory(lobby.sideBetLedger, 'side');

    // Broadcast updated ledger data immediately to all connected sockets
    const allSockets = [
        ...lobby.players.map(p => p.id),
        ...lobby.spectators.map(s => s.idSocket)
    ].filter(ws => ws && ws.readyState === WebSocket.OPEN);

    allSockets.forEach(ws => {
        try {
            const uid = (ws.user && !ws.user.isGuest && (ws.user.userId || ws.user.id)) 
                || (typeof db.findUserByUsername === 'function' && ws.currentUsername && db.findUserByUsername(ws.currentUsername)?.id);

            if (uid && !uid.startsWith('gst_')) {
                const balances = db.getLifetimeBalances(uid);
                ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
            }
        } catch (e) {}
    });
}

// -------------------------------------------------------------
// 2. LOBBY SANITIZATION & STATE BROADCASTING
// -------------------------------------------------------------
function getSanitizedLobby(lobby) {
    if (!lobby) return null;

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        defaultLives: lobby.defaultLives || 2,
        players: lobby.players.map(p => ({
            username: p.username,
            seat: p.seat,
            lives: p.lives,
            wager: p.wager,
            ready: p.ready,
            eliminated: p.eliminated,
            isBot: p.isBot,
            inVC: p.inVC,
            isMuted: p.isMuted,
            cards: (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd' || p.eliminated) ? p.cards : (p.cards ? p.cards.map(() => ({})) : []),
            nextHandReady: p.nextHandReady,
            peekAllowed: p.peekAllowed || {},
            peekRequests: p.peekRequests || {}
        })),
        spectators: lobby.spectators.map(s => ({
            username: s.username,
            inVC: s.inVC,
            isMuted: s.isMuted
        })),
        currentTurnUser: lobby.currentTurnUser,
        turnIndex: lobby.turnIndex,
        dealerIndex: lobby.dealerIndex,
        dealerName: lobby.dealerName,
        deckCount: lobby.deck ? lobby.deck.length : 0,
        discardTop: lobby.discardPile && lobby.discardPile.length > 0 ? lobby.discardPile[lobby.discardPile.length - 1] : null,
        potTotal: lobby.potTotal || 0,
        sidePotTotal: lobby.sidePotTotal || 0,
        phaseMessage: lobby.phaseMessage || '',
        knockedBy: lobby.knockedBy,
        hit31Player: lobby.hit31Player || null,
        tournamentWinner: lobby.tournamentWinner || null,
        lastGameWinner: lobby.lastGameWinner || null,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        myFedCardReminder: lobby.myFedCardReminder || null,
        drawPool: lobby.drawPool || [],
        drawResults: lobby.drawResults || {},
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        globalProposals: lobby.globalProposals || [],
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        botBetLedger: lobby.botBetLedger || {},
        livesVote: lobby.livesVote || null,
        chatHistory: lobby.chatHistory || []
    };
}

function broadcastLobbyUpdate(code) {
    const lobby = lobbies[code];
    if (!lobby) return;

    lobby.lastActivity = Date.now();
    const sanitized = getSanitizedLobby(lobby);

    const sendTo = (ws, player) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const payload = JSON.parse(JSON.stringify(sanitized));

        // Unmask local player's private hand
        if (player && player.cards) {
            const meIndex = payload.players.findIndex(p => p.username === player.username);
            if (meIndex !== -1) {
                payload.players[meIndex].cards = player.cards;
            }
        }

        // Deliver spectator peeking hand access if authorized
        if (ws.currentUsername) {
            const specUsername = ws.currentUsername.toLowerCase();
            lobby.players.forEach((p, idx) => {
                if (p.peekAllowed && Object.keys(p.peekAllowed).some(k => k.toLowerCase() === specUsername)) {
                    if (payload.players[idx]) {
                        payload.players[idx].cards = p.cards;
                    }
                }
            });
        }

        ws.send(JSON.stringify({
            type: 'GAME_STATE_UPDATE',
            lobby: payload
        }));
    };

    lobby.players.forEach(p => {
        if (p.id) sendTo(p.id, p);
    });

    lobby.spectators.forEach(s => {
        if (s.idSocket) sendTo(s.idSocket, null);
    });
}

function touchLobbyActivity(lobby, broadcastListFn) {
    if (!lobby) return;
    lobby.lastActivity = Date.now();
}

function getActiveParticipants(lobby) {
    return (lobby.players || []).filter(p => !p.eliminated);
}

// -------------------------------------------------------------
// 3. DEALER DRAW CUT & TIE BREAKER PHASES (RESTORED ENGINE)
// -------------------------------------------------------------
function startDealerDrawPhase(lobby) {
    const deck = createDeck(); // Full 52-card deck
    lobby.drawPool = deck.map((c, idx) => ({ index: idx, card: c, chosenBy: null }));
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

function handlePoolCardSelection(lobby, username, poolIndex) {
    if (lobby.gameState !== 'dealerDraw' && lobby.gameState !== 'tieBreaker') return;

    const activeParticipants = getActiveParticipants(lobby);
    const isTiedPhase = lobby.gameState === 'tieBreaker';

    if (isTiedPhase) {
        if (!lobby.tiedParticipantsList.includes(username)) return;
    } else {
        if (!activeParticipants.some(p => p.username === username)) return;
    }

    if (lobby.drawResults[username]) return;

    const poolItem = lobby.drawPool.find(p => p.index === poolIndex);
    if (!poolItem || poolItem.chosenBy) return;

    poolItem.chosenBy = username;
    lobby.drawResults[username] = poolItem.card;
    lobby.drawOrderSequence.push({ username, card: poolItem.card });

    const expectedParticipants = isTiedPhase ? lobby.tiedParticipantsList : activeParticipants.map(p => p.username);
    const allDrawn = expectedParticipants.every(u => Boolean(lobby.drawResults[u]));

    if (allDrawn) {
        if (isTiedPhase) {
            resolveTieBreakerDraw(lobby);
        } else {
            resolveDealerCutResults(lobby);
        }
    } else {
        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
    }
}

function getCardRankValue(val) {
    if (val === 'A') return 14;
    if (val === 'K') return 13;
    if (val === 'Q') return 12;
    if (val === 'J') return 11;
    return parseInt(val, 10) || 0;
}

function resolveDealerCutResults(lobby) {
    const results = lobby.drawOrderSequence;
    if (!results || results.length === 0) return;

    let lowestScore = 999;
    let lowestDraws = [];

    results.forEach(res => {
        const score = getCardRankValue(res.card.val);
        if (score < lowestScore) {
            lowestScore = score;
            lowestDraws = [res.username];
        } else if (score === lowestScore) {
            lowestDraws.push(res.username);
        }
    });

    if (lowestDraws.length === 1) {
        const dealerName = lowestDraws[0];
        lobby.dealerName = dealerName;
        lobby.dealerIndex = lobby.players.findIndex(p => p.username === dealerName);
        lobby.phaseMessage = `${dealerName} drew lowest (${lowestScore}) and deals!`;
        broadcastLobbyUpdate(lobby.code);

        setTimeout(() => {
            if (lobby.gameState === 'dealerDraw') {
                startRound(lobby);
            }
        }, 2200);
    } else {
        // Redraw tie between tied dealer candidates
        lobby.phaseMessage = `Dealer tie between: ${lowestDraws.join(', ')}. Redrawing...`;
        lobby.tiedParticipantsList = lowestDraws;
        lobby.drawResults = {};
        lobby.drawOrderSequence = [];
        const deck = createDeck();
        lobby.drawPool = deck.map((c, idx) => ({ index: idx, card: c, chosenBy: null }));
        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
    }
}

function resolveTieBreakerDraw(lobby) {
    const tiedUsers = lobby.tiedParticipantsList;
    let lowestScore = 999;
    let eliminatedUser = null;

    tiedUsers.forEach(u => {
        const card = lobby.drawResults[u];
        const score = getCardRankValue(card.val);
        if (score < lowestScore) {
            lowestScore = score;
            eliminatedUser = u;
        }
    });

    const targetPlayer = lobby.players.find(p => p.username === eliminatedUser);
    if (targetPlayer) {
        targetPlayer.lives -= 1;
        if (targetPlayer.lives <= 0) targetPlayer.eliminated = true;
    }

    lobby.phaseMessage = `${eliminatedUser} drew lowest in tie-breaker and lost a life!`;
    lobby.tiedParticipantsList = [];
    broadcastLobbyUpdate(lobby.code);

    setTimeout(() => {
        checkTournamentProgress(lobby);
    }, 2500);
}

// -------------------------------------------------------------
// 4. PLAYER READY & WAITING ROOM HOOKS
// -------------------------------------------------------------
function handleSetReady(lobby, username, isReady) {
    if (lobby.gameState !== 'lobby') return;
    const player = lobby.players.find(p => p.username === username);
    if (!player) return;

    player.ready = Boolean(isReady);

    // Sync bot readiness to match humans
    lobby.players.forEach(p => {
        if (p.isBot) p.ready = true;
    });

    const active = getActiveParticipants(lobby);
    // When 2 or more seated players are all ready, start Dealer Draw Cut
    if (active.length >= 2 && active.every(p => p.ready)) {
        lobby.players.forEach(p => { p.ready = false; });
        startDealerDrawPhase(lobby);
    } else {
        broadcastLobbyUpdate(lobby.code);
    }
}
// server/game/lobbyManager.js - Gameplay Engine, Turn Processing & Match Handlers (PART 2 OF 2)

// -------------------------------------------------------------
// 5. ROUND INITIALIZATION & CARD DEALING
// -------------------------------------------------------------
function startRound(lobby) {
    clearRoundOverTimer(lobby);
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.turnsTakenThisRound = 0;
    lobby.finalTurnsTaken = {};
    lobby.knockedBy = null;
    lobby.hit31Player = null;
    lobby.tournamentWinner = null;
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};

    const activePlayers = getActiveParticipants(lobby);
    if (activePlayers.length <= 1) {
        if (activePlayers.length === 1) {
            awardTournamentWinner(lobby, activePlayers[0]);
        } else {
            resetLobbyToReadyRoom(lobby, "All players eliminated. Returning to waiting room.");
        }
        return;
    }

    // Deal 3 cards to every active participant
    activePlayers.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.pickedUpDiscardCard = null;
        p.nextHandReady = p.isBot;
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    // Flip top card onto discard pile
    const initialCard = lobby.deck.pop();
    lobby.discardPile.push(initialCard);
    lobby.initialDealCard = { val: initialCard.val, suit: initialCard.suit };

    lobby.gameState = 'playing';

    // First turn goes to the player immediately left of dealer
    if (lobby.dealerIndex === undefined || lobby.dealerIndex === null || lobby.dealerIndex < 0) {
        lobby.dealerIndex = 0;
    }

    let nextTurn = (lobby.dealerIndex + 1) % lobby.players.length;
    let safety = 0;
    while (lobby.players[nextTurn].eliminated && safety < lobby.players.length) {
        nextTurn = (nextTurn + 1) % lobby.players.length;
        safety++;
    }
    lobby.turnIndex = nextTurn;
    lobby.currentTurnUser = lobby.players[nextTurn].username;
    lobby.phaseMessage = `Round started! Dealer: ${lobby.players[lobby.dealerIndex]?.username || 'Player'}. ${lobby.currentTurnUser}'s turn.`;

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

// -------------------------------------------------------------
// 6. IN-GAME TURN & DISCARD PROCESSING
// -------------------------------------------------------------
function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (currentPlayer.id !== wsId && (!currentPlayer.idSocket || currentPlayer.idSocket !== wsId)) return;

    // The knocker is not allowed to draw during the final turn phase
    if (lobby.gameState === 'finalTurn' && lobby.knockedBy === currentPlayer.username) {
        return;
    }

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

    // Evaluate instant 31 blitz upon draw
    if (calculateBestFourCardScore(currentPlayer.cards) === 31 || calculateScore(currentPlayer.cards) === 31) {
        lobby.hit31Player = currentPlayer.username;

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
        syncLifetimeLedgerBalances(lobby);

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
    if (!currentPlayer || currentPlayer.cards.length !== 4) return;

    if (currentPlayer.id !== wsId && (!currentPlayer.idSocket || currentPlayer.idSocket !== wsId)) return;

    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= currentPlayer.cards.length) {
        cardIndex = 0;
    }

    const discarded = currentPlayer.cards[cardIndex];

    // Cannot immediately discard the exact card just drawn from the discard pile
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

    if (lobby.gameState === 'finalTurn') {
        if (!lobby.finalTurnsTaken) lobby.finalTurnsTaken = {};
        lobby.finalTurnsTaken[currentPlayer.username] = true;
    }

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
        syncLifetimeLedgerBalances(lobby);

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
    if (!p || p.eliminated || lobby.knockedBy) return;

    if (p.id !== wsId && (!p.idSocket || p.idSocket !== wsId)) return;

    if (p.cards.length !== 3) return;

    const active = getActiveParticipants(lobby);
    if (lobby.turnsTakenThisRound < active.length) return;
    if (calculateScore(p.cards) < (active.length > 2 ? 21 : 25)) return;

    lobby.gameState = 'finalTurn';
    lobby.knockedBy = p.username;
    lobby.finalTurnsTaken = {};
    lobby.phaseMessage = `🔔 KNOCK! ${p.username} knocked! 1 final turn each.`;

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    let attempts = 0;
    while ((lobby.players[next].eliminated || lobby.players[next].username === lobby.knockedBy) && attempts < lobby.players.length) {
        next = (next + 1) % lobby.players.length;
        attempts++;
    }

    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function advanceTurnOrResolve(lobby) {
    if (lobby.gameState === 'finalTurn') {
        const activeOpponents = getActiveParticipants(lobby).filter(p => p.username !== lobby.knockedBy);
        const allOpponentsFinished = activeOpponents.every(p => lobby.finalTurnsTaken && lobby.finalTurnsTaken[p.username]);

        if (allOpponentsFinished) {
            resolveRoundEnd(lobby);
            return;
        }

        let next = (lobby.turnIndex + 1) % lobby.players.length;
        let found = false;
        for (let i = 0; i < lobby.players.length; i++) {
            const candidate = lobby.players[next];
            if (!candidate.eliminated && candidate.username !== lobby.knockedBy && (!lobby.finalTurnsTaken || !lobby.finalTurnsTaken[candidate.username])) {
                lobby.turnIndex = next;
                found = true;
                break;
            }
            next = (next + 1) % lobby.players.length;
        }

        if (!found) {
            resolveRoundEnd(lobby);
            return;
        }

        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
        return;
    }

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    let safety = 0;
    while (lobby.players[next].eliminated && safety < lobby.players.length) {
        next = (next + 1) % lobby.players.length;
        safety++;
    }

    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

// -------------------------------------------------------------
// 7. ROUND RESOLUTION & SCORING
// -------------------------------------------------------------
function resolveRoundEnd(lobby) {
    lobby.players.forEach(p => {
        if (p.cards && p.cards.length === 4) {
            let bestCards = p.cards.slice(0, 3);
            let maxSc = calculateScore(bestCards);
            for (let i = 0; i < 4; i++) {
                const testHand = p.cards.filter((_, idx) => idx !== i);
                const sc = calculateScore(testHand);
                if (sc >= maxSc) {
                    maxSc = sc;
                    bestCards = testHand;
                }
            }
            p.cards = bestCards;
        }
    });

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
            lobby.drawPool = tieDeck.map((c, idx) => ({ index: idx, card: c, chosenBy: null }));
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
            syncLifetimeLedgerBalances(lobby);
            if (loser.id && typeof loser.id === 'object') {
                lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
            }
        }

        resolveWinSideBets(lobby, winner.username);
        syncLifetimeLedgerBalances(lobby);

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
    lobby.players.forEach(p => { 
        p.peekAllowed = {};
        p.peekRequests = {};
        p.nextHandReady = p.isBot; 
    });
    broadcastLobbyUpdate(lobby.code);

    const active = getActiveParticipants(lobby);
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
        }, 8000);
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

            recordDebt(targetLedger, p.username, winner.username, amt);
        }
    });

    lobby.lastGameWinner = winner.username;
    lobby.tournamentWinner = winner.username;
    const winIdx = lobby.players.findIndex(p => p.username === winner.username);
    if (winIdx !== -1) lobby.dealerIndex = winIdx;

    syncLifetimeLedgerBalances(lobby);

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
    lobby.finalTurnsTaken = {};
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

    const spectatorsToReclaim = [...lobby.spectators];
    spectatorsToReclaim.forEach(spec => {
        if (lobby.players.length < 6) {
            const openSeat = findOpenSeat(lobby);
            lobby.players.push({
                id: spec.idSocket,
                username: spec.username,
                lives: lobby.defaultLives || 2,
                wager: 5,
                cards: [],
                ready: false,
                seat: openSeat,
                eliminated: false,
                isBot: false,
                inVC: spec.inVC,
                isMuted: spec.isMuted,
                nextHandReady: false,
                peekRequests: {},
                peekAllowed: {},
                disconnectedAt: null
            });
            lobby.spectators = lobby.spectators.filter(s => s !== spec);
        }
    });

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

// -------------------------------------------------------------
// 8. BOT ACTIONS & TIMERS
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// 9. LOBBY CREATION, SEATING & CLEANUP
// -------------------------------------------------------------
function createLobby(code, name, hostUsername, isPrivate = false, defaultLives = 2) {
    lobbies[code] = {
        code,
        name: name || `${hostUsername}'s Room`,
        host: hostUsername,
        isPrivate: Boolean(isPrivate),
        defaultLives: defaultLives || 2,
        gameState: 'lobby',
        players: [],
        spectators: [],
        deck: [],
        discardPile: [],
        drawPool: [],
        drawResults: {},
        drawOrderSequence: [],
        turnIndex: 0,
        dealerIndex: 0,
        turnsTakenThisRound: 0,
        finalTurnsTaken: {},
        mainGameLedger: {},
        sideBetLedger: {},
        botBetLedger: {},
        activeBets: [],
        pendingBets: [],
        globalProposals: [],
        chatHistory: [],
        inactivityTimer: null,
        roundOverAutoTimer: null
    };
    return lobbies[code];
}

function joinLobby(ws, code, username) {
    const lobby = lobbies[code];
    if (!lobby) return { success: false, message: 'Lobby does not exist.' };

    const existingPlayer = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (existingPlayer) {
        existingPlayer.id = ws;
        existingPlayer.disconnectedAt = null;
        return { success: true, lobby, isSpectator: false };
    }

    const existingSpectator = lobby.spectators.find(s => s.username.toLowerCase() === username.toLowerCase());
    if (existingSpectator) {
        existingSpectator.idSocket = ws;
        return { success: true, lobby, isSpectator: true };
    }

    if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
        const seat = findOpenSeat(lobby);
        lobby.players.push({
            id: ws,
            username,
            lives: lobby.defaultLives || 2,
            wager: 5,
            cards: [],
            ready: false,
            seat,
            eliminated: false,
            isBot: false,
            inVC: false,
            isMuted: true,
            nextHandReady: false,
            peekRequests: {},
            peekAllowed: {},
            disconnectedAt: null
        });
        return { success: true, lobby, isSpectator: false };
    }

    lobby.spectators.push({
        idSocket: ws,
        username,
        inVC: false,
        isMuted: true
    });
    return { success: true, lobby, isSpectator: true };
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

// -------------------------------------------------------------
// 10. HELPER FUNCTIONS & DEBT RESOLUTIONS
// -------------------------------------------------------------
function clearRoundOverTimer(lobby) {
    if (lobby.roundOverAutoTimer) {
        clearTimeout(lobby.roundOverAutoTimer);
        lobby.roundOverAutoTimer = null;
    }
}

function advanceDealerToNextActive(lobby) {
    let next = (lobby.dealerIndex + 1) % lobby.players.length;
    let safety = 0;
    while (lobby.players[next].eliminated && safety < lobby.players.length) {
        next = (next + 1) % lobby.players.length;
        safety++;
    }
    lobby.dealerIndex = next;
    lobby.dealerName = lobby.players[next]?.username || null;
}

function establishDealer(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length === 0) return;
    if (lobby.dealerIndex >= lobby.players.length || lobby.players[lobby.dealerIndex].eliminated) {
        lobby.dealerIndex = lobby.players.indexOf(active[0]);
        lobby.dealerName = active[0].username;
    }
}

function findOpenSeat(lobby) {
    const taken = new Set(lobby.players.map(p => p.seat));
    for (let i = 0; i < 6; i++) {
        if (!taken.has(i)) return i;
    }
    return lobby.players.length;
}

function syncBotReadiness(lobby) {
    lobby.players.forEach(p => {
        if (p.isBot) p.ready = true;
    });
}

function calculateBestFourCardScore(cards) {
    if (!cards || cards.length < 3) return 0;
    if (cards.length === 3) return calculateScore(cards);

    let maxSc = 0;
    for (let i = 0; i < cards.length; i++) {
        const sub = cards.filter((_, idx) => idx !== i);
        const sc = calculateScore(sub);
        if (sc > maxSc) maxSc = sc;
    }
    return maxSc;
}

function getWinningSuitFor31(cards) {
    const suitTotals = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    cards.forEach(c => {
        const val = (c.val === 'A') ? 11 : (['K', 'Q', 'J', '10'].includes(c.val) ? 10 : parseInt(c.val, 10));
        suitTotals[c.suit] = (suitTotals[c.suit] || 0) + val;
    });
    for (const suit in suitTotals) {
        if (suitTotals[suit] === 31) return suit;
    }
    return Object.keys(suitTotals)[0];
}

function getFeeder21OutOf31(lobby, winnerPlayer, winningSuit) {
    if (!lobby.fedCardsHistory || !lobby.fedCardsHistory[winnerPlayer.username]) return null;

    const donorMap = lobby.fedCardsHistory[winnerPlayer.username];
    for (const donorName in donorMap) {
        const cardsGiven = donorMap[donorName].filter(c => c.suit === winningSuit);
        const hasAce = cardsGiven.some(c => c.val === 'A');
        const hasFace = cardsGiven.some(c => ['K', 'Q', 'J', '10'].includes(c.val));
        if (hasAce && hasFace) {
            return lobby.players.find(p => p.username === donorName && !p.eliminated);
        }
    }
    return null;
}

function resolveFirstToLoseBets(lobby, eliminatedUsername) {
    if (!lobby.activeBets) return;

    lobby.activeBets = lobby.activeBets.filter(bet => {
        if (bet.type === 'eliminate') {
            const bettor = bet.bettor || bet.proposer;
            const target = bet.target;
            const wager = bet.wagerAmt || 5;

            if (target === eliminatedUsername) {
                // Target lost first -> Bettor wins
                const isBot = lobby.players.some(p => (p.username === bettor || p.username === target) && p.isBot);
                const ledger = isBot ? lobby.botBetLedger : lobby.sideBetLedger;
                recordDebt(ledger, target, bettor, wager);
                return false;
            } else if (bettor === eliminatedUsername) {
                // Bettor lost first -> Target wins
                const isBot = lobby.players.some(p => (p.username === bettor || p.username === target) && p.isBot);
                const ledger = isBot ? lobby.botBetLedger : lobby.sideBetLedger;
                recordDebt(ledger, bettor, target, wager);
                return false;
            }
        }
        return true;
    });
}

function resolveWinSideBets(lobby, roundWinnerUsername) {
    if (!lobby.activeBets) return;

    lobby.activeBets = lobby.activeBets.filter(bet => {
        if (bet.type === 'win_round') {
            const bettor = bet.bettor || bet.proposer;
            const target = bet.target;
            const pick = bet.pickUser || bettor;
            const wager = bet.wagerAmt || 5;

            const isBot = lobby.players.some(p => (p.username === bettor || p.username === target) && p.isBot);
            const ledger = isBot ? lobby.botBetLedger : lobby.sideBetLedger;

            if (pick === roundWinnerUsername) {
                recordDebt(ledger, target, bettor, wager);
            } else {
                recordDebt(ledger, bettor, target, wager);
            }
            return false;
        }
        return true;
    });
}

function getPublicLobbiesList() {
    return Object.values(lobbies)
        .filter(l => !l.isPrivate)
        .map(l => ({
            code: l.code,
            name: l.name,
            host: l.host,
            playersCount: l.players.length,
            gameState: l.gameState,
            defaultLives: l.defaultLives || 2
        }));
}

function getLobbies() {
    return lobbies;
}

module.exports = {
    lobbies,
    getLobbies,
    createLobby,
    joinLobby,
    leaveLobby,
    getActiveParticipants,
    findOpenSeat,
    touchLobbyActivity,
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
    handleSetReady,
    syncLifetimeLedgerBalances
};
