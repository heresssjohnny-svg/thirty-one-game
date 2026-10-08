// public/js/ui.js - Complete DOM Coordinator, Casino Felt Table & Card Visuals

// -------------------------------------------------------------
// 1. STATE & ENVIRONMENT SAFEGUARDS
// -------------------------------------------------------------
window.clientState = window.clientState || {
    username: 'Player1',
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
    currentJoinedCode: null,
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
    if (typeof updateVcParticipantsList === 'function') updateVcParticipantsList();
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

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        sendSocket({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
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
        content.innerHTML = 'No spectators.';
    } else {
        content.innerHTML = '<ul>' + specs.map(s => `<li style="margin-bottom:3px;"><b>${s.username}</b></li>`).join('') + '</ul>';
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
        html += `<div style="margin-left:8px; margin-bottom:8px; color:var(--text-muted);">None currently active.</div>`;
    } else {
        html += '<ul style="margin-left:14px; margin-bottom:8px;">';
        myActive.forEach(b => {
            const desc = b.type === 'eliminate' ? `Bet with ${b.proposer === myName ? b.target : b.proposer}: $${b.wagerAmt} on ${b.pickUser} to lose first` : `Global Bet: $${b.wagerAmt} on ${b.pickUser}`;
            html += `<li style="margin-bottom:3px;">${desc}</li>`;
        });
        html += '</ul>';
    }

    html += `<div style="font-weight:bold; color:var(--accent-gold); margin-bottom:4px;">Pending Side Bets (${myPending.length})</div>`;
    if (myPending.length === 0) {
        html += `<div style="margin-left:8px; color:var(--text-muted);">None currently pending.</div>`;
    } else {
        html += '<ul style="margin-left:14px;">';
        myPending.forEach(b => {
            html += `<li style="margin-bottom:3px;">Proposal from ${b.proposer}: $${b.wagerAmt}</li>`;
        });
        html += '</ul>';
    }

    if (contentDiv) contentDiv.innerHTML = html;
    window.toggleModal('active-bets-modal');
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

window.refreshLobbies = function() {
    sendSocket({ type: 'GET_LOBBIES' });
    sendSocket({ type: 'REFRESH_LOBBIES' });
};

window.createLobby = function() {
    if (typeof window.saveInputs === 'function') window.saveInputs();
    const userIn = document.getElementById('username-input');
    const nameIn = document.getElementById('lobby-name-input');
    const privIn = document.getElementById('private-lobby-checkbox');

    const username = (userIn?.value || '').trim() || (window.userSession?.username || 'Player1');
    const lobbyName = (nameIn?.value || '').trim() || `${username}'s Table`;
    const isPrivate = privIn ? privIn.checked : false;

    window.clientState.username = username;
    sendSocket({ type: 'CREATE_LOBBY', username, lobbyName, isPrivate });
};

window.joinLobby = function() {
    if (typeof window.saveInputs === 'function') window.saveInputs();
    const codeIn = document.getElementById('lobby-code-input');
    const code = (codeIn?.value || '').trim().toUpperCase();
    if (code) window.joinLobbyCode(code);
};

window.joinLobbyCode = function(code) {
    if (!code) return;
    if (typeof window.saveInputs === 'function') window.saveInputs();
    const userIn = document.getElementById('username-input');
    const username = (userIn?.value || '').trim() || (window.userSession?.username || 'Player1');

    window.clientState.username = username;
    window.appGlobals.currentJoinedCode = code.toUpperCase();
    sendSocket({ type: 'JOIN_LOBBY', code: code.toUpperCase(), username });
};

window.leaveLobby = function() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    sendSocket({ type: 'LEAVE_LOBBY' });
    window.resetToMainMenu();
};

window.resetToMainMenu = function() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.lastChatCount = 0;

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
// 5. IN-GAME ACTIONS & CARD INTERACTIONS
// -------------------------------------------------------------
window.drawCard = function(source) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    sendSocket({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(30);
    sendSocket({
        type: 'DISCARD_CARD',
        index: cardIndex,
        cardIndex: cardIndex
    });
};

window.choosePoolCard = function(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    sendSocket({ type: 'CHOOSE_POOL_CARD', cardIndex });
};

window.clickNextHand = function() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    sendSocket({ type: 'NEXT_HAND_READY' });
    sendSocket({ type: 'NEXT_HAND' });
};

window.toggleReady = function() {
    window.clientState.isReady = !window.clientState.isReady;
    const btn = document.getElementById('ready-btn');
    if (btn) btn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    sendSocket({ type: 'SET_READY', ready: window.clientState.isReady });
};

window.standUp = function() { sendSocket({ type: 'STAND_UP' }); };
window.sitDown = function() { sendSocket({ type: 'SIT_DOWN' }); };

window.updateWager = function() {
    const sel = document.getElementById('config-wager');
    if (sel) sendSocket({ type: 'UPDATE_WAGER', wager: parseInt(sel.value, 10) || 5 });
};

window.updateSettings = function() {
    const sel = document.getElementById('config-lives');
    if (sel) sendSocket({ type: 'UPDATE_SETTINGS', lives: parseInt(sel.value, 10) || 3 });
};

window.submitLivesVote = function(agree) {
    sendSocket({ type: 'VOTE_LIVES', agree: !!agree });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
};

window.addBot = function() { sendSocket({ type: 'ADD_BOT' }); };
window.removeBot = function() { sendSocket({ type: 'REMOVE_BOT' }); };

window.proposeEndGame = function() {
    if (confirm("Propose ending the game and returning to the lobby?")) {
        sendSocket({ type: 'END_GAME_PROPOSAL' });
    }
};

window.stopPeekingAction = function() {
    sendSocket({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
    window.showCenterNotification("Stopped peeking.");
};

window.kickPeekerAction = function(spectatorUsername) {
    sendSocket({ type: 'KICK_PEEKER', spectatorUsername });
    window.showCenterNotification(`Removed ${spectatorUsername} from peeking your hand.`);
};

// -------------------------------------------------------------
// 6. KNOCK VALIDATION & EXECUTION
// -------------------------------------------------------------
function updateKnockAlertAndAudio(lobby) {
    const knockAlertModal = document.getElementById('knock-alert-modal');
    if (!knockAlertModal) return;

    if (lobby.knockedBy && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn')) {
        knockAlertModal.innerText = `🔔 ${lobby.knockedBy.toUpperCase()} HAS KNOCKED!`;
        knockAlertModal.style.display = 'block';

        if (window.appGlobals.lastKnownKnockedBy !== lobby.knockedBy) {
            window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
            if (typeof playSound === 'function') playSound('knock');
            if (typeof speakKnockedCue === 'function') speakKnockedCue();
            if (typeof triggerVibration === 'function') triggerVibration([180, 110, 180, 110, 180]);
        }
    } else {
        knockAlertModal.style.display = 'none';
        window.appGlobals.lastKnownKnockedBy = null;
    }
}

function updateKnockButtonState(lobby, me, isMyTurn) {
    const knockBtn = document.getElementById('knock-btn');
    if (!knockBtn) return;

    const activeCount = lobby.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;
    const myScore = (me && me.cards) ? window.calculateLocalScore(me.cards) : 0;
    const turnsConditionMet = !!lobby.canKnock;
    const scoreConditionMet = myScore >= threshold;
    const hasNotDrawn = me && me.cards && me.cards.length === 3; // Strict 3-card rule

    if (lobby.knockedBy) {
        knockBtn.disabled = true;
        knockBtn.innerText = `${lobby.knockedBy} knocked!`;
    } else if (!turnsConditionMet || !scoreConditionMet || !isMyTurn || !hasNotDrawn) {
        knockBtn.disabled = true;
        knockBtn.innerText = `Knock (${threshold}+)`;
    } else {
        knockBtn.disabled = false;
        knockBtn.innerText = 'Knock!';
    }
}

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

    if (typeof playSound === 'function') playSound('knock');
    if (typeof speakKnockedCue === 'function') speakKnockedCue();
    if (typeof triggerVibration === 'function') triggerVibration([180, 110, 180, 110, 180]);
    sendSocket({ type: 'KNOCK' });
};

// -------------------------------------------------------------
// 7. SIDE BETS & PEEKING DIALOGS
// -------------------------------------------------------------
window.tapSeat = function(targetUsername) {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    if (window.clientState.gameState === 'lobby') return;

    const isSpecOnly = window.clientState.isSpectator;
    const activeCount = window.clientState.activeParticipantsCount;

    if (isSpecOnly) {
        const modalTitle = document.getElementById('seat-action-title');
        const modalBody = document.getElementById('seat-action-body');
        if (modalTitle) modalTitle.innerText = `Actions for ${targetUsername}`;
        if (modalBody) {
            let actionsHtml = `<button style="background:#2563eb; padding:8px; font-size:0.85rem;" onclick="requestPeekFromModal('${targetUsername}')">🔍 Peek Hand</button>`;
            if (activeCount === 2) {
                actionsHtml += `<button style="background:#d97706; padding:8px; font-size:0.85rem; margin-top:6px;" onclick="betOnHimFromModal('${targetUsername}')">🤝 Bet on ${targetUsername}</button>`;
            }
            actionsHtml += `<button class="secondary" onclick="toggleModal('seat-action-modal')" style="margin-top:6px;">Cancel</button>`;
            modalBody.innerHTML = actionsHtml;
        }
        window.toggleModal('seat-action-modal');
        return;
    }

    if (activeCount >= 3) {
        if (targetUsername.toLowerCase() === activeUsername.toLowerCase()) return;
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (modalTitle) modalTitle.innerText = `First to Lose Bet on ${targetUsername}`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager that ${targetUsername} is eliminated before you:</p>
                <button onclick="submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
                <button onclick="submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
                <button onclick="submitEliminationProposal('${targetUsername}', 20)">$20 Wager</button>
                <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
            `;
        }
        window.toggleModal('bet-modal');
    } else if (activeCount === 2) {
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
                <button onclick="submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
                <button onclick="submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
                <button onclick="submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
                <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
            `;
        }
        window.toggleModal('bet-modal');
    }
};

window.requestPeekFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal');
    sendSocket({ type: 'REQUEST_PEEK', targetUsername });
    window.showCenterNotification(`Peek request sent to ${targetUsername}!`);
};

window.betOnHimFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
            <button onclick="submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
        `;
    }
    window.toggleModal('bet-modal');
};

window.submitEliminationProposal = function(target, wagerAmt) {
    sendSocket({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`First to lose bet proposed to ${target}!`);
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    sendSocket({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`Global bet offered on ${pickUser}!`);
};

window.acceptGlobalProposal = function(proposalId) { sendSocket({ type: 'ACCEPT_GLOBAL_PROPOSAL', proposalId }); };
window.confirmGlobalBet = function(proposalId, acceptedUser, confirmChoice) {
    sendSocket({ type: 'CONFIRM_GLOBAL_BET', proposalId, acceptedUser, confirm: !!confirmChoice });
    window.toggleModal('bet-modal');
};

window.openConfirmModal = function(proposalId, proposer, pickUser, acceptedUsers) {
    const modal = document.getElementById('bet-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Confirm Global Side Bet (${pickUser})`;

    const listHtml = (acceptedUsers || []).map(acc => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:6px; border-radius:6px; margin-bottom:4px;">
            <span><b>${acc}</b> accepted</span>
            <div style="display:flex; gap:4px;">
                <button style="font-size:0.7rem; padding:4px 8px; background:#10b981;" onclick="confirmGlobalBet('${proposalId}', '${acc}', true)">Confirm</button>
                <button class="danger" style="font-size:0.7rem; padding:4px 8px;" onclick="confirmGlobalBet('${proposalId}', '${acc}', false)">Decline</button>
            </div>
        </div>
    `).join('');

    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.80rem; color:var(--text-muted); margin-bottom:6px;">Players who accepted your proposal:</p>
            ${listHtml}
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:8px;">Close</button>
        `;
    }
    if (modal) modal.style.display = 'flex';
};

window.respondToBet = function(betId, accept) {
    sendSocket({ type: 'RESPOND_BET', betId, accept: !!accept });
    window.toggleModal('bet-modal');
};

// -------------------------------------------------------------
// 8. MASTER TABLE RENDER & GAME STATE WATCHDOG
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    const authScreen = document.getElementById('auth-screen');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const endBtn = document.getElementById('end-game-btn');
    const leaveBtn = document.getElementById('leave-lobby-btn');

    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    if (topRowBtns) topRowBtns.style.display = 'inline-flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (endBtn) endBtn.style.display = 'inline-block';
    if (leaveBtn) leaveBtn.style.display = 'inline-block';

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name} [${lobby.code}]`;

    if (lobby.chatHistory) {
        window.syncChatHistory(lobby.chatHistory);
    }

    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();

    // 1. CELEBRATION TRIGGER: HIT 31
    if (lobby.hit31Player) {
        if (window.appGlobals.lastCelebrated31 !== lobby.hit31Player) {
            window.appGlobals.lastCelebrated31 = lobby.hit31Player;
            if (typeof trigger31Celebration === 'function') {
                trigger31Celebration(lobby.hit31Player);
            } else if (typeof triggerWinnerCelebration === 'function') {
                triggerWinnerCelebration(lobby.hit31Player, "HIT 31!");
            }
        }
    } else {
        window.appGlobals.lastCelebrated31 = null;
    }

    // 2. CELEBRATION TRIGGER: TOURNAMENT END
    const isTournamentOver = (lobby.gameState === 'tournamentEnd') || (lobby.phaseMessage && lobby.phaseMessage.includes('TOURNAMENT WINNER'));
    if (isTournamentOver) {
        let winnerName = lobby.tournamentWinner || lobby.lastGameWinner;
        if (!winnerName && lobby.phaseMessage) {
            const m = lobby.phaseMessage.match(/TOURNAMENT WINNER!\s+(.*?)\s+wins/);
            if (m && m[1]) winnerName = m[1].trim();
        }
        if (winnerName && window.appGlobals.lastCelebratedWinner !== winnerName) {
            window.appGlobals.lastCelebratedWinner = winnerName;
            if (typeof triggerWinnerCelebration === 'function') {
                triggerWinnerCelebration(winnerName, "TOURNAMENT CHAMPION!");
            }
        }
    } else if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
        window.appGlobals.lastCelebratedWinner = null;
    }

    // 3. STATE TRANSITION NOTIFICATIONS
    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            const topleft = document.getElementById('discard-pickup-topleft-modal');
            const fedModal = document.getElementById('fed-card-topright-modal');
            if (topleft) topleft.style.display = 'none';
            if (fedModal) fedModal.style.display = 'none';
        }
    }

    // 4. LIVES VOTING MODAL
    const voteModal = document.getElementById('lives-vote-modal');
    if (voteModal) {
        if (lobby.livesVote && lobby.gameState === 'lobby') {
            const hasVoted = lobby.livesVote.votes && lobby.livesVote.votes[activeUsername] !== undefined;
            const isSeatedHuman = (lobby.players || []).some(p => p.username.toLowerCase() === activeUsername.toLowerCase() && !p.isBot);

            if (isSeatedHuman && !hasVoted) {
                const promptEl = document.getElementById('lives-vote-prompt');
                if (promptEl) {
                    promptEl.innerText = `${lobby.livesVote.proposer} proposed setting starting lives to ${lobby.livesVote.proposedLives}. Do you agree?`;
                }
                voteModal.style.display = 'flex';
            } else {
                voteModal.style.display = 'none';
            }
        } else {
            voteModal.style.display = 'none';
        }
    }

    const configLivesSelect = document.getElementById('config-lives');
    if (configLivesSelect && lobby.defaultLives) {
        configLivesSelect.value = String(lobby.defaultLives);
    }

    // 5. KNOCK VISUALS & ALERTS
    updateKnockAlertAndAudio(lobby);

    // 6. TOP IN-GAME FEEDS
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        if (topleftCardContent) {
            topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${window.formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
        }
        if (topleftModal) topleftModal.style.display = 'flex';
    } else if (topleftModal) {
        topleftModal.style.display = 'none';
    }

    const fedModal = document.getElementById('fed-card-topright-modal');
    const fedContent = document.getElementById('fed-card-content');
    const fedLabel = document.getElementById('fed-card-label');
    if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        if (fedLabel) fedLabel.innerText = `${lobby.myFedCardReminder.target} took your:`;
        if (fedContent) fedContent.innerHTML = window.formatCardHtml(lobby.myFedCardReminder.card, true);
        if (fedModal) fedModal.style.display = 'flex';
    } else if (fedModal) {
        fedModal.style.display = 'none';
    }

    // 7. CLIENT CACHES
    window.clientState.gameState = lobby.gameState;
    window.clientState.playersList = (lobby.players || []).map(p => p.username);
    window.clientState.spectatorsList = lobby.spectators || [];
    window.clientState.activeParticipantsCount = lobby.activeParticipantsCount || 3;
    window.clientState.tiedParticipantsList = lobby.tiedParticipantsList || [];
    window.clientState.activeBetsList = lobby.activeBets || [];
    window.clientState.pendingBetsList = lobby.pendingBets || [];
    window.clientState.sideBetLedger = lobby.sideBetLedger || {};
    window.clientState.mainGameLedger = lobby.mainGameLedger || {};
    window.clientState.botBetLedger = lobby.botBetLedger || {};

    const specCount = document.getElementById('spec-count');
    if (specCount) specCount.innerText = window.clientState.spectatorsList.length;

    const me = (lobby.players || []).find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isSpecUser = (lobby.spectators || []).some(s => s.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // 8. SPECTATOR PEEK INDICATOR
    const peekingBanner = document.getElementById('active-peeking-banner');
    let activelyPeekingTarget = null;
    if (isSpectatorOnly && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        (lobby.players || []).forEach(pl => {
            if (pl.peekAllowed && Object.keys(pl.peekAllowed).some(k => k.toLowerCase() === activeUsername.toLowerCase())) {
                activelyPeekingTarget = pl.username;
            }
        });
    }
    if (peekingBanner) {
        if (activelyPeekingTarget) {
            peekingBanner.style.display = 'inline-flex';
            const spanEl = peekingBanner.querySelector('span');
            if (spanEl) spanEl.innerText = `👀 Viewing ${activelyPeekingTarget}'s Hand`;
        } else {
            peekingBanner.style.display = 'none';
        }
    }

    if (me) {
        window.clientState.isReady = me.ready;
        const readyBtn = document.getElementById('ready-btn');
        if (readyBtn) readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';

        if (me.peekIncoming && Object.keys(me.peekIncoming).length > 0) {
            const requester = Object.keys(me.peekIncoming)[0];
            const peekModal = document.getElementById('peek-request-modal');
            const pMsg = document.getElementById('peek-modal-msg');
            const pAllow = document.getElementById('peek-allow-btn');
            const pDeny = document.getElementById('peek-deny-btn');

            if (pMsg) pMsg.innerText = `${requester} wants to peek at your hand.`;
            if (pAllow) {
                pAllow.onclick = () => {
                    sendSocket({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: true });
                    window.toggleModal('peek-request-modal');
                };
            }
            if (pDeny) {
                pDeny.onclick = () => {
                    sendSocket({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: false });
                    window.toggleModal('peek-request-modal');
                };
            }
            if (peekModal) peekModal.style.display = 'flex';
        }
    }

    // 9. ACTION BAR CONTROLS
    const standUpBtn = document.getElementById('stand-up-btn');
    const sitBtn = document.getElementById('sit-btn');
    const readyBtn = document.getElementById('ready-btn');
    const knockBtn = document.getElementById('knock-btn');

    if (lobby.gameState === 'lobby') {
        if (me) {
            if (standUpBtn) standUpBtn.style.display = 'inline-block';
            if (sitBtn) sitBtn.style.display = 'none';
            if (readyBtn) readyBtn.style.display = 'inline-block';
            if (knockBtn) knockBtn.style.display = 'none';
        } else {
            if (standUpBtn) standUpBtn.style.display = 'none';
            if (readyBtn) readyBtn.style.display = 'none';
            if (knockBtn) knockBtn.style.display = 'none';
            if (sitBtn) {
                sitBtn.style.display = 'inline-block';
                sitBtn.disabled = (lobby.players || []).length >= 6;
            }
        }
    } else {
        if (sitBtn) sitBtn.style.display = 'none';
        if (isSpectatorOnly) {
            if (standUpBtn) standUpBtn.style.display = 'none';
            if (readyBtn) readyBtn.style.display = 'none';
            if (knockBtn) knockBtn.style.display = 'none';
        } else {
            if (standUpBtn) standUpBtn.style.display = 'none';
            if (readyBtn) readyBtn.style.display = 'none';
            if (knockBtn) knockBtn.style.display = 'inline-block';
        }
    }

    // 10. TURN ACTION & yourturn.mp3 TRIGGER
    const isMyTurnPlaying = ((lobby.currentTurnUser || '').toLowerCase() === activeUsername.toLowerCase()) && 
        (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');

    if (isMyTurnPlaying) {
        if (!window.appGlobals.wasMyTurn) {
            window.appGlobals.wasMyTurn = true;
            if (typeof playYourTurnCue === 'function') {
                playYourTurnCue();
            } else if (typeof playSound === 'function') {
                playSound('yourturn');
            }
            if (typeof triggerVibration === 'function') triggerVibration([60, 40, 60]);
        }
    } else {
        window.appGlobals.wasMyTurn = false;
    }

    updateKnockButtonState(lobby, me, isMyTurnPlaying);

    // 11. SIDE BET PROPOSALS
    const sidebar = document.getElementById('global-side-bets-sidebar');
    const sidebarList = document.getElementById('global-side-bets-list');
    const globalProps = lobby.globalProposals || [];

    if (globalProps.length > 0 && lobby.gameState !== 'lobby') {
        if (sidebar) sidebar.style.display = 'flex';
        let sidebarHtml = '';
        globalProps.forEach(gp => {
            const isMyProp = (gp.proposer === activeUsername);
            const alreadyAccepted = gp.acceptedBy && gp.acceptedBy.includes(activeUsername);

            let actionHtml = '';
            if (isMyProp) {
                if (gp.acceptedBy && gp.acceptedBy.length > 0) {
                    actionHtml = `<button style="font-size:0.65rem; padding:3px 6px; background:#38bdf8; color:#0f172a; margin-top:4px;" onclick="openConfirmModal('${gp.id}', '${gp.proposer}', '${gp.pickUser}', ${JSON.stringify(gp.acceptedBy).replace(/"/g, '&quot;')})">Review (${gp.acceptedBy.length})</button>`;
                } else {
                    actionHtml = `<span style="color:var(--text-muted); font-size:0.65rem;">Waiting for acceptances...</span>`;
                }
            } else {
                if (!alreadyAccepted) {
                    actionHtml = `<button style="font-size:0.7rem; padding:3px 6px; background:#10b981; margin-top:4px;" onclick="acceptGlobalProposal('${gp.id}')">You got it</button>`;
                } else {
                    actionHtml = `<span style="color:#34d399; font-size:0.65rem;">Accepted ("You got it")</span>`;
                }
            }

            sidebarHtml += `
                <div class="global-bet-item">
                    <span>I like <b>${gp.pickUser}</b> for <b>$${gp.wagerAmt}</b> (${gp.proposer})</span>
                    ${actionHtml}
                </div>
            `;
        });
        if (sidebarList) sidebarList.innerHTML = sidebarHtml;
    } else if (sidebar) {
        sidebar.style.display = 'none';
    }

    const bModal = document.getElementById('bet-modal');
    const isModalOpen = bModal && bModal.style.display === 'flex';
    if (lobby.pendingBetsForMe && lobby.pendingBetsForMe.length > 0 && !isModalOpen) {
        lobby.pendingBetsForMe.forEach(bet => {
            const label = bet.type === 'win' ? `Side Bet: ${bet.proposer} bets $${bet.wagerAmt} that you win round.` : `First Out Bet: ${bet.proposer} bets $${bet.wagerAmt} that ${bet.pickUser} is eliminated before ${bet.targetSurvivor}.`;
            const mTitle = document.getElementById('bet-modal-title');
            const mBody = document.getElementById('bet-modal-body');

            if (mTitle) mTitle.innerText = `Incoming Bet Proposal from ${bet.proposer}`;
            if (mBody) {
                mBody.innerHTML = `
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">${label}</p>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button onclick="respondToBet('${bet.id}', true)">Accept</button>
                        <button class="danger" onclick="respondToBet('${bet.id}', false)">Decline</button>
                    </div>
                `;
            }
            if (bModal) bModal.style.display = 'flex';
        });
        lobby.pendingBetsForMe = [];
    }

    // 12. POTS & CONFIG
    const configBar = document.getElementById('lobby-config-bar');
    if (configBar) configBar.style.display = (lobby.gameState === 'lobby') ? 'flex' : 'none';

    const potBanner = document.getElementById('pot-total-banner');
    if (potBanner) potBanner.innerText = `Pot: $${lobby.potTotal || 0}`;

    const sidePotBanner = document.getElementById('side-pot-total-banner');
    if (sidePotBanner) {
        if (lobby.sidePotTotal && lobby.sidePotTotal > 0) {
            sidePotBanner.innerText = `Side Pots: $${lobby.sidePotTotal}`;
            sidePotBanner.style.display = 'block';
        } else {
            sidePotBanner.style.display = 'none';
        }
    }

    // 13. NEXT HAND OVERLAY (Guaranteed active player visibility & 8s auto-countdown)
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    const nextBtn = document.getElementById('next-hand-btn');

    if (lobby.gameState === 'roundOver') {
        const myPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
        const isPermanentlyOut = myPlayer && myPlayer.eliminated;

        if (lobby.activeParticipantsCount <= 1) {
            if (nextHandOverlay) nextHandOverlay.style.display = 'block';
            if (nextBtn) {
                nextBtn.innerText = 'Returning to Ready Room...';
                nextBtn.disabled = true;
            }
        } else if (myPlayer && !isPermanentlyOut) {
            if (nextHandOverlay) nextHandOverlay.style.display = 'block';
            if (nextBtn) {
                if (myPlayer.nextHandReady) {
                    nextBtn.innerText = 'Waiting for players (Auto in 8s)...';
                    nextBtn.disabled = true;
                } else {
                    nextBtn.innerText = 'Next Hand (Auto in 8s)';
                    nextBtn.disabled = false;
                }
            }
        } else if (nextHandOverlay) {
            nextHandOverlay.style.display = 'none';
        }
    } else if (nextHandOverlay) {
        nextHandOverlay.style.display = 'none';
    }

    // 14. DEALER DRAW & TIE BREAKER MODALS
    const poolModal = document.getElementById('pool-draw-modal');
    const revealModal = document.getElementById('tie-breaker-reveal-modal');
    const turnBanner = document.getElementById('turn-banner');

    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        window.showCenterNotification(lobby.phaseMessage);
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
    }

    if (lobby.gameState === 'dealerDraw') {
        if (poolModal) poolModal.style.display = 'flex';
        if (revealModal) revealModal.style.display = 'none';

        const pTitle = document.getElementById('pool-modal-title');
        const pInstr = document.getElementById('pool-modal-instruction');
        if (pTitle) pTitle.innerText = 'Picking for Dealer';
        if (pInstr) pInstr.innerText = lobby.phaseMessage || 'Select a card from the deck pool.';

        let gridHtml = '';
        (lobby.drawPool || []).forEach((slot) => {
            if (slot.chosenBy) {
                const revealedCard = lobby.drawResults?.[slot.chosenBy];
                const cardHtmlStr = revealedCard ? window.formatCardHtml(revealedCard, true) : '';
                gridHtml += `<div class="pool-card-item revealed" style="background:#fff; border-radius:4px; padding:3px; text-align:center;"><span style="font-size:0.55rem; color:#475569;">${slot.chosenBy}</span>${cardHtmlStr}</div>`;
            } else {
                const clickable = !lobby.drawResults?.[activeUsername] && !window.appGlobals.hasChosenPoolCard;
                gridHtml += `<div class="pool-card-item" ${clickable ? `onclick="choosePoolCard(${slot.index})"` : ''} style="${!clickable ? 'opacity:0.4; cursor:not-allowed;' : ''}">?</div>`;
            }
        });
        const poolContainer = document.getElementById('pool-cards-container');
        if (poolContainer) poolContainer.innerHTML = gridHtml;
        if (turnBanner) turnBanner.innerText = 'Dealer Draw Phase';
    } else if (lobby.gameState === 'tieBreaker') {
        if (poolModal) poolModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'flex';

        const isTied = (lobby.tiedParticipantsList || []).includes(activeUsername);
        const tMsg = document.getElementById('tie-breaker-stream-msg');
        if (tMsg) tMsg.innerText = isTied ? 'You are tied! Pick your tie-breaker card below:' : 'Waiting for tied participants to draw cards...';

        let streamHtml = '';
        if (isTied && !lobby.drawResults?.[activeUsername]) {
            streamHtml += `<div style="width:100%; display:grid; grid-template-columns: repeat(auto-fill, minmax(32px, 1fr)); gap:4px; margin-bottom:8px;">`;
            (lobby.drawPool || []).forEach((slot) => {
                if (!slot.chosenBy) {
                    streamHtml += `<div class="pool-card-item" onclick="choosePoolCard(${slot.index})">?</div>`;
                }
            });
            streamHtml += `</div>`;
        }

        (lobby.tiedParticipantsList || []).forEach(uname => {
            const card = lobby.drawResults?.[uname];
            streamHtml += `<div style="text-align:center; padding:4px;"><b>${uname}</b>: ${card ? window.formatCardHtml(card, true) : '<i>Choosing...</i>'}</div>`;
        });
        const tGrid = document.getElementById('tie-breaker-stream-grid');
        if (tGrid) tGrid.innerHTML = streamHtml;
        if (turnBanner) turnBanner.innerText = 'Tie-Breaker Draw';
    } else {
        if (poolModal) poolModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'none';
        if (turnBanner) {
            if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
                turnBanner.innerText = isMyTurnPlaying ? "YOUR TURN!" : `Turn: ${lobby.currentTurnUser}`;
            } else if (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd') {
                turnBanner.innerText = lobby.phaseMessage || 'Round Over';
            }
        }
    }

    // 15. CENTER TABLE & DIAMOND-LATTICE DECK RENDER
    const tableContainer = document.getElementById('table-oval-container');
    if (tableContainer) {
        let discardSlotHtml = '';
        if (lobby.discardTop) {
            const dVal = lobby.discardTop.val || '';
            const dSuit = normalizeSuit(lobby.discardTop.suit);
            const dIsRed = (dSuit === '♥' || dSuit === '♦');
            const dClass = dIsRed ? 'red-suit' : 'black-suit';

            discardSlotHtml = `
                <div class="card-slot playing-card ${dClass}" onclick="drawCard('discard')">
                    <div class="card-corner top-left">
                        <span class="corner-val">${dVal}</span>
                        <span class="corner-suit">${dSuit}</span>
                    </div>
                    <div class="card-center-pip">${dSuit}</div>
                    <div class="card-corner bottom-right">
                        <span class="corner-val">${dVal}</span>
                        <span class="corner-suit">${dSuit}</span>
                    </div>
                </div>
            `;
        } else {
            discardSlotHtml = `<div class="card-slot empty-slot" onclick="drawCard('discard')"><span>DISCARD</span></div>`;
        }

        let html = `
            <div class="pots-container">
                <div class="pot-total-display" id="pot-total-banner">Pot: $${lobby.potTotal || 0}</div>
                <div class="side-pot-total-display" id="side-pot-total-banner" style="display:${lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none'};">Side Pots: $${lobby.sidePotTotal || 0}</div>
            </div>
            <div class="deck-center" id="deck-center">
                <div class="card-slot back" id="deck-pile" onclick="drawCard('deck')">
                    <div class="card-back-inner"></div>
                    <span class="deck-counter-badge" id="deck-count-display">${lobby.deckCount || 0} left</span>
                </div>
                ${discardSlotHtml}
            </div>
        `;

        (lobby.players || []).forEach((p, idx) => {
            const revealedCardsHtml = p.cards && p.cards.length > 0 ? `<div class="seat-cards">${p.cards.map(c => window.formatCardHtml(c, true)).join('')}</div>` : '';
            const statusBadge = p.eliminated ? ' [OUT]' : '';
            const readyStatusIcon = p.ready ? '✅' : '❌';
            const botBadge = p.isBot ? ' 🤖' : '';
            const isCurrent = (p.username.toLowerCase() === (lobby.currentTurnUser || '').toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
            const isDealer = (idx === lobby.dealerIndex) || (lobby.dealerName === p.username);
            const dealerBadgeHtml = isDealer ? `<span class="dealer-badge">D</span>` : '';
            const micIcon = p.inVC ? (p.isMuted ? ' 🔇' : ' 🎙️') : '';

            let peekerBadgesHtml = '';
            if (p.username.toLowerCase() === activeUsername.toLowerCase() && p.peekAllowed) {
                const peekers = Object.keys(p.peekAllowed);
                if (peekers.length > 0) {
                    peekerBadgesHtml = `<div style="display:flex; gap:2px; flex-wrap:wrap; justify-content:center; margin-top:2px;">${peekers.map(pk => `<span style="background:#ef4444; color:#fff; padding:1px 3px; border-radius:3px; font-size:0.5rem; cursor:pointer;" onclick="kickPeekerAction('${pk}')" title="Click to kick">Kick ${pk} ✕</span>`).join('')}</div>`;
                }
            }

            html += `
                <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}">
                    <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                        <span>${readyStatusIcon}</span> <b>${p.username}${botBadge}${statusBadge}</b>${dealerBadgeHtml}${micIcon}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                    </div>
                    ${revealedCardsHtml}
                    ${peekerBadgesHtml}
                </div>
            `;
        });

        tableContainer.innerHTML = html;
        if (nextHandOverlay) tableContainer.appendChild(nextHandOverlay);
    }

    // 16. LOCAL HAND RENDERING WITH AUTHENTIC PLAYING CARDS
    const handContainer = document.getElementById('my-cards-container');
    const scoreDisplay = document.getElementById('my-score-display');
    if (me && me.cards && handContainer) {
        handContainer.innerHTML = me.cards.map((c, i) => {
            const val = c.val || '';
            const suit = normalizeSuit(c.suit);
            const isRed = (suit === '♥' || suit === '♦');
            const suitClass = isRed ? 'red-suit' : 'black-suit';

            return `
                <div class="my-card playing-card ${suitClass}" onclick="discardCard(${i})">
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
        }).join('');

        if (scoreDisplay) scoreDisplay.innerText = window.calculateLocalScore(me.cards);
    } else if (handContainer) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.innerText = '0';
    }
};

window.renderLobbyState = window.updateUIFromLobby;

// Global Window Bindings
window.drawCard = drawCard;
window.drawFromDeck = drawFromDeck;
window.drawFromDiscard = drawFromDiscard;
window.discardCard = discardCard;
window.choosePoolCard = choosePoolCard;
window.clickNextHand = clickNextHand;
window.toggleReady = toggleReady;
window.standUp = standUp;
window.sitDown = sitDown;
window.updateWager = updateWager;
window.updateSettings = updateSettings;
window.submitLivesVote = submitLivesVote;
window.addBot = addBot;
window.removeBot = removeBot;
window.proposeEndGame = proposeEndGame;
window.leaveLobby = leaveLobby;
window.resetToMainMenu = resetToMainMenu;
window.tapSeat = tapSeat;
window.requestPeekFromModal = requestPeekFromModal;
window.betOnHimFromModal = betOnHimFromModal;
window.submitEliminationProposal = submitEliminationProposal;
window.submitGlobalProposal = submitGlobalProposal;
window.acceptGlobalProposal = acceptGlobalProposal;
window.confirmGlobalBet = confirmGlobalBet;
window.openConfirmModal = openConfirmModal;
window.respondToBet = respondToBet;
window.stopPeekingAction = stopPeekingAction;
window.kickPeekerAction = kickPeekerAction;
