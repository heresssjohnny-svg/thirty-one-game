// public/js/ui.js - Complete DOM Coordinator, Table Render & Card Visuals (PART 1 OF 2)

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
    if (!cards || cards.length === 0) return 0;
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    const sums = {};
    scoringCards.forEach(c => {
        const s = normalizeSuit(c.suit);
        sums[s] = (sums[s] || 0) + (c.points !== undefined ? c.points : 0);
    });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
};

// -------------------------------------------------------------
// 3. MODALS, NOTIFICATIONS & CHAT CONTROLS
// -------------------------------------------------------------
window.toggleModal = function(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
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
    if (typeof refreshAudioOutputDevices === 'function') refreshAudioOutputDevices();
    if (typeof refreshVoiceParticipantsList === 'function') refreshVoiceParticipantsList();
    window.toggleModal('settings-modal');
};

window.toggleChatWindow = function() {
    const win = document.getElementById('chat-window');
    if (!win) return;
    const isVisible = win.style.display === 'flex';
    win.style.display = isVisible ? 'none' : 'flex';
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

window.syncChatHistory = function(history) {
    if (!Array.isArray(history)) return;
    const box = document.getElementById('chat-messages');
    if (!box) return;

    const lastCount = window.appGlobals.lastChatCount || 0;
    if (history.length !== lastCount) {
        box.innerHTML = history.map(m => `<div><b>${m.user || m.username}:</b> ${m.text || m.message}</div>`).join('');
        box.scrollTop = box.scrollHeight;

        const win = document.getElementById('chat-window');
        if (history.length > lastCount && (!win || win.style.display !== 'flex')) {
            const chatBtn = document.getElementById('chat-toggle-btn');
            if (chatBtn) {
                chatBtn.classList.add('unread');
                chatBtn.innerText = '💬 Chat (!)';
            }
        }
        window.appGlobals.lastChatCount = history.length;
    }
};

window.toggleGlobalSidebar = function() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) {
        sidebar.style.display = (sidebar.style.display === 'none') ? 'flex' : 'none';
    }
};

window.openSpectatorListModal = function() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState.spectatorsList || [];
    if (!content) return;
    if (specs.length === 0) {
        content.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">No spectators currently in table.</div>';
    } else {
        content.innerHTML = '<ul style="list-style:none; padding:0; margin:0;">' + specs.map(s => `<li style="margin-bottom:6px; font-size:0.85rem;">👤 <b>${s.username}</b></li>`).join('') + '</ul>';
    }
    window.toggleModal('spectators-modal');
};

window.openActiveBetsModal = function() {
    const myName = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const contentDiv = document.getElementById('active-bets-content');
    const active = window.clientState.activeBetsList || [];
    const pending = window.clientState.pendingBetsList || [];

    const myActive = active.filter(b => b.proposer === myName || b.target === myName || b.pickUser === myName);
    const myPending = pending.filter(b => b.proposer === myName || b.target === myName || b.pickUser === myName);

    let html = `<div style="font-weight:bold; color:var(--accent-gold); margin-bottom:4px;">Active Side Bets (${myActive.length})</div>`;
    if (myActive.length === 0) {
        html += `<div style="margin-left:8px; margin-bottom:8px; color:var(--text-muted); font-size:0.8rem;">None currently active.</div>`;
    } else {
        html += '<ul style="margin-left:14px; margin-bottom:8px;">';
        myActive.forEach(b => {
            const desc = b.type === 'eliminate' ? `Bet with ${b.proposer === myName ? b.target : b.proposer}: $${b.wagerAmt} on ${b.pickUser} to lose first` : `Global Bet: $${b.wagerAmt} on ${b.pickUser}`;
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
            html += `<li style="margin-bottom:3px; font-size:0.8rem;">Proposal from ${b.proposer}: $${b.wagerAmt}</li>`;
        });
        html += '</ul>';
    }

    if (contentDiv) contentDiv.innerHTML = html;
    window.toggleModal('active-bets-modal');
};

// -------------------------------------------------------------
// 4. LOBBY BROWSING & NAVIGATION LIFECYCLE
// -------------------------------------------------------------
window.renderLobbyList = function(lobbies) {
    const container = document.getElementById('lobby-list');
    if (!container) return;

    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div class="empty-list-notice">No active tables found.</div>';
        return;
    }

    container.innerHTML = lobbies.map(l => {
        const count = l.count !== undefined ? l.count : (l.players ? l.players.length : 0);
        const isOpen = (l.state === 'lobby' || l.gameState === 'lobby');
        return `
            <div class="lobby-item" onclick="joinLobbyCode('${l.code}')">
                <span style="font-size:0.82rem;">
                    <b>${l.name}</b> (${count}/6) — <i style="color:${isOpen ? '#34d399' : '#fbbf24'};">${isOpen ? 'Open' : 'In-Progress'}</i>
                </span>
                <span style="color:var(--accent-gold); font-size:0.75rem; font-weight:bold;">Enter →</span>
            </div>
        `;
    }).join('');
};

window.renderPublicLobbies = window.renderLobbyList;

window.refreshLobbies = function() {
    sendSocket({ type: 'GET_LOBBIES' });
    sendSocket({ type: 'REFRESH_LOBBIES' });
};

window.resetToMainMenu = function() {
    if (typeof window.disconnectLiveKit === 'function') window.disconnectLiveKit();
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.lastChatCount = 0;
    localStorage.removeItem('blitz31_active_room');

    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const endBtn = document.getElementById('end-game-btn');
    const leaveBtn = document.getElementById('leave-lobby-btn');

    if (gameView) gameView.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';
    if (topRowBtns) topRowBtns.style.display = 'none';
    if (toolsRow) toolsRow.style.display = 'none';
    if (endBtn) endBtn.style.display = 'none';
    if (leaveBtn) leaveBtn.style.display = 'none';

    const chatWin = document.getElementById('chat-window');
    if (chatWin) chatWin.style.display = 'none';

    const box = document.getElementById('chat-messages');
    if (box) box.innerHTML = '';

    window.clientState.isReady = false;
    window.appGlobals.hasChosenPoolCard = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';
    window.refreshLobbies();
};
// -------------------------------------------------------------
// 5. MASTER TABLE & GAME STATE RENDERER
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    window.appGlobals.latestLobbySnapshot = lobby;
    window.clientState.gameState = lobby.gameState || 'lobby';
    window.clientState.activeParticipantsCount = lobby.activeParticipantsCount || 3;
    window.clientState.discardTop = lobby.discardTop || null;
    window.clientState.lastDiscardPickup = lobby.lastDiscardPickup || null;
    window.clientState.tiedParticipantsList = lobby.tiedParticipantsList || [];
    window.clientState.activeBetsList = lobby.activeBets || [];
    window.clientState.pendingBetsList = lobby.pendingBets || [];
    window.clientState.playersList = lobby.players || [];
    window.clientState.spectatorsList = lobby.spectators || [];

    // 1. Force view transition out of Main Menu into Table View
    const authOverlay = document.getElementById('auth-overlay') || document.getElementById('auth-screen');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const leaveBtn = document.getElementById('leave-lobby-btn');
    const endBtn = document.getElementById('end-game-btn');

    if (authOverlay) authOverlay.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'block';
    if (topRowBtns) topRowBtns.style.display = 'flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (leaveBtn) leaveBtn.style.display = 'inline-block';
    if (endBtn) endBtn.style.display = (lobby.gameState !== 'lobby') ? 'inline-block' : 'none';

    // 2. Room Header and Status Banners
    const roomCodeDisplay = document.getElementById('room-code-display');
    const phaseBanner = document.getElementById('phase-message-banner');
    const potTotalDisplay = document.getElementById('pot-total-display');

    if (roomCodeDisplay) roomCodeDisplay.innerText = lobby.code || '';
    if (phaseBanner) phaseBanner.innerText = lobby.phaseMessage || '';
    if (potTotalDisplay) potTotalDisplay.innerText = `$${lobby.potTotal || 0}`;

    // 3. Resolve Current User Context
    const myUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const myPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === myUsername.toLowerCase());
    const isSpectator = !myPlayer;
    window.clientState.isSpectator = isSpectator;

    // 4. Render Center Felt (Deck & Discard Pile)
    renderCenterFelt(lobby, myPlayer);

    // 5. Render Seated Players & Spectator Views
    renderSeatPodiums(lobby, myUsername);

    // 6. Render Local Player Hand and Controls
    renderLocalActionControls(lobby, myPlayer);

    // 7. Modals: Dealer Draw & Tie-Breaker Draw Pools
    renderDrawPoolModals(lobby, myUsername);

    // 8. In-Game Audio & Visual Triggers
    triggerAudioAndVisualEvents(lobby, myPlayer);

    // 9. Sync Chat History
    if (lobby.chatHistory) {
        window.syncChatHistory(lobby.chatHistory);
    }
};

window.renderLobbyState = window.updateUIFromLobby;

// -------------------------------------------------------------
// 6. CENTER FELT (DECK & DISCARD PILE)
// -------------------------------------------------------------
function renderCenterFelt(lobby, myPlayer) {
    const deckCountDisplay = document.getElementById('deck-card-count');
    const deckElement = document.getElementById('deck-pile');
    const discardPileElement = document.getElementById('discard-pile');

    if (deckCountDisplay) {
        deckCountDisplay.innerText = lobby.deckCount !== undefined ? lobby.deckCount : '';
    }

    const isMyTurn = myPlayer && (lobby.currentTurnUser?.toLowerCase() === myPlayer.username.toLowerCase());
    const canDraw = isMyTurn && myPlayer.cards && myPlayer.cards.length === 3 && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');

    if (deckElement) {
        deckElement.classList.toggle('interactive-draw', !!canDraw);
        deckElement.onclick = canDraw ? () => window.drawCard('deck') : null;
    }

    if (discardPileElement) {
        if (lobby.discardTop) {
            discardPileElement.innerHTML = window.formatCardHtml(lobby.discardTop, false);
            discardPileElement.classList.toggle('interactive-draw', !!canDraw);
            discardPileElement.onclick = canDraw ? () => window.drawCard('discard') : null;
        } else {
            discardPileElement.innerHTML = '<div class="empty-discard-slot">Empty</div>';
            discardPileElement.classList.remove('interactive-draw');
            discardPileElement.onclick = null;
        }
    }
}

// -------------------------------------------------------------
// 7. SEAT PODIUMS & TABLE LAYOUT
// -------------------------------------------------------------
function renderSeatPodiums(lobby, myUsername) {
    const tableSeatsContainer = document.getElementById('table-seats');
    if (!tableSeatsContainer) return;

    const players = lobby.players || [];
    tableSeatsContainer.innerHTML = '';

    for (let i = 0; i < 6; i++) {
        const player = players.find(p => p.seat === i) || players[i];
        const seatDiv = document.createElement('div');
        seatDiv.className = `table-seat seat-${i}`;

        if (!player) {
            seatDiv.classList.add('empty-seat');
            if (lobby.gameState === 'lobby') {
                seatDiv.innerHTML = `
                    <div class="empty-seat-placeholder" onclick="sitDown()">
                        <span>+ Sit Down</span>
                    </div>
                `;
            } else {
                seatDiv.innerHTML = `<div class="empty-seat-placeholder"><span>Empty</span></div>`;
            }
            tableSeatsContainer.appendChild(seatDiv);
            continue;
        }

        const isCurrentTurn = (lobby.currentTurnUser?.toLowerCase() === player.username.toLowerCase());
        const isDealer = (lobby.dealerIndex === i);
        const isMe = (player.username.toLowerCase() === myUsername.toLowerCase());

        let cardsHtml = '';
        if (player.cards && player.cards.length > 0) {
            cardsHtml = `<div class="podium-cards">` + player.cards.map(c => window.formatCardHtml(c, true)).join('') + `</div>`;
        } else if (player.cardCount) {
            cardsHtml = `<div class="podium-cards">` + Array(player.cardCount).fill(0).map(() => `<div class="card-back mini-card"></div>`).join('') + `</div>`;
        }

        const livesHtml = Array(Math.max(0, player.lives || 0)).fill('❤️').join('') || '<span style="color:#ef4444; font-size:0.75rem;">OUT</span>';

        seatDiv.innerHTML = `
            <div class="player-podium ${isCurrentTurn ? 'active-turn' : ''} ${player.eliminated ? 'eliminated' : ''}">
                ${isDealer ? '<span class="dealer-badge">D</span>' : ''}
                <div class="podium-header">
                    <span class="podium-username">${player.username} ${isMe ? '(You)' : ''}</span>
                    <span class="podium-lives">${livesHtml}</span>
                </div>
                ${cardsHtml}
                <div class="podium-footer">
                    <span class="podium-wager">Bet: $${player.wager || 5}</span>
                    ${lobby.gameState === 'lobby' ? `<span class="ready-tag ${player.ready ? 'ready' : ''}">${player.ready ? 'Ready' : 'Not Ready'}</span>` : ''}
                </div>
            </div>
        `;

        tableSeatsContainer.appendChild(seatDiv);
    }
}

// -------------------------------------------------------------
// 8. LOCAL ACTION CONTROLS & HAND INTERACTION
// -------------------------------------------------------------
function renderLocalActionControls(lobby, myPlayer) {
    const handContainer = document.getElementById('player-hand-container');
    const localScoreDisplay = document.getElementById('my-hand-score');
    const actionBtnsRow = document.getElementById('player-action-buttons');
    const knockBtn = document.getElementById('knock-action-btn');
    const nextHandBtn = document.getElementById('next-hand-btn');

    if (!myPlayer || !handContainer) {
        if (handContainer) handContainer.innerHTML = '';
        if (localScoreDisplay) localScoreDisplay.innerText = '';
        if (actionBtnsRow) actionBtnsRow.style.display = 'none';
        return;
    }

    if (actionBtnsRow) actionBtnsRow.style.display = 'flex';

    const isMyTurn = (lobby.currentTurnUser?.toLowerCase() === myPlayer.username.toLowerCase());
    const cards = myPlayer.cards || [];

    // Calculate & Display Real-Time Local Score
    if (localScoreDisplay) {
        const score = window.calculateLocalScore(cards);
        localScoreDisplay.innerText = score ? `Score: ${score}` : '';
    }

    // Render 3 or 4 Interactive Cards
    handContainer.innerHTML = cards.map((c, idx) => {
        const canDiscard = isMyTurn && (cards.length === 4);
        return `
            <div class="hand-card-wrapper ${canDiscard ? 'can-discard' : ''}" onclick="${canDiscard ? `discardCard(${idx})` : ''}">
                ${window.formatCardHtml(c, false)}
                ${canDiscard ? '<span class="discard-hint">Discard</span>' : ''}
            </div>
        `;
    }).join('');

    // Knock Button Evaluation
    if (knockBtn) {
        const activeCount = lobby.activeParticipantsCount || 3;
        const minKnockScore = (activeCount > 2) ? 21 : 25;
        const currentScore = window.calculateLocalScore(cards);
        const canKnock = isMyTurn && !lobby.knockedBy && lobby.canKnock && (cards.length === 3) && (currentScore >= minKnockScore);

        knockBtn.disabled = !canKnock;
        knockBtn.style.display = (lobby.gameState === 'playing') ? 'inline-block' : 'none';
    }

    // Next Hand Ready Button
    if (nextHandBtn) {
        nextHandBtn.style.display = (lobby.gameState === 'roundOver') ? 'inline-block' : 'none';
        nextHandBtn.disabled = !!myPlayer.nextHandReady;
        nextHandBtn.innerText = myPlayer.nextHandReady ? 'Waiting for others...' : 'Next Hand Ready';
    }
}

// -------------------------------------------------------------
// 9. DEALER DRAW & TIE-BREAKER DRAW POOL OVERLAYS
// -------------------------------------------------------------
function renderDrawPoolModals(lobby, myUsername) {
    const isDealerDraw = (lobby.gameState === 'dealerDraw');
    const isTieBreaker = (lobby.gameState === 'tieBreaker');
    const modal = document.getElementById('dealer-draw-modal');
    const grid = document.getElementById('draw-pool-grid');
    const title = document.getElementById('draw-modal-title');

    if (!modal || !grid) return;

    if (!isDealerDraw && !isTieBreaker) {
        modal.style.display = 'none';
        return;
    }

    modal.style.display = 'flex';
    if (title) {
        title.innerText = isDealerDraw ? 'Pick for Dealer (Lowest Card Deals)' : 'Tie-Breaker: Draw for Survival!';
    }

    const drawPool = lobby.drawPool || [];
    const drawResults = lobby.drawResults || {};
    const hasPicked = !!drawResults[myUsername];

    grid.innerHTML = drawPool.map((slot, idx) => {
        const isChosen = slot.chosenBy !== null;
        const isChosenByMe = slot.chosenBy === myUsername;

        if (isChosen) {
            const revealedCard = isChosenByMe ? drawResults[myUsername] : null;
            return `
                <div class="pool-card-slot chosen">
                    ${revealedCard ? window.formatCardHtml(revealedCard, true) : '<div class="card-back mini-card"></div>'}
                    <span class="slot-owner">${slot.chosenBy}</span>
                </div>
            `;
        }

        return `
            <div class="pool-card-slot available ${!hasPicked ? 'clickable' : ''}" onclick="${!hasPicked ? `choosePoolCard(${idx})` : ''}">
                <div class="card-back mini-card"></div>
                <span class="slot-owner">Pick</span>
            </div>
        `;
    }).join('');
}

// -------------------------------------------------------------
// 10. AUDIO, NOTIFICATION & CELEBRATION TRIGGERS
// -------------------------------------------------------------
function triggerAudioAndVisualEvents(lobby, myPlayer) {
    const isMyTurn = myPlayer && (lobby.currentTurnUser?.toLowerCase() === myPlayer.username.toLowerCase());

    // 1. Turn chime
    if (isMyTurn && !window.appGlobals.wasMyTurn) {
        if (typeof window.playSound === 'function') window.playSound('yourturn');
    }
    window.appGlobals.wasMyTurn = isMyTurn;

    // 2. Knock audio
    if (lobby.knockedBy && lobby.knockedBy !== window.appGlobals.lastKnownKnockedBy) {
        window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
        if (typeof window.playSound === 'function') window.playSound('knock');
        window.showCenterNotification(`🔔 ${lobby.knockedBy} has knocked! Final turn.`);
    } else if (!lobby.knockedBy) {
        window.appGlobals.lastKnownKnockedBy = null;
    }

    // 3. 31 Celebration
    if (lobby.hit31Player && lobby.hit31Player !== window.appGlobals.lastCelebrated31) {
        window.appGlobals.lastCelebrated31 = lobby.hit31Player;
        window.showCenterNotification(`⚡ BLITZ 31! ${lobby.hit31Player} scored 31 points!`);
    } else if (!lobby.hit31Player) {
        window.appGlobals.lastCelebrated31 = null;
    }
}

// -------------------------------------------------------------
// 11. LIFETIME LEDGER MODAL RENDERER
// -------------------------------------------------------------
window.renderLifetimeLedger = function(balances) {
    const modalContent = document.getElementById('lifetime-ledger-content');
    if (!modalContent) return;

    if (!balances || balances.length === 0) {
        modalContent.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:8px 0;">No lifetime debts recorded. All settled!</div>';
        return;
    }

    modalContent.innerHTML = balances.map(b => {
        const isOwed = b.balance > 0;
        const color = isOwed ? '#34d399' : '#ef4444';
        const label = isOwed ? `owes you $${Math.abs(b.balance)}` : `you owe $${Math.abs(b.balance)}`;

        return `
            <div class="ledger-row" style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.08); font-size:0.85rem;">
                <span><b>${b.counterpart_name}</b></span>
                <span style="color:${color}; font-weight:bold;">${label}</span>
            </div>
        `;
    }).join('');
};
