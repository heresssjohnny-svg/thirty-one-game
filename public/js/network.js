// public/js/network.js - WebSocket Engine, Event Routing, Anti-Kick & Mic Cleanup

// -------------------------------------------------------------
// 1. STATE & PERSISTENT ENVIRONMENT INITIALIZATION
// -------------------------------------------------------------
window.appGlobals = window.appGlobals || {};

// Rehydrate active room code from localStorage so backgrounding/reload retains table context
window.appGlobals.currentJoinedCode = localStorage.getItem('blitz31_active_room') || null;
window.appGlobals.ws = null;
window.appGlobals.isConnected = false;
window.appGlobals.pendingQueue = [];
window.appGlobals.latestLobbySnapshot = null;
window.appGlobals.wasMyTurn = false;
window.appGlobals.lastKnownKnockedBy = null;
window.appGlobals.hasChosenPoolCard = false;
window.appGlobals.lastPhaseMessage = '';
window.appGlobals.lastGameState = '';
window.appGlobals.lastCelebratedWinner = null;
window.appGlobals.lastCelebrated31 = null;
window.appGlobals.lastChatCount = 0;
window.appGlobals.notificationTimer = null;
window.appGlobals.lastConnectedLiveKitRoom = null;

window.clientState = window.clientState || {
    username: localStorage.getItem('saved_username') || 'Player1',
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

// Helper to reliably get the active player's username
window.getActiveUsername = window.getActiveUsername || function() {
    const uIn = document.getElementById('username-input');
    const fromInput = uIn && uIn.value ? uIn.value.trim() : '';
    if (fromInput) return fromInput;
    if (window.clientState && window.clientState.username) return window.clientState.username.trim();
    if (window.userSession && window.userSession.username) return window.userSession.username.trim();
    return (localStorage.getItem('saved_username') || localStorage.getItem('blitz31_username') || 'Player1').trim();
};

// Input field persistence helpers
window.saveInputs = window.saveInputs || function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u && u.value.trim()) {
            const val = u.value.trim();
            localStorage.setItem('saved_username', val);
            localStorage.setItem('blitz31_username', val);
            if (window.clientState) window.clientState.username = val;
        }
        if (l) {
            localStorage.setItem('saved_lobby_name', l.value.trim());
            localStorage.setItem('blitz31_lobby_name', l.value.trim());
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
        if (window.clientState && savedU) {
            window.clientState.username = savedU.trim() || 'Player1';
        }
    } catch (e) {}
};

// -------------------------------------------------------------
// 2. WEBSOCKET CONNECTION & EVENT ROUTING
// -------------------------------------------------------------
let reconnectTimer = null;
let heartbeatTimer = null;
let lastResyncTimestamp = 0;

function getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
}

window.connectSocket = function() {
    let ws = window.appGlobals.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    try {
        ws = new WebSocket(getWebSocketUrl());
        window.appGlobals.ws = ws;
        window.ws = ws;

        ws.onopen = () => {
            window.appGlobals.isConnected = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            // Start 20s heartbeat to prevent NAT / carrier disconnects
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN && !document.hidden) {
                    ws.send(JSON.stringify({ type: 'PING' }));
                }
            }, 20000);

            // 1. Authenticate with stored session token if present
            const jwtToken = localStorage.getItem('auth_token') || 
                             localStorage.getItem('token') || 
                             localStorage.getItem('jwt') || 
                             localStorage.getItem('31_jwt');
            if (jwtToken) {
                ws.send(JSON.stringify({ type: 'AUTH_TOKEN', token: jwtToken }));
            }

            // 2. Username & active room resolution
            const myName = window.getActiveUsername();
            const authScreen = document.getElementById('auth-screen');
            const isAuthScreenVisible = authScreen && authScreen.style.display !== 'none';
            const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');

            // 3. Reclaim seat first so ws.currentLobbyCode & ws.currentUsername are bound on the server
            if (activeRoom && !isAuthScreenVisible) {
                lastResyncTimestamp = Date.now();
                ws.send(JSON.stringify({
                    type: 'JOIN_LOBBY',
                    code: activeRoom.toUpperCase(),
                    username: myName
                }));
            } else if (!isAuthScreenVisible) {
                window.refreshLobbies();
            }

            // 4. Flush pending message queue after JOIN_LOBBY
            if (window.appGlobals.pendingQueue && window.appGlobals.pendingQueue.length > 0) {
                while (window.appGlobals.pendingQueue.length > 0) {
                    const msg = window.appGlobals.pendingQueue.shift();
                    ws.send(JSON.stringify(msg));
                }
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleIncomingServerMessage(data);
            } catch (err) {
                console.error('[Network] Message parse error:', err);
            }
        };

        ws.onerror = (err) => {
            console.warn('[Network] WebSocket error:', err);
        };

        ws.onclose = () => {
            window.appGlobals.isConnected = false;
            window.ws = null;
            window.appGlobals.ws = null;

            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }

            // Do not reset UI here; allow the server grace period to preserve the table seat
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');
                    if (window.userSession || activeRoom) {
                        window.connectSocket();
                    }
                }, 1500);
            }
        };
    } catch (e) {
        console.error('[Network] Connection initiation failed:', e);
    }
};

function handleIncomingServerMessage(data) {
    if (!data || !data.type) return;

    switch (data.type) {
        case 'PONG':
            break;

        case 'AUTH_SUCCESS':
            window.userSession = data.user;
            if (data.user && data.user.username) {
                window.clientState.username = data.user.username;
                localStorage.setItem('saved_username', data.user.username);
                const uIn = document.getElementById('username-input');
                if (uIn) uIn.value = data.user.username;
            }
            if (typeof window.updateViewForAuth === 'function') {
                window.updateViewForAuth(data.user);
            }
            window.initSocketAndSend({ type: 'GET_LOBBIES' });
            break;

        case 'AUTH_ERROR':
            window.userSession = null;
            if (typeof window.updateViewForAuth === 'function') {
                window.updateViewForAuth(null);
            }
            break;

        case 'LOBBY_LIST':
        case 'PUBLIC_LOBBIES':
            if (typeof window.renderLobbyList === 'function') {
                window.renderLobbyList(data.lobbies || []);
            } else if (typeof window.renderPublicLobbies === 'function') {
                window.renderPublicLobbies(data.lobbies || []);
            }
            break;

        case 'LOBBY_CREATED':
        case 'LOBBY_JOINED': {
            const joinedCode = (data.code || data.lobby?.code || '').toUpperCase();
            if (joinedCode) {
                window.appGlobals.currentJoinedCode = joinedCode;
                localStorage.setItem('blitz31_active_room', joinedCode);
            }
            if (data.lobby) window.appGlobals.latestLobbySnapshot = data.lobby;

            // Viewport transition from menu/auth to active table felt
            const mainMenu = document.getElementById('main-menu');
            const authScreen = document.getElementById('auth-screen');
            const gameView = document.getElementById('game-view');
            if (mainMenu) mainMenu.style.display = 'none';
            if (authScreen) authScreen.style.display = 'none';
            if (gameView) {
                gameView.style.display = 'flex';
                gameView.style.visibility = 'visible';
            }

            // Connect LiveKit Voice Room only if not already connected to this room
            const livekitHost = data.livekitHost || data.host;
            const livekitToken = data.livekitToken || data.token;
            if (livekitHost && livekitToken && window.appGlobals.lastConnectedLiveKitRoom !== joinedCode) {
                window.appGlobals.lastConnectedLiveKitRoom = joinedCode;
                if (typeof window.connectToLiveKit === 'function') {
                    window.connectToLiveKit(livekitHost, livekitToken, joinedCode);
                } else if (typeof window.connectLiveKit === 'function') {
                    window.connectLiveKit(livekitHost, livekitToken, joinedCode);
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
        }

        case 'GAME_STATE_UPDATE':
        case 'LOBBY_UPDATE':
            if (data.lobby) {
                if (data.lobby.code) {
                    window.appGlobals.currentJoinedCode = data.lobby.code.toUpperCase();
                    localStorage.setItem('blitz31_active_room', data.lobby.code.toUpperCase());
                }
                window.appGlobals.latestLobbySnapshot = data.lobby;
                if (typeof window.updateUIFromLobby === 'function') {
                    window.updateUIFromLobby(data.lobby);
                } else if (typeof window.renderLobbyState === 'function') {
                    window.renderLobbyState(data.lobby);
                }
            }
            break;

        case 'KICKED_FROM_LOBBY':
            // Clear active room context first so window.focus doesn't auto-rejoin after alert()
            window.appGlobals.currentJoinedCode = null;
            window.appGlobals.latestLobbySnapshot = null;
            window.appGlobals.lastConnectedLiveKitRoom = null;
            localStorage.removeItem('blitz31_active_room');
            localStorage.removeItem('blitz31_mic_state');
            if (typeof window.resetToMainMenu === 'function') {
                window.resetToMainMenu(true);
            }
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(data.message || 'You were kicked from the room by the host.');
            } else {
                alert(data.message || 'You were kicked from the room by the host.');
            }
            break;

        case 'ADMIN_FORCE_MUTE':
            if (typeof window.forceMuteLocalMicByAdmin === 'function') {
                window.forceMuteLocalMicByAdmin(data.byHost);
            } else if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(`🔇 ${data.byHost || 'The host'} muted your microphone.`);
            }
            break;

        case 'LEFT_LOBBY':
            window.appGlobals.currentJoinedCode = null;
            window.appGlobals.latestLobbySnapshot = null;
            window.appGlobals.lastConnectedLiveKitRoom = null;
            if (typeof window.resetToMainMenu === 'function') {
                window.resetToMainMenu(true);
            }
            break;

        case ' NOTIFICATION':
        case 'NOTIFICATION':
            if (data.message && typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(data.message);
            }
            break;

        case 'ERROR': {
            const msg = data.message || 'Error occurred';
            const isDeadLobby = msg.includes('Table does not exist') ||
                                msg.includes('Lobby not found') ||
                                msg.includes('Lobby does not exist') ||
                                msg.includes('closed due to inactivity');

            if (isDeadLobby) {
                window.appGlobals.currentJoinedCode = null;
                window.appGlobals.lastConnectedLiveKitRoom = null;
                localStorage.removeItem('blitz31_active_room');
                localStorage.removeItem('blitz31_mic_state');
                if (typeof window.resetToMainMenu === 'function') {
                    window.resetToMainMenu(true);
                }
            }
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(msg);
            }
            break;
        }

        case 'LIVEKIT_TOKEN':
            if (data.token && data.host && typeof window.connectToLiveKit === 'function') {
                window.connectToLiveKit(data.host, data.token, data.room);
            }
            break;

        case 'LIFETIME_LEDGER_DATA':
            if (typeof window.renderLifetimeLedger === 'function') {
                window.renderLifetimeLedger(data.balances || data.ledger || data.debts || []);
            }
            break;

        case 'SESSION_LEDGER_DATA':
            if (window.appGlobals.latestLobbySnapshot) {
                if (data.mainGameLedger) window.appGlobals.latestLobbySnapshot.mainGameLedger = data.mainGameLedger;
                if (data.sideBetLedger) window.appGlobals.latestLobbySnapshot.sideBetLedger = data.sideBetLedger;
                if (data.botBetLedger) window.appGlobals.latestLobbySnapshot.botBetLedger = data.botBetLedger;
                if (data.activeBets) window.appGlobals.latestLobbySnapshot.activeBets = data.activeBets;
            }
            if (typeof window.renderSessionLedger === 'function') {
                window.renderSessionLedger(window.appGlobals.latestLobbySnapshot || data);
            }
            break;

        case 'UPDATE_VC_STATUS':
        case 'VC_STATUS_UPDATE':
            if (data.username && window.appGlobals && window.appGlobals.latestLobbySnapshot) {
                const snap = window.appGlobals.latestLobbySnapshot;
                const player = (snap.players || []).find(p => p.username.toLowerCase() === data.username.toLowerCase());
                if (player) {
                    player.inVC = Boolean(data.inVC !== undefined ? data.inVC : true);
                    player.isMuted = Boolean(data.isMuted);
                }
                const spectator = (snap.spectators || []).find(s => s.username && s.username.toLowerCase() === data.username.toLowerCase());
                if (spectator) {
                    spectator.inVC = Boolean(data.inVC !== undefined ? data.inVC : true);
                    spectator.isMuted = Boolean(data.isMuted);
                }
                if (typeof window.updateUIFromLobby === 'function') {
                    window.updateUIFromLobby(snap);
                }
                if (typeof window.refreshVoiceParticipantsList === 'function') {
                    window.refreshVoiceParticipantsList();
                }
            }
            break;

        case 'CHAT_MESSAGE':
            if (typeof window.appendChatMessage === 'function') {
                window.appendChatMessage(data.user || data.username || 'Player', data.text || data.message || '');
            }
            break;

        default:
            break;
    }
}

// -------------------------------------------------------------
// 3. OUTGOING MESSAGE DISPATCHERS
// -------------------------------------------------------------
window.initSocketAndSend = function(data) {
    if (!data || typeof data !== 'object') return;

    // Auto-attach room code, username, and session userId so no packet is ever orphaned
    if (!data.code) {
        const activeCode = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');
        if (activeCode) data.code = activeCode.toUpperCase();
    }
    if (!data.username) {
        data.username = window.getActiveUsername();
    }
    if (window.userSession && !data.userId) {
        data.userId = window.userSession.id || window.userSession.userId;
        data.isGuest = Boolean(window.userSession.isGuest);
    }

    const ws = window.appGlobals.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    } else {
        if (!window.appGlobals.pendingQueue) window.appGlobals.pendingQueue = [];
        window.appGlobals.pendingQueue.push(data);
        if (typeof window.connectSocket === 'function') {
            window.connectSocket();
        }
    }
};

window.sendSocket = window.initSocketAndSend;
window.sendSocketMessage = window.initSocketAndSend;

// -------------------------------------------------------------
// 4. LOBBY CREATION, NAVIGATION & LIFECYCLE
// -------------------------------------------------------------
window.refreshLobbies = function() {
    window.initSocketAndSend({ type: 'GET_LOBBIES' });
};

window.createLobby = function() {
    try {
        if (typeof window.saveInputs === 'function') window.saveInputs();
        const nameIn = document.getElementById('lobby-name-input');
        const privIn = document.getElementById('lobby-private-toggle') || document.getElementById('private-lobby-checkbox');
        const livesSelect = document.getElementById('lobby-lives-select') || document.getElementById('initial-lives-select');

        const username = window.getActiveUsername();
        const lobbyName = (nameIn?.value || '').trim() || `${username}'s Table`;
        const isPrivate = privIn ? Boolean(privIn.checked) : false;
        const defaultLives = livesSelect ? (parseInt(livesSelect.value, 10) || 2) : 2;

        window.clientState = window.clientState || {};
        window.clientState.username = username;
        localStorage.setItem('saved_username', username);

        window.initSocketAndSend({
            type: 'CREATE_LOBBY',
            name: lobbyName,
            lobbyName: lobbyName,
            username: username,
            isPrivate: isPrivate,
            defaultLives: defaultLives
        });
    } catch (err) {
        alert("Create Table Error: " + err.message);
    }
};

window.joinLobby = function(targetCode) {
    try {
        if (typeof window.saveInputs === 'function') window.saveInputs();

        const codeIn = document.getElementById('lobby-code-input') || 
                       document.getElementById('join-code-input') ||
                       document.getElementById('table-code-input');

        const username = window.getActiveUsername();

        const rawCode = (typeof targetCode === 'string' && targetCode.trim())
            ? targetCode.trim()
            : (codeIn?.value || '').trim();

        const code = rawCode.toUpperCase();

        if (!code) {
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification('Please enter a table code.');
            } else {
                alert('Please enter a table code.');
            }
            return;
        }

        window.clientState = window.clientState || {};
        window.clientState.username = username;
        localStorage.setItem('saved_username', username);
        if (window.appGlobals) window.appGlobals.currentJoinedCode = code;
        localStorage.setItem('blitz31_active_room', code);

        window.initSocketAndSend({
            type: 'JOIN_LOBBY',
            code: code,
            username: username
        });
    } catch (err) {
        alert("Join Table Error: " + err.message);
    }
};

window.joinLobbyCode = window.joinLobby;
window.joinLobbyDirect = window.joinLobby;
window.handleJoinLobby = window.joinLobby;

// -------------------------------------------------------------
// SECURE LEAVE & UI RESET LOGIC (WITH MIC STATE CLEANUP)
// -------------------------------------------------------------
window.leaveLobby = function() {
    if (!confirm("Are you sure you want to leave the table?")) {
        return;
    }

    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.lastConnectedLiveKitRoom = null;
    localStorage.removeItem('blitz31_mic_state');

    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();

    if (window.appGlobals.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify({ type: 'LEAVE_LOBBY' }));
    }

    window.resetToMainMenu(true);
};

window.resetToMainMenu = function(forceClearRoom = false) {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.lastConnectedLiveKitRoom = null;
    window.appGlobals.lastChatCount = 0;

    if (forceClearRoom === true) {
        localStorage.removeItem('blitz31_active_room');
        localStorage.removeItem('blitz31_mic_state');
    }

    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const endBtn = document.getElementById('end-game-btn');
    const leaveBtn = document.getElementById('leave-lobby-btn');

    if (gameView) gameView.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';
    if (topRowBtns) topRowBtns.style.display = 'none';
    if (toolsRow) toolsRow.style.display = 'none';
    if (endBtn) endBtn.style.display = 'none';
    if (leaveBtn) leaveBtn.style.display = 'none';

    const chatWin = document.getElementById('chat-window');
    if (chatWin) chatWin.style.display = 'none';
    const box = document.getElementById('chat-messages');
    if (box) box.innerHTML = '';

    window.clientState.isReady = false;
    window.appGlobals.hasChosenPoolCard = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';

    if (typeof window.refreshLobbies === 'function') window.refreshLobbies();
};

// -------------------------------------------------------------
// 5. TABLE SEATING, PEEKING, ADMIN & PRE-GAME CONTROLS
// -------------------------------------------------------------
window.sitDown = function() {
    window.initSocketAndSend({ type: 'SIT_DOWN' });
};

window.standUp = function() {
    window.initSocketAndSend({ type: 'STAND_UP' });
};

window.toggleReady = function() {
    const nextState = !Boolean(window.clientState && window.clientState.isReady);
    if (window.clientState) {
        window.clientState.isReady = nextState;
    }

    const btn = document.getElementById('ready-btn') || document.getElementById('btn-ready');
    if (btn) {
        btn.innerText = nextState ? 'Unready' : 'Ready Up';
        btn.classList.toggle('ready-active', nextState);
    }

    window.appGlobals.hasChosenPoolCard = false;
    if (typeof playSound === 'function') playSound('card');

    window.initSocketAndSend({
        type: 'SET_READY',
        ready: nextState
    });
};

window.addBot = function() { window.initSocketAndSend({ type: 'ADD_BOT' }); };
window.removeBot = function() { window.initSocketAndSend({ type: 'REMOVE_BOT' }); };

window.updateWager = function() {
    const sel = document.getElementById('config-wager') || document.getElementById('lobby-wager-select');
    if (sel) {
        window.initSocketAndSend({ type: 'UPDATE_WAGER', wager: parseInt(sel.value, 10) || 5 });
    }
};

window.updateSettings = function() {
    const sel = document.getElementById('config-lives') || document.getElementById('lobby-lives-select');
    if (sel) {
        window.initSocketAndSend({ type: 'UPDATE_SETTINGS', lives: parseInt(sel.value, 10) || 2 });
    }
};

window.proposeEndGame = function() {
    if (confirm("End current match and return to the waiting lobby?")) {
        window.initSocketAndSend({ type: 'END_GAME_PROPOSAL' });
    }
};

window.requestPeekAction = function(targetUsername) {
    window.initSocketAndSend({
        type: 'REQUEST_PEEK',
        targetUsername: targetUsername,
        target: targetUsername
    });
};

window.respondPeekAction = function(spectatorUsername, allow) {
    window.initSocketAndSend({
        type: 'RESPOND_PEEK',
        spectatorUsername: spectatorUsername,
        requester: spectatorUsername,
        allow: Boolean(allow),
        accept: Boolean(allow)
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
        spectatorUsername: spectatorUsername,
        requester: spectatorUsername,
        target: spectatorUsername
    });
};

// Room Creator (Host) Admin Controls: Kick & Mute
window.adminKickPlayer = function(targetUsername) {
    if (!targetUsername) return;
    if (!confirm(`Kick ${targetUsername} from the room?`)) return;
    const myName = window.getActiveUsername();
    const code = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');
    window.initSocketAndSend({
        type: 'ADMIN_KICK_PLAYER',
        code: code,
        requesterUsername: myName,
        targetUsername: targetUsername
    });
};

window.adminMutePlayer = function(targetUsername) {
    if (!targetUsername) return;
    const myName = window.getActiveUsername();
    const code = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');
    window.initSocketAndSend({
        type: 'ADMIN_MUTE_PLAYER',
        code: code,
        requesterUsername: myName,
        targetUsername: targetUsername
    });
    if (typeof window.showCenterNotification === 'function') {
        window.showCenterNotification(`🔇 Muted ${targetUsername}`);
    }
};

// -------------------------------------------------------------
// 6. IN-GAME TURN & CARD ACTIONS
// -------------------------------------------------------------
window.drawCard = function(source) {
    if (window.clientState && window.clientState.isSpectator) return;
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);

    const isDiscard = source === 'discard';
    window.initSocketAndSend({
        type: isDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK',
        source: isDiscard ? 'discard' : 'deck',
        action: isDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK'
    });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    if (window.clientState && window.clientState.isSpectator) return;
    const idx = parseInt(cardIndex, 10);
    if (isNaN(idx)) return;

    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(30);

    window.initSocketAndSend({
        type: 'DISCARD_CARD',
        cardIndex: idx,
        index: idx
    });
};

window.knockGame = function() {
    window.initSocketAndSend({ type: 'KNOCK' });
};

window.selectPoolCard = function(poolIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    const idx = parseInt(poolIndex, 10);
    if (isNaN(idx)) return;

    window.appGlobals.hasChosenPoolCard = true;
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(25);

    window.initSocketAndSend({ 
        type: 'CHOOSE_POOL_CARD', 
        poolIndex: idx, 
        cardIndex: idx,
        index: idx
    });
};
window.choosePoolCard = window.selectPoolCard;

window.readyNextHand = function() {
    const overlay = document.getElementById('next-hand-overlay');
    if (overlay) overlay.style.display = 'none';
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }

    window.initSocketAndSend({ type: 'NEXT_HAND_READY' });
};
window.clickNextHand = window.readyNextHand;

// -------------------------------------------------------------
// 7. MOBILE VISIBILITY, LIFECYCLE RE-SYNC & ANTI-KICK
// -------------------------------------------------------------
function resyncActiveSession(forceJoin = false) {
    const authScreen = document.getElementById('auth-screen');
    if (authScreen && authScreen.style.display !== 'none') {
        return;
    }

    const activeRoom = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');
    if (!activeRoom) return;

    const myName = window.getActiveUsername();
    if (!myName) return;

    const ws = window.appGlobals?.ws;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (typeof window.connectSocket === 'function') {
            window.connectSocket();
        }
    } else if (forceJoin || (Date.now() - lastResyncTimestamp > 5000)) {
        // Throttle JOIN_LOBBY resyncs so closing confirm() modals doesn't spam LiveKit tokens
        lastResyncTimestamp = Date.now();
        ws.send(JSON.stringify({
            type: 'JOIN_LOBBY',
            code: activeRoom.toUpperCase(),
            username: myName
        }));
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resyncActiveSession(true);
});

window.addEventListener('pageshow', () => {
    resyncActiveSession(true);
});

window.addEventListener('focus', () => {
    resyncActiveSession(false);
});

// UI & HTML compatibility aliases
window.setReady = window.toggleReady;
window.handleSitDown = window.sitDown;
window.handleStandUp = window.standUp;
window.handleLeaveLobby = window.leaveLobby;

// Boot synchronization
function bootNetworkLayer() {
    window.restoreSavedInputs();
    window.connectSocket();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootNetworkLayer);
} else {
    bootNetworkLayer();
}
