// public/js/ui.js

function toggleModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = m.style.display === 'flex' ? 'none' : 'flex';
}

function showCenterNotification(msg) {
    const banner = document.getElementById('center-notification-banner');
    if (!banner) return;
    banner.innerText = msg;
    banner.style.display = 'block';
    if (window.appGlobals?.notificationTimer) clearTimeout(window.appGlobals.notificationTimer);
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.notificationTimer = setTimeout(() => {
        banner.style.display = 'none';
    }, 2800);
}

function formatCardHtml(card, isMini = false) {
    if (!card) return '';
    const isRed = ['♥', '♦'].includes(card.suit);
    const suitClass = isRed ? 'red-suit' : 'black-suit';
    if (isMini) {
        return `<div class="mini-card ${suitClass}"><span>${card.val}</span><span>${card.suit}</span></div>`;
    }
    return `<div class="my-card ${suitClass}" style="width:60px; height:85px; font-size:1.1rem;"><span>${card.val}</span><span style="font-size:1.4rem;">${card.suit}</span></div>`;
}

function calculateLocalScore(cards) {
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    const sums = {};
    scoringCards.forEach(c => { sums[c.suit] = (sums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
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
    const myScore = (me && me.cards) ? calculateLocalScore(me.cards) : 0;
    const turnsConditionMet = !!lobby.canKnock;
    const scoreConditionMet = myScore >= threshold;
    const hasNotDrawn = me && me.cards && me.cards.length === 3; // Strict 3-card pre-draw requirement

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

function knockRound() {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());

    // Prevent knocking after a card has been picked up
    if (!me || !me.cards || me.cards.length !== 3) {
        showCenterNotification("You cannot knock after picking up a card!");
        return;
    }

    const currentScore = calculateLocalScore(me.cards);
    const activeCount = window.clientState.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;

    if (currentScore < threshold) {
        showCenterNotification(`Need at least ${threshold} points to knock!`);
        return;
    }

    if (currentScore <= 30) {
        const confirmKnock = confirm(`Knock Confirmation: Are you sure you want to knock with ${currentScore} points?`);
        if (!confirmKnock) return;
    }

    initSocketAndSend({ type: 'KNOCK' });
}

function createLobby() {
    try {
        const usernameEl = document.getElementById('username-input');
        const lobbyNameEl = document.getElementById('lobby-name-input');
        const privateEl = document.getElementById('private-lobby-checkbox');

        const username = (usernameEl && usernameEl.value.trim()) || 'Player1';
        const lobbyName = (lobbyNameEl && lobbyNameEl.value.trim()) || 'My Table';
        const isPrivate = privateEl ? privateEl.checked : false;

        initSocketAndSend({ type: 'CREATE_LOBBY', username, lobbyName, isPrivate });
    } catch (err) {
        console.error("Error creating lobby:", err);
    }
}

function joinLobby() {
    const codeEl = document.getElementById('lobby-code-input');
    const code = codeEl ? codeEl.value.trim().toUpperCase() : '';
    if (code) joinLobbyCode(code);
}

function joinLobbyCode(code) {
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.currentJoinedCode = code;
    const usernameEl = document.getElementById('username-input');
    const username = (usernameEl && usernameEl.value.trim()) || 'Player1';
    initSocketAndSend({ type: 'JOIN_LOBBY', code, username });
}

function standUp() { initSocketAndSend({ type: 'STAND_UP' }); }
function sitDown() { initSocketAndSend({ type: 'SIT_DOWN' }); }

function updateWager() {
    const wagerEl = document.getElementById('config-wager');
    const wager = wagerEl ? wagerEl.value : 5;
    initSocketAndSend({ type: 'UPDATE_WAGER', wager });
}

function updateSettings() {
    const livesEl = document.getElementById('config-lives');
    const lives = livesEl ? livesEl.value : 3;
    initSocketAndSend({ type: 'UPDATE_SETTINGS', lives });
}

function addBot() { initSocketAndSend({ type: 'ADD_BOT' }); }
function removeBot() { initSocketAndSend({ type: 'REMOVE_BOT' }); }

function toggleReady() {
    if (!window.clientState) window.clientState = {};
    window.clientState.isReady = !window.clientState.isReady;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.hasChosenPoolCard = false;
    initSocketAndSend({ type: 'SET_READY', ready: window.clientState.isReady });
}

function clickNextHand() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    initSocketAndSend({ type: 'NEXT_HAND_READY' });
}

function proposeEndGame() {
    if (confirm("Propose ending the game?")) {
        initSocketAndSend({ type: 'END_GAME_PROPOSAL' });
    }
}

function leaveLobby() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    initSocketAndSend({ type: 'LEAVE_LOBBY' });
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        initSocketAndSend({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
    }
}

function appendChatMessage(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML += `<div><b>${user}:</b> ${msg}</div>`;
    box.scrollTop = box.scrollHeight;
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

function stopPeekingAction() {
    initSocketAndSend({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
}

function drawCard(source) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    initSocketAndSend({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
}

function discardCard(index) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    initSocketAndSend({ type: 'DISCARD_CARD', cardIndex: index });
}

function choosePoolCard(cardIndex) {
    if (window.appGlobals?.hasChosenPoolCard) return;
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.hasChosenPoolCard = true;
    initSocketAndSend({ type: 'CHOOSE_POOL_CARD', cardIndex });
}

function tapSeat(targetUsername) {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;
    if (window.clientState.gameState === 'lobby') return;

    const isSpecOnly = window.clientState.isSpectator;
    const activeCount = window.clientState.activeParticipantsCount;

    if (isSpecOnly) {
        const modalTitle = document.getElementById('seat-action-title');
        const modalBody = document.getElementById('seat-action-body');
        modalTitle.innerText = `Actions for ${targetUsername}`;

        let actionsHtml = `<button style="background:#2563eb; padding:8px; font-size:0.85rem;" onclick="requestPeekFromModal('${targetUsername}')">🔍 Peek Hand</button>`;
        if (activeCount === 2) {
            actionsHtml += `<button style="background:#d97706; padding:8px; font-size:0.85rem; margin-top:6px;" onclick="betOnHimFromModal('${targetUsername}')">🤝 Bet on ${targetUsername}</button>`;
        }
        actionsHtml += `<button class="secondary" onclick="toggleModal('seat-action-modal')" style="margin-top:6px;">Cancel</button>`;
        modalBody.innerHTML = actionsHtml;
        toggleModal('seat-action-modal');
        return;
    }

    if (activeCount >= 3) {
        if (targetUsername.toLowerCase() === activeUsername.toLowerCase()) return;
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
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
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
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
    initSocketAndSend({ type: 'REQUEST_PEEK', targetUsername });
    showCenterNotification(`Peek request sent to ${targetUsername}!`);
}

function betOnHimFromModal(targetUsername) {
    toggleModal('seat-action-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
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

function submitEliminationProposal(target, wagerAmt) {
    initSocketAndSend({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    toggleModal('bet-modal');
    showCenterNotification(`First to lose bet proposed to ${target}!`);
}

function submitGlobalProposal(pickUser, wagerAmt) {
    initSocketAndSend({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt });
    toggleModal('bet-modal');
    showCenterNotification(`Global bet offered on ${pickUser}!`);
}

function acceptGlobalProposal(proposalId) { initSocketAndSend({ type: 'ACCEPT_GLOBAL_PROPOSAL', proposalId }); }
function confirmGlobalBet(proposalId, acceptedUser, confirm) {
    initSocketAndSend({ type: 'CONFIRM_GLOBAL_BET', proposalId, acceptedUser, confirm });
    toggleModal('bet-modal');
}

function openConfirmModal(proposalId, proposer, pickUser, acceptedUsers) {
    const modal = document.getElementById('bet-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    modalTitle.innerText = `Confirm Global Side Bet (${pickUser})`;

    const listHtml = acceptedUsers.map(acc => `
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
    initSocketAndSend({ type: 'RESPOND_BET', betId, accept });
    toggleModal('bet-modal');
}

function openActiveBetsModal() {
    const myName = document.getElementById('username-input')?.value.trim() || window.clientState.username;
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

    contentDiv.innerHTML = html;
    toggleModal('active-bets-modal');
}

function openSpectatorListModal() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState.spectatorsList || [];
    if (!content) return;
    if (specs.length === 0) {
        content.innerHTML = 'No spectators.';
    } else {
        content.innerHTML = '<ul>' + specs.map(s => `<li style="margin-bottom:3px;"><b>${s.username}</b></li>`).join('') + '</ul>';
    }
    toggleModal('spectators-modal');
}

function openVcParticipantsModal() {
    const listDiv = document.getElementById('vc-participants-list');
    if (!window.appGlobals?.latestLobbySnapshot) {
        if (listDiv) listDiv.innerHTML = 'No active lobby data.';
        toggleModal('vc-participants-modal');
        return;
    }
    const vcUsers = [];
    window.appGlobals.latestLobbySnapshot.players?.forEach(p => { if (p.inVC) vcUsers.push({ username: p.username, isMuted: p.isMuted }); });
    window.appGlobals.latestLobbySnapshot.spectators?.forEach(s => { if (s.inVC) vcUsers.push({ username: s.username, isMuted: s.isMuted }); });
    if (listDiv) {
        if (vcUsers.length === 0) {
            listDiv.innerHTML = 'No one currently in voice chat.';
        } else {
            listDiv.innerHTML = '<ul>' + vcUsers.map(u => `<li style="margin-bottom:4px;"><b>${u.username}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>`).join('') + '</ul>';
        }
    }
    toggleModal('vc-participants-modal');
}

function renderLobbyList(lobbies) {
    const container = document.getElementById('lobby-list');
    if (!container) return;
    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:6px;">No lobbies found</div>';
        return;
    }
    container.innerHTML = lobbies.map(l => `
        <div class="lobby-item" onclick="joinLobbyCode('${l.code}')">
            <span>${l.name} (${l.count}/6) - ${l.state === 'lobby' ? 'Open' : 'In-Progress'}</span>
            <span style="color:#38bdf8;">Join</span>
        </div>
    `).join('');
}

function updateUIFromLobby(lobby) {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('game-view').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'inline-block';
    document.getElementById('leave-lobby-btn').style.display = 'inline-block';
    document.getElementById('vc-group-container').style.display = 'inline-flex';
    document.getElementById('room-title-display').innerText = `${lobby.name} [${lobby.code}]`;

    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;

    if (typeof renderYouTubePlayer === 'function') {
        renderYouTubePlayer(lobby.playlist, lobby.currentSongIndex, lobby.isPlaying);
    }

    if (!window.appGlobals) window.appGlobals = {};
    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            const discardEl = document.getElementById('discard-pickup-topleft-modal');
            const fedEl = document.getElementById('fed-card-topright-modal');
            if (discardEl) discardEl.style.display = 'none';
            if (fedEl) fedEl.style.display = 'none';
        }
    }

    updateKnockAlertAndAudio(lobby);

    // Initial discard pickup modal
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        if (topleftCardContent) topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
        if (topleftModal) topleftModal.style.display = 'flex';
    } else if (topleftModal) {
        topleftModal.style.display = 'none';
    }

    // Fed card reminder modal
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
    window.clientState.playersList = lobby.players.map(p => p.username);
    window.clientState.spectatorsList = lobby.spectators || [];
    window.clientState.activeParticipantsCount = lobby.activeParticipantsCount || 3;
    window.clientState.tiedParticipantsList = lobby.tiedParticipantsList || [];
    window.clientState.activeBetsList = lobby.activeBets || [];
    window.clientState.pendingBetsList = lobby.pendingBets || [];
    window.clientState.sideBetLedger = lobby.sideBetLedger || {};
    window.clientState.mainGameLedger = lobby.mainGameLedger || {};
    window.clientState.botBetLedger = lobby.botBetLedger || {};

    const specCountEl = document.getElementById('spec-count');
    if (specCountEl) specCountEl.innerText = window.clientState.spectatorsList.length;

    const me = lobby.players.find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isSpecUser = lobby.spectators.some(s => s.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    if (me) {
        window.clientState.isReady = me.ready;
        const readyBtn = document.getElementById('ready-btn');
        if (readyBtn) readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';

        if (me.peekIncoming && Object.keys(me.peekIncoming).length > 0) {
            const requester = Object.keys(me.peekIncoming)[0];
            const peekModal = document.getElementById('peek-request-modal');
            const msgEl = document.getElementById('peek-modal-msg');
            if (msgEl) msgEl.innerText = `${requester} wants to peek at your hand.`;
            const allowBtn = document.getElementById('peek-allow-btn');
            if (allowBtn) {
                allowBtn.onclick = () => {
                    initSocketAndSend({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: true });
                    toggleModal('peek-request-modal');
                };
            }
            const denyBtn = document.getElementById('peek-deny-btn');
            if (denyBtn) {
                denyBtn.onclick = () => {
                    initSocketAndSend({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: false });
                    toggleModal('peek-request-modal');
                };
            }
            if (peekModal) peekModal.style.display = 'flex';
        }
    }

    const standUpBtn = document.getElementById('stand-up-btn');
    const sitBtn = document.getElementById('sit-btn');
    const readyBtn = document.getElementById('ready-btn');
    const knockBtn = document.getElementById('knock-btn');

    if (lobby.gameState === 'lobby') {
        if (me && !isEliminated) {
            if (standUpBtn) standUpBtn.style.display = 'inline-block';
            if (sitBtn) sitBtn.style.display = 'none';
            if (readyBtn) readyBtn.style.display = 'inline-block';
            if (knockBtn) knockBtn.style.display = 'none';
        } else {
            if (standUpBtn) standUpBtn.style.display = 'none';
            if (readyBtn) readyBtn.style.display = 'none';
            if (knockBtn) knockBtn.style.display = 'none';
            if (sitBtn) {
                sitBtn.style.display = isSpecUser ? 'inline-block' : 'none';
                sitBtn.disabled = lobby.players.length >= 6;
            }
        }
    } else {
        if (sitBtn) sitBtn.style.display = 'none';
        if (standUpBtn) standUpBtn.style.display = 'none';
        if (readyBtn) readyBtn.style.display = 'none';
        if (knockBtn) knockBtn.style.display = isSpectatorOnly ? 'none' : 'inline-block';
    }

    const isMyTurn = (lobby.currentTurnUser.toLowerCase() === activeUsername.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
    const turnBanner = document.getElementById('turn-banner');

    updateKnockButtonState(lobby, me, isMyTurn);

    // Global Side Bets Sidebar
    const sidebar = document.getElementById('global-side-bets-sidebar');
    const sidebarList = document.getElementById('global-side-bets-list');
    const globalProps = lobby.globalProposals || [];

    if (globalProps.length > 0 && lobby.gameState !== 'lobby') {
        if (sidebar) sidebar.style.display = 'flex';
        let sidebarHtml = '';
        globalProps.forEach(gp => {
            const isMyProp = (gp.proposer === activeUsername);
            const alreadyAccepted = gp.acceptedBy.includes(activeUsername);

            let actionHtml = '';
            if (isMyProp) {
                if (gp.acceptedBy.length > 0) {
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

    // Direct Bet Proposals
    const modal = document.getElementById('bet-modal');
    const isModalOpen = modal && modal.style.display === 'flex';

    if (lobby.pendingBetsForMe && lobby.pendingBetsForMe.length > 0 && !isModalOpen) {
        lobby.pendingBetsForMe.forEach(bet => {
            const label = bet.type === 'win' ? `Side Bet: ${bet.proposer} bets $${bet.wagerAmt} that you win round.` : `First Out Bet: ${bet.proposer} bets $${bet.wagerAmt} that ${bet.pickUser} is eliminated before ${bet.targetSurvivor}.`;
            const modalTitle = document.getElementById('bet-modal-title');
            const modalBody = document.getElementById('bet-modal-body');
            if (modalTitle) modalTitle.innerText = `Incoming Bet Proposal from ${bet.proposer}`;
            if (modalBody) {
                modalBody.innerHTML = `
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">${label}</p>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button onclick="respondToBet('${bet.id}', true)">Accept</button>
                        <button class="danger" onclick="respondToBet('${bet.id}', false)">Decline</button>
                    </div>
                `;
            }
            if (modal) modal.style.display = 'flex';
        });
        lobby.pendingBetsForMe = [];
    }

    const configBar = document.getElementById('lobby-config-bar');
    if (configBar) configBar.style.display = lobby.gameState === 'lobby' ? 'flex' : 'none';

    const potTotalBanner = document.getElementById('pot-total-banner');
    if (potTotalBanner) potTotalBanner.innerText = `Pot: $${lobby.potTotal || 0}`;

    const sidePotBanner = document.getElementById('side-pot-total-banner');
    if (sidePotBanner) {
        if (lobby.sidePotTotal && lobby.sidePotTotal > 0) {
            sidePotBanner.innerText = `Side Pots: $${lobby.sidePotTotal}`;
            sidePotBanner.style.display = 'block';
        } else {
            sidePotBanner.style.display = 'none';
        }
    }

    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (lobby.gameState === 'roundOver') {
        if (lobby.activeParticipantsCount <= 1) {
            if (nextHandOverlay) nextHandOverlay.style.display = 'block';
            const nextBtn = document.getElementById('next-hand-btn');
            if (nextBtn) {
                nextBtn.innerText = 'Returning to Ready Room...';
                nextBtn.disabled = true;
            }
        } else if (!isSpectatorOnly) {
            if (nextHandOverlay) nextHandOverlay.style.display = 'block';
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
        } else if (nextHandOverlay) {
            nextHandOverlay.style.display = 'none';
        }
    } else if (nextHandOverlay) {
        nextHandOverlay.style.display = 'none';
    }

    const poolModal = document.getElementById('pool-draw-modal');
    const revealModal = document.getElementById('tie-breaker-reveal-modal');

    if (lobby.gameState === 'dealerDraw') {
        if (poolModal) poolModal.style.display = 'flex';
        if (revealModal) revealModal.style.display = 'none';
        const titleEl = document.getElementById('pool-modal-title');
        const instEl = document.getElementById('pool-modal-instruction');
        if (titleEl) titleEl.innerText = 'Picking for Dealer';
        if (instEl) instEl.innerText = lobby.phaseMessage || 'Select a card from the deck pool.';

        let gridHtml = '';
        lobby.drawPool?.forEach((slot) => {
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
        if (turnBanner) turnBanner.innerText = 'Dealer Draw Phase';
    } else if (lobby.gameState === 'tieBreaker') {
        if (poolModal) poolModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'flex';
        const isTiedParticipant = lobby.tiedParticipantsList?.includes(activeUsername);
        const streamMsg = document.getElementById('tie-breaker-stream-msg');
        if (streamMsg) streamMsg.innerText = isTiedParticipant ? 'You are tied! Pick your tie-breaker card below:' : 'Waiting for tied participants to draw cards...';

        let streamHtml = '';
        if (isTiedParticipant && !lobby.drawResults?.[activeUsername]) {
            streamHtml += `<div style="width:100%; display:grid; grid-template-columns: repeat(auto-fill, minmax(32px, 1fr)); gap:4px; margin-bottom:8px;">`;
            lobby.drawPool?.forEach((slot) => {
                if (!slot.chosenBy) {
                    streamHtml += `<div class="pool-card-item" onclick="choosePoolCard(${slot.index})">?</div>`;
                }
            });
            streamHtml += `</div>`;
        }

        lobby.tiedParticipantsList?.forEach(uname => {
            const card = lobby.drawResults?.[uname];
            streamHtml += `<div style="text-align:center; padding:4px;"><b>${uname}</b>: ${card ? formatCardHtml(card, true) : '<i>Choosing...</i>'}</div>`;
        });
        const streamGrid = document.getElementById('tie-breaker-stream-grid');
        if (streamGrid) streamGrid.innerHTML = streamHtml;
        if (turnBanner) turnBanner.innerText = 'Tie-Breaker Draw';
    } else {
        if (poolModal) poolModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'none';
        if (turnBanner) {
            if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
                turnBanner.innerText = isMyTurn ? "YOUR TURN!" : `Turn: ${lobby.currentTurnUser}`;
            } else if (lobby.gameState === 'roundOver') {
                turnBanner.innerText = lobby.phaseMessage || 'Round Over';
            }
        }
    }

    // Oval Table Layout Render
    const container = document.getElementById('table-oval-container');
    const discardTopHtml = lobby.discardTop ? formatCardHtml(lobby.discardTop, false) : 'Empty';

    let html = `
        <div class="pots-container">
            <div class="pot-total-display" id="pot-total-banner">Pot: $${lobby.potTotal || 0}</div>
            <div class="side-pot-total-display" id="side-pot-total-banner" style="display:${lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none'};">Side Pots: $${lobby.sidePotTotal || 0}</div>
        </div>
        <div class="deck-center">
            <div class="card-slot back" onclick="drawCard('deck')">DECK<div class="deck-counter">${lobby.deckCount || 0} left</div></div>
            <div class="card-slot" onclick="drawCard('discard')">${discardTopHtml}</div>
        </div>
    `;

    lobby.players.forEach(p => {
        const revealedCardsHtml = p.cards && p.cards.length > 0 ? `<div class="seat-cards">` + p.cards.map(c => formatCardHtml(c, true)).join('') + `</div>` : '';
        const statusBadge = p.eliminated ? ' [OUT]' : '';
        const readyStatusIcon = p.ready ? '✅' : '❌';
        const botBadge = p.isBot ? ' 🤖' : '';
        const isCurrentTurnUserSeat = (p.username.toLowerCase() === lobby.currentTurnUser.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        const isDealer = lobby.players[lobby.dealerIndex]?.username === p.username;
        const dealerBadgeHtml = isDealer ? `<span class="dealer-badge">D</span>` : '';
        const micStatusIcon = p.inVC ? (p.isMuted ? ' 🔇' : ' 🎙️') : '';

        html += `
            <div class="seat seat-${p.seat}${isCurrentTurnUserSeat ? ' current-turn-seat' : ''}">
                <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                    <span>${readyStatusIcon}</span> <b>${p.username}${botBadge}${micStatusIcon}${statusBadge}</b>${dealerBadgeHtml}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                </div>
                ${revealedCardsHtml}
            </div>
        `;
    });

    if (container) {
        container.innerHTML = html;
        if (nextHandOverlay) container.appendChild(nextHandOverlay);
    }

    // Hand Render
    const myCardsContainer = document.getElementById('my-cards-container');
    const myScoreDisplay = document.getElementById('my-score-display');
    if (me && me.cards) {
        const cardsHtml = me.cards.map((c, i) => `
            <div class="my-card ${['♥', '♦'].includes(c.suit) ? 'red-suit' : 'black-suit'}" onclick="discardCard(${i})">
                <span>${c.val}</span><span style="font-size:1.1rem;">${c.suit}</span>
            </div>
        `).join('');
        if (myCardsContainer) myCardsContainer.innerHTML = cardsHtml;
        if (myScoreDisplay) myScoreDisplay.innerText = calculateLocalScore(me.cards);
    } else {
        if (myCardsContainer) myCardsContainer.innerHTML = '';
        if (myScoreDisplay) myScoreDisplay.innerText = '0';
    }
}

function resetToMainMenu() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.hasChosenPoolCard = false;
    document.getElementById('game-view').style.display = 'none';
    document.getElementById('main-menu').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'none';
    document.getElementById('leave-lobby-btn').style.display = 'none';
    document.getElementById('vc-group-container').style.display = 'none';
    window.clientState.isReady = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';
    if (typeof refreshLobbies === 'function') refreshLobbies();
}
