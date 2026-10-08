// public/js/network.js - WebSocket Engine, Dispatcher & Game Event Relay

// -------------------------------------------------------------
// 1. STATE & ENVIRONMENT INITIALIZATION
// -------------------------------------------------------------
window.appGlobals = window.appGlobals || {
    ws: null,
    isConnected: false,
    pendingQueue: [],
    currentJoinedCode: null,
    latestLobbySnapshot: null,
    lastKnownKnockedBy: null,
    lastPhaseMessage: '',
    lastGameState: ''
};

window.clientState = window.clientState || {
    username: 'Player1',
    isReady: false,
    playersList: [],
    spectatorsList: [],
    discardTop: null,
    sideBetLedger: {},
    mainGameLedger: {},
    botBetLedger: {},
    lastDiscardPickup: null,
    gameState: 'lobby',
    activeParticipantsCount: 3,
    isSpectator: false,
    tiedParticipantsList: [],
    activeBetsList: [],
    pendingBetsList: []
};

// Input persistence fallback so inputs never throw ReferenceError
window.saveInputs = window.saveInputs || function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u) {
            localStorage.setItem('saved_username', u.value);
            localStorage.setItem('blitz31_username', u.value);
            if (window.clientState) window.clientState.username = u.value.trim() || 'Player1';
        }
        if (l) {
            localStorage.setItem('saved_lobby_name', l.value);
            localStorage.setItem('blitz31_lobby_name', l.value);
        }
    } catch (e) {}
};

window.restoreSavedInputs = window.restoreSavedInputs || function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        const savedU = localStorage.getItem('saved_username') || localStorage.getItem('blitz31_username');
        const savedL = localStorage.getItem('saved_lobby_name') || localStorage.getItem('blitz31_lobby_name');
        if (u && savedU) u.value = savedU;
        if (l && savedL) l.value = savedL;
        if (window.clientState && u) {
            window.clientState.username = u.value.trim() || 'Player1';
        }
    } catch (e) {}
};

// -------------------------------------------------------------
// 2. WEBSOCKET CONNECTION & EVENT ROUTING
// -------------------------------------------------------------
let reconnectTimer = null;

function getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
}

window.connectSocket = function() {
    let ws = window.appGlobals.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const wsUrl = getWebSocketUrl();
    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        console.error('[WS] Connection init error:', e);
        return;
    }

    window.ws = ws;
    window.appGlobals.ws = ws;

    ws.onopen = () => {
        window.appGlobals.isConnected = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // 1. Authenticate socket session if JWT token exists
        const jwtToken = localStorage.getItem('31_jwt');
        if (jwtToken) {
            ws.send(JSON.stringify({ type: 'AUTH_TOKEN', token: jwtToken }));
        }

        // 2. Auto-rejoin active table on mobile reconnect / focus recovery
        if (window.appGlobals.currentJoinedCode) {
            const usernameInput = document.getElementById('username-input');
            const activeUsername = usernameInput ? usernameInput.value.trim() : (window.clientState.username || 'Player1');
            ws.send(JSON.stringify({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: activeUsername
            }));
        }

        // 3. Flush queued messages
        while (window.appGlobals.pendingQueue.length > 0) {
            const msg = window.appGlobals.pendingQueue.shift();
            ws.send(JSON.stringify(msg));
        }

        // 4. Query public lobbies
        window.initSocketAndSend({ type: 'GET_LOBBIES' });
        window.initSocketAndSend({ type: 'REFRESH_LOBBIES' });
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            console.error('[WS] JSON Parse Error:', err);
            return;
        }
        handleIncomingServerMessage(data);
    };

    ws.onclose = () => {
        window.appGlobals.isConnected = false;
        window.ws = null;
        window.appGlobals.ws = null;

        // Auto-reconnect if authenticated or inside an active room
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (window.userSession || window.appGlobals.currentJoinedCode) {
                    window.connectSocket();
                }
            }, 1500);
        }
    };

    ws.onerror = (err) => {
        console.warn('[WS] Socket encounter:', err);
    };
};

/**
 * Message dispatcher: Routes server state to UI, Audio, and LiveKit modules
 */
function handleIncomingServerMessage(data) {
    switch (data.type) {
        case 'LOBBY_LIST':
            if (typeof window.renderLobbyList === 'function') {
                window.renderLobbyList(data.lobbies || []);
            } else if (typeof window.renderPublicLobbies === 'function') {
                window.renderPublicLobbies(data.lobbies || []);
            }
            break;

        case 'LOBBY_CREATED':
        case 'LOBBY_JOINED':
            if (data.code) window.appGlobals.currentJoinedCode = data.code;
            if (data.lobby) window.appGlobals.latestLobbySnapshot = data.lobby;

            // Connect LiveKit Voice Room (Muted state)
            const livekitHost = data.livekitHost || data.host;
            const livekitToken = data.livekitToken || data.token;
            if (livekitHost && livekitToken) {
                if (typeof window.connectLiveKit === 'function') {
                    window.connectLiveKit(livekitToken, livekitHost, data.code);
                } else if (typeof window.connectToVoiceChat === 'function') {
                    window.connectToVoiceChat(livekitHost, livekitToken);
                }
            }

            // Render table view
            if (data.lobby && typeof window.updateUIFromLobby === 'function') {
                window.updateUIFromLobby(data.lobby);
            } else if (data.lobby && typeof window.renderLobbyState === 'function') {
                window.renderLobbyState(data.lobby);
            }
            break;

        case 'GAME_STATE_UPDATE':
        case 'LOBBY_UPDATE':
            if (data.lobby) {
                if (data.lobby.code) window.appGlobals.currentJoinedCode = data.lobby.code;
                window.appGlobals.latestLobbySnapshot = data.lobby;

                // Sync LiveKit credentials if included in update
                if (data.livekitHost && data.livekitToken) {
                    if (typeof window.connectLiveKit === 'function') {
                        window.connectLiveKit(data.livekitToken, data.livekitHost, data.lobby.code);
                    } else if (typeof window.connectToVoiceChat === 'function') {
                        window.connectToVoiceChat(data.livekitHost, data.livekitToken);
                    }
                }

                if (typeof window.updateUIFromLobby === 'function') {
                    window.updateUIFromLobby(data.lobby);
                } else if (typeof window.renderLobbyState === 'function') {
                    window.renderLobbyState(data.lobby);
                }
            }
            break;

        case 'CHAT_MESSAGE':
            if (typeof window.appendChatMessage === 'function') {
                window.appendChatMessage(data.user || data.username, data.text || data.message);
            }
            break;

        case 'LEFT_LOBBY':
            window.appGlobals.currentJoinedCode = null;
            window.appGlobals.latestLobbySnapshot = null;

            if (typeof window.disconnectLiveKit === 'function') {
                window.disconnectLiveKit();
            }
            if (typeof window.resetToMainMenu === 'function') {
                window.resetToMainMenu();
            }
            break;

        case 'LIFETIME_LEDGER_DATA':
            if (data.balances) {
                window.cachedLifetimeBalances = data.balances;
                if (typeof window.renderLifetimeLedger === 'function') {
                    window.renderLifetimeLedger(data.balances);
                }
            }
            break;

        case 'LIVEKIT_TOKEN':
            if (data.host && data.token) {
                if (typeof window.connectLiveKit === 'function') {
                    window.connectLiveKit(data.token, data.host, window.appGlobals.currentJoinedCode);
                } else if (typeof window.connectToVoiceChat === 'function') {
                    window.connectToVoiceChat(data.host, data.token);
                }
            }
            break;

        case 'ERROR':
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(data.message || 'Error occurred');
            } else {
                alert(data.message || 'An error occurred.');
            }
            break;

        default:
            break;
    }
}

// -------------------------------------------------------------
// 3. OUTGOING MESSAGE DISPATCHER
// -------------------------------------------------------------
window.initSocketAndSend = function(payload) {
    if (!payload || typeof payload !== 'object') return;

    // Attach active persistent profile identity to all payloads
    if (window.userSession) {
        payload.userId = window.userSession.id;
        payload.isGuest = !!window.userSession.isGuest;
    }

    const ws = window.appGlobals.ws || window.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        window.appGlobals.pendingQueue.push(payload);
        window.connectSocket();
    }
};

window.sendSocketMessage = window.initSocketAndSend;

// -------------------------------------------------------------
// 4. GLOBAL GAME ACTIONS (Invoked by HTML controls)
// -------------------------------------------------------------
window.createLobby = function() {
    window.saveInputs();
    const userIn = document.getElementById('username-input');
    const nameIn = document.getElementById('lobby-name-input');
    const privIn = document.getElementById('private-lobby-checkbox');

    const username = (userIn && userIn.value ? userIn.value : '').trim() || (window.userSession?.username || 'Player1');
    const lobbyName = (nameIn && nameIn.value ? nameIn.value : '').trim() || `${username}'s Table`;
    const isPrivate = privIn ? privIn.checked : false;

    window.clientState.username = username;

    window.initSocketAndSend({
        type: 'CREATE_LOBBY',
        username,
        lobbyName,
        isPrivate
    });
};

window.joinLobby = function() {
    window.saveInputs();
    const userIn = document.getElementById('username-input');
    const codeIn = document.getElementById('lobby-code-input') || document.getElementById('join-code-input');

    const username = (userIn && userIn.value ? userIn.value : '').trim() || (window.userSession?.username || 'Player1');
    const code = (codeIn && codeIn.value ? codeIn.value : '').trim().toUpperCase();

    if (!code) {
        return alert('Please enter a table code.');
    }

    window.clientState.username = username;
    window.appGlobals.currentJoinedCode = code;

    window.initSocketAndSend({
        type: 'JOIN_LOBBY',
        code,
        username
    });
};

window.joinLobbyCode = function(code) {
    if (!code) return;
    window.saveInputs();
    const userIn = document.getElementById('username-input');
    const username = (userIn && userIn.value ? userIn.value : '').trim() || (window.userSession?.username || 'Player1');

    window.clientState.username = username;
    window.appGlobals.currentJoinedCode = code.toUpperCase();

    window.initSocketAndSend({
        type: 'JOIN_LOBBY',
        code: code.toUpperCase(),
        username
    });
};

window.joinLobbyDirect = window.joinLobbyCode;

window.refreshLobbies = function() {
    window.initSocketAndSend({ type: 'REFRESH_LOBBIES' });
    window.initSocketAndSend({ type: 'GET_LOBBIES' });
};

window.leaveLobby = function() {
    window.initSocketAndSend({ type: 'LEAVE_LOBBY' });
    if (typeof window.disconnectLiveKit === 'function') window.disconnectLiveKit();
    if (typeof window.resetToMainMenu === 'function') window.resetToMainMenu();
};

window.sitDown = function() {
    window.initSocketAndSend({ type: 'SIT_DOWN' });
};

window.standUp = function() {
    window.initSocketAndSend({ type: 'STAND_UP' });
};

window.toggleReady = function() {
    const nextState = !window.clientState.isReady;
    window.clientState.isReady = nextState;
    const btn = document.getElementById('ready-btn');
    if (btn) btn.innerText = nextState ? 'Unready' : 'Ready Up';

    window.initSocketAndSend({
        type: 'SET_READY',
        ready: nextState
    });
};

window.clickNextHand = function() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    window.initSocketAndSend({ type: 'NEXT_HAND_READY' });
    window.initSocketAndSend({ type: 'NEXT_HAND' });
};

window.drawCard = function(source) {
    window.initSocketAndSend({
        type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD'
    });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

// Symmetrical index dispatching so discard actions never freeze
window.discardCard = function(cardIndex) {
    window.initSocketAndSend({
        type: 'DISCARD_CARD',
        cardIndex: cardIndex,
        index: cardIndex
    });
};

window.knockRound = function() {
    window.initSocketAndSend({ type: 'KNOCK' });
    if (typeof window.playSound === 'function') window.playSound('knock');
};

window.choosePoolCard = function(cardIndex) {
    window.initSocketAndSend({
        type: 'CHOOSE_POOL_CARD',
        cardIndex: cardIndex
    });
};

window.chooseTieCard = window.choosePoolCard;

window.updateWager = function() {
    const sel = document.getElementById('config-wager');
    if (sel) {
        window.initSocketAndSend({
            type: 'UPDATE_WAGER',
            wager: parseInt(sel.value, 10) || 5
        });
    }
};

window.updateSettings = function() {
    const sel = document.getElementById('config-lives');
    if (sel) {
        window.initSocketAndSend({
            type: 'UPDATE_SETTINGS',
            lives: parseInt(sel.value, 10) || 3
        });
    }
};

window.addBot = function() {
    window.initSocketAndSend({ type: 'ADD_BOT' });
};

window.removeBot = function() {
    window.initSocketAndSend({ type: 'REMOVE_BOT' });
};

window.proposeEndGame = function() {
    if (confirm("Propose ending the match and returning to waiting room?")) {
        window.initSocketAndSend({ type: 'END_GAME_PROPOSAL' });
    }
};

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        window.initSocketAndSend({
            type: 'CHAT_MESSAGE',
            message: text,
            text: text
        });
        input.value = '';
    }
};

window.submitEliminationProposal = function(target, wagerAmt) {
    window.initSocketAndSend({
        type: 'PROPOSE_ELIMINATION_BET',
        target: target,
        wagerAmt: wagerAmt
    });
    if (typeof window.toggleModal === 'function') window.toggleModal('bet-modal');
    if (typeof window.showCenterNotification === 'function') {
        window.showCenterNotification(`Side bet proposed to ${target}!`);
    }
};

window.clearDebtCategory = function(targetUser, category) {
    window.initSocketAndSend({
        type: 'CLEAR_DEBT',
        targetUser: targetUser,
        category: category
    });
};

window.requestPeekAction = function(targetUsername) {
    window.initSocketAndSend({
        type: 'REQUEST_PEEK',
        targetUsername: targetUsername
    });
};

window.respondPeekAction = function(spectatorUsername, allow) {
    window.initSocketAndSend({
        type: 'RESPOND_PEEK',
        spectatorUsername: spectatorUsername,
        allow: !!allow
    });
};

window.stopPeekingAction = function() {
    window.initSocketAndSend({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
};

window.kickPeekerAction = function(spectatorUsername) {
    window.initSocketAndSend({
        type: 'KICK_PEEKER',
        spectatorUsername: spectatorUsername
    });
};

// -------------------------------------------------------------
// 5. MOBILE VISIBILITY & TAB LIFECYCLE AUTO-SYNC
// -------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        const ws = window.appGlobals.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            window.connectSocket();
        } else if (window.appGlobals.currentJoinedCode) {
            const usernameInput = document.getElementById('username-input');
            const activeUsername = usernameInput ? usernameInput.value.trim() : (window.clientState.username || 'Player1');
            window.initSocketAndSend({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: activeUsername
            });
        }
    }
});

window.addEventListener('pageshow', () => {
    const ws = window.appGlobals.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        window.connectSocket();
    }
});

// Auto-run input restoration on script load
window.restoreSavedInputs();
