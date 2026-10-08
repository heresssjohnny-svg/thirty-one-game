// public/js/app.js - PART 1 OF 2
// Authentication Coordinator, View Transition & Session Lifecycle

window.userSession = null;

// -------------------------------------------------------------
// 1. GOOGLE IDENTITY SERVICES INITIALIZATION
// -------------------------------------------------------------
function initializeGoogleIdentity() {
    // Retry briefly if Google SDK is still downloading
    if (typeof window.google === 'undefined' || !window.google.accounts || !window.google.accounts.id) {
        setTimeout(initializeGoogleIdentity, 300);
        return;
    }

    const clientId = window.GOOGLE_CLIENT_ID || '420400140659-rpsr8gccd88sbbjiibq0dt2196ftgrb9.apps.googleusercontent.com';

    try {
        window.google.accounts.id.initialize({
            client_id: clientId,
            callback: handleGoogleCredentialResponse,
            auto_select: false,
            cancel_on_tap_outside: true
        });

        const btnContainer = document.getElementById('google-signin-btn');
        if (btnContainer) {
            btnContainer.innerHTML = '';
            window.google.accounts.id.renderButton(btnContainer, {
                type: 'standard',
                theme: 'filled_black',
                size: 'large',
                text: 'continue_with',
                shape: 'rectangular',
                width: 250
            });
        }

        // Trigger Google One Tap floating dialog
        window.google.accounts.id.prompt((notification) => {
            if (notification.isNotDisplayed()) {
                console.log('[Auth] One Tap prompt not displayed:', notification.getNotDisplayedReason());
            } else if (notification.isSkippedMoment()) {
                console.log('[Auth] One Tap prompt skipped:', notification.getSkippedReason());
            }
        });
    } catch (e) {
        console.warn('[Auth] GIS initialization notice:', e);
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
            localStorage.setItem('31_jwt', data.token);
            window.userSession = data.user;

            // 1. Establish the socket transport FIRST so refresh commands have an open link
            if (typeof window.connectSocket === 'function') {
                window.connectSocket();
            }

            // 2. Safely swap view from auth modal to main menu
            updateViewForAuth(data.user);
        } else {
            showAuthError(data.error || 'Google login failed.');
        }
    } catch (err) {
        console.error('[Auth] Network error during Google login:', err);
        showAuthError('Unable to connect to login service.');
    }
}

// -------------------------------------------------------------
// 2. AUTH VIEW CONTROLS & TABS
// -------------------------------------------------------------
function switchAuthTab(tab) {
    const tabLogin = document.getElementById('tab-login');
    const tabReg = document.getElementById('tab-register');
    const loginFields = document.getElementById('login-fields');
    const regFields = document.getElementById('register-fields');
    const errorEl = document.getElementById('auth-error-msg');

    if (errorEl) errorEl.style.display = 'none';

    if (tab === 'login') {
        if (tabLogin) tabLogin.classList.add('active');
        if (tabReg) tabReg.classList.remove('active');
        if (loginFields) loginFields.style.display = 'block';
        if (regFields) regFields.style.display = 'none';
    } else {
        if (tabReg) tabReg.classList.add('active');
        if (tabLogin) tabLogin.classList.remove('active');
        if (loginFields) loginFields.style.display = 'none';
        if (regFields) regFields.style.display = 'block';
    }
}

function showAuthError(message) {
    const errorEl = document.getElementById('auth-error-msg');
    if (!errorEl) return;
    errorEl.innerText = message;
    errorEl.style.display = 'block';
}

function updateViewForAuth(user) {
    try {
        const authOverlay = document.getElementById('auth-overlay') || document.getElementById('auth-screen');
        const mainMenu = document.getElementById('main-menu');
        const badge = document.getElementById('menu-user-badge');
        const usernameInput = document.getElementById('username-input');

        // Hide login modal
        if (authOverlay) {
            authOverlay.style.display = 'none';
        }

        // Display main menu view
        if (mainMenu) {
            mainMenu.style.display = 'flex';
        }

        if (user) {
            if (badge) {
                badge.innerText = user.isGuest ? `${user.username} (Guest)` : user.username;
            }
            if (usernameInput) {
                usernameInput.value = user.username;
                if (typeof window.saveInputs === 'function') {
                    window.saveInputs();
                }
            }
            if (window.clientState) {
                window.clientState.username = user.username;
            }
        }

        // Debounced public lobby fetch to allow socket to fully open
        setTimeout(() => {
            if (typeof window.refreshLobbies === 'function') {
                window.refreshLobbies();
            }
        }, 150);
    } catch (err) {
        console.error('[Auth] Error transitioning from auth to main menu:', err);
        const menu = document.getElementById('main-menu');
        if (menu) menu.style.display = 'flex';
    }
}
// public/js/app.js - PART 2 OF 2

// -------------------------------------------------------------
// 3. NATIVE FORM DISPATCHERS (PASSWORD & GUEST)
// -------------------------------------------------------------
async function submitAuthLogin() {
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!username || !password) {
        return showAuthError('Please enter both username and password.');
    }

    try {
        const res = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok && data.token) {
            localStorage.setItem('31_jwt', data.token);
            window.userSession = data.user;
            if (typeof window.connectSocket === 'function') window.connectSocket();
            updateViewForAuth(data.user);
        } else {
            showAuthError(data.error || 'Invalid credentials.');
        }
    } catch (err) {
        showAuthError('Server connection error.');
    }
}

async function submitAuthRegister() {
    const usernameInput = document.getElementById('reg-username');
    const passwordInput = document.getElementById('reg-password');
    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!username || password.length < 6) {
        return showAuthError('Username required and password must be at least 6 characters.');
    }

    try {
        const res = await fetch('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok && data.token) {
            localStorage.setItem('31_jwt', data.token);
            window.userSession = data.user;
            if (typeof window.connectSocket === 'function') window.connectSocket();
            updateViewForAuth(data.user);
        } else {
            showAuthError(data.error || 'Registration failed.');
        }
    } catch (err) {
        showAuthError('Server connection error.');
    }
}

async function submitAuthGuest() {
    try {
        const res = await fetch('/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (res.ok && data.token) {
            localStorage.setItem('31_jwt', data.token);
            window.userSession = data.user;
            if (typeof window.connectSocket === 'function') window.connectSocket();
            updateViewForAuth(data.user);
        } else {
            showAuthError(data.error || 'Could not start guest session.');
        }
    } catch (err) {
        showAuthError('Server connection error.');
    }
}

function logoutSession() {
    localStorage.removeItem('31_jwt');
    window.userSession = null;
    if (typeof window.disconnectLiveKit === 'function') window.disconnectLiveKit();
    if (window.appGlobals && window.appGlobals.ws) {
        window.appGlobals.ws.close();
    }
    window.location.reload();
}

// -------------------------------------------------------------
// 4. SESSION REHYDRATION & INITIALIZATION ON BOOT
// -------------------------------------------------------------
async function checkExistingAuthToken() {
    const token = localStorage.getItem('31_jwt');
    if (!token) {
        initializeGoogleIdentity();
        return;
    }

    try {
        const res = await fetch('/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            window.userSession = data.user;
            if (typeof window.connectSocket === 'function') {
                window.connectSocket();
            }
            updateViewForAuth(data.user);
        } else {
            localStorage.removeItem('31_jwt');
            initializeGoogleIdentity();
        }
    } catch (e) {
        initializeGoogleIdentity();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    checkExistingAuthToken();
});

// Expose handlers globally for HTML inline events
window.switchAuthTab = switchAuthTab;
window.submitAuthLogin = submitAuthLogin;
window.submitAuthRegister = submitAuthRegister;
window.submitAuthGuest = submitAuthGuest;
window.logoutSession = logoutSession;
window.updateViewForAuth = updateViewForAuth;
