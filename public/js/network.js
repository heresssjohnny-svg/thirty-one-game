// js/network.js

let ws = null;
let reconnectTimer = null;
let isReconnecting = false;

window.clientState = window.clientState || {
    myUsername: '',
    currentLobbyCode: null,
    currentLobbyData: null,
    isSpectator: false,
    selectedDiscardIndex: null
};

// Form persistence helper required by index.html oninput
function saveInputs() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u) localStorage.setItem('blitz31_username', u.value);
        if (l) localStorage.setItem('blitz31_lobby_name', l.value);
    } catch (e) {
        // Storage access handled gracefully
    }
}

function restoreSavedInputs() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        const savedU = localStorage.getItem('blitz31_username');
        const savedL = localStorage.getItem('blitz31_lobby_name');
        if (u && savedU) u.value = savedU;
        if (l && savedL) l.value = savedL;
    } catch (e) {}
}

function getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
}

function initWebSocket(onOpenCallback) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (onOpenCallback) onOpenCallback();
        return;
    }

    if (ws && ws.readyState === WebSocket.CONNECTING) {
        if (onOpenCallback) {
            const prevOpen = ws.onopen;
            ws.onopen = (e) => {
                if (prevOpen) prevOpen(e);
                onOpenCallback();
            };
        }
        return;
    }

    const wsUrl = getWebSocketUrl();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('[WS] Connected to Blitz 31 server');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        isReconnecting = false;

        // Auto-rejoin if connection dropped mid-game
        if (window.clientState.currentLobbyCode && window.clientState.myUsername) {
            sendSocketMessage({
                type: 'JOIN_LOBBY',
                code: window.clientState.currentLobbyCode,
                username: window.clientState.myUsername
            });
        }

        if (onOpenCallback) onOpenCallback();
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            console.error('[WS] Failed to parse message JSON:', err);
            return;
        }

        handleServerMessage(data);
    };

    ws.onclose = () => {
        console.warn('[WS] Connection closed. Attempting reconnect in 2 seconds...');
        ws = null;
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                isReconnecting = true;
                initWebSocket();
            }, 2000);
        }
    };

    ws.onerror = (err) => {
        console.error('[WS] Error encountered:', err);
    };
}

function sendSocketMessage(msgObj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msgObj));
    } else {
        initWebSocket(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msgObj));
            }
        });
    }
}

function initSocketAndSend(msgObj) {
    sendSocketMessage(msgObj);
}

function handleServerMessage(data) {
    switch (data.type) {
        case 'LOBBY_LIST':
            if (typeof renderPublicLobbies === 'function') {
                renderPublicLobbies(data.lobbies || []);
            }
            break;

        case 'LOBBY_CREATED':
        case 'LOBBY_JOINED':
            window.clientState.currentLobbyCode = data.code;
            
            if (typeof showGameScreen === 'function') {
                showGameScreen(data.code);
            }

            // Auto-connect voice chat activated & muted
            if (data.livekitHost && data.livekitToken && typeof connectToVoiceChat === 'function') {
                connectToVoiceChat(data.livekitHost, data.livekitToken);
            }
            break;

        case 'LOBBY_UPDATE':
            window.clientState.currentLobbyData = data.lobby;
            if (typeof renderLobbyState === 'function') {
                renderLobbyState(data.lobby);
            }
            break;

        case 'LEFT_LOBBY':
            window.clientState.currentLobbyCode = null;
            window.clientState.currentLobbyData = null;
            
            if (typeof disconnectLiveKit === 'function') {
                disconnectLiveKit();
            }
            if (typeof returnToMainMenu === 'function') {
                returnToMainMenu();
            }
            break;

        case 'CHAT_MESSAGE':
            if (typeof appendChatMessage === 'function') {
                appendChatMessage(data.user, data.text);
            }
            break;

        case 'ERROR':
            if (typeof showCenterNotification === 'function') {
                showCenterNotification(data.message || 'An error occurred.');
            }
            break;

        default:
            break;
    }
}

// UI Triggers for lobby actions
function createLobby() {
    const userIn = document.getElementById('username-input');
    const nameIn = document.getElementById('lobby-name-input');
    const privIn = document.getElementById('private-lobby-checkbox');

    const username = (userIn ? userIn.value : '').trim() || 'Player1';
    const lobbyName = (nameIn ? nameIn.value : '').trim() || `${username}'s Table`;
    const isPrivate = privIn ? privIn.checked : false;

    window.clientState.myUsername = username;
    saveInputs();

    sendSocketMessage({
        type: 'CREATE_LOBBY',
        username,
        lobbyName,
        isPrivate
    });
}

function joinLobby() {
    const userIn = document.getElementById('username-input');
    const codeIn = document.getElementById('lobby-code-input');

    const username = (userIn ? userIn.value : '').trim() || 'Player';
    const code = (codeIn ? codeIn.value : '').trim().toUpperCase();

    if (!code) {
        if (typeof showCenterNotification === 'function') {
            showCenterNotification('Please enter a table code.');
        }
        return;
    }

    window.clientState.myUsername = username;
    saveInputs();

    sendSocketMessage({
        type: 'JOIN_LOBBY',
        code,
        username
    });
}

function joinLobbyDirect(code) {
    const userIn = document.getElementById('username-input');
    const username = (userIn ? userIn.value : '').trim() || 'Player';

    window.clientState.myUsername = username;
    saveInputs();

    sendSocketMessage({
        type: 'JOIN_LOBBY',
        code: code.trim().toUpperCase(),
        username
    });
}

function refreshLobbies() {
    sendSocketMessage({ type: 'GET_LOBBIES' });
}

function leaveLobby() {
    sendSocketMessage({ type: 'LEAVE_LOBBY' });
}

function sitDown() {
    sendSocketMessage({ type: 'SIT_DOWN' });
}

function standUp() {
    sendSocketMessage({ type: 'STAND_UP' });
}

function toggleReady() {
    const currentLobby = window.clientState.currentLobbyData;
    if (!currentLobby) return;

    const me = currentLobby.players.find(
        p => p.username.toLowerCase() === window.clientState.myUsername.toLowerCase()
    );

    const nextReadyState = me ? !me.ready : true;
    sendSocketMessage({
        type: 'SET_READY',
        ready: nextReadyState
    });
}

function clickNextHand() {
    sendSocketMessage({ type: 'NEXT_HAND' });
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Ready (Waiting...)';
    }
}

function choosePoolCard(index) {
    sendSocketMessage({
        type: 'CHOOSE_POOL_CARD',
        cardIndex: index
    });
}

function drawFromDeck() {
    sendSocketMessage({ type: 'DRAW_DECK' });
}

function drawFromDiscard() {
    sendSocketMessage({ type: 'DRAW_DISCARD' });
}

function discardCard(cardIndex) {
    sendSocketMessage({
        type: 'DISCARD_CARD',
        cardIndex
    });
}

function knockRound() {
    sendSocketMessage({ type: 'KNOCK' });
}

function updateSettings() {
    const livesSelect = document.getElementById('config-lives');
    if (!livesSelect) return;

    sendSocketMessage({
        type: 'UPDATE_SETTINGS',
        lives: parseInt(livesSelect.value, 10)
    });
}

function updateWager() {
    const wagerSelect = document.getElementById('config-wager');
    if (!wagerSelect) return;

    sendSocketMessage({
        type: 'UPDATE_WAGER',
        wager: parseInt(wagerSelect.value, 10)
    });
}

function addBot() {
    sendSocketMessage({ type: 'ADD_BOT' });
}

function removeBot() {
    sendSocketMessage({ type: 'REMOVE_BOT' });
}

function proposeEndGame() {
    sendSocketMessage({ type: 'END_GAME_PROPOSAL' });
}

function submitLivesVote(agree) {
    sendSocketMessage({
        type: 'VOTE_LIVES',
        agree
    });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    sendSocketMessage({
        type: 'CHAT_MESSAGE',
        message: text
    });

    input.value = '';
}

function requestPeekAction(targetUsername) {
    sendSocketMessage({
        type: 'REQUEST_PEEK',
        targetUsername
    });
}

function respondPeekAction(spectatorUsername, allow) {
    sendSocketMessage({
        type: 'RESPOND_PEEK',
        spectatorUsername,
        allow
    });
}

function stopPeekingAction() {
    sendSocketMessage({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
}

function kickPeekerAction(spectatorUsername) {
    sendSocketMessage({
        type: 'KICK_PEEKER',
        spectatorUsername
    });
}

// Lifecycle Init
document.addEventListener('DOMContentLoaded', () => {
    restoreSavedInputs();
    initWebSocket();
});
