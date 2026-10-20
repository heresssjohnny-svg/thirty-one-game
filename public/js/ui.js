// public/js/ui.js - Table Renderer, Countdown Bars, Score Badges, Side Bets, Reactions & Modals

window.appGlobals = window.appGlobals || {};
window.appGlobals.lastKnownTurnUser = null;
window.appGlobals.lastKnownKnockedBy = null;
window.appGlobals.lastKnownGameState = null;
window.appGlobals.lastRenderedReactionId = null;
window.appGlobals.lastTickSecond = null;
window.appGlobals.selectedDiscardIndex = null;

// -------------------------------------------------------------
// 1. SAFE AUDIO, HAPTICS & UTILITIES
// -------------------------------------------------------------
window.safePlaySound = function(soundName) {
    try {
        if (typeof window.playSound === 'function') {
            window.playSound(soundName);
            return;
        }
        const el = document.getElementById(`sound-${soundName}`) || document.getElementById(`audio-${soundName}`);
        if (el && typeof el.play === 'function') {
            el.currentTime = 0;
            el.play().catch(() => {});
        }
    } catch (e) {}
};

window.safeVibrate = function(pattern) {
    try {
        if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
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

function getActiveUsername() {
    const inputEl = document.getElementById('username-input');
    if (inputEl && inputEl.value.trim()) return inputEl.value.trim();
    if (window.clientState && window.clientState.username) return window.clientState.username.trim();
    if (window.userSession && window.userSession.username) return window.userSession.username.trim();
    return (localStorage.getItem('saved_username') || localStorage.getItem('p31_username') || 'Player1').trim();
}

function dispatchGameAction(payload) {
    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(payload);
    } else if (typeof window.sendSocket === 'function') {
        window.sendSocket(payload);
    } else if (window.appGlobals?.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    }
}

window.toggleModal = function(modalId, show) {
    const el = document.getElementById(modalId);
    if (!el) return;
    if (typeof show === 'boolean') {
        el.style.display = show ? 'flex' : 'none';
    } else {
        el.style.display = (el.style.display === 'flex' || el.style.display === 'block') ? 'none' : 'flex';
    }
};

window.showCenterNotification = function(msg, duration = 3200) {
    if (!msg) return;
    let banner = document.getElementById('center-toast-notification');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'center-toast-notification';
        banner.style.cssText = `
            position: fixed;
            top: 68px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(2, 44, 34, 0.96);
            color: #fbbf24;
            border: 1.5px solid #d97706;
            border-radius: 999px;
            padding: 8px 18px;
            font-size: 0.88rem;
            font-weight: 700;
            z-index: 10050;
            box-shadow: 0 6px 20px rgba(0,0,0,0.65);
            pointer-events: none;
            text-align: center;
            max-width: 90vw;
            transition: opacity 0.25s ease;
        `;
        document.body.appendChild(banner);
    }
    banner.textContent = msg;
    banner.style.opacity = '1';
    banner.style.display = 'block';

    if (banner._hideTimer) clearTimeout(banner._hideTimer);
    banner._hideTimer = setTimeout(() => {
        banner.style.opacity = '0';
        setTimeout(() => { banner.style.display = 'none'; }, 260);
    }, duration);
};

// -------------------------------------------------------------
// 2. CLIENT-SIDE SCORE CALCULATOR & SHOWDOWN SCORE BADGES
// -------------------------------------------------------------
function calculateClientHandScore(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return { score: 0, isTrips: false };

    const evalThree = (threeCards) => {
        const suitSums = {};
        const valCounts = {};
        threeCards.forEach(c => {
            if (!c) return;
            const pts = c.val === 'A' ? 11 : (['K', 'Q', 'J', '10'].includes(c.val) ? 10 : (Number(c.val) || 0));
            suitSums[c.suit] = (suitSums[c.suit] || 0) + pts;
            valCounts[c.val] = (valCounts[c.val] || 0) + 1;
        });

        for (const v in valCounts) {
            if (valCounts[v] === 3) return { score: 30.5, isTrips: true };
        }
        const maxSuit = Math.max(0, ...Object.values(suitSums));
        return { score: maxSuit, isTrips: false };
    };

    if (cards.length <= 3) return evalThree(cards);

    let best = { score: 0, isTrips: false };
    for (let i = 0; i < cards.length; i++) {
        const sub = cards.filter((_, idx) => idx !== i);
        const res = evalThree(sub);
        if (res.score > best.score) best = res;
    }
    return best;
}

function formatScoreBadgeHTML(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return '';
    const { score, isTrips } = calculateClientHandScore(cards);
    if (score <= 0) return '';

    let label = `${score} pts`;
    let bg = 'rgba(15, 23, 42, 0.9)';
    let border = '#fbbf24';
    let color = '#fbbf24';

    if (score === 31) {
        label = `⚡ 31!`;
        bg = 'linear-gradient(135deg, #d97706 0%, #b45309 100%)';
        border = '#fde68a';
        color = '#ffffff';
    } else if (isTrips || score === 30.5) {
        label = `🔥 30.5 (Trips)`;
        bg = 'rgba(6, 78, 59, 0.95)';
        border = '#34d399';
        color = '#6ee7b7';
    }

    return `
        <div class="hand-score-pill" style="
            display: inline-block;
            background: ${bg};
            color: ${color};
            border: 1px solid ${border};
            border-radius: 999px;
            padding: 2px 8px;
            font-size: 0.72rem;
            font-weight: 800;
            margin-top: 3px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.5);
            white-space: nowrap;
        ">${label}</div>
    `;
}

// -------------------------------------------------------------
// 3. CARD HTML RENDERING
// -------------------------------------------------------------
function isRedSuit(suit) {
    return suit === '♥' || suit === '♦' || suit === 'H' || suit === 'D';
}

function renderPlayingCardHTML(card, options = {}) {
    const { isInteractive = false, cardIndex = 0, isSmall = false, isSelected = false } = options;

    if (!card || (!card.val && !card.suit)) {
        const w = isSmall ? '34px' : '56px';
        const h = isSmall ? '48px' : '80px';
        return `
            <div class="playing-card card-back" style="
                width: ${w};
                height: ${h};
                border-radius: 6px;
                background: repeating-linear-gradient(45deg, #1e3a8a, #1e3a8a 5px, #172554 5px, #172554 10px);
                border: 1.5px solid #e2e8f0;
                box-shadow: 0 2px 6px rgba(0,0,0,0.45);
                display: inline-block;
            "></div>
        `;
    }

    const red = isRedSuit(card.suit);
    const color = red ? '#dc2626' : '#0f172a';
    const w = isSmall ? '38px' : '64px';
    const h = isSmall ? '54px' : '90px';
    const fontSize = isSmall ? '0.78rem' : '1.05rem';
    const liftStyle = isSelected ? 'transform: translateY(-10px); border: 2px solid #fbbf24; box-shadow: 0 6px 14px rgba(251,191,36,0.5);' : 'border: 1.5px solid #cbd5e1;';
    const clickAttr = isInteractive ? `onclick="handleLocalCardClick(${cardIndex})"` : '';

    return `
        <div class="playing-card ${isInteractive ? 'interactive-card' : ''}" ${clickAttr} style="
            width: ${w};
            height: ${h};
            border-radius: 7px;
            background: #ffffff;
            color: ${color};
            display: inline-flex;
            flex-direction: column;
            justify-content: space-between;
            padding: ${isSmall ? '3px 4px' : '5px 6px'};
            box-sizing: border-box;
            font-weight: 800;
            font-size: ${fontSize};
            box-shadow: 0 3px 8px rgba(0,0,0,0.45);
            cursor: ${isInteractive ? 'pointer' : 'default'};
            transition: transform 0.15s ease, box-shadow 0.15s ease;
            user-select: none;
            position: relative;
            ${liftStyle}
        ">
            <div style="line-height: 1; text-align: left;">${escapeHtmlUI(card.val)}${escapeHtmlUI(card.suit)}</div>
            <div style="font-size: ${isSmall ? '1rem' : '1.45rem'}; text-align: center; line-height: 1;">${escapeHtmlUI(card.suit)}</div>
            <div style="line-height: 1; text-align: right; transform: rotate(180deg);">${escapeHtmlUI(card.val)}${escapeHtmlUI(card.suit)}</div>
        </div>
    `;
}

window.handleLocalCardClick = function(cardIndex) {
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (!lobby) return;

    const myName = getActiveUsername().toLowerCase();
    const currentTurnPlayer = (lobby.players || [])[lobby.turnIndex];
    const isMyTurn = Boolean(currentTurnPlayer && currentTurnPlayer.username.toLowerCase() === myName);
    const me = (lobby.players || []).find(p => p.username && p.username.toLowerCase() === myName);

    if (!isMyTurn || !me || !Array.isArray(me.cards) || me.cards.length !== 4) return;

    window.safePlaySound('card');
    if (typeof window.discardCard === 'function') {
        window.discardCard(cardIndex);
    } else {
        dispatchGameAction({ type: 'DISCARD_CARD', cardIndex, index: cardIndex });
    }
};

// -------------------------------------------------------------
// 4. PUBLIC LOBBIES LIST (MAIN MENU)
// -------------------------------------------------------------
window.renderLobbyList = window.renderPublicLobbies = function(lobbiesList) {
    const container = document.getElementById('lobby-list') ||
                      document.getElementById('lobbies-list') ||
                      document.getElementById('public-lobbies-list');
    if (!container) return;

    if (!Array.isArray(lobbiesList) || lobbiesList.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: #94a3b8; padding: 14px; font-size: 0.88rem;">
                No public tables open right now. Create one above!
            </div>
        `;
        return;
    }

    container.innerHTML = lobbiesList.map(l => {
        const safeName = escapeHtmlUI(l.name || 'Table');
        const safeCode = escapeHtmlUI(l.code || '');
        const count = l.playerCount ?? l.count ?? 0;
        const max = l.maxPlayers || 6;
        const stateLabel = l.gameState === 'lobby' ? 'Waiting' : 'In Progress';
        return `
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.35); border: 1px solid rgba(251,191,36,0.3); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;">
                <div>
                    <div style="font-weight: 700; color: #f8fafc; font-size: 0.95rem;">${safeName} <span style="color: #fbbf24; font-size: 0.8rem;">[${safeCode}]</span></div>
                    <div style="font-size: 0.78rem; color: #94a3b8;">Seats: ${count}/${max} • ${stateLabel}</div>
                </div>
                <button type="button" onclick="joinLobbyCode('${safeCode}')" style="background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: none; border-radius: 6px; padding: 7px 14px; font-weight: 700; cursor: pointer; font-size: 0.84rem;">
                    Join
                </button>
            </div>
        `;
    }).join('');
};

// -------------------------------------------------------------
// 5. LIVE COUNTDOWN BAR ENGINE (TURN & READY TIMERS)
// -------------------------------------------------------------
function updateLiveCountdownBars() {
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (!lobby) return;

    const now = Date.now();
    const bars = document.querySelectorAll('.seat-countdown-fill');

    bars.forEach(bar => {
        const deadline = Number(bar.getAttribute('data-deadline')) || 0;
        const duration = Number(bar.getAttribute('data-duration')) || 25000;
        if (!deadline || deadline <= now) {
            bar.style.width = '0%';
            return;
        }
        const remaining = Math.max(0, deadline - now);
        const pct = Math.min(100, Math.max(0, (remaining / duration) * 100));
        bar.style.width = `${pct.toFixed(1)}%`;

        if (remaining <= 6000) {
            bar.style.background = '#ef4444';
        } else if (remaining <= 12000) {
            bar.style.background = '#f59e0b';
        } else {
            bar.style.background = '#10b981';
        }
    });

    // Subtle low-time audio/haptic cue on local player's active turn (last 5 seconds)
    if ((lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') && lobby.turnDeadline) {
        const myName = getActiveUsername().toLowerCase();
        const turnUser = (lobby.currentTurnUser || '').toLowerCase();
        if (myName && myName === turnUser) {
            const secsLeft = Math.ceil((lobby.turnDeadline - now) / 1000);
            if (secsLeft >= 1 && secsLeft <= 5 && window.appGlobals.lastTickSecond !== secsLeft) {
                window.appGlobals.lastTickSecond = secsLeft;
                window.safeVibrate(40);
            }
        }
    }
}

if (!window.appGlobals.countdownInterval) {
    window.appGlobals.countdownInterval = setInterval(updateLiveCountdownBars, 200);
}

// -------------------------------------------------------------
// 6. QUICK REACTIONS BAR & FLOATING EMOTE ANIMATIONS
// -------------------------------------------------------------
function ensureQuickReactionBar() {
    let bar = document.getElementById('quick-reaction-bar');
    if (bar) return bar;

    const gameView = document.getElementById('game-view') || document.body;
    bar = document.createElement('div');
    bar.id = 'quick-reaction-bar';
    bar.style.cssText = `
        position: fixed;
        bottom: 12px;
        right: 12px;
        display: flex;
        gap: 4px;
        background: rgba(2, 44, 34, 0.88);
        border: 1px solid rgba(251, 191, 36, 0.4);
        border-radius: 999px;
        padding: 4px 8px;
        z-index: 950;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;

    const emojis = ['🔥', '💀', '👏', '💸', '👀', '😂'];
    bar.innerHTML = emojis.map(em => `
        <button type="button" onclick="sendReaction('${em}')" style="
            background: transparent;
            border: none;
            font-size: 1.15rem;
            padding: 3px 5px;
            cursor: pointer;
            line-height: 1;
            transition: transform 0.12s ease;
        " onmousedown="this.style.transform='scale(1.25)'" onmouseup="this.style.transform='scale(1)'">${em}</button>
    `).join('');

    gameView.appendChild(bar);
    return bar;
}

function triggerReactionAnimationIfNew(lobby) {
    const rx = lobby?.lastReaction;
    if (!rx || !rx.id || rx.id === window.appGlobals.lastRenderedReactionId) return;
    if (Date.now() - (rx.timestamp || 0) > 8000) return;

    window.appGlobals.lastRenderedReactionId = rx.id;

    // Find seat element for sender
    const seats = document.querySelectorAll('[data-player-username]');
    let targetEl = null;
    seats.forEach(el => {
        if ((el.getAttribute('data-player-username') || '').toLowerCase() === (rx.username || '').toLowerCase()) {
            targetEl = el;
        }
    });

    const floater = document.createElement('div');
    floater.textContent = `${rx.emoji}`;
    floater.style.cssText = `
        position: fixed;
        font-size: 2.1rem;
        z-index: 10020;
        pointer-events: none;
        transition: transform 1.4s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 1.4s ease;
        transform: translate(-50%, 0) scale(0.9);
        opacity: 1;
        filter: drop-shadow(0 4px 8px rgba(0,0,0,0.65));
    `;

    if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        floater.style.left = `${rect.left + rect.width / 2}px`;
        floater.style.top = `${rect.top + 10}px`;
    } else {
        floater.style.left = `50%`;
        floater.style.top = `50%`;
    }

    document.body.appendChild(floater);
    requestAnimationFrame(() => {
        floater.style.transform = `translate(-50%, -65px) scale(1.35)`;
        floater.style.opacity = '0';
    });

    setTimeout(() => {
        if (floater.parentNode) floater.parentNode.removeChild(floater);
    }, 1450);
}

// -------------------------------------------------------------
// 7. KNOCK VALIDATION, AUDIO & VOTE MODALS
// -------------------------------------------------------------
function updateKnockAlertAndAudio(lobby) {
    const knockAlertModal = document.getElementById('knock-alert-modal');

    if (lobby.knockedBy && lobby.knockedBy !== window.appGlobals.lastKnownKnockedBy) {
        window.appGlobals.lastKnownKnockedBy = lobby.knockedBy;
        const activeUsername = getActiveUsername();

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

    if (!me || me.eliminated || lobby.gameState !== 'playing' || lobby.knockedBy || !isMyTurn) {
        knockBtn.style.display = 'none';
        return;
    }

    const cards = me.cards || [];
    const { score } = calculateClientHandScore(cards);
    const activeCount = lobby.activeParticipantsCount || (lobby.players || []).filter(p => !p.eliminated).length;
    const minKnockScore = activeCount > 2 ? 21 : 25;
    const canKnockNow = Boolean(lobby.canKnock && cards.length === 3 && score >= minKnockScore);

    knockBtn.style.display = 'inline-block';
    knockBtn.disabled = !canKnockNow;
    knockBtn.style.opacity = canKnockNow ? '1' : '0.45';
    knockBtn.style.cursor = canKnockNow ? 'pointer' : 'not-allowed';
    knockBtn.title = canKnockNow
        ? `Knock with ${score} pts`
        : `Need ${minKnockScore}+ pts before drawing (after 1 full orbit) to knock`;
}

function renderLivesVoteModal(lobby) {
    let modal = document.getElementById('lives-vote-modal');
    if (!lobby || !lobby.livesVote || lobby.gameState !== 'lobby') {
        if (modal) modal.style.display = 'none';
        return;
    }

    const activeUsername = getActiveUsername().toLowerCase();
    const vote = lobby.livesVote;
    const isSeatedHuman = (lobby.players || []).some(
        p => p.username && p.username.toLowerCase() === activeUsername && !p.isBot
    );
    const hasVoted = Object.keys(vote.votes || {}).some(u => u.toLowerCase() === activeUsername);

    if (!isSeatedHuman || hasVoted) {
        if (modal) modal.style.display = 'none';
        return;
    }

    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'lives-vote-modal';
        modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 10010; padding: 16px;';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 12px; width: 100%; max-width: 360px; padding: 20px; color: #f8fafc; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
            <h3 style="margin: 0 0 10px; color: #fbbf24; font-size: 1.15rem; text-transform: uppercase;">Starting Lives Vote</h3>
            <p style="margin: 0 0 16px; font-size: 0.92rem; color: #cbd5e1;">
                <strong>${escapeHtmlUI(vote.proposer)}</strong> proposed setting starting lives to <strong style="color:#fbbf24;">${vote.proposedLives}</strong>.
            </p>
            <div style="display: flex; gap: 10px;">
                <button type="button" onclick="submitLivesVote(false)" style="flex: 1; padding: 10px; border-radius: 6px; background: #374151; color: #fff; border: none; font-weight: 700; cursor: pointer;">Decline</button>
                <button type="button" onclick="submitLivesVote(true)" style="flex: 1; padding: 10px; border-radius: 6px; background: #10b981; color: #fff; border: none; font-weight: 700; cursor: pointer;">Agree</button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

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
                <strong style="color: #fbbf24;">${escapeHtmlUI(proposer)}</strong> has proposed ending the game and returning to the lobby.
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
// 8. SEAT ACTION MODAL (CUSTOM SIDE BET WAGER, PEEK & HOST ADMIN)
// -------------------------------------------------------------
window.openSeatActionModal = function(targetUsername) {
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (!lobby || !targetUsername) return;

    const myName = getActiveUsername();
    if (targetUsername.toLowerCase() === myName.toLowerCase()) return;

    const targetPlayer = (lobby.players || []).find(p => p.username && p.username.toLowerCase() === targetUsername.toLowerCase());
    const me = (lobby.players || []).find(p => p.username && p.username.toLowerCase() === myName.toLowerCase());
    const isSpectatingOrEliminated = !me || me.eliminated;
    const isHost = Boolean(lobby.host && lobby.host.toLowerCase() === myName.toLowerCase());

    let modal = document.getElementById('seat-action-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'seat-action-modal';
        modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.76); display: none; align-items: center; justify-content: center; z-index: 10005; padding: 16px;';
        document.body.appendChild(modal);
    }

    const safeTarget = escapeHtmlUI(targetUsername);
    const attrTarget = targetUsername.replace(/'/g, "\\'");

    let html = `
        <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 12px; width: 100%; max-width: 370px; padding: 18px; color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,0.85);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <h3 style="margin: 0; color: #fbbf24; font-size: 1.1rem;">🎯 ${safeTarget}</h3>
                <button type="button" onclick="toggleModal('seat-action-modal', false)" style="background: transparent; border: none; color: #cbd5e1; font-size: 1.2rem; cursor: pointer;">✕</button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 12px;">
    `;

    // 1. "First to Lose" Side Bet (Preset $5/$10/$20 + Custom$ Input)
    if (targetPlayer && !targetPlayer.eliminated) {
        html += `
            <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; border: 1px solid rgba(251,191,36,0.25);">
                <div style="font-size: 0.82rem; color: #a7f3d0; font-weight: 700; margin-bottom: 8px; text-transform: uppercase;">
                    🤝 Last Longer / First-to-Lose Bet
                </div>
                <div style="display: flex; gap: 6px; margin-bottom: 8px;">
                    <button type="button" onclick="submitEliminationProposal('${attrTarget}', 5)" style="flex: 1; background: #059669; color: #fff; border: 1px solid #34d399; border-radius: 6px; padding: 8px; font-weight: 800; cursor: pointer;">$5</button>
                    <button type="button" onclick="submitEliminationProposal('${attrTarget}', 10)" style="flex: 1; background: #059669; color: #fff; border: 1px solid #34d399; border-radius: 6px; padding: 8px; font-weight: 800; cursor: pointer;">$10</button>
                    <button type="button" onclick="submitEliminationProposal('${attrTarget}', 20)" style="flex: 1; background: #059669; color: #fff; border: 1px solid #34d399; border-radius: 6px; padding: 8px; font-weight: 800; cursor: pointer;">$20</button>
                </div>
                <div style="display: flex; gap: 6px;">
                    <input type="number" id="custom-seat-wager-input" min="1" step="1" placeholder="Custom $" style="flex: 1; background: rgba(0,0,0,0.45); border: 1px solid #d97706; border-radius: 6px; color: #fff; padding: 7px 10px; font-size: 0.9rem;" />
                    <button type="button" onclick="const v = parseInt(document.getElementById('custom-seat-wager-input')?.value, 10); if (v > 0) submitEliminationProposal('${attrTarget}', v);" style="background: #d97706; color: #fff; border: none; border-radius: 6px; padding: 7px 12px; font-weight: 700; cursor: pointer; font-size: 0.82rem;">
                        Send Bet
                    </button>
                </div>
            </div>
        `;
    }

    // 2. Global "I Like X to Win" Proposal
    if (targetPlayer && !targetPlayer.eliminated) {
        html += `
            <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; border: 1px solid rgba(59,130,246,0.3);">
                <div style="font-size: 0.82rem; color: #93c5fd; font-weight: 700; margin-bottom: 8px; text-transform: uppercase;">
                    📢 Propose Table Bet: ${safeTarget} Wins Hand
                </div>
                <div style="display: flex; gap: 6px;">
                    <button type="button" onclick="submitGlobalProposal('${attrTarget}', 5); toggleModal('seat-action-modal', false);" style="flex: 1; background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 7px; font-weight: 700; cursor: pointer;">$5</button>
                    <button type="button" onclick="submitGlobalProposal('${attrTarget}', 10); toggleModal('seat-action-modal', false);" style="flex: 1; background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 7px; font-weight: 700; cursor: pointer;">$10</button>
                    <button type="button" onclick="const cw = parseInt(document.getElementById('custom-seat-wager-input')?.value, 10) || 20; submitGlobalProposal('${attrTarget}', cw); toggleModal('seat-action-modal', false);" style="flex: 1; background: #1d4ed8; color: #fff; border: none; border-radius: 6px; padding: 7px; font-weight: 700; cursor: pointer;">Custom/$20</button>
                </div>
            </div>
        `;
    }

    // 3. Spectator Peek Request
    if (isSpectatingOrEliminated && targetPlayer && !targetPlayer.eliminated && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn')) {
        html += `
            <button type="button" onclick="requestPeekAction('${attrTarget}'); toggleModal('seat-action-modal', false); showCenterNotification('👀 Peek request sent to ${attrTarget}');" style="background: #7c3aed; color: #fff; border: 1px solid #a78bfa; border-radius: 8px; padding: 10px; font-weight: 700; cursor: pointer;">
                👀 Request to Peek Hand
            </button>
        `;
    }

    // 4. Host Admin Controls (Mute & Kick)
    if (isHost) {
        html += `
            <div style="display: flex; gap: 8px; border-top: 1px solid rgba(255,255,255,0.12); padding-top: 10px;">
                ${!targetPlayer?.isBot ? `
                    <button type="button" onclick="adminMutePlayer('${attrTarget}')" style="flex: 1; background: #475569; color: #fff; border: none; border-radius: 6px; padding: 8px; font-weight: 700; cursor: pointer; font-size: 0.82rem;">
                        🔇 Mute Mic
                    </button>
                ` : ''}
                <button type="button" onclick="adminKickPlayer('${attrTarget}')" style="flex: 1; background: #dc2626; color: #fff; border: none; border-radius: 6px; padding: 8px; font-weight: 700; cursor: pointer; font-size: 0.82rem;">
                    👢 Kick Player
                </button>
            </div>
        `;
    }

    html += `
            </div>
        </div>
    `;

    modal.innerHTML = html;
    modal.style.display = 'flex';
};

// -------------------------------------------------------------
// 9. DEALER DRAW & TIE-BREAKER POOL MODAL
// -------------------------------------------------------------
function renderPoolDrawModal(lobby) {
    const modal = document.getElementById('dealer-draw-modal') || document.getElementById('pool-draw-modal');
    const isPoolState = lobby && (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker');

    if (!isPoolState) {
        if (modal) modal.style.display = 'none';
        return;
    }

    let targetModal = modal;
    if (!targetModal) {
        targetModal = document.createElement('div');
        targetModal.id = 'dealer-draw-modal';
        targetModal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.82); display: flex; align-items: center; justify-content: center; z-index: 9995; padding: 14px;';
        targetModal.innerHTML = `
            <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 12px; width: 100%; max-width: 520px; padding: 16px; color: #fff; text-align: center; max-height: 90vh; overflow-y: auto;">
                <h3 id="dealer-draw-title" style="margin: 0 0 6px; color: #fbbf24; font-size: 1.15rem;"></h3>
                <p id="dealer-draw-status" style="margin: 0 0 12px; font-size: 0.86rem; color: #a7f3d0;"></p>
                <div id="dealer-draw-grid" style="display: flex; flex-wrap: wrap; gap: 6px; justify-content: center;"></div>
            </div>
        `;
        document.body.appendChild(targetModal);
    }

    const titleEl = document.getElementById('dealer-draw-title') || document.getElementById('pool-draw-title');
    const statusEl = document.getElementById('dealer-draw-status') || document.getElementById('pool-draw-status');
    const gridEl = document.getElementById('dealer-draw-grid') || document.getElementById('pool-draw-grid') || document.getElementById('draw-pool-container');

    if (titleEl) {
        titleEl.textContent = lobby.gameState === 'tieBreaker'
            ? '⚔️ Tie-Breaker Card Draw (Lowest Loses a Life)'
            : '🃏 Dealer Draw (Lowest Card Deals)';
    }
    if (statusEl) {
        statusEl.textContent = lobby.phaseMessage || 'Pick any face-down card!';
    }

    if (gridEl) {
        const pool = lobby.drawPool || [];
        gridEl.innerHTML = pool.slice(0, 18).map((slot, idx) => {
            const slotIdx = slot.index !== undefined ? slot.index : idx;
            if (slot.chosenBy && slot.card) {
                const red = isRedSuit(slot.card.suit);
                return `
                    <div style="display: flex; flex-direction: column; align-items: center; width: 54px;">
                        <div style="width: 46px; height: 64px; background: #fff; color: ${red ? '#dc2626' : '#0f172a'}; border-radius: 6px; border: 2px solid #fbbf24; display: flex; flex-direction: column; align-items: center; justify-content: center; font-weight: 800; font-size: 0.9rem;">
                            <span>${escapeHtmlUI(slot.card.val)}</span>
                            <span>${escapeHtmlUI(slot.card.suit)}</span>
                        </div>
                        <span style="font-size: 0.65rem; color: #fde68a; margin-top: 2px; max-width: 52px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtmlUI(slot.chosenBy)}</span>
                    </div>
                `;
            }
            return `
                <div onclick="choosePoolCard(${slotIdx})" style="width: 46px; height: 64px; border-radius: 6px; background: repeating-linear-gradient(45deg, #1e3a8a, #1e3a8a 5px, #172554 5px, #172554 10px); border: 1.5px solid #cbd5e1; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.5);"></div>
            `;
        }).join('');
    }

    targetModal.style.display = 'flex';
}

// -------------------------------------------------------------
// 10. SIDE BET NOTIFICATIONS & PEEK BANNERS
// -------------------------------------------------------------
function renderIncomingBetsAndPeekUI(lobby, me) {
    // 1. Incoming Direct Elimination Bets
    const pendingForMe = lobby.pendingBetsForMe || [];
    if (pendingForMe.length > 0) {
        const b = pendingForMe[0];
        let betModal = document.getElementById('bet-modal');
        if (!betModal) {
            betModal = document.createElement('div');
            betModal.id = 'bet-modal';
            betModal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 10008; padding: 16px;';
            document.body.appendChild(betModal);
        }
        betModal.innerHTML = `
            <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 12px; width: 100%; max-width: 350px; padding: 18px; color: #fff; text-align: center;">
                <h3 style="margin: 0 0 8px; color: #fbbf24;">🤝 Side Bet Challenge!</h3>
                <p style="font-size: 0.92rem; color: #e2e8f0; margin-bottom: 14px;">
                    <strong>${escapeHtmlUI(b.proposer)}</strong> wants to bet <strong style="color:#34d399;">$${b.wagerAmt}</strong> on who gets eliminated first!
                </p>
                <div style="display: flex; gap: 10px;">
                    <button type="button" onclick="respondToBet('${b.id}', false)" style="flex: 1; background: #475569; color: #fff; border: none; border-radius: 6px; padding: 10px; font-weight: 700; cursor: pointer;">Decline</button>
                    <button type="button" onclick="respondToBet('${b.id}', true)" style="flex: 1; background: #10b981; color: #fff; border: none; border-radius: 6px; padding: 10px; font-weight: 700; cursor: pointer;">Accept ($${b.wagerAmt})</button>
                </div>
            </div>
        `;
        betModal.style.display = 'flex';
    }

    // 2. Incoming Peek Requests on My Hand
    if (me && me.peekIncoming && Object.keys(me.peekIncoming).length > 0) {
        const requester = Object.keys(me.peekIncoming)[0];
        const safeReq = escapeHtmlUI(requester);
        const attrReq = requester.replace(/'/g, "\\'");
        let peekPrompt = document.getElementById('peek-request-toast');
        if (!peekPrompt) {
            peekPrompt = document.createElement('div');
            peekPrompt.id = 'peek-request-toast';
            peekPrompt.style.cssText = 'position: fixed; top: 110px; left: 50%; transform: translateX(-50%); background: #1e1b4b; border: 2px solid #a78bfa; border-radius: 10px; padding: 10px 14px; color: #fff; z-index: 10006; display: flex; align-items: center; gap: 10px; box-shadow: 0 6px 20px rgba(0,0,0,0.7);';
            document.body.appendChild(peekPrompt);
        }
        peekPrompt.innerHTML = `
            <span style="font-size: 0.85rem;">👀 <strong>${safeReq}</strong> wants to peek your hand</span>
            <button type="button" onclick="respondPeekAction('${attrReq}', true); document.getElementById('peek-request-toast').style.display='none';" style="background: #10b981; color: #fff; border: none; border-radius: 5px; padding: 4px 8px; font-weight: 700; cursor: pointer; font-size: 0.78rem;">Allow</button>
            <button type="button" onclick="respondPeekAction('${attrReq}', false); document.getElementById('peek-request-toast').style.display='none';" style="background: #ef4444; color: #fff; border: none; border-radius: 5px; padding: 4px 8px; font-weight: 700; cursor: pointer; font-size: 0.78rem;">Deny</button>
        `;
        peekPrompt.style.display = 'flex';
    } else {
        const peekPrompt = document.getElementById('peek-request-toast');
        if (peekPrompt) peekPrompt.style.display = 'none';
    }
}

// -------------------------------------------------------------
// 11. MASTER LOBBY & TABLE RENDERER
// -------------------------------------------------------------
window.updateUIFromLobby = function(lobby) {
    if (!lobby) return;
    window.appGlobals.latestLobbySnapshot = lobby;

    const myName = getActiveUsername();
    const myLower = myName.toLowerCase();
    const players = lobby.players || [];
    const me = players.find(p => p.username && p.username.toLowerCase() === myLower);
    const isMyTurn = Boolean(
        (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') &&
        lobby.currentTurnUser &&
        lobby.currentTurnUser.toLowerCase() === myLower
    );

    // Play turn notification cue when turn switches to local player
    if (isMyTurn && window.appGlobals.lastKnownTurnUser !== lobby.currentTurnUser) {
        window.safePlaySound('turn');
        window.safeVibrate([90, 50, 90]);
    }
    window.appGlobals.lastKnownTurnUser = lobby.currentTurnUser || null;

    // 1. Header & Clickable Room Code Invite Badge
    const titleEl = document.getElementById('room-title') || document.getElementById('lobby-title-display');
    if (titleEl) {
        titleEl.innerHTML = `
            ${escapeHtmlUI(lobby.name || 'Table')}
            <span onclick="shareRoomInviteLink('${escapeHtmlUI(lobby.code)}')" title="Tap to share invite link" style="
                color: #fbbf24;
                background: rgba(251, 191, 36, 0.14);
                border: 1px solid rgba(251, 191, 36, 0.45);
                border-radius: 6px;
                padding: 2px 7px;
                margin-left: 6px;
                font-size: 0.8rem;
                cursor: pointer;
                user-select: none;
            ">🔗 [${escapeHtmlUI(lobby.code)}]</span>
        `;
    }

    const codeOnlyEl = document.getElementById('room-code-display') || document.getElementById('lobby-code-display');
    if (codeOnlyEl) {
        codeOnlyEl.textContent = lobby.code || '';
        codeOnlyEl.style.cursor = 'pointer';
        codeOnlyEl.title = 'Tap to share invite link';
        codeOnlyEl.onclick = () => window.shareRoomInviteLink(lobby.code);
    }

    // 2. Phase Message Banner + Fed Card Reminder
    const phaseEl = document.getElementById('phase-message') || document.getElementById('game-status') || document.getElementById('status-banner');
    if (phaseEl) {
        let phaseText = lobby.phaseMessage || '';
        if (lobby.myFedCardReminder && lobby.myFedCardReminder.card) {
            const fc = lobby.myFedCardReminder.card;
            phaseText += `  |  ⚠️ You fed ${lobby.myFedCardReminder.target} ${fc.val}${fc.suit}`;
        }
        phaseEl.textContent = phaseText;
    }

    // 3. Pots Display (Reads server potTotal first so forfeited buy-ins stay in the pot)
    const mainPot = (lobby.potTotal !== undefined)
        ? lobby.potTotal
        : players.reduce((sum, p) => sum + (Number(p.wager) || 5), 0);
    const sidePot = lobby.sidePotTotal || 0;

    const potEl = document.getElementById('main-pot-display') || document.getElementById('pot-total');
    if (potEl) potEl.textContent = `$${mainPot}`;

    const sidePotEl = document.getElementById('side-pot-display') || document.getElementById('side-pot-total');
    if (sidePotEl) sidePotEl.textContent = `$${sidePot}`;

    // 4. Center Deck & Discard Pile
    const deckCountEl = document.getElementById('deck-count');
    if (deckCountEl) deckCountEl.textContent = lobby.deckCount ?? 0;

    const discardEl = document.getElementById('discard-pile') || document.getElementById('discard-top');
    if (discardEl) {
        if (lobby.discardTop) {
            discardEl.innerHTML = renderPlayingCardHTML(lobby.discardTop, { isSmall: false });
        } else {
            discardEl.innerHTML = `<div style="width:64px;height:90px;border:1.5px dashed rgba(255,255,255,0.3);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:0.72rem;color:#94a3b8;">Empty</div>`;
        }
    }

    // 5. Action Buttons (Ready, Next Hand, Knock, Sit/Stand)
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) {
        if (lobby.gameState === 'lobby' && me && !me.eliminated) {
            readyBtn.style.display = 'inline-block';
            readyBtn.textContent = me.ready ? 'Unready' : 'Ready Up';
        } else {
            readyBtn.style.display = 'none';
        }
    }

    const nextHandBtn = document.getElementById('next-hand-btn');
    if (nextHandBtn) {
        if (lobby.gameState === 'roundOver' && me && !me.eliminated) {
            nextHandBtn.style.display = 'inline-block';
            nextHandBtn.disabled = !!me.nextHandReady;
            nextHandBtn.textContent = me.nextHandReady ? 'Waiting...' : 'Next Hand';
        } else {
            nextHandBtn.style.display = 'none';
        }
    }

    const sitBtn = document.getElementById('sit-down-btn');
    const standBtn = document.getElementById('stand-up-btn');
    if (sitBtn) sitBtn.style.display = (lobby.gameState === 'lobby' && !me && players.length < 6) ? 'inline-block' : 'none';
    if (standBtn) standBtn.style.display = (lobby.gameState === 'lobby' && me) ? 'inline-block' : 'none';

    updateKnockButtonState(lobby, me, isMyTurn);
    updateKnockAlertAndAudio(lobby);
    renderLivesVoteModal(lobby);
    renderEndGameVoteModal(lobby);
    renderPoolDrawModal(lobby);
    renderIncomingBetsAndPeekUI(lobby, me);

    // 6. Seats Rendering (With Countdown Bars & Showdown Hand Score Badges)
    renderTableSeats(lobby, me, isMyTurn);

    // 7. Chat History Update
    renderChatHistory(lobby.chatHistory || []);

    // 8. Quick Reaction Bar & Floating Emotes
    ensureQuickReactionBar();
    triggerReactionAnimationIfNew(lobby);
    updateLiveCountdownBars();
};

function renderTableSeats(lobby, me, isMyTurn) {
    const players = lobby.players || [];
    const myLower = getActiveUsername().toLowerCase();
    const isShowdown = lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd';

    // Clear existing seat slots 0..5 if present
    for (let i = 0; i < 6; i++) {
        const slot = document.getElementById(`seat-${i}`);
        if (slot) {
            slot.innerHTML = '';
            slot.removeAttribute('data-player-username');
        }
    }

    const seatsContainer = document.getElementById('seats-container');
    const hasIndividualSlots = Boolean(document.getElementById('seat-0'));

    if (!hasIndividualSlots && seatsContainer) {
        seatsContainer.innerHTML = '';
    }

    players.forEach((p, idx) => {
        const seatIndex = (p.seat !== undefined && p.seat >= 0 && p.seat < 6) ? p.seat : idx;
        const isMe = Boolean(p.username && p.username.toLowerCase() === myLower);
        const isTurn = Boolean(
            (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') &&
            lobby.currentTurnUser &&
            lobby.currentTurnUser.toLowerCase() === p.username.toLowerCase()
        );
        const isDealer = (lobby.players.findIndex(pl => pl.username === p.username) === lobby.dealerIndex);

        const hearts = p.eliminated ? '💀 Out' : '❤️'.repeat(Math.max(0, p.lives || 0));
        const borderStyle = isTurn
            ? '2px solid #fbbf24; box-shadow: 0 0 14px rgba(251, 191, 36, 0.75);'
            : (p.eliminated ? '1px solid #475569; opacity: 0.68;' : '1.5px solid rgba(255,255,255,0.22);');

        // Countdown Bar HTML (Turn timer during play OR Ready-up timer in lobby)
        let countdownHTML = '';
        if (isTurn && lobby.turnDeadline) {
            const totalDuration = p.isOffline ? 5000 : 25000;
            countdownHTML = `
                <div style="width: 100%; height: 4px; background: rgba(0,0,0,0.45); border-radius: 99px; overflow: hidden; margin-top: 4px;">
                    <div class="seat-countdown-fill" data-deadline="${lobby.turnDeadline}" data-duration="${totalDuration}" style="width: 100%; height: 100%; background: #10b981; transition: width 0.2s linear;"></div>
                </div>
            `;
        } else if (lobby.gameState === 'lobby' && !p.ready && p.readyDeadline) {
            countdownHTML = `
                <div style="width: 100%; height: 4px; background: rgba(0,0,0,0.45); border-radius: 99px; overflow: hidden; margin-top: 4px;">
                    <div class="seat-countdown-fill" data-deadline="${p.readyDeadline}" data-duration="30000" style="width: 100%; height: 100%; background: #f59e0b; transition: width 0.2s linear;"></div>
                </div>
            `;
        }

        // Cards HTML (Eliminated players have p.cards = [] after the round they lost, so no old cards render)
        let cardsHTML = '';
        const visibleCards = Array.isArray(p.cards) ? p.cards : [];
        if (visibleCards.length > 0) {
            cardsHTML = `
                <div style="display: flex; gap: ${isMe ? '6px' : '4px'}; justify-content: center; margin-top: 5px;">
                    ${visibleCards.map((c, cIdx) => renderPlayingCardHTML(c, {
                        isInteractive: isMe && isMyTurn && visibleCards.length === 4,
                        cardIndex: cIdx,
                        isSmall: !isMe
                    })).join('')}
                </div>
            `;
        } else if (!p.eliminated && (p.cardCount || 0) > 0 && lobby.gameState !== 'lobby') {
            cardsHTML = `
                <div style="display: flex; gap: 4px; justify-content: center; margin-top: 5px;">
                    ${Array.from({ length: p.cardCount }).map(() => renderPlayingCardHTML(null, { isSmall: true })).join('')}
                </div>
            `;
        }

        // Score Pill Badge (Always shown for local player's hand, and shown for all revealed hands on Showdown)
        let scoreBadgeHTML = '';
        if (visibleCards.length > 0 && (isMe || isShowdown)) {
            scoreBadgeHTML = formatScoreBadgeHTML(visibleCards);
        }

        const safeUser = escapeHtmlUI(p.username);
        const attrUser = p.username.replace(/'/g, "\\'");
        const seatClickAttr = !isMe ? `onclick="openSeatActionModal('${attrUser}')"` : '';

        const seatBadgeHTML = `
            <div class="player-seat-card" data-player-username="${safeUser}" ${seatClickAttr} style="
                background: rgba(2, 44, 34, 0.88);
                border: ${borderStyle}
                border-radius: 10px;
                padding: ${isMe ? '8px 12px' : '6px 9px'};
                color: #f8fafc;
                text-align: center;
                min-width: ${isMe ? '150px' : '105px'};
                cursor: ${!isMe ? 'pointer' : 'default'};
                position: relative;
            ">
                <div style="display: flex; align-items: center; justify-content: center; gap: 5px; font-weight: 700; font-size: ${isMe ? '0.92rem' : '0.8rem'};">
                    ${isDealer ? `<span title="Dealer" style="background:#fbbf24;color:#0f172a;border-radius:50%;width:17px;height:17px;display:inline-flex;align-items:center;justify-content:center;font-size:0.68rem;font-weight:900;">D</span>` : ''}
                    <span>${safeUser}</span>
                    ${p.isOffline ? `<span style="color:#f87171;font-size:0.68rem;">(Offline)</span>` : ''}
                </div>
                <div style="font-size: 0.74rem; color: #cbd5e1; margin-top: 2px;">
                    ${hearts} • <span style="color:#fbbf24;font-weight:700;">$${p.wager || 5}</span>
                    ${lobby.gameState === 'lobby' ? (p.ready ? ' • <span style="color:#34d399;">Ready</span>' : ' • <span style="color:#94a3b8;">Waiting</span>') : ''}
                </div>
                ${countdownHTML}
                ${cardsHTML}
                ${scoreBadgeHTML}
            </div>
        `;

        const targetSlot = document.getElementById(`seat-${seatIndex}`);
        if (targetSlot) {
            targetSlot.setAttribute('data-player-username', p.username);
            targetSlot.innerHTML = seatBadgeHTML;
        } else if (seatsContainer) {
            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-player-username', p.username);
            wrapper.innerHTML = seatBadgeHTML;
            seatsContainer.appendChild(wrapper);
        }
    });
}

function renderChatHistory(chatHistory) {
    const chatBox = document.getElementById('chat-messages') || document.getElementById('chat-box');
    if (!chatBox) return;

    chatBox.innerHTML = chatHistory.map(m => `
        <div style="margin-bottom: 4px; font-size: 0.82rem; line-height: 1.35;">
            <strong style="color: #fbbf24;">${escapeHtmlUI(m.user)}:</strong>
            <span style="color: #f1f5f9;">${escapeHtmlUI(m.text)}</span>
        </div>
    `).join('');
    chatBox.scrollTop = chatBox.scrollHeight;
}
