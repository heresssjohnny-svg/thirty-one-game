// public/js/app.js - Auth Handlers, Password Recovery & Session Lifecycle

// -------------------------------------------------------------
// 1. SOCKET AUTHENTICATION HELPER
// -------------------------------------------------------------
function authenticateActiveSocket(token, user) {
    if (!token) return;
    if (typeof window.connectSocket === 'function') {
        window.connectSocket();
    }
    const ws = window.appGlobals?.ws || window.ws || window.gameSocket;
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({
                type: 'AUTH_TOKEN',
                token: token,
                userId: user?.id,
                username: user?.username
            }));
        } catch (e) {}
    }
}

// -------------------------------------------------------------
// 2. TOKEN & SESSION PERSISTENCE HELPERS
// -------------------------------------------------------------
function getStoredAuthToken() {
    return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || null;
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
    sessionStorage.removeItem('31_jwt');
    localStorage.removeItem('blitz31_active_room');
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
        if (authOverlay) authOverlay.style.display = 'flex';
        if (mainMenu) mainMenu.style.display = 'none';
        if (gameView) gameView.style.display = 'none';
        return;
    }

    if (authOverlay) authOverlay.style.display = 'none';
    if (!window.appGlobals?.currentJoinedCode) {
        if (mainMenu) mainMenu.style.display = 'flex';
        if (gameView) gameView.style.display = 'none';
    }

    const displayName = user.username || 'Player';
    if (userBadge) userBadge.textContent = displayName;
    if (usernameInput) usernameInput.value = displayName;

    localStorage.setItem('saved_username', displayName);
    localStorage.setItem('blitz31_username', displayName);

    if (window.clientState) {
        window.clientState.username = displayName;
    }

    if (typeof window.refreshLobbies === 'function') {
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
            showAuthSuccess(data.message || 'Recovery code sent! Check your email inbox.');

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
    const sfxToggle = document.getElementById('setting-sfx');
    if (sfxToggle) {
        sfxToggle.checked = localStorage.getItem('blitz31_sfx_enabled') !== 'false';
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
});
