// public/js/ui.js

/**
 * Normalizes card data (object or shorthand string) and produces authentic playing card markup
 * @param {string|object} card - e.g. "10H", { val: "A", suit: "♠" }
 * @param {boolean} isMini - if true, renders compact format for seat previews
 * @param {string} extraClass - optional classes like 'discard-card'
 */
function formatCardHtml(card, isMini = false, extraClass = '') {
    if (!card) {
        return `<div class="card-slot empty-slot ${extraClass}"><span>Empty</span></div>`;
    }

    let val = '';
    let suit = '';

    if (typeof card === 'string') {
        const raw = card.trim().toUpperCase();
        const suitChar = raw.slice(-1);
        val = raw.slice(0, -1);

        const suitMap = {
            'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣',
            '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣'
        };
        suit = suitMap[suitChar] || suitChar;
    } else if (typeof card === 'object') {
        val = card.val || card.value || card.rank || '';
        suit = card.suit || '';
    }

    const isRed = ['♥', '♦', 'H', 'D'].includes(suit);
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

// Card HTML helper
function createCardHTML(card, extraClass = '') {
    return formatCardHtml(card, false, extraClass);
}

function calculateLocalScore(cards) {
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let sums = {};
    scoringCards.forEach(c => { sums[c.suit] = (sums[c.suit] || 0) + (c.points || 0); });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
}

function showCenterNotification(msg) {
    const banner = document.getElementById('center-notification-banner');
    if (!banner) return;
    banner.innerText = msg;
    banner.style.display = 'block';
    if (!window.appGlobals) window.appGlobals = {};
    if (window.appGlobals.notificationTimer) clearTimeout(window.appGlobals.notificationTimer);
    window.appGlobals.notificationTimer = setTimeout(() => {
        banner.style.display = 'none';
    }, 3200);
}

function toggleModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = m.style.display === 'flex' ? 'none' : 'flex';
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

    initSocketAndSend({ type: 'KNOCK' });
}

function updateUIFromLobby(lobby) {
    if (!window.appGlobals) window.appGlobals = {};
    if (!window.clientState) window.clientState = {};

    window.appGlobals.latestLobbySnapshot = lobby;

    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('game-view').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'inline-block';
    document.getElementById('leave-lobby-btn').style.display = 'inline-block';
    
    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'inline-flex';

    const inGameBtns = document.getElementById('in-game-header-btns');
    if (inGameBtns) inGameBtns.style.display = 'flex';

    document.getElementById('room-title-display').innerText = `${lobby.name} [${lobby.code}]`;

    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username;

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
    if (topleftModal) {
        if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
            topleftModal.innerHTML = `
                <div style="display:flex; align-items:center; gap:6px;">
                    <span><b>${lobby.lastDiscardPickup.username}</b> drew:</span>
                    ${formatCardHtml(lobby.lastDiscardPickup.card, false)}
                </div>
            `;
            topleftModal.style.display = 'flex';
        } else {
            topleftModal.style.display = 'none';
        }
    }

    // Fed card reminder modal
    const fedModal = document.getElementById('fed-card-topright-modal');
    if (fedModal) {
        if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
            fedModal.innerHTML = `
                <div style="display:flex; align-items:center; gap:6px;">
                    <span><b>${lobby.myFedCardReminder.target}</b> took your:</span>
                    ${formatCardHtml(lobby.myFedCardReminder.card, false)}
                </div>
            `;
            fedModal.style.display = 'flex';
        } else {
            fedModal.style.display = 'none';
        }
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

    const specCountEl = document.getElementById('spec-count');
    if (specCountEl) specCountEl.innerText = window.clientState.spectatorsList.length;

    const me = lobby.players.find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isSpecUser = (lobby.spectators || []).some(s => s.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // Action button state
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

    // =========================================================================
    // Device Turn Cue Detection (Plays yourturn.mp3 directly via audio.js)
    // =========================================================================
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

    // Tie Breaker Modal
    const tiebreakerModal = document.getElementById('tiebreaker-modal');
    const tiebreakerPool = document.getElementById('tiebreaker-pool');
    if (tiebreakerModal && tiebreakerPool) {
        if (lobby.gameState === 'tieBreaker' && lobby.tieBreakerPool && lobby.tieBreakerPool.length > 0) {
            tiebreakerPool.innerHTML = lobby.tieBreakerPool.map(item => `
                <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
                    <span style="font-size:0.75rem; color:#facc15; font-weight:bold;">${item.username}</span>
                    ${formatCardHtml(item.card, false)}
                </div>
            `).join('');
            tiebreakerModal.style.display = 'flex';
        } else {
            tiebreakerModal.style.display = 'none';
        }
    }

    // =========================================================================
    // Center Table & Draw Screen Cards
    // =========================================================================
    const tableContainer = document.getElementById('table-oval-container');
    const deckCount = (lobby.deck && lobby.deck.length !== undefined) ? lobby.deck.length : (lobby.deckCount || 0);
    const topDiscard = (lobby.discardPile && lobby.discardPile.length > 0) 
        ? lobby.discardPile[lobby.discardPile.length - 1] 
        : lobby.discardTop;

    const discardCardHtml = topDiscard 
        ? formatCardHtml(topDiscard, false) 
        : '<div class="card-slot empty-slot"><span>Empty</span></div>';

    let html = `
        <div class="pots-container">
            <div class="pot-total-display" id="pot-total-banner">Pot: $${lobby.potTotal || 0}</div>
            <div class="side-pot-total-display" id="side-pot-total-banner" style="display:${lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none'};">Side Pots: $${lobby.sidePotTotal || 0}</div>
        </div>
        <div class="deck-center">
            <div class="card-slot back" id="deck-pile" onclick="drawCard('deck')">
                <div class="card-back-inner"></div>
                <div class="deck-counter-badge" id="deck-count-display">${deckCount} left</div>
            </div>
            <div id="discard-pile" onclick="drawCard('discard')">
                ${discardCardHtml}
            </div>
        </div>
    `;

    // Render 6 Seats
    lobby.players.forEach((p) => {
        const revealedCards = p.cards && p.cards.length > 0 
            ? `<div class="seat-cards">${p.cards.map(c => formatCardHtml(c, true)).join('')}</div>` 
            : '';
        const isCurrent = (p.username.toLowerCase() === lobby.currentTurnUser?.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        html += `
            <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}">
                <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                    <span>${p.ready ? '✅' : '❌'}</span> <b>${p.username}${p.eliminated ? ' [OUT]' : ''}</b><br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                </div>
                ${revealedCards}
            </div>
        `;
    });

    if (tableContainer) {
        tableContainer.innerHTML = html;
        if (nextHandOverlay) tableContainer.appendChild(nextHandOverlay);
    }

    // =========================================================================
    // Local Hand Area (Bottom Controls)
    // =========================================================================
    const myCardsContainer = document.getElementById('my-cards-container');
    const myScoreDisplay = document.getElementById('my-score-display');
    if (me && me.cards && myCardsContainer) {
        myCardsContainer.innerHTML = me.cards.map((c, i) => `
            <div onclick="discardCard(${i})">
                ${formatCardHtml(c, false, 'my-card')}
            </div>
        `).join('');
        if (myScoreDisplay) myScoreDisplay.innerText = calculateLocalScore(me.cards);
    }
}

function resetToMainMenu() {
    if (window.appGlobals) {
        window.appGlobals.currentJoinedCode = null;
        window.appGlobals.latestLobbySnapshot = null;
        window.appGlobals.wasMyTurn = false;
    }
    document.getElementById('game-view').style.display = 'none';
    document.getElementById('main-menu').style.display = 'flex';
    document.getElementById('end-game-btn').style.display = 'none';
    document.getElementById('leave-lobby-btn').style.display = 'none';
    
    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'none';
    
    const inGameBtns = document.getElementById('in-game-header-btns');
    if (inGameBtns) inGameBtns.style.display = 'none';

    if (window.clientState) window.clientState.isReady = false;
    if (typeof refreshLobbies === 'function') refreshLobbies();
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
}

function stopPeekingAction() {
    initSocketAndSend({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
}

function tapSeat(targetUsername) {
    if (window.clientState?.gameState === 'lobby') return;
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState?.username;
    if (targetUsername === activeUsername) return;

    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (!modalTitle || !modalBody) return;

    modalTitle.innerText = `Side Bet on ${targetUsername}`;
    modalBody.innerHTML = `
        <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
        <button onclick="submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
        <button onclick="submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
        <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
    `;
    toggleModal('bet-modal');
}
