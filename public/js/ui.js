// public/js/ui.js - Complete DOM Coordinator, Table Render, Countdown Bars, Score Badges & Modals

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
    ledgerHistory: [],
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
    lastRenderedReactionId: null,
    lastTickSecond: null,
    lastChatCount: 0,
    notificationTimer: null
};

function escapeHtmlUI(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
    return (window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room') || '').toUpperCase();
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
// 2. SAFE AUDIO, HAPTICS & MOBILE AUTOPLAY UNLOCK
// -------------------------------------------------------------
window.safePlaySound = function(cueType) {
    const sfxToggle = document.getElementById('setting-sfx');
    if (sfxToggle && !sfxToggle.checked) return;
    if (localStorage.getItem('blitz31_sfx_enabled') === 'false') return;

    try {
        const normalized = (cueType === 'turn') ? 'yourturn' : cueType;
        const audioEl = document.getElementById(`sound-${normalized}`);
        if (audioEl) {
            try { audioEl.currentTime = 0; } catch (e) {}
            const playPromise = audioEl.play();
            if (playPromise !== undefined) {
                playPromise.catch(() => {});
            }
            return;
        }

        if (typeof window.playSound === 'function' && window.playSound !== window.safePlaySound) {
            window.playSound(normalized);
            return;
        }

        const fallbackAudio = new Audio(`/mp3s/${normalized}.mp3`);
        fallbackAudio.play().catch(() => {});
    } catch (e) {}
};

window.triggerAudioCue = window.safePlaySound;
window.playYourTurnCue = function() { window.safePlaySound('yourturn'); };

window.safeVibrate = function(pattern) {
    const vibToggle = document.getElementById('setting-vibrate');
    if (vibToggle && !vibToggle.checked) return;
    if (localStorage.getItem('blitz31_vibrate_enabled') === 'false') return;

    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(pattern); } catch (e) {}
    }
};
const triggerVibration = window.safeVibrate;

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
// 3. CARD FORMATTING, SCORE CALCULATION & SHOWDOWN BADGES
// -------------------------------------------------------------
function normalizeSuit(suit) {
    if (!suit) return '♠';
    const map = { S: '♠', H: '♥', D: '♦', C: '♣', '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣' };
    return map[String(suit).toUpperCase()] || suit;
}
window.normalizeSuit = normalizeSuit;

window.formatCardHtml = function(card, isMini = false) {
    if (!card || (!card.val && !card.suit)) {
        return `<div class="${isMini ? 'mini-card' : 'playing-card'} back">?</div>`;
    }
    const val = card.val || '';
    const suit = normalizeSuit(card.suit);
    const isRed = (suit === '♥' || suit === '♦');
    const suitClass = isRed ? 'red-suit' : 'black-suit';

    if (isMini) {
        return `<span class="mini-card ${suitClass}" style="display:inline-flex; align-items:center; justify-content:center; background:#fff; color:${isRed ? '#dc2626' : '#0f172a'}; border:1px solid #cbd5e1; border-radius:4px; padding:1px 4px; font-weight:800; font-size:0.75rem; margin:0 1px; box-shadow:0 1px 3px rgba(0,0,0,0.4);">${escapeHtmlUI(val)}${escapeHtmlUI(suit)}</span>`;
    }

    return `
        <div class="playing-card ${suitClass}">
            <div class="card-corner top-left">
                <span class="corner-val">${escapeHtmlUI(val)}</span>
                <span class="corner-suit">${escapeHtmlUI(suit)}</span>
            </div>
            <div class="card-center-pip">${escapeHtmlUI(suit)}</div>
            <div class="card-corner bottom-right">
                <span class="corner-val">${escapeHtmlUI(val)}</span>
                <span class="corner-suit">${escapeHtmlUI(suit)}</span>
            </div>
        </div>
    `;
};

window.calculateLocalScore = function(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return 0;

    const evalThree = (threeCards) => {
        const suitSums = {};
        const valCounts = {};
        threeCards.forEach(c => {
            if (!c) return;
            const s = normalizeSuit(c.suit);
            const pts = c.val === 'A' ? 11 : (['K', 'Q', 'J', '10'].includes(c.val) ? 10 : (Number(c.val) || 0));
            suitSums[s] = (suitSums[s] || 0) + pts;
            valCounts[c.val] = (valCounts[c.val] || 0) + 1;
        });

        for (const v in valCounts) {
            if (valCounts[v] >= 3) return 30.5;
        }
        return Math.max(0, ...Object.values(suitSums));
    };

    if (cards.length <= 3) return evalThree(cards);

    let best = 0;
    for (let i = 0; i < cards.length; i++) {
        const sub = cards.filter((_, idx) => idx !== i);
        best = Math.max(best, evalThree(sub));
    }
    return best;
};

function formatShowdownScoreBadge(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return '';
    const score = window.calculateLocalScore(cards);
    if (score <= 0) return '';

    let text = `${score} pts`;
    let bg = 'rgba(15, 23, 42, 0.92)';
    let border = '#fbbf24';
    let color = '#fbbf24';

    if (score === 31) {
        text = '⚡ 31!';
        bg = 'linear-gradient(135deg, #d97706, #b45309)';
        border = '#fde68a';
        color = '#ffffff';
    } else if (score === 30.5) {
        text = '🔥 30.5 (Trips)';
        bg = 'rgba(6, 78, 59, 0.95)';
        border = '#34d399';
        color = '#6ee7b7';
    }

    return `<div class="showdown-score-pill" style="display:inline-block; background:${bg}; color:${color}; border:1px solid ${border}; border-radius:999px; padding:1px 7px; font-size:0.65rem; font-weight:800; margin-top:2px; box-shadow:0 2px 5px rgba(0,0,0,0.5);">${text}</div>`;
}

// -------------------------------------------------------------
// 4. MODALS, NOTIFICATIONS, LOBBY LIST & CHAT DRAWER ENGINE
// -------------------------------------------------------------
window.toggleModal = function(modalId, forceState) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const isHidden = window.getComputedStyle(modal).display === 'none' || modal.classList.contains('hidden');
    const shouldShow = (typeof forceState === 'boolean') ? forceState : isHidden;
    if (shouldShow) {
        modal.classList.remove('hidden');
        modal.style.setProperty('display', 'flex', 'important');
    } else {
        modal.classList.add('hidden');
        modal.style.setProperty('display', 'none', 'important');
    }
};

window.toggleChatWindow = function(e) {
    if (e && typeof e.stopPropagation === 'function') {
        e.stopPropagation();
    }
    const chat = document.getElementById('chat-window') || document.getElementById('chat-drawer');
    if (!chat) return;

    const computedDisplay = window.getComputedStyle(chat).display;
    const isHidden = computedDisplay === 'none' || chat.classList.contains('hidden');

    if (isHidden) {
        chat.classList.remove('hidden', 'minimized');
        chat.style.setProperty('display', 'flex', 'important');
        chat.style.setProperty('z-index', '9998', 'important');

        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.remove('unread');
            chatBtn.innerText = '💬 Chat';
        }
        const box = document.getElementById('chat-messages') || document.getElementById('chat-box');
        if (box) box.scrollTop = box.scrollHeight;
        const inp = document.getElementById('chat-input') || document.getElementById('chat-text-input');
        if (inp) setTimeout(() => inp.focus(), 80);
    } else {
        chat.classList.add('hidden');
        chat.style.setProperty('display', 'none', 'important');
    }
};

window.closeChatWindow = function(e) {
    if (e && typeof e.stopPropagation === 'function') {
        e.stopPropagation();
    }
    const chat = document.getElementById('chat-window') || document.getElementById('chat-drawer');
    if (chat) {
        chat.classList.add('hidden');
        chat.style.setProperty('display', 'none', 'important');
    }
};

window.appendChatMessage = function(userOrData, msgText) {
    const chatBox = document.getElementById('chat-messages') || document.getElementById('chat-box');
    if (!chatBox) return;

    let sender = 'Player';
    let text = '';

    if (typeof userOrData === 'object' && userOrData !== null) {
        sender = userOrData.user || userOrData.username || userOrData.sender || 'Player';
        text = userOrData.text || userOrData.message || '';
    } else {
        sender = userOrData || 'Player';
        text = msgText || '';
    }

    if (!text) return;

    const div = document.createElement('div');
    div.className = 'chat-line';
    div.style.cssText = 'margin-bottom:4px; font-size:0.8rem;';
    div.innerHTML = `<strong style="color:#fbbf24;">${escapeHtmlUI(sender)}:</strong> <span style="color:#f8fafc;">${escapeHtmlUI(text)}</span>`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;

    const chatWin = document.getElementById('chat-window') || document.getElementById('chat-drawer');
    const isVisible = chatWin && window.getComputedStyle(chatWin).display !== 'none' && !chatWin.classList.contains('hidden');
    if (!isVisible) {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
};

window.syncChatHistory = function(chatHistory) {
    const chatBox = document.getElementById('chat-messages') || document.getElementById('chat-box');
    if (!chatBox || !Array.isArray(chatHistory)) return;

    const lastCount = window.appGlobals.lastChatCount || 0;
    chatBox.innerHTML = chatHistory.map(msg => {
        const sender = msg.user || msg.username || 'Player';
        const text = msg.text || msg.message || '';
        return `
            <div class="chat-line" style="margin-bottom:4px; font-size:0.8rem;">
                <strong style="color:#fbbf24;">${escapeHtmlUI(sender)}:</strong>
                <span style="color:#f8fafc;">${escapeHtmlUI(text)}</span>
            </div>
        `;
    }).join('');
    chatBox.scrollTop = chatBox.scrollHeight;

    const chatWin = document.getElementById('chat-window') || document.getElementById('chat-drawer');
    const isVisible = chatWin && window.getComputedStyle(chatWin).display !== 'none' && !chatWin.classList.contains('hidden');
    if (chatHistory.length > lastCount && !isVisible) {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
    window.appGlobals.lastChatCount = chatHistory.length;
};

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input') || document.getElementById('chat-text-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    sendSocket({
        type: 'CHAT_MESSAGE',
        message: text,
        text: text
    });
    input.value = '';
};

window.showCenterNotification = function(message, durationMs = 3200) {
    if (!message) return;
    let banner = document.getElementById('center-notification-banner') || document.getElementById('center-toast-notification');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'center-notification-banner';
        banner.style.cssText = `
            position: fixed;
            top: 64px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(2, 44, 34, 0.95);
            color: #fbbf24;
            border: 1.5px solid #d97706;
            border-radius: 999px;
            padding: 7px 16px;
            font-size: 0.84rem;
            font-weight: 700;
            z-index: 10050;
            box-shadow: 0 6px 20px rgba(0,0,0,0.65);
            pointer-events: none;
            text-align: center;
            max-width: 90vw;
        `;
        document.body.appendChild(banner);
    }

    banner.innerText = message;
    banner.style.display = 'block';
    banner.style.opacity = '1';

    if (window.appGlobals.notificationTimer) {
        clearTimeout(window.appGlobals.notificationTimer);
    }
    window.appGlobals.notificationTimer = setTimeout(() => {
        banner.style.display = 'none';
    }, durationMs);
};

window.renderLobbyList = window.renderPublicLobbies = function(lobbiesList) {
    const container = document.getElementById('lobby-list') ||
                      document.getElementById('lobbies-list') ||
                      document.getElementById('public-lobbies-list') ||
                      document.getElementById('lobbies-container');
    if (!container) return;

    if (!Array.isArray(lobbiesList) || lobbiesList.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:var(--text-muted, #94a3b8); padding:12px; font-size:0.85rem;">No public tables active. Create one above!</div>`;
        return;
    }

    container.innerHTML = lobbiesList.map(l => {
        const safeName = escapeHtmlUI(l.name || 'Table');
        const safeCode = escapeHtmlUI(l.code || '');
        const count = l.playerCount ?? l.count ?? 0;
        const stateText = l.gameState === 'lobby' ? 'Waiting' : 'In Game';
        return `
            <div class="lobby-item" style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.35); border:1px solid rgba(251,191,36,0.3); border-radius:8px; padding:8px 12px; margin-bottom:6px;">
                <div>
                    <div style="font-weight:700; color:#f8fafc; font-size:0.9rem;">${safeName} <span style="color:#fbbf24; font-size:0.78rem;">[${safeCode}]</span></div>
                    <div style="font-size:0.75rem; color:#94a3b8;">Players: ${count}/6 • ${stateText}</div>
                </div>
                <button type="button" onclick="joinLobbyCode('${safeCode}')" style="background:#10b981; color:#fff; border:none; border-radius:6px; padding:6px 12px; font-weight:700; cursor:pointer; font-size:0.8rem;">Join</button>
            </div>
        `;
    }).join('');
};

window.openSpectatorListModal = function() {
    const modal = document.getElementById('spectator-list-modal');
    const body = document.getElementById('spectator-list-body') || document.getElementById('spectators-list') || document.getElementById('spectator-list-content');
    const specs = window.clientState.spectatorsList || [];
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (body) {
        if (specs.length === 0) {
            body.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:10px;">No spectators currently watching.</div>`;
        } else {
            body.innerHTML = specs.map(s => {
                const sObj = (typeof s === 'object' && s !== null) ? s : { username: String(s) };
                const vcBadge = sObj.inVC ? (sObj.isMuted ? ' 🔇' : ' 🎙️') : '';
                const adminBtns = window.getHostAdminButtonsHTML(lobby, sObj);
                return `<div style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center;"><span><b>${escapeHtmlUI(sObj.username)}</b>${vcBadge}</span>${adminBtns}</div>`;
            }).join('');
        }
    }
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
};

window.closeSpectatorListModal = function() {
    const modal = document.getElementById('spectator-list-modal');
    if (modal) modal.style.display = 'none';
};

window.closeSettingsModal = function() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.style.display = 'none';
};

window.openActiveBetsModal = function() {
    const modal = document.getElementById('active-bets-modal') || document.getElementById('bet-modal');
    const list = document.getElementById('active-bets-list');
    const bets = window.clientState.activeBetsList || [];
    if (list) {
        if (bets.length === 0) {
            list.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:10px;">No active side bets locked in right now.</div>`;
        } else {
            list.innerHTML = bets.map(b => `
                <div style="background:rgba(0,0,0,0.35); padding:8px; border-radius:6px; margin-bottom:6px; font-size:0.82rem;">
                    <b>${escapeHtmlUI(b.proposer)}</b> vs <b>${escapeHtmlUI(b.target)}</b> — <span style="color:#fbbf24; font-weight:700;">$${b.wagerAmt}</span>
                </div>
            `).join('');
        }
    }
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
};

// -------------------------------------------------------------
// 5. LIVE COUNTDOWN BARS, EMOJI POPOVER & TABLE SOUNDBOARD
// -------------------------------------------------------------
function updateLiveCountdownBars() {
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (!lobby) return;

    const now = Date.now();
    document.querySelectorAll('.seat-countdown-fill').forEach(bar => {
        const deadline = Number(bar.getAttribute('data-deadline')) || 0;
        const duration = Number(bar.getAttribute('data-duration')) || 25000;
        if (!deadline || deadline <= now) {
            bar.style.width = '0%';
            return;
        }
        const rem = Math.max(0, deadline - now);
        const pct = Math.min(100, Math.max(0, (rem / duration) * 100));
        bar.style.width = `${pct.toFixed(1)}%`;
        bar.style.background = rem <= 6000 ? '#ef4444' : (rem <= 12000 ? '#f59e0b' : '#10b981');
    });

    if ((lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') && lobby.turnDeadline) {
        const myName = getActiveUsername().toLowerCase();
        const turnName = (lobby.currentTurnUser || '').toLowerCase();
        if (myName && myName === turnName) {
            const secsLeft = Math.ceil((lobby.turnDeadline - now) / 1000);
            if (secsLeft >= 1 && secsLeft <= 5 && window.appGlobals.lastTickSecond !== secsLeft) {
                window.appGlobals.lastTickSecond = secsLeft;
                window.safeVibrate(35);
            }
        }
    }
}

if (!window.appGlobals.countdownInterval) {
    window.appGlobals.countdownInterval = setInterval(updateLiveCountdownBars, 200);
}

// Catalog of Soundboard items (sent as "sb:<id>" via SEND_REACTION)
const SOUNDBOARD_ITEMS = {
    horn:     { emoji: '📢', label: 'Horn' },
    cash:     { emoji: '💰', label: 'Cash' },
    rimshot:  { emoji: '🥁', label: 'Ba-Dum' },
    sad:      { emoji: '🎺', label: 'Sad' },
    crickets: { emoji: '🦗', label: 'Crickets' },
    siren:    { emoji: '🚨', label: 'Hype' }
};

// Web Audio API Soundboard Synthesizer (Respects Settings SFX Toggle & Volume Slider)
window.playSoundboardEffect = function(soundId) {
    const sfxToggle = document.getElementById('setting-sfx');
    if (sfxToggle && !sfxToggle.checked) return;
    if (localStorage.getItem('blitz31_sfx_enabled') === 'false') return;

    const vol = (typeof window.getSfxVolume === 'function') ? window.getSfxVolume() : 1.0;
    if (vol <= 0) return;

    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!window.audioCtx) window.audioCtx = new AudioCtx();
        const ctx = window.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();

        const now = ctx.currentTime;

        if (soundId === 'horn') {
            // Stadium Airhorn (detuned sawtooth chord)
            [349.23, 354.0, 440.0, 523.25].forEach(freq => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(freq, now);
                gain.gain.setValueAtTime(0.18 * vol, now);
                gain.gain.setValueAtTime(0.18 * vol, now + 0.45);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now);
                osc.stop(now + 0.65);
            });
        } else if (soundId === 'cash') {
            // Ka-Ching! Cash Register Bell
            const notes = [
                { f: 1046.50, t: 0,    d: 0.09 },
                { f: 1318.51, t: 0.08, d: 0.45 },
                { f: 2637.02, t: 0.08, d: 0.50 }
            ];
            notes.forEach(n => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(n.f, now + n.t);
                gain.gain.setValueAtTime(0.32 * vol, now + n.t);
                gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + n.t);
                osc.stop(now + n.t + n.d);
            });
        } else if (soundId === 'rimshot') {
            // Ba-Dum-Tss!
            const hits = [
                { fStart: 160, fEnd: 80,  t: 0,    d: 0.11 },
                { fStart: 120, fEnd: 55,  t: 0.14, d: 0.13 }
            ];
            hits.forEach(h => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(h.fStart, now + h.t);
                osc.frequency.exponentialRampToValueAtTime(h.fEnd, now + h.t + h.d);
                gain.gain.setValueAtTime(0.5 * vol, now + h.t);
                gain.gain.exponentialRampToValueAtTime(0.001, now + h.t + h.d);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + h.t);
                osc.stop(now + h.t + h.d);
            });
            // Cymbal "Tss" noise burst
            const bufferSize = ctx.sampleRate * 0.35;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
            const noise = ctx.createBufferSource();
            noise.buffer = buffer;
            const filter = ctx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.setValueAtTime(5000, now + 0.30);
            const nGain = ctx.createGain();
            nGain.gain.setValueAtTime(0.28 * vol, now + 0.30);
            nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
            noise.connect(filter);
            filter.connect(nGain);
            nGain.connect(ctx.destination);
            noise.start(now + 0.30);
            noise.stop(now + 0.65);
        } else if (soundId === 'sad') {
            // Wah-Wah-Wah-Waaaah (Sad Trombone)
            const notes = [
                { f: 293.66, t: 0.00, d: 0.28 },
                { f: 277.18, t: 0.30, d: 0.28 },
                { f: 261.63, t: 0.60, d: 0.28 },
                { f: 246.94, t: 0.90, d: 0.65, slide: 215.0 }
            ];
            notes.forEach(n => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(n.f, now + n.t);
                if (n.slide) {
                    osc.frequency.linearRampToValueAtTime(n.slide, now + n.t + n.d);
                }
                gain.gain.setValueAtTime(0.22 * vol, now + n.t);
                gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + n.t);
                osc.stop(now + n.t + n.d);
            });
        } else if (soundId === 'crickets') {
            // Awkward Crickets Chirp
            [0, 0.06, 0.12, 0.38, 0.44, 0.50].forEach(offset => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(4200, now + offset);
                gain.gain.setValueAtTime(0.18 * vol, now + offset);
                gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.045);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + offset);
                osc.stop(now + offset + 0.045);
            });
        } else if (soundId === 'siren') {
            // Rising/Falling Casino Hype Siren
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.linearRampToValueAtTime(880, now + 0.28);
            osc.frequency.linearRampToValueAtTime(440, now + 0.56);
            osc.frequency.linearRampToValueAtTime(880, now + 0.80);
            gain.gain.setValueAtTime(0.28 * vol, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.85);
        }
    } catch (e) {
        console.warn('[Soundboard] Playback error:', e);
    }
};

window.sendSoundboard = function(soundId) {
    if (!SOUNDBOARD_ITEMS[soundId]) return;
    if (typeof window.sendReaction === 'function') {
        window.sendReaction(`sb:${soundId}`);
    } else {
        sendSocket({ type: 'SEND_REACTION', emoji: `sb:${soundId}` });
    }
};

// Mounts both the "😀" Emoji Toggle and "📢" Soundboard Toggle inside #in-game-tools-row
function ensureQuickReactionBar() {
    const oldFloating = document.getElementById('quick-reaction-bar');
    if (oldFloating) oldFloating.remove();

    const toolsRow = document.getElementById('in-game-tools-row');
    if (!toolsRow) return;

    // Ensure Chat button always triggers window.toggleChatWindow directly
    const chatToggleBtn = document.getElementById('chat-toggle-btn');
    if (chatToggleBtn && !chatToggleBtn.dataset.chatBound) {
        chatToggleBtn.dataset.chatBound = 'true';
        chatToggleBtn.onclick = (e) => window.toggleChatWindow(e);
    }

    // 1. Emoji Reaction Toggle Button (😀)
    if (!document.getElementById('reaction-toggle-btn')) {
        const btn = document.createElement('button');
        btn.id = 'reaction-toggle-btn';
        btn.className = 'tool-btn';
        btn.type = 'button';
        btn.innerHTML = '😀';
        btn.title = 'Quick Reactions';
        btn.onclick = (e) => {
            e.stopPropagation();
            const pop = document.getElementById('reaction-popover-menu');
            const sbPop = document.getElementById('soundboard-popover-menu');
            if (sbPop) sbPop.style.display = 'none';
            if (!pop) return;
            pop.style.display = (pop.style.display === 'flex') ? 'none' : 'flex';
        };
        toolsRow.appendChild(btn);
    }

    // 2. Soundboard Toggle Button (📢)
    if (!document.getElementById('soundboard-toggle-btn')) {
        const sbBtn = document.createElement('button');
        sbBtn.id = 'soundboard-toggle-btn';
        sbBtn.className = 'tool-btn';
        sbBtn.type = 'button';
        sbBtn.innerHTML = '📢';
        sbBtn.title = 'Table Soundboard';
        sbBtn.onclick = (e) => {
            e.stopPropagation();
            const sbPop = document.getElementById('soundboard-popover-menu');
            const emoPop = document.getElementById('reaction-popover-menu');
            if (emoPop) emoPop.style.display = 'none';
            if (!sbPop) return;
            sbPop.style.display = (sbPop.style.display === 'flex') ? 'none' : 'flex';
        };
        toolsRow.appendChild(sbBtn);
    }

    // 3. Emoji Popover Menu
    if (!document.getElementById('reaction-popover-menu')) {
        const pop = document.createElement('div');
        pop.id = 'reaction-popover-menu';
        pop.style.cssText = `
            display: none;
            position: fixed;
            top: 76px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(4, 28, 18, 0.96);
            border: 1.5px solid #fbbf24;
            border-radius: 999px;
            padding: 4px 10px;
            gap: 6px;
            z-index: 9500;
            box-shadow: 0 6px 18px rgba(0,0,0,0.75);
        `;
        const emojis = ['🔥', '💀', '👏', '💸', '👀', '😂'];
        pop.innerHTML = emojis.map(em => `
            <button type="button" onclick="sendReaction('${em}'); document.getElementById('reaction-popover-menu').style.display='none';" style="background:transparent; border:none; font-size:1.25rem; padding:3px 5px; cursor:pointer; line-height:1;">${em}</button>
        `).join('');
        document.body.appendChild(pop);

        document.addEventListener('click', (ev) => {
            if (pop.style.display === 'flex' && !pop.contains(ev.target) && ev.target.id !== 'reaction-toggle-btn') {
                pop.style.display = 'none';
            }
        });
    }

    // 4. Soundboard Popover Menu
    if (!document.getElementById('soundboard-popover-menu')) {
        const sbPop = document.createElement('div');
        sbPop.id = 'soundboard-popover-menu';
        sbPop.style.cssText = `
            display: none;
            position: fixed;
            top: 76px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(4, 28, 18, 0.97);
            border: 1.5px solid #fbbf24;
            border-radius: 14px;
            padding: 6px 10px;
            gap: 6px;
            flex-wrap: wrap;
            justify-content: center;
            max-width: 92vw;
            z-index: 9500;
            box-shadow: 0 6px 18px rgba(0,0,0,0.8);
        `;
        sbPop.innerHTML = Object.entries(SOUNDBOARD_ITEMS).map(([key, item]) => `
            <button type="button" onclick="sendSoundboard('${key}'); document.getElementById('soundboard-popover-menu').style.display='none';" style="background:rgba(251,191,36,0.12); border:1px solid rgba(251,191,36,0.45); border-radius:8px; color:#f8fafc; font-size:0.74rem; font-weight:700; padding:5px 8px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                <span style="font-size:1rem;">${item.emoji}</span>
                <span>${item.label}</span>
            </button>
        `).join('');
        document.body.appendChild(sbPop);

        document.addEventListener('click', (ev) => {
            if (sbPop.style.display === 'flex' && !sbPop.contains(ev.target) && ev.target.id !== 'soundboard-toggle-btn') {
                sbPop.style.display = 'none';
            }
        });
    }
}

function triggerReactionAnimationIfNew(lobby) {
    const rx = lobby?.lastReaction;
    if (!rx || !rx.id || rx.id === window.appGlobals.lastRenderedReactionId) return;
    if (Date.now() - (rx.timestamp || 0) > 8000) return;

    window.appGlobals.lastRenderedReactionId = rx.id;

    let displayContent = rx.emoji || '';
    if (typeof displayContent === 'string' && displayContent.startsWith('sb:')) {
        const soundKey = displayContent.slice(3);
        const item = SOUNDBOARD_ITEMS[soundKey];
        if (item) {
            window.playSoundboardEffect(soundKey);
            displayContent = `${item.emoji} ${item.label}!`;
        }
    }

    let targetSeat = null;
    document.querySelectorAll('[data-player-username]').forEach(el => {
        if ((el.getAttribute('data-player-username') || '').toLowerCase() === (rx.username || '').toLowerCase()) {
            targetSeat = el;
        }
    });

    const floater = document.createElement('div');
    floater.textContent = displayContent;
    floater.style.cssText = `
        position: fixed;
        font-size: ${ String(rx.emoji).startsWith('sb:') ? '1.05rem' : '2rem' };
        font-weight: 900;
        color: #fbbf24;
        background: ${ String(rx.emoji).startsWith('sb:') ? 'rgba(4, 28, 18, 0.92)' : 'transparent' };
        border: ${ String(rx.emoji).startsWith('sb:') ? '1.5px solid #fbbf24' : 'none' };
        border-radius: 999px;
        padding: ${ String(rx.emoji).startsWith('sb:') ? '3px 10px' : '0' };
        white-space: nowrap;
        z-index: 10025;
        pointer-events: none;
        transition: transform 1.35s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 1.35s ease;
        transform: translate(-50%, 0) scale(0.9);
        opacity: 1;
        filter: drop-shadow(0 4px 8px rgba(0,0,0,0.65));
    `;

    if (targetSeat) {
        const rect = targetSeat.getBoundingClientRect();
        floater.style.left = `${rect.left + rect.width / 2}px`;
        floater.style.top = `${rect.top + 8}px`;
    } else {
        floater.style.left = '50%';
        floater.style.top = '50%';
    }

    document.body.appendChild(floater);
    requestAnimationFrame(() => {
        floater.style.transform = 'translate(-50%, -60px) scale(1.2)';
        floater.style.opacity = '0';
    });
    setTimeout(() => {
        if (floater.parentNode) floater.parentNode.removeChild(floater);
    }, 1400);
}


// -------------------------------------------------------------
// 6. IN-GAME ACTIONS, AUDIO & CARD INTERACTIONS
// -------------------------------------------------------------
window.drawCard = function(source) {
    if (window.clientState.isSpectator) return;
    window.safePlaySound('card');
    triggerVibration(40);
    sendSocket({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    if (window.clientState.isSpectator) return;
    window.safePlaySound('card');
    triggerVibration(30);
    sendSocket({
        type: 'DISCARD_CARD',
        index: cardIndex,
        cardIndex: cardIndex
    });
};

window.choosePoolCard = function(cardIndex) {
    const resolvedIndex = (typeof cardIndex === 'number') ? cardIndex : parseInt(cardIndex, 10);
    if (isNaN(resolvedIndex)) return;
    if (window.appGlobals.hasChosenPoolCard) return;

    window.appGlobals.hasChosenPoolCard = true;
    window.safePlaySound('card');
    triggerVibration(25);

    sendSocket({
        type: 'CHOOSE_POOL_CARD',
        index: resolvedIndex,
        cardIndex: resolvedIndex
    });
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
    window.safePlaySound('card');
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
// 7. KNOCK VALIDATION, AUDIO & VIBRATION
// -------------------------------------------------------------
function updateKnockAlertAndAudio(lobby) {
    const knockAlertModal = document.getElementById('knock-alert-modal');
    if (!knockAlertModal) return;

    if (lobby.knockedBy && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn')) {
        knockAlertModal.innerText = `🔔 ${lobby.knockedBy.toUpperCase()} HAS KNOCKED!`;
        knockAlertModal.style.display = 'block';

        if (window.appGlobals.lastKnownKnockedBy !== lobby.knockedBy) {
            window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
            window.safePlaySound('knock');
            if (typeof speakKnockedCue === 'function') speakKnockedCue();
            triggerVibration([180, 110, 180, 110, 180]);
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
    triggerVibration([180, 110, 180, 110, 180]);
    sendSocket({ type: 'KNOCK' });
};

// -------------------------------------------------------------
// 8. SIDE BETS (SELF BETTING, CUSTOM WAGER INPUT), PEEKING & HOST ADMIN
// -------------------------------------------------------------
window.isCurrentUserLobbyHost = function(lobby) {
    const snap = lobby || window.appGlobals?.latestLobbySnapshot;
    if (!snap || !snap.host) return false;
    const myName = getActiveUsername().trim().toLowerCase();
    return Boolean(myName && snap.host.trim().toLowerCase() === myName);
};

window.adminKickPlayer = function(targetUsername) {
    if (!targetUsername) return;
    if (!confirm(`Kick ${targetUsername} from the room?`)) return;
    sendSocket({
        type: 'ADMIN_KICK_PLAYER',
        requesterUsername: getActiveUsername(),
        targetUsername: targetUsername
    });
    window.toggleModal('seat-action-modal', false);
    window.toggleModal('bet-modal', false);
};

window.adminMutePlayer = function(targetUsername) {
    if (!targetUsername) return;
    sendSocket({
        type: 'ADMIN_MUTE_PLAYER',
        requesterUsername: getActiveUsername(),
        targetUsername: targetUsername
    });
    window.showCenterNotification(`🔇 Muted ${targetUsername}`);
    window.toggleModal('seat-action-modal', false);
    window.toggleModal('bet-modal', false);
};

window.getHostAdminButtonsHTML = function(lobby, targetPlayer) {
    if (!window.isCurrentUserLobbyHost(lobby) || !targetPlayer) return '';
    const myName = getActiveUsername().trim().toLowerCase();
    const targetName = (targetPlayer.username || '').trim();
    if (!targetName || targetName.toLowerCase() === myName) return '';
    const attrTarget = targetName.replace(/'/g, "\\'");
    return `
        <span style="display:inline-flex; gap:4px; margin-left:6px;">
            <button type="button" style="font-size:0.65rem; padding:2px 6px; background:#475569;" onclick="adminMutePlayer('${attrTarget}')">🔇</button>
            <button type="button" class="danger" style="font-size:0.65rem; padding:2px 6px;" onclick="adminKickPlayer('${attrTarget}')">👢</button>
        </span>
    `;
};

window.tapSeat = function(targetUsername) {
    const activeUsername = getActiveUsername();
    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    if (!targetUsername) return;

    const isSelf = targetUsername.trim().toLowerCase() === activeUsername.trim().toLowerCase();
    const attrTarget = targetUsername.replace(/'/g, "\\'");

    // Tapping your own seat opens the "Bet on Yourself to Win" modal
    if (isSelf) {
        if (window.clientState.gameState === 'lobby') {
            window.showCenterNotification('Start the game first to place a side bet on yourself!');
            return;
        }
        if (window.clientState.isSpectator) return;

        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount to bet on yourself winning this hand:</p>
                <div style="display:flex; gap:6px; margin-bottom:8px;">
                    <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 5)">$5</button>
                    <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 10)">$10</button>
                    <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 20)">$20</button>
                </div>
                <div style="display:flex; gap:6px; margin-bottom:6px;">
                    <input type="number" id="custom-bet-wager-input" min="1" step="1" placeholder="Custom $" style="flex:1; padding:7px; border-radius:6px; border:1px solid #d97706; background:rgba(0,0,0,0.4); color:#fff;" />
                    <button style="background:#d97706;" onclick="const v=parseInt(document.getElementById('custom-bet-wager-input')?.value,10); if(v>0) submitGlobalProposal('${attrTarget}', v);">Bet Custom</button>
                </div>
                <button class="secondary" onclick="toggleModal('bet-modal', false)" style="margin-top:4px;">Cancel</button>
            `;
        }
        window.toggleModal('bet-modal', true);
        return;
    }

    const isHost = Boolean(lobby.host && lobby.host.toLowerCase() === activeUsername.toLowerCase());

    const hostAdminHtml = isHost ? `
        <div style="display:flex; gap:6px; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.15);">
            <button type="button" style="flex:1; background:#475569; font-size:0.75rem; padding:6px;" onclick="adminMutePlayer('${attrTarget}')">🔇 Mute</button>
            <button type="button" class="danger" style="flex:1; font-size:0.75rem; padding:6px;" onclick="adminKickPlayer('${attrTarget}')">👢 Kick</button>
        </div>
    ` : '';

    if (window.clientState.gameState === 'lobby') {
        if (!isHost) return;
        const modalTitle = document.getElementById('seat-action-title');
        const modalBody = document.getElementById('seat-action-body');
        if (modalTitle) modalTitle.innerText = `Host Controls: ${targetUsername}`;
        if (modalBody) {
            modalBody.innerHTML = `
                ${hostAdminHtml}
                <button class="secondary" onclick="toggleModal('seat-action-modal', false)" style="margin-top:8px;">Close</button>
            `;
        }
        window.toggleModal('seat-action-modal', true);
        return;
    }

    const isSpecOnly = window.clientState.isSpectator;
    const activeCount = window.clientState.activeParticipantsCount;

    if (isSpecOnly) {
        const modalTitle = document.getElementById('seat-action-title');
        const modalBody = document.getElementById('seat-action-body');
        if (modalTitle) modalTitle.innerText = `Actions for ${targetUsername}`;
        if (modalBody) {
            let actionsHtml = `<button style="background:#2563eb; padding:8px; font-size:0.85rem;" onclick="requestPeekFromModal('${attrTarget}')">🔍 Peek Hand</button>`;
            actionsHtml += `<button style="background:#d97706; padding:8px; font-size:0.85rem; margin-top:6px;" onclick="betOnHimFromModal('${attrTarget}')">🤝 Bet on ${escapeHtmlUI(targetUsername)} to Win</button>`;
            actionsHtml += hostAdminHtml;
            actionsHtml += `<button class="secondary" onclick="toggleModal('seat-action-modal', false)" style="margin-top:6px;">Cancel</button>`;
            modalBody.innerHTML = actionsHtml;
        }
        window.toggleModal('seat-action-modal', true);
        return;
    }

    if (activeCount >= 3) {
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (modalTitle) modalTitle.innerText = `Side Bets on ${targetUsername}`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:6px;"><b>First to Lose:</b> Bet ${escapeHtmlUI(targetUsername)} is eliminated before you:</p>
                <div style="display:flex; gap:6px; margin-bottom:8px;">
                    <button style="flex:1;" onclick="submitEliminationProposal('${attrTarget}', 5)">$5</button>
                    <button style="flex:1;" onclick="submitEliminationProposal('${attrTarget}', 10)">$10</button>
                    <button style="flex:1;" onclick="submitEliminationProposal('${attrTarget}', 20)">$20</button>
                </div>
                <div style="display:flex; gap:6px; margin-bottom:10px;">
                    <input type="number" id="custom-bet-wager-input" min="1" step="1" placeholder="Custom $" style="flex:1; padding:7px; border-radius:6px; border:1px solid #d97706; background:rgba(0,0,0,0.4); color:#fff;" />
                    <button style="background:#d97706;" onclick="const v=parseInt(document.getElementById('custom-bet-wager-input')?.value,10); if(v>0) submitEliminationProposal('${attrTarget}', v);">Bet Custom</button>
                </div>
                <div style="border-top:1px solid rgba(255,255,255,0.12); padding-top:8px; margin-bottom:6px;">
                    <p style="font-size:0.8rem; color:#93c5fd; margin:0 0 6px;"><b>Or Table Bet:</b> I like ${escapeHtmlUI(targetUsername)} to win this hand:</p>
                    <div style="display:flex; gap:6px;">
                        <button style="flex:1; background:#2563eb;" onclick="submitGlobalProposal('${attrTarget}', 5)">$5</button>
                        <button style="flex:1; background:#2563eb;" onclick="submitGlobalProposal('${attrTarget}', 10)">$10</button>
                        <button style="flex:1; background:#2563eb;" onclick="submitGlobalProposal('${attrTarget}', 20)">$20</button>
                    </div>
                </div>
                ${hostAdminHtml}
                <button class="secondary" onclick="toggleModal('bet-modal', false)" style="margin-top:4px;">Cancel</button>
            `;
        }
        window.toggleModal('bet-modal', true);
    } else {
        const modalTitle = document.getElementById('bet-modal-title');
        const modalBody = document.getElementById('bet-modal-body');
        if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
                <div style="display:flex; gap:6px; margin-bottom:8px;">
                    <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 5)">$5</button>
                    <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 10)">$10</button>
                    <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 20)">$20</button>
                </div>
                <div style="display:flex; gap:6px; margin-bottom:6px;">
                    <input type="number" id="custom-bet-wager-input" min="1" step="1" placeholder="Custom $" style="flex:1; padding:7px; border-radius:6px; border:1px solid #d97706; background:rgba(0,0,0,0.4); color:#fff;" />
                    <button style="background:#d97706;" onclick="const v=parseInt(document.getElementById('custom-bet-wager-input')?.value,10); if(v>0) submitGlobalProposal('${attrTarget}', v);">Bet Custom</button>
                </div>
                ${hostAdminHtml}
                <button class="secondary" onclick="toggleModal('bet-modal', false)" style="margin-top:4px;">Cancel</button>
            `;
        }
        window.toggleModal('bet-modal', true);
    }
};

window.handleSeatClick = function(seatIndex) {
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (!lobby || !Array.isArray(lobby.players)) return;
    const player = lobby.players.find((p, idx) => (p.seat !== undefined ? p.seat : idx) === seatIndex);
    if (player && player.username) {
        window.tapSeat(player.username);
    }
};

window.requestPeekFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal', false);
    sendSocket({ type: 'REQUEST_PEEK', targetUsername });
    window.showCenterNotification(`Peek request sent to ${targetUsername}!`);
};

window.betOnHimFromModal = function(targetUsername) {
    window.toggleModal('seat-action-modal', false);
    const attrTarget = targetUsername.replace(/'/g, "\\'");
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">Select wager amount:</p>
            <div style="display:flex; gap:6px; margin-bottom:8px;">
                <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 5)">$5</button>
                <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 10)">$10</button>
                <button style="flex:1;" onclick="submitGlobalProposal('${attrTarget}', 20)">$20</button>
            </div>
            <div style="display:flex; gap:6px; margin-bottom:6px;">
                <input type="number" id="custom-bet-wager-input" min="1" step="1" placeholder="Custom $" style="flex:1; padding:7px; border-radius:6px; border:1px solid #d97706; background:rgba(0,0,0,0.4); color:#fff;" />
                <button style="background:#d97706;" onclick="const v=parseInt(document.getElementById('custom-bet-wager-input')?.value,10); if(v>0) submitGlobalProposal('${attrTarget}', v);">Bet Custom</button>
            </div>
            <button class="secondary" onclick="toggleModal('bet-modal', false)" style="margin-top:4px;">Cancel</button>
        `;
    }
    window.toggleModal('bet-modal', true);
};

window.submitEliminationProposal = function(target, wagerAmt) {
    sendSocket({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt: Math.max(1, parseInt(wagerAmt, 10) || 5) });
    window.toggleModal('bet-modal', false);
    window.showCenterNotification(`First to lose bet proposed to ${target}!`);
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    sendSocket({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt: Math.max(1, parseInt(wagerAmt, 10) || 5) });
    window.toggleModal('bet-modal', false);
    window.showCenterNotification(`Global bet offered on ${pickUser}!`);
};

window.acceptGlobalProposal = function(proposalId) {
    sendSocket({ type: 'ACCEPT_GLOBAL_PROPOSAL', proposalId, betId: proposalId, id: proposalId });
};

window.declineGlobalProposal = function(proposalId) {
    sendSocket({ type: 'DECLINE_GLOBAL_PROPOSAL', proposalId, betId: proposalId, id: proposalId, accept: false, confirm: false });
};

window.confirmGlobalBet = function(proposalId, acceptedUser, confirmChoice) {
    sendSocket({ type: 'CONFIRM_GLOBAL_BET', proposalId, betId: proposalId, id: proposalId, acceptedUser, confirm: !!confirmChoice, accept: !!confirmChoice });
    window.toggleModal('bet-modal', false);
};

window.openConfirmModal = function(proposalId, proposer, pickUser, acceptedUsers) {
    const modal = document.getElementById('bet-modal');
    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');
    if (modalTitle) modalTitle.innerText = `Confirm Global Side Bet (${pickUser})`;

    const listHtml = (acceptedUsers || []).map(acc => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:6px; border-radius:6px; margin-bottom:4px;">
            <span><b>${escapeHtmlUI(acc)}</b> accepted</span>
            <div style="display:flex; gap:4px;">
                <button style="font-size:0.7rem; padding:4px 8px; background:#10b981;" onclick="confirmGlobalBet('${proposalId}', '${acc.replace(/'/g, "\\'")}', true)">Confirm</button>
                <button class="danger" style="font-size:0.7rem; padding:4px 8px;" onclick="confirmGlobalBet('${proposalId}', '${acc.replace(/'/g, "\\'")}', false)">Decline</button>
            </div>
        </div>
    `).join('');

    if (modalBody) {
        modalBody.innerHTML = `
            <p style="font-size:0.80rem; color:var(--text-muted); margin-bottom:6px;">Players who accepted your proposal:</p>
            ${listHtml}
            <button class="secondary" onclick="toggleModal('bet-modal', false)" style="margin-top:8px;">Close</button>
        `;
    }
    if (modal) modal.style.display = 'flex';
};

window.respondToBet = function(betId, accept) {
    sendSocket({ type: 'RESPOND_BET', betId, proposalId: betId, id: betId, accept: !!accept, confirm: !!accept });
    window.toggleModal('bet-modal', false);
};

function renderEndGameVoteModal(lobby, activeUsername) {
    let modal = document.getElementById('end-game-vote-modal');
    if (!lobby || !lobby.endGameVote) {
        if (modal) modal.style.display = 'none';
        return;
    }

    const activeLower = activeUsername.toLowerCase();
    const vote = lobby.endGameVote;
    const isSeatedHuman = (lobby.players || []).some(p => p.username && p.username.toLowerCase() === activeLower && !p.isBot);
    const hasVoted = Object.keys(vote.votes || {}).some(u => u.toLowerCase() === activeLower);

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

    modal.innerHTML = `
        <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #ef4444; border-radius: 12px; width: 100%; max-width: 380px; padding: 20px; color: #f8fafc; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
            <h3 style="margin: 0 0 10px; color: #fca5a5; font-size: 1.15rem; text-transform: uppercase;">Vote to End Match</h3>
            <p style="margin: 0 0 16px; font-size: 0.92rem; color: #cbd5e1;">
                <strong style="color: #fbbf24;">${escapeHtmlUI(vote.proposer || 'A player')}</strong> proposed ending the match and returning to the waiting room.
            </p>
            <div style="display: flex; gap: 10px;">
                <button type="button" onclick="submitEndGameVote(false)" style="flex: 1; padding: 10px; border-radius: 6px; background: #374151; color: #fff; border: 1px solid #6b7280; cursor: pointer; font-weight: 700;">No (Keep Playing)</button>
                <button type="button" onclick="submitEndGameVote(true)" style="flex: 1; padding: 10px; border-radius: 6px; background: #dc2626; color: #fff; border: none; cursor: pointer; font-weight: 700;">Yes (End Match)</button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

window.submitEndGameVote = function(agree) {
    sendSocket({ type: 'VOTE_END_GAME', agree: !!agree });
    const modal = document.getElementById('end-game-vote-modal');
    if (modal) modal.style.display = 'none';
};

// -------------------------------------------------------------
// 9. MASTER TABLE RENDER, AUDIO CUES & NOTIFICATIONS
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;

    window.appGlobals.latestLobbySnapshot = lobby;

    // Remove legacy #next-hand-overlay if present in DOM so its stylesheet rules never create a giant box
    const legacyOverlay = document.getElementById('next-hand-overlay');
    if (legacyOverlay) {
        legacyOverlay.remove();
    }

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
    if (roomTitle) {
        roomTitle.innerHTML = `${escapeHtmlUI(lobby.name)} <span onclick="shareRoomInviteLink('${escapeHtmlUI(lobby.code)}')" title="Tap to share invite link" style="color:#fbbf24; cursor:pointer; text-decoration:underline;">[${escapeHtmlUI(lobby.code)} 🔗]</span>`;
    }

    if (lobby.chatHistory) {
        window.syncChatHistory(lobby.chatHistory);
    }

    const activeUsername = getActiveUsername();

    // 1. CELEBRATION TRIGGER: HIT 31
    if (lobby.hit31Player) {
        if (window.appGlobals.lastCelebrated31 !== lobby.hit31Player) {
            window.appGlobals.lastCelebrated31 = lobby.hit31Player;
            if (typeof trigger31Celebration === 'function') {
                trigger31Celebration(lobby.hit31Player);
            } else if (typeof triggerWinnerCelebration === 'function') {
                triggerWinnerCelebration(lobby.hit31Player, "HIT 31!");
            }
            window.safePlaySound('win');
            triggerVibration([100, 50, 100, 50, 200]);
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
            window.safePlaySound('win');
            triggerVibration([150, 80, 150, 80, 300]);
        }
    } else if (lobby.gameState === 'lobby' || lobby.gameState === 'playing') {
        window.appGlobals.lastCelebratedWinner = null;
    }

    // 3. STATE TRANSITION NOTIFICATIONS & SELECTION RESET
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

    if ((lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') && !lobby.drawResults?.[activeUsername]) {
        window.appGlobals.hasChosenPoolCard = false;
    }

    // 4. LIVES & END-GAME VOTING MODALS
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

    renderEndGameVoteModal(lobby, activeUsername);

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
            topleftCardContent.innerHTML = `<span><b>${escapeHtmlUI(lobby.lastDiscardPickup.username)}</b>:</span> ${window.formatCardHtml(lobby.lastDiscardPickup.card, true)}`;
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
    window.clientState.ledgerHistory = lobby.ledgerHistory || [];

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
                    window.toggleModal('peek-request-modal', false);
                };
            }
            if (pDeny) {
                pDeny.onclick = () => {
                    sendSocket({ type: 'RESPOND_PEEK', spectatorUsername: requester, allow: false });
                    window.toggleModal('peek-request-modal', false);
                };
            }
            if (peekModal) peekModal.style.display = 'flex';
        }
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
            window.playYourTurnCue();
            triggerVibration([60, 40, 60]);
        }
    } else {
        window.appGlobals.wasMyTurn = false;
    }

    updateKnockButtonState(lobby, me, isMyTurnPlaying);

    // 11. SIDE BET PROPOSALS
    const sidebar = document.getElementById('global-side-bets-sidebar');
    const sidebarList = document.getElementById('global-side-bets-list');
    const globalProps = lobby.globalProposals || [];

    if (globalProps.length > 0 && lobby.gameState !== 'lobby') {
        if (sidebar) sidebar.style.display = 'flex';
        let sidebarHtml = '';
        globalProps.forEach(gp => {
            const isMyProp = Boolean(gp.proposer && gp.proposer.toLowerCase() === activeUsername.toLowerCase());
            const alreadyAccepted = Boolean(gp.acceptedBy && gp.acceptedBy.some(u => u.toLowerCase() === activeUsername.toLowerCase()));

            let actionHtml = '';
            if (isMyProp) {
                if (gp.acceptedBy && gp.acceptedBy.length > 0) {
                    actionHtml = `<button style="font-size:0.65rem; padding:3px 6px; background:#38bdf8; color:#0f172a; margin-top:4px;" onclick="openConfirmModal('${gp.id}', '${gp.proposer}', '${gp.pickUser}', ${JSON.stringify(gp.acceptedBy).replace(/"/g, '&quot;')})">Review (${gp.acceptedBy.length})</button>`;
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
                    <span>I like <b>${escapeHtmlUI(gp.pickUser)}</b> for <b>$${gp.wagerAmt}</b> (${escapeHtmlUI(gp.proposer)})</span>
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

            if (mTitle) mTitle.innerText = `Incoming Bet Proposal from ${bet.proposer}`;
            if (mBody) {
                mBody.innerHTML = `
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:10px;">${escapeHtmlUI(label)}</p>
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

    // 12. POTS & CONFIG (Reads server potTotal first so forfeited buy-ins stay in the pot)
    const configBar = document.getElementById('lobby-config-bar');
    if (configBar) configBar.style.display = (lobby.gameState === 'lobby') ? 'flex' : 'none';

    const mainPotValue = (lobby.potTotal !== undefined)
        ? lobby.potTotal
        : (lobby.players || []).reduce((sum, p) => sum + (Number(p.wager) || 5), 0);

    const potBanner = document.getElementById('pot-total-banner');
    if (potBanner) potBanner.innerText = `Pot: $${mainPotValue}`;

    const sidePotBanner = document.getElementById('side-pot-total-banner');
    if (sidePotBanner) {
        if (lobby.sidePotTotal && lobby.sidePotTotal > 0) {
            sidePotBanner.innerText = `Side Pots: $${lobby.sidePotTotal}`;
            sidePotBanner.style.display = 'block';
        } else {
            sidePotBanner.style.display = 'none';
        }
    }

    // 13. BUILD COMPACT NEXT-HAND POPUP RIGHT OVER THE CENTER DECK (Does not block seats or hands)
    let nextHandDeckPopupHtml = '';
    if (lobby.gameState === 'roundOver') {
        const myPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === activeUsername.toLowerCase());
        const isPermanentlyOut = myPlayer && myPlayer.eliminated;

        let showPopup = false;
        let btnText = 'Next Hand (Auto in 8s)';
        let btnDisabled = false;

        if (lobby.activeParticipantsCount <= 1) {
            showPopup = true;
            btnText = 'Returning to Ready Room...';
            btnDisabled = true;
        } else if (myPlayer && !isPermanentlyOut) {
            showPopup = true;
            if (myPlayer.nextHandReady) {
                btnText = 'Waiting for players...';
                btnDisabled = true;
            } else {
                btnText = 'Next Hand (Auto in 8s)';
                btnDisabled = false;
            }
        }

        if (showPopup) {
            nextHandDeckPopupHtml = `
                <div id="deck-next-hand-popup" style="
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    z-index: 80;
                    background: rgba(4, 28, 18, 0.96);
                    border: 2px solid #fbbf24;
                    border-radius: 10px;
                    padding: 6px 10px;
                    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.85);
                    width: max-content;
                    pointer-events: auto;
                ">
                    <button id="next-hand-btn" type="button" onclick="window.clickNextHand()" ${btnDisabled ? 'disabled' : ''} style="
                        background: ${btnDisabled ? '#475569' : 'linear-gradient(135deg, #fbbf24 0%, #d97706 100%)'};
                        color: ${btnDisabled ? '#cbd5e1' : '#0f172a'};
                        border: none;
                        border-radius: 7px;
                        padding: 8px 14px;
                        font-weight: 900;
                        font-size: 0.78rem;
                        text-transform: uppercase;
                        letter-spacing: 0.4px;
                        cursor: ${btnDisabled ? 'default' : 'pointer'};
                        white-space: nowrap;
                        margin: 0;
                    ">${btnText}</button>
                </div>
            `;
        }
    }

    // 14. DEALER DRAW & TIE BREAKER MODALS
    const dealerDrawModal = document.getElementById('dealer-draw-modal');
    const revealModal = document.getElementById('tie-breaker-reveal-modal');
    const turnBanner = document.getElementById('turn-banner');

    if (lobby.phaseMessage && lobby.phaseMessage !== window.appGlobals.lastPhaseMessage) {
        window.showCenterNotification(lobby.phaseMessage);
        window.appGlobals.lastPhaseMessage = lobby.phaseMessage;
    }

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
                    <span class="draw-picker-badge" style="${isMe ? 'border-color:#38bdf8; color:#38bdf8;' : ''}">${escapeHtmlUI(p.username)}${p.isBot ? ' 🤖' : ''}</span>
                    ${card ? window.formatCardHtml(card, false) : '<div class="draw-card-waiting"><span>Waiting...</span></div>'}
                </div>
            `;
        });
        showcaseHtml += '</div>';

        let poolHtml = '';
        (lobby.drawPool || []).forEach((slot, idx) => {
            const slotIndex = (slot && slot.index !== undefined) ? slot.index : idx;
            if (slot && slot.chosenBy) {
                poolHtml += `<div class="pool-card-item taken" title="Chosen by ${escapeHtmlUI(slot.chosenBy)}">✓</div>`;
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
    } else if (lobby.gameState === 'tieBreaker') {
        if (dealerDrawModal) dealerDrawModal.style.display = 'none';
        if (revealModal) revealModal.style.display = 'flex';

        const isTied = (lobby.tiedParticipantsList || []).includes(activeUsername);
        const tMsg = document.getElementById('tie-breaker-stream-msg');
        if (tMsg) tMsg.innerText = isTied ? 'You are tied for lowest score! Pick your tie-breaker card:' : 'Watching tied players draw for elimination...';

        let streamHtml = '<div class="draw-showcase-sidebar">';
        streamHtml += '<div style="font-size:0.65rem; font-weight:800; color:var(--accent-gold); margin-bottom:2px; text-transform:uppercase;">Tied Players</div>';
        (lobby.tiedParticipantsList || []).forEach(uname => {
            const card = lobby.drawResults?.[uname];
            const isMe = (uname.toLowerCase() === activeUsername.toLowerCase());
            streamHtml += `
                <div class="draw-showcase-item">
                    <span class="draw-picker-badge" style="${isMe ? 'border-color:#38bdf8; color:#38bdf8;' : ''}">${escapeHtmlUI(uname)}</span>
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
            }
        }
    }

    // 15. CENTER TABLE, COUNTDOWN BARS & SHOWDOWN SCORE BADGES
    const tableContainer = document.getElementById('table-oval-container');
    const isShowdown = (lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd');

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
                        <span class="corner-val">${escapeHtmlUI(dVal)}</span>
                        <span class="corner-suit">${escapeHtmlUI(dSuit)}</span>
                    </div>
                    <div class="card-center-pip">${escapeHtmlUI(dSuit)}</div>
                    <div class="card-corner bottom-right">
                        <span class="corner-val">${escapeHtmlUI(dVal)}</span>
                        <span class="corner-suit">${escapeHtmlUI(dSuit)}</span>
                    </div>
                </div>
            `;
        } else {
            discardSlotHtml = `<div class="card-slot empty-slot" onclick="drawCard('discard')"><span>DISCARD</span></div>`;
        }

        let html = `
            <div class="pots-container">
                <div class="pot-total-display" id="pot-total-banner">Pot: $${mainPotValue}</div>
                <div class="side-pot-total-display" id="side-pot-total-banner" style="display:${lobby.sidePotTotal && lobby.sidePotTotal > 0 ? 'block' : 'none'};">Side Pots: $${lobby.sidePotTotal || 0}</div>
            </div>
            <div class="deck-center" id="deck-center">
                <div class="card-slot back" id="deck-pile" onclick="drawCard('deck')">
                    <div class="card-back-inner"></div>
                    <span class="deck-counter-badge" id="deck-count-display">${lobby.deckCount || 0} left</span>
                </div>
                ${discardSlotHtml}
                ${nextHandDeckPopupHtml}
            </div>
        `;

        (lobby.players || []).forEach((p, idx) => {
            const hasRevealedCards = Array.isArray(p.cards) && p.cards.length > 0;
            const revealedCardsHtml = hasRevealedCards
                ? `<div class="seat-cards">${p.cards.map(c => window.formatCardHtml(c, true)).join('')}</div>`
                : '';
            const scoreBadgeHtml = (hasRevealedCards && isShowdown)
                ? formatShowdownScoreBadge(p.cards)
                : '';

            const statusBadge = p.eliminated ? ' [OUT]' : (p.isOffline ? ' [OFFLINE]' : '');
            const readyStatusIcon = p.ready ? '✅' : '❌';
            const botBadge = p.isBot ? ' 🤖' : '';
            const isCurrent = (p.username.toLowerCase() === (lobby.currentTurnUser || '').toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
            const isDealer = (idx === lobby.dealerIndex) || (lobby.dealerName === p.username);
            const dealerBadgeHtml = isDealer ? `<span class="dealer-badge">D</span>` : '';
            const micIcon = p.inVC ? (p.isMuted ? ' 🔇' : ' 🎙️') : '';

            let countdownBarHtml = '';
            if (isCurrent && lobby.turnDeadline) {
                const dur = p.isOffline ? 5000 : 25000;
                countdownBarHtml = `
                    <div style="width:100%; height:4px; background:rgba(0,0,0,0.5); border-radius:99px; overflow:hidden; margin-top:3px;">
                        <div class="seat-countdown-fill" data-deadline="${lobby.turnDeadline}" data-duration="${dur}" style="width:100%; height:100%; background:#10b981; transition:width 0.2s linear;"></div>
                    </div>
                `;
            } else if (lobby.gameState === 'lobby' && !p.ready && p.readyDeadline) {
                countdownBarHtml = `
                    <div style="width:100%; height:4px; background:rgba(0,0,0,0.5); border-radius:99px; overflow:hidden; margin-top:3px;">
                        <div class="seat-countdown-fill" data-deadline="${p.readyDeadline}" data-duration="30000" style="width:100%; height:100%; background:#f59e0b; transition:width 0.2s linear;"></div>
                    </div>
                `;
            }

            let peekerBadgesHtml = '';
            if (p.username.toLowerCase() === activeUsername.toLowerCase() && p.peekAllowed) {
                const peekers = Object.keys(p.peekAllowed);
                if (peekers.length > 0) {
                    peekerBadgesHtml = `<div style="display:flex; gap:2px; flex-wrap:wrap; justify-content:center; margin-top:2px;">${peekers.map(pk => `<span style="background:#ef4444; color:#fff; padding:1px 3px; border-radius:3px; font-size:0.5rem; cursor:pointer;" onclick="kickPeekerAction('${pk.replace(/'/g, "\\'")}')" title="Click to kick">Kick ${escapeHtmlUI(pk)} ✕</span>`).join('')}</div>`;
                }
            }

            const attrUser = p.username.replace(/'/g, "\\'");
            html += `
                <div class="seat seat-${p.seat}${isCurrent ? ' current-turn-seat' : ''}" data-player-username="${escapeHtmlUI(p.username)}">
                    <div class="seat-name-area" onclick="tapSeat('${attrUser}')">
                        <span>${readyStatusIcon}</span> <b>${escapeHtmlUI(p.username)}${botBadge}${statusBadge}</b>${dealerBadgeHtml}${micIcon}<br>Lives: ${p.lives} | Wager: $${p.wager || 5}
                        ${countdownBarHtml}
                    </div>
                    ${revealedCardsHtml}
                    ${scoreBadgeHtml}
                    ${peekerBadgesHtml}
                </div>
            `;
        });

        tableContainer.innerHTML = html;
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
        const myScore = window.calculateLocalScore(me.cards);
        if (myHandTitle) myHandTitle.innerHTML = 'My Hand (Score: <strong style="font-size: 1rem; color: var(--accent-gold);" id="my-score-display">' + myScore + '</strong>)';
        handContainer.innerHTML = me.cards.map((c, i) => {
            const val = c.val || '';
            const suit = normalizeSuit(c.suit);
            const isRed = (suit === '♥' || suit === '♦');
            const suitClass = isRed ? 'red-suit' : 'black-suit';

            return `
                <div class="my-card playing-card ${suitClass}" onclick="discardCard(${i})">
                    <div class="card-corner top-left">
                        <span class="corner-val">${escapeHtmlUI(val)}</span>
                        <span class="corner-suit">${escapeHtmlUI(suit)}</span>
                    </div>
                    <div class="card-center-pip">${escapeHtmlUI(suit)}</div>
                    <div class="card-corner bottom-right">
                        <span class="corner-val">${escapeHtmlUI(val)}</span>
                        <span class="corner-suit">${escapeHtmlUI(suit)}</span>
                    </div>
                </div>
            `;
        }).join('');

        if (scoreDisplay) scoreDisplay.innerText = myScore;
    } else if (handContainer) {
        handContainer.innerHTML = '';
        if (scoreDisplay) scoreDisplay.innerText = '0';
    }

    // 17. QUICK SEAT REACTIONS & COUNTDOWN SYNC
    ensureQuickReactionBar();
    triggerReactionAnimationIfNew(lobby);
    updateLiveCountdownBars();
};

window.renderLobbyState = window.updateUIFromLobby;
