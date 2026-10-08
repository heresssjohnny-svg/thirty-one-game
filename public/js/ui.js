// public/js/ui.js

// Safe message dispatcher ensuring compatibility with all network wrappers
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
if (typeof window.initSocketAndSend !== 'function') {
    window.initSocketAndSend = sendMsg;
}

/**
 * Normalizes card data (object or string) and returns authentic playing card HTML.
 * @param {string|object} card - e.g. "10H", { val: "A", suit: "♠" }
 * @param {boolean} isMini - Compact format for seat previews
 * @param {string} extraClass - Optional class names
 */
function formatCardHtml(card, isMini = false, extraClass = '') {
    if (!card) return '';

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
            <div class="mini-card ${suitClass} ${extraClass}">
                <span class="mini-val">${val}</span>
                <span class="mini-suit">${suit}</span>
            </div>
        `;
    }

    return `
        <div class="playing-card ${suitClass} ${extraClass}">
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
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
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
    }, 2500);
}

function toggleModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = m.style.display === 'flex' ? 'none' : 'flex';
}

// Voice Chat Controls
function toggleVoiceOnOff() {
    if (typeof window.toggleLiveKitVoice === 'function') {
        window.toggleLiveKitVoice();
    } else if (typeof window.toggleVoice === 'function') {
        window.toggleVoice();
    } else if (typeof window.toggleLiveKitMute === 'function') {
        window.toggleLiveKitMute();
    } else if (typeof toggleLiveKitVoice === 'function') {
        toggleLiveKitVoice();
    }
}

function triggerVoiceReconnect() {
    if (typeof window.reconnectLiveKit === 'function') {
        window.reconnectLiveKit();
    } else if (typeof window.connectLiveKit === 'function') {
        window.connectLiveKit();
    }
}

function openSettingsModal() {
    if (typeof updateVcParticipantsList === 'function') {
        updateVcParticipantsList();
    }
    toggleModal('settings-modal');
}

function openVcParticipantsModal() {
    if (typeof updateVcParticipantsList === 'function') {
        updateVcParticipantsList();
    }
    toggleModal('vc-participants-modal');
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
        const box = document.getElementById('chat-messages');
        if (box) box.scrollTop = box.scrollHeight;
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
    if (!win || win.style.display !== 'flex') {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
}

function syncChatHistory(history) {
    if (!Array.isArray(history)) return;
    const box = document.getElementById('chat-messages');
    if (!box) return;

    if (!window.appGlobals) window.appGlobals = {};
    const lastCount = window.appGlobals.lastChatCount || 0;

    if (history.length !== lastCount) {
        box.innerHTML = history.map(m => `<div><b>${m.user}:</b> ${m.text}</div>`).join('');
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
}

function stopPeekingAction() {
    sendMsg({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
    showCenterNotification("Stopped peeking.");
}

function kickPeekerAction(spectatorUsername) {
    sendMsg({ type: 'KICK_PEEKER', spectatorUsername });
    showCenterNotification(`Removed ${spectatorUsername} from peeking your hand.`);
}

function refreshLobbies() {
    sendMsg({ type: 'GET_LOBBIES' });
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

        sendMsg({ type: 'CREATE_LOBBY', username, lobbyName, isPrivate });
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
    sendMsg({ type: 'JOIN_LOBBY', code, username });
}

function standUp() { sendMsg({ type: 'STAND_UP' }); }
function sitDown() { sendMsg({ type: 'SIT_DOWN' }); }

function updateWager() {
    const wagerEl = document.getElementById('config-wager');
    const wager = wagerEl ? wagerEl.value : 5;
    sendMsg({ type: 'UPDATE_WAGER', wager: Number(wager) });
}

function updateSettings() {
    const livesEl = document.getElementById('config-lives');
    const lives = livesEl ? parseInt(livesEl.value, 10) : 2;
    sendMsg({ type: 'UPDATE_SETTINGS', lives: Number(lives) });
}

function submitLivesVote(agree) {
    sendMsg({ type: 'VOTE_LIVES', agree });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
}

function addBot() { sendMsg({ type: 'ADD_BOT' }); }
function removeBot() { sendMsg({ type: 'REMOVE_BOT' }); }

function toggleReady() {
    if (!window.clientState) window.clientState = {};
    window.clientState.isReady = !window.clientState.isReady;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.hasChosenPoolCard = false;
    sendMsg({ type: 'SET_READY', ready: window.clientState.isReady });
}

function clickNextHand() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    sendMsg({ type: 'NEXT_HAND' });
}

function proposeEndGame() {
    if (confirm("Propose ending the game?")) {
        sendMsg({ type: 'END_GAME_PROPOSAL' });
    }
}

function leaveLobby() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    sendMsg({ type: 'LEAVE_LOBBY' });
    resetToMainMenu();
}

function drawCard(type) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    sendMsg({ type: type === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
}

function discardCard(cardIndex) {
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(30);
    sendMsg({ type: 'DISCARD_CARD', index: cardIndex, cardIndex: cardIndex });
}

function choosePoolCard(cardIndex) {
    if (window.appGlobals?.hasChosenPoolCard) return;
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.hasChosenPoolCard = true;
    sendMsg({ type: 'CHOOSE_POOL_CARD', cardIndex });
}

// Seat Tap & Side-Bet Selection
function tapSeat(targetUsername) {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState?.username || '';
    if (window.clientState?.gameState === 'lobby') return;

    const isSpecOnly = window.clientState?.isSpectator;
    const activeCount = window.clientState?.activeParticipantsCount || 3;
    const isMe = targetUsername.trim().toLowerCase() === activeUsername.trim().toLowerCase();

    // Spectator logic
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

    // 3+ Players: "First to Lose" Elimination Bets (Cannot target yourself)
    if (activeCount >= 3) {
        if (isMe) return; // Prevent betting against yourself to lose first
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (!modalTitle || !modalBody) return;

        modalTitle.innerText = `First to Lose Bet on ${targetUsername}`;
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount that ${targetUsername} loses before you:</p>
            <button onclick="submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
            <button onclick="submitEliminationProposal('${targetUsername}', 20)">$20 Wager</button>
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
        `;
        toggleModal('bet-modal');
    } 
    // Heads Up (2 Players): Global Side Bets (You CAN click yourself or your opponent)
    else if (activeCount === 2) {
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (!modalTitle || !modalBody) return;

        modalTitle.innerText = isMe 
            ? `Global Side Bet: I like myself (${targetUsername}) to win!` 
            : `Global Side Bet: I like ${targetUsername} to win!`;

        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount on ${isMe ? 'yourself' : targetUsername}:</p>
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

function acceptGlobalProposal(proposalId) { 
    sendMsg({ type: 'ACCEPT_GLOBAL_PROPOSAL', proposalId }); 
}

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
    sendMsg({ type: 'RESPOND_BET', betId, accept });
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

    if (contentDiv) contentDiv.innerHTML = html;
    toggleModal('active-bets-modal');
}

function openSpectatorListModal() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState.spectatorsList || [];
    if (!content) return;
    if (specs.length === 0) {
        content.innerHTML = 'No spectators.';
    } else {
        content.innerHTML = '<ul>' + specs.map(s => `<li style="margin-bottom:3px;"><b>${s.username || s}</b></li>`).join('') + '</ul>';
    }
    toggleModal('spectators-modal');
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
    sendMsg({ type: 'KNOCK' });
}

// Master UI Update Loop
function updateUIFromLobby(lobby) {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('game-view').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'inline-block';
    document.getElementById('leave-lobby-btn').style.display = 'inline-block';

    const topRowBtns = document.getElementById('in-game-top-row-btns');
    if (topRowBtns) topRowBtns.style.display = 'inline-flex';

    const toolsRow = document.getElementById('in-game-tools-row');
    if (toolsRow) toolsRow.style.display = 'flex';

    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'inline-flex';

    document.getElementById('room-title-display').innerText = `${lobby.name} [${lobby.code}]`;

    // Sync persistent chat history
    if (lobby.chatHistory) {
        syncChatHistory(lobby.chatHistory);
    }

    const activeUsername = (document.getElementById('username-input')?.value.trim() || window.clientState.username || '').toLowerCase();

    // Celebration check
    const isTournamentOver = lobby.gameState === 'tournamentEnd' || (lobby.phaseMessage && lobby.phaseMessage.includes('TOURNAMENT WINNER'));
    if (isTournamentOver) {
        let winnerName = lobby.tournamentWinner || lobby.lastGameWinner;
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
    } else if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
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

    // Lives voting modal
    const voteModal = document.getElementById('lives-vote-modal');
    if (voteModal) {
        if (lobby.livesVote && lobby.gameState === 'lobby') {
            const hasVoted = lobby.livesVote.votes && lobby.livesVote.votes[activeUsername] !== undefined;
            const isSeatedHuman = lobby.players.some(p => p.username.toLowerCase() === activeUsername && !p.isBot);

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

    // Knock alert modal & audio cues
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

    // Initial discard pickup modal
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        const cardHtml = formatCardHtml(lobby.lastDiscardPickup.card, true);
        if (topleftCardContent) {
            topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${cardHtml}`;
        }
        if (topleftModal) topleftModal.style.display = 'flex';
    } else if (topleftModal) {
        topleftModal.style.display = 'none';
    }

    // Fed card reminder modal
    const fedModal = document.getElementById('fed-card-topright-modal');
    const fedContent = document.getElementById('fed-card-content');
    const fedLabel = document.getElementById('fed-card-label');
    if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        if (fedLabel) fedLabel.innerText = `${lobby.myFedCardReminder.target} took your:`;
        if (fedContent) fedContent.innerHTML = formatCardHtml(lobby.myFedCardReminder.card, true);
        if (fedModal) fedModal.style.display = 'flex';
    } else if (fedModal) {
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
    
    const specCountEl = document.getElementById('spec-count');
    if (specCountEl) specCountEl.innerText = window.clientState.spectatorsList.length;

    const me = lobby.players.find(p => p.username.trim().toLowerCase() === activeUsername);
    const isSpecUser = lobby.spectators.some(s => (s.username || s).trim().toLowerCase() === activeUsername);
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // Active hand peeking banner
    const peekingBanner = document.getElementById('active-peeking-banner');
    let activelyPeekingTarget = null;
    if (isSpectatorOnly && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        lobby.players.forEach(pl => {
            if (pl.peekAllowed && Object.keys(pl.peekAllowed).some(k => k.toLowerCase() === activeUsername)) {
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
    }

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
                sitBtn.disabled = lobby.players.length >= 6;
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

    const activePartsCount = lobby.players.filter(p => !p.eliminated).length;
    const threshold = activePartsCount > 2 ? 21 : 25;
    const myScore = (me && me.cards) ? calculateLocalScore(me.cards) : 0;
    const turnsConditionMet = !!lobby.canKnock;
    const scoreConditionMet = myScore >= threshold;
    const isMyTurnPlaying = (lobby.currentTurnUser && lobby.currentTurnUser.toLowerCase() === activeUsername) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
    const hasNotDrawn = me && me.cards && me.cards.length === 3;

    // Trigger your-turn MP3 audio cue and haptic pattern when turn becomes yours
    if (isMyTurnPlaying) {
        if (!window.appGlobals) window.appGlobals = {};
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
        if (window.appGlobals) {
            window.appGlobals.wasMyTurn = false;
        }
    }

    if (knockBtn) {
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
    }

    const sidebar = document.getElementById('global-side-bets-sidebar');
    const sidebarList = document.getElementById('global-side-bets-list');
    const globalProps = lobby.globalProposals || [];

    if (globalProps.length > 0 && lobby.gameState !== 'lobby') {
        if (sidebar) sidebar.style.display = 'flex';
        let sidebarHtml = '';
        globalProps.forEach(gp => {
            const isMyProp = (gp.proposer.toLowerCase() === activeUsername);
            const alreadyAccepted = gp.acceptedBy.map(u => u.toLowerCase()).includes(activeUsername);

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

    const modal = document.getElementById('bet-modal');
    const isModalOpen = modal && modal.style.display === 'flex';

    if (lobby.pendingBetsForMe && lobby.pendingBetsForMe.length > 0 && !isModalOpen) {
        lobby.pendingBetsForMe.forEach(bet => {
            const label = bet.type === 'win' ? `Side Bet: ${bet.proposer} bets $${bet.wagerAmt} that you win round.` : `First Out Bet: ${bet.proposer} bets $${bet.wagerAmt} that ${bet.pickUser} is eliminated before ${bet.targetSurvivor}.`;

            const modalTitle = document.getElementById('bet-modal-title');
            const modalBody = document.getElementById('bet-modal-body');
            if (modalTitle && modalBody) {
                modalTitle.innerText = `Incoming Bet Proposal from ${bet.proposer}`;
                modalBody.innerHTML = `
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">${label}</p>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button onclick="respondToBet('${bet.id}', true)">Accept</button>
                        <button class="danger" onclick="respondToBet('${bet.id}', false)">Decline</button>
                    </div>
                `;
                modal.style.display = 'flex';
            }
        });
        lobby.pendingBetsForMe = [];
    }

    const lobbyConfigBar = document.getElementById('lobby-config-bar');
    if (lobbyConfigBar) lobbyConfigBar.style.display = lobby.gameState === 'lobby' ? 'flex' : 'none';

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

    // Next Hand Overlay: Display for all surviving seated players at round end
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (nextHandOverlay) {
        if (lobby.gameState === 'roundOver') {
            if (lobby.activeParticipantsCount <= 1) {
                nextHandOverlay.style.display = 'block';
                const nextBtn = document.getElementById('next-hand-btn');
                if (nextBtn) {
                    nextBtn.innerText = 'Returning to Ready Room...';
                    nextBtn.disabled = true;
                }
            } else if (me && !me.eliminated) {
                nextHandOverlay.style.display = 'block';
                const nextBtn = document.getElementById('next-hand-btn');
                if (nextBtn) {
                    if (me.nextHandReady) {
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
        } else {
            nextHandOverlay.style.display = 'none';
        }
    }

    const poolModal = document.getElementById('pool-draw-modal');
    const revealModal = document.getElementById('tie-breaker-reveal-modal');
    const turnBanner = document.getElementById('turn-banner');

    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        showCenterNotification(lobby.phaseMessage);
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
    }

    if (lobby.gameState === 'dealerDraw') {
        if (poolModal) poolModal.style.display = 'flex';
        if (revealModal) revealModal.style.display = 'none';
        const pTitle = document.getElementById('pool-modal-title');
        const pInst = document.getElementById('pool-modal-instruction');
        if (pTitle) pTitle.innerText = 'Picking for Dealer';
        if (pInst) pInst.innerText = lobby.phaseMessage || 'Select a card from the deck pool.';

        let gridHtml = '';
        (lobby.drawPool || []).forEach((slot) => {
            if (slot.chosenBy) {
                const revealedCard = lobby.drawResults?.[slot.chosenBy];
                const cardHtmlStr = revealedCard ? formatCardHtml(revealedCard, true) : '';
                gridHtml += `<div class="pool-card-item revealed"><span style="font-size:0.55rem; color:#475569;">${slot.chosenBy}</span>${cardHtmlStr}</div>`;
            } else {
                const clickable = !lobby.drawResults?.[me?.username] && !window.appGlobals.hasChosenPoolCard;
                gridHtml += `<div class="pool-card-item" ${clickable ? `onclick="choosePoolCard(${slot.index})"` : ''} style="${!clickable ? 'opacity:0.5; cursor:not-allowed;' : ''}">?</div>`;
            }
        });
        const poolCont = document.getElementById('pool-cards-container');
        if (poolCont) poolCont.innerHTML = gridHtml;
        if (turnBanner) turnBanner.innerText = 'Dealer Draw Phase';
    } else if (lobby.gameState === 'tieBreaker') {
        if (poolModal) poolModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'flex';
        const isTiedParticipant = (lobby.tiedParticipantsList || []).some(u => u.toLowerCase() === activeUsername);
        const streamMsg = document.getElementById('tie-breaker-stream-msg');
        if (streamMsg) streamMsg.innerText = isTiedParticipant ? 'You are tied! Pick your tie-breaker card below:' : 'Waiting for tied participants to draw cards...';

        let streamHtml = '';
        if (isTiedParticipant && !lobby.drawResults?.[me?.username]) {
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
                const isMyTurn = (lobby.currentTurnUser && lobby.currentTurnUser.toLowerCase() === activeUsername);
                turnBanner.innerText = isMyTurn ? "YOUR TURN!" : `Turn: ${lobby.currentTurnUser}`;
            } else if (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd') {
                turnBanner.innerText = lobby.phaseMessage || 'Round Over';
            }
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
            <div class="card-slot back" onclick="drawCard('deck')">
                <div class="card-back-inner"></div>
                <div class="deck-counter">${lobby.deckCount || 0} left</div>
            </div>
            <div class="card-slot" onclick="drawCard('discard')">${discardTopHtml}</div>
        </div>
    `;

    lobby.players.forEach((p, idx) => {
        const revealedCardsHtml = p.cards && p.cards.length > 0 ? `<div class="seat-cards">${p.cards.map(c => formatCardHtml(c, true)).join('')}</div>` : '';
        const statusBadge = p.eliminated ? ' [OUT]' : '';
        const readyStatusIcon = p.ready ? '✅' : '❌';
        const botBadge = p.isBot ? ' 🤖' : '';
        const isCurrentTurnUserSeat = (lobby.currentTurnUser && p.username.toLowerCase() === lobby.currentTurnUser.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        const isDealer = (idx === lobby.dealerIndex);
        const dealerBadgeHtml = isDealer ? `<span class="dealer-badge">D</span>` : '';
        const micIcon = p.inVC ? (p.isMuted ? ' 🔇' : ' 🎙️') : '';

        let peekerBadgesHtml = '';
        if (p.username.toLowerCase() === activeUsername && p.peekAllowed) {
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

    if (container) {
        container.innerHTML = html;
        if (nextHandOverlay) container.appendChild(nextHandOverlay);
    }

    if (me && me.cards) {
        const cardsHtml = me.cards.map((c, i) => `
            <div onclick="discardCard(${i})">
                ${formatCardHtml(c, false, 'my-card')}
            </div>
        `).join('');
        const myCardsCont = document.getElementById('my-cards-container');
        const myScoreDisp = document.getElementById('my-score-display');
        if (myCardsCont) myCardsCont.innerHTML = cardsHtml;
        if (myScoreDisp) myScoreDisp.innerText = calculateLocalScore(me.cards);
    } else {
        const myCardsCont = document.getElementById('my-cards-container');
        const myScoreDisp = document.getElementById('my-score-display');
        if (myCardsCont) myCardsCont.innerHTML = '';
        if (myScoreDisp) myScoreDisp.innerText = '0';
    }
}

function resetToMainMenu() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    window.appGlobals.lastChatCount = 0;
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

    const topRowBtns = document.getElementById('in-game-top-row-btns');
    if (topRowBtns) topRowBtns.style.display = 'none';

    const toolsRow = document.getElementById('in-game-tools-row');
    if (toolsRow) toolsRow.style.display = 'none';

    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'none';

    const chatWin = document.getElementById('chat-window');
    if (chatWin) chatWin.style.display = 'none';

    const box = document.getElementById('chat-messages');
    if (box) box.innerHTML = '';

    if (window.clientState) window.clientState.isReady = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';
    refreshLobbies();
}

// Global Window Exports
window.formatCardHtml = formatCardHtml;
window.calculateLocalScore = calculateLocalScore;
window.showCenterNotification = showCenterNotification;
window.toggleModal = toggleModal;
window.toggleVoiceOnOff = toggleVoiceOnOff;
window.triggerVoiceReconnect = triggerVoiceReconnect;
window.openSettingsModal = openSettingsModal;
window.openVcParticipantsModal = openVcParticipantsModal;
window.toggleChatWindow = toggleChatWindow;
window.toggleGlobalSidebar = toggleGlobalSidebar;
window.sendChatMessage = sendChatMessage;
window.appendChatMessage = appendChatMessage;
window.syncChatHistory = syncChatHistory;
window.stopPeekingAction = stopPeekingAction;
window.kickPeekerAction = kickPeekerAction;
window.refreshLobbies = refreshLobbies;
window.renderLobbyList = renderLobbyList;
window.createLobby = createLobby;
window.joinLobby = joinLobby;
window.joinLobbyCode = joinLobbyCode;
window.standUp = standUp;
window.sitDown = sitDown;
window.updateWager = updateWager;
window.updateSettings = updateSettings;
window.submitLivesVote = submitLivesVote;
window.addBot = addBot;
window.removeBot = removeBot;
window.toggleReady = toggleReady;
window.clickNextHand = clickNextHand;
window.proposeEndGame = proposeEndGame;
window.leaveLobby = leaveLobby;
window.drawCard = drawCard;
window.discardCard = discardCard;
window.choosePoolCard = choosePoolCard;
window.tapSeat = tapSeat;
window.requestPeekFromModal = requestPeekFromModal;
window.betOnHimFromModal = betOnHimFromModal;
window.submitEliminationProposal = submitEliminationProposal;
window.submitGlobalProposal = submitGlobalProposal;
window.acceptGlobalProposal = acceptGlobalProposal;
window.confirmGlobalBet = confirmGlobalBet;
window.openConfirmModal = openConfirmModal;
window.respondToBet = respondToBet;
window.openActiveBetsModal = openActiveBetsModal;
window.openSpectatorListModal = openSpectatorListModal;
window.knockRound = knockRound;
window.updateUIFromLobby = updateUIFromLobby;
window.resetToMainMenu = resetToMainMenu;
