// public/js/network.js
let ws = null;
let isConnected = false;
const pendingQueue = [];

function connectSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

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
            const activeUsername = document.getElementById('username-input')?.value.trim() 
                || window.clientState?.username 
                || 'Player1';
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
            if (data.code) {
                window.appGlobals.currentJoinedCode = data.code;
            }

            const token = data.livekitToken || data.token;
            const host = data.livekitHost;
            const code = data.code || window.appGlobals.currentJoinedCode;

            // Automatically join lobby-specific LiveKit voice room
            if (token) {
                if (typeof connectLiveKit === 'function') {
                    connectLiveKit(token, host, code);
                } else if (typeof connectToLiveKit === 'function') {
                    connectToLiveKit(host, token, code);
                }
            }
        } else if (data.type === 'LIVEKIT_TOKEN') {
            const host = data.livekitHost;
            const token = data.livekitToken || data.token;
            const code = window.appGlobals?.currentJoinedCode;
            if (host && token) {
                if (typeof connectLiveKit === 'function') {
                    connectLiveKit(token, host, code);
                } else if (typeof connectToLiveKit === 'function') {
                    connectToLiveKit(host, token, code);
                }
            }
        } else if (data.type === 'GAME_STATE_UPDATE' || data.type === 'LOBBY_UPDATE') {
            if (!window.appGlobals) window.appGlobals = {};
            window.appGlobals.latestLobbySnapshot = data.lobby;
            if (data.lobby && data.lobby.code) {
                window.appGlobals.currentJoinedCode = data.lobby.code;
            }
            if (typeof updateUIFromLobby === 'function') {
                updateUIFromLobby(data.lobby);
            }
        } else if (data.type === 'CHAT_MESSAGE') {
            const sender = data.user || data.username || 'Guest';
            const messageText = data.text || data.message || '';
            if (typeof appendChatMessage === 'function') {
                appendChatMessage(sender, messageText);
            }
        } else if (data.type === 'LEFT_LOBBY') {
            if (window.appGlobals) {
                window.appGlobals.currentJoinedCode = null;
                window.appGlobals.latestLobbySnapshot = null;
            }
            if (typeof disconnectLiveKit === 'function') {
                disconnectLiveKit();
            }
            if (typeof resetToMainMenu === 'function') {
                resetToMainMenu();
            }
        } else if (data.type === 'ERROR') {
            if (typeof showCenterNotification === 'function') {
                showCenterNotification(data.message);
            } else {
                alert(data.message);
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

function refreshLobbies() {
    initSocketAndSend({ type: 'GET_LOBBIES' });
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectSocket();
        } else {
            initSocketAndSend({ type: 'GET_LOBBIES' });
            if (window.appGlobals?.currentJoinedCode) {
                const activeUsername = document.getElementById('username-input')?.value.trim() 
                    || window.clientState?.username 
                    || 'Player1';
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
