// server/game/wsHandler.js - Master WebSocket Router & Action Dispatcher
const WebSocket = require('ws');
const lobbyManager = require('./lobbyManager');

function generateLobbyCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function setupWebSocket(wss, broadcastLobbyList) {
    wss.on('connection', (ws) => {
        let currentLobbyCode = null;

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (!data || typeof data !== 'object') return;

                // 1. Query Public Lobbies
                if (data.type === 'REFRESH_LOBBIES' || data.type === 'GET_LOBBIES') {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'LOBBY_LIST',
                            lobbies: lobbyManager.getPublicLobbiesList()
                        }));
                    }
                    return;
                }

                // 2. Create Lobby (Duplicate Name Guard)
                if (data.type === 'CREATE_LOBBY') {
                    const username = (data.username || 'Player1').trim();
                    const lobbyName = (data.lobbyName || `${username}'s Table`).trim();

                    if (typeof lobbyManager.isLobbyNameTaken === 'function' && lobbyManager.isLobbyNameTaken(lobbyName)) {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'ERROR',
                                message: `A table named "${lobbyName}" already exists. Please choose a different name.`
                            }));
                        }
                        return;
                    }

                    const code = generateLobbyCode();
                    const lobbies = lobbyManager.getLobbies();

                    lobbies[code] = {
                        code,
                        name: lobbyName,
                        host: username,
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
                            username,
                            lives: 2,
                            wager: 5,
                            ready: false,
                            cards: [],
                            seat: 0,
                            eliminated: false,
                            isBot: false,
                            disconnected: false,
                            inVC: false,
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
                        fedCardReminders: {},
                        fedCardsHistory: {},
                        lastDiscardPickup: null,
                        lastDiscardDonor: null
                    };

                    currentLobbyCode = code;
                    lobbyManager.touchLobbyActivity(lobbies[code], broadcastLobbyList);

                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'LOBBY_CREATED',
                            code,
                            lobby: lobbyManager.getSanitizedLobby(lobbies[code], ws)
                        }));
                    }

                    broadcastLobbyList();
                    return;
                }

                // 3. Join Lobby (with Reconnection Re-attach)
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

                    const username = (data.username || 'Player').trim();

                    // Check if player is already seated (reconnecting from background/sleep)
                    const existingPlayer = lobby.players.find(
                        p => p.username.toLowerCase() === username.toLowerCase()
                    );

                    if (existingPlayer) {
                        existingPlayer.id = ws;
                        existingPlayer.disconnected = false;
                        // Avoid duplicates in spectators list
                        lobby.spectators = lobby.spectators.filter(
                            s => s.username.toLowerCase() !== username.toLowerCase()
                        );
                    } else if (lobby.players.length < 6 && lobby.gameState === 'lobby') {
                        lobby.players.push({
                            id: ws,
                            username,
                            lives: lobby.defaultLives || 2,
                            wager: 5,
                            ready: false,
                            cards: [],
                            seat: lobbyManager.findOpenSeat(lobby),
                            eliminated: false,
                            isBot: false,
                            disconnected: false,
                            inVC: false,
                            isMuted: true,
                            nextHandReady: false,
                            peekAllowed: {},
                            peekRequests: {}
                        });
                    } else {
                        lobby.spectators.push({ idSocket: ws, username, inVC: false, isMuted: true });
                    }

                    currentLobbyCode = code;
                    lobbyManager.touchLobbyActivity(lobby, broadcastLobbyList);

                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'LOBBY_JOINED',
                            code,
                            lobby: lobbyManager.getSanitizedLobby(lobby, ws)
                        }));
                    }

                    lobbyManager.broadcastLobbyUpdate(code);
                    broadcastLobbyList();
                    return;
                }

                // 4. In-Game & Table Directives
                if (currentLobbyCode) {
                    const lobbies = lobbyManager.getLobbies();
                    const lobby = lobbies[currentLobbyCode];
                    if (!lobby) return;

                    lobbyManager.touchLobbyActivity(lobby, broadcastLobbyList);
                    const player = lobby.players.find(p => p.id === ws);
                    const activeUsername = player ? player.username : null;

                    // Ready Up
                    if (data.type === 'SET_READY' && player) {
                        player.ready = !!data.ready;
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);

                        const activeParts = lobbyManager.getActiveParticipants(lobby);
                        if (activeParts.length >= 2 && activeParts.every(p => p.ready)) {
                            lobbyManager.startDealerDrawPhase(lobby);
                        }
                    }

                    // Card Turn Actions
                    else if (data.type === 'DRAW_DECK' || data.type === 'DRAW_DISCARD') {
                        lobbyManager.handleTurnAction(lobby, ws, data.type);
                    } else if (data.type === 'DISCARD_CARD') {
                        const idx = data.index !== undefined ? data.index : data.cardIndex;
                        lobbyManager.handleDiscardAction(lobby, ws, idx);
                    } else if (data.type === 'KNOCK') {
                        lobbyManager.handleKnock(lobby, ws);
                    } else if (data.type === 'CHOOSE_POOL_CARD' && player) {
                        lobbyManager.handlePoolCardSelection(lobby, player.username, data.cardIndex);
                    }

                    // Next Hand
                    else if (data.type === 'NEXT_HAND_READY' || data.type === 'NEXT_HAND') {
                        if (player) {
                            player.nextHandReady = true;
                            lobbyManager.checkNextHandReady(lobby);
                            lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }

                    // Table Seating Controls
                    else if (data.type === 'STAND_UP' && player && lobby.gameState === 'lobby') {
                        lobby.players = lobby.players.filter(p => p.id !== ws);
                        lobby.spectators.push({ idSocket: ws, username: player.username, inVC: player.inVC, isMuted: player.isMuted });
                        lobby.players.forEach((p, idx) => { p.seat = idx; });
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    } else if (data.type === 'SIT_DOWN' && lobby.gameState === 'lobby' && lobby.players.length < 6) {
                        const specIdx = lobby.spectators.findIndex(s => s.idSocket === ws);
                        if (specIdx !== -1) {
                            const spec = lobby.spectators[specIdx];
                            lobby.spectators.splice(specIdx, 1);
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
                        }
                    }

                    // Settings & Wagers
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

                    // Bot Controls
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
                    } else if (data.type === 'REMOVE_BOT' && lobby.gameState === 'lobby') {
                        const botIdx = lobby.players.map(p => p.isBot).lastIndexOf(true);
                        if (botIdx !== -1) {
                            lobby.players.splice(botIdx, 1);
                            lobby.players.forEach((p, idx) => { p.seat = idx; });
                            lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }

                    // Side Bet Proposals & Directives
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
                    }

                    // Peeking Hand Controls
                    else if (data.type === 'REQUEST_PEEK' && activeUsername) {
                        const targetP = lobby.players.find(p => p.username === data.targetUsername);
                        if (targetP) {
                            targetP.peekRequests = targetP.peekRequests || {};
                            targetP.peekRequests[activeUsername] = true;
                            lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                        }
                    } else if (data.type === 'RESPOND_PEEK' && player) {
                        player.peekRequests = player.peekRequests || {};
                        delete player.peekRequests[data.spectatorUsername];
                        if (data.allow) {
                            player.peekAllowed = player.peekAllowed || {};
                            player.peekAllowed[data.spectatorUsername] = true;
                        }
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    } else if (data.type === 'STOP_PEEK' && activeUsername) {
                        lobby.players.forEach(p => {
                            if (p.peekAllowed) delete p.peekAllowed[activeUsername];
                        });
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    } else if (data.type === 'KICK_PEEKER' && player) {
                        if (player.peekAllowed) delete player.peekAllowed[data.spectatorUsername];
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }

                    // End Game Proposal
                    else if (data.type === 'END_GAME_PROPOSAL') {
                        lobbyManager.resetLobbyToReadyRoom(lobby, 'Game ended by mutual proposal.', broadcastLobbyList);
                    }

                    // Chat
                    else if (data.type === 'CHAT_MESSAGE') {
                        const sender = activeUsername || (lobby.spectators.find(s => s.idSocket === ws)?.username) || 'Player';
                        lobby.chatHistory = lobby.chatHistory || [];
                        lobby.chatHistory.push({ user: sender, text: (data.message || '').trim() });
                        if (lobby.chatHistory.length > 50) lobby.chatHistory.shift();
                        lobbyManager.broadcastLobbyUpdate(currentLobbyCode);
                    }

                    // Intentional Exit
                    else if (data.type === 'LEAVE_LOBBY') {
                        lobbyManager.leaveLobby(ws, currentLobbyCode, broadcastLobbyList);
                        currentLobbyCode = null;
                    }
                }
            } catch (err) {
                console.error('[WS] Router exception:', err);
            }
        });

        // Graceful disconnect on network drop, app backgrounding, or screen sleep
        ws.on('close', () => {
            if (currentLobbyCode) {
                lobbyManager.handleDisconnect(ws, currentLobbyCode, broadcastLobbyList);
            }
        });
    });
}

module.exports = { setupWebSocket };
