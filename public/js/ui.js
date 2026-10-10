// public/js/ui.js

// -------------------------------------------------------------
// 1. STATE & ENVIRONMENT SAFEGUARDS
// -------------------------------------------------------------
window.clientState = window.clientState || {
    username: localStorage.getItem('saved_username') || 'Player1',
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
    ws: null,
    currentJoinedCode: localStorage.getItem('blitz31_active_room') || null,
    latestLobbySnapshot: null,
    wasMyTurn: false,
    lastKnownKnockedBy: null,
    hasChosenPoolCard: false,
    lastPhaseMessage: '',
    lastGameState: '',
    lastCelebratedWinner: null,
    lastCelebrated31: null,
    lastChatCount: 0,
    notificationTimer: null
};

function sendSocket(payload) {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc(payload);
    } else if (window.appGlobals.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(payload));
    }
};

window.triggerAudioCue = function(cueType) {
    try {
        const audioEl = document.getElementById(`sound-${cueType}`);
        if (audioEl) {
            audioEl.currentTime = 0;
            audioEl.play().catch(e => console.warn(`[Audio] Blocked HTML tag for ${cueType}:`, e));
        } else {
            console.warn(`[Audio] HTML tag sound-${cueType} missing. Trying dynamic fallback.`);
            const fallbackAudio = new Audio(`/mp3s/${cueType}.mp3`);
            fallbackAudio.play().catch(e => console.warn(`[Audio] Blocked dynamic audio for ${cueType}:`, e));
        }

        if (navigator.vibrate) {
            navigator.vibrate(cueType === 'knock' ? [150, 100, 200] : [80, 50, 80]);
        }
    } catch (e) {
        console.error('[Audio] Trigger error:', e);
    }
};

// Global one-tap unlock for mobile Chrome / Safari AudioContext
function unlockAudioContextOnTap() {
    if (window.audioCtx && window.audioCtx.state === 'suspended') {
        window.audioCtx.resume();
    }
    if (typeof getAudioContext === 'function') {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') ctx.resume();
    }
    document.removeEventListener('touchstart', unlockAudioContextOnTap);
    document.removeEventListener('click', unlockAudioContextOnTap);
}
document.addEventListener('touchstart', unlockAudioContextOnTap, { passive: true });
document.addEventListener('click', unlockAudioContextOnTap);

function sendSocket(payload) {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc(payload);
    } else if (window.appGlobals.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(payload));
    }
}

// -------------------------------------------------------------
// 2. CASINO PLAYING CARD RENDERER & HAND SCORING
// -------------------------------------------------------------
function normalizeSuit(rawSuit) {
    if (!rawSuit) return '♠';
    const s = String(rawSuit).trim().toUpperCase();
    const map = {
        'S': '♠', 'SPADES': '♠', '♠': '♠',
        'H': '♥', 'HEARTS': '♥', '♥': '♥',
        'D': '♦', 'DIAMONDS': '♦', '♦': '♦',
        'C': '♣', 'CLUBS': '♣', '♣': '♣'
    };
    return map[s] || s;
}

window.formatCardHtml = function(card, isMini = false) {
    if (!card) return '';

    let val = '';
    let suit = '';

    if (typeof card === 'string') {
        const raw = card.trim().toUpperCase();
        const suitChar = raw.slice(-1);
        val = raw.slice(0, -1);
        suit = normalizeSuit(suitChar);
    } else if (typeof card === 'object') {
        val = card.val || card.value || card.rank || '';
        suit = normalizeSuit(card.suit);
    }

    const isRed = (suit === '♥' || suit === '♦');
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    if (isMini) {
        return `
            <div class="mini-card ${suitClass}">
                <span class="mini-val">${val}</span>
                <span class="mini-suit">${suit}</span>
            </div>
        `;
    }

    return `
        <div class="playing-card ${suitClass}">
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
};

window.calculateLocalScore = function(cards) {
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    const sums = {};
    scoringCards.forEach(c => {
        const s = normalizeSuit(c.suit);
        sums[s] = (sums[s] || 0) + (c.points !== undefined ? c.points : 0);
    });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
};

// -------------------------------------------------------------
// 3. MODALS, NOTIFICATIONS, CHAT & SESSION LEDGER CONTROLS
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
        const box = document.getElementById('chat-messages');
        if (box) box.scrollTop = box.scrollHeight;
    }
};

window.appendChatMessage = function(user, msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.innerHTML = `<b>${user}:</b> ${msg}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    const win = document.getElementById('chat-window');
    if (!win || win.style.display !== 'flex') {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
};

window.syncChatHistory = function(history) {
    if (!Array.isArray(history)) return;
    const box = document.getElementById('chat-messages');
    if (!box) return;

    const lastCount = window.appGlobals.lastChatCount || 0;
    if (history.length !== lastCount) {
        box.innerHTML = history.map(m => `<div><b>${m.user || m.username}:</b> ${m.text || m.message}</div>`).join('');
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
};

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        sendSocket({ type: 'CHAT_MESSAGE', message: text });
        input.value = '';
    }
};

window.toggleGlobalSidebar = function() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) {
        sidebar.style.display = (sidebar.style.display === 'none') ? 'flex' : 'none';
    }
};

window.openSpectatorListModal = function() {
    const content = document.getElementById('spectators-list-content');
    const specs = window.clientState.spectatorsList || [];
    if (!content) return;
    if (specs.length === 0) {
        content.innerHTML = 'No spectators.';
    } else {
        content.innerHTML = '<ul>' + specs.map(s => `<li style="margin-bottom:3px;"><b>${s.username}</b></li>`).join('') + '</ul>';
    }
    window.toggleModal('spectators-modal');
};

window.openActiveBetsModal = function() {
    const myName = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    const contentDiv = document.getElementById('active-bets-content');
    const active = window.clientState.activeBetsList || [];
    const pending = window.clientState.pendingBetsList || [];

    const myActive = active.filter(b => (b.proposer || b.bettor) === myName || b.target === myName || b.pickUser === myName);
    const myPending = pending.filter(b => (b.proposer || b.creator) === myName || b.target === myName || b.pickUser === myName);

    let html = `<div style="font-weight:bold; color:var(--accent-gold); margin-bottom:4px;">Active Side Bets (${myActive.length})</div>`;
    if (myActive.length === 0) {
        html += `<div style="margin-left:8px; margin-bottom:8px; color:var(--text-muted);">None currently active.</div>`;
    } else {
        html += '<ul style="margin-left:14px; margin-bottom:8px;">';
        myActive.forEach(b => {
            const desc = (b.type === 'eliminate' || b.type === 'first_out')
                ? `Bet with ${(b.proposer || b.bettor) === myName ? b.target : (b.proposer || b.bettor)}: $${b.wagerAmt} on ${b.pickUser} to lose first`
                : `Global Bet: $${b.wagerAmt} on ${b.pickUser || b.condition}`;
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
            html += `<li style="margin-bottom:3px;">Proposal from ${b.proposer || b.creator}: $${b.wagerAmt}</li>`;
        });
        html += '</ul>';
    }

    if (contentDiv) contentDiv.innerHTML = html;
    window.toggleModal('active-bets-modal');
};

// --- LOBBY SESSION LEDGER CONTROLS (BILATERAL NETTED ENGINE) ---
window.toggleSessionLedger = function(show) {
    const modal = document.getElementById('session-ledger-modal');
    if (!modal) return;
    const shouldShow = (show !== undefined) ? !!show : (modal.style.display !== 'flex');
    modal.style.display = shouldShow ? 'flex' : 'none';
    if (shouldShow && window.appGlobals?.latestLobbySnapshot) {
        window.renderSessionLedger(window.appGlobals.latestLobbySnapshot);
    }
};

window.openSessionLedgerModal = function() {
    window.toggleSessionLedger(true);
};

window.renderSessionLedger = function(lobby) {
    if (!lobby) lobby = window.appGlobals?.latestLobbySnapshot || {};
    const activeBetsEl = document.getElementById('active-session-bets-list');
    const settledLedgerEl = document.getElementById('session-settled-ledger-list') || document.getElementById('session-ledger-display');

    // 1. Render Active Unresolved Bets (Exact 1x wager amount)
    if (activeBetsEl) {
        const activeList = lobby.activeBets || [];
        if (activeList.length === 0) {
            activeBetsEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:4px;">No active side bets.</div>';
        } else {
            activeBetsEl.innerHTML = activeList.map(b => {
                const desc = (b.type === 'eliminate' || b.type === 'first_out')
                    ? `<b>${b.proposer || b.bettor}</b> vs <b>${b.target}</b> (${b.pickUser} out first)`
                    : `<b>${b.proposer || b.bettor}</b> vs <b>${b.target}</b> (${b.condition || 'Win'})`;
                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                        <span style="font-size:0.8rem;">${desc}</span>
                        <span style="color:var(--accent-gold); font-weight:bold; font-size:0.85rem;">$${b.wagerAmt || 5}</span>
                    </div>
                `;
            }).join('');
        }
    }

    // 2. Pairwise Netting Across Main Game & Side Bet Ledgers
    if (settledLedgerEl) {
        const gross = {};
        const addGross = (debtor, creditor, amt) => {
            if (!debtor || !creditor || debtor === creditor || amt <= 0) return;
            if (!gross[debtor]) gross[debtor] = {};
            gross[debtor][creditor] = (gross[debtor][creditor] || 0) + amt;
        };

        const tally = (ledger) => {
            if (!ledger) return;
            for (const debtor in ledger) {
                for (const creditor in ledger[debtor]) {
                    const amt = Number(ledger[debtor][creditor]) || 0;
                    if (amt > 0) addGross(debtor, creditor, amt);
                }
            }
        };

        tally(lobby.mainGameLedger);
        tally(lobby.sideBetLedger);

        const allUsers = new Set();
        Object.keys(gross).forEach(u => allUsers.add(u));
        Object.values(gross).forEach(map => Object.keys(map).forEach(u => allUsers.add(u)));

        const usersArr = Array.from(allUsers);
        const netList = [];

        // Check each pair once to calculate pure net balance
        for (let i = 0; i < usersArr.length; i++) {
            for (let j = i + 1; j < usersArr.length; j++) {
                const u1 = usersArr[i];
                const u2 = usersArr[j];

                const u1OwesU2 = (gross[u1] && gross[u1][u2]) || 0;
                const u2OwesU1 = (gross[u2] && gross[u2][u1]) || 0;
                const diff = u1OwesU2 - u2OwesU1;

                if (diff > 0) {
                    netList.push({ debtor: u1, creditor: u2, amount: diff });
                } else if (diff < 0) {
                    netList.push({ debtor: u2, creditor: u1, amount: -diff });
                }
            }
        }

        if (netList.length === 0) {
            settledLedgerEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:4px;">No debts settled this session.</div>';
        } else {
            settledLedgerEl.innerHTML = netList.map(({ debtor, creditor, amount }) => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="font-size:0.8rem;"><span style="color:#f87171; font-weight:bold;">${debtor}</span> owes <span style="color:#4ade80; font-weight:bold;">${creditor}</span></span>
                    <span style="color:#fde047; font-weight:bold; font-size:0.85rem;">$${amount}</span>
                </div>
            `).join('');
        }
    }
};

// // -------------------------------------------------------------
// 4. LOBBY BROWSING RENDERING
// -------------------------------------------------------------
window.renderLobbyList = function(lobbies) {
    const container = document.getElementById('lobby-list');
    if (!container) return;

    if (!lobbies || lobbies.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#64748b; padding:10px; font-size:0.75rem;">No active tables found.</div>';
        return;
    }

    container.innerHTML = lobbies.map(l => {
        const count = l.count !== undefined ? l.count : (l.players ? l.players.length : 0);
        const isOpen = (l.state === 'lobby' || l.gameState === 'lobby');
        return `
            <div class="lobby-item" onclick="joinLobbyCode('${l.code}')">
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
// 5. IN-GAME ACTIONS & CARD INTERACTIONS
// -------------------------------------------------------------
window.drawCard = function(source) {
    if (window.clientState.isSpectator) return;
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(40);
    sendSocket({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    if (window.clientState.isSpectator) return;
    if (typeof playSound === 'function') playSound('card');
    if (typeof triggerVibration === 'function') triggerVibration(30);
    sendSocket({
        type: 'DISCARD_CARD',
        index: cardIndex,
        cardIndex: cardIndex
    });
};

window.choosePoolCard = function(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    window.appGlobals.hasChosenPoolCard = true;
    sendSocket({ type: 'CHOOSE_POOL_CARD', cardIndex });
};

window.clickNextHand = function() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    sendSocket({ type: 'NEXT_HAND_READY' });
    sendSocket({ type: 'NEXT_HAND' });
};

window.toggleReady = function() {
    window.clientState.isReady = !window.clientState.isReady;
    const btn = document.getElementById('ready-btn');
    if (btn) btn.innerText = window.clientState.isReady ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    sendSocket({ type: 'SET_READY', ready: window.clientState.isReady });
};

window.standUp = function() { sendSocket({ type: 'STAND_UP' }); };
window.sitDown = function() { sendSocket({ type: 'SIT_DOWN' }); };

window.updateWager = function() {
    const sel = document.getElementById('config-wager');
    if (sel) sendSocket({ type: 'UPDATE_WAGER', wager: parseInt(sel.value, 10) || 5 });
};

window.updateSettings = function() {
    const sel = document.getElementById('config-lives');
    if (sel) sendSocket({ type: 'UPDATE_SETTINGS', lives: parseInt(sel.value, 10) || 3 });
};

window.submitLivesVote = function(agree) {
    sendSocket({ type: 'VOTE_LIVES', agree: !!agree });
    const modal = document.getElementById('lives-vote-modal');
    if (modal) modal.style.display = 'none';
};

window.addBot = function() { sendSocket({ type: 'ADD_BOT' }); };
window.removeBot = function() { sendSocket({ type: 'REMOVE_BOT' }); };

window.proposeEndGame = function() {
    if (confirm("Propose ending the game and returning to the lobby?")) {
        sendSocket({ type: 'END_GAME_PROPOSAL' });
    }
};

window.stopPeekingAction = function() {
    sendSocket({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
    window.showCenterNotification("Stopped peeking.");
};

window.kickPeekerAction = function(spectatorUsername) {
    sendSocket({ type: 'KICK_PEEKER', spectatorUsername });
    window.showCenterNotification(`Removed ${spectatorUsername} from peeking your hand.`);
};

// -------------------------------------------------------------
// 6. KNOCK VALIDATION & EXECUTION
// -------------------------------------------------------------
function updateKnockAlertAndAudio(lobby) {
    const knockAlertModal = document.getElementById('knock-alert-modal');
    if (!knockAlertModal) return;

    // B.2. OPPONENT KNOCK ALERTS & AUDIO
    if (lobby.knockedBy && lobby.knockedBy !== window.appGlobals.lastKnownKnockedBy) {
        window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
        // Only play the incoming sound if someone ELSE knocked
        if (lobby.knockedBy.toLowerCase() !== activeUsername.toLowerCase()) {
            window.safePlaySound('knock');
            window.safeVibrate([180, 110, 180, 110, 180]);
        }
    } else if (!lobby.knockedBy) {
        window.appGlobals.lastKnownKnockedBy = null;
    }

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

window.knockRound = function() {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
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

    if (typeof playSound === 'function') playSound('knock');
    if (typeof speakKnockedCue === 'function') speakKnockedCue();
    if (typeof triggerVibration === 'function') triggerVibration([180, 110, 180, 110, 180]);
    sendSocket({ type: 'KNOCK' });
};

// -------------------------------------------------------------
// 7. SIDE BETS & PEEKING DIALOGS
// -------------------------------------------------------------
window.tapSeat = function(targetUsername) {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();
    if (window.clientState.gameState === 'lobby') return;

    const isSpecOnly = window.clientState.isSpectator;
    const activeCount = window.clientState.activeParticipantsCount;

    if (isSpecOnly) {
        const modalTitle = document.getElementById('seat-action-title');
        const modalBody = document.getElementById('seat-action-body');
        if (modalTitle) modalTitle.innerText = `Actions for ${targetUsername}`;
        if (modalBody) {
            let actionsHtml = `<button style="background:#2563eb; padding:8px; font-size:0.85rem;" onclick="requestPeekFromModal('${targetUsername}')">🔍 Peek Hand</button>`;
            if (activeCount === 2) {
                actionsHtml += `<button style="background:#d97706; padding:8px; font-size:0.85rem; margin-top:6px;" onclick="betOnHimFromModal('${targetUsername}')">🤝 Bet on ${targetUsername}</button>`;
            }
            actionsHtml += `<button class="secondary" onclick="toggleModal('seat-action-modal')" style="margin-top:6px;">Cancel</button>`;
            modalBody.innerHTML = actionsHtml;
        }
        window.toggleModal('seat-action-modal');
        return;
    }

    if (activeCount >= 3) {
        if (targetUsername.toLowerCase() === activeUsername.toLowerCase()) return;
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (modalTitle) modalTitle.innerText = `First to Lose Bet on ${targetUsername}`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager that ${targetUsername} is eliminated before you:</p>
                <button onclick="submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
                <button onclick="submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
                <button onclick="submitEliminationProposal('${targetUsername}', 20)">$20 Wager</button>
                <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
            `;
        }
        window.toggleModal('bet-modal');
    } else if (activeCount === 2) {
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
                <button onclick="submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
                <button onclick="submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
                <button onclick="submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
                <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
            `;
        }
        window.toggleModal('bet-modal');
    }
};

window.requestPeekFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal');
    sendSocket({ type: 'REQUEST_PEEK', targetUsername });
    window.showCenterNotification(`Peek request sent to ${targetUsername}!`);
};

window.betOnHimFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
            <button onclick="submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:4px;">Cancel</button>
        `;
    }
    window.toggleModal('bet-modal');
};

window.submitEliminationProposal = function(target, wagerAmt) {
    sendSocket({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`First to lose bet proposed to ${target}!`);
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    sendSocket({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`Global bet offered on ${pickUser}!`);
};

window.acceptGlobalProposal = function(proposalId) {
    sendSocket({
        type: 'ACCEPT_GLOBAL_PROPOSAL',
        proposalId: proposalId,
        betId: proposalId,
        id: proposalId
    });
};

window.respondGlobalBet = function(proposalId, accept) {
    sendSocket({
        type: 'RESPOND_GLOBAL_BET',
        proposalId: proposalId,
        betId: proposalId,
        id: proposalId,
        accept: !!accept,
        confirm: !!accept
    });
};

window.confirmGlobalBet = function(proposalId, acceptedUser, confirmChoice) {
    sendSocket({
        type: 'CONFIRM_GLOBAL_BET',
        proposalId: proposalId,
        betId: proposalId,
        id: proposalId,
        acceptedUser: acceptedUser,
        confirm: !!confirmChoice,
        accept: !!confirmChoice
    });
    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'none';
};

window.openConfirmModal = function(proposalId, proposer, pickUser, acceptedUsers) {
    const modal = document.getElementById('bet-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Confirm Global Side Bet (${pickUser})`;

    const listHtml = (acceptedUsers || []).map(acc => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:6px; border-radius:6px; margin-bottom:4px;">
            <span><b>${acc}</b> accepted</span>
            <div style="display:flex; gap:4px;">
                <button style="font-size:0.7rem; padding:4px 8px; background:#10b981;" onclick="confirmGlobalBet('${proposalId}', '${acc}', true)">Confirm</button>
                <button class="danger" style="font-size:0.7rem; padding:4px 8px;" onclick="confirmGlobalBet('${proposalId}', '${acc}', false)">Decline</button>
            </div>
        </div>
    `).join('');

    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.80rem; color:var(--text-muted); margin-bottom:6px;">Players who accepted your proposal:</p>
            ${listHtml}
            <button class="secondary" onclick="toggleModal('bet-modal')" style="margin-top:8px;">Close</button>
        `;
    }
    if (modal) modal.style.display = 'flex';
};

window.respondToBet = function(betId, accept) {
    sendSocket({
        type: 'RESPOND_BET',
        betId: betId,
        proposalId: betId,
        id: betId,
        accept: !!accept,
        confirm: !!accept
    });
    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'none';
};

// -------------------------------------------------------------
// 8. MASTER TABLE RENDER & SPECTATOR LOGIC
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    window.appGlobals.latestLobbySnapshot = lobby;

    const authScreen = document.getElementById('auth-screen');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const endBtn = document.getElementById('end-game-btn');
    const leaveBtn = document.getElementById('leave-lobby-btn');
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    console.log(`[Turn Debug] Server Turn: ${lobby.currentTurnUser} | My Name: ${myName}`);

    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    if (topRowBtns) topRowBtns.style.display = 'inline-flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (endBtn) endBtn.style.display = 'inline-block';
    if (leaveBtn) leaveBtn.style.display = 'inline-block';

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name || 'Table'} [${lobby.code || '----'}]`;

    if (lobby.chatHistory) {
        window.syncChatHistory(lobby.chatHistory);
    }

    const activeUsername = (document.getElementById('username-input')?.value || window.clientState.username || 'Player1').trim();

    // 1. CELEBRATION TRIGGER: HIT 31
    if (lobby.hit31Player) {
        if (window.appGlobals.lastCelebrated31 !== lobby.hit31Player) {
            window.appGlobals.lastCelebrated31 = lobby.hit31Player;
            if (typeof trigger31Celebration === 'function') {
                trigger31Celebration(lobby.hit31Player);
            } else if (typeof triggerWinnerCelebration === 'function') {
                triggerWinnerCelebration(lobby.hit31Player, "HIT 31!");
            }
        }
    } else {
        window.appGlobals.lastCelebrated31 = null;
    }

    // 2. CELEBRATION TRIGGER: TOURNAMENT END
    const isTournamentOver = (lobby.gameState === 'tournamentEnd') || (lobby.phaseMessage && lobby.phaseMessage.includes('TOURNAMENT WINNER'));
    if (isTournamentOver) {
        let winnerName = lobby.tournamentWinner || lobby.lastGameWinner;
        if (!winnerName && lobby.phaseMessage) {
            const m = lobby.phaseMessage.match(/TOURNAMENT WINNER!\s+(.*?)\s+wins/);
            if (m && m[1]) winnerName = m[1].trim();
        }
        if (winnerName && window.appGlobals.lastCelebratedWinner !== winnerName) {
            window.appGlobals.lastCelebratedWinner = winnerName;
            if (typeof triggerWinnerCelebration === 'function') {
                triggerWinnerCelebration(winnerName, "TOURNAMENT CHAMPION!");
            }
        }
    } else if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
        window.appGlobals.lastCelebratedWinner = null;
    }

    // 3. STATE TRANSITION NOTIFICATIONS
    if (lobby.gameState !== window.appGlobals.lastGameState) {
        window.appGlobals.hasChosenPoolCard = false;
        window.appGlobals.lastGameState = lobby.gameState;
        if (lobby.gameState === 'roundOver' || lobby.gameState === 'lobby') {
            const topleft = document.getElementById('discard-pickup-topleft-modal');
            const fedModal = document.getElementById('fed-card-topright-modal');
            if (topleft) topleft.style.display = 'none';
            if (fedModal) fedModal.style.display = 'none';
        }
    }

    // 4. LIVES VOTING MODAL
    const voteModal = document.getElementById('lives-vote-modal');
    if (voteModal) {
        if (lobby.livesVote && lobby.gameState === 'lobby') {
            const hasVoted = lobby.livesVote.votes && lobby.livesVote.votes[activeUsername] !== undefined;
            const isSeatedHuman = (lobby.players || []).some(p => p.username.toLowerCase() === activeUsername.toLowerCase() && !p.isBot);

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

    // 5. KNOCK VISUALS & ALERTS
    updateKnockAlertAndAudio(lobby);

    // 6. TOP IN-GAME FEEDS
    const topleftModal = document.getElementById('discard-pickup-topleft-modal');
    const topleftCardContent = document.getElementById('discard-pickup-card-content');
    if (lobby.lastDiscardPickup && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        if (topleftCardContent) {
            topleftCardContent.innerHTML = `<span><b>${lobby.lastDiscardPickup.username}</b>:</span> ${window.formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
        }
        if (topleftModal) topleftModal.style.display = 'flex';
    } else if (topleftModal) {
        topleftModal.style.display = 'none';
    }

    const fedModal = document.getElementById('fed-card-topright-modal');
    const fedContent = document.getElementById('fed-card-content');
    const fedLabel = document.getElementById('fed-card-label');
    if (lobby.myFedCardReminder && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        if (fedLabel) fedLabel.innerText = `${lobby.myFedCardReminder.target} took your:`;
        if (fedContent) fedContent.innerHTML = window.formatCardHtml(lobby.myFedCardReminder.card, true);
        if (fedModal) fedModal.style.display = 'flex';
    } else if (fedModal) {
        fedModal.style.display = 'none';
    }

    // 7. CLIENT CACHES & SPECTATOR DETERMINATION
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

    // 8. SPECTATOR PEEK INDICATOR
    const peekingBanner = document.getElementById('active-peeking-banner');
    let activelyPeekingTarget = null;
    if (isSpectatorOnly && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        (lobby.players || []).forEach(pl => {
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
        if (readyBtn) readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';

        if (me.peekIncoming && Object.keys(me.peekIncoming).length > 0) {
            const requester = Object.keys(me.peekIncoming)[0];
            const peekModal = document.getElementById('peek-request-modal');
            const pMsg = document.getElementById('peek-modal-msg');
            const pAllow = document.getElementById('peek-allow-btn');
            const pDeny = document.getElementById('peek-deny-btn');

            if (pMsg) pMsg.innerText = `${requester} wants to peek at your hand.`;
            if (pAllow) {
                pAllow.onclick = () => {
                    sendSocket({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: true });
                    window.toggleModal('peek-request-modal');
                };
            }
            if (pDeny) {
                pDeny.onclick = () => {
                    sendSocket({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: false });
                    window.toggleModal('peek-request-modal');
                };
            }
            if (peekModal) peekModal.style.display = 'flex';
        }
    }

    // 9. DYNAMIC ACTION BAR
    const standUpBtn = document.getElementById('stand-up-btn');
    const sitBtn = document.getElementById('sit-btn');
    const readyBtn = document.getElementById('ready-btn');
    const knockBtn = document.getElementById('knock-btn');
    const playerCount = (lobby.players || []).length;

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
                sitBtn.disabled = playerCount >= 6;
                sitBtn.innerText = playerCount < 6 ? 'Sit Down' : 'Table Full (6/6)';
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

    // 10. TURN ACTION & AUDIO TRIGGER
    const isMyTurnPlaying = !isSpectatorOnly && ((lobby.currentTurnUser || '').toLowerCase() === activeUsername.toLowerCase()) && 
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

    // 11. SIDE BET PROPOSALS (SIDEBAR & TOP DOCKED NOTIFICATIONS)
    const sidebar = document.getElementById('global-side-bets-sidebar');
    const sidebarList = document.getElementById('global-side-bets-list');
    const globalProps = lobby.globalProposals || [];

    if (globalProps.length > 0 && lobby.gameState !== 'lobby') {
        if (sidebar) sidebar.style.display = 'flex';
        let sidebarHtml = '';
        globalProps.forEach(gp => {
            const proposerName = gp.proposer || gp.creator;
            const isMyProp = (proposerName === activeUsername);
            const alreadyAccepted = gp.acceptedBy && gp.acceptedBy.includes(activeUsername);

            let actionHtml = '';
            if (isMyProp) {
                if (gp.acceptedBy && gp.acceptedBy.length > 0) {
                    actionHtml = `<button style="font-size:0.65rem; padding:3px 6px; background:#38bdf8; color:#0f172a; margin-top:4px;" onclick="openConfirmModal('${gp.id}', '${proposerName}', '${gp.pickUser || gp.condition}', ${JSON.stringify(gp.acceptedBy).replace(/"/g, '&quot;')})">Review (${gp.acceptedBy.length})</button>`;
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
                    <span>I like <b>${gp.pickUser || gp.condition}</b> for <b>$${gp.wagerAmt || 5}</b> (${proposerName})</span>
                    ${actionHtml}
                </div>
            `;
        });
        if (sidebarList) sidebarList.innerHTML = sidebarHtml;
    } else if (sidebar) {
        sidebar.style.display = 'none';
    }

    const globalProposalsContainer = document.getElementById('global-proposals-container') || document.getElementById('pending-bets-banner');
    if (globalProposalsContainer) {
        const pendingForMe = (lobby.globalProposals || []).filter(p => {
            const creator = p.proposer || p.creator;
            return creator !== activeUsername &&
                !(p.acceptedBy || []).includes(activeUsername) &&
                !(p.deniedBy || []).includes(activeUsername);
        });

        if (pendingForMe.length > 0 && lobby.gameState !== 'lobby') {
            globalProposalsContainer.style.display = 'flex';
            globalProposalsContainer.innerHTML = pendingForMe.map(bet => {
                const creator = bet.proposer || bet.creator;
                const cond = bet.pickUser || bet.condition || 'Win the Match';
                return `
                    <div class="global-bet-toast" style="background: rgba(4,20,13,0.95); border: 1px solid #d4af37; border-radius: 6px; padding: 6px 10px; margin: 4px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <div style="font-size: 0.8rem; color: #f8fafc;">
                            <strong>${creator}</strong>: $${bet.wagerAmt || 5} on <em>${cond}</em>
                        </div>
                        <div style="display: flex; gap: 4px;">
                            <button onclick="window.respondGlobalBet('${bet.id}', true)" style="background: #15803d; border: 1px solid #4ade80; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 0.75rem;">Confirm</button>
                            <button onclick="window.respondGlobalBet('${bet.id}', false)" style="background: #991b1b; border: 1px solid #f87171; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 0.75rem;">Deny</button>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            globalProposalsContainer.innerHTML = '';
            globalProposalsContainer.style.display = 'none';
        }
    }

    const bModal = document.getElementById('bet-modal');
    const isModalOpen = bModal && bModal.style.display === 'flex';
    if (lobby.pendingBetsForMe && lobby.pendingBetsForMe.length > 0 && !isModalOpen) {
        lobby.pendingBetsForMe.forEach(bet => {
            const label = bet.type === 'win' 
                ? `Side Bet: ${bet.proposer} bets $${bet.wagerAmt} that you win round.` 
                : `First Out Bet: ${bet.proposer} bets $${bet.wagerAmt} that ${bet.pickUser} is eliminated before ${bet.targetSurvivor}.`;
            const mTitle = document.getElementById('bet-modal-title');
            const mBody = document.getElementById('bet-modal-body');

            if (mTitle) mTitle.innerText = `Incoming Bet Proposal from ${bet.proposer}`;
            if (mBody) {
                mBody.innerHTML = `
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">${label}</p>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button onclick="respondToBet('${bet.id}', true)">Accept</button>
                        <button class="danger" onclick="respondToBet('${bet.id}', false)">Decline</button>
                    </div>
                `;
            }
            if (bModal) bModal.style.display = 'flex';
        });
        lobby.pendingBetsForMe = [];
    }

    // 12. POTS & CONFIG
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

    // 13. NEXT HAND OVERLAY
    const nextHandOverlay = document.getElementById('next-hand-overlay');
    const nextBtn = document.getElementById('next-hand-btn');

    if (lobby.gameState === 'roundOver') {
        const myPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
        const isPermanentlyOut = myPlayer && myPlayer.eliminated;

        if (lobby.activeParticipantsCount <= 1) {
            if (nextHandOverlay) nextHandOverlay.style.display = 'flex';
            if (nextBtn) {
                nextBtn.innerText = 'Returning to Ready Room...';
                nextBtn.disabled = true;
            }
        } else if (myPlayer && !isPermanentlyOut) {
            if (nextHandOverlay) nextHandOverlay.style.display = 'flex';
            if (nextBtn) {
                if (myPlayer.nextHandReady) {
                    nextBtn.innerText = 'Waiting for players (Auto in 8s)...';
                    nextBtn.disabled = true;
                } else {
                    nextBtn.innerText = 'Next Hand (Auto in 8s)';
                    nextBtn.disabled = false;
                }
            }
        } else if (nextHandOverlay) {
            nextHandOverlay.style.display = 'none';
        }
    } else if (nextHandOverlay) {
        nextHandOverlay.style.display = 'none';
    }

    // 14. DEALER DRAW & TIE BREAKER MODALS (MATCHING HTML IDs)
    const dealerDrawModal = document.getElementById('dealer-draw-modal');
    const turnBanner = document.getElementById('turn-banner');

    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        window.showCenterNotification(lobby.phaseMessage);
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
    }

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        if (dealerDrawModal) dealerDrawModal.style.display = 'flex';

        const pTitle = document.getElementById('dealer-draw-title');
        const pInstr = document.getElementById('dealer-draw-status');
        
        if (pTitle) {
            pTitle.innerText = lobby.gameState === 'dealerDraw' ? 'Picking for Dealer' : 'Tie-Breaker Draw';
        }
        if (pInstr) {
            if (lobby.gameState === 'tieBreaker' && (lobby.tiedParticipantsList || []).includes(activeUsername)) {
                pInstr.innerText = 'You are tied for lowest score! Pick your tie-breaker card:';
            } else if (lobby.gameState === 'tieBreaker') {
                pInstr.innerText = 'Watching tied players draw for elimination...';
            } else {
                pInstr.innerText = lobby.phaseMessage || 'Lowest card deals (Ace highest). Tap any card!';
            }
        }

        const activeParts = lobby.gameState === 'dealerDraw' 
            ? (lobby.players || []).filter(p => !p.eliminated)
            : (lobby.players || []).filter(p => (lobby.tiedParticipantsList || []).includes(p.username));

        let showcaseHtml = '<div style="display:flex; flex-wrap:wrap; justify-content:center; gap:8px;">';
        activeParts.forEach(p => {
            const card = lobby.drawResults?.[p.username];
            const isMe = (p.username.toLowerCase() === activeUsername.toLowerCase());
            showcaseHtml += `
                <div class="draw-showcase-item" style="display:flex; flex-direction:column; align-items:center; background:rgba(4,20,13,0.95); border:1.5px solid ${isMe ? '#38bdf8' : 'rgba(212,175,55,0.55)'}; border-radius:6px; padding:4px 8px; margin: 4px;">
                    <span class="draw-picker-badge" style="font-size:0.74rem; font-weight:800; color:${isMe ? '#38bdf8' : '#f6e05e'};">${p.username}${p.isBot ? ' 🤖' : ''}</span>
                    ${card ? window.formatCardHtml(card, false) : '<div class="draw-card-waiting" style="width:38px; height:52px; border:1.5px dashed #64748b; display:flex; align-items:center; justify-content:center; font-size:0.6rem; color:#94a3b8; margin-top:2px;">Wait</div>'}
                </div>
            `;
        });
        showcaseHtml += '</div>';

        const orderStrip = document.getElementById('draw-order-sequence');
        if (orderStrip) {
            orderStrip.innerHTML = showcaseHtml;
        }

        let poolSource = lobby.drawPool || [];
        if (lobby.gameState === 'tieBreaker') {
            const tieDeckPool = poolSource.filter(slot => !slot.chosenBy);
            const countRemaining = lobby.deckCount !== undefined ? lobby.deckCount : tieDeckPool.length;
            poolSource = tieDeckPool.slice(0, countRemaining);
        }

        let poolHtml = '';
        poolSource.forEach((slot, idx) => {
            const slotIndex = (slot && slot.index !== undefined) ? slot.index : idx;
            if (slot && slot.chosenBy) {
                poolHtml += `<div class="card-pool-item taken" title="Chosen by ${slot.chosenBy}" style="opacity:0.22; background:#04140b; border:1px solid #143521; color:#10b981; width:100%; aspect-ratio:2/2.7; display:flex; align-items:center; justify-content:center; border-radius:3px; font-size:0.72rem; margin:1px;">✓</div>`;
            } else {
                const isTied = lobby.gameState === 'tieBreaker' ? (lobby.tiedParticipantsList || []).includes(activeUsername) : true;
                const clickable = !isSpectatorOnly && isTied && !lobby.drawResults?.[activeUsername] && !window.appGlobals.hasChosenPoolCard;
                poolHtml += `<div class="card-pool-item ${clickable ? 'selectable' : ''}" ${clickable ? `onclick="choosePoolCard(${slotIndex})"` : ''} style="${!clickable ? 'opacity:0.4; cursor:not-allowed;' : 'cursor:pointer;'} background:linear-gradient(135deg, #1d4ed8 0%, #0f172a 100%); border:1.5px solid #93c5fd; color:#fff; width:100%; aspect-ratio:2/2.7; display:flex; align-items:center; justify-content:center; border-radius:3px; font-weight:900; font-size:0.72rem; margin:1px;">?</div>`;
            }
        });

        const poolGrid = document.getElementById('draw-pool-grid');
        if (poolGrid) {
            poolGrid.innerHTML = `<div style="display:grid; grid-template-columns:repeat(11, 1fr); gap:2px; width:100%; max-width:460px; margin:0 auto;">${poolHtml}</div>`;
        }

        if (turnBanner) turnBanner.innerText = lobby.gameState === 'dealerDraw' ? 'Dealer Draw Phase' : 'Tie-Breaker Draw';

    } else {
        if (dealerDrawModal) dealerDrawModal.style.display = 'none';
        if (turnBanner) {
            if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
                const isMyTurnPlaying = !isSpectatorOnly && ((lobby.currentTurnUser || '').toLowerCase() === activeUsername.toLowerCase());
                turnBanner.innerText = isMyTurnPlaying ? "YOUR TURN!" : `Turn: ${lobby.currentTurnUser}`;
            } else if (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd') {
                turnBanner.innerText = lobby.phaseMessage || 'Round Over';
            }
        }
    }

    // 15. CENTER TABLE & DIAMOND-LATTICE DECK RENDER
    const tableContainer = document.getElementById('table-oval-container');
    if (tableContainer) {
        let discardSlotHtml = '';
        if (lobby.discardTop) {
            const dVal = lobby.discardTop.val || '';
            const dSuit = normalizeSuit(lobby.discardTop.suit);
            const dIsRed = (dSuit === '♥' || dSuit === '♦');
            const dClass = dIsRed ? 'red-suit' : 'black-suit';

            discardSlotHtml = `
                <div class="card-slot playing-card ${dClass}" onclick="drawCard('discard')">
                    <div class="card-corner top-left">
                        <span class="corner-val">${dVal}</span>
                        <span class="corner-suit">${dSuit}</span>
                    </div>
                    <div class="card-center-pip">${dSuit}</div>
                    <div class="card-corner bottom-right">
                        <span class="corner-val">${dVal}</span>
                        <span class="corner-suit">${dSuit}</span>
                    </div>
                </div>
            `;
        } else {
            discardSlotHtml = `<div class="card-slot empty-slot" onclick="drawCard('discard')"><span>DISCARD</span></div>`;
        }

        let html = `
            <div class="pots-container">
                <div class="pot-total-display" id="pot-total-banner">Pot: $${lobby.potTotal || 0}</div>
                <div class="side-pot-total-display" id="side-pot-total-banner" style="display:${lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none'};">Side Pots: $${lobby.sidePotTotal || 0}</div>
            </div>
            <div class="deck-center" id="deck-center">
                <div class="card-slot back" id="deck-pile" onclick="drawCard('deck')">
                    <div class="card-back-inner"></div>
                    <span class="deck-counter-badge" id="deck-count-display">${lobby.deckCount || 0} left</span>
                </div>
                ${discardSlotHtml}
            </div>
        `;

        (lobby.players || []).forEach((p, idx) => {
            const revealedCardsHtml = p.cards && p.cards.length > 0 ? `<div class="seat-cards">${p.cards.map(c => window.formatCardHtml(c, true)).join('')}</div>` : '';
            const statusBadge = p.eliminated ? ' [OUT]' : '';
            const readyStatusIcon = p.ready ? '✅' : '❌';
            const botBadge = p.isBot ? ' 🤖' : '';
            const isCurrent = (p.username.toLowerCase() === (lobby.currentTurnUser || '').toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
            const isDealer = (idx === lobby.dealerIndex) || (lobby.dealerName === p.username);
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
                <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}">
                    <div class="seat-name-area" onclick="tapSeat('${p.username}')">
                        <span>${readyStatusIcon}</span> <b>${p.username}${botBadge}${statusBadge}</b>${dealerBadgeHtml}${micIcon}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                    </div>
                    ${revealedCardsHtml}
                    ${peekerBadgesHtml}
                </div>
            `;
        });

        tableContainer.innerHTML = html;
        if (nextHandOverlay) tableContainer.appendChild(nextHandOverlay);
    }

    // 16. LOCAL HAND RENDERING WITH AUTHENTIC PLAYING CARDS
    const handContainer = document.getElementById('my-cards-container');
    const scoreDisplay = document.getElementById('my-score-display');
    const myHandTitle = document.getElementById('my-hand-title');

    if (isSpectatorOnly) {
        if (handContainer) handContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:12px;">👀 Spectator Mode</div>';
        if (scoreDisplay) scoreDisplay.innerText = '-';
        if (myHandTitle) myHandTitle.innerHTML = 'Spectating Table';
    } else if (me && me.cards && handContainer) {
        if (myHandTitle) myHandTitle.innerHTML = 'My Hand (Score: <strong style="font-size: 1rem; color: var(--accent-gold);" id="my-score-display">' + window.calculateLocalScore(me.cards) + '</strong>)';
        handContainer.innerHTML = me.cards.map((c, i) => {
            const val = c.val || '';
            const suit = normalizeSuit(c.suit);
            const isRed = (suit === '♥' || suit === '♦');
            const suitClass = isRed ? 'red-suit' : 'black-suit';

            return `
                <div class="my-card playing-card ${suitClass}" onclick="discardCard(${i})">
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
        }).join('');

        if (scoreDisplay) scoreDisplay.innerText = window.calculateLocalScore(me.cards);
    } else if (handContainer) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.innerText = '0';
    }
};

window.renderLobbyState = window.updateUIFromLobby;