// js/network.js

let ws = null;
let reconnectTimer = null;

window.clientState = window.clientState || {
    myUsername: '',
    currentLobbyCode: null,
    currentLobbyData: null,
    isSpectator: false,
    selectedDiscardIndex: null
};

window.saveInputs = function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u) localStorage.setItem('blitz31_username', u.value);
        if (l) localStorage.setItem('blitz31_lobby_name', l.value);
    } catch (e) {}
};

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
            const oldHandler = ws.onopen;
            ws.onopen = (e) => {
                if (typeof oldHandler === 'function') oldHandler(e);
                onOpenCallback();
            };
        }
        return;
    }

    const wsUrl = getWebSocketUrl();
    console.log('[WS] Connecting to:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('[WS] Connected successfully');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

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
            console.error('[WS] Parse error:', err);
            return;
        }
        handleServerMessage(data);
    };

    ws.onclose = () => {
        console.warn('[WS] Closed. Retrying in 2s...');
        ws = null;
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                initWebSocket();
            }, 2000);
        }
    };

    ws.onerror = (err) => {
        console.error('[WS] Error:', err);
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

window.initSocketAndSend = function(msgObj) {
    sendSocketMessage(msgObj);
};

// Fallback screen transition if ui.js has not loaded or has errors
function fallbackShowGameScreen(code) {
    const menu = document.getElementById('main-menu');
    const game = document.getElementById('game-view');
    const inGameBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const title = document.getElementById('room-title-display');

    if (menu) menu.style.display = 'none';
    if (game) game.style.display = 'flex';
    if (inGameBtns) inGameBtns.style.display = 'flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (title) title.innerText = `Table: ${code}`;
}

function handleServerMessage(data) {
    console.log('[WS] Received:', data.type);
    switch (data.type) {
        case 'LOBBY_LIST':
            if (typeof window.renderPublicLobbies === 'function') {
                window.renderPublicLobbies(data.lobbies || []);
            }
            break;

        case 'LOBBY_CREATED':
        case 'LOBBY_JOINED':
            window.clientState.currentLobbyCode = data.code;
            
            if (typeof window.showGameScreen === 'function') {
                window.showGameScreen(data.code);
            } else {
                fallbackShowGameScreen(data.code);
            }

            // Auto-connect voice chat activated & muted
            if (data.livekitHost && data.livekitToken && typeof window.connectToVoiceChat === 'function') {
                window.connectToVoiceChat(data.livekitHost, data.livekitToken);
            }
            break;

        case 'LOBBY_UPDATE':
            window.clientState.currentLobbyData = data.lobby;
            if (typeof window.renderLobbyState === 'function') {
                window.renderLobbyState(data.lobby);
            }
            break;

        case 'LEFT_LOBBY':
            window.clientState.currentLobbyCode = null;
            window.clientState.currentLobbyData = null;
            if (typeof window.disconnectLiveKit === 'function') {
                window.disconnectLiveKit();
            }
            if (typeof window.returnToMainMenu === 'function') {
                window.returnToMainMenu();
            } else {
                window.location.reload();
            }
            break;

        case 'CHAT_MESSAGE':
            if (typeof window.appendChatMessage === 'function') {
                window.appendChatMessage(data.user, data.text);
            }
            break;

        case 'ERROR':
            alert(data.message || 'Error occurred');
            break;

        default:
            break;
    }
}

// Window-assigned triggers so inline HTML buttons never fail
window.createLobby = function() {
    const userIn = document.getElementById('username-input');
    const nameIn = document.getElementById('lobby-name-input');
    const privIn = document.getElementById('private-lobby-checkbox');

    const username = (userIn && userIn.value ? userIn.value : '').trim() || 'Player1';
    const lobbyName = (nameIn && nameIn.value ? nameIn.value : '').trim() || `${username}'s Table`;
    const isPrivate = privIn ? privIn.checked : false;

    window.clientState.myUsername = username;
    window.saveInputs();

    console.log('[Action] Creating lobby for', username);
    sendSocketMessage({
        type: 'CREATE_LOBBY',
        username,
        lobbyName,
        isPrivate
    });
};

window.joinLobby = function() {
    const userIn = document.getElementById('username-input');
    const codeIn = document.getElementById('lobby-code-input');

    const username = (userIn && userIn.value ? userIn.value : '').trim() || 'Player';
    const code = (codeIn && codeIn.value ? codeIn.value : '').trim().toUpperCase();

    if (!code) {
        alert('Please enter a table code.');
        return;
    }

    window.clientState.myUsername = username;
    window.saveInputs();

    sendSocketMessage({
        type: 'JOIN_LOBBY',
        code,
        username
    });
};

window.joinLobbyDirect = function(code) {
    const userIn = document.getElementById('username-input');
    const username = (userIn && userIn.value ? userIn.value : '').trim() || 'Player';

    window.clientState.myUsername = username;
    window.saveInputs();

    sendSocketMessage({
        type: 'JOIN_LOBBY',
        code: code.trim().toUpperCase(),
        username
    });
};

window.refreshLobbies = function() {
    sendSocketMessage({ type: 'GET_LOBBIES' });
};

window.leaveLobby = function() {
    sendSocketMessage({ type: 'LEAVE_LOBBY' });
};

window.sitDown = function() {
    sendSocketMessage({ type: 'SIT_DOWN' });
};

window.standUp = function() {
    sendSocketMessage({ type: 'STAND_UP' });
};

window.toggleReady = function() {
    const currentLobby = window.clientState.currentLobbyData;
    if (!currentLobby) return;
    const me = currentLobby.players.find(
        p => p.username.toLowerCase() === window.clientState.myUsername.toLowerCase()
    );
    const nextReadyState = me ? !me.ready : true;
    sendSocketMessage({ type: 'SET_READY', ready: nextReadyState });
};

window.clickNextHand = function() {
    sendSocketMessage({ type: 'NEXT_HAND' });
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Ready (Waiting...)';
    }
};

window.choosePoolCard = function(index) {
    sendSocketMessage({ type: 'CHOOSE_POOL_CARD', cardIndex: index });
};

window.drawFromDeck = function() {
    sendSocketMessage({ type: 'DRAW_DECK' });
};

window.drawFromDiscard = function() {
    sendSocketMessage({ type: 'DRAW_DISCARD' });
};

window.discardCard = function(cardIndex) {
    sendSocketMessage({ type: 'DISCARD_CARD', cardIndex });
};

window.knockRound = function() {
    sendSocketMessage({ type: 'KNOCK' });
};

window.updateSettings = function() {
    const livesSelect = document.getElementById('config-lives');
    if (!livesSelect) return;
    sendSocketMessage({ type: 'UPDATE_SETTINGS', lives: parseInt(livesSelect.value, 10) });
};

window.updateWager = function() {
    const wagerSelect = document.getElementById('config-wager');
    if (!wagerSelect) return;
    sendSocketMessage({ type: 'UPDATE_WAGER', wager: parseInt(wagerSelect.value, 10) });
};

window.addBot = function() {
    sendSocketMessage({ type: 'ADD_BOT' });
};

window.removeBot = function() {
    sendSocketMessage({ type: 'REMOVE_BOT' });
};

window.proposeEndGame = function() {
    sendSocketMessage({ type: 'END_GAME_PROPOSAL' });
};

window.submitLivesVote = function(agree) {
    sendSocketMessage({ type: 'VOTE_LIVES', agree });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
};

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    sendSocketMessage({ type: 'CHAT_MESSAGE', message: text });
    input.value = '';
};

window.requestPeekAction = function(targetUsername) {
    sendSocketMessage({ type: 'REQUEST_PEEK', targetUsername });
};

window.respondPeekAction = function(spectatorUsername, allow) {
    sendSocketMessage({ type: 'RESPOND_PEEK', spectatorUsername, allow });
};

window.stopPeekingAction = function() {
    sendSocketMessage({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
};

window.kickPeekerAction = function(spectatorUsername) {
    sendSocketMessage({ type: 'KICK_PEEKER', spectatorUsername });
};

// Immediate start
restoreSavedInputs();
initWebSocket();
