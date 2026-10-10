// server/game/wsHandler.js - WebSocket Event Relay & Gameplay Actions (PART 1 OF 2)
const WebSocket = require('ws');
const {
    lobbies,
    touchLobbyActivity,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    findOpenSeat,
    startDealerDrawPhase,
    startRound,
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

function handleWebSocketMessage(ws, message, broadcastLobbyList) {
    let data;
    try {
        data = typeof message === 'string' ? JSON.parse(message) : JSON.parse(message.toString());
    } catch (e) {
        return;
    }

    let currentLobbyCode = ws.currentLobbyCode || null;
    let currentUsername = ws.currentUsername || null;

    switch (data.type) {
        case 'GET_LOBBIES': {
            if (typeof broadcastLobbyList === 'function') broadcastLobbyList();
            break;
        }

        case 'CREATE_LOBBY': {
            const code = Math.random().toString(36).substring(2, 7).toUpperCase();
            const username = (data.username || 'Player1').trim();
            const lobbyName = (data.lobbyName || `${username}'s Room`).trim();
            const isPrivate = !!data.isPrivate;

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
            } else if (existingSpec) {
                existingSpec.idSocket = ws;
                existingSpec.disconnectedAt = null;
            } else {
                if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    lobby.players.push({
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
                    });
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
                    syncBotReadiness(lobby);
                    broadcastLobbyUpdate(currentLobbyCode);

                    const activePlayers = lobby.players.filter(p => !p.eliminated);
                    if (activePlayers.length >= 2 && activePlayers.every(p => p.ready)) {
                        startDealerDrawPhase(lobby);
                    }
                }
            }
            break;
        }

        case 'STAND_UP': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (lobby.gameState === 'lobby') {
                    const pIdx = lobby.players.findIndex(p => p.id === ws);
                    if (pIdx !== -1) {
                        const removed = lobby.players.splice(pIdx, 1)[0];
                        lobby.spectators.push({
                            idSocket: ws,
                            username: removed.username,
                            inVC: removed.inVC,
                            isMuted: removed.isMuted,
                            disconnectedAt: null
                        });
                        syncBotReadiness(lobby);
                        broadcastLobbyUpdate(currentLobbyCode);
                        if (broadcastLobbyList) broadcastLobbyList();
                    }
                }
            }
            break;
        }

        case 'SIT_DOWN': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                if (lobby.gameState === 'lobby' && lobby.players.length < 6) {
                    const sIdx = lobby.spectators.findIndex(s => s.idSocket === ws);
                    if (sIdx !== -1) {
                        const spec = lobby.spectators.splice(sIdx, 1)[0];
                        lobby.players.push({
                            id: ws,
                            username: spec.username,
                            lives: lobby.defaultLives || 2,
                            wager: 5,
                            cards: [],
                            ready: false,
                            seat: findOpenSeat(lobby),
                            eliminated: false,
                            isBot: false,
                            inVC: spec.inVC,
                            isMuted: spec.isMuted,
                            nextHandReady: false,
                            peekRequests: {},
                            peekAllowed: {},
                            disconnectedAt: null
                        });
                        syncBotReadiness(lobby);
                        broadcastLobbyUpdate(currentLobbyCode);
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

        case 'DRAW_DECK': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                handleTurnAction(lobby, ws, 'DRAW_DECK');
            }
            break;
        }

        case 'DRAW_DISCARD': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                handleTurnAction(lobby, ws, 'DRAW_DISCARD');
            }
            break;
        }

        case 'DISCARD_CARD': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                const cardIdx = (data.index !== undefined) ? data.index : data.cardIndex;
                if (typeof cardIdx === 'number') {
                    handleDiscardAction(lobby, ws, cardIdx);
                }
            }
            break;
        }

        case 'KNOCK': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                handleKnock(lobby, ws);
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
                }
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
// server/game/wsHandler.js - PART 2 OF 2

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
                    deniedBy: [currentUsername], // Creator cannot accept their own bet
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
                        ? (data.acceptedUser || data.target || data.username || (prop.acceptedBy && prop.acceptedBy[0]))
                        : currentUsername;

                    if (!lobby.activeBets) lobby.activeBets = [];

                    // Prevent duplicate bet records between the identical pair for this proposal
                    const alreadyExists = lobby.activeBets.some(b =>
                        b.proposalId === prop.id &&
                        ((b.proposer === proposerName && b.target === partnerUser) ||
                         (b.target === proposerName && b.proposer === partnerUser))
                    );

                    if (isAccept && partnerUser && partnerUser !== proposerName && !alreadyExists) {
                        lobby.activeBets.push({
                            id: `gbet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                            proposalId: prop.id,
                            type: prop.betType || 'win',
                            proposer: proposerName,
                            bettor: proposerName,
                            target: partnerUser,
                            pickUser: prop.pickUser || proposerName,
                            wagerAmt: Number(prop.wagerAmt) || 5,
                            condition: prop.condition || 'Win the Match',
                            createdAt: Date.now()
                        });
                    }

                    if (isProposer) {
                        if (partnerUser) {
                            prop.acceptedBy = (prop.acceptedBy || []).filter(u => u !== partnerUser);
                        }
                        if (!prop.acceptedBy || prop.acceptedBy.length === 0) {
                            lobby.globalProposals.splice(pIdx, 1);
                        }
                    } else {
                        if (!prop.deniedBy) prop.deniedBy = [];
                        if (!prop.acceptedBy) prop.acceptedBy = [];

                        if (isAccept) {
                            if (!prop.acceptedBy.includes(currentUsername)) prop.acceptedBy.push(currentUsername);
                        } else {
                            if (!prop.deniedBy.includes(currentUsername)) prop.deniedBy.push(currentUsername);
                            prop.acceptedBy = prop.acceptedBy.filter(u => u !== currentUsername);
                        }

                        const activeHumans = lobby.players.filter(p => !p.eliminated).map(p => p.username);
                        const totalResponded = new Set([...prop.acceptedBy, ...prop.deniedBy, proposerName]);
                        if (activeHumans.every(u => totalResponded.has(u))) {
                            lobby.globalProposals.splice(pIdx, 1);
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

        case 'END_GAME_PROPOSAL': {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                const lobby = lobbies[currentLobbyCode];
                touchLobbyActivity(lobby, broadcastLobbyList);
                resetLobbyToReadyRoom(lobby, `${currentUsername} ended the match.`, broadcastLobbyList);
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
            // Target the specific room the user was in
            if (ws.currentLobbyCode && lobbies[ws.currentLobbyCode]) {
                const lobby = lobbies[ws.currentLobbyCode];
                
                // Mark player as temporarily disconnected (Starts the 90s grace period)
                const player = lobby.players.find(p => p.id === ws);
                if (player) {
                    player.id = null;
                    player.disconnectedAt = Date.now();
                    broadcastLobbyUpdate(ws.currentLobbyCode);
                }
                
                // Mark spectator as temporarily disconnected
                const spec = lobby.spectators.find(s => s.idSocket === ws);
                if (spec) {
                    spec.idSocket = null;
                    spec.disconnectedAt = Date.now();
                }
                
                // Trigger inactivity timer to clean up if the lobby stays empty
                touchLobbyActivity(lobby, broadcastLobbyList);
            }
        });

      });      
             
}

module.exports = {
    handleWebSocketMessage,
    handleWsMessage: handleWebSocketMessage,
    setupWebSocket
};
