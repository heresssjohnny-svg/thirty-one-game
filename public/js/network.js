// public/js/network.js

window.saveInputs = function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u) localStorage.setItem('blitz31_username', u.value.trim());
        if (l) localStorage.setItem('blitz31_lobby_name', l.value.trim());
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

let ws = null;
let currentLobby = null;
let currentUsername = '';

function getWsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
}

function initWebSocket(onOpenCb) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (onOpenCb) onOpenCb();
        return;
    }
    ws = new WebSocket(getWsUrl());
    window.ws = ws;

    ws.onopen = () => {
        if (onOpenCb) onOpenCb();
    };

    ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch (e) { return; }

        switch (data.type) {
            case 'LOBBY_JOINED':
                currentLobby = data.lobby;
                switchToGameView();
                renderLobby(data.lobby);
                break;
            case 'GAME_STATE_UPDATE':
            case 'LOBBY_UPDATE':
                currentLobby = data.lobby;
                renderLobby(data.lobby);
                break;
            case 'LEFT_LOBBY':
                resetToMainMenu();
                break;
            case 'ERROR':
                alert(data.message || 'An error occurred');
                break;
        }
    };

    ws.onclose = () => {
        setTimeout(() => {
            if (currentLobby) initWebSocket();
        }, 2000);
    };
}

window.sendSocketMessage = function(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    } else {
        initWebSocket(() => {
            ws.send(JSON.stringify(msg));
        });
    }
};

window.createLobby = function(isPrivate) {
    const u = document.getElementById('username-input').value.trim() || 'Host';
    const l = document.getElementById('lobby-name-input').value.trim();
    currentUsername = u;
    initWebSocket(() => {
        window.sendSocketMessage({
            type: 'CREATE_LOBBY',
            username: u,
            lobbyName: l,
            isPrivate: !!isPrivate
        });
    });
};

window.joinLobby = function() {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    const u = document.getElementById('username-input').value.trim() || 'Player';
    if (!code) { alert('Please enter a table code'); return; }
    currentUsername = u;
    initWebSocket(() => {
        window.sendSocketMessage({
            type: 'JOIN_LOBBY',
            code,
            username: u
        });
    });
};

window.setReady = function() {
    window.sendSocketMessage({ type: 'SET_READY' });
};

window.nextHand = function() {
    window.sendSocketMessage({ type: 'NEXT_HAND_READY' });
};

window.drawCard = function(source) {
    if (!currentLobby) return;
    const isMyTurn = currentLobby.currentTurnUser.toLowerCase() === currentUsername.toLowerCase();
    const me = currentLobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
    if (!isMyTurn || !me || me.cards.length >= 4) return;
    window.sendSocketMessage({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.discardCard = function(index) {
    if (!currentLobby) return;
    const isMyTurn = currentLobby.currentTurnUser.toLowerCase() === currentUsername.toLowerCase();
    const me = currentLobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
    if (!isMyTurn || !me || me.cards.length !== 4) return;
    window.sendSocketMessage({ type: 'DISCARD_CARD', cardIndex: index, index });
};

window.knockRound = function() {
    if (!currentLobby) return;
    const me = currentLobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
    if (!me || me.cards.length !== 3) return;

    const score = calculateLocalScore(me.cards);
    if (score <= 30) {
        if (!confirm(`Are you sure you want to knock with ${score} points?`)) return;
    }
    window.sendSocketMessage({ type: 'KNOCK' });
};

window.leaveLobby = function() {
    window.sendSocketMessage({ type: 'LEAVE_LOBBY' });
    resetToMainMenu();
};

function switchToGameView() {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('game-view').style.display = 'flex';
    document.getElementById('in-game-header-btns').style.display = 'block';
}

function resetToMainMenu() {
    currentLobby = null;
    document.getElementById('main-menu').style.display = 'flex';
    document.getElementById('game-view').style.display = 'none';
    document.getElementById('in-game-header-btns').style.display = 'none';
}

function calculateLocalScore(cards) {
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let sums = {};
    scoringCards.forEach(c => { sums[c.suit] = (sums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
}

function renderLobby(lobby) {
    document.getElementById('pot-total-banner').innerText = `Pot: $${lobby.potTotal || 0}`;
    document.getElementById('deck-count-display').innerText = `${lobby.deckCount || 0} left`;
    document.getElementById('phase-message-display').innerText = lobby.phaseMessage || '';

    // Discard pile rendering
    const discardSlot = document.getElementById('discard-pile');
    if (lobby.discardTop) {
        const isRed = ['♥', '♦'].includes(lobby.discardTop.suit);
        discardSlot.className = `card-slot card-face ${isRed ? 'red-suit' : 'black-suit'}`;
        discardSlot.innerHTML = `<span style="font-size:1.1rem;">${lobby.discardTop.val}</span><span>${lobby.discardTop.suit}</span>`;
    } else {
        discardSlot.className = 'card-slot';
        discardSlot.innerHTML = '<span>Empty</span>';
    }

    // Top Notifications
    const topleft = document.getElementById('discard-pickup-topleft-modal');
    if (lobby.lastDiscardPickup) {
        topleft.style.display = 'block';
        topleft.innerText = `👀 ${lobby.lastDiscardPickup.username} took ${lobby.lastDiscardPickup.card.val}${lobby.lastDiscardPickup.card.suit}`;
    } else {
        topleft.style.display = 'none';
    }

    const topright = document.getElementById('fed-card-topright-modal');
    if (lobby.myFedCardReminder) {
        topright.style.display = 'block';
        topright.innerText = `⚠️ ${lobby.myFedCardReminder.target} has your ${lobby.myFedCardReminder.card.val}${lobby.myFedCardReminder.card.suit}`;
    } else {
        topright.style.display = 'none';
    }

    // Seats
    const seatsContainer = document.getElementById('seats-container');
    seatsContainer.innerHTML = '';
    lobby.players.forEach(p => {
        const isTurn = (p.username.toLowerCase() === lobby.currentTurnUser.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        const isDealer = lobby.players[lobby.dealerIndex]?.username === p.username;
        const seatDiv = document.createElement('div');
        seatDiv.className = `seat seat-${p.seat} ${isTurn ? 'current-turn-seat' : ''}`;
        seatDiv.innerHTML = `
            <div>
                <b>${p.username}</b> ${isDealer ? '<span class="dealer-badge">D</span>' : ''}
            </div>
            <div>${p.ready ? '✅' : '⏳'} Lives: ${p.lives}</div>
        `;
        seatsContainer.appendChild(seatDiv);
    });

    // Hand & Controls for local player
    const me = lobby.players.find(p => p.username.toLowerCase() === currentUsername.toLowerCase());
    const myCardsContainer = document.getElementById('my-cards-container');
    const myScoreDisplay = document.getElementById('my-score-display');
    const knockBtn = document.getElementById('knock-btn');
    const readyBtn = document.getElementById('ready-btn');
    const nextHandBtn = document.getElementById('next-hand-btn');

    if (me && me.cards) {
        myCardsContainer.innerHTML = me.cards.map((c, i) => {
            const isRed = ['♥', '♦'].includes(c.suit);
            return `
                <div class="my-card ${isRed ? 'red-suit' : 'black-suit'}" onclick="window.discardCard(${i})">
                    <span>${c.val}</span>
                    <span style="font-size:1.1rem;">${c.suit}</span>
                </div>
            `;
        }).join('');
        myScoreDisplay.innerText = calculateLocalScore(me.cards);
    } else {
        myCardsContainer.innerHTML = '';
        myScoreDisplay.innerText = '0';
    }

    // Button states
    if (lobby.gameState === 'lobby') {
        readyBtn.style.display = 'block';
        readyBtn.innerText = me?.ready ? 'Ready ✅' : 'Ready Up';
        knockBtn.style.display = 'none';
        nextHandBtn.style.display = 'none';
    } else if (lobby.gameState === 'roundOver') {
        readyBtn.style.display = 'none';
        knockBtn.style.display = 'none';
        nextHandBtn.style.display = 'block';
        nextHandBtn.innerText = me?.nextHandReady ? 'Waiting...' : 'Next Hand';
    } else {
        readyBtn.style.display = 'none';
        nextHandBtn.style.display = 'none';
        knockBtn.style.display = 'block';

        const isMyTurn = lobby.currentTurnUser.toLowerCase() === currentUsername.toLowerCase();
        const hasThreeCards = me && me.cards.length === 3;
        const score = me ? calculateLocalScore(me.cards) : 0;
        const minKnockReq = lobby.activeParticipantsCount > 2 ? 21 : 25;

        // Knock disabled if drawn 4th card, not their turn, or round not eligible
        knockBtn.disabled = !(isMyTurn && hasThreeCards && lobby.canKnock && score >= minKnockReq);
    }

    // Tiebreaker handling
    const tbModal = document.getElementById('tiebreaker-modal');
    if (lobby.gameState === 'tieBreaker') {
        tbModal.style.display = 'flex';
        const poolDiv = document.getElementById('tiebreaker-pool');
        poolDiv.innerHTML = (lobby.drawPool || []).map((slot, i) => {
            if (slot.chosenBy) {
                const card = lobby.drawResults?.[slot.chosenBy];
                return `<div class="card-slot card-face" style="font-size:0.75rem;">${card ? `${card.val}${card.suit}` : 'Picked'}<br>${slot.chosenBy}</div>`;
            }
            return `<div class="card-slot back" onclick="window.chooseTieCard(${i})">?</div>`;
        }).join('');
    } else {
        tbModal.style.display = 'none';
    }
}

window.chooseTieCard = function(index) {
    window.sendSocketMessage({ type: 'CHOOSE_POOL_CARD', cardIndex: index });
};

document.addEventListener('DOMContentLoaded', () => {
    window.restoreSavedInputs();
});
