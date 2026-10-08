// public/js/ui.js

// Safe message dispatcher that preserves network.js connection queues
function sendMsg(msgObj) {
    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(msgObj);
    } else if (typeof window.sendSocketMessage === 'function') {
        window.sendSocketMessage(msgObj);
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(msgObj));
    } else if (window.appGlobals?.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(msgObj));
    }
}

/**
 * Normalizes card data (object or shorthand string) and produces authentic playing card markup
 * @param {string|object} card - e.g. "10H", { val: "A", suit: "♠" }
 * @param {boolean} isMini - if true, renders compact format for seat previews
 * @param {string} extraClass - optional classes like 'discard-card'
 * @param {string} clickAttr - optional inline click handler
 */
function formatCardHtml(card, isMini = false, extraClass = '', clickAttr = '') {
    if (!card) {
        return `<div class="card-slot empty-slot ${extraClass}" ${clickAttr}><span>Empty</span></div>`;
    }

    let val = '';
    let rawSuit = '';

    if (typeof card === 'string') {
        const raw = card.trim().toUpperCase();
        rawSuit = raw.slice(-1);
        val = raw.slice(0, -1);
    } else if (typeof card === 'object') {
        val = card.val || card.value || card.rank || '';
        rawSuit = card.suit || '';
    }

    const suitMap = {
        'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣',
        '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣'
    };
    const suit = suitMap[rawSuit] || rawSuit;
    const isRed = ['♥', '♦', 'H', 'D'].includes(rawSuit) || suit === '♥' || suit === '♦';
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    if (isMini) {
        return `
            <div class="mini-card ${suitClass} ${extraClass}" ${clickAttr}>
                <span class="mini-val">${val}</span>
                <span class="mini-suit">${suit}</span>
            </div>
        `;
    }

    return `
        <div class="playing-card ${suitClass} ${extraClass}" ${clickAttr}>
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
}

function calculateLocalScore(cards) {
    if (!cards || cards.length === 0) return 0;
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    const sums = {};
    scoringCards.forEach(c => {
        const suitMap = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
        const s = suitMap[c.suit] || c.suit;
        sums[s] = (sums[s] || 0) + (c.points || 0);
    });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
}

function showCenterNotification(msg) {
    const banner = document.getElementById('center-notification-banner') || document.getElementById('phase-message-display');
    if (!banner) return;
    banner.innerText = msg;
    banner.style.display = 'block';
    if (!window.appGlobals) window.appGlobals = {};
    if (window.appGlobals.notificationTimer) clearTimeout(window.appGlobals.notificationTimer);
    window.appGlobals.notificationTimer = setTimeout(() => {
        banner.style.display = 'none';
    }, 2800);
}

function toggleModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = m.style.display === 'flex' ? 'none' : 'flex';
}

function renderLobbyList(lobbies) {
    const container = document.getElementById('lobby-list') || document.getElementById('lobbies-list-container');
    if (!container) return;
    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:8px; font-size:0.8rem;">No active tables found. Create one!</div>';
        return;
    }
    container.innerHTML = lobbies.map(l => `
        <div class="lobby-item" onclick="joinLobbyCode('${l.code}')">
            <span><b>${l.name || l.code}</b> (${l.count || l.playerCount || 1}/6) - ${l.state || l.gameState || 'Open'}</span>
            <span style="color:#38bdf8; font-weight:bold;">Join</span>
        </div>
    `).join('');
}

function updateKnockAlertAndAudio(lobby) {
    const knockAlertModal = document.getElementById('knock-alert-modal');
    if (!knockAlertModal) return;

    if (lobby.knockedBy && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn')) {
        knockAlertModal.innerText = `🔔 ${lobby.knockedBy.toUpperCase()} HAS KNOCKED!`;
        knockAlertModal.style.display = 'block';

        if (!window.appGlobals) window.appGlobals = {};
        if (window.appGlobals.lastKnownKnockedBy !== lobby.knockedBy) {
            window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
            if (typeof playSound === 'function') playSound('knock');
            if (typeof speakKnockedCue === 'function') speakKnockedCue();
            if (typeof triggerVibration === 'function') triggerVibration([180, 110, 180, 110, 180]);
        }
    } else {
        knockAlertModal.style.display = 'none';
        if (window.appGlobals) window.appGlobals.lastKnownKnockedBy = null;
    }
}

function updateKnockButtonState(lobby, me, isMyTurn) {
    const knockBtn = document.getElementById('knock-btn');
    if (!knockBtn) return;

    const activeCount = lobby.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;
    const myScore = me?.cards ? calculateLocalScore(me.cards) : 0;
    const turnsConditionMet = !!lobby.canKnock;
    const scoreConditionMet = myScore >= threshold;
    const hasNotDrawn = me && me.cards && me.cards.length === 3;

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

// Action Handlers
function drawCard(source) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    sendMsg({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD', source });
}
function drawFromDeck() { drawCard('deck'); }
function drawFromDiscard() { drawCard('discard'); }

function discardCard(index) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    sendMsg({ type: 'DISCARD_CARD', index: index, cardIndex: index });
}

function choosePoolCard(cardIndex) {
    if (window.appGlobals?.hasChosenPoolCard) return;
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.hasChosenPoolCard = true;
    sendMsg({ type: 'CHOOSE_POOL_CARD', index: cardIndex, cardIndex });
}

function knockRound() {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState?.username;
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername?.toLowerCase());

    if (!me || !me.cards || me.cards.length !== 3) {
        showCenterNotification("You cannot knock after picking up a card!");
        return;
    }

    const currentScore = calculateLocalScore(me.cards);
    const activeCount = window.clientState?.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;

    if (currentScore < threshold) {
        showCenterNotification(`Need at least ${threshold} points to knock!`);
        return;
    }

    if (currentScore <= 30) {
        const confirmKnock = confirm(`Knock Confirmation: Are you sure you want to knock with ${currentScore} points?`);
        if (!confirmKnock) return;
    }

    sendMsg({ type: 'KNOCK' });
}

function toggleReady() {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState?.username;
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername?.toLowerCase());
    const isReady = me ? !me.ready : !window.clientState?.isReady;
    
    if (window.clientState) window.clientState.isReady = isReady;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = isReady ? 'Unready' : 'Ready Up';
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.hasChosenPoolCard = false;
    
    sendMsg({ type: 'SET_READY', ready: isReady });
}

function standUp() { sendMsg({ type: 'STAND_UP' }); }
function sitDown() { sendMsg({ type: 'SIT_DOWN' }); }

function clickNextHand() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    sendMsg({ type: 'NEXT_HAND_READY' });
}

function proposeEndGame() {
    if (confirm("Propose ending the match?")) {
        sendMsg({ type: 'END_GAME_PROPOSAL' });
    }
}

function leaveLobby() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    sendMsg({ type: 'LEAVE_LOBBY' });
    resetToMainMenu();
}

function createLobby(isPrivate = false) {
    try {
        const usernameEl = document.getElementById('username-input');
        const lobbyNameEl = document.getElementById('lobby-name-input');
        const privateEl = document.getElementById('private-lobby-checkbox');

        const username = (usernameEl && usernameEl.value.trim()) || window.clientState?.username || 'Player1';
        const lobbyName = (lobbyNameEl && lobbyNameEl.value.trim()) || `${username}'s Table`;
        const isPriv = privateEl ? privateEl.checked : isPrivate;

        if (window.clientState) window.clientState.username = username;
        sendMsg({ type: 'CREATE_LOBBY', username, lobbyName, name: lobbyName, isPrivate: isPriv });
    } catch (err) {
        console.error("Error creating lobby:", err);
    }
}

function joinLobby() {
    const codeEl = document.getElementById('lobby-code-input') || document.getElementById('join-code-input');
    const code = codeEl ? codeEl.value.trim().toUpperCase() : '';
    if (!code) {
        alert("Please enter a table code");
        return;
    }
    joinLobbyCode(code);
}

function joinLobbyCode(code) {
    if (!code) return;
    const cleanCode = code.trim().toUpperCase();
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.currentJoinedCode = cleanCode;
    const usernameEl = document.getElementById('username-input');
    const username = (usernameEl && usernameEl.value.trim()) || window.clientState?.username || 'Player1';
    if (window.clientState) window.clientState.username = username;
    sendMsg({ type: 'JOIN_LOBBY', code: cleanCode, username });
}

function addBot() { sendMsg({ type: 'ADD_BOT' }); }
function removeBot() { sendMsg({ type: 'REMOVE_BOT' }); }

function updateWager() {
    const wagerEl = document.getElementById('config-wager');
    const wager = wagerEl ? wagerEl.value : 5;
    sendMsg({ type: 'UPDATE_WAGER', wager: Number(wager) });
    sendMsg({ type: 'UPDATE_CONFIG', wager: Number(wager) });
}

function updateSettings() {
    const livesEl = document.getElementById('config-lives');
    const lives = livesEl ? livesEl.value : 3;
    sendMsg({ type: 'UPDATE_SETTINGS', lives: Number(lives) });
    sendMsg({ type: 'UPDATE_CONFIG', lives: Number(lives) });
}

function refreshLobbies() { sendMsg({ type: 'GET_LOBBIES' }); }

function toggleVoiceOnOff() {
    if (typeof window.toggleLiveKitVoice === 'function') {
        window.toggleLiveKitVoice();
    } else if (typeof window.toggleVoice === 'function') {
        window.toggleVoice();
    } else if (typeof window.toggleLiveKitMute === 'function') {
        window.toggleLiveKitMute();
    }
}

function openSettingsModal() { toggleModal('settings-modal'); }
function openActiveBetsModal() { toggleModal('active-bets-modal'); }
function openVcParticipantsModal() { toggleModal('vc-participants-modal'); }
function openSpectatorListModal() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState?.spectatorsList || [];
    if (content) {
        content.innerHTML = specs.length === 0 ? 'No spectators.' : '<ul>' + specs.map(s => `<li style="margin-bottom:3px;"><b>${s.username || s}</b></li>`).join('') + '</ul>';
    }
    toggleModal('spectators-modal');
}
function openLedgerModal() {
    if (typeof window.renderLedgerData === 'function') window.renderLedgerData();
    toggleModal('ledger-modal');
}

function toggleChatWindow() {
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
    }
}

function toggleGlobalSidebar() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) sidebar.style.display = sidebar.style.display === 'none' ? 'flex' : 'none';
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        sendMsg({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
    }
}

function appendChatMessage(user, msg) {
    const box = document.getElementById('chat-messages');
    if (box) {
        box.innerHTML += `<div><b>${user}:</b> ${msg}</div>`;
        box.scrollTop = box.scrollHeight;
    }
    const win = document.getElementById('chat-window');
    if (win && win.style.display !== 'flex') {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
}

function stopPeekingAction() {
    sendMsg({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
}

function tapSeat(targetUsername) {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState?.username;
    if (window.clientState?.gameState === 'lobby') return;
    if (targetUsername.toLowerCase() === activeUsername.toLowerCase()) return;

    const isSpecOnly = window.clientState?.isSpectator;
    const activeCount = window.clientState?.activeParticipantsCount || 3;

    if (isSpecOnly) {
        const modalTitle = document.getElementById('seat-action-title');
        const modalBody = document.getElementById('seat-action-body');
        if (modalTitle && modalBody) {
            modalTitle.innerText = `Actions for ${targetUsername}`;
            let actionsHtml = `<button style="background:#2563eb; padding:8px; font-size:0.85rem;" onclick="requestPeekFromModal('${targetUsername}')">🔍 Peek Hand</button>`;
            if (activeCount === 2) {
                actionsHtml += `<button style="background:#d97706; padding:8px; font-size:0.85rem; margin-top:6px;" onclick="betOnHimFromModal('${targetUsername}')">🤝 Bet on ${targetUsername}</button>`;
            }
            actionsHtml += `<button class="secondary" onclick="toggleModal('seat-action-modal')" style="margin-top:6px;">Cancel</button>`;
            modalBody.innerHTML = actionsHtml;
            toggleModal('seat-action-modal');
        }
        return;
    }

    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (!modalTitle || !modalBody) return;

    if (activeCount >= 3) {
        modalTitle.innerText = `First to Lose Bet on ${targetUsername}`;
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount that ${targetUsername} loses before you:</p>
            <button onclick="submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
            <button onclick="submitEliminationProposal('${targetUsername}', 20)">$20 Wager</button>
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
        `;
        toggleModal('bet-modal');
    } else if (activeCount === 2) {
        modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
            <button onclick="submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
        `;
        toggleModal('bet-modal');
    }
}

function requestPeekFromModal(targetUsername) {
    toggleModal('seat-action-modal');
    sendMsg({ type: 'REQUEST_PEEK', targetUsername });
    showCenterNotification(`Peek request sent to ${targetUsername}!`);
}

function betOnHimFromModal(targetUsername) {
    toggleModal('seat-action-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle && modalBody) {
        modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
            <button onclick="submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
        `;
        toggleModal('bet-modal');
    }
}

function submitEliminationProposal(target, wagerAmt) {
    sendMsg({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt: Number(wagerAmt) });
    toggleModal('bet-modal');
    showCenterNotification(`First to lose bet proposed to ${target}!`);
}

function submitGlobalProposal(pickUser, wagerAmt) {
    sendMsg({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt: Number(wagerAmt) });
    toggleModal('bet-modal');
    showCenterNotification(`Global bet offered on ${pickUser}!`);
}

function acceptGlobalProposal(proposalId) { sendMsg({ type: 'ACCEPT_GLOBAL_PROPOSAL', proposalId }); }
function confirmGlobalBet(proposalId, acceptedUser, confirmChoice) {
    sendMsg({ type: 'CONFIRM_GLOBAL_BET', proposalId, acceptedUser, confirm: confirmChoice });
    toggleModal('bet-modal');
}

function openConfirmModal(proposalId, proposer, pickUser, acceptedUsers) {
    const modal = document.getElementById('bet-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (!modal || !modalTitle || !modalBody) return;

    modalTitle.innerText = `Confirm Global Side Bet (${pickUser})`;
    const listHtml = (acceptedUsers || []).map(acc => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:6px; border-radius:6px; margin-bottom:4px;">
            <span><b>${acc}</b> accepted</span>
            <div style="display:flex; gap:4px;">
                <button style="font-size:0.7rem; padding:4px 8px; background:#10b981;" onclick="confirmGlobalBet('${proposalId}', '${acc}', true)">Confirm</button>
                <button class="danger" style="font-size:0.7rem; padding:4px 8px;" onclick="confirmGlobalBet('${proposalId}', '${acc}', false)">Decline</button>
            </div>
        </div>
    `).join('');

    modalBody.innerHTML = `
        <p style="font-size:0.80rem; color:var(--text-muted); margin-bottom:6px;">Players who accepted your proposal:</p>
        ${listHtml}
        <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:8px;">Close</button>
    `;
    modal.style.display = 'flex';
}

function respondToBet(betId, accept) {
    sendMsg({ type: 'RESPOND_BET', betId, accept });
    toggleModal('bet-modal');
}

// Master UI Update Loop
function updateUIFromLobby(lobby) {
    if (!window.appGlobals) window.appGlobals = {};
    if (!window.clientState) window.clientState = {};

    window.appGlobals.latestLobbySnapshot = lobby;

    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';

    const endGameBtn = document.getElementById('end-game-btn');
    const leaveLobbyBtn = document.getElementById('leave-lobby-btn');
    if (endGameBtn) endGameBtn.style.display = 'inline-block';
    if (leaveLobbyBtn) leaveLobbyBtn.style.display = 'inline-block';

    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'inline-flex';

    const inGameBtns = document.getElementById('in-game-header-btns') || document.getElementById('in-game-top-row-btns');
    if (inGameBtns) inGameBtns.style.display = 'flex';

    const inGameTools = document.getElementById('in-game-tools-row');
    if (inGameTools) inGameTools.style.display = 'flex';

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name || lobby.code} [${lobby.code}]`;

    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username || 'Player1';

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

    updateKnockAlertAndAudio(lobby);

    // Initial Discard Pickup Tracker
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        if (topleftCardContent) {
            topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
        }
        if (topleftModal) topleftModal.style.display = 'flex';
    } else if (topleftModal) {
        topleftModal.style.display = 'none';
    }

    // Fed Card Reminder Tracker
    const fedModal = document.getElementById('fed-card-topright-modal');
    const fedContent = document.getElementById('fed-card-content');
    const fedLabel = document.getElementById('fed-card-label');
    if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        if (fedLabel) fedLabel.innerText = `${lobby.myFedCardReminder.target} took your:`;
        if (fedContent) fedContent.innerHTML = formatCardHtml(lobby.myFedCardReminder.card, true);
        if (fedModal) fedModal.style.display = 'flex';
    } else if (fedModal) {
        fedModal.style.display = 'none';
    }

    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        showCenterNotification(lobby.phaseMessage);
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
    }

    window.clientState.gameState = lobby.gameState;
    window.clientState.playersList = (lobby.players || []).map(p => p.username);
    window.clientState.spectatorsList = lobby.spectators || [];
    window.clientState.activeParticipantsCount = lobby.activeParticipantsCount || 3;
    window.clientState.tiedParticipantsList = lobby.tiedParticipantsList || [];
    window.clientState.activeBetsList = lobby.activeBets || [];
    window.clientState.pendingBetsList = lobby.pendingBets || [];

    const specCountEl = document.getElementById('spec-count');
    if (specCountEl) specCountEl.innerText = window.clientState.spectatorsList.length;

    const me = (lobby.players || []).find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isSpecUser = (lobby.spectators || []).some(s => (s.username || s).trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // Incoming Peek Requests
    if (me && me.peekIncoming && Object.keys(me.peekIncoming).length > 0) {
        const requester = Object.keys(me.peekIncoming)[0];
        const peekModal = document.getElementById('peek-request-modal');
        const msgEl = document.getElementById('peek-modal-msg');
        if (msgEl) msgEl.innerText = `${requester} wants to peek at your hand.`;
        const allowBtn = document.getElementById('peek-allow-btn');
        if (allowBtn) {
            allowBtn.onclick = () => {
                sendMsg({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: true });
                toggleModal('peek-request-modal');
            };
        }
        const denyBtn = document.getElementById('peek-deny-btn');
        if (denyBtn) {
            denyBtn.onclick = () => {
                sendMsg({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: false });
                toggleModal('peek-request-modal');
            };
        }
        if (peekModal) peekModal.style.display = 'flex';
    }

    // Seating & Ready Button States
    const standUpBtn = document.getElementById('stand-up-btn');
    const sitBtn = document.getElementById('sit-btn');
    const readyBtn = document.getElementById('ready-btn');
    const knockBtn = document.getElementById('knock-btn');

    if (lobby.gameState === 'lobby') {
        if (me && !isEliminated) {
            if (standUpBtn) standUpBtn.style.display = 'inline-block';
            if (sitBtn) sitBtn.style.display = 'none';
            if (readyBtn) {
                readyBtn.style.display = 'inline-block';
                readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';
            }
            if (knockBtn) knockBtn.style.display = 'none';
        } else {
            if (standUpBtn) standUpBtn.style.display = 'none';
            if (readyBtn) readyBtn.style.display = 'none';
            if (knockBtn) knockBtn.style.display = 'none';
            if (sitBtn) {
                sitBtn.style.display = (isSpecUser || !me) ? 'inline-block' : 'none';
                sitBtn.disabled = (lobby.players || []).length >= 6;
            }
        }
    } else {
        if (sitBtn) sitBtn.style.display = 'none';
        if (standUpBtn) standUpBtn.style.display = 'none';
        if (readyBtn) readyBtn.style.display = 'none';
        if (knockBtn) knockBtn.style.display = isSpectatorOnly ? 'none' : 'inline-block';
    }

    // Turn Audio Cue
    const isMyTurn = !!(
        activeUsername &&
        lobby.currentTurnUser &&
        lobby.currentTurnUser.trim().toLowerCase() === activeUsername.toLowerCase() &&
        (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn')
    );

    if (isMyTurn) {
        if (!window.appGlobals.wasMyTurn) {
            window.appGlobals.wasMyTurn = true;
            if (typeof playYourTurnCue === 'function') {
                playYourTurnCue();
            } else if (typeof playSound === 'function') {
                playSound('yourturn');
            }
            if (typeof triggerVibration === 'function') {
                triggerVibration([60, 40, 60]);
            }
        }
    } else {
        window.appGlobals.wasMyTurn = false;
    }

    const turnBanner = document.getElementById('turn-banner');
    if (turnBanner) {
        turnBanner.innerText = isMyTurn ? "YOUR TURN!" : ((lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') ? `Turn: ${lobby.currentTurnUser}` : 'Turn: Waiting...');
    }

    updateKnockButtonState(lobby, me, isMyTurn);

    const lobbyConfigBar = document.getElementById('lobby-config-bar');
    if (lobbyConfigBar) lobbyConfigBar.style.display = lobby.gameState === 'lobby' ? 'flex' : 'none';

    const potTotalBanner = document.getElementById('pot-total-banner');
    if (potTotalBanner) potTotalBanner.innerText = `Pot: $${lobby.potTotal || 0}`;

    const sidePotBanner = document.getElementById('side-pot-total-banner');
    if (sidePotBanner) {
        sidePotBanner.innerText = `Side Pots: $${lobby.sidePotTotal || 0}`;
        sidePotBanner.style.display = lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none';
    }

    // Next Hand Overlay
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (nextHandOverlay) {
        if (lobby.gameState === 'roundOver' && !isSpectatorOnly) {
            nextHandOverlay.style.display = 'block';
            const nextBtn = document.getElementById('next-hand-btn');
            if (nextBtn) {
                if (me && me.nextHandReady) {
                    nextBtn.innerText = 'Waiting...';
                    nextBtn.disabled = true;
                } else {
                    nextBtn.innerText = 'Next Hand';
                    nextBtn.disabled = false;
                }
            }
        } else {
            nextHandOverlay.style.display = 'none';
        }
    }

    // Dealer Draw Phase Modal
    const poolModal = document.getElementById('pool-draw-modal');
    if (poolModal) {
        if (lobby.gameState === 'dealerDraw') {
            const titleEl = document.getElementById('pool-modal-title');
            const instEl = document.getElementById('pool-modal-instruction');
            if (titleEl) titleEl.innerText = 'Picking for Dealer';
            if (instEl) instEl.innerText = lobby.phaseMessage || 'Select a card from the deck pool.';

            let gridHtml = '';
            (lobby.drawPool || []).forEach(slot => {
                if (slot.chosenBy) {
                    const revealedCard = lobby.drawResults?.[slot.chosenBy];
                    const cardHtmlStr = revealedCard ? formatCardHtml(revealedCard, true) : '';
                    gridHtml += `<div class="pool-card-item revealed"><span style="font-size:0.55rem; color:#475569;">${slot.chosenBy}</span>${cardHtmlStr}</div>`;
                } else {
                    const clickable = !lobby.drawResults?.[activeUsername] && !window.appGlobals.hasChosenPoolCard;
                    gridHtml += `<div class="pool-card-item" ${clickable ? `onclick="choosePoolCard(${slot.index})"` : ''} style="${!clickable ? 'opacity:0.5; cursor:not-allowed;' : ''}">?</div>`;
                }
            });
            const poolCont = document.getElementById('pool-cards-container');
            if (poolCont) poolCont.innerHTML = gridHtml;
            poolModal.style.display = 'flex';
        } else {
            poolModal.style.display = 'none';
        }
    }

    // Tie-Breaker Draw Modal
    const revealModal = document.getElementById('tie-breaker-reveal-modal');
    if (revealModal) {
        if (lobby.gameState === 'tieBreaker') {
            const isTiedParticipant = (lobby.tiedParticipantsList || []).includes(activeUsername);
            const streamMsg = document.getElementById('tie-breaker-stream-msg');
            if (streamMsg) streamMsg.innerText = isTiedParticipant ? 'You are tied! Pick your tie-breaker card below:' : 'Waiting for tied participants to draw cards...';

            let streamHtml = '';
            if (isTiedParticipant && !lobby.drawResults?.[activeUsername]) {
                streamHtml += `<div style="width:100%; display:grid; grid-template-columns: repeat(auto-fill, minmax(32px, 1fr)); gap:4px; margin-bottom:8px;">`;
                (lobby.drawPool || []).forEach(slot => {
                    if (!slot.chosenBy) {
                        streamHtml += `<div class="pool-card-item" onclick="choosePoolCard(${slot.index})">?</div>`;
                    }
                });
                streamHtml += `</div>`;
            }

            (lobby.tiedParticipantsList || []).forEach(uname => {
                const card = lobby.drawResults?.[uname];
                streamHtml += `<div style="text-align:center; padding:4px;"><b>${uname}</b>: ${card ? formatCardHtml(card, true) : '<i>Choosing...</i>'}</div>`;
            });
            const streamGrid = document.getElementById('tie-breaker-stream-grid');
            if (streamGrid) streamGrid.innerHTML = streamHtml;
            revealModal.style.display = 'flex';
        } else {
            revealModal.style.display = 'none';
        }
    }

    // Table Felt Elements: Deck & Discard
    const deckCount = (lobby.deck && lobby.deck.length !== undefined) ? lobby.deck.length : (lobby.deckCount || 0);
    const topDiscard = (lobby.discardPile && lobby.discardPile.length > 0)
        ? lobby.discardPile[lobby.discardPile.length - 1]
        : lobby.discardTop;

    const deckPile = document.getElementById('deck-pile');
    if (deckPile) {
        deckPile.className = 'card-slot back';
        deckPile.onclick = () => drawCard('deck');
        deckPile.innerHTML = `
            <div class="card-back-inner"></div>
            <div class="deck-counter-badge" id="deck-count-display">${deckCount} left</div>
        `;
    }

    const discardPile = document.getElementById('discard-pile');
    if (discardPile) {
        discardPile.onclick = () => drawCard('discard');
        if (!topDiscard) {
            discardPile.className = 'card-slot empty-slot';
            discardPile.innerHTML = '<span>Empty</span>';
        } else {
            discardPile.className = 'card-slot';
            discardPile.innerHTML = formatCardHtml(topDiscard, false);
        }
    }

    // Render 6 Player Seats
    for (let s = 0; s < 6; s++) {
        const seatNode = document.getElementById(`seat-${s}`);
        const p = (lobby.players || []).find(player => player.seat === s);

        if (!seatNode) continue;

        if (!p) {
            seatNode.innerHTML = '';
            seatNode.className = `seat seat-${s}`;
            continue;
        }

        const isCurrent = (p.username.toLowerCase() === lobby.currentTurnUser?.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        const isDealer = (lobby.dealerIndex !== undefined && lobby.players[lobby.dealerIndex]?.username === p.username) || p.isDealer;
        const dealerBadge = isDealer ? `<span class="dealer-badge">D</span>` : '';
        const vcBadge = p.inVC ? (p.isMuted ? '<span class="vc-badge">🔇</span>' : '<span class="vc-badge active">🎙️</span>') : '';
        const botBadge = p.isBot ? '🤖 ' : '';
        const readyIcon = p.isBot && !p.ready ? '⏳' : (p.ready ? '✅' : '❌');

        const revealedCards = p.cards && p.cards.length > 0
            ? `<div class="seat-cards">${p.cards.map(c => formatCardHtml(c, true)).join('')}</div>`
            : '';

        seatNode.className = `seat seat-${s}${isCurrent ? ' current-turn-seat' : ''}`;
        seatNode.innerHTML = `
            <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                <span>${readyIcon}</span> <b>${botBadge}${p.username}${p.eliminated ? ' [OUT]' : ''}</b> ${dealerBadge} ${vcBadge}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
            </div>
            ${revealedCards}
        `;
    }

    // Local Hand (Bottom Dock)
    const myCardsContainer = document.getElementById('my-cards-container');
    const myScoreDisplay = document.getElementById('my-score-display');
    if (me && me.cards && myCardsContainer) {
        myCardsContainer.innerHTML = me.cards.map((c, i) => `
            ${formatCardHtml(c, false, 'my-card', `onclick="discardCard(${i})"`)}
        `).join('');
        if (myScoreDisplay) myScoreDisplay.innerText = calculateLocalScore(me.cards);
    } else if (myCardsContainer) {
        myCardsContainer.innerHTML = '';
        if (myScoreDisplay) myScoreDisplay.innerText = '0';
    }

    // Winner / 31 Celebrations
    if (lobby.hit31Player && typeof trigger31Celebration === 'function') {
        trigger31Celebration(lobby.hit31Player);
    }
    if ((lobby.gameState === 'tournamentEnd' || lobby.tournamentWinner) && typeof triggerWinnerCelebration === 'function') {
        triggerWinnerCelebration(lobby.tournamentWinner || lobby.lastGameWinner);
    }
}

function resetToMainMenu() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.hasChosenPoolCard = false;
    window.appGlobals.wasMyTurn = false;

    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    if (gameView) gameView.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';

    const endGameBtn = document.getElementById('end-game-btn');
    const leaveLobbyBtn = document.getElementById('leave-lobby-btn');
    if (endGameBtn) endGameBtn.style.display = 'none';
    if (leaveLobbyBtn) leaveLobbyBtn.style.display = 'none';

    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'none';

    if (window.clientState) window.clientState.isReady = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';

    refreshLobbies();
}

// Global Window Exports
window.toggleModal = toggleModal;
window.showCenterNotification = showCenterNotification;
window.formatCardHtml = formatCardHtml;
window.calculateLocalScore = calculateLocalScore;
window.renderLobbyList = renderLobbyList;
window.drawCard = drawCard;
window.drawFromDeck = drawFromDeck;
window.drawFromDiscard = drawFromDiscard;
window.discardCard = discardCard;
window.choosePoolCard = choosePoolCard;
window.knockRound = knockRound;
window.toggleReady = toggleReady;
window.setReady = toggleReady;
window.standUp = standUp;
window.sitDown = sitDown;
window.clickNextHand = clickNextHand;
window.nextHand = clickNextHand;
window.proposeEndGame = proposeEndGame;
window.leaveLobby = leaveLobby;
window.createLobby = createLobby;
window.joinLobby = joinLobby;
window.joinLobbyCode = joinLobbyCode;
window.joinSpecificLobby = joinLobbyCode;
window.joinByCode = joinLobbyCode;
window.addBot = addBot;
window.removeBot = removeBot;
window.updateWager = updateWager;
window.updateSettings = updateSettings;
window.refreshLobbies = refreshLobbies;
window.toggleVoiceOnOff = toggleVoiceOnOff;
window.openSettingsModal = openSettingsModal;
window.openActiveBetsModal = openActiveBetsModal;
window.openVcParticipantsModal = openVcParticipantsModal;
window.openSpectatorListModal = openSpectatorListModal;
window.openLedgerModal = openLedgerModal;
window.toggleChatWindow = toggleChatWindow;
window.toggleGlobalSidebar = toggleGlobalSidebar;
window.sendChatMessage = sendChatMessage;
window.appendChatMessage = appendChatMessage;
window.stopPeekingAction = stopPeekingAction;
window.tapSeat = tapSeat;
window.requestPeekFromModal = requestPeekFromModal;
window.betOnHimFromModal = betOnHimFromModal;
window.submitEliminationProposal = submitEliminationProposal;
window.submitGlobalProposal = submitGlobalProposal;
window.acceptGlobalProposal = acceptGlobalProposal;
window.confirmGlobalBet = confirmGlobalBet;
window.openConfirmModal = openConfirmModal;
window.respondToBet = respondToBet;
window.updateUIFromLobby = updateUIFromLobby;
window.renderLobbyState = updateUIFromLobby;
window.renderGameView = updateUIFromLobby;
window.resetToMainMenu = resetToMainMenu;
