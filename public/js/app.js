// public/js/app.js
function saveInputs() {
    localStorage.setItem('saved_username', document.getElementById('username-input').value);
    localStorage.setItem('saved_lobby_name', document.getElementById('lobby-name-input').value);
}

window.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('saved_username')) {
        document.getElementById('username-input').value = localStorage.getItem('saved_username');
    }
    if (localStorage.getItem('saved_lobby_name')) {
        document.getElementById('lobby-name-input').value = localStorage.getItem('saved_lobby_name');
    }
    connectSocket();
    refreshLobbies();
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        if (!window.appGlobals.ws || window.appGlobals.ws.readyState !== WebSocket.OPEN) {
            connectSocket();
        } else if (window.appGlobals.currentJoinedCode) {
            initSocketAndSend({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: document.getElementById('username-input').value.trim() || window.clientState.username
            });
        }
    }
});

window.addEventListener('pageshow', () => {
    if (!window.appGlobals.ws || window.appGlobals.ws.readyState !== WebSocket.OPEN) {
        connectSocket();
    }
});
