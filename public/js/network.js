// public/js/network.js
let ws = null;
let isConnected = false;
const pendingQueue = [];

function connectSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        isConnected = true;
        while (pendingQueue.length > 0) {
            const msg = pendingQueue.shift();
            ws.send(JSON.stringify(msg));
        }

        initSocketAndSend({ type: 'GET_LOBBIES' });

        if (window.appGlobals?.currentJoinedCode) {
            const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;
            initSocketAndSend({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: activeUsername
            });
        }
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (data.type === 'LOBBY_LIST') {
            if (typeof renderLobbyList === 'function') {
                renderLobbyList(data.lobbies);
            }
        } else if (data.type === 'LOBBY_CREATED' || data.type === 'LOBBY_JOINED') {
            if (!window.appGlobals) window.appGlobals = {};
            window.appGlobals.currentJoinedCode = data.code;

            // Automatically join lobby-specific LiveKit voice room in muted state
            if (typeof connectLiveKit === 'function' && data.livekitToken) {
                connectLiveKit(data.livekitToken, data.livekitHost, data.code);
            }
        } else if (data.type === 'GAME_STATE_UPDATE' || data.type === 'LOBBY_UPDATE') {
            if (!window.appGlobals) window.appGlobals = {};
            window.appGlobals.latestLobbySnapshot = data.lobby;
            if (typeof updateUIFromLobby === 'function') {
                updateUIFromLobby(data.lobby);
            }
        } else if (data.type === 'CHAT_MESSAGE') {
            if (typeof appendChatMessage === 'function') {
                appendChatMessage(data.user, data.text);
            }
        } else if (data.type === 'LEFT_LOBBY') {
            if (typeof resetToMainMenu === 'function') {
                resetToMainMenu();
            }
        } else if (data.type === 'ERROR') {
            if (typeof showCenterNotification === 'function') {
                showCenterNotification(data.message);
            }
        }
    };

    ws.onclose = () => {
        isConnected = false;
        setTimeout(() => {
            if (!isConnected) connectSocket();
        }, 1500);
    };

    ws.onerror = () => {
        if (ws) ws.close();
    };
}

function initSocketAndSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        pendingQueue.push(payload);
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectSocket();
        }
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectSocket();
        } else {
            initSocketAndSend({ type: 'GET_LOBBIES' });
            if (window.appGlobals?.currentJoinedCode) {
                const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;
                initSocketAndSend({
                    type: 'JOIN_LOBBY',
                    code: window.appGlobals.currentJoinedCode,
                    username: activeUsername
                });
            }
        }
    }
});

window.addEventListener('pageshow', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) connectSocket();
});
