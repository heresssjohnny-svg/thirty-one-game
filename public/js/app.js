// public/js/app.js - Authentication, Session Persistence & View Coordinator (PART 1 OF 2)

// -------------------------------------------------------------
// 1. TOKEN & SESSION PERSISTENCE HELPERS
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
// 2. AUTH UI FEEDBACK & TAB SWITCHING
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

    // Reset recovery step containers
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
// 3. MAIN MENU TRANSITION & PROFILE INITIALIZATION
// -------------------------------------------------------------
function updateViewForAuth(user) {
    const authOverlay = document.getElementById('auth-screen') || document.getElementById('auth-overlay');
    const mainMenu = document.getElementById('main-menu');
    const userBadge = document.getElementById('menu-user-badge');
    const usernameInput = document.getElementById('username-input');

    if (authOverlay) authOverlay.style.display = 'none';
    if (mainMenu) mainMenu.style.display = 'flex';

    const displayName = user?.username || 'Player';
    if (userBadge) userBadge.textContent = displayName;
    if (usernameInput) usernameInput.value = displayName;

    localStorage.setItem('saved_username', displayName);
    localStorage.setItem('blitz31_username', displayName);

    if (window.clientState) {
        window.clientState.username = displayName;
    }

    // Refresh public lobbies upon transition
    if (typeof window.refreshLobbies === 'function') {
        window.refreshLobbies();
    }
}

// -------------------------------------------------------------
// 4. AUTH ACTION DISPATCHERS (LOGIN & REGISTRATION)
// -------------------------------------------------------------
async function submitAuthLogin() {
    clearAuthError();

    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const rememberMeBox = document.getElementById('login-remember-me');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const rememberMe = rememberMeBox ? rememberMeBox.checked : true;

    if (!username || !password) {
        return showAuthError('Please enter both username/email and password.');
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

            if (typeof window.connectSocket === 'function') {
                window.connectSocket();
            }

            updateViewForAuth(data.user);
        } else {
            showAuthError(data.error || 'Invalid credentials.');
        }
    } catch (err) {
        showAuthError('Unable to connect to game authentication server.');
    }
}

async function submitAuthRegister() {
    clearAuthError();

    const usernameInput = document.getElementById('reg-username');
    const emailInput = document.getElementById('reg-email');
    const passwordInput = document.getElementById('reg-password');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!username || !email || !password) {
        return showAuthError('All fields (Username, Email, and Password) are required.');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return showAuthError('Please provide a valid email format (e.g. name@example.com).');
    }

    if (password.length < 6) {
        return showAuthError('Password must be at least 6 characters.');
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

            if (typeof window.connectSocket === 'function') {
                window.connectSocket();
            }

            updateViewForAuth(data.user);
        } else {
            showAuthError(data.error || 'Account registration failed.');
        }
    } catch (err) {
        showAuthError('Unable to connect to game authentication server.');
    }
}
// public/js/app.js - PART 2 OF 2

// -------------------------------------------------------------
// 5. PASSWORD RECOVERY DISPATCHERS
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
// 6. SESSION REHYDRATION ON BOOT
// -------------------------------------------------------------
async function checkExistingSession() {
    const token = getStoredAuthToken();
    if (!token) {
        const authScreen = document.getElementById('auth-screen');
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

            if (typeof window.connectSocket === 'function') {
                window.connectSocket();
            }

            updateViewForAuth(data.user);
        } else {
            clearStoredAuthToken();
            const authScreen = document.getElementById('auth-screen');
            if (authScreen) authScreen.style.display = 'flex';
        }
    } catch (err) {
        // Fallback: keep auth modal visible if offline
        const authScreen = document.getElementById('auth-screen');
        if (authScreen) authScreen.style.display = 'flex';
    }
}

// -------------------------------------------------------------
// 7. LOGOUT SESSION
// -------------------------------------------------------------
function logoutSession() {
    clearStoredAuthToken();
    window.userSession = null;

    const ws = window.gameSocket || window.ws || window.socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.close();
        } catch (e) {}
    }

    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const authScreen = document.getElementById('auth-screen');

    if (mainMenu) mainMenu.style.display = 'none';
    if (gameView) gameView.style.display = 'none';
    if (authScreen) authScreen.style.display = 'flex';

    switchAuthTab('login');

    const loginPass = document.getElementById('login-password');
    if (loginPass) loginPass.value = '';
}

// -------------------------------------------------------------
// SETTINGS & GENERIC MODAL CONTROLS
// -------------------------------------------------------------
function openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.style.display = 'flex';
}

function closeSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.style.display = 'none';
}

function toggleModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const isHidden = !modal.style.display || modal.style.display === 'none';
    modal.style.display = isHidden ? 'flex' : 'none';
}

// Global window bindings
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.toggleModal = toggleModal;
// -------------------------------------------------------------
// 8. GLOBAL EXPORTS & LIFECYCLE LISTENERS
// -------------------------------------------------------------
window.getStoredAuthToken = getStoredAuthToken;
window.saveStoredAuthToken = saveStoredAuthToken;
window.clearStoredAuthToken = clearStoredAuthToken;
window.showAuthError = showAuthError;
window.showAuthSuccess = showAuthSuccess;
window.clearAuthError = clearAuthError;
window.switchAuthTab = switchAuthTab;
window.updateViewForAuth = updateViewForAuth;
window.submitAuthLogin = submitAuthLogin;
window.submitAuthRegister = submitAuthRegister;
window.submitForgotPasswordRequest = submitForgotPasswordRequest;
window.submitResetPassword = submitResetPassword;
window.logoutSession = logoutSession;

document.addEventListener('DOMContentLoaded', () => {
    checkExistingSession();
});
