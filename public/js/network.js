// public/js/network.js - WebSocket Engine, Event Routing & State Cache (PART 1 OF 2)

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
        const jwtToken = localStorage.getItem('31_jwt') || sessionStorage.getItem('31_jwt');
        if (jwtToken) {
            ws.send(JSON.stringify({ type: 'AUTH_TOKEN', token: jwtToken }));
        }

       // 2. Auto-reclaim seat directly from localStorage
        const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');

        if (activeRoom) {
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

        // 3. Flush any queued messages buffered while offline
        while (window.appGlobals.pendingQueue && window.appGlobals.pendingQueue.length > 0) {
            const msg = window.appGlobals.pendingQueue.shift();
            ws.send(JSON.stringify(msg));
        }

        // 4. Update lobby list browser
        if (typeof window.initSocketAndSend === 'function') {
            window.initSocketAndSend({ type: 'GET_LOBBIES' });
            window.initSocketAndSend({ type: 'REFRESH_LOBBIES' });
        }
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

        // Do NOT reset the UI here. Allow the 90-second server grace period to hold the seat.
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
}

/**
 * Routes incoming server payloads directly to client UI and audio modules
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
            if (data.code) {
                window.appGlobals.currentJoinedCode = data.code;
                localStorage.setItem('blitz31_active_room', data.code);
            }
            if (data.lobby) {
                window.appGlobals.latestLobbySnapshot = data.lobby;
            }

            // Connect LiveKit voice room isolated to this lobby
            const livekitHost = data.livekitHost || data.host;
            const livekitToken = data.livekitToken || data.token;
            if (livekitHost && livekitToken) {
                if (typeof window.connectLiveKit === 'function') {
                    window.connectLiveKit(livekitToken, livekitHost, data.code);
                } else if (typeof window.connectToVoiceChat === 'function') {
                    window.connectToVoiceChat(livekitHost, livekitToken);
                }
            }

            // Transition view to table felt
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
                    window.appGlobals.currentJoinedCode = data.lobby.code;
                    localStorage.setItem('blitz31_active_room', data.lobby.code);
                }
                window.appGlobals.latestLobbySnapshot = data.lobby;

                // Trigger 31 Blitz or Match Win celebrations (confetti & audio fanfare)
                if (typeof window.checkAndTriggerCelebrations === 'function') {
                    window.checkAndTriggerCelebrations(data.lobby);
                }

                // Maintain lobby-scoped LiveKit voice connection
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
            if (data.message && (data.message.includes('not found') || data.message.includes('Lobby') || data.message.includes('closed'))) {
                window.appGlobals.currentJoinedCode = null;
                localStorage.removeItem('blitz31_active_room');
            }
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
// public/js/network.js - Outgoing Dispatchers, Table Actions & Lifecycle (PART 2 OF 2)

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
// 4. LOBBY CREATION & NAVIGATION CONTROLS
// -------------------------------------------------------------
window.refreshLobbies = function() {
    window.initSocketAndSend({ type: 'GET_LOBBIES' });
};

window.createLobby = function() {
    window.saveInputs();
    const nameInput = document.getElementById('lobby-name-input');
    const privateCheckbox = document.getElementById('lobby-private-toggle') || document.getElementById('private-lobby-checkbox');
    const livesSelect = document.getElementById('lobby-lives-select') || document.getElementById('initial-lives-select');

    const usernameInput = document.getElementById('username-input');
    const activeUsername = usernameInput?.value.trim() 
        || localStorage.getItem('saved_username') 
        || window.clientState.username 
        || 'Player1';

    const lobbyName = nameInput ? nameInput.value.trim() : `${activeUsername}'s Table`;
    const isPrivate = privateCheckbox ? Boolean(privateCheckbox.checked) : false;
    const defaultLives = livesSelect ? (parseInt(livesSelect.value, 10) || 2) : 2;

    window.initSocketAndSend({
        type: 'CREATE_LOBBY',
        name: lobbyName || `${activeUsername}'s Table`,
        username: activeUsername,
        isPrivate: isPrivate,
        defaultLives: defaultLives
    });
};

window.joinLobby = function(code) {
    if (!code) return;
    window.saveInputs();
    const usernameInput = document.getElementById('username-input');
    const activeUsername = usernameInput?.value.trim() 
        || localStorage.getItem('saved_username') 
        || window.clientState.username 
        || 'Player1';

    window.appGlobals.currentJoinedCode = code;
    localStorage.setItem('blitz31_active_room', code);

    window.initSocketAndSend({
        type: 'JOIN_LOBBY',
        code: code.trim().toUpperCase(),
        username: activeUsername
    });
};

window.leaveLobby = function() {
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    localStorage.removeItem('blitz31_active_room');

    window.initSocketAndSend({ type: 'LEAVE_LOBBY' });

    if (typeof window.disconnectLiveKit === 'function') {
        window.disconnectLiveKit();
    }
    if (typeof window.resetToMainMenu === 'function') {
        window.resetToMainMenu();
    }
};

// -------------------------------------------------------------
// 5. TABLE SEATING & PRE-GAME CONTROLS
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

    window.initSocketAndSend({
        type: 'SET_READY',
        ready: nextState
    });
};

window.addBot = function() {
    window.initSocketAndSend({ type: 'ADD_BOT' });
};

window.removeBot = function() {
    window.initSocketAndSend({ type: 'REMOVE_BOT' });
};

window.updateWager = function() {
    const sel = document.getElementById('config-wager') || document.getElementById('lobby-wager-select');
    if (sel) {
        window.initSocketAndSend({
            type: 'UPDATE_WAGER',
            wager: parseInt(sel.value, 10) || 5
        });
    }
};

window.updateSettings = function() {
    const sel = document.getElementById('config-lives') || document.getElementById('lobby-lives-select');
    if (sel) {
        window.initSocketAndSend({
            type: 'UPDATE_SETTINGS',
            lives: parseInt(sel.value, 10) || 2
        });
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
window.drawFromDeck = function() {
    window.initSocketAndSend({ type: 'DRAW_DECK' });
};

window.drawFromDiscard = function() {
    window.initSocketAndSend({ type: 'DRAW_DISCARD' });
};

window.discardCard = function(cardIndex) {
    window.initSocketAndSend({
        type: 'DISCARD_CARD',
        cardIndex: parseInt(cardIndex, 10) || 0
    });
};

window.knockGame = function() {
    window.initSocketAndSend({ type: 'KNOCK' });
};

window.selectPoolCard = function(poolIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    window.initSocketAndSend({
        type: 'CHOOSE_POOL_CARD',
        poolIndex: parseInt(poolIndex, 10)
    });
};

window.readyNextHand = function() {
    const overlay = document.getElementById('next-hand-overlay');
    if (overlay) overlay.style.display = 'none';
    window.initSocketAndSend({ type: 'READY_NEXT_HAND' });
};

// -------------------------------------------------------------
// 7. IN-GAME CHAT & PEEKER ACTIONS
// -------------------------------------------------------------
window.sendChatMessage = function() {
    const input = document.getElementById('chat-input') || document.getElementById('chat-text-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;

    window.initSocketAndSend({
        type: 'CHAT_MESSAGE',
        message: msg
    });

    input.value = '';
    input.focus();
};

window.requestPeek = function(targetPlayer) {
    if (!targetPlayer) return;
    window.initSocketAndSend({
        type: 'REQUEST_PEEK',
        target: targetPlayer
    });
};

window.respondPeek = function(requesterPlayer, allow) {
    if (!requesterPlayer) return;
    window.initSocketAndSend({
        type: 'RESPOND_PEEK',
        requester: requesterPlayer,
        allow: Boolean(allow)
    });
};

// -------------------------------------------------------------
// 8. SIDE BETS & TAB SWITCHING
// -------------------------------------------------------------
window.switchBetsTab = function(tab) {
    const tabActive = document.getElementById('bets-tab-active');
    const tabPropose = document.getElementById('bets-tab-propose');
    const listActive = document.getElementById('active-bets-list');
    const formPropose = document.getElementById('propose-bet-fields');

    if (tab === 'active') {
        if (tabActive) tabActive.classList.add('active');
        if (tabPropose) tabPropose.classList.remove('active');
        if (listActive) listActive.style.display = 'block';
        if (formPropose) formPropose.style.display = 'none';
    } else {
        if (tabActive) tabActive.classList.remove('active');
        if (tabPropose) tabPropose.classList.add('active');
        if (listActive) listActive.style.display = 'none';
        if (formPropose) formPropose.style.display = 'block';
    }
};

window.submitSideBetProposal = function() {
    const targetSelect = document.getElementById('bet-target-player');
    const wagerInput = document.getElementById('bet-wager-amount');
    const typeSelect = document.getElementById('bet-type-select');

    const target = targetSelect ? targetSelect.value : null;
    const wagerAmt = wagerInput ? (parseInt(wagerInput.value, 10) || 5) : 5;
    const betType = typeSelect ? typeSelect.value : 'first_to_lose';

    if (!target) {
        alert("Please select a target player.");
        return;
    }

    if (betType === 'first_to_lose') {
        window.initSocketAndSend({
            type: 'PROPOSE_ELIMINATION_BET',
            target: target,
            wagerAmt: wagerAmt
        });
    } else {
        window.initSocketAndSend({
            type: 'PROPOSE_GLOBAL_SIDE_BET',
            pickUser: target,
            wagerAmt: wagerAmt,
            betType: 'win',
            condition: `Backing ${target} to win the game`
        });
    }

    if (typeof window.closeActiveBetsModal === 'function') {
        window.closeActiveBetsModal();
    }
};

window.respondBet = function(betId, accept) {
    window.initSocketAndSend({
        type: 'RESPOND_BET',
        betId: betId,
        accept: Boolean(accept)
    });
};

window.acceptGlobalProposal = function(proposalId) {
    window.initSocketAndSend({
        type: 'ACCEPT_GLOBAL_PROPOSAL',
        proposalId: proposalId
    });
};

window.confirmGlobalBet = function(proposalId, confirmState, acceptedUser) {
    window.initSocketAndSend({
        type: 'CONFIRM_GLOBAL_BET',
        proposalId: proposalId,
        confirm: Boolean(confirmState),
        acceptedUser: acceptedUser
    });
};

// -------------------------------------------------------------
// 9. BACKGROUND RESILIENCE & WAKE RECOVERY
// -------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        const activeRoom = localStorage.getItem('blitz31_active_room') || window.appGlobals.currentJoinedCode;
        const ws = window.appGlobals.ws;
        if ((!ws || ws.readyState !== WebSocket.OPEN) && activeRoom) {
            window.connectSocket();
        }
    }
});

window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        const activeRoom = localStorage.getItem('blitz31_active_room') || window.appGlobals.currentJoinedCode;
        if (activeRoom) {
            window.connectSocket();
        }
    }
});

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
    // Check local storage for an abandoned session
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
