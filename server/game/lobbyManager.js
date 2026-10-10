// server/game/lobbyManager.js - PART 1 OF 2
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
    
    // 1. Check seated player's websocket auth session
    const p = lobby.players.find(pl => pl.username && pl.username.toLowerCase() === username.toLowerCase());
    if (p && p.id && p.id.user && !p.id.user.isGuest) {
        return p.id.user.id || p.id.user.userId;
    }

    // 2. Check spectator's websocket auth session
    const s = lobby.spectators.find(sp => sp.username && sp.username.toLowerCase() === username.toLowerCase());
    if (s && s.idSocket && s.idSocket.user && !s.idSocket.user.isGuest) {
        return s.idSocket.user.id || s.idSocket.user.userId;
    }

    // 3. Direct SQLite fallback lookup by username
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
// public/js/ui.js - PART 2 OF 2

// -------------------------------------------------------------
// 8. MASTER TABLE RENDER & SPECTATOR LOGIC
// -------------------------------------------------------------
window.updateUIFromLobby = window.renderLobbyState = function(lobby) {
    if (!lobby || !lobby.players) return;
    window.appGlobals = window.appGlobals || {};
    window.appGlobals.latestLobbySnapshot = lobby;

    const authScreen = document.getElementById('auth-screen');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const endBtn = document.getElementById('end-game-btn');
    const leaveBtn = document.getElementById('leave-lobby-btn');

    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    if (topRowBtns) topRowBtns.style.display = 'inline-flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (endBtn) endBtn.style.display = 'inline-block';
    if (leaveBtn) leaveBtn.style.display = 'inline-block';

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name || 'Table'} [${lobby.code || '----'}]`;

    if (lobby.chatHistory) {
        window.syncChatHistory(lobby.chatHistory);
    }

    const activeUsername = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
    const me = lobby.players.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
    const isSpectatorOnly = !me || me.eliminated;
    window.clientState.isSpectator = isSpectatorOnly;

    // A. NOTIFICATIONS BANNER
    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
        if (typeof window.showCenterNotification === 'function') {
            window.showCenterNotification(lobby.phaseMessage);
        }
    }

    // B. TURN AUDIO CUE & VIBRATION
    const isMyTurnPlaying = !isSpectatorOnly && 
        ((lobby.currentTurnUser || '').toLowerCase() === activeUsername.toLowerCase()) && 
        (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');

    if (isMyTurnPlaying) {
        if (!window.appGlobals.wasMyTurn) {
            window.appGlobals.wasMyTurn = true;
            if (typeof window.playYourTurnCue === 'function') {
                window.playYourTurnCue();
            } else {
                window.safePlaySound('yourturn');
            }
            window.safeVibrate([60, 40, 60]);
        }
    } else {
        window.appGlobals.wasMyTurn = false;
    }

    // C. 31 BLITZ & TOURNAMENT CELEBRATIONS
    if (lobby.hit31Player && lobby.hit31Player !== window.previous31Player) {
        window.previous31Player = lobby.hit31Player;
        if (typeof window.launchConfetti === 'function') window.launchConfetti();
        if (typeof window.showCenterNotification === 'function') {
            window.showCenterNotification(`⚡ ${lobby.hit31Player} hit 31!`);
        }
    } else if (!lobby.hit31Player) {
        window.previous31Player = null;
    }

    const isTournamentOver = (lobby.gameState === 'tournamentEnd') || (lobby.phaseMessage && lobby.phaseMessage.includes('TOURNAMENT WINNER'));
    if (isTournamentOver) {
        let winnerName = lobby.tournamentWinner || lobby.lastGameWinner;
        if (winnerName && window.appGlobals.lastCelebratedWinner !== winnerName) {
            window.appGlobals.lastCelebratedWinner = winnerName;
            if (typeof window.launchConfetti === 'function') window.launchConfetti();
        }
    } else if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
        window.appGlobals.lastCelebratedWinner = null;
    }

    // D. STATE TRANSITIONS
    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            const topleft = document.getElementById('discard-pickup-topleft-modal');
            const fedModal = document.getElementById('fed-card-topright-modal');
            if (topleft) topleft.style.display = 'none';
            if (fedModal) fedModal.style.display = 'none';
        }
    }

    // E. DEALER DRAW & TIE BREAKER MODALS (FIXED IDS)
    const dealerDrawModal = document.getElementById('dealer-draw-modal');
    const turnBanner = document.getElementById('turn-banner');

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        if (dealerDrawModal) dealerDrawModal.style.display = 'flex';

        const pTitle = document.getElementById('dealer-draw-title');
        const pInstr = document.getElementById('dealer-draw-status');
        
        if (lobby.gameState === 'dealerDraw') {
            if (pTitle) pTitle.innerText = 'Picking for Dealer';
            if (turnBanner) turnBanner.innerText = 'Dealer Draw Phase';
        } else {
            if (pTitle) pTitle.innerText = 'Tie-Breaker Draw';
            if (turnBanner) turnBanner.innerText = 'Tie-Breaker Draw';
        }

        if (pInstr) pInstr.innerText = lobby.phaseMessage || 'Lowest card deals (Ace highest). Tap any card!';

        const activeParts = lobby.gameState === 'dealerDraw'
            ? (lobby.players || []).filter(p => !p.eliminated)
            : (lobby.players || []).filter(p => (lobby.tiedParticipantsList || []).includes(p.username));

        let showcaseHtml = '';
        activeParts.forEach(p => {
            const card = lobby.drawResults?.[p.username];
            const isMe = (p.username.toLowerCase() === activeUsername.toLowerCase());
            showcaseHtml += `
                <div class="result-item" style="display:flex; flex-direction:column; align-items:center; background:rgba(4,20,13,0.95); border:1.5px solid ${isMe ? '#38bdf8' : 'rgba(212,175,55,0.55)'}; border-radius:6px; padding:4px 8px; margin: 4px;">
                    <span style="font-size:0.74rem; font-weight:800; color:${isMe ? '#38bdf8' : '#f6e05e'};">${p.username}${p.isBot ? ' 🤖' : ''}</span>
                    ${card ? window.formatCardHtml(card, false) : '<div style="width:38px; height:52px; border:1.5px dashed #64748b; display:flex; align-items:center; justify-content:center; font-size:0.6rem; color:#94a3b8; margin-top:2px;">Wait</div>'}
                </div>
            `;
        });

        const orderSequence = document.getElementById('draw-order-sequence');
        if (orderSequence) {
            orderSequence.innerHTML = `<div style="display:flex; flex-wrap:wrap; justify-content:center; gap:8px;">${showcaseHtml}</div>`;
        }

        let poolHtml = '';
        const drawPool = lobby.drawPool || [];
        drawPool.forEach((slot) => {
            if (slot.chosenBy) {
                poolHtml += `<div class="card-pool-item taken" style="opacity:0.22; background:#04140b; border:1px solid #143521; color:#10b981; width:100%; aspect-ratio:2/2.7; display:flex; align-items:center; justify-content:center; border-radius:3px; font-size:0.72rem; margin:1px;">✓</div>`;
            } else {
                const isTied = lobby.gameState === 'tieBreaker' ? (lobby.tiedParticipantsList || []).includes(activeUsername) : true;
                const clickable = !isSpectatorOnly && isTied && !lobby.drawResults?.[activeUsername] && !window.appGlobals.hasChosenPoolCard;
                poolHtml += `<div class="card-pool-item" ${clickable ? `onclick="choosePoolCard(${slot.index})"` : ''} style="${!clickable ? 'opacity:0.4; cursor:not-allowed;' : 'cursor:pointer;'} background:linear-gradient(135deg, #1d4ed8 0%, #0f172a 100%); border:1.5px solid #93c5fd; color:#fff; width:100%; aspect-ratio:2/2.7; display:flex; align-items:center; justify-content:center; border-radius:3px; font-weight:900; font-size:0.72rem; margin:1px;">?</div>`;
            }
        });

        const poolGrid = document.getElementById('draw-pool-grid');
        if (poolGrid) {
            poolGrid.innerHTML = `<div style="display:grid; grid-template-columns:repeat(11, 1fr); gap:2px; width:100%; max-width:460px; margin:0 auto;">${poolHtml}</div>`;
        }
    } else {
        if (dealerDrawModal) dealerDrawModal.style.display = 'none';
        if (turnBanner) {
            if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
                turnBanner.innerText = isMyTurnPlaying ? "YOUR TURN!" : `Turn: ${lobby.currentTurnUser}`;
            } else if (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd') {
                turnBanner.innerText = lobby.phaseMessage || 'Round Over';
            }
        }
    }

    // F. TOP IN-GAME FEEDS
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        if (topleftCardContent) {
            topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${window.formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
        }
        if (topleftModal) topleftModal.style.display = 'flex';
    } else if (topleftModal) {
        topleftModal.style.display = 'none';
    }

    const fedModal = document.getElementById('fed-card-topright-modal');
    const fedContent = document.getElementById('fed-card-content');
    const fedLabel = document.getElementById('fed-card-label');
    if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        if (fedLabel) fedLabel.innerText = `${lobby.myFedCardReminder.target} took your:`;
        if (fedContent) fedContent.innerHTML = window.formatCardHtml(lobby.myFedCardReminder.card, true);
        if (fedModal) fedModal.style.display = 'flex';
    } else if (fedModal) {
        fedModal.style.display = 'none';
    }

    // G. CENTER TABLE & DIAMOND-LATTICE DECK RENDER
    const tableContainer = document.getElementById('table-oval-container');
    if (tableContainer) {
        let discardSlotHtml = '';
        if (lobby.discardTop) {
            const dVal = lobby.discardTop.val || '';
            const dSuit = normalizeSuit(lobby.discardTop.suit);
            const dIsRed = (dSuit === '♥' || dSuit === '♦');
            const dClass = dIsRed ? 'red-suit' : 'black-suit';

            discardSlotHtml = `
                <div class="card-slot playing-card ${dClass}" onclick="drawCard('discard')">
                    <div class="card-corner top-left">
                        <span class="corner-val">${dVal}</span>
                        <span class="corner-suit">${dSuit}</span>
                    </div>
                    <div class="card-center-pip">${dSuit}</div>
                    <div class="card-corner bottom-right">
                        <span class="corner-val">${dVal}</span>
                        <span class="corner-suit">${dSuit}</span>
                    </div>
                </div>
            `;
        } else {
            discardSlotHtml = `<div class="card-slot empty-slot" onclick="drawCard('discard')"><span>DISCARD</span></div>`;
        }

        let html = `
            <div class="pots-container">
                <div class="pot-total-display" id="pot-total-banner">Pot: $${lobby.potTotal || 0}</div>
                <div class="side-pot-total-display" id="side-pot-total-banner" style="display:${lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none'};">Side Pots: $${lobby.sidePotTotal || 0}</div>
            </div>
            <div class="deck-center" id="deck-center">
                <div class="card-slot back" id="deck-pile" onclick="drawCard('deck')">
                    <div class="card-back-inner"></div>
                    <span class="deck-counter-badge" id="deck-count-display">${lobby.deckCount || 0} left</span>
                </div>
                ${discardSlotHtml}
            </div>
        `;

        (lobby.players || []).forEach((p, idx) => {
            const revealedCardsHtml = p.cards && p.cards.length > 0 ? `<div class="seat-cards">${p.cards.map(c => window.formatCardHtml(c, true)).join('')}</div>` : '';
            const statusBadge = p.eliminated ? ' [OUT]' : '';
            const readyStatusIcon = p.ready ? '✅' : '❌';
            const botBadge = p.isBot ? ' 🤖' : '';
            const isCurrent = (p.username.toLowerCase() === (lobby.currentTurnUser || '').toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
            const isDealer = (idx === lobby.dealerIndex) || (lobby.dealerName === p.username);
            const dealerBadgeHtml = isDealer ? `<span class="dealer-badge">D</span>` : '';
            const micIcon = p.inVC ? (p.isMuted ? ' 🔇' : ' 🎙️') : '';

            html += `
                <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}">
                    <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                        <span>${readyStatusIcon}</span> <b>${p.username}${botBadge}${statusBadge}</b>${dealerBadgeHtml}${micIcon}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                    </div>
                    ${revealedCardsHtml}
                </div>
            `;
        });

        tableContainer.innerHTML = html;
        const nextHandOverlay = document.getElementById('next-hand-overlay');
        if (nextHandOverlay) tableContainer.appendChild(nextHandOverlay);
    }

    // H. LOCAL HAND RENDERING WITH AUTHENTIC PLAYING CARDS
    const handContainer = document.getElementById('my-cards-container');
    const scoreDisplay = document.getElementById('my-score-display');
    const myHandTitle = document.getElementById('my-hand-title');
    const knockBtn = document.getElementById('knock-btn');

    if (isSpectatorOnly) {
        if (handContainer) handContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:12px;">👀 Spectator Mode</div>';
        if (scoreDisplay) scoreDisplay.innerText = '-';
        if (myHandTitle) myHandTitle.innerHTML = 'Spectating Table';
        if (knockBtn) knockBtn.style.display = 'none';
    } else if (me && me.cards && handContainer) {
        const currentScore = window.calculateLocalScore(me.cards);
        if (myHandTitle) myHandTitle.innerHTML = `My Hand (Score: <strong style="font-size: 1rem; color: var(--accent-gold);" id="my-score-display">${currentScore}</strong>)`;
        handContainer.innerHTML = me.cards.map((c, i) => {
            const val = c.val || '';
            const suit = normalizeSuit(c.suit);
            const isRed = (suit === '♥' || suit === '♦');
            const suitClass = isRed ? 'red-suit' : 'black-suit';

            return `
                <div class="my-card playing-card ${suitClass}" onclick="discardCard(${i})">
                    <div class="card-corner top-left">
                        <span class="corner-val">${val}</span>
                        <span class="corner-suit">${suit}</span>
                    </div>
                    <div class="card-center-pip">${suit}</div>
                    <div class="card-corner bottom-right">
                        <span class="corner-val">${val}</span>
                        <span class="corner-suit">${suit}</span>
                    </div>
                </div>
            `;
        }).join('');

        if (scoreDisplay) scoreDisplay.innerText = currentScore;
        
        if (knockBtn) {
            knockBtn.style.display = 'inline-block';
            const activeCount = lobby.activeParticipantsCount || 3;
            const threshold = activeCount > 2 ? 21 : 25;
            const turnsConditionMet = !!lobby.canKnock;
            const scoreConditionMet = currentScore >= threshold;
            const hasNotDrawn = me.cards.length === 3;

            if (lobby.knockedBy) {
                knockBtn.disabled = true;
                knockBtn.innerText = `${lobby.knockedBy} knocked!`;
            } else if (!turnsConditionMet || !scoreConditionMet || !isMyTurnPlaying || !hasNotDrawn) {
                knockBtn.disabled = true;
                knockBtn.innerText = `Knock (${threshold}+)`;
            } else {
                knockBtn.disabled = false;
                knockBtn.innerText = 'Knock!';
            }
        }
    } else if (handContainer) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.innerText = '0';
        if (knockBtn) knockBtn.style.display = 'none';
    }
};

// -------------------------------------------------------------
// 9. GLOBAL WINDOW BINDINGS
// -------------------------------------------------------------
window.drawCard = function(source) {
    if (window.clientState.isSpectator) return;
    window.safePlaySound('card');
    window.safeVibrate(40);
    sendSocket({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.drawFromDeck = () => window.drawCard('deck');
window.drawFromDiscard = () => window.drawCard('discard');

window.discardCard = function(cardIndex) {
    if (window.clientState.isSpectator) return;
    window.safePlaySound('card');
    window.safeVibrate(30);
    sendSocket({ type: 'DISCARD_CARD', index: cardIndex, cardIndex: cardIndex });
};

window.choosePoolCard = function(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    sendSocket({ type: 'CHOOSE_POOL_CARD', cardIndex: cardIndex });
    setTimeout(() => { window.appGlobals.hasChosenPoolCard = false; }, 1500); // Safety unlock
};

window.knockGame = window.knockRound = function() {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());

    if (!me || !me.cards || me.cards.length !== 3) {
        window.showCenterNotification("You cannot knock after picking up a card!");
        return;
    }

    const currentScore = window.calculateLocalScore(me.cards);
    const activeCount = window.appGlobals.latestLobbySnapshot?.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;

    if (currentScore < threshold) {
        window.showCenterNotification(`Need at least ${threshold} points to knock!`);
        return;
    }

    window.safePlaySound('knock');
    window.safeVibrate([180, 110, 180, 110, 180]);
    sendSocket({ type: 'KNOCK' });
};

window.clickNextHand = function() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    sendSocket({ type: 'NEXT_HAND_READY' });
    sendSocket({ type: 'NEXT_HAND' });
};

window.toggleReady = function() {
    window.clientState.isReady = !window.clientState.isReady;
    const btn = document.getElementById('ready-btn');
    if (btn) btn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    sendSocket({ type: 'SET_READY', ready: window.clientState.isReady });
};

window.standUp = function() { sendSocket({ type: 'STAND_UP' }); };
window.sitDown = function() { sendSocket({ type: 'SIT_DOWN' }); };
window.addBot = function() { sendSocket({ type: 'ADD_BOT' }); };
window.removeBot = function() { sendSocket({ type: 'REMOVE_BOT' }); };

window.updateWager = function() {
    const sel = document.getElementById('config-wager');
    if (sel) sendSocket({ type: 'UPDATE_WAGER', wager: parseInt(sel.value, 10) || 5 });
};

window.updateSettings = function() {
    const sel = document.getElementById('config-lives');
    if (sel) sendSocket({ type: 'UPDATE_SETTINGS', lives: parseInt(sel.value, 10) || 3 });
};

window.proposeEndGame = function() {
    if (confirm("Propose ending the game and returning to the lobby?")) {
        sendSocket({ type: 'END_GAME_PROPOSAL' });
    }
};

window.leaveLobby = function() {
    window.appGlobals.currentJoinedCode = null;
    localStorage.removeItem('blitz31_active_room');
    sendSocket({ type: 'LEAVE_LOBBY' });
    window.location.reload();
};
};
