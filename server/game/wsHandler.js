// server/game/wsHandler.js - WebSocket Event Relay & Gameplay Actions
const WebSocket = require('ws');
const {
    lobbies,
    touchLobbyActivity,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    findOpenSeat,
    startDealerDrawPhase,
    startRound,
    establishDealer,
    handlePoolCardSelection,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    leaveLobby,
    resetLobbyToReadyRoom,
    checkNextHandReady,
    syncLifetimeLedgerBalances
} = require('./lobbyManager');
const { generateLiveKitToken } = require('../services/livekit');
const { BOT_NAMES, syncBotReadiness } = require('./bot');
const { clearDebts, recordDebt } = require('./ledger');
const config = require('../config');

let dbModule;
try {
    dbModule = require('../db');
} catch (e) {
    dbModule = null;
}

// -------------------------------------------------------------
// 1. LOBBY 30-SECOND READY TIMEOUT CONTROLLER
// -------------------------------------------------------------

function clearReadyCountdown(player) {
    if (player && player.readyTimeout) {
        clearTimeout(player.readyTimeout);
        player.readyTimeout = null;
    }
}

function startReadyCountdown(lobby, player, broadcastLobbyList) {
    if (!lobby || lobby.gameState !== 'lobby' || !player || player.isBot) return;

    clearReadyCountdown(player);

    player.readyTimeout = setTimeout(() => {
        const curLobby = lobbies[lobby.code];
        if (!curLobby || curLobby.gameState !== 'lobby') return;

        const pIdx = curLobby.players.findIndex(p => p.username && p.username.toLowerCase() === (player.username || '').toLowerCase());
        if (pIdx === -1) return;

        const target = curLobby.players[pIdx];
        if (target && !target.ready) {
            clearReadyCountdown(target);
            const removed = curLobby.players.splice(pIdx, 1)[0];

            const alreadySpec = curLobby.spectators.some(s =>
                s.idSocket === target.id ||
                (removed.username && s.username && s.username.toLowerCase() === removed.username.toLowerCase())
            );

            if (!alreadySpec) {
                curLobby.spectators.push({
                    idSocket: target.id,
                    username: removed.username,
                    inVC: removed.inVC || false,
                    isMuted: removed.isMuted !== undefined ? removed.isMuted : true,
                    disconnectedAt: null
                });
            }

            curLobby.players.forEach((p, idx) => { p.seat = idx; });
            syncBotReadiness(curLobby);
            curLobby.phaseMessage = `⏱️ ${target.username} timed out after 30s and was moved to spectator mode.`;
            broadcastLobbyUpdate(curLobby.code);
            if (typeof broadcastLobbyList === 'function') broadcastLobbyList();
        }
    }, 30000); // 30 seconds
}

// -------------------------------------------------------------
// 2. TURN TIMEOUT & LEVEL 8/10 AI ENGINE
// -------------------------------------------------------------

function calculateHandScore(cards) {
    if (!cards || !Array.isArray(cards) || cards.length === 0) return 0;
    const suitTotals = { H: 0, D: 0, C: 0, S: 0 };
    const rankCounts = {};

    cards.forEach(c => {
        if (!c) return;
        let v = 0;
        if (c.val === 'A') v = 11;
        else if (['K', 'Q', 'J', '10'].includes(c.val)) v = 10;
        else v = Number(c.val) || 0;

        if (c.suit && suitTotals[c.suit] !== undefined) {
            suitTotals[c.suit] += v;
        }
        rankCounts[c.val] = (rankCounts[c.val] || 0) + 1;
    });

    let maxScore = Math.max(...Object.values(suitTotals));
    for (const rank in rankCounts) {
        if (rankCounts[rank] >= 3) {
            maxScore = Math.max(maxScore, 30.5);
        }
    }
    return maxScore;
}

function executeLevel8AITurn(lobby, player) {
    if (!lobby || !player || player.eliminated) return;
    const cards = player.cards || [];
    const active = lobby.players.filter(p => !p.eliminated);
    const currentScore = calculateHandScore(cards);

    // If player already drew and holds 4 cards: execute best discard
    if (cards.length === 4) {
        let bestDiscardIdx = 0;
        let highestSubScore = -1;
        for (let i = 0; i < 4; i++) {
            const subHand = cards.filter((_, idx) => idx !== i);
            const score = calculateHandScore(subHand);
            if (score > highestSubScore) {
                highestSubScore = score;
                bestDiscardIdx = i;
            }
        }
        handleDiscardAction(lobby, player.id, bestDiscardIdx);
        resetTurnTimer(lobby);
        return;
    }

    // LEVEL 8 KNOCK EVALUATION (Before drawing)
    const canKnock = lobby.gameState === 'playing' 
        && !lobby.knockedBy 
        && cards.length === 3 
        && (lobby.turnsTakenThisRound || 0) >= active.length;

    const knockThreshold = active.length > 2 ? 26 : 24;
    if (canKnock && currentScore >= knockThreshold) {
        handleKnock(lobby, player.id);
        resetTurnTimer(lobby);
        return;
    }

    // LEVEL 8 DRAW DECISION: Discard vs Deck
    const topDiscard = (lobby.discardPile && lobby.discardPile.length > 0)
        ? lobby.discardPile[lobby.discardPile.length - 1]
        : null;

    let shouldDrawDiscard = false;
    if (topDiscard && cards.length === 3) {
        let bestScoreWithDiscard = 0;
        for (let i = 0; i < 3; i++) {
            const testHand = cards.filter((_, idx) => idx !== i).concat([topDiscard]);
            bestScoreWithDiscard = Math.max(bestScoreWithDiscard, calculateHandScore(testHand));
        }
        if (bestScoreWithDiscard > currentScore) {
            shouldDrawDiscard = true;
        }
    }

    // 1. Draw Card
    handleTurnAction(lobby, player.id, shouldDrawDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK');

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
            const score = calculateHandScore(simulatedHand);

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

        handleDiscardAction(curLobby, curPlayer.id, bestDiscardIndex);
        resetTurnTimer(curLobby);
    }, 600);
}

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

// -------------------------------------------------------------
// 3. MASTER WEBSOCKET MESSAGE DISPATCHER
// -------------------------------------------------------------

function handleWebSocketMessage(ws, message, broadcastLobbyList) {
    let data;
    try {
        data = typeof message === 'string' ? JSON.parse(message) : JSON.parse(message.toString());
    } catch (e) {
        return;
    }

    let currentLobbyCode = (ws.currentLobbyCode || data.code || '').trim().toUpperCase() || null;
    let currentUsername = (ws.currentUsername || data.username || '').trim() || null;

    if (currentLobbyCode && !ws.currentLobbyCode) ws.currentLobbyCode = currentLobbyCode;
    if (currentUsername && !ws.currentUsername) ws.currentUsername = currentUsername;

    switch (data.type) {
        case 'GET_LOBBIES': {
            if (typeof broadcastLobbyList === 'function') broadcastLobbyList();
            break;
        }

        case 'CREATE_LOBBY': {
            const username = (data.username || 'Player1').trim();
            const lobbyName = (data.lobbyName || `${username}'s Room`).trim();
            const isPrivate = !!data.isPrivate;

            const isDuplicateName = Object.values(lobbies).some(
                l => l.name && l.name.trim().toLowerCase() === lobbyName.toLowerCase()
            );

            if (isDuplicateName) {
                ws.send(JSON.stringify({
                    type: 'ERROR',
                    message: `A table named "${lobbyName}" already exists. Please choose a different name.`
                }));
                return;
            }

            const code = Math.random().toString(36).substring(2, 7).toUpperCase();

            const newLobby = {
                code,
                name: lobbyName,
                host: username,
                isPrivate,
                gameState: 'lobby',
                defaultLives: 2,
                deck: [],
                discardPile: [],
                turnIndex: 0,
                dealerIndex: 0,
                phaseMessage: 'Waiting for players to ready up...',
                turnsTakenThisRound: 0,
                livesVote: null,
                endGameVote: null,
                players: [{
                    id: ws,
                    username,
                    lives: 2,
                    wager: 5,
                    cards: [],
                    ready: false,
                    seat: 0,
                    eliminated: false,
                    isBot: false,
                    inVC: true,
                    isMuted: true,
                    nextHandReady: false,
                    peekRequests: {},
                    peekAllowed: {},
                    disconnectedAt: null
                }],
                spectators: [],
                activeBets: [],
                pendingBets: [],
                globalProposals: [],
                sideBetLedger: {},
                mainGameLedger: {},
                botBetLedger: {},
                chatHistory: [],
                playlist: [],
                currentSongIndex: 0,
                isPlaying: false,
                songStartedAt: null,
                songPausedAtOffset: 0
            };

            lobbies[code] = newLobby;
            ws.currentLobbyCode = code;
            ws.currentUsername = username;
            touchLobbyActivity(newLobby, broadcastLobbyList);

            // Arm 30s ready countdown for the lobby creator
            startReadyCountdown(newLobby, newLobby.players[0], broadcastLobbyList);

            generateLiveKitToken(code, username).then(token => {
                ws.send(JSON.stringify({
                    type: 'LOBBY_CREATED',
                    code,
                    livekitToken: token,
                    livekitHost: config.LIVEKIT_HOST,
                    lobby: getSanitizedLobby(newLobby, ws)
                }));
                broadcastLobbyUpdate(code);
                if (broadcastLobbyList) broadcastLobbyList();
            });
            break;
        }

        case 'JOIN_LOBBY': {
            const code = (data.code || '').trim().toUpperCase();
            const username = (data.username || 'Player').trim();
            const lobby = lobbies[code];

            if (!lobby) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found.' }));
                return;
            }

            ws.currentLobbyCode = code;
            ws.currentUsername = username;
            touchLobbyActivity(lobby, broadcastLobbyList);

            let existingPlayer = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
            let existingSpec = lobby.spectators.find(s => s.username.toLowerCase() === username.toLowerCase());

            if (existingPlayer) {
                existingPlayer.id = ws;
                existingPlayer.disconnectedAt = null;
                if (lobby.gameState === 'lobby' && !existingPlayer.ready) {
                    startReadyCountdown(lobby, existingPlayer, broadcastLobbyList);
                }
            } else if (existingSpec) {
                existingSpec.idSocket = ws;
                existingSpec.disconnectedAt = null;
            } else {
                if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const newPlayer = {
                        id: ws,
                        username,
                        lives: lobby.defaultLives || 2,
                        wager: 5,
                        cards: [],
                        ready: false,
                        seat: findOpenSeat(lobby),
                        eliminated: false,
                        isBot: false,
                        inVC: true,
                        isMuted: true,
                        nextHandReady: false,
                        peekRequests: {},
                        peekAllowed: {},
                        disconnectedAt: null
                    };
                    lobby.players.push(newPlayer);
                    startReadyCountdown(lobby, newPlayer, broadcastLobbyList);
                } else {
                    lobby.spectators.push({
                        idSocket: ws,
                        username,
                        inVC: true,
                        isMuted: true,
                        disconnectedAt: null
                    });
                }
            }

            syncBotReadiness(lobby);
            generateLiveKitToken(code, username).then(token => {
                ws.send(JSON.stringify({
                    type: 'LOBBY_JOINED',
                    code,
                    livekitToken: token,
                    livekitHost: config.LIVEKIT_HOST,
                    lobby: getSanitizedLobby(lobby, ws)
                }));
                broadcastLobbyUpdate(code);
                if (broadcastLobbyList) broadcastLobbyList();
            });
            break;
        }

        case 'LEAVE_LOBBY': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                const player = lobby.players.find(p => p.id === ws);
                if (player) clearReadyCountdown(player);

                leaveLobby(ws, currentLobbyCode, broadcastLobbyList);
                ws.currentLobbyCode = null;
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
            }
            break;
        }

        case 'SET_READY': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const player = lobby.players.find(p => p.id === ws);
                if (player && lobby.gameState === 'lobby') {
                    player.ready = !!data.ready;

                    if (player.ready) {
                        clearReadyCountdown(player);
                    } else {
                        startReadyCountdown(lobby, player, broadcastLobbyList);
                    }

                    syncBotReadiness(lobby);
                    broadcastLobbyUpdate(currentLobbyCode);

                    const seatedPlayers = lobby.players;
                    if (seatedPlayers.length >= 2 && seatedPlayers.every(p => p.ready)) {
                        lobby.players.forEach(p => { 
                            clearReadyCountdown(p);
                            p.ready = false; 
                            p.eliminated = false;
                            p.lives = lobby.defaultLives || 2;
                        });

                        const winnerStillSeated = lobby.lastGameWinner && lobby.players.some(
                            p => p.username.toLowerCase() === lobby.lastGameWinner.toLowerCase()
                        );

                        if (winnerStillSeated || lobby.hasEstablishedInitialDealer) {
                            if (typeof establishDealer === 'function') {
                                establishDealer(lobby);
                            } else if (lobby.players.length > 0) {
                                lobby.dealerIndex = ((lobby.dealerIndex ?? -1) + 1) % lobby.players.length;
                                lobby.dealerName = lobby.players[lobby.dealerIndex]?.username || null;
                            }
                            startRound(lobby);
                            resetTurnTimer(lobby);
                        } else {
                            startDealerDrawPhase(lobby);
                        }
                    }
                }
            }
            break;
        }

        case 'STAND_UP': {
            const code = ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                const lobby = lobbies[code];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (lobby.gameState === 'lobby') {
                    const uName = (data.username || currentUsername || ws.currentUsername || '').toLowerCase();
                    const pIdx = lobby.players.findIndex(p => 
                        p.id === ws || 
                        (uName && p.username && p.username.toLowerCase() === uName)
                    );

                    if (pIdx !== -1) {
                        const removed = lobby.players.splice(pIdx, 1)[0];
                        clearReadyCountdown(removed);

                        const alreadySpec = lobby.spectators.some(s => 
                            s.idSocket === ws || 
                            (removed.username && s.username && s.username.toLowerCase() === removed.username.toLowerCase())
                        );

                        if (!alreadySpec) {
                            lobby.spectators.push({
                                idSocket: ws,
                                username: removed.username,
                                inVC: removed.inVC || false,
                                isMuted: removed.isMuted !== undefined ? removed.isMuted : true,
                                disconnectedAt: null
                            });
                        }

                        lobby.players.forEach((p, idx) => { p.seat = idx; });
                        syncBotReadiness(lobby);
                        broadcastLobbyUpdate(code);
                        if (broadcastLobbyList) broadcastLobbyList();
                    }
                }
            }
            break;
        }

        case 'SIT_DOWN': {
            const code = ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                const lobby = lobbies[code];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const uName = (data.username || currentUsername || ws.currentUsername || '').toLowerCase();
                    const sIdx = lobby.spectators.findIndex(s => 
                        s.idSocket === ws || 
                        (uName && s.username && s.username.toLowerCase() === uName)
                    );

                    const spec = (sIdx !== -1) ? lobby.spectators.splice(sIdx, 1)[0] : null;
                    const targetUsername = spec?.username || data.username || currentUsername || ws.currentUsername;

                    if (targetUsername) {
                        const existingP = lobby.players.find(p => p.username.toLowerCase() === targetUsername.toLowerCase());
                        if (existingP) {
                            existingP.id = ws;
                            existingP.disconnectedAt = null;
                            startReadyCountdown(lobby, existingP, broadcastLobbyList);
                        } else {
                            const openSeat = findOpenSeat(lobby);
                            const newPlayer = {
                                id: ws,
                                username: targetUsername,
                                lives: lobby.defaultLives || 2,
                                wager: 5,
                                cards: [],
                                ready: false,
                                seat: openSeat !== -1 ? openSeat : lobby.players.length,
                                eliminated: false,
                                isBot: false,
                                inVC: spec ? spec.inVC : true,
                                isMuted: spec && spec.isMuted !== undefined ? spec.isMuted : true,
                                nextHandReady: false,
                                peekRequests: {},
                                peekAllowed: {},
                                disconnectedAt: null
                            };
                            lobby.players.push(newPlayer);
                            startReadyCountdown(lobby, newPlayer, broadcastLobbyList);
                        }

                        syncBotReadiness(lobby);
                        broadcastLobbyUpdate(code);
                        if (broadcastLobbyList) broadcastLobbyList();
                    }
                }
            }
            break;
        }

        case 'CHOOSE_POOL_CARD': {
            if (currentLobbyCode && lobbies[currentLobbyCode] && typeof data.cardIndex === 'number') {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                handlePoolCardSelection(lobby, currentUsername, data.cardIndex);
            }
            break;
        }

        case 'DRAW_CARD':
        case 'DRAW_DECK':
        case 'DRAW_DISCARD': {
            const code = currentLobbyCode || ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                const lobby = lobbies[code];
                touchLobbyActivity(lobby, broadcastLobbyList);

                const isDiscard = (data.type === 'DRAW_DISCARD' || data.source === 'discard' || data.action === 'DRAW_DISCARD');
                const actionType = isDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK';

                handleTurnAction(lobby, ws, actionType);
                resetTurnTimer(lobby);
            }
            break;
        }

        case 'DISCARD_CARD': {
            const code = currentLobbyCode || ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                const lobby = lobbies[code];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const rawIdx = (data.index !== undefined) ? data.index : data.cardIndex;
                const cardIdx = Number(rawIdx);
                if (!isNaN(cardIdx)) {
                    handleDiscardAction(lobby, ws, cardIdx);
                    resetTurnTimer(lobby);
                }
            }
            break;
        }

        case 'KNOCK': {
            const code = currentLobbyCode || ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                const lobby = lobbies[code];
                touchLobbyActivity(lobby, broadcastLobbyList);
                handleKnock(lobby, ws);
                resetTurnTimer(lobby);
            }
            break;
        }

        case 'NEXT_HAND_READY':
        case 'NEXT_HAND': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const player = lobby.players.find(p => p.id === ws);
                if (player && lobby.gameState === 'roundOver') {
                    player.nextHandReady = true;
                    broadcastLobbyUpdate(currentLobbyCode);
                    checkNextHandReady(lobby);
                    resetTurnTimer(lobby);
                }
            }
            break;
        }

        // ---------------------------------------------------------
        // 4. DEBT TRANSFER / NOVATION HANDLERS
        // ---------------------------------------------------------
        case 'TRANSFER_DEBT': {
            const code = currentLobbyCode || ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                const lobby = lobbies[code];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const myUsername = currentUsername || ws.currentUsername;
                if (!myUsername) break;

                const { fromDebtor, toCreditor, amount } = data;
                const transferAmt = Number(amount);
                if (!fromDebtor || !toCreditor || transferAmt <= 0) break;

                // 1. Debtor owes me less -> credit debtor against me
                recordDebt(lobby.mainGameLedger, myUsername, fromDebtor, transferAmt);

                // 2. I owe target creditor less -> credit me against target creditor
                recordDebt(lobby.mainGameLedger, toCreditor, myUsername, transferAmt);

                // 3. Debtor now owes target creditor directly
                recordDebt(lobby.mainGameLedger, fromDebtor, toCreditor, transferAmt);

                if (typeof syncLifetimeLedgerBalances === 'function') {
                    syncLifetimeLedgerBalances(lobby);
                }

                broadcastLobbyUpdate(lobby.code);
            }
            break;
        }

        case 'TRANSFER_LIFETIME_DEBT': {
            let myUid = (ws.user && !ws.user.isGuest) ? (ws.user.id || ws.user.userId) : (ws.userId || data.myId);
            const { fromDebtorId, toCreditorId, amount } = data;
            const transferAmt = Number(amount);

            if (dbModule && typeof dbModule.recordLifetimeDebt === 'function' && myUid && fromDebtorId && toCreditorId && transferAmt > 0) {
                dbModule.recordLifetimeDebt(myUid, fromDebtorId, transferAmt);
                dbModule.recordLifetimeDebt(toCreditorId, myUid, transferAmt);
                dbModule.recordLifetimeDebt(fromDebtorId, toCreditorId, transferAmt);

                if (typeof dbModule.getLifetimeBalances === 'function') {
                    const balances = dbModule.getLifetimeBalances(myUid);
                    ws.send(JSON.stringify({
                        type: 'LIFETIME_LEDGER_DATA',
                        balances,
                        ledger: balances,
                        debts: balances
                    }));
                }
            }
            break;
        }

        case 'GET_LIFETIME_LEDGER': {
            let uid = (ws.user && !ws.user.isGuest && (ws.user.id || ws.user.userId)) ||
                      (ws.currentUsername && dbModule?.findUserByUsername?.(ws.currentUsername)?.id) ||
                      data.userId;

            if (uid && dbModule && typeof dbModule.getLifetimeBalances === 'function') {
                const balances = dbModule.getLifetimeBalances(uid);
                ws.send(JSON.stringify({
                    type: 'LIFETIME_LEDGER_DATA',
                    balances,
                    ledger: balances,
                    debts: balances
                }));
            }
            break;
        }

        case 'CLEAR_DEBT': {
            if (currentLobbyCode && lobbies[currentLobbyCode] && data.debtor && data.creditor) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const isBot = lobby.players.some(p => (p.username === data.debtor || p.username === data.creditor) && p.isBot);
                const ledger = isBot ? lobby.botBetLedger : (data.ledgerType === 'side' ? lobby.sideBetLedger : lobby.mainGameLedger);
                clearDebts(ledger, data.debtor, data.creditor);
                syncLifetimeLedgerBalances(lobby);
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'GET_SESSION_LEDGER':
        case 'GET_LEDGER': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                ws.send(JSON.stringify({
                    type: 'SESSION_LEDGER_DATA',
                    mainGameLedger: lobby.mainGameLedger || {},
                    sideBetLedger: lobby.sideBetLedger || {},
                    botBetLedger: lobby.botBetLedger || {},
                    activeBets: lobby.activeBets || []
                }));
            }
            break;
        }

        case 'UPDATE_WAGER': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const player = lobby.players.find(p => p.id === ws);
                if (player && lobby.gameState === 'lobby') {
                    player.wager = Math.max(1, parseInt(data.wager, 10) || 5);
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'UPDATE_SETTINGS': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (lobby.gameState !== 'lobby') return;

                const requestedLives = parseInt(data.lives, 10) || 2;
                if (requestedLives === lobby.defaultLives) return;

                const seatedHumans = lobby.players.filter(p => !p.isBot);
                if (seatedHumans.length <= 1) {
                    lobby.defaultLives = requestedLives;
                    lobby.players.forEach(p => { p.lives = requestedLives; });
                    lobby.phaseMessage = `Starting lives updated to ${requestedLives}.`;
                    broadcastLobbyUpdate(currentLobbyCode);
                    return;
                }

                lobby.livesVote = {
                    proposer: currentUsername,
                    proposedLives: requestedLives,
                    votes: { [currentUsername]: true },
                    totalVoters: seatedHumans.length
                };

                lobby.phaseMessage = `🗳️ ${currentUsername} proposed changing starting lives to ${requestedLives}!`;
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'VOTE_LIVES': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (!lobby.livesVote || lobby.gameState !== 'lobby') return;

                const seatedHuman = lobby.players.find(p => p.id === ws && !p.isBot);
                if (!seatedHuman) return;

                lobby.livesVote.votes[seatedHuman.username] = !!data.agree;

                const seatedHumans = lobby.players.filter(p => !p.isBot);
                const yesCount = Object.values(lobby.livesVote.votes).filter(v => v === true).length;
                const noCount = Object.values(lobby.livesVote.votes).filter(v => v === false).length;
                const majorityNeeded = Math.floor(seatedHumans.length / 2) + 1;

                if (yesCount >= majorityNeeded) {
                    const newLives = lobby.livesVote.proposedLives;
                    lobby.defaultLives = newLives;
                    lobby.players.forEach(p => { p.lives = newLives; });
                    lobby.phaseMessage = `✅ Vote passed! Starting lives set to ${newLives}.`;
                    lobby.livesVote = null;
                } else if (noCount >= majorityNeeded || Object.keys(lobby.livesVote.votes).length >= seatedHumans.length) {
                    lobby.phaseMessage = `❌ Vote failed. Starting lives remain ${lobby.defaultLives || 2}.`;
                    lobby.livesVote = null;
                }

                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'ADD_BOT': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const availableNames = BOT_NAMES.filter(n => !lobby.players.some(p => p.username.startsWith(n)));
                    const chosenName = (availableNames[Math.floor(Math.random() * availableNames.length)] || ('Bot ' + (lobby.players.length + 1))) + ' (B)';

                    lobby.players.push({
                        id: `bot_${Date.now()}_${Math.random()}`,
                        username: chosenName,
                        lives: lobby.defaultLives || 2,
                        wager: 5,
                        cards: [],
                        ready: false,
                        seat: findOpenSeat(lobby),
                        eliminated: false,
                        isBot: true,
                        inVC: false,
                        isMuted: true,
                        nextHandReady: true,
                        peekRequests: {},
                        peekAllowed: {},
                        disconnectedAt: null
                    });

                    syncBotReadiness(lobby);
                    lobby.phaseMessage = `🤖 ${chosenName} joined the table.`;
                    broadcastLobbyUpdate(currentLobbyCode);
                    if (broadcastLobbyList) broadcastLobbyList();
                }
            }
            break;
        }

        case 'REMOVE_BOT': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (lobby.gameState === 'lobby') {
                    let botIdx = -1;
                    for (let i = lobby.players.length - 1; i >= 0; i--) {
                        if (lobby.players[i].isBot) {
                            botIdx = i;
                            break;
                        }
                    }
                    if (botIdx !== -1) {
                        const removed = lobby.players.splice(botIdx, 1)[0];
                        lobby.phaseMessage = `🤖 ${removed.username} was removed.`;
                        syncBotReadiness(lobby);
                        broadcastLobbyUpdate(currentLobbyCode);
                        if (broadcastLobbyList) broadcastLobbyList();
                    }
                }
            }
            break;
        }

        case 'REQUEST_PEEK': {
            if (currentLobbyCode && lobbies[currentLobbyCode] && data.targetUsername) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const targetLower = data.targetUsername.trim().toLowerCase();
                const targetPlayer = lobby.players.find(p => p.username.toLowerCase() === targetLower);
                if (targetPlayer) {
                    if (!targetPlayer.peekRequests) targetPlayer.peekRequests = {};
                    targetPlayer.peekRequests[currentUsername] = true;
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'RESPOND_PEEK': {
            if (currentLobbyCode && lobbies[currentLobbyCode] && data.spectatorUsername) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const player = lobby.players.find(p => p.id === ws);
                if (player) {
                    const specName = data.spectatorUsername.trim();
                    const specLower = specName.toLowerCase();

                    if (player.peekRequests) {
                        Object.keys(player.peekRequests).forEach(k => {
                            if (k.toLowerCase() === specLower) delete player.peekRequests[k];
                        });
                    }

                    if (data.allow) {
                        if (!player.peekAllowed) player.peekAllowed = {};
                        player.peekAllowed[specName] = true;
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'KICK_PEEKER': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const player = lobby.players.find(p => p.id === ws);
                if (player && player.peekAllowed) {
                    const targetName = (data.spectatorUsername || '').trim().toLowerCase();
                    Object.keys(player.peekAllowed).forEach(k => {
                        if (k.toLowerCase() === targetName) {
                            delete player.peekAllowed[k];
                        }
                    });
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'STOP_PEEK': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const myLower = (currentUsername || '').trim().toLowerCase();
                lobby.players.forEach(pl => {
                    if (pl.peekAllowed) {
                        Object.keys(pl.peekAllowed).forEach(k => {
                            if (k.toLowerCase() === myLower) {
                                delete pl.peekAllowed[k];
                            }
                        });
                    }
                });
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'PROPOSE_ELIMINATION_BET': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const wagerAmt = Math.max(1, parseInt(data.wagerAmt, 10) || 5);
                const targetPlayer = lobby.players.find(p => p.username === data.target);

                if (targetPlayer && targetPlayer.isBot) {
                    if (!lobby.activeBets) lobby.activeBets = [];
                    lobby.activeBets.push({
                        id: `bet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                        type: 'eliminate',
                        proposer: currentUsername,
                        bettor: currentUsername,
                        target: data.target,
                        pickUser: data.target,
                        targetSurvivor: currentUsername,
                        wagerAmt,
                        isBotBet: true,
                        createdAt: Date.now()
                    });
                    lobby.phaseMessage = `🤝 Bot Bet Accepted! ${targetPlayer.username} accepted ${currentUsername}'s $${wagerAmt} bet!`;
                } else {
                    if (!lobby.pendingBets) lobby.pendingBets = [];
                    lobby.pendingBets.push({
                        id: `bet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                        type: 'eliminate',
                        proposer: currentUsername,
                        bettor: currentUsername,
                        target: data.target,
                        pickUser: data.target,
                        targetSurvivor: currentUsername,
                        wagerAmt,
                        createdAt: Date.now()
                    });
                }
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'PROPOSE_GLOBAL_SIDE_BET':
        case 'PROPOSE_GLOBAL_BET': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const wagerAmt = Math.max(1, parseInt(data.wagerAmt, 10) || 5);
                const newProp = {
                    id: data.id || `prop_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    proposer: currentUsername,
                    creator: currentUsername,
                    pickUser: data.pickUser || currentUsername,
                    condition: data.condition || `I like ${data.pickUser || currentUsername} to win`,
                    betType: data.betType || 'win',
                    wagerAmt,
                    acceptedBy: [],
                    deniedBy: [currentUsername],
                    createdAt: Date.now()
                };
                if (!lobby.globalProposals) lobby.globalProposals = [];
                lobby.globalProposals.push(newProp);
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'ACCEPT_GLOBAL_PROPOSAL': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const propId = data.proposalId || data.betId || data.id;
                const prop = (lobby.globalProposals || []).find(gp => gp.id === propId);
                const proposerName = prop ? (prop.proposer || prop.creator) : null;
                if (prop && proposerName !== currentUsername) {
                    if (!prop.acceptedBy) prop.acceptedBy = [];
                    if (!prop.acceptedBy.includes(currentUsername)) {
                        prop.acceptedBy.push(currentUsername);
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'CONFIRM_GLOBAL_BET':
        case 'RESPOND_GLOBAL_BET': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const propId = data.proposalId || data.betId || data.id;
                const pIdx = (lobby.globalProposals || []).findIndex(gp => gp.id === propId);

                if (pIdx !== -1) {
                    const prop = lobby.globalProposals[pIdx];
                    const proposerName = prop.proposer || prop.creator;
                    const isProposer = (proposerName === currentUsername);
                    const isAccept = data.confirm !== undefined ? !!data.confirm : (data.accept !== undefined ? !!data.accept : true);

                    const partnerUser = isProposer
                        ? (data.acceptedUser || (prop.acceptedBy && prop.acceptedBy[0]))
                        : currentUsername;

                    if (isProposer) {
                        if (isAccept) {
                            if (!lobby.activeBets) lobby.activeBets = [];
                            lobby.activeBets.push({
                                id: prop.id,
                                proposer: proposerName,
                                target: partnerUser,
                                pickUser: prop.pickUser || prop.condition,
                                wagerAmt: prop.wagerAmt,
                                type: 'win'
                            });
                            lobby.globalProposals.splice(pIdx, 1);
                        } else {
                            prop.acceptedBy = (prop.acceptedBy || []).filter(u => u !== partnerUser);
                            const targetPlayer = lobby.players.find(p => p.username === partnerUser);
                            const targetSocket = targetPlayer?.id || lobby.spectators.find(s => s.username === partnerUser)?.idSocket;
                            if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                                targetSocket.send(JSON.stringify({
                                    type: 'NOTIFICATION',
                                    message: `❌ ${proposerName} declined your side bet.`
                                }));
                            }
                        }
                    } else {
                        if (!prop.acceptedBy) prop.acceptedBy = [];
                        if (!prop.acceptedBy.includes(currentUsername)) {
                            prop.acceptedBy.push(currentUsername);
                        }
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'RESPOND_BET': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const betId = data.betId || data.proposalId || data.id;
                const isAccept = data.accept !== undefined ? !!data.accept : !!data.confirm;

                const bIdx = (lobby.pendingBets || []).findIndex(b => b.id === betId);
                if (bIdx !== -1) {
                    const bet = lobby.pendingBets.splice(bIdx, 1)[0];
                    if (isAccept) {
                        if (!lobby.activeBets) lobby.activeBets = [];
                        lobby.activeBets.push(bet);
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                } else {
                    const gpIdx = (lobby.globalProposals || []).findIndex(gp => gp.id === betId);
                    if (gpIdx !== -1) {
                        const prop = lobby.globalProposals[gpIdx];
                        const proposerName = prop.proposer || prop.creator;
                        if (!lobby.activeBets) lobby.activeBets = [];

                        const alreadyExists = lobby.activeBets.some(b =>
                            b.proposalId === prop.id &&
                            ((b.proposer === proposerName && b.target === currentUsername) ||
                             (b.target === proposerName && b.proposer === currentUsername))
                        );

                        if (isAccept && !alreadyExists) {
                            if (!prop.acceptedBy) prop.acceptedBy = [];
                            if (!prop.acceptedBy.includes(currentUsername)) prop.acceptedBy.push(currentUsername);

                            lobby.activeBets.push({
                                id: `gbet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                proposalId: prop.id,
                                type: prop.betType || 'win',
                                proposer: proposerName,
                                bettor: proposerName,
                                target: currentUsername,
                                pickUser: prop.pickUser || proposerName,
                                wagerAmt: Number(prop.wagerAmt) || 5,
                                condition: prop.condition || 'Win the Match',
                                createdAt: Date.now()
                            });
                        } else if (!isAccept) {
                            if (!prop.deniedBy) prop.deniedBy = [];
                            if (!prop.deniedBy.includes(currentUsername)) prop.deniedBy.push(currentUsername);
                            if (prop.acceptedBy) prop.acceptedBy = prop.acceptedBy.filter(u => u !== currentUsername);
                        }
                        broadcastLobbyUpdate(currentLobbyCode);
                    }
                }
            }
            break;
        }

        case 'CHAT_MESSAGE': {
            if (currentLobbyCode && lobbies[currentLobbyCode] && data.message) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const msgObj = { user: currentUsername || 'Unknown', text: String(data.message).slice(0, 200) };
                if (!lobby.chatHistory) lobby.chatHistory = [];
                lobby.chatHistory.push(msgObj);
                if (lobby.chatHistory.length > 50) lobby.chatHistory.shift();
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        // ---------------------------------------------------------
        // 5. END GAME VOTE ENGINE
        // ---------------------------------------------------------
        case 'END_GAME_PROPOSAL': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);

                // Prevent starting another vote if one is already in progress
                if (lobby.endGameVote) return;

                const seatedHumans = lobby.players.filter(p => !p.isBot);

                // If only 1 human player is present (playing solo or with bots), end immediately
                if (seatedHumans.length <= 1) {
                    clearTurnTimer(lobby);
                    resetLobbyToReadyRoom(lobby, `${currentUsername} ended the match.`, broadcastLobbyList);
                    return;
                }

                // If multiple human players are seated, initiate a majority vote
                lobby.endGameVote = {
                    proposer: currentUsername,
                    votes: { [currentUsername]: true }, // Proposer automatically votes "Yes"
                    totalVoters: seatedHumans.length
                };

                lobby.phaseMessage = `🗳️ ${currentUsername} proposed ending the match! Cast your vote.`;
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'VOTE_END_GAME': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (!lobby.endGameVote) return;

                const seatedHuman = lobby.players.find(p => p.id === ws && !p.isBot);
                if (!seatedHuman) return;

                lobby.endGameVote.votes[seatedHuman.username] = !!data.agree;

                const seatedHumans = lobby.players.filter(p => !p.isBot);
                const yesCount = Object.values(lobby.endGameVote.votes).filter(v => v === true).length;
                const noCount = Object.values(lobby.endGameVote.votes).filter(v => v === false).length;
                const majorityNeeded = Math.floor(seatedHumans.length / 2) + 1;

                if (yesCount >= majorityNeeded) {
                    lobby.phaseMessage = `✅ Vote passed! Match ended by majority vote.`;
                    lobby.endGameVote = null;
                    clearTurnTimer(lobby);
                    resetLobbyToReadyRoom(lobby, `🗳️ Match ended by majority vote.`, broadcastLobbyList);
                    return;
                } else if (noCount >= majorityNeeded || Object.keys(lobby.endGameVote.votes).length >= seatedHumans.length) {
                    lobby.phaseMessage = `❌ Vote failed. Match continues!`;
                    lobby.endGameVote = null;
                }

                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'YT_PLAY':
        case 'YT_PAUSE':
        case 'YT_SKIP':
        case 'YT_PREV':
        case 'YT_ADD_SONG':
        case 'YT_REMOVE_SONG': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);

                if (data.type === 'YT_PLAY') {
                    lobby.isPlaying = true;
                    lobby.songStartedAt = Date.now() - ((lobby.songPausedAtOffset || 0) * 1000);
                } else if (data.type === 'YT_PAUSE') {
                    lobby.isPlaying = false;
                    if (lobby.songStartedAt) {
                        lobby.songPausedAtOffset = Math.max(0, Math.floor((Date.now() - lobby.songStartedAt) / 1000));
                    }
                } else if (data.type === 'YT_SKIP') {
                    if (lobby.playlist && lobby.playlist.length > 0) {
                        lobby.currentSongIndex = (lobby.currentSongIndex + 1) % lobby.playlist.length;
                        lobby.songPausedAtOffset = 0;
                        lobby.songStartedAt = Date.now();
                        lobby.isPlaying = true;
                    }
                } else if (data.type === 'YT_PREV') {
                    if (lobby.playlist && lobby.playlist.length > 0) {
                        lobby.currentSongIndex = (lobby.currentSongIndex - 1 + lobby.playlist.length) % lobby.playlist.length;
                        lobby.songPausedAtOffset = 0;
                        lobby.songStartedAt = Date.now();
                        lobby.isPlaying = true;
                    }
                } else if (data.type === 'YT_ADD_SONG' && data.videoId && data.title) {
                    if (!lobby.playlist) lobby.playlist = [];
                    lobby.playlist.push({ videoId: data.videoId, title: data.title });
                    if (lobby.playlist.length === 1) {
                        lobby.currentSongIndex = 0;
                        lobby.songPausedAtOffset = 0;
                        lobby.songStartedAt = Date.now();
                        lobby.isPlaying = true;
                    }
                } else if (data.type === 'YT_REMOVE_SONG' && typeof data.index === 'number') {
                    if (lobby.playlist && lobby.playlist[data.index]) {
                        lobby.playlist.splice(data.index, 1);
                        if (lobby.currentSongIndex >= lobby.playlist.length) {
                            lobby.currentSongIndex = Math.max(0, lobby.playlist.length - 1);
                        }
                    }
                }
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'VC_STATUS_UPDATE': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                const player = lobby.players.find(p => p.id === ws);
                const spec = lobby.spectators.find(s => s.idSocket === ws);
                if (player) {
                    player.inVC = !!data.inVC;
                    player.isMuted = data.isMuted !== undefined ? !!data.isMuted : true;
                }
                if (spec) {
                    spec.inVC = !!data.inVC;
                    spec.isMuted = data.isMuted !== undefined ? !!data.isMuted : true;
                }
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }
    }
}

function setupWebSocket(wss, broadcastLobbyList) {
    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (message) => {
            handleWebSocketMessage(ws, message, broadcastLobbyList);
        });

        ws.on('close', () => {
            if (ws.currentLobbyCode && lobbies[ws.currentLobbyCode]) {
                const lobby = lobbies[ws.currentLobbyCode];
                
                const player = lobby.players.find(p => p.id === ws);
                if (player) {
                    clearReadyCountdown(player);
                    player.id = null;
                    player.disconnectedAt = Date.now();

                    // If an end game vote is active and this player drops, check if threshold is resolved
                    if (lobby.endGameVote) {
                        const seatedHumans = lobby.players.filter(p => !p.isBot && p.id !== null);
                        if (seatedHumans.length <= 1) {
                            lobby.endGameVote = null;
                        }
                    }

                    broadcastLobbyUpdate(ws.currentLobbyCode);
                }
                
                const spec = lobby.spectators.find(s => s.idSocket === ws);
                if (spec) {
                    spec.idSocket = null;
                    spec.disconnectedAt = Date.now();
                }
                
                touchLobbyActivity(lobby, broadcastLobbyList);
            }
        });
    });      
}

module.exports = {
    handleWebSocketMessage,
    handleWsMessage: handleWebSocketMessage,
    setupWebSocket,
    initWebSocketHandler: setupWebSocket,
    resetTurnTimer,
    executeLevel8AITurn,
    startReadyCountdown,
    clearReadyCountdown
};
