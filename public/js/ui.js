// public/js/ui.js - HUD Notifications, Audio Cues, Dynamic Seats, Deck & Action Engine

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
                <div class="card-back-pattern" style="display:flex; align-items:center; justify-content:center; width:100%; height:100%; font-size:1.4rem;">🂠</div>
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
// 5. TABLE SEATS RENDERER (EMPTY SEATS HIDDEN)
// -------------------------------------------------------------
window.renderSeats = function(lobby) {
    for (let seatIndex = 0; seatIndex < 6; seatIndex++) {
        const seatEl = document.getElementById(`seat-${seatIndex}`) ||
                       document.getElementById(`seat${seatIndex}`) ||
                       document.getElementById(`player-seat-${seatIndex}`) ||
                       document.querySelector(`[data-seat="${seatIndex}"]`) ||
                       document.querySelectorAll('.seat, .table-seat')[seatIndex];

        if (!seatEl) continue;

        const player = lobby.players?.find(p => p.seat === seatIndex);

        // 1. Hide empty seats completely
        if (!player) {
            seatEl.style.display = 'none';
            seatEl.innerHTML = '';
            seatEl.className = 'table-seat empty-seat';
            continue;
        }

        // 2. Render occupied seat
        seatEl.style.display = ''; // Restore default display
        const isDealer = lobby.dealerIndex === lobby.players?.indexOf(player);
        const isTurn = lobby.currentTurnUser?.toLowerCase() === player.username?.toLowerCase();
        const isEliminated = Boolean(player.eliminated);

        seatEl.classList.remove('empty-seat');
        seatEl.classList.toggle('active-turn', isTurn);
        seatEl.classList.toggle('dealer-seat', isDealer);
        seatEl.classList.toggle('ready-seat', Boolean(player.ready));
        seatEl.classList.toggle('eliminated', isEliminated);

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

        const nameEl = seatEl.querySelector('.seat-name, .player-name, .name');
        const statusEl = seatEl.querySelector('.seat-status, .player-status, .status');
        const avatarEl = seatEl.querySelector('.seat-avatar, .avatar, .seat-icon');
        const livesEl = seatEl.querySelector('.seat-lives, .player-lives, .lives');
        const cardsEl = seatEl.querySelector('.seat-cards, .player-cards, .cards');

        if (nameEl && statusEl) {
            nameEl.innerText = player.username;
            statusEl.innerText = statusText;
            if (statusColor) statusEl.style.color = statusColor;
            if (avatarEl) avatarEl.innerHTML = avatarIcon;
            if (livesEl) livesEl.innerHTML = livesPips;
            if (cardsEl) cardsEl.innerHTML = miniCardsHtml;
        } else {
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
// 6. FELT CENTER (DECK CASINO GRAPHIC & DISCARD SLOTS)
// -------------------------------------------------------------
window.renderFeltCenter = function(lobby) {
    // 1. Deck Pile (Always render casino card back)
    const deckSlot = document.getElementById('deck-card-slot') || 
                     document.getElementById('deck-slot') || 
                     document.getElementById('deck-pile') ||
                     document.getElementById('deck');

    if (deckSlot) {
        deckSlot.innerHTML = `
            <div class="card playing-card card-back deck-card" style="cursor:pointer; margin:0 auto; box-shadow: 2px 2px 8px rgba(0,0,0,0.4);">
                <div class="card-back-pattern" style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:100%; font-size:1.1rem; color:#f8fafc;">
                    <span>🂠</span>
                    <span style="font-size:0.65rem; font-weight:700; letter-spacing:0.5px;">DECK</span>
                </div>
            </div>
        `;
        deckSlot.onclick = () => window.drawFromDeck();
        deckSlot.style.cursor = 'pointer';
    }

    // 2. Discard Pile
    const discardSlot = document.getElementById('discard-card-slot') || 
                        document.getElementById('discard-pile-top') || 
                        document.getElementById('discard-slot') || 
                        document.getElementById('discard-pile') ||
                        document.getElementById('discard');

    if (discardSlot) {
        if (lobby.discardTop && lobby.gameState !== 'lobby') {
            discardSlot.innerHTML = window.renderCardHTML(lobby.discardTop, 'discard-card');
            discardSlot.onclick = () => window.drawFromDiscard();
            discardSlot.style.cursor = 'pointer';
        } else {
            discardSlot.innerHTML = `
                <div class="card-slot-placeholder" style="display:flex; flex-direction:column; align-items:center; justify-content:center; border:2px dashed rgba(255,255,255,0.25); border-radius:6px; min-width:55px; min-height:75px; color:#94a3b8; font-size:0.75rem;">
                    <span>DISCARD</span>
                    <span style="font-size:0.65rem; opacity:0.6;">Empty</span>
                </div>
            `;
            discardSlot.onclick = null;
            discardSlot.style.cursor = 'default';
        }
    }

    // 3. Pot & Turn Status
    const potEl = document.getElementById('pot-display') || document.getElementById('pot-total');
    if (potEl) potEl.innerText = `$${lobby.potTotal || 0}`;

    const phaseEl = document.getElementById('table-status-message') || 
                    document.getElementById('phase-message') || 
                    document.getElementById('game-status-banner');
    if (phaseEl && lobby.phaseMessage) phaseEl.innerText = lobby.phaseMessage;
};

// -------------------------------------------------------------
// 7. MY HAND
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
// 8. ACTION CONTROLS & BOT MANAGEMENT
// -------------------------------------------------------------
let previousTurnUser = null;
let previousKnockedBy = null;

window.updateActionButtons = function(lobby) {
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const me = lobby.players?.find(p => p.isMe) || 
               lobby.players?.find(p => p.username?.toLowerCase() === myName);

    const isHost = lobby.host && (lobby.host.toLowerCase() === myName);
    const isLobby = lobby.gameState === 'lobby';
    const isMyTurn = lobby.currentTurnUser?.toLowerCase() === me?.username?.toLowerCase();
    const isPlaying = lobby.gameState === 'playing' || lobby.gameState === 'finalTurn';

    // 1. Ready Button
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) {
        if (isLobby) {
            readyBtn.style.display = 'inline-flex';
            readyBtn.innerText = me?.ready ? 'Unready' : 'Ready Up';
            readyBtn.style.background = me?.ready ? '#eab308' : '';
        } else {
            readyBtn.style.display = 'none';
        }
    }

    // 2. Bot Buttons (Resolve or Dynamically Mount next to Ready)
    let addBotBtn = document.getElementById('add-bot-btn') || 
                    document.getElementById('add-bot') || 
                    document.getElementById('bot-add-btn');

    let removeBotBtn = document.getElementById('remove-bot-btn') || 
                       document.getElementById('remove-bot') || 
                       document.getElementById('bot-remove-btn');

    if (!addBotBtn && readyBtn && readyBtn.parentElement) {
        addBotBtn = document.createElement('button');
        addBotBtn.id = 'add-bot-btn';
        addBotBtn.className = 'secondary';
        addBotBtn.innerText = '+ Bot';
        addBotBtn.style.marginLeft = '6px';
        addBotBtn.onclick = (e) => { e.preventDefault(); window.addBot(); };
        readyBtn.parentElement.appendChild(addBotBtn);
    }

    if (!removeBotBtn && readyBtn && readyBtn.parentElement) {
        removeBotBtn = document.createElement('button');
        removeBotBtn.id = 'remove-bot-btn';
        removeBotBtn.className = 'secondary';
        removeBotBtn.innerText = '- Bot';
        removeBotBtn.style.marginLeft = '6px';
        removeBotBtn.onclick = (e) => { e.preventDefault(); window.removeBot(); };
        readyBtn.parentElement.appendChild(removeBotBtn);
    }

    const currentBots = lobby.players ? lobby.players.filter(p => p.isBot).length : 0;
    const totalPlayers = lobby.players ? lobby.players.length : 0;

    if (addBotBtn) {
        addBotBtn.style.display = (isLobby && isHost && totalPlayers < 6) ? 'inline-flex' : 'none';
    }
    if (removeBotBtn) {
        removeBotBtn.style.display = (isLobby && isHost && currentBots > 0) ? 'inline-flex' : 'none';
    }

    // 3. Draw & Knock Actions
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
