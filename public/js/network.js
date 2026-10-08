// js/network.js

// Safe input persistence fallback so index.html oninput never throws ReferenceError
window.saveInputs = function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u) localStorage.setItem('blitz31_username', u.value);
        if (l) localStorage.setItem('blitz31_lobby_name', l.value);
    } catch (e) {}
};

window.restoreSavedInputs = function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        const savedU = localStorage.getItem('blitz31_username');
        const savedL = localStorage.getItem('blitz31_lobby_name');
        if (u && savedU) u.value = savedU;
        if (l && savedL) l.value = savedL;
    } catch (e) {}
};

// Unified safe socket send method that works with app.js or standalone ws
window.sendSocketMessage = function(msgObj) {
    const socket = window.ws || (window.app && window.app.ws);
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msgObj));
    } else if (typeof window.initSocketAndSend === 'function' && window.initSocketAndSend !== window.sendSocketMessage) {
        window.initSocketAndSend(msgObj);
    }
};

// Global helper for other scripts
window.initSocketAndSend = window.sendSocketMessage;

// Side bet & peeking actions
window.requestPeekAction = function(targetUsername) {
    window.sendSocketMessage({
        type: 'REQUEST_PEEK',
        targetUsername
    });
};

window.respondPeekAction = function(spectatorUsername, allow) {
    window.sendSocketMessage({
        type: 'RESPOND_PEEK',
        spectatorUsername,
        allow
    });
};

window.stopPeekingAction = function() {
    window.sendSocketMessage({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
};

window.kickPeekerAction = function(spectatorUsername) {
    window.sendSocketMessage({
        type: 'KICK_PEEKER',
        spectatorUsername
    });
};

window.submitLivesVote = function(agree) {
    window.sendSocketMessage({
        type: 'VOTE_LIVES',
        agree
    });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
};

// Listen for network messages to auto-connect voice chat activated & muted
window.handleNetworkVoiceHook = function(data) {
    if ((data.type === 'LOBBY_CREATED' || data.type === 'LOBBY_JOINED') && data.livekitHost && data.livekitToken) {
        if (typeof window.connectToVoiceChat === 'function') {
            window.connectToVoiceChat(data.livekitHost, data.livekitToken);
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    window.restoreSavedInputs();
});
