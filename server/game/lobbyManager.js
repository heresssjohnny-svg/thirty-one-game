// server/game/lobbyManager.js - Lobby Lifecycle, Dealer Draw, Game Engine & Seat Management
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
const INACTIVITY_TIMEOUT_MS = 300000; // 5-minute lobby inactivity protection

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
    return -1;
}

function extractSocketUsername(wsId) {
    if (!wsId) return null;
    if (typeof wsId === 'string') return wsId.trim();
    return (wsId.currentUsername || wsId.user?.username || wsId.username || '').trim() || null;
}

function extractSocketUserId(ws) {
    if (!ws || typeof ws !== 'object') return null;
    const uid = (ws.user && !ws.user.isGuest && (ws.user.id || ws.user.userId)) || ws.userId || null;
    if (uid && !String(uid).startsWith('gst_')) return uid;
    return null;
}

function addSpectatorUnique(lobby, specObj) {
    if (!lobby || !specObj || !specObj.username) return;
    const cleanName = specObj.username.trim().toLowerCase();
    const existing = lobby.spectators.find(s =>
        (specObj.idSocket && s.idSocket === specObj.idSocket) ||
        (s.username && s.username.trim().toLowerCase() === cleanName)
    );
    const resolvedUid = specObj.userId || extractSocketUserId(specObj.idSocket);
    if (existing) {
        if (specObj.idSocket) existing.idSocket = specObj.idSocket;
        if (resolvedUid) existing.userId = resolvedUid;
        existing.inVC = specObj.inVC !== undefined ? specObj.inVC : existing.inVC;
        existing.isMuted = specObj.isMuted !== undefined ? specObj.isMuted : existing.isMuted;
    } else {
        lobby.spectators.push({
            idSocket: specObj.idSocket || null,
            userId: resolvedUid || null,
            username: specObj.username,
            inVC: !!specObj.inVC,
            isMuted: specObj.isMuted !== undefined ? specObj.isMuted : true
        });
    }
}

function touchLobbyActivity(lobby, broadcastLobbyList) {
    if (!lobby) return;
    if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
    lobby.inactivityTimer = setTimeout(() => closeInactiveLobby(lobby.code, broadcastLobbyList), INACTIVITY_TIMEOUT_MS);

    const now = Date.now();

    // 1. Check seated human players
    const hasSeatedHumans = lobby.players.some(p => {
        if (p.isBot) return false;
        if (p.id !== null) return true;
        if (p.disconnectedAt && (now - p.disconnectedAt < INACTIVITY_TIMEOUT_MS)) return true;
        return false;
    });

    // 2. Also check human spectators so standing up doesn't delete the table
    const hasSpectatorHumans = (lobby.spectators || []).some(s => {
        if (s.idSocket !== null) return true;
        if (s.disconnectedAt && (now - s.disconnectedAt < INACTIVITY_TIMEOUT_MS)) return true;
        return false;
    });

    const hasActiveHumans = hasSeatedHumans || hasSpectatorHumans;

    if (!hasActiveHumans) {
        delete lobbies[lobby.code];
        if (typeof broadcastLobbyList === 'function') broadcastLobbyList();
    }
}

function closeInactiveLobby(code, broadcastLobbyList) {
    const lobby = lobbies[code];
    if (!lobby) return;

    const now = Date.now();
    const hasSeated = lobby.players.some(p => {
        if (p.isBot) return false;
        if (p.id && p.id.readyState === WebSocket.OPEN) return true;
        if (p.disconnectedAt && (now - p.disconnectedAt < INACTIVITY_TIMEOUT_MS)) return true;
        return false;
    });

    const hasSpec = (lobby.spectators || []).some(s => {
        if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) return true;
        if (s.disconnectedAt && (now - s.disconnectedAt < INACTIVITY_TIMEOUT_MS)) return true;
        return false;
    });

    if (hasSeated || hasSpec) return;

    const closePayload = JSON.stringify({ type: 'ERROR', message: 'Lobby closed due to inactivity.' });
    lobby.players.forEach(p => {
        clearReadyCountdown(p);
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

// -------------------------------------------------------------
// MID-GAME FORFEIT TRACKER (KEEPS BUY-IN IN POT & CHARGES LOSER)
// -------------------------------------------------------------

function recordForfeitedPlayer(lobby, player) {
    if (!lobby || !player || player.isBot) return;
    const isGameActive = lobby.gameState !== 'lobby' && lobby.gameState !== 'tournamentEnd';
    if (!isGameActive) return;

    if (!lobby.forfeitedPlayers) lobby.forfeitedPlayers = [];
    const cleanName = (player.username || '').trim().toLowerCase();
    if (!cleanName) return;

    const uid = player.userId || extractSocketUserId(player.id) || resolveUserId(lobby, player.username);
    const existing = lobby.forfeitedPlayers.find(fp => fp.username && fp.username.toLowerCase() === cleanName);

    if (existing) {
        existing.wager = Number(player.wager) || existing.wager || 5;
        if (uid) existing.userId = uid;
    } else {
        lobby.forfeitedPlayers.push({
            username: player.username,
            userId: uid || null,
            wager: Number(player.wager) || 5,
            isBot: false
        });
    }

    // Leaving mid-game before elimination counts as losing all lives for "First to Lose" side bets
    if (!player.eliminated) {
        player.lives = 0;
        player.eliminated = true;
        resolveFirstToLoseBets(lobby, player.username);
        syncLifetimeLedgerBalances(lobby);
    }
}

// -------------------------------------------------------------
// 1. LOBBY 30-SECOND READY-UP TIMEOUT CONTROLLER
// -------------------------------------------------------------

function clearReadyCountdown(player) {
    if (player && player.readyTimeout) {
        clearTimeout(player.readyTimeout);
        player.readyTimeout = null;
    }
}

function startReadyCountdown(lobby, player) {
    if (!lobby || lobby.gameState !== 'lobby' || !player || player.isBot) return;
    clearReadyCountdown(player);

    player.readyTimeout = setTimeout(() => {
        const curLobby = lobbies[lobby.code];
        if (!curLobby || curLobby.gameState !== 'lobby') return;

        const target = curLobby.players.find(p => p.username && p.username.toLowerCase() === (player.username || '').toLowerCase());
        if (target && !target.ready) {
            clearReadyCountdown(target);
            handleStandUp(curLobby, target.id, target.username);
            curLobby.phaseMessage = `⏱️ ${target.username} timed out after 30s and was moved to spectator mode.`;
            broadcastLobbyUpdate(curLobby.code);
        }
    }, 30000); // 30 seconds
}

// -------------------------------------------------------------
// 2. TURN INACTIVITY TIMER & LEVEL 8/10 AI DECISION ENGINE
// -------------------------------------------------------------

function clearTurnTimer(lobby) {
    if (lobby && lobby.turnTimeoutTimer) {
        clearTimeout(lobby.turnTimeoutTimer);
        lobby.turnTimeoutTimer = null;
    }
}

function resetTurnTimer(lobby) {
    if (!lobby) return;
    clearTurnTimer(lobby);

    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;

    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated) return;

    // Only apply timer to human players
    if (!currentPlayer.isBot) {
        lobby.turnTimeoutTimer = setTimeout(() => {
            const curLobby = lobbies[lobby.code];
            if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
            const p = curLobby.players[curLobby.turnIndex];
            if (!p || p.username !== currentPlayer.username) return;

            curLobby.phaseMessage = `🤖 ${p.username} ran out of time! AI Level 8 played for them.`;
            executeLevel8AITurn(curLobby, p);
            broadcastLobbyUpdate(curLobby.code);
        }, 25000); // 25 seconds turn timeout
    }
}

function executeLevel8AITurn(lobby, player) {
    if (!lobby || !player || player.eliminated) return;

    const cards = player.cards || [];
    const active = getActiveParticipants(lobby);
    const currentScore = calculateScore(cards);

    // If player already drew and holds 4 cards: pick the optimal discard
    if (cards.length === 4) {
        let bestDiscardIdx = 0;
        let highestSubScore = -1;
        for (let i = 0; i < 4; i++) {
            const subHand = cards.filter((_, idx) => idx !== i);
            const score = calculateScore(subHand);
            if (score > highestSubScore) {
                highestSubScore = score;
                bestDiscardIdx = i;
            }
        }
        handleDiscardAction(lobby, player.id || player.username, bestDiscardIdx);
        return;
    }

    // LEVEL 8 KNOCK EVALUATION (Before drawing) - Must be >= 25 in 2-player games to match handleKnock
    const canKnock = lobby.gameState === 'playing' 
        && !lobby.knockedBy 
        && cards.length === 3 
        && (lobby.turnsTakenThisRound || 0) >= active.length;

    const knockThreshold = active.length > 2 ? 26 : 25;
    if (canKnock && currentScore >= knockThreshold) {
        handleKnock(lobby, player.id || player.username);
        return;
    }

    // LEVEL 8 DRAW DECISION: Discard vs Center Deck
    const topDiscard = (lobby.discardPile && lobby.discardPile.length > 0)
        ? lobby.discardPile[lobby.discardPile.length - 1]
        : null;

    let shouldDrawDiscard = false;
    if (topDiscard && cards.length === 3) {
        let bestScoreWithDiscard = 0;
        for (let i = 0; i < 3; i++) {
            const testHand = cards.filter((_, idx) => idx !== i).concat([topDiscard]);
            bestScoreWithDiscard = Math.max(bestScoreWithDiscard, calculateScore(testHand));
        }
        if (bestScoreWithDiscard > currentScore) {
            shouldDrawDiscard = true;
        }
    }

    // 1. Draw Card
    handleTurnAction(lobby, player.id || player.username, shouldDrawDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK');

    // 2. Discard Card (Permutational Evaluation)
    setTimeout(() => {
        const curLobby = lobbies[lobby.code];
        if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
        const curPlayer = curLobby.players[curLobby.turnIndex];
        if (!curPlayer || curPlayer.username !== player.username || curPlayer.cards.length !== 4) return;

        let bestDiscardIndex = 0;
        let maxScore = -1;

        for (let i = 0; i < 4; i++) {
            const simulatedHand = curPlayer.cards.filter((_, idx) => idx !== i);
            const score = calculateScore(simulatedHand);

            if (score > maxScore) {
                maxScore = score;
                bestDiscardIndex = i;
            } else if (score === maxScore) {
                const c1 = curPlayer.cards[i];
                const c2 = curPlayer.cards[bestDiscardIndex];
                const v1 = (c1.val === 'A') ? 11 : (['K','Q','J','10'].includes(c1.val) ? 10 : Number(c1.val));
                const v2 = (c2.val === 'A') ? 11 : (['K','Q','J','10'].includes(c2.val) ? 10 : Number(c2.val));
                if (v1 < v2) {
                    bestDiscardIndex = i;
                }
            }
        }

        handleDiscardAction(curLobby, curPlayer.id || curPlayer.username, bestDiscardIndex);
    }, 600);
}

// -------------------------------------------------------------
// PEEK HAND CONTROLLERS
// -------------------------------------------------------------

function handleRequestPeek(lobby, ws, targetUsername) {
    if (!lobby || !targetUsername) return;
    const sockName = extractSocketUsername(ws);
    const reqSpec = lobby.spectators.find(s => s.idSocket === ws || (sockName && s.username.toLowerCase() === sockName.toLowerCase()));
    const reqPlayer = lobby.players.find(p => p.id === ws || (sockName && p.username.toLowerCase() === sockName.toLowerCase()));
    const requesterName = reqSpec?.username || (reqPlayer?.eliminated ? reqPlayer.username : sockName);

    if (!requesterName) return;

    const target = lobby.players.find(p => p.username.toLowerCase() === String(targetUsername).trim().toLowerCase());
    if (!target || target.eliminated) return;

    if (!target.peekRequests) target.peekRequests = {};
    if (!target.peekAllowed) target.peekAllowed = {};

    if (target.isBot) {
        lobby.players.forEach(p => {
            if (p.peekAllowed) {
                Object.keys(p.peekAllowed).forEach(k => {
                    if (k.toLowerCase() === requesterName.toLowerCase()) {
                        delete p.peekAllowed[k];
                    }
                });
            }
        });
        target.peekAllowed[requesterName] = true;
    } else {
        target.peekRequests[requesterName] = true;
    }
    broadcastLobbyUpdate(lobby.code);
}

function handleRespondPeek(lobby, ws, requesterUsername, allow) {
    if (!lobby || !requesterUsername) return;
    const sockName = extractSocketUsername(ws);
    const me = lobby.players.find(p => p.id === ws || (sockName && p.username.toLowerCase() === sockName.toLowerCase()));
    if (!me) return;

    if (!me.peekRequests) me.peekRequests = {};
    if (!me.peekAllowed) me.peekAllowed = {};

    Object.keys(me.peekRequests).forEach(k => {
        if (k.toLowerCase() === String(requesterUsername).trim().toLowerCase()) {
            delete me.peekRequests[k];
        }
    });
    if (me.peekIncoming) {
        Object.keys(me.peekIncoming).forEach(k => {
            if (k.toLowerCase() === String(requesterUsername).trim().toLowerCase()) {
                delete me.peekIncoming[k];
            }
        });
    }

    if (allow) {
        // Clear any previous peek target for this spectator so they view one hand at a time
        lobby.players.forEach(p => {
            if (p.peekAllowed) {
                Object.keys(p.peekAllowed).forEach(k => {
                    if (k.toLowerCase() === String(requesterUsername).trim().toLowerCase()) {
                        delete p.peekAllowed[k];
                    }
                });
            }
        });
        me.peekAllowed[requesterUsername] = true;
    } else {
        Object.keys(me.peekAllowed).forEach(k => {
            if (k.toLowerCase() === String(requesterUsername).trim().toLowerCase()) {
                delete me.peekAllowed[k];
            }
        });
    }

    broadcastLobbyUpdate(lobby.code);
}

function handleStopPeek(lobby, ws) {
    if (!lobby) return;
    const sockName = extractSocketUsername(ws);
    const reqSpec = lobby.spectators.find(s => s.idSocket === ws || (sockName && s.username.toLowerCase() === sockName.toLowerCase()));
    const reqPlayer = lobby.players.find(p => p.id === ws || (sockName && p.username.toLowerCase() === sockName.toLowerCase()));
    const requesterName = reqSpec?.username || reqPlayer?.username || sockName;
    if (!requesterName) return;

    lobby.players.forEach(p => {
        if (p.peekAllowed) {
            Object.keys(p.peekAllowed).forEach(k => {
                if (k.toLowerCase() === requesterName.toLowerCase()) {
                    delete p.peekAllowed[k];
                }
            });
        }
    });
    broadcastLobbyUpdate(lobby.code);
}

function handleKickPeeker(lobby, ws, spectatorUsername) {
    if (!lobby || !spectatorUsername) return;
    const sockName = extractSocketUsername(ws);
    const me = lobby.players.find(p => p.id === ws || (sockName && p.username.toLowerCase() === sockName.toLowerCase()));
    if (!me || !me.peekAllowed) return;

    Object.keys(me.peekAllowed).forEach(k => {
        if (k.toLowerCase() === String(spectatorUsername).trim().toLowerCase()) {
            delete me.peekAllowed[k];
        }
    });
    broadcastLobbyUpdate(lobby.code);
}

// -------------------------------------------------------------
// DEALER & GAMEPLAY ENGINE
// -------------------------------------------------------------

function establishDealer(lobby) {
    // Only set dealer to lastGameWinner on the initial hand of a match (if not already established)
    if (!lobby.hasEstablishedInitialDealer && lobby.lastGameWinner) {
        const winIdx = lobby.players.findIndex(
            p => p.username && p.username.toLowerCase() === lobby.lastGameWinner.toLowerCase() && !p.eliminated
        );
        if (winIdx !== -1) {
            lobby.dealerIndex = winIdx;
            lobby.hasEstablishedInitialDealer = true;
            return;
        }
    }
    if (lobby.dealerIndex === undefined || lobby.dealerIndex >= lobby.players.length || lobby.dealerIndex < 0) {
        lobby.dealerIndex = 0;
    }
    if (lobby.players[lobby.dealerIndex]?.eliminated) {
        advanceDealerToNextActive(lobby);
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
    const cleanName = username.trim().toLowerCase();

    const p = lobby.players.find(pl => pl.username && pl.username.toLowerCase() === cleanName);
    if (p) {
        if (p.userId && !String(p.userId).startsWith('gst_')) return p.userId;
        if (p.id && p.id.user && !p.id.user.isGuest) {
            return p.id.user.id || p.id.user.userId;
        }
    }

    const fp = (lobby.forfeitedPlayers || []).find(f => f.username && f.username.toLowerCase() === cleanName);
    if (fp && fp.userId && !String(fp.userId).startsWith('gst_')) {
        return fp.userId;
    }

    const s = lobby.spectators.find(sp => sp.username && sp.username.toLowerCase() === cleanName);
    if (s) {
        if (s.userId && !String(s.userId).startsWith('gst_')) return s.userId;
        if (s.idSocket && s.idSocket.user && !s.idSocket.user.isGuest) {
            return s.idSocket.user.id || s.idSocket.user.userId;
        }
    }

    if (db && typeof db.findUserByUsername === 'function') {
        const row = db.findUserByUsername(username);
        if (row && row.id && !String(row.id).startsWith('gst_')) {
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

    if (uid && !String(uid).startsWith('gst_') && db && typeof db.getLifetimeBalances === 'function') {
        const balances = db.getLifetimeBalances(uid);
        ws.send(JSON.stringify({ 
            type: 'LIFETIME_LEDGER_DATA', 
            balances: balances,
            ledger: balances,
            debts: balances 
        }));
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
        try { sendLifetimeLedger(ws); } catch (err) {}
    });
}

function recordSessionAndLifetimeDebt(lobby, ledger, debtorUsername, creditorUsername, amount) {
    recordDebt(ledger, debtorUsername, creditorUsername, amount);

    if (!lobby.persistedLifetimeLedger) {
        lobby.persistedLifetimeLedger = { main: {}, side: {} };
    }
    const cat = (ledger === lobby.sideBetLedger) ? 'side' : 'main';
    if (!lobby.persistedLifetimeLedger[cat]) lobby.persistedLifetimeLedger[cat] = {};
    if (!lobby.persistedLifetimeLedger[cat][debtorUsername]) lobby.persistedLifetimeLedger[cat][debtorUsername] = {};

    if (db && typeof db.recordLifetimeDebt === 'function') {
        const debtorId = resolveUserId(lobby, debtorUsername);
        const creditorId = resolveUserId(lobby, creditorUsername);

        if (debtorId && creditorId && debtorId !== creditorId) {
            db.recordLifetimeDebt(debtorId, creditorId, amount);
            lobby.persistedLifetimeLedger[cat][debtorUsername][creditorUsername] = 
                (Number(lobby.persistedLifetimeLedger[cat][debtorUsername][creditorUsername]) || 0) + amount;

            const participants = [...lobby.players.map(pl => pl.id), ...lobby.spectators.map(sp => sp.idSocket)];
            participants.forEach(ws => {
                const uid = ws?.user ? (ws.user.id || ws.user.userId) : (ws?.userId || null);
                if (ws && ws.readyState === WebSocket.OPEN && uid && (uid === debtorId || uid === creditorId)) {
                    try { sendLifetimeLedger(ws); } catch (e) {}
                }
            });
        }
    }
}

function getSanitizedLobby(lobby, wsId) {
    const activeParts = getActiveParticipants(lobby);
    const allParticipants = [...lobby.players];
    const sockUsername = extractSocketUsername(wsId);

    const requestingPlayer = lobby.players.find(p =>
        p.id === wsId || (sockUsername && p.username.toLowerCase() === sockUsername.toLowerCase())
    );
    const requestingSpectator = lobby.spectators.find(s =>
        s.idSocket === wsId || (sockUsername && s.username.toLowerCase() === sockUsername.toLowerCase())
    );
    const myUsername = requestingPlayer?.username || requestingSpectator?.username || sockUsername || null;
    const isRequesterSpectating = Boolean(requestingSpectator || (requestingPlayer && requestingPlayer.eliminated) || !requestingPlayer);

    // Compute rotated seat indices without mutating server-side player.seat
    let sortedParticipants = [...allParticipants];
    if (myUsername) {
        const idx = sortedParticipants.findIndex(p => p.username.toLowerCase() === myUsername.toLowerCase());
        if (idx !== -1) {
            sortedParticipants = sortedParticipants.slice(idx).concat(sortedParticipants.slice(0, idx));
        }
    }

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

    const seatedPotTotal = allParticipants.reduce((sum, p) => sum + (Number(p.wager) || 5), 0);
    const forfeitedPotTotal = (lobby.forfeitedPlayers || [])
        .filter(fp => !allParticipants.some(p => p.username.toLowerCase() === fp.username.toLowerCase()))
        .reduce((sum, fp) => sum + (Number(fp.wager) || 5), 0);

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
        potTotal: seatedPotTotal + forfeitedPotTotal,
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
        drawPool: (lobby.drawPool || []).map((c, i) => ({
            index: (c && c.index !== undefined) ? c.index : i,
            chosenBy: c ? c.chosenBy : null,
            card: (c && c.chosenBy) ? c.card : null
        })),
        drawResults: lobby.drawResults || {},
        drawOrderSequence: lobby.drawOrderSequence || [],
        discardTop: lobby.discardPile ? (lobby.discardPile[lobby.discardPile.length - 1] || null) : null,
        knockedBy: lobby.knockedBy || null,
        chatHistory: lobby.chatHistory || [],
        playlist: lobby.playlist || [],
        currentSongIndex: lobby.currentSongIndex || 0,
        isPlaying: !!lobby.isPlaying,
        currentSongElapsedSeconds: elapsedSeconds,
        livekitHost: config.LIVEKIT_HOST,
        livesVote: lobby.livesVote || null,
        endGameVote: lobby.endGameVote || null,
        players: lobby.players.map(p => {
            const isMe = Boolean(myUsername && p.username.toLowerCase() === myUsername.toLowerCase());
            const canSee = lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd' || isMe;

            const specAllowed = Boolean(
                isRequesterSpectating &&
                myUsername &&
                p.peekAllowed &&
                (Array.isArray(p.peekAllowed)
                    ? p.peekAllowed.some(k => String(k).toLowerCase() === myUsername.toLowerCase())
                    : Object.keys(p.peekAllowed).some(k => k.toLowerCase() === myUsername.toLowerCase() && Boolean(p.peekAllowed[k])))
            );

            const rotatedSeatIdx = sortedParticipants.findIndex(sp => sp.username === p.username);
            const mergedIncoming = { ...(p.peekRequests || {}), ...(p.peekIncoming || {}) };

            return {
                username: p.username,
                lives: Math.max(0, p.lives),
                wager: p.wager || 5,
                cardCount: p.cards ? p.cards.length : 0,
                ready: p.ready,
                seat: rotatedSeatIdx !== -1 ? rotatedSeatIdx : p.seat,
                nextHandReady: p.nextHandReady,
                eliminated: p.eliminated,
                isBot: !!p.isBot,
                inVC: !!p.inVC,
                isMuted: p.isMuted !== undefined ? p.isMuted : true,
                peekIncoming: (wsId === p.id || isMe) ? mergedIncoming : {},
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

    const sentSockets = new Set();

    lobby.players.forEach(p => {
        if (p.id?.readyState === WebSocket.OPEN && !sentSockets.has(p.id)) {
            sentSockets.add(p.id);
            const data = getSanitizedLobby(lobby, p.id);
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            p.id.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket?.readyState === WebSocket.OPEN && !sentSockets.has(s.idSocket)) {
            sentSockets.add(s.idSocket);
            const data = getSanitizedLobby(lobby, s.idSocket);
            s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            s.idSocket.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    });
}

// -------------------------------------------------------------
// SPECTATOR SEAT CONTROLS: SIT DOWN & STAND UP
// -------------------------------------------------------------

function attemptGameStart(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length >= 2 && active.every(p => p.ready)) {
        lobby.forfeitedPlayers = [];
        lobby.players.forEach(p => { 
            clearReadyCountdown(p);
            p.ready = false; 
            p.eliminated = false;
            p.lives = lobby.defaultLives || 2;
        });

        const winnerStillSeated = lobby.lastGameWinner && lobby.players.some(
            p => p.username.toLowerCase() === lobby.lastGameWinner.toLowerCase() && !p.eliminated
        );

        if (winnerStillSeated || lobby.hasEstablishedInitialDealer) {
            establishDealer(lobby);
            startRound(lobby);
        } else {
            startDealerDrawPhase(lobby);
        }
    }
}

function handleSetReady(lobby, username, isReady) {
    if (!lobby || lobby.gameState !== 'lobby') return;
    const player = lobby.players.find(p => p.username && p.username.toLowerCase() === (username || '').toLowerCase());
    if (!player) return;

    player.ready = Boolean(isReady);

    if (player.ready) {
        clearReadyCountdown(player);
    } else {
        startReadyCountdown(lobby, player);
    }

    syncBotReadiness(lobby);
    attemptGameStart(lobby);
    broadcastLobbyUpdate(lobby.code);
}

function handleSitDown(lobby, ws, username) {
    if (!lobby || lobby.gameState !== 'lobby') return false;

    const cleanName = (username || '').trim().toLowerCase();
    const existingPlayer = lobby.players.find(p => 
        (p.id && p.id === ws) || 
        (cleanName && p.username && p.username.toLowerCase() === cleanName)
    );

    if (existingPlayer) {
        existingPlayer.id = ws;
        existingPlayer.userId = extractSocketUserId(ws) || existingPlayer.userId || null;
        existingPlayer.disconnectedAt = null;
        lobby.spectators = lobby.spectators.filter(s => 
            s.idSocket !== ws && 
            (!cleanName || !s.username || s.username.toLowerCase() !== cleanName)
        );
        if (!existingPlayer.ready) {
            startReadyCountdown(lobby, existingPlayer);
        }
        attemptGameStart(lobby);
        broadcastLobbyUpdate(lobby.code);
        return true;
    }

    if (lobby.players.length >= 6) return false;

    const specIndex = lobby.spectators.findIndex(s => 
        (s.idSocket && s.idSocket === ws) || 
        (cleanName && s.username && s.username.toLowerCase() === cleanName)
    );

    const spec = specIndex !== -1 ? lobby.spectators.splice(specIndex, 1)[0] : null;
    const targetUsername = spec?.username || username;
    if (!targetUsername) return false;

    const openSeat = findOpenSeat(lobby);
    if (openSeat === -1) return false;

    lobby.spectators = lobby.spectators.filter(s => 
        s.idSocket !== ws && 
        s.username.toLowerCase() !== targetUsername.toLowerCase()
    );

    const newPlayer = {
        id: ws,
        userId: extractSocketUserId(ws) || spec?.userId || null,
        username: targetUsername,
        lives: lobby.defaultLives || 2,
        wager: 5,
        cards: [],
        ready: false,
        seat: openSeat,
        eliminated: false,
        isBot: false,
        inVC: spec ? spec.inVC : false,
        isMuted: spec && spec.isMuted !== undefined ? spec.isMuted : true,
        nextHandReady: false,
        peekRequests: {},
        peekAllowed: {},
        disconnectedAt: null
    };

    lobby.players.push(newPlayer);
    startReadyCountdown(lobby, newPlayer);

    syncBotReadiness(lobby);
    attemptGameStart(lobby);
    broadcastLobbyUpdate(lobby.code);
    return true;
}

function handleStandUp(lobby, ws, username) {
    if (!lobby || lobby.gameState !== 'lobby') return false;

    const cleanName = (username || '').trim().toLowerCase();
    const playerIndex = lobby.players.findIndex(p => 
        (p.id && p.id === ws) || 
        (cleanName && p.username && p.username.toLowerCase() === cleanName)
    );
    if (playerIndex === -1) return false;

    const player = lobby.players[playerIndex];
    clearReadyCountdown(player);
    lobby.players.splice(playerIndex, 1);

    lobby.players.forEach((p, idx) => { p.seat = idx; });

    addSpectatorUnique(lobby, {
        idSocket: ws || player.id,
        userId: player.userId || extractSocketUserId(ws || player.id),
        username: player.username,
        inVC: player.inVC || false,
        isMuted: player.isMuted !== undefined ? player.isMuted : true
    });

    establishDealer(lobby);
    syncBotReadiness(lobby);
    attemptGameStart(lobby);
    broadcastLobbyUpdate(lobby.code);
    return true;
}

// -------------------------------------------------------------
// ROOM CREATOR ADMIN CONTROLS: KICK & MUTE
// -------------------------------------------------------------

function isLobbyHost(lobby, ws, username) {
    if (!lobby || !lobby.host) return false;
    const reqName = (username || extractSocketUsername(ws) || '').trim().toLowerCase();
    return Boolean(reqName && lobby.host.trim().toLowerCase() === reqName);
}

function handleAdminKickPlayer(lobby, hostWs, targetUsername, broadcastLobbyList) {
    if (!lobby || !targetUsername) return false;

    if (!isLobbyHost(lobby, hostWs, hostWs?.currentUsername)) {
        if (hostWs && hostWs.readyState === WebSocket.OPEN) {
            hostWs.send(JSON.stringify({ type: 'ERROR', message: 'Only the room creator can kick players.' }));
        }
        return false;
    }

    const cleanTarget = String(targetUsername).trim().toLowerCase();
    const cleanHost = (lobby.host || '').trim().toLowerCase();
    if (!cleanTarget || cleanTarget === cleanHost) return false;

    let targetSocket = null;
    let kickedName = String(targetUsername).trim();
    let wasCurrentTurnPlayer = false;

    // 1. Check seated players
    const playerIdx = lobby.players.findIndex(p => p.username && p.username.trim().toLowerCase() === cleanTarget);
    if (playerIdx !== -1) {
        const removedPlayer = lobby.players[playerIdx];
        kickedName = removedPlayer.username || kickedName;
        targetSocket = removedPlayer.id;
        clearReadyCountdown(removedPlayer);

        // Lock their buy-in into the pot if a game is currently active
        recordForfeitedPlayer(lobby, removedPlayer);

        if (playerIdx === lobby.turnIndex) {
            wasCurrentTurnPlayer = true;
            clearTurnTimer(lobby);
        } else if (playerIdx < lobby.turnIndex) {
            lobby.turnIndex = Math.max(0, lobby.turnIndex - 1);
        }

        lobby.players.splice(playerIdx, 1);
        lobby.players.forEach((p, idx) => { p.seat = idx; });

        if (lobby.turnIndex >= lobby.players.length) {
            lobby.turnIndex = 0;
        }
    }

    // 2. Check spectators
    const specIdx = lobby.spectators.findIndex(s => s.username && s.username.trim().toLowerCase() === cleanTarget);
    if (specIdx !== -1) {
        const removedSpec = lobby.spectators.splice(specIdx, 1)[0];
        kickedName = removedSpec.username || kickedName;
        if (!targetSocket) targetSocket = removedSpec.idSocket;
    }

    // 3. Clean up any peek references and tie-breaker lists for the kicked user
    lobby.players.forEach(p => {
        if (p.peekAllowed) {
            Object.keys(p.peekAllowed).forEach(k => {
                if (k.toLowerCase() === cleanTarget) delete p.peekAllowed[k];
            });
        }
        if (p.peekRequests) {
            Object.keys(p.peekRequests).forEach(k => {
                if (k.toLowerCase() === cleanTarget) delete p.peekRequests[k];
            });
        }
    });

    if (Array.isArray(lobby.tiedParticipantsList)) {
        lobby.tiedParticipantsList = lobby.tiedParticipantsList.filter(
            u => String(u).trim().toLowerCase() !== cleanTarget
        );
    }

    // 4. Notify kicked socket and detach room code
    if (targetSocket && typeof targetSocket === 'object' && targetSocket.readyState === WebSocket.OPEN) {
        targetSocket.currentLobbyCode = null;
        targetSocket.send(JSON.stringify({
            type: 'KICKED_FROM_LOBBY',
            message: `You were kicked from the table by ${lobby.host}.`
        }));
        targetSocket.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
    }

    lobby.phaseMessage = `👢 ${kickedName} was kicked from the room by ${lobby.host}.`;

    // 5. Reconcile game state if a seated player was kicked mid-game
    if (lobby.gameState === 'lobby') {
        establishDealer(lobby);
        syncBotReadiness(lobby);
        attemptGameStart(lobby);
        broadcastLobbyUpdate(lobby.code);
    } else if (lobby.gameState === 'roundOver') {
        checkNextHandReady(lobby);
        broadcastLobbyUpdate(lobby.code);
    } else {
        const activeLeft = getActiveParticipants(lobby);
        if (activeLeft.length <= 1) {
            if (activeLeft.length === 1) {
                awardTournamentWinner(lobby, activeLeft[0]);
            } else {
                resetLobbyToReadyRoom(lobby, `${kickedName} was kicked. Returning to waiting room.`, broadcastLobbyList);
            }
        } else {
            while (lobby.players[lobby.turnIndex] && lobby.players[lobby.turnIndex].eliminated) {
                lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
            }
            establishDealer(lobby);
            broadcastLobbyUpdate(lobby.code);
            if (wasCurrentTurnPlayer || lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
                scheduleBotActions(lobby);
                resetTurnTimer(lobby);
            }
        }
    }

    if (typeof broadcastLobbyList === 'function') broadcastLobbyList();
    return true;
}

function handleAdminMutePlayer(lobby, hostWs, targetUsername) {
    if (!lobby || !targetUsername) return false;

    if (!isLobbyHost(lobby, hostWs, hostWs?.currentUsername)) {
        if (hostWs && hostWs.readyState === WebSocket.OPEN) {
            hostWs.send(JSON.stringify({ type: 'ERROR', message: 'Only the room creator can mute players.' }));
        }
        return false;
    }

    const cleanTarget = String(targetUsername).trim().toLowerCase();
    let targetSocket = null;
    let targetCanonicalName = String(targetUsername).trim();
    let targetInVC = false;

    const targetPlayer = lobby.players.find(p => p.username && p.username.trim().toLowerCase() === cleanTarget);
    if (targetPlayer) {
        targetPlayer.isMuted = true;
        targetCanonicalName = targetPlayer.username;
        targetInVC = Boolean(targetPlayer.inVC);
        targetSocket = targetPlayer.id;
    }

    const targetSpec = lobby.spectators.find(s => s.username && s.username.trim().toLowerCase() === cleanTarget);
    if (targetSpec) {
        targetSpec.isMuted = true;
        targetCanonicalName = targetSpec.username || targetCanonicalName;
        targetInVC = targetInVC || Boolean(targetSpec.inVC);
        if (!targetSocket) targetSocket = targetSpec.idSocket;
    }

    if (!targetPlayer && !targetSpec) return false;

    // Instruct target browser to immediately shut off LiveKit microphone
    if (targetSocket && typeof targetSocket === 'object' && targetSocket.readyState === WebSocket.OPEN) {
        targetSocket.send(JSON.stringify({
            type: 'ADMIN_FORCE_MUTE',
            byHost: lobby.host
        }));
    }

    // Broadcast updated VC status to all connected clients in the lobby
    const vcPayload = JSON.stringify({
        type: 'VC_STATUS_UPDATE',
        username: targetCanonicalName,
        inVC: targetInVC,
        isMuted: true
    });

    const sent = new Set();
    [...lobby.players.map(p => p.id), ...lobby.spectators.map(s => s.idSocket)].forEach(sock => {
        if (sock && typeof sock === 'object' && sock.readyState === WebSocket.OPEN && !sent.has(sock)) {
            sent.add(sock);
            sock.send(vcPayload);
        }
    });

    broadcastLobbyUpdate(lobby.code);
    return true;
}

function startDealerDrawPhase(lobby) {
    clearRoundOverTimer(lobby);
    clearTurnTimer(lobby);
    lobby.players.forEach(p => clearReadyCountdown(p));

    const deck = createDeck();
    lobby.drawPool = deck.map((c, i) => ({ index: i, card: c, chosenBy: null }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.hasEstablishedInitialDealer = true; 
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.turnsTakenThisRound = 0;
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.globalProposals = [];
    lobby.players.forEach(p => {
        p.peekAllowed = {};
        p.peekRequests = {};
        p.peekIncoming = {};
        if (!p.eliminated) p.nextHandReady = p.isBot;
    });
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function startRound(lobby) {
    clearRoundOverTimer(lobby);
    clearTurnTimer(lobby);
    lobby.players.forEach(p => clearReadyCountdown(p));

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

    // Single-round global proposals/bets do not carry over to a new round
    lobby.globalProposals = [];
    if (Array.isArray(lobby.activeBets)) {
        lobby.activeBets = lobby.activeBets.filter(b => b.type === 'eliminate' || b.type === 'first_out');
    }

    const activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1) {
        awardTournamentWinner(lobby, activeParts[0]);
        return;
    }

    lobby.players.forEach(p => {
        p.peekAllowed = {};
        p.peekRequests = {};
        p.peekIncoming = {};
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
    resetTurnTimer(lobby);
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

function handlePoolCardSelection(lobby, userOrWs, rawCardIndex) {
    if (!lobby || (lobby.gameState !== 'dealerDraw' && lobby.gameState !== 'tieBreaker')) return;

    // Resolve canonical player username case-insensitively or by socket reference
    const extracted = extractSocketUsername(userOrWs);
    const matchedPlayer = lobby.players.find(p =>
        (typeof userOrWs === 'object' && userOrWs !== null && p.id === userOrWs) ||
        (extracted && p.username && p.username.toLowerCase() === extracted.toLowerCase())
    );
    const username = matchedPlayer ? matchedPlayer.username : extracted;
    if (!username) return;

    if (matchedPlayer && matchedPlayer.eliminated) return;

    if (lobby.gameState === 'tieBreaker') {
        const isTied = (lobby.tiedParticipantsList || []).some(
            u => String(u).toLowerCase() === username.toLowerCase()
        );
        if (!isTied) return;
    }

    if (lobby.drawResults && lobby.drawResults[username]) return;

    // Normalize index (supports number, numeric string, or payload object)
    let cardIndex = typeof rawCardIndex === 'object' && rawCardIndex !== null
        ? Number(rawCardIndex.index ?? rawCardIndex.cardIndex ?? rawCardIndex.slotIndex)
        : Number(rawCardIndex);

    // Fallback: if index is out of bounds or already taken, pick the first available unchosen slot
    if (isNaN(cardIndex) || !lobby.drawPool[cardIndex] || lobby.drawPool[cardIndex].chosenBy !== null) {
        const availableSlot = (lobby.drawPool || []).find(slot => slot && slot.chosenBy === null);
        if (!availableSlot) return;
        cardIndex = availableSlot.index !== undefined ? availableSlot.index : lobby.drawPool.indexOf(availableSlot);
    }

    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        const card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        if (!lobby.drawOrderSequence) lobby.drawOrderSequence = [];
        lobby.drawOrderSequence.push({ username, card });
        broadcastLobbyUpdate(lobby.code);

        const activeParts = getActiveParticipants(lobby);
        if (lobby.gameState === 'dealerDraw' && activeParts.every(p => lobby.drawResults[p.username])) {
            const entries = activeParts
                .map(p => ({ username: p.username, card: lobby.drawResults[p.username] }))
                .filter(e => e.card)
                .sort((a, b) => a.card.drawVal - b.card.drawVal);

            lobby.dealerIndex = lobby.players.findIndex(p => p.username === entries[0].username);
            lobby.phaseMessage = `🎉 ${entries[0].username} drew lowest and is Dealer!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => {
                if (lobbies[lobby.code]) startRound(lobbies[lobby.code]);
            }, 3000);
        } else if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.every(u => lobby.drawResults[u])) {
            const entries = lobby.tiedParticipantsList
                .map(u => ({ username: u, card: lobby.drawResults[u] }))
                .filter(e => e.card)
                .sort((a, b) => a.card.drawVal - b.card.drawVal);

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
                    cur.drawPool = tieDeck.map((c, i) => ({ index: i, card: c, chosenBy: null }));
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
                        addSpectatorUnique(lobby, {
                            idSocket: loser.id,
                            userId: loser.userId || extractSocketUserId(loser.id),
                            username: loser.username,
                            inVC: loser.inVC,
                            isMuted: loser.isMuted
                        });
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

// -------------------------------------------------------------
// TURN ACTION & DISCARD LOGIC WITH RESILIENT MATCHING
// -------------------------------------------------------------
function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    const sockName = extractSocketUsername(wsId);
    const isDirectMatch = (currentPlayer.id === wsId) || (currentPlayer.idSocket === wsId) || (wsId === currentPlayer.username);
    const isSocketNameMatch = Boolean(sockName && currentPlayer.username && sockName.toLowerCase() === currentPlayer.username.toLowerCase());

    if (!isDirectMatch && !isSocketNameMatch) return;
    if (isSocketNameMatch && !isDirectMatch && typeof wsId === 'object' && wsId !== null) {
        currentPlayer.id = wsId;
        currentPlayer.userId = extractSocketUserId(wsId) || currentPlayer.userId || null;
        currentPlayer.disconnectedAt = null;
    }

    if (lobby.gameState === 'finalTurn' && lobby.knockedBy === currentPlayer.username) return;

    let act = typeof actionType === 'object' ? (actionType.source || actionType.action || actionType.type) : actionType;
    act = String(act || '').toUpperCase();

    const isDiscard = (act === 'DRAW_DISCARD' || act === 'DISCARD' || (typeof actionType === 'object' && actionType.source === 'discard'));
    const isDeck = !isDiscard && (act === 'DRAW_DECK' || act === 'DECK' || act === 'DRAW_CARD' || act === '');

    if (isDeck) {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the deck.`;
    } else if (isDiscard && lobby.discardPile.length > 0) {
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
    } else {
        return;
    }

    if (calculateBestFourCardScore(currentPlayer.cards) === 31 || calculateScore(currentPlayer.cards) === 31) {
        clearTurnTimer(lobby);
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
                addSpectatorUnique(lobby, {
                    idSocket: feeder.id,
                    userId: feeder.userId || extractSocketUserId(feeder.id),
                    username: feeder.username,
                    inVC: feeder.inVC,
                    isMuted: feeder.isMuted
                });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            // Pass 1: Deduct lives and mark all eliminated players first
            const newlyEliminated = [];
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        newlyEliminated.push(p);
                        if (p.id && typeof p.id === 'object') {
                            addSpectatorUnique(lobby, {
                                idSocket: p.id,
                                userId: p.userId || extractSocketUserId(p.id),
                                username: p.username,
                                inVC: p.inVC,
                                isMuted: p.isMuted
                            });
                        }
                    }
                }
            });
            // Pass 2: Resolve First-to-Lose bets now that all life totals are updated
            newlyEliminated.forEach(p => {
                resolveFirstToLoseBets(lobby, p.username);
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        if (typeof resolveWinSideBets === 'function') {
            resolveWinSideBets(lobby, currentPlayer.username);
        }
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
    resetTurnTimer(lobby);
}

function handleDiscardAction(lobby, wsId, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.cards.length !== 4) return;

    const sockName = extractSocketUsername(wsId);
    const isDirectMatch = (currentPlayer.id === wsId) || (currentPlayer.idSocket === wsId) || (wsId === currentPlayer.username);
    const isSocketNameMatch = Boolean(sockName && currentPlayer.username && sockName.toLowerCase() === currentPlayer.username.toLowerCase());

    if (!isDirectMatch && !isSocketNameMatch) return;
    if (isSocketNameMatch && !isDirectMatch && typeof wsId === 'object' && wsId !== null) {
        currentPlayer.id = wsId;
        currentPlayer.userId = extractSocketUserId(wsId) || currentPlayer.userId || null;
        currentPlayer.disconnectedAt = null;
    }

    clearTurnTimer(lobby);

    const idx = Number(cardIndex);
    if (isNaN(idx) || idx < 0 || idx >= currentPlayer.cards.length) {
        cardIndex = 0;
    } else {
        cardIndex = idx;
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
        resetTurnTimer(lobby);
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
                addSpectatorUnique(lobby, {
                    idSocket: feeder.id,
                    userId: feeder.userId || extractSocketUserId(feeder.id),
                    username: feeder.username,
                    inVC: feeder.inVC,
                    isMuted: feeder.isMuted
                });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            // Pass 1: Deduct lives and mark all eliminated players first
            const newlyEliminated = [];
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        newlyEliminated.push(p);
                        if (p.id && typeof p.id === 'object') {
                            addSpectatorUnique(lobby, {
                                idSocket: p.id,
                                userId: p.userId || extractSocketUserId(p.id),
                                username: p.username,
                                inVC: p.inVC,
                                isMuted: p.isMuted
                            });
                        }
                    }
                }
            });
            // Pass 2: Resolve First-to-Lose bets now that all life totals are updated
            newlyEliminated.forEach(p => {
                resolveFirstToLoseBets(lobby, p.username);
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        if (typeof resolveWinSideBets === 'function') {
            resolveWinSideBets(lobby, currentPlayer.username);
        }
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

    const sockName = extractSocketUsername(wsId);
    const isDirectMatch = (p.id === wsId) || (p.idSocket === wsId) || (wsId === p.username);
    const isSocketNameMatch = Boolean(sockName && p.username && sockName.toLowerCase() === p.username.toLowerCase());

    if (!isDirectMatch && !isSocketNameMatch) return;
    if (isSocketNameMatch && !isDirectMatch && typeof wsId === 'object' && wsId !== null) {
        p.id = wsId;
        p.userId = extractSocketUserId(wsId) || p.userId || null;
        p.disconnectedAt = null;
    }

    if (p.cards.length !== 3) return;

    const active = getActiveParticipants(lobby);
    if (lobby.turnsTakenThisRound < active.length) return;
    if (calculateScore(p.cards) < (active.length > 2 ? 21 : 25)) return;

    clearTurnTimer(lobby);
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
    resetTurnTimer(lobby);
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
        resetTurnTimer(lobby);
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
    resetTurnTimer(lobby);
}

function resolveRoundEnd(lobby) {
    clearTurnTimer(lobby);

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

    // Determine single-round winner (unique highest score in this hand)
    const highest = scores[scores.length - 1].s;
    const highestTied = scores.filter(s => s.s === highest);
    const roundWinnerUsername = (highestTied.length === 1) ? highestTied[0].p.username : null;

    if (typeof resolveWinSideBets === 'function') {
        try { resolveWinSideBets(lobby, roundWinnerUsername); } catch (e) {}
    }
    syncLifetimeLedgerBalances(lobby);

    if (tied.length > 1) {
        if (active.length <= 2) {
            // Heads-up (2-player) tie: NEVER enter 'tieBreaker' modal.
            // Pass the dealer chip to the next active player and trigger roundOver for a re-deal.
            lobby.tiedParticipantsList = [];
            lobby.drawPool = [];
            lobby.drawResults = {};
            lobby.drawOrderSequence = [];
            lobby.pendingBotDraw = {};
            advanceDealerToNextActive(lobby);
            const nextDealerName = lobby.players[lobby.dealerIndex]?.username || 'next player';
            triggerRoundOver(lobby, `Round tied at ${lowest} pts! No one loses a life. Passing deal to ${nextDealerName}...`);
        } else {
            lobby.tiedParticipantsList = tied.map(t => t.p.username);
            const tieDeck = (lobby.deck && lobby.deck.length >= tied.length) ? lobby.deck : createDeck();
            lobby.drawPool = tieDeck.map((c, i) => ({ index: i, card: c, chosenBy: null }));
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
        loser.lives = Math.max(0, loser.lives - 1);

        if (loser.lives <= 0 && !loser.eliminated) {
            loser.eliminated = true;
            resolveFirstToLoseBets(lobby, loser.username);
            syncLifetimeLedgerBalances(lobby);
            if (loser.id && typeof loser.id === 'object') {
                addSpectatorUnique(lobby, {
                    idSocket: loser.id,
                    userId: loser.userId || extractSocketUserId(loser.id),
                    username: loser.username,
                    inVC: loser.inVC,
                    isMuted: loser.isMuted
                });
            }
        }

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
    clearTurnTimer(lobby);
    lobby.fedCardReminders = {};
    lobby.globalProposals = [];
    if (Array.isArray(lobby.activeBets)) {
        lobby.activeBets = lobby.activeBets.filter(b => b.type === 'eliminate' || b.type === 'first_out');
    }
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    lobby.players.forEach(p => { 
        p.peekAllowed = {};
        p.peekRequests = {};
        p.peekIncoming = {};
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
    clearTurnTimer(lobby);
    if (!winner) return;
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    const winnerWager = Number(winner.wager) || 5;
    const winnerLower = (winner.username || '').toLowerCase();
    const chargedUsers = new Set();

    // 1. Charge seated players who lost
    lobby.players.forEach(p => {
        const lower = (p.username || '').toLowerCase();
        if (lower && lower !== winnerLower && !chargedUsers.has(lower)) {
            chargedUsers.add(lower);
            const loserWager = Number(p.wager) || 5;
            // Effective payout is capped at the lower wager between the winner and the loser
            const amt = Math.min(loserWager, winnerWager);
            const isBotInvolved = p.isBot || winner.isBot;
            const targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.mainGameLedger;

            recordSessionAndLifetimeDebt(lobby, targetLedger, p.username, winner.username, amt);
        }
    });

    // 2. Charge players who left the table mid-game (their buy-in stayed in the pot)
    (lobby.forfeitedPlayers || []).forEach(fp => {
        const lower = (fp.username || '').toLowerCase();
        if (lower && lower !== winnerLower && !chargedUsers.has(lower)) {
            chargedUsers.add(lower);
            const loserWager = Number(fp.wager) || 5;
            const amt = Math.min(loserWager, winnerWager);
            const isBotInvolved = fp.isBot || winner.isBot;
            const targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.mainGameLedger;

            recordSessionAndLifetimeDebt(lobby, targetLedger, fp.username, winner.username, amt);
        }
    });

    if (typeof resolveWinSideBets === 'function') {
        try { resolveWinSideBets(lobby, winner.username); } catch (e) {}
    }

    // Clear any remaining activeBets/proposals at tournament end
    lobby.globalProposals = [];
    lobby.activeBets = [];

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
    clearTurnTimer(lobby);

    lobby.gameState = 'lobby';
    lobby.phaseMessage = msg || "Returned to waiting room.";
    lobby.endGameVotes = {};
    lobby.endGameVote = null;
    lobby.activeBets = [];
    lobby.pendingBets = [];
    lobby.globalProposals = [];
    lobby.forfeitedPlayers = [];
    lobby.knockedBy = null;
    lobby.finalTurnsTaken = {};
    
    // Completely wipe previous state to force a new Dealer Draw on the next match
    lobby.tournamentWinner = null;
    lobby.lastGameWinner = null;
    lobby.hasEstablishedInitialDealer = false;
    
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

    lobby.spectators = lobby.spectators.filter(s => {
        return !lobby.players.some(p => p.username && s.username && p.username.toLowerCase() === s.username.toLowerCase());
    });

    const spectatorsToReclaim = [...lobby.spectators];
    spectatorsToReclaim.forEach(spec => {
        const alreadyIn = lobby.players.some(p => p.username && spec.username && p.username.toLowerCase() === spec.username.toLowerCase());
        if (!alreadyIn && lobby.players.length < 6) {
            const openSeat = findOpenSeat(lobby);
            const recl = {
                id: spec.idSocket,
                userId: spec.userId || extractSocketUserId(spec.idSocket) || null,
                username: spec.username,
                lives: lobby.defaultLives || 2,
                wager: 5,
                cards: [],
                ready: false,
                seat: openSeat !== -1 ? openSeat : lobby.players.length,
                eliminated: false,
                isBot: false,
                inVC: spec.inVC,
                isMuted: spec.isMuted,
                nextHandReady: false,
                peekRequests: {},
                peekAllowed: {},
                disconnectedAt: null
            };
            lobby.players.push(recl);
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
        p.peekIncoming = {};
        p.peekAllowed = {};
        startReadyCountdown(lobby, p);
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
        forfeitedPlayers: [],
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
        roundOverAutoTimer: null,
        turnTimeoutTimer: null,
        endGameVote: null
    };
    return lobbies[code];
}

function joinLobby(ws, code, username) {
    const lobby = lobbies[code];
    if (!lobby) return { success: false, message: 'Lobby does not exist.' };

    const cleanName = (username || '').trim().toLowerCase();
    const incomingUid = extractSocketUserId(ws);

    // 1. Re-attach to existing seated player
    const existingPlayer = lobby.players.find(p => 
        (cleanName && p.username.toLowerCase() === cleanName) || (p.id && p.id === ws)
    );
    if (existingPlayer) {
        existingPlayer.id = ws;
        if (incomingUid) existingPlayer.userId = incomingUid;
        existingPlayer.disconnectedAt = null;
        if (existingPlayer.eliminated) {
            addSpectatorUnique(lobby, {
                idSocket: ws,
                userId: existingPlayer.userId,
                username: existingPlayer.username,
                inVC: existingPlayer.inVC,
                isMuted: existingPlayer.isMuted
            });
        } else {
            lobby.spectators = lobby.spectators.filter(s => 
                s.idSocket !== ws && s.username.toLowerCase() !== cleanName
            );
        }
        if (lobby.gameState === 'lobby' && !existingPlayer.ready) {
            startReadyCountdown(lobby, existingPlayer);
        }
        return { success: true, lobby, isSpectator: !!existingPlayer.eliminated };
    }

    // 2. Re-attach to existing spectator
    const existingSpectator = lobby.spectators.find(s => 
        (cleanName && s.username.toLowerCase() === cleanName) || (s.idSocket && s.idSocket === ws)
    );
    if (existingSpectator) {
        existingSpectator.idSocket = ws;
        if (incomingUid) existingSpectator.userId = incomingUid;
        existingSpectator.username = username;
        return { success: true, lobby, isSpectator: true };
    }

    // 3. Fresh join into waiting room lobby
    if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
        const seat = findOpenSeat(lobby);
        const newPlayer = {
            id: ws,
            userId: incomingUid,
            username,
            lives: lobby.defaultLives || 2,
            wager: 5,
            cards: [],
            ready: false,
            seat: seat !== -1 ? seat : lobby.players.length,
            eliminated: false,
            isBot: false,
            inVC: false,
            isMuted: true,
            nextHandReady: false,
            peekRequests: {},
            peekAllowed: {},
            disconnectedAt: null
        };
        lobby.players.push(newPlayer);
        startReadyCountdown(lobby, newPlayer);
        return { success: true, lobby, isSpectator: false };
    }

    // 4. Fresh spectator join
    addSpectatorUnique(lobby, {
        idSocket: ws,
        userId: incomingUid,
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
    const leavingSpectator = lobby.spectators.find(s => s.idSocket === ws);
    const leavingUsername = leavingPlayerIndex !== -1
        ? lobby.players[leavingPlayerIndex].username
        : (leavingSpectator?.username || null);

    let wasCurrentTurnPlayer = false;

    if (leavingPlayerIndex !== -1) {
        const leavingPlayer = lobby.players[leavingPlayerIndex];
        clearReadyCountdown(leavingPlayer);

        // Lock their buy-in into the pot if they leave mid-game
        recordForfeitedPlayer(lobby, leavingPlayer);

        if (leavingPlayerIndex === lobby.turnIndex) {
            wasCurrentTurnPlayer = true;
            clearTurnTimer(lobby);
        } else if (leavingPlayerIndex < lobby.turnIndex) {
            lobby.turnIndex = Math.max(0, lobby.turnIndex - 1);
        }

        lobby.players.splice(leavingPlayerIndex, 1);

        if (Array.isArray(lobby.tiedParticipantsList) && leavingUsername) {
            lobby.tiedParticipantsList = lobby.tiedParticipantsList.filter(
                u => String(u).trim().toLowerCase() !== leavingUsername.trim().toLowerCase()
            );
        }
    }

    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);

    const remainingHumans = lobby.players.filter(p => !p.isBot);
    const remainingSpectators = lobby.spectators.filter(s => s.idSocket && s.idSocket.readyState === WebSocket.OPEN);

    if (remainingHumans.length === 0 && remainingSpectators.length === 0) {
        clearRoundOverTimer(lobby);
        clearTurnTimer(lobby);
        if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
        delete lobbies[code];
        if (broadcastLobbyList) broadcastLobbyList();
        return;
    }

    lobby.players.forEach((p, idx) => { p.seat = idx; });

    // If the room creator left, pass host powers to the next remaining human player or spectator
    if (leavingUsername && lobby.host && lobby.host.toLowerCase() === leavingUsername.toLowerCase()) {
        const nextHost = remainingHumans[0]?.username || remainingSpectators[0]?.username;
        if (nextHost) lobby.host = nextHost;
    }

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
        while (lobby.players[lobby.turnIndex] && lobby.players[lobby.turnIndex].eliminated) {
            lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
        }
        establishDealer(lobby);
        syncBotReadiness(lobby);
        broadcastLobbyUpdate(code);
        if (wasCurrentTurnPlayer || lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
            scheduleBotActions(lobby);
        }
        resetTurnTimer(lobby);
    }

    if (broadcastLobbyList) broadcastLobbyList();
}

module.exports = {
    lobbies,
    getLobbies,
    createLobby,
    joinLobby,
    establishDealer,
    getActiveParticipants,
    findOpenSeat,
    touchLobbyActivity,
    closeInactiveLobby,
    getPublicLobbiesList,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    handleSetReady,
    handleSitDown,
    handleStandUp,
    isLobbyHost,
    handleAdminKickPlayer,
    handleAdminMutePlayer,
    handleRequestPeek,
    handleRespondPeek,
    handleStopPeek,
    handleKickPeeker,
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
    recordForfeitedPlayer,
    resolveUserId,
    recordSessionAndLifetimeDebt,
    syncLifetimeLedgerBalances,
    sendLifetimeLedger,
    startReadyCountdown,
    clearReadyCountdown,
    resetTurnTimer,
    clearTurnTimer,
    executeLevel8AITurn
};
