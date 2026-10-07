// public/js/network.js

function connectSocket() {
    if (window.appGlobals.ws && (window.appGlobals.ws.readyState === WebSocket.OPEN || window.appGlobals.ws.readyState === WebSocket.CONNECTING)) {
        return;
    }
    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(protocol + location.host);
    window.appGlobals.ws = ws;

    ws.onopen = () => {
        window.appGlobals.isConnected = true;
        if (window.appGlobals.currentJoinedCode) {
            ws.send(JSON.stringify({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: window.clientState.username
            }));
        }

        while (window.appGlobals.pendingQueue.length > 0) {
            let msg = window.appGlobals.pendingQueue.shift();
            ws.send(JSON.stringify(msg));
        }
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        switch (data.type) {
            case 'LOBBY_LIST':
                if (typeof renderLobbyList === 'function') renderLobbyList(data.lobbies);
                break;
            case 'PLAY_SOUND':
                if (typeof playSound === 'function') playSound(data.sound);
                break;
            case 'LIVEKIT_TOKEN':
                if (typeof connectToLiveKit === 'function' && data.livekitHost && data.livekitToken) {
                    connectToLiveKit(data.livekitHost, data.livekitToken);
                }
                break;
            case 'LOBBY_JOINED':
            case 'GAME_STATE_UPDATE':
                if (data.lobby && data.lobby.code) window.appGlobals.currentJoinedCode = data.lobby.code;
                window.appGlobals.latestLobbySnapshot = data.lobby;
                if (typeof updateUIFromLobby === 'function') updateUIFromLobby(data.lobby);
                if (typeof connectToLiveKit === 'function' && data.livekitHost && data.livekitToken) {
                    connectToLiveKit(data.livekitHost, data.livekitToken);
                }
                break;
            case 'CHAT_MESSAGE':
                if (typeof appendChatMessage === 'function') appendChatMessage(data.username, data.message);
                break;
            case 'LEFT_LOBBY':
                if (typeof resetToMainMenu === 'function') resetToMainMenu();
                break;
            case 'ERROR':
                alert(data.message);
                break;
        }
    };

    ws.onclose = () => {
        window.appGlobals.isConnected = false;
        setTimeout(() => connectSocket(), 3000);
    };
}

function initSocketAndSend(payload) {
    if (typeof saveInputs === 'function') saveInputs();
    const usernameInput = document.getElementById('username-input');
    if (usernameInput) {
        window.clientState.username = usernameInput.value.trim() || 'Player1';
    }

    if (payload.type === 'CREATE_LOBBY' || payload.type === 'JOIN_LOBBY') {
        if (payload.code) window.appGlobals.currentJoinedCode = payload.code;
    }

    const ws = window.appGlobals.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        window.appGlobals.pendingQueue.push(payload);
        connectSocket();
    }
}

function refreshLobbies() {
    initSocketAndSend({ type: 'REFRESH_LOBBIES' });
}

function createLobby() {
    const username = document.getElementById('username-input').value.trim() || 'Player1';
    const lobbyName = document.getElementById('lobby-name-input').value.trim() || 'My Table';
    const isPrivate = document.getElementById('private-lobby-checkbox').checked;
    initSocketAndSend({ type: 'CREATE_LOBBY', username, lobbyName, isPrivate });
}

function joinLobby() {
    const code = document.getElementById('lobby-code-input').value.trim().toUpperCase();
    if (code) joinLobbyCode(code);
}

function joinLobbyCode(code) {
    window.appGlobals.currentJoinedCode = code;
    const username = document.getElementById('username-input').value.trim() || 'Player1';
    initSocketAndSend({ type: 'JOIN_LOBBY', code, username });
}

function leaveLobby() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    initSocketAndSend({ type: 'LEAVE_LOBBY' });
}

function standUp() { initSocketAndSend({ type: 'STAND_UP' }); }
function sitDown() { initSocketAndSend({ type: 'SIT_DOWN' }); }
function updateWager() { initSocketAndSend({ type: 'UPDATE_WAGER', wager: document.getElementById('config-wager').value }); }
function updateSettings() { initSocketAndSend({ type: 'UPDATE_SETTINGS', lives: document.getElementById('config-lives').value }); }
function addBot() { initSocketAndSend({ type: 'ADD_BOT' }); }
function removeBot() { initSocketAndSend({ type: 'REMOVE_BOT' }); }

function toggleReady() {
    window.clientState.isReady = !window.clientState.isReady;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    initSocketAndSend({ type: 'SET_READY', ready: window.clientState.isReady });
}

function clickNextHand() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    initSocketAndSend({ type: 'NEXT_HAND' });
}

function proposeEndGame() {
    if (confirm("Propose ending the game?")) {
        initSocketAndSend({ type: 'END_GAME_PROPOSAL' });
    }
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (text) {
        initSocketAndSend({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
    }
}

function drawCard(type) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    initSocketAndSend({ type: type === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
}

function discardCard(cardIndex) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(30);
    initSocketAndSend({ type: 'DISCARD_CARD', cardIndex });
}

function choosePoolCard(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    initSocketAndSend({ type: 'CHOOSE_POOL_CARD', cardIndex });
}

function stopPeekingAction() {
    initSocketAndSend({ type: 'STOP_PEEK' });
    if (typeof showCenterNotification === 'function') showCenterNotification("Stopped peeking.");
}

function kickPeekerAction(spectatorUsername) {
    initSocketAndSend({ type: 'KICK_PEEKER', spectatorUsername });
    if (typeof showCenterNotification === 'function') showCenterNotification(`Removed ${spectatorUsername} from peeking.`);
}

function respondToBet(betId, accept) {
    initSocketAndSend({ type: 'RESPOND_BET', betId, accept });
    if (typeof toggleModal === 'function') toggleModal('bet-modal');
}

function submitEliminationProposal(target, wagerAmt) {
    initSocketAndSend({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    if (typeof toggleModal === 'function') toggleModal('bet-modal');
    if (typeof showCenterNotification === 'function') showCenterNotification(`First to lose bet proposed to ${target}!`);
}

function submitGlobalProposal(pickUser, wagerAmt) {
    initSocketAndSend({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt });
    if (typeof toggleModal === 'function') toggleModal('bet-modal');
    if (typeof showCenterNotification === 'function') showCenterNotification(`Global bet offered on ${pickUser}!`);
}

function acceptGlobalProposal(proposalId) {
    initSocketAndSend({ type: 'ACCEPT_GLOBAL_PROPOSAL', proposalId });
}

function confirmGlobalBet(proposalId, acceptedUser, confirm) {
    initSocketAndSend({ type: 'CONFIRM_GLOBAL_BET', proposalId, acceptedUser, confirm });
    if (typeof toggleModal === 'function') toggleModal('bet-modal');
}

function clearDebtCategory(targetUser, category) {
    initSocketAndSend({ type: 'CLEAR_DEBT', targetUser, category });
    if (typeof openLedgerModal === 'function') {
        setTimeout(() => openLedgerModal(), 200);
    }
}
