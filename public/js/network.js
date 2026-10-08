// public/js/network.js - WebSocket Coordinator, Mobile Lifecycle & Network Dispatcher

// -------------------------------------------------------------
// 1. GLOBAL STATE & CONNECTION CONFIGURATION
// -------------------------------------------------------------
window.ws = null;
window.isConnectingSocket = false;
window.reconnectAttempts = 0;
window.socketHeartbeatTimer = null;

function getWebSocketUrl() {
    if (window.APP_CONFIG && window.APP_CONFIG.WS_URL) {
        return window.APP_CONFIG.WS_URL;
    }
    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    
    // In local dev without dedicated port mapping or default port 10000/3000
    if (loc.port && loc.port !== '80' && loc.port !== '443') {
        return `${protocol}//${loc.hostname}:${loc.port}`;
    }
    return `${protocol}//${loc.host}`;
}

// -------------------------------------------------------------
// 2. SOCKET INITIALIZATION & EVENT DISPATCHER
// -------------------------------------------------------------
window.initSocket = function(onOpenCallback) {
    if (window.ws && (window.ws.readyState === WebSocket.OPEN || window.ws.readyState === WebSocket.CONNECTING)) {
        if (window.ws.readyState === WebSocket.OPEN && typeof onOpenCallback === 'function') {
            onOpenCallback();
        }
        return;
    }

    window.isConnectingSocket = true;
    const wsUrl = getWebSocketUrl();

    try {
        window.ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error('[NETWORK] Failed to create WebSocket:', err);
        window.isConnectingSocket = false;
        return;
    }

    // Keep global reference in sync
    if (window.appGlobals) {
        window.appGlobals.ws = window.ws;
    }

    window.ws.onopen = function() {
        console.log('[NETWORK] Connected to server via WebSocket');
        window.isConnectingSocket = false;
        window.reconnectAttempts = 0;

        // Auto-authenticate socket if user session token exists
        const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
        if (token) {
            window.sendSocketMessage({ type: 'AUTH_TOKEN', token });
        }

        // Start heartbeat ping
        if (window.socketHeartbeatTimer) clearInterval(window.socketHeartbeatTimer);
        window.socketHeartbeatTimer = setInterval(() => {
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ type: 'PING' }));
            }
        }, 12000);

        if (typeof onOpenCallback === 'function') {
            onOpenCallback();
        }
    };

    window.ws.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            if (!data || typeof data !== 'object') return;

            // Heartbeat response
            if (data.type === 'PONG') return;

            // Notification / Error banners
            if (data.type === 'ERROR') {
                if (typeof window.showCenterNotification === 'function') {
                    window.showCenterNotification(data.message || 'An error occurred.');
                } else {
                    alert(data.message || 'An error occurred.');
                }
                return;
            }

            // Public table list refresh
            if (data.type === 'LOBBY_LIST') {
                if (typeof window.renderLobbyList === 'function') {
                    window.renderLobbyList(data.lobbies || []);
                }
                return;
            }

            // Lobby room created
            if (data.type === 'LOBBY_CREATED') {
                if (window.appGlobals) {
                    window.appGlobals.currentJoinedCode = data.code;
                    window.appGlobals.latestLobbySnapshot = data.lobby;
                }
                if (typeof window.updateUIFromLobby === 'function') {
                    window.updateUIFromLobby(data.lobby);
                }
                if (typeof window.connectToLiveKitRoom === 'function' && data.code) {
                    const myUser = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
                    window.connectToLiveKitRoom(data.code, myUser);
                }
                return;
            }

            // Lobby room joined
            if (data.type === 'LOBBY_JOINED') {
                if (window.appGlobals) {
                    window.appGlobals.currentJoinedCode = data.code;
                    window.appGlobals.latestLobbySnapshot = data.lobby;
                }
                if (typeof window.updateUIFromLobby === 'function') {
                    window.updateUIFromLobby(data.lobby);
                }
                if (typeof window.connectToLiveKitRoom === 'function' && data.code) {
                    const myUser = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
                    window.connectToLiveKitRoom(data.code, myUser);
                }
                return;
            }

            // In-game / lobby state tick
            if (data.type === 'GAME_STATE_UPDATE' || data.type === 'LOBBY_UPDATE') {
                if (window.appGlobals) {
                    window.appGlobals.latestLobbySnapshot = data.lobby;
                }
                if (typeof window.updateUIFromLobby === 'function') {
                    window.updateUIFromLobby(data.lobby);
                }
                return;
            }

            // Chat relay
            if (data.type === 'CHAT_MESSAGE') {
                if (typeof window.appendChatMessage === 'function') {
                    window.appendChatMessage(data.user || 'Player', data.text || data.message || '');
                }
                return;
            }

            // Left room
            if (data.type === 'LEFT_LOBBY') {
                if (typeof window.resetToMainMenu === 'function') {
                    window.resetToMainMenu();
                }
                return;
            }

            // Lifetime ledger balance payload
            if (data.type === 'LIFETIME_LEDGER_DATA') {
                if (typeof window.renderLifetimeLedgerData === 'function') {
                    window.renderLifetimeLedgerData(data.balances || [], data.isGuest);
                }
                return;
            }

        } catch (err) {
            console.warn('[NETWORK] Failed to parse message:', err);
        }
    };

    window.ws.onerror = function(err) {
        console.warn('[NETWORK] WebSocket error encountered:', err);
    };

    window.ws.onclose = function() {
        console.log('[NETWORK] WebSocket connection closed');
        window.isConnectingSocket = false;
        if (window.socketHeartbeatTimer) {
            clearInterval(window.socketHeartbeatTimer);
            window.socketHeartbeatTimer = null;
        }
    };
};

// -------------------------------------------------------------
// 3. SEND HELPERS
// -------------------------------------------------------------
window.sendSocketMessage = function(payload) {
    if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(payload));
        return true;
    } else {
        window.initSocket(() => {
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify(payload));
            }
        });
        return false;
    }
};

window.initSocketAndSend = window.sendSocketMessage;

// -------------------------------------------------------------
// 4. MOBILE LIFECYCLE RECOVERY (APP BACKGROUND / SLEEP / RESUME)
// -------------------------------------------------------------
function verifyAndReconnectSocket() {
    const isSocketDead = !window.ws || window.ws.readyState === WebSocket.CLOSED || window.ws.readyState === WebSocket.CLOSING;

    if (isSocketDead) {
        console.log('[NETWORK] App resumed with dormant socket. Re-establishing link...');
        window.initSocket(() => {
            // Re-join active lobby upon socket recovery so player re-attaches to their seat
            if (window.appGlobals && window.appGlobals.currentJoinedCode) {
                const activeUser = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
                window.sendSocketMessage({
                    type: 'JOIN_LOBBY',
                    code: window.appGlobals.currentJoinedCode,
                    username: activeUser
                });
            } else if (typeof window.refreshLobbies === 'function') {
                window.refreshLobbies();
            }
        });
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        // Socket is alive; request immediate snapshot to refresh turn, board, and lives
        if (window.appGlobals && window.appGlobals.currentJoinedCode) {
            const activeUser = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
            window.sendSocketMessage({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: activeUser
            });
        } else if (typeof window.refreshLobbies === 'function') {
            window.refreshLobbies();
        }
    }
}

// Browser tab visibility change
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        verifyAndReconnectSocket();
    }
});

// Window focus event
window.addEventListener('focus', () => {
    verifyAndReconnectSocket();
});

// Network online event (e.g. Wi-Fi <-> Cellular handoff)
window.addEventListener('online', () => {
    verifyAndReconnectSocket();
});

// Native Android / iOS Capacitor app resume listener
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
        if (state && state.isActive) {
            verifyAndReconnectSocket();
        }
    });
}

// -------------------------------------------------------------
// 5. BOOTSTRAP CONNECTION
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    window.initSocket(() => {
        if (typeof window.refreshLobbies === 'function') {
            window.refreshLobbies();
        }
    });
});
