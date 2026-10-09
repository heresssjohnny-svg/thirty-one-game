
const WebSocket = require('ws');

let db = null;
try {
    db = require('../db');
} catch (e) {
    console.warn('[LobbyManager] db load warning:', e.message);
}

let createDeck, calculateScore;
try {
    const deckMod = require('./deck');
    createDeck = deckMod.createDeck;
    calculateScore = deckMod.calculateScore;
} catch (e) {
    createDeck = function() {
        const suits = ['♠', '♥', '♦', '♣'];
        const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        const deck = [];
        suits.forEach(suit => {
            values.forEach(val => deck.push({ val, suit }));
        });
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    };

    calculateScore = function(cards) {
        if (!cards || cards.length === 0) return 0;
        const sums = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
        cards.forEach(c => {
            if (!c || !c.val) return;
            const val = (c.val === 'A') ? 11 : (['K', 'Q', 'J', '10'].includes(c.val) ? 10 : parseInt(c.val, 10));
            sums[c.suit] = (sums[c.suit] || 0) + (isNaN(val) ? 0 : val);
        });
        if (cards.length === 3 && cards[0].val === cards[1].val && cards[0].val === cards[2].val) {
            return 30.5;
        }
        return Math.max(...Object.values(sums), 0);
    };
}

let recordDebt = function(ledger, debtor, creditor, amount) {
    if (!ledger) return;
    if (!ledger[debtor]) ledger[debtor] = {};
    ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + amount;
};
try {
    const ledgerMod = require('./ledger');
    if (ledgerMod && ledgerMod.recordDebt) recordDebt = ledgerMod.recordDebt;
} catch (e) {}

const lobbies = {};

function getActiveParticipants(lobby) {
    return (lobby.players || []).filter(p => !p.eliminated);
}

function establishDealer(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length === 0) return;
    if (lobby.dealerIndex === undefined || lobby.dealerIndex >= lobby.players.length || lobby.players[lobby.dealerIndex].eliminated) {
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

function getCardRankValue(val) {
    if (val === 'A') return 14;
    if (val === 'K') return 13;
    if (val === 'Q') return 12;
    if (val === 'J') return 11;
    return parseInt(val, 10) || 0;
}

function syncLifetimeLedgerBalances(lobby) {
    if (!db || typeof db.recordLifetimeDebt !== 'function') return;

    if (!lobby.persistedLifetimeLedger) {
        lobby.persistedLifetimeLedger = { main: {}, side: {} };
    }

    const findUserId = (username) => {
        const pl = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
        if (pl && pl.id && pl.id.user && !pl.id.user.isGuest) return pl.id.user.userId || pl.id.user.id;

        const sp = (lobby.spectators || []).find(s => s.username.toLowerCase() === username.toLowerCase());
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

    const allSockets = [
        ...lobby.players.map(p => p.id),
        ...(lobby.spectators || []).map(s => s.idSocket)
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
            cards: (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd' || p.eliminated) 
                ? p.cards 
                : (p.cards ? p.cards.map(() => ({})) : []),
            nextHandReady: p.nextHandReady,
            peekAllowed: p.peekAllowed || {},
            peekRequests: p.peekRequests || {}
        })),
        spectators: (lobby.spectators || []).map(s => ({
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
        phaseMessage: lobby.phaseMessage || '',
        knockedBy: lobby.knockedBy,
        hit31Player: lobby.hit31Player || null,
        tournamentWinner: lobby.tournamentWinner || null,
        lastGameWinner: lobby.lastGameWinner || null,
        drawPool: lobby.drawPool || [],
        drawResults: lobby.drawResults || {},
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        globalProposals: lobby.globalProposals || [],
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        botBetLedger: lobby.botBetLedger || {},
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

        if (player && player.cards) {
            const meIndex = payload.players.findIndex(p => p.username === player.username);
            if (meIndex !== -1) {
                payload.players[meIndex].cards = player.cards;
            }
        }

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

    (lobby.spectators || []).forEach(s => {
        if (s.idSocket) sendTo(s.idSocket, null);
    });
}

function startDealerDrawPhase(lobby) {
    const deck = createDeck();
    lobby.drawPool = deck.map((c, idx) => ({ index: idx, card: c, chosenBy: null }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;

    lobby.players.forEach(p => {
        if (!p.eliminated) p.nextHandReady = p.isBot;
    });

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handlePoolCardSelection(lobby, username, poolIndex) {
    if (lobby.gameState !== 'dealerDraw' && lobby.gameState !== 'tieBreaker') return;
    const activeParticipants = getActiveParticipants(lobby);
    if (!activeParticipants.some(p => p.username === username)) return;
    if (lobby.drawResults[username]) return;

    const poolItem = lobby.drawPool.find(p => p.index === poolIndex);
    if (!poolItem || poolItem.chosenBy) return;

    poolItem.chosenBy = username;
    lobby.drawResults[username] = poolItem.card;
    lobby.drawOrderSequence.push({ username, card: poolItem.card });

    const allDrawn = activeParticipants.every(p => Boolean(lobby.drawResults[p.username]));
    if (allDrawn) {
        resolveDealerCutResults(lobby);
    } else {
        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
    }
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

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.knockedBy = null;
    lobby.hit31Player = null;
    lobby.tournamentWinner = null;
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.turnsTakenThisRound = 0;
    lobby.finalTurnsTaken = {};

    const activePlayers = getActiveParticipants(lobby);
    if (activePlayers.length <= 1) {
        lobby.gameState = 'lobby';
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    activePlayers.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.pickedUpDiscardCard = null;
        p.nextHandReady = p.isBot;
    });

    lobby.discardPile.push(lobby.deck.pop());
    lobby.gameState = 'playing';

    establishDealer(lobby);
    let nextTurn = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[nextTurn].eliminated) {
        nextTurn = (nextTurn + 1) % lobby.players.length;
    }
    lobby.turnIndex = nextTurn;
    lobby.currentTurnUser = lobby.players[nextTurn].username;
    lobby.phaseMessage = `${lobby.currentTurnUser}'s turn.`;

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function scheduleBotActions(lobby) {
    if (!lobby) return;

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        lobby.players.forEach(p => {
            if (p.isBot && !p.eliminated && !lobby.drawResults[p.username]) {
                setTimeout(() => {
                    const cur = lobbies[lobby.code];
                    if (!cur || (cur.gameState !== 'dealerDraw' && cur.gameState !== 'tieBreaker') || cur.drawResults[p.username]) return;
                    const unchosen = cur.drawPool.filter(c => c.chosenBy === null);
                    if (unchosen.length > 0) {
                        const pick = unchosen[Math.floor(Math.random() * unchosen.length)];
                        handlePoolCardSelection(cur, p.username, pick.index);
                    }
                }, 600 + Math.random() * 500);
            }
        });
        return;
    }

    if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
        const bot = lobby.players[lobby.turnIndex];
        if (!bot || !bot.isBot || bot.eliminated) return;

        setTimeout(() => {
            const cur = lobbies[lobby.code];
            if (!cur || (cur.gameState !== 'playing' && cur.gameState !== 'finalTurn')) return;
            const currentBot = cur.players[cur.turnIndex];
            if (!currentBot || !currentBot.isBot || currentBot.username !== bot.username) return;

            if (cur.deck.length === 0) cur.deck = createDeck();
            currentBot.cards.push(cur.deck.pop());

            setTimeout(() => {
                if (currentBot.cards.length === 4) {
                    const discarded = currentBot.cards.pop();
                    cur.discardPile.push(discarded);
                }

                let next = (cur.turnIndex + 1) % cur.players.length;
                while (cur.players[next].eliminated) {
                    next = (next + 1) % cur.players.length;
                }
                cur.turnIndex = next;
                cur.currentTurnUser = cur.players[next].username;
                cur.phaseMessage = `${cur.currentTurnUser}'s turn.`;

                broadcastLobbyUpdate(cur.code);
                scheduleBotActions(cur);
            }, 600);
        }, 800);
    }
}

function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;
    if (currentPlayer.id !== wsId && (!currentPlayer.idSocket || currentPlayer.idSocket !== wsId)) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `${currentPlayer.username} drew from deck.`;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        const card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };
        lobby.phaseMessage = `${currentPlayer.username} drew from discard.`;
    }

    if (calculateScore(currentPlayer.cards) === 31) {
        lobby.hit31Player = currentPlayer.username;
        lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points!`;
        lobby.gameState = 'roundOver';
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

    const discarded = currentPlayer.cards.splice(cardIndex, 1)[0];
    currentPlayer.pickedUpDiscardCard = null;
    lobby.discardPile.push(discarded);

    if (calculateScore(currentPlayer.cards) === 31) {
        lobby.hit31Player = currentPlayer.username;
        lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points!`;
        lobby.gameState = 'roundOver';
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) {
        next = (next + 1) % lobby.players.length;
    }
    lobby.turnIndex = next;
    lobby.currentTurnUser = lobby.players[next].username;
    lobby.phaseMessage = `${lobby.currentTurnUser}'s turn.`;

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleKnock(lobby, wsId) {
    if (lobby.gameState !== 'playing') return;
    const p = lobby.players[lobby.turnIndex];
    if (!p || p.eliminated || lobby.knockedBy) return;
    if (p.id !== wsId && (!p.idSocket || p.idSocket !== wsId)) return;

    lobby.gameState = 'finalTurn';
    lobby.knockedBy = p.username;
    lobby.phaseMessage = `🔔 KNOCK! ${p.username} knocked!`;

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated || lobby.players[next].username === lobby.knockedBy) {
        next = (next + 1) % lobby.players.length;
    }
    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleSetReady(lobby, username, isReady) {
    if (lobby.gameState !== 'lobby') return;
    const player = lobby.players.find(p => p.username === username);
    if (!player) return;

    player.ready = Boolean(isReady);
    syncBotReadiness(lobby);

    const active = getActiveParticipants(lobby);
    if (active.length >= 2 && active.every(p => p.ready)) {
        lobby.players.forEach(p => { p.ready = false; });
        startDealerDrawPhase(lobby);
    } else {
        broadcastLobbyUpdate(lobby.code);
    }
}

function checkNextHandReady(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.every(p => p.nextHandReady)) {
        startRound(lobby);
    }
}

function createLobby(code, name, hostUsername, isPrivate = false, defaultLives = 2) {
    lobbies[code] = {
        code,
        name: name || `${hostUsername}'s Table`,
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
        mainGameLedger: {},
        sideBetLedger: {},
        botBetLedger: {},
        activeBets: [],
        pendingBets: [],
        globalProposals: [],
        chatHistory: []
    };
    return lobbies[code];
}

function joinLobby(ws, code, username) {
    const lobby = lobbies[code];
    if (!lobby) return { success: false, message: 'Lobby does not exist.' };

    const existingPlayer = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (existingPlayer) {
        existingPlayer.id = ws;
        return { success: true, lobby, isSpectator: false };
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
            nextHandReady: false
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

function leaveLobby(ws, code) {
    const lobby = lobbies[code];
    if (!lobby) return;

    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = (lobby.spectators || []).filter(s => s.idSocket !== ws);

    if (lobby.players.filter(p => !p.isBot).length === 0) {
        delete lobbies[code];
        return;
    }

    establishDealer(lobby);
    broadcastLobbyUpdate(code);
}

function touchLobbyActivity(lobby) {
    if (lobby) lobby.lastActivity = Date.now();
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
    touchLobbyActivity,
    getPublicLobbiesList,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    startDealerDrawPhase,
    startRound,
    handlePoolCardSelection,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    checkNextHandReady,
    scheduleBotActions,
    handleSetReady,
    syncLifetimeLedgerBalances
};

