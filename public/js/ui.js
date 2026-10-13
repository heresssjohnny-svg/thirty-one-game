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

// Unified username helper preventing fallbacks to 'Player1'
function getActiveUsername() {
    return (window.clientState?.username || 
            localStorage.getItem('saved_username') || 
            document.getElementById('username-input')?.value || 
            'Player1').trim();
}

function getActiveRoomCode() {
    return (window.appGlobals?.currentJoinedCode || 
            localStorage.getItem('blitz31_active_room') || 
            '').toUpperCase();
}

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
// SAFE AUDIO, HAPTICS & MOBILE AUTOPLAY UNLOCK
// -------------------------------------------------------------
window.safePlaySound = function(cueType) {
    try {
        // 1. Direct targeting of primed DOM tags FIRST (bypasses Android WebSocket blocks)
        const audioEl = document.getElementById(`sound-${cueType}`);
        if (audioEl) {
            try { audioEl.currentTime = 0; } catch (e) {}
            const playPromise = audioEl.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => console.warn(`[Audio] Blocked HTML tag for ${cueType}:`, e));
            }
            return;
        }

        // 2. Global helper fallback
        if (typeof window.playSound === 'function') {
            window.playSound(cueType);
            return;
        }

        // 3. Dynamic audio fallback
        const fallbackAudio = new Audio(`/mp3s/${cueType}.mp3`);
        fallbackAudio.play().catch(e => console.warn(`[Audio] Blocked dynamic audio for ${cueType}:`, e));
    } catch (e) {
        console.error('[Audio] Trigger error:', e);
    }
};

window.triggerAudioCue = window.safePlaySound;
window.playYourTurnCue = function() { window.safePlaySound('yourturn'); };

window.safeVibrate = function(pattern) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(pattern); } catch (e) {}
    }
};

// Global one-tap unlock & priming for all 4 sound elements
function unlockAudioContextOnTap() {
    if (window.audioCtx && window.audioCtx.state === 'suspended') {
        window.audioCtx.resume();
    }
    if (typeof getAudioContext === 'function') {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    ['sound-knock', 'sound-yourturn', 'sound-card', 'sound-win'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.play().then(() => {
                el.pause();
                try { el.currentTime = 0; } catch (e) {}
            }).catch(() => {});
        }
    });

    document.removeEventListener('touchstart', unlockAudioContextOnTap);
    document.removeEventListener('click', unlockAudioContextOnTap);
}
document.addEventListener('touchstart', unlockAudioContextOnTap, { passive: true });
document.addEventListener('click', unlockAudioContextOnTap);

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

window.openRulesModal = function() {
    const modal = document.getElementById('rules-modal');
    if (modal) modal.style.display = 'flex';
};

window.closeRulesModal = function() {
    const modal = document.getElementById('rules-modal');
    if (modal) modal.style.display = 'none';
};

window.toggleRulesModal = function() {
    const modal = document.getElementById('rules-modal');
    if (!modal) return;
    modal.style.display = (modal.style.display === 'flex') ? 'none' : 'flex';
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

window.hideAllBetsButtons = function() {
    const selectors = [
        '#active-bets-btn', '#view-bets-btn', '#side-bets-btn', 
        '#bets-btn', '#bets-toggle-btn', '#side-bets-modal-btn', 
        '#bets-modal-btn', '.bets-btn', '.side-bets-btn'
    ];
    selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
            el.style.setProperty('display', 'none', 'important');
        });
    });

    const containers = document.querySelectorAll('#in-game-top-row-btns, #in-game-tools-row, .tools-row, #table-actions');
    containers.forEach(container => {
        container.querySelectorAll('button').forEach(btn => {
            const txt = (btn.textContent || '').trim().toLowerCase();
            if (txt === 'bets' || txt === 'side bets' || txt === 'active bets' || txt.includes('active bets')) {
                btn.style.setProperty('display', 'none', 'important');
            }
        });
    });
};
window.openActiveBetsModal = window.hideAllBetsButtons;
document.addEventListener('DOMContentLoaded', window.hideAllBetsButtons);

// --- LOBBY SESSION LEDGER CONTROLS (BILATERAL NETTED ENGINE) ---
window.toggleSessionLedger = function(show) {
    const modal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (!modal) return;
    const shouldShow = (show !== undefined) ? !!show : (modal.style.display !== 'flex');
    modal.style.display = shouldShow ? 'flex' : 'none';
    if (shouldShow) {
        window.renderSessionLedger(window.appGlobals?.latestLobbySnapshot);
    }
};

window.openSessionLedgerModal = function() {
    window.toggleSessionLedger(true);
};

window.renderSessionLedger = function(lobby) {
    if (!lobby) lobby = window.appGlobals?.latestLobbySnapshot || {};
    
    const settledLedgerEl = document.getElementById('session-settled-ledger-list')
        || document.getElementById('session-ledger-content')
        || document.getElementById('ledger-content')
        || document.getElementById('session-ledger-list')
        || document.getElementById('session-ledger-display');

    const activeBetsEl = document.getElementById('active-session-bets-list');

    if (activeBetsEl) {
        const activeList = lobby.activeBets || window.clientState?.activeBetsList || [];
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

    if (!settledLedgerEl) return;

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

    tally(lobby.mainGameLedger || window.clientState?.mainGameLedger);
    tally(lobby.sideBetLedger || window.clientState?.sideBetLedger);

    const allUsers = new Set();
    Object.keys(gross).forEach(u => allUsers.add(u));
    Object.values(gross).forEach(map => Object.keys(map).forEach(u => allUsers.add(u)));

    const usersArr = Array.from(allUsers);
    const netList = [];

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
        settledLedgerEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:8px; text-align:center;">No debts settled this session. All square!</div>';
    } else {
        settledLedgerEl.innerHTML = netList.map(({ debtor, creditor, amount }) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                <span style="font-size:0.85rem;"><span style="color:#f87171; font-weight:bold;">${debtor}</span> owes <span style="color:#4ade80; font-weight:bold;">${creditor}</span></span>
                <span style="color:#fde047; font-weight:bold; font-size:0.9rem;">$${amount}</span>
            </div>
        `).join('');
    }
};

// -------------------------------------------------------------
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
            <div class="lobby-item" onclick="window.joinLobby('${l.code}')">
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
function dispatchGameAction(payload) {
    if (!payload.code) payload.code = getActiveRoomCode();
    if (!payload.username) payload.username = getActiveUsername();

    if (typeof window.sendSocket === 'function') {
        window.sendSocket(payload);
    } else if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(payload);
    } else if (window.appGlobals?.ws && window.appGlobals.ws.readyState === 1) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    }
}

window.sitDown = function() { dispatchGameAction({ type: 'SIT_DOWN' }); };
window.standUp = function() { dispatchGameAction({ type: 'STAND_UP' }); };

window.toggleReady = function() {
    const myName = getActiveUsername().toLowerCase();
    const snap = window.appGlobals?.latestLobbySnapshot;
    const me = snap?.players?.find(p => p.username?.toLowerCase() === myName);
    
    const current = me ? Boolean(me.ready) : Boolean(window.clientState?.isReady);
    const nextState = !current;

    if (window.clientState) window.clientState.isReady = nextState;

    const btn = document.getElementById('ready-btn') || document.getElementById('btn-ready');
    if (btn) {
        btn.innerText = nextState ? 'Unready' : 'Ready Up';
        btn.style.background = nextState ? '#eab308' : '#15803d';
    }

    dispatchGameAction({ type: 'SET_READY', ready: nextState });
};

window.clickNextHand = function() {
    const overlay = document.getElementById('next-hand-overlay');
    if (overlay) overlay.style.display = 'none';
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    dispatchGameAction({ type: 'NEXT_HAND_READY' });
};

window.addBot = function() { dispatchGameAction({ type: 'ADD_BOT' }); };
window.removeBot = function() { dispatchGameAction({ type: 'REMOVE_BOT' }); };

window.updateWager = function(wagerAmount) {
    const sel = document.getElementById('config-wager') || document.getElementById('lobby-wager-select');
    const amount = Number(wagerAmount) || (sel ? parseInt(sel.value, 10) : 5);
    if (!isNaN(amount) && amount > 0) {
        dispatchGameAction({ type: 'UPDATE_WAGER', wager: amount });
    }
};

window.submitLivesVote = function(lives) {
    const sel = document.getElementById('config-lives') || document.getElementById('lobby-lives-select');
    const count = Number(lives) || (sel ? parseInt(sel.value, 10) : 2);
    if (!isNaN(count) && count > 0) {
        dispatchGameAction({ type: 'UPDATE_SETTINGS', lives: count });
    }
};

window.proposeEndGame = function() {
    if (!confirm("Propose ending the game and returning to the lobby?")) return;
    dispatchGameAction({ type: 'END_GAME_PROPOSAL' });
};

window.leaveLobby = function() {
    if (!confirm("Are you sure you want to leave the table?")) return;
    dispatchGameAction({ type: 'LEAVE_LOBBY' });

    if (typeof window.disconnectLiveKit === 'function') {
        try { window.disconnectLiveKit(); } catch (e) {}
    }

    const gameView = document.getElementById('game-view');
    const mainMenu = document.getElementById('main-menu');
    if (gameView) gameView.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';
    localStorage.removeItem('blitz31_active_room');
};

// Card actions with sound & haptic cues restored
window.drawFromDeck = function() {
    window.safePlaySound('card');
    window.safeVibrate(35);
    dispatchGameAction({ type: 'DRAW_CARD', source: 'deck', action: 'DRAW_DECK' });
};

window.drawFromDiscard = function() {
    window.safePlaySound('card');
    window.safeVibrate(35);
    dispatchGameAction({ type: 'DRAW_CARD', source: 'discard', action: 'DRAW_DISCARD' });
};

window.drawCard = function(source) {
    if (source === 'discard') {
        window.drawFromDiscard();
    } else {
        window.drawFromDeck();
    }
};

window.discardCard = function(cardIndex) {
    const idx = Number(cardIndex);
    if (!isNaN(idx)) {
        window.safePlaySound('card');
        window.safeVibrate(30);
        dispatchGameAction({ type: 'DISCARD_CARD', cardIndex: idx, index: idx });
    }
};

window.knock = function() {
    if (typeof window.knockRound === 'function') {
        window.knockRound();
    } else {
        dispatchGameAction({ type: 'KNOCK' });
    }
};

window.choosePoolCard = function(poolIndex) {
    const idx = Number(poolIndex);
    if (!isNaN(idx)) {
        window.safePlaySound('card');
        dispatchGameAction({ type: 'CHOOSE_POOL_CARD', index: idx, cardIndex: idx, poolIndex: idx });
    }
};

window.setReady = window.toggleReady;
window.handleSitDown = window.sitDown;
window.handleStandUp = window.standUp;
window.readyNextHand = window.clickNextHand;
window.knockGame = window.knock;
window.selectPoolCard = window.choosePoolCard;

// -------------------------------------------------------------
// 6. END GAME VOTE MODAL & SUBMISSION
// -------------------------------------------------------------
function renderEndGameVoteModal(lobby) {
    let modal = document.getElementById('end-game-vote-modal');
    if (!lobby || !lobby.endGameVote) {
        if (modal) modal.style.display = 'none';
        return;
    }

    const activeUsername = getActiveUsername().toLowerCase();
    const vote = lobby.endGameVote;

    // Check if current user is an active seated human
    const isSeatedHuman = (lobby.players || []).some(
        p => p.username && p.username.toLowerCase() === activeUsername && !p.isBot
    );

    // Check if user has already voted
    const hasVoted = Object.keys(vote.votes || {}).some(
        u => u.toLowerCase() === activeUsername
    );

    if (!isSeatedHuman || hasVoted) {
        if (modal) modal.style.display = 'none';
        return;
    }

    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'end-game-vote-modal';
        modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 10010; padding: 16px;';
        document.body.appendChild(modal);
    }

    const proposer = vote.proposer || 'A player';

    modal.innerHTML = `
        <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #ef4444; border-radius: 12px; width: 100%; max-width: 380px; padding: 20px; color: #f8fafc; font-family: inherit; box-shadow: 0 10px 30px rgba(0,0,0,0.8); text-align: center;">
            <h3 style="margin: 0 0 10px; color: #fca5a5; font-size: 1.2rem; text-transform: uppercase;">Vote to End Match</h3>
            <p style="margin: 0 0 16px; font-size: 0.95rem; color: #cbd5e1;">
                <strong style="color: #fbbf24;">${proposer}</strong> has proposed ending the game and returning to the lobby.
            </p>
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button type="button" onclick="submitEndGameVote(false)" style="flex: 1; padding: 10px; border-radius: 6px; background: #374151; color: #fff; border: 1px solid #6b7280; cursor: pointer; font-weight: bold; font-size: 0.95rem;">
                    No (Keep Playing)
                </button>
                <button type="button" onclick="submitEndGameVote(true)" style="flex: 1; padding: 10px; border-radius: 6px; background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; border: 1px solid #f87171; cursor: pointer; font-weight: bold; font-size: 0.95rem;">
                    Yes (End Match)
                </button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

window.submitEndGameVote = function(agree) {
    dispatchGameAction({ type: 'VOTE_END_GAME', agree: !!agree });
    const modal = document.getElementById('end-game-vote-modal');
    if (modal) modal.style.display = 'none';
};

// -------------------------------------------------------------
// 7. KNOCK VALIDATION & EXECUTION
// -------------------------------------------------------------
function updateKnockAlertAndAudio(lobby) {
    const knockAlertModal = document.getElementById('knock-alert-modal');

    if (lobby.knockedBy && lobby.knockedBy !== window.appGlobals.lastKnownKnockedBy) {
        window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
        const activeUsername = getActiveUsername();
        
        // Opponent knock cue trigger
        if (lobby.knockedBy.toLowerCase() !== activeUsername.toLowerCase()) {
            window.safePlaySound('knock');
            window.safeVibrate([180, 110, 180, 110, 180]);
        }
    } else if (!lobby.knockedBy) {
        window.appGlobals.lastKnownKnockedBy = null;
    }

    if (knockAlertModal) {
        if (lobby.knockedBy && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn')) {
            knockAlertModal.innerText = `🔔 ${lobby.knockedBy.toUpperCase()} HAS KNOCKED!`;
            knockAlertModal.style.display = 'block';
        } else {
            knockAlertModal.style.display = 'none';
        }
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
    const activeUsername = getActiveUsername();
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

    window.safePlaySound('knock');
    if (typeof speakKnockedCue === 'function') speakKnockedCue();
    window.safeVibrate([180, 110, 180, 110, 180]);
    dispatchGameAction({ type: 'KNOCK' });
};

// -------------------------------------------------------------
// 8. SIDE BETS & PEEKING DIALOGS
// -------------------------------------------------------------
window.handleSeatClick = function(seatIndex) {
    if (window.clientState.gameState === 'lobby') {
        window.showCenterNotification("Game hasn't started yet! Ready up to play.");
        return;
    }
    const lobby = window.appGlobals.latestLobbySnapshot;
    if (!lobby || !lobby.players) return;
    const targetPlayer = lobby.players.find(p => String(p.seat) === String(seatIndex));
    if (targetPlayer?.username) {
        window.tapSeat(targetPlayer.username);
    }
};

window.tapSeat = function(targetUsername) {
    const activeUsername = getActiveUsername();
    if (window.clientState.gameState === 'lobby') {
        window.showCenterNotification("Game hasn't started yet! Ready up to play.");
        return;
    }

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
    dispatchGameAction({ type: 'REQUEST_PEEK', targetUsername });
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
    dispatchGameAction({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`First to lose bet proposed to ${target}!`);
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    dispatchGameAction({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`Global bet offered on ${pickUser}!`);
};

window.acceptGlobalProposal = function(proposalId) {
    dispatchGameAction({ type: 'ACCEPT_GLOBAL_PROPOSAL', proposalId: proposalId, betId: proposalId, id: proposalId });
};

window.respondGlobalBet = function(proposalId, accept) {
    dispatchGameAction({ type: 'RESPOND_GLOBAL_BET', proposalId: proposalId, betId: proposalId, id: proposalId, accept: !!accept, confirm: !!accept });
};

window.confirmGlobalBet = function(proposalId, acceptedUser, confirmChoice) {
    dispatchGameAction({ type: 'CONFIRM_GLOBAL_BET', proposalId: proposalId, betId: proposalId, id: proposalId, acceptedUser: acceptedUser, confirm: !!confirmChoice, accept: !!confirmChoice });
    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'none';
};

window.respondToBet = function(betId, accept) {
    dispatchGameAction({ type: 'RESPOND_BET', betId: betId, proposalId: betId, id: betId, accept: !!accept, confirm: !!accept });
    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'none';
};

// -------------------------------------------------------------
// 9. MASTER TABLE RENDER & SPECTATOR LOGIC
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
    const activeUsername = getActiveUsername();

    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    if (topRowBtns) topRowBtns.style.display = 'inline-flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (endBtn) {
        endBtn.style.display = 'inline-block';
        endBtn.onclick = function() { window.proposeEndGame(); };
    }
    if (leaveBtn) {
        leaveBtn.style.display = 'inline-block';
        leaveBtn.onclick = function(e) {
            if (e) e.preventDefault();
            window.leaveLobby();
        };
    }

    const ledgerBtn = document.getElementById('ledger-btn') 
        || document.getElementById('session-ledger-btn')
        || document.getElementById('board-btn');
    if (ledgerBtn) {
        ledgerBtn.onclick = function() { window.toggleSessionLedger(true); };
    }

    window.hideAllBetsButtons();

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name || 'Table'} [${lobby.code || '----'}]`;

    if (lobby.chatHistory) {
        window.syncChatHistory(lobby.chatHistory);
    }

    // CELEBRATION HELPER WITH AUDIO
    function fireCelebrationEffect(winnerName, titleMsg) {
        window.safePlaySound('win');
        const canvas = document.getElementById('celebration-canvas');
        if (canvas) canvas.style.display = 'block';

        if (typeof window.triggerWinnerCelebration === 'function') {
            window.triggerWinnerCelebration(winnerName, titleMsg);
        } else if (typeof triggerWinnerCelebration === 'function') {
            triggerWinnerCelebration(winnerName, titleMsg);
        } else if (typeof window.trigger31Celebration === 'function') {
            window.trigger31Celebration(winnerName);
        }
    }

    // 1. HIT 31 CELEBRATION
    if (lobby.hit31Player) {
        if (window.appGlobals.lastCelebrated31 !== lobby.hit31Player) {
            window.appGlobals.lastCelebrated31 = lobby.hit31Player;
            fireCelebrationEffect(lobby.hit31Player, "HIT 31!");
        }
    } else {
        window.appGlobals.lastCelebrated31 = null;
    }

    // 2. TOURNAMENT CHAMPION CELEBRATION
    const isTournamentOver = (lobby.gameState === 'tournamentEnd') || (lobby.phaseMessage && lobby.phaseMessage.includes('TOURNAMENT WINNER'));
    if (isTournamentOver) {
        let winnerName = lobby.tournamentWinner || lobby.lastGameWinner;
        if (!winnerName && lobby.phaseMessage) {
            const m = lobby.phaseMessage.match(/TOURNAMENT WINNER!\s+(.*?)\s+wins/);
            if (m && m[1]) winnerName = m[1].trim();
        }
        if (winnerName && window.appGlobals.lastCelebratedWinner !== winnerName) {
            window.appGlobals.lastCelebratedWinner = winnerName;
            fireCelebrationEffect(winnerName, "TOURNAMENT CHAMPION!");
        }
    } else if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
        window.appGlobals.lastCelebratedWinner = null;
        const canvas = document.getElementById('celebration-canvas');
        if (canvas && lobby.gameState === 'playing') {
            canvas.style.display = 'none';
        }
    }

    // 3. STATE TRANSITIONS
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

    // 5. END GAME VOTE MODAL
    renderEndGameVoteModal(lobby);

    // 6. KNOCK VISUALS & ALERTS
    updateKnockAlertAndAudio(lobby);

    // 7. TOP IN-GAME FEEDS
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

    // 8. PARTICIPANT & SPECTATOR DETERMINATION
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

    // 9. DYNAMIC ACTION BAR
    const standUpBtn = document.getElementById('stand-up-btn');
    const sitBtn = document.getElementById('sit-btn');
    const readyBtn = document.getElementById('ready-btn');
    const knockBtn = document.getElementById('knock-btn');
    const playerCount = (lobby.players || []).length;

    if (standUpBtn) standUpBtn.onclick = function(e) { if (e) e.preventDefault(); window.standUp(); };
    if (sitBtn) sitBtn.onclick = function(e) { if (e) e.preventDefault(); window.sitDown(); };
    if (readyBtn) readyBtn.onclick = function(e) { if (e) e.preventDefault(); window.toggleReady(); };

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

    // 10. TURN AUDIO & HAPTIC NOTIFICATION
    const isMyTurnPlaying = !isSpectatorOnly && 
        ((lobby.currentTurnUser || '').toLowerCase() === activeUsername.toLowerCase()) && 
        (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');

    if (isMyTurnPlaying) {
        if (!window.appGlobals.wasMyTurn) {
            window.appGlobals.wasMyTurn = true;
            window.safePlaySound('yourturn');
            window.safeVibrate([60, 40, 60]);
        }
    } else {
        window.appGlobals.wasMyTurn = false;
    }

    updateKnockButtonState(lobby, me, isMyTurnPlaying);

    // 11. POTS & SHOWDOWN OVERLAYS
    const potBanner = document.getElementById('pot-total-banner');
    if (potBanner) potBanner.innerText = `Pot: $${lobby.potTotal || 0}`;

    const sidePotBanner = document.getElementById('side-pot-total-banner');
    if (sidePotBanner) {
        sidePotBanner.style.display = (lobby.sidePotTotal && lobby.sidePotTotal > 0) ? 'block' : 'none';
        sidePotBanner.innerText = `Side Pots: $${lobby.sidePotTotal || 0}`;
    }

    const nextHandOverlay = document.getElementById('next-hand-overlay');
    const nextBtn = document.getElementById('next-hand-btn');
    const showdownContainer = document.getElementById('showdown-hands-container');

    if (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd') {
        if (nextHandOverlay) nextHandOverlay.style.display = 'flex';

        if (showdownContainer) {
            let showdownHtml = '';
            (lobby.players || []).forEach(p => {
                const score = (p.cards && p.cards.length > 0) ? window.calculateLocalScore(p.cards) : null;
                const cardsHtml = (p.cards || []).map(c => {
                    const isRed = c.suit === '♥' || c.suit === '♦';
                    return `
                        <div class="showdown-mini-card ${isRed ? 'card-red' : 'card-black'}">
                            <span class="card-val">${c.val}</span>
                            <span class="card-suit">${c.suit}</span>
                        </div>
                    `;
                }).join('');

                const isSelf = p.username.toLowerCase() === activeUsername.toLowerCase();
                showdownHtml += `
                    <div class="showdown-player-cell ${isSelf ? 'my-showdown-cell' : ''}">
                        <div class="showdown-player-header">
                            <span class="showdown-name">${p.username} ${isSelf ? '(You)' : ''}</span>
                            <span class="showdown-score ${score === 31 ? 'blitz-score' : ''}">${score !== null ? score + ' pts' : ''}</span>
                        </div>
                        <div class="showdown-cards-row">
                            ${cardsHtml || '<span style="color:#94a3b8; font-size:0.75rem;">No cards</span>'}
                        </div>
                    </div>
                `;
            });
            showdownContainer.innerHTML = showdownHtml;
        }

        const myPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
        const isPermanentlyOut = myPlayer && myPlayer.eliminated;

        if (lobby.activeParticipantsCount <= 1 || lobby.gameState === 'tournamentEnd') {
            if (nextBtn) {
                nextBtn.innerText = 'Tournament Complete';
                nextBtn.disabled = true;
            }
        } else if (myPlayer && !isPermanentlyOut) {
            if (nextBtn) {
                nextBtn.innerText = myPlayer.nextHandReady ? 'Waiting for players (Auto in 8s)...' : 'Next Hand (Auto in 8s)';
                nextBtn.disabled = Boolean(myPlayer.nextHandReady);
            }
        }
    } else {
        if (nextHandOverlay) nextHandOverlay.style.display = 'none';
        if (showdownContainer) showdownContainer.innerHTML = '';
    }

    // 12. CENTER TABLE & HARDWARE FELT
    const tableContainer = document.getElementById('table-oval-container');
    if (tableContainer) {
        let discardSlotHtml = '';
        if (lobby.discardTop) {
            const dVal = lobby.discardTop.val || '';
            const dSuit = normalizeSuit(lobby.discardTop.suit);
            const dClass = (dSuit === '♥' || dSuit === '♦') ? 'red-suit' : 'black-suit';

            discardSlotHtml = `
                <div class="card-slot playing-card ${dClass}" onclick="drawCard('discard')">
                    <div class="card-corner top-left"><span class="corner-val">${dVal}</span><span class="corner-suit">${dSuit}</span></div>
                    <div class="card-center-pip">${dSuit}</div>
                    <div class="card-corner bottom-right"><span class="corner-val">${dVal}</span><span class="corner-suit">${dSuit}</span></div>
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

            html += `
                <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}" onclick="window.tapSeat('${p.username}')" style="cursor:pointer;">
                    <div class="seat-name-area">
                        <span>${readyStatusIcon}</span> <b>${p.username}${botBadge}${statusBadge}</b>${dealerBadgeHtml}${micIcon}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                    </div>
                    ${revealedCardsHtml}
                </div>
            `;
        });

        tableContainer.innerHTML = html;
        if (nextHandOverlay) tableContainer.appendChild(nextHandOverlay);
    }

    // 13. LOCAL HAND RENDERING
    const handContainer = document.getElementById('my-cards-container');
    const scoreDisplay = document.getElementById('my-score-display');
    const myHandTitle = document.getElementById('my-hand-title');

    if (isSpectatorOnly) {
        if (handContainer) handContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:12px;">👀 Spectator Mode</div>';
        if (scoreDisplay) scoreDisplay.innerText = '-';
        if (myHandTitle) myHandTitle.innerHTML = 'Spectating Table';
    } else if (me && me.cards && handContainer) {
        if (myHandTitle) myHandTitle.innerHTML = 'My Hand (Score: <strong style="font-size: 1rem; color: var(--accent-gold);">' + window.calculateLocalScore(me.cards) + '</strong>)';
        handContainer.innerHTML = me.cards.map((c, i) => {
            const val = c.val || '';
            const suit = normalizeSuit(c.suit);
            const suitClass = (suit === '♥' || suit === '♦') ? 'red-suit' : 'black-suit';

            return `
                <div class="my-card playing-card ${suitClass}" onclick="discardCard(${i})">
                    <div class="card-corner top-left"><span class="corner-val">${val}</span><span class="corner-suit">${suit}</span></div>
                    <div class="card-center-pip">${suit}</div>
                    <div class="card-corner bottom-right"><span class="corner-val">${val}</span><span class="corner-suit">${suit}</span></div>
                </div>
            `;
        }).join('');

        if (scoreDisplay) scoreDisplay.innerText = window.calculateLocalScore(me.cards);
    } else if (handContainer) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.innerText = '0';
    }
    // 14. LOBBY CONFIG BAR VISIBILITY
    const configBar = document.getElementById('lobby-config-bar');
    if (configBar) {
        configBar.style.display = (lobby.gameState === 'lobby') ? 'flex' : 'none';
    }
    // 15. DEALER DRAW & TIE BREAKER MODALS
    const dealerDrawModal = document.getElementById('dealer-draw-modal');
    if (dealerDrawModal) {
        if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
            dealerDrawModal.style.display = 'flex';

            const pTitle = document.getElementById('dealer-draw-title');
            if (pTitle) pTitle.innerText = lobby.gameState === 'tieBreaker' ? 'Tie-Breaker Draw' : 'Picking for Dealer';

            const pInstr = document.getElementById('dealer-draw-status');
            if (pInstr) pInstr.innerText = lobby.phaseMessage || 'Lowest card deals (Ace highest). Tap any card!';
            
            const sequenceDiv = document.getElementById('draw-order-sequence');
            if (sequenceDiv) {
                let drawParts = (lobby.players || []).filter(p => !p.eliminated);
                if (lobby.gameState === 'tieBreaker') {
                    drawParts = drawParts.filter(p => (lobby.tiedParticipantsList || []).includes(p.username));
                }
                
                let showcaseHtml = '';
                drawParts.forEach(p => {
                    const card = lobby.drawResults?.[p.username];
                    const isMe = (p.username.toLowerCase() === activeUsername.toLowerCase());
                    showcaseHtml += `
                        <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
                            <span style="font-size:0.75rem; font-weight:bold; ${isMe ? 'color:#38bdf8;' : 'color:#cbd5e1;'}">
                                ${p.username}${p.isBot ? ' 🤖' : ''}
                            </span>
                            ${card ? window.formatCardHtml(card, true) : '<div style="width:40px; height:56px; border:1px dashed #64748b; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:0.6rem; color:#94a3b8;">Wait</div>'}
                        </div>
                    `;
                });
                sequenceDiv.style.display = 'flex';
                sequenceDiv.style.gap = '12px';
                sequenceDiv.style.justifyContent = 'center';
                sequenceDiv.style.flexWrap = 'wrap';
                sequenceDiv.style.marginBottom = '16px';
                sequenceDiv.innerHTML = showcaseHtml;
            }

            const poolGrid = document.getElementById('draw-pool-grid');
            if (poolGrid) {
                let poolHtml = '';
                const isSpecUser = window.clientState.isSpectator;
                
                (lobby.drawPool || []).forEach((slot, idx) => {
                    const slotIndex = slot.index !== undefined ? slot.index : idx;
                    const isChosen = slot.chosenBy !== null;
                    
                    let clickable = false;
                    if (!isSpecUser && !isChosen) {
                        if (lobby.gameState === 'dealerDraw' && !lobby.drawResults?.[activeUsername]) clickable = true;
                        if (lobby.gameState === 'tieBreaker' && (lobby.tiedParticipantsList || []).includes(activeUsername) && !lobby.drawResults?.[activeUsername]) clickable = true;
                    }

                    if (isChosen) {
                        poolHtml += `
                            <div style="width:40px; height:56px; background:rgba(0,0,0,0.6); border-radius:4px; display:flex; align-items:center; justify-content:center; flex-direction:column;">
                                <span style="font-size:0.5rem; color:#94a3b8; text-align:center; word-break:break-all; padding:2px;">${slot.chosenBy}</span>
                            </div>
                        `;
                    } else if (clickable) {
                        poolHtml += `
                            <div style="width:40px; height:56px; background:repeating-linear-gradient(45deg, #1e293b, #1e293b 4px, #0f172a 4px, #0f172a 8px); border:1px solid #3b82f6; border-radius:4px; cursor:pointer;" onclick="window.selectPoolCard(${slotIndex})">
                            </div>
                        `;
                    } else {
                        poolHtml += `
                            <div style="width:40px; height:56px; background:repeating-linear-gradient(45deg, #1e293b, #1e293b 4px, #0f172a 4px, #0f172a 8px); border:1px solid #475569; border-radius:4px; opacity:0.5;" onclick="window.showCenterNotification('You cannot pick a card right now.')">
                            </div>
                        `;
                    }
                });
                poolGrid.style.display = 'flex';
                poolGrid.style.flexWrap = 'wrap';
                poolGrid.style.gap = '6px';
                poolGrid.style.justifyContent = 'center';
                poolGrid.innerHTML = poolHtml;
            }
        } else {
            dealerDrawModal.style.display = 'none';
        }
    }
}; // <-- Make sure this closing bracket is still at the very end!



window.renderLobbyState = window.updateUIFromLobby;

// -------------------------------------------------------------
// 10. MICROPHONE BUTTON BINDINGS & DOM READY INITIALIZATION
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    // Bind all known microphone buttons to voice.js toggle function
    const micButtons = [
        document.getElementById('vc-main-btn'),
        document.getElementById('voice-btn'),
        document.getElementById('voice-toggle-btn')
    ];

    micButtons.forEach(btn => {
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (typeof window.toggleVoiceOnOff === 'function') {
                    window.toggleVoiceOnOff();
                } else if (typeof window.toggleLiveKitVoice === 'function') {
                    window.toggleLiveKitVoice();
                }
            });
        }
    });
});
