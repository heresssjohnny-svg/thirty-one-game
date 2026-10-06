// server/game/wsHandler.js
const { generateLiveKitToken } = require('../services/livekit');
const { BOT_NAMES, syncBotReadiness } = require('./bot');
const config = require('../config');
const lm = require('./lobbyManager');

function setupWebSocket(wss) {
    function broadcastLobbyList() {
        const list = lm.getPublicLobbiesList();
        const payload = JSON.stringify({ type: 'LOBBY_LIST', lobbies: list });
        wss.clients.forEach(c => {
            if (c.readyState === 1) c.send(payload);
        });
    }

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        let currentLobbyCode = null;
        let currentUsername = null;

        ws.on('message', async (message) => {
            let data;
            try { data = JSON.parse(message); } catch (e) { return; }

            try {
                if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                    lm.touchLobbyActivity(lm.lobbies[currentLobbyCode], broadcastLobbyList);
                }

                switch (data.type) {
                    case 'CREATE_LOBBY': {
                        currentUsername = (data.username || 'Player').trim();
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            lm.leaveLobby(ws, currentLobbyCode, broadcastLobbyList);
                        }

                        currentLobbyCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                        ws.lobbyCode = currentLobbyCode;
                        ws.username = currentUsername;

                        lm.lobbies[currentLobbyCode] = {
                            code: currentLobbyCode,
                            name: data.lobbyName || `${currentUsername}'s Table`,
                            host: currentUsername,
                            isPrivate: !!data.isPrivate,
                            players: [{
                                id: ws,
                                username: currentUsername,
                                lives: 2,
                                wager: 5,
                                cards: [],
                                ready: false,
                                seat: 0,
                                nextHandReady: false,
                                eliminated: false,
                                isBot: false,
                                inVC: true,
                                isMuted: true,
                                peekRequests: {},
                                peekAllowed: {}
                            }],
                            spectators: [],
                            deck: [],
                            discardPile: [],
                            gameState: 'lobby',
                            drawPool: [],
                            drawResults: {},
                            drawOrderSequence: [],
                            tiedParticipantsList: [],
                            pendingBotDraw: {},
                            phaseMessage: null,
                            initialDealCard: null,
                            lastDiscardPickup: null,
                            lastDiscardDonor: null,
                            fedCardReminders: {},
                            turnIndex: 0,
                            dealerIndex: 0,
                            lastGameWinner: null,
                            tournamentWinner: null,
                            sideBetLedger: {},
                            mainGameLedger: {},
                            botBetLedger: {},
                            pendingBets: [],
                            activeBets: [],
                            globalProposals: [],
                            knockedBy: null,
                            finalTurnsRemaining: 0,
                            turnsTakenThisRound: 0,
                            endGameVotes: {},
                            chatHistory: [],
                            playlist: [],
                            currentSongIndex: 0,
                            isPlaying: false,
                            songStartedAt: null,
                            songPausedAtOffset: 0,
                            inactivityTimer: null
                        };
                        lm.touchLobbyActivity(lm.lobbies[currentLobbyCode], broadcastLobbyList);

                        const token = await generateLiveKitToken(currentLobbyCode, currentUsername);
                        ws.send(JSON.stringify({
                            type: 'LOBBY_JOINED',
                            lobby: lm.getSanitizedLobby(lm.lobbies[currentLobbyCode], ws),
                            livekitHost: config.LIVEKIT_HOST,
                            livekitToken: token,
                            token
                        }));
                        broadcastLobbyList();
                        break;
                    }

                    case 'JOIN_LOBBY': {
                        const code = (data.code || '').toUpperCase();
                        if (lm.lobbies[code]) {
                            currentLobbyCode = code;
                            currentUsername = (data.username || 'Player').trim();
                            ws.lobbyCode = code;
                            ws.username = currentUsername;

                            const lobby = lm.lobbies[code];
                            lm.touchLobbyActivity(lobby, broadcastLobbyList);

                            const token = await generateLiveKitToken(code, currentUsername);

                            const existingPlayer = lobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
                            if (existingPlayer) {
                                existingPlayer.id = ws;
                                ws.send(JSON.stringify({
                                    type: 'LOBBY_JOINED',
                                    lobby: lm.getSanitizedLobby(lobby, ws),
                                    livekitHost: config.LIVEKIT_HOST,
                                    livekitToken: token,
                                    token
                                }));
                                lm.broadcastLobbyUpdate(code);
                                broadcastLobbyList();
                                return;
                            }

                            const existingSpec = lobby.spectators.find(s => s.username.toLowerCase() === currentUsername.toLowerCase());
                            if (existingSpec) {
                                existingSpec.idSocket = ws;
                                ws.send(JSON.stringify({
                                    type: 'LOBBY_JOINED',
                                    lobby: lm.getSanitizedLobby(lobby, ws),
                                    livekitHost: config.LIVEKIT_HOST,
                                    livekitToken: token,
                                    token
                                }));
                                lm.broadcastLobbyUpdate(code);
                                broadcastLobbyList();
                                return;
                            }

                            if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                                const availableSeat = lm.findOpenSeat(lobby);
                                lobby.players.push({
                                    id: ws,
                                    username: currentUsername,
                                    lives: lobby.players[0]?.lives || 2,
                                    wager: 5,
                                    cards: [],
                                    ready: false,
                                    seat: availableSeat,
                                    nextHandReady: false,
                                    eliminated: false,
                                    isBot: false,
                                    inVC: true,
                                    isMuted: true,
                                    peekRequests: {},
                                    peekAllowed: {}
                                });
                            } else {
                                lobby.spectators.push({ username: currentUsername, idSocket: ws, inVC: true, isMuted: true });
                            }

                            syncBotReadiness(lobby);
                            ws.send(JSON.stringify({
                                type: 'LOBBY_JOINED',
                                lobby: lm.getSanitizedLobby(lobby, ws),
                                livekitHost: config.LIVEKIT_HOST,
                                livekitToken: token,
                                token
                            }));
                            lm.broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                        } else {
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                        }
                        break;
                    }

                    case 'REQUEST_LIVEKIT_TOKEN': {
                        if (currentLobbyCode && currentUsername) {
                            const token = await generateLiveKitToken(currentLobbyCode, currentUsername);
                            ws.send(JSON.stringify({
                                type: 'LIVEKIT_TOKEN',
                                livekitHost: config.LIVEKIT_HOST,
                                livekitToken: token,
                                token
                            }));
                        }
                        break;
                    }

                    case 'ADD_BOT': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            if (lobby.players.length < 6) {
                                const availableNames = BOT_NAMES.filter(n => !lobby.players.some(p => p.username.startsWith(n)));
                                const chosen = (availableNames[Math.floor(Math.random() * availableNames.length)] || ('Bot' + (lobby.players.length + 1))) + ' (B)';
                                lobby.players.push({
                                    id: 'bot_' + Math.random().toString(36).substring(2, 9),
                                    username: chosen,
                                    isBot: true,
                                    lives: lobby.defaultLives || 2,
                                    wager: lobby.defaultWager || 5,
                                    cards: [],
                                    ready: false,
                                    seat: lm.findOpenSeat(lobby),
                                    nextHandReady: false,
                                    eliminated: false,
                                    inVC: false,
                                    isMuted: true,
                                    peekRequests: {},
                                    peekAllowed: {}
                                });
                                syncBotReadiness(lobby);
                                lobby.phaseMessage = `🤖 ${chosen} joined the table.`;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'REMOVE_BOT': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            let botIdx = -1;
                            for (let i = lobby.players.length - 1; i >= 0; i--) {
                                if (lobby.players[i].isBot) {
                                    botIdx = i;
                                    break;
                                }
                            }
                            if (botIdx !== -1) {
                                const removed = lobby.players.splice(botIdx, 1)[0];
                                syncBotReadiness(lobby);
                                lobby.phaseMessage = `🤖 ${removed.username} was removed.`;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'UPDATE_VC_STATUS': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const p = lobby.players.find(pl => pl.username === currentUsername) || lobby.spectators.find(s => s.username === currentUsername);
                            if (p) {
                                p.inVC = !!data.inVC;
                                p.isMuted = !!data.isMuted;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'ADD_PLAYLIST_SONG': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            lm.touchLobbyActivity(lobby, broadcastLobbyList);
                            const title = (data.title || '').trim();
                            const url = (data.url || '').trim();
                            if (title && url) {
                                if (!lobby.playlist) lobby.playlist = [];
                                lobby.playlist.push({ title, url });
                                if (lobby.playlist.length === 1) {
                                    lobby.currentSongIndex = 0;
                                    lobby.isPlaying = true;
                                    lobby.songStartedAt = Date.now();
                                    lobby.songPausedAtOffset = 0;
                                }
                                lobby.phaseMessage = `🎵 ${currentUsername} added "${title}" to queue!`;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'REMOVE_PLAYLIST_SONG': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            lm.touchLobbyActivity(lobby, broadcastLobbyList);
                            const index = data.index;
                            if (lobby.playlist?.[index]) {
                                const removed = lobby.playlist.splice(index, 1)[0];
                                if (lobby.playlist.length === 0) {
                                    lobby.isPlaying = false;
                                    lobby.songStartedAt = null;
                                    lobby.songPausedAtOffset = 0;
                                } else if (lobby.currentSongIndex >= lobby.playlist.length) {
                                    lobby.currentSongIndex = 0;
                                    lobby.songStartedAt = Date.now();
                                    lobby.songPausedAtOffset = 0;
                                }
                                lobby.phaseMessage = `🎵 ${currentUsername} removed "${removed.title}".`;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'CONTROL_MUSIC': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            lm.touchLobbyActivity(lobby, broadcastLobbyList);
                            if (data.action === 'PLAY') {
                                if (!lobby.isPlaying) {
                                    lobby.isPlaying = true;
                                    lobby.songStartedAt = Date.now() - (lobby.songPausedAtOffset * 1000);
                                }
                            } else if (data.action === 'PAUSE') {
                                if (lobby.isPlaying) {
                                    lobby.isPlaying = false;
                                    const elapsed = lobby.songStartedAt ? Math.floor((Date.now() - lobby.songStartedAt) / 1000) : 0;
                                    lobby.songPausedAtOffset = Math.max(0, elapsed);
                                }
                            } else if (data.action === 'SKIP' && lobby.playlist?.length > 0) {
                                lobby.currentSongIndex = (lobby.currentSongIndex + 1) % lobby.playlist.length;
                                lobby.isPlaying = true;
                                lobby.songStartedAt = Date.now();
                                lobby.songPausedAtOffset = 0;
                            } else if (data.action === 'SELECT' && typeof data.index === 'number' && lobby.playlist?.[data.index]) {
                                lobby.currentSongIndex = data.index;
                                lobby.isPlaying = true;
                                lobby.songStartedAt = Date.now();
                                lobby.songPausedAtOffset = 0;
                            }
                            lm.broadcastLobbyUpdate(currentLobbyCode);
                        }
                        break;
                    }

                    case 'STAND_UP': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const playerIdx = lobby.players.findIndex(p => p.username === currentUsername);
                            if (playerIdx !== -1) {
                                const leaving = lobby.players.splice(playerIdx, 1)[0];
                                lobby.spectators.push({ username: leaving.username, idSocket: ws, inVC: leaving.inVC, isMuted: leaving.isMuted });
                                syncBotReadiness(lobby);
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                                broadcastLobbyList();
                            }
                        }
                        break;
                    }

                    case 'SIT_DOWN': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const specIdx = lobby.spectators.findIndex(s => s.username === currentUsername);
                            if (specIdx !== -1 && lobby.players.length < 6 && lobby.gameState === 'lobby') {
                                const spec = lobby.spectators.splice(specIdx, 1)[0];
                                lobby.players.push({
                                    id: ws,
                                    username: spec.username,
                                    lives: lobby.players[0]?.lives || 2,
                                    wager: 5,
                                    cards: [],
                                    ready: false,
                                    seat: lm.findOpenSeat(lobby),
                                    nextHandReady: false,
                                    eliminated: false,
                                    isBot: false,
                                    inVC: spec.inVC,
                                    isMuted: spec.isMuted,
                                    peekRequests: {},
                                    peekAllowed: {}
                                });
                                syncBotReadiness(lobby);
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                                broadcastLobbyList();
                            }
                        }
                        break;
                    }

                    case 'REFRESH_LOBBIES': {
                        ws.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: lm.getPublicLobbiesList() }));
                        break;
                    }

                    case 'UPDATE_WAGER': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const player = lm.lobbies[currentLobbyCode].players.find(p => p.username === currentUsername);
                            if (player && lm.lobbies[currentLobbyCode].gameState === 'lobby') {
                                player.wager = parseInt(data.wager, 10) || 5;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'UPDATE_SETTINGS': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            if (lobby.host.toLowerCase() === currentUsername.toLowerCase() && lobby.gameState === 'lobby') {
                                if (data.lives) {
                                    const l = parseInt(data.lives, 10);
                                    lobby.defaultLives = l;
                                    lobby.players.forEach(p => { p.lives = Math.max(0, l); });
                                }
                                if (data.wager) {
                                    lobby.defaultWager = parseInt(data.wager, 10);
                                    lobby.players.forEach(p => { p.wager = lobby.defaultWager; });
                                }
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'CLEAR_DEBT': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const { targetUser, category } = data;
                            const targetLedger = category === 'main' ? lobby.mainGameLedger : (category === 'bot' ? lobby.botBetLedger : lobby.sideBetLedger);

                            if (targetLedger) {
                                if (targetLedger[targetUser]?.[currentUsername] !== undefined) targetLedger[targetUser][currentUsername] = 0;
                                if (targetLedger[currentUsername]?.[targetUser] !== undefined) targetLedger[currentUsername][targetUser] = 0;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'PROPOSE_BET': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const targetPlayer = lobby.players.find(p => p.username === data.target);
                            if (targetPlayer?.isBot) {
                                lobby.activeBets.push({
                                    id: Math.random().toString(36).substring(2, 8),
                                    proposer: currentUsername,
                                    target: targetPlayer.username,
                                    type: data.betType,
                                    pickUser: data.pickUser,
                                    wagerAmt: parseFloat(data.wagerAmt) || 5,
                                    isBotBet: true
                                });
                                lobby.phaseMessage = `🤝 Bot Bet Accepted! ${targetPlayer.username} accepted ${currentUsername}'s bet!`;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            } else if (targetPlayer) {
                                lobby.pendingBets.push({
                                    id: Math.random().toString(36).substring(2, 8),
                                    proposer: currentUsername,
                                    target: targetPlayer.username,
                                    type: data.betType,
                                    pickUser: data.pickUser,
                                    wagerAmt: parseFloat(data.wagerAmt) || 5,
                                    delivered: {}
                                });
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'PROPOSE_ELIMINATION_BET': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const targetPlayer = lobby.players.find(p => p.username === data.target);
                            if (targetPlayer?.isBot) {
                                lobby.activeBets.push({
                                    id: Math.random().toString(36).substring(2, 8),
                                    proposer: currentUsername,
                                    target: targetPlayer.username,
                                    pickUser: data.target,
                                    wagerAmt: parseFloat(data.wagerAmt) || 5,
                                    type: 'eliminate',
                                    isBotBet: true
                                });
                                lobby.phaseMessage = `🤝 Bot Bet Accepted! ${targetPlayer.username} accepted elimination bet!`;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            } else {
                                lobby.pendingBets.push({
                                    id: Math.random().toString(36).substring(2, 8),
                                    proposer: currentUsername,
                                    target: data.target,
                                    pickUser: data.target,
                                    wagerAmt: parseFloat(data.wagerAmt) || 5,
                                    type: 'eliminate',
                                    delivered: {}
                                });
                                lobby.phaseMessage = `🤝 Elimination Bet proposed by ${currentUsername} to ${data.target}!`;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'PROPOSE_GLOBAL_SIDE_BET': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            lobby.globalProposals.push({
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                pickUser: data.pickUser,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                acceptedBy: []
                            });
                            lm.broadcastLobbyUpdate(currentLobbyCode);
                        }
                        break;
                    }

                    case 'ACCEPT_GLOBAL_PROPOSAL': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const prop = lm.lobbies[currentLobbyCode].globalProposals.find(gp => gp.id === data.proposalId);
                            if (prop && !prop.acceptedBy.includes(currentUsername) && prop.proposer !== currentUsername) {
                                prop.acceptedBy.push(currentUsername);
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'CONFIRM_GLOBAL_BET': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const prop = lobby.globalProposals.find(gp => gp.id === data.proposalId && gp.proposer === currentUsername);
                            if (prop && prop.acceptedBy.includes(data.acceptedUser)) {
                                if (data.confirm) {
                                    lobby.activeBets.push({
                                        id: Math.random().toString(36).substring(2, 8),
                                        proposer: prop.proposer,
                                        target: data.acceptedUser,
                                        pickUser: prop.pickUser,
                                        wagerAmt: prop.wagerAmt,
                                        type: 'win'
                                    });
                                }
                                prop.acceptedBy = prop.acceptedBy.filter(u => u !== data.acceptedUser);
                                if (prop.acceptedBy.length === 0) lobby.globalProposals = lobby.globalProposals.filter(gp => gp.id !== prop.id);
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'RESPOND_BET': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const betIdx = lobby.pendingBets.findIndex(b => b.id === data.betId);
                            if (betIdx !== -1) {
                                const bet = lobby.pendingBets.splice(betIdx, 1)[0];
                                if (data.accept) lobby.activeBets.push(bet);
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'SET_READY': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const player = lobby.players.find(p => p.username === currentUsername);
                            if (player && lobby.gameState === 'lobby' && !player.eliminated) {
                                player.ready = !!data.ready;
                                syncBotReadiness(lobby);

                                const activeParts = lm.getActiveParticipants(lobby);
                                if (activeParts.length >= 2 && activeParts.every(p => p.ready)) {
                                    if (lobby.lastGameWinner && lobby.players.some(p => p.username === lobby.lastGameWinner)) {
                                        const winIdx = lobby.players.findIndex(p => p.username === lobby.lastGameWinner);
                                        lobby.dealerIndex = winIdx !== -1 ? winIdx : 0;
                                        lm.startRound(lobby);
                                    } else {
                                        lm.startDealerDrawPhase(lobby);
                                    }
                                } else {
                                    lm.broadcastLobbyUpdate(currentLobbyCode);
                                }
                            }
                        }
                        break;
                    }

                    case 'NEXT_HAND':
                    case 'NEXT_HAND_READY': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            const player = lobby.players.find(p => p.username === currentUsername);
                            if (player && lobby.gameState === 'roundOver' && !player.eliminated) {
                                player.nextHandReady = true;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                                lm.checkNextHandReady(lobby);
                            }
                        }
                        break;
                    }

                    case 'END_GAME_PROPOSAL': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            if (!lobby.endGameVotes) lobby.endGameVotes = {};
                            lobby.endGameVotes[currentUsername] = true;
                            const activeParts = lm.getActiveParticipants(lobby);
                            if (activeParts.every(p => lobby.endGameVotes[p.username])) {
                                lm.resetLobbyToReadyRoom(lobby, "⚠️ Game ended! Returning to waiting room.", broadcastLobbyList);
                            } else {
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'REQUEST_PEEK': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const target = lm.lobbies[currentLobbyCode].players.find(p => p.username.toLowerCase() === (data.targetUsername || '').toLowerCase());
                            if (target) {
                                if (!target.peekRequests) target.peekRequests = {};
                                target.peekRequests[currentUsername] = true;
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'RESPOND_PEEK': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const player = lm.lobbies[currentLobbyCode].players.find(p => p.username === currentUsername);
                            if (player) {
                                delete player.peekRequests?.[data.spectatorUsername];
                                if (data.allow) {
                                    if (!player.peekAllowed) player.peekAllowed = {};
                                    player.peekAllowed[data.spectatorUsername] = true;
                                }
                                lm.broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                        break;
                    }

                    case 'STOP_PEEK': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            lm.touchLobbyActivity(lobby, broadcastLobbyList);
                            lobby.players.forEach(pl => {
                                if (pl.peekAllowed) delete pl.peekAllowed[currentUsername];
                            });
                            lm.broadcastLobbyUpdate(currentLobbyCode);
                        }
                        break;
                    }

                    case 'CHOOSE_POOL_CARD': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const lobby = lm.lobbies[currentLobbyCode];
                            if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
                                lm.handlePoolCardSelection(lobby, currentUsername, data.cardIndex);
                            }
                        }
                        break;
                    }

                    case 'CHAT_MESSAGE': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            const chatPayload = { type: 'CHAT_MESSAGE', username: currentUsername, message: data.message };
                            lm.lobbies[currentLobbyCode].players.forEach(p => {
                                if (p.id?.readyState === 1) p.id.send(JSON.stringify(chatPayload));
                            });
                            lm.lobbies[currentLobbyCode].spectators.forEach(s => {
                                if (s.idSocket?.readyState === 1) s.idSocket.send(JSON.stringify(chatPayload));
                            });
                        }
                        break;
                    }

                    case 'DRAW_DECK':
                    case 'DRAW_DISCARD': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            lm.handleTurnAction(lm.lobbies[currentLobbyCode], ws, data.type);
                        }
                        break;
                    }

                    case 'DISCARD_CARD': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            lm.handleDiscardAction(lm.lobbies[currentLobbyCode], ws, data.cardIndex);
                        }
                        break;
                    }

                    case 'KNOCK': {
                        if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                            lm.handleKnock(lm.lobbies[currentLobbyCode], ws);
                        }
                        break;
                    }

                    case 'LEAVE_LOBBY': {
                        lm.leaveLobby(ws, currentLobbyCode, broadcastLobbyList);
                        currentLobbyCode = null;
                        ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                        break;
                    }
                }
            } catch (err) {
                console.error('Action error:', err);
            }
        });

        ws.on('close', () => {
            if (currentLobbyCode && lm.lobbies[currentLobbyCode]) {
                const lobby = lm.lobbies[currentLobbyCode];
                const p = lobby.players.find(pl => pl.id === ws);
                if (p) p.id = null;
                const s = lobby.spectators.find(spec => spec.idSocket === ws);
                if (s) s.idSocket = null;
            }
        });
    });
}

module.exports = { setupWebSocket };

