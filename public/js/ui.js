// public/js/ui.js

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
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) return 30.5;
    return Math.max(...Object.values(sums), 0);
}

function showCenterNotification(msg) {
    const banner = document.getElementById('center-notification-banner');
    if (!banner) return;
    banner.innerText = msg;
    banner.style.display = 'block';
    if (window.appGlobals?.notificationTimer) clearTimeout(window.appGlobals.notificationTimer);
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.notificationTimer = setTimeout(() => { banner.style.display = 'none'; }, 2500);
}

function toggleModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = m.style.display === 'flex' ? 'none' : 'flex';
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
        initSocketAndSend({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
    }
}

function appendChatMessage(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML += `<div><b>${user}:</b> ${msg}</div>`;
    box.scrollTop = box.scrollHeight;

    const win = document.getElementById('chat-window');
    if (!win || win.style.display !== 'flex') {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
}

function stopPeekingAction() {
    initSocketAndSend({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
    showCenterNotification("Stopped peeking.");
}

function kickPeekerAction(spectatorUsername) {
    initSocketAndSend({ type: 'KICK_PEEKER', spectatorUsername });
    showCenterNotification(`Removed ${spectatorUsername} from peeking your hand.`);
}

function refreshLobbies() {
    initSocketAndSend({ type: 'GET_LOBBIES' });
}

function renderLobbyList(lobbies) {
    const container = document.getElementById('lobby-list');
    if (!container) return;
    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:10px; font-size:0.75rem;">No active lobbies found</div>';
        return;
    }
    container.innerHTML = lobbies.map(l => {
        const count = l.count !== undefined ? l.count : (l.playerCount || 0);
        const stateText = (l.state === 'lobby' || l.gameState === 'lobby') ? 'Open' : 'In-Progress';
        return `<div class="lobby-item" onclick="joinLobbyCode('${l.code}')"><span><b>${l.name}</b> (${count}/6) - ${stateText}</span><span style="color:#38bdf8; font-weight:bold;">Join</span></div>`;
    }).join('');
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

// Propose lives update (triggers majority vote across humans)
function updateSettings() {
    const livesEl = document.getElementById('config-lives');
    const lives = livesEl ? parseInt(livesEl.value, 10) : 2;
    initSocketAndSend({ type: 'UPDATE_SETTINGS', lives });
}

function submitLivesVote(agree) {
    initSocketAndSend({ type: 'VOTE_LIVES', agree });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
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
    initSocketAndSend({ type: 'NEXT_HAND' });
}

function proposeEndGame() {
    if (confirm("Propose ending the game?")) {
        initSocketAndSend({ type: 'END_GAME_PROPOSAL' });
    }
}

function leaveLobby() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    initSocketAndSend({ type: 'LEAVE_LOBBY' });
    resetToMainMenu();
}

function drawCard(type) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    initSocketAndSend({ type: type === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
}

function discardCard(cardIndex) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(30);
    initSocketAndSend({ type: 'DISCARD_CARD', index: cardIndex, cardIndex: cardIndex });
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
        if (targetUsername === activeUsername) return;
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
    toggleModal('vc-participants-modal');
}

function knockRound() {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());

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

    if (typeof playSound === 'function') playSound('knock');
    if (typeof speakKnockedCue === 'function') speakKnockedCue();
    if (typeof triggerVibration === 'function') triggerVibration([180, 110, 180, 110, 180]);
    initSocketAndSend({ type: 'KNOCK' });
}

function updateUIFromLobby(lobby) {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('game-view').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'inline-block';
    document.getElementById('leave-lobby-btn').style.display = 'inline-block';
    
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    if (topRowBtns) topRowBtns.style.display = 'inline-flex';

    const toolsRow = document.getElementById('in-game-tools-row');
    if (toolsRow) toolsRow.style.display = 'flex';

    document.getElementById('room-title-display').innerText = `${lobby.name} [${lobby.code}]`;

    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;
    if (typeof renderYouTubePlayer === 'function') {
        renderYouTubePlayer(lobby.playlist, lobby.currentSongIndex, lobby.isPlaying, lobby.currentSongElapsedSeconds || 0);
    }

    // CELEBRATION FIX: Trigger cleanly on tournament victory
    const hasWinner = lobby.tournamentWinner || (lobby.phaseMessage && lobby.phaseMessage.includes('TOURNAMENT WINNER'));
    if (hasWinner) {
        let winnerName = lobby.tournamentWinner;
        if (!winnerName && lobby.phaseMessage) {
            const m = lobby.phaseMessage.match(/TOURNAMENT WINNER!\s+(.*?)\s+wins/);
            if (m && m[1]) winnerName = m[1].trim();
        }
        if (winnerName && window.appGlobals?.lastCelebratedWinner !== winnerName) {
            if (!window.appGlobals) window.appGlobals = {};
            window.appGlobals.lastCelebratedWinner = winnerName;
            if (typeof triggerWinnerCelebration === 'function') {
                triggerWinnerCelebration(winnerName);
            }
        }
    }
    if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
        if (window.appGlobals) window.appGlobals.lastCelebratedWinner = null;
    }

    if (!window.appGlobals) window.appGlobals = {};
    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            document.getElementById('discard-pickup-topleft-modal').style.display = 'none';
            document.getElementById('fed-card-topright-modal').style.display = 'none';
        }
    }

    // LIVES VOTING MODAL HANDLING
    const voteModal = document.getElementById('lives-vote-modal');
    if (voteModal) {
        if (lobby.livesVote && lobby.gameState === 'lobby') {
            const hasVoted = lobby.livesVote.votes && lobby.livesVote.votes[activeUsername] !== undefined;
            const isSeatedHuman = lobby.players.some(p => p.username.toLowerCase() === activeUsername.toLowerCase() && !p.isBot);

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

    // Update config lives dropdown to match server state
    const configLivesSelect = document.getElementById('config-lives');
    if (configLivesSelect && lobby.defaultLives) {
        configLivesSelect.value = String(lobby.defaultLives);
    }

    // Knock alert modal
    const knockAlertModal = document.getElementById('knock-alert-modal');
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

    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        const cardHtml = formatCardHtml(lobby.lastDiscardPickup.card, true);
        topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${cardHtml}`;
        topleftModal.style.display = 'flex';
    } else {
        topleftModal.style.display = 'none';
    }

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
    document.getElementById('spec-count').innerText = window.clientState.spectatorsList.length;

    const me = lobby.players.find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isSpecUser = lobby.spectators.some(s => s.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // Active hand peeking indicator
    const peekingBanner = document.getElementById('active-peeking-banner');
    let activelyPeekingTarget = null;
    if (isSpectatorOnly && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        lobby.players.forEach(pl => {
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
        readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';

        if (me.peekIncoming && Object.keys(me.peekIncoming).length > 0) {
            const requester = Object.keys(me.peekIncoming)[0];
            const peekModal = document.getElementById('peek-request-modal');
            document.getElementById('peek-modal-msg').innerText = `${requester} wants to peek at your hand.`;
            document.getElementById('peek-allow-btn').onclick = () => {
                initSocketAndSend({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: true });
                toggleModal('peek-request-modal');
            };
            document.getElementById('peek-deny-btn').onclick = () => {
                initSocketAndSend({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: false });
                toggleModal('peek-request-modal');
            };
            peekModal.style.display = 'flex';
        }
    }

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
        } else {
            standUpBtn.style.display = 'none';
            readyBtn.style.display = 'none';
            knockBtn.style.display = 'none';
            sitBtn.style.display = isSpecUser ? 'inline-block' : 'none';
            sitBtn.disabled = lobby.players.length >= 6;
        }
    } else {
        sitBtn.style.display = 'none';
        if (isSpectatorOnly) {
            standUpBtn.style.display = 'none';
            readyBtn.style.display = 'none';
            knockBtn.style.display = 'none';
        } else {
            standUpBtn.style.display = 'none';
            readyBtn.style.display = 'none';
            knockBtn.style.display = 'inline-block';
        }
    }

    const activePartsCount = lobby.players.filter(p => !p.eliminated).length;
    const threshold = activePartsCount > 2 ? 21 : 25;
    const myScore = (me && me.cards) ? calculateLocalScore(me.cards) : 0;
    const turnsConditionMet = !!lobby.canKnock;
    const scoreConditionMet = myScore >= threshold;
    const isMyTurnPlaying = (lobby.currentTurnUser.toLowerCase() === activeUsername.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
    const hasNotDrawn = me && me.cards && me.cards.length === 3;

    if (lobby.knockedBy) {
        knockBtn.disabled = true;
        knockBtn.innerText = `${lobby.knockedBy} knocked!`;
    } else if (!turnsConditionMet || !scoreConditionMet || !isMyTurnPlaying || !hasNotDrawn) {
        knockBtn.disabled = true;
        knockBtn.innerText = `Knock (${threshold}+)`;
    } else {
        knockBtn.disabled = false;
        knockBtn.innerText = 'Knock!';
    }

    const sidebar = document.getElementById('global-side-bets-sidebar');
    const sidebarList = document.getElementById('global-side-bets-list');
    const globalProps = lobby.globalProposals || [];

    if (globalProps.length > 0 && lobby.gameState !== 'lobby') {
        sidebar.style.display = 'flex';
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
        sidebarList.innerHTML = sidebarHtml;
    } else {
        sidebar.style.display = 'none';
    }

    const modal = document.getElementById('bet-modal');
    const isModalOpen = modal && modal.style.display === 'flex';

    if (lobby.pendingBetsForMe && lobby.pendingBetsForMe.length > 0 && !isModalOpen) {
        lobby.pendingBetsForMe.forEach(bet => {
            const label = bet.type === 'win' ? `Side Bet: ${bet.proposer} bets $${bet.wagerAmt} that you win round.` : `First Out Bet: ${bet.proposer} bets $${bet.wagerAmt} that ${bet.pickUser} is eliminated before ${bet.targetSurvivor}.`;
            
            const modalTitle = document.getElementById('bet-modal-title');
            const modalBody = document.getElementById('bet-modal-body');
            modalTitle.innerText = `Incoming Bet Proposal from ${bet.proposer}`;
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">${label}</p>
                <div style="display: flex; gap: 8px; justify-content: center;">
                    <button onclick="respondToBet('${bet.id}', true)">Accept</button>
                    <button class="danger" onclick="respondToBet('${bet.id}', false)">Decline</button>
                </div>
            `;
            modal.style.display = 'flex';
        });
        lobby.pendingBetsForMe = [];
    }

    document.getElementById('lobby-config-bar').style.display = lobby.gameState === 'lobby' ? 'flex' : 'none';
    document.getElementById('pot-total-banner').innerText = `Pot: $${lobby.potTotal || 0}`;

    const sidePotBanner = document.getElementById('side-pot-total-banner');
    if (lobby.sidePotTotal && lobby.sidePotTotal > 0) {
        sidePotBanner.innerText = `Side Pots: $${lobby.sidePotTotal}`;
        sidePotBanner.style.display = 'block';
    } else {
        sidePotBanner.style.display = 'none';
    }

    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (lobby.gameState === 'roundOver') {
        if (lobby.activeParticipantsCount <= 1) {
            nextHandOverlay.style.display = 'block';
            const nextBtn = document.getElementById('next-hand-btn');
            nextBtn.innerText = 'Returning to Ready Room...';
            nextBtn.disabled = true;
        } else if (!isSpectatorOnly) {
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
    } else {
        nextHandOverlay.style.display = 'none';
    }

    const poolModal = document.getElementById('pool-draw-modal');
    const revealModal = document.getElementById('tie-breaker-reveal-modal');
    const turnBanner = document.getElementById('turn-banner');

    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        showCenterNotification(lobby.phaseMessage);
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
    }

    if (lobby.gameState === 'dealerDraw') {
        poolModal.style.display = 'flex';
        revealModal.style.display = 'none';
        document.getElementById('pool-modal-title').innerText = 'Picking for Dealer';
        document.getElementById('pool-modal-instruction').innerText = lobby.phaseMessage || 'Select a card from the deck pool.';
        
        let gridHtml = '';
        lobby.drawPool.forEach((slot) => {
            if (slot.chosenBy) {
                const revealedCard = lobby.drawResults[slot.chosenBy];
                const cardHtmlStr = revealedCard ? formatCardHtml(revealedCard, true) : '';
                gridHtml += `<div class="pool-card-item revealed"><span style="font-size:0.55rem; color:#475569;">${slot.chosenBy}</span>${cardHtmlStr}</div>`;
            } else {
                const clickable = !lobby.drawResults[activeUsername] && !window.appGlobals.hasChosenPoolCard;
                gridHtml += `<div class="pool-card-item" ${clickable ? `onclick="choosePoolCard(${slot.index})"` : ''} style="${!clickable ? 'opacity:0.5; cursor:not-allowed;' : ''}">?</div>`;
            }
        });
        document.getElementById('pool-cards-container').innerHTML = gridHtml;
        turnBanner.innerText = 'Dealer Draw Phase';
    } else if (lobby.gameState === 'tieBreaker') {
        poolModal.style.display = 'none';
        revealModal.style.display = 'flex';
        const isTiedParticipant = lobby.tiedParticipantsList.includes(activeUsername);
        document.getElementById('tie-breaker-stream-msg').innerText = isTiedParticipant ? 'You are tied! Pick your tie-breaker card below:' : 'Waiting for tied participants to draw cards...';
        
        let streamHtml = '';
        if (isTiedParticipant && !lobby.drawResults[activeUsername]) {
            streamHtml += `<div style="width:100%; display:grid; grid-template-columns: repeat(auto-fill, minmax(32px, 1fr)); gap:4px; margin-bottom:8px;">`;
            lobby.drawPool.forEach((slot) => {
                if (!slot.chosenBy) {
                    streamHtml += `<div class="pool-card-item" onclick="choosePoolCard(${slot.index})">?</div>`;
                }
            });
            streamHtml += `</div>`;
        }

        lobby.tiedParticipantsList.forEach(uname => {
            const card = lobby.drawResults[uname];
            streamHtml += `<div style="text-align:center; padding:4px;"><b>${uname}</b>: ${card ? formatCardHtml(card, true) : '<i>Choosing...</i>'}</div>`;
        });
        document.getElementById('tie-breaker-stream-grid').innerHTML = streamHtml;
        turnBanner.innerText = 'Tie-Breaker Draw';
    } else {
        poolModal.style.display = 'none';
        revealModal.style.display = 'none';
        if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
            const isMyTurn = (lobby.currentTurnUser.toLowerCase() === activeUsername.toLowerCase());
            turnBanner.innerText = isMyTurn ? "YOUR TURN!" : `Turn: ${lobby.currentTurnUser}`;
        } else if (lobby.gameState === 'roundOver') {
            turnBanner.innerText = lobby.phaseMessage || 'Round Over';
        }
    }

    const container = document.getElementById('table-oval-container');
    const discardTopHtml = lobby.discardTop ? formatCardHtml(lobby.discardTop, false) : 'Empty';

    let html = `
        <div class="pots-container">
            <div class="pot-total-display" id="pot-total-banner">Pot: $${lobby.potTotal || 0}</div>
            <div class="side-pot-total-display" id="side-pot-total-banner" style="display:${lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none'};">Side Pots: $${lobby.sidePotTotal || 0}</div>
        </div>
        <div class="deck-center">
            <div id="center-turn-indicator" style="display:${isMyTurnPlaying ? 'block' : 'none'};">YOUR TURN!</div>
            <div class="card-slot back" onclick="drawCard('deck')">DECK<div class="deck-counter">${lobby.deckCount || 0} left</div></div>
            <div class="card-slot" onclick="drawCard('discard')">${discardTopHtml}</div>
        </div>
    `;

    lobby.players.forEach((p, idx) => {
        const revealedCardsHtml = p.cards && p.cards.length > 0 ? `<div class="seat-cards">${p.cards.map(c => formatCardHtml(c, true)).join('')}</div>` : '';
        const statusBadge = p.eliminated ? ' [OUT]' : '';
        const readyStatusIcon = p.ready ? '✅' : '❌';
        const botBadge = p.isBot ? ' 🤖' : '';
        const isCurrentTurnUserSeat = (p.username.toLowerCase() === lobby.currentTurnUser.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        const isDealer = (idx === lobby.dealerIndex);
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
            <div class="seat seat-${p.seat}${isCurrentTurnUserSeat ? ' current-turn-seat' : ''}">
                <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                    <span>${readyStatusIcon}</span> <b>${p.username}${botBadge}${statusBadge}</b>${dealerBadgeHtml}${micIcon}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                </div>
                ${revealedCardsHtml}
                ${peekerBadgesHtml}
            </div>
        `;
    });

    container.innerHTML = html;
    container.appendChild(nextHandOverlay);

    if (me && me.cards) {
        const cardsHtml = me.cards.map((c, i) => `
            <div class="my-card ${['♥', '♦'].includes(c.suit) ? 'red-suit' : 'black-suit'}" onclick="discardCard(${i})">
                <span>${c.val}</span><span style="font-size:1.1rem;">${c.suit}</span>
            </div>
        `).join('');
        document.getElementById('my-cards-container').innerHTML = cardsHtml;
        document.getElementById('my-score-display').innerText = calculateLocalScore(me.cards);
    } else {
        document.getElementById('my-cards-container').innerHTML = '';
        document.getElementById('my-score-display').innerText = '0';
    }
}

function resetToMainMenu() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    
    document.getElementById('game-view').style.display = 'none';
    document.getElementById('main-menu').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'none';
    document.getElementById('leave-lobby-btn').style.display = 'none';
    
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    if (topRowBtns) topRowBtns.style.display = 'none';

    const toolsRow = document.getElementById('in-game-tools-row');
    if (toolsRow) toolsRow.style.display = 'none';

    const chatWin = document.getElementById('chat-window');
    if (chatWin) chatWin.style.display = 'none';

    window.clientState.isReady = false;
    window.appGlobals.hasChosenPoolCard = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';
    refreshLobbies();
}
