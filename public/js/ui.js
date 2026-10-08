// public/js/ui.js

// Safe message dispatcher with fallback to available sockets
function safeSend(msgObj) {
    if (typeof window.sendSocketMessage === 'function') {
        window.sendSocketMessage(msgObj);
    } else if (typeof window.initSocketAndSend === 'function' && window.initSocketAndSend !== safeSend) {
        window.initSocketAndSend(msgObj);
    } else if (window.appGlobals?.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(msgObj));
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(msgObj));
    }
}
window.initSocketAndSend = safeSend;
window.sendSocketMessage = safeSend;

/**
 * Normalizes card data (object or string) and returns authentic playing card HTML.
 * @param {string|object} card - e.g. "10H", { val: "A", suit: "H" }
 * @param {boolean} isMini - Compact format for seat avatars
 * @param {string} extraClass - Custom classes
 * @param {string} clickAttr - Inline onclick attribute string
 */
function formatCardHtml(card, isMini = false, extraClass = '', clickAttr = '') {
    if (!card) {
        return `<div class="card-slot empty-slot ${extraClass}" ${clickAttr}><span>Empty</span></div>`;
    }

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
    const isRed = (suit === '♥' || suit === '♦' || rawSuit === 'H' || rawSuit === 'D');
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    if (isMini) {
        return `
            <div class="mini-card ${suitClass} ${extraClass}" ${clickAttr}>
                <span class="mini-val">${val}</span>
                <span class="mini-suit">${suit}</span>
            </div>
        `;
    }

    return `
        <div class="playing-card ${suitClass} ${extraClass}" ${clickAttr}>
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

function createCardHTML(card, extraClass = '') {
    return formatCardHtml(card, false, extraClass);
}

function calculateLocalScore(cards) {
    if (!cards || cards.length === 0) return 0;
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    const sums = {};
    scoringCards.forEach(c => {
        const suitMap = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
        const s = suitMap[c.suit] || c.suit;
        sums[s] = (sums[s] || 0) + (c.points || 0);
    });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoring2Valid(scoringCards[2].val)) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
}

function scoring2Valid(val) {
    return val;
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
    }, 2800);
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
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:8px; font-size:0.75rem;">No active lobbies</div>';
        return;
    }
    container.innerHTML = lobbies.map(l => `
        <div class="lobby-item" onclick="joinLobbyCode('${l.code}')">
            <span>${l.name || l.code} (${l.count || l.playerCount || 1}/${l.maxPlayers || 6})</span>
            <span style="color:var(--accent-cyan, #38bdf8); font-weight:bold;">Join</span>
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

// Player Action Handlers
function drawCard(source) {
    safeSend({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD', source });
}
function drawFromDeck() { drawCard('deck'); }
function drawFromDiscard() { drawCard('discard'); }

function discardCard(index) {
    safeSend({ type: 'DISCARD_CARD', index: index, cardIndex: index });
}

function choosePoolCard(index) {
    if (window.appGlobals?.hasChosenPoolCard) return;
    if (!window.appGlobals) window.appGlobals = {};
    window.appGlobals.hasChosenPoolCard = true;
    safeSend({ type: 'CHOOSE_POOL_CARD', index: index, cardIndex: index });
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

    safeSend({ type: 'KNOCK' });
}

function toggleReady() {
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState?.username;
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername?.toLowerCase());
    const isReady = !me?.ready;
    safeSend({ type: 'SET_READY', ready: isReady });
}
function setReady() { toggleReady(); }

function sitDown() { safeSend({ type: 'SIT_DOWN' }); }
function standUp() { safeSend({ type: 'STAND_UP' }); }

function clickNextHand() {
    safeSend({ type: 'NEXT_HAND_READY' });
}
function nextHand() { clickNextHand(); }

function leaveLobby() {
    safeSend({ type: 'LEAVE_LOBBY' });
    resetToMainMenu();
}

function proposeEndGame() {
    if (confirm("Are you sure you want to propose ending the game?")) {
        safeSend({ type: 'END_GAME_PROPOSAL' });
    }
}

function createLobby(isPrivate = false) {
    const username = document.getElementById('username-input')?.value.trim() || 'Player1';
    const lobbyName = document.getElementById('lobby-name-input')?.value.trim() || `${username}'s Table`;
    if (window.clientState) window.clientState.username = username;
    safeSend({ type: 'CREATE_LOBBY', username, name: lobbyName, isPrivate });
}

function joinLobby() {
    const code = document.getElementById('join-code-input')?.value.trim();
    if (!code) {
        alert("Please enter a lobby code");
        return;
    }
    joinLobbyCode(code);
}

function joinLobbyCode(code) {
    const username = document.getElementById('username-input')?.value.trim() || window.clientState?.username || 'Player1';
    if (window.clientState) window.clientState.username = username;
    safeSend({ type: 'JOIN_LOBBY', code: code.toUpperCase(), username });
}
function joinByCode(code) { joinLobbyCode(code); }

function addBot() { safeSend({ type: 'ADD_BOT' }); }
function removeBot() { safeSend({ type: 'REMOVE_BOT' }); }

function updateSettings() {
    const wager = document.getElementById('config-wager')?.value || 5;
    const lives = document.getElementById('config-lives')?.value || 3;
    safeSend({ type: 'UPDATE_CONFIG', wager: Number(wager), lives: Number(lives) });
}
function updateWager() { updateSettings(); }

function refreshLobbies() {
    safeSend({ type: 'GET_LOBBIES' });
}

function submitEliminationProposal(targetUsername, amount) {
    safeSend({ type: 'PROPOSE_SIDE_BET', target: targetUsername, amount: Number(amount) });
    toggleModal('bet-modal');
}

function submitSideBet() {
    const target = document.getElementById('bet-target-user')?.value;
    const betType = document.getElementById('bet-type-select')?.value;
    const pickUser = document.getElementById('bet-pick-user')?.value;
    const wagerAmt = document.getElementById('bet-amount-input')?.value || 5;
    safeSend({ type: 'PROPOSE_BET', target, betType, pickUser, wagerAmt: Number(wagerAmt) });
    toggleModal('sidebets-modal');
}

function stopPeekingAction() {
    safeSend({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
}

function openSettingsModal() { toggleModal('settings-modal'); }
function openActiveBetsModal() { toggleModal('active-bets-modal'); }
function openSideBetsModal() { toggleModal('sidebets-modal'); }
function openVcParticipantsModal() { toggleModal('vc-participants-modal'); }

function openLedgerModal() {
    if (typeof window.renderLedgerData === 'function') window.renderLedgerData();
    toggleModal('ledger-modal');
}

function openSpectatorListModal() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState?.spectatorsList || [];
    if (content) {
        content.innerHTML = specs.length === 0 ? 'No spectators.' : '<ul>' + specs.map(s => `<li><b>${s.username || s}</b></li>`).join('') + '</ul>';
    }
    toggleModal('spectators-modal');
}

// Master UI Update Loop
function updateUIFromLobby(lobby) {
    if (!window.appGlobals) window.appGlobals = {};
    if (!window.clientState) window.clientState = {};

    window.appGlobals.latestLobbySnapshot = lobby;

    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';

    const endGameBtn = document.getElementById('end-game-btn');
    const leaveLobbyBtn = document.getElementById('leave-lobby-btn') || document.getElementById('leave-btn');
    if (endGameBtn) endGameBtn.style.display = 'inline-block';
    if (leaveLobbyBtn) leaveLobbyBtn.style.display = 'inline-block';

    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'inline-flex';

    const inGameBtns = document.getElementById('in-game-header-btns') || document.getElementById('in-game-top-row-btns');
    if (inGameBtns) inGameBtns.style.display = 'flex';

    const inGameTools = document.getElementById('in-game-tools-row');
    if (inGameTools) inGameTools.style.display = 'flex';

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name || lobby.code} [${lobby.code}]`;

    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState.username || 'Player1';

    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            const topleft = document.getElementById('discard-pickup-topleft-modal');
            const topright = document.getElementById('fed-card-topright-modal');
            if (topleft) topleft.style.display = 'none';
            if (topright) topright.style.display = 'none';
        }
    }

    updateKnockAlertAndAudio(lobby);

    // Initial Discard Pickup Notification
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    if (topleftModal) {
        if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
            topleftModal.innerHTML = `
                <div style="display:flex; align-items:center; gap:6px;">
                    <span><b>${lobby.lastDiscardPickup.username}</b> drew initial card:</span>
                    ${formatCardHtml(lobby.lastDiscardPickup.card, true)}
                </div>
            `;
            topleftModal.style.display = 'flex';
        } else {
            topleftModal.style.display = 'none';
        }
    }

    // Fed Card Reminder Notification
    const fedModal = document.getElementById('fed-card-topright-modal');
    if (fedModal) {
        if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'lobby') {
            fedModal.innerHTML = `
                <div style="display:flex; align-items:center; gap:6px;">
                    <span><b>${lobby.myFedCardReminder.target}</b> took your card:</span>
                    ${formatCardHtml(lobby.myFedCardReminder.card, true)}
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
    window.clientState.playersList = (lobby.players || []).map(p => p.username);
    window.clientState.spectatorsList = lobby.spectators || [];
    window.clientState.activeParticipantsCount = lobby.activeParticipantsCount || 3;

    const me = (lobby.players || []).find(p => p.username.trim().toLowerCase() === activeUsername.toLowerCase());
    const isSpecUser = (lobby.spectators || []).some(s => (s.username || s).trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = me && me.eliminated;
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // Action Button States
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
                sitBtn.style.display = (isSpecUser || !me) ? 'inline-block' : 'none';
                sitBtn.disabled = (lobby.players || []).length >= 6;
            }
        }
    } else {
        if (sitBtn) sitBtn.style.display = 'none';
        if (standUpBtn) standUpBtn.style.display = 'none';
        if (readyBtn) readyBtn.style.display = 'none';
        if (knockBtn) knockBtn.style.display = isSpectatorOnly ? 'none' : 'inline-block';
    }

    // Turn Audio Cue
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

    const centerTurnIndicator = document.getElementById('center-turn-indicator');
    if (centerTurnIndicator) {
        centerTurnIndicator.style.display = isMyTurn ? 'block' : 'none';
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

    // Ensure Felt Structure Exists inside #table-oval-container
    const tableContainer = document.getElementById('table-oval-container');
    if (tableContainer) {
        let deckCenter = document.getElementById('deck-center');
        if (!deckCenter) {
            deckCenter = document.createElement('div');
            deckCenter.id = 'deck-center';
            deckCenter.className = 'deck-center';
            deckCenter.innerHTML = `
                <div class="card-slot back" id="deck-pile" onclick="drawCard('deck')">
                    <div class="card-back-inner"></div>
                    <div class="deck-counter-badge" id="deck-count-display">0 left</div>
                </div>
                <div class="card-slot empty-slot" id="discard-pile" onclick="drawCard('discard')">
                    <span>Empty</span>
                </div>
            `;
            tableContainer.appendChild(deckCenter);
        }

        // Ensure 6 static seat slots exist
        for (let s = 0; s < 6; s++) {
            if (!document.getElementById(`seat-${s}`)) {
                const seatDiv = document.createElement('div');
                seatDiv.id = `seat-${s}`;
                seatDiv.className = `seat seat-${s}`;
                tableContainer.appendChild(seatDiv);
            }
        }
    }

    // Center Deck & Discard Elements
    const deckCount = (lobby.deck && lobby.deck.length !== undefined) ? lobby.deck.length : (lobby.deckCount || 0);
    const topDiscard = (lobby.discardPile && lobby.discardPile.length > 0)
        ? lobby.discardPile[lobby.discardPile.length - 1]
        : lobby.discardTop;

    const deckCountDisplay = document.getElementById('deck-count-display') || document.getElementById('deck-counter-val');
    if (deckCountDisplay) deckCountDisplay.innerText = `${deckCount} left`;

    const discardPile = document.getElementById('discard-pile') || document.getElementById('discard-slot');
    if (discardPile) {
        discardPile.onclick = () => drawCard('discard');
        if (!topDiscard) {
            discardPile.className = 'card-slot empty-slot';
            discardPile.innerHTML = '<span>Empty</span>';
        } else {
            discardPile.className = '';
            discardPile.innerHTML = formatCardHtml(topDiscard, false, 'table-discard-card');
        }
    }

    // Render 6 Player Seats
    for (let s = 0; s < 6; s++) {
        const seatNode = document.getElementById(`seat-${s}`);
        const p = (lobby.players || []).find(player => player.seat === s);

        if (!seatNode) continue;

        if (!p) {
            seatNode.innerHTML = '';
            seatNode.className = `seat seat-${s}`;
            continue;
        }

        const isCurrent = (p.username.toLowerCase() === lobby.currentTurnUser?.toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
        const isDealer = (lobby.dealerIndex !== undefined && lobby.players[lobby.dealerIndex]?.username === p.username) || p.isDealer;
        const dealerBadge = isDealer ? `<span class="dealer-badge">D</span>` : '';
        const vcBadge = p.inVC ? (p.isMuted ? '<span class="vc-badge">🔇</span>' : '<span class="vc-badge active">🎙️</span>') : '';
        const botBadge = p.isBot ? '🤖 ' : '';
        const readyIcon = p.isBot && !p.ready ? '⏳' : (p.ready ? '✅' : '❌');

        const revealedCards = p.cards && p.cards.length > 0
            ? `<div class="seat-cards">${p.cards.map(c => formatCardHtml(c, true)).join('')}</div>`
            : '';

        seatNode.className = `seat seat-${s}${isCurrent ? ' current-turn-seat' : ''}`;
        seatNode.innerHTML = `
            <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                <span>${readyIcon}</span> <b>${botBadge}${p.username}${p.eliminated ? ' [OUT]' : ''}</b> ${dealerBadge} ${vcBadge}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
            </div>
            ${revealedCards}
        `;
    }

    // Local Hand (Bottom Dock)
    const myCardsContainer = document.getElementById('my-cards-container');
    const myScoreDisplay = document.getElementById('my-score-display');
    if (me && me.cards && myCardsContainer) {
        myCardsContainer.innerHTML = me.cards.map((c, i) => `
            ${formatCardHtml(c, false, 'my-card', `onclick="discardCard(${i})"`)}
        `).join('');
        if (myScoreDisplay) myScoreDisplay.innerText = calculateLocalScore(me.cards);
    }
}

// Global Exports
window.updateUIFromLobby = updateUIFromLobby;
window.renderLobbyState = updateUIFromLobby;
window.renderGameView = updateUIFromLobby;
window.renderLobbyList = renderLobbyList;
window.createLobby = createLobby;
window.joinLobby = joinLobby;
window.joinLobbyCode = joinLobbyCode;
window.joinByCode = joinByCode;
window.drawCard = drawCard;
window.drawFromDeck = drawFromDeck;
window.drawFromDiscard = drawFromDiscard;
window.discardCard = discardCard;
window.knockRound = knockRound;
window.toggleReady = toggleReady;
window.setReady = setReady;
window.sitDown = sitDown;
window.standUp = standUp;
window.clickNextHand = clickNextHand;
window.nextHand = nextHand;
window.leaveLobby = leaveLobby;
window.proposeEndGame = proposeEndGame;
window.addBot = addBot;
window.removeBot = removeBot;
window.updateSettings = updateSettings;
window.updateWager = updateWager;
window.refreshLobbies = refreshLobbies;
window.choosePoolCard = choosePoolCard;
window.submitEliminationProposal = submitEliminationProposal;
window.submitSideBet = submitSideBet;
window.stopPeekingAction = stopPeekingAction;
window.openSettingsModal = openSettingsModal;
window.openActiveBetsModal = openActiveBetsModal;
window.openSideBetsModal = openSideBetsModal;
window.openVcParticipantsModal = openVcParticipantsModal;
window.openLedgerModal = openLedgerModal;
window.openSpectatorListModal = openSpectatorListModal;
window.toggleModal = toggleModal;
window.showCenterNotification = showCenterNotification;
window.formatCardHtml = formatCardHtml;
window.createCardHTML = createCardHTML;

function resetToMainMenu() {
    if (window.appGlobals) {
        window.appGlobals.currentJoinedCode = null;
        window.appGlobals.latestLobbySnapshot = null;
        window.appGlobals.wasMyTurn = false;
    }
    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    if (gameView) gameView.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';

    const endGameBtn = document.getElementById('end-game-btn');
    const leaveLobbyBtn = document.getElementById('leave-lobby-btn') || document.getElementById('leave-btn');
    if (endGameBtn) endGameBtn.style.display = 'none';
    if (leaveLobbyBtn) leaveLobbyBtn.style.display = 'none';

    const vcGroup = document.getElementById('vc-group-container');
    if (vcGroup) vcGroup.style.display = 'none';

    const inGameBtns = document.getElementById('in-game-header-btns') || document.getElementById('in-game-top-row-btns');
    if (inGameBtns) inGameBtns.style.display = 'none';

    const inGameTools = document.getElementById('in-game-tools-row');
    if (inGameTools) inGameTools.style.display = 'none';

    if (window.clientState) window.clientState.isReady = false;
    refreshLobbies();
}
window.resetToMainMenu = resetToMainMenu;

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
window.toggleChatWindow = toggleChatWindow;

function toggleGlobalSidebar() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) sidebar.style.display = sidebar.style.display === 'none' ? 'flex' : 'none';
}
window.toggleGlobalSidebar = toggleGlobalSidebar;

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        safeSend({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
    }
}
window.sendChatMessage = sendChatMessage;

function appendChatMessage(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML += `<div><b>${user}:</b> ${msg}</div>`;
    box.scrollTop = box.scrollHeight;
}
window.appendChatMessage = appendChatMessage;

function tapSeat(targetUsername) {
    if (window.clientState?.gameState === 'lobby') return;
    const activeUsername = document.getElementById('username-input')?.value.trim() || window.clientState?.username;
    if (targetUsername === activeUsername) return;

    const modalTitle = document.getElementById('bet-modal-title') || document.getElementById('seat-action-title');
    const modalBody = document.getElementById('bet-modal-body') || document.getElementById('seat-action-body');
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
window.tapSeat = tapSeat;
