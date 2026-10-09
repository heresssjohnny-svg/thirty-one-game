// public/js/ui.js - HUD Notifications, Audio Cues, Seats 0-5 & Felt Engine

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
        }
    } catch (e) {
        console.warn('[Audio] Trigger exception:', e);
    }
};

// -------------------------------------------------------------
// 3. CARD HTML GENERATOR
// -------------------------------------------------------------
window.renderCardHTML = function(card, customClasses = '') {
    if (!card || card.val === '?' || card.suit === '?') {
        return `
            <div class="card playing-card card-back ${customClasses}">
                <div class="card-back-pattern">🂠</div>
            </div>
        `;
    }

    const isRed = card.suit === '♥' || card.suit === '♦';
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    return `
        <div class="card playing-card ${suitClass} ${customClasses}" data-val="${card.val}" data-suit="${card.suit}">
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
// 4. DEALER DRAW & TIE-BREAKER MODAL RENDERER
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

    const titleEl = document.getElementById('dealer-draw-title');
    if (titleEl) {
        titleEl.innerText = lobby.gameState === 'tieBreaker' ? '⚔️ Tie-Breaker Draw' : '👑 Draw for Dealer';
    }

    const statusEl = document.getElementById('dealer-draw-status');
    if (statusEl) {
        statusEl.innerText = lobby.phaseMessage || 
            (lobby.gameState === 'tieBreaker' 
                ? 'Tied players: Pick a card. Lowest card loses a life!' 
                : 'Everyone pick a card! Lowest card deals first (Ace is highest).');
    }

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
// 5. TABLE SEATS RENDERER (DIRECT TARGETING FOR SEATS 0 - 5)
// -------------------------------------------------------------
window.renderSeats = function(lobby) {
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const isMeSeated = lobby.players?.some(p => p.isMe || p.username?.toLowerCase() === myName);

    for (let seatIndex = 0; seatIndex < 6; seatIndex++) {
        const seatEl = document.getElementById(`seat-${seatIndex}`) ||
                       document.getElementById(`seat${seatIndex}`) ||
                       document.getElementById(`player-seat-${seatIndex}`) ||
                       document.querySelector(`[data-seat="${seatIndex}"]`) ||
                       document.querySelectorAll('.seat, .table-seat')[seatIndex];

        if (!seatEl) continue;

        const player = lobby.players?.find(p => p.seat === seatIndex);

        if (!player) {
            // Empty Seat State
            seatEl.classList.remove('active-turn', 'dealer-seat', 'ready-seat', 'eliminated');
            seatEl.classList.add('empty-seat');

            const nameEl = seatEl.querySelector('.seat-name, .player-name, .name');
            const statusEl = seatEl.querySelector('.seat-status, .player-status, .status');
            const avatarEl = seatEl.querySelector('.seat-avatar, .avatar, .seat-icon');
            const livesEl = seatEl.querySelector('.seat-lives, .player-lives, .lives');
            const cardsEl = seatEl.querySelector('.seat-cards, .player-cards, .cards');

            const canSit = lobby.gameState === 'lobby' && !isMeSeated;

            if (nameEl) nameEl.innerText = 'Empty';
            if (statusEl) {
                statusEl.innerHTML = canSit ? `<button class="sit-btn" onclick="window.sitDown()" style="padding:2px 8px; font-size:0.75rem;">Sit</button>` : 'Open';
                statusEl.style.color = '';
            }
            if (avatarEl) avatarEl.innerHTML = '👤';
            if (livesEl) livesEl.innerHTML = '';
            if (cardsEl) cardsEl.innerHTML = '';

            if (!nameEl && !statusEl) {
                seatEl.innerHTML = `
                    <div class="seat-avatar">👤</div>
                    <div class="seat-name">Empty</div>
                    <div class="seat-status">${canSit ? `<button class="sit-btn" onclick="window.sitDown()" style="padding:2px 8px; font-size:0.75rem;">Sit</button>` : 'Open'}</div>
                `;
            }
            continue;
        }

        // Occupied Seat State
        const isDealer = lobby.dealerIndex === lobby.players?.indexOf(player);
        const isTurn = lobby.currentTurnUser?.toLowerCase() === player.username?.toLowerCase();
        const isEliminated = Boolean(player.eliminated);

        seatEl.classList.remove('empty-seat');
        seatEl.classList.toggle('active-turn', isTurn);
        seatEl.classList.toggle('dealer-seat', isDealer);
        seatEl.classList.toggle('ready-seat', Boolean(player.ready));
        seatEl.classList.toggle('eliminated', isEliminated);

        const nameEl = seatEl.querySelector('.seat-name, .player-name, .name');
        const statusEl = seatEl.querySelector('.seat-status, .player-status, .status');
        const avatarEl = seatEl.querySelector('.seat-avatar, .avatar, .seat-icon');
        const livesEl = seatEl.querySelector('.seat-lives, .player-lives, .lives');
        const cardsEl = seatEl.querySelector('.seat-cards, .player-cards, .cards');

        let statusText = '';
        let statusColor = '';
        if (isEliminated) {
            statusText = 'Eliminated';
            statusColor = '#ef4444';
        } else if (lobby.gameState === 'lobby') {
            statusText = player.ready ? 'Ready' : 'Waiting...';
            statusColor = player.ready ? '#22c55e' : '#94a3b8';
        } else {
            statusText = isTurn ? 'Turn' : '';
            statusColor = isTurn ? '#f59e0b' : '';
        }

        const avatarIcon = isDealer ? '👑' : (player.isBot ? '🤖' : '👤');

        let livesPips = '';
        const maxLives = lobby.defaultLives || 2;
        for (let l = 0; l < maxLives; l++) {
            const hasLife = l < (player.lives || 0);
            livesPips += `<span class="life-pip ${hasLife ? 'active' : 'lost'}" style="color:${hasLife ? '#ef4444' : 'rgba(255,255,255,0.2)'}; font-size:0.85rem; margin:0 1px;">♥</span>`;
        }

        let miniCardsHtml = '';
        if (Array.isArray(player.cards) && player.cards.length > 0 && lobby.gameState !== 'lobby') {
            player.cards.forEach(c => {
                miniCardsHtml += window.renderCardHTML(c, 'table-mini-card');
            });
        }

        if (nameEl) nameEl.innerText = player.username;
        if (statusEl) {
            statusEl.innerText = statusText;
            if (statusColor) statusEl.style.color = statusColor;
        }
        if (avatarEl) avatarEl.innerHTML = avatarIcon;
        if (livesEl) livesEl.innerHTML = livesPips;
        if (cardsEl) cardsEl.innerHTML = miniCardsHtml;

        if (!nameEl && !statusEl) {
            seatEl.innerHTML = `
                <div class="seat-avatar">${avatarIcon}</div>
                <div class="seat-name" style="font-weight:700;">${player.username}</div>
                <div class="seat-lives">${livesPips}</div>
                <div class="seat-status" style="font-size:0.75rem; color:${statusColor};">${statusText}</div>
                <div class="seat-cards">${miniCardsHtml}</div>
            `;
        }
    }
};

// -------------------------------------------------------------
// 6. MY HAND (HORIZONTAL DISPLAY & CARD ACTIONS)
// -------------------------------------------------------------
window.renderMyHand = function(lobby) {
    const container = document.getElementById('my-cards-container');
    if (!container) return;

    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const me = lobby.players?.find(p => p.isMe) || 
              lobby.players?.find(p => p.username?.toLowerCase() === myName);

    if (!me || me.eliminated || !Array.isArray(me.cards) || me.cards.length === 0 || lobby.gameState === 'lobby') {
        container.innerHTML = `<div style="color:var(--text-muted, #94a3b8); font-size:0.8rem; padding:12px;">No active cards</div>`;
        return;
    }

    const isMyTurn = lobby.currentTurnUser?.toLowerCase() === me.username?.toLowerCase();
    const mustDiscard = (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') && isMyTurn && me.cards.length === 4;

    let handHtml = '';
    me.cards.forEach((card, index) => {
        const discardAttr = mustDiscard ? `onclick="window.discardCard(${index})"` : '';
        const customClasses = `my-card ${mustDiscard ? 'selectable-discard' : ''}`;
        handHtml += `
            <div class="hand-card-wrapper" style="display:inline-block; cursor:${mustDiscard ? 'pointer' : 'default'}; margin:0 4px;" ${discardAttr}>
                ${window.renderCardHTML(card, customClasses)}
            </div>
        `;
    });

    container.innerHTML = handHtml;
};

// -------------------------------------------------------------
// 7. FELT CENTER (DECK & DISCARD SLOTS)
// -------------------------------------------------------------
window.renderFeltCenter = function(lobby) {
    const discardSlot = document.getElementById('discard-card-slot') || 
                        document.getElementById('discard-pile-top') || 
                        document.getElementById('discard-slot') || 
                        document.getElementById('discard-pile');

    if (discardSlot) {
        if (lobby.discardTop && lobby.gameState !== 'lobby') {
            discardSlot.innerHTML = window.renderCardHTML(lobby.discardTop, 'discard-card');
            discardSlot.onclick = () => window.drawFromDiscard();
            discardSlot.style.cursor = 'pointer';
        } else {
            discardSlot.innerHTML = `<div class="card-slot-placeholder" style="text-align:center; font-size:0.75rem; color:#94a3b8;">Empty<br>DISCARD</div>`;
            discardSlot.onclick = null;
            discardSlot.style.cursor = 'default';
        }
    }

    const deckSlot = document.getElementById('deck-card-slot') || 
                     document.getElementById('deck-slot') || 
                     document.getElementById('deck-pile');

    if (deckSlot) {
        deckSlot.onclick = () => window.drawFromDeck();
        deckSlot.style.cursor = 'pointer';
    }

    const deckCountEl = document.getElementById('deck-count') || 
                        document.getElementById('deck-remaining-count');
    if (deckCountEl) {
        deckCountEl.innerText = lobby.deckCount || 0;
    }

    const potEl = document.getElementById('pot-display') || document.getElementById('pot-total');
    if (potEl) {
        potEl.innerText = `$${lobby.potTotal || 0}`;
    }

    const phaseEl = document.getElementById('table-status-message') || 
                    document.getElementById('phase-message') || 
                    document.getElementById('game-status-banner');
    if (phaseEl && lobby.phaseMessage) {
        phaseEl.innerText = lobby.phaseMessage;
    }
};

// -------------------------------------------------------------
// 8. ACTION BUTTONS & TURN ENGINE
// -------------------------------------------------------------
let previousTurnUser = null;
let previousKnockedBy = null;

window.updateActionButtons = function(lobby) {
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const me = lobby.players?.find(p => p.isMe) || 
              lobby.players?.find(p => p.username?.toLowerCase() === myName);
    const isMyTurn = lobby.currentTurnUser?.toLowerCase() === me?.username?.toLowerCase();
    const isPlaying = lobby.gameState === 'playing' || lobby.gameState === 'finalTurn';

    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) {
        if (lobby.gameState === 'lobby') {
            readyBtn.style.display = 'inline-flex';
            readyBtn.innerText = me?.ready ? 'Unready' : 'Ready Up';
            readyBtn.style.background = me?.ready ? '#eab308' : '';
        } else {
            readyBtn.style.display = 'none';
        }
    }

    const drawDeckBtn = document.getElementById('draw-deck-btn');
    const drawDiscardBtn = document.getElementById('draw-discard-btn');
    const knockBtn = document.getElementById('knock-btn');

    const cardCount = me?.cards?.length || 0;
    const canDraw = isPlaying && isMyTurn && cardCount === 3;
    const canKnock = isPlaying && isMyTurn && cardCount === 3 && lobby.canKnock && !lobby.knockedBy;

    if (drawDeckBtn) drawDeckBtn.disabled = !canDraw;
    if (drawDiscardBtn) drawDiscardBtn.disabled = !canDraw || !lobby.discardTop;
    if (knockBtn) {
        knockBtn.disabled = !canKnock;
        knockBtn.style.display = lobby.gameState === 'finalTurn' ? 'none' : 'inline-flex';
    }
};

// -------------------------------------------------------------
// 9. MASTER TABLE RENDER LOOP
// -------------------------------------------------------------
window.updateUIFromLobby = window.renderLobbyState = function(lobby) {
    if (!lobby) return;

    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    if (lobby.currentTurnUser && lobby.currentTurnUser.toLowerCase() === myName && previousTurnUser !== myName) {
        window.triggerAudioCue('yourturn');
    }
    previousTurnUser = lobby.currentTurnUser ? lobby.currentTurnUser.toLowerCase() : null;

    if (lobby.knockedBy && lobby.knockedBy !== previousKnockedBy) {
        window.showKnockAlert(lobby.knockedBy);
    }
    previousKnockedBy = lobby.knockedBy || null;

    window.renderDealerDrawPhase(lobby);
    window.renderSeats(lobby);
    window.renderFeltCenter(lobby);
    window.renderMyHand(lobby);
    window.updateActionButtons(lobby);

    const specCount = document.getElementById('spectator-count-badge');
    if (specCount && lobby.spectators) {
        specCount.innerText = `${lobby.spectators.length} Spectating`;
    }
};
