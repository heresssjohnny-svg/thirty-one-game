// public/js/ui.js - Complete DOM Coordinator, Table Render, Spectator Peek, Host Admin & Card Visuals

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
    notificationTimer: null,
    declinedProposals: [],
    lastAutoConfirmKey: null,
    promptedConfirmations: {}
};

// Resilient username resolver that checks both players AND spectators
window.getMyUsername = function(lobby) {
    let name = '';

    if (window.userSession && window.userSession.username) {
        name = window.userSession.username.trim();
    }
    if (!name || name === 'Player1') {
        const inputVal = (document.getElementById('username-input')?.value || '').trim();
        if (inputVal && inputVal !== 'Player1') name = inputVal;
    }
    if (!name || name === 'Player1') {
        const stateVal = (window.clientState?.username || '').trim();
        if (stateVal && stateVal !== 'Player1') name = stateVal;
    }
    if (!name || name === 'Player1') {
        name = (localStorage.getItem('saved_username') || localStorage.getItem('blitz31_username') || localStorage.getItem('p31_username') || '').trim();
    }

    if (lobby && name) {
        if (Array.isArray(lobby.players)) {
            const pMatch = lobby.players.find(p => p.username && p.username.toLowerCase() === name.toLowerCase());
            if (pMatch) return pMatch.username;
        }
        if (Array.isArray(lobby.spectators)) {
            const sMatch = lobby.spectators.find(s => s.username && s.username.toLowerCase() === name.toLowerCase());
            if (sMatch) return sMatch.username;
        }
    }

    return name || 'Player1';
};

function getActiveUsername() {
    return window.getMyUsername(window.appGlobals?.latestLobbySnapshot);
}
window.getActiveUsername = getActiveUsername;

function getActiveRoomCode() {
    return (window.appGlobals?.currentJoinedCode || 
            localStorage.getItem('blitz31_active_room') || 
            '').toUpperCase();
}

function sendSocket(payload) {
    if (!payload) return;
    if (!payload.code) {
        const c = getActiveRoomCode();
        if (c) payload.code = c;
    }
    if (!payload.username) {
        payload.username = getActiveUsername();
    }

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
    const sfxToggle = document.getElementById('setting-sfx');
    if (sfxToggle && !sfxToggle.checked) return;
    if (localStorage.getItem('blitz31_sfx_enabled') === 'false') return;

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

        // 2. Dynamic audio fallback
        const fallbackAudio = new Audio(`/mp3s/${cueType}.mp3`);
        fallbackAudio.play().catch(e => console.warn(`[Audio] Blocked dynamic audio for ${cueType}:`, e));
    } catch (e) {
        console.error('[Audio] Trigger error:', e);
    }
};

window.playSound = window.safePlaySound;
window.triggerAudioCue = window.safePlaySound;
window.playYourTurnCue = function() { window.safePlaySound('yourturn'); };

window.safeVibrate = function(pattern) {
    const sfxToggle = document.getElementById('setting-sfx');
    if (sfxToggle && !sfxToggle.checked) return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(pattern); } catch (e) {}
    }
};
window.triggerVibration = window.safeVibrate;

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

function getCardPoints(card) {
    if (!card) return 0;
    if (card.points !== undefined) return Number(card.points) || 0;
    const v = String(card.val || card.value || '').toUpperCase();
    if (v === 'A') return 11;
    if (['K', 'Q', 'J', '10'].includes(v)) return 10;
    return Number(v) || 0;
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

function scoreThreeCards(threeCards) {
    if (!threeCards || threeCards.length === 0) return 0;
    if (threeCards.length === 3 && threeCards[0].val && threeCards[0].val === threeCards[1].val && threeCards[0].val === threeCards[2].val) {
        return 30.5;
    }
    const sums = {};
    threeCards.forEach(c => {
        if (!c) return;
        const s = normalizeSuit(c.suit);
        sums[s] = (sums[s] || 0) + getCardPoints(c);
    });
    return Math.max(...Object.values(sums), 0);
}

window.calculateLocalScore = function(cards) {
    if (!cards || !Array.isArray(cards) || cards.length === 0) return 0;
    if (cards.length === 4) {
        let best = 0;
        for (let i = 0; i < 4; i++) {
            const sub = cards.filter((_, idx) => idx !== i);
            best = Math.max(best, scoreThreeCards(sub));
        }
        return best;
    }
    return scoreThreeCards(cards);
};

// -------------------------------------------------------------
// 3. MODALS, NOTIFICATIONS, CHAT & SESSION LEDGER CONTROLS
// -------------------------------------------------------------
window.toggleModal = function(id, forceState) {
    const m = document.getElementById(id);
    if (!m) return;
    const willOpen = (typeof forceState === 'boolean') ? forceState : (m.style.display !== 'flex');
    if (willOpen && id === 'bet-modal' && typeof window.toggleMinimizeBetModal === 'function') {
        window.ensureBetModalMinimizeControls();
        window.toggleMinimizeBetModal(true);
    }
    m.style.display = willOpen ? 'flex' : 'none';

    if (willOpen && (id === 'session-ledger-modal' || id === 'ledger-modal') && typeof window.renderSessionLedger === 'function') {
        window.renderSessionLedger(window.appGlobals?.latestLobbySnapshot);
    }
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
    if (typeof window.refreshAudioOutputDevices === 'function') window.refreshAudioOutputDevices();
    if (typeof window.refreshVoiceParticipantsList === 'function') window.refreshVoiceParticipantsList();
    const m = document.getElementById('settings-modal');
    if (m) m.style.display = 'flex';
};

window.closeSettingsModal = function() {
    const m = document.getElementById('settings-modal');
    if (m) m.style.display = 'none';
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
    const content = document.getElementById('spectators-list') || document.getElementById('spectators-list-content');
    const specs = window.clientState.spectatorsList || [];
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (content) {
        if (specs.length === 0) {
            content.innerHTML = '<div class="empty-list-notice">No spectators currently watching.</div>';
        } else {
            content.innerHTML = '<ul style="padding-left:14px; margin:0; list-style:none;">' +
                specs.map(s => {
                    const sObj = (typeof s === 'object' && s !== null) ? s : { username: String(s) };
                    const vcBadge = sObj.inVC ? (sObj.isMuted ? ' 🔇' : ' 🎙️') : '';
                    const adminBtns = window.getHostAdminButtonsHTML(lobby, sObj);
                    return `<li style="margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;"><span><b>${sObj.username}</b>${vcBadge}</span>${adminBtns}</li>`;
                }).join('') +
                '</ul>';
        }
    }
    const modal = document.getElementById('spectator-list-modal') || document.getElementById('spectators-modal');
    if (modal) modal.style.display = 'flex';
};

window.closeSpectatorListModal = function() {
    const modal = document.getElementById('spectator-list-modal') || document.getElementById('spectators-modal');
    if (modal) modal.style.display = 'none';
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
document.addEventListener('DOMContentLoaded', window.hideAllBetsButtons);

window.openActiveBetsModal = function() {
    const myName = getActiveUsername();
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

// --- ACTIVE SIDE BETS LIST SYNC & LEDGER FALLBACKS (PRESERVES LEDGER.JS TOGGLE ENGINE) ---
window.syncActiveSessionBetsList = function(lobby) {
    if (!lobby) lobby = window.appGlobals?.latestLobbySnapshot || {};
    const activeBetsEl = document.getElementById('active-session-bets-list');
    if (!activeBetsEl) return;

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
};

// Only define ledger modal helpers if ledger.js hasn't already registered the toggle-enabled versions
window.toggleSessionLedger = window.toggleSessionLedger || function(show) {
    const modal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (!modal) return;
    const shouldShow = (show !== undefined) ? !!show : (modal.style.display !== 'flex');
    modal.style.display = shouldShow ? 'flex' : 'none';
    if (shouldShow && typeof window.renderSessionLedger === 'function') {
        window.renderSessionLedger(window.appGlobals?.latestLobbySnapshot);
    }
};

window.openSessionLedgerModal = window.openSessionLedgerModal || function() {
    window.toggleSessionLedger(true);
};

window.closeSessionLedgerModal = window.closeSessionLedgerModal || function() {
    const m = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (m) m.style.display = 'none';
};

window.openLifetimeLedgerModal = window.openLifetimeLedgerModal || function() {
    sendSocket({ type: 'GET_LIFETIME_LEDGER' });
    const m = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    if (m) m.style.display = 'flex';
};

window.closeLifetimeLedgerModal = window.closeLifetimeLedgerModal || function() {
    const m = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    if (m) m.style.display = 'none';
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
// 5. IN-GAME ACTIONS, HOST ADMIN CONTROLS, AUDIO & CARD INTERACTIONS
// -------------------------------------------------------------
window.isCurrentUserLobbyHost = function(lobby) {
    const snap = lobby || window.appGlobals?.latestLobbySnapshot;
    if (!snap || !snap.host) return false;
    const myName = getActiveUsername().trim().toLowerCase();
    return Boolean(myName && snap.host.trim().toLowerCase() === myName);
};

window.adminKickPlayer = window.adminKickPlayer || function(targetUsername) {
    if (!targetUsername) return;
    if (!confirm(`Kick ${targetUsername} from the room?`)) return;
    sendSocket({
        type: 'ADMIN_KICK_PLAYER',
        requesterUsername: getActiveUsername(),
        targetUsername: targetUsername
    });
};

window.adminMutePlayer = window.adminMutePlayer || function(targetUsername) {
    if (!targetUsername) return;
    sendSocket({
        type: 'ADMIN_MUTE_PLAYER',
        requesterUsername: getActiveUsername(),
        targetUsername: targetUsername
    });
    window.showCenterNotification(`🔇 Muted ${targetUsername}`);
};

window.getHostAdminButtonsHTML = function(lobby, targetPlayer) {
    if (!window.isCurrentUserLobbyHost(lobby) || !targetPlayer) return '';
    const myName = getActiveUsername().trim().toLowerCase();
    const targetName = (targetPlayer.username || '').trim();

    if (!targetName || targetName.toLowerCase() === myName) return '';

    const safeTarget = targetName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const isAlreadyMuted = Boolean(targetPlayer.isMuted);

    // Show Mute button on all human players (dimmed if already muted, bright if active)
    const muteBtn = !targetPlayer.isBot
        ? `<button type="button" onclick="event.stopPropagation(); window.adminMutePlayer('${safeTarget}')" title="${isAlreadyMuted ? targetName + ' is muted (click to force-mute)' : 'Mute ' + targetName}" style="pointer-events: auto; background: ${isAlreadyMuted ? 'rgba(148,163,184,0.2)' : 'rgba(245,158,11,0.3)'}; border: 1px solid ${isAlreadyMuted ? '#64748b' : '#f59e0b'}; color: ${isAlreadyMuted ? '#94a3b8' : '#fcd34d'}; border-radius: 4px; padding: 2px 5px; font-size: 0.65rem; line-height: 1; cursor: pointer;">🔇</button>`
        : '';

    const kickBtn = `<button type="button" onclick="event.stopPropagation(); window.adminKickPlayer('${safeTarget}')" title="Kick ${targetName}" style="pointer-events: auto; background: rgba(239,68,68,0.25); border: 1px solid #ef4444; color: #fca5a5; border-radius: 4px; padding: 2px 5px; font-size: 0.65rem; line-height: 1; cursor: pointer;">👢</button>`;

    return `<span class="host-admin-controls" style="display: inline-flex; gap: 4px; margin-left: 5px; vertical-align: middle; position: relative; z-index: 25; pointer-events: auto;">${muteBtn}${kickBtn}</span>`;
};

window.drawCard = function(source) {
    if (window.clientState.isSpectator) return;
    window.safePlaySound('card');
    window.safeVibrate(40);
    const isDiscard = source === 'discard';
    sendSocket({
        type: isDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK',
        source: isDiscard ? 'discard' : 'deck',
        action: isDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK'
    });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    if (window.clientState.isSpectator) return;
    const idx = parseInt(cardIndex, 10);
    if (isNaN(idx)) return;
    window.safePlaySound('card');
    window.safeVibrate(30);
    sendSocket({
        type: 'DISCARD_CARD',
        index: idx,
        cardIndex: idx
    });
};

window.choosePoolCard = function(cardIndex) {
    if (window.appGlobals.hasChosenPoolCard) return;
    const resolvedIndex = typeof cardIndex === 'number' ? cardIndex : parseInt(cardIndex, 10);
    if (isNaN(resolvedIndex)) return;

    window.appGlobals.hasChosenPoolCard = true;
    window.safePlaySound('card');
    window.safeVibrate(25);
    sendSocket({
        type: 'CHOOSE_POOL_CARD',
        index: resolvedIndex,
        cardIndex: resolvedIndex,
        poolIndex: resolvedIndex
    });
};

window.clickNextHand = function() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    sendSocket({ type: 'NEXT_HAND_READY' });
};

window.toggleReady = function() {
    const myName = getActiveUsername().toLowerCase();
    const snap = window.appGlobals?.latestLobbySnapshot;
    const me = snap?.players?.find(p => p.username?.toLowerCase() === myName);
    const current = me ? Boolean(me.ready) : Boolean(window.clientState?.isReady);
    const nextState = !current;

    window.clientState.isReady = nextState;
    const btn = document.getElementById('ready-btn');
    if (btn) btn.innerText = nextState ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    window.safePlaySound('card');
    sendSocket({ type: 'SET_READY', ready: nextState });
};

window.standUp = function() { sendSocket({ type: 'STAND_UP' }); };
window.sitDown = function() { sendSocket({ type: 'SIT_DOWN' }); };

window.updateWager = function() {
    const sel = document.getElementById('config-wager');
    if (sel) sendSocket({ type: 'UPDATE_WAGER', wager: parseInt(sel.value, 10) || 5 });
};

window.updateSettings = function() {
    const sel = document.getElementById('config-lives');
    if (sel) sendSocket({ type: 'UPDATE_SETTINGS', lives: parseInt(sel.value, 10) || 2 });
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

window.submitEndGameVote = function(agree) {
    sendSocket({ type: 'VOTE_END_GAME', agree: !!agree });
    const modal = document.getElementById('end-game-vote-modal');
    if (modal) modal.style.display = 'none';
};

function renderEndGameVoteModal(lobby) {
    let modal = document.getElementById('end-game-vote-modal');
    if (!lobby || !lobby.endGameVote) {
        if (modal) modal.style.display = 'none';
        return;
    }

    const activeUsername = getActiveUsername().toLowerCase();
    const vote = lobby.endGameVote;

    const isSeatedHuman = (lobby.players || []).some(
        p => p.username && p.username.toLowerCase() === activeUsername && !p.isBot
    );
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

window.stopPeekingAction = function() {
    sendSocket({ type: 'STOP_PEEK' });
    const banner = document.getElementById('active-peeking-banner');
    if (banner) banner.style.display = 'none';
    window.showCenterNotification("Stopped peeking.");
};

window.kickPeekerAction = function(spectatorUsername) {
    sendSocket({
        type: 'KICK_PEEKER',
        spectatorUsername: spectatorUsername,
        requester: spectatorUsername,
        target: spectatorUsername
    });
    window.showCenterNotification(`Removed ${spectatorUsername} from peeking your hand.`);
};

// -------------------------------------------------------------
// 6. KNOCK VALIDATION, AUDIO & VIBRATION
// -------------------------------------------------------------
function updateKnockAlertAndAudio(lobby) {
    const knockAlertModal = document.getElementById('knock-alert-modal');
    if (!knockAlertModal) return;

    if (lobby.knockedBy && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn')) {
        knockAlertModal.innerText = `🔔 ${lobby.knockedBy.toUpperCase()} HAS KNOCKED!`;
        knockAlertModal.style.display = 'block';

        if (window.appGlobals.lastKnownKnockedBy !== lobby.knockedBy) {
            window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
            const activeUsername = getActiveUsername();
            if (lobby.knockedBy.toLowerCase() !== activeUsername.toLowerCase()) {
                window.safePlaySound('knock');
                if (typeof speakKnockedCue === 'function') speakKnockedCue();
                window.safeVibrate([180, 110, 180, 110, 180]);
            }
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
    sendSocket({ type: 'KNOCK' });
};

// -------------------------------------------------------------
// 7. SIDE BETS, MINIMIZE CONTROLS & PEEKING DIALOGS
// -------------------------------------------------------------
window.ensureBetModalMinimizeControls = function() {
    // 1. Ensure #bet-modal has a minimize button in its header
    const betModal = document.getElementById('bet-modal');
    if (betModal && !document.getElementById('bet-modal-min-btn')) {
        const header = betModal.querySelector('.modal-header');
        if (header) {
            const closeBtn = header.querySelector('.close-btn');
            const minBtn = document.createElement('button');
            minBtn.type = 'button';
            minBtn.id = 'bet-modal-min-btn';
            minBtn.className = 'close-btn';
            minBtn.title = 'Minimize';
            minBtn.innerText = '—';
            minBtn.style.marginRight = '6px';
            minBtn.onclick = function(e) {
                e.stopPropagation();
                window.toggleMinimizeBetModal();
            };

            if (closeBtn && closeBtn.parentNode === header) {
                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = 'display: flex; gap: 6px; align-items: center;';
                header.insertBefore(btnGroup, closeBtn);
                btnGroup.appendChild(minBtn);
                btnGroup.appendChild(closeBtn);
            } else {
                header.appendChild(minBtn);
            }
        }
    }

    // 2. Ensure #global-side-bets-sidebar has a minimize button in its header
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar && !document.getElementById('global-sidebar-min-btn')) {
        let header = sidebar.querySelector('.drawer-header') || sidebar.querySelector('h4')?.parentElement;
        if (!header) {
            const h4 = sidebar.querySelector('h4');
            if (h4) {
                header = document.createElement('div');
                header.className = 'drawer-header';
                header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; width: 100%;';
                h4.parentNode.insertBefore(header, h4);
                header.appendChild(h4);
            }
        }
        if (header) {
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.alignItems = 'center';
            const minBtn = document.createElement('button');
            minBtn.type = 'button';
            minBtn.id = 'global-sidebar-min-btn';
            minBtn.className = 'close-btn';
            minBtn.title = 'Minimize';
            minBtn.innerText = '—';
            minBtn.style.cssText = 'font-size: 0.9rem; padding: 0 6px; cursor: pointer; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px;';
            minBtn.onclick = function(e) {
                e.stopPropagation();
                window.toggleMinimizeGlobalSidebar();
            };
            header.appendChild(minBtn);
        }
    }
};
document.addEventListener('DOMContentLoaded', window.ensureBetModalMinimizeControls);

window.toggleMinimizeBetModal = function(forceRestore) {
    window.ensureBetModalMinimizeControls();
    const modal = document.getElementById('bet-modal');
    const wrap = document.getElementById('bet-modal-content-wrap') || document.getElementById('bet-modal-body');
    const proposalsFeed = document.getElementById('global-proposals-container');
    const minBtn = document.getElementById('bet-modal-min-btn');
    if (!modal || !wrap) return;

    const isMinimized = forceRestore === true ? true : modal.classList.contains('minimized-bet-modal');

    if (isMinimized) {
        modal.classList.remove('minimized-bet-modal');
        modal.style.cssText = 'display: flex;';
        wrap.style.display = 'block';
        if (proposalsFeed) proposalsFeed.style.display = 'block';
        if (minBtn) minBtn.innerText = '—';
    } else {
        modal.classList.add('minimized-bet-modal');
        modal.style.cssText = 'display: flex; inset: auto 10px 10px auto !important; width: 260px !important; height: auto !important; background: transparent !important; backdrop-filter: none !important; padding: 0 !important; pointer-events: auto !important; z-index: 9999 !important;';
        wrap.style.display = 'none';
        if (proposalsFeed) proposalsFeed.style.display = 'none';
        if (minBtn) minBtn.innerText = '▲';
    }
};

window.toggleMinimizeGlobalSidebar = function(forceRestore) {
    window.ensureBetModalMinimizeControls();
    const sidebar = document.getElementById('global-side-bets-sidebar');
    const list = document.getElementById('global-side-bets-list');
    const minBtn = document.getElementById('global-sidebar-min-btn');
    if (!sidebar || !list) return;

    const isMinimized = forceRestore === true ? true : sidebar.dataset.minimized === 'true';

    if (isMinimized) {
        sidebar.dataset.minimized = 'false';
        sidebar.style.height = '';
        list.style.display = 'flex';
        if (minBtn) minBtn.innerText = '—';
    } else {
        sidebar.dataset.minimized = 'true';
        sidebar.style.height = 'auto';
        list.style.display = 'none';
        if (minBtn) minBtn.innerText = '▲';
    }
};

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
            actionsHtml += `<button class="secondary" onclick="toggleModal('seat-action-modal', false)" style="margin-top:6px;">Cancel</button>`;
            modalBody.innerHTML = actionsHtml;
        }
        window.toggleModal('seat-action-modal', true);
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
                <div style="display:flex; gap:6px; margin-top:6px;">
                    <button class="secondary" onclick="window.toggleMinimizeBetModal()" style="flex:1;">Minimize</button>
                    <button class="secondary" onclick="toggleModal('bet-modal', false)" style="flex:1;">Cancel</button>
                </div>
            `;
        }
        window.toggleModal('bet-modal', true);
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
                <div style="display:flex; gap:6px; margin-top:6px;">
                    <button class="secondary" onclick="window.toggleMinimizeBetModal()" style="flex:1;">Minimize</button>
                    <button class="secondary" onclick="toggleModal('bet-modal', false)" style="flex:1;">Cancel</button>
                </div>
            `;
        }
        window.toggleModal('bet-modal', true);
    }
};

window.requestPeekFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal', false);
    sendSocket({
        type: 'REQUEST_PEEK',
        targetUsername: targetUsername,
        target: targetUsername
    });
    window.showCenterNotification(`Peek request sent to ${targetUsername}!`);
};

window.betOnHimFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal', false);
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
            <button onclick="submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
            <button onclick="submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
            <div style="display:flex; gap:6px; margin-top:6px;">
                <button class="secondary" onclick="window.toggleMinimizeBetModal()" style="flex:1;">Minimize</button>
                <button class="secondary" onclick="toggleModal('bet-modal', false)" style="flex:1;">Cancel</button>
            </div>
        `;
    }
    window.toggleModal('bet-modal', true);
};

window.submitEliminationProposal = function(target, wagerAmt) {
    sendSocket({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    window.toggleModal('bet-modal', false);
    window.showCenterNotification(`First to lose bet proposed to ${target}!`);
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    sendSocket({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt });
    window.toggleModal('bet-modal', false);
    window.showCenterNotification(`Global bet offered on ${pickUser}!`);
};

window.acceptGlobalProposal = function(proposalId) {
    sendSocket({
        type: 'ACCEPT_GLOBAL_PROPOSAL',
        proposalId: proposalId,
        betId: proposalId,
        id: proposalId,
        accept: true,
        confirm: true
    });
    window.showCenterNotification('Waiting for proposer to confirm bet...');
};

window.respondGlobalBet = function(proposalId, accept) {
    if (accept) {
        window.acceptGlobalProposal(proposalId);
    } else {
        window.declineGlobalProposal(proposalId);
    }
};

window.declineGlobalProposal = function(proposalId) {
    if (!window.appGlobals.declinedProposals) {
        window.appGlobals.declinedProposals = [];
    }
    if (!window.appGlobals.declinedProposals.includes(proposalId)) {
        window.appGlobals.declinedProposals.push(proposalId);
    }

    sendSocket({
        type: 'DECLINE_GLOBAL_PROPOSAL',
        proposalId: proposalId,
        betId: proposalId,
        id: proposalId,
        accept: false,
        confirm: false
    });

    if (window.appGlobals && window.appGlobals.latestLobbySnapshot) {
        window.updateUIFromLobby(window.appGlobals.latestLobbySnapshot);
    }
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
    if (window.appGlobals && window.appGlobals.promptedConfirmations) {
        delete window.appGlobals.promptedConfirmations[`${proposalId}_${acceptedUser}`];
    }
    window.toggleMinimizeBetModal(true);
    window.toggleModal('bet-modal', false);
};

window.openConfirmModal = function(proposalId, proposer, pickUser, acceptedUsers, wagerAmt) {
    window.ensureBetModalMinimizeControls();
    const modal = document.getElementById('bet-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');

    window.toggleMinimizeBetModal(true); // Always un-minimize when a confirmation arrives

    if (modalTitle) modalTitle.innerText = `Confirm Global Side Bet (${pickUser})`;

    const listHtml = (acceptedUsers || []).map(acc => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:8px; border-radius:6px; margin-bottom:6px;">
            <span><b>${acc}</b> clicked "You got it!" ${wagerAmt ? `($${wagerAmt})` : ''}</span>
            <div style="display:flex; gap:6px;">
                <button style="font-size:0.75rem; padding:5px 10px; background:#10b981; color:#fff; font-weight:bold; border-radius:4px; border:none; cursor:pointer;" onclick="window.confirmGlobalBet('${proposalId}', '${acc}', true)">Confirm</button>
                <button class="danger" style="font-size:0.75rem; padding:5px 10px; background:#ef4444; color:#fff; font-weight:bold; border-radius:4px; border:none; cursor:pointer;" onclick="window.confirmGlobalBet('${proposalId}', '${acc}', false)">Deny</button>
            </div>
        </div>
    `).join('');

    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:#f8fafc; margin-bottom:8px; text-align:center;">
                Lock in your side bet on <b>${pickUser}</b>:
            </p>
            ${listHtml}
            <div style="display:flex; gap:6px; margin-top:8px;">
                <button class="secondary" onclick="window.toggleMinimizeBetModal()" style="flex:1;">Minimize</button>
                <button class="secondary" onclick="window.toggleModal('bet-modal', false)" style="flex:1;">Close</button>
            </div>
        `;
    }
    if (modal) modal.style.display = 'flex';
};

window.respondToBet = function(betId, accept) {
    sendSocket({ type: 'RESPOND_BET', betId, accept: !!accept });
    window.toggleMinimizeBetModal(true);
    window.toggleModal('bet-modal', false);
};

// -------------------------------------------------------------
// 8. MASTER TABLE RENDER, AUDIO CUES & CELEBRATIONS
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    window.appGlobals.latestLobbySnapshot = lobby;
    window.ensureBetModalMinimizeControls();

    const authScreen = document.getElementById('auth-screen');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const topRowBtns = document.getElementById('in-game-top-row-btns');
    const toolsRow = document.getElementById('in-game-tools-row');
    const endBtn = document.getElementById('end-game-btn');
    const leaveBtn = document.getElementById('leave-lobby-btn');

    if (authScreen) authScreen.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    if (topRowBtns) topRowBtns.style.display = 'inline-flex';
    if (toolsRow) toolsRow.style.display = 'flex';
    if (endBtn) endBtn.style.display = 'inline-block';
    if (leaveBtn) leaveBtn.style.display = 'inline-block';

    const roomTitle = document.getElementById('room-title-display');
    if (roomTitle) roomTitle.innerText = `${lobby.name} [${lobby.code}]`;

    if (lobby.chatHistory) {
        window.syncChatHistory(lobby.chatHistory);
    }

    const activeUsername = getActiveUsername();

    // 1. CELEBRATION TRIGGER: HIT 31
    if (lobby.hit31Player) {
        if (window.appGlobals.lastCelebrated31 !== lobby.hit31Player) {
            window.appGlobals.lastCelebrated31 = lobby.hit31Player;
            const canvas = document.getElementById('celebration-canvas');
            if (canvas) canvas.style.display = 'block';
            if (typeof window.trigger31Celebration === 'function') {
                window.trigger31Celebration(lobby.hit31Player);
            } else if (typeof window.triggerWinnerCelebration === 'function') {
                window.triggerWinnerCelebration(lobby.hit31Player, "HIT 31!");
            }
            window.safePlaySound('win');
            window.safeVibrate([100, 50, 100, 50, 200]);
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
            const canvas = document.getElementById('celebration-canvas');
            if (canvas) canvas.style.display = 'block';
            if (typeof window.triggerWinnerCelebration === 'function') {
                window.triggerWinnerCelebration(winnerName, "TOURNAMENT CHAMPION!");
            }
            window.safePlaySound('win');
            window.safeVibrate([150, 80, 150, 80, 300]);
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

    // 4. LIVES VOTING & END GAME VOTING MODALS
    const voteModal = document.getElementById('lives-vote-modal');
    if (voteModal) {
        if (lobby.livesVote && lobby.gameState === 'lobby') {
            const hasVoted = lobby.livesVote.votes && Object.keys(lobby.livesVote.votes).some(u => u.toLowerCase() === activeUsername.toLowerCase());
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

    renderEndGameVoteModal(lobby);

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
    const isSpecUser = (lobby.spectators || []).some(s => (s.username || '').trim().toLowerCase() === activeUsername.toLowerCase());
    const isEliminated = Boolean(me && me.eliminated);
    const isSpectatorOnly = !me || isEliminated || isSpecUser;
    window.clientState.isSpectator = isSpectatorOnly;

    // 8. SPECTATOR PEEK INDICATOR & PEEK REQUEST MODAL
    const peekingBanner = document.getElementById('active-peeking-banner');
    let activelyPeekingTarget = null;
    if (isSpectatorOnly && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd' && lobby.gameState !== 'lobby') {
        (lobby.players || []).forEach(pl => {
            if (pl.peekAllowed) {
                const isAllowed = Array.isArray(pl.peekAllowed)
                    ? pl.peekAllowed.some(k => String(k).toLowerCase() === activeUsername.toLowerCase())
                    : Object.keys(pl.peekAllowed).some(k => k.toLowerCase() === activeUsername.toLowerCase() && pl.peekAllowed[k]);
                if (isAllowed) {
                    activelyPeekingTarget = pl.username;
                }
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

    const peekModal = document.getElementById('peek-request-modal');
    if (me && !me.eliminated) {
        window.clientState.isReady = me.ready;
        const readyBtn = document.getElementById('ready-btn');
        if (readyBtn) readyBtn.innerText = me.ready ? 'Unready' : 'Ready Up';

        const incomingKeys = me.peekIncoming ? Object.keys(me.peekIncoming).filter(k => me.peekIncoming[k]) : [];
        if (incomingKeys.length > 0) {
            const requester = incomingKeys[0];
            const pMsg = document.getElementById('peek-modal-msg');
            const pAllow = document.getElementById('peek-allow-btn');
            const pDeny = document.getElementById('peek-deny-btn');

            if (pMsg) pMsg.innerText = `${requester} wants to peek at your hand.`;
            if (pAllow) {
                pAllow.onclick = () => {
                    sendSocket({
                        type: 'RESPOND_PEEK',
                        spectatorUsername: requester,
                        requester: requester,
                        allow: true,
                        accept: true
                    });
                    if (peekModal) peekModal.style.display = 'none';
                };
            }
            if (pDeny) {
                pDeny.onclick = () => {
                    sendSocket({
                        type: 'RESPOND_PEEK',
                        spectatorUsername: requester,
                        requester: requester,
                        allow: false,
                        accept: false
                    });
                    if (peekModal) peekModal.style.display = 'none';
                };
            }
            if (peekModal) peekModal.style.display = 'flex';
        } else if (peekModal) {
            peekModal.style.display = 'none';
        }
    } else if (peekModal) {
        peekModal.style.display = 'none';
    }

    // 9. DYNAMIC ACTION BAR & "SIT DOWN" IN WAITING ROOM
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

    // 10. TURN ACTION & AUDIO CUE TRIGGER
    const isMyTurnPlaying = !isSpectatorOnly && ((lobby.currentTurnUser || '').toLowerCase() === activeUsername.toLowerCase()) && 
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

    // 11. SIDE BET PROPOSALS & AUTO-POPUP CONFIRMATION FOR PROPOSER
    const sidebar = document.getElementById('global-side-bets-sidebar');
    const sidebarList = document.getElementById('global-side-bets-list');
    const globalProps = lobby.globalProposals || [];
    const declinedIds = (window.appGlobals && window.appGlobals.declinedProposals) || [];
    const activeNameClean = activeUsername.trim().toLowerCase();

    // Auto-popup confirmation modal when someone clicks "You got it" on MY proposal
    const myAcceptedProposal = globalProps.find(gp => {
        const propOwner = String(gp.proposer || gp.creator || '').trim().toLowerCase();
        const acceptedList = gp.acceptedBy || gp.acceptedUsers || (gp.acceptedUser ? [gp.acceptedUser] : []);
        return propOwner === activeNameClean && Array.isArray(acceptedList) && acceptedList.length > 0;
    });

    if (myAcceptedProposal && lobby.gameState !== 'lobby') {
        const acceptedList = myAcceptedProposal.acceptedBy || myAcceptedProposal.acceptedUsers || [myAcceptedProposal.acceptedUser];
        const confirmKey = `${myAcceptedProposal.id}_${acceptedList.join(',')}`;
        if (window.appGlobals.lastAutoConfirmKey !== confirmKey) {
            window.appGlobals.lastAutoConfirmKey = confirmKey;
            window.openConfirmModal(
                myAcceptedProposal.id,
                myAcceptedProposal.proposer || myAcceptedProposal.creator,
                myAcceptedProposal.pickUser,
                acceptedList,
                myAcceptedProposal.wagerAmt
            );
        }
    } else {
        window.appGlobals.lastAutoConfirmKey = null;
    }

    const visibleGlobalProps = globalProps.filter(gp => {
        const deniedByServer = (gp.deniedBy || []).some(u => u.toLowerCase() === activeNameClean);
        const deniedLocally = declinedIds.includes(gp.id);
        return !deniedByServer && !deniedLocally;
    });

    if (visibleGlobalProps.length > 0 && lobby.gameState !== 'lobby') {
        if (sidebar) sidebar.style.display = 'flex';
        let sidebarHtml = '';
        visibleGlobalProps.forEach(gp => {
            const proposerName = gp.proposer || gp.creator || 'Player';
            const isMyProp = (proposerName.toLowerCase() === activeNameClean);
            const acceptedList = gp.acceptedBy || gp.acceptedUsers || (gp.acceptedUser ? [gp.acceptedUser] : []);
            const alreadyAccepted = acceptedList.some(u => String(u).toLowerCase() === activeNameClean);

            let actionHtml = '';
            if (isMyProp) {
                if (acceptedList.length > 0) {
                    actionHtml = `<button style="font-size:0.65rem; padding:3px 6px; background:#38bdf8; color:#0f172a; margin-top:4px; font-weight:bold; border-radius:4px; border:none; cursor:pointer;" onclick="window.openConfirmModal('${gp.id}', '${proposerName}', '${gp.pickUser}', ${JSON.stringify(acceptedList).replace(/"/g, '&quot;')}, ${gp.wagerAmt || 5})">Review (${acceptedList.length})</button>`;
                } else {
                    actionHtml = `<span style="color:var(--text-muted); font-size:0.65rem;">Waiting for acceptances...</span>`;
                }
            } else {
                if (!alreadyAccepted) {
                    actionHtml = `
                        <div style="display:flex; flex-direction:column; gap:4px; align-items:stretch; margin-top:4px;">
                            <button style="font-size:0.7rem; padding:4px 8px; background:#10b981; color:#fff; font-weight:bold; border-radius:4px; border:none; cursor:pointer;" onclick="window.acceptGlobalProposal('${gp.id}')">You got it</button>
                            <button class="danger" style="font-size:0.7rem; padding:4px 8px; background:#ef4444; color:#fff; font-weight:bold; border-radius:4px; border:none; cursor:pointer;" onclick="window.declineGlobalProposal('${gp.id}')">Decline</button>
                        </div>
                    `;
                } else {
                    actionHtml = `<span style="color:#34d399; font-size:0.65rem;">Accepted ("You got it")</span>`;
                }
            }

            sidebarHtml += `
                <div class="global-bet-item">
                    <span>I like <b>${gp.pickUser}</b> for <b>$${gp.wagerAmt}</b> (${proposerName})</span>
                    ${actionHtml}
                </div>
            `;
        });
        if (sidebarList) sidebarList.innerHTML = sidebarHtml;
    } else if (sidebar) {
        sidebar.style.display = 'none';
    }

    const bModal = document.getElementById('bet-modal');
    const isModalOpen = bModal && bModal.style.display === 'flex';
    if (lobby.pendingBetsForMe && lobby.pendingBetsForMe.length > 0 && !isModalOpen) {
        lobby.pendingBetsForMe.forEach(bet => {
            const label = bet.type === 'win' ? `Side Bet: ${bet.proposer} bets $${bet.wagerAmt} that you win round.` : `First Out Bet: ${bet.proposer} bets $${bet.wagerAmt} that ${bet.pickUser} is eliminated before ${bet.targetSurvivor}.`;
            const mTitle = document.getElementById('bet-modal-title');
            const mBody = document.getElementById('bet-modal-body');

            window.toggleMinimizeBetModal(true);

            if (mTitle) mTitle.innerText = `Incoming Bet Proposal from ${bet.proposer}`;
            if (mBody) {
                mBody.innerHTML = `
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">${label}</p>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button onclick="respondToBet('${bet.id}', true)">Accept</button>
                        <button class="danger" onclick="respondToBet('${bet.id}', false)">Decline</button>
                        <button class="secondary" onclick="window.toggleMinimizeBetModal()">Minimize</button>
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

    // 13. NEXT HAND & SHOWDOWN OVERLAY
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
                    const s = normalizeSuit(c.suit);
                    const isRed = (s === '♥' || s === '♦');
                    return `
                        <div class="showdown-mini-card ${isRed ? 'card-red' : 'card-black'}">
                            <span class="card-val">${c.val}</span>
                            <span class="card-suit">${s}</span>
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
                nextBtn.style.display = 'inline-block';
                nextBtn.innerText = 'Returning to Ready Room...';
                nextBtn.disabled = true;
            }
        } else if (myPlayer && !isPermanentlyOut) {
            if (nextBtn) {
                nextBtn.style.display = 'inline-block';
                if (myPlayer.nextHandReady) {
                    nextBtn.innerText = 'Waiting for players (Auto in 8s)...';
                    nextBtn.disabled = true;
                } else {
                    nextBtn.innerText = 'Next Hand (Auto in 8s)';
                    nextBtn.disabled = false;
                }
            }
        } else if (nextBtn) {
            nextBtn.style.display = 'none';
        }
    } else {
        if (nextHandOverlay) nextHandOverlay.style.display = 'none';
        if (showdownContainer) showdownContainer.innerHTML = '';
    }

    // 14. DEALER DRAW & TIE BREAKER MODALS
    const dealerDrawModal = document.getElementById('dealer-draw-modal');
    const revealModal = document.getElementById('tie-breaker-reveal-modal');
    const turnBanner = document.getElementById('turn-banner');

    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        window.showCenterNotification(lobby.phaseMessage);
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
    }

    // --- A. DEALER DRAW MODAL ---
    if (lobby.gameState === 'dealerDraw') {
        if (dealerDrawModal) dealerDrawModal.style.display = 'flex';
        if (revealModal) revealModal.style.display = 'none';

        const pTitle = document.getElementById('dealer-draw-title');
        const pInstr = document.getElementById('dealer-draw-status');
        if (pTitle) pTitle.innerText = 'Picking for Dealer';
        if (pInstr) pInstr.innerText = lobby.phaseMessage || 'Lowest card deals (Ace highest). Tap any card!';

        const activeParts = (lobby.players || []).filter(p => !p.eliminated);

        let showcaseHtml = '<div class="draw-showcase-sidebar">';
        showcaseHtml += '<div style="font-size:0.65rem; font-weight:800; color:var(--accent-gold); margin-bottom:2px; text-transform:uppercase;">Players</div>';
        activeParts.forEach(p => {
            const card = lobby.drawResults?.[p.username];
            const isMe = (p.username.toLowerCase() === activeUsername.toLowerCase());
            showcaseHtml += `
                <div class="draw-showcase-item">
                    <span class="draw-picker-badge" style="${isMe ? 'border-color:#38bdf8; color:#38bdf8;' : ''}">${p.username}${p.isBot ? ' 🤖' : ''}</span>
                    ${card ? window.formatCardHtml(card, false) : '<div class="draw-card-waiting"><span>Waiting...</span></div>'}
                </div>
            `;
        });
        showcaseHtml += '</div>';

        let poolHtml = '';
        (lobby.drawPool || []).forEach((slot, idx) => {
            const slotIndex = (slot && slot.index !== undefined) ? slot.index : idx;
            if (slot && slot.chosenBy) {
                poolHtml += `<div class="pool-card-item taken" title="Chosen by ${slot.chosenBy}">✓</div>`;
            } else {
                const clickable = !isSpectatorOnly && !lobby.drawResults?.[activeUsername] && !window.appGlobals.hasChosenPoolCard;
                poolHtml += `<div class="pool-card-item" ${clickable ? `onclick="choosePoolCard(${slotIndex})"` : ''} style="${!clickable ? 'opacity:0.4; cursor:not-allowed;' : ''}">?</div>`;
            }
        });

        const poolGrid = document.getElementById('draw-pool-grid');
        const orderStrip = document.getElementById('draw-order-sequence');
        if (poolGrid) poolGrid.innerHTML = poolHtml;
        if (orderStrip) orderStrip.innerHTML = showcaseHtml;
        if (turnBanner) turnBanner.innerText = 'Dealer Draw Phase';
    } 
    // --- B. TIE BREAKER MODAL ---
    else if (lobby.gameState === 'tieBreaker') {
        if (dealerDrawModal) dealerDrawModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'flex';

        const isTied = (lobby.tiedParticipantsList || []).some(u => u.toLowerCase() === activeUsername.toLowerCase());
        const tMsg = document.getElementById('tie-breaker-stream-msg');
        if (tMsg) tMsg.innerText = isTied ? 'You are tied for lowest score! Pick your tie-breaker card:' : 'Watching tied players draw for elimination...';

        let streamHtml = '<div class="draw-showcase-sidebar">';
        streamHtml += '<div style="font-size:0.65rem; font-weight:800; color:var(--accent-gold); margin-bottom:2px; text-transform:uppercase;">Tied Players</div>';
        (lobby.tiedParticipantsList || []).forEach(uname => {
            const card = lobby.drawResults?.[uname];
            const isMe = (uname.toLowerCase() === activeUsername.toLowerCase());
            streamHtml += `
                <div class="draw-showcase-item">
                    <span class="draw-picker-badge" style="${isMe ? 'border-color:#38bdf8; color:#38bdf8;' : ''}">${uname}</span>
                    ${card ? window.formatCardHtml(card, false) : '<div class="draw-card-waiting"><span>Drawing...</span></div>'}
                </div>
            `;
        });
        streamHtml += '</div>';

        let tieDeckPool = (lobby.drawPool || []).filter(slot => !slot.chosenBy);
        const countRemaining = lobby.deckCount !== undefined ? lobby.deckCount : tieDeckPool.length;
        if (tieDeckPool.length > countRemaining) {
            tieDeckPool = tieDeckPool.slice(0, countRemaining);
        }

        let poolHtml = '';
        tieDeckPool.forEach((slot, idx) => {
            const slotIndex = (slot && slot.index !== undefined) ? slot.index : idx;
            const clickable = isTied && !lobby.drawResults?.[activeUsername] && !window.appGlobals.hasChosenPoolCard;
            poolHtml += `<div class="pool-card-item" ${clickable ? `onclick="choosePoolCard(${slotIndex})"` : ''} style="${!clickable ? 'opacity:0.4; cursor:not-allowed;' : ''}">?</div>`;
        });

        const tGrid = document.getElementById('tie-breaker-stream-grid');
        if (tGrid) {
            tGrid.className = 'draw-modal-split-layout';
            tGrid.innerHTML = `
                ${streamHtml}
                <div class="draw-pool-panel">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; padding:0 2px;">
                        <span style="font-size:0.72rem; color:var(--text-muted); font-weight:bold;">Cards Left in Deck (${countRemaining})</span>
                        <span style="font-size:0.65rem; color:var(--accent-gold);">${isTied ? 'Tap your card' : 'Watching'}</span>
                    </div>
                    <div class="pool-52-grid">${poolHtml}</div>
                </div>
            `;
        }
        if (turnBanner) turnBanner.innerText = 'Tie-Breaker Draw';
    } else {
        if (dealerDrawModal) dealerDrawModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'none';
        if (turnBanner) {
            if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
                turnBanner.innerText = isMyTurnPlaying ? "YOUR TURN!" : `Turn: ${lobby.currentTurnUser}`;
            } else if (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd') {
                turnBanner.innerText = lobby.phaseMessage || 'Round Over';
            } else {
                turnBanner.innerText = lobby.phaseMessage || 'Waiting...';
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
            const hasRevealedCards = p.cards && p.cards.length > 0 && p.cards.some(c => c && c.val && c.val !== '?');
            const revealedCardsHtml = hasRevealedCards ? `<div class="seat-cards">${p.cards.map(c => window.formatCardHtml(c, true)).join('')}</div>` : '';
            const statusBadge = p.eliminated ? ' [OUT]' : '';
            const readyStatusIcon = p.ready ? '✅' : '❌';
            const botBadge = p.isBot ? ' 🤖' : '';
            const isSeatHost = lobby.host && p.username && lobby.host.trim().toLowerCase() === p.username.trim().toLowerCase();
            const hostCrown = isSeatHost ? ' 👑' : '';
            const isCurrent = (p.username.toLowerCase() === (lobby.currentTurnUser || '').toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
            const isDealer = (idx === lobby.dealerIndex) || (lobby.dealerName === p.username);
            const dealerBadgeHtml = isDealer ? `<span class="dealer-badge">D</span>` : '';
            const micIcon = p.inVC ? (p.isMuted ? ' 🔇' : ' 🎙️') : '';
            const hostAdminBtns = window.getHostAdminButtonsHTML(lobby, p);

            let peekerBadgesHtml = '';
            if (p.username.toLowerCase() === activeUsername.toLowerCase() && p.peekAllowed) {
                const peekers = Array.isArray(p.peekAllowed)
                    ? p.peekAllowed
                    : Object.keys(p.peekAllowed).filter(k => p.peekAllowed[k]);
                if (peekers.length > 0) {
                    peekerBadgesHtml = `<div style="display:flex; gap:2px; flex-wrap:wrap; justify-content:center; margin-top:2px;">${peekers.map(pk => `<span style="background:#ef4444; color:#fff; padding:1px 3px; border-radius:3px; font-size:0.5rem; cursor:pointer;" onclick="event.stopPropagation(); kickPeekerAction('${pk}')" title="Click to kick">Kick ${pk} ✕</span>`).join('')}</div>`;
                }
            }

            html += `
                <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}" onclick="tapSeat('${p.username}')" style="cursor:pointer;">
                    <div class="seat-name-area">
                        <span>${readyStatusIcon}</span> <b>${p.username}${hostCrown}${botBadge}${statusBadge}</b>${dealerBadgeHtml}${micIcon}${hostAdminBtns}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                    </div>
                    ${revealedCardsHtml}
                    ${peekerBadgesHtml}
                </div>
            `;
        });

        tableContainer.innerHTML = html;
        if (nextHandOverlay) tableContainer.appendChild(nextHandOverlay);
    }

    // 16. LOCAL HAND RENDERING WITH AUTHENTIC PLAYING CARDS & SPECTATOR PEEK
    const handContainer = document.getElementById('my-cards-container');
    const scoreDisplay = document.getElementById('my-score-display');
    const myHandTitle = document.getElementById('my-hand-title');

    const peekedPlayer = activelyPeekingTarget
        ? (lobby.players || []).find(p => p.username.toLowerCase() === activelyPeekingTarget.toLowerCase())
        : null;
    const peekedCardsRevealed = peekedPlayer && peekedPlayer.cards && peekedPlayer.cards.length > 0 && peekedPlayer.cards.some(c => c && c.val && c.val !== '?');

    if (isSpectatorOnly) {
        if (peekedPlayer && peekedCardsRevealed && handContainer) {
            const peekScore = window.calculateLocalScore(peekedPlayer.cards);
            if (myHandTitle) {
                myHandTitle.innerHTML = `👀 ${peekedPlayer.username}'s Hand (Score: <strong style="font-size: 1rem; color: var(--accent-gold);" id="my-score-display">${peekScore}</strong>)`;
            }
            handContainer.innerHTML = peekedPlayer.cards.map((c) => {
                const val = c.val || '';
                const suit = normalizeSuit(c.suit);
                const isRed = (suit === '♥' || suit === '♦');
                const suitClass = isRed ? 'red-suit' : 'black-suit';

                return `
                    <div class="my-card playing-card ${suitClass}" style="cursor: default;">
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
            if (scoreDisplay) scoreDisplay.innerText = peekScore;
        } else {
            if (handContainer) handContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:12px;">👀 Spectator Mode — Tap any player seat to Peek Hand</div>';
            if (scoreDisplay) scoreDisplay.innerText = '-';
            if (myHandTitle) myHandTitle.innerHTML = 'Spectating Table';
        }
    } else if (me && me.cards && handContainer) {
        const myScore = window.calculateLocalScore(me.cards);
        if (myHandTitle) myHandTitle.innerHTML = `My Hand (Score: <strong style="font-size: 1rem; color: var(--accent-gold);" id="my-score-display">${myScore}</strong>)`;
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

        if (scoreDisplay) scoreDisplay.innerText = myScore;
    } else if (handContainer) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.innerText = '0';
    }

    // 17. SESSION LEDGER & SPECTATOR MODAL AUTO-SYNC
    window.syncActiveSessionBetsList(lobby);
    const sessionLedgerModal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (sessionLedgerModal && sessionLedgerModal.style.display === 'flex') {
        if (window.currentLedgerTab !== 'lifetime' && typeof window.renderSessionLedger === 'function') {
            window.renderSessionLedger(lobby);
        }
    }

    const specModal = document.getElementById('spectator-list-modal') || document.getElementById('spectators-modal');
    if (specModal && specModal.style.display === 'flex') {
        window.openSpectatorListModal();
    }
};

window.renderLobbyState = window.updateUIFromLobby;
