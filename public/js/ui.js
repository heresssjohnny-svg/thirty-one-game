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
    if (window.appGlobals.notificationTimer) clearTimeout(window.appGlobals.notificationTimer);
    window.appGlobals.notificationTimer = setTimeout(() => {
        banner.style.display = 'none';
    }, 3200);
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
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let sums = {};
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
    const myScore = me?.cards ? calculateLocalScore(me.cards) : 0;
    const turnsConditionMet = !!lobby.canKnock;
    const scoreConditionMet = myScore >= threshold;
    const hasNotDrawn = me && me.cards && me.cards.length === 3; // Must hold 3 cards

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
    const activeUsername = document.getElementById('username-input').value.trim() || window.clientState.username;
    const me = window.appGlobals.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());

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

function updateUIFromLobby(lobby) {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('game-view').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'inline-block';
    document.getElementById('leave-lobby-btn').style.display = 'inline-block';
    document.getElementById('vc-group-container').style.display = 'inline-flex';
    document.getElementById('room-title-display').innerText = `${lobby.name} [${lobby.code}]`;

    const activeUsername = document.getElementById('username-input').value.trim() || window.clientState.username;

    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            document.getElementById('discard-pickup-topleft-modal').style.display = 'none';
            document.getElementById('fed-card-topright-modal').style.display = 'none';
        }
    }

    updateKnockAlertAndAudio(lobby);

    // Initial discard pickup modal
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
        topleftModal.style.display = 'flex';
    } else {
        topleftModal.style.display = 'none';
    }

    // Fed card modal
    const fedModal = document.getElementById('fed-card-topright-modal');
    const fedContent = document.getElementById('fed-card-content');
    const fedLabel = document.getElementById('fed-card-label');
    if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        fedLabel.innerText = `${lobby.myFedCardReminder.target} took your:`;
        fedContent.innerHTML = formatCardHtml(lobby.myFedCardReminder.card, true);
        fedModal.style.display = 'flex';
    } else {
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
    document.getElementById('spec-count').innerText = window.clientState.spectatorsList.length;

    const me = lobby.players.find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isSpecUser = lobby.spectators.some(s => s.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    const standUpBtn = document.getElementById('stand-up-btn');
    const sitBtn = document.getElementById('sit-btn');
    const readyBtn = document.getElementById('ready-btn');
    const knockBtn = document.getElementById('knock-btn');

    if (lobby.gameState === 'lobby') {
        if (me && !isEliminated) {
            standUpBtn.style.display = 'inline-block';
            sitBtn.style.display = 'none';
            readyBtn.style.display = 'inline-block';
            knockBtn.style.display = 'none';
            readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';
        } else {
            standUpBtn.style.display = 'none';
            readyBtn.style.display = 'none';
            knockBtn.style.display = 'none';
            sitBtn.style.display = isSpecUser ? 'inline-block' : 'none';
            sitBtn.disabled = lobby.players.length >= 6;
        }
    } else {
        sitBtn.style.display = 'none';
        standUpBtn.style.display = 'none';
        readyBtn.style.display = 'none';
        knockBtn.style.display = isSpectatorOnly ? 'none' : 'inline-block';
    }

    const isMyTurn = (lobby.currentTurnUser.toLowerCase() === activeUsername.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
    const turnBanner = document.getElementById('turn-banner');
    turnBanner.innerText = isMyTurn ? "YOUR TURN!" : ((lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') ? `Turn: ${lobby.currentTurnUser}` : 'Turn: Waiting...');

    updateKnockButtonState(lobby, me, isMyTurn);

    document.getElementById('lobby-config-bar').style.display = lobby.gameState === 'lobby' ? 'flex' : 'none';
    document.getElementById('pot-total-banner').innerText = `Pot: $${lobby.potTotal || 0}`;

    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (lobby.gameState === 'roundOver' && !isSpectatorOnly) {
        nextHandOverlay.style.display = 'block';
        const nextBtn = document.getElementById('next-hand-btn');
        if (me && me.nextHandReady) {
            nextBtn.innerText = 'Waiting...';
            nextBtn.disabled = true;
        } else {
            nextBtn.innerText = 'Next Hand';
            nextBtn.disabled = false;
        }
    } else {
        nextHandOverlay.style.display = 'none';
    }

    // Oval Table Render
    const tableContainer = document.getElementById('table-oval-container');
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

    lobby.players.forEach((p) => {
        const revealedCards = p.cards && p.cards.length > 0 ? `<div class="seat-cards">${p.cards.map(c => formatCardHtml(c, true)).join('')}</div>` : '';
        const isCurrent = (p.username.toLowerCase() === lobby.currentTurnUser.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        html += `
            <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}">
                <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                    <span>${p.ready ? '✅' : '❌'}</span> <b>${p.username}${p.eliminated ? ' [OUT]' : ''}</b><br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                </div>
                ${revealedCards}
            </div>
        `;
    });

    tableContainer.innerHTML = html;
    tableContainer.appendChild(nextHandOverlay);

    // My Hand Render
    if (me && me.cards) {
        document.getElementById('my-cards-container').innerHTML = me.cards.map((c, i) => `
            <div class="my-card ${['♥', '♦'].includes(c.suit) ? 'red-suit' : 'black-suit'}" onclick="discardCard(${i})">
                <span>${c.val}</span><span style="font-size:1.1rem;">${c.suit}</span>
            </div>
        `).join('');
        document.getElementById('my-score-display').innerText = calculateLocalScore(me.cards);
    }
}

function resetToMainMenu() {
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    document.getElementById('game-view').style.display = 'none';
    document.getElementById('main-menu').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'none';
    document.getElementById('leave-lobby-btn').style.display = 'none';
    document.getElementById('vc-group-container').style.display = 'none';
    window.clientState.isReady = false;
    refreshLobbies();
}

function toggleChatWindow() {
    const win = document.getElementById('chat-window');
    win.style.display = win.style.display === 'flex' ? 'none' : 'flex';
}

function toggleGlobalSidebar() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) sidebar.style.display = sidebar.style.display === 'none' ? 'flex' : 'none';
}

function openSpectatorListModal() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState.spectatorsList || [];
    content.innerHTML = specs.length === 0 ? 'No spectators.' : '<ul>' + specs.map(s => `<li><b>${s.username}</b></li>`).join('') + '</ul>';
    toggleModal('spectators-modal');
}

function openActiveBetsModal() {
    toggleModal('active-bets-modal');
}

function openVcParticipantsModal() {
    toggleModal('vc-participants-modal');
}

function tapSeat(targetUsername) {
    if (window.clientState.gameState === 'lobby') return;
    const activeUsername = document.getElementById('username-input').value.trim() || window.clientState.username;
    if (targetUsername === activeUsername) return;

    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    modalTitle.innerText = `Side Bet on ${targetUsername}`;
    modalBody.innerHTML = `
        <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
        <button onclick="submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
        <button onclick="submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
        <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
    `;
    toggleModal('bet-modal');
}

function appendChatMessage(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML += `<div><b>${user}:</b> ${msg}</div>`;
    box.scrollTop = box.scrollHeight;
}
