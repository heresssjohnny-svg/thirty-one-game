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
    recordForfeitedPlayer,
    addLedgerHistory,
    applySessionCredit,
    resetLobbyToReadyRoom,
    checkNextHandReady,
    syncLifetimeLedgerBalances,
    handleAdminKickPlayer,
    handleAdminMutePlayer
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
// 0. IDENTITY, HANDLE & ACCOUNT LEDGER RESOLUTION HELPERS
// -------------------------------------------------------------

function extractAccountUsername(ws, data, lobby) {
    if (ws && ws.user && !ws.user.isGuest && ws.user.username) {
        return String(ws.user.username).trim();
    }
    if (data && data.accountUsername && String(data.accountUsername).trim()) {
        return String(data.accountUsername).trim();
    }
    if (ws && ws.accountUsername && String(ws.accountUsername).trim()) {
        return String(ws.accountUsername).trim();
    }
    if (lobby && ws) {
        const p = (lobby.players || []).find(pl => pl.id === ws && pl.accountUsername);
        if (p) return p.accountUsername;
        const s = (lobby.spectators || []).find(sp => sp.idSocket === ws && sp.accountUsername);
        if (s) return s.accountUsername;
    }
    return null;
}

function extractSocketUserId(ws, data, lobby) {
    if (!ws || typeof ws !== 'object') return null;

    let uid = (ws.user && !ws.user.isGuest && (ws.user.id || ws.user.userId)) ||
              ws.userId ||
              (data && data.userId) ||
              null;

    if (uid && !String(uid).startsWith('gst_')) {
        ws.userId = uid;
        return uid;
    }

    const acctName = extractAccountUsername(ws, data, lobby);
    if (acctName && dbModule && typeof dbModule.findUserByUsername === 'function') {
        const row = dbModule.findUserByUsername(acctName);
        if (row && row.id && !String(row.id).startsWith('gst_')) {
            ws.userId = row.id;
            return row.id;
        }
    }

    const handleName = (data?.username || ws.currentUsername || '').trim();
    if (lobby && lobby.identityMap) {
        const mapped = (acctName && lobby.identityMap[acctName.toLowerCase()]) ||
                       (handleName && lobby.identityMap[handleName.toLowerCase()]);
        if (mapped && mapped.userId && !String(mapped.userId).startsWith('gst_')) {
            ws.userId = mapped.userId;
            return mapped.userId;
        }
    }

    if (handleName && dbModule && typeof dbModule.findUserByUsername === 'function') {
        const row = dbModule.findUserByUsername(handleName);
        if (row && row.id && !String(row.id).startsWith('gst_')) {
            ws.userId = row.id;
            return row.id;
        }
    }

    return null;
}

function registerLobbyIdentity(lobby, ws, handle, accountUsername, userId) {
    if (!lobby) return null;
    if (!lobby.identityMap) lobby.identityMap = {};

    const cleanHandle = (handle || '').trim();
    const cleanAcct = (accountUsername || cleanHandle || '').trim();
    let resolvedUid = userId || extractSocketUserId(ws, { username: cleanHandle, accountUsername: cleanAcct }, lobby);

    if (!resolvedUid && dbModule && typeof dbModule.findUserByUsername === 'function') {
        const acctRow = cleanAcct ? dbModule.findUserByUsername(cleanAcct) : null;
        const handleRow = (!acctRow && cleanHandle) ? dbModule.findUserByUsername(cleanHandle) : null;
        const row = acctRow || handleRow;
        if (row && row.id && !String(row.id).startsWith('gst_')) {
            resolvedUid = row.id;
        }
    }

    if (ws && typeof ws === 'object') {
        if (resolvedUid) ws.userId = resolvedUid;
        if (cleanAcct) ws.accountUsername = cleanAcct;
    }

    const record = {
        userId: resolvedUid || null,
        accountUsername: cleanAcct || cleanHandle,
        handle: cleanHandle || cleanAcct
    };

    if (cleanHandle) lobby.identityMap[cleanHandle.toLowerCase()] = record;
    if (cleanAcct) lobby.identityMap[cleanAcct.toLowerCase()] = record;

    return resolvedUid;
}

function matchesParticipantIdentity(entry, sockProp, ws, incomingUid, handle, accountUsername) {
    if (!entry || entry.isBot) return false;
    if (ws && entry[sockProp] && entry[sockProp] === ws) return true;
    if (incomingUid && entry.userId && String(entry.userId) === String(incomingUid)) return true;

    const hLower = (handle || '').trim().toLowerCase();
    const aLower = (accountUsername || '').trim().toLowerCase();
    const eName = (entry.username || '').trim().toLowerCase();
    const eAcct = (entry.accountUsername || '').trim().toLowerCase();

    if (aLower && (eAcct === aLower || eName === aLower)) return true;
    if (hLower && (eName === hLower || (eAcct && eAcct === hLower))) return true;
    return false;
}

// Determines whether an incoming username should rename an existing seat's handle.
// Blocks automatic force-close/rejoin resets ('Player1' or reverting to accountUsername).
function shouldRenameExistingHandle(oldHandle, newHandle, accountUsername, data) {
    const cleanOld = (oldHandle || '').trim();
    const cleanNew = (newHandle || '').trim();
    const cleanAcct = (accountUsername || '').trim();

    if (!cleanNew || cleanOld === cleanNew) return false;

    const newLower = cleanNew.toLowerCase();
    const oldLower = cleanOld.toLowerCase();
    const acctLower = cleanAcct.toLowerCase();

    // 1. Never rename a seat to a generic default placeholder
    if (newLower === 'player' || newLower === 'player1') return false;

    // 2. Never rename during an automatic reconnect
    if (data && data.isReconnect) return false;

    // 3. If the player already has a custom handle (different from their login accountUsername),
    // and the incoming join carries their raw login accountUsername, block the reset
    // (this happens when force-closing and reopening resets #username-input to the login name).
    if (acctLower && oldLower && oldLower !== acctLower && newLower === acctLower && !data?.explicitHandleChange) {
        return false;
    }

    return true;
}

// Renames a player's display handle in-place and migrates session ledgers & references
function renameParticipantHandle(lobby, oldHandle, newHandle, accountUsername, userId) {
    if (!lobby || !newHandle) return;
    const cleanOld = (oldHandle || '').trim();
    const cleanNew = (newHandle || '').trim();
    if (!cleanOld || cleanOld === cleanNew) return;

    const oldLower = cleanOld.toLowerCase();

    const migrateLedgerObject = (ledger) => {
        if (!ledger || typeof ledger !== 'object') return;
        for (const debtor of Object.keys(ledger)) {
            if (debtor.toLowerCase() === oldLower && debtor !== cleanNew) {
                if (!ledger[cleanNew]) ledger[cleanNew] = {};
                for (const cred of Object.keys(ledger[debtor] || {})) {
                    const targetCred = cred.toLowerCase() === oldLower ? cleanNew : cred;
                    if (targetCred !== cleanNew) {
                        ledger[cleanNew][targetCred] = (Number(ledger[cleanNew][targetCred]) || 0) + (Number(ledger[debtor][cred]) || 0);
                    }
                }
                delete ledger[debtor];
            }
        }
        for (const debtor of Object.keys(ledger)) {
            if (!ledger[debtor]) continue;
            for (const cred of Object.keys(ledger[debtor])) {
                if (cred.toLowerCase() === oldLower && cred !== cleanNew) {
                    if (debtor !== cleanNew) {
                        ledger[debtor][cleanNew] = (Number(ledger[debtor][cleanNew]) || 0) + (Number(ledger[debtor][cred]) || 0);
                    }
                    delete ledger[debtor][cred];
                }
            }
        }
    };

    migrateLedgerObject(lobby.mainGameLedger);
    migrateLedgerObject(lobby.sideBetLedger);
    migrateLedgerObject(lobby.botBetLedger);
    if (lobby.persistedLifetimeLedger) {
        migrateLedgerObject(lobby.persistedLifetimeLedger.main);
        migrateLedgerObject(lobby.persistedLifetimeLedger.side);
        migrateLedgerObject(lobby.persistedLifetimeLedger.loggedSide);
    }

    if (lobby.host && lobby.host.toLowerCase() === oldLower) lobby.host = cleanNew;
    if (lobby.dealerName && lobby.dealerName.toLowerCase() === oldLower) lobby.dealerName = cleanNew;
    if (lobby.lastGameWinner && lobby.lastGameWinner.toLowerCase() === oldLower) lobby.lastGameWinner = cleanNew;
    if (lobby.knockedBy && lobby.knockedBy.toLowerCase() === oldLower) lobby.knockedBy = cleanNew;

    if (lobby.drawResults && lobby.drawResults[cleanOld] !== undefined) {
        lobby.drawResults[cleanNew] = lobby.drawResults[cleanOld];
        delete lobby.drawResults[cleanOld];
    }
    if (Array.isArray(lobby.drawPool)) {
        lobby.drawPool.forEach(slot => {
            if (slot && slot.chosenBy && slot.chosenBy.toLowerCase() === oldLower) {
                slot.chosenBy = cleanNew;
            }
        });
    }
    if (Array.isArray(lobby.tiedParticipantsList)) {
        lobby.tiedParticipantsList = lobby.tiedParticipantsList.map(u =>
            (u && u.toLowerCase() === oldLower) ? cleanNew : u
        );
    }

    const updateBetParticipants = (list) => {
        if (!Array.isArray(list)) return;
        list.forEach(b => {
            if (!b) return;
            if (b.proposer && b.proposer.toLowerCase() === oldLower) b.proposer = cleanNew;
            if (b.bettor && b.bettor.toLowerCase() === oldLower) b.bettor = cleanNew;
            if (b.creator && b.creator.toLowerCase() === oldLower) b.creator = cleanNew;
            if (b.target && b.target.toLowerCase() === oldLower) b.target = cleanNew;
            if (b.pickUser && b.pickUser.toLowerCase() === oldLower) b.pickUser = cleanNew;
            if (b.targetSurvivor && b.targetSurvivor.toLowerCase() === oldLower) b.targetSurvivor = cleanNew;
            if (Array.isArray(b.acceptedBy)) {
                b.acceptedBy = b.acceptedBy.map(u => (u && u.toLowerCase() === oldLower) ? cleanNew : u);
            }
            if (Array.isArray(b.deniedBy)) {
                b.deniedBy = b.deniedBy.map(u => (u && u.toLowerCase() === oldLower) ? cleanNew : u);
            }
        });
    };

    updateBetParticipants(lobby.activeBets);
    updateBetParticipants(lobby.pendingBets);
    updateBetParticipants(lobby.globalProposals);
}

// Helper to reliably resolve a socket's canonical display handle in a lobby
function resolveSocketUsername(lobby, ws, fallbackUsername) {
    if (lobby) {
        const p = lobby.players.find(pl => pl.id === ws);
        if (p && p.username) return p.username;
        const s = (lobby.spectators || []).find(sp => sp.idSocket === ws);
        if (s && s.username) return s.username;
    }
    const rawFallback = (fallbackUsername || ws?.currentUsername || ws?.accountUsername || ws?.user?.username || '').trim();
    if (lobby && rawFallback) {
        const lower = rawFallback.toLowerCase();
        const pByName = lobby.players.find(pl =>
            (pl.username && pl.username.toLowerCase() === lower) ||
            (pl.accountUsername && pl.accountUsername.toLowerCase() === lower)
        );
        if (pByName) return pByName.username;
        const sByName = (lobby.spectators || []).find(sp =>
            (sp.username && sp.username.toLowerCase() === lower) ||
            (sp.accountUsername && sp.accountUsername.toLowerCase() === lower)
        );
        if (sByName) return sByName.username;
    }
    return rawFallback || null;
}

// -------------------------------------------------------------
// 1. LOBBY 30-SECOND READY TIMEOUT CONTROLLER
// -------------------------------------------------------------

function clearReadyCountdown(player) {
    if (!player) return;
    if (player.readyTimeout) {
        clearTimeout(player.readyTimeout);
        player.readyTimeout = null;
    }
    player.readyDeadline = null;
}

function startReadyCountdown(lobby, player, broadcastLobbyList) {
    if (!lobby || lobby.gameState !== 'lobby' || !player || player.isBot) return;

    clearReadyCountdown(player);
    player.readyDeadline = Date.now() + 30000;

    player.readyTimeout = setTimeout(() => {
        const curLobby = lobbies[lobby.code];
        if (!curLobby || curLobby.gameState !== 'lobby') return;

        const pIdx = curLobby.players.findIndex(p =>
            p === player ||
            (p.username && p.username.toLowerCase() === (player.username || '').toLowerCase())
        );
        if (pIdx === -1) return;

        const target = curLobby.players[pIdx];
        if (target && !target.ready) {
            clearReadyCountdown(target);
            const removed = curLobby.players.splice(pIdx, 1)[0];

            const alreadySpec = curLobby.spectators.some(s =>
                matchesParticipantIdentity(s, 'idSocket', target.id, removed.userId, removed.username, removed.accountUsername)
            );

            if (!alreadySpec) {
                curLobby.spectators.push({
                    idSocket: target.id,
                    userId: removed.userId || extractSocketUserId(target.id, null, curLobby) || null,
                    accountUsername: removed.accountUsername || removed.username,
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
    }, 30000);
}

// -------------------------------------------------------------
// 2. TURN TIMEOUT & LEVEL 8/10 AI ENGINE
// -------------------------------------------------------------

function calculateHandScore(cards) {
    if (!cards || !Array.isArray(cards) || cards.length === 0) return 0;
    const suitTotals = { '♠': 0, '♥': 0, '♦': 0, '♣': 0, S: 0, H: 0, D: 0, C: 0 };
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
    const actorIdentity = player.id || player.username;

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
        handleDiscardAction(lobby, actorIdentity, bestDiscardIdx);
        resetTurnTimer(lobby);
        return;
    }

    const canKnock = lobby.gameState === 'playing' 
        && !lobby.knockedBy 
        && cards.length === 3 
        && (lobby.turnsTakenThisRound || 0) >= active.length;

    const knockThreshold = active.length > 2 ? 26 : 25;
    if (canKnock && currentScore >= knockThreshold) {
        handleKnock(lobby, actorIdentity);
        resetTurnTimer(lobby);
        return;
    }

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

    handleTurnAction(lobby, actorIdentity, shouldDrawDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK');

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

        handleDiscardAction(curLobby, curPlayer.id || curPlayer.username, bestDiscardIndex);
        resetTurnTimer(curLobby);
    }, 600);
}

function clearTurnTimer(lobby) {
    if (!lobby) return;
    if (lobby.turnTimeoutTimer) {
        clearTimeout(lobby.turnTimeoutTimer);
        lobby.turnTimeoutTimer = null;
    }
    lobby.turnDeadline = null;
}

function resetTurnTimer(lobby) {
    if (!lobby) return;
    clearTurnTimer(lobby);

    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;

    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated) return;

    if (!currentPlayer.isBot) {
        const isDisconnected = !currentPlayer.id || (typeof currentPlayer.id === 'object' && currentPlayer.id.readyState !== WebSocket.OPEN);
        const timeoutMs = isDisconnected ? 5000 : 25000;
        lobby.turnDeadline = Date.now() + timeoutMs;

        lobby.turnTimeoutTimer = setTimeout(() => {
            const curLobby = lobbies[lobby.code];
            if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
            const p = curLobby.players[curLobby.turnIndex];
            if (!p || p.username !== currentPlayer.username) return;

            curLobby.phaseMessage = isDisconnected
                ? `🤖 ${p.username} is offline — AI Level 8 played their turn.`
                : `🤖 ${p.username} ran out of time! AI Level 8 played for them.`;
            executeLevel8AITurn(curLobby, p);
            broadcastLobbyUpdate(curLobby.code);
        }, timeoutMs);
    }
}

// -------------------------------------------------------------
// 3. MASTER WEBSOCKET MESSAGE DISPATCHER
// -------------------------------------------------------------

function attemptGameStart(lobby) {
    const seatedPlayers = lobby.players;
    if (seatedPlayers.length >= 2 && seatedPlayers.every(p => p.ready)) {
        lobby.forfeitedPlayers = [];
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

function handleWebSocketMessage(ws, message, broadcastLobbyList) {
    let data;
    try {
        data = typeof message === 'string' ? JSON.parse(message) : JSON.parse(message.toString());
    } catch (e) {
        return;
    }

    let currentLobbyCode = (ws.currentLobbyCode || data.code || '').trim().toUpperCase() || null;
    const activeLobby = currentLobbyCode ? lobbies[currentLobbyCode] : null;
    let currentAccountUsername = extractAccountUsername(ws, data, activeLobby);

    // Preserve the socket's seated handle in the lobby so reconnect payloads carrying
    // the login accountUsername do not clobber ws.currentUsername.
    const existingSeatHandle = activeLobby
        ? (activeLobby.players.find(p => p.id === ws)?.username ||
           activeLobby.spectators.find(s => s.idSocket === ws)?.username ||
           null)
        : null;

    let currentUsername = (existingSeatHandle || ws.currentUsername || data.username || '').trim() || null;

    if (currentLobbyCode && !ws.currentLobbyCode) ws.currentLobbyCode = currentLobbyCode;
    if (currentUsername && !ws.currentUsername) ws.currentUsername = currentUsername;
    if (currentAccountUsername) ws.accountUsername = currentAccountUsername;
    if (data.userId && !String(data.userId).startsWith('gst_')) ws.userId = data.userId;

    switch (data.type) {
        case 'PING': {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'PONG' }));
            }
            break;
        }

        case 'GET_LOBBIES':
        case 'REFRESH_LOBBIES': {
            if (typeof broadcastLobbyList === 'function') broadcastLobbyList();
            break;
        }

        case 'CREATE_LOBBY': {
            const username = (data.username || 'Player1').trim();
            const accountUsername = (currentAccountUsername || username).trim();
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
            const creatorUid = extractSocketUserId(ws, data, null);

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
                turnDeadline: null,
                phaseMessage: 'Waiting for players to ready up...',
                turnsTakenThisRound: 0,
                livesVote: null,
                endGameVote: null,
                forfeitedPlayers: [],
                ledgerHistory: [],
                lastReaction: null,
                identityMap: {},
                players: [{
                    id: ws,
                    userId: creatorUid,
                    accountUsername,
                    username,
                    lives: 2,
                    wager: 5,
                    cards: [],
                    ready: false,
                    readyDeadline: null,
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
                songPausedAtOffset: 0,
                turnTimeoutTimer: null
            };

            registerLobbyIdentity(newLobby, ws, username, accountUsername, creatorUid);

            lobbies[code] = newLobby;
            ws.currentLobbyCode = code;
            ws.currentUsername = username;
            ws.accountUsername = accountUsername;
            touchLobbyActivity(newLobby, broadcastLobbyList);

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

            const accountUsername = (extractAccountUsername(ws, data, lobby) || username).trim();
            const incomingUid = registerLobbyIdentity(lobby, ws, username, accountUsername, extractSocketUserId(ws, data, lobby));

            ws.currentLobbyCode = code;
            ws.accountUsername = accountUsername;
            touchLobbyActivity(lobby, broadcastLobbyList);

            // Match existing player by socket, userId, accountUsername, or handle
            const matchingPlayers = lobby.players.filter(p =>
                matchesParticipantIdentity(p, 'id', ws, incomingUid, username, accountUsername)
            );
            const matchingSpecs = lobby.spectators.filter(s =>
                matchesParticipantIdentity(s, 'idSocket', ws, incomingUid, username, accountUsername)
            );

            if (matchingPlayers.length > 0) {
                const existingPlayer = matchingPlayers[0];
                const wasOffline = !existingPlayer.id;
                const oldHandle = existingPlayer.username;

                // Remove any accidental duplicate player seats for this user
                if (matchingPlayers.length > 1) {
                    const dupes = new Set(matchingPlayers.slice(1));
                    lobby.players = lobby.players.filter(p => !dupes.has(p));
                    lobby.players.forEach((p, idx) => { p.seat = idx; });
                }

                existingPlayer.id = ws;
                if (incomingUid) existingPlayer.userId = incomingUid;
                if (accountUsername) existingPlayer.accountUsername = accountUsername;
                existingPlayer.disconnectedAt = null;

                // Only rename handle if it's a genuine custom handle change,
                // never a force-close/rejoin reset to 'Player1' or the raw login accountUsername.
                if (!wasOffline && shouldRenameExistingHandle(oldHandle, username, accountUsername, data)) {
                    existingPlayer.username = username;
                    renameParticipantHandle(lobby, oldHandle, username, accountUsername, existingPlayer.userId);
                }

                ws.currentUsername = existingPlayer.username;
                registerLobbyIdentity(lobby, ws, existingPlayer.username, accountUsername, existingPlayer.userId);

                if (existingPlayer.eliminated) {
                    if (matchingSpecs.length > 0) {
                        const existingSpec = matchingSpecs[0];
                        if (matchingSpecs.length > 1) {
                            const specDupes = new Set(matchingSpecs.slice(1));
                            lobby.spectators = lobby.spectators.filter(s => !specDupes.has(s));
                        }
                        existingSpec.idSocket = ws;
                        if (incomingUid) existingSpec.userId = incomingUid;
                        if (accountUsername) existingSpec.accountUsername = accountUsername;
                        existingSpec.username = existingPlayer.username;
                        existingSpec.disconnectedAt = null;
                    } else {
                        lobby.spectators.push({
                            idSocket: ws,
                            userId: existingPlayer.userId || incomingUid || null,
                            accountUsername: existingPlayer.accountUsername || accountUsername,
                            username: existingPlayer.username,
                            inVC: existingPlayer.inVC ?? true,
                            isMuted: existingPlayer.isMuted ?? true,
                            disconnectedAt: null
                        });
                    }
                } else {
                    // Ensure active seated player is not also listed in spectators
                    lobby.spectators = lobby.spectators.filter(s =>
                        !matchesParticipantIdentity(s, 'idSocket', ws, incomingUid, existingPlayer.username, accountUsername)
                    );
                    if (lobby.gameState === 'lobby' && !existingPlayer.ready) {
                        startReadyCountdown(lobby, existingPlayer, broadcastLobbyList);
                    } else if (wasOffline && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') && lobby.players[lobby.turnIndex] === existingPlayer) {
                        resetTurnTimer(lobby);
                    }
                }
            } else if (matchingSpecs.length > 0) {
                const existingSpec = matchingSpecs[0];
                const wasSpecOffline = !existingSpec.idSocket;
                const oldHandle = existingSpec.username;

                if (matchingSpecs.length > 1) {
                    const specDupes = new Set(matchingSpecs.slice(1));
                    lobby.spectators = lobby.spectators.filter(s => !specDupes.has(s));
                }

                existingSpec.idSocket = ws;
                if (incomingUid) existingSpec.userId = incomingUid;
                if (accountUsername) existingSpec.accountUsername = accountUsername;
                existingSpec.disconnectedAt = null;

                if (!wasSpecOffline && shouldRenameExistingHandle(oldHandle, username, accountUsername, data)) {
                    existingSpec.username = username;
                    renameParticipantHandle(lobby, oldHandle, username, accountUsername, existingSpec.userId);
                }

                ws.currentUsername = existingSpec.username;
                registerLobbyIdentity(lobby, ws, existingSpec.username, accountUsername, existingSpec.userId);
            } else {
                ws.currentUsername = username;
                if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const newPlayer = {
                        id: ws,
                        userId: incomingUid,
                        accountUsername,
                        username,
                        lives: lobby.defaultLives || 2,
                        wager: 5,
                        cards: [],
                        ready: false,
                        readyDeadline: null,
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
                        userId: incomingUid,
                        accountUsername,
                        username,
                        inVC: true,
                        isMuted: true,
                        disconnectedAt: null
                    });
                }
            }

            const finalLiveKitIdentity = ws.currentUsername || username;
            syncBotReadiness(lobby);
            generateLiveKitToken(code, finalLiveKitIdentity).then(token => {
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
                if (player) {
                    clearReadyCountdown(player);
                    if (typeof recordForfeitedPlayer === 'function') {
                        recordForfeitedPlayer(lobby, player);
                    }
                }

                leaveLobby(ws, currentLobbyCode, broadcastLobbyList);
                ws.currentLobbyCode = null;
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
            }
            break;
        }

        // ---------------------------------------------------------
        // ROOM CREATOR (HOST) ADMIN CONTROLS: KICK & MUTE
        // ---------------------------------------------------------
        case 'ADMIN_KICK_PLAYER': {
            const code = currentLobbyCode || ws.currentLobbyCode || data.code;
            const lobby = code ? lobbies[code] : null;
            if (lobby && data.targetUsername) {
                touchLobbyActivity(lobby, broadcastLobbyList);
                const reqName = resolveSocketUsername(lobby, ws, data.requesterUsername || currentUsername);
                if (reqName) ws.currentUsername = reqName;
                handleAdminKickPlayer(lobby, ws, data.targetUsername, broadcastLobbyList);
            }
            break;
        }

        case 'ADMIN_MUTE_PLAYER': {
            const code = currentLobbyCode || ws.currentLobbyCode || data.code;
            const lobby = code ? lobbies[code] : null;
            if (lobby && data.targetUsername) {
                touchLobbyActivity(lobby, broadcastLobbyList);
                const reqName = resolveSocketUsername(lobby, ws, data.requesterUsername || currentUsername);
                if (reqName) ws.currentUsername = reqName;
                handleAdminMutePlayer(lobby, ws, data.targetUsername);
            }
            break;
        }

        case 'SET_READY': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const incomingUid = extractSocketUserId(ws, data, lobby);
                const player = lobby.players.find(p =>
                    matchesParticipantIdentity(p, 'id', ws, incomingUid, currentUsername, currentAccountUsername)
                );
                if (player && lobby.gameState === 'lobby') {
                    player.id = ws;
                    player.userId = incomingUid || player.userId || null;
                    if (currentAccountUsername) player.accountUsername = currentAccountUsername;
                    player.ready = !!data.ready;

                    if (player.ready) {
                        clearReadyCountdown(player);
                    } else {
                        startReadyCountdown(lobby, player, broadcastLobbyList);
                    }

                    syncBotReadiness(lobby);
                    attemptGameStart(lobby);
                    broadcastLobbyUpdate(currentLobbyCode);
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
                    const uName = (data.username || currentUsername || ws.currentUsername || '').trim();
                    const acctName = extractAccountUsername(ws, data, lobby) || uName;
                    const incomingUid = extractSocketUserId(ws, data, lobby);

                    const pIdx = lobby.players.findIndex(p =>
                        matchesParticipantIdentity(p, 'id', ws, incomingUid, uName, acctName)
                    );

                    if (pIdx !== -1) {
                        const removed = lobby.players.splice(pIdx, 1)[0];
                        clearReadyCountdown(removed);

                        const alreadySpec = lobby.spectators.some(s =>
                            matchesParticipantIdentity(s, 'idSocket', ws, incomingUid || removed.userId, removed.username, removed.accountUsername || acctName)
                        );

                        if (!alreadySpec) {
                            lobby.spectators.push({
                                idSocket: ws,
                                userId: removed.userId || incomingUid || null,
                                accountUsername: removed.accountUsername || acctName || removed.username,
                                username: removed.username,
                                inVC: removed.inVC || false,
                                isMuted: removed.isMuted !== undefined ? removed.isMuted : true,
                                disconnectedAt: null
                            });
                        }

                        lobby.players.forEach((p, idx) => { p.seat = idx; });
                        syncBotReadiness(lobby);
                        attemptGameStart(lobby);
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
                if (lobby.gameState === 'lobby') {
                    const requestedHandle = (data.username || currentUsername || ws.currentUsername || '').trim();
                    const accountUsername = (extractAccountUsername(ws, data, lobby) || requestedHandle).trim();
                    const incomingUid = registerLobbyIdentity(lobby, ws, requestedHandle, accountUsername, extractSocketUserId(ws, data, lobby));

                    // 1. Check if already seated under socket, userId, accountUsername, or handle
                    const existingP = lobby.players.find(p =>
                        matchesParticipantIdentity(p, 'id', ws, incomingUid, requestedHandle, accountUsername)
                    );

                    if (existingP) {
                        const oldHandle = existingP.username;
                        existingP.id = ws;
                        if (incomingUid) existingP.userId = incomingUid;
                        if (accountUsername) existingP.accountUsername = accountUsername;
                        existingP.disconnectedAt = null;

                        if (shouldRenameExistingHandle(oldHandle, requestedHandle, accountUsername, data)) {
                            existingP.username = requestedHandle;
                            renameParticipantHandle(lobby, oldHandle, requestedHandle, accountUsername, existingP.userId);
                        }

                        ws.currentUsername = existingP.username;
                        lobby.spectators = lobby.spectators.filter(s =>
                            !matchesParticipantIdentity(s, 'idSocket', ws, incomingUid, existingP.username, accountUsername)
                        );
                        startReadyCountdown(lobby, existingP, broadcastLobbyList);
                        syncBotReadiness(lobby);
                        attemptGameStart(lobby);
                        broadcastLobbyUpdate(code);
                        if (broadcastLobbyList) broadcastLobbyList();
                        break;
                    }

                    if (lobby.players.length < 6) {
                        const sIdx = lobby.spectators.findIndex(s =>
                            matchesParticipantIdentity(s, 'idSocket', ws, incomingUid, requestedHandle, accountUsername)
                        );

                        const spec = (sIdx !== -1) ? lobby.spectators.splice(sIdx, 1)[0] : null;
                        const specHandle = spec?.username || '';
                        const targetUsername = (specHandle && !shouldRenameExistingHandle(specHandle, requestedHandle, accountUsername, data))
                            ? specHandle
                            : (requestedHandle || specHandle || currentUsername || ws.currentUsername);
                        const resolvedUid = incomingUid || spec?.userId || null;
                        const resolvedAcct = accountUsername || spec?.accountUsername || targetUsername;

                        if (targetUsername) {
                            if (spec && spec.username && spec.username !== targetUsername) {
                                renameParticipantHandle(lobby, spec.username, targetUsername, resolvedAcct, resolvedUid);
                            }
                            ws.currentUsername = targetUsername;
                            lobby.spectators = lobby.spectators.filter(s =>
                                !matchesParticipantIdentity(s, 'idSocket', ws, resolvedUid, targetUsername, resolvedAcct)
                            );

                            const openSeat = findOpenSeat(lobby);
                            const newPlayer = {
                                id: ws,
                                userId: resolvedUid,
                                accountUsername: resolvedAcct,
                                username: targetUsername,
                                lives: lobby.defaultLives || 2,
                                wager: 5,
                                cards: [],
                                ready: false,
                                readyDeadline: null,
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

                            syncBotReadiness(lobby);
                            attemptGameStart(lobby);
                            broadcastLobbyUpdate(code);
                            if (broadcastLobbyList) broadcastLobbyList();
                        }
                    }
                }
            }
            break;
        }

        case 'CHOOSE_POOL_CARD': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                const rawIdx = data.cardIndex !== undefined ? data.cardIndex : data.index;
                const cardIdx = Number(rawIdx);
                const pickerUsername = resolveSocketUsername(lobby, ws, currentUsername);

                if (!isNaN(cardIdx) && pickerUsername) {
                    touchLobbyActivity(lobby, broadcastLobbyList);
                    handlePoolCardSelection(lobby, pickerUsername, cardIdx);
                }
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
                const incomingUid = extractSocketUserId(ws, data, lobby);
                const player = lobby.players.find(p =>
                    matchesParticipantIdentity(p, 'id', ws, incomingUid, currentUsername, currentAccountUsername)
                );
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
        // 4. DEBT TRANSFER / NOVATION & LIFETIME LEDGER HANDLERS
        // ---------------------------------------------------------
        case 'TRANSFER_DEBT': {
            const code = currentLobbyCode || ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                const lobby = lobbies[code];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const myUsername = resolveSocketUsername(lobby, ws, currentUsername);
                if (!myUsername) break;

                const { fromDebtor, toCreditor, amount } = data;
                const transferAmt = Number(amount);
                if (!fromDebtor || !toCreditor || transferAmt <= 0) break;

                recordDebt(lobby.mainGameLedger, myUsername, fromDebtor, transferAmt);
                recordDebt(lobby.mainGameLedger, toCreditor, myUsername, transferAmt);
                recordDebt(lobby.mainGameLedger, fromDebtor, toCreditor, transferAmt);

                if (typeof addLedgerHistory === 'function') {
                    addLedgerHistory(
                        lobby,
                        `🔄 Debt Transfer: ${fromDebtor} moved $${transferAmt} (via ${myUsername}) to ${toCreditor}`,
                        'transfer'
                    );
                }

                if (typeof syncLifetimeLedgerBalances === 'function') {
                    syncLifetimeLedgerBalances(lobby);
                }

                broadcastLobbyUpdate(lobby.code);
            }
            break;
        }

        case 'TRANSFER_LIFETIME_DEBT': {
            const lobby = currentLobbyCode ? lobbies[currentLobbyCode] : null;
            const myUid = extractSocketUserId(ws, data, lobby) || data.myId;
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

        case 'APPLY_CREDIT': {
            const lobby = currentLobbyCode ? lobbies[currentLobbyCode] : null;
            const myUid = extractSocketUserId(ws, data, lobby) || data.debtorId;
            const otherId = data.creditorId;
            const creditAmt = Number(data.amount);

            if (dbModule && typeof dbModule.recordLifetimeDebt === 'function' && myUid && otherId && creditAmt > 0) {
                dbModule.recordLifetimeDebt(myUid, otherId, creditAmt);

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
            const lobby = currentLobbyCode ? lobbies[currentLobbyCode] : null;
            const uid = extractSocketUserId(ws, data, lobby);

            if (uid && !String(uid).startsWith('gst_') && dbModule && typeof dbModule.getLifetimeBalances === 'function') {
                const balances = dbModule.getLifetimeBalances(uid) || [];
                ws.send(JSON.stringify({
                    type: 'LIFETIME_LEDGER_DATA',
                    balances,
                    ledger: balances,
                    debts: balances
                }));
            } else {
                ws.send(JSON.stringify({
                    type: 'LIFETIME_LEDGER_DATA',
                    balances: [],
                    ledger: [],
                    debts: []
                }));
            }
            break;
        }

        case 'APPLY_SESSION_CREDIT':
        case 'CLEAR_DEBT': {
            let code = currentLobbyCode || ws.currentLobbyCode || data.code;
            let lobby = code ? lobbies[code] : null;

            if (!lobby) {
                const searchName = (data.creditor || currentUsername || ws.currentUsername || '').trim().toLowerCase();
                const searchAcct = (data.creditorAccount || currentAccountUsername || ws.accountUsername || '').trim().toLowerCase();
                lobby = Object.values(lobbies).find(l =>
                    (l.players || []).some(p =>
                        p.id === ws ||
                        (searchName && p.username.toLowerCase() === searchName) ||
                        (searchAcct && p.accountUsername && p.accountUsername.toLowerCase() === searchAcct)
                    ) ||
                    (l.spectators || []).some(s =>
                        s.idSocket === ws ||
                        (searchName && s.username.toLowerCase() === searchName) ||
                        (searchAcct && s.accountUsername && s.accountUsername.toLowerCase() === searchAcct)
                    )
                ) || null;
                if (lobby) code = lobby.code;
            }

            if (lobby && data.debtor) {
                touchLobbyActivity(lobby, broadcastLobbyList);
                const creditorName = resolveSocketUsername(lobby, ws, data.creditor || currentUsername);
                const creditAmount = Number(data.amount) || 0;

                if (creditorName && typeof applySessionCredit === 'function') {
                    applySessionCredit(lobby, creditorName, data.debtor, creditAmount);
                }

                broadcastLobbyUpdate(lobby.code);

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'SESSION_LEDGER_DATA',
                        mainGameLedger: lobby.mainGameLedger || {},
                        sideBetLedger: lobby.sideBetLedger || {},
                        botBetLedger: lobby.botBetLedger || {},
                        ledgerHistory: lobby.ledgerHistory || [],
                        activeBets: lobby.activeBets || []
                    }));
                }
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
                    ledgerHistory: lobby.ledgerHistory || [],
                    activeBets: lobby.activeBets || []
                }));
            }
            break;
        }

        case 'UPDATE_WAGER': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const incomingUid = extractSocketUserId(ws, data, lobby);
                const player = lobby.players.find(p =>
                    matchesParticipantIdentity(p, 'id', ws, incomingUid, currentUsername, currentAccountUsername)
                );
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

                const proposerName = resolveSocketUsername(lobby, ws, currentUsername) || 'Host';
                const seatedHumans = lobby.players.filter(p => !p.isBot);
                if (seatedHumans.length <= 1) {
                    lobby.defaultLives = requestedLives;
                    lobby.players.forEach(p => { p.lives = requestedLives; });
                    lobby.phaseMessage = `Starting lives updated to ${requestedLives}.`;
                    broadcastLobbyUpdate(currentLobbyCode);
                    return;
                }

                lobby.livesVote = {
                    proposer: proposerName,
                    proposedLives: requestedLives,
                    votes: { [proposerName]: true },
                    totalVoters: seatedHumans.length
                };

                lobby.phaseMessage = `🗳️ ${proposerName} proposed changing starting lives to ${requestedLives}!`;
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'VOTE_LIVES': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (!lobby.livesVote || lobby.gameState !== 'lobby') return;

                const incomingUid = extractSocketUserId(ws, data, lobby);
                const seatedHuman = lobby.players.find(p =>
                    !p.isBot && matchesParticipantIdentity(p, 'id', ws, incomingUid, currentUsername, currentAccountUsername)
                );
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
                        readyDeadline: null,
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
                    attemptGameStart(lobby);
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
            const targetRaw = data.targetUsername || data.target || data.username;
            if (currentLobbyCode && lobbies[currentLobbyCode] && targetRaw) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);

                const requesterName = resolveSocketUsername(lobby, ws, currentUsername);
                if (!requesterName) break;

                const targetLower = String(targetRaw).trim().toLowerCase();
                const targetPlayer = lobby.players.find(p => p.username.toLowerCase() === targetLower);
                if (targetPlayer && !targetPlayer.eliminated) {
                    if (!targetPlayer.peekRequests) targetPlayer.peekRequests = {};
                    if (!targetPlayer.peekAllowed) targetPlayer.peekAllowed = {};

                    if (targetPlayer.isBot) {
                        lobby.players.forEach(p => {
                            if (p.peekAllowed) {
                                Object.keys(p.peekAllowed).forEach(k => {
                                    if (k.toLowerCase() === requesterName.toLowerCase()) {
                                        delete p.peekAllowed[k];
                                    }
                                });
                            }
                        });
                        targetPlayer.peekAllowed[requesterName] = true;
                    } else {
                        targetPlayer.peekRequests[requesterName] = true;
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'RESPOND_PEEK': {
            const specRaw = data.spectatorUsername || data.requester || data.username;
            if (currentLobbyCode && lobbies[currentLobbyCode] && specRaw) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const incomingUid = extractSocketUserId(ws, data, lobby);
                const player = lobby.players.find(p =>
                    matchesParticipantIdentity(p, 'id', ws, incomingUid, currentUsername, currentAccountUsername)
                );
                if (player) {
                    const specName = String(specRaw).trim();
                    const specLower = specName.toLowerCase();
                    const isAllowed = data.allow !== undefined ? !!data.allow : !!data.accept;

                    if (player.peekRequests) {
                        Object.keys(player.peekRequests).forEach(k => {
                            if (k.toLowerCase() === specLower) delete player.peekRequests[k];
                        });
                    }
                    if (player.peekIncoming) {
                        Object.keys(player.peekIncoming).forEach(k => {
                            if (k.toLowerCase() === specLower) delete player.peekIncoming[k];
                        });
                    }

                    if (isAllowed) {
                        lobby.players.forEach(p => {
                            if (p.peekAllowed) {
                                Object.keys(p.peekAllowed).forEach(k => {
                                    if (k.toLowerCase() === specLower) {
                                        delete p.peekAllowed[k];
                                    }
                                });
                            }
                        });
                        if (!player.peekAllowed) player.peekAllowed = {};
                        player.peekAllowed[specName] = true;
                    } else if (player.peekAllowed) {
                        Object.keys(player.peekAllowed).forEach(k => {
                            if (k.toLowerCase() === specLower) delete player.peekAllowed[k];
                        });
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'KICK_PEEKER': {
            const targetRaw = data.spectatorUsername || data.requester || data.target || data.username;
            if (currentLobbyCode && lobbies[currentLobbyCode] && targetRaw) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const incomingUid = extractSocketUserId(ws, data, lobby);
                const player = lobby.players.find(p =>
                    matchesParticipantIdentity(p, 'id', ws, incomingUid, currentUsername, currentAccountUsername)
                );
                if (player && player.peekAllowed) {
                    const targetName = String(targetRaw).trim().toLowerCase();
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
                const myName = resolveSocketUsername(lobby, ws, currentUsername);
                const myLower = (myName || '').trim().toLowerCase();
                if (myLower) {
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
            }
            break;
        }

        case 'PROPOSE_ELIMINATION_BET': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const proposerName = resolveSocketUsername(lobby, ws, currentUsername);
                if (!proposerName) break;

                const wagerAmt = Math.max(1, parseInt(data.wagerAmt, 10) || 5);
                const targetRaw = String(data.target || '').trim();
                const targetPlayer = lobby.players.find(p => p.username && p.username.toLowerCase() === targetRaw.toLowerCase());
                const canonicalTarget = targetPlayer ? targetPlayer.username : targetRaw;

                if (targetPlayer && targetPlayer.isBot) {
                    if (!lobby.activeBets) lobby.activeBets = [];
                    lobby.activeBets.push({
                        id: `bet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                        type: 'eliminate',
                        proposer: proposerName,
                        bettor: proposerName,
                        target: canonicalTarget,
                        pickUser: canonicalTarget,
                        targetSurvivor: proposerName,
                        wagerAmt,
                        isBotBet: true,
                        createdAt: Date.now()
                    });
                    lobby.phaseMessage = `🤝 Bot Bet Accepted! ${targetPlayer.username} accepted ${proposerName}'s $${wagerAmt} bet!`;
                } else {
                    if (!lobby.pendingBets) lobby.pendingBets = [];
                    lobby.pendingBets.push({
                        id: `bet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                        type: 'eliminate',
                        proposer: proposerName,
                        bettor: proposerName,
                        target: canonicalTarget,
                        pickUser: canonicalTarget,
                        targetSurvivor: proposerName,
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
                const proposerName = resolveSocketUsername(lobby, ws, currentUsername);
                if (!proposerName) break;

                const wagerAmt = Math.max(1, parseInt(data.wagerAmt, 10) || 5);
                const newProp = {
                    id: data.id || `prop_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    proposer: proposerName,
                    creator: proposerName,
                    pickUser: data.pickUser || proposerName,
                    condition: data.condition || `I like ${data.pickUser || proposerName} to win`,
                    betType: data.betType || 'win',
                    wagerAmt,
                    acceptedBy: [],
                    deniedBy: [proposerName],
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
                const accepterName = resolveSocketUsername(lobby, ws, currentUsername);
                if (!accepterName) break;

                const propId = data.proposalId || data.betId || data.id;
                const prop = (lobby.globalProposals || []).find(gp => String(gp.id) === String(propId));
                const proposerName = prop ? (prop.proposer || prop.creator) : null;
                if (prop && (!proposerName || proposerName.toLowerCase() !== accepterName.toLowerCase())) {
                    if (!Array.isArray(prop.acceptedBy)) prop.acceptedBy = [];
                    if (!prop.acceptedBy.some(u => u.toLowerCase() === accepterName.toLowerCase())) {
                        prop.acceptedBy.push(accepterName);
                    }
                    if (Array.isArray(prop.deniedBy)) {
                        prop.deniedBy = prop.deniedBy.filter(u => u.toLowerCase() !== accepterName.toLowerCase());
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                }
            }
            break;
        }

        case 'DECLINE_GLOBAL_PROPOSAL':
        case 'CONFIRM_GLOBAL_BET':
        case 'RESPOND_GLOBAL_BET': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const actorName = resolveSocketUsername(lobby, ws, currentUsername);
                if (!actorName) break;

                const propId = data.proposalId || data.betId || data.id;
                const pIdx = (lobby.globalProposals || []).findIndex(gp => String(gp.id) === String(propId));

                if (pIdx !== -1) {
                    const prop = lobby.globalProposals[pIdx];
                    const proposerName = prop.proposer || prop.creator;
                    const isProposer = Boolean(proposerName && proposerName.toLowerCase() === actorName.toLowerCase());
                    const isAccept = data.type === 'DECLINE_GLOBAL_PROPOSAL'
                        ? false
                        : (data.confirm !== undefined ? !!data.confirm : (data.accept !== undefined ? !!data.accept : true));

                    const partnerUser = isProposer
                        ? (data.acceptedUser || (prop.acceptedBy && prop.acceptedBy[0]))
                        : actorName;

                    if (isProposer) {
                        if (isAccept && partnerUser) {
                            if (!lobby.activeBets) lobby.activeBets = [];
                            lobby.activeBets.push({
                                id: prop.id,
                                proposalId: prop.id,
                                proposer: proposerName,
                                bettor: proposerName,
                                target: partnerUser,
                                pickUser: prop.pickUser || proposerName,
                                condition: prop.condition || `I like ${prop.pickUser || proposerName} to win`,
                                wagerAmt: Number(prop.wagerAmt) || 5,
                                type: prop.betType || 'win',
                                createdAt: Date.now()
                            });
                            lobby.globalProposals.splice(pIdx, 1);
                            lobby.phaseMessage = `🤝 Side Bet Locked In: ${proposerName} vs ${partnerUser} ($${prop.wagerAmt || 5} on ${prop.pickUser || proposerName})!`;
                        } else if (partnerUser) {
                            prop.acceptedBy = (prop.acceptedBy || []).filter(u => u.toLowerCase() !== String(partnerUser).toLowerCase());
                            const targetPlayer = lobby.players.find(p => p.username && p.username.toLowerCase() === String(partnerUser).toLowerCase());
                            const targetSocket = targetPlayer?.id || lobby.spectators.find(s => s.username && s.username.toLowerCase() === String(partnerUser).toLowerCase())?.idSocket;
                            if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                                targetSocket.send(JSON.stringify({
                                    type: 'NOTIFICATION',
                                    message: `❌ ${proposerName} declined your side bet.`
                                }));
                            }
                        }
                    } else {
                        if (isAccept) {
                            if (!Array.isArray(prop.acceptedBy)) prop.acceptedBy = [];
                            if (!prop.acceptedBy.some(u => u.toLowerCase() === actorName.toLowerCase())) {
                                prop.acceptedBy.push(actorName);
                            }
                            if (Array.isArray(prop.deniedBy)) {
                                prop.deniedBy = prop.deniedBy.filter(u => u.toLowerCase() !== actorName.toLowerCase());
                            }
                        } else {
                            if (!Array.isArray(prop.deniedBy)) prop.deniedBy = [];
                            if (!prop.deniedBy.some(u => u.toLowerCase() === actorName.toLowerCase())) {
                                prop.deniedBy.push(actorName);
                            }
                            if (Array.isArray(prop.acceptedBy)) {
                                prop.acceptedBy = prop.acceptedBy.filter(u => u.toLowerCase() !== actorName.toLowerCase());
                            }
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
                const actorName = resolveSocketUsername(lobby, ws, currentUsername);
                const betId = data.betId || data.proposalId || data.id;
                const isAccept = data.accept !== undefined ? !!data.accept : !!data.confirm;

                const bIdx = (lobby.pendingBets || []).findIndex(b => String(b.id) === String(betId));
                if (bIdx !== -1) {
                    const bet = lobby.pendingBets.splice(bIdx, 1)[0];
                    if (isAccept) {
                        if (!lobby.activeBets) lobby.activeBets = [];
                        lobby.activeBets.push(bet);
                        lobby.phaseMessage = `🤝 First-to-Lose Bet Locked In: ${bet.proposer} vs ${bet.target} ($${bet.wagerAmt})!`;
                    }
                    broadcastLobbyUpdate(currentLobbyCode);
                } else if (actorName) {
                    const gpIdx = (lobby.globalProposals || []).findIndex(gp => String(gp.id) === String(betId));
                    if (gpIdx !== -1) {
                        const prop = lobby.globalProposals[gpIdx];
                        const proposerName = prop.proposer || prop.creator;
                        if (!lobby.activeBets) lobby.activeBets = [];

                        const alreadyExists = lobby.activeBets.some(b =>
                            b.proposalId === prop.id &&
                            ((b.proposer === proposerName && b.target === actorName) ||
                             (b.target === proposerName && b.proposer === actorName))
                        );

                        if (isAccept && !alreadyExists) {
                            if (!prop.acceptedBy) prop.acceptedBy = [];
                            if (!prop.acceptedBy.some(u => u.toLowerCase() === actorName.toLowerCase())) {
                                prop.acceptedBy.push(actorName);
                            }

                            lobby.activeBets.push({
                                id: `gbet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                proposalId: prop.id,
                                type: prop.betType || 'win',
                                proposer: proposerName,
                                bettor: proposerName,
                                target: actorName,
                                pickUser: prop.pickUser || proposerName,
                                wagerAmt: Number(prop.wagerAmt) || 5,
                                condition: prop.condition || 'Win the Match',
                                createdAt: Date.now()
                            });
                        } else if (!isAccept) {
                            if (!prop.deniedBy) prop.deniedBy = [];
                            if (!prop.deniedBy.some(u => u.toLowerCase() === actorName.toLowerCase())) {
                                prop.deniedBy.push(actorName);
                            }
                            if (prop.acceptedBy) {
                                prop.acceptedBy = prop.acceptedBy.filter(u => u.toLowerCase() !== actorName.toLowerCase());
                            }
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
                const senderName = resolveSocketUsername(lobby, ws, currentUsername) || 'Unknown';
                const msgObj = { user: senderName, text: String(data.message).slice(0, 200) };
                if (!lobby.chatHistory) lobby.chatHistory = [];
                lobby.chatHistory.push(msgObj);
                if (lobby.chatHistory.length > 50) lobby.chatHistory.shift();
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'SEND_REACTION':
        case 'SEAT_REACTION':
        case 'QUICK_REACTION': {
            const code = (data.code || currentLobbyCode || ws.currentLobbyCode || '').toUpperCase();
            const lobby = lobbies[code];
            if (!lobby) break;

            const allowedReactions = [
                '🔥', '💀', '👏', '💸', '👀', '😂',
                'sb:horn', 'sb:cash', 'sb:rimshot', 'sb:sad', 'sb:crickets', 'sb:siren'
            ];
            const rawEmoji = String(data.emoji || data.reaction || '').trim();
            if (!allowedReactions.includes(rawEmoji)) break;

            const senderName = resolveSocketUsername(lobby, ws, data.username || currentUsername) || 'Player';
            lobby.lastReaction = {
                id: `rx_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                username: senderName,
                emoji: rawEmoji,
                timestamp: Date.now()
            };
            broadcastLobbyUpdate(lobby.code);
            break;
        }

        // ---------------------------------------------------------
        // 5. END GAME VOTE ENGINE
        // ---------------------------------------------------------
        case 'END_GAME_PROPOSAL': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);

                if (lobby.endGameVote) return;

                const proposerName = resolveSocketUsername(lobby, ws, currentUsername) || 'Host';
                const seatedHumans = lobby.players.filter(p => !p.isBot);

                if (seatedHumans.length <= 1) {
                    clearTurnTimer(lobby);
                    resetLobbyToReadyRoom(lobby, `${proposerName} ended the match.`, broadcastLobbyList);
                    return;
                }

                lobby.endGameVote = {
                    proposer: proposerName,
                    votes: { [proposerName]: true },
                    totalVoters: seatedHumans.length
                };

                lobby.phaseMessage = `🗳️ ${proposerName} proposed ending the match! Cast your vote.`;
                broadcastLobbyUpdate(currentLobbyCode);
            }
            break;
        }

        case 'VOTE_END_GAME': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (!lobby.endGameVote) return;

                const incomingUid = extractSocketUserId(ws, data, lobby);
                const seatedHuman = lobby.players.find(p =>
                    !p.isBot && matchesParticipantIdentity(p, 'id', ws, incomingUid, currentUsername, currentAccountUsername)
                );
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

        case 'UPDATE_VC_STATUS':
        case 'VC_STATUS_UPDATE': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                const uName = (data.username || currentUsername || ws.currentUsername || '').trim();
                const incomingUid = extractSocketUserId(ws, data, lobby);
                const player = lobby.players.find(p =>
                    matchesParticipantIdentity(p, 'id', ws, incomingUid, uName, currentAccountUsername)
                );
                const spec = lobby.spectators.find(s =>
                    matchesParticipantIdentity(s, 'idSocket', ws, incomingUid, uName, currentAccountUsername)
                );
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
                const disconnectedUid = extractSocketUserId(ws, null, lobby);
                
                const player = lobby.players.find(p => p.id === ws);
                if (player) {
                    clearReadyCountdown(player);
                    if (disconnectedUid) player.userId = disconnectedUid;
                    if (ws.accountUsername && !player.accountUsername) player.accountUsername = ws.accountUsername;
                    player.id = null;
                    player.disconnectedAt = Date.now();

                    if ((lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') && lobby.players[lobby.turnIndex] === player) {
                        resetTurnTimer(lobby);
                    }

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
                    if (disconnectedUid) spec.userId = disconnectedUid;
                    if (ws.accountUsername && !spec.accountUsername) spec.accountUsername = ws.accountUsername;
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
    clearTurnTimer,
    executeLevel8AITurn,
    startReadyCountdown,
    clearReadyCountdown
};
