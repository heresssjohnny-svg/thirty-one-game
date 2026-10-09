// server/game/lobbyManager.js - Core Match Logic, State Management & Ledger Sync
const WebSocket = require('ws');
let db;
try {
    db = require('../db');
} catch (e) {
    db = null;
}
const { executeBotTurn } = require('./bot');

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const lobbies = {};

function getLobbies() {
    return lobbies;
}

function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const val of VALUES) {
            deck.push({ val, suit });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardValue(val) {
    if (val === 'A') return 11;
    if (['K', 'Q', 'J', '10'].includes(val)) return 10;
    return parseInt(val, 10) || 0;
}

function calculateScore(cards) {
    if (!cards || cards.length === 0) return 0;
    const suitTotals = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    cards.forEach(c => {
        if (c && c.suit) {
            suitTotals[c.suit] = (suitTotals[c.suit] || 0) + cardValue(c.val);
        }
    });

    let maxScore = Math.max(...Object.values(suitTotals));

    // Three of a kind of the same rank = 30.5 points
    if (cards.length >= 3) {
        const counts = {};
        cards.forEach(c => { counts[c.val] = (counts[c.val] || 0) + 1; });
        for (const val in counts) {
            if (counts[val] >= 3) {
                maxScore = Math.max(maxScore, 30.5);
            }
        }
    }
    return maxScore;
}

function calculateBestFourCardScore(cards) {
    if (!cards || cards.length < 4) return calculateScore(cards);
    let maxSc = 0;
    for (let i = 0; i < 4; i++) {
        const testHand = cards.filter((_, idx) => idx !== i);
        const sc = calculateScore(testHand);
        if (sc > maxSc) maxSc = sc;
    }
    return maxSc;
}

function getWinningSuitFor31(cards) {
    const suitTotals = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    cards.forEach(c => {
        if (c && c.suit) suitTotals[c.suit] += cardValue(c.val);
    });
    for (const suit in suitTotals) {
        if (suitTotals[suit] === 31) return suit;
    }
    return null;
}

function getFeeder21OutOf31(lobby, winnerPlayer, winningSuit) {
    if (!lobby.fedCardsHistory || !lobby.fedCardsHistory[winnerPlayer.username]) return null;
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

function resolveUserId(lobby, username) {
    if (!username) return null;
    const p = lobby.players.find(pl => pl.username && pl.username.toLowerCase() === username.toLowerCase());
    if (p && p.id && p.id.user && !p.id.user.isGuest) {
        return p.id.user.id || p.id.user.userId;
    }
    const s = lobby.spectators.find(sp => sp.username && sp.username.toLowerCase() === username.toLowerCase());
    if (s && s.idSocket && s.idSocket.user && !s.idSocket.user.isGuest) {
        return s.idSocket.user.id || s.idSocket.user.userId;
    }
    if (db && typeof db.findUserByUsername === 'function') {
        const row = db.findUserByUsername(username);
        if (row && row.id && !row.id.startsWith('gst_')) {
            return row.id;
        }
    }
    return null;
}

function recordDebt(ledger, debtor, creditor, amount) {
    if (!ledger || !debtor || !creditor || debtor === creditor || amount <= 0) return;
    if (!ledger[debtor]) ledger[debtor] = {};
    if (!ledger[creditor]) ledger[creditor] = {};

    const reverseOwed = ledger[creditor][debtor] || 0;
    if (reverseOwed > 0) {
        if (reverseOwed >= amount) {
            ledger[creditor][debtor] -= amount;
            if (ledger[creditor][debtor] === 0) delete ledger[creditor][debtor];
            return;
        } else {
            const remainder = amount - reverseOwed;
            delete ledger[creditor][debtor];
            ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + remainder;
            return;
        }
    }
    ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + amount;
}

function recordSessionAndLifetimeDebt(lobby, ledger, debtor, creditor, amount) {
    recordDebt(ledger, debtor, creditor, amount);
    const debtorId = resolveUserId(lobby, debtor);
    const creditorId = resolveUserId(lobby, creditor);

    if (debtorId && creditorId && debtorId !== creditorId && db && typeof db.recordLifetimeDebt === 'function') {
        db.recordLifetimeDebt(debtorId, creditorId, amount);
    }
}

function sendLifetimeLedger(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const uid = (ws.user && !ws.user.isGuest && (ws.user.id || ws.user.userId))
        || ws.userId
        || (typeof db?.findUserByUsername === 'function' && ws.currentUsername && db.findUserByUsername(ws.currentUsername)?.id);

    if (uid && !uid.startsWith('gst_') && db && typeof db.getLifetimeBalances === 'function') {
        const balances = db.getLifetimeBalances(uid);
        ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
    }
}

function syncLifetimeLedgerBalances(lobby) {
    if (!lobby) return;
    lobby.players.forEach(p => {
        if (p.id && p.id.readyState === WebSocket.OPEN) {
            sendLifetimeLedger(p.id);
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) {
            sendLifetimeLedger(s.idSocket);
        }
    });
}

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    const taken = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) {
        if (!taken.includes(i)) return i;
    }
    return lobby.players.length;
}

function touchLobbyActivity(lobby) {
    if (!lobby) return;
    if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
    lobby.inactivityTimer = setTimeout(() => {
        closeInactiveLobby(lobby.code);
    }, 1800000);
}

function closeInactiveLobby(code) {
    if (lobbies[code]) {
        delete lobbies[code];
    }
}

function getPublicLobbiesList() {
    return Object.values(lobbies)
        .filter(l => !l.isPrivate)
        .map(l => ({
            code: l.code,
            name: l.name,
            host: l.host,
            playerCount: l.players.length,
            gameState: l.gameState
        }));
}

function clearRoundOverTimer(lobby) {
    if (lobby.roundOverAutoTimer) {
        clearTimeout(lobby.roundOverAutoTimer);
        lobby.roundOverAutoTimer = null;
    }
}

function establishDealer(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length === 0) {
        lobby.dealerIndex = 0;
        return;
    }
    if (lobby.dealerIndex >= lobby.players.length || lobby.players[lobby.dealerIndex].eliminated) {
        const firstActiveIdx = lobby.players.findIndex(p => !p.eliminated);
        lobby.dealerIndex = firstActiveIdx !== -1 ? firstActiveIdx : 0;
    }
}

function advanceDealerToNextActive(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length <= 1) return;
    let next = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) {
        next = (next + 1) % lobby.players.length;
    }
    lobby.dealerIndex = next;
}

function syncBotReadiness(lobby) {
    const anyHumanReady = lobby.players.some(p => !p.isBot && p.ready);
    lobby.players.forEach(p => {
        if (p.isBot) p.ready = anyHumanReady;
    });
}

function getSanitizedLobby(lobby, wsOrId) {
    const isRoundOver = lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd';
    const activeUsername = lobby.players.find(p => p.id === wsOrId)?.username ||
                           lobby.spectators.find(s => s.idSocket === wsOrId)?.username || null;

    let myFedReminder = null;
    if (activeUsername && lobby.fedCardReminders?.[activeUsername] && !isRoundOver) {
        const rem = lobby.fedCardReminders[activeUsername];
        const targetPlayer = lobby.players.find(p => p.username === rem.target);
        if (targetPlayer?.cards?.some(c => c.val === rem.card.val && c.suit === rem.card.suit)) {
            myFedReminder = rem;
        } else {
            delete lobby.fedCardReminders[activeUsername];
        }
    }

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        phaseMessage: lobby.phaseMessage,
        knockedBy: lobby.knockedBy,
        hit31Player: lobby.hit31Player,
        lastDiscardPickup: lobby.lastDiscardPickup,
        myFedCardReminder: myFedReminder,
        defaultLives: lobby.defaultLives,
        dealerIndex: lobby.dealerIndex,
        dealerName: lobby.players[lobby.dealerIndex]?.username || null,
        currentTurnUser: lobby.players[lobby.turnIndex]?.username || null,
        activeParticipantsCount: getActiveParticipants(lobby).length,
        potTotal: lobby.players.reduce((sum, p) => sum + (p.wager || 5), 0),
        deckCount: lobby.deck ? lobby.deck.length : 0,
        discardTop: lobby.discardPile.length > 0 ? lobby.discardPile[lobby.discardPile.length - 1] : null,
        drawPool: lobby.drawPool || [],
        drawResults: lobby.drawResults || {},
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        globalProposals: lobby.globalProposals || [],
        mainGameLedger: lobby.mainGameLedger || {},
        botBetLedger: lobby.botBetLedger || {},
        sideBetLedger: lobby.sideBetLedger || {},
        chatHistory: lobby.chatHistory || [],
        livesVote: lobby.livesVote || null,
        canKnock: lobby.turnsTakenThisRound >= getActiveParticipants(lobby).length,
        players: lobby.players.map((p, idx) => {
            const isMe = (p.id === wsOrId);
            const isPeekingAllowed = activeUsername && p.peekAllowed?.[activeUsername];
            const revealCards = isMe || isRoundOver || isPeekingAllowed;

            return {
                username: p.username,
                lives: p.lives,
                wager: p.wager || 5,
                seat: p.seat !== undefined ? p.seat : idx,
                ready: p.ready,
                eliminated: p.eliminated,
                isBot: p.isBot,
                inVC: p.inVC,
                isMuted: p.isMuted,
                nextHandReady: p.nextHandReady,
                peekAllowed: p.peekAllowed || {},
                peekIncoming: isMe ? p.peekRequests : {},
                cards: revealCards ? p.cards : (p.cards ? p.cards.map(() => ({ val: '?', suit: '?' })) : [])
            };
        }),
        spectators: lobby.spectators.map(s => ({
            username: s.username,
            inVC: s.inVC,
            isMuted: s.isMuted
        }))
    };
}

function broadcastLobbyUpdate(code) {
    const lobby = lobbies[code];
    if (!lobby) return;
    touchLobbyActivity(lobby);

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
    lobby.drawPool = deck.map((c, i) => ({ index: i, card: c, chosenBy: null }));
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
    lobby.lastDiscardDonor = null;
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

function handlePoolCardSelection(lobby, username, chosenIndex) {
    if (lobby.gameState !== 'dealerDraw' && lobby.gameState !== 'tieBreaker') return;
    if (!lobby.drawPool || !lobby.drawPool[chosenIndex] || lobby.drawPool[chosenIndex].chosenBy) return;
    if (lobby.drawResults[username]) return;

    if (lobby.gameState === 'tieBreaker' && !lobby.tiedParticipantsList.includes(username)) return;

    const chosenCard = lobby.drawPool[chosenIndex].card;
    lobby.drawPool[chosenIndex].chosenBy = username;
    lobby.drawResults[username] = chosenCard;
    lobby.drawOrderSequence.push({ username, card: chosenCard });

    broadcastLobbyUpdate(lobby.code);

    const neededParticipants = lobby.gameState === 'dealerDraw' ?
        getActiveParticipants(lobby).map(p => p.username) : lobby.tiedParticipantsList;

    const allChosen = neededParticipants.every(uname => lobby.drawResults[uname]);
    if (!allChosen) return;

    setTimeout(() => {
        const curLobby = lobbies[lobby.code];
        if (!curLobby) return;

        if (curLobby.gameState === 'dealerDraw') {
            const results = neededParticipants.map(uname => {
                const p = curLobby.players.find(pl => pl.username === uname);
                const c = curLobby.drawResults[uname];
                return { player: p, card: c, rank: VALUES.indexOf(c.val) };
            }).sort((a, b) => a.rank - b.rank);

            const dealerWinner = results[0].player;
            curLobby.dealerIndex = curLobby.players.indexOf(dealerWinner);
            curLobby.phaseMessage = `👑 ${dealerWinner.username} drew ${results[0].card.val}${results[0].card.suit} (lowest) and is the Dealer!`;
            broadcastLobbyUpdate(curLobby.code);

            setTimeout(() => {
                if (lobbies[curLobby.code]) startRound(lobbies[curLobby.code]);
            }, 3000);
        } else if (curLobby.gameState === 'tieBreaker') {
            const results = curLobby.tiedParticipantsList.map(uname => {
                const p = curLobby.players.find(pl => pl.username === uname);
                const c = curLobby.drawResults[uname];
                return { player: p, card: c, rank: VALUES.indexOf(c.val) };
            }).sort((a, b) => a.rank - b.rank);

            const loser = results[0].player;
            loser.lives = Math.max(0, loser.lives - 1);
            if (loser.lives <= 0) {
                loser.eliminated = true;
                loser.cards = [];
                resolveFirstToLoseBets(curLobby, loser.username);
                syncLifetimeLedgerBalances(curLobby);
                if (loser.id && typeof loser.id === 'object') {
                    curLobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
                }
            }

            advanceDealerToNextActive(curLobby);
            triggerRoundOver(curLobby, `Tie resolved! ${loser.username} drew lowest (${results[0].card.val}${results[0].card.suit}) and lost a life.`);
        }
    }, 2000);
}

function startRound(lobby) {
    clearRoundOverTimer(lobby);
    establishDealer(lobby);

    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.turnsTakenThisRound = 0;
    lobby.finalTurnsRemaining = 0;
    lobby.finalTurnsTaken = {};
    lobby.knockedBy = null;
    lobby.hit31Player = null;
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};

    lobby.players.forEach(p => {
        p.peekAllowed = {};
        p.peekRequests = {};
        p.nextHandReady = p.isBot;
        p.pickedUpDiscardCard = null;
        p.cards = !p.eliminated ? [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()] : [];
    });

    const startCard = lobby.deck.pop();
    lobby.discardPile.push(startCard);
    lobby.initialDealCard = { val: startCard.val, suit: startCard.suit };

    let startTurn = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[startTurn].eliminated) {
        startTurn = (startTurn + 1) % lobby.players.length;
    }
    lobby.turnIndex = startTurn;
    lobby.gameState = 'playing';
    lobby.phaseMessage = `Round started! Dealer: ${lobby.players[lobby.dealerIndex].username}. Turn: ${lobby.players[lobby.turnIndex].username}.`;

    // Check for natural 31 on initial deal
    const natural31 = lobby.players.find(p => !p.eliminated && calculateScore(p.cards) === 31);
    if (natural31) {
        lobby.hit31Player = natural31.username;
        lobby.players.forEach(p => {
            if (p !== natural31 && !p.eliminated) {
                p.lives = Math.max(0, p.lives - 1);
                if (p.lives <= 0) {
                    p.eliminated = true;
                    p.cards = [];
                    resolveFirstToLoseBets(lobby, p.username);
                    if (p.id && typeof p.id === 'object') {
                        lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                    }
                }
            }
        });

        resolveWinSideBets(lobby, natural31.username);
        syncLifetimeLedgerBalances(lobby);

        const remaining = getActiveParticipants(lobby);
        if (remaining.length <= 1) {
            awardTournamentWinner(lobby, remaining[0] || natural31);
            return;
        }

        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `⚡ NATURAL 31! ${natural31.username} dealt 31! All other players lose a life.`);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;
    if (currentPlayer.id !== wsId && (!currentPlayer.idSocket || currentPlayer.idSocket !== wsId)) return;
    if (lobby.gameState === 'finalTurn' && lobby.knockedBy === currentPlayer.username) return;

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
            lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor].push({ val: card.val, suit: card.suit });

            if (!lobby.fedCardReminders) lobby.fedCardReminders = {};
            lobby.fedCardReminders[lobby.lastDiscardDonor] = {
                target: currentPlayer.username,
                card: { val: card.val, suit: card.suit }
            };
        }
    }

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
            feeder.cards = [];
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
                        p.cards = [];
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
            feeder.cards = [];
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
                        p.cards = [];
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
            loser.cards = [];
            resolveFirstToLoseBets(lobby, loser.username);
            syncLifetimeLedgerBalances(lobby);
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
        p.cards = [];
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

function handleSetReady(lobby, username, isReady) {
    if (lobby.gameState !== 'lobby') return;
    const player = lobby.players.find(p => p.username === username);
    if (!player) return;

    player.ready = Boolean(isReady);
    syncBotReadiness(lobby);
    broadcastLobbyUpdate(lobby.code);

    const active = getActiveParticipants(lobby);
    if (active.length >= 2 && active.every(p => p.ready)) {
        lobby.players.forEach(p => { p.ready = false; });
        startDealerDrawPhase(lobby);
    }
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

function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby || !lobby.activeBets) return;
    lobby.activeBets.forEach(bet => {
        if (bet.type === 'win' && bet.pickUser === winnerUsername) {
            recordSessionAndLifetimeDebt(lobby, lobby.sideBetLedger, bet.opponent, bet.proposer, bet.wagerAmt);
        }
    });
}

function resolveFirstToLoseBets(lobby, loserUsername) {
    if (!lobby || !lobby.activeBets) return;
    lobby.activeBets.forEach(bet => {
        if (bet.type === 'first_out' && bet.pickUser === loserUsername) {
            recordSessionAndLifetimeDebt(lobby, lobby.sideBetLedger, bet.opponent, bet.proposer, bet.wagerAmt);
        }
    });
}

function createLobby(code, name, hostUsername, isPrivate = false, defaultLives = 2) {
    lobbies[code] = {
        code,
        name: name || `${hostUsername}'s Room`,
        host: hostUsername,
        isPrivate: !!isPrivate,
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
        finalTurnsRemaining: 0,
        mainGameLedger: {},
        sideBetLedger: {},
        botBetLedger: {},
        activeBets: [],
        pendingBets: [],
        globalProposals: [],
        chatHistory: [],
        playlist: [],
        currentSongIndex: 0,
        isPlaying: false,
        songStartedAt: null,
        songPausedAtOffset: 0,
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

module.exports = {
    lobbies,
    getLobbies,
    createLobby,
    joinLobby,
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
    handleSetReady,
    checkNextHandReady,
    resetLobbyToReadyRoom,
    scheduleBotActions,
    leaveLobby,
    resolveUserId,
    recordSessionAndLifetimeDebt,
    syncLifetimeLedgerBalances
};
