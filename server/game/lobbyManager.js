// server/game/lobbyManager.js

const db = require('../db');

const lobbies = {};

function getLobbies() {
    return lobbies;
}

function createDeck() {
    const suits = ['H', 'D', 'C', 'S'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let val of values) {
            deck.push({ suit, value: val });
        }
    }
    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getCardNumericValue(card) {
    if (!card) return 0;
    if (['J', 'Q', 'K'].includes(card.value)) return 10;
    if (card.value === 'A') return 11;
    return parseInt(card.value, 10) || 0;
}

function calculateScore(cards) {
    if (!cards || cards.length === 0) return 0;
    const suitSums = { H: 0, D: 0, C: 0, S: 0 };
    
    cards.forEach(c => {
        const val = getCardNumericValue(c);
        suitSums[c.suit] = (suitSums[c.suit] || 0) + val;
    });

    let maxScore = 0;
    Object.keys(suitSums).forEach(suit => {
        if (suitSums[suit] > maxScore) {
            maxScore = suitSums[suit];
        }
    });

    const valueCounts = {};
    cards.forEach(c => {
        valueCounts[c.value] = (valueCounts[c.value] || 0) + 1;
    });

    Object.keys(valueCounts).forEach(val => {
        if (valueCounts[val] >= 3) {
            if (30 > maxScore) maxScore = 30;
        }
    });

    return maxScore;
}

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    const takenSeats = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) {
        if (!takenSeats.includes(i)) return i;
    }
    return 0;
}

function getSanitizedLobby(lobby, username) {
    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        isPrivate: lobby.isPrivate,
        gameState: lobby.gameState,
        defaultLives: lobby.defaultLives,
        wager: lobby.wager || 5,
        phaseMessage: lobby.phaseMessage || '',
        turnIndex: lobby.turnIndex,
        currentTurnUser: lobby.currentTurnUser,
        discardPile: lobby.discardPile,
        drawPool: lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker' ? lobby.drawPool : [],
        players: lobby.players.map(p => ({
            username: p.username,
            lives: p.lives,
            wager: p.wager,
            ready: p.ready,
            seat: p.seat,
            eliminated: p.eliminated,
            isBot: p.isBot,
            inVC: p.inVC,
            isMuted: p.isMuted,
            hasDrawnThisTurn: p.hasDrawnThisTurn,
            cardCount: p.cards ? p.cards.length : 0,
            cards: (p.username.toLowerCase() === username.toLowerCase() || lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd') ? p.cards : p.cards.map(() => ({ hidden: true }))
        })),
        spectators: lobby.spectators || [],
        chatHistory: lobby.chatHistory || []
    };
}

function broadcastLobbyUpdate(code) {
    const lobby = lobbies[code];
    if (!lobby) return;
    
    lobby.players.forEach(p => {
        if (p.id && p.id.readyState === 1) {
            p.id.send(JSON.stringify({
                type: 'LOBBY_UPDATE',
                lobby: getSanitizedLobby(lobby, p.username)
            }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket && s.idSocket.readyState === 1) {
            s.idSocket.send(JSON.stringify({
                type: 'LOBBY_UPDATE',
                lobby: getSanitizedLobby(lobby, s.username)
            }));
        }
    });
}

function getPublicLobbiesList() {
    const list = [];
    Object.values(lobbies).forEach(l => {
        if (!l.isPrivate && l.gameState === 'lobby') {
            list.push({
                code: l.code,
                name: l.name,
                host: l.host,
                playerCount: l.players.length,
                maxPlayers: 6
            });
        }
    });
    return list;
}

function establishDealer(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length === 0) return;
    if (lobby.dealerIndex >= active.length) {
        lobby.dealerIndex = 0;
    }
}

function startDealerDrawPhase(lobby) {
    lobby.gameState = 'dealerDraw';
    const deck = createDeck();
    const active = getActiveParticipants(lobby);
    lobby.drawPool = active.map(() => ({
        card: deck.pop(),
        chosenBy: null
    }));
    lobby.drawResults = {};
    lobby.phaseMessage = 'Dealer Draw Phase: Choose a card from the pool.';
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.gameState !== 'dealerDraw' && lobby.gameState !== 'tieBreaker') return;
    if (cardIndex < 0 || cardIndex >= lobby.drawPool.length) return;
    
    const poolItem = lobby.drawPool[cardIndex];
    if (poolItem.chosenBy !== null) return;

    poolItem.chosenBy = username;
    lobby.drawResults[username] = poolItem.card;

    const activeCount = lobby.gameState === 'dealerDraw' ? getActiveParticipants(lobby).length : lobby.tiedParticipantsList.length;

    if (Object.keys(lobby.drawResults).length >= activeCount) {
        if (lobby.gameState === 'dealerDraw') {
            let lowestPlayer = null;
            let minVal = 999;
            Object.entries(lobby.drawResults).forEach(([uname, card]) => {
                const val = getCardNumericValue(card);
                if (val < minVal) {
                    minVal = val;
                    lowestPlayer = uname;
                }
            });
            const dealerIdx = getActiveParticipants(lobby).findIndex(p => p.username === lowestPlayer);
            if (dealerIdx !== -1) lobby.dealerIndex = dealerIdx;

            setTimeout(() => startRound(lobby), 2500);
        } else if (lobby.gameState === 'tieBreaker') {
            setTimeout(() => resolveTieBreakerOutcome(lobby), 2500);
        }
    } else {
        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
    }
}

function startRound(lobby) {
    lobby.gameState = 'playing';
    lobby.hit31Player = null;
    lobby.knockedBy = null;
    lobby.turnsTakenThisRound = 0;
    lobby.deck = createDeck();
    lobby.discardPile = [lobby.deck.pop()];

    const active = getActiveParticipants(lobby);
    active.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.hasDrawnThisTurn = false;
    });

    const dealerPlayer = active[lobby.dealerIndex] || active[0];
    const dealerActiveIdx = active.indexOf(dealerPlayer);
    const firstTurnActiveIdx = (dealerActiveIdx + 1) % active.length;
    const firstTurnPlayer = active[firstTurnActiveIdx];
    lobby.turnIndex = lobby.players.findIndex(p => p.username === firstTurnPlayer.username);
    lobby.currentTurnUser = lobby.players[lobby.turnIndex].username;

    lobby.phaseMessage = `${lobby.currentTurnUser}'s turn to draw.`;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleDrawDeck(lobby, username) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const active = getActiveParticipants(lobby);
    const curPlayer = active[lobby.turnIndex];
    if (!curPlayer || curPlayer.username.toLowerCase() !== username.toLowerCase()) return;
    if (curPlayer.hasDrawnThisTurn) return;

    if (!lobby.deck || lobby.deck.length === 0) {
        lobby.deck = createDeck();
    }

    curPlayer.cards.push(lobby.deck.pop());
    curPlayer.hasDrawnThisTurn = true;
    lobby.phaseMessage = `${username} drew from deck. Discard a card.`;
    broadcastLobbyUpdate(lobby.code);
}

function handleDiscardPickup(lobby, username, fromDiscard) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const active = getActiveParticipants(lobby);
    const curPlayer = active[lobby.turnIndex];
    if (!curPlayer || curPlayer.username.toLowerCase() !== username.toLowerCase()) return;
    if (curPlayer.hasDrawnThisTurn) return;

    if (fromDiscard) {
        if (!lobby.discardPile || lobby.discardPile.length === 0) return;
        curPlayer.cards.push(lobby.discardPile.pop());
    } else {
        if (!lobby.deck || lobby.deck.length === 0) lobby.deck = createDeck();
        curPlayer.cards.push(lobby.deck.pop());
    }

    curPlayer.hasDrawnThisTurn = true;
    lobby.phaseMessage = `${username} picked a card. Discard one!`;
    broadcastLobbyUpdate(lobby.code);
}

function handleDiscardAction(lobby, username, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const active = getActiveParticipants(lobby);
    const curPlayer = active[lobby.turnIndex];
    if (!curPlayer || curPlayer.username.toLowerCase() !== username.toLowerCase()) return;
    if (!curPlayer.hasDrawnThisTurn) return;

    if (cardIndex < 0 || cardIndex >= curPlayer.cards.length) return;
    const discarded = curPlayer.cards.splice(cardIndex, 1)[0];
    lobby.discardPile.push(discarded);
    curPlayer.hasDrawnThisTurn = false;

    const score = calculateScore(curPlayer.cards);
    if (score === 31) {
        lobby.hit31Player = curPlayer.username;
        triggerRoundOver(lobby, `${curPlayer.username} hit 31 instantly!`);
        return;
    }

    lobby.turnsTakenThisRound++;

    let nextActiveIdx = (active.indexOf(curPlayer) + 1) % active.length;
    const nextActivePlayer = active[nextActiveIdx];
    lobby.turnIndex = lobby.players.findIndex(p => p.username === nextActivePlayer.username);

    if (lobby.gameState === 'finalTurn') {
        lobby.finalTurnsRemaining--;
        if (lobby.finalTurnsRemaining <= 0) {
            resolveRoundOutcome(lobby);
            return;
        }
    }

    lobby.currentTurnUser = lobby.players[lobby.turnIndex].username;
    lobby.phaseMessage = `${lobby.currentTurnUser}'s turn.`;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleKnock(lobby, username) {
    if (lobby.gameState !== 'playing') return;
    const active = getActiveParticipants(lobby);
    const curPlayer = active[lobby.turnIndex];
    if (!curPlayer || curPlayer.username.toLowerCase() !== username.toLowerCase()) return;
    if (lobby.turnsTakenThisRound < active.length) return;

    lobby.knockedBy = username;
    lobby.gameState = 'finalTurn';
    lobby.finalTurnsRemaining = active.length - 1;
    lobby.phaseMessage = `${username} knocked! One final turn for remaining players.`;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function triggerRoundOver(lobby, msg) {
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    resolveRoundOutcome(lobby);
}

function resolveRoundOutcome(lobby) {
    lobby.gameState = 'roundOver';
    const active = getActiveParticipants(lobby);
    let lowestScore = 999;
    let lowestPlayers = [];

    active.forEach(p => {
        const sc = calculateScore(p.cards);
        p.lastRoundScore = sc;
        if (sc < lowestScore) {
            lowestScore = sc;
            lowestPlayers = [p];
        } else if (sc === lowestScore) {
            lowestPlayers.push(p);
        }
    });

    if (lowestPlayers.length > 1) {
        lobby.gameState = 'tieBreaker';
        lobby.tiedParticipantsList = lowestPlayers.map(p => p.username);
        const deck = createDeck();
        lobby.drawPool = deck.map(c => ({ card: c, chosenBy: null }));
        lobby.drawResults = {};
        lobby.phaseMessage = `Tie for lowest score (${lowestScore})! Tie-breaker draw required.`;
        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
        return;
    }

    const loser = lowestPlayers[0];
    loser.lives = Math.max(0, loser.lives - 1);
    if (loser.lives <= 0 && !loser.eliminated) {
        loser.eliminated = true;
        syncLifetimeLedgerBalances(lobby);
        if (loser.id && typeof loser.id === 'object') {
            lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
        }
    }

    const surviving = getActiveParticipants(lobby);
    if (surviving.length <= 1) {
        lobby.gameState = 'tournamentEnd';
        lobby.tournamentWinner = surviving.length === 1 ? surviving[0].username : 'Nobody';
        lobby.phaseMessage = `🏆 Tournament Over! Winner: ${lobby.tournamentWinner}`;
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    lobby.phaseMessage = `${loser.username} had the lowest score (${lowestScore}) and lost a life!`;
    broadcastLobbyUpdate(lobby.code);

    setTimeout(() => {
        if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'roundOver') {
            resetLobbyToReadyRoom(lobbies[lobby.code]);
        }
    }, 8000);
}

function resolveTieBreakerOutcome(lobby) {
    let lowestVal = 999;
    let tiedLoser = null;
    Object.entries(lobby.drawResults).forEach(([uname, card]) => {
        const val = getCardNumericValue(card);
        if (val < lowestVal) {
            lowestVal = val;
            tiedLoser = uname;
        }
    });

    const loser = lobby.players.find(p => p.username === tiedLoser);
    if (loser) {
        loser.lives = Math.max(0, loser.lives - 1);
        if (loser.lives <= 0 && !loser.eliminated) {
            loser.eliminated = true;
            syncLifetimeLedgerBalances(lobby);
        }
    }

    const surviving = getActiveParticipants(lobby);
    if (surviving.length <= 1) {
        lobby.gameState = 'tournamentEnd';
        lobby.tournamentWinner = surviving.length === 1 ? surviving[0].username : 'Nobody';
        lobby.phaseMessage = `🏆 Tournament Over! Winner: ${lobby.tournamentWinner}`;
        broadcastLobbyUpdate(lobby.code);
        return;
    }

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `${loser.username} lost the tie-breaker draw and lost a life!`;
    broadcastLobbyUpdate(lobby.code);

    setTimeout(() => {
        if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'roundOver') {
            resetLobbyToReadyRoom(lobbies[lobby.code]);
        }
    }, 8000);
}

function resetLobbyToReadyRoom(lobby) {
    lobby.gameState = 'lobby';
    lobby.phaseMessage = 'Waiting for players to ready up...';
    lobby.deck = [];
    lobby.discardPile = [];
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.turnsTakenThisRound = 0;

    lobby.players.forEach(p => {
        p.ready = false;
        p.cards = [];
        p.hasDrawnThisTurn = false;
    });

    broadcastLobbyUpdate(lobby.code);
}

function syncLifetimeLedgerBalances(lobby) {
    try {
        lobby.players.forEach(p => {
            if (p.id && typeof db !== 'undefined' && db.recordLifetimeDebt) {
                // DB synchronization hook
            }
        });
    } catch (e) {
        console.warn("Ledger sync error:", e);
    }
}

function sendLifetimeLedger(ws, username) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: 'LIFETIME_LEDGER_DATA',
            balances: {}
        }));
    }
}

function scheduleBotActions(lobby) {
    if (!lobby || (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn' && lobby.gameState !== 'dealerDraw')) return;
    if (lobby.gameState === 'dealerDraw') {
        lobby.players.forEach(p => {
            if (p.isBot && !p.eliminated && !lobby.drawResults[p.username]) {
                setTimeout(() => {
                    const cur = lobbies[lobby.code];
                    if (!cur || cur.gameState !== 'dealerDraw' || cur.drawResults[p.username]) return;
                    const unchosen = cur.drawPool.filter(c => c.chosenBy === null);
                    if (unchosen.length > 0) {
                        const pickIdx = cur.drawPool.indexOf(unchosen[0]);
                        handlePoolCardSelection(cur, p.username, pickIdx);
                    }
                }, 800);
            }
        });
        return;
    }

    const active = getActiveParticipants(lobby);
    const curPlayer = active[lobby.turnIndex];
    if (!curPlayer || !curPlayer.isBot || curPlayer.eliminated) return;

    setTimeout(() => {
        const cur = lobbies[lobby.code];
        if (!cur || (cur.gameState !== 'playing' && cur.gameState !== 'finalTurn')) return;
        const currentBot = getActiveParticipants(cur)[cur.turnIndex];
        if (!currentBot || !currentBot.isBot || currentBot.username !== curPlayer.username) return;

        if (!cur.deck || cur.deck.length === 0) cur.deck = createDeck();
        currentBot.cards.push(cur.deck.pop());
        currentBot.hasDrawnThisTurn = true;

        setTimeout(() => {
            if (currentBot.cards.length === 4) {
                const discIdx = Math.floor(Math.random() * currentBot.cards.length);
                const discarded = currentBot.cards.splice(discIdx, 1)[0];
                cur.discardPile.push(discarded);
            }
            currentBot.hasDrawnThisTurn = false;

            const score = calculateScore(currentBot.cards);
            if (score === 31) {
                cur.hit31Player = currentBot.username;
                triggerRoundOver(cur, `${currentBot.username} hit 31 instantly!`);
                return;
            }

            cur.turnsTakenThisRound++;
            let nextActiveIdx = (getActiveParticipants(cur).indexOf(currentBot) + 1) % getActiveParticipants(cur).length;
            cur.turnIndex = cur.players.findIndex(p => p.username === getActiveParticipants(cur)[nextActiveIdx].username);

            if (cur.gameState === 'finalTurn') {
                cur.finalTurnsRemaining--;
                if (cur.finalTurnsRemaining <= 0) {
                    resolveRoundOutcome(cur);
                    return;
                }
            }

            cur.currentTurnUser = cur.players[cur.turnIndex].username;
            cur.phaseMessage = `${cur.currentTurnUser}'s turn.`;
            broadcastLobbyUpdate(cur.code);
            scheduleBotActions(cur);
        }, 800);
    }, 1000);
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
        turnIndex: 0,
        dealerIndex: 0,
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
        existingPlayer.disconnectedAt = null;
        return { success: true, lobby, isSpectator: false };
    }

    const existingSpec = lobby.spectators.find(s => s.username.toLowerCase() === username.toLowerCase());
    if (existingSpec) {
        existingSpec.idSocket = ws;
        existingSpec.disconnectedAt = null;
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
            isMuted: true
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

    if (lobby.players.filter(p => !p.isBot).length === 0 && lobby.spectators.length === 0) {
        delete lobbies[code];
        return;
    }

    establishDealer(lobby);
    broadcastLobbyUpdate(code);
}

function handleSetReady(lobby, username, isReady) {
    if (lobby.gameState !== 'lobby') return;
    const player = lobby.players.find(p => p.username === username);
    if (!player) return;

    player.ready = Boolean(isReady);
    const active = getActiveParticipants(lobby);
    if (active.length >= 2 && active.every(p => p.ready)) {
        lobby.players.forEach(p => { p.ready = false; });
        startDealerDrawPhase(lobby);
    } else {
        broadcastLobbyUpdate(lobby.code);
    }
}

function handleSitDown(ws, lobby, username) {
    if (lobby.gameState !== 'lobby') return;
    const existing = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (existing) return;

    if (lobby.players.length < 6) {
        lobby.spectators = lobby.spectators.filter(s => s.username.toLowerCase() !== username.toLowerCase());
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
            isMuted: true
        });
        broadcastLobbyUpdate(lobby.code);
    }
}

function handleStandUp(ws, lobby, username) {
    if (lobby.gameState !== 'lobby') return;
    lobby.players = lobby.players.filter(p => p.username.toLowerCase() !== username.toLowerCase());
    lobby.spectators.push({
        idSocket: ws,
        username,
        inVC: false,
        isMuted: true
    });
    broadcastLobbyUpdate(lobby.code);
}

function updateSettings(lobby, username, lives) {
    if (lobby.gameState !== 'lobby' || lobby.host.toLowerCase() !== username.toLowerCase()) return;
    lobby.defaultLives = parseInt(lives, 10) || 2;
    lobby.players.forEach(p => { if (!p.isBot) p.lives = lobby.defaultLives; });
    broadcastLobbyUpdate(lobby.code);
}

function updateWager(lobby, username, wager) {
    if (lobby.gameState !== 'lobby' || lobby.host.toLowerCase() !== username.toLowerCase()) return;
    lobby.wager = parseInt(wager, 10) || 5;
    lobby.players.forEach(p => { p.wager = lobby.wager; });
    broadcastLobbyUpdate(lobby.code);
}

function handleAddBot(lobby, username) {
    if (lobby.gameState !== 'lobby' || lobby.host.toLowerCase() !== username.toLowerCase() || lobby.players.length >= 6) return;
    const seat = findOpenSeat(lobby);
    const botCount = lobby.players.filter(p => p.isBot).length + 1;
    lobby.players.push({
        id: null,
        username: `Bot_${botCount}`,
        lives: lobby.defaultLives || 2,
        wager: lobby.wager || 5,
        cards: [],
        ready: true,
        seat,
        eliminated: false,
        isBot: true,
        inVC: false,
        isMuted: true
    });
    broadcastLobbyUpdate(lobby.code);
}

function handleRemoveBot(lobby, username) {
    if (lobby.gameState !== 'lobby' || lobby.host.toLowerCase() !== username.toLowerCase()) return;
    const botIndex = lobby.players.map((p, idx) => p.isBot ? idx : -1).filter(idx => idx !== -1).pop();
    if (botIndex !== undefined) {
        lobby.players.splice(botIndex, 1);
        broadcastLobbyUpdate(lobby.code);
    }
}

module.exports = {
    lobbies,
    getLobbies,
    createLobby,
    joinLobby,
    leaveLobby,
    getActiveParticipants,
    getPublicLobbiesList,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    startDealerDrawPhase,
    startRound,
    handlePoolCardSelection,
    handleSetReady,
    handleSitDown,
    handleStandUp,
    updateSettings,
    updateWager,
    handleAddBot,
    handleRemoveBot,
    handleDrawDeck,
    handleDiscardPickup,
    handleDiscardAction,
    handleKnock,
    resolveSessionAndLifetimeDebt: syncLifetimeLedgerBalances,
    syncLifetimeLedgerBalances,
    sendLifetimeLedger
};
