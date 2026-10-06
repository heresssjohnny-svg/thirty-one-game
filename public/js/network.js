// public/js/network.js
function connectSocket() {
    if (window.appGlobals.ws && (window.appGlobals.ws.readyState === WebSocket.OPEN || window.appGlobals.ws.readyState === WebSocket.CONNECTING)) return;
    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    window.appGlobals.ws = new WebSocket(protocol + location.host);

    window.appGlobals.ws.onopen = () => {
        window.appGlobals.isConnected = true;
        while (window.appGlobals.pendingQueue.length > 0) {
            const msg = window.appGlobals.pendingQueue.shift();
            window.appGlobals.ws.send(JSON.stringify(msg));
        }
        if (window.appGlobals.currentJoinedCode) {
            initSocketAndSend({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: document.getElementById('username-input').value.trim() || window.clientState.username
            });
        }
    };

    window.appGlobals.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'LOBBY_LIST') {
            renderLobbyList(data.lobbies);
        } else if (data.type === 'LOBBY_JOINED' || data.type === 'GAME_STATE_UPDATE' || data.type === 'LOBBY_UPDATE') {
            if (data.lobby && data.lobby.code) window.appGlobals.currentJoinedCode = data.lobby.code;
            window.appGlobals.latestLobbySnapshot = data.lobby;
            updateUIFromLobby(data.lobby);

            const host = data.livekitHost || window.appGlobals.latestLiveKitHost;
            const token = data.livekitToken || data.token || window.appGlobals.latestLiveKitToken;
            if (host && token) {
                window.appGlobals.latestLiveKitHost = host;
                window.appGlobals.latestLiveKitToken = token;
                if (!window.appGlobals.isLiveKitConnected && !window.appGlobals.isConnectingVoice) {
                    connectToLiveKit(host, token);
                }
            }
        } else if (data.type === 'LIVEKIT_TOKEN') {
            const host = data.livekitHost || window.appGlobals.latestLiveKitHost;
            const token = data.livekitToken || data.token;
            if (host && token) {
                window.appGlobals.latestLiveKitHost = host;
                window.appGlobals.latestLiveKitToken = token;
                connectToLiveKit(host, token);
            }
        } else if (data.type === 'CHAT_MESSAGE') {
            appendChatMessage(data.username, data.message);
        } else if (data.type === 'LEFT_LOBBY') {
            window.appGlobals.currentJoinedCode = null;
            window.appGlobals.latestLobbySnapshot = null;
            disconnectLiveKit();
            resetToMainMenu();
        } else if (data.type === 'ERROR') {
            alert(data.message);
        }
    };

    window.appGlobals.ws.onclose = () => {
        window.appGlobals.isConnected = false;
        setTimeout(() => { connectSocket(); }, 2500);
    };
}

function initSocketAndSend(payload) {
    saveInputs();
    window.clientState.username = document.getElementById('username-input').value.trim() || 'Player1';
    
    if (payload.type === 'CREATE_LOBBY' || payload.type === 'JOIN_LOBBY') {
        if (payload.code) window.appGlobals.currentJoinedCode = payload.code;
    }

    if (window.appGlobals.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    } else {
        window.appGlobals.pendingQueue.push(payload);
        connectSocket();
    }
}

function refreshLobbies() { initSocketAndSend({ type: 'REFRESH_LOBBIES' }); }
function createLobby() {
    const username = document.getElementById('username-input').value.trim() || 'Player1';
    const lobbyName = document.getElementById('lobby-name-input').value.trim() || 'My Table';
    const isPrivate = document.getElementById('private-lobby-checkbox').checked;
    initSocketAndSend({ type: 'CREATE_LOBBY', username, lobbyName, isPrivate });
}
function joinLobby() {
    const code = document.getElementById('lobby-code-input').value.toUpperCase();
    if (code) joinLobbyCode(code);
}
function joinLobbyCode(code) {
    window.appGlobals.currentJoinedCode = code;
    initSocketAndSend({ type: 'JOIN_LOBBY', code, username: document.getElementById('username-input').value.trim() || 'Player1' });
}
function standUp() { initSocketAndSend({ type: 'STAND_UP' }); }
function sitDown() { initSocketAndSend({ type: 'SIT_DOWN' }); }
function updateWager() {
    const wager = document.getElementById('config-wager').value;
    initSocketAndSend({ type: 'UPDATE_WAGER', wager });
}
function updateSettings() {
    const lives = document.getElementById('config-lives').value;
    initSocketAndSend({ type: 'UPDATE_SETTINGS', lives });
}
function toggleReady() {
    window.clientState.isReady = !window.clientState.isReady;
    document.getElementById('ready-btn').innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    initSocketAndSend({ type: 'SET_READY', ready: window.clientState.isReady });
}
function clickNextHand() {
    const btn = document.getElementById('next-hand-btn');
    btn.innerText = 'Waiting...';
    btn.disabled = true;
    initSocketAndSend({ type: 'NEXT_HAND_READY' });
}
function proposeEndGame() {
    if (confirm("Propose ending the game?")) {
        initSocketAndSend({ type: 'END_GAME_PROPOSAL' });
    }
}
function drawCard(type) { initSocketAndSend({ type: type === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' }); }
function discardCard(cardIndex) { initSocketAndSend({ type: 'DISCARD_CARD', cardIndex }); }
function knockRound() {
    initSocketAndSend({ type: 'KNOCK' });
    playSound('knock');
}
function leaveLobby() {
    disconnectLiveKit();
    initSocketAndSend({ type: 'LEAVE_LOBBY' });
}
function choosePoolCard(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    initSocketAndSend({ type: 'CHOOSE_POOL_CARD', cardIndex });
}
function addBot() { initSocketAndSend({ type: 'ADD_BOT' }); }
function removeBot() { initSocketAndSend({ type: 'REMOVE_BOT' }); }

