// public/js/ui.js - HUD Notifications, Audio Cues, Seats Engine, Deck & Bot Controls

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
        console.warn('[Audio] Trigger error:', e);
    }
};

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

window.renderSeats = function(lobby) {
    for (let seatIndex = 0; seatIndex < 6; seatIndex++) {
        const seatEl = document.getElementById(`seat-${seatIndex}`) ||
                       document.getElementById(`seat${seatIndex}`) ||
                       document.getElementById(`player-seat-${seatIndex}`) ||
                       document.querySelector(`[data-seat="${seatIndex}"]`) ||
                       document.querySelectorAll('.seat, .table-seat')[seatIndex];

        if (!seatEl) continue;

        const player = lobby.players?.find(p => p.seat === seatIndex);

        if (!player) {
            seatEl.style.display = 'none';
            seatEl.innerHTML = '';
            seatEl.className = 'table-seat empty-seat';
            continue;
        }

        seatEl.style.display = '';
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

window.renderFeltCenter = function(lobby) {
    const deckSlot = document.getElementById('deck-card-slot') || 
                     document.getElementById('deck-slot') || 
                     document.getElementById('deck-pile') ||
                     document.getElementById('deck');

    if (deckSlot) {
        deckSlot.innerHTML = `
            <div class="card playing-card card-back deck-card" style="cursor:pointer; margin:0 auto; box-shadow: 2px 2px 10px rgba(0,0,0,0.5);">
                <div class="card-back-pattern" style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:100%; font-size:1.1rem; color:#f8fafc;">
                    <span>🂠</span>
                    <span style="font-size:0.65rem; font-weight:800; letter-spacing:0.5px; margin-top:2px;">DECK</span>
                </div>
            </div>
        `;
        deckSlot.onclick = () => window.drawFromDeck();
        deckSlot.style.cursor = 'pointer';
    }

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

    const potEl = document.getElementById('pot-display') || document.getElementById('pot-total');
    if (potEl) potEl.innerText = `$${lobby.potTotal || 0}`;

    const phaseEl = document.getElementById('table-status-message') || 
                    document.getElementById('phase-message') || 
                    document.getElementById('game-status-banner');
    if (phaseEl && lobby.phaseMessage) phaseEl.innerText = lobby.phaseMessage;

    const titleEl = document.getElementById('room-title-display') || document.getElementById('lobby-title');
    if (titleEl && lobby.code) {
        titleEl.innerText = `${lobby.name || 'Table'} (${lobby.code})`;
    }
};

window.renderMyHand = function(lobby) {
    const container = document.getElementById('my-cards-container') || document.getElementById('my-cards');
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

window.bindAllTableButtons = function() {
    const btnMap = {
        'ready-btn': () => window.toggleReady(),
        'next-hand-btn': () => window.clickNextHand(),
        'add-bot-btn': () => window.addBot(),
        'remove-bot-btn': () => window.removeBot(),
        'stand-up-btn': () => window.standUp(),
        'end-match-btn': () => window.proposeEndGame(),
        'leave-btn': () => window.leaveLobby(),
        'chat-toggle-btn': () => window.toggleChatWindow(),
        'bets-btn': () => window.toggleModal('bet-modal'),
        'in-game-ledger-btn': () => window.toggleLedgerModal(),
        'draw-deck-btn': () => window.drawFromDeck(),
        'draw-discard-btn': () => window.drawFromDiscard(),
        'knock-btn': () => window.knockRound()
    };

    for (const [id, handler] of Object.entries(btnMap)) {
        const el = document.getElementById(id);
        if (el) {
            el.onclick = (e) => {
                e.preventDefault();
                handler();
            };
        }
    }
};

let previousTurnUser = null;
let previousKnockedBy = null;

window.updateActionButtons = function(lobby) {
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const me = lobby.players?.find(p => p.isMe) || 
               lobby.players?.find(p => p.username?.toLowerCase() === myName);

    const isHost = (me && lobby.host && me.username?.toLowerCase() === lobby.host.toLowerCase()) ||
                   (me && lobby.players && lobby.players[0] === me) ||
                   (lobby.host && myName && lobby.host.toLowerCase() === myName);

    const isLobby = lobby.gameState === 'lobby';
    const isMyTurn = lobby.currentTurnUser?.toLowerCase() === me?.username?.toLowerCase();
    const isPlaying = lobby.gameState === 'playing' || lobby.gameState === 'finalTurn';

    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) {
        if (isLobby) {
            readyBtn.style.display = 'inline-flex';
            readyBtn.innerText = me?.ready ? 'Unready' : 'Ready Up';
            readyBtn.style.background = me?.ready ? '#eab308' : '#15803d';
        } else {
            readyBtn.style.display = 'none';
        }
    }

    const nextHandBtn = document.getElementById('next-hand-btn');
    if (nextHandBtn) {
        if (lobby.gameState === 'roundOver') {
            nextHandBtn.style.display = 'inline-flex';
            nextHandBtn.disabled = Boolean(me?.nextHandReady);
            nextHandBtn.innerText = me?.nextHandReady ? 'Waiting...' : 'Next Hand';
        } else {
            nextHandBtn.style.display = 'none';
        }
    }

    const addBotBtn = document.getElementById('add-bot-btn');
    const removeBotBtn = document.getElementById('remove-bot-btn');
    const currentBots = lobby.players ? lobby.players.filter(p => p.isBot).length : 0;
    const totalPlayers = lobby.players ? lobby.players.length : 0;

    if (addBotBtn) {
        addBotBtn.style.display = (isLobby && isHost && totalPlayers < 6) ? 'inline-flex' : 'none';
    }
    if (removeBotBtn) {
        removeBotBtn.style.display = (isLobby && isHost && currentBots > 0) ? 'inline-flex' : 'none';
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

    window.bindAllTableButtons();
};

window.updateTopCornerFeeds = function(lobby) {
    const discardFeed = document.getElementById('discard-pickup-topleft-modal');
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

    const fedFeed = document.getElementById('fed-card-topright-modal');
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

window.appendChatMessage = function(username, message) {
    const chatContainer = document.getElementById('chat-messages');
    if (!chatContainer) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-entry';
    msgDiv.innerHTML = `<strong style="color:var(--accent-gold, #f59e0b);">${username}:</strong> <span>${message}</span>`;
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

window.toggleModal = function(modalId, forceState) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const isOpen = modal.style.display === 'flex' || modal.style.display === 'block';
    const nextState = typeof forceState === 'boolean' ? forceState : !isOpen;

    modal.style.display = nextState ? 'flex' : 'none';
};

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

    if (lobby.hit31Player && lobby.hit31Player !== window.previous31Player) {
        window.previous31Player = lobby.hit31Player;
        if (typeof window.launchConfetti === 'function') {
            window.launchConfetti();
        } else if (typeof window.startCelebration === 'function') {
            window.startCelebration();
        }
        window.showCenterNotification(`⚡ ${lobby.hit31Player} HIT 31!`, 4000);
    } else if (!lobby.hit31Player) {
        window.previous31Player = null;
    }

    if (lobby.gameState === 'tournamentEnd' && lobby.tournamentWinner && !window.hasCelebratedTournament) {
        window.hasCelebratedTournament = true;
        if (typeof window.launchConfetti === 'function') {
            window.launchConfetti();
        } else if (typeof window.startCelebration === 'function') {
            window.startCelebration();
        }
    } else if (lobby.gameState !== 'tournamentEnd') {
        window.hasCelebratedTournament = false;
    }

    window.renderDealerDrawPhase(lobby);
    window.updateTopCornerFeeds(lobby);
    window.renderSeats(lobby);
    window.renderFeltCenter(lobby);
    window.renderMyHand(lobby);
    window.updateActionButtons(lobby);

    const specCount = document.getElementById('spectator-count-badge');
    if (specCount && lobby.spectators) {
        specCount.innerText = `${lobby.spectators.length} Spectating`;
    }
};

window.bindAllTableButtons();
