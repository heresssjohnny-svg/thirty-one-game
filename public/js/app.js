// public/js/app.js - Modal Controls, Auth Management, Audio Bridge, Session State & Hardware Lifecycle

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
function closeSettingsModal() { closeModal('settings-modal'); }

// Rules Modal Controls
function openRulesModal() { openModal('rules-modal'); }
function closeRulesModal() { closeModal('rules-modal'); }

// Spectator List Modal Controls
function openSpectatorListModal() {
    const content = document.getElementById('spectator-list-body') ||
                    document.getElementById('spectators-list') ||
                    document.getElementById('spectators-list-content');
    const specs = (window.clientState && window.clientState.spectatorsList) || [];
    if (content) {
        if (specs.length === 0) {
            content.innerHTML = '<div class="empty-list-notice">No spectators currently watching.</div>';
        } else {
            content.innerHTML = '<ul style="padding-left:14px; margin:0;">' +
                specs.map(s => `<li style="margin-bottom:4px;"><b>${s.username || s}</b>${s.inVC ? (s.isMuted ? ' 🔇' : ' 🎙️') : ''}</li>`).join('') +
                '</ul>';
        }
    }
    openModal('spectator-list-modal');
}
function closeSpectatorListModal() { closeModal('spectator-list-modal'); }

// Active Bets Modal: Respects ui.js button-hiding guard
function openActiveBetsModal() { 
    if (typeof window.hideAllBetsButtons === 'function') {
        window.hideAllBetsButtons();
    }
    openModal('active-bets-modal'); 
}
function closeActiveBetsModal() { closeModal('active-bets-modal'); }

// Minimize / Restore Controls for Side Bet Modal & Global Sidebar
function toggleMinimizeBetModal() {
    const wrap = document.getElementById('bet-modal-content-wrap');
    const btn = document.getElementById('bet-modal-min-btn');
    if (!wrap) return;
    const isCollapsed = wrap.style.display === 'none';
    wrap.style.display = isCollapsed ? 'block' : 'none';
    if (btn) btn.textContent = isCollapsed ? '—' : '+';
}

function toggleMinimizeGlobalSidebar() {
    const list = document.getElementById('global-side-bets-list');
    const btn = document.getElementById('global-sidebar-min-btn');
    if (!list) return;
    const isCollapsed = list.style.display === 'none';
    list.style.display = isCollapsed ? 'flex' : 'none';
    if (btn) btn.textContent = isCollapsed ? '—' : '+';
}

// Ledger Modal Controls
function toggleGlobalSidebar() {
    const sidebar = document.getElementById('global-side-bets-sidebar');
    if (sidebar) {
        sidebar.style.display = (sidebar.style.display === 'none') ? 'flex' : 'none';
        return;
    }
    const ledger = getModalElement('session-ledger-modal') || getModalElement('ledger-modal');
    if (ledger) toggleModal(ledger.id);
}

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
    const uid = (window.userSession && (window.userSession.id || window.userSession.userId)) ||
                (window.clientState && window.clientState.userId) ||
                localStorage.getItem('blitz31_user_id') ||
                null;
    const uname = (window.userSession && window.userSession.username) ||
                  (window.clientState && window.clientState.username) ||
                  localStorage.getItem('saved_username') ||
                  '';

    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend({
            type: 'GET_LIFETIME_LEDGER',
            userId: uid,
            username: uname,
            token: getStoredAuthToken()
        });
    }
    openModal('lifetime-ledger-modal');
}

function closeLifetimeLedgerModal() {
    closeModal('lifetime-ledger-modal');
}

// Chat Window Controls
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

// Dismiss modal overlays when tapping backdrop
document.addEventListener('click', (e) => {
    if (e.target.classList && (e.target.classList.contains('modal-overlay') || e.target.classList.contains('modal-backdrop'))) {
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

window.playSound = function(cueType) {
    if (!window.isSfxEnabled()) return;
    try {
        const audioEl = document.getElementById(`sound-${cueType}`);
        if (audioEl) {
            try { audioEl.currentTime = 0; } catch (e) {}
            const playPromise = audioEl.play();
            if (playPromise !== undefined) {
                playPromise.catch(() => {});
            }
            return;
        }
        const fallbackAudio = new Audio(`/mp3s/${cueType}.mp3`);
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

// Public Lobbies List Renderer Fallback (if not already in ui.js)
window.renderLobbyList = window.renderLobbyList || function(lobbiesList) {
    const container = document.getElementById('lobby-list');
    if (!container) return;
    if (!Array.isArray(lobbiesList) || lobbiesList.length === 0) {
        container.innerHTML = '<div class="empty-list-notice">No public tables active. Create one!</div>';
        return;
    }
    container.innerHTML = lobbiesList.map(l => {
        const count = l.playerCount !== undefined ? l.playerCount : (l.count || 0);
        const max = l.maxPlayers || 6;
        const statusLabel = l.gameState === 'lobby' ? 'Waiting' : 'In Progress';
        return `
            <div class="lobby-item" style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(0,0,0,0.35); border:1px solid rgba(212,175,55,0.3); border-radius:8px; margin-bottom:8px;">
                <div>
                    <div style="font-weight:800; color:#fbbf24;">${l.name || 'Table'} <span style="font-size:0.75rem; color:#94a3b8;">[${l.code}]</span></div>
                    <div style="font-size:0.75rem; color:#cbd5e1;">Host: ${l.host || 'Player'} • ${count}/${max} Seated • ${statusLabel}</div>
                </div>
                <button class="secondary-btn" style="padding:6px 12px; font-size:0.8rem;" onclick="window.joinLobbyCode('${l.code}')">Join</button>
            </div>
        `;
    }).join('');
};

// Bind modal & utility controllers to window for inline onclick attributes
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
window.toggleMinimizeBetModal = toggleMinimizeBetModal;
window.toggleMinimizeGlobalSidebar = toggleMinimizeGlobalSidebar;
window.toggleGlobalSidebar = toggleGlobalSidebar;
window.openLedgerModal = openLedgerModal;
window.closeLedgerModal = closeLedgerModal;
window.closeSessionLedgerModal = closeSessionLedgerModal;
window.openLifetimeLedgerModal = openLifetimeLedgerModal;
window.closeLifetimeLedgerModal = closeLifetimeLedgerModal;
window.toggleChatWindow = toggleChatWindow;
window.closeChatWindow = closeChatWindow;

// -------------------------------------------------------------
// 2. TOKEN & SESSION PERSISTENCE HELPERS
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
        window.initSocketAndSend({ type: 'AUTH_TOKEN', token: authToken });
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
    if (!errBox) {
        alert(msg);
        return;
    }
    errBox.textContent = msg;
    errBox.style.color = '#f87171';
    errBox.style.display = 'block';
}

function showAuthSuccess(msg) {
    const errBox = document.getElementById('auth-error-msg');
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.style.color = '#34d399';
    errBox.style.display = 'block';
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

    // Only show Main Menu if the user is not already seated inside the Game View
    const isGameActive = gameView && gameView.style.display === 'flex';
    if (!isGameActive && mainMenu) {
        mainMenu.style.display = 'flex';
    }

    const displayName = user?.username || 'Player';
    if (userBadge) userBadge.textContent = displayName;
    if (usernameInput) usernameInput.value = displayName;

    localStorage.setItem('saved_username', displayName);
    localStorage.setItem('blitz31_username', displayName);

    if (window.clientState) {
        window.clientState.username = displayName;
        if (user.id || user.userId) {
            window.clientState.userId = user.id || user.userId;
            localStorage.setItem('blitz31_user_id', window.clientState.userId);
        }
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
            body: JSON.stringify({ username, password })
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
// 7. PASSWORD RECOVERY DISPATCHERS
// -------------------------------------------------------------
async function submitForgotPasswordRequest() {
    clearAuthError();

    const identifierInput = document.getElementById('forgot-identifier');
    const identifier = identifierInput ? identifierInput.value.trim() : '';

    if (!identifier) {
        return showAuthError('Please enter your account username or registered email.');
    }

    try {
        const res = await fetch('/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier })
        });

        const data = await res.json();
        if (res.ok) {
            showAuthSuccess(data.message || 'Recovery code generated. Check server logs.');

            const step1 = document.getElementById('forgot-step-1');
            const step2 = document.getElementById('forgot-step-2');
            if (step1) step1.style.display = 'none';
            if (step2) step2.style.display = 'block';

            const codeInput = document.getElementById('reset-code');
            if (codeInput) codeInput.focus();
        } else {
            showAuthError(data.error || 'Failed to process recovery request.');
        }
    } catch (err) {
        showAuthError('Unable to connect to recovery service.');
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
        return showAuthError('All fields (Account, 6-digit code, new password) are required.');
    }

    if (newPassword.length < 6) {
        return showAuthError('New password must be at least 6 characters.');
    }

    try {
        const res = await fetch('/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, code, newPassword })
        });

        const data = await res.json();
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
            showAuthError(data.error || 'Password reset failed.');
        }
    } catch (err) {
        showAuthError('Unable to connect to recovery service.');
    }
}

// -------------------------------------------------------------
// 8. SESSION REHYDRATION ON BOOT
// -------------------------------------------------------------
async function checkExistingSession() {
    // Restore SFX & Vibration checkbox states from localStorage
    const sfxToggle = document.getElementById('setting-sfx');
    if (sfxToggle) {
        sfxToggle.checked = localStorage.getItem('blitz31_sfx_enabled') !== 'false';
    }
    const vibToggle = document.getElementById('setting-vibrate');
    if (vibToggle) {
        vibToggle.checked = localStorage.getItem('blitz31_vibrate_enabled') !== 'false';
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
    // 1. Release microphone hardware and drop LiveKit session
    if (typeof window.disconnectLiveKit === 'function') {
        try { window.disconnectLiveKit(); } catch (e) {}
    }

    // 2. Notify server if leaving an active room before closing socket
    const ws = window.gameSocket || window.ws || window.appGlobals?.ws;
    if (ws && ws.readyState === WebSocket.OPEN && window.appGlobals?.currentJoinedCode) {
        try { ws.send(JSON.stringify({ type: 'LEAVE_LOBBY' })); } catch (e) {}
    }

    // 3. Clear credentials and active table cache
    clearStoredAuthToken();
    window.userSession = null;
    if (window.appGlobals) {
        window.appGlobals.currentJoinedCode = null;
        window.appGlobals.latestLobbySnapshot = null;
    }

    // 4. Close gameplay socket
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch (e) {}
    }

    // 5. Return viewport to authentication screen
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

    // Allow pressing Enter to submit Login or Registration forms
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
});
