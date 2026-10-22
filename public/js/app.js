// public/js/app.js - Modal Controls, Chat Engine, Audio Bridge, Auth & Session Lifecycle

// -------------------------------------------------------------
// 1. UNIVERSAL MODAL & DRAWER CONTROLLER
// -------------------------------------------------------------
function getModalElement(id) {
    return document.getElementById(id) || null;
}

function openModal(id) {
    const el = getModalElement(id);
    if (el) {
        el.style.display = 'flex';
        el.classList.remove('hidden');
    }
}

function closeModal(id) {
    const el = getModalElement(id);
    if (el) {
        el.style.display = 'none';
        el.classList.add('hidden');
    }
}

function toggleModal(id, forceState) {
    const el = getModalElement(id);
    if (!el) return;
    if (typeof forceState === 'boolean') {
        if (forceState) openModal(id);
        else closeModal(id);
        return;
    }
    const isHidden = !el.style.display || el.style.display === 'none' || el.classList.contains('hidden');
    if (isHidden) {
        openModal(id);
    } else {
        closeModal(id);
    }
}

// Settings Modal: Refreshes LiveKit audio outputs and participants before showing
function openSettingsModal() {
    if (typeof window.refreshAudioOutputDevices === 'function') window.refreshAudioOutputDevices();
    if (typeof window.refreshVoiceParticipantsList === 'function') window.refreshVoiceParticipantsList();
    openModal('settings-modal');
}
function closeSettingsModal() {
    closeModal('settings-modal');
}

// Rules Modal Controls
function openRulesModal() { openModal('rules-modal'); }
function closeRulesModal() { closeModal('rules-modal'); }

// Spectator List Modal Controls
function openSpectatorListModal() {
    const content = document.getElementById('spectators-list') || document.getElementById('spectators-list-content');
    const specs = (window.clientState && window.clientState.spectatorsList) || [];
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (content) {
        if (specs.length === 0) {
            content.innerHTML = '<div class="empty-list-notice">No spectators currently watching.</div>';
        } else {
            content.innerHTML = '<ul style="padding-left:14px; margin:0; list-style:none;">' +
                specs.map(s => {
                    const sObj = (typeof s === 'object' && s !== null) ? s : { username: String(s) };
                    const vcBadge = sObj.inVC ? (sObj.isMuted ? ' 🔇' : ' 🎙️') : '';
                    const adminBtns = (typeof window.getHostAdminButtonsHTML === 'function')
                        ? window.getHostAdminButtonsHTML(lobby, sObj)
                        : '';
                    return `<li style="margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;"><span><b>${sObj.username}</b>${vcBadge}</span>${adminBtns}</li>`;
                }).join('') + '</ul>';
        }
    }
    openModal('spectator-list-modal');
}
function closeSpectatorListModal() {
    closeModal('spectator-list-modal');
}

// Active Bets & Side Bets Modal Controls
function openActiveBetsModal() {
    if (typeof window.hideAllBetsButtons === 'function') {
        window.hideAllBetsButtons();
    }
    openModal('active-bets-modal');
}
function closeActiveBetsModal() {
    closeModal('active-bets-modal');
}

function toggleGlobalSidebar() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) {
        const isHidden = !sidebar.style.display || sidebar.style.display === 'none' || sidebar.classList.contains('hidden');
        sidebar.style.display = isHidden ? 'flex' : 'none';
        sidebar.classList.toggle('hidden', !isHidden);
        return;
    }
    const betModal = getModalElement('bet-modal');
    if (betModal) {
        toggleModal('bet-modal');
        return;
    }
    const ledger = getModalElement('session-ledger-modal') || getModalElement('ledger-modal');
    if (ledger) toggleModal(ledger.id);
}

function toggleMinimizeBetModal() {
    const modal = document.getElementById('bet-modal');
    if (modal) modal.classList.toggle('minimized');
}

function toggleMinimizeGlobalSidebar() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) sidebar.classList.toggle('minimized');
}

// Ledger Modal Controls
function openLedgerModal() {
    if (typeof window.toggleSessionLedger === 'function') {
        window.toggleSessionLedger(true);
        return;
    }
    const ledger = getModalElement('session-ledger-modal') || getModalElement('ledger-modal');
    if (ledger) openModal(ledger.id);
}
function closeLedgerModal() {
    const ledger = getModalElement('session-ledger-modal') || getModalElement('ledger-modal');
    if (ledger) closeModal(ledger.id);
}
function closeSessionLedgerModal() {
    closeModal('session-ledger-modal');
}

function openLifetimeLedgerModal() {
    const token = getStoredAuthToken();
    const username = (window.userSession && window.userSession.username) ||
                     (window.clientState && window.clientState.username) ||
                     localStorage.getItem('saved_username') || null;
    const userId = (window.userSession && (window.userSession.id || window.userSession.userId)) || null;

    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend({
            type: 'GET_LIFETIME_LEDGER',
            token,
            userId,
            username
        });
    }
    openModal('lifetime-ledger-modal');
}
function closeLifetimeLedgerModal() {
    closeModal('lifetime-ledger-modal');
}

// -------------------------------------------------------------
// 1A. TABLE CHAT DRAWER & MESSAGE ENGINE
// -------------------------------------------------------------
function toggleChatWindow() {
    const chat = getModalElement('chat-window') || getModalElement('chat-drawer');
    if (!chat) return;
    const isHidden = !chat.style.display || chat.style.display === 'none' || chat.classList.contains('hidden');
    chat.style.display = isHidden ? 'flex' : 'none';
    chat.classList.toggle('hidden', !isHidden);

    if (isHidden) {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.remove('unread');
            chatBtn.innerText = '💬 Chat';
        }
        const box = document.getElementById('chat-messages');
        if (box) box.scrollTop = box.scrollHeight;
        const inp = document.getElementById('chat-input') || document.getElementById('chat-text-input');
        if (inp) setTimeout(() => inp.focus(), 80);
    }
}

function closeChatWindow() {
    const chat = getModalElement('chat-window') || getModalElement('chat-drawer');
    if (chat) {
        chat.style.display = 'none';
        chat.classList.add('hidden');
    }
}

function appendChatMessage(userOrData, msgText) {
    const box = document.getElementById('chat-messages');
    if (!box) return;

    let sender = 'Player';
    let text = '';

    // Support both appendChatMessage(user, msg) and appendChatMessage(dataObj)
    if (typeof userOrData === 'object' && userOrData !== null) {
        sender = userOrData.user || userOrData.username || userOrData.sender || 'Player';
        text = userOrData.text || userOrData.message || '';
    } else {
        sender = userOrData || 'Player';
        text = msgText || '';
    }

    if (!text) return;

    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    div.innerHTML = `<b>${sender}:</b> ${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    const win = getModalElement('chat-window') || getModalElement('chat-drawer');
    const isVisible = win && win.style.display === 'flex' && !win.classList.contains('hidden');
    if (!isVisible) {
        const chatBtn = document.getElementById('chat-toggle-btn');
        if (chatBtn) {
            chatBtn.classList.add('unread');
            chatBtn.innerText = '💬 Chat (!)';
        }
    }
}

function syncChatHistory(history) {
    if (!Array.isArray(history)) return;
    const box = document.getElementById('chat-messages');
    if (!box) return;

    window.appGlobals = window.appGlobals || {};
    const lastCount = window.appGlobals.lastChatCount || 0;

    if (history.length !== lastCount) {
        box.innerHTML = history.map(m => {
            const u = m.user || m.username || 'Player';
            const t = m.text || m.message || '';
            return `<div style="margin-bottom:4px;"><b>${u}:</b> ${t}</div>`;
        }).join('');
        box.scrollTop = box.scrollHeight;

        const win = getModalElement('chat-window') || getModalElement('chat-drawer');
        const isVisible = win && win.style.display === 'flex' && !win.classList.contains('hidden');
        if (history.length > lastCount && !isVisible) {
            const chatBtn = document.getElementById('chat-toggle-btn');
            if (chatBtn) {
                chatBtn.classList.add('unread');
                chatBtn.innerText = '💬 Chat (!)';
            }
        }
        window.appGlobals.lastChatCount = history.length;
    }
}

function sendChatMessage() {
    const input = document.getElementById('chat-input') || document.getElementById('chat-text-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const code = (window.appGlobals && window.appGlobals.currentJoinedCode) ||
                 localStorage.getItem('blitz31_active_room') || '';
    const username = (window.userSession && window.userSession.username) ||
                     (window.clientState && window.clientState.username) ||
                     localStorage.getItem('saved_username') || 'Player';

    const payload = {
        type: 'CHAT_MESSAGE',
        message: text,
        text: text,
        code: code ? code.toUpperCase() : undefined,
        username: username
    };

    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(payload);
    } else if (typeof window.sendSocketMessage === 'function') {
        window.sendSocketMessage(payload);
    } else {
        const ws = window.appGlobals?.ws || window.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    input.value = '';
}

// Dismiss modal overlays when tapping outside the modal box
document.addEventListener('click', (e) => {
    if (e.target && e.target.classList && (e.target.classList.contains('modal-overlay') || e.target.classList.contains('modal-backdrop'))) {
        if (e.target.id === 'dealer-draw-modal') return;
        e.target.style.display = 'none';
        e.target.classList.add('hidden');
    }
});

// -------------------------------------------------------------
// 1B. SOUND EFFECTS, HAPTICS & SETTINGS BRIDGE
// -------------------------------------------------------------
window.isSfxEnabled = function() {
    const toggle = document.getElementById('setting-sfx');
    if (toggle) return toggle.checked;
    return localStorage.getItem('blitz31_sfx_enabled') !== 'false';
};

window.isVibrateEnabled = function() {
    const toggle = document.getElementById('setting-vibrate');
    if (toggle) return toggle.checked;
    return localStorage.getItem('blitz31_vibrate_enabled') !== 'false';
};

window.toggleSoundSetting = function() {
    const toggle = document.getElementById('setting-sfx');
    const enabled = toggle ? toggle.checked : true;
    localStorage.setItem('blitz31_sfx_enabled', enabled ? 'true' : 'false');
};

window.toggleVibrateSetting = function() {
    const toggle = document.getElementById('setting-vibrate');
    const enabled = toggle ? toggle.checked : true;
    localStorage.setItem('blitz31_vibrate_enabled', enabled ? 'true' : 'false');
};

window.playSound = function(cueType) {
    if (!window.isSfxEnabled()) return;
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
        const fallbackAudio = new Audio(`/mp3s/${normalized}.mp3`);
        fallbackAudio.play().catch(() => {});
    } catch (e) {}
};

window.safePlaySound = window.playSound;
window.triggerAudioCue = window.playSound;
window.playYourTurnCue = function() { window.playSound('yourturn'); };

window.triggerVibration = function(pattern) {
    if (!window.isVibrateEnabled()) return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(pattern); } catch (e) {}
    }
};
window.safeVibrate = window.triggerVibration;

// Bind modal, chat & utility controllers to window
window.openModal = openModal;
window.closeModal = closeModal;
window.toggleModal = toggleModal;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.openRulesModal = openRulesModal;
window.closeRulesModal = closeRulesModal;
window.openSpectatorListModal = openSpectatorListModal;
window.closeSpectatorListModal = closeSpectatorListModal;
window.openActiveBetsModal = openActiveBetsModal;
window.closeActiveBetsModal = closeActiveBetsModal;
window.toggleGlobalSidebar = toggleGlobalSidebar;
window.toggleMinimizeBetModal = toggleMinimizeBetModal;
window.toggleMinimizeGlobalSidebar = toggleMinimizeGlobalSidebar;
window.openLedgerModal = openLedgerModal;
window.closeLedgerModal = closeLedgerModal;
window.closeSessionLedgerModal = closeSessionLedgerModal;
window.openLifetimeLedgerModal = openLifetimeLedgerModal;
window.closeLifetimeLedgerModal = closeLifetimeLedgerModal;
window.toggleChatWindow = toggleChatWindow;
window.closeChatWindow = closeChatWindow;
window.appendChatMessage = appendChatMessage;
window.syncChatHistory = syncChatHistory;
window.sendChatMessage = sendChatMessage;

// -------------------------------------------------------------
// 2. TOKEN & SOCKET AUTHENTICATION HELPERS
// -------------------------------------------------------------
function getStoredAuthToken() {
    return sessionStorage.getItem('31_jwt') ||
           localStorage.getItem('31_jwt') ||
           localStorage.getItem('auth_token') ||
           localStorage.getItem('token') ||
           null;
}

function saveStoredAuthToken(token, rememberMe = true) {
    if (!token) return;
    if (rememberMe) {
        localStorage.setItem('31_jwt', token);
        sessionStorage.removeItem('31_jwt');
    } else {
        sessionStorage.setItem('31_jwt', token);
        localStorage.removeItem('31_jwt');
    }
}

function clearStoredAuthToken() {
    localStorage.removeItem('31_jwt');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('token');
    localStorage.removeItem('jwt');
    sessionStorage.removeItem('31_jwt');
    localStorage.removeItem('blitz31_active_room');
}

function authenticateActiveSocket(token, user) {
    if (typeof window.connectSocket === 'function') {
        window.connectSocket();
    }
    const authToken = token || getStoredAuthToken();
    if (authToken && typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend({
            type: 'AUTH_TOKEN',
            token: authToken,
            userId: user?.id,
            username: user?.username
        });
    }
    const activeRoom = (window.appGlobals && window.appGlobals.currentJoinedCode) || localStorage.getItem('blitz31_active_room');
    const myName = (user && user.username) || (window.clientState && window.clientState.username) || localStorage.getItem('saved_username') || 'Player1';
    if (activeRoom && typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend({
            type: 'JOIN_LOBBY',
            code: activeRoom.toUpperCase(),
            username: myName
        });
    }
}

// -------------------------------------------------------------
// 3. AUTH UI FEEDBACK & TAB SWITCHING
// -------------------------------------------------------------
function showAuthError(msg) {
    const errBox = document.getElementById('auth-error-msg');
    if (errBox) {
        errBox.textContent = msg;
        errBox.style.color = '#f87171';
        errBox.style.display = 'block';
    } else {
        alert(msg);
    }
}

function showAuthSuccess(msg) {
    const errBox = document.getElementById('auth-error-msg');
    if (errBox) {
        errBox.textContent = msg;
        errBox.style.color = '#34d399';
        errBox.style.display = 'block';
    } else {
        alert(msg);
    }
}

function clearAuthError() {
    const errBox = document.getElementById('auth-error-msg');
    if (errBox) {
        errBox.textContent = '';
        errBox.style.display = 'none';
    }
}

function switchAuthTab(tab) {
    clearAuthError();

    const loginTab = document.getElementById('tab-login');
    const registerTab = document.getElementById('tab-register');
    const tabBar = document.getElementById('auth-tab-bar');

    const loginFields = document.getElementById('login-fields');
    const registerFields = document.getElementById('register-fields');
    const forgotFields = document.getElementById('forgot-fields');

    const forgotStep1 = document.getElementById('forgot-step-1');
    const forgotStep2 = document.getElementById('forgot-step-2');
    if (forgotStep1) forgotStep1.style.display = 'block';
    if (forgotStep2) forgotStep2.style.display = 'none';

    if (tab === 'login') {
        if (loginTab) loginTab.classList.add('active');
        if (registerTab) registerTab.classList.remove('active');
        if (tabBar) tabBar.style.display = 'flex';

        if (loginFields) loginFields.style.display = 'block';
        if (registerFields) registerFields.style.display = 'none';
        if (forgotFields) forgotFields.style.display = 'none';
    } else if (tab === 'register') {
        if (loginTab) loginTab.classList.remove('active');
        if (registerTab) registerTab.classList.add('active');
        if (tabBar) tabBar.style.display = 'flex';

        if (loginFields) loginFields.style.display = 'none';
        if (registerFields) registerFields.style.display = 'block';
        if (forgotFields) forgotFields.style.display = 'none';
    } else if (tab === 'forgot') {
        if (tabBar) tabBar.style.display = 'none';

        if (loginFields) loginFields.style.display = 'none';
        if (registerFields) registerFields.style.display = 'none';
        if (forgotFields) forgotFields.style.display = 'block';
    }
}

// -------------------------------------------------------------
// 4. MAIN MENU TRANSITION & PROFILE INITIALIZATION
// -------------------------------------------------------------
function updateViewForAuth(user) {
    const authOverlay = document.getElementById('auth-screen') || document.getElementById('auth-overlay');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const userBadge = document.getElementById('menu-user-badge');
    const usernameInput = document.getElementById('username-input');

    if (!user) {
        if (mainMenu) mainMenu.style.display = 'none';
        if (gameView) gameView.style.display = 'none';
        if (authOverlay) authOverlay.style.display = 'flex';
        return;
    }

    if (authOverlay) authOverlay.style.display = 'none';

    const isGameActive = gameView && gameView.style.display === 'flex';
    if (!isGameActive && mainMenu) {
        mainMenu.style.display = 'flex';
    }

    const displayName = user.username || 'Player';
    if (userBadge) userBadge.textContent = displayName;
    if (usernameInput) usernameInput.value = displayName;

    localStorage.setItem('saved_username', displayName);
    localStorage.setItem('blitz31_username', displayName);

    if (window.clientState) {
        window.clientState.username = displayName;
    }

    if (!isGameActive && typeof window.refreshLobbies === 'function') {
        window.refreshLobbies();
    }
}

// -------------------------------------------------------------
// 5. GOOGLE IDENTITY SERVICES INITIALIZATION
// -------------------------------------------------------------
function initializeGoogleIdentity() {
    const clientId = window.GOOGLE_CLIENT_ID || "420400140659-rpsr8gccd88sbbjiibq0dt2196ftgrb9.apps.googleusercontent.com";
    if (window.google && window.google.accounts && window.google.accounts.id) {
        try {
            window.google.accounts.id.initialize({
                client_id: clientId,
                callback: handleGoogleCredentialResponse,
                auto_select: false,
                cancel_on_tap_outside: true
            });

            const btnContainer = document.getElementById('google-signin-btn');
            if (btnContainer) {
                window.google.accounts.id.renderButton(btnContainer, {
                    theme: 'outline',
                    size: 'large',
                    width: btnContainer.offsetWidth || 280,
                    text: 'signin_with',
                    shape: 'pill'
                });
            }
        } catch (e) {
            console.warn('[GIS] Error initializing Google button:', e);
        }
    } else if (document.getElementById('google-signin-btn')) {
        setTimeout(initializeGoogleIdentity, 300);
    }
}

async function handleGoogleCredentialResponse(response) {
    if (!response || !response.credential) return;

    try {
        const res = await fetch('/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: response.credential })
        });
        const data = await res.json();
        if (res.ok && data.token) {
            saveStoredAuthToken(data.token, true);
            window.userSession = data.user;
            updateViewForAuth(data.user);
            authenticateActiveSocket(data.token, data.user);
        } else {
            showAuthError(data.error || 'Google sign-in failed.');
        }
    } catch (err) {
        showAuthError('Server communication error during Google login.');
    }
}

// -------------------------------------------------------------
// 6. NATIVE AUTHENTICATION FORM DISPATCHERS
// -------------------------------------------------------------
async function submitAuthLogin() {
    clearAuthError();

    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const rememberMeInput = document.getElementById('login-remember-me') || document.getElementById('remember-me-checkbox');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const rememberMe = rememberMeInput ? rememberMeInput.checked : true;

    if (!username || !password) {
        return showAuthError('Username and password are required.');
    }

    try {
        const res = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, rememberMe })
        });

        const data = await res.json();
        if (res.ok && data.token) {
            saveStoredAuthToken(data.token, rememberMe);
            window.userSession = data.user;
            updateViewForAuth(data.user);
            authenticateActiveSocket(data.token, data.user);
        } else {
            showAuthError(data.error || 'Invalid credentials.');
        }
    } catch (err) {
        showAuthError('Server communication error during login.');
    }
}

async function submitAuthRegister() {
    clearAuthError();

    const usernameInput = document.getElementById('reg-username') || document.getElementById('register-username');
    const emailInput = document.getElementById('reg-email') || document.getElementById('register-email');
    const passwordInput = document.getElementById('reg-password') || document.getElementById('register-password');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!username || !password) {
        return showAuthError('Username and password are required.');
    }

    try {
        const res = await fetch('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });

        const data = await res.json();
        if (res.ok && data.token) {
            saveStoredAuthToken(data.token, true);
            window.userSession = data.user;
            updateViewForAuth(data.user);
            authenticateActiveSocket(data.token, data.user);
        } else {
            showAuthError(data.error || 'Registration failed.');
        }
    } catch (err) {
        showAuthError('Server communication error during registration.');
    }
}

async function submitGuestLogin() {
    clearAuthError();

    try {
        const res = await fetch('/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await res.json();
        if (res.ok && data.token) {
            saveStoredAuthToken(data.token, false);
            window.userSession = data.user;
            updateViewForAuth(data.user);
            authenticateActiveSocket(data.token, data.user);
        } else {
            showAuthError(data.error || 'Guest login currently unavailable.');
        }
    } catch (err) {
        showAuthError('Unable to initialize guest session.');
    }
}

// -------------------------------------------------------------
// 7. PASSWORD RECOVERY DISPATCHERS (WITH VISUAL FEEDBACK)
// -------------------------------------------------------------
async function submitForgotPasswordRequest() {
    clearAuthError();

    const identifierInput = document.getElementById('forgot-identifier');
    const identifier = identifierInput ? identifierInput.value.trim() : '';

    if (!identifier) {
        const msg = 'Please enter your account username or registered email.';
        showAuthError(msg);
        alert(msg);
        return;
    }

    const btn = document.querySelector('#forgot-step-1 button');
    const originalBtnText = btn ? btn.textContent : 'Send Recovery Code';
    if (btn) {
        btn.textContent = 'Sending...';
        btn.disabled = true;
    }

    try {
        const res = await fetch('/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier })
        });

        const rawText = await res.text();
        let data = {};
        try {
            data = JSON.parse(rawText);
        } catch (parseErr) {
            console.error('[Forgot Password] Non-JSON response:', rawText);
        }

        if (res.ok) {
            const successMsg = data.message || 'Recovery code sent! Check your email inbox (and spam folder).';
            showAuthSuccess(successMsg);

            const step1 = document.getElementById('forgot-step-1');
            const step2 = document.getElementById('forgot-step-2');
            if (step1) step1.style.display = 'none';
            if (step2) step2.style.display = 'block';

            const codeInput = document.getElementById('reset-code');
            if (codeInput) codeInput.focus();
        } else {
            const errMsg = data.error || `Error (${res.status}): Failed to process recovery request.`;
            showAuthError(errMsg);
            alert(errMsg);
        }
    } catch (err) {
        console.error('[Forgot Password] Request error:', err);
        const netMsg = 'Unable to connect to recovery service. Please verify the server is online.';
        showAuthError(netMsg);
        alert(netMsg);
    } finally {
        if (btn) {
            btn.textContent = originalBtnText;
            btn.disabled = false;
        }
    }
}

async function submitResetPassword() {
    clearAuthError();

    const identifierInput = document.getElementById('forgot-identifier');
    const codeInput = document.getElementById('reset-code');
    const newPasswordInput = document.getElementById('reset-new-password');

    const identifier = identifierInput ? identifierInput.value.trim() : '';
    const code = codeInput ? codeInput.value.trim() : '';
    const newPassword = newPasswordInput ? newPasswordInput.value : '';

    if (!identifier || !code || !newPassword) {
        const msg = 'All fields (Account, 6-digit code, new password) are required.';
        showAuthError(msg);
        alert(msg);
        return;
    }

    if (newPassword.length < 6) {
        const msg = 'New password must be at least 6 characters.';
        showAuthError(msg);
        alert(msg);
        return;
    }

    const btn = document.querySelector('#forgot-step-2 button');
    const originalBtnText = btn ? btn.textContent : 'Set New Password';
    if (btn) {
        btn.textContent = 'Updating...';
        btn.disabled = true;
    }

    try {
        const res = await fetch('/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, code, newPassword })
        });

        const rawText = await res.text();
        let data = {};
        try {
            data = JSON.parse(rawText);
        } catch (parseErr) {}

        if (res.ok) {
            alert(data.message || 'Password updated successfully! Please log in.');
            switchAuthTab('login');

            const loginUserInput = document.getElementById('login-username');
            const loginPassInput = document.getElementById('login-password');
            if (loginUserInput) loginUserInput.value = identifier;
            if (loginPassInput) {
                loginPassInput.value = '';
                loginPassInput.focus();
            }
        } else {
            const errMsg = data.error || 'Password reset failed.';
            showAuthError(errMsg);
            alert(errMsg);
        }
    } catch (err) {
        const netMsg = 'Unable to connect to recovery service.';
        showAuthError(netMsg);
        alert(netMsg);
    } finally {
        if (btn) {
            btn.textContent = originalBtnText;
            btn.disabled = false;
        }
    }
}

// -------------------------------------------------------------
// 8. SESSION REHYDRATION ON BOOT
// -------------------------------------------------------------
async function checkExistingSession() {
    const sfxToggle = document.getElementById('setting-sfx');
    if (sfxToggle) {
        sfxToggle.checked = localStorage.getItem('blitz31_sfx_enabled') !== 'false';
    }
    const vibrateToggle = document.getElementById('setting-vibrate');
    if (vibrateToggle) {
        vibrateToggle.checked = localStorage.getItem('blitz31_vibrate_enabled') !== 'false';
    }

    const token = getStoredAuthToken();
    if (!token) {
        const authScreen = document.getElementById('auth-screen') || document.getElementById('auth-overlay');
        if (authScreen) authScreen.style.display = 'flex';
        return;
    }

    try {
        const res = await fetch('/auth/me', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (res.ok) {
            const data = await res.json();
            window.userSession = data.user;
            updateViewForAuth(data.user);
            authenticateActiveSocket(token, data.user);
        } else {
            clearStoredAuthToken();
            const authScreen = document.getElementById('auth-screen') || document.getElementById('auth-overlay');
            if (authScreen) authScreen.style.display = 'flex';
        }
    } catch (err) {
        const authScreen = document.getElementById('auth-screen') || document.getElementById('auth-overlay');
        if (authScreen) authScreen.style.display = 'flex';
    }
}

// -------------------------------------------------------------
// 9. LOGOUT SESSION (WITH WEBRTC & HARDWARE RELEASE)
// -------------------------------------------------------------
function logoutSession() {
    if (typeof window.disconnectLiveKit === 'function') {
        try { window.disconnectLiveKit(); } catch (e) {}
    }

    const ws = window.gameSocket || window.ws || window.appGlobals?.ws;
    if (ws && ws.readyState === WebSocket.OPEN && window.appGlobals?.currentJoinedCode) {
        try { ws.send(JSON.stringify({ type: 'LEAVE_LOBBY' })); } catch (e) {}
    }

    clearStoredAuthToken();
    window.userSession = null;
    if (window.appGlobals) {
        window.appGlobals.currentJoinedCode = null;
        window.appGlobals.latestLobbySnapshot = null;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch (e) {}
    }

    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const authScreen = document.getElementById('auth-screen') || document.getElementById('auth-overlay');

    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'none';
    if (authScreen) authScreen.style.display = 'flex';

    switchAuthTab('login');

    const loginPass = document.getElementById('login-password');
    if (loginPass) loginPass.value = '';
}

// -------------------------------------------------------------
// 10. GLOBAL EXPORTS & LIFECYCLE LISTENERS
// -------------------------------------------------------------
window.switchAuthTab = switchAuthTab;
window.updateViewForAuth = updateViewForAuth;
window.submitAuthLogin = submitAuthLogin;
window.submitAuthRegister = submitAuthRegister;
window.submitGuestLogin = submitGuestLogin;
window.submitForgotPasswordRequest = submitForgotPasswordRequest;
window.submitResetPassword = submitResetPassword;
window.logoutSession = logoutSession;
window.checkExistingSession = checkExistingSession;

document.addEventListener('DOMContentLoaded', () => {
    checkExistingSession();
    initializeGoogleIdentity();

    const loginPass = document.getElementById('login-password');
    if (loginPass) {
        loginPass.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitAuthLogin();
        });
    }
    const regPass = document.getElementById('reg-password');
    if (regPass) {
        regPass.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitAuthRegister();
        });
    }
    const forgotId = document.getElementById('forgot-identifier');
    if (forgotId) {
        forgotId.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitForgotPasswordRequest();
        });
    }
    const resetNewPass = document.getElementById('reset-new-password');
    if (resetNewPass) {
        resetNewPass.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitResetPassword();
        });
    }
    const chatInput = document.getElementById('chat-input') || document.getElementById('chat-text-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
});
