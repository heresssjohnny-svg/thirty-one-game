// public/js/network.js - WebSocket Engine, Event Relay & Menu Dispatcher

// -------------------------------------------------------------
// 1. STATE & ENVIRONMENT INITIALIZATION
// -------------------------------------------------------------
window.appGlobals = window.appGlobals || {
    ws: null,
    isConnected: false,
    pendingQueue: [],
    currentJoinedCode: localStorage.getItem('blitz31_active_room') || null,
    latestLobbySnapshot: null,
    lastKnownKnockedBy: null,
    lastPhaseMessage: '',
    lastGameState: ''
};

window.clientState = window.clientState || {
    username: localStorage.getItem('saved_username') || localStorage.getItem('p31_username') || 'Player1',
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

window.saveInputs = window.saveInputs || function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u) {
            const val = u.value.trim();
            if (val) {
                localStorage.setItem('saved_username', val);
                localStorage.setItem('p31_username', val);
                if (window.clientState) window.clientState.username = val;
            }
        }
        if (l) {
            localStorage.setItem('saved_lobby_name', l.value.trim());
        }
    } catch (e) {}
};

window.restoreSavedInputs = window.restoreSavedInputs || function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        const savedU = localStorage.getItem('saved_username') || localStorage.getItem('p31_username');
        const savedL = localStorage.getItem('saved_lobby_name');
        if (u && savedU) u.value = savedU;
        if (l && savedL) l.value = savedL;
        if (window.clientState && savedU) {
            window.clientState.username = savedU;
        }
    } catch (e) {}
};

// -------------------------------------------------------------
// 2. WEBSOCKET CONNECTION, KEEP-ALIVE & EVENT ROUTING
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

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'PING' }));
            }
        }, 20000);

        // 1. Authenticate with all recognized stored token keys
        const jwtToken = localStorage.getItem('auth_token') || 
                         localStorage.getItem('token') || 
                         localStorage.getItem('jwt') || 
                         localStorage.getItem('31_jwt');
        if (jwtToken) {
            ws.send(JSON.stringify({ type: 'AUTH_TOKEN', token: jwtToken }));
        }

        // 2. Auto-reclaim seat only if not currently on the auth screen
        const authScreen = document.getElementById('auth-screen');
        const isAuthScreenVisible = authScreen && authScreen.style.display !== 'none';
        const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');

        if (activeRoom && !isAuthScreenVisible) {
            window.appGlobals.currentJoinedCode = activeRoom;
            const myName = (document.getElementById('username-input')?.value || 
                            window.clientState?.username || 
                            localStorage.getItem('saved_username') || 
                            'Player1').trim();
            ws.send(JSON.stringify({
                type: 'JOIN_LOBBY',
                code: activeRoom.toUpperCase(),
                username: myName
            }));
        }

        // 3. Flush buffered messages
        while (window.appGlobals.pendingQueue.length > 0) {
            const msg = window.appGlobals.pendingQueue.shift();
            ws.send(JSON.stringify(msg));
        }

        // 4. Query current public lobbies
        window.initSocketAndSend({ type: 'GET_LOBBIES' });
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            return;
        }
        handleIncomingServerMessage(data);
    };

    ws.onclose = () => {
        window.appGlobals.isConnected = false;
        window.ws = null;
        window.appGlobals.ws = null;

        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }

        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');
                if (window.userSession || activeRoom) {
                    window.connectSocket();
                }
            }, 1200);
        }
    };

    ws.onerror = (err) => {
        console.warn('[WS] Socket event:', err);
    };
};

function handleIncomingServerMessage(data) {
    switch (data.type) {
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

        case 'PONG':
            // Keep-alive heartbeat acknowledgement
            break;

        case 'LOBBY_LIST':
            if (typeof window.renderLobbyList === 'function') {
                window.renderLobbyList(data.lobbies || []);
            } else if (typeof window.renderPublicLobbies === 'function') {
                window.renderPublicLobbies(data.lobbies || []);
            }
            break;

        case 'LOBBY_CREATED':
        case 'LOBBY_JOINED':
            if (data.code) {
                window.appGlobals.currentJoinedCode = data.code.toUpperCase();
                localStorage.setItem('blitz31_active_room', data.code.toUpperCase());
            }
            if (data.lobby) window.appGlobals.latestLobbySnapshot = data.lobby;

            const livekitHost = data.livekitHost || data.host;
            const livekitToken = data.livekitToken || data.token;
            if (livekitHost && livekitToken) {
                if (typeof window.connectLiveKit === 'function') {
                    window.connectLiveKit(livekitToken, livekitHost, data.code);
                } else if (typeof window.connectToVoiceChat === 'function') {
                    window.connectToVoiceChat(livekitHost, livekitToken);
                }
            }

            if (data.lobby && typeof window.updateUIFromLobby === 'function') {
                window.updateUIFromLobby(data.lobby);
            } else if (data.lobby && typeof window.renderLobbyState === 'function') {
                window.renderLobbyState(data.lobby);
            }
            break;

        case 'GAME_STATE_UPDATE':
        case 'LOBBY_UPDATE':
            if (data.lobby) {
                if (data.lobby.code) {
                    window.appGlobals.currentJoinedCode = data.lobby.code.toUpperCase();
                    localStorage.setItem('blitz31_active_room', data.lobby.code.toUpperCase());
                }
                window.appGlobals.latestLobbySnapshot = data.lobby;

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
            localStorage.removeItem('blitz31_active_room');

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
            if (data.message && data.message.includes('Table does not exist')) {
                window.appGlobals.currentJoinedCode = null;
                localStorage.removeItem('blitz31_active_room');
                if (typeof window.resetToMainMenu === 'function') {
                    window.resetToMainMenu();
                }
            }
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(data.message || 'Error occurred');
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

    if (window.userSession) {
        payload.userId = window.userSession.id || window.userSession.userId;
        payload.isGuest = !!window.userSession.isGuest;
    }

    const ws = window.appGlobals?.ws || window.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        window.appGlobals.pendingQueue.push(payload);
        if (typeof window.connectSocket === 'function') {
            window.connectSocket();
        }
    }
};

window.sendSocketMessage = window.initSocketAndSend;

// -------------------------------------------------------------
// 4. GLOBAL GAME & MENU ACTIONS (SAFEGUARDED WRAPPERS)
// -------------------------------------------------------------
window.createLobby = function() {
    try {
        if (typeof window.saveInputs === 'function') window.saveInputs();
        const userIn = document.getElementById('username-input');
        const nameIn = document.getElementById('lobby-name-input');
        const privIn = document.getElementById('private-lobby-checkbox');

        const username = (userIn?.value || '').trim() || 
                         (window.clientState && window.clientState.username) || 
                         localStorage.getItem('saved_username') || 
                         'Player1';
        const lobbyName = (nameIn?.value || '').trim() || `${username}'s Table`;
        const isPrivate = privIn ? privIn.checked : false;

        window.clientState = window.clientState || {};
        window.clientState.username = username;
        localStorage.setItem('saved_username', username);

        if (typeof window.initSocketAndSend === 'function') {
            window.initSocketAndSend({
                type: 'CREATE_LOBBY',
                username,
                lobbyName,
                isPrivate
            });
        }
    } catch (err) {
        console.error("Create Table Error:", err);
    }
};

window.joinLobby = function() {
    try {
        if (typeof window.saveInputs === 'function') window.saveInputs();
        const userIn = document.getElementById('username-input');
        const codeIn = document.getElementById('lobby-code-input') || document.getElementById('join-code-input');

        const username = (userIn?.value || '').trim() || 
                         (window.clientState && window.clientState.username) || 
                         localStorage.getItem('saved_username') || 
                         'Player1';
        const code = (codeIn?.value || '').trim().toUpperCase();

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

        if (typeof window.initSocketAndSend === 'function') {
            window.initSocketAndSend({
                type: 'JOIN_LOBBY',
                code,
                username
            });
        }
    } catch (err) {
        console.error("Join Table Error:", err);
    }
};

window.joinLobbyCode = function(code) {
    if (!code) return;
    if (typeof window.saveInputs === 'function') window.saveInputs();
    const userIn = document.getElementById('username-input');
    const username = (userIn?.value || '').trim() || 
                     (window.clientState && window.clientState.username) || 
                     localStorage.getItem('saved_username') || 
                     'Player1';

    const normalizedCode = code.toUpperCase();
    window.clientState = window.clientState || {};
    window.clientState.username = username;
    localStorage.setItem('saved_username', username);
    if (window.appGlobals) window.appGlobals.currentJoinedCode = normalizedCode;
    localStorage.setItem('blitz31_active_room', normalizedCode);

    window.initSocketAndSend({
        type: 'JOIN_LOBBY',
        code: normalizedCode,
        username
    });
};

window.joinLobbyDirect = window.joinLobbyCode;

window.refreshLobbies = function() {
    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend({ type: 'REFRESH_LOBBIES' });
        window.initSocketAndSend({ type: 'GET_LOBBIES' });
    }
};

window.leaveLobby = function() {
    window.appGlobals.currentJoinedCode = null;
    localStorage.removeItem('blitz31_active_room');
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

window.discardCard = function(cardIndex) {
    window.initSocketAndSend({
        type: 'DISCARD_CARD',
        cardIndex: cardIndex,
        index: cardIndex
    });
};

window.knockRound = function() {
    window.initSocketAndSend({ type: 'KNOCK' });
};

window.choosePoolCard = function(cardIndex) {
    const idx = (typeof cardIndex === 'number') ? cardIndex : parseInt(cardIndex, 10);
    if (isNaN(idx)) return;
    window.initSocketAndSend({
        type: 'CHOOSE_POOL_CARD',
        cardIndex: idx,
        index: idx,
        slotIndex: idx
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

window.submitLivesVote = function(agree) {
    window.initSocketAndSend({
        type: 'VOTE_LIVES',
        agree: !!agree
    });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
};

window.addBot = function() { window.initSocketAndSend({ type: 'ADD_BOT' }); };
window.removeBot = function() { window.initSocketAndSend({ type: 'REMOVE_BOT' }); };

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
        target,
        wagerAmt: parseInt(wagerAmt, 10) || 5
    });
    if (typeof window.toggleModal === 'function') window.toggleModal('bet-modal');
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    window.initSocketAndSend({
        type: 'PROPOSE_GLOBAL_SIDE_BET',
        pickUser,
        wagerAmt: parseInt(wagerAmt, 10) || 5
    });
    if (typeof window.toggleModal === 'function') window.toggleModal('bet-modal');
};

window.acceptGlobalProposal = function(proposalId) {
    window.initSocketAndSend({
        type: 'ACCEPT_GLOBAL_PROPOSAL',
        proposalId,
        betId: proposalId,
        id: proposalId
    });
};

window.respondGlobalBet = function(proposalId, accept) {
    window.initSocketAndSend({
        type: 'RESPOND_GLOBAL_BET',
        proposalId,
        betId: proposalId,
        id: proposalId,
        accept: !!accept,
        confirm: !!accept
    });
};

window.confirmGlobalBet = function(proposalId, acceptedUser, confirmChoice) {
    window.initSocketAndSend({
        type: 'CONFIRM_GLOBAL_BET',
        proposalId,
        betId: proposalId,
        id: proposalId,
        acceptedUser,
        confirm: !!confirmChoice,
        accept: !!confirmChoice
    });
    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'none';
};

window.respondToBet = function(betId, accept) {
    window.initSocketAndSend({
        type: 'RESPOND_BET',
        betId,
        proposalId: betId,
        id: betId,
        accept: !!accept,
        confirm: !!accept
    });
    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'none';
};

window.clearDebtCategory = function(targetUser, category) {
    window.initSocketAndSend({
        type: 'CLEAR_DEBT',
        debtor: targetUser,
        creditor: (window.clientState?.username || 'Player1'),
        ledgerType: category
    });
};

window.requestPeekAction = function(targetUsername) {
    window.initSocketAndSend({ type: 'REQUEST_PEEK', targetUsername });
};

window.respondPeekAction = function(spectatorUsername, allow) {
    window.initSocketAndSend({ type: 'RESPOND_PEEK', spectatorUsername, allow: !!allow });
};

window.stopPeekingAction = function() {
    window.initSocketAndSend({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
};

window.kickPeekerAction = function(spectatorUsername) {
    window.initSocketAndSend({ type: 'KICK_PEEKER', spectatorUsername });
};

// -------------------------------------------------------------
// 5. MOBILE VISIBILITY, LIFECYCLE RE-SYNC & ANTI-KICK
// -------------------------------------------------------------
function resyncActiveSession() {
    const authScreen = document.getElementById('auth-screen');
    if (authScreen && authScreen.style.display !== 'none') {
        return;
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
    if (!document.hidden) {
        resyncActiveSession();
    }
});

window.addEventListener('pageshow', () => {
    resyncActiveSession();
});

// Restore saved form values and establish connection on script boot
window.restoreSavedInputs();
window.connectSocket();
