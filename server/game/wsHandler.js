// server/game/wsHandler.js - WebSocket Dispatcher & Message Router
const WebSocket = require('ws');
const {
    lobbies,
    getLobbies,
    createLobby,
    joinLobby,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    handleSetReady,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    handlePoolCardSelection,
    checkNextHandReady,
    leaveLobby,
    getPublicLobbiesList,
    syncLifetimeLedgerBalances,
    findOpenSeat
} = require('./lobbyManager');

let botModule;
try {
    botModule = require('./bot');
} catch (e) {
    botModule = {};
}

let dbModule;
try {
    dbModule = require('../db');
} catch (e) {
    dbModule = null;
}

let activeWss = null;

function broadcastLobbyList(wssInstance) {
    const wss = wssInstance || activeWss;
    if (!wss || !wss.clients) return;

    const payload = JSON.stringify({
        type: 'LOBBY_LIST',
        lobbies: getPublicLobbiesList()
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function handleWebSocketMessage(arg1, arg2, arg3) {
    let ws, data, wss;

    // Normalize arguments whether called as (ws, data, wss) or (wss, ws, data)
    if (arg1 && arg1.clients) {
        wss = arg1;
        ws = arg2;
        data = arg3;
    } else {
        ws = arg1;
        data = arg2;
        wss = arg3;
    }

    if (wss && wss.clients) {
        activeWss = wss;
    }

    if (!ws) return;

    // Auto-parse JSON string or Buffer payloads
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
        try {
            data = JSON.parse(data.toString());
        } catch (err) {
            return;
        }
    }

    if (!data || typeof data !== 'object') return;

    switch (data.type) {
        case 'PING': {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'PONG' }));
            }
            break;
        }

        case 'GET_LOBBIES':
        case 'REFRESH_LOBBIES': {
            ws.send(JSON.stringify({
                type: 'LOBBY_LIST',
                lobbies: getPublicLobbiesList()
            }));
            break;
        }

        case 'CREATE_LOBBY': {
            const username = (data.username || 'Player1').trim();
            const lobbyName = (data.lobbyName || `${username}'s Table`).trim();
            const isPrivate = Boolean(data.isPrivate);

            const code = Math.random().toString(36).substring(2, 6).toUpperCase();
            ws.currentLobbyCode = code;
            ws.currentUsername = username;

            const lobby = createLobby(code, lobbyName, username, isPrivate);
            joinLobby(ws, code, username);

            ws.send(JSON.stringify({
                type: 'LOBBY_CREATED',
                code,
                lobby: getSanitizedLobby(lobby, ws)
            }));

            broadcastLobbyUpdate(code);
            broadcastLobbyList(wss);
            break;
        }

        case 'JOIN_LOBBY': {
            const code = (data.code || '').trim().toUpperCase();
            const username = (data.username || 'Player1').trim();

            const lobby = lobbies[code];
            if (!lobby) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Table does not exist.' }));
                return;
            }

            ws.currentLobbyCode = code;
            ws.currentUsername = username;

            const existingPlayer = lobby.players.find(p => p.username.toLowerCase() === username.toLowerCase());
            if (existingPlayer) {
                existingPlayer.id = ws;
                existingPlayer.disconnectedAt = null;

                ws.send(JSON.stringify({
                    type: 'LOBBY_JOINED',
                    code,
                    isSpectator: false,
                    lobby: getSanitizedLobby(lobby, ws)
                }));
                broadcastLobbyUpdate(code);
                return;
            }

            const existingSpectator = lobby.spectators.find(s => s.username.toLowerCase() === username.toLowerCase());
            if (existingSpectator) {
                existingSpectator.idSocket = ws;

                ws.send(JSON.stringify({
                    type: 'LOBBY_JOINED',
                    code,
                    isSpectator: true,
                    lobby: getSanitizedLobby(lobby, ws)
                }));
                broadcastLobbyUpdate(code);
                return;
            }

            const result = joinLobby(ws, code, username);
            if (!result.success) {
                ws.send(JSON.stringify({ type: 'ERROR', message: result.message }));
                return;
            }

            ws.send(JSON.stringify({
                type: 'LOBBY_JOINED',
                code,
                isSpectator: result.isSpectator,
                lobby: getSanitizedLobby(lobby, ws)
            }));

            broadcastLobbyUpdate(code);
            broadcastLobbyList(wss);
            break;
        }

        case 'SET_READY': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            handleSetReady(lobbies[code], ws.currentUsername || data.username, data.ready);
            break;
        }

        case 'CHOOSE_POOL_CARD': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const cardIdx = data.cardIndex !== undefined ? data.cardIndex : (data.index !== undefined ? data.index : data.slotIndex);
            if (typeof cardIdx === 'number') {
                handlePoolCardSelection(lobbies[code], ws.currentUsername || data.username, cardIdx);
            }
            break;
        }

        case 'DRAW_DECK':
        case 'DRAW_DISCARD': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            handleTurnAction(lobbies[code], ws, data.type);
            break;
        }

        case 'DISCARD_CARD': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const cIdx = data.cardIndex !== undefined ? data.cardIndex : data.index;
            if (typeof cIdx === 'number') {
                handleDiscardAction(lobbies[code], ws, cIdx);
            }
            break;
        }

        case 'KNOCK': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            handleKnock(lobbies[code], ws);
            break;
        }

        case 'NEXT_HAND_READY':
        case 'NEXT_HAND': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const lobby = lobbies[code];
            const player = lobby.players.find(p => p.username.toLowerCase() === (ws.currentUsername || data.username || '').toLowerCase());
            if (player) {
                player.nextHandReady = true;
                broadcastLobbyUpdate(code);
                checkNextHandReady(lobby);
            }
            break;
        }

        case 'SIT_DOWN': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const lobby = lobbies[code];
            if (lobby.gameState !== 'lobby' || lobby.players.length >= 6) return;

            const specIdx = lobby.spectators.findIndex(s => s.username.toLowerCase() === (ws.currentUsername || '').toLowerCase());
            if (specIdx !== -1) {
                lobby.spectators.splice(specIdx, 1);
                joinLobby(ws, code, ws.currentUsername);
                broadcastLobbyUpdate(code);
                broadcastLobbyList(wss);
            }
            break;
        }

        case 'STAND_UP': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const lobby = lobbies[code];
            if (lobby.gameState !== 'lobby') return;

            const pIdx = lobby.players.findIndex(p => p.username.toLowerCase() === (ws.currentUsername || '').toLowerCase());
            if (pIdx !== -1) {
                lobby.players.splice(pIdx, 1);
                lobby.spectators.push({ idSocket: ws, username: ws.currentUsername, inVC: false, isMuted: true });
                broadcastLobbyUpdate(code);
                broadcastLobbyList(wss);
            }
            break;
        }

        case 'ADD_BOT': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const lobby = lobbies[code];
            if (typeof botModule.addBotToLobby === 'function') {
                botModule.addBotToLobby(lobby);
            } else if (lobby.players.length < 6) {
                const botNum = lobby.players.filter(p => p.isBot).length + 1;
                const seat = findOpenSeat ? findOpenSeat(lobby) : lobby.players.length;
                lobby.players.push({
                    id: `bot_${Date.now()}_${Math.random()}`,
                    username: `Bot ${botNum}`,
                    lives: lobby.defaultLives || 2,
                    wager: 5,
                    cards: [],
                    ready: true,
                    seat,
                    eliminated: false,
                    isBot: true,
                    inVC: false,
                    isMuted: true,
                    nextHandReady: true,
                    peekRequests: {},
                    peekAllowed: {},
                    disconnectedAt: null
                });
            }
            broadcastLobbyUpdate(code);
            broadcastLobbyList(wss);
            break;
        }

        case 'REMOVE_BOT': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const lobby = lobbies[code];
            if (typeof botModule.removeBotFromLobby === 'function') {
                botModule.removeBotFromLobby(lobby);
            } else {
                const bIdx = lobby.players.map(p => p.isBot).lastIndexOf(true);
                if (bIdx !== -1) lobby.players.splice(bIdx, 1);
            }
            broadcastLobbyUpdate(code);
            broadcastLobbyList(wss);
            break;
        }

        case 'LEAVE_LOBBY': {
            const code = ws.currentLobbyCode || data.code;
            if (code && lobbies[code]) {
                leaveLobby(ws, code, () => broadcastLobbyList(wss));
                ws.currentLobbyCode = null;
                ws.currentUsername = null;
                ws.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
            }
            break;
        }

        case 'CHAT_MESSAGE': {
            const code = ws.currentLobbyCode || data.code;
            if (!code || !lobbies[code]) return;
            const lobby = lobbies[code];
            const text = (data.message || data.text || '').trim();
            if (!text) return;

            if (!lobby.chatHistory) lobby.chatHistory = [];
            lobby.chatHistory.push({
                username: ws.currentUsername || data.username || 'Player',
                message: text,
                timestamp: Date.now()
            });
            if (lobby.chatHistory.length > 50) lobby.chatHistory.shift();

            broadcastLobbyUpdate(code);
            break;
        }

        case 'GET_LIFETIME_LEDGER': {
            const uid = (ws.user && !ws.user.isGuest && (ws.user.id || ws.user.userId)) ||
                        (ws.currentUsername && dbModule?.findUserByUsername?.(ws.currentUsername)?.id);

            if (uid && dbModule && typeof dbModule.getLifetimeBalances === 'function') {
                const balances = dbModule.getLifetimeBalances(uid);
                ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
            }
            break;
        }

        default:
            break;
    }
}

function handleWebSocketClose(ws) {
    const code = ws.currentLobbyCode;
    if (!code || !lobbies[code]) return;
    const lobby = lobbies[code];

    const player = lobby.players.find(p => p.id === ws);
    if (player) {
        player.id = null;
        player.disconnectedAt = Date.now();
        broadcastLobbyUpdate(code);
    }

    const spectator = lobby.spectators.find(s => s.idSocket === ws);
    if (spectator) {
        spectator.idSocket = null;
    }
}

function initWebSocketHandler(wss) {
    activeWss = wss;
    wss.on('connection', (ws) => {
        ws.on('message', (msg) => handleWebSocketMessage(ws, msg, wss));
        ws.on('close', () => handleWebSocketClose(ws));
    });
}

// Master dispatcher supporting both direct functional import and destructuring
function wsHandlerDispatcher(arg1, arg2, arg3) {
    if (arg1 && arg1.clients && (!arg2 || typeof arg2 !== 'object')) {
        return initWebSocketHandler(arg1);
    }
    return handleWebSocketMessage(arg1, arg2, arg3);
}

wsHandlerDispatcher.handleWebSocketMessage = handleWebSocketMessage;
wsHandlerDispatcher.handleWebSocketClose = handleWebSocketClose;
wsHandlerDispatcher.initWebSocketHandler = initWebSocketHandler;
wsHandlerDispatcher.broadcastLobbyList = broadcastLobbyList;

module.exports = wsHandlerDispatcher;
module.exports.handleWebSocketMessage = handleWebSocketMessage;
module.exports.handleWebSocketClose = handleWebSocketClose;
module.exports.initWebSocketHandler = initWebSocketHandler;
