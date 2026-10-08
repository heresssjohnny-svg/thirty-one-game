// public/js/ui.js - Complete Frontend Coordinator & Table Renderer

// --- 1. Playing Card Markup & Local Scoring ---

function createCardHTML(card, extraClass = '') {
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
        const suitMap = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
        if (suitMap[suit]) suit = suitMap[suit];
    }

    const isRed = ['♥', '♦', 'H', 'D'].includes(suit);
    const suitClass = isRed ? 'red-suit' : 'black-suit';

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

function formatCardHtml(card, isMini = false) {
    if (!card) return '';
    let val = card.val || card.value || '';
    let suit = card.suit || '';
    const suitMap = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
    if (suitMap[suit]) suit = suitMap[suit];

    const isRed = ['♥', '♦', 'H', 'D'].includes(suit);
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    if (isMini) {
        return `
            <div class="mini-card ${suitClass}">
                <span class="mini-val">${val}</span>
                <span class="mini-suit">${suit}</span>
            </div>
        `;
    }

    return createCardHTML(card, 'my-card');
}

function calculateLocalScore(cards) {
    if (!cards || !Array.isArray(cards) || cards.length === 0) return 0;
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    
    // Check for 3 of a kind (trips = 30.5)
    if (scoringCards.length === 3 && 
        scoringCards[0].val === scoringCards[1].val && 
        scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }

    const sums = {};
    scoringCards.forEach(c => {
        const suit = c.suit;
        const pts = Number(c.points) || 0;
        sums[suit] = (sums[suit] || 0) + pts;
    });

    return Math.max(...Object.values(sums), 0);
}

// --- 2. Notification Banners & Modals ---

let centerNotificationTimer = null;
function showCenterNotification(msg) {
    const banner = document.getElementById('center-notification-banner');
    if (!banner) return;
    banner.innerText = msg;
    banner.style.display = 'block';
    if (centerNotificationTimer) clearTimeout(centerNotificationTimer);
    centerNotificationTimer = setTimeout(() => {
        banner.style.display = 'none';
    }, 3200);
}

function toggleModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = (el.style.display === 'flex' || el.style.display === 'block') ? 'none' : 'flex';
}

function openSettingsModal() {
    toggleModal('settings-modal');
}

function openSpectatorListModal() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState?.spectatorsList || [];
    if (!content) return;
    if (specs.length === 0) {
        content.innerHTML = '<div style="color:var(--text-muted); padding:4px;">No spectators.</div>';
    } else {
        content.innerHTML = '<ul style="padding-left:14px; margin:0;">' + 
            specs.map(s => `<li style="margin-bottom:3px;"><b>${s.username}</b></li>`).join('') + 
            '</ul>';
    }
    toggleModal('spectators-modal');
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

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        dispatchSocketAction({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
    }
}

function appendChatMessage(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML += `<div><b>${user}:</b> ${msg}</div>`;
    box.scrollTop = box.scrollHeight;

    const chatWin = document.getElementById('chat-window');
    const chatBtn = document.getElementById('chat-toggle-btn');
    if (chatWin && chatWin.style.display !== 'flex' && chatBtn) {
        chatBtn.classList.add('unread');
        chatBtn.innerText = '💬 Chat (!)';
    }
}

// --- 3. Table Action Dispatchers ---

function dispatchSocketAction(payload) {
    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(payload);
    } else if (typeof window.sendSocketMessage === 'function') {
        window.sendSocketMessage(payload);
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(payload));
    }
}

function createLobby() {
    const username = (document.getElementById('username-input')?.value || 'Player1').trim();
    const lobbyName = (document.getElementById('lobby-name-input')?.value || 'My Table').trim();
    const isPrivate = !!document.getElementById('private-lobby-checkbox')?.checked;
    dispatchSocketAction({ type: 'CREATE_LOBBY', username, lobbyName, isPrivate });
}

function joinLobby() {
    const code = (document.getElementById('lobby-code-input')?.value || '').trim().toUpperCase();
    if (code) joinLobbyCode(code);
}

function joinLobbyCode(code) {
    const username = (document.getElementById('username-input')?.value || 'Player1').trim();
    dispatchSocketAction({ type: 'JOIN_LOBBY', code, username });
}

function refreshLobbies() {
    dispatchSocketAction({ type: 'REFRESH_LOBBIES' });
}

function renderLobbyList(lobbies) {
    const container = document.getElementById('lobby-list');
    if (!container) return;
    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:8px;">No tables found</div>';
        return;
    }
    container.innerHTML = lobbies.map(l => `
        <div class="lobby-item" onclick="joinLobbyCode('${l.code}')">
            <span>${l.name} (${l.count}/6) - ${l.state === 'lobby' ? 'Open' : 'Playing'}</span>
            <span style="color:var(--accent-cyan);">Join</span>
        </div>
    `).join('');
}

function toggleReady() {
    window.clientState.isReady = !window.clientState.isReady;
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    dispatchSocketAction({ type: 'SET_READY', ready: window.clientState.isReady });
}

function sitDown() {
    dispatchSocketAction({ type: 'SIT_DOWN' });
}

function standUp() {
    dispatchSocketAction({ type: 'STAND_UP' });
}

function drawFromDeck() {
    if (typeof playSound === 'function') playSound('card');
    dispatchSocketAction({ type: 'DRAW_DECK' });
}

function drawFromDiscard() {
    if (typeof playSound === 'function') playSound('card');
    dispatchSocketAction({ type: 'DRAW_DISCARD' });
}

function discardCard(cardIndex) {
    if (typeof playSound === 'function') playSound('card');
    dispatchSocketAction({ type: 'DISCARD_CARD', index: cardIndex, cardIndex: cardIndex });
}

function knockRound() {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const me = window.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
    const currentScore = me && me.cards ? calculateLocalScore(me.cards) : 0;

    if (currentScore <= 30) {
        const confirmKnock = confirm(`Knock Confirmation: Are you sure you want to knock with ${currentScore} points?`);
        if (!confirmKnock) return;
    }

    if (typeof playSound === 'function') playSound('knock');
    if (typeof speakKnockedCue === 'function') speakKnockedCue();
    dispatchSocketAction({ type: 'KNOCK' });
}

function clickNextHand() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    dispatchSocketAction({ type: 'NEXT_HAND' });
}

function proposeEndGame() {
    if (confirm("Propose ending the match?")) {
        dispatchSocketAction({ type: 'END_GAME_PROPOSAL' });
    }
}

function leaveLobby() {
    if (typeof window.leaveLiveKitVoice === 'function') window.leaveLiveKitVoice();
    dispatchSocketAction({ type: 'LEAVE_LOBBY' });
}

function stopPeekingAction() {
    dispatchSocketAction({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
}

function kickPeekerAction(spectatorUsername) {
    dispatchSocketAction({ type: 'KICK_PEEKER', spectatorUsername });
}

function choosePoolCard(cardIndex) {
    if (window.clientState.hasChosenPoolCard) return;
    window.clientState.hasChosenPoolCard = true;
    dispatchSocketAction({ type: 'CHOOSE_POOL_CARD', cardIndex });
}

// --- 4. Main Table UI Coordinator (updateUIFromLobby) ---

let lastTurnUserTracked = '';
let lastCelebration31Tracked = null;
let lastWinnerCelebrationTracked = null;

function updateUIFromLobby(lobby) {
    if (!lobby) return;
    window.latestLobbySnapshot = lobby;

    const activeUsername = (
        document.getElementById('username-input')?.value ||
        window.clientState.username ||
        'Player1'
    ).trim();

    // 1. Scene Switch: Lobby vs Table
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const toolsRow = document.getElementById('in-game-tools-row');
    const topBtns = document.getElementById('in-game-top-row-btns');
    const roomTitle = document.getElementById('room-title-display');

    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (topBtns) topBtns.style.display = 'flex';
    if (roomTitle) roomTitle.innerText = `${lobby.name || 'Table'} [${lobby.code || ''}]`;

    // 2. Spectator & Elimination Resolution
    const me = lobby.players?.find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && (me.eliminated === true || me.lives <= 0);
    const isSpecUser = lobby.spectators && lobby.spectators.some(s => s.username.trim().toLowerCase() === activeUsername.toLowerCase());
    
    // An eliminated player or unseated user is strictly a spectator
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // Spectator Banner
    const specBanner = document.getElementById('spectator-status-banner');
    if (specBanner) {
        if (isSpectatorOnly) {
            specBanner.style.display = 'block';
            specBanner.innerText = isEliminated ? "💀 You have lost all lives and are now spectating." : "👀 You are currently spectating.";
        } else {
            specBanner.style.display = 'none';
        }
    }

    // Spec Count Header Badge
    const specCount = document.getElementById('spec-count');
    if (specCount) specCount.innerText = lobby.spectators?.length || 0;

    // 3. Audio & Celebration Triggers
    if (lobby.hit31Player && lobby.hit31Player !== lastCelebration31Tracked) {
        lastCelebration31Tracked = lobby.hit31Player;
        if (typeof trigger31Celebration === 'function') trigger31Celebration(lobby.hit31Player);
    }
    if (lobby.matchWinner && lobby.matchWinner !== lastWinnerCelebrationTracked) {
        lastWinnerCelebrationTracked = lobby.matchWinner;
        if (typeof triggerWinnerCelebration === 'function') triggerWinnerCelebration(lobby.matchWinner, "TOURNAMENT CHAMPION!");
    }

    // 4. Center Deck, Discard & Pots
    const potBanner = document.getElementById('pot-total-banner');
    if (potBanner) potBanner.innerText = `Pot: $${lobby.potTotal || 0}`;

    const deckCountEl = document.getElementById('deck-count-display');
    if (deckCountEl) deckCountEl.innerText = `${lobby.deckCount || 0} cards`;

    const discardPile = document.getElementById('discard-pile');
    if (discardPile) {
        if (lobby.discardTop) {
            discardPile.innerHTML = formatCardHtml(lobby.discardTop, false);
        } else {
            discardPile.innerHTML = '<span style="font-size:0.65rem; color:#94a3b8; font-weight:bold;">DISCARD</span>';
        }
    }

    // 5. Seats Rendering (0-5)
    for (let i = 0; i < 6; i++) {
        const seatEl = document.getElementById(`seat-${i}`);
        if (!seatEl) continue;

        const p = lobby.players?.find(player => player.seat === i);
        if (!p) {
            seatEl.innerHTML = `<span style="color:#64748b; font-size:0.65rem;">Empty Seat</span>`;
            seatEl.className = `seat seat-${i}`;
            continue;
        }

        const isCurrentTurn = (lobby.currentTurnUser && p.username.toLowerCase() === lobby.currentTurnUser.toLowerCase()) && 
                              (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        const isDealer = (i === lobby.dealerIndex);
        const readyIcon = p.ready ? '✅' : '⏳';
        const isPlayerDead = p.eliminated || p.lives <= 0;

        let cardsMarkup = '';
        if (p.cards && p.cards.length > 0) {
            cardsMarkup = `<div class="seat-cards">${p.cards.map(c => formatCardHtml(c, true)).join('')}</div>`;
        }

        let peekerKickMarkup = '';
        if (p.username.toLowerCase() === activeUsername.toLowerCase() && p.peekAllowed) {
            const peekers = Object.keys(p.peekAllowed);
            if (peekers.length > 0) {
                peekerKickMarkup = `<div style="display:flex; gap:2px; flex-wrap:wrap; justify-content:center; margin-top:2px;">` +
                    peekers.map(pk => `<span style="background:#ef4444; color:#fff; padding:1px 3px; border-radius:3px; font-size:0.5rem; cursor:pointer;" onclick="kickPeekerAction('${pk}')">Kick ${pk} ✕</span>`).join('') +
                    `</div>`;
            }
        }

        seatEl.className = `seat seat-${i}${isCurrentTurn ? ' current-turn-seat' : ''}`;
        seatEl.innerHTML = `
            <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                <span>${readyIcon}</span> <b>${p.username}${isPlayerDead ? ' [DEAD]' : ''}</b>
                ${isDealer ? '<span class="dealer-badge">D</span>' : ''}<br>
                Lives: ${p.lives} | Wager: $${p.wager || 5}
            </div>
            ${cardsMarkup}
            ${peekerKickMarkup}
        `;
    }

    // 6. Action Dock Controls & Knock Validation
    const readyBtn = document.getElementById('ready-btn');
    const knockBtn = document.getElementById('knock-btn');
    const sitBtn = document.getElementById('sit-btn');
    const standUpBtn = document.getElementById('stand-up-btn');
    const actionDock = document.getElementById('player-action-dock');

    const activeParticipants = lobby.players?.filter(p => !p.eliminated && p.lives > 0) || [];
    const activePartsCount = activeParticipants.length;
    const threshold = activePartsCount > 2 ? 21 : 25;
    const myScore = (me && me.cards) ? calculateLocalScore(me.cards) : 0;
    
    // Resolve knock availability without getting blocked by un-broadcast turn counts
    const turnsConditionMet = (lobby.canKnock !== undefined) 
        ? !!lobby.canKnock 
        : (lobby.turnsTakenThisRound >= activePartsCount);

    const isMyTurnPlaying = (lobby.currentTurnUser && lobby.currentTurnUser.toLowerCase() === activeUsername.toLowerCase()) && 
                            (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
    const hasExactlyThreeCards = me && me.cards && me.cards.length === 3;

    if (isSpectatorOnly) {
        if (knockBtn) knockBtn.style.display = 'none';
        if (readyBtn) readyBtn.style.display = 'none';
        if (standUpBtn) standUpBtn.style.display = 'none';
        if (sitBtn) sitBtn.style.display = (lobby.gameState === 'lobby' && (lobby.players?.length || 0) < 6) ? 'inline-block' : 'none';
    } else {
        if (sitBtn) sitBtn.style.display = 'none';
        if (standUpBtn) standUpBtn.style.display = (lobby.gameState === 'lobby') ? 'inline-block' : 'none';

        if (lobby.gameState === 'lobby') {
            if (readyBtn) {
                readyBtn.style.display = 'inline-block';
                readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';
            }
            if (knockBtn) knockBtn.style.display = 'none';
        } else {
            if (readyBtn) readyBtn.style.display = 'none';
            if (knockBtn) {
                knockBtn.style.display = 'inline-block';
                if (lobby.knockedBy) {
                    knockBtn.disabled = true;
                    knockBtn.innerText = `${lobby.knockedBy} knocked!`;
                } else if (!isMyTurnPlaying) {
                    knockBtn.disabled = true;
                    knockBtn.innerText = `Knock (${threshold}+)`;
                } else if (!hasExactlyThreeCards) {
                    knockBtn.disabled = true;
                    knockBtn.innerText = "Can't Knock After Draw";
                } else if (!turnsConditionMet) {
                    knockBtn.disabled = true;
                    knockBtn.innerText = `Wait 1 Round`;
                } else if (myScore < threshold) {
                    knockBtn.disabled = true;
                    knockBtn.innerText = `Knock (${threshold}+)`;
                } else {
                    knockBtn.disabled = false;
                    knockBtn.innerText = 'Knock!';
                }
            }
        }
    }

    // 7. Turn Audio Cue
    if (isMyTurnPlaying && lastTurnUserTracked !== activeUsername) {
        lastTurnUserTracked = activeUsername;
        if (typeof playYourTurnCue === 'function') playYourTurnCue();
    } else if (!isMyTurnPlaying) {
        lastTurnUserTracked = lobby.currentTurnUser || '';
    }

    // 8. Player Hand Rendering
    const handContainer = document.getElementById('player-hand-container');
    if (handContainer) {
        if (!isSpectatorOnly && me && me.cards) {
            handContainer.innerHTML = me.cards.map((c, i) => `
                <div class="hand-card-wrapper" onclick="discardCard(${i})">
                    ${formatCardHtml(c, false)}
                </div>
            `).join('');
        } else {
            handContainer.innerHTML = '';
        }
    }

    // 9. Next Hand Overlay
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    const nextHandBtn = document.getElementById('next-hand-btn');
    if (nextHandOverlay && nextHandBtn) {
        if (lobby.gameState === 'roundOver' && !isSpectatorOnly) {
            nextHandOverlay.style.display = 'block';
            nextHandBtn.disabled = me && !!me.nextHandReady;
            nextHandBtn.innerText = (me && me.nextHandReady) ? 'Waiting...' : 'Next Hand';
        } else {
            nextHandOverlay.style.display = 'none';
        }
    }

    // 10. Phase Message Updates
    const phaseBanner = document.getElementById('phase-message-banner');
    if (phaseBanner && lobby.phaseMessage) {
        phaseBanner.innerText = lobby.phaseMessage;
    }
}

// Global Window Exports
window.createLobby = createLobby;
window.joinLobby = joinLobby;
window.joinLobbyCode = joinLobbyCode;
window.refreshLobbies = refreshLobbies;
window.toggleReady = toggleReady;
window.sitDown = sitDown;
window.standUp = standUp;
window.drawFromDeck = drawFromDeck;
window.drawFromDiscard = drawFromDiscard;
window.discardCard = discardCard;
window.knockRound = knockRound;
window.clickNextHand = clickNextHand;
window.proposeEndGame = proposeEndGame;
window.leaveLobby = leaveLobby;
window.stopPeekingAction = stopPeekingAction;
window.kickPeekerAction = kickPeekerAction;
window.choosePoolCard = choosePoolCard;
window.toggleModal = toggleModal;
window.openSettingsModal = openSettingsModal;
window.openSpectatorListModal = openSpectatorListModal;
window.toggleChatWindow = toggleChatWindow;
window.sendChatMessage = sendChatMessage;
window.appendChatMessage = appendChatMessage;
window.formatCardHtml = formatCardHtml;
window.calculateLocalScore = calculateLocalScore;
window.updateUIFromLobby = updateUIFromLobby;
