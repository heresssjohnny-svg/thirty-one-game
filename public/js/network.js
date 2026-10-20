// public/js/network.js - WebSocket Client, Reconnect Lifecycle, Menu Actions & Outgoing Dispatchers

// -------------------------------------------------------------
// 1. GLOBAL STATE & INPUT PERSISTENCE
// -------------------------------------------------------------
window.appGlobals = window.appGlobals || {
    ws: null,
    pendingQueue: [],
    reconnectTimer: null,
    heartbeatInterval: null,
    currentJoinedCode: localStorage.getItem('blitz31_active_room') || null,
    latestLobbySnapshot: null
};

window.clientState = window.clientState || {
    username: localStorage.getItem('saved_username') || localStorage.getItem('p31_username') || '',
    userId: localStorage.getItem('blitz31_user_id') || null,
    isReady: false,
    playersList: [],
    spectatorsList: [],
    mainGameLedger: {},
    sideBetLedger: {},
    botBetLedger: {},
    ledgerHistory: []
};

window.saveInputs = function() {
    const userIn = document.getElementById('username-input');
    const nameIn = document.getElementById('lobby-name-input');
    const codeIn = document.getElementById('lobby-code-input') || document.getElementById('join-code-input');

    if (userIn && userIn.value.trim()) {
        const cleanUser = userIn.value.trim();
        window.clientState.username = cleanUser;
        localStorage.setItem('saved_username', cleanUser);
        localStorage.setItem('p31_username', cleanUser);
    }
    if (nameIn && nameIn.value.trim()) {
        localStorage.setItem('saved_lobby_name', nameIn.value.trim());
    }
    if (codeIn && codeIn.value.trim()) {
        localStorage.setItem('saved_lobby_code', codeIn.value.trim().toUpperCase());
    }
};

window.restoreSavedInputs = function() {
    const savedUser = localStorage.getItem('saved_username') || localStorage.getItem('p31_username') || '';
    const savedLobbyName = localStorage.getItem('saved_lobby_name') || '';
    const savedCode = localStorage.getItem('saved_lobby_code') || '';

    const userIn = document.getElementById('username-input');
    const nameIn = document.getElementById('lobby-name-input');
    const codeIn = document.getElementById('lobby-code-input') || document.getElementById('join-code-input');

    if (userIn && savedUser && !userIn.value) userIn.value = savedUser;
    if (nameIn && savedLobbyName && !nameIn.value) nameIn.value = savedLobbyName;
    if (codeIn && savedCode && !codeIn.value) codeIn.value = savedCode;

    if (savedUser) window.clientState.username = savedUser;

    // Check URL for ?room=CODE or ?code=CODE invite parameter
    try {
        const params = new URLSearchParams(window.location.search);
        const inviteCode = (params.get('room') || params.get('code') || '').trim().toUpperCase();
        if (inviteCode) {
            if (codeIn) codeIn.value = inviteCode;
            localStorage.setItem('saved_lobby_code', inviteCode);
            localStorage.setItem('blitz31_active_room', inviteCode);
            window.appGlobals.currentJoinedCode = inviteCode;
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    } catch (e) {}
};

// -------------------------------------------------------------
// 2. WEBSOCKET CONNECTION, HEARTBEAT & INCOMING ROUTER
// -------------------------------------------------------------
function getWebSocketUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
}

function startHeartbeat() {
    stopHeartbeat();
    window.appGlobals.heartbeatInterval = setInterval(() => {
        const ws = window.appGlobals.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PING' }));
        }
    }, 20000);
}

function stopHeartbeat() {
    if (window.appGlobals.heartbeatInterval) {
        clearInterval(window.appGlobals.heartbeatInterval);
        window.appGlobals.heartbeatInterval = null;
    }
}

function showGameView() {
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const authScreen = document.getElementById('auth-screen');

    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
}

function syncLobbyToClientState(lobby) {
    if (!lobby) return;
    window.appGlobals.latestLobbySnapshot = lobby;
    if (lobby.code) {
        window.appGlobals.currentJoinedCode = lobby.code;
        localStorage.setItem('blitz31_active_room', lobby.code);
    }

    window.clientState.playersList = lobby.players || [];
    window.clientState.spectatorsList = lobby.spectators || [];
    window.clientState.mainGameLedger = lobby.mainGameLedger || {};
    window.clientState.sideBetLedger = lobby.sideBetLedger || {};
    window.clientState.botBetLedger = lobby.botBetLedger || {};
    window.clientState.ledgerHistory = lobby.ledgerHistory || [];
    window.clientState.gameState = lobby.gameState || 'lobby';

    const myName = (window.clientState.username || '').toLowerCase();
    const me = (lobby.players || []).find(p => p.username && p.username.toLowerCase() === myName);
    if (me) {
        window.clientState.isReady = !!me.ready;
    }
}

window.connectSocket = function() {
    const existing = window.appGlobals.ws;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        return existing;
    }

    const wsUrl = getWebSocketUrl();
    const ws = new WebSocket(wsUrl);
    window.appGlobals.ws = ws;
    window.ws = ws;

    ws.onopen = () => {
        if (window.appGlobals.reconnectTimer) {
            clearTimeout(window.appGlobals.reconnectTimer);
            window.appGlobals.reconnectTimer = null;
        }

        startHeartbeat();

        // Authenticate socket if JWT token exists
        const token = localStorage.getItem('31_jwt') || localStorage.getItem('token') || localStorage.getItem('auth_token') || localStorage.getItem('p31_token');
        if (token) {
            ws.send(JSON.stringify({ type: 'AUTH_TOKEN', token }));
        }

        // Flush any queued outgoing actions
        while (window.appGlobals.pendingQueue.length > 0) {
            const msg = window.appGlobals.pendingQueue.shift();
            ws.send(JSON.stringify(msg));
        }

        // Request public lobbies list
        ws.send(JSON.stringify({ type: 'GET_LOBBIES' }));

        // Auto-rejoin active room (or ?room=CODE invite link) if auth screen is not blocking
        const authScreen = document.getElementById('auth-screen');
        const isAuthVisible = authScreen && authScreen.style.display !== 'none';
        const activeRoom = window.appGlobals.currentJoinedCode || localStorage.getItem('blitz31_active_room');

        if (!isAuthVisible && activeRoom) {
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
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            return;
        }

        switch (data.type) {
            case 'PONG':
                break;

            case 'AUTH_SUCCESS': {
                window.userSession = data.user;
                if (data.user && data.user.username) {
                    window.clientState.username = data.user.username;
                    localStorage.setItem('saved_username', data.user.username);
                    localStorage.setItem('p31_username', data.user.username);
                    const uIn = document.getElementById('username-input');
                    if (uIn) uIn.value = data.user.username;
                }
                if (data.user && (data.user.id || data.user.userId)) {
                    window.clientState.userId = data.user.id || data.user.userId;
                    localStorage.setItem('blitz31_user_id', window.clientState.userId);
                }
                if (typeof window.updateViewForAuth === 'function') {
                    window.updateViewForAuth(data.user);
                }
                window.initSocketAndSend({ type: 'GET_LOBBIES' });
                break;
            }

            case 'AUTH_ERROR': {
                localStorage.removeItem('p31_token');
                localStorage.removeItem('31_jwt');
                break;
            }

            case 'LOBBY_LIST':
            case 'LOBBIES_LIST':
            case 'PUBLIC_LOBBIES': {
                const list = data.lobbies || [];
                if (typeof window.renderLobbyList === 'function') {
                    window.renderLobbyList(list);
                } else if (typeof window.renderPublicLobbies === 'function') {
                    window.renderPublicLobbies(list);
                }
                break;
            }

            case 'LOBBY_CREATED':
            case 'LOBBY_JOINED': {
                const lobby = data.lobby;
                if (lobby) {
                    syncLobbyToClientState(lobby);
                    showGameView();
                    if (typeof window.updateUIFromLobby === 'function') {
                        window.updateUIFromLobby(lobby);
                    }
                }
                if (data.livekitToken && typeof window.connectToLiveKitRoom === 'function') {
                    const lkHost = data.livekitHost || lobby?.livekitHost;
                    window.connectToLiveKitRoom(lkHost, data.livekitToken, data.code || lobby?.code);
                } else if (data.livekitToken && typeof window.initVoiceChat === 'function') {
                    window.initVoiceChat(data.livekitToken, data.livekitHost || lobby?.livekitHost);
                }
                break;
            }

            case 'GAME_STATE_UPDATE':
            case 'LOBBY_UPDATE': {
                const lobby = data.lobby;
                if (lobby) {
                    syncLobbyToClientState(lobby);
                    showGameView();
                    if (typeof window.updateUIFromLobby === 'function') {
                        window.updateUIFromLobby(lobby);
                    }
                    if (typeof window.renderSessionLedger === 'function') {
                        const sessionModal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
                        if (sessionModal && sessionModal.style.display === 'flex') {
                            window.renderSessionLedger(lobby);
                        }
                    }
                }
                break;
            }

            case 'SESSION_LEDGER_DATA': {
                window.clientState.mainGameLedger = data.mainGameLedger || {};
                window.clientState.sideBetLedger = data.sideBetLedger || {};
                window.clientState.botBetLedger = data.botBetLedger || {};
                window.clientState.ledgerHistory = data.ledgerHistory || [];
                if (typeof window.renderSessionLedger === 'function') {
                    window.renderSessionLedger();
                }
                break;
            }

            case 'LIFETIME_LEDGER_DATA': {
                if (typeof window.renderLifetimeLedger === 'function') {
                    window.renderLifetimeLedger(data);
                }
                break;
            }

            case 'VC_STATUS_UPDATE': {
                if (typeof window.syncRemoteParticipantMuteState === 'function') {
                    window.syncRemoteParticipantMuteState(data.username, data.inVC, data.isMuted);
                }
                break;
            }

            case 'ADMIN_FORCE_MUTE': {
                if (typeof window.forceMuteLocalMic === 'function') {
                    window.forceMuteLocalMic(data.byHost);
                } else if (typeof window.showCenterNotification === 'function') {
                    window.showCenterNotification(`🔇 You were muted by ${data.byHost || 'the host'}.`);
                }
                break;
            }

            case 'KICKED_FROM_LOBBY': {
                window.appGlobals.currentJoinedCode = null;
                window.appGlobals.latestLobbySnapshot = null;
                localStorage.removeItem('blitz31_active_room');
                if (typeof window.disconnectLiveKit === 'function') window.disconnectLiveKit();
                if (typeof window.resetToMainMenu === 'function') window.resetToMainMenu();
                if (typeof window.showCenterNotification === 'function') {
                    window.showCenterNotification(data.message || 'You were removed from the table.');
                } else {
                    alert(data.message || 'You were removed from the table.');
                }
                break;
            }

            case 'LEFT_LOBBY': {
                window.appGlobals.currentJoinedCode = null;
                window.appGlobals.latestLobbySnapshot = null;
                localStorage.removeItem('blitz31_active_room');
                if (typeof window.resetToMainMenu === 'function') window.resetToMainMenu();
                break;
            }

            case 'NOTIFICATION': {
                if (data.message && typeof window.showCenterNotification === 'function') {
                    window.showCenterNotification(data.message);
                }
                break;
            }

            case 'ERROR': {
                if (data.message && (data.message.toLowerCase().includes('not found') || data.message.toLowerCase().includes('does not exist'))) {
                    window.appGlobals.currentJoinedCode = null;
                    localStorage.removeItem('blitz31_active_room');
                    if (typeof window.resetToMainMenu === 'function') {
                        window.resetToMainMenu();
                    }
                }
                if (typeof window.showCenterNotification === 'function') {
                    window.showCenterNotification(data.message || 'An error occurred.');
                } else if (data.message) {
                    alert(data.message);
                }
                break;
            }
        }
    };

    ws.onclose = () => {
        stopHeartbeat();
        if (!window.appGlobals.reconnectTimer) {
            window.appGlobals.reconnectTimer = setTimeout(() => {
                window.appGlobals.reconnectTimer = null;
                window.connectSocket();
            }, 2500);
        }
    };

    ws.onerror = () => {};

    return ws;
};

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
window.sendSocket = window.initSocketAndSend;

// -------------------------------------------------------------
// 4. GLOBAL GAME & MENU ACTIONS
// -------------------------------------------------------------
window.resetToMainMenu = function() {
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    localStorage.removeItem('blitz31_active_room');

    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const authScreen = document.getElementById('auth-screen');

    if (gameView) gameView.style.display = 'none';
    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';

    if (typeof window.disconnectLiveKit === 'function') {
        window.disconnectLiveKit();
    }
    if (typeof window.refreshLobbies === 'function') {
        window.refreshLobbies();
    }
};

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

        window.initSocketAndSend({
            type: 'CREATE_LOBBY',
            username,
            lobbyName,
            isPrivate
        });
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

        window.initSocketAndSend({
            type: 'JOIN_LOBBY',
            code,
            username
        });
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
    window.initSocketAndSend({ type: 'REFRESH_LOBBIES' });
    window.initSocketAndSend({ type: 'GET_LOBBIES' });
};

window.leaveLobby = function(skipConfirm = false) {
    if (!skipConfirm) {
        const lobby = window.appGlobals?.latestLobbySnapshot;
        const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').trim().toLowerCase();
        const me = (lobby?.players || []).find(p => p.username && p.username.toLowerCase() === myName);
        const isGameActive = Boolean(lobby && lobby.gameState && lobby.gameState !== 'lobby' && lobby.gameState !== 'tournamentEnd');

        if (isGameActive && me && !me.isBot) {
            const myWager = Number(me.wager) || 5;
            const confirmed = confirm(
                `⚠️ A game is in progress!\n\nIf you leave the table now, your $${myWager} wager stays in the pot and you will owe whoever wins this game.\n\nLeave anyway?`
            );
            if (!confirmed) return;
        } else {
            if (!confirm('Are you sure you want to leave the table?')) return;
        }
    }

    window.appGlobals.currentJoinedCode = null;
    localStorage.removeItem('blitz31_active_room');
    window.initSocketAndSend({ type: 'LEAVE_LOBBY' });
    if (typeof window.disconnectLiveKit === 'function') window.disconnectLiveKit();
    if (typeof window.resetToMainMenu === 'function') window.resetToMainMenu();
};

window.shareRoomInviteLink = async function(codeOverride) {
    const code = (codeOverride || window.appGlobals?.currentJoinedCode || window.appGlobals?.latestLobbySnapshot?.code || '').trim().toUpperCase();
    if (!code) return;

    const shareUrl = `${window.location.origin}/?room=${encodeURIComponent(code)}`;
    const shareData = {
        title: 'Blitz 31 Table Invite',
        text: `Join my Blitz 31 table! Room Code: ${code}`,
        url: shareUrl
    };

    try {
        if (navigator.share) {
            await navigator.share(shareData);
            return;
        }
    } catch (err) {
        if (err && err.name === 'AbortError') return;
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(shareUrl);
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification(`📋 Invite link for [${code}] copied!`);
            }
            return;
        }
    } catch (e) {}

    prompt('Copy this invite link to share with friends:', shareUrl);
};

window.sendReaction = window.sendQuickReaction = function(emoji) {
    if (!emoji) return;
    window.initSocketAndSend({
        type: 'SEND_REACTION',
        emoji: String(emoji).trim(),
        code: window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room')
    });
};

window.sitDown = function() { window.initSocketAndSend({ type: 'SIT_DOWN' }); };
window.standUp = function() { window.initSocketAndSend({ type: 'STAND_UP' }); };

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

window.knockRound = function() { window.initSocketAndSend({ type: 'KNOCK' }); };

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
        wagerAmt: Math.max(1, parseInt(wagerAmt, 10) || 5)
    });
    if (typeof window.toggleModal === 'function') window.toggleModal('bet-modal', false);
    if (typeof window.toggleModal === 'function') window.toggleModal('seat-action-modal', false);
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    window.initSocketAndSend({
        type: 'PROPOSE_GLOBAL_SIDE_BET',
        pickUser,
        wagerAmt: Math.max(1, parseInt(wagerAmt, 10) || 5)
    });
    if (typeof window.toggleModal === 'function') window.toggleModal('bet-modal', false);
};

window.acceptGlobalProposal = function(proposalId) {
    window.initSocketAndSend({
        type: 'ACCEPT_GLOBAL_PROPOSAL',
        proposalId,
        betId: proposalId,
        id: proposalId
    });
};

window.declineGlobalProposal = function(proposalId) {
    window.initSocketAndSend({
        type: 'DECLINE_GLOBAL_PROPOSAL',
        proposalId,
        betId: proposalId,
        id: proposalId,
        accept: false,
        confirm: false
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

window.adminKickPlayer = function(targetUsername) {
    if (!targetUsername) return;
    if (!confirm(`Kick ${targetUsername} from the room?`)) return;
    window.initSocketAndSend({
        type: 'ADMIN_KICK_PLAYER',
        targetUsername,
        code: window.appGlobals?.currentJoinedCode
    });
    if (typeof window.toggleModal === 'function') window.toggleModal('seat-action-modal', false);
};

window.adminMutePlayer = function(targetUsername) {
    if (!targetUsername) return;
    window.initSocketAndSend({
        type: 'ADMIN_MUTE_PLAYER',
        targetUsername,
        code: window.appGlobals?.currentJoinedCode
    });
    if (typeof window.toggleModal === 'function') window.toggleModal('seat-action-modal', false);
};

// -------------------------------------------------------------
// 5. UNIVERSAL DOM BUTTON ATTACHMENT & LEDGER BRIDGING
// -------------------------------------------------------------
function bindAllMenuAndLedgerButtons() {
    document.querySelectorAll('form').forEach(f => {
        f.onsubmit = (e) => { e.preventDefault(); };
    });

    ['create-lobby-btn', 'create-table-btn', 'create-btn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.onclick = (e) => { e.preventDefault(); window.createLobby(); };
    });

    ['join-lobby-btn', 'join-table-btn', 'join-btn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.onclick = (e) => { e.preventDefault(); window.joinLobby(); };
    });

    ['refresh-lobbies-btn', 'refresh-btn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.onclick = (e) => { e.preventDefault(); window.refreshLobbies(); };
    });

    ['ledger-btn', 'open-ledger-btn', 'session-ledger-btn', 'in-game-ledger-btn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.onclick = (e) => { e.preventDefault(); window.toggleLedgerModal(); };
    });
}

window.toggleLedgerModal = window.openLedgerModal = window.toggleSessionLedger = function(forceState) {
    const modal = document.getElementById('session-ledger-modal') || 
                  document.getElementById('ledger-modal') || 
                  document.getElementById('lifetime-ledger-modal');
    if (!modal) return;
    const isVisible = modal.style.display === 'flex' || modal.style.display === 'block';
    const nextState = typeof forceState === 'boolean' ? forceState : !isVisible;

    modal.style.display = nextState ? 'flex' : 'none';

    if (nextState) {
        window.initSocketAndSend({ type: 'GET_LIFETIME_LEDGER' });
        if (typeof window.renderSessionLedger === 'function') {
            window.renderSessionLedger();
        }
    }
};

// -------------------------------------------------------------
// 6. MOBILE VISIBILITY, LIFECYCLE RE-SYNC & ANTI-KICK
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
    if (!document.hidden) resyncActiveSession();
});

window.addEventListener('pageshow', () => {
    resyncActiveSession();
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllMenuAndLedgerButtons);
} else {
    bindAllMenuAndLedgerButtons();
}

window.restoreSavedInputs();
window.connectSocket();
