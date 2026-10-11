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

// Input field persistence helpers
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
let heartbeatTimer = null;

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

            // Flush pending message queue
            if (window.appGlobals.pendingQueue && window.appGlobals.pendingQueue.length > 0) {
                while (window.appGlobals.pendingQueue.length > 0) {
                    const msg = window.appGlobals.pendingQueue.shift();
                    ws.send(JSON.stringify(msg));
                }
            }

            // Heartbeat to prevent silent carrier/NAT disconnects
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN && !document.hidden) {
                    ws.send(JSON.stringify({ type: 'PING' }));
                }
            }, 20000);

            // Reclaim seat if table session is preserved in storage
            const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');
            const myName = (document.getElementById('username-input')?.value ||
                            window.clientState?.username ||
                            localStorage.getItem('saved_username') ||
                            'Player1').trim();

            if (activeRoom) {
                ws.send(JSON.stringify({
                    type: 'JOIN_LOBBY',
                    code: activeRoom.toUpperCase(),
                    username: myName
                }));
            } else {
                window.refreshLobbies();
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

            // Do NOT reset UI here. Allow the 90-second server grace period to hold the seat.
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
            // Heartbeat reply; no action needed
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
            }
            break;

        case 'LOBBY_CREATED':
        case 'LOBBY_JOINED':
            if (data.code) {
                window.appGlobals.currentJoinedCode = data.code.toUpperCase();
                localStorage.setItem('blitz31_active_room', data.code.toUpperCase());
            }
            if (data.lobby) window.appGlobals.latestLobbySnapshot = data.lobby;

            // Viewport transition
            const mainMenu = document.getElementById('main-menu');
            const authScreen = document.getElementById('auth-screen');
            const gameView = document.getElementById('game-view');
            if (mainMenu) mainMenu.style.display = 'none';
            if (authScreen) authScreen.style.display = 'none';
            if (gameView) {
                gameView.style.display = 'flex';
                gameView.style.visibility = 'visible';
            }

            // Connect LiveKit Voice Room
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

        case 'LOBBY_UPDATE':
            if (data.lobby) {
                window.appGlobals.latestLobbySnapshot = data.lobby;
                if (typeof window.updateUIFromLobby === 'function') {
                    window.updateUIFromLobby(data.lobby);
                } else if (typeof window.renderLobbyState === 'function') {
                    window.renderLobbyState(data.lobby);
                }
            }
            break;

        case 'LEFT_LOBBY':
            window.appGlobals.currentJoinedCode = null;
            window.appGlobals.latestLobbySnapshot = null;
            if (typeof window.resetToMainMenu === 'function') {
                window.resetToMainMenu(true);
            }
            break;

        case 'ERROR':
            if (data.message && data.message.includes('Table does not exist')) {
                window.appGlobals.currentJoinedCode = null;
                localStorage.removeItem('blitz31_active_room');
                localStorage.removeItem('blitz31_mic_state'); // Clear mic preference on dead table
                if (typeof window.resetToMainMenu === 'function') {
                    window.resetToMainMenu(true);
                }
            }
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(data.message || 'Error occurred');
            }
            break;

        case 'LIVEKIT_TOKEN':
            if (data.token && data.host && typeof window.connectToLiveKit === 'function') {
                window.connectToLiveKit(data.host, data.token, data.room);
            }
            break;

        case 'LIFETIME_LEDGER_DATA':
            if (typeof window.renderLifetimeLedger === 'function') {
                window.renderLifetimeLedger(data.ledger || data.debts || []);
            }
            break;

        case 'CHAT_MESSAGE':
            if (typeof window.appendChatMessage === 'function') {
                window.appendChatMessage(data);
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
    if (!data) return;
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

// -------------------------------------------------------------
// 4. LOBBY CREATION, NAVIGATION & LIFECYCLE
// -------------------------------------------------------------
window.refreshLobbies = function() {
    window.initSocketAndSend({ type: 'GET_LOBBIES' });
    window.initSocketAndSend({ type: 'REFRESH_LOBBIES' });
};

window.createLobby = function() {
    try {
        if (typeof window.saveInputs === 'function') window.saveInputs();
        const userIn = document.getElementById('username-input');
        const nameIn = document.getElementById('lobby-name-input');
        const privIn = document.getElementById('lobby-private-toggle') || document.getElementById('private-lobby-checkbox');
        const livesSelect = document.getElementById('lobby-lives-select') || document.getElementById('initial-lives-select');

        const username = (userIn?.value || '').trim() ||
                         (window.clientState && window.clientState.username) ||
                         (window.userSession && window.userSession.username) ||
                         localStorage.getItem('saved_username') ||
                         'Player1';
        const lobbyName = (nameIn?.value || '').trim() || `${username}'s Table`;
        const isPrivate = privIn ? Boolean(privIn.checked) : false;
        const defaultLives = livesSelect ? (parseInt(livesSelect.value, 10) || 2) : 2;

        window.clientState = window.clientState || {};
        window.clientState.username = username;
        localStorage.setItem('saved_username', username);

        window.initSocketAndSend({
            type: 'CREATE_LOBBY',
            name: lobbyName,
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

        const userIn = document.getElementById('username-input');
        const codeIn = document.getElementById('lobby-code-input') || 
                       document.getElementById('join-code-input') ||
                       document.getElementById('table-code-input');

        const username = (userIn?.value || '').trim() ||
                         (window.clientState && window.clientState.username) ||
                         (window.userSession && window.userSession.username) ||
                         localStorage.getItem('saved_username') ||
                         'Player1';

        // Read code from argument (when clicking a list row) or fall back to input box
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
    window.appGlobals.currentJoinedCode = null;

    // Clear saved mic preference so subsequent room joins start muted
    localStorage.removeItem('blitz31_mic_state');

    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();

    // Inform server of explicit departure
    if (window.appGlobals.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify({ type: 'LEAVE_LOBBY' }));
    }

    // Authorize deletion of active room
    window.resetToMainMenu(true);
};

window.resetToMainMenu = function(forceClearRoom = false) {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.lastChatCount = 0;

    // STRICT SANDBOX: Only clear room context and mic preferences on explicit leave/reset
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
// 5. TABLE SEATING & PRE-GAME CONTROLS
// -------------------------------------------------------------
window.sitDown = function() {
    const uName = (document.getElementById('username-input')?.value || window.clientState?.username || localStorage.getItem('saved_username') || 'Player1').trim();
    const code = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');
    window.initSocketAndSend({ type: 'SIT_DOWN', username: uName, code: code });
};

window.standUp = function() {
    const uName = (document.getElementById('username-input')?.value || window.clientState?.username || localStorage.getItem('saved_username') || 'Player1').trim();
    const code = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');
    window.initSocketAndSend({ type: 'STAND_UP', username: uName, code: code });
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

// -------------------------------------------------------------
// 6. IN-GAME TURN & CARD ACTIONS
// -------------------------------------------------------------
window.drawFromDeck = function() { window.initSocketAndSend({ type: 'DRAW_DECK' }); };
window.drawFromDiscard = function() { window.initSocketAndSend({ type: 'DRAW_DISCARD' }); };

window.discardCard = function(cardIndex) {
    const idx = parseInt(cardIndex, 10) || 0;
    window.initSocketAndSend({ type: 'DISCARD_CARD', cardIndex: idx, index: idx });
};

window.knockGame = function() { window.initSocketAndSend({ type: 'KNOCK' }); };

window.selectPoolCard = function(poolIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    const idx = parseInt(poolIndex, 10);
    window.initSocketAndSend({ type: 'CHOOSE_POOL_CARD', poolIndex: idx, cardIndex: idx });
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
    window.initSocketAndSend({ type: 'READY_NEXT_HAND' });
    window.initSocketAndSend({ type: 'NEXT_HAND' });
};
window.clickNextHand = window.readyNextHand;

// -------------------------------------------------------------
// 7. LIFECYCLE LISTENERS & AUTO-START
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    window.restoreSavedInputs();
    window.connectSocket();
});

// UI & HTML compatibility aliases
window.setReady = window.toggleReady;
window.handleSitDown = window.sitDown;
window.handleStandUp = window.standUp;
window.handleLeaveLobby = window.leaveLobby;

// -------------------------------------------------------------
// MOBILE VISIBILITY, LIFECYCLE RE-SYNC & ANTI-KICK
// -------------------------------------------------------------
function resyncActiveSession() {
    const authScreen = document.getElementById('auth-screen');
    if (authScreen && authScreen.style.display !== 'none') {
        return; // Do not auto-join while user is logging in
    }

    const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');
    const myName = (document.getElementById('username-input')?.value ||
                    window.clientState?.username ||
                    localStorage.getItem('saved_username') ||
                    'Player1').trim();
    const ws = window.appGlobals.ws;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        window.connectSocket();
    } else if (activeRoom) {
        ws.send(JSON.stringify({
            type: 'JOIN_LOBBY',
            code: activeRoom.toUpperCase(),
            username: myName
        }));
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resyncActiveSession();
});

window.addEventListener('pageshow', () => {
    resyncActiveSession();
});

//===============Additional coding

function bindMenuButtons() {
    const joinBtns = [
        document.getElementById('join-lobby-btn'),
        document.getElementById('join-table-btn'),
        document.getElementById('join-btn'),
        document.getElementById('btn-join')
    ];
    joinBtns.forEach(btn => {
        if (btn) {
            btn.onclick = (e) => {
                if (e) e.preventDefault();
                window.joinLobby();
            };
        }
    });

    const createBtns = [
        document.getElementById('create-lobby-btn'),
        document.getElementById('create-table-btn'),
        document.getElementById('create-btn'),
        document.getElementById('btn-create')
    ];
    createBtns.forEach(btn => {
        if (btn) {
            btn.onclick = (e) => {
                if (e) e.preventDefault();
                window.createLobby();
            };
        }
    });
}

// Bind immediately if DOM is ready, and on DOMContentLoaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMenuButtons);
} else {
    bindMenuButtons();
}
