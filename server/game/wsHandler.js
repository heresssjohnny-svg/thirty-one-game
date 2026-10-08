// server/game/wsHandler.js - Master WebSocket Router, Lifetime Ledger, LiveKit & Action Dispatcher
const WebSocket = require('ws');
const path = require('path');
const lobbyManager = require('./lobbyManager');
const { generateLiveKitToken } = require('../services/livekit');
const config = require('../config');
const ledger = require('./ledger');

// Resilient SQLite Database & Auth Resolvers
let db = null;
for (const p of ['../db', '../../db', '../services/db', '../../server/db']) {
    try { db = require(p); break; } catch (e) {}
}

let auth = null;
for (const p of ['../auth', '../../auth', '../services/auth', '../../server/auth']) {
    try { auth = require(p); break; } catch (e) {}
}

function generateLobbyCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function broadcastLobbyList(wss) {
    if (typeof lobbyManager.getPublicLobbiesList !== 'function') return;
    const list = lobbyManager.getPublicLobbiesList();
    const payload = JSON.stringify({ type: 'LOBBY_LIST', lobbies: list });
    if (wss && wss.clients) {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

function setupWebSocket(wss, customBroadcastList) {
    const triggerBroadcast = customBroadcastList || (() => broadcastLobbyList(wss));

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        let currentLobbyCode = null;
        let currentUsername = null;

        ws.on('message', async (message) => {
            let data;
            try {
                data = JSON.parse(message);
            } catch (e) {
                return;
            }

            if (!data || typeof data !== 'object') return;

            // -------------------------------------------------------------
            // 1. AUTHENTICATION & LIFETIME LEDGER (SQLITE)
            // -------------------------------------------------------------
            if (data.type === 'AUTH_TOKEN' && auth && typeof auth.verifyToken === 'function') {
                const decoded = auth.verifyToken(data.token);
                if (decoded) ws.user = decoded;
                return;
            }

            if (data.type === 'GET_LIFETIME_LEDGER') {
                const username = (data.username || (ws.user && ws.user.username) || '').trim();
                let userId = (ws.user && (ws.user.userId || ws.user.id)) || data.userId || null;
                let isGuest = data.isGuest;

                if (db) {
                    let userRow = null;
                    if (userId && typeof db.getUserById === 'function') {
                        userRow = db.getUserById(userId);
                    }
                    if (!userRow && username && typeof db.getUserByUsername === 'function') {
                        userRow = db.getUserByUsername(username);
                    }

                    if (userRow) {
                        userId = userRow.id || userRow.userId;
                        isGuest = false;
                    }
                }

                if (!isGuest && userId && db && typeof db.getLifetimeBalances === 'function') {
                    const balances = db.getLifetimeBalances(userId);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'LIFETIME_LEDGER_DATA',
                            balances: balances || [],
                            isGuest: false
                        }));
                    }
                } else {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'LIFETIME_LEDGER_DATA',
                            balances: [],
                            isGuest: isGuest || !userId
                        }));
                    }
                }
                return;
            }

            if (data.type === 'APPLY_CREDIT' && db && typeof db.applyCredit === 'function') {
                let creditorId = (ws.user && (ws.user.userId || ws.user.id)) || data.userId;
                const isGuest = ws.user ? !!ws.user.isGuest : !!data.isGuest;
                const creditorUsername = data.username || (ws.user && ws.user.username);

                if (!creditorId && creditorUsername && typeof db.getUserByUsername === 'function') {
                    const userRow = db.getUserByUsername(creditorUsername);
                    if (userRow) creditorId = userRow.id || userRow.userId;
                }

                if (!isGuest && creditorId && data.debtorId && data.amount) {
                    const result = db.applyCredit(creditorId, data.debtorId, Number(data.amount));
                    const balances = db.getLifetimeBalances(creditorId);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'LIFETIME_LEDGER_DATA',
                            balances: balances || [],
                            creditResult: result
                        }));
                    }
                }
                return;
            }

            // -------------------------------------------------------------
            // 2. LOBBY BROWSING & TABLE CREATION
            // -------------------------------------------------------------
            if (data.type === 'REFRESH_LOBBIES' || data.type === 'GET_LOBBIES') {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'LOBBY_LIST',
                        lobbies: lobbyManager.getPublicLobbiesList()
                    }));
                }
                return;
            }

            if (data.type === 'CREATE_LOBBY') {
                currentUsername = (data.username || (ws.user && ws.user.username) || 'Player1').trim();
                const lobbyName = (data.lobbyName || `${currentUsername}'s Table`).trim();

                if (typeof lobbyManager.isLobbyNameTaken === 'function' && lobbyManager.isLobbyNameTaken(lobbyName)) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: `A table named "${lobbyName}" already exists. Please choose a different name.`
                        }));
                    }
                    return;
                }

                currentLobbyCode = generateLobbyCode();
                const lobbies = lobbyManager.getLobbies();

                lobbies[currentLobbyCode] = {
                    code: currentLobbyCode,
                    name: lobbyName,
                    host: currentUsername,
                    isPrivate: !!data.isPrivate,
                    gameState: 'lobby',
                    defaultLives: 2,
                    deck: [],
                    discardPile: [],
                    drawPool: [],
                    drawResults: {},
                    drawOrderSequence: [],
                    tiedParticipantsList: [],
                    turnIndex: 0,
                    dealerIndex: 0,
                    turnsTakenThisRound: 0,
                    finalTurnsRemaining: 0,
                    knockedBy: null,
                    lastGameWinner: null,
                    tournamentWinner: null,
                    hit31Player: null,
                    phaseMessage: 'Waiting for players to ready up...',
                    players: [{
                        id: ws,
                        username: currentUsername,
                        lives: 2,
                        wager: 5,
                        ready: false,
                        cards: [],
                        seat: 0,
                        eliminated: false,
                        isBot: false,
                        disconnected: false,
                        inVC: true,
                        isMuted: true,
                        nextHandReady: false,
                        peekAllowed: {},
                        peekRequests: {}
                    }],
                    spectators: [],
                    activeBets: [],
                    pendingBets: [],
                    globalProposals: [],
                    chatHistory: [],
                    playlist: [],
                    currentSongIndex: 0,
                    isPlaying: false,
                    songStartedAt: null,
                    songPausedAtOffset: 0,
                    fedCardReminders: {},
                    fedCardsHistory: {},
                    lastDiscardPickup: null,
                    lastDiscardDonor: null
                };

                lobbyManager.touchLobbyActivity(lobbies[currentLobbyCode], triggerBroadcast);

                const token = await generateLiveKitToken(currentLobbyCode, currentUsername);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'LOBBY_CREATED',
                        code: currentLobbyCode,
                        lobby: lobbyManager.getSanitizedLobby(lobbies[currentLobbyCode], ws),
                        livekitToken: token,
                        livekitHost: config.LIVEKIT_HOST
                    }));
                }

                triggerBroadcast();
                return;
            }

            // -------------------------------------------------------------
            // 3. TABLE JOIN & RECONNECT HANDSHAKE
            // -------------------------------------------------------------
            if (data.type === 'JOIN_LOBBY') {
                const code = (data.code || '').trim().toUpperCase();
                const lobbies = lobbyManager.getLobbies();
                const lobby = lobbies[code];

                if (!lobby) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Table not found.' }));
                    }
                    return;
                }

                currentUsername = (data.username || (ws.user && ws.user.username) || 'Player').trim();
                currentLobbyCode = code;

                const existingPlayer = lobby.players.find(
                    p => p.username.toLowerCase() === currentUsername.toLowerCase()
                );
                const existingSpec = lobby.spectators.find(
                    s => s.username.toLowerCase() === currentUsername.toLowerCase()
                );

                if (existingPlayer) {
                    existingPlayer.id = ws;
                    existingPlayer.disconnected = false;
                    lobby.spectators = lobby.spectators.filter(
                        s => s.username.toLowerCase() !== currentUsername.toLowerCase()
                    );
                } else if (existingSpec) {
                    existingSpec.idSocket = ws;
                } else if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                    lobby.players.push({
                        id: ws,
                        username: currentUsername,
                        lives: lobby.defaultLives || 2,
                        wager: 5,
                        ready: false,
                        cards: [],
                        seat: lobbyManager.findOpenSeat(lobby),
                        eliminated: false,
                        isBot: false,
                        disconnected: false,
                        inVC: true,
                        isMuted: true,
                        nextHandReady: false,
                        peekAllowed: {},
                        peekRequests: {}
                    });
                } else {
                    lobby.spectators.push({ idSocket: ws, username: currentUsername, inVC: true, isMuted: true });
                }

                lobbyManager.touchLobbyActivity(lobby, triggerBroadcast);

                const token = await generateLiveKitToken(currentLobbyCode, currentUsername);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'LOBBY_JOINED',
                        code: currentLobbyCode,
                        lobby: lobbyManager.getSanitizedLobby(lobby, ws),
                        livekitToken: token,
                        livekitHost: config.LIVEKIT_HOST
                    }));
                }

                lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                triggerBroadcast();
                return;
            }

            // -------------------------------------------------------------
            // 4. IN-GAME ACTION ROUTING
            // -------------------------------------------------------------
            const lobbies = lobbyManager.getLobbies();
            let lobby = currentLobbyCode ? lobbies[currentLobbyCode] : null;

            if (lobby) {
                lobbyManager.touchLobbyActivity(lobby, triggerBroadcast);
                const player = lobby.players.find(p => p.id === ws);
                const activeUsername = player ? player.username : currentUsername;

                // Voice / VC Status Update[span_8](start_span)[span_8](end_span)
                if (data.type === 'VOICE_STATUS' || data.type === 'VC_STATUS_UPDATE') {
                    const inVC = !!data.inVC;
                    const isMuted = data.isMuted !== undefined ? !!data.isMuted : true;
                    if (player) {
                        player.inVC = inVC;
                        player.isMuted = isMuted;
                    } else {
                        const spec = lobby.spectators.find(s => s.idSocket === ws);
                        if (spec) {
                            spec.inVC = inVC;
                            spec.isMuted = isMuted;
                        }
                    }
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                } else if (data.type === 'MUTE_TOGGLE') {
                    const isMuted = !!data.isMuted;
                    if (player) {
                        player.isMuted = isMuted;
                    } else {
                        const spec = lobby.spectators.find(s => s.idSocket === ws);
                        if (spec) spec.isMuted = isMuted;
                    }
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                }

                // Ready Up[span_9](start_span)[span_9](end_span)
                else if (data.type === 'SET_READY' && player) {
                    player.ready = !!data.ready;
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);

                    const activeParts = lobbyManager.getActiveParticipants(lobby);
                    if (activeParts.length >= 2 && activeParts.every(p => p.ready)) {
                        if (typeof lobbyManager.startRound === 'function') {
                            lobbyManager.startRound(lobby);
                        } else if (typeof lobbyManager.startDealerDrawPhase === 'function') {
                            lobbyManager.startDealerDrawPhase(lobby);
                        }
                    }
                }

                // Card Turn Actions[span_10](start_span)[span_10](end_span)
                else if (data.type === 'DRAW_DECK' || data.type === 'DRAW_DISCARD') {
                    lobbyManager.handleTurnAction(lobby, ws, data.type);
                } else if (data.type === 'DISCARD_CARD') {
                    const idx = data.index !== undefined ? data.index : data.cardIndex;
                    lobbyManager.handleDiscardAction(lobby, ws, Number(idx));
                } else if (data.type === 'KNOCK') {
                    lobbyManager.handleKnock(lobby, ws, () => lobbyManager.broadcastLobbyUpdate(currentLobbyCode));
                } else if (data.type === 'CHOOSE_POOL_CARD' && player) {
                    lobbyManager.handlePoolCardSelection(lobby, activeUsername, Number(data.cardIndex));
                }

                // Next Hand[span_11](start_span)[span_11](end_span)
                else if (data.type === 'NEXT_HAND_READY' || data.type === 'NEXT_HAND') {
                    if (player) {
                        player.nextHandReady = true;
                        lobbyManager.checkNextHandReady(lobby);
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }
                }

                // Table Seating Controls[span_12](start_span)[span_12](end_span)
                else if (data.type === 'STAND_UP' && player && lobby.gameState === 'lobby') {
                    lobby.players = lobby.players.filter(p => p.id !== ws);
                    lobby.spectators.push({ idSocket: ws, username: player.username, inVC: player.inVC, isMuted: player.isMuted });
                    lobby.players.forEach((p, idx) => { p.seat = idx; });
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    triggerBroadcast();
                } else if (data.type === 'SIT_DOWN' && lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const specIdx = lobby.spectators.findIndex(s => s.idSocket === ws);
                    if (specIdx !== -1) {
                        const spec = lobby.spectators.splice(specIdx, 1)[0];
                        lobby.players.push({
                            id: ws,
                            username: spec.username,
                            lives: lobby.defaultLives || 2,
                            wager: 5,
                            ready: false,
                            cards: [],
                            seat: lobbyManager.findOpenSeat(lobby),
                            eliminated: false,
                            isBot: false,
                            disconnected: false,
                            inVC: !!spec.inVC,
                            isMuted: spec.isMuted !== undefined ? spec.isMuted : true,
                            nextHandReady: false,
                            peekAllowed: {},
                            peekRequests: {}
                        });
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                        triggerBroadcast();
                    }
                }

                // Settings & Wagers[span_13](start_span)[span_13](end_span)
                else if (data.type === 'UPDATE_WAGER' && player && lobby.gameState === 'lobby') {
                    player.wager = parseInt(data.wager, 10) || 5;
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                } else if (data.type === 'UPDATE_SETTINGS' && lobby.gameState === 'lobby') {
                    const proposedLives = parseInt(data.lives, 10) || 2;
                    const humanPlayers = lobby.players.filter(p => !p.isBot);
                    if (humanPlayers.length <= 1) {
                        lobby.defaultLives = proposedLives;
                        lobby.players.forEach(p => { p.lives = proposedLives; });
                    } else {
                        lobby.livesVote = {
                            proposer: activeUsername || 'Host',
                            proposedLives,
                            votes: { [activeUsername]: true }
                        };
                    }
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                } else if (data.type === 'VOTE_LIVES' && lobby.livesVote && activeUsername) {
                    lobby.livesVote.votes[activeUsername] = !!data.agree;
                    const seatedHumans = lobby.players.filter(p => !p.isBot);
                    if (seatedHumans.every(h => lobby.livesVote.votes[h.username] !== undefined)) {
                        const agreeCount = Object.values(lobby.livesVote.votes).filter(Boolean).length;
                        if (agreeCount > seatedHumans.length / 2) {
                            lobby.defaultLives = lobby.livesVote.proposedLives;
                            lobby.players.forEach(p => { p.lives = lobby.defaultLives; });
                            lobby.phaseMessage = `Lives updated to ${lobby.defaultLives}.`;
                        } else {
                            lobby.phaseMessage = `Proposed lives vote failed.`;
                        }
                        lobby.livesVote = null;
                    }
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                }

                // Bot Controls[span_14](start_span)[span_14](end_span)
                else if (data.type === 'ADD_BOT' && lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const botCount = lobby.players.filter(p => p.isBot).length + 1;
                    lobby.players.push({
                        id: null,
                        username: `Bot-${botCount}`,
                        lives: lobby.defaultLives || 2,
                        wager: 5,
                        ready: true,
                        cards: [],
                        seat: lobbyManager.findOpenSeat(lobby),
                        eliminated: false,
                        isBot: true,
                        disconnected: false,
                        inVC: false,
                        isMuted: true,
                        nextHandReady: true,
                        peekAllowed: {},
                        peekRequests: {}
                    });
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    triggerBroadcast();
                } else if (data.type === 'REMOVE_BOT' && lobby.gameState === 'lobby') {
                    const botIdx = lobby.players.map(p => p.isBot).lastIndexOf(true);
                    if (botIdx !== -1) {
                        lobby.players.splice(botIdx, 1);
                        lobby.players.forEach((p, idx) => { p.seat = idx; });
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                        triggerBroadcast();
                    }
                }

                // Side Bet Proposals & Directives[span_15](start_span)[span_15](end_span)
                else if (data.type === 'PROPOSE_ELIMINATION_BET' && activeUsername) {
                    const target = data.target;
                    const wagerAmt = parseInt(data.wagerAmt, 10) || 5;
                    lobby.pendingBets = lobby.pendingBets || [];
                    lobby.pendingBets.push({
                        id: `elim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                        type: 'eliminate',
                        proposer: activeUsername,
                        target,
                        pickUser: target,
                        targetSurvivor: activeUsername,
                        wagerAmt
                    });
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                } else if (data.type === 'PROPOSE_GLOBAL_SIDE_BET' && activeUsername) {
                    const wagerAmt = parseInt(data.wagerAmt, 10) || 5;
                    lobby.globalProposals = lobby.globalProposals || [];
                    lobby.globalProposals.push({
                        id: `glob_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                        proposer: activeUsername,
                        pickUser: data.pickUser,
                        wagerAmt,
                        acceptedBy: []
                    });
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                } else if (data.type === 'ACCEPT_GLOBAL_PROPOSAL' && activeUsername) {
                    const prop = (lobby.globalProposals || []).find(gp => gp.id === data.proposalId);
                    if (prop && prop.proposer !== activeUsername && !prop.acceptedBy.includes(activeUsername)) {
                        prop.acceptedBy.push(activeUsername);
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }
                } else if (data.type === 'CONFIRM_GLOBAL_BET' && activeUsername) {
                    const propIdx = (lobby.globalProposals || []).findIndex(gp => gp.id === data.proposalId);
                    if (propIdx !== -1) {
                        const prop = lobby.globalProposals[propIdx];
                        if (prop.proposer === activeUsername) {
                            if (data.confirm) {
                                lobby.activeBets = lobby.activeBets || [];
                                lobby.activeBets.push({
                                    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                                    type: 'win',
                                    proposer: prop.proposer,
                                    target: data.acceptedUser,
                                    pickUser: prop.pickUser,
                                    wagerAmt: prop.wagerAmt
                                });
                            }
                            prop.acceptedBy = prop.acceptedBy.filter(u => u !== data.acceptedUser);
                            if (prop.acceptedBy.length === 0) {
                                lobby.globalProposals.splice(propIdx, 1);
                            }
                            lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                } else if (data.type === 'RESPOND_BET' && activeUsername) {
                    const idx = (lobby.pendingBets || []).findIndex(b => b.id === data.betId);
                    if (idx !== -1) {
                        const bet = lobby.pendingBets[idx];
                        lobby.pendingBets.splice(idx, 1);
                        if (data.accept) {
                            lobby.activeBets = lobby.activeBets || [];
                            lobby.activeBets.push(bet);
                        }
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }
                } else if (data.type === 'CLEAR_DEBT') {
                    if (typeof ledger.clearDebt === 'function') {
                        ledger.clearDebt(lobby, activeUsername, data.targetUser, data.category || data.ledgerType);
                    } else {
                        const isBot = lobby.players.some(p => (p.username === data.debtor || p.username === data.creditor) && p.isBot);
                        const ledgerMap = isBot ? lobby.botBetLedger : (data.ledgerType === 'side' ? lobby.sideBetLedger : lobby.mainGameLedger);
                        if (typeof ledger.clearDebts === 'function') {
                            ledger.clearDebts(ledgerMap, data.debtor, data.creditor);
                        }
                    }
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                }

                // Peeking Hand Controls[span_16](start_span)[span_16](end_span)
                else if (data.type === 'REQUEST_PEEK' && activeUsername) {
                    const targetUser = (data.targetUsername || data.targetUser || '').toLowerCase();
                    const targetP = lobby.players.find(p => p.username.toLowerCase() === targetUser);
                    if (targetP) {
                        targetP.peekRequests = targetP.peekRequests || {};
                        targetP.peekRequests[activeUsername] = true;
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }
                } else if (data.type === 'RESPOND_PEEK' || data.type === 'ACCEPT_PEEK') {
                    const specName = data.spectatorUsername || data.targetUser;
                    if (player) {
                        player.peekRequests = player.peekRequests || {};
                        if (specName) delete player.peekRequests[specName];
                        if (data.allow || data.type === 'ACCEPT_PEEK') {
                            player.peekAllowed = player.peekAllowed || {};
                            if (specName) player.peekAllowed[specName] = true;
                        }
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }
                } else if (data.type === 'DENY_PEEK') {
                    const specName = data.spectatorUsername || data.targetUser;
                    if (player && player.peekRequests && specName) {
                        delete player.peekRequests[specName];
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }
                } else if (data.type === 'STOP_PEEK' && activeUsername) {
                    lobby.players.forEach(p => {
                        if (p.peekAllowed) delete p.peekAllowed[activeUsername];
                        if (p.peekRequests) delete p.peekRequests[activeUsername];
                    });
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                } else if (data.type === 'KICK_PEEKER' && player) {
                    const specName = data.spectatorUsername || data.targetUser;
                    if (player.peekAllowed && specName) delete player.peekAllowed[specName];
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                }

                // End Game Proposal[span_17](start_span)[span_17](end_span)
                else if (data.type === 'END_GAME_PROPOSAL') {
                    lobbyManager.resetLobbyToReadyRoom(lobby, 'Game ended by mutual proposal.', triggerBroadcast);
                }

                // YouTube Player Actions[span_18](start_span)[span_18](end_span)
                else if ([
                    'YT_PLAY', 'YT_PAUSE', 'YT_SKIP', 'YT_PREV', 'YT_ADD_SONG', 'YT_REMOVE_SONG'
                ].includes(data.type)) {
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
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                }

                // Chat[span_19](start_span)[span_19](end_span)
                else if (data.type === 'CHAT_MESSAGE') {
                    const sender = activeUsername || (lobby.spectators.find(s => s.idSocket === ws)?.username) || 'Player';
                    lobby.chatHistory = lobby.chatHistory || [];
                    lobby.chatHistory.push({ user: sender, text: String(data.message || '').trim().substring(0, 200) });
                    if (lobby.chatHistory.length > 50) lobby.chatHistory.shift();
                    lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                }

                // Intentional Exit[span_20](start_span)[span_20](end_span)
                else if (data.type === 'LEAVE_LOBBY') {
                    lobbyManager.leaveLobby(ws, currentLobbyCode, triggerBroadcast);
                    currentLobbyCode = null;
                    ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                }
            }
        });

        // Graceful disconnect on network drop, app backgrounding, or screen sleep[span_21](start_span)[span_21](end_span)[span_22](start_span)[span_22](end_span)
        ws.on('close', () => {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                if (typeof lobbyManager.handleDisconnect === 'function') {
                    lobbyManager.handleDisconnect(ws, currentLobbyCode, triggerBroadcast);
                } else {
                    const lobby = lobbies[currentLobbyCode];
                    const p = lobby.players.find(pl => pl.id === ws);
                    if (p) p.id = null;
                    const s = lobby.spectators.find(sp => sp.idSocket === ws);
                    if (s) s.idSocket = null;
                }
            }
        });
    });
}

module.exports = {
    setupWebSocket,
    broadcastLobbyList
};
