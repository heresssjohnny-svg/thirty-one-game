function saveInputs() {
    const u = document.getElementById('username-input');
    const l = document.getElementById('lobby-name-input');
    if (u) localStorage.setItem('saved_username', u.value);
    if (l) localStorage.setItem('saved_lobby_name', l.value);
}

window.addEventListener('DOMContentLoaded', () => {
    const savedUser = localStorage.getItem('saved_username');
    const savedLobby = localStorage.getItem('saved_lobby_name');
    if (savedUser && document.getElementById('username-input')) {
        document.getElementById('username-input').value = savedUser;
    }
    if (savedLobby && document.getElementById('lobby-name-input')) {
        document.getElementById('lobby-name-input').value = savedLobby;
    }

    connectSocket();
    refreshLobbies();
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        const ws = window.appGlobals?.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectSocket();
        } else if (window.appGlobals?.currentJoinedCode) {
            const usernameInput = document.getElementById('username-input');
            const username = usernameInput ? usernameInput.value.trim() : window.clientState.username;
            initSocketAndSend({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: username
            });
        }
    }
});

window.addEventListener('pageshow', () => {
    const ws = window.appGlobals?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectSocket();
    }
});
