// server/game/lobbyManager.js - PART 1 OF 2
const WebSocket = require('ws');
const { createDeck, calculateScore, calculateBestFourCardScore } = require('./deck');
const { recordDebt, resolveFirstToLoseBets, resolveWinSideBets } = require('./ledger');
const { executeBotTurn, syncBotReadiness } = require('./bot');
const config = require('../config');

// Resilient Database Loader for Lifetime Ledger Integration
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

    const now = Date.now();
    const hasActiveHuman = lobby.players.some(p => {
        if (p.isBot) return false;
        if (p.id && p.id.readyState === WebSocket.OPEN) return true;
        if (p.disconnectedAt && (now - p.disconnectedAt < 90000)) return true;
        return false;
    });

    if (hasActiveHuman) return;

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
    const p = lobby.players.find(pl => pl.username && pl.username.toLowerCase() === username.toLowerCase());
    if (p && p.id && p.id.user && !p.id.user.isGuest && (p.id.user.id || p.id.user.userId)) {
        return p.id.user.id || p.id.user.userId;
    }

    const s = lobby.spectators.find(sp => sp.username && sp.username.toLowerCase() === username.toLowerCase());
    if (s && s.idSocket && s.idSocket.user && !s.idSocket.user.isGuest && (s.idSocket.user.id || s.idSocket.user.userId)) {
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
    if (!db || typeof db.recordLifetimeDebt !== 'function') return;

    if (!lobby.persistedLifetimeLedger) {
        lobby.persistedLifetimeLedger = { main: {}, side: {} };
    }

    const processCategory = (currentLedger, categoryKey) => {
        if (!currentLedger) return;
        if (!lobby.persistedLifetimeLedger[categoryKey]) {
            lobby.persistedLifetimeLedger[categoryKey] = {};
        }
        const persisted = lobby.persistedLifetimeLedger[categoryKey];

        for (const debtorName in currentLedger) {
            for (const creditorName in currentLedger[debtorName]) {
                const totalDebt = Number(currentLedger[debtorName][creditorName]) || 0;
                if (!persisted[debtorName]) persisted[debtorName] = {};
                const alreadyPersisted = Number(persisted[debtorName][creditorName]) || 0;

                const delta = totalDebt - alreadyPersisted;
                if (delta > 0) {
                    const debtorId = resolveUserId(lobby, debtorName);
                    const creditorId = resolveUserId(lobby, creditorName);

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
        ...lobby.spectators.map(s => s.idSocket)
    ].filter(ws => ws && ws.readyState === WebSocket.OPEN);

    allSockets.forEach(ws => {
        try {
            sendLifetimeLedger(ws);
        } catch (err) {}
    });
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
                const uid = ws?.user ? (ws.user.id || ws.user.userId) : (ws?.userId || null);
                if (ws && ws.readyState === WebSocket.OPEN && uid && (uid === debtorId || uid === creditorId)) {
                    try {
                        sendLifetimeLedger(ws);
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
    lobby.hit31Player = null;
    lobby.tournamentWinner = null;
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
                    syncLifetimeLedgerBalances(lobby);
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
// public/js/ui.js - Table DOM Coordinator, Card Rendering & Modals (PART 2 OF 2)

// -------------------------------------------------------------
// 6. DEALER CUT & TIE-BREAKER DRAW OVERLAY (2 ROWS OF 3 SHOWCASE)
// -------------------------------------------------------------
function renderDealerDrawOverlay(lobby) {
    const modal = document.getElementById('dealer-draw-modal') || document.getElementById('pool-draw-modal');
    if (!modal) return;

    if (lobby.gameState !== 'dealerDraw' && lobby.gameState !== 'tieBreaker') {
        modal.style.display = 'none';
        modal.classList.add('hidden');
        window.appGlobals.hasChosenPoolCard = false;
        return;
    }

    modal.style.display = 'flex';
    modal.classList.remove('hidden');

    const titleElem = document.getElementById('dealer-draw-title') || document.getElementById('pool-modal-title');
    const descElem = document.getElementById('dealer-draw-desc') || document.getElementById('pool-modal-instruction');

    if (lobby.gameState === 'tieBreaker') {
        if (titleElem) titleElem.innerText = 'TIE-BREAKER DRAW';
        if (descElem) descElem.innerText = 'Lowest card drawn loses a life! (Ace highest)';
    } else {
        if (titleElem) titleElem.innerText = 'DEALER CUT';
        if (descElem) descElem.innerText = 'Lowest card deals! (Ace highest)';
    }

    // Top Player Showcase: 2 rows of 3 (3 on top, 3 on bottom)
    const stream = document.getElementById('draw-results-stream') 
        || document.getElementById('draw-order-sequence') 
        || document.getElementById('draw-showcase-sidebar');

    if (stream) {
        const active = (lobby.players || []).filter(p => !p.eliminated);
        stream.innerHTML = active.map(p => {
            const pickedCard = lobby.drawResults && lobby.drawResults[p.username];
            if (pickedCard) {
                const isRed = (pickedCard.suit === '♥' || pickedCard.suit === '♦');
                return `
                    <div class="result-item draw-showcase-item">
                        <span class="draw-picker-badge">${p.username}</span>
                        <div class="mini-card ${isRed ? 'red-suit' : 'black-suit'}">
                            <span>${pickedCard.val}</span>
                            <span>${pickedCard.suit}</span>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div class="result-item draw-showcase-item">
                        <span class="draw-picker-badge">${p.username}</span>
                        <div class="draw-card-waiting">?</div>
                    </div>
                `;
            }
        }).join('');
    }

    // 52-Card Deck Selection Grid (7 columns by 8 rows to fit all 52 cards)
    const grid = document.getElementById('draw-pool-grid') || document.getElementById('pool-cards-container');
    if (grid && lobby.drawPool) {
        const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
        const hasPicked = Boolean(lobby.drawResults && lobby.drawResults[activeUsername]);
        const isTieBreaker = lobby.gameState === 'tieBreaker';
        const eligible = isTieBreaker 
            ? (lobby.tiedParticipantsList || []).includes(activeUsername)
            : active.some(p => p.username === activeUsername);

        grid.innerHTML = lobby.drawPool.map((item, idx) => {
            const isTaken = item.chosenBy !== null;
            const canClick = eligible && !hasPicked && !isTaken && !window.appGlobals.hasChosenPoolCard;
            return `
                <div class="card-pool-item ${isTaken ? 'taken' : ''}" 
                     onclick="${canClick ? `choosePoolCard(${idx})` : ''}">
                    ${isTaken ? '✓' : ''}
                </div>
            `;
        }).join('');
    }
}

// -------------------------------------------------------------
// 7. IN-GAME MASTER TABLE & SEAT PODIUM RENDERER
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    window.appGlobals.latestLobbySnapshot = lobby;
    window.clientState.gameState = lobby.gameState;

    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    if (gameView && gameView.style.display !== 'block' && gameView.style.display !== 'flex') {
        gameView.style.display = 'flex';
    }
    if (mainMenu) mainMenu.style.display = 'none';

    // Room info headers
    const roomCodeEl = document.getElementById('room-code-display') || document.getElementById('in-game-room-code');
    const tableNameEl = document.getElementById('in-game-table-name');
    if (roomCodeEl) roomCodeEl.textContent = lobby.code;
    if (tableNameEl) tableNameEl.textContent = lobby.name || `${lobby.code} Table`;

    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const isHost = (lobby.host && lobby.host.toLowerCase() === activeUsername.toLowerCase());

    const isSpectator = (lobby.spectators || []).some(s => (s.username || s).toLowerCase() === activeUsername.toLowerCase());
    const isSeated = (lobby.players || []).some(p => p.username.toLowerCase() === activeUsername.toLowerCase());
    window.clientState.isSpectator = isSpectator;

    // Spectator counter & tools
    const specCount = document.getElementById('spec-count');
    if (specCount) specCount.textContent = (lobby.spectators || []).length;

    const sitBtn = document.getElementById('sit-btn');
    const standUpBtn = document.getElementById('stand-up-btn');
    const readyBtn = document.getElementById('ready-btn');

    if (sitBtn) sitBtn.style.display = (isSpectator && lobby.gameState === 'lobby' && lobby.players.length < 6) ? 'inline-block' : 'none';
    if (standUpBtn) standUpBtn.style.display = (isSeated && lobby.gameState === 'lobby') ? 'inline-block' : 'none';
    if (readyBtn) readyBtn.style.display = isSpectator ? 'none' : 'inline-block';

    // Host table config panel
    const hostControls = document.getElementById('host-controls') || document.getElementById('lobby-config-bar');
    if (hostControls) {
        hostControls.style.display = (isHost && lobby.gameState === 'lobby') ? 'flex' : 'none';
    }

    // Dealer draw modal watcher
    renderDealerDrawOverlay(lobby);

    // Phase messages and notifications
    const phaseBanner = document.getElementById('center-notification-banner');
    if (phaseBanner && lobby.phaseMessage && lobby.gameState !== 'dealerDraw') {
        if (lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
            window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
            window.showCenterNotification(lobby.phaseMessage);
        }
    }

    // Felt center deck & discard pile
    const discardSlot = document.getElementById('felt-discard-slot') || document.getElementById('discard-pile');
    if (discardSlot) {
        if (lobby.discardTop) {
            discardSlot.innerHTML = window.formatCardHtml(lobby.discardTop);
            discardSlot.onclick = () => window.drawFromDiscard();
        } else {
            discardSlot.innerHTML = '<div class="empty-discard-box">Empty</div>';
            discardSlot.onclick = null;
        }
    }

    const deckSlot = document.getElementById('felt-deck-slot') || document.getElementById('draw-deck');
    if (deckSlot) {
        deckSlot.onclick = () => window.drawFromDeck();
    }

    // Render seats around felt oval
    renderTableSeats(lobby, activeUsername);

    // Render user hand
    const me = (lobby.players || []).find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
    renderLocalPlayerHand(me, lobby);

    // Next Hand Ready overlay
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (nextHandOverlay) {
        const showNext = (lobby.gameState === 'roundOver' && me && !me.eliminated && !me.nextHandReady);
        nextHandOverlay.style.display = showNext ? 'flex' : 'none';
    }
};

function renderTableSeats(lobby, activeUsername) {
    const tableSeatsContainer = document.getElementById('seats-container') || document.getElementById('table-seats');
    if (!tableSeatsContainer) return;

    const players = lobby.players || [];
    let html = '';

    for (let i = 0; i < 6; i++) {
        const player = players.find(p => p.seat === i) || players[i];
        if (player) {
            const isTurn = (lobby.turnIndex !== undefined && lobby.players[lobby.turnIndex]?.username === player.username && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn'));
            const isDealer = (lobby.dealerName === player.username || lobby.dealerIndex === i);
            const isMe = (player.username.toLowerCase() === activeUsername.toLowerCase());
            const livesIcons = '❤️'.repeat(Math.max(0, player.lives || 0));

            html += `
                <div class="seat-podium seat-${i} ${isTurn ? 'active-turn' : ''} ${player.eliminated ? 'eliminated' : ''}">
                    <div class="player-badge ${isMe ? 'local-player' : ''}">
                        <span class="seat-name">${player.username} ${isDealer ? '👑' : ''}</span>
                        <span class="seat-lives">${livesIcons}</span>
                        ${player.ready && lobby.gameState === 'lobby' ? '<span class="ready-badge">READY</span>' : ''}
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="seat-podium seat-${i} empty-seat">
                    <div class="empty-badge">Open</div>
                </div>
            `;
        }
    }

    tableSeatsContainer.innerHTML = html;
}

function renderLocalPlayerHand(me, lobby) {
    const handContainer = document.getElementById('player-cards-container') || document.getElementById('my-hand');
    const scoreDisplay = document.getElementById('my-score-display') || document.getElementById('hand-score');
    if (!handContainer) return;

    if (!me || !me.cards || me.cards.length === 0 || me.eliminated) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.textContent = 'Score: 0';
        return;
    }

    const isMyTurn = (lobby.turnIndex !== undefined && lobby.players[lobby.turnIndex]?.username === me.username && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn'));
    const canDiscard = (isMyTurn && me.cards.length === 4);

    handContainer.innerHTML = me.cards.map((c, idx) => {
        return `
            <div class="hand-card-wrapper ${canDiscard ? 'clickable-card' : ''}" 
                 onclick="${canDiscard ? `discardCard(${idx})` : ''}">
                ${window.formatCardHtml(c)}
            </div>
        `;
    }).join('');

    if (scoreDisplay) {
        scoreDisplay.textContent = `Score: ${window.calculateLocalScore(me.cards)}`;
    }
}

// -------------------------------------------------------------
// 8. GLOBAL EXPORTS
// -------------------------------------------------------------
window.renderDealerDrawOverlay = renderDealerDrawOverlay;
window.renderLobbyState = window.updateUIFromLobby;
