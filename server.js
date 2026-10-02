const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const lobbies = {};

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            let points = 10;
            let drawVal = parseInt(v) || (v === 'A' ? 14 : (v === 'K' ? 13 : (v === 'Q' ? 12 : 11)));
            if (v === 'A') points = 11;
            else if (['J', 'Q', 'K'].includes(v)) points = 10;
            else points = parseInt(v);
            deck.push({ suit: s, val: v, points: points, drawVal: drawVal });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

wss.on('connection', (ws) => {
    let currentLobbyCode = null;
    let currentUsername = null;

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        try {
            switch (data.type) {
                case 'CREATE_LOBBY':
                    currentUsername = (data.username || 'Player').trim();
                    for (let existingCode in lobbies) {
                        let l = lobbies[existingCode];
                        if (l.host.trim().toLowerCase() === currentUsername.toLowerCase() && l.gameState === 'lobby') {
                            currentLobbyCode = existingCode;
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(l, ws) }));
                            return;
                        }
                    }

                    currentLobbyCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                    lobbies[currentLobbyCode] = {
                        code: currentLobbyCode,
                        name: data.lobbyName || `${currentUsername}'s Lobby`,
                        host: currentUsername,
                        isPrivate: !!data.isPrivate,
                        players: [{ id: ws, username: currentUsername, lives: 2, wager: 5, cards: [], ready: false, seat: 0, nextHandReady: false, eliminated: false, inVC: false, isMuted: false, peekRequests: {}, peekAllowed: {} }],
                        bots: [],
                        spectators: [],
                        deck: [],
                        discardPile: [],
                        gameState: 'lobby',
                        drawPool: [],
                        drawResults: {},
                        tiedParticipantsList: [],
                        phaseMessage: null,
                        initialDealCard: null,
                        lastDiscardPickup: null,
                        turnIndex: 0,
                        dealerIndex: 0,
                        sideBetLedger: {},
                        mainGameLedger: {},
                        pendingBets: [],
                        activeBets: [],
                        globalProposals: [],
                        knockedBy: null,
                        finalTurnsRemaining: 0,
                        turnsTakenThisRound: 0,
                        nextHandTimer: null,
                        lastDiscarder: null,
                        fedCardsTracker: {},
                        endGameVotes: {}
                    };
                    ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobbies[currentLobbyCode], ws) }));
                    broadcastLobbyList();
                    break;

                case 'JOIN_LOBBY':
                    let code = (data.code || '').toUpperCase();
                    if (lobbies[code]) {
                        currentLobbyCode = code;
                        currentUsername = (data.username || 'Player').trim();
                        let lobby = lobbies[code];
                        
                        let existingPlayer = lobby.players.find(p => p.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        if (existingPlayer) {
                            existingPlayer.id = ws;
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        let existingSpec = lobby.spectators.find(s => s.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        if (existingSpec) {
                            existingSpec.idSocket = ws;
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                            return;
                        }

                        let totalOccupants = lobby.players.length + lobby.bots.length;
                        if (totalOccupants < 6 && lobby.gameState === 'lobby') {
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({ id: ws, username: currentUsername, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], ready: false, seat: availableSeat, nextHandReady: false, eliminated: false, inVC: false, isMuted: false, peekRequests: {}, peekAllowed: {} });
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                        } else {
                            lobby.spectators.push({ username: currentUsername, idSocket: ws, inVC: false, isMuted: false });
                            ws.send(JSON.stringify({ type: 'LOBBY_JOINED', lobby: getSanitizedLobby(lobby, ws) }));
                            broadcastLobbyUpdate(code);
                            broadcastLobbyList();
                        }
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
                    }
                    break;

                case 'STAND_UP':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let playerIdx = lobby.players.findIndex(p => p.id === ws);
                        if (playerIdx !== -1) {
                            let leavingPlayer = lobby.players.splice(playerIdx, 1)[0];
                            lobby.spectators.push({
                                username: leavingPlayer.username,
                                idSocket: ws,
                                inVC: leavingPlayer.inVC,
                                isMuted: leavingPlayer.isMuted
                            });
                            lobby.phaseMessage = `🪑 ${leavingPlayer.username} stood up and moved to spectator mode.`;
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;

                case 'SIT_DOWN':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let specIdx = lobby.spectators.findIndex(s => s.idSocket === ws || s.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        let totalOccupants = lobby.players.length + lobby.bots.length;

                        if (specIdx !== -1 && totalOccupants < 6 && lobby.gameState === 'lobby') {
                            let spec = lobby.spectators.splice(specIdx, 1)[0];
                            let availableSeat = findOpenSeat(lobby);
                            lobby.players.push({
                                id: ws,
                                username: spec.username,
                                lives: lobby.players[0]?.lives || 2,
                                wager: 5,
                                cards: [],
                                ready: false,
                                seat: availableSeat,
                                nextHandReady: false,
                                eliminated: false,
                                inVC: spec.inVC,
                                isMuted: spec.isMuted,
                                peekRequests: {},
                                peekAllowed: {}
                            });
                            lobby.phaseMessage = `🪑 ${spec.username} sat down at the table!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;

                case 'REFRESH_LOBBIES':
                    ws.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: getPublicLobbiesList() }));
                    break;

                case 'UPDATE_WAGER':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'lobby') {
                            player.wager = parseInt(data.wager) || 5;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'UPDATE_SETTINGS':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.host.trim().toLowerCase() === currentUsername.toLowerCase() && lobby.gameState === 'lobby') {
                            if (data.lives) {
                                let l = parseInt(data.lives);
                                lobby.players.forEach(p => p.lives = l);
                                lobby.bots.forEach(b => b.lives = l);
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'UPDATE_VC_STATUS':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let p = lobby.players.find(pl => pl.id === ws) || lobby.spectators.find(s => s.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        if (p) {
                            let wasInVC = p.inVC;
                            p.inVC = !!data.inVC;
                            p.isMuted = !!data.isMuted;

                            if (!wasInVC && p.inVC) {
                                let chatPayload = { type: 'CHAT_MESSAGE', username: 'System', message: `🎙️ ${currentUsername} joined the voice chat.` };
                                lobby.players.forEach(pl => { if (pl.id && pl.id.readyState === WebSocket.OPEN) pl.id.send(JSON.stringify(chatPayload)); });
                                lobby.spectators.forEach(s => { if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) s.idSocket.send(JSON.stringify(chatPayload)); });
                            }

                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CLEAR_DEBT':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let targetUser = data.targetUser;
                        let category = data.category; 
                        let targetLedger = category === 'main' ? lobby.mainGameLedger : lobby.sideBetLedger;

                        if (targetLedger && targetLedger[currentUsername]) {
                            targetLedger[currentUsername][targetUser] = 0;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'PROPOSE_ELIMINATION_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let activeParts = getActiveParticipants(lobby);
                        let isSpec = lobby.spectators.some(s => s.username.trim().toLowerCase() === currentUsername.toLowerCase());
                        if (!isSpec && lobby.gameState !== 'lobby' && activeParts.length >= 3) {
                            let target = data.target;
                            let newBet = {
                                id: Math.random().toString(36).substring(2, 8),
                                proposer: currentUsername,
                                target: target,
                                pickUser: target,
                                targetSurvivor: currentUsername,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                type: 'eliminate',
                                delivered: {}
                            };
                            lobby.pendingBets.push(newBet);
                            lobby.phaseMessage = `🤝 First to Lose Bet proposed by ${currentUsername} to ${target}!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'PROPOSE_GLOBAL_SIDE_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let activeParts = getActiveParticipants(lobby);
                        if (lobby.gameState !== 'lobby' && activeParts.length === 2) {
                            let proposalId = Math.random().toString(36).substring(2, 8);
                            lobby.globalProposals.push({
                                id: proposalId,
                                proposer: currentUsername,
                                pickUser: data.pickUser,
                                wagerAmt: parseFloat(data.wagerAmt) || 5,
                                acceptedBy: []
                            });
                            lobby.phaseMessage = `📢 Global Side Bet offered by ${currentUsername}: I like ${data.pickUser} for $${data.wagerAmt}!`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'ACCEPT_GLOBAL_PROPOSAL':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let prop = lobby.globalProposals.find(gp => gp.id === data.proposalId);
                        if (prop && !prop.acceptedBy.includes(currentUsername) && prop.proposer !== currentUsername) {
                            prop.acceptedBy.push(currentUsername);
                            lobby.phaseMessage = `✅ ${currentUsername} accepted global bet from ${prop.proposer} ("You got it!")`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CONFIRM_GLOBAL_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let prop = lobby.globalProposals.find(gp => gp.id === data.proposalId && gp.proposer === currentUsername);
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
                                lobby.phaseMessage = `🤝 Confirmed global side bet between ${prop.proposer} and ${data.acceptedUser}!`;
                            } else {
                                lobby.phaseMessage = `❌ ${prop.proposer} declined global bet acceptance from ${data.acceptedUser}.`;
                            }
                            prop.acceptedBy = prop.acceptedBy.filter(u => u !== data.acceptedUser);
                            if (prop.acceptedBy.length === 0) {
                                lobby.globalProposals = lobby.globalProposals.filter(gp => gp.id !== prop.id);
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'RESPOND_BET':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let betIdx = lobby.pendingBets.findIndex(b => b.id === data.betId);
                        if (betIdx !== -1) {
                            let bet = lobby.pendingBets.splice(betIdx, 1)[0];
                            if (data.accept) {
                                lobby.activeBets.push(bet);
                                lobby.phaseMessage = `✅ ${currentUsername} accepted the bet from ${bet.proposer}!`;
                            } else {
                                lobby.phaseMessage = `❌ ${currentUsername} declined the bet from ${bet.proposer}.`;
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'ADD_BOT':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.players.length + lobby.bots.length < 6 && lobby.gameState === 'lobby') {
                            let botName = 'Bot_' + Math.floor(Math.random() * 900 + 100);
                            lobby.bots.push({ username: botName, lives: lobby.players[0]?.lives || 2, wager: 5, cards: [], seat: findOpenSeat(lobby), ready: true, nextHandReady: true, eliminated: false });
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;

                case 'REMOVE_BOT':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.bots.length > 0 && lobby.gameState === 'lobby') {
                            lobby.bots.pop();
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        }
                    }
                    break;

                case 'SET_READY':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'lobby' && !player.eliminated) {
                            player.ready = data.ready;

                            let activeParticipants = getActiveParticipants(lobby);
                            let allReady = activeParticipants.every(p => p.ready || lobby.bots.some(b => b.username === p.username));
                            
                            if (allReady && activeParticipants.length >= 2) {
                                startDealerDrawPhase(lobby);
                            } else {
                                broadcastLobbyUpdate(currentLobbyCode);
                            }
                        }
                    }
                    break;

                case 'NEXT_HAND':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && lobby.gameState === 'roundOver' && !player.eliminated) {
                            player.nextHandReady = true;
                            broadcastLobbyUpdate(currentLobbyCode);
                            checkNextHandReady(lobby);
                        }
                    }
                    break;

                case 'END_GAME_PROPOSAL':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (!lobby.endGameVotes) lobby.endGameVotes = {};
                        lobby.endGameVotes[currentUsername] = true;
                        lobby.bots.forEach(b => { lobby.endGameVotes[b.username] = true; });
                        
                        let activeParts = getActiveParticipants(lobby);
                        let allVotedYes = activeParts.every(p => lobby.endGameVotes[p.username]);
                        
                        if (allVotedYes) {
                            lobby.phaseMessage = "⚠️ Unanimous vote! Game ended, returning to lobby ready-up.";
                            lobby.gameState = 'lobby';
                            lobby.endGameVotes = {};
                            lobby.activeBets = [];
                            lobby.pendingBets = [];
                            lobby.globalProposals = [];
                            
                            lobby.players.forEach(p => {
                                p.lives = 2;
                                p.eliminated = false;
                                p.cards = [];
                                p.ready = false;
                                p.nextHandReady = false;
                                p.peekRequests = {};
                                p.peekAllowed = {};
                            });
                            lobby.bots.forEach(b => {
                                b.lives = 2;
                                b.eliminated = false;
                                b.cards = [];
                                b.ready = true;
                                b.nextHandReady = true;
                            });
                            lobby.spectators = [];
                            broadcastLobbyUpdate(currentLobbyCode);
                            broadcastLobbyList();
                        } else {
                            lobby.phaseMessage = `⚠️ ${currentUsername} voted to end the game (${Object.keys(lobby.endGameVotes).length}/${activeParts.length} votes)`;
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'REQUEST_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let requesterName = currentUsername;
                        let rawTarget = (data.targetUsername || '').trim().toLowerCase();

                        let targetPlayer = lobby.players.find(p => p.username.trim().toLowerCase() === rawTarget);
                        if (targetPlayer && targetPlayer.id && targetPlayer.id.readyState === WebSocket.OPEN) {
                            if (!targetPlayer.peekRequests) targetPlayer.peekRequests = {};
                            targetPlayer.peekRequests[requesterName] = true;
                            console.log(`[Peek Request Success] Spectator '${requesterName}' requested to peek at player '${targetPlayer.username}'`);
                            broadcastLobbyUpdate(currentLobbyCode);
                        } else {
                            console.log(`[Peek Request Failed] Target player '${data.targetUsername}' not found or inactive.`);
                        }
                    }
                    break;

                case 'RESPOND_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player) {
                            if (player.peekRequests) {
                                Object.keys(player.peekRequests).forEach(k => {
                                    if (k.trim().toLowerCase() === (data.spectatorUsername || '').trim().toLowerCase()) {
                                        delete player.peekRequests[k];
                                    }
                                });
                            }
                            if (data.allow) {
                                if (!player.peekAllowed) player.peekAllowed = {};
                                player.peekAllowed[data.spectatorUsername] = true;
                                console.log(`[Peek Allowed] Player '${player.username}' granted peek permission to '${data.spectatorUsername}'.`);
                            } else {
                                console.log(`[Peek Denied] Player '${player.username}' denied peek permission to '${data.spectatorUsername}'.`);
                            }
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'STOP_PEEK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let targetPlayer = lobby.players.find(p => p.username.trim().toLowerCase() === (data.targetUsername || '').trim().toLowerCase());
                        if (targetPlayer && targetPlayer.peekAllowed) {
                            Object.keys(targetPlayer.peekAllowed).forEach(k => {
                                if (k.trim().toLowerCase() === currentUsername.trim().toLowerCase()) {
                                    delete targetPlayer.peekAllowed[k];
                                }
                            });
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'KICK_PEEKER':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let player = lobby.players.find(p => p.id === ws);
                        if (player && player.peekAllowed) {
                            Object.keys(player.peekAllowed).forEach(k => {
                                if (k.trim().toLowerCase() === (data.spectatorUsername || '').trim().toLowerCase()) {
                                    delete player.peekAllowed[k];
                                }
                            });
                            broadcastLobbyUpdate(currentLobbyCode);
                        }
                    }
                    break;

                case 'CHOOSE_POOL_CARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
                            let activeSender = lobby.players.find(p => p.id === ws);
                            let verifiedUsername = activeSender ? activeSender.username : currentUsername;
                            handlePoolCardSelection(lobby, verifiedUsername, data.cardIndex);
                        }
                    }
                    break;

                case 'CHAT_MESSAGE':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let chatPayload = { type: 'CHAT_MESSAGE', username: currentUsername, message: data.message };
                        lobby.players.forEach(p => { if (p.id && p.id.readyState === WebSocket.OPEN) p.id.send(JSON.stringify(chatPayload)); });
                        lobby.spectators.forEach(s => { if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) s.idSocket.send(JSON.stringify(chatPayload)); });
                    }
                    break;

                case 'WEBRTC_SIGNAL':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        let lobby = lobbies[currentLobbyCode];
                        let targetUser = data.target;
                        let allRecipients = [...lobby.players, ...lobby.spectators.map(s => ({ username: s.username, id: s.idSocket }))];
                        let targetRec = allRecipients.find(r => r.username === targetUser);
                        if (targetRec && targetRec.id && targetRec.id.readyState === WebSocket.OPEN) {
                            targetRec.id.send(JSON.stringify({
                                type: 'WEBRTC_SIGNAL',
                                sender: currentUsername,
                                signal: data.signal
                            }));
                        }
                    }
                    break;

                case 'DRAW_DECK':
                case 'DRAW_DISCARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        handleTurnAction(lobbies[currentLobbyCode], ws, data.type);
                    }
                    break;

                case 'DISCARD_CARD':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        handleDiscardAction(lobbies[currentLobbyCode], ws, data.cardIndex);
                    }
                    break;

                case 'KNOCK':
                    if (currentLobbyCode && lobbies[currentLobbyCode]) {
                        handleKnock(lobbies[currentLobbyCode], ws);
                    }
                    break;

                case 'LEAVE_LOBBY':
                    leaveLobby(ws, currentLobbyCode);
                    currentLobbyCode = null;
                    ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
                    break;
            }
        } catch (err) {
            console.error('Error handling message:', err);
        }
    });

    ws.on('close', () => {});
});

function getActiveParticipants(lobby) {
    let all = [...lobby.players, ...lobby.bots];
    return all.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    let occupied = lobby.players.map(p => p.seat).concat(lobby.bots.map(b => b.seat));
    for (let i = 0; i < 6; i++) { if (!occupied.includes(i)) return i; }
    return 0;
}

function leaveLobby(ws, code) {
    if (!lobbies[code]) return;
    let lobby = lobbies[code];
    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);
    if (lobby.players.length === 0 && lobby.bots.length === 0) {
        if (lobby.nextHandTimer) clearTimeout(lobby.nextHandTimer);
        delete lobbies[code];
    } else {
        broadcastLobbyUpdate(code);
    }
    broadcastLobbyList();
}

function getPublicLobbiesList() {
    return Object.values(lobbies)
        .filter(l => !l.isPrivate)
        .map(l => ({
            code: l.code,
            name: l.name,
            host: l.host,
            count: l.players.length + l.bots.length,
            state: l.gameState
        }));
}

function broadcastLobbyList() {
    let publicLobbies = getPublicLobbiesList();
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: publicLobbies }));
        }
    });
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    
    lobby.players.forEach(p => {
        if (p.id && p.id.readyState === WebSocket.OPEN) {
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, p.id) }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket && s.idSocket.readyState === WebSocket.OPEN) {
            s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: getSanitizedLobby(lobby, s.idSocket) }));
        }
    });

    if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
        checkAndRunBotTurn(lobby);
    }
}

function getSanitizedLobby(lobby, wsId) {
    let activeParts = getActiveParticipants(lobby);
    let allParticipants = [...lobby.players, ...lobby.bots];
    let currentTurnUser = allParticipants[lobby.turnIndex] ? allParticipants[lobby.turnIndex].username : '';
    let isRoundOver = lobby.gameState === 'roundOver';
    let canKnock = lobby.turnsTakenThisRound >= activeParts.length;
    let potTotal = allParticipants.reduce((sum, p) => sum + (p.wager || 5), 0);
    let sidePotTotal = (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0);

    let requestingPlayer = lobby.players.find(p => p.id === wsId);
    let requestingSpectator = lobby.spectators.find(s => s.idSocket === wsId);
    let myUsername = requestingPlayer ? requestingPlayer.username : (requestingSpectator ? requestingSpectator.username : null);

    let sortedParticipants = [...allParticipants];
    if (myUsername) {
        let myIdx = sortedParticipants.findIndex(p => p.username === myUsername);
        if (myIdx !== -1) {
            sortedParticipants = sortedParticipants.slice(myIdx).concat(sortedParticipants.slice(0, myIdx));
        }
    }
    sortedParticipants.forEach((p, idx) => { p.seat = idx; });

    let myUnrespondedBets = (lobby.pendingBets || []).filter(b => b.target === myUsername && !b.delivered[myUsername]);
    if (myUnrespondedBets.length > 0) {
        myUnrespondedBets.forEach(b => { b.delivered[myUsername] = true; });
    }

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        deckCount: lobby.deck.length,
        turnIndex: lobby.turnIndex,
        currentTurnUser: currentTurnUser,
        phaseMessage: lobby.phaseMessage,
        canKnock: canKnock,
        potTotal: potTotal,
        sidePotTotal: sidePotTotal,
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        pendingBetsForMe: myUnrespondedBets,
        globalProposals: lobby.globalProposals || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: activeParts.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: lobby.drawPool.map((c, idx) => ({ index: idx, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults,
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        players: lobby.players.map(p => {
            let canSeeCards = isRoundOver || p.username === myUsername;
            
            let specAllowed = false;
            if (requestingSpectator) {
                specAllowed = p.peekAllowed && Object.keys(p.peekAllowed).some(k => k.trim().toLowerCase() === requestingSpectator.username.trim().toLowerCase());
            } else if (requestingPlayer) {
                specAllowed = p.username === myUsername || (p.peekAllowed && Object.keys(p.peekAllowed).some(k => k.trim().toLowerCase() === requestingPlayer.username.trim().toLowerCase()));
            }

            let incomingPeekMap = {};
            if (wsId === p.id && p.peekRequests) {
                incomingPeekMap = p.peekRequests;
            }

            let allowedPeekMap = p.peekAllowed || {};

            let sortedRef = sortedParticipants.find(sp => sp.username === p.username);
            return {
                username: p.username,
                lives: p.lives,
                wager: p.wager || 5,
                cardCount: p.cards.length,
                ready: p.ready,
                seat: sortedRef ? sortedRef.seat : p.seat,
                nextHandReady: p.nextHandReady,
                eliminated: p.eliminated,
                inVC: !!p.inVC,
                isMuted: !!p.isMuted,
                peekIncoming: incomingPeekMap,
                peekAllowed: allowedPeekMap,
                cards: (canSeeCards || specAllowed) ? p.cards : []
            };
        }),
        bots: lobby.bots.map(b => {
            let sortedRef = sortedParticipants.find(sp => sp.username === b.username);
            return {
                username: b.username,
                lives: b.lives,
                wager: b.wager || 5,
                cardCount: b.cards.length,
                seat: sortedRef ? sortedRef.seat : b.seat,
                ready: true,
                nextHandReady: b.nextHandReady,
                eliminated: b.eliminated,
                inVC: false,
                isMuted: false,
                cards: isRoundOver ? b.cards : []
            };
        }),
        spectators: lobby.spectators.map(s => ({
            username: s.username,
            inVC: !!s.inVC,
            isMuted: !!s.isMuted
        }))
    };
}

function startDealerDrawPhase(lobby) {
    let deck = createDeck();
    lobby.drawPool = deck.map(card => ({ card: card, chosenBy: null }));
    lobby.drawResults = {};
    lobby.tiedParticipantsList = [];
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;
    lobby.lastDiscarder = null;
    lobby.initialDealCard = null;
    lobby.lastDiscardPickup = null;
    lobby.fedCardsTracker = {};
    lobby.firstEliminated = null;

    lobby.players.forEach(p => { 
        if (!p.eliminated) p.nextHandReady = false; 
        p.peekRequests = {};
        p.peekAllowed = {};
    });
    lobby.bots.forEach(b => { if (!b.eliminated) b.nextHandReady = true; });

    autoPickForBots(lobby);
    broadcastLobbyUpdate(lobby.code);
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.gameState === 'tieBreaker') {
        let isTied = lobby.tiedParticipantsList.some(t => t.trim().toLowerCase() === username.trim().toLowerCase());
        if (!isTied) return;
    }

    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        let card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        
        broadcastLobbyUpdate(lobby.code);

        if (lobby.gameState === 'dealerDraw') {
            checkDealerDrawComplete(lobby);
        } else if (lobby.gameState === 'tieBreaker') {
            checkTieBreakerComplete(lobby);
        }
    }
}

function autoPickForBots(lobby) {
    let pickingUsers = lobby.gameState === 'tieBreaker' ? lobby.tiedParticipantsList : getActiveParticipants(lobby).map(p => p.username);
    
    pickingUsers.forEach(uname => {
        let isBot = lobby.bots.some(b => b.username === uname);
        if (isBot && !lobby.drawResults[uname]) {
            let available = lobby.drawPool.map((slot, i) => slot.chosenBy === null ? i : null).filter(i => i !== null);
            if (available.length > 0) {
                let randIdx = available[Math.floor(Math.random() * available.length)];
                lobby.drawPool[randIdx].chosenBy = uname;
                lobby.drawResults[uname] = lobby.drawPool[randIdx].card;
            }
        }
    });
}

function checkDealerDrawComplete(lobby) {
    let activeParts = getActiveParticipants(lobby);
    let allPicked = activeParts.every(p => lobby.drawResults[p.username]);

    if (allPicked) {
        let entries = Object.entries(lobby.drawResults).map(([user, card]) => ({ username: user, card: card }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);
        let dealerWinner = entries[0];
        
        let allParts = [...lobby.players, ...lobby.bots];
        let dealerIndex = allParts.findIndex(p => p.username === dealerWinner.username);
        lobby.dealerIndex = dealerIndex !== -1 ? dealerIndex : 0;
        lobby.phaseMessage = `🎉 ${dealerWinner.username} drew the lowest card and is the Dealer!`;

        broadcastLobbyUpdate(lobby.code);

        setTimeout(() => {
            if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'dealerDraw') {
                startRound(lobbies[lobby.code]);
            }
        }, 5000);
    }
}

function startRound(lobby) {
    if (lobby.nextHandTimer) {
        clearTimeout(lobby.nextHandTimer);
        lobby.nextHandTimer = null;
    }
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.lastDiscarder = null;
    lobby.lastDiscardPickup = null;
    lobby.fedCardsTracker = {};
    lobby.tiedParticipantsList = [];
    
    lobby.players.forEach(p => {
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    let activeParts = getActiveParticipants(lobby);
    if (activeParts.length === 1) {
        let winner = activeParts[0];
        awardTournamentWinner(lobby, winner);
        return;
    }

    activeParts.forEach(p => { 
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()]; 
        p.nextHandReady = false;
    });
    lobby.bots.forEach(b => { if (!b.eliminated) b.nextHandReady = true; });

    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = firstDiscard;

    lobby.gameState = 'playing';
    lobby.phaseMessage = null;
    lobby.knockedBy = null;
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;
    
    let allParts = [...lobby.players, ...lobby.bots];
    lobby.turnIndex = (lobby.dealerIndex + 1) % allParts.length;
    
    while (allParts[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % allParts.length;
    }

    broadcastLobbyUpdate(lobby.code);
}

function addLedgerDebt(ledgerObj, debtor, creditor, amount) {
    if (!ledgerObj[debtor]) ledgerObj[debtor] = {};
    if (!ledgerObj[creditor]) ledgerObj[creditor] = {};
    ledgerObj[debtor][creditor] = (ledgerObj[debtor][creditor] || 0) + amount;
}

function resolveFirstToLoseBets(lobby, loserName) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};

    let remainingBets = [];
    
    lobby.activeBets.forEach(bet => {
        if (bet.type === 'eliminate') {
            let proposer = bet.proposer;
            let target = bet.target;

            if (bet.pickUser === loserName) {
                addLedgerDebt(lobby.sideBetLedger, target, proposer, bet.wagerAmt);
            } else if (bet.proposer === loserName) {
                addLedgerDebt(lobby.sideBetLedger, proposer, target, bet.wagerAmt);
            } else {
                remainingBets.push(bet);
            }
        } else {
            remainingBets.push(bet);
        }
    });
    
    lobby.activeBets = remainingBets;
}

function resolveWinSideBets(lobby, roundWinnerName) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};

    let remainingBets = [];
    lobby.activeBets.forEach(bet => {
        if (bet.type === 'win') {
            let won = (bet.pickUser === roundWinnerName);
            let debtor = won ? bet.target : bet.proposer;
            let creditor = won ? bet.proposer : bet.target;
            addLedgerDebt(lobby.sideBetLedger, debtor, creditor, bet.wagerAmt);
        } else {
            remainingBets.push(bet);
        }
    });
    lobby.activeBets = remainingBets;
}

function awardTournamentWinner(lobby, winner) {
    let allParts = [...lobby.players, ...lobby.bots];
    
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    allParts.forEach(loser => {
        if (loser.username !== winner.username) {
            let loserWager = loser.wager || 5;
            let winnerWager = winner.wager || 5;
            let paidAmount = Math.min(loserWager, winnerWager);

            addLedgerDebt(lobby.mainGameLedger, loser.username, winner.username, paidAmount);
        }
    });

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} is the last player standing and wins the match!`;
    
    lobby.players.forEach(p => {
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    broadcastLobbyUpdate(lobby.code);

    setTimeout(() => {
        if (lobbies[lobby.code]) {
            let l = lobbies[lobby.code];
            l.gameState = 'lobby';
            l.phaseMessage = null;
            l.firstEliminated = null;
            l.activeBets = [];
            l.pendingBets = [];
            l.globalProposals = [];
            
            l.players.forEach(p => {
                p.lives = 2;
                p.eliminated = false;
                p.cards = [];
                p.ready = false;
                p.nextHandReady = false;
                p.peekRequests = {};
                p.peekAllowed = {};
            });
            l.bots.forEach(b => {
                b.lives = 2;
                b.eliminated = false;
                b.cards = [];
                b.ready = true;
                b.nextHandReady = true;
            });
            l.spectators = [];

            let winnerIdx = allParts.findIndex(p => p.username === winner.username);
            l.dealerIndex = winnerIdx !== -1 ? winnerIdx : 0;

            broadcastLobbyUpdate(l.code);
            broadcastLobbyList();
        }
    }, 5000);
}

function checkNextHandReady(lobby) {
    let activeParts = getActiveParticipants(lobby);
    if (activeParts.length === 1) {
        awardTournamentWinner(lobby, activeParts[0]);
        return;
    }

    let allReady = activeParts.every(p => p.nextHandReady);
    if (allReady) {
        startRound(lobby);
    } else if (!lobby.nextHandTimer) {
        lobby.nextHandTimer = setTimeout(() => {
            if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'roundOver') {
                startRound(lobbies[lobby.code]);
            }
        }, 10000);
    }
}

function checkAndRunBotTurn(lobby) {
    let allParts = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParts[lobby.turnIndex];
    if (currentPlayer && lobby.bots.some(b => b.username === currentPlayer.username) && !currentPlayer.eliminated) {
        setTimeout(() => {
            if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
            let currentTurnCheck = [...lobby.players, ...lobby.bots][lobby.turnIndex];
            if (currentTurnCheck && currentTurnCheck.username === currentPlayer.username) {
                
                let activeParts = getActiveParticipants(lobby);
                let threshold = activeParts.length > 2 ? 21 : 25;
                if (lobby.turnsTakenThisRound >= activeParts.length && calculateScore(currentPlayer.cards) >= threshold && lobby.gameState === 'playing') {
                    executeKnock(lobby, currentPlayer);
                    return;
                }

                let topDiscard = lobby.discardPile[lobby.discardPile.length - 1];
                let shouldTakeDiscard = false;
                if (topDiscard) {
                    let testCards = [...currentPlayer.cards, topDiscard];
                    let bestScoreSoFar = calculateScore(currentPlayer.cards);
                    for (let i = 0; i < testCards.length; i++) {
                        let sub = testCards.filter((_, idx) => idx !== i);
                        if (calculateScore(sub) > bestScoreSoFar) {
                            shouldTakeDiscard = true;
                            break;
                        }
                    }
                }

                if (shouldTakeDiscard && lobby.discardPile.length > 0) {
                    let card = lobby.discardPile.pop();
                    currentPlayer.cards.push(card);
                    if (card && lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
                        lobby.lastDiscardPickup = null;
                        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up initial deal card ${card.val}${card.suit} from the discard pile!`;
                    }
                } else {
                    if (lobby.deck.length === 0) lobby.deck = createDeck();
                    currentPlayer.cards.push(lobby.deck.pop());
                    lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the draw pile.`;
                }

                let worstIndex = 0;
                let lowestVal = 999;
                currentPlayer.cards.forEach((c, idx) => {
                    if (c.points < lowestVal) {
                        lowestVal = c.points;
                        worstIndex = idx;
                    }
                });

                let discarded = currentPlayer.cards.splice(worstIndex, 1)[0];
                lobby.discardPile.push(discarded);
                
                lobby.lastDiscarder = currentPlayer.username;
                if (!lobby.fedCardsTracker[currentPlayer.username]) lobby.fedCardsTracker[currentPlayer.username] = [];
                lobby.fedCardsTracker[currentPlayer.username].push(discarded);

                lobby.turnsTakenThisRound++;

                if (calculateScore(currentPlayer.cards) === 31) {
                    allParts.forEach(p => { 
                        if (p !== currentPlayer && !p.eliminated) {
                            p.lives--;
                            resolveFirstToLoseBets(lobby, p.username);
                            if (p.lives <= 0) {
                                p.eliminated = true;
                                lobby.spectators.push({ idSocket: p.id, username: p.username });
                            }
                        }
                    });

                    triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points! All hands revealed.`);
                    return;
                }

                if (lobby.turnsTakenThisRound >= activeParts.length && calculateScore(currentPlayer.cards) >= threshold && lobby.gameState === 'playing') {
                    executeKnock(lobby, currentPlayer);
                    return;
                }

                advanceTurnOrResolve(lobby);
            }
        }, 1500);
    }
}

function handleTurnAction(lobby, ws, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let allParts = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParts[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated) return;
    if (currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the draw pile.`;
        broadcastLobbyUpdate(lobby.code);
    } else if (actionType === 'DRAW_DISCARD') {
        if (lobby.discardPile.length > 0) {
            let card = lobby.discardPile.pop();
            currentPlayer.cards.push(card);

            let isInitialDeal = lobby.initialDealCard && 
                                card.val === lobby.initialDealCard.val && 
                                card.suit === lobby.initialDealCard.suit;

            if (isInitialDeal) {
                lobby.lastDiscardPickup = { username: currentPlayer.username, card: card };
                lobby.phaseMessage = `📢 ${currentPlayer.username} picked up initial deal card ${card.val}${card.suit} from the discard pile!`;
            } else {
                lobby.phaseMessage = `📢 ${currentPlayer.username} picked up ${card.val}${card.suit} from the discard pile!`;
            }

            if (lobby.lastDiscarder && lobby.lastDiscarder !== currentPlayer.username) {
                let fedCards = lobby.fedCardsTracker[lobby.lastDiscarder] || [];
                fedCards.push(card);
                
                let hasAce = fedCards.some(c => c.val === 'A');
                let hasFaceOr10 = fedCards.some(c => ['10', 'J', 'Q', 'K'].includes(c.val));

                if (hasAce && hasFaceOr10) {
                    let feeder = allParts.find(p => p.username === lobby.lastDiscarder);
                    if (feeder) {
                        let fedPlayerScore = calculateScore(currentPlayer.cards);
                        if (fedPlayerScore === 31 || calculateSuitScore(currentPlayer.cards, card.suit) === 31) {
                            feeder.lives = 0;
                            allParts.forEach(p => {
                                if (p.lives <= 0 && !p.eliminated) {
                                    p.eliminated = true;
                                    resolveFirstToLoseBets(lobby, p.username);
                                    lobby.spectators.push({ idSocket: p.id, username: p.username });
                                }
                            });
                            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and a 10-value card, and ${currentPlayer.username} hit 31! ${feeder.username} loses ALL lives!`;
                        }
                    }
                }
            }

            broadcastLobbyUpdate(lobby.code);
        }
    }
}

function calculateSuitScore(cards, suit) {
    let sum = 0;
    cards.forEach(c => { if (c.suit === suit) sum += c.points; });
    return sum;
}

function handleDiscardAction(lobby, ws, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let allParts = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParts[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated) return;
    if (currentPlayer.cards.length !== 4) return;

    if (currentPlayer.cards[cardIndex]) {
        let discarded = currentPlayer.cards.splice(cardIndex, 1)[0];
        
        if (lobby.lastDiscardPickup && 
            lobby.lastDiscardPickup.username === currentPlayer.username &&
            lobby.lastDiscardPickup.card.val === discarded.val &&
            lobby.lastDiscardPickup.card.suit === discarded.suit) {
            lobby.lastDiscardPickup = null;
        }

        lobby.discardPile.push(discarded);

        lobby.lastDiscarder = currentPlayer.username;
        if (!lobby.fedCardsTracker[currentPlayer.username]) lobby.fedCardsTracker[currentPlayer.username] = [];
        lobby.fedCardsTracker[currentPlayer.username].push(discarded);

        let currentScore = calculateScore(currentPlayer.cards);
        if (currentScore === 31 && lobby.lastDiscarder) {
            for (let feederName in lobby.fedCardsTracker) {
                if (feederName !== currentPlayer.username) {
                    let fedCards = lobby.fedCardsTracker[feederName];
                    let hasAce = fedCards.some(c => c.val === 'A');
                    let hasFaceOr10 = fedCards.some(c => ['10', 'J', 'Q', 'K'].includes(c.val));
                    if (hasAce && hasFaceOr10) {
                        let feeder = allParts.find(p => p.username === feederName);
                        if (feeder) {
                            feeder.lives = 0;
                            allParts.forEach(p => {
                                if (p.lives <= 0 && !p.eliminated) {
                                    p.eliminated = true;
                                    resolveFirstToLoseBets(lobby, p.username);
                                    lobby.spectators.push({ idSocket: p.id, username: p.username });
                                }
                            });
                            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} cards and ${currentPlayer.username} hit 31! ${feeder.username} loses ALL lives!`;
                        }
                    }
                }
            }
        }

        lobby.turnsTakenThisRound++;

        if (currentScore === 31) {
            allParts.forEach(p => { 
                if (p !== currentPlayer && !p.eliminated) {
                    p.lives--;
                    resolveFirstToLoseBets(lobby, p.username);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        lobby.spectators.push({ idSocket: p.id, username: p.username });
                    }
                }
            });
            triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points! All hands revealed.`);
        } else {
            advanceTurnOrResolve(lobby);
        }
    }
}

function advanceTurnOrResolve(lobby) {
    let allParts = [...lobby.players, ...lobby.bots];
    if (lobby.gameState === 'finalTurn') {
        lobby.finalTurnsRemaining--;
        if (lobby.finalTurnsRemaining <= 0) {
            resolveRoundEnd(lobby);
            return;
        }
    }
    
    lobby.turnIndex = (lobby.turnIndex + 1) % allParts.length;
    while (allParts[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % allParts.length;
    }
    broadcastLobbyUpdate(lobby.code);
}

function handleKnock(lobby, ws) {
    if (lobby.gameState !== 'playing') return;
    let allParts = [...lobby.players, ...lobby.bots];
    let currentPlayer = allParts[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== ws || currentPlayer.eliminated) return;

    let activeParts = getActiveParticipants(lobby);
    if (lobby.turnsTakenThisRound < activeParts.length) return;

    let score = calculateScore(currentPlayer.cards);
    let threshold = activeParts.length > 2 ? 21 : 25;
    if (score < threshold) return;

    executeKnock(lobby, currentPlayer);
}

function executeKnock(lobby, player) {
    let activeParts = getActiveParticipants(lobby);
    let allParts = [...lobby.players, ...lobby.bots];
    lobby.gameState = 'finalTurn';
    lobby.knockedBy = player.username;
    lobby.finalTurnsRemaining = activeParts.length - 1;
    lobby.phaseMessage = `🔔 KNOCK! ${player.username} knocked! Every other player gets 1 final turn.`;
    
    lobby.turnIndex = (lobby.turnIndex + 1) % allParts.length;
    while (allParts[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % allParts.length;
    }
    broadcastLobbyUpdate(lobby.code);
}

function resolveRoundEnd(lobby) {
    let activeParts = getActiveParticipants(lobby);
    let scores = activeParts.map(p => ({ player: p, score: calculateScore(p.cards) }));
    scores.sort((a, b) => a.score - b.score);

    let lowestScore = scores[0].score;
    let tiedPlayers = scores.filter(s => s.score === lowestScore);

    if (tiedPlayers.length > 1) {
        if (activeParts.length === 2) {
            triggerRoundOver(lobby, `Round Over! Heads up match tied at ${lowestScore} pts. No one loses a life!`);
        } else {
            lobby.tiedParticipantsList = tiedPlayers.map(t => t.player.username);
            lobby.drawPool = lobby.deck.map(card => ({ card: card, chosenBy: null }));
            lobby.drawResults = {};
            lobby.phaseMessage = `Tie-Breaker Phase`;
            lobby.gameState = 'tieBreaker';

            autoPickForBots(lobby);
            broadcastLobbyUpdate(lobby.code);
        }
    } else {
        let loserPlayer = scores[0].player;
        loserPlayer.lives--;
        let roundLoser = loserPlayer.username;
        let roundWinner = scores[scores.length - 1].player.username;
        
        resolveFirstToLoseBets(lobby, roundLoser);

        if (loserPlayer.lives <= 0 && !loserPlayer.eliminated) {
            loserPlayer.eliminated = true;
            lobby.spectators.push({ idSocket: loserPlayer.id, username: loserPlayer.username });
        }
        
        resolveWinSideBets(lobby, roundWinner);
        
        triggerRoundOver(lobby, `Round Over! ${roundLoser} had the lowest score and lost a life. All hands revealed.`);
    }
}

function checkTieBreakerComplete(lobby) {
    let tiedNames = lobby.tiedParticipantsList;
    let allTiedPicked = tiedNames.every(username => lobby.drawResults[username]);

    if (allTiedPicked) {
        let entries = tiedNames.map(username => ({ username: username, card: lobby.drawResults[username] }));
        entries.sort((a, b) => a.card.drawVal - b.card.drawVal);
        let loserEntry = entries[0];
        
        let activeParts = getActiveParticipants(lobby);
        let targetParticipant = activeParts.find(p => p.username === loserEntry.username);
        if (targetParticipant) {
            targetParticipant.lives--;
            resolveFirstToLoseBets(lobby, targetParticipant.username);

            if (targetParticipant.lives <= 0 && !targetParticipant.eliminated) {
                targetParticipant.eliminated = true;
                lobby.spectators.push({ idSocket: targetParticipant.id, username: targetParticipant.username });
            }

            let activeScores = activeParts.map(p => ({ p: p, s: calculateScore(p.cards) })).sort((a,b) => a.s - b.s);
            let roundWinner = activeScores[activeScores.length - 1].p.username;
            resolveWinSideBets(lobby, roundWinner);
        }

        lobby.phaseMessage = `Tie-breaker results:\n` + entries.map(e => `${e.username}: ${e.card.val}${e.card.suit}`).join('\n') + `\n\n${loserEntry.username} drew the lowest card and lost a life!`;
        broadcastLobbyUpdate(lobby.code);

        setTimeout(() => {
            if (lobbies[lobby.code] && lobbies[lobby.code].gameState === 'tieBreaker') {
                triggerRoundOver(lobbies[lobby.code], lobby.phaseMessage);
            }
        }, 4000);
    }
}

function triggerRoundOver(lobby, msg) {
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    rotateDealer(lobby);
    broadcastLobbyUpdate(lobby.code);
}

function rotateDealer(lobby) {
    let allParts = [...lobby.players, ...lobby.bots];
    lobby.dealerIndex = (lobby.dealerIndex + 1) % allParts.length;
}

function calculateScore(cards) {
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let suitSums = {};
    scoringCards.forEach(c => { suitSums[c.suit] = (suitSums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) return 30.5;
    return Math.max(...Object.values(suitSums), 0);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`31! Game Server running on port ${PORT}`);
});
