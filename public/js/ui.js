// public/js/ui.js - Table DOM Coordinator, Card Rendering & Modals (PART 1 OF 2)

// -------------------------------------------------------------
// 1. STATE & ENVIRONMENT SAFEGUARDS
// -------------------------------------------------------------
window.clientState = window.clientState || {
    username: localStorage.getItem('saved_username') || 'Player1',
    isReady: false,
    playersList: [],
    spectatorsList: [],
    discardTop: null,
    sideBetLedger: {},
    mainGameLedger: {},
    botBetLedger: {},
    lastDiscardPickup: null,
    gameState: 'lobby',
    activeParticipantsCount: 3,
    isSpectator: false,
    tiedParticipantsList: [],
    activeBetsList: [],
    pendingBetsList: []
};

window.appGlobals = window.appGlobals || {
    ws: null,
    currentJoinedCode: localStorage.getItem('blitz31_active_room') || null,
    latestLobbySnapshot: null,
    wasMyTurn: false,
    lastKnownKnockedBy: null,
    hasChosenPoolCard: false,
    lastPhaseMessage: '',
    lastGameState: '',
    lastCelebratedWinner: null,
    lastCelebrated31: null,
    lastChatCount: 0,
    notificationTimer: null
};

function sendSocket(payload) {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc(payload);
    } else if (window.appGlobals.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(payload));
    }
}

// -------------------------------------------------------------
// 2. CASINO PLAYING CARD RENDERER & HAND SCORING
// -------------------------------------------------------------
function normalizeSuit(rawSuit) {
    if (!rawSuit) return '♠';
    const s = String(rawSuit).trim().toUpperCase();
    const map = {
        'S': '♠', 'SPADES': '♠', '♠': '♠',
        'H': '♥', 'HEARTS': '♥', '♥': '♥',
        'D': '♦', 'DIAMONDS': '♦', '♦': '♦',
        'C': '♣', 'CLUBS': '♣', '♣': '♣'
    };
    return map[s] || s;
}

window.formatCardHtml = function(card, isMini = false) {
    if (!card) return '';

    let val = '';
    let suit = '';

    if (typeof card === 'string') {
        const raw = card.trim().toUpperCase();
        const suitChar = raw.slice(-1);
        val = raw.slice(0, -1);
        suit = normalizeSuit(suitChar);
    } else if (typeof card === 'object') {
        val = card.val || card.value || card.rank || '';
        suit = normalizeSuit(card.suit);
    }

    const isRed = (suit === '♥' || suit === '♦');
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    if (isMini) {
        return `
            <div class="mini-card ${suitClass}">
                <span class="mini-val">${val}</span>
                <span class="mini-suit">${suit}</span>
            </div>
        `;
    }

    return `
        <div class="playing-card ${suitClass}">
            <div class="card-corner top-left">
                <span class="corner-val">${val}</span>
                <span class="corner-suit">${suit}</span>
            </div>
            <div class="card-center-pip">${suit}</div>
            <div class="card-corner bottom-right">
                <span class="corner-val">${val}</span>
                <span class="corner-suit">${suit}</span>
            </div>
        </div>
    `;
};

window.calculateLocalScore = function(cards) {
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    const sums = {};
    scoringCards.forEach(c => {
        const s = normalizeSuit(c.suit);
        const val = (c.val === 'A') ? 11 : (['K', 'Q', 'J', '10'].includes(c.val) ? 10 : parseInt(c.val, 10));
        sums[s] = (sums[s] || 0) + (isNaN(val) ? 0 : val);
    });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
};

// -------------------------------------------------------------
// 3. MODALS, NOTIFICATIONS, CHAT & SPECTATOR CONTROLS
// -------------------------------------------------------------
window.toggleModal = function(id) {
    const m = document.getElementById(id);
    if (!m) return;
    const isVisible = (m.style.display === 'flex') && !m.classList.contains('hidden');
    m.style.display = isVisible ? 'none' : 'flex';
    m.classList.toggle('hidden', isVisible);
};

window.showCenterNotification = function(msg) {
    const banner = document.getElementById('center-notification-banner');
    if (!banner) return;
    banner.innerText = msg;
    banner.style.display = 'block';
    if (window.appGlobals.notificationTimer) clearTimeout(window.appGlobals.notificationTimer);
    window.appGlobals.notificationTimer = setTimeout(() => {
        banner.style.display = 'none';
    }, 2800);
};

window.openSettingsModal = function() {
    window.toggleModal('settings-modal');
};

window.closeSettingsModal = function() {
    const m = document.getElementById('settings-modal');
    if (m) {
        m.style.display = 'none';
        m.classList.add('hidden');
    }
};

window.toggleChatWindow = function() {
    const win = document.getElementById('chat-window');
    if (!win) return;
    const isVisible = win.style.display === 'flex' && !win.classList.contains('hidden');
    win.style.display = isVisible ? 'none' : 'flex';
    win.classList.toggle('hidden', isVisible);
    if (!isVisible) {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.remove('unread');
            chatBtn.innerText = '💬 Chat';
        }
        const box = document.getElementById('chat-messages');
        if (box) box.scrollTop = box.scrollHeight;
    }
};

window.appendChatMessage = function(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.innerHTML = `<b>${user}:</b> ${msg}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    const win = document.getElementById('chat-window');
    if (!win || win.style.display !== 'flex') {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
};

window.openSpectatorListModal = function() {
    const modal = document.getElementById('spectator-list-modal') || document.getElementById('spectators-modal');
    const content = document.getElementById('spectators-list') || document.getElementById('spectators-list-content');
    if (!modal) return;

    const snapshot = window.appGlobals?.latestLobbySnapshot || {};
    const specs = snapshot.spectators || window.clientState.spectatorsList || [];

    if (content) {
        if (specs.length === 0) {
            content.innerHTML = '<div style="color:var(--text-muted, #94a3b8); font-size:0.85rem; text-align:center; padding:12px;">No active spectators.</div>';
        } else {
            content.innerHTML = '<ul style="list-style:none; padding:0; margin:0;">' + specs.map(s => {
                const name = typeof s === 'string' ? s : (s.username || 'Spectator');
                const micIcon = s.inVC ? (s.isMuted ? ' 🔇' : ' 🎙️') : '';
                return `
                    <li style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; margin-bottom:5px; background:rgba(0,0,0,0.3); border-radius:6px; border:1px solid rgba(255,255,255,0.06); font-weight:600; font-size:0.85rem; color:#f1f5f9;">
                        <span>👀 ${name}</span>
                        <span>${micIcon}</span>
                    </li>
                `;
            }).join('') + '</ul>';
        }
    }

    modal.style.display = 'flex';
    modal.classList.remove('hidden');
};

window.closeSpectatorListModal = function() {
    const modal = document.getElementById('spectator-list-modal') || document.getElementById('spectators-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
};

window.openActiveBetsModal = function() {
    const myName = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const contentDiv = document.getElementById('active-bets-content');
    const active = window.clientState.activeBetsList || [];
    const pending = window.clientState.pendingBetsList || [];

    const myActive = active.filter(b => (b.proposer || b.bettor) === myName || b.target === myName || b.pickUser === myName);
    const myPending = pending.filter(b => (b.proposer || b.creator) === myName || b.target === myName || b.pickUser === myName);

    let html = `<div style="font-weight:bold; color:var(--accent-gold); margin-bottom:4px;">Active Side Bets (${myActive.length})</div>`;
    if (myActive.length === 0) {
        html += `<div style="margin-left:8px; margin-bottom:8px; color:var(--text-muted); font-size:0.8rem;">None currently active.</div>`;
    } else {
        html += '<ul style="margin-left:14px; margin-bottom:8px;">';
        myActive.forEach(b => {
            const desc = b.type === 'eliminate'
                ? `Bet with ${(b.proposer || b.bettor) === myName ? b.target : (b.proposer || b.bettor)}: $${b.wagerAmt} on ${b.pickUser} to lose first`
                : `Global Bet: $${b.wagerAmt} on ${b.pickUser || b.condition}`;
            html += `<li style="margin-bottom:3px; font-size:0.8rem;">${desc}</li>`;
        });
        html += '</ul>';
    }

    html += `<div style="font-weight:bold; color:var(--accent-gold); margin-bottom:4px;">Pending Side Bets (${myPending.length})</div>`;
    if (myPending.length === 0) {
        html += `<div style="margin-left:8px; color:var(--text-muted); font-size:0.8rem;">None currently pending.</div>`;
    } else {
        html += '<ul style="margin-left:14px;">';
        myPending.forEach(b => {
            html += `<li style="margin-bottom:3px; font-size:0.8rem;">Proposal from ${b.proposer || b.creator}: $${b.wagerAmt}</li>`;
        });
        html += '</ul>';
    }

    if (contentDiv) contentDiv.innerHTML = html;
    window.toggleModal('active-bets-modal');
};

window.closeActiveBetsModal = function() {
    const modal = document.getElementById('active-bets-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
};

window.toggleGlobalSidebar = function() {
    const modal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (modal) {
        window.toggleModal(modal.id);
    }
};

// -------------------------------------------------------------
// 4. LOBBY BROWSING & NAVIGATION ACTIONS
// -------------------------------------------------------------
window.renderLobbyList = function(lobbies) {
    const container = document.getElementById('lobby-list');
    if (!container) return;

    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:10px; font-size:0.75rem;">No active tables found.</div>';
        return;
    }

    container.innerHTML = lobbies.map(l => {
        const count = l.count !== undefined ? l.count : (l.players ? l.players.length : 0);
        const isOpen = (l.state === 'lobby' || l.gameState === 'lobby');
        return `
            <div class="lobby-item" onclick="joinLobbyCode('${l.code}')">
                <span style="font-size:0.78rem;">
                    <b>${l.name}</b> (${count}/6) — <i style="color:${isOpen ? '#34d399' : '#fbbf24'};">${isOpen ? 'Open' : 'In-Progress'}</i>
                </span>
                <span style="color:var(--accent-gold); font-size:0.75rem; font-weight:bold;">Enter →</span>
            </div>
        `;
    }).join('');
};

window.renderPublicLobbies = window.renderLobbyList;

window.resetToMainMenu = function() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.lastChatCount = 0;
    localStorage.removeItem('blitz31_active_room');

    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    if (gameView) gameView.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';

    const chatWin = document.getElementById('chat-window');
    if (chatWin) chatWin.style.display = 'none';

    window.clientState.isReady = false;
    window.appGlobals.hasChosenPoolCard = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';
    window.refreshLobbies();
};

// -------------------------------------------------------------
// 5. IN-GAME CARD SELECTION & KNOCK ACTIONS
// -------------------------------------------------------------
window.drawCard = function(source) {
    if (window.clientState.isSpectator) return;
    sendSocket({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    if (window.clientState.isSpectator) return;
    sendSocket({
        type: 'DISCARD_CARD',
        index: cardIndex,
        cardIndex: cardIndex
    });
};

window.choosePoolCard = function(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    sendSocket({ type: 'CHOOSE_POOL_CARD', poolIndex: cardIndex, cardIndex: cardIndex });
};

window.selectPoolCard = window.choosePoolCard;

window.knockRound = function() {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());

    if (!me || !me.cards || me.cards.length !== 3) {
        window.showCenterNotification("You cannot knock after picking up a card!");
        return;
    }

    const currentScore = window.calculateLocalScore(me.cards);
    const activeCount = window.clientState.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;

    if (currentScore < threshold) {
        window.showCenterNotification(`Need at least ${threshold} points to knock!`);
        return;
    }

    if (currentScore <= 30) {
        const confirmKnock = confirm(`Knock Confirmation: Are you sure you want to knock with ${currentScore} points?`);
        if (!confirmKnock) return;
    }

    sendSocket({ type: 'KNOCK' });
};
// public/js/ui.js - Table DOM Coordinator, Card Rendering & Modals (PART 2 OF 2)

// -------------------------------------------------------------
// 6. DEALER CUT & TIE-BREAKER DRAW OVERLAY (COMPACT SETS OF 2)
// -------------------------------------------------------------
function renderDealerDrawOverlay(lobby) {
    const modal = document.getElementById('dealer-draw-modal') || document.getElementById('pool-draw-modal');
    if (!modal) return;

    if (lobby.gameState !== 'dealerDraw' && lobby.gameState !== 'tieBreaker') {
        modal.style.display = 'none';
        modal.classList.add('hidden');
        window.appGlobals.hasChosenPoolCard = false;
        return;
    }

    modal.style.display = 'flex';
    modal.classList.remove('hidden');

    const titleElem = document.getElementById('dealer-draw-title') || document.getElementById('pool-modal-title');
    const descElem = document.getElementById('dealer-draw-desc') || document.getElementById('pool-modal-instruction');

    if (lobby.gameState === 'tieBreaker') {
        if (titleElem) titleElem.innerText = 'TIE-BREAKER DRAW';
        if (descElem) descElem.innerText = 'Lowest card drawn loses a life! (Ace highest)';
    } else {
        if (titleElem) titleElem.innerText = 'DEALER CUT';
        if (descElem) descElem.innerText = 'Lowest card deals! (Ace highest)';
    }

    // Top Player Showcase: Compact 3 rows of 2
    const stream = document.getElementById('draw-results-stream') 
        || document.getElementById('draw-order-sequence') 
        || document.getElementById('draw-showcase-sidebar');

    if (stream) {
        const active = (lobby.players || []).filter(p => !p.eliminated);
        stream.innerHTML = active.map(p => {
            const pickedCard = lobby.drawResults && lobby.drawResults[p.username];
            if (pickedCard) {
                const isRed = (pickedCard.suit === '♥' || pickedCard.suit === '♦');
                return `
                    <div class="result-item draw-showcase-item">
                        <span class="draw-picker-badge">${p.username}</span>
                        <div class="mini-card ${isRed ? 'red-suit' : 'black-suit'}">
                            <span>${pickedCard.val}</span>
                            <span>${pickedCard.suit}</span>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div class="result-item draw-showcase-item">
                        <span class="draw-picker-badge">${p.username}</span>
                        <div class="draw-card-waiting">?</div>
                    </div>
                `;
            }
        }).join('');
    }

    // 52-Card Deck Selection Grid
    const grid = document.getElementById('draw-pool-grid') || document.getElementById('pool-cards-container');
    if (grid && lobby.drawPool) {
        const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
        const hasPicked = Boolean(lobby.drawResults && lobby.drawResults[activeUsername]);
        const isTieBreaker = lobby.gameState === 'tieBreaker';
        const eligible = isTieBreaker 
            ? (lobby.tiedParticipantsList || []).includes(activeUsername)
            : active.some(p => p.username === activeUsername);

        grid.innerHTML = lobby.drawPool.map((item, idx) => {
            const isTaken = item.chosenBy !== null;
            const canClick = eligible && !hasPicked && !isTaken && !window.appGlobals.hasChosenPoolCard;
            return `
                <div class="card-pool-item ${isTaken ? 'taken' : ''}" 
                     onclick="${canClick ? `choosePoolCard(${idx})` : ''}">
                    ${isTaken ? '✓' : ''}
                </div>
            `;
        }).join('');
    }
}

// -------------------------------------------------------------
// 7. IN-GAME MASTER TABLE & SEAT PODIUM RENDERER
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    window.appGlobals.latestLobbySnapshot = lobby;
    window.clientState.gameState = lobby.gameState;

    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    if (gameView && gameView.style.display !== 'block' && gameView.style.display !== 'flex') {
        gameView.style.display = 'flex';
    }
    if (mainMenu) mainMenu.style.display = 'none';

    // Room info headers
    const roomCodeEl = document.getElementById('room-code-display') || document.getElementById('in-game-room-code');
    const tableNameEl = document.getElementById('in-game-table-name');
    if (roomCodeEl) roomCodeEl.textContent = lobby.code;
    if (tableNameEl) tableNameEl.textContent = lobby.name || `${lobby.code} Table`;

    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const isHost = (lobby.host && lobby.host.toLowerCase() === activeUsername.toLowerCase());

    const isSpectator = (lobby.spectators || []).some(s => (s.username || s).toLowerCase() === activeUsername.toLowerCase());
    const isSeated = (lobby.players || []).some(p => p.username.toLowerCase() === activeUsername.toLowerCase());
    window.clientState.isSpectator = isSpectator;

    // Spectator counter & tools
    const specCount = document.getElementById('spec-count');
    if (specCount) specCount.textContent = (lobby.spectators || []).length;

    const sitBtn = document.getElementById('sit-btn');
    const standUpBtn = document.getElementById('stand-up-btn');
    const readyBtn = document.getElementById('ready-btn');

    if (sitBtn) sitBtn.style.display = (isSpectator && lobby.gameState === 'lobby' && lobby.players.length < 6) ? 'inline-block' : 'none';
    if (standUpBtn) standUpBtn.style.display = (isSeated && lobby.gameState === 'lobby') ? 'inline-block' : 'none';
    if (readyBtn) readyBtn.style.display = isSpectator ? 'none' : 'inline-block';

    // Host table config panel
    const hostControls = document.getElementById('host-controls') || document.getElementById('lobby-config-bar');
    if (hostControls) {
        hostControls.style.display = (isHost && lobby.gameState === 'lobby') ? 'flex' : 'none';
    }

    // Dealer draw modal watcher
    renderDealerDrawOverlay(lobby);

    // Phase messages and notifications
    const phaseBanner = document.getElementById('center-notification-banner');
    if (phaseBanner && lobby.phaseMessage && lobby.gameState !== 'dealerDraw') {
        if (lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
            window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
            window.showCenterNotification(lobby.phaseMessage);
        }
    }

    // Felt center deck & discard pile
    const discardSlot = document.getElementById('felt-discard-slot') || document.getElementById('discard-pile');
    if (discardSlot) {
        if (lobby.discardTop) {
            discardSlot.innerHTML = window.formatCardHtml(lobby.discardTop);
            discardSlot.onclick = () => window.drawFromDiscard();
        } else {
            discardSlot.innerHTML = '<div class="empty-discard-box">Empty</div>';
            discardSlot.onclick = null;
        }
    }

    const deckSlot = document.getElementById('felt-deck-slot') || document.getElementById('draw-deck');
    if (deckSlot) {
        deckSlot.onclick = () => window.drawFromDeck();
    }

    // Render seats around felt oval
    renderTableSeats(lobby, activeUsername);

    // Render user hand
    const me = (lobby.players || []).find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
    renderLocalPlayerHand(me, lobby);

    // Next Hand Ready overlay
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (nextHandOverlay) {
        const showNext = (lobby.gameState === 'roundOver' && me && !me.eliminated && !me.nextHandReady);
        nextHandOverlay.style.display = showNext ? 'flex' : 'none';
    }
};

function renderTableSeats(lobby, activeUsername) {
    const tableSeatsContainer = document.getElementById('seats-container') || document.getElementById('table-seats');
    if (!tableSeatsContainer) return;

    const players = lobby.players || [];
    let html = '';

    for (let i = 0; i < 6; i++) {
        const player = players.find(p => p.seat === i) || players[i];
        if (player) {
            const isTurn = (lobby.turnIndex !== undefined && lobby.players[lobby.turnIndex]?.username === player.username && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn'));
            const isDealer = (lobby.dealerName === player.username || lobby.dealerIndex === i);
            const isMe = (player.username.toLowerCase() === activeUsername.toLowerCase());
            const livesIcons = '❤️'.repeat(Math.max(0, player.lives || 0));

            html += `
                <div class="seat-podium seat-${i} ${isTurn ? 'active-turn' : ''} ${player.eliminated ? 'eliminated' : ''}">
                    <div class="player-badge ${isMe ? 'local-player' : ''}">
                        <span class="seat-name">${player.username} ${isDealer ? '👑' : ''}</span>
                        <span class="seat-lives">${livesIcons}</span>
                        ${player.ready && lobby.gameState === 'lobby' ? '<span class="ready-badge">READY</span>' : ''}
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="seat-podium seat-${i} empty-seat">
                    <div class="empty-badge">Open</div>
                </div>
            `;
        }
    }

    tableSeatsContainer.innerHTML = html;
}

function renderLocalPlayerHand(me, lobby) {
    const handContainer = document.getElementById('player-cards-container') || document.getElementById('my-hand');
    const scoreDisplay = document.getElementById('my-score-display') || document.getElementById('hand-score');
    if (!handContainer) return;

    if (!me || !me.cards || me.cards.length === 0 || me.eliminated) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.textContent = 'Score: 0';
        return;
    }

    const isMyTurn = (lobby.turnIndex !== undefined && lobby.players[lobby.turnIndex]?.username === me.username && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn'));
    const canDiscard = (isMyTurn && me.cards.length === 4);

    handContainer.innerHTML = me.cards.map((c, idx) => {
        return `
            <div class="hand-card-wrapper ${canDiscard ? 'clickable-card' : ''}" 
                 onclick="${canDiscard ? `discardCard(${idx})` : ''}">
                ${window.formatCardHtml(c)}
            </div>
        `;
    }).join('');

    if (scoreDisplay) {
        scoreDisplay.textContent = `Score: ${window.calculateLocalScore(me.cards)}`;
    }
}

// -------------------------------------------------------------
// 8. GLOBAL EXPORTS
// -------------------------------------------------------------
window.renderDealerDrawOverlay = renderDealerDrawOverlay;
window.renderLobbyState = window.updateUIFromLobby;
