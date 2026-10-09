// public/js/ui.js - HUD Notifications, Audio Cues & Dealer Draw Renderers (PART 1 OF 2)

// -------------------------------------------------------------
// 1. NOTIFICATION BANNERS & IN-GAME ALERTS
// -------------------------------------------------------------
let notificationTimer = null;

window.showCenterNotification = function(message, duration = 3200) {
    const banner = document.getElementById('center-notification-banner') || 
                   document.getElementById('notification-banner') || 
                   document.getElementById('center-notification');
    if (!banner) return;

    banner.innerText = message;
    banner.style.display = 'block';

    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
        banner.style.display = 'none';
        notificationTimer = null;
    }, duration);
};

window.showKnockAlert = function(knockerName) {
    const knockAlert = document.getElementById('knock-alert-modal') || 
                       document.getElementById('knock-banner');
    if (knockAlert) {
        knockAlert.innerText = `🔔 ${knockerName} KNOCKED! FINAL ROUND!`;
        knockAlert.style.display = 'block';
        setTimeout(() => {
            knockAlert.style.display = 'none';
        }, 4500);
    }
    // Audio trigger for knock
    window.triggerAudioCue('knock');
};

// -------------------------------------------------------------
// 2. AUDIO & HAPTIC DISPATCH ENGINE
// -------------------------------------------------------------
window.triggerAudioCue = function(cueType) {
    try {
        if (cueType === 'yourturn') {
            if (typeof window.playYourTurnSound === 'function') {
                window.playYourTurnSound();
            } else {
                const turnAudio = new Audio('/mp3s/yourturn.mp3');
                turnAudio.play().catch(() => {});
            }
            if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
        } else if (cueType === 'knock') {
            if (typeof window.playKnockSound === 'function') {
                window.playKnockSound();
            } else {
                const knockAudio = new Audio('/mp3s/knock.mp3');
                knockAudio.play().catch(() => {});
            }
            if (navigator.vibrate) navigator.vibrate([150, 100, 200]);
        } else if (cueType === 'card') {
            if (typeof window.playCardSound === 'function') {
                window.playCardSound();
            }
        }
    } catch (e) {
        console.warn('[Audio] Trigger exception:', e);
    }
};

// -------------------------------------------------------------
// 3. CARD HTML GENERATOR (AUTHENTIC DUAL-CORNER CASINO CARDS)
// -------------------------------------------------------------
window.renderCardHTML = function(card, customClasses = '') {
    if (!card || card.val === '?' || card.suit === '?') {
        return `
            <div class="playing-card card-back ${customClasses}">
                <div class="card-inner-pattern"></div>
            </div>
        `;
    }

    const isRed = card.suit === '♥' || card.suit === '♦';
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    return `
        <div class="playing-card ${suitClass} ${customClasses}" data-val="${card.val}" data-suit="${card.suit}">
            <div class="card-corner top-left">
                <span class="corner-val">${card.val}</span>
                <span class="corner-suit">${card.suit}</span>
            </div>
            <div class="card-center-pip">${card.suit}</div>
            <div class="card-corner bottom-right">
                <span class="corner-val">${card.val}</span>
                <span class="corner-suit">${card.suit}</span>
            </div>
        </div>
    `;
};

// -------------------------------------------------------------
// 4. MODAL DIALOG TOGGLE CONTROLLER
// -------------------------------------------------------------
window.toggleModal = function(modalId, forceState) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const isOpen = modal.style.display === 'flex' || modal.style.display === 'block';
    const nextState = typeof forceState === 'boolean' ? forceState : !isOpen;

    modal.style.display = nextState ? 'flex' : 'none';
};

// -------------------------------------------------------------
// 5. DEALER DRAW & TIE-BREAKER MODAL RENDERER
// -------------------------------------------------------------
window.renderDealerDrawPhase = function(lobby) {
    const modal = document.getElementById('dealer-draw-modal');
    if (!modal) return;

    const isDrawPhase = lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker';
    if (!isDrawPhase) {
        modal.style.display = 'none';
        return;
    }

    modal.style.display = 'flex';

    // 1. Title Header
    const titleEl = document.getElementById('dealer-draw-title');
    if (titleEl) {
        titleEl.innerText = lobby.gameState === 'tieBreaker' ? '⚔️ Tie-Breaker Draw' : '👑 Draw for Dealer';
    }

    // 2. Status & Subtitle Instructions
    const statusEl = document.getElementById('dealer-draw-status');
    if (statusEl) {
        statusEl.innerText = lobby.phaseMessage || 
            (lobby.gameState === 'tieBreaker' 
                ? 'Tied players: Pick a card. Lowest card loses a life!' 
                : 'Everyone pick a card! Lowest card deals first (Ace is highest).');
    }

    // 3. Draw Order & Chosen Showcase Sequence
    const sequenceEl = document.getElementById('draw-order-sequence');
    if (sequenceEl) {
        const orderList = lobby.drawResults || {};
        let orderHtml = '';

        const activeParticipants = lobby.gameState === 'tieBreaker'
            ? (lobby.tiedParticipantsList || [])
            : (lobby.players || []).filter(p => !p.eliminated).map(p => p.username);

        activeParticipants.forEach(uname => {
            const card = orderList[uname];
            orderHtml += `
                <div class="draw-showcase-item">
                    <span class="draw-picker-badge">${uname}</span>
                    ${card ? window.renderCardHTML(card, 'showcase-card') : '<div class="draw-card-waiting">Picking...</div>'}
                </div>
            `;
        });
        sequenceEl.innerHTML = orderHtml;
    }

    // 4. 52-Card Pool Grid
    const poolGrid = document.getElementById('draw-pool-grid');
    if (poolGrid && Array.isArray(lobby.drawPool)) {
        const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
        const hasPicked = Boolean(lobby.drawResults && lobby.drawResults[myName]);
        const isEligible = lobby.gameState !== 'tieBreaker' || (lobby.tiedParticipantsList && lobby.tiedParticipantsList.some(u => u.toLowerCase() === myName));

        let gridHtml = '';
        lobby.drawPool.forEach((item, index) => {
            const isTaken = Boolean(item.chosenBy);
            const clickable = !isTaken && !hasPicked && isEligible;

            gridHtml += `
                <div class="pool-card-item ${isTaken ? 'taken' : ''} ${clickable ? 'selectable' : ''}" 
                     data-index="${index}"
                     onclick="${clickable ? `window.choosePoolCard(${index})` : ''}">
                    ${isTaken ? '✓' : index + 1}
                </div>
            `;
        });
        poolGrid.innerHTML = gridHtml;
    }
};

// -------------------------------------------------------------
// 6. TOP HUD FEEDS: DISCARD PICKUP & FED CARDS
// -------------------------------------------------------------
window.updateTopCornerFeeds = function(lobby) {
    // 1. Top-Left Discard Pickup Feed
    const discardFeed = document.getElementById('discard-pickup-topleft-modal') || 
                        document.getElementById('discard-pickup-modal');
    const discardCardBox = document.getElementById('discard-pickup-card-content');

    if (discardFeed && discardCardBox) {
        if (lobby.lastDiscardPickup && lobby.lastDiscardPickup.card) {
            discardCardBox.innerHTML = `
                <span>${lobby.lastDiscardPickup.username} drew:</span>
                <span class="mini-card ${lobby.lastDiscardPickup.card.suit === '♥' || lobby.lastDiscardPickup.card.suit === '♦' ? 'red-suit' : 'black-suit'}">
                    ${lobby.lastDiscardPickup.card.val}${lobby.lastDiscardPickup.card.suit}
                </span>
            `;
            discardFeed.style.display = 'flex';
        } else {
            discardFeed.style.display = 'none';
        }
    }

    // 2. Top-Right Fed Card Reminder Feed
    const fedFeed = document.getElementById('fed-card-topright-modal') || 
                    document.getElementById('fed-card-modal');
    const fedLabel = document.getElementById('fed-card-label');

    if (fedFeed) {
        if (lobby.myFedCardReminder && lobby.myFedCardReminder.card) {
            if (fedLabel) {
                fedLabel.innerText = `Fed to ${lobby.myFedCardReminder.target}: ${lobby.myFedCardReminder.card.val}${lobby.myFedCardReminder.card.suit}`;
            }
            fedFeed.style.display = 'flex';
        } else {
            fedFeed.style.display = 'none';
        }
    }
};
// public/js/ui.js - Master Table Renderer, Seats 0-5, My Hand & Action Controls (PART 2 OF 2)

// -------------------------------------------------------------
// 7. IN-GAME ACTION CONTROLS & TURN STATE ENGINE
// -------------------------------------------------------------
let previousTurnUser = null;
let previousKnockedBy = null;

window.updateActionButtons = function(lobby) {
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const me = lobby.players?.find(p => p.username?.toLowerCase() === myName);
    const isMyTurn = lobby.currentTurnUser?.toLowerCase() === myName;
    const isPlaying = lobby.gameState === 'playing' || lobby.gameState === 'finalTurn';

    const drawDeckBtn = document.getElementById('draw-deck-btn');
    const drawDiscardBtn = document.getElementById('draw-discard-btn');
    const knockBtn = document.getElementById('knock-btn');
    const readyBtn = document.getElementById('ready-btn');
    const nextHandBtn = document.getElementById('next-hand-btn');

    // 1. Ready & Next Hand Buttons
    if (readyBtn) {
        if (lobby.gameState === 'lobby') {
            readyBtn.style.display = 'inline-flex';
            readyBtn.innerText = me?.ready ? 'Unready' : 'Ready Up';
            readyBtn.disabled = false;
        } else {
            readyBtn.style.display = 'none';
        }
    }

    if (nextHandBtn) {
        if (lobby.gameState === 'roundOver') {
            nextHandBtn.style.display = 'inline-flex';
            nextHandBtn.disabled = Boolean(me?.nextHandReady);
            nextHandBtn.innerText = me?.nextHandReady ? 'Waiting...' : 'Next Hand';
        } else {
            nextHandBtn.style.display = 'none';
        }
    }

    // 2. Play Actions (Draw & Knock)
    const cardCount = me?.cards?.length || 0;
    const canDraw = isPlaying && isMyTurn && cardCount === 3;
    const canKnock = isPlaying && isMyTurn && cardCount === 3 && lobby.canKnock && !lobby.knockedBy;

    if (drawDeckBtn) {
        drawDeckBtn.disabled = !canDraw;
    }
    if (drawDiscardBtn) {
        drawDiscardBtn.disabled = !canDraw || !lobby.discardTop;
    }
    if (knockBtn) {
        knockBtn.disabled = !canKnock;
        knockBtn.style.display = lobby.gameState === 'finalTurn' ? 'none' : 'inline-flex';
    }
};

// -------------------------------------------------------------
// 8. MY HAND SECTION (HORIZONTAL & ENLARGED)
// -------------------------------------------------------------
window.renderMyHand = function(lobby) {
    const container = document.getElementById('my-cards-container');
    if (!container) return;

    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const me = lobby.players?.find(p => p.username?.toLowerCase() === myName);

    if (!me || me.eliminated || !Array.isArray(me.cards) || me.cards.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted); font-size:0.8rem; padding:12px;">No active cards</div>`;
        return;
    }

    const isMyTurn = lobby.currentTurnUser?.toLowerCase() === myName;
    const mustDiscard = (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') && isMyTurn && me.cards.length === 4;

    let handHtml = '';
    me.cards.forEach((card, index) => {
        const discardAttr = mustDiscard ? `onclick="window.discardCard(${index})"` : '';
        const customClasses = `my-card ${mustDiscard ? 'selectable-discard' : ''}`;
        handHtml += `
            <div style="display:inline-block;" ${discardAttr}>
                ${window.renderCardHTML(card, customClasses)}
            </div>
        `;
    });

    container.innerHTML = handHtml;
};

// -------------------------------------------------------------
// 9. TABLE SEATS (SEATS 0 - 5) & FELT CENTER
// -------------------------------------------------------------
window.renderSeats = function(lobby) {
    const seatsContainer = document.getElementById('table-seats-container') || 
                           document.getElementById('felt-seats-layer');
    if (!seatsContainer) return;

    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    let seatsHtml = '';

    // Render 6 configured seat positions
    for (let seatIndex = 0; seatIndex < 6; seatIndex++) {
        const player = lobby.players?.find(p => p.seat === seatIndex);
        const seatId = `seat-${seatIndex}`;

        if (!player) {
            // Empty Seat
            const canSit = lobby.gameState === 'lobby' && !lobby.players?.some(p => p.username?.toLowerCase() === myName);
            seatsHtml += `
                <div class="table-seat empty-seat" id="${seatId}">
                    ${canSit ? `<button class="sit-btn secondary" onclick="window.sitDown()">Sit</button>` : `<div class="empty-seat-slot">Empty</div>`}
                </div>
            `;
            continue;
        }

        const isTurn = lobby.currentTurnUser?.toLowerCase() === player.username?.toLowerCase();
        const isDealer = lobby.dealerIndex === lobby.players?.indexOf(player);
        const isEliminated = Boolean(player.eliminated);

        let livesPips = '';
        for (let l = 0; l < (lobby.defaultLives || 3); l++) {
            livesPips += `<span class="life-pip ${l < player.lives ? 'active' : 'lost'}">♥</span>`;
        }

        let miniCardsHtml = '';
        if (Array.isArray(player.cards)) {
            player.cards.forEach(c => {
                miniCardsHtml += window.renderCardHTML(c, 'table-mini-card');
            });
        }

        seatsHtml += `
            <div class="table-seat ${isTurn ? 'active-turn' : ''} ${isEliminated ? 'eliminated' : ''}" id="${seatId}">
                <div class="seat-badge ${isDealer ? 'dealer-badge' : ''}">
                    ${isDealer ? '👑 ' : ''}${player.username} ${player.isBot ? '🤖' : ''}
                </div>
                <div class="seat-lives">${livesPips}</div>
                <div class="seat-cards">${miniCardsHtml}</div>
            </div>
        `;
    }

    seatsContainer.innerHTML = seatsHtml;
};

window.renderFeltCenter = function(lobby) {
    // 1. Pot Total
    const potEl = document.getElementById('pot-display') || document.getElementById('pot-total');
    if (potEl) {
        potEl.innerText = `$${lobby.potTotal || 0}`;
    }

    // 2. Deck Stack Count
    const deckCountEl = document.getElementById('deck-count') || document.getElementById('deck-remaining-count');
    if (deckCountEl) {
        deckCountEl.innerText = lobby.deckCount || 0;
    }

    // 3. Discard Pile Top Card
    const discardSlot = document.getElementById('discard-card-slot') || document.getElementById('discard-pile-top');
    if (discardSlot) {
        if (lobby.discardTop) {
            discardSlot.innerHTML = window.renderCardHTML(lobby.discardTop, 'discard-card');
        } else {
            discardSlot.innerHTML = `<div class="card-slot-placeholder">Empty</div>`;
        }
    }

    // 4. Status and Phase Message
    const phaseEl = document.getElementById('table-status-message') || 
                    document.getElementById('phase-message') || 
                    document.getElementById('game-status-banner');
    if (phaseEl && lobby.phaseMessage) {
        phaseEl.innerText = lobby.phaseMessage;
    }

    // 5. Room Title Header
    const titleEl = document.getElementById('room-title-display');
    if (titleEl && lobby.name) {
        titleEl.innerText = `${lobby.name} (${lobby.code})`;
    }
};

// -------------------------------------------------------------
// 10. CHAT DRAWER & SIDE BETS FEED
// -------------------------------------------------------------
window.appendChatMessage = function(username, message) {
    const chatContainer = document.getElementById('chat-messages');
    if (!chatContainer) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-entry';
    msgDiv.innerHTML = `<strong style="color:var(--accent-gold);">${username}:</strong> <span>${message}</span>`;
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    const chatWindow = document.getElementById('chat-window');
    const toggleBtn = document.getElementById('chat-toggle-btn');
    if (toggleBtn && (!chatWindow || chatWindow.style.display === 'none')) {
        toggleBtn.classList.add('unread');
    }
};

window.toggleChatWindow = function() {
    const chatWindow = document.getElementById('chat-window');
    const toggleBtn = document.getElementById('chat-toggle-btn');
    if (!chatWindow) return;

    const isVisible = chatWindow.style.display === 'flex';
    chatWindow.style.display = isVisible ? 'none' : 'flex';

    if (toggleBtn && !isVisible) {
        toggleBtn.classList.remove('unread');
    }
};

window.renderGlobalProposals = function(lobby) {
    const container = document.getElementById('global-proposals-container') || 
                      document.getElementById('pending-bets-banner');
    if (!container) return;

    const proposals = lobby.globalProposals || [];
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();

    let html = '';
    proposals.forEach(prop => {
        const isMine = prop.proposer?.toLowerCase() === myName;
        html += `
            <div class="global-bet-toast">
                <span><strong>${prop.proposer}</strong> bets $${prop.wagerAmt} on <em>${prop.pickUser}</em></span>
                ${!isMine ? `<button style="padding:2px 8px; font-size:0.75rem;" onclick="window.acceptGlobalProposal('${prop.id}')">Accept</button>` : '<span style="color:var(--text-muted); font-size:0.7rem;">(Your Bet)</span>'}
            </div>
        `;
    });

    container.innerHTML = html;
};

// -------------------------------------------------------------
// 11. MASTER TABLE RENDER LOOP
// -------------------------------------------------------------
window.updateUIFromLobby = window.renderLobbyState = function(lobby) {
    if (!lobby) return;

    // 1. Audio and Haptic Triggers
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    if (lobby.currentTurnUser && lobby.currentTurnUser.toLowerCase() === myName && previousTurnUser !== myName) {
        window.triggerAudioCue('yourturn');
    }
    previousTurnUser = lobby.currentTurnUser ? lobby.currentTurnUser.toLowerCase() : null;

    if (lobby.knockedBy && lobby.knockedBy !== previousKnockedBy) {
        window.showKnockAlert(lobby.knockedBy);
    }
    previousKnockedBy = lobby.knockedBy || null;

    // 2. Sub-layer renderers
    window.renderDealerDrawPhase(lobby);
    window.updateTopCornerFeeds(lobby);
    window.renderFeltCenter(lobby);
    window.renderSeats(lobby);
    window.renderMyHand(lobby);
    window.updateActionButtons(lobby);
    window.renderGlobalProposals(lobby);

    // 3. Update active spectator count
    const specCount = document.getElementById('spectator-count-badge');
    if (specCount && lobby.spectators) {
        specCount.innerText = `${lobby.spectators.length} Spectating`;
    }
};
