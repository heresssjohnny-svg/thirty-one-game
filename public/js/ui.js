// public/js/ui.js - Complete DOM, Felt Table, Audio Cues & State Coordinator

// -------------------------------------------------------------
// 1. STATE & GLOBAL SAFEGUARDS
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
    wasMyTurn: false,
    lastKnownKnockedBy: null,
    hasChosenPoolCard: false,
    lastPhaseMessage: '',
    lastGameState: '',
    lastCelebratedWinner: null,
    notificationTimer: null
};

// -------------------------------------------------------------
// 2. MODAL, CHAT & NOTIFICATION HELPERS
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
    }
};

window.appendChatMessage = function(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.innerHTML = `<b>${user}:</b> ${msg}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    const chatWin = document.getElementById('chat-window');
    if (chatWin && chatWin.style.display !== 'flex') {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (•)';
        }
    }
};

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
        if (typeof sendFunc === 'function') {
            sendFunc({ type: 'CHAT_MESSAGE', message: text });
        }
        input.value = '';
    }
};

window.toggleGlobalSidebar = function() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) {
        sidebar.style.display = (sidebar.style.display === 'none') ? 'flex' : 'none';
    }
};

// -------------------------------------------------------------
// 3. CARD FORMATTING & HAND SCORING
// -------------------------------------------------------------
window.formatCardHtml = function(card, isMini = false) {
    if (!card) return '';
    const isRed = ['♥', '♦'].includes(card.suit);
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    if (isMini) {
        return `
            <div class="mini-card ${suitClass}">
                <span class="mini-val">${card.val}</span>
                <span class="mini-suit">${card.suit}</span>
            </div>
        `;
    }
    return `
        <div class="my-card ${suitClass}">
            <span class="card-value">${card.val}</span>
            <span class="card-suit-large">${card.suit}</span>
        </div>
    `;
};

window.calculateLocalScore = function(cards) {
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    const sums = {};
    scoringCards.forEach(c => { sums[c.suit] = (sums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
};

// -------------------------------------------------------------
// 4. LOBBY LIST RENDERER
// -------------------------------------------------------------
window.renderLobbyList = function(lobbies) {
    const container = document.getElementById('lobby-list');
    if (!container) return;

    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:10px; font-size:0.75rem;">No active tables found.</div>';
        return;
    }

    container.innerHTML = lobbies.map(l => {
        const count = l.count || (l.players ? l.players.length : 0);
        const isOpen = (l.state === 'lobby' || l.gameState === 'lobby');
        return `
            <div class="lobby-item" onclick="joinLobbyCode('${l.code}')" style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; border-bottom:1px solid rgba(250,204,21,0.15); cursor:pointer;">
                <span style="font-size:0.78rem;">
                    <b>${l.name}</b> (${count}/6) — <i style="color:${isOpen ? '#34d399' : '#fbbf24'};">${isOpen ? 'Open' : 'In-Progress'}</i>
                </span>
                <span style="color:var(--accent-gold); font-size:0.75rem; font-weight:bold;">Enter →</span>
            </div>
        `;
    }).join('');
};

window.renderPublicLobbies = window.renderLobbyList;

// -------------------------------------------------------------
// 5. KNOCK ENFORCEMENT & AUDIO CUES
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
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
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

    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'KNOCK' });
    if (typeof playSound === 'function') playSound('knock');
};

// -------------------------------------------------------------
// 6. MASTER TABLE & GAME STATE RENDERER
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    const authScreen = document.getElementById('auth-screen');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const inGameBtns = document.getElementById('in-game-header-btns') || document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');

    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    if (inGameBtns) inGameBtns.style.display = 'inline-flex';
    if (toolsRow) toolsRow.style.display = 'flex';

    const endBtn = document.getElementById('end-game-btn');
    const leaveBtn = document.getElementById('leave-lobby-btn');
    if (endBtn) endBtn.style.display = 'inline-block';
    if (leaveBtn) leaveBtn.style.display = 'inline-block';

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name} [${lobby.code}]`;

    const activeUsername = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();

    // 1. Tournament Winner Celebration
    const hasWinner = lobby.tournamentWinner || (lobby.phaseMessage && lobby.phaseMessage.includes('TOURNAMENT WINNER'));
    if (hasWinner) {
        let winnerName = lobby.tournamentWinner;
        if (!winnerName && lobby.phaseMessage) {
            const m = lobby.phaseMessage.match(/TOURNAMENT WINNER!\s+(.*?)\s+wins/);
            if (m && m[1]) winnerName = m[1].trim();
        }
        if (winnerName && window.appGlobals.lastCelebratedWinner !== winnerName) {
            window.appGlobals.lastCelebratedWinner = winnerName;
            if (typeof triggerWinnerCelebration === 'function') triggerWinnerCelebration(winnerName);
        }
    }
    if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
        window.appGlobals.lastCelebratedWinner = null;
    }

    // 2. State Transition Cleanups
    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            const topleft = document.getElementById('discard-pickup-topleft-modal');
            const fedModal = document.getElementById('fed-card-topright-modal');
            if (topleft) topleft.style.display = 'none';
            if (fedModal) fedModal.style.display = 'none';
            window.appGlobals.wasMyTurn = false;
        }
    }

    // 3. Knock Visuals & Cues
    updateKnockAlertAndAudio(lobby);

    // 4. Discard Pickup & Fed-Card Modals
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        if (topleftContent) {
            topleftContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${window.formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
        }
        if (topleftModal) topleftModal.style.display = 'flex';
    } else if (topleftModal) {
        topleftModal.style.display = 'none';
    }

    const fedModal = document.getElementById('fed-card-topright-modal');
    const fedContent = document.getElementById('fed-card-content');
    const fedLabel = document.getElementById('fed-card-label');
    if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
        if (fedLabel) fedLabel.innerText = `${lobby.myFedCardReminder.target} took your:`;
        if (fedContent) fedContent.innerHTML = window.formatCardHtml(lobby.myFedCardReminder.card, true);
        if (fedModal) fedModal.style.display = 'flex';
    } else if (fedModal) {
        fedModal.style.display = 'none';
    }

    // 5. Client State Caches
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

    if (me) {
        window.clientState.isReady = me.ready;
        const readyBtn = document.getElementById('ready-btn');
        if (readyBtn) readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';
    }

    // 6. Action Dock Button Visibility
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
                sitBtn.disabled = (lobby.players || []).length >= 6;
            }
        }
    } else {
        if (sitBtn) sitBtn.style.display = 'none';
        if (standUpBtn) standUpBtn.style.display = 'none';
        if (readyBtn) readyBtn.style.display = 'none';
        if (knockBtn) knockBtn.style.display = isSpectatorOnly ? 'none' : 'inline-block';
    }

    // 7. Turn Action & yourturn.mp3 Audio Cue
    const isMyTurnPlaying = (lobby.currentTurnUser?.toLowerCase() === activeUsername.toLowerCase()) && 
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

    // 8. Next Hand Overlay
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    if (lobby.gameState === 'roundOver' && !isSpectatorOnly && nextHandOverlay) {
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
    } else if (nextHandOverlay) {
        nextHandOverlay.style.display = 'none';
    }

    // 9. Dealer Draw & Tie Breaker Modals
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
                gridHtml += `<div class="pool-card-item" ${clickable ? `onclick="choosePoolCard(${slot.index})"` : ''} style="width:36px; height:50px; background:#1e3a8a; color:#fff; display:flex; align-items:center; justify-content:center; border-radius:4px; cursor:pointer; font-weight:bold; ${!clickable ? 'opacity:0.4; cursor:not-allowed;' : ''}">?</div>`;
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
            streamHtml += `<div style="width:100%; display:flex; gap:6px; justify-content:center; flex-wrap:wrap; margin-bottom:8px;">`;
            (lobby.drawPool || []).forEach((slot) => {
                if (!slot.chosenBy) {
                    streamHtml += `<div class="pool-card-item" onclick="choosePoolCard(${slot.index})" style="width:36px; height:50px; background:#1e3a8a; color:#fff; display:flex; align-items:center; justify-content:center; border-radius:4px; cursor:pointer; font-weight:bold;">?</div>`;
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
            } else if (lobby.gameState === 'roundOver') {
                turnBanner.innerText = lobby.phaseMessage || 'Round Over';
            }
        }
    }

    // 10. Table Oval & Player Seats
    const tableContainer = document.getElementById('table-oval-container');
    if (tableContainer) {
        const discardTopHtml = lobby.discardTop ? window.formatCardHtml(lobby.discardTop, false) : 'Empty';
        let html = `
            <div class="pots-container">
                <div class="pot-total-display" id="pot-total-banner">Pot: $${lobby.potTotal || 0}</div>
            </div>
            <div class="deck-center" style="display:flex; gap:12px; align-items:center; z-index:5;">
                <div class="card-slot back" onclick="drawCard('deck')">DECK<div class="deck-counter">${lobby.deckCount || 0}</div></div>
                <div class="card-slot" onclick="drawCard('discard')">${discardTopHtml}</div>
            </div>
        `;

        (lobby.players || []).forEach(p => {
            const isCurrent = (p.username.toLowerCase() === (lobby.currentTurnUser || '').toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
            const isDealer = lobby.players[lobby.dealerIndex]?.username === p.username || lobby.dealerName === p.username;
            const dealerBadge = isDealer ? '<span class="dealer-badge">D</span>' : '';
            const botBadge = p.isBot ? ' 🤖' : '';
            const statusBadge = p.eliminated ? ' [OUT]' : '';
            const readyIcon = p.ready ? '✅' : '❌';

            let revealedCards = '';
            if (p.cards && p.cards.length > 0) {
                revealedCards = `<div class="seat-cards" style="display:flex; gap:2px; justify-content:center; margin-top:2px;">` +
                    p.cards.map(c => window.formatCardHtml(c, true)).join('') + `</div>`;
            }

            html += `
                <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}">
                    <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                        <span>${readyIcon}</span> <b>${p.username}${botBadge}${statusBadge}</b>${dealerBadge}<br>
                        Lives: ${p.lives} | $${p.wager || 5}
                    </div>
                    ${revealedCards}
                </div>
            `;
        });

        tableContainer.innerHTML = html;
        if (nextHandOverlay) tableContainer.appendChild(nextHandOverlay);
    }

    // 11. My Hand Cards
    const handContainer = document.getElementById('my-cards-container');
    const scoreDisplay = document.getElementById('my-score-display');
    if (me && me.cards && handContainer) {
        handContainer.innerHTML = me.cards.map((c, i) => `
            <div class="my-card ${['♥', '♦'].includes(c.suit) ? 'red-suit' : 'black-suit'}" onclick="discardCard(${i})">
                <span class="card-value">${c.val}</span>
                <span class="card-suit-large">${c.suit}</span>
            </div>
        `).join('');

        if (scoreDisplay) scoreDisplay.innerText = window.calculateLocalScore(me.cards);
    } else if (handContainer) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.innerText = '0';
    }
};

window.renderLobbyState = window.updateUIFromLobby;

// -------------------------------------------------------------
// 7. IN-GAME ACTION HANDLERS
// -------------------------------------------------------------
window.drawCard = function(source) {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc({ type: 'DISCARD_CARD', index: cardIndex, cardIndex: cardIndex });
    }
};

window.choosePoolCard = function(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'CHOOSE_POOL_CARD', cardIndex });
};

window.clickNextHand = function() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'NEXT_HAND_READY' });
};

window.toggleReady = function() {
    window.clientState.isReady = !window.clientState.isReady;
    const btn = document.getElementById('ready-btn');
    if (btn) btn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'SET_READY', ready: window.clientState.isReady });
};

window.standUp = function() {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'STAND_UP' });
};

window.sitDown = function() {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'SIT_DOWN' });
};

window.updateWager = function() {
    const wager = document.getElementById('config-wager')?.value;
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'UPDATE_WAGER', wager: parseInt(wager, 10) || 5 });
};

window.updateSettings = function() {
    const lives = document.getElementById('config-lives')?.value;
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'UPDATE_SETTINGS', lives: parseInt(lives, 10) || 3 });
};

window.addBot = function() {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'ADD_BOT' });
};

window.removeBot = function() {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'REMOVE_BOT' });
};

window.stopPeekingAction = function() {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
};

window.proposeEndGame = function() {
    if (confirm("Propose ending the game and returning to the ready room?")) {
        const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
        if (typeof sendFunc === 'function') sendFunc({ type: 'END_GAME_PROPOSAL' });
    }
};

window.leaveLobby = function() {
    if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'LEAVE_LOBBY' });
};

window.resetToMainMenu = function() {
    window.appGlobals.currentJoinedCode = null;
    window.appGlobals.latestLobbySnapshot = null;
    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    const inGameBtns = document.getElementById('in-game-header-btns') || document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');

    if (gameView) gameView.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';
    if (inGameBtns) inGameBtns.style.display = 'none';
    if (toolsRow) toolsRow.style.display = 'none';

    window.clientState.isReady = false;
    window.appGlobals.hasChosenPoolCard = false;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = 'Ready Up';
    if (typeof refreshLobbies === 'function') refreshLobbies();
};

window.tapSeat = function(targetUsername) {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
    if (window.clientState.gameState === 'lobby') return;
    if (targetUsername.toLowerCase() === activeUsername.toLowerCase()) return;

    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Side Bet on ${targetUsername}`;
    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:8px;">Wager that ${targetUsername} is eliminated before you:</p>
            <button onclick="submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
        `;
    }
    window.toggleModal('bet-modal');
};

window.submitEliminationProposal = function(target, wagerAmt) {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') sendFunc({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`Side bet proposed to ${target}!`);
};
